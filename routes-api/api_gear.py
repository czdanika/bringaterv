"""Bringaterv API – Felszerelés (bal menü → Felszerelés): bringák, alkatrészek, karbantartás.

  GET  /api/gear                 a felszerelés + a szerver számolta km / feladat-állapot
  PUT  /api/gear                 a teljes dokumentum mentése (a kliens szerkeszti)
  POST /api/gear/task-done       karbantartás elvégezve (napló + számláló nullázása)
  POST /api/routes/bulk-bike     több edzés bringájának kézi beállítása
"""

import fcntl
import os
import threading
import time

from flask import Blueprint, abort, g, jsonify, request, send_from_directory

from auth import require_auth
from config import MULTI_DATA_DIR, log
from gear import (PHOTO_RE, _date, _num, _str, cleanup_photos, clean_gear, compute_usage, load_gear, new_id,
                  notify_due, photo_dir, save_gear)
from storage import _user_routes_dir
from utils import _load_index, _save_index

bp = Blueprint("api_gear", __name__)


def _payload(uid: str, gear: dict | None = None):
    gear = gear or load_gear(uid)
    return jsonify({"gear": {k: gear[k] for k in ("bikes", "components", "logs")},
                    "usage": compute_usage(uid, gear)})


@bp.route("/api/gear", methods=["GET"])
@require_auth
def gear_get():
    return _payload(g.user["id"])


@bp.route("/api/gear", methods=["PUT"])
@require_auth
def gear_put():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        abort(400, description="Hiányzó felszerelés-adat.")
    uid = g.user["id"]
    gear = clean_gear(body, load_gear(uid), uid)
    save_gear(uid, gear)
    cleanup_photos(uid, gear)
    return _payload(uid, gear)


# ── Fotók (a böngésző átméretezi: max ~1280 px, JPEG) ─────────────────────────
_PHOTO_MAX = 1_500_000
_MAGIC = ((b"\xff\xd8\xff", "jpg"), (b"\x89PNG\r\n\x1a\n", "png"))


def _photo_target(gear: dict, ttype: str, tid: str):
    coll = gear["bikes"] if ttype == "bike" else gear["components"] if ttype == "component" else None
    t = next((x for x in coll or [] if x["id"] == tid), None)
    if not t:
        abort(404, description="Nincs ilyen bringa / alkatrész.")
    return t


@bp.route("/api/gear/photo/<ttype>/<tid>", methods=["POST"])
@require_auth
def gear_photo_upload(ttype: str, tid: str):
    data = request.get_data(cache=False, as_text=False)
    if not data or len(data) > _PHOTO_MAX:
        return jsonify({"error": "A kép túl nagy (legfeljebb 1,5 MB – a böngésző átméretezi)."}), 413
    ext = next((e for m, e in _MAGIC if data.startswith(m)), None)
    if not ext and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        ext = "webp"
    if not ext:
        return jsonify({"error": "Csak JPEG, PNG vagy WebP kép tölthető fel."}), 415
    uid = g.user["id"]
    gear = load_gear(uid)
    target = _photo_target(gear, ttype, tid)
    os.makedirs(photo_dir(uid), exist_ok=True)
    name = f"{tid}-{new_id('p')}.{ext}"
    with open(os.path.join(photo_dir(uid), name), "wb") as f:
        f.write(data)
    target["photo"] = name
    save_gear(uid, gear)
    cleanup_photos(uid, gear)                      # a régi kép törlődik
    return _payload(uid, gear)


@bp.route("/api/gear/photo/<ttype>/<tid>", methods=["DELETE"])
@require_auth
def gear_photo_delete(ttype: str, tid: str):
    uid = g.user["id"]
    gear = load_gear(uid)
    _photo_target(gear, ttype, tid).pop("photo", None)
    save_gear(uid, gear)
    cleanup_photos(uid, gear)
    return _payload(uid, gear)


@bp.route("/api/gear/photo/<name>", methods=["GET"])
@require_auth
def gear_photo_get(name: str):
    if not PHOTO_RE.match(name):
        abort(404)
    resp = send_from_directory(photo_dir(g.user["id"]), name, max_age=86400)
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


@bp.route("/api/gear/task-done", methods=["POST"])
@require_auth
def gear_task_done():
    """Elvégzett karbantartás: a feladat last_done-ja a megadott nap, és naplóbejegyzés."""
    body = request.get_json(silent=True) or {}
    uid = g.user["id"]
    gear = load_gear(uid)
    ttype = body.get("target_type")
    coll = gear["bikes"] if ttype == "bike" else gear["components"] if ttype == "component" else None
    target = next((x for x in coll or [] if x["id"] == body.get("target_id")), None)
    task = next((t for t in (target or {}).get("tasks") or [] if t["id"] == body.get("task_id")), None)
    if not task:
        abort(404, description="A feladat nem található.")
    day = _date(body.get("date")) or time.strftime("%Y-%m-%d")
    task["last_done"] = day
    gear["logs"].append({"id": new_id("l"), "target_type": ttype, "target_id": target["id"],
                         "task_id": task["id"], "task_name": task["name"], "date": day,
                         "cost": _num(body.get("cost"), 0, 100_000_000), "note": _str(body.get("note"), 300)})
    save_gear(uid, gear)
    return _payload(uid, gear)


@bp.route("/api/routes/bulk-bike", methods=["POST"])
@require_auth
def routes_bulk_bike():
    """Több edzés bringája egyszerre (üres bike_id = vissza automatikusra)."""
    body = request.get_json(silent=True) or {}
    ids = {str(i) for i in (body.get("ids") or [])[:2000]}
    bike_id = _str(body.get("bike_id"), 40)
    if not ids:
        abort(400, description="Nincs kijelölt edzés.")
    uid = g.user["id"]
    if bike_id and not any(b["id"] == bike_id for b in load_gear(uid)["bikes"]):
        abort(404, description="Ismeretlen bringa.")
    idx_path = os.path.join(_user_routes_dir(uid), "index.json")
    idx = _load_index(idx_path)
    n = 0
    for e in idx:
        if e.get("id") in ids and e.get("type") == "workout":
            if bike_id: e["bike_id"] = bike_id
            else: e.pop("bike_id", None)
            n += 1
    _save_index(idx, idx_path)
    return jsonify({"ok": True, "updated": n})


# ── Óránkénti ellenőrzés: esedékes karbantartás → push ────────────────────────

def _loop():
    lock = None
    while True:
        try:
            if lock is None:
                f = open(os.path.join(os.path.dirname(MULTI_DATA_DIR.rstrip("/")) or "/data", "gear_notify.lock"), "w")
                try:
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    lock = f
                except OSError:
                    f.close()
            if lock is not None and os.path.isdir(MULTI_DATA_DIR):
                for uid in sorted(os.listdir(MULTI_DATA_DIR)):
                    if os.path.isfile(os.path.join(MULTI_DATA_DIR, uid, "gear.json")):
                        try:
                            notify_due(uid)
                        except Exception as exc:
                            log.warning("Felszerelés-ellenőrzés hiba (%s): %s", uid, exc)
        except Exception as exc:
            log.warning("Felszerelés-ütemező hiba: %s", exc)
        time.sleep(3600)


_started = False


def start_scheduler():
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, name="gear-notify", daemon=True).start()
