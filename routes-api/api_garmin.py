"""Bringaterv API – Garmin Connect végpontok (csatlakozás, MFA, státusz, testsúly, course)."""

import os

from flask import Blueprint, abort, g, jsonify, request

from auth import require_auth
from config import log
from storage import _user_routes_dir
from utils import _load_index, _now_dt, _safe_id, _save_index
from garmin_service import (
    GARMIN_AVAILABLE,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
    GarminMfaRequired,
    GarminStateExpired,
    _delete_user_garmin,
    _load_user_garmin,
    _remove_garmin_deny,
    garmin_backfill_name,
    garmin_client,
    garmin_import_activity,
    garmin_latest_weight,
    garmin_list_activities,
    garmin_login_resume,
    garmin_login_start,
    garmin_upload_course,
)

bp = Blueprint("api_garmin", __name__)

# Könyvtár-bejegyzés típusa → Garmin course sport
_GARMIN_SPORT_MAP = {
    "cycling": "cycling", "gravel": "cycling", "mtb": "cycling", "asphalt": "cycling",
    "running": "running", "run": "running",
    "hiking": "hiking", "hike": "hiking",
    "walking": "walking", "walk": "walking",
}


def _require_garmin_lib():
    if not GARMIN_AVAILABLE:
        abort(503, description="A garminconnect Python csomag nincs telepítve a szerveren.")


@bp.route("/api/garmin/status", methods=["GET"])
@require_auth
def garmin_status():
    """Csatlakozott-e a user Garminhoz."""
    data = _load_user_garmin(g.user["id"])
    full_name = data.get("full_name")
    # Üres név utólagos pótlása (pl. MFA-s belépés után), best-effort
    if data.get("tokens") and not full_name and GARMIN_AVAILABLE:
        try:
            full_name = garmin_backfill_name(g.user["id"]) or full_name
        except Exception as exc:
            log.debug("Garmin név-pótlás sikertelen: %s", exc)
    return jsonify({
        "available":    GARMIN_AVAILABLE,
        "connected":    bool(data.get("tokens")),
        "full_name":    full_name,
        "connected_at": data.get("connected_at"),
    })


@bp.route("/api/garmin/connect", methods=["POST"])
@require_auth
def garmin_connect():
    """Belépés email + jelszóval. A jelszót nem tároljuk, csak a tokeneket.
    Ha MFA kell: 200 {mfa_required: true} – a kód a /api/garmin/mfa-ra megy."""
    _require_garmin_lib()
    body     = request.get_json(silent=True) or {}
    email    = (body.get("email") or "").strip()
    password = body.get("password") or ""
    if not email or not password:
        abort(400, description="Email és jelszó kötelező.")
    try:
        data = garmin_login_start(g.user["id"], email, password)
    except GarminMfaRequired:
        return jsonify({"mfa_required": True})
    except GarminConnectAuthenticationError:
        # 403 és nem 401: a 401-et a frontend session-lejáratként kezeli (kiléptet)
        abort(403, description="Hibás Garmin email vagy jelszó.")
    except GarminConnectTooManyRequestsError:
        abort(429, description="A Garmin átmenetileg korlátozza a belépéseket. Próbáld pár perc múlva.")
    except (GarminConnectConnectionError, Exception) as exc:
        log.warning("Garmin connect hiba (user=%s): %s", g.user["id"], exc)
        abort(502, description=f"Garmin belépés sikertelen: {exc}")
    log.info("Garmin csatlakoztatva (user=%s)", g.user["id"])
    return jsonify({"connected": True, "full_name": data.get("full_name")})


@bp.route("/api/garmin/mfa", methods=["POST"])
@require_auth
def garmin_mfa():
    """MFA kód beküldése a belépés befejezéséhez."""
    _require_garmin_lib()
    body = request.get_json(silent=True) or {}
    code = (body.get("code") or "").strip()
    if not code:
        abort(400, description="MFA kód kötelező.")
    try:
        data = garmin_login_resume(g.user["id"], code)
    except GarminStateExpired:
        abort(410, description="A belépési folyamat lejárt. Kezdd újra az email + jelszó megadásával.")
    except GarminConnectAuthenticationError:
        abort(403, description="Hibás MFA kód. Kezdd újra a belépést.")
    except Exception as exc:
        log.warning("Garmin MFA hiba (user=%s): %s", g.user["id"], exc)
        abort(502, description=f"Garmin MFA ellenőrzés sikertelen: {exc}. Kezdd újra a belépést.")
    log.info("Garmin csatlakoztatva MFA-val (user=%s)", g.user["id"])
    return jsonify({"connected": True, "full_name": data.get("full_name")})


@bp.route("/api/garmin/disconnect", methods=["DELETE"])
@require_auth
def garmin_disconnect():
    """Lecsatlakozás: tokenek törlése (a Garmin oldalon a kapcsolat magától lejár)."""
    _delete_user_garmin(g.user["id"])
    return jsonify({"ok": True})


@bp.route("/api/garmin/weight", methods=["GET"])
@require_auth
def garmin_weight():
    """Legutóbbi testsúly a Garmin mérlegről. Ha a fióknak nincs súlyadata
    (nincs mérleg), {has_data: false} jön vissza – ez nem hiba."""
    _require_garmin_lib()
    garmin = garmin_client(g.user["id"])
    if garmin is None:
        abort(409, description="Nincs Garmin kapcsolat. Csatlakozz a Beállítások panelben.")
    days = max(1, min(3650, int(request.args.get("days", 365))))
    try:
        result = garmin_latest_weight(garmin, days=days)
    except GarminConnectAuthenticationError:
        _delete_user_garmin(g.user["id"])
        abort(409, description="A Garmin kapcsolat érvénytelenné vált. Csatlakozz újra.")
    except GarminConnectTooManyRequestsError:
        abort(429, description="Garmin rate limit. Próbáld pár perc múlva.")
    except Exception as exc:
        log.warning("Garmin weight hiba (user=%s): %s", g.user["id"], exc)
        abort(502, description=f"Garmin súlyadat lekérdezés sikertelen: {exc}")
    return jsonify(result)


@bp.route("/api/garmin/activities", methods=["GET"])
@require_auth
def garmin_activities():
    """Garmin aktivitások listája dedup-státusszal (importáláshoz)."""
    _require_garmin_lib()
    garmin = garmin_client(g.user["id"])
    if garmin is None:
        abort(409, description="Nincs Garmin kapcsolat. Csatlakozz a Beállítások panelben.")
    limit = max(1, min(200, int(request.args.get("limit", 30))))
    after = request.args.get("after") or None  # 'YYYY-MM-DD'
    try:
        items = garmin_list_activities(garmin, g.user["id"], limit=limit, after_date=after)
    except GarminConnectAuthenticationError:
        _delete_user_garmin(g.user["id"])
        abort(409, description="A Garmin kapcsolat érvénytelenné vált. Csatlakozz újra a Beállítások panelben.")
    except GarminConnectTooManyRequestsError:
        abort(429, description="Garmin rate limit elérve. Próbáld 15 perc múlva.")
    except Exception as exc:
        log.warning("Garmin activities hiba (user=%s): %s", g.user["id"], exc)
        abort(502, description=f"Garmin lekérdezés sikertelen: {exc}")
    return jsonify({"activities": items, "limit": limit})


@bp.route("/api/garmin/import/<int:activity_id>", methods=["POST"])
@require_auth
def garmin_import(activity_id: int):
    """Egy Garmin aktivitást letölt GPX-ben + ment a könyvtárba."""
    _require_garmin_lib()
    garmin = garmin_client(g.user["id"])
    if garmin is None:
        abort(409, description="Nincs Garmin kapcsolat. Csatlakozz a Beállítások panelben.")
    try:
        result = garmin_import_activity(garmin, g.user["id"], activity_id)
    except GarminConnectAuthenticationError:
        _delete_user_garmin(g.user["id"])
        abort(409, description="A Garmin kapcsolat érvénytelenné vált. Csatlakozz újra.")
    except GarminConnectTooManyRequestsError:
        abort(429, description="Garmin rate limit elérve. Próbáld 15 perc múlva.")
    except Exception as exc:
        log.warning("Garmin import hiba (user=%s, activity=%s): %s", g.user["id"], activity_id, exc)
        abort(502, description=f"Garmin import sikertelen: {exc}")
    status = 422 if (not result.get("ok") and not result.get("skipped")) else 200
    return jsonify(result), status


@bp.route("/api/garmin/deny-list/<int:activity_id>", methods=["DELETE"])
@require_auth
def garmin_deny_remove(activity_id: int):
    """Eltávolít egy activity_id-t a deny-listből (re-import újra lehetséges)."""
    removed = _remove_garmin_deny(g.user["id"], activity_id)
    return jsonify({"ok": True, "removed": removed})


@bp.route("/api/garmin/course/<route_id>", methods=["POST"])
@require_auth
def garmin_course_upload(route_id: str):
    """Tervezett útvonal feltöltése Garmin Connect course-ként (navigációhoz).
    ⚠️ Nem hivatalos végpont – izolált hibakezeléssel."""
    _require_garmin_lib()
    garmin = garmin_client(g.user["id"])
    if garmin is None:
        abort(409, description="Nincs Garmin kapcsolat. Csatlakozz a Beállítások panelben.")

    route_id   = _safe_id(route_id)
    user_dir   = _user_routes_dir(g.user["id"])
    gpx_path   = os.path.join(user_dir, f"{route_id}.gpx")
    if not os.path.isfile(gpx_path):
        abort(404, description="Útvonal nem található.")

    # Név + sport a könyvtár-indexből
    idx   = _load_index(os.path.join(user_dir, "index.json"))
    entry = next((r for r in idx if r.get("id") == route_id), None)
    name  = (entry or {}).get("name") or "Bringaterv útvonal"
    sport = _GARMIN_SPORT_MAP.get((entry or {}).get("type", "").lower(), "cycling")

    try:
        with open(gpx_path, encoding="utf-8") as f:
            gpx_text = f.read()
    except OSError:
        abort(500, description="Az útvonal fájl nem olvasható.")

    try:
        result = garmin_upload_course(garmin, name, gpx_text, sport=sport)
    except GarminConnectAuthenticationError:
        _delete_user_garmin(g.user["id"])
        abort(409, description="A Garmin kapcsolat érvénytelenné vált. Csatlakozz újra.")
    except GarminConnectTooManyRequestsError:
        abort(429, description="Garmin rate limit. Próbáld pár perc múlva.")
    except Exception as exc:
        log.warning("Garmin course upload hiba (user=%s, route=%s): %s", g.user["id"], route_id, exc)
        abort(502, description=f"Garmin course feltöltés sikertelen: {exc}")

    if not result.get("ok"):
        abort(422, description=result.get("error") or "A course feltöltés nem sikerült.")

    # Megjegyezzük a route-on, hogy felment Garminra (course_id + időpont) –
    # így a könyvtár „már feltöltve" jelzést tud mutatni.
    if entry is not None and result.get("course_id"):
        entry["garmin_course_id"]   = result["course_id"]
        entry["garmin_uploaded_at"] = _now_dt()
        try:
            _save_index(idx, os.path.join(user_dir, "index.json"))
        except Exception as exc:
            log.warning("Garmin course_id mentés sikertelen (route=%s): %s", route_id, exc)
        result["garmin_uploaded_at"] = entry["garmin_uploaded_at"]
    return jsonify(result)
