"""Bringaterv API – Bryton végpontok (csatlakozás, státusz, edzés-import, útvonal-feltöltés).

  GET    /api/bryton/status
  POST   /api/bryton/connect              {email, password} – a jelszót nem tároljuk
  DELETE /api/bryton/disconnect
  GET    /api/bryton/activities?limit=
  POST   /api/bryton/import/<ride_id>
  GET    /api/bryton/auto-sync  ·  PUT /api/bryton/auto-sync  ·  POST /api/bryton/auto-sync/run
  DELETE /api/bryton/deny-list/<ride_id>
  POST   /api/bryton/route                {name, gpx, hints?} – közvetlen küldés
  POST   /api/bryton/route/<route_id>     könyvtári útvonal küldése ({hints?})
"""

import os
import re
from functools import wraps

from flask import Blueprint, abort, g, jsonify, request

from auth import require_auth
from config import log
from storage import _user_routes_dir, import_dedup_enabled
from utils import _load_index, _now_dt, _safe_id, index_lock, _save_index
from bryton_service import (
    FIT_AVAILABLE, BrytonApiError, BrytonAuthError, bryton_disconnect, bryton_import_activity,
    bryton_list_activities, bryton_login, bryton_session, bryton_status, bryton_upload_route, remove_deny,
)

bp = Blueprint("api_bryton", __name__)

_RIDE_ID_RE = re.compile(r"^[A-Za-z0-9]{6,40}$")
_RECONNECT = "A Bryton-belépés lejárt vagy érvénytelen. Csatlakozz újra: Beállítások → Bryton."


def _with_bryton(fn):
    """Érvényes tokent ad át (g.bryton); egységes hibakezelés."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            tok = bryton_session(g.user["id"])
            if tok is None:
                abort(409, description="Nincs Bryton kapcsolat. Csatlakozz a Beállítások panelben.")
            g.bryton = tok
            return fn(*args, **kwargs)
        except BrytonAuthError:
            abort(409, description=_RECONNECT)
        except BrytonApiError as exc:
            log.warning("Bryton hiba (user=%s, %s): %s", g.user["id"], fn.__name__, exc)
            abort(502, description=str(exc))
    return wrapper


def _notify_sent(name: str) -> None:
    import notify
    notify.send_async(g.user["id"], "route_sent", "✅ Útvonal elküldve a Brytonra",
                      f"„{name}” – a Bryton Active appban a tervezett utak között; szinkronizáld a komputerre.",
                      tag=f"route-sent-bryton-{name}")


@bp.route("/api/bryton/status", methods=["GET"])
@require_auth
def bryton_ep_status_ep():
    return jsonify(bryton_status(g.user["id"]))


@bp.route("/api/bryton/connect", methods=["POST"])
@require_auth
def bryton_ep_connect():
    body = request.get_json(silent=True) or {}
    account = (body.get("email") or "").strip()
    password = body.get("password") or ""
    if not account or not password:
        abort(400, description="E-mail és jelszó kötelező.")
    try:
        data = bryton_login(g.user["id"], account, password)
    except BrytonAuthError:
        abort(403, description="Hibás Bryton e-mail vagy jelszó.")   # nem 401 (a kliens kiléptetne)
    except BrytonApiError as exc:
        abort(502, description=f"Bryton belépés sikertelen: {exc}")
    try:   # új belépés → a lejárat-figyelmeztetés újra küldhető
        from bryton_sync import load_sync, save_sync
        st = load_sync(g.user["id"])
        st["expiry_alerted"] = False
        st["conn_alerted"] = False
        save_sync(g.user["id"], st)
    except Exception:
        pass
    return jsonify({"connected": True, "account": data["account"], "expires_at": data.get("expires_at")})


@bp.route("/api/bryton/disconnect", methods=["DELETE"])
@require_auth
def bryton_ep_disconnect_ep():
    bryton_disconnect(g.user["id"])
    return jsonify({"ok": True})


@bp.route("/api/bryton/activities", methods=["GET"])
@require_auth
@_with_bryton
def bryton_ep_activities():
    try:
        limit = max(1, min(200, int(request.args.get("limit", 30))))
    except ValueError:
        limit = 30
    return jsonify({"activities": bryton_list_activities(g.bryton, g.user["id"], limit=limit), "limit": limit})


@bp.route("/api/bryton/import/<ride_id>", methods=["POST"])
@require_auth
@_with_bryton
def bryton_ep_import(ride_id: str):
    if not FIT_AVAILABLE:
        abort(503, description="A fitdecode Python csomag nincs telepítve a szerveren.")
    if not _RIDE_ID_RE.match(ride_id):
        abort(400, description="Érvénytelen edzés-azonosító.")
    from bryton_sync import _UserLock
    with _UserLock(g.user["id"]):
        result = bryton_import_activity(g.bryton, g.user["id"], ride_id, dedup=import_dedup_enabled(g.user["id"]))
    return jsonify(result), (422 if (not result.get("ok") and not result.get("skipped")) else 200)


@bp.route("/api/bryton/auto-sync", methods=["GET"])
@require_auth
def bryton_ep_auto_sync_get():
    from bryton_sync import load_sync, public
    return jsonify(public(load_sync(g.user["id"])))


@bp.route("/api/bryton/auto-sync", methods=["PUT"])
@require_auth
def bryton_ep_auto_sync_set():
    from bryton_sync import public, update_settings
    body = request.get_json(silent=True) or {}
    try:
        interval = int(body.get("interval_min", 15))
    except (TypeError, ValueError):
        interval = 15
    return jsonify(public(update_settings(g.user["id"], bool(body.get("enabled")), interval)))


@bp.route("/api/bryton/auto-sync/run", methods=["POST"])
@require_auth
def bryton_ep_auto_sync_run():
    from bryton_sync import public, sync_user
    return jsonify(public(sync_user(g.user["id"])))


@bp.route("/api/bryton/deny-list/<ride_id>", methods=["DELETE"])
@require_auth
def bryton_ep_deny_remove(ride_id: str):
    if not _RIDE_ID_RE.match(ride_id):
        abort(400, description="Érvénytelen edzés-azonosító.")
    return jsonify({"ok": True, "removed": remove_deny(g.user["id"], ride_id)})


def _upload(name: str, gpx_text: str, hints) -> dict:
    result = bryton_upload_route(g.bryton, name, gpx_text, hints=hints if isinstance(hints, list) else None)
    if not result.get("ok"):
        abort(422, description=result.get("error") or "Az útvonal feltöltése nem sikerült.")
    _notify_sent(result["name"])
    return result


@bp.route("/api/bryton/route", methods=["POST"])
@require_auth
@_with_bryton
def bryton_ep_route_direct():
    """Tervezett útvonal küldése közvetlenül (könyvtári mentés nélkül). Body: {name, gpx, hints?} – hints: a BRouter kanyar-utasításai."""
    body = request.get_json(silent=True) or {}
    gpx_text = body.get("gpx") or ""
    if not gpx_text.strip():
        abort(400, description="Hiányzó GPX.")
    res = _upload((body.get("name") or "").strip() or "Bringaterv útvonal", gpx_text, body.get("hints"))
    log.info("Bryton útvonal feltöltve közvetlenül (user=%s, road=%s)", g.user["id"], res.get("file_id"))
    return jsonify(res)


@bp.route("/api/bryton/route/<route_id>", methods=["POST"])
@require_auth
@_with_bryton
def bryton_ep_route_upload(route_id: str):
    route_id = _safe_id(route_id)
    user_dir = _user_routes_dir(g.user["id"])
    gpx_path = os.path.join(user_dir, f"{route_id}.gpx")
    if not os.path.isfile(gpx_path):
        abort(404, description="Útvonal nem található.")
    idx_path = os.path.join(user_dir, "index.json")
    entry = next((r for r in _load_index(idx_path) if r.get("id") == route_id), None) or {}
    with open(gpx_path, encoding="utf-8") as f:
        gpx_text = f.read()
    body = request.get_json(silent=True) or {}
    res = _upload(entry.get("name") or "Bringaterv útvonal", gpx_text, body.get("hints"))
    with index_lock(idx_path):             # megjegyezzük (a könyvtár „Újraküldés” feliratot mutat)
        idx = _load_index(idx_path)
        e = next((r for r in idx if r.get("id") == route_id), None)
        if e is not None:
            e["bryton_file_id"] = res.get("file_id")
            e["bryton_uploaded_at"] = _now_dt()
            _save_index(idx, idx_path)
            res["bryton_uploaded_at"] = e["bryton_uploaded_at"]
    log.info("Bryton útvonal feltöltve (user=%s, route=%s, road=%s)", g.user["id"], route_id, res.get("file_id"))
    return jsonify(res)
