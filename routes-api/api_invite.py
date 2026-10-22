"""Bringaterv API – meghívásos regisztráció (nyilvános végpontok).

A meghívott a /invite?t=<token> oldalon regisztrál: a token alapján ellenőrizzük
(érvényes, nem lejárt, nem visszavont, van még felhasználás), létrehozzuk a
fiókot a meghívóban megadott szerepkörrel / kvótával, és rögtön be is léptetjük.
"""

from flask import Blueprint, abort, jsonify, request

import mailer
from api_account import EMAIL_RE, public_base, send_verification
from config import log
from db import _db, _db_create_user
from security import _make_token
from utils import _now_dt

bp = Blueprint("api_invite", __name__)


def _valid_invite(conn, token: str):
    r = conn.execute("SELECT * FROM invites WHERE token = ?", (token,)).fetchone()
    if not r or r["revoked"]:
        return None, "Ez a meghívó nem érvényes."
    if r["expires_at"] and r["expires_at"] < _now_dt():
        return None, "Ez a meghívó lejárt – kérj újat."
    if r["uses"] >= r["max_uses"]:
        return None, "Ezt a meghívót már felhasználták."
    return r, None


@bp.route("/api/invite/<token>", methods=["GET"])
def invite_info(token: str):
    with _db() as conn:
        r, err = _valid_invite(conn, token)
        if err:
            return jsonify({"valid": False, "error": err}), 404
    # Csak az érvényesség, a lejárat és (e-mailes meghívónál) a cím – a megjegyzés nem kerül ki
    return jsonify({"valid": True, "expires_at": r["expires_at"], "email": r["invited_email"] or ""})


@bp.route("/api/invite/<token>/register", methods=["POST"])
def invite_register(token: str):
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    first = (body.get("first_name") or "").strip()
    last = (body.get("last_name") or "").strip()
    if not email or not password:
        abort(400, description="E-mail-cím és jelszó kötelező.")
    if not EMAIL_RE.match(email) or len(email) > 120:
        abort(400, description="Adj meg egy érvényes e-mail-címet – ezzel fogsz belépni.")
    if len(password) < 8:
        abort(400, description="A jelszó legalább 8 karakter legyen.")
    if not body.get("consent"):
        abort(400, description="Az adatkezelési tájékoztató elfogadása kötelező.")
    with _db() as conn:
        r, err = _valid_invite(conn, token)
        if err:
            abort(400, description=err)
        if conn.execute("SELECT id FROM users WHERE email = ? OR contact_email = ?", (email, email)).fetchone():
            abort(409, description="Ezzel az e-mail-címmel már van fiók.")
        uid = _db_create_user(conn, email, "", password, r["role"], first, last)
        if r["quota_routes"]:
            conn.execute("UPDATE users SET quota_routes = ? WHERE id = ?", (r["quota_routes"], uid))
        used_by = (r["used_by"] + "," if r["used_by"] else "") + email
        conn.execute("UPDATE invites SET uses = uses + 1, used_by = ? WHERE token = ?", (used_by, token))
        conn.execute("UPDATE users SET last_login_at = ?, login_count = 1, contact_email = ? WHERE id = ?",
                     (_now_dt(), email, uid))
        user = dict(conn.execute("SELECT id, email, name, role FROM users WHERE id = ?", (uid,)).fetchone())
        if r["invited_email"] and r["invited_email"] == email:
            # A meghívót erre a címre küldtük, a linkkel jött – a cím ezzel igazolt, nem kell kód
            conn.execute("UPDATE users SET email_verified_at = ? WHERE id = ?", (_now_dt(), uid))
        elif mailer.status()["configured"]:
            send_verification(conn, user, email, public_base())
    log.info("Regisztráció meghívóval: %s [%s]", email, user["role"])
    return jsonify({"token": _make_token(user["id"], user["email"], user["role"]), "user": user}), 201
