"""Bringaterv API – Polar AccessLink v3 (hivatalos): OAuth, edzéslista, FIT-import.

Dokumentáció: https://www.polar.com/accesslink-api/ – kliens: admin.polaraccesslink.com
(ingyenes, jóváhagyás nélkül). A Polar API-szerződés szerint az adat forrásaként a
Polart fel kell tüntetni (a könyvtárban: forrás „Polar”).

  • OAuth 2.0: flow.polar.com → code → token (polarremote.com, Basic auth). A token nem
    jár le, amíg vissza nem vonják; refresh nincs. Utána a felhasználót REGISZTRÁLNI kell
    a kliensnél (POST /v3/users), különben nem ad adatot.
  • Edzések: GET /v3/exercises (nem tranzakciós végpont). Csak a csatlakozás UTÁN
    feltöltött, legfeljebb 30 napos edzéseket adja – a régieket a Polar Flow-ból
    exportálva, fájlból lehet behozni.
  • Fájl: /v3/exercises/{id}/fit, tartalékként /gpx.
"""

import re
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import requests

from config import log
from device_import import (DeviceApiError, DeviceAuthError, load_app, load_tokens, mark_duplicates,
                           save_tokens, save_workout)

PROVIDER = "polar"
_AUTH = "https://flow.polar.com/oauth2/authorization"
_TOKEN = "https://polarremote.com/v2/oauth2/token"
_API = "https://www.polaraccesslink.com/v3"
_TZ = ZoneInfo("Europe/Budapest")


def auth_url(user_id: str, state: str, redirect: str) -> str:
    app = load_app(PROVIDER, user_id)
    return f"{_AUTH}?" + urlencode({
        "response_type": "code", "client_id": app["client_id"], "scope": "accesslink.read_all",
        "redirect_uri": redirect, "state": state,
    })


def exchange_code(user_id: str, code: str, redirect: str) -> dict:
    """Callback: code → token, majd a felhasználó regisztrálása a kliensnél."""
    app = load_app(PROVIDER, user_id)
    try:
        r = requests.post(_TOKEN, timeout=20, auth=(app["client_id"], app["client_secret"]),
                          headers={"Accept": "application/json;charset=UTF-8"},
                          data={"grant_type": "authorization_code", "code": code,
                                "redirect_uri": redirect})
    except requests.RequestException as exc:
        raise DeviceApiError(f"A Polar nem érhető el: {exc}") from exc
    if r.status_code != 200:
        raise DeviceAuthError(f"A Polar elutasította a belépést ({r.status_code}).")
    td = r.json()
    token, polar_uid = td["access_token"], td.get("x_user_id")
    # Kötelező regisztráció (409 = már regisztrálva – rendben)
    try:
        reg = requests.post(f"{_API}/users", timeout=20, json={"member-id": user_id},
                            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    except requests.RequestException as exc:
        raise DeviceApiError(f"A Polar nem érhető el: {exc}") from exc
    if reg.status_code == 403:
        raise DeviceAuthError("A Polar-fiókban nincs elfogadva minden kötelező hozzájárulás (Polar Flow → beállítások).")
    if reg.status_code not in (200, 201, 409):
        raise DeviceApiError(f"A Polar-regisztráció sikertelen ({reg.status_code}).")
    name = ""
    try:
        info = reg.json() if reg.status_code in (200, 201) else {}
        name = " ".join(x for x in (info.get("first-name"), info.get("last-name")) if x)
    except ValueError:
        pass
    data = {"access_token": token, "polar_user_id": polar_uid, "name": name,
            "connected_at": datetime.now().astimezone().isoformat(timespec="seconds")}
    save_tokens(user_id, PROVIDER, data)
    log.info("Polar csatlakoztatva (user=%s)", user_id)
    return data


def _req(user_id: str, path: str, accept: str = "application/json"):
    data = load_tokens(user_id, PROVIDER)
    if not data.get("access_token"):
        raise DeviceAuthError("Nincs Polar-kapcsolat.")
    try:
        r = requests.get(f"{_API}{path}", timeout=60,
                         headers={"Authorization": f"Bearer {data['access_token']}", "Accept": accept})
    except requests.RequestException as exc:
        raise DeviceApiError(f"A Polar nem érhető el: {exc}") from exc
    if r.status_code in (401, 403):
        raise DeviceAuthError("A Polar-kapcsolat érvénytelenné vált.")
    if r.status_code == 429:
        raise DeviceApiError("A Polar átmenetileg korlátozza a lekérdezést (túl sok kérés).")
    if r.status_code not in (200, 204):
        raise DeviceApiError(f"Polar API hiba ({r.status_code}).")
    return r


def _iso_duration_s(s: str | None) -> float | None:
    """ISO 8601 időtartam (pl. PT1H2M3.5S) → másodperc."""
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?", s or "")
    if not m:
        return None
    d, h, mi, se = (float(x) if x else 0 for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + se


def _start_ts(e: dict) -> int:
    """A Polar a helyi kezdési időt adja (+ start_time_utc_offset percben, ha van)."""
    st = e.get("start_time") or e.get("start-time")
    if not st:
        return 0
    try:
        dt = datetime.fromisoformat(st.replace("Z", "+00:00"))
    except ValueError:
        return 0
    if dt.tzinfo is None:
        off = e.get("start_time_utc_offset", e.get("start-time-utc-offset"))
        dt = dt.replace(tzinfo=timezone(timedelta(minutes=int(off))) if off is not None else _TZ)
    return int(dt.timestamp())


def _sport(e: dict) -> str:
    s = str(e.get("sport") or e.get("detailed_sport_info") or e.get("detailed-sport-info") or "").lower()
    if "run" in s: return "running"
    if "walk" in s: return "walking"
    if "hik" in s: return "hiking"
    return "cycling"


def list_activities(user_id: str, days: int = 30, limit: int = 30) -> list:
    """Edzések normalizált listája dedup-státusszal (legújabb elöl). A Polar csak a
    csatlakozás után feltöltött, legfeljebb 30 napos edzéseket adja."""
    ex = _req(user_id, "/exercises").json() or []
    since = time.time() - days * 86400
    out = []
    for e in ex:
        st = _start_ts(e)
        has_route = e.get("has_route", e.get("has-route"))
        if (st and st < since) or has_route is False:
            continue                                     # régi / GPS nélküli (beltéri) edzés
        out.append({
            "id": str(e["id"]), "name": "", "start_ts": st,
            "start_date": datetime.fromtimestamp(st, timezone.utc).isoformat() if st else None,
            "distance_m": e.get("distance"),
            "moving_time_s": _iso_duration_s(e.get("duration")),
            "total_elevation_gain": None, "sport": _sport(e),
        })
    out.sort(key=lambda x: x["start_ts"], reverse=True)
    return mark_duplicates(user_id, PROVIDER, out[:limit])


def import_activity(user_id: str, exercise_id: str, dedup: bool = False) -> dict:
    """Egy edzés FIT-je (tartalékként GPX-e) → könyvtár."""
    e = _req(user_id, f"/exercises/{exercise_id}").json() or {}
    fit = None
    r = _req(user_id, f"/exercises/{exercise_id}/fit", accept="*/*")
    if r.status_code == 200 and r.content[8:12] == b".FIT":
        fit = r.content
    gpx = None
    if not fit:
        g = _req(user_id, f"/exercises/{exercise_id}/gpx", accept="application/gpx+xml")
        gpx = g.text if g.status_code == 200 else None
    hr = e.get("heart_rate") or e.get("heart-rate") or {}
    return save_workout(
        user_id, PROVIDER, str(exercise_id), fit_bytes=fit, gpx_text=gpx, name="",
        start_ts=_start_ts(e), distance_m=e.get("distance"), dedup=dedup,
        extra={"sport": _sport(e), "moving_s": _iso_duration_s(e.get("duration")),
               "calories": e.get("calories"), "avg_hr": hr.get("average"), "max_hr": hr.get("maximum")})


def disconnect(user_id: str) -> None:
    """Regisztráció törlése a Polarnál (ez visszavonja a tokent is) – best-effort."""
    data = load_tokens(user_id, PROVIDER)
    if not data.get("polar_user_id") or not data.get("access_token"):
        return
    try:
        requests.delete(f"{_API}/users/{data['polar_user_id']}", timeout=15,
                        headers={"Authorization": f"Bearer {data['access_token']}"})
    except Exception as exc:
        log.info("Polar leregisztrálás sikertelen (user=%s): %s", user_id, exc)
