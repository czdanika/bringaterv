"""Bringaterv API – Wahoo Cloud API (hivatalos): OAuth, edzéslista, FIT-import.

Dokumentáció: https://cloud-api.wahooligan.com/ – fejlesztői app: developers.wahooligan.com
(a Wahoo jóváhagyja; a „Sandbox” app azonnal megy, de napi 250 kérés a kerete).

  • OAuth 2.0: authorize → code → token. Az access token 2 óráig él; a refresh új
    access ÉS refresh tokent ad (a régi az első használatkor érvénytelenül) → zár alatt.
  • Edzések: GET /v1/workouts (lapozva, legújabb elöl), a FIT a workout_summary.file.url-ről.
  • A Wahoo csak a saját eszközein / appjaiban rögzített edzéseket adja ki (harmadik
    féltől oda feltöltöttet nem).
"""

import fcntl
import os
import time
from contextlib import contextmanager
from datetime import datetime
from urllib.parse import urlencode, urlparse

import requests

from config import log
from device_import import (DeviceApiError, DeviceAuthError, load_app, load_tokens, mark_duplicates,
                           save_tokens, save_workout)
from storage import _user_dir

PROVIDER = "wahoo"
_API = "https://api.wahooligan.com"
_SCOPES = "user_read workouts_read offline_data"


def auth_url(user_id: str, state: str, redirect: str) -> str:
    app = load_app(PROVIDER, user_id)
    return f"{_API}/oauth/authorize?" + urlencode({
        "client_id": app["client_id"], "redirect_uri": redirect,
        "response_type": "code", "scope": _SCOPES, "state": state,
    })


def _token_request(user_id: str, params: dict) -> dict:
    app = load_app(PROVIDER, user_id)
    try:
        r = requests.post(f"{_API}/oauth/token", timeout=20, params={
            "client_id": app["client_id"], "client_secret": app["client_secret"], **params})
    except requests.RequestException as exc:
        raise DeviceApiError(f"A Wahoo nem érhető el: {exc}") from exc
    if r.status_code in (400, 401, 403):
        raise DeviceAuthError(f"A Wahoo elutasította a belépést ({r.status_code}).")
    if r.status_code != 200:
        raise DeviceApiError(f"Wahoo token-hiba ({r.status_code}).")
    td = r.json()
    return {"access_token": td["access_token"], "refresh_token": td.get("refresh_token", ""),
            "expires_at": int(time.time()) + int(td.get("expires_in") or 7200)}


def exchange_code(user_id: str, code: str, redirect: str) -> dict:
    """Callback: code → tokenek, + a felhasználó neve (user_read)."""
    tok = _token_request(user_id, {"code": code, "redirect_uri": redirect,
                          "grant_type": "authorization_code"})
    data = {**tok, "connected_at": datetime.now().astimezone().isoformat(timespec="seconds")}
    try:
        u = requests.get(f"{_API}/v1/user", timeout=20,
                         headers={"Authorization": f"Bearer {tok['access_token']}"}).json()
        data["name"] = " ".join(x for x in (u.get("first"), u.get("last")) if x) or u.get("email") or ""
    except (requests.RequestException, ValueError):
        data["name"] = ""
    save_tokens(user_id, PROVIDER, data)
    log.info("Wahoo csatlakoztatva (user=%s)", user_id)
    return data


@contextmanager
def _lock(user_id: str):
    os.makedirs(_user_dir(user_id), exist_ok=True)
    with open(os.path.join(_user_dir(user_id), ".wahoo_token.lock"), "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def _access_token(user_id: str) -> str | None:
    """Érvényes access token; lejárat előtt (a Wahoo ajánlása szerint közvetlenül a hívás
    előtt) frissít. None, ha nincs kapcsolat."""
    data = load_tokens(user_id, PROVIDER)
    if not data.get("access_token"):
        return None
    if data.get("expires_at", 0) - time.time() > 120:
        return data["access_token"]
    with _lock(user_id):
        data = load_tokens(user_id, PROVIDER)          # a másik worker közben frissíthetett
        if data.get("expires_at", 0) - time.time() > 120:
            return data["access_token"]
        tok = _token_request(user_id, {"grant_type": "refresh_token", "refresh_token": data.get("refresh_token", "")})
        data.update(tok)
        save_tokens(user_id, PROVIDER, data)
        return data["access_token"]


def _get(user_id: str, path: str, params: dict | None = None):
    token = _access_token(user_id)
    if not token:
        raise DeviceAuthError("Nincs Wahoo-kapcsolat.")
    try:
        r = requests.get(f"{_API}{path}", params=params, timeout=30,
                         headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    except requests.RequestException as exc:
        raise DeviceApiError(f"A Wahoo nem érhető el: {exc}") from exc
    if r.status_code == 401:
        raise DeviceAuthError("A Wahoo-kapcsolat érvénytelenné vált.")
    if r.status_code == 429:
        raise DeviceApiError("A Wahoo átmenetileg korlátozza a lekérdezést (túl sok kérés).")
    if r.status_code == 422:
        raise DeviceApiError("A Wahoo-alkalmazás nincs jóváhagyva ehhez (422).")
    if r.status_code != 200:
        raise DeviceApiError(f"Wahoo API hiba ({r.status_code}).")
    return r.json()


def _ts(iso: str | None) -> int:
    try:
        return int(datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp())
    except (TypeError, ValueError):
        return 0


def _summary_num(w: dict, key: str):
    v = (w.get("workout_summary") or {}).get(key)
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def list_activities(user_id: str, days: int = 30, limit: int = 30) -> list:
    """Edzések normalizált listája dedup-státusszal (legújabb elöl)."""
    since = time.time() - days * 86400
    out, page = [], 1
    while len(out) < limit and page <= 20:
        d = _get(user_id, "/v1/workouts", {"page": page, "per_page": 50}) or {}
        ws = d.get("workouts") or []
        for w in ws:
            st = _ts(w.get("starts"))
            if st and st < since:
                ws = []                                  # rendezett lista: innen csak régebbiek
                break
            dist = _summary_num(w, "distance_accum")
            out.append({
                "id": w["id"], "name": w.get("name") or "", "start_ts": st,
                "start_date": w.get("starts"), "distance_m": dist,
                "moving_time_s": _summary_num(w, "duration_active_accum") or (w.get("minutes") or 0) * 60 or None,
                "total_elevation_gain": _summary_num(w, "ascent_accum"),
            })
            if len(out) >= limit:
                break
        if len(ws) < 50:
            break
        page += 1
    return mark_duplicates(user_id, PROVIDER, out)


def import_activity(user_id: str, workout_id: int, dedup: bool = False) -> dict:
    """Egy edzés FIT-je → könyvtár (az eredeti FIT is megmarad)."""
    w = _get(user_id, f"/v1/workouts/{int(workout_id)}") or {}
    summ = w.get("workout_summary") or {}
    if not summ.get("file"):
        try:
            summ = _get(user_id, f"/v1/workouts/{int(workout_id)}/workout_summary") or {}
        except DeviceApiError:
            summ = {}
    url = (summ.get("file") or {}).get("url") or ""
    if urlparse(url).scheme != "https":
        return {"ok": False, "error": "Ehhez az edzéshez a Wahoo nem ad FIT-fájlt."}
    try:
        r = requests.get(url, timeout=60)
        r.raise_for_status()
    except requests.RequestException as exc:
        raise DeviceApiError(f"A FIT letöltése sikertelen: {exc}") from exc
    fit = r.content if r.content[8:12] == b".FIT" else None
    if not fit:
        return {"ok": False, "error": "A Wahoo nem FIT fájlt adott vissza."}
    num = lambda k: float(summ[k]) if summ.get(k) not in (None, "") else None
    return save_workout(
        user_id, PROVIDER, int(workout_id), fit_bytes=fit, name=w.get("name") or "",
        start_ts=_ts(w.get("starts")), distance_m=num("distance_accum"), dedup=dedup,
        extra={"moving_s": num("duration_active_accum"), "ascent_m": num("ascent_accum"),
               "calories": num("calories_accum"), "avg_hr": num("heart_rate_avg"),
               "avg_power": num("power_avg"), "avg_speed": num("speed_avg")})


def disconnect(user_id: str) -> None:
    """Hozzáférés visszavonása a Wahoo-nál (best-effort); a tokenfájlt a hívó törli."""
    try:
        token = _access_token(user_id)
        if token:
            requests.delete(f"{_API}/v1/permissions", timeout=15,
                            headers={"Authorization": f"Bearer {token}"})
    except Exception as exc:
        log.info("Wahoo visszavonás sikertelen (user=%s): %s", user_id, exc)
