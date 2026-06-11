"""Bringaterv API – admin végpontok (userek, user útvonalak, statisztika)."""

import os
import re
import uuid

from flask import Blueprint, abort, g, jsonify, request

from auth import require_admin, require_auth
from config import log
from db import _db, _db_create_user
from security import _hash_pw
from storage import _user_routes_dir, _user_storage_stats
from utils import _load_index, _now_date, _now_dt, _safe_id, _save_index

bp = Blueprint("api_admin", __name__)


@bp.route("/api/admin/users", methods=["GET"])
@require_auth
@require_admin
def admin_list_users():
    with _db() as conn:
        rows = conn.execute("""
            SELECT id, email, name, first_name, last_name,
                   role, active, created_at,
                   last_login_at, login_count,
                   quota_routes, quota_workouts, quota_mb
            FROM users ORDER BY created_at DESC
        """).fetchall()
    result = []
    for r in rows:
        u = dict(r)
        u["stats"] = _user_storage_stats(u["id"])
        result.append(u)
    return jsonify(result)


@bp.route("/api/admin/users", methods=["POST"])
@require_auth
@require_admin
def admin_create_user():
    data       = request.get_json(silent=True) or {}
    email      = (data.get("email") or "").strip().lower()
    password   = data.get("password") or ""
    first_name = (data.get("first_name") or "").strip()
    last_name  = (data.get("last_name")  or "").strip()
    name       = (data.get("name") or "").strip()
    role       = data.get("role", "user")
    if not email or not password:
        abort(400, description="Email és jelszó kötelező")
    if len(password) < 6:
        abort(400, description="A jelszó legalább 6 karakter legyen")
    if role not in ("admin", "user", "readonly"):
        abort(400, description="Érvénytelen szerepkör: admin | user | readonly")
    display = f"{first_name} {last_name}".strip() or name or email.split("@")[0]
    with _db() as conn:
        if conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone():
            abort(409, description="Ez az email már regisztrált")
        uid = _db_create_user(conn, email, display, password, role, first_name, last_name)
    log.info("Új user: %s [%s]  (admin: %s)", email, role, g.user["email"])
    return jsonify({"id": uid, "email": email, "name": display,
                    "first_name": first_name, "last_name": last_name, "role": role}), 201


@bp.route("/api/admin/users/<user_id>", methods=["GET"])
@require_auth
@require_admin
def admin_get_user(user_id: str):
    with _db() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            abort(404, description="User nem található")
        sessions = conn.execute("""
            SELECT logged_in_at, ip_address FROM user_sessions
            WHERE user_id = ? ORDER BY logged_in_at DESC LIMIT 10
        """, (user_id,)).fetchall()
    u = dict(row)
    u.pop("password_hash", None)
    u["stats"]           = _user_storage_stats(user_id)
    u["recent_sessions"] = [dict(s) for s in sessions]
    return jsonify(u)


@bp.route("/api/admin/users/<user_id>", methods=["PATCH"])
@require_auth
@require_admin
def admin_update_user(user_id: str):
    data    = request.get_json(silent=True) or {}
    allowed = {"name", "first_name", "last_name", "role", "active",
               "quota_routes", "quota_workouts", "quota_mb"}
    updates = {k: v for k, v in data.items() if k in allowed}
    new_email    = (data.get("email") or "").strip().lower() or None
    new_password = (data.get("password") or "").strip() or None

    if not updates and not new_email and not new_password:
        abort(400, description="Nincs módosítható mező")
    if user_id == g.user["id"] and "active" in updates and not updates["active"]:
        abort(400, description="Saját magad nem tilthatod le")
    if new_password and len(new_password) < 6:
        abort(400, description="A jelszó legalább 6 karakter legyen")

    with _db() as conn:
        # Email egyediség ellenőrzés
        if new_email:
            clash = conn.execute(
                "SELECT id FROM users WHERE email = ? AND id != ?", (new_email, user_id)
            ).fetchone()
            if clash:
                abort(409, description="Ez a felhasználónév/email már foglalt")
            updates["email"] = new_email

        # Jelszó hash
        if new_password:
            updates["password_hash"] = _hash_pw(new_password)

        # Ha first_name vagy last_name változott, frissítsük a name-t is
        if "first_name" in updates or "last_name" in updates:
            cur = conn.execute(
                "SELECT first_name, last_name FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            fn = updates.get("first_name", cur["first_name"] if cur else "").strip()
            ln = updates.get("last_name",  cur["last_name"]  if cur else "").strip()
            computed = f"{ln} {fn}".strip()
            if computed:
                updates["name"] = computed

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(f"UPDATE users SET {set_clause} WHERE id = ?",
                     [*updates.values(), user_id])
        row = conn.execute(
            "SELECT id, email, name, first_name, last_name, role, active, "
            "quota_routes, quota_workouts, quota_mb FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
    if not row:
        abort(404, description="User nem található")
    return jsonify(dict(row))


@bp.route("/api/admin/users/<user_id>/password", methods=["POST"])
@require_auth
@require_admin
def admin_reset_password(user_id: str):
    data = request.get_json(silent=True) or {}
    pw   = data.get("password") or ""
    if len(pw) < 6:
        abort(400, description="Legalább 6 karakter szükséges")
    with _db() as conn:
        cur = conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?", (_hash_pw(pw), user_id)
        )
    if cur.rowcount == 0:
        abort(404, description="User nem található")
    log.info("Jelszó reset: %s  (admin: %s)", user_id, g.user["email"])
    return jsonify({"ok": True})


@bp.route("/api/admin/users/<user_id>/routes", methods=["GET"])
@require_auth
@require_admin
def admin_list_user_routes(user_id: str):
    """Admin: adott user útvonalainak listája."""
    routes_dir = _user_routes_dir(user_id)
    idx_path   = os.path.join(routes_dir, "index.json")
    routes     = _load_index(idx_path)
    # GPX + opcionális FIT fájlméret hozzáadása
    for r in routes:
        gpx = os.path.join(routes_dir, f"{r['id']}.gpx")
        fit = os.path.join(routes_dir, f"{r['id']}.fit")
        r["size_kb"] = round(os.path.getsize(gpx) / 1024, 1) if os.path.isfile(gpx) else 0
        if os.path.isfile(fit):
            r["has_fit"]     = True
            r["fit_size_kb"] = round(os.path.getsize(fit) / 1024, 1)
        else:
            r["has_fit"]     = False
    return jsonify(sorted(routes, key=lambda r: r.get("date", ""), reverse=True))


@bp.route("/api/admin/users/<user_id>/routes/<route_id>/fit", methods=["GET"])
@require_auth
@require_admin
def admin_get_user_route_fit(user_id: str, route_id: str):
    """Admin: eredeti FIT bináris letöltése."""
    route_id   = _safe_id(route_id)
    routes_dir = _user_routes_dir(user_id)
    fit_path   = os.path.join(routes_dir, f"{route_id}.fit")
    if not os.path.isfile(fit_path):
        abort(404, description="FIT fájl nem érhető el")
    with open(fit_path, "rb") as f:
        content = f.read()
    return content, 200, {
        "Content-Type": "application/vnd.ant.fit",
        "Content-Disposition": f'attachment; filename="{route_id}.fit"',
    }


@bp.route("/api/admin/users/<user_id>/routes/<route_id>", methods=["DELETE"])
@require_auth
@require_admin
def admin_delete_user_route(user_id: str, route_id: str):
    """Admin: adott user útvonalának törlése (GPX + FIT együtt)."""
    route_id   = _safe_id(route_id)
    routes_dir = _user_routes_dir(user_id)
    idx_path   = os.path.join(routes_dir, "index.json")
    gpx_path   = os.path.join(routes_dir, f"{route_id}.gpx")
    fit_path   = os.path.join(routes_dir, f"{route_id}.fit")
    if not os.path.isfile(gpx_path):
        abort(404, description="Útvonal nem található")
    os.remove(gpx_path)
    if os.path.isfile(fit_path):
        os.remove(fit_path)
    _save_index([r for r in _load_index(idx_path) if r.get("id") != route_id], idx_path)
    with _db() as conn:
        conn.execute("DELETE FROM routes WHERE id = ? AND user_id = ?", (route_id, user_id))
    return "", 204


@bp.route("/api/admin/users/<user_id>/routes/<route_id>/gpx", methods=["GET"])
@require_auth
@require_admin
def admin_get_user_route_gpx(user_id: str, route_id: str):
    """Admin: letölti egy user útvonalának GPX fájlját."""
    route_id   = _safe_id(route_id)
    routes_dir = _user_routes_dir(user_id)
    gpx_path   = os.path.join(routes_dir, f"{route_id}.gpx")
    if not os.path.isfile(gpx_path):
        abort(404, description="GPX fájl nem található")
    idx_path = os.path.join(routes_dir, "index.json")
    index    = _load_index(idx_path)
    entry    = next((r for r in index if r.get("id") == route_id), None)
    raw_name = entry["name"] if entry else route_id
    # fájlnév: ASCII-biztos, whitespace → underscore
    safe_name = re.sub(r"[^\w\-.]", "_", raw_name) or route_id
    with open(gpx_path, encoding="utf-8") as f:
        content = f.read()
    return content, 200, {
        "Content-Type": "application/gpx+xml; charset=utf-8",
        "Content-Disposition": f'attachment; filename="{safe_name}.gpx"',
    }


@bp.route("/api/admin/users/<user_id>/routes/<route_id>", methods=["PATCH"])
@require_auth
@require_admin
def admin_update_user_route(user_id: str, route_id: str):
    """Admin: módosítja egy user útvonalának metaadatait (name, type, description)."""
    route_id   = _safe_id(route_id)
    routes_dir = _user_routes_dir(user_id)
    idx_path   = os.path.join(routes_dir, "index.json")
    data  = request.get_json(silent=True) or {}
    index = _load_index(idx_path)
    entry = next((r for r in index if r.get("id") == route_id), None)
    if not entry:
        abort(404, description="Útvonal nem található")
    if "name"        in data: entry["name"]        = (data["name"] or "Névtelen").strip()
    if "type"        in data: entry["type"]        = data["type"]
    if "description" in data: entry["description"] = (data["description"] or "").strip()
    _save_index(index, idx_path)
    with _db() as conn:
        conn.execute(
            "UPDATE routes SET name=?, route_type=?, description=? WHERE id=? AND user_id=?",
            (entry.get("name"), entry.get("type"), entry.get("description"), route_id, user_id),
        )
    log.info("Admin frissítette: %s / %s", user_id, route_id)
    return jsonify(entry)


@bp.route("/api/admin/users/<user_id>/routes", methods=["POST"])
@require_auth
@require_admin
def admin_upload_user_route(user_id: str):
    """Admin: új GPX fájlt tölt fel egy usernek (JSON body, gpxContent mezővel)."""
    with _db() as conn:
        user = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
    if not user:
        abort(404, description="Felhasználó nem található")

    data        = request.get_json(silent=True) or {}
    name        = (data.get("name") or "Névtelen útvonal").strip()
    gpx_content = (data.get("gpxContent") or "").strip()
    fit_b64     = data.get("fitContent")
    distance    = data.get("distance")
    duration    = data.get("duration")
    elevation   = data.get("elevation")
    route_type  = data.get("type", "cycling")
    description = (data.get("description") or "").strip()

    if not gpx_content:
        abort(400, description="Hiányzó gpxContent mező")

    routes_dir = _user_routes_dir(user_id)
    idx_path   = os.path.join(routes_dir, "index.json")
    route_id   = uuid.uuid4().hex[:8]
    gpx_path   = os.path.join(routes_dir, f"{route_id}.gpx")
    fit_path   = os.path.join(routes_dir, f"{route_id}.fit")

    try:
        with open(gpx_path, "w", encoding="utf-8") as f:
            f.write(gpx_content)
    except OSError as exc:
        log.error("GPX írási hiba: %s", exc)
        abort(500, description="Fájl írási hiba")

    has_fit = False
    if fit_b64:
        try:
            import base64
            with open(fit_path, "wb") as f:
                f.write(base64.b64decode(fit_b64, validate=True))
            has_fit = True
        except (ValueError, OSError) as exc:
            log.warning("FIT írási hiba (%s): %s", route_id, exc)

    entry = {
        "id":          route_id,
        "name":        name,
        "date":        _now_date(),
        "distance":    round(distance, 1) if isinstance(distance, (int, float)) else None,
        "duration":    int(duration)      if isinstance(duration,  (int, float)) else None,
        "elevation":   int(elevation)     if isinstance(elevation, (int, float)) else None,
        "type":        route_type,
        "description": description,
        "has_fit":     has_fit,
    }
    index = _load_index(idx_path)
    index.append(entry)
    try:
        _save_index(index, idx_path)
    except OSError:
        os.remove(gpx_path)
        if has_fit: os.remove(fit_path)
        abort(500, description="Index írási hiba")

    with _db() as conn:
        conn.execute("""
            INSERT INTO routes
              (id, user_id, name, date, created_at, distance_m,
               duration_min, elevation_m, route_type, description, gpx_path)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """, (
            route_id, user_id, name, _now_date(), _now_dt(),
            distance * 1000 if isinstance(distance, (int, float)) else None,
            int(duration)   if isinstance(duration,  (int, float)) else None,
            int(elevation)  if isinstance(elevation, (int, float)) else None,
            route_type, description, gpx_path,
        ))

    log.info("Admin feltöltött: %s / %s (%s)", user_id, route_id, name)
    return jsonify(entry), 201


@bp.route("/api/admin/stats", methods=["GET"])
@require_auth
@require_admin
def admin_stats():
    with _db() as conn:
        total  = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        active = conn.execute("SELECT COUNT(*) FROM users WHERE active = 1").fetchone()[0]
        today  = conn.execute(
            "SELECT COUNT(*) FROM user_sessions WHERE logged_in_at >= ?", (_now_date(),)
        ).fetchone()[0]
    return jsonify({"total_users": total, "active_users": active, "logins_today": today})
