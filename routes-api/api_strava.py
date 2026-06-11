"""Bringaterv API – Strava végpontok (OAuth, aktivitások, import, app config)."""

import json
import os
import uuid
from datetime import datetime, timezone
from urllib.parse import urlencode

import requests
from flask import Blueprint, abort, g, jsonify, request

from auth import require_admin, require_auth
from config import log
from storage import _user_routes_dir
from strava_service import (
    STRAVA_API_BASE,
    STRAVA_DEAUTH_URL,
    STRAVA_DEFAULT_SCOPE,
    STRAVA_OAUTH_URL,
    STRAVA_TOKEN_URL,
    _build_gpx_from_streams,
    _consume_strava_state,
    _delete_strava_app_config,
    _delete_user_strava,
    _ensure_strava_token,
    _load_strava_app_config,
    _load_strava_deny_list,
    _load_user_strava,
    _new_strava_state,
    _resolve_redirect_uri,
    _save_strava_app_config,
    _save_user_strava,
    _user_strava_deny_path,
)
from utils import _load_index, _now_dt, _safe_id, _save_index

bp = Blueprint("api_strava", __name__)


# ── User-facing endpoint-ok ───────────────────────────────────────────────────

@bp.route("/api/strava/status", methods=["GET"])
@require_auth
def strava_status():
    """Csatlakozott-e a user, ha igen mikor és athleta-név is."""
    user_id = g.user["id"]
    data = _load_user_strava(user_id)
    cfg  = _load_strava_app_config(user_id)
    return jsonify({
        "connected":     bool(data.get("access_token")),
        "athlete_id":    data.get("athlete_id"),
        "athlete_name":  data.get("athlete_name"),
        "connected_at":  data.get("connected_at"),
        "scope":         data.get("scope"),
        "app_configured": cfg["client_id"] is not None,
        "app_source":    cfg["source"],   # "user" / "env" / "admin_ui" / "none"
        "has_user_creds": bool(data.get("client_id") and data.get("client_secret")),
    })


@bp.route("/api/strava/connect", methods=["GET"])
@require_auth
def strava_connect():
    """Visszaadja a Strava OAuth URL-t, ahova a usert irányítjuk."""
    user_id = g.user["id"]
    cfg = _load_strava_app_config(user_id)
    if not cfg["client_id"]:
        abort(503, description="Strava app credentials nincs megadva. A Beállítások → Strava szekcióban add meg a saját Strava app Client ID-t és Secret-jét.")
    state = _new_strava_state(user_id)
    params = {
        "client_id":     cfg["client_id"],
        "redirect_uri":  _resolve_redirect_uri(user_id),
        "response_type": "code",
        "scope":         STRAVA_DEFAULT_SCOPE,
        "state":         state,
        "approval_prompt": "auto",
    }
    return jsonify({"auth_url": f"{STRAVA_OAUTH_URL}?{urlencode(params)}"})


@bp.route("/api/strava/callback", methods=["GET"])
def strava_callback():
    """Stravas redirect: code → access_token csere, mentés user mappájába.
    NEM @require_auth – maga a redirect publikus, a state azonosít.
    HTML választ ad vissza, ami az ablakot bezárja és értesíti a parent-et."""
    code  = request.args.get("code")
    state = request.args.get("state")
    err   = request.args.get("error")
    if err:
        return _strava_oauth_close_window(error=f"Strava elutasította: {err}")
    if not code or not state:
        return _strava_oauth_close_window(error="Hiányos visszahívás (code/state).")
    user_id = _consume_strava_state(state)
    if not user_id:
        return _strava_oauth_close_window(error="Érvénytelen vagy lejárt state.")
    cfg = _load_strava_app_config(user_id)
    if not cfg["client_id"]:
        return _strava_oauth_close_window(error="Strava app credentials nincs megadva.")
    # Token csere
    try:
        resp = requests.post(STRAVA_TOKEN_URL, data={
            "client_id":     cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "code":          code,
            "grant_type":    "authorization_code",
        }, timeout=15)
        if resp.status_code != 200:
            # 403 = a Strava app elérte a felhasználói (athlete) limitet.
            # Alapból 1 athlete/app a Strava-nál, ezt a developer dashboardon
            # ("Authorized athletes count") kell növeltetni.
            if resp.status_code == 403:
                return _strava_oauth_close_window(error=(
                    "A Strava app elérte a felhasználói limitet (alapból 1 athlete). "
                    "Ha más Strava-fiókod is van, hozz létre saját Strava app-ot a "
                    "strava.com/settings/api oldalon és add meg itt a credentials-jét."
                ))
            return _strava_oauth_close_window(error=f"Token csere hiba ({resp.status_code}).")
        td = resp.json()
    except requests.RequestException as exc:
        return _strava_oauth_close_window(error=f"Hálózati hiba: {exc}")
    # Athleta adatok
    athlete = td.get("athlete", {}) or {}
    athlete_name = (athlete.get("firstname", "") + " " + athlete.get("lastname", "")).strip() \
                or athlete.get("username") or f"#{athlete.get('id')}"
    # Mergelünk a meglévő adatokkal — a user által mentett client_id/secret megmarad
    existing = _load_user_strava(user_id)
    existing.update({
        "athlete_id":    athlete.get("id"),
        "athlete_name":  athlete_name,
        "access_token":  td["access_token"],
        "refresh_token": td["refresh_token"],
        "expires_at":    td["expires_at"],
        "scope":         td.get("scope") or STRAVA_DEFAULT_SCOPE,
        "connected_at":  _now_dt(),
    })
    _save_user_strava(user_id, existing)
    return _strava_oauth_close_window(success=True, athlete_name=athlete_name)


def _strava_oauth_close_window(success: bool = False, athlete_name: str = "", error: str = "") -> str:
    """HTML választ ad vissza, ami az popup ablakot bezárja és a parent ablakot
    értesíti a window.postMessage-en keresztül."""
    payload = {"type": "strava-oauth", "success": success, "athlete_name": athlete_name, "error": error}
    msg = "Sikeres kapcsolódás!" if success else f"Hiba: {error}"
    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Strava kapcsolódás</title>
<style>
body {{ font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;color:#222 }}
.box {{ background:#fff;padding:24px 32px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.1);text-align:center;max-width:400px }}
.ok {{ color:#16a34a }} .err {{ color:#dc2626 }}
button {{ margin-top:14px;padding:8px 20px;font-size:14px;background:#FC4C02;color:#fff;border:none;border-radius:6px;cursor:pointer }}
button:hover {{ filter:brightness(1.1) }}
.hint {{ margin-top:10px;font-size:12px;color:#666 }}
</style></head><body>
<div class="box">
  <h2 class="{'ok' if success else 'err'}">{msg}</h2>
  <p>A bringaterv ablakban már látszik az új állapot. Ezt a fület most már bezárhatod.</p>
  <button onclick="tryClose()">Ablak bezárása</button>
  <div class="hint" id="hint" style="display:none">Safari nem engedi auto-bezárni — zárd be kézzel (Cmd+W).</div>
</div>
<script>
try {{
  if (window.opener && !window.opener.closed) {{
    window.opener.postMessage({json.dumps(payload)}, "*");
  }}
}} catch(e) {{}}
function tryClose() {{
  try {{ window.close(); }} catch(e) {{}}
  // Ha 200ms után még itt vagyunk, mutatjuk a hint-et
  setTimeout(() => {{
    if (!window.closed) document.getElementById("hint").style.display = "block";
  }}, 200);
}}
</script>
</body></html>"""
    return html, 200, {"Content-Type": "text/html; charset=utf-8"}


@bp.route("/api/strava/activities", methods=["GET"])
@require_auth
def strava_activities():
    """Visszaadja a user Strava activity-it (utolsó X). Duplicate-check is fut."""
    token = _ensure_strava_token(g.user["id"])
    if not token:
        abort(401, description="Nincs csatlakozva Stravához vagy a token érvénytelen.")
    per_page = max(1, min(100, int(request.args.get("per_page", 30))))
    page     = max(1, int(request.args.get("page", 1)))
    after    = request.args.get("after")   # UNIX timestamp – activities AFTER this date
    before   = request.args.get("before")  # UNIX timestamp – activities BEFORE this date
    params = {"per_page": per_page, "page": page}
    if after:  params["after"]  = after
    if before: params["before"] = before
    try:
        resp = requests.get(f"{STRAVA_API_BASE}/athlete/activities",
                            params=params,
                            headers={"Authorization": f"Bearer {token}"},
                            timeout=20)
        if resp.status_code == 401:
            # Token revoke-olódott vagy az app credentials hibásak. Töröljük a tokent
            # hogy a frontend újra-csatlakozást ajánljon.
            _delete_user_strava(g.user["id"])
            abort(401, description="A Strava kapcsolat érvénytelenné vált. Csatlakozz újra a Beállítások panelben.")
        if resp.status_code == 429:
            abort(429, description="Strava rate limit elérve. Próbáld 15 perc múlva.")
        if resp.status_code != 200:
            abort(502, description=f"Strava API hiba ({resp.status_code}).")
        data = resp.json()
    except requests.RequestException as exc:
        abort(502, description=f"Strava lekérdezés sikertelen: {exc}")

    # Lokális library + deny-list a duplicate-checkhez
    routes_dir = _user_routes_dir(g.user["id"])
    idx        = _load_index(os.path.join(routes_dir, "index.json"))
    by_strava  = {r.get("strava_id"): r for r in idx if r.get("strava_id")}
    deny_list  = _load_strava_deny_list(g.user["id"])

    # Nem útvonal-alapú (GPS nélküli) Strava aktivitás-típusok – ezeket nem listázzuk,
    # mert nincs térképük/útvonaluk (pl. konditermi "Workout", súlyzós edzés, jóga).
    NON_GPS_TYPES = {
        "workout", "weighttraining", "yoga", "crossfit", "elliptical",
        "stairstepper", "pilates", "rockclimbing", "hiit", "swim",
        "virtualrun", "velomobile",
    }

    items = []
    for a in data:
        sid = a.get("id")
        # Kihagyjuk a nem-térképes edzéseket (típus-alapon VAGY ha nincs se GPS-track, se táv)
        sport_t  = (a.get("sport_type") or a.get("type") or "").lower()
        polyline = (a.get("map") or {}).get("summary_polyline")
        dist_m   = a.get("distance") or 0
        if sport_t in NON_GPS_TYPES or (not polyline and dist_m <= 0):
            continue
        dup_local   = by_strava.get(sid)
        dup_deleted = sid in deny_list
        # Esetleges manuális-import egyezés (start_time + distance heurisztika)
        manual_match = None
        if not dup_local and not dup_deleted:
            manual_match = _find_manual_match(idx, a)
        items.append({
            "id":           sid,
            "name":         a.get("name") or "",
            "type":         a.get("sport_type") or a.get("type"),
            "start_date":   a.get("start_date"),
            "distance_m":   a.get("distance"),
            "moving_time_s": a.get("moving_time"),
            "elapsed_time_s": a.get("elapsed_time"),
            "total_elevation_gain": a.get("total_elevation_gain"),
            "trainer":      a.get("trainer"),
            "has_heartrate": a.get("has_heartrate"),
            "duplicate_status":
                "already_imported" if dup_local else
                ("previously_deleted" if dup_deleted else
                 ("likely_duplicate" if manual_match else "new")),
            "duplicate_local_id": dup_local["id"] if dup_local else (manual_match["id"] if manual_match else None),
        })
    return jsonify({"activities": items, "page": page, "per_page": per_page})


def _find_manual_match(idx: list, strava_activity: dict) -> dict | None:
    """Heurisztika: kb. ugyanaz a manuális import létezik-e?
    start_time ±60 sec ÉS distance ±2%."""
    s_start = strava_activity.get("start_date")
    s_dist  = strava_activity.get("distance")
    if not s_start or not s_dist:
        return None
    try:
        s_ts = datetime.fromisoformat(s_start.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return None
    for r in idx:
        # Csak nem-Strava-os elemekkel hasonlítunk
        if r.get("strava_id"):
            continue
        r_start = r.get("start_time") or r.get("date")
        if not r_start:
            continue
        try:
            r_ts = datetime.fromisoformat(r_start.replace("Z", "+00:00")).timestamp() if "T" in r_start \
                   else datetime.fromisoformat(r_start).timestamp()
        except (ValueError, AttributeError):
            continue
        if abs(r_ts - s_ts) > 60:
            continue
        r_dist_km = r.get("distance")
        if r_dist_km is None:
            continue
        r_dist_m = r_dist_km * 1000
        if abs(r_dist_m - s_dist) / s_dist > 0.02:
            continue
        return r
    return None


@bp.route("/api/strava/import/<int:activity_id>", methods=["POST"])
@require_auth
def strava_import(activity_id: int):
    """Egy Strava activity-t letölt + GPX-szé konvertál + ment a könyvtárba."""
    token = _ensure_strava_token(g.user["id"])
    if not token:
        abort(401, description="Nincs csatlakozva Stravához.")
    user_id    = g.user["id"]
    routes_dir = _user_routes_dir(user_id)
    idx_path   = os.path.join(routes_dir, "index.json")
    idx        = _load_index(idx_path)

    # Duplikálás check – ha már megvan, skip
    if any(r.get("strava_id") == activity_id for r in idx):
        return jsonify({"ok": True, "skipped": True, "reason": "already_imported"})

    # Activity meta
    try:
        ar = requests.get(f"{STRAVA_API_BASE}/activities/{activity_id}",
                          headers={"Authorization": f"Bearer {token}"},
                          params={"include_all_efforts": "false"},
                          timeout=20)
        if ar.status_code == 401:
            _delete_user_strava(user_id)
            abort(401, description="A Strava kapcsolat érvénytelenné vált. Csatlakozz újra a Beállítások panelben.")
        if ar.status_code != 200:
            abort(502, description=f"Strava activity hiba ({ar.status_code}).")
        activity = ar.json()
    except requests.RequestException as exc:
        abort(502, description=f"Strava activity lekérdezés sikertelen: {exc}")

    # Streams (latlng, altitude, time, heartrate, cadence, watts)
    try:
        sr = requests.get(f"{STRAVA_API_BASE}/activities/{activity_id}/streams",
                          headers={"Authorization": f"Bearer {token}"},
                          params={"keys": "latlng,altitude,time,heartrate,cadence,watts", "key_by_type": "true"},
                          timeout=30)
        if sr.status_code == 401:
            _delete_user_strava(user_id)
            abort(401, description="A Strava kapcsolat érvénytelenné vált. Csatlakozz újra.")
        if sr.status_code != 200:
            abort(502, description=f"Strava streams hiba ({sr.status_code}). Lehet, hogy nincs GPS adat?")
        streams = sr.json()
    except requests.RequestException as exc:
        abort(502, description=f"Strava streams lekérdezés sikertelen: {exc}")

    latlng = streams.get("latlng", {}).get("data", [])
    if not latlng:
        return jsonify({"ok": False, "error": "Nincs GPS adat ehhez az activity-hez (talán beltéri vagy trainer)."}), 422

    altitude = streams.get("altitude", {}).get("data", []) or [None] * len(latlng)
    times    = streams.get("time", {}).get("data", []) or [None] * len(latlng)
    hr       = streams.get("heartrate", {}).get("data", []) or [None] * len(latlng)
    cad      = streams.get("cadence", {}).get("data", []) or [None] * len(latlng)
    pow_     = streams.get("watts", {}).get("data", []) or [None] * len(latlng)

    # Start timestamp ISO 8601
    try:
        start_dt = datetime.fromisoformat(activity["start_date"].replace("Z", "+00:00"))
    except (KeyError, ValueError, AttributeError):
        start_dt = datetime.now(timezone.utc)

    # GPX szöveg építés
    gpx = _build_gpx_from_streams(
        name=activity.get("name") or f"Strava {activity_id}",
        sport_type=activity.get("sport_type") or activity.get("type") or "cycling",
        start_dt=start_dt,
        latlng=latlng, altitude=altitude, times=times, hr=hr, cad=cad, power=pow_,
    )

    # Mentés
    new_id = uuid.uuid4().hex[:8]
    gpx_path = os.path.join(routes_dir, f"{new_id}.gpx")
    with open(gpx_path, "w", encoding="utf-8") as f:
        f.write(gpx)

    # Index bejegyzés
    dist_m  = activity.get("distance") or 0
    ele_m   = activity.get("total_elevation_gain") or 0
    mov_s   = activity.get("moving_time") or 0
    sport_t = (activity.get("sport_type") or activity.get("type") or "").lower()
    sport_subtype = "cycling" if "ride" in sport_t or "cycl" in sport_t else \
                    "running" if "run" in sport_t else \
                    "walking" if "walk" in sport_t else \
                    "hiking"  if "hik" in sport_t else "cycling"

    new_entry = {
        "id":           new_id,
        "name":         activity.get("name") or f"Strava {activity_id}",
        "type":         "workout",         # KATEGÓRIA: edzés (nem útvonal) – default Elemzés tab
        "sport_type":   sport_subtype,     # SPORT: cycling/running/walking/hiking
        "distance":     round(dist_m / 1000, 2),
        "duration":     round(mov_s / 60),
        "elevation":    round(ele_m),
        "date":         start_dt.strftime("%Y-%m-%d"),
        "start_time":   start_dt.isoformat(),
        "strava_id":    activity_id,
        "source":       "strava",
        "imported_at":  _now_dt(),
        "description":  activity.get("description") or "",
        # Strava-specifikus enrichment mezők (mind opcionális, None ha nincs)
        "calories":              activity.get("calories"),
        "suffer_score":          activity.get("suffer_score"),
        "weighted_avg_watts":    activity.get("weighted_average_watts"),
        "device_watts":          activity.get("device_watts"),
        "avg_watts":             activity.get("average_watts"),
        "max_watts":             activity.get("max_watts"),
        "kilojoules":            activity.get("kilojoules"),
        "avg_heartrate":         activity.get("average_heartrate"),
        "max_heartrate":         activity.get("max_heartrate"),
        "avg_cadence":           activity.get("average_cadence"),
        "avg_speed_kmh":         round(activity["average_speed"] * 3.6, 2) if activity.get("average_speed") else None,
        "max_speed_kmh":         round(activity["max_speed"] * 3.6, 2) if activity.get("max_speed") else None,
        "location_city":         activity.get("location_city"),
        "location_country":      activity.get("location_country"),
        "gear_id":               activity.get("gear_id"),
        "achievement_count":     activity.get("achievement_count"),
        "pr_count":              activity.get("pr_count"),
    }
    idx.append(new_entry)
    _save_index(idx, idx_path)

    return jsonify({"ok": True, "skipped": False, "entry": new_entry})


@bp.route("/api/strava/refresh/<route_id>", methods=["POST"])
@require_auth
def strava_refresh(route_id: str):
    """Egy meglévő Strava-importált workout meta-adatait frissíti Stravából
    (a GPX fájl változatlan marad – csak a JSON mezők frissülnek)."""
    route_id   = _safe_id(route_id)
    user_id    = g.user["id"]
    routes_dir = _user_routes_dir(user_id)
    idx_path   = os.path.join(routes_dir, "index.json")
    idx        = _load_index(idx_path)
    entry      = next((r for r in idx if r.get("id") == route_id), None)
    if not entry:
        abort(404, description="Útvonal nem található.")
    sid = entry.get("strava_id")
    if not sid:
        abort(400, description="Ez nem Stravás bejegyzés.")

    token = _ensure_strava_token(user_id)
    if not token:
        abort(401, description="Nincs Strava kapcsolat. Csatlakozz újra a Beállítások panelben.")

    try:
        ar = requests.get(f"{STRAVA_API_BASE}/activities/{sid}",
                          headers={"Authorization": f"Bearer {token}"},
                          params={"include_all_efforts": "false"},
                          timeout=20)
        if ar.status_code == 401:
            _delete_user_strava(user_id)
            abort(401, description="A Strava kapcsolat érvénytelenné vált. Csatlakozz újra.")
        if ar.status_code == 404:
            abort(404, description="Ez az activity nincs meg a Stravádon (törölted onnan?).")
        if ar.status_code != 200:
            abort(502, description=f"Strava activity hiba ({ar.status_code}).")
        activity = ar.json()
    except requests.RequestException as exc:
        abort(502, description=f"Strava lekérdezés sikertelen: {exc}")

    # Frissítjük az entry-t a meglévő mezők megőrzésével (id, gpx fájl változatlan)
    sport_t = (activity.get("sport_type") or activity.get("type") or "").lower()
    sport_subtype = "cycling" if "ride" in sport_t or "cycl" in sport_t else \
                    "running" if "run" in sport_t else \
                    "walking" if "walk" in sport_t else \
                    "hiking"  if "hik" in sport_t else "cycling"
    dist_m  = activity.get("distance") or 0
    ele_m   = activity.get("total_elevation_gain") or 0
    mov_s   = activity.get("moving_time") or 0

    entry.update({
        "name":         activity.get("name") or entry.get("name"),
        "type":         "workout",
        "sport_type":   sport_subtype,
        "distance":     round(dist_m / 1000, 2),
        "duration":     round(mov_s / 60),
        "elevation":    round(ele_m),
        "description":  activity.get("description") or entry.get("description", ""),
        "calories":              activity.get("calories"),
        "suffer_score":          activity.get("suffer_score"),
        "weighted_avg_watts":    activity.get("weighted_average_watts"),
        "device_watts":          activity.get("device_watts"),
        "avg_watts":             activity.get("average_watts"),
        "max_watts":             activity.get("max_watts"),
        "kilojoules":            activity.get("kilojoules"),
        "avg_heartrate":         activity.get("average_heartrate"),
        "max_heartrate":         activity.get("max_heartrate"),
        "avg_cadence":           activity.get("average_cadence"),
        "avg_speed_kmh":         round(activity["average_speed"] * 3.6, 2) if activity.get("average_speed") else None,
        "max_speed_kmh":         round(activity["max_speed"] * 3.6, 2) if activity.get("max_speed") else None,
        "location_city":         activity.get("location_city"),
        "location_country":      activity.get("location_country"),
        "gear_id":               activity.get("gear_id"),
        "achievement_count":     activity.get("achievement_count"),
        "pr_count":              activity.get("pr_count"),
        "refreshed_at":          _now_dt(),
    })
    _save_index(idx, idx_path)
    return jsonify({"ok": True, "entry": entry})


@bp.route("/api/strava/deny-list/<int:strava_id>", methods=["DELETE"])
@require_auth
def strava_deny_remove(strava_id: int):
    """Eltávolít egy strava_id-t a deny-listből (re-import újra lehetségessé válik)."""
    path = _user_strava_deny_path(g.user["id"])
    if not os.path.isfile(path):
        return jsonify({"ok": True, "removed": False})
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return jsonify({"ok": True, "removed": False})
    removed = data.get("deleted_at", {}).pop(str(strava_id), None) is not None
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)
    return jsonify({"ok": True, "removed": removed})


@bp.route("/api/strava/disconnect", methods=["DELETE"])
@require_auth
def strava_disconnect():
    """Lecsatlakozás: token deauth + token/athlete törlés.
    A user által mentett client_id/secret (saját app creds) MARAD,
    hogy ne kelljen újra beírni csatlakozáskor."""
    user_id = g.user["id"]
    data = _load_user_strava(user_id)
    if data.get("access_token"):
        try:
            requests.post(STRAVA_DEAUTH_URL, data={"access_token": data["access_token"]}, timeout=10)
        except requests.RequestException as exc:
            log.warning("Strava deauth exception: %s", exc)
    # Csak a session-jellegű mezőket töröljük, a creds marad
    for k in ("access_token", "refresh_token", "expires_at",
              "athlete_id", "athlete_name", "scope", "connected_at"):
        data.pop(k, None)
    if data:
        _save_user_strava(user_id, data)
    else:
        _delete_user_strava(user_id)
    return jsonify({"ok": True})


# ── User-szintű Strava app credentials kezelés (saját Strava-app) ─────────────

@bp.route("/api/strava/app-config", methods=["GET"])
@require_auth
def user_strava_app_config_get():
    """User által beállított Strava app credentials állapota."""
    user_id = g.user["id"]
    data = _load_user_strava(user_id)
    return jsonify({
        "client_id":    data.get("client_id"),        # publikus érték
        "secret_set":   bool(data.get("client_secret")),
        "callback_url": data.get("callback_url"),     # user override (vagy None)
        "redirect_uri": _resolve_redirect_uri(user_id),  # tényleges (override vagy auto)
    })


@bp.route("/api/strava/app-config", methods=["PUT"])
@require_auth
def user_strava_app_config_set():
    """User mentse a saját Strava app Client ID + Secret-jét (+ opcionális callback URL)."""
    body = request.get_json(silent=True) or {}
    cid  = (body.get("client_id") or "").strip()
    sec  = (body.get("client_secret") or "").strip()
    cb   = (body.get("callback_url") or "").strip() or None
    if not cid:
        abort(400, description="Client ID kötelező.")
    user_id = g.user["id"]
    data = _load_user_strava(user_id)
    data["client_id"] = cid
    # Secret-et csak akkor írjuk felül, ha küldött újat (üres string = ne piszkáld)
    if sec:
        data["client_secret"] = sec
    elif not data.get("client_secret"):
        abort(400, description="Client Secret kötelező (első mentésnél).")
    # Callback URL: opcionális override, üresnél töröljük
    if cb:
        data["callback_url"] = cb
    else:
        data.pop("callback_url", None)
    _save_user_strava(user_id, data)
    return jsonify({"ok": True})


@bp.route("/api/strava/app-config", methods=["DELETE"])
@require_auth
def user_strava_app_config_delete():
    """User saját Strava app credentials törlése (a tokenek megmaradnak,
    de refresh fail-elni fog ha nincs env fallback)."""
    user_id = g.user["id"]
    data = _load_user_strava(user_id)
    data.pop("client_id", None)
    data.pop("client_secret", None)
    data.pop("callback_url", None)
    if data:
        _save_user_strava(user_id, data)
    else:
        _delete_user_strava(user_id)
    return jsonify({"ok": True})


# ── Admin endpoint-ok (app credentials) ───────────────────────────────────────

@bp.route("/api/admin/strava/config", methods=["GET"])
@require_auth
@require_admin
def admin_strava_config_get():
    cfg = _load_strava_app_config()
    return jsonify({
        "source":         cfg["source"],      # "env" | "admin_ui" | "none"
        "client_id":      cfg["client_id"],   # publikus – mehet a frontendre
        "secret_set":     bool(cfg["client_secret"]),
        "redirect_uri":   _resolve_redirect_uri(),
    })


@bp.route("/api/admin/strava/config", methods=["PUT"])
@require_auth
@require_admin
def admin_strava_config_set():
    data = request.get_json(silent=True) or {}
    cid  = (data.get("client_id") or "").strip()
    sec  = (data.get("client_secret") or "").strip()
    if not cid or not sec:
        abort(400, description="Client ID és Client Secret kötelező.")
    _save_strava_app_config(cid, sec)
    return jsonify({"ok": True, "source": "admin_ui"})


@bp.route("/api/admin/strava/config", methods=["DELETE"])
@require_auth
@require_admin
def admin_strava_config_delete():
    """Csak az admin UI-s konfig törlésére – env-változó változatlan."""
    _delete_strava_app_config()
    return jsonify({"ok": True})
