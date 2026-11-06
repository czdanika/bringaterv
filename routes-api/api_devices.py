"""Bringaterv API – Wahoo és Polar végpontok (hivatalos OAuth-os API-k, csak import).

  /api/<wahoo|polar>/status, connect, callback, disconnect, activities,
  import/<id>, deny-list/<id>, auto-sync (GET/PUT), auto-sync/run
  app-config (GET/PUT/DELETE) – a felhasználó saját fejlesztői app-kulcsai
"""

import re

from flask import Blueprint, abort, g, jsonify, request

from auth import require_auth
from config import log
from device_import import (LABELS, DeviceApiError, DeviceAuthError, close_window_html,
                           consume_state, delete_app, delete_tokens, load_app, load_tokens, new_state,
                           redirect_uri, remove_deny, save_app)
from device_sync import UserLock, _service
from storage import import_dedup_enabled

bp = Blueprint("api_devices", __name__)

_P = "<any(wahoo, polar):provider>"
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _fail(provider: str, exc: Exception):
    """Egységes hibakezelés: érvénytelen token → a kapcsolatot töröljük (409)."""
    if isinstance(exc, DeviceAuthError):
        delete_tokens(g.user["id"], provider)
        abort(409, description=f"A {LABELS[provider]}-kapcsolat érvénytelenné vált. Csatlakozz újra a Beállítások panelben.")
    log.warning("%s hiba (user=%s): %s", provider, g.user["id"], exc)
    abort(502, description=str(exc))


def _require_connected(provider: str):
    if not load_tokens(g.user["id"], provider).get("access_token"):
        abort(409, description=f"Nincs {LABELS[provider]}-kapcsolat. Csatlakozz a Beállítások panelben.")


@bp.route(f"/api/{_P}/status", methods=["GET"])
@require_auth
def device_status(provider: str):
    t = load_tokens(g.user["id"], provider)
    return jsonify({
        "app_configured": bool(load_app(provider, g.user["id"])["client_id"]),
        "connected":      bool(t.get("access_token")),
        "name":           t.get("name") or "",
        "connected_at":   t.get("connected_at"),
    })


@bp.route(f"/api/{_P}/connect", methods=["GET"])
@require_auth
def device_connect(provider: str):
    """A gyártó belépési oldalának címe (a frontend popupban nyitja meg)."""
    if not load_app(provider, g.user["id"])["client_id"]:
        abort(409, description=f"Előbb add meg a saját {LABELS[provider]}-alkalmazásod kulcsait (Beállítások → {LABELS[provider]}).")
    redirect = redirect_uri(provider)
    state = new_state(g.user["id"], provider, redirect)
    return jsonify({"auth_url": _service(provider).auth_url(g.user["id"], state, redirect)})


@bp.route(f"/api/{_P}/callback", methods=["GET"])
def device_callback(provider: str):
    """PUBLIKUS – a gyártó ide irányít vissza; a state azonosítja a felhasználót."""
    if request.args.get("error"):
        return close_window_html(provider, error=f"elutasítva ({request.args.get('error')})")
    code, state = request.args.get("code"), request.args.get("state")
    st = consume_state(state, provider) if code and state else None
    if not st or not st.get("user_id"):
        return close_window_html(provider, error="Lejárt vagy érvénytelen belépési folyamat – próbáld újra.")
    try:
        data = _service(provider).exchange_code(st["user_id"], code, st["redirect"])
    except (DeviceAuthError, DeviceApiError) as exc:
        return close_window_html(provider, error=str(exc))
    return close_window_html(provider, success=True, name=data.get("name") or "")


@bp.route(f"/api/{_P}/disconnect", methods=["DELETE"])
@require_auth
def device_disconnect(provider: str):
    _service(provider).disconnect(g.user["id"])
    delete_tokens(g.user["id"], provider)
    return jsonify({"ok": True})


@bp.route(f"/api/{_P}/activities", methods=["GET"])
@require_auth
def device_activities(provider: str):
    _require_connected(provider)
    days = max(1, min(3650, int(request.args.get("days", 30))))
    limit = max(1, min(200, int(request.args.get("limit", 30))))
    try:
        items = _service(provider).list_activities(g.user["id"], days=days, limit=limit)
    except (DeviceAuthError, DeviceApiError) as exc:
        _fail(provider, exc)
    return jsonify({"activities": items, "limit": limit})


@bp.route(f"/api/{_P}/import/<item_id>", methods=["POST"])
@require_auth
def device_import(provider: str, item_id: str):
    _require_connected(provider)
    if not _ID_RE.match(item_id) or (provider == "wahoo" and not item_id.isdigit()):
        abort(400, description="Érvénytelen edzés-azonosító.")
    try:
        with UserLock(g.user["id"], provider):       # a háttér-szinkron közben ne hozza be ugyanezt
            res = _service(provider).import_activity(g.user["id"], item_id,
                                                     dedup=import_dedup_enabled(g.user["id"]))
    except (DeviceAuthError, DeviceApiError) as exc:
        _fail(provider, exc)
    status = 422 if (not res.get("ok") and not res.get("skipped")) else 200
    return jsonify(res), status


@bp.route(f"/api/{_P}/deny-list/<item_id>", methods=["DELETE"])
@require_auth
def device_deny_remove(provider: str, item_id: str):
    if not _ID_RE.match(item_id):
        abort(400, description="Érvénytelen edzés-azonosító.")
    return jsonify({"ok": True, "removed": remove_deny(g.user["id"], provider, item_id)})


@bp.route(f"/api/{_P}/auto-sync", methods=["GET"])
@require_auth
def device_auto_sync_get(provider: str):
    from device_sync import load_sync, public
    return jsonify(public(load_sync(g.user["id"], provider)))


@bp.route(f"/api/{_P}/auto-sync", methods=["PUT"])
@require_auth
def device_auto_sync_set(provider: str):
    from device_sync import public, update_settings
    body = request.get_json(silent=True) or {}
    try:
        interval = int(body.get("interval_min", 15))
    except (TypeError, ValueError):
        interval = 15
    return jsonify(public(update_settings(g.user["id"], provider, bool(body.get("enabled")), interval)))


@bp.route(f"/api/{_P}/auto-sync/run", methods=["POST"])
@require_auth
def device_auto_sync_run(provider: str):
    from device_sync import public, sync_user
    _require_connected(provider)
    return jsonify(public(sync_user(g.user["id"], provider)))


# ── A felhasználó saját fejlesztői alkalmazása ────────────────────────────────

@bp.route(f"/api/{_P}/app-config", methods=["GET"])
@require_auth
def device_app_get(provider: str):
    a = load_app(provider, g.user["id"])
    return jsonify({"source": a["source"], "client_id": a["client_id"] if a["source"] == "user" else "",
                    "secret_set": a["source"] == "user", "redirect_uri": redirect_uri(provider)})


@bp.route(f"/api/{_P}/app-config", methods=["PUT"])
@require_auth
def device_app_set(provider: str):
    body = request.get_json(silent=True) or {}
    cid = (body.get("client_id") or "").strip()
    sec = (body.get("client_secret") or "").strip()
    has_old = load_app(provider, g.user["id"])["source"] == "user"
    if not cid or (not sec and not has_old):
        abort(400, description="A Client ID és a Client Secret is kötelező.")
    if len(cid) > 200 or len(sec) > 400:
        abort(400, description="Túl hosszú kulcs.")
    save_app(g.user["id"], provider, cid, sec or None)
    return jsonify({"ok": True})


@bp.route(f"/api/{_P}/app-config", methods=["DELETE"])
@require_auth
def device_app_delete(provider: str):
    """A saját kulcsok törlése – a meglévő kapcsolat is megszűnik (azzal az appal jött létre)."""
    try:
        _service(provider).disconnect(g.user["id"])
    except Exception:
        pass
    delete_tokens(g.user["id"], provider)
    delete_app(g.user["id"], provider)
    return jsonify({"ok": True})
