"""Bringaterv API – Garmin Connect helperek (login, MFA, tokenek, testsúly).

A python-garminconnect (garth-alapú) library-re épül. Nincs OAuth app:
email + jelszó (+ MFA) → ~1 évig érvényes DI tokenek.

Token tárolás: /data/users/<uid>/garmin.json (0600), csak a token-dump –
jelszót SOHA nem tárolunk.

MFA: a library MFA-állapota a kliens objektumon él, ezért két HTTP kérés
között (2 gunicorn worker!) fájlba pickle-eljük – ugyanaz a minta, mint a
Strava OAuth state-tár.
"""

import json
import os
import pickle
import time
import uuid

from config import log
from storage import _user_dir, _user_routes_dir
from utils import _load_index, _now_dt, _save_index

try:
    from garminconnect import (
        Garmin,
        GarminConnectAuthenticationError,
        GarminConnectConnectionError,
        GarminConnectTooManyRequestsError,
    )
    GARMIN_AVAILABLE = True
except ImportError:
    GARMIN_AVAILABLE = False
    Garmin = None
    GarminConnectAuthenticationError = GarminConnectConnectionError = \
        GarminConnectTooManyRequestsError = Exception

# GPS-alapú Garmin aktivitás-típusok (csak ezeknek van térképük/útvonaluk).
# A többit (konditermi, jóga, erősítés, úszás stb.) nem listázzuk.
_GARMIN_NON_GPS_TYPES = {
    "strength_training", "indoor_cardio", "yoga", "pilates", "elliptical",
    "stair_climbing", "indoor_cycling", "fitness_equipment", "breathwork",
    "lap_swimming", "open_water_swimming", "whitewater_rafting_kayaking",
    "hiit", "bouldering", "indoor_climbing", "meditation", "other",
}

# A kliens objektumon élő MFA-állapot attribútumai (lásd garminconnect.client)
_MFA_STATE_ATTRS = (
    "_mfa_flow", "_mfa_login_params", "_mfa_method", "_mfa_post_headers",
    "_mfa_service_url", "_mfa_session", "_widget_last_resp", "_widget_web_login",
)

_GARMIN_STATES_DIR = os.environ.get("GARMIN_STATES_DIR", "/data/garmin_states")
_GARMIN_STATE_TTL = 10 * 60  # 10 perc


class GarminMfaRequired(Exception):
    """A belépéshez MFA kód szükséges."""


class GarminStateExpired(Exception):
    """Az MFA folytatási állapot lejárt vagy hiányzik – újra kell kezdeni a belépést."""


# ── Per-user token tárolás (/data/users/<uid>/garmin.json) ────────────────────

def _user_garmin_path(user_id: str) -> str:
    return os.path.join(_user_dir(user_id), "garmin.json")


def _load_user_garmin(user_id: str) -> dict:
    path = _user_garmin_path(user_id)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_user_garmin(user_id: str, data: dict) -> None:
    os.makedirs(_user_dir(user_id), exist_ok=True)
    path = _user_garmin_path(user_id)
    tmp  = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _delete_user_garmin(user_id: str) -> None:
    path = _user_garmin_path(user_id)
    if os.path.isfile(path):
        os.remove(path)


def _resolve_garmin_name(garmin) -> str:
    """A megjelenítendő név. MFA (resume) után a library nem tölti be a profilt,
    ezért üres név esetén explicit lekérjük a social profile-t."""
    name = (garmin.get_full_name() or "").strip()
    if name:
        return name
    name = (getattr(garmin, "display_name", None) or "").strip()
    if name:
        return name
    # Fallback: közvetlen profil lekérés
    try:
        prof = garmin.client.connectapi("/userprofile-service/socialProfile")
        if isinstance(prof, dict):
            return (prof.get("fullName") or prof.get("displayName") or "").strip()
    except Exception as exc:
        log.debug("Garmin profilnév lekérés sikertelen: %s", exc)
    return ""


def _persist_garmin_session(user_id: str, garmin) -> dict:
    """Sikeres login/resume után elmenti a tokeneket + profil adatokat."""
    data = _load_user_garmin(user_id)
    data.update({
        "tokens":       garmin.client.dumps(),
        "full_name":    _resolve_garmin_name(garmin),
        "display_name": getattr(garmin, "display_name", None),
        "connected_at": data.get("connected_at") or _now_dt(),
    })
    _save_user_garmin(user_id, data)
    return data


# ── MFA folytatási állapot (fájl-alapú, worker-független) ─────────────────────

def _mfa_state_path(user_id: str) -> str:
    return os.path.join(_GARMIN_STATES_DIR, f"{user_id}.pkl")


def _save_mfa_state(user_id: str, garmin) -> None:
    attrs = {}
    for name in _MFA_STATE_ATTRS:
        if hasattr(garmin.client, name):
            attrs[name] = getattr(garmin.client, name)
    os.makedirs(_GARMIN_STATES_DIR, exist_ok=True)
    path = _mfa_state_path(user_id)
    tmp  = path + ".tmp"
    with open(tmp, "wb") as f:
        pickle.dump({"attrs": attrs, "expiry_ts": time.time() + _GARMIN_STATE_TTL}, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _consume_mfa_state(user_id: str) -> dict:
    """Betölti és törli az MFA állapotot. GarminStateExpired ha nincs/lejárt."""
    path = _mfa_state_path(user_id)
    if not os.path.isfile(path):
        raise GarminStateExpired()
    try:
        with open(path, "rb") as f:
            rec = pickle.load(f)
    except Exception as exc:
        log.warning("Garmin MFA state betöltési hiba (%s): %s", user_id, exc)
        raise GarminStateExpired() from exc
    finally:
        try: os.remove(path)
        except OSError: pass
    if time.time() > rec.get("expiry_ts", 0):
        raise GarminStateExpired()
    return rec["attrs"]


def _cleanup_mfa_states() -> None:
    """Lejárt state fájlok törlése (best-effort)."""
    if not os.path.isdir(_GARMIN_STATES_DIR):
        return
    now = time.time()
    try:
        for name in os.listdir(_GARMIN_STATES_DIR):
            if not name.endswith(".pkl"):
                continue
            p = os.path.join(_GARMIN_STATES_DIR, name)
            try:
                with open(p, "rb") as f:
                    rec = pickle.load(f)
                if now > rec.get("expiry_ts", 0):
                    os.remove(p)
            except Exception:
                try: os.remove(p)
                except OSError: pass
    except OSError:
        pass


# ── Login folyamat ────────────────────────────────────────────────────────────

def garmin_login_start(user_id: str, email: str, password: str) -> dict:
    """Belépés indítása. Siker → tokenek mentve, profil adat vissza.
    MFA szükséges → GarminMfaRequired (állapot fájlba mentve)."""
    garmin = Garmin(email=email, password=password, return_on_mfa=True)
    status, _ = garmin.login()
    if status == "needs_mfa":
        _save_mfa_state(user_id, garmin)
        _cleanup_mfa_states()
        log.info("Garmin login: MFA kód szükséges (user=%s)", user_id)
        raise GarminMfaRequired()
    return _persist_garmin_session(user_id, garmin)


def garmin_login_resume(user_id: str, mfa_code: str) -> dict:
    """MFA kóddal folytatja a belépést a fájlba mentett állapotból."""
    attrs = _consume_mfa_state(user_id)
    garmin = Garmin(return_on_mfa=True)
    for name, value in attrs.items():
        setattr(garmin.client, name, value)
    garmin.resume_login(None, mfa_code)
    log.info("Garmin login: MFA sikeres (user=%s)", user_id)
    return _persist_garmin_session(user_id, garmin)


def garmin_backfill_name(user_id: str) -> str | None:
    """Ha a mentett név üres, de van token, egyszer lekéri és elmenti.
    Visszaadja a (lehet hogy frissült) nevet, vagy None ha nincs token."""
    data = _load_user_garmin(user_id)
    if not data.get("tokens"):
        return None
    if data.get("full_name"):
        return data["full_name"]
    garmin = garmin_client(user_id)
    if garmin is None:
        return None
    try:
        name = _resolve_garmin_name(garmin)
    except Exception:
        return data.get("full_name")
    if name:
        data["full_name"] = name
        _save_user_garmin(user_id, data)
    return name or None


def garmin_client(user_id: str):
    """Token-alapú kliens. None ha a user nincs csatlakoztatva.
    A library lejárat előtt automatikusan refreshel – a frissült tokent
    visszamentjük."""
    data = _load_user_garmin(user_id)
    tokens = data.get("tokens")
    if not tokens:
        return None
    garmin = Garmin()
    garmin.client.loads(tokens)
    if garmin.client.di_refresh_token and garmin.client._token_expires_soon():
        garmin.client._refresh_session()
    # Refresh után mentsük vissza a tokeneket
    new_tokens = garmin.client.dumps()
    if new_tokens != tokens:
        data["tokens"] = new_tokens
        _save_user_garmin(user_id, data)
    return garmin


# ── Testsúly (okosmérleg) ─────────────────────────────────────────────────────

def garmin_latest_weight(garmin, days: int = 365) -> dict:
    """A legutóbbi mérleg-adat. {has_data: False} ha a fióknak nincs súlyadata
    (pl. nincs Garmin mérlege) – ez nem hiba."""
    from datetime import date, timedelta
    end   = date.today()
    start = end - timedelta(days=days)
    body = garmin.get_body_composition(start.isoformat(), end.isoformat())
    entries = (body or {}).get("dateWeightList") or []
    # A GC API grammban adja a súlyt
    valid = [e for e in entries if e.get("weight")]
    if not valid:
        return {"has_data": False}
    valid.sort(key=lambda e: e.get("date") or 0)
    latest = valid[-1]
    return {
        "has_data":  True,
        "weight_kg": round(latest["weight"] / 1000, 1),
        "date":      latest.get("calendarDate"),
        "body_fat":  latest.get("bodyFat"),
        "bmi":       latest.get("bmi"),
        "count":     len(valid),
    }


# ══════════════════════════════════════════════════════════════════════════════
# AKTIVITÁS IMPORT
# ══════════════════════════════════════════════════════════════════════════════

def _garmin_sport_subtype(type_key: str) -> str:
    """Garmin típuskulcs → bringaterv sport (cycling/running/walking/hiking)."""
    t = (type_key or "").lower()
    if "cycl" in t or "bik" in t or "ride" in t: return "cycling"
    if "run" in t:  return "running"
    if "walk" in t: return "walking"
    if "hik" in t:  return "hiking"
    return "cycling"


def _parse_garmin_gmt(s: str):
    """Garmin 'YYYY-MM-DD HH:MM:SS' (GMT) → datetime (UTC). None ha nem értelmezhető."""
    from datetime import datetime, timezone
    if not s:
        return None
    try:
        dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
        return dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


# ── Garmin deny-list (törölt aktivitások – ne ajánljuk újra importra) ──────────

def _user_garmin_deny_path(user_id: str) -> str:
    return os.path.join(_user_dir(user_id), "garmin_deleted.json")


def _load_garmin_deny_list(user_id: str) -> set:
    path = _user_garmin_deny_path(user_id)
    if not os.path.isfile(path):
        return set()
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f) or {}
        return set(int(k) for k in (data.get("deleted_at") or {}).keys())
    except (OSError, json.JSONDecodeError, ValueError):
        return set()


def _add_garmin_deny(user_id: str, activity_id: int) -> None:
    path = _user_garmin_deny_path(user_id)
    data = {"deleted_at": {}}
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f) or {"deleted_at": {}}
        except (OSError, json.JSONDecodeError):
            pass
    data.setdefault("deleted_at", {})[str(activity_id)] = _now_dt()
    os.makedirs(_user_dir(user_id), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)


def _remove_garmin_deny(user_id: str, activity_id: int) -> bool:
    path = _user_garmin_deny_path(user_id)
    if not os.path.isfile(path):
        return False
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return False
    removed = data.get("deleted_at", {}).pop(str(activity_id), None) is not None
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)
    return removed


def _find_cross_source_match(idx: list, start_dt, distance_m) -> dict | None:
    """Másik forrásból (pl. Strava, FIT) már meglévő, valószínűleg azonos edzés.
    Heurisztika: indulás ±60 mp ÉS táv ±2%. Csak nem-Garmin bejegyzésekkel hasonlít."""
    if not start_dt or not distance_m:
        return None
    s_ts = start_dt.timestamp()
    from datetime import datetime
    for r in idx:
        if r.get("garmin_id"):
            continue  # Garmin-bejegyzéseket a garmin_id alapján külön kezeljük
        r_start = r.get("start_time") or r.get("date")
        if not r_start:
            continue
        try:
            r_ts = (datetime.fromisoformat(r_start.replace("Z", "+00:00")).timestamp()
                    if "T" in r_start else datetime.fromisoformat(r_start).timestamp())
        except (ValueError, AttributeError):
            continue
        if abs(r_ts - s_ts) > 60:
            continue
        r_dist_km = r.get("distance")
        if r_dist_km is None:
            continue
        if abs(r_dist_km * 1000 - distance_m) / distance_m > 0.02:
            continue
        return r
    return None


def garmin_list_activities(garmin, user_id: str, limit: int = 30, after_date: str = None) -> list:
    """Garmin aktivitások normalizált listája dedup-státusszal.
    after_date: 'YYYY-MM-DD' – ettől a naptól (opcionális)."""
    from datetime import date
    if after_date:
        activities = garmin.get_activities_by_date(after_date, date.today().isoformat())
        activities = activities[:limit] if limit else activities
    else:
        activities = garmin.get_activities(0, limit)
    if isinstance(activities, dict):
        activities = activities.get("activities") or []

    idx = _load_index(os.path.join(_user_routes_dir(user_id), "index.json"))
    by_garmin = {r.get("garmin_id"): r for r in idx if r.get("garmin_id")}
    deny      = _load_garmin_deny_list(user_id)

    out = []
    for a in activities:
        aid = a.get("activityId")
        if aid is None:
            continue
        type_key = ((a.get("activityType") or {}).get("typeKey") or "").lower()
        dist_m   = a.get("distance") or 0
        has_poly = a.get("hasPolyline")
        # GPS nélküli típusok / nulla távú edzések kihagyása
        if type_key in _GARMIN_NON_GPS_TYPES or (not has_poly and dist_m <= 0):
            continue
        start_dt = _parse_garmin_gmt(a.get("startTimeGMT"))
        dup_local   = by_garmin.get(aid)
        dup_deleted = aid in deny
        cross = None
        if not dup_local and not dup_deleted:
            cross = _find_cross_source_match(idx, start_dt, dist_m)
        out.append({
            "id":            aid,
            "name":          a.get("activityName") or "",
            "type":          type_key,
            "start_date":    start_dt.isoformat() if start_dt else None,
            "distance_m":    dist_m or None,
            "moving_time_s": a.get("movingDuration") or a.get("duration"),
            "elapsed_time_s": a.get("elapsedDuration") or a.get("duration"),
            "total_elevation_gain": a.get("elevationGain"),
            "has_heartrate": a.get("averageHR") is not None,
            "duplicate_status":
                "already_imported" if dup_local else
                ("previously_deleted" if dup_deleted else
                 ("likely_duplicate" if cross else "new")),
            "duplicate_local_id": dup_local["id"] if dup_local else (cross["id"] if cross else None),
        })
    return out


def garmin_import_activity(garmin, user_id: str, activity_id: int) -> dict:
    """Egy Garmin aktivitást letölt GPX-ben + ment a könyvtárba (type=workout)."""
    from garminconnect import Garmin as _G
    routes_dir = _user_routes_dir(user_id)
    idx_path   = os.path.join(routes_dir, "index.json")
    idx        = _load_index(idx_path)

    if any(r.get("garmin_id") == activity_id for r in idx):
        return {"ok": True, "skipped": True, "reason": "already_imported"}

    # Aktivitás összefoglaló (enrichment mezőkhöz)
    summary = {}
    try:
        summary = garmin.get_activity(activity_id) or {}
    except Exception as exc:
        log.debug("Garmin activity summary lekérés sikertelen (%s): %s", activity_id, exc)
    # A get_activity néha {summaryDTO:..} struktúrát ad; lapítsuk
    sdto = summary.get("summaryDTO") or {}
    atype = (summary.get("activityTypeDTO") or {}).get("typeKey") \
            or ((summary.get("activityType") or {}).get("typeKey")) or ""

    # GPX letöltés
    gpx_bytes = garmin.download_activity(activity_id, dl_fmt=_G.ActivityDownloadFormat.GPX)
    gpx_text = gpx_bytes.decode("utf-8") if isinstance(gpx_bytes, bytes) else str(gpx_bytes)
    if "<trkpt" not in gpx_text and "<rtept" not in gpx_text:
        return {"ok": False, "error": "Nincs GPS adat ehhez az aktivitáshoz (beltéri/trainer?)."}

    new_id   = uuid.uuid4().hex[:8]
    gpx_path = os.path.join(routes_dir, f"{new_id}.gpx")
    with open(gpx_path, "w", encoding="utf-8") as f:
        f.write(gpx_text)

    start_dt = _parse_garmin_gmt(sdto.get("startTimeGMT") or summary.get("startTimeGMT"))
    if start_dt is None:
        from datetime import datetime, timezone
        start_dt = datetime.now(timezone.utc)

    dist_m = sdto.get("distance") or summary.get("distance") or 0
    ele_m  = sdto.get("elevationGain") or summary.get("elevationGain") or 0
    mov_s  = sdto.get("movingDuration") or sdto.get("duration") or summary.get("duration") or 0
    avg_sp = sdto.get("averageSpeed")  # m/s
    max_sp = sdto.get("maxSpeed")

    entry = {
        "id":           new_id,
        "name":         summary.get("activityName") or sdto.get("activityName") or f"Garmin {activity_id}",
        "type":         "workout",
        "sport_type":   _garmin_sport_subtype(atype),
        "distance":     round(dist_m / 1000, 2),
        "duration":     round(mov_s / 60) if mov_s else None,
        "elevation":    round(ele_m) if ele_m else 0,
        "date":         start_dt.strftime("%Y-%m-%d"),
        "start_time":   start_dt.isoformat(),
        "garmin_id":    activity_id,
        "source":       "garmin",
        "imported_at":  _now_dt(),
        "include_in_stats": True,
        "description":  summary.get("description") or "",
        "calories":      sdto.get("calories"),
        "avg_heartrate": sdto.get("averageHR"),
        "max_heartrate": sdto.get("maxHR"),
        "avg_watts":     sdto.get("averagePower"),
        "max_watts":     sdto.get("maxPower"),
        "avg_cadence":   sdto.get("averageBikeCadence") or sdto.get("averageRunCadence"),
        "avg_speed_kmh": round(avg_sp * 3.6, 2) if avg_sp else None,
        "max_speed_kmh": round(max_sp * 3.6, 2) if max_sp else None,
    }
    idx.append(entry)
    _save_index(idx, idx_path)
    return {"ok": True, "skipped": False, "entry": entry}


# ══════════════════════════════════════════════════════════════════════════════
# COURSE FELTÖLTÉS (tervezett útvonal → Garmin Connect course)
# ══════════════════════════════════════════════════════════════════════════════
# ⚠️ Nem hivatalos végpont (a Garmin Connect web course-editora használja).
# Izoláltan, részletes hibajelentéssel – ha a Garmin változtat, csak ez áll le.

import math
import re as _re

# Garmin activityType – a course-service ezt várja (typeId + typeKey).
_GARMIN_COURSE_ACTIVITY_TYPES = {
    "cycling":  {"typeId": 2,  "typeKey": "cycling"},
    "running":  {"typeId": 1,  "typeKey": "running"},
    "hiking":   {"typeId": 3,  "typeKey": "hiking"},
    "walking":  {"typeId": 9,  "typeKey": "walking"},
}

_GPX_PT_RE = _re.compile(
    r'<(?:trkpt|rtept)\b[^>]*?\blat="([-\d.]+)"[^>]*?\blon="([-\d.]+)"[^>]*?>(.*?)</(?:trkpt|rtept)>'
    r'|<(?:trkpt|rtept)\b[^>]*?\blat="([-\d.]+)"[^>]*?\blon="([-\d.]+)"[^>]*?/>',
    _re.DOTALL,
)
_GPX_ELE_RE = _re.compile(r'<ele>([-\d.]+)</ele>')


def _parse_gpx_points(gpx_text: str) -> list:
    """[(lat, lon, ele|None), ...] kinyerése GPX szövegből (trkpt/rtept)."""
    pts = []
    for m in _GPX_PT_RE.finditer(gpx_text):
        if m.group(1) is not None:
            lat, lon, inner = m.group(1), m.group(2), m.group(3)
            ele_m = _GPX_ELE_RE.search(inner or "")
            ele = float(ele_m.group(1)) if ele_m else None
        else:
            lat, lon, ele = m.group(4), m.group(5), None
        try:
            pts.append((float(lat), float(lon), ele))
        except (ValueError, TypeError):
            continue
    return pts


def _haversine_m(lat1, lon1, lat2, lon2) -> float:
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


def _build_course_geopoints(points: list) -> tuple:
    """geoPoints lista + (distance_m, gain_m, loss_m). Kumulatív táv + szint.
    A Garmin GPS-eszközhöz ritkítjuk: max ~1000 pont (course-limit)."""
    # Ritkítás, ha túl sok pont
    MAX = 1000
    if len(points) > MAX:
        step = len(points) // MAX + 1
        points = points[::step]

    geo = []
    dist = 0.0
    gain = 0.0
    loss = 0.0
    prev = None
    prev_ele = None
    for (lat, lon, ele) in points:
        if prev is not None:
            dist += _haversine_m(prev[0], prev[1], lat, lon)
            if ele is not None and prev_ele is not None:
                d = ele - prev_ele
                if d > 0.5:   gain += d
                elif d < -0.5: loss += -d
        gp = {
            "latitude":  round(lat, 7),
            "longitude": round(lon, 7),
            "distance":  round(dist, 2),   # kumulatív táv a starttól (GeoPointDTO.distance)
        }
        if ele is not None:
            gp["elevation"] = round(ele, 2)
        geo.append(gp)
        prev = (lat, lon)
        if ele is not None:
            prev_ele = ele
    return geo, dist, gain, loss


def garmin_upload_course(garmin, name: str, gpx_text: str, sport: str = "cycling") -> dict:
    """Tervezett útvonal feltöltése Garmin course-ként.
    Visszaad: {ok, course_id, course_name, distance_km} vagy hiba."""
    points = _parse_gpx_points(gpx_text)
    if len(points) < 2:
        return {"ok": False, "error": "Az útvonalból nem sikerült pontokat kinyerni."}

    geo, dist_m, gain_m, loss_m = _build_course_geopoints(points)
    activity = _GARMIN_COURSE_ACTIVITY_TYPES.get(sport, _GARMIN_COURSE_ACTIVITY_TYPES["cycling"])

    # A course-service kötelező mezői (élő validációból derítve):
    #   activityTypePk (int), rulePK (1=Public/2=Private/4=Group), startPoint
    payload = {
        "courseName":          (name or "Bringaterv útvonal")[:60],
        "description":         "Bringaterv által feltöltve",
        "distanceMeter":       round(dist_m, 2),
        "elevationGainMeter":  round(gain_m, 2),
        "elevationLossMeter":  round(loss_m, 2),
        "coordinateSystem":    "WGS84",
        "sourceTypeId":        3,            # 3 = manuálisan/külső forrásból
        "activityTypePk":      activity["typeId"],
        "rulePK":              2,            # 2 = Private
        "startPoint":          {"latitude": geo[0]["latitude"], "longitude": geo[0]["longitude"]},
        "geoPoints":           geo,
        "elevationSource":     0,
    }

    # Nem hivatalos végpont – a Garmin web course-editora ezt POST-olja.
    try:
        resp = garmin.client.post("connectapi", "/course-service/course", json=payload)
    except Exception as exc:
        # A library a hibatestet is csatolja az üzenethez – továbbadjuk
        raise RuntimeError(f"Garmin course POST hiba: {exc}") from exc

    # Válasz feldolgozása
    body = None
    try:
        body = resp.json() if hasattr(resp, "json") else None
    except Exception:
        body = None
    if isinstance(body, dict):
        cid = body.get("courseId") or body.get("id")
    else:
        cid = None
    return {
        "ok": True,
        "course_id": cid,
        "course_name": payload["courseName"],
        "distance_km": round(dist_m / 1000, 2),
        "elevation_gain_m": round(gain_m),
        "points": len(geo),
    }
