"""Bringaterv API – Magene / OneLapFit végpontok (kapcsolat, útvonal-feltöltés)."""

import os

from flask import Blueprint, abort, g, jsonify, request

from auth import require_auth
from config import log
from magene_service import (
    MAGENE_AVAILABLE,
    _delete_user_magene,
    _load_user_magene,
    magene_build_payload,
    magene_login,
    magene_upload_route,
)
from storage import _user_routes_dir
from utils import _load_index, _safe_id

bp = Blueprint("api_magene", __name__)


@bp.route("/api/magene/status", methods=["GET"])
@require_auth
def magene_status():
    data = _load_user_magene(g.user["id"])
    return jsonify({
        "available":    MAGENE_AVAILABLE,
        "connected":    bool(data.get("token")),
        "account":      data.get("account"),
        "nickname":     data.get("nickname"),
        "connected_at": data.get("connected_at"),
    })


@bp.route("/api/magene/connect", methods=["POST"])
@require_auth
def magene_connect():
    """Belépés OneLapFit email + jelszóval. A jelszót nem tároljuk, csak a tokent."""
    body     = request.get_json(silent=True) or {}
    email    = (body.get("email") or "").strip()
    password = body.get("password") or ""
    if not email or not password:
        abort(400, description="Email és jelszó kötelező.")
    try:
        data = magene_login(g.user["id"], email, password)
    except Exception as exc:
        log.warning("Magene connect hiba (user=%s): %s", g.user["id"], exc)
        abort(403, description=f"Magene belépés sikertelen: {exc}")
    log.info("Magene csatlakoztatva (user=%s)", g.user["id"])
    return jsonify({"connected": True, "account": data.get("account"), "nickname": data.get("nickname")})


@bp.route("/api/magene/disconnect", methods=["DELETE"])
@require_auth
def magene_disconnect():
    _delete_user_magene(g.user["id"])
    return jsonify({"ok": True})


@bp.route("/api/magene/route/<route_id>", methods=["POST"])
@require_auth
def magene_route_upload(route_id: str):
    """Tervezett útvonal feltöltése Magene/OneLapFit navigációhoz (csak vonal)."""
    data = _load_user_magene(g.user["id"])
    if not data.get("token"):
        abort(409, description="Nincs Magene kapcsolat. Csatlakozz a Beállítások panelben.")

    route_id = _safe_id(route_id)
    user_dir = _user_routes_dir(g.user["id"])
    gpx_path = os.path.join(user_dir, f"{route_id}.gpx")
    if not os.path.isfile(gpx_path):
        abort(404, description="Útvonal nem található.")

    idx   = _load_index(os.path.join(user_dir, "index.json"))
    entry = next((r for r in idx if r.get("id") == route_id), None)
    name  = (entry or {}).get("name") or "Bringaterv útvonal"

    try:
        with open(gpx_path, encoding="utf-8") as f:
            gpx_text = f.read()
    except OSError:
        abort(500, description="Az útvonal fájl nem olvasható.")

    built = magene_build_payload(gpx_text, name)
    if not built.get("ok"):
        abort(422, description=built.get("error") or "A payload előállítása nem sikerült.")

    try:
        result = magene_upload_route(g.user["id"], built["payload"])
    except Exception as exc:
        log.warning("Magene route upload hiba (user=%s, route=%s): %s", g.user["id"], route_id, exc)
        abort(502, description=f"Magene feltöltés sikertelen: {exc}")

    if not result.get("ok"):
        abort(422, description=result.get("error") or "A feltöltés nem sikerült.")

    # Megjegyezzük a route-on, hogy felment Magene-re
    if entry is not None and result.get("nid") is not None:
        entry["magene_nid"] = result["nid"]
        from utils import _now_dt, _save_index
        entry["magene_uploaded_at"] = _now_dt()
        try:
            _save_index(idx, os.path.join(user_dir, "index.json"))
        except Exception as exc:
            log.warning("Magene nid mentés sikertelen (route=%s): %s", route_id, exc)

    return jsonify({
        "ok": True,
        "nid": result.get("nid"),
        "name": result.get("name"),
        "distance_km": built.get("distance_km"),
        "climb_m": built.get("climb_m"),
        "points": built.get("points"),
    })
