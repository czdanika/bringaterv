"""Bringaterv API – iGPSport helperek: belépés, token, edzés-import (FIT), útvonal-feltöltés.

Nem hivatalos API: az iGPSport webes felülete (app.igpsport.com) által használt végpontok,
a nemzetközi (prod.en.igpsport.com) fiókhoz. Ha az iGPSport változtat, csak ez a modul áll le.
Részletek, élő teszt eredménye: docs/IGPSPORT_NOTES.md (git-ignorált).

Belépés: e-mail + jelszó → Bearer access_token (7 nap). A refresh_token nyilvános kliens-
adatok nélkül nem használható (a webes felület is újra beléptet) → lejárat előtt push-értesítés,
a felhasználó újracsatlakozik. A jelszót SOHA nem tároljuk.

Token tárolás: /data/users/<uid>/igpsport.json (0600).

Időzóna: a lista csak dátumot ad, a részletek `startTime`-ja kínai idő (UTC+8) – importnál
a FIT saját (UTC) idejét használjuk.
"""

import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import requests

from config import log
from storage import _user_dir, _user_routes_dir
from utils import _load_index, _now_dt, append_index, find_cross_source_duplicate

from fit_gpx import FIT_AVAILABLE, _xml, equipment_fields, fit_to_gpx

_BASE      = "https://prod.en.igpsport.com"
_UA        = "Mozilla/5.0 (Bringaterv; +https://github.com/czdanika/bringaterv)"
_TZ        = ZoneInfo("Europe/Budapest")
_SRV_TZ    = ZoneInfo("Asia/Shanghai")          # a részletek startTime-ja ebben van
_MAX_GPX_BYTES = 10 * 1024 * 1024               # az iGPSport korlátja
_FILE_HOST_SUFFIX = ".aliyuncs.com"             # FIT-letöltés és feltöltés csak ide
EXERCISE = {"asphalt": 0, "cycling": 0, "gravel": 0, "mtb": 1, "walking": 3, "hiking": 3, "running": 2}


class IgpAuthError(Exception):
    """Hibás jelszó, vagy a token lejárt / érvénytelen."""


class IgpApiError(Exception):
    """Az iGPSport szerver hibát adott vagy nem érhető el."""


# ── Per-user token tárolás ────────────────────────────────────────────────────

def _path(user_id: str) -> str:
    return os.path.join(_user_dir(user_id), "igpsport.json")


def _load(user_id: str) -> dict:
    try:
        with open(_path(user_id), encoding="utf-8") as f:
            return json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save(user_id: str, data: dict) -> None:
    os.makedirs(_user_dir(user_id), exist_ok=True)
    path = _path(user_id)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(path + ".tmp", 0o600)
    os.replace(path + ".tmp", path)


def igp_disconnect(user_id: str) -> None:
    if os.path.isfile(_path(user_id)):
        os.remove(_path(user_id))


# ── Kérések ───────────────────────────────────────────────────────────────────

def _headers(token: str | None = None) -> dict:
    h = {"User-Agent": _UA, "Accept-Language": "en", "TimeZone": "Europe/Budapest", "X-Platform": "web",
         "Accept": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _call(method: str, path: str, token: str | None = None, params: dict | None = None,
          body: dict | None = None, timeout: int = 30):
    """Kérés az iGPSport API felé → a válasz `data` mezője. Hibák: IgpAuthError / IgpApiError."""
    try:
        resp = requests.request(method, _BASE + path, params=params, json=body, timeout=timeout,
                                headers=_headers(token))
    except requests.RequestException as exc:
        raise IgpApiError(f"Az iGPSport szerver nem érhető el: {exc}") from exc
    if resp.status_code == 401:
        raise IgpAuthError("Lejárt vagy érvénytelen iGPSport-belépés.")
    try:
        j = resp.json()
    except ValueError:
        raise IgpApiError(f"Váratlan válasz az iGPSporttól (HTTP {resp.status_code})")
    code = j.get("code")
    if code == 401:
        raise IgpAuthError(j.get("message") or "Lejárt iGPSport-belépés.")
    if resp.status_code == 403 and code in (1020, 1021, 1022):
        # a webes kliensben előkészített kérés-aláírást bekapcsolták – ezt a modult frissíteni kell
        raise IgpApiError("Az iGPSport megváltoztatta a hozzáférés módját – az integráció frissítésre szorul.")
    if resp.status_code >= 400 or code not in (0, None):
        raise IgpApiError(j.get("message") or f"iGPSport hiba (HTTP {resp.status_code}, code {code})")
    return j.get("data")


# ── Belépés, munkamenet ───────────────────────────────────────────────────────

def igp_login(user_id: str, account: str, password: str) -> dict:
    try:
        resp = requests.post(_BASE + "/service/auth/account/login", timeout=30, headers=_headers(),
                             json={"appId": "igpsport-web", "username": account, "password": password})
        j = resp.json()
    except (requests.RequestException, ValueError) as exc:
        raise IgpApiError(f"Az iGPSport belépés nem érhető el: {exc}") from exc
    d = j.get("data") or {}
    if not isinstance(d, dict) or not d.get("access_token"):
        if resp.status_code in (400, 401, 403) or j.get("code") not in (0, None):
            raise IgpAuthError(j.get("message") or "Hibás e-mail vagy jelszó.")
        raise IgpApiError("Az iGPSport belépés nem adott tokent.")
    token = d["access_token"]
    info = {}
    try:
        info = _call("GET", "/service/mobile/api/User/UserInfo", token) or {}
    except (IgpApiError, IgpAuthError):
        pass
    data = {
        "account":      account,
        "token":        token,
        "expires_at":   int(time.time()) + int(d.get("expires_in") or 604800),
        "member_id":    info.get("memberId"),
        "nickname":     info.get("nickName"),
        "connected_at": _now_dt(),
    }
    _save(user_id, data)
    log.info("iGPSport csatlakoztatva (user=%s, member=%s)", user_id, data["member_id"])
    return data


def igp_token(user_id: str) -> str | None:
    """Érvényes token, vagy None (nincs kapcsolat). Lejárt → IgpAuthError."""
    data = _load(user_id)
    if not data.get("token"):
        return None
    if int(data.get("expires_at") or 0) <= time.time():
        raise IgpAuthError("Lejárt az iGPSport-belépés (7 naponta újra kell csatlakozni).")
    return data["token"]


def igp_status(user_id: str) -> dict:
    data = _load(user_id)
    exp = int(data.get("expires_at") or 0)
    return {
        "available":    FIT_AVAILABLE,
        "connected":    bool(data.get("token")) and exp > time.time(),
        "expired":      bool(data.get("token")) and exp <= time.time(),
        "account":      data.get("account"),
        "nickname":     data.get("nickname"),
        "connected_at": data.get("connected_at"),
        "expires_at":   datetime.fromtimestamp(exp, timezone.utc).isoformat() if exp else None,
    }


# ══════════════════════════════════════════════════════════════════════════════
# EDZÉS-IMPORT
# ══════════════════════════════════════════════════════════════════════════════

def _deny_path(user_id: str) -> str:
    return os.path.join(_user_dir(user_id), "igpsport_deleted.json")


def load_deny(user_id: str) -> dict:
    try:
        with open(_deny_path(user_id), encoding="utf-8") as f:
            return (json.load(f) or {}).get("deleted_at") or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_deny(user_id: str, deny: dict) -> None:
    os.makedirs(_user_dir(user_id), exist_ok=True)
    with open(_deny_path(user_id) + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"deleted_at": deny}, f, ensure_ascii=False, indent=2)
    os.replace(_deny_path(user_id) + ".tmp", _deny_path(user_id))


def add_deny(user_id: str, ride_id: str) -> None:
    deny = load_deny(user_id)
    deny[str(ride_id)] = _now_dt()
    _save_deny(user_id, deny)


def remove_deny(user_id: str, ride_id: str) -> bool:
    deny = load_deny(user_id)
    removed = deny.pop(str(ride_id), None) is not None
    if removed:
        _save_deny(user_id, deny)
    return removed


def list_rides(token: str, max_items: int = 30) -> list:
    """Nyers edzéslista (legújabb elöl), oldalanként 20."""
    out, page = [], 1
    while len(out) < max_items and page <= 50:
        d = _call("GET", "/service/web-gateway/web-analyze/activity/queryMyActivity", token,
                  params={"pageNo": str(page), "pageSize": "20", "sort": "1", "reqType": "0"}) or {}
        rows = d.get("rows") or []
        out.extend(r for r in rows if isinstance(r, dict) and r.get("rideId") is not None)
        if len(rows) < 20 or page >= int(d.get("totalPage") or 1):
            break
        page += 1
    return out[:max_items]


def ride_detail(token: str, ride_id) -> dict:
    return _call("GET", f"/service/web-gateway/web-analyze/activity/queryActivityDetail/{ride_id}", token) or {}


def _start_ts(detail: dict) -> int | None:
    """A részletek startTime-ja kínai idő szerint ("2026-10-30 17:08:28") → unix (UTC)."""
    s = str(detail.get("startTime") or "")
    try:
        return int(datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=_SRV_TZ).timestamp())
    except ValueError:
        return None


def _list_date(row: dict) -> str | None:
    """A lista startTime-ja csak dátum ("2026.10.30") → ISO dátum."""
    m = re.match(r"(\d{4})[.\-](\d{2})[.\-](\d{2})", str(row.get("startTime") or ""))
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None


def _default_name(start_ts: int | None, sport: str = "cycling") -> str:
    h = datetime.fromtimestamp(start_ts, _TZ).hour if start_ts else 12
    part = ("Éjszakai" if h < 5 else "Reggeli" if h < 11 else "Déli" if h < 14
            else "Délutáni" if h < 18 else "Esti" if h < 22 else "Éjszakai")
    noun = {"running": "futás", "walking": "séta", "hiking": "túra"}.get(sport, "kerékpározás")
    return f"{part} {noun}"


def _ride_name(title: str, start_ts: int | None, sport: str = "cycling") -> str:
    """Az iGPSport sokszor fájlnevet / azonosítót ad címnek (pl. „127de720”) – akkor napszakos név."""
    t = (title or "").strip()
    if t and not re.fullmatch(r"[0-9a-fA-F\-_.]{6,}|Outdoor cycling|Ride|Cycling", t, flags=re.I):
        return t
    return _default_name(start_ts, sport)


def igp_list_activities(token: str, user_id: str, limit: int = 30, with_times: bool = True) -> list:
    """Edzések normalizált listája dedup-státusszal (legújabb elöl). A pontos indulási idő a
    részletekből jön (soronként egy kérés) – a „Hasonló van” jelzéshez kell."""
    rows = list_rides(token, limit)
    idx = _load_index(os.path.join(_user_routes_dir(user_id), "index.json"))
    by_igp = {str(r.get("igpsport_id")): r for r in idx if r.get("igpsport_id")}
    deny = load_deny(user_id)
    out = []
    for r in rows:
        rid = str(r["rideId"])
        dist_m = float(r.get("rideDistance") or 0)
        start_ts = None
        if with_times and rid not in by_igp:
            try:
                start_ts = _start_ts(ride_detail(token, rid))
            except IgpApiError:
                start_ts = None
        local = by_igp.get(rid)
        if local and not start_ts and local.get("start_time"):     # már importált: a könyvtári idő és név
            try:
                start_ts = int(datetime.fromisoformat(str(local["start_time"]).replace("Z", "+00:00")).timestamp())
            except ValueError:
                pass
        deleted = rid in deny
        cross = None if (local or deleted or not start_ts) else find_cross_source_duplicate(idx, start_ts, dist_m, "igpsport_id")
        out.append({
            "id":            rid,
            "name":          (local or {}).get("name") or _ride_name(r.get("title"), start_ts),
            "start_ts":      start_ts,
            "start_date":    datetime.fromtimestamp(start_ts, timezone.utc).isoformat() if start_ts else _list_date(r),
            "distance_m":    dist_m or None,
            "moving_time_s": r.get("totalMovingTime"),
            "total_elevation_gain": r.get("totalAscent"),
            "duplicate_status":
                "already_imported" if local else
                ("previously_deleted" if deleted else ("likely_duplicate" if cross else "new")),
            "duplicate_local_id": local["id"] if local else (cross["id"] if cross else None),
        })
    return out


def _safe_file_url(url: str) -> bool:
    p = urlparse(url or "")
    return p.scheme == "https" and (p.hostname or "").endswith(_FILE_HOST_SUFFIX)


def igp_import_activity(token: str, user_id: str, ride_id: str, dedup: bool = False) -> dict:
    """Egy iGPSport-edzés eredeti FIT-jét letölti, GPX-et készít, menti a könyvtárba
    (type=workout, a FIT is megmarad)."""
    routes_dir = _user_routes_dir(user_id)
    idx_path = os.path.join(routes_dir, "index.json")
    idx = _load_index(idx_path)
    if any(str(r.get("igpsport_id")) == ride_id for r in idx):
        return {"ok": True, "skipped": True, "reason": "already_imported"}

    det = ride_detail(token, ride_id)
    if not det:
        return {"ok": False, "error": "Az edzés nem található az iGPSportban (törölték?)."}
    start_ts = _start_ts(det)
    if dedup and start_ts:
        dup = find_cross_source_duplicate(idx, start_ts, float(det.get("rideDistance") or 0), "igpsport_id")
        if dup:
            return {"ok": True, "skipped": True, "reason": "duplicate",
                    "duplicate_local_id": dup["id"], "duplicate_name": dup.get("name")}
    url = det.get("fitUrl")
    if not url:
        try:
            url = _call("GET", f"/service/web-gateway/web-analyze/activity/getDownloadUrl/{ride_id}", token)
        except IgpApiError:
            url = None
    if not url or not _safe_file_url(str(url)):
        return {"ok": False, "error": "Ehhez az edzéshez nincs letölthető FIT."}
    try:
        resp = requests.get(url, headers={"User-Agent": _UA}, timeout=60)
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise IgpApiError(f"A FIT letöltése sikertelen: {exc}") from exc
    fit_bytes = resp.content
    if fit_bytes[8:12] != b".FIT":
        return {"ok": False, "error": "Az iGPSport nem FIT fájlt adott vissza."}

    gpx_text, s = fit_to_gpx(fit_bytes, "iGPSport")
    if not gpx_text:   # GPS nélkül: beltéri edzés – adatsorként mentjük
        from indoor import save_indoor_from_fit
        return save_indoor_from_fit(user_id, fit_bytes, name=_ride_name(det.get("title"), start_ts, s.get("sport") or "cycling"),
                                    source="igpsport", id_field="igpsport_id", source_id=ride_id,
                                    start_dt=datetime.fromtimestamp(start_ts, timezone.utc) if start_ts else None)
    sport = s.get("sport") or "cycling"
    start_dt = s.get("start_time") if isinstance(s.get("start_time"), datetime) \
        else datetime.fromtimestamp(start_ts or time.time(), timezone.utc)
    name = _ride_name(det.get("title"), int(start_dt.timestamp()), sport)
    gpx_text = gpx_text.replace("<name>iGPSport</name>", f"<name>{_xml(name)}</name>", 1)

    new_id = uuid.uuid4().hex[:8]
    with open(os.path.join(routes_dir, f"{new_id}.gpx"), "w", encoding="utf-8") as f:
        f.write(gpx_text)
    with open(os.path.join(routes_dir, f"{new_id}.fit"), "wb") as f:
        f.write(fit_bytes)

    dist_m = s.get("distance_m") or det.get("rideDistance") or 0
    mov_s = s.get("moving_s") or det.get("totalMovingTime") or 0
    ele_m = s.get("ascent_m") if s.get("ascent_m") is not None else det.get("totalAscent")
    avg_sp, max_sp = s.get("avg_speed"), s.get("max_speed")
    entry = {
        "id":           new_id,
        "name":         name,
        "type":         "workout",
        "sport_type":   sport,
        "distance":     round(float(dist_m) / 1000, 2),
        "duration":     round(float(mov_s) / 60) if mov_s else None,
        "elevation":    round(float(ele_m)) if ele_m else 0,
        "date":         start_dt.astimezone(_TZ).strftime("%Y-%m-%d"),
        "start_time":   start_dt.astimezone(timezone.utc).isoformat(),
        "igpsport_id":  ride_id,
        "source":       "igpsport",
        "has_fit":      True,
        "imported_at":  _now_dt(),
        "include_in_stats": True,
        "description":  "",
        "calories":      s.get("calories"),
        "avg_heartrate": s.get("avg_hr") or det.get("avgHrm"),
        "max_heartrate": s.get("max_hr") or det.get("maxHrm"),
        "avg_watts":     s.get("avg_power") or det.get("avgPower"),
        "max_watts":     s.get("max_power") or det.get("maxPower"),
        "avg_cadence":   s.get("avg_cadence") or det.get("avgCad"),
        "avg_speed_kmh": round(avg_sp * 3.6, 2) if avg_sp else None,
        "max_speed_kmh": round(max_sp * 3.6, 2) if max_sp else None,
        **equipment_fields(s.get("equipment")),
    }
    append_index(idx_path, entry)
    try:
        import temp_weather
        temp_weather.fill_soon(user_id)
    except Exception:
        pass
    return {"ok": True, "skipped": False, "entry": entry}


# ══════════════════════════════════════════════════════════════════════════════
# ÚTVONAL-FELTÖLTÉS (tervezett útvonal → iGPSport útvonalai → komputer)
# ══════════════════════════════════════════════════════════════════════════════

def _prepare_route_gpx(gpx_text: str, name: str) -> str:
    """Az útpontok (<wpt>) kikerülnek (a komputer a nyomvonalon navigál), a név a könyvtári név."""
    gpx_text = re.sub(r"<wpt\b.*?</wpt>\s*", "", gpx_text, flags=re.DOTALL)
    tag = f"<name>{_xml(name)}</name>"
    if re.search(r"<name>.*?</name>", gpx_text, re.DOTALL):
        return re.sub(r"<name>.*?</name>", lambda _m: tag, gpx_text, flags=re.DOTALL)
    return re.sub(r"(<(?:trk|rte)>)", lambda m: m.group(1) + tag, gpx_text, count=1)


def _route_shape(gpx_text: str) -> int:
    """roadBookType: 0 egyirányú, 2 kör (rajt és cél 300 m-en belül)."""
    pts = re.findall(r'<(?:trkpt|rtept)\b[^>]*?\blat="([-\d.]+)"[^>]*?\blon="([-\d.]+)"', gpx_text)
    if len(pts) < 2:
        return 0
    import math
    (a1, o1), (a2, o2) = [(float(a), float(o)) for a, o in (pts[0], pts[-1])]
    d = 6371000 * math.hypot(math.radians(a2 - a1), math.radians(o2 - o1) * math.cos(math.radians(a1)))
    return 2 if d < 300 else 0


def igp_upload_route(token: str, name: str, gpx_text: str, mode: str = "asphalt",
                     description: str = "", start_place: str = "", end_place: str = "",
                     public: bool = False) -> dict:
    """GPX → aláírt OSS-feltöltés → útvonal készítése. Visszaad: {ok, road_id, name, distance, ascent}."""
    name = (name or "Bringaterv útvonal").strip()[:50]
    raw = _prepare_route_gpx(gpx_text, name).encode("utf-8")
    if len(raw) > _MAX_GPX_BYTES:
        return {"ok": False, "error": "Az útvonal GPX-e nagyobb 10 MB-nál (az iGPSport korlátja)."}
    if b"<trkpt" not in raw and b"<rtept" not in raw:
        return {"ok": False, "error": "Az útvonalban nincsenek pontok."}
    signed = _call("GET", "/service/sportg/third-party-server/oss/getSignedUrl", token,
                   params={"fileExtension": ".gpx"}) or {}
    url, oss_id = signed.get("signedUrl"), signed.get("ossId")
    if not url or not oss_id or not _safe_file_url(url):
        raise IgpApiError("Az iGPSport nem adott feltöltési címet.")
    try:
        put = requests.put(url, data=raw, headers={"Content-Type": ""}, timeout=60)
        put.raise_for_status()
    except requests.RequestException as exc:
        raise IgpApiError(f"A GPX feltöltése sikertelen: {exc}") from exc
    _call("POST", "/service/web-gateway/roadbook4j/web-road-book/uploadOssGenerateRoutes", token, body={
        "title": name, "description": (description or "")[:500],
        "startPlace": (start_place or "")[:50], "endPlace": (end_place or "")[:50],
        "exerciseType": EXERCISE.get(mode, 0), "roadBookType": _route_shape(gpx_text),
        "status": 1 if public else 0, "fileId": oss_id, "fileName": f"{uuid.uuid4().hex[:8]}.gpx",
        "sourceType": 4,
    }, timeout=60)
    # a válasz nem ad azonosítót – a legfrissebb, azonos nevű útvonal a sajátjaink közül
    road = {}
    try:
        books = _call("GET", "/service/web-gateway/roadbook4j/web-road-book/myRoadBook", token,
                      params={"pageNo": 1, "pageSize": 10}) or []
        road = next((b for b in books if b.get("title") == name), {}) if isinstance(books, list) else {}
    except IgpApiError:
        pass
    return {"ok": True, "road_id": road.get("roadId"), "name": name,
            "distance": road.get("distance"), "ascent": road.get("totalAscent")}
