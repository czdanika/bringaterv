"""Bringaterv API – iGPSport végpontok (csatlakozás, státusz, edzés-import, útvonal-feltöltés).

  GET    /api/igpsport/status
  POST   /api/igpsport/connect              {email, password} – a jelszót nem tároljuk
  DELETE /api/igpsport/disconnect
  GET    /api/igpsport/activities?limit=
  POST   /api/igpsport/import/<ride_id>
  GET    /api/igpsport/auto-sync  ·  PUT /api/igpsport/auto-sync  ·  POST /api/igpsport/auto-sync/run
  DELETE /api/igpsport/deny-list/<ride_id>
  POST   /api/igpsport/route                {name, gpx, mode?, description?} – közvetlen küldés
  POST   /api/igpsport/route/<route_id>     könyvtári útvonal küldése
"""

import os
import re
from functools import wraps

from flask import Blueprint, abort, g, jsonify, request

from auth import require_auth
from config import log
from storage import _user_routes_dir, import_dedup_enabled
from utils import _load_index, _now_dt, _safe_id, index_lock, _save_index
from igpsport_service import (
    FIT_AVAILABLE, IgpApiError, IgpAuthError, igp_disconnect, igp_import_activity,
    igp_list_activities, igp_login, igp_status, igp_token, igp_upload_route, remove_deny,
)

bp = Blueprint("api_igpsport", __name__)

_RIDE_ID_RE = re.compile(r"^\d{1,15}$")
_RECONNECT = "Az iGPSport-belépés lejárt (7 naponta kell). Csatlakozz újra: Beállítások → iGPSport."


def _with_igp(fn):
    """Érvényes tokent ad át (g.igp_token); egységes hibakezelés."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            tok = igp_token(g.user["id"])
            if tok is None:
                abort(409, description="Nincs iGPSport kapcsolat. Csatlakozz a Beállítások panelben.")
            g.igp_token = tok
            return fn(*args, **kwargs)
        except IgpAuthError:
            abort(409, description=_RECONNECT)
        except IgpApiError as exc:
            log.warning("iGPSport hiba (user=%s, %s): %s", g.user["id"], fn.__name__, exc)
            abort(502, description=str(exc))
    return wrapper


def _notify_sent(name: str) -> None:
    import notify
    notify.send_async(g.user["id"], "route_sent", "✅ Útvonal elküldve az iGPSportra",
                      f"„{name}” – az iGPSport appban az útvonalaid között; szinkronizáld a komputerre.",
                      tag=f"route-sent-igp-{name}")


@bp.route("/api/igpsport/status", methods=["GET"])
@require_auth
def igp_status_ep():
    return jsonify(igp_status(g.user["id"]))


@bp.route("/api/igpsport/connect", methods=["POST"])
@require_auth
def igp_connect():
    body = request.get_json(silent=True) or {}
    account = (body.get("email") or "").strip()
    password = body.get("password") or ""
    if not account or not password:
        abort(400, description="E-mail és jelszó kötelező.")
    try:
        data = igp_login(g.user["id"], account, password)
    except IgpAuthError:
        abort(403, description="Hibás iGPSport e-mail vagy jelszó.")   # nem 401 (a kliens kiléptetne)
    except IgpApiError as exc:
        abort(502, description=f"iGPSport belépés sikertelen: {exc}")
    try:   # új belépés → a lejárat-figyelmeztetés újra küldhető
        from igpsport_sync import load_sync, save_sync
        st = load_sync(g.user["id"])
        st["expiry_alerted"] = False
        st["conn_alerted"] = False
        save_sync(g.user["id"], st)
    except Exception:
        pass
    return jsonify({"connected": True, "account": data["account"], "nickname": data.get("nickname")})


@bp.route("/api/igpsport/disconnect", methods=["DELETE"])
@require_auth
def igp_disconnect_ep():
    igp_disconnect(g.user["id"])
    return jsonify({"ok": True})


@bp.route("/api/igpsport/activities", methods=["GET"])
@require_auth
@_with_igp
def igp_activities():
    try:
        limit = max(1, min(100, int(request.args.get("limit", 30))))
    except ValueError:
        limit = 30
    return jsonify({"activities": igp_list_activities(g.igp_token, g.user["id"], limit=limit), "limit": limit})


@bp.route("/api/igpsport/import/<ride_id>", methods=["POST"])
@require_auth
@_with_igp
def igp_import(ride_id: str):
    if not FIT_AVAILABLE:
        abort(503, description="A fitdecode Python csomag nincs telepítve a szerveren.")
    if not _RIDE_ID_RE.match(ride_id):
        abort(400, description="Érvénytelen edzés-azonosító.")
    from igpsport_sync import _UserLock
    with _UserLock(g.user["id"]):
        result = igp_import_activity(g.igp_token, g.user["id"], ride_id, dedup=import_dedup_enabled(g.user["id"]))
    return jsonify(result), (422 if (not result.get("ok") and not result.get("skipped")) else 200)


@bp.route("/api/igpsport/auto-sync", methods=["GET"])
@require_auth
def igp_auto_sync_get():
    from igpsport_sync import load_sync, public
    return jsonify(public(load_sync(g.user["id"])))


@bp.route("/api/igpsport/auto-sync", methods=["PUT"])
@require_auth
def igp_auto_sync_set():
    from igpsport_sync import public, update_settings
    body = request.get_json(silent=True) or {}
    try:
        interval = int(body.get("interval_min", 15))
    except (TypeError, ValueError):
        interval = 15
    return jsonify(public(update_settings(g.user["id"], bool(body.get("enabled")), interval)))


@bp.route("/api/igpsport/auto-sync/run", methods=["POST"])
@require_auth
def igp_auto_sync_run():
    from igpsport_sync import public, sync_user
    return jsonify(public(sync_user(g.user["id"])))


@bp.route("/api/igpsport/deny-list/<ride_id>", methods=["DELETE"])
@require_auth
def igp_deny_remove(ride_id: str):
    if not _RIDE_ID_RE.match(ride_id):
        abort(400, description="Érvénytelen edzés-azonosító.")
    return jsonify({"ok": True, "removed": remove_deny(g.user["id"], ride_id)})


def _upload(name: str, gpx_text: str, mode: str, description: str) -> dict:
    result = igp_upload_route(g.igp_token, name, gpx_text, mode=mode, description=description)
    if not result.get("ok"):
        abort(422, description=result.get("error") or "Az útvonal feltöltése nem sikerült.")
    _notify_sent(result["name"])
    return result


@bp.route("/api/igpsport/route", methods=["POST"])
@require_auth
@_with_igp
def igp_route_direct():
    """Tervezett útvonal küldése közvetlenül (könyvtári mentés nélkül). Body: {name, gpx, mode?, description?}."""
    body = request.get_json(silent=True) or {}
    gpx_text = body.get("gpx") or ""
    if not gpx_text.strip():
        abort(400, description="Hiányzó GPX.")
    res = _upload((body.get("name") or "").strip() or "Bringaterv útvonal", gpx_text,
                  str(body.get("mode") or "asphalt"), str(body.get("description") or ""))
    log.info("iGPSport útvonal feltöltve közvetlenül (user=%s, road=%s)", g.user["id"], res.get("road_id"))
    return jsonify(res)


@bp.route("/api/igpsport/route/<route_id>", methods=["POST"])
@require_auth
@_with_igp
def igp_route_upload(route_id: str):
    route_id = _safe_id(route_id)
    user_dir = _user_routes_dir(g.user["id"])
    gpx_path = os.path.join(user_dir, f"{route_id}.gpx")
    if not os.path.isfile(gpx_path):
        abort(404, description="Útvonal nem található.")
    idx_path = os.path.join(user_dir, "index.json")
    entry = next((r for r in _load_index(idx_path) if r.get("id") == route_id), None) or {}
    with open(gpx_path, encoding="utf-8") as f:
        gpx_text = f.read()
    res = _upload(entry.get("name") or "Bringaterv útvonal", gpx_text,
                  entry.get("type") or "asphalt", entry.get("description") or "")
    with index_lock(idx_path):             # megjegyezzük (a könyvtár „Újraküldés” feliratot mutat)
        idx = _load_index(idx_path)
        e = next((r for r in idx if r.get("id") == route_id), None)
        if e is not None:
            e["igpsport_road_id"] = res.get("road_id")
            e["igpsport_uploaded_at"] = _now_dt()
            _save_index(idx, idx_path)
            res["igpsport_uploaded_at"] = e["igpsport_uploaded_at"]
    log.info("iGPSport útvonal feltöltve (user=%s, route=%s, road=%s)", g.user["id"], route_id, res.get("road_id"))
    return jsonify(res)
