"""Bringaterv API – OnelapFit (Magene) végpontok (csatlakozás, státusz, edzés-import, útvonal-feltöltés)."""

import os
import re
from functools import wraps

from flask import Blueprint, abort, g, jsonify, request

from auth import require_auth
from config import log
from storage import _user_routes_dir, import_dedup_enabled
from utils import _load_index, _now_dt, _safe_id, _save_index
from onelap_service import (
    FIT_AVAILABLE,
    OnelapApiError,
    OnelapAuthError,
    _delete_user_onelap,
    _remove_onelap_deny,
    onelap_import_activity,
    onelap_list_activities,
    onelap_login,
    onelap_session,
    onelap_status,
    onelap_upload_route,
)

bp = Blueprint("api_onelap", __name__)

_RIDE_ID_RE = re.compile(r"^[0-9a-fA-F]{8,40}$")


def _with_onelap(fn):
    """Kész munkamenetet ad át (g.onelap); egységes hibakezelés.
    Érvénytelen token → a kapcsolatot töröljük, 409 (újra kell csatlakozni)."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            sess = onelap_session(g.user["id"])
            if sess is None:
                abort(409, description="Nincs Onelap kapcsolat. Csatlakozz a Beállítások panelben.")
            g.onelap = sess
            return fn(*args, **kwargs)
        except OnelapAuthError:
            _delete_user_onelap(g.user["id"])
            abort(409, description="Az Onelap kapcsolat érvénytelenné vált. Csatlakozz újra a Beállítások panelben.")
        except OnelapApiError as exc:
            log.warning("Onelap hiba (user=%s, %s): %s", g.user["id"], fn.__name__, exc)
            abort(502, description=str(exc))
    return wrapper


def _notify_sent(name: str) -> None:
    """Push-értesítés a sikeres küldésről (Beállítások → Értesítések → Útvonal elküldve)."""
    import notify
    notify.send_async(g.user["id"], "route_sent", "✅ Útvonal elküldve az Onelapra",
                      f"„{name}” – az OnelapFit appban az útvonalaid között; szinkronizáld a komputerre.",
                      tag=f"route-sent-{name}")


@bp.route("/api/onelap/status", methods=["GET"])
@require_auth
def onelap_status_ep():
    """Csatlakozott-e a user. Ha a token a lejárathoz közel van, itt frissül (best-effort),
    így a kapcsolat addig él, amíg a user 60 napon belül megnyitja az appot."""
    try:
        onelap_session(g.user["id"])
    except OnelapAuthError:
        _delete_user_onelap(g.user["id"])
    except OnelapApiError as exc:
        log.debug("Onelap token-frissítés (status) sikertelen: %s", exc)
    return jsonify(onelap_status(g.user["id"]))


@bp.route("/api/onelap/connect", methods=["POST"])
@require_auth
def onelap_connect():
    """Belépés e-mail + jelszóval. A jelszót nem tároljuk, csak a tokeneket."""
    body     = request.get_json(silent=True) or {}
    account  = (body.get("email") or "").strip()
    password = body.get("password") or ""
    if not account or not password:
        abort(400, description="E-mail és jelszó kötelező.")
    try:
        data = onelap_login(g.user["id"], account, password)
    except OnelapAuthError:
        # 403 és nem 401: a 401-et a frontend session-lejáratként kezeli (kiléptet)
        abort(403, description="Hibás Onelap e-mail vagy jelszó.")
    except OnelapApiError as exc:
        log.warning("Onelap connect hiba (user=%s): %s", g.user["id"], exc)
        abort(502, description=f"Onelap belépés sikertelen: {exc}")
    return jsonify({"connected": True, "account": data["account"]})


@bp.route("/api/onelap/disconnect", methods=["DELETE"])
@require_auth
def onelap_disconnect():
    _delete_user_onelap(g.user["id"])
    return jsonify({"ok": True})


@bp.route("/api/onelap/activities", methods=["GET"])
@require_auth
@_with_onelap
def onelap_activities():
    """Onelap-edzések listája dedup-státusszal (importáláshoz)."""
    days  = max(1, min(3650, int(request.args.get("days", 30))))
    limit = max(1, min(200, int(request.args.get("limit", 30))))
    items = onelap_list_activities(g.onelap, g.user["id"], days=days, limit=limit)
    return jsonify({"activities": items, "limit": limit})


@bp.route("/api/onelap/import/<ride_id>", methods=["POST"])
@require_auth
@_with_onelap
def onelap_import(ride_id: str):
    """Egy edzés letöltése (FIT → GPX) és mentése a könyvtárba.
    Body: {start_ts} – az edzés kezdete (a lista adja), ebből keressük ki a friss FIT-linket."""
    if not FIT_AVAILABLE:
        abort(503, description="A fitdecode Python csomag nincs telepítve a szerveren.")
    if not _RIDE_ID_RE.match(ride_id):
        abort(400, description="Érvénytelen edzés-azonosító.")
    body = request.get_json(silent=True) or {}
    try:
        start_ts = int(body.get("start_ts") or 0)
    except (TypeError, ValueError):
        start_ts = 0
    if start_ts <= 0:
        abort(400, description="Hiányzó start_ts.")
    # a Strava / Garmin importhoz hasonlóan a kvóta nem korlátozza;
    # a zár miatt a háttér-szinkron közben nem hozza be ugyanezt
    from onelap_sync import _UserLock
    with _UserLock(g.user["id"]):
        result = onelap_import_activity(g.onelap, g.user["id"], ride_id, start_ts,
                                        dedup=import_dedup_enabled(g.user["id"]))
    status = 422 if (not result.get("ok") and not result.get("skipped")) else 200
    return jsonify(result), status


@bp.route("/api/onelap/auto-sync", methods=["GET"])
@require_auth
def onelap_auto_sync_get():
    """Automatikus import állapota (kapcsoló, időköz, utolsó ellenőrzés eredménye)."""
    from onelap_sync import load_sync, public
    return jsonify(public(load_sync(g.user["id"])))


@bp.route("/api/onelap/auto-sync", methods=["PUT"])
@require_auth
def onelap_auto_sync_set():
    from onelap_sync import public, update_settings
    body = request.get_json(silent=True) or {}
    try:
        interval = int(body.get("interval_min", 15))
    except (TypeError, ValueError):
        interval = 15
    return jsonify(public(update_settings(g.user["id"], bool(body.get("enabled")), interval)))


@bp.route("/api/onelap/auto-sync/run", methods=["POST"])
@require_auth
def onelap_auto_sync_run():
    """Azonnali ellenőrzés (az „Ellenőrzés most” gomb) – ugyanaz, mint egy ütemezett kör."""
    from onelap_sync import public, sync_user
    return jsonify(public(sync_user(g.user["id"])))


@bp.route("/api/onelap/deny-list/<ride_id>", methods=["DELETE"])
@require_auth
def onelap_deny_remove(ride_id: str):
    """Eltávolít egy edzést a törölt-listából (újra importálható)."""
    if not _RIDE_ID_RE.match(ride_id):
        abort(400, description="Érvénytelen edzés-azonosító.")
    return jsonify({"ok": True, "removed": _remove_onelap_deny(g.user["id"], ride_id)})


@bp.route("/api/onelap/route", methods=["POST"])
@require_auth
@_with_onelap
def onelap_route_upload_direct():
    """Tervezett útvonal küldése közvetlenül (könyvtári mentés nélkül) – pl. ha a
    könyvtár kvótája betelt. Body: {name, gpx}."""
    body = request.get_json(silent=True) or {}
    gpx_text = body.get("gpx") or ""
    if not gpx_text.strip():
        abort(400, description="Hiányzó GPX.")
    result = onelap_upload_route(g.onelap, (body.get("name") or "").strip() or "Bringaterv útvonal", gpx_text)
    if not result.get("ok"):
        abort(422, description=result.get("error") or "Az útvonal feltöltése nem sikerült.")
    log.info("Onelap útvonal feltöltve közvetlenül (user=%s, nid=%s)", g.user["id"], result.get("nid"))
    _notify_sent(result["name"])
    return jsonify(result)


@bp.route("/api/onelap/route/<route_id>", methods=["POST"])
@require_auth
@_with_onelap
def onelap_route_upload(route_id: str):
    """Tervezett útvonal feltöltése az OnelapFit útvonalkönyvébe (onnan a Magene
    kerékpáros komputerre szinkronizálható navigációhoz)."""
    route_id = _safe_id(route_id)
    user_dir = _user_routes_dir(g.user["id"])
    gpx_path = os.path.join(user_dir, f"{route_id}.gpx")
    if not os.path.isfile(gpx_path):
        abort(404, description="Útvonal nem található.")
    idx_path = os.path.join(user_dir, "index.json")
    idx      = _load_index(idx_path)
    entry    = next((r for r in idx if r.get("id") == route_id), None)
    try:
        with open(gpx_path, encoding="utf-8") as f:
            gpx_text = f.read()
    except OSError:
        abort(500, description="Az útvonal fájl nem olvasható.")

    result = onelap_upload_route(g.onelap, (entry or {}).get("name") or "Bringaterv útvonal", gpx_text)
    if not result.get("ok"):
        abort(422, description=result.get("error") or "Az útvonal feltöltése nem sikerült.")

    # Megjegyezzük, hogy felment (a könyvtár „újraküldés” feliratot mutat)
    if entry is not None:
        entry["onelap_route_nid"]   = result.get("nid")
        entry["onelap_uploaded_at"] = _now_dt()
        try:
            _save_index(idx, idx_path)
        except Exception as exc:
            log.warning("Onelap nid mentés sikertelen (route=%s): %s", route_id, exc)
        result["onelap_uploaded_at"] = entry["onelap_uploaded_at"]
    log.info("Onelap útvonal feltöltve (user=%s, route=%s, nid=%s)", g.user["id"], route_id, result.get("nid"))
    _notify_sent(result["name"])
    return jsonify(result)
