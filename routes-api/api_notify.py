"""Bringaterv API – értesítések (Web Push): kulcs, feliratkozás, eseménybeállítás, teszt."""

from flask import Blueprint, abort, g, jsonify, request

import notify
from auth import require_auth

bp = Blueprint("api_notify", __name__)


def _public(data: dict, endpoint: str | None = None) -> dict:
    """A kliensnek: események + eszközök száma (a kulcsokat nem adjuk vissza)."""
    subs = data.get("subscriptions") or []
    return {
        "events": data.get("events", {}),
        "event_labels": notify.EVENTS,
        "devices": len(subs),
        "this_device": bool(endpoint and any(s.get("endpoint") == endpoint for s in subs)),
        "last_send": data.get("last_send"),
    }


@bp.route("/api/notify/config", methods=["GET"])
@require_auth
def notify_config():
    return jsonify({**_public(notify.load(g.user["id"]), request.args.get("endpoint")),
                    "vapid_public_key": notify.vapid_public_key()})


@bp.route("/api/notify/events", methods=["PUT"])
@require_auth
def notify_events():
    body = request.get_json(silent=True) or {}
    data = notify.load(g.user["id"])
    for k, v in (body.get("events") or {}).items():
        if k in notify.EVENTS:
            data["events"][k] = bool(v)
    notify.save(g.user["id"], data)
    return jsonify(_public(data))


@bp.route("/api/notify/subscribe", methods=["POST"])
@require_auth
def notify_subscribe():
    body = request.get_json(silent=True) or {}
    try:
        data = notify.subscribe(g.user["id"], body.get("subscription") or {},
                                request.headers.get("User-Agent", ""))
    except ValueError as exc:
        abort(400, description=str(exc))
    return jsonify(_public(data, (body.get("subscription") or {}).get("endpoint")))


@bp.route("/api/notify/unsubscribe", methods=["POST"])
@require_auth
def notify_unsubscribe():
    body = request.get_json(silent=True) or {}
    return jsonify(_public(notify.unsubscribe(g.user["id"], body.get("endpoint") or "")))


@bp.route("/api/notify/test", methods=["POST"])
@require_auth
def notify_test():
    """Próbaértesítés. `delay` (mp, max 30): a szerver késleltetve küldi, hogy közben
    be lehessen zárni az appot (zárt / háttérben lévő appnál látszik igazán)."""
    import threading
    import time
    body = request.get_json(silent=True) or {}
    try:
        delay = max(0, min(30, int(body.get("delay", 0))))
    except (TypeError, ValueError):
        delay = 0
    uid = g.user["id"]
    devices = len(notify.load(uid).get("subscriptions") or [])

    def _send():
        if delay:
            time.sleep(delay)
        notify.send(uid, "test", "Bringaterv – próbaértesítés",
                    "Ha ezt látod, az értesítések működnek. 🚴", force=True)

    if delay:
        threading.Thread(target=_send, daemon=True).start()
        return jsonify({"scheduled": True, "delay": delay, "devices": devices})
    return jsonify({"sent": notify.send(uid, "test", "Bringaterv – próbaértesítés",
                                        "Ha ezt látod, az értesítések működnek. 🚴", force=True),
                    "devices": devices})
