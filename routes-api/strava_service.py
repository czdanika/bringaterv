"""Bringaterv API – Strava helperek (app config, tokenek, OAuth state, deny-list, GPX builder)."""

import json
import os
import secrets
import time
from datetime import timedelta

import requests
from flask import request

from config import STRAVA_APP_CONFIG, STRAVA_REDIRECT_URI, log
from storage import _user_dir
from utils import _now_dt

STRAVA_OAUTH_URL    = "https://www.strava.com/oauth/authorize"
STRAVA_TOKEN_URL    = "https://www.strava.com/oauth/token"
STRAVA_DEAUTH_URL   = "https://www.strava.com/oauth/deauthorize"
STRAVA_API_BASE     = "https://www.strava.com/api/v3"
STRAVA_DEFAULT_SCOPE = "read,activity:read_all"


# ── App credentials kezelés (env felülbírálja az admin UI-fájlt) ─────────────

def _load_strava_app_config(user_id: str = None) -> dict:
    """Visszaadja a Strava app credentialokat. Forrás-prioritás:
       1. User saját client_id/secret (strava.json-ban) — per-user app modell
       2. Env STRAVA_CLIENT_ID/SECRET — legacy fallback (régi tokenek refresh-éhez)
       3. Admin UI globális (legacy, deprecated)
    """
    # 1. User saját
    if user_id:
        ud = _load_user_strava(user_id)
        if ud.get("client_id") and ud.get("client_secret"):
            return {"client_id": ud["client_id"], "client_secret": ud["client_secret"], "source": "user"}
    # 2. Env (legacy)
    cid = os.environ.get("STRAVA_CLIENT_ID")
    sec = os.environ.get("STRAVA_CLIENT_SECRET")
    if cid and sec:
        return {"client_id": cid, "client_secret": sec, "source": "env"}
    # 3. Admin UI globális (legacy)
    if os.path.isfile(STRAVA_APP_CONFIG):
        try:
            with open(STRAVA_APP_CONFIG, encoding="utf-8") as f:
                data = json.load(f)
            if data.get("client_id") and data.get("client_secret"):
                return {**data, "source": "admin_ui"}
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("Strava app config olvasási hiba: %s", exc)
    return {"client_id": None, "client_secret": None, "source": "none"}


def _save_strava_app_config(client_id: str, client_secret: str) -> None:
    """Admin UI-ből beállított credentials mentése (0600 perm)."""
    os.makedirs(os.path.dirname(STRAVA_APP_CONFIG), exist_ok=True)
    tmp = STRAVA_APP_CONFIG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"client_id": client_id, "client_secret": client_secret}, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, STRAVA_APP_CONFIG)


def _delete_strava_app_config() -> None:
    if os.path.isfile(STRAVA_APP_CONFIG):
        os.remove(STRAVA_APP_CONFIG)


def _resolve_redirect_uri(user_id: str = None) -> str:
    """Visszaadja a callback URL-t. Prioritás:
       1. User saját override (strava.json callback_url)
       2. Env STRAVA_REDIRECT_URI
       3. Request-alapú auto-detect (scheme + host)
    """
    if user_id:
        ud = _load_user_strava(user_id)
        if ud.get("callback_url"):
            return ud["callback_url"]
    if STRAVA_REDIRECT_URI:
        return STRAVA_REDIRECT_URI
    # Request-alapú: scheme + host
    proto = request.headers.get("X-Forwarded-Proto", request.scheme)
    host  = request.headers.get("X-Forwarded-Host", request.host)
    return f"{proto}://{host}/api/strava/callback"


# ── Per-user token kezelés (/data/users/<uid>/strava.json) ────────────────────

def _user_strava_path(user_id: str) -> str:
    return os.path.join(_user_dir(user_id), "strava.json")


def _load_user_strava(user_id: str) -> dict:
    path = _user_strava_path(user_id)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_user_strava(user_id: str, data: dict) -> None:
    os.makedirs(_user_dir(user_id), exist_ok=True)
    path = _user_strava_path(user_id)
    tmp  = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _delete_user_strava(user_id: str) -> None:
    path = _user_strava_path(user_id)
    if os.path.isfile(path):
        os.remove(path)


# ── OAuth state (CSRF védelem) ────────────────────────────────────────────────
# Fájl-alapú state-tár (több gunicorn worker is látja).
# /data/strava_states/<state>.json {user_id, expiry_ts}
_STRAVA_STATES_DIR = os.environ.get("STRAVA_STATES_DIR", "/data/strava_states")
_STRAVA_STATE_TTL = 10 * 60  # 10 perc


def _strava_state_path(state: str) -> str:
    # Csak alfanumerikus state token engedélyezett a path-ban
    safe = "".join(c for c in state if c.isalnum() or c in "-_")
    return os.path.join(_STRAVA_STATES_DIR, f"{safe}.json")


def _new_strava_state(user_id: str) -> str:
    state = secrets.token_urlsafe(24)
    os.makedirs(_STRAVA_STATES_DIR, exist_ok=True)
    path = _strava_state_path(state)
    tmp  = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"user_id": user_id, "expiry_ts": time.time() + _STRAVA_STATE_TTL}, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    _cleanup_strava_states()
    return state


def _consume_strava_state(state: str) -> str | None:
    path = _strava_state_path(state)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            rec = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    finally:
        try: os.remove(path)
        except OSError: pass
    if not rec or time.time() > rec.get("expiry_ts", 0):
        return None
    return rec.get("user_id")


def _cleanup_strava_states():
    """Lejárt state fájlok törlése (best-effort, futás-időben)."""
    if not os.path.isdir(_STRAVA_STATES_DIR):
        return
    now = time.time()
    try:
        for name in os.listdir(_STRAVA_STATES_DIR):
            if not name.endswith(".json"): continue
            p = os.path.join(_STRAVA_STATES_DIR, name)
            try:
                with open(p, encoding="utf-8") as f:
                    rec = json.load(f)
                if now > rec.get("expiry_ts", 0):
                    os.remove(p)
            except (OSError, json.JSONDecodeError):
                try: os.remove(p)
                except OSError: pass
    except OSError:
        pass


# ── Token refresh ─────────────────────────────────────────────────────────────

def _ensure_strava_token(user_id: str) -> str | None:
    """Garantáltan érvényes access_token-t ad vissza, refresh-eli ha lejárt.
    None ha nincs csatlakoztatva vagy refresh sikertelen."""
    data = _load_user_strava(user_id)
    if not data.get("access_token") or not data.get("refresh_token"):
        return None
    # 60 sec buffer
    if data.get("expires_at", 0) > time.time() + 60:
        return data["access_token"]
    # Refresh — a user saját app credentials-jével (vagy env fallback)
    cfg = _load_strava_app_config(user_id)
    if not cfg["client_id"]:
        log.warning("Strava app credentials hiányoznak token refresh-hez (user=%s)", user_id)
        return None
    try:
        resp = requests.post(STRAVA_TOKEN_URL, data={
            "client_id":     cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "grant_type":    "refresh_token",
            "refresh_token": data["refresh_token"],
        }, timeout=15)
        if resp.status_code != 200:
            log.warning("Strava token refresh hiba (%s): %s", resp.status_code, resp.text[:200])
            return None
        td = resp.json()
        data.update({
            "access_token":  td["access_token"],
            "refresh_token": td["refresh_token"],
            "expires_at":    td["expires_at"],
        })
        _save_user_strava(user_id, data)
        return data["access_token"]
    except requests.RequestException as exc:
        log.warning("Strava token refresh exception: %s", exc)
        return None


# ── Strava deny-list (törölt activity-k) ──────────────────────────────────────

def _user_strava_deny_path(user_id: str) -> str:
    return os.path.join(_user_dir(user_id), "strava_deleted.json")


def _load_strava_deny_list(user_id: str) -> set:
    path = _user_strava_deny_path(user_id)
    if not os.path.isfile(path):
        return set()
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f) or {}
        return set(int(k) for k in (data.get("deleted_at") or {}).keys())
    except (OSError, json.JSONDecodeError, ValueError):
        return set()


def _add_strava_deny(user_id: str, strava_id: int) -> None:
    path = _user_strava_deny_path(user_id)
    data = {"deleted_at": {}}
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f) or {"deleted_at": {}}
        except (OSError, json.JSONDecodeError):
            pass
    data.setdefault("deleted_at", {})[str(strava_id)] = _now_dt()
    os.makedirs(_user_dir(user_id), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)


# ── GPX builder ───────────────────────────────────────────────────────────────

def _build_gpx_from_streams(name, sport_type, start_dt, latlng, altitude, times, hr, cad, power) -> str:
    """GPX XML építése Strava streams-ből."""
    import xml.sax.saxutils as sx
    out = []
    out.append('<?xml version="1.0" encoding="UTF-8"?>')
    out.append('<gpx version="1.1" creator="Bringaterv (Strava import)"')
    out.append('  xmlns="http://www.topografix.com/GPX/1/1"')
    out.append('  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"')
    out.append('  xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">')
    out.append(f'  <metadata><name>{sx.escape(name)}</name><time>{start_dt.strftime("%Y-%m-%dT%H:%M:%SZ")}</time></metadata>')
    out.append(f'  <trk><name>{sx.escape(name)}</name><type>{sx.escape(sport_type)}</type><trkseg>')
    for i, (lat, lng) in enumerate(latlng):
        ele = altitude[i] if i < len(altitude) and altitude[i] is not None else None
        t_off = times[i] if i < len(times) and times[i] is not None else None
        out.append(f'    <trkpt lat="{lat}" lon="{lng}">')
        if ele is not None:
            out.append(f'      <ele>{ele}</ele>')
        if t_off is not None:
            t = start_dt + timedelta(seconds=t_off)
            out.append(f'      <time>{t.strftime("%Y-%m-%dT%H:%M:%SZ")}</time>')
        h = hr[i]  if i < len(hr)  else None
        c = cad[i] if i < len(cad) else None
        p = power[i] if i < len(power) else None
        if h is not None or c is not None or p is not None:
            out.append('      <extensions>')
            if h is not None or c is not None:
                out.append('        <gpxtpx:TrackPointExtension>')
                if h is not None: out.append(f'          <gpxtpx:hr>{h}</gpxtpx:hr>')
                if c is not None: out.append(f'          <gpxtpx:cad>{c}</gpxtpx:cad>')
                out.append('        </gpxtpx:TrackPointExtension>')
            if p is not None:
                out.append(f'        <power>{p}</power>')
            out.append('      </extensions>')
        out.append('    </trkpt>')
    out.append('  </trkseg></trk>')
    out.append('</gpx>')
    return "\n".join(out)
