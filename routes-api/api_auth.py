"""Bringaterv API – auth végpontok (login, me) + user beállítások."""

from flask import Blueprint, abort, g, jsonify, request

from auth import require_auth
from config import log
from db import _db
from security import _check_pw, _make_token
from storage import _load_user_settings_file, _save_user_settings_file
from utils import _now_dt

bp = Blueprint("api_auth", __name__)


@bp.route("/api/auth/login", methods=["POST"])
def auth_login():
    data     = request.get_json(silent=True) or {}
    # "email" vagy "username" mezőt egyaránt elfogadunk
    email    = (data.get("email") or data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    if not email or not password:
        abort(400, description="Felhasználónév/email és jelszó kötelező")
    with _db() as conn:
        user = conn.execute(
            "SELECT * FROM users WHERE email = ? AND active = 1", (email,)
        ).fetchone()
        if not user or not _check_pw(password, user["password_hash"]):
            abort(401, description="Hibás email vagy jelszó")
        user = dict(user)
        conn.execute(
            "UPDATE users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?",
            (_now_dt(), user["id"]),
        )
        conn.execute(
            "INSERT INTO user_sessions (user_id, logged_in_at, ip_address) VALUES (?,?,?)",
            (user["id"], _now_dt(), request.remote_addr),
        )
    token = _make_token(user["id"], user["email"], user["role"])
    log.info("Login: %s", user["email"])
    return jsonify({
        "token": token,
        "user":  {"id": user["id"], "email": user["email"],
                  "name": user["name"], "role": user["role"]},
    })


@bp.route("/api/auth/me", methods=["GET"])
@require_auth
def auth_me():
    u = g.user
    return jsonify({"id": u["id"], "email": u["email"],
                    "name": u["name"], "role": u["role"]})


# Engedélyezett settings kulcsok – új kulcs hozzáadásához itt kell bővíteni
SETTINGS_ALLOWED_KEYS = {
    # Térkép és UI
    "mapStyle", "theme", "unit", "startView",
    "snapToRoads", "showStageInfo", "gpxSampleWaypoints",
    "toolbarOrder", "toolbarHidden",
    # HR / edzés zónák
    "hrZones", "speedZones", "cadZones", "powerZones",
    # Diagram színek (mode + per-chart színek)
    "chartColors",
    # Kerékpáros profil (szélhatás, kalória)
    "cyclistProfile",
}


@bp.route("/api/user/settings", methods=["GET"])
@require_auth
def get_user_settings():
    """Felhasználó személyes beállításainak lekérése (per-user settings.json)."""
    return jsonify(_load_user_settings_file(g.user["id"]))


@bp.route("/api/user/settings", methods=["PUT"])
@require_auth
def put_user_settings():
    """Felhasználó személyes beállításainak mentése (per-user settings.json).

    Merge stratégia: a meglévő beállításokhoz hozzáadja / felülírja a kapott
    kulcsokat – nem törli a régieket. Így a kliens küldhet részleges payload-ot.
    """
    data = request.get_json(silent=True)
    if data is None:
        abort(400, description="Hiányzó JSON body")
    incoming = {k: v for k, v in data.items() if k in SETTINGS_ALLOWED_KEYS}
    current  = _load_user_settings_file(g.user["id"])
    current.update(incoming)
    try:
        _save_user_settings_file(g.user["id"], current)
    except OSError as exc:
        log.error("Settings írási hiba (%s): %s", g.user["id"], exc)
        abort(500, description="Beállítások mentése sikertelen")
    return jsonify({"ok": True})
