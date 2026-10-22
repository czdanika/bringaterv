"""Bringaterv API – admin végpontok (userek, user útvonalak, statisztika)."""

import os
import re
import uuid

from flask import Blueprint, abort, g, jsonify, request

import mail_templates
import mailer
import notify
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
                   quota_routes, quota_workouts, quota_mb,
                   contact_email, email_verified_at
            FROM users ORDER BY created_at DESC
        """).fetchall()
    result = []
    for r in rows:
        u = dict(r)
        u["stats"] = _user_storage_stats(u["id"])
        try:
            u["push_devices"] = len(notify.load(u["id"]).get("subscriptions") or [])
        except Exception:
            u["push_devices"] = 0
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

    # Értesítési e-mail-cím és megerősítés (admin kézzel is megerősítettnek jelölheti)
    has_contact = "contact_email" in data
    contact = (data.get("contact_email") or "").strip().lower() or None
    verified = data.get("email_verified")
    if has_contact and contact and ("@" not in contact or " " in contact or len(contact) > 120):
        abort(400, description="Érvénytelen e-mail-cím")

    if not updates and not new_email and not new_password and not has_contact and verified is None:
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

        # Jelszó hash – a felhasználó a többi eszközén kilép
        if new_password:
            updates["password_hash"] = _hash_pw(new_password)
            updates["pw_changed_at"] = _now_dt()

        cur = conn.execute("SELECT contact_email, email_verified_at FROM users WHERE id = ?", (user_id,)).fetchone()
        if has_contact and cur and contact != cur["contact_email"]:
            if contact and conn.execute("SELECT id FROM users WHERE (contact_email = ? OR email = ?) AND id != ?",
                                        (contact, contact, user_id)).fetchone():
                abort(409, description="Ez az e-mail-cím már egy másik fiókhoz tartozik")
            updates["contact_email"] = contact
            updates["email_verified_at"] = None
        if verified is not None:
            updates["email_verified_at"] = _now_dt() if verified and (contact or (cur and cur["contact_email"])) else None

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

        if updates:
            set_clause = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(f"UPDATE users SET {set_clause} WHERE id = ?",
                         [*updates.values(), user_id])
        row = conn.execute(
            "SELECT id, email, name, first_name, last_name, role, active, "
            "quota_routes, quota_workouts, quota_mb, contact_email, email_verified_at FROM users WHERE id = ?",
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


# ── Felhasználó törlése ───────────────────────────────────────────────────────

def purge_user(user_id: str) -> None:
    """Egy fiók és MINDEN adatának végleges törlése: adatbázis-sorok (útvonalak,
    edzések, belépések, tokenek), Strava webhook + hozzáférés visszavonása, a
    felhasználó mappája. A visszajelzések (feedback) megmaradnak – az admin látja őket."""
    import shutil
    from storage import _user_dir
    # Strava: webhook leiratkozás és hozzáférés visszavonása, amíg a beállítások még megvannak
    try:
        import strava_webhook
        strava_webhook.disable(user_id)
    except Exception as exc:
        log.warning("Strava webhook törléskor (%s): %s", user_id, exc)
    try:
        from strava_service import STRAVA_DEAUTH_URL, _load_user_strava
        tok = _load_user_strava(user_id).get("access_token")
        if tok:
            import requests
            requests.post(STRAVA_DEAUTH_URL, data={"access_token": tok}, timeout=10)
    except Exception as exc:
        log.warning("Strava deauth törléskor (%s): %s", user_id, exc)
    with _db() as conn:
        conn.execute("DELETE FROM workout_zones WHERE workout_id IN (SELECT id FROM workouts WHERE user_id = ?)", (user_id,))
        for table in ("workouts", "routes", "user_sessions", "auth_tokens"):
            conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    path = _user_dir(user_id)
    if os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)


@bp.route("/api/admin/users/<user_id>", methods=["DELETE"])
@require_auth
@require_admin
def admin_delete_user(user_id: str):
    """Fiók és MINDEN adatának végleges törlése (útvonalak, edzések, beállítások,
    Strava/Garmin kapcsolat). Biztonság: magadat és az utolsó admint nem lehet;
    a kliens az e-mail cím begépelésével erősít meg (confirm_email)."""
    # (a _safe_id az aláhúzást is kivenné – a user-azonosítók „u_…” alakúak)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", user_id):
        abort(404, description="Nincs ilyen felhasználó.")
    if user_id == g.user["id"]:
        abort(400, description="Saját magadat nem törölheted.")
    body = request.get_json(silent=True) or {}
    with _db() as conn:
        row = conn.execute("SELECT id, email, role FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            abort(404, description="Nincs ilyen felhasználó.")
        if (body.get("confirm_email") or "").strip().lower() != row["email"].lower():
            abort(400, description="A megerősítéshez a felhasználó e-mail címét / nevét kell beírni.")
        if row["role"] == "admin":
            admins = conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1").fetchone()[0]
            if admins <= 1:
                abort(400, description="Az utolsó admint nem lehet törölni.")
    purge_user(user_id)
    log.info("User törölve: %s (%s) – admin: %s", row["email"], user_id, g.user["email"])
    return jsonify({"ok": True})


# ── Meghívók (regisztrációs link) ─────────────────────────────────────────────

def _invite_public(r) -> dict:
    d = dict(r)
    now = _now_dt()
    if d["revoked"]:
        d["status"] = "revoked"
    elif d.get("expires_at") and d["expires_at"] < now:
        d["status"] = "expired"
    elif d["uses"] >= d["max_uses"]:
        d["status"] = "used"
    else:
        d["status"] = "active"
    return d


@bp.route("/api/admin/invites", methods=["GET"])
@require_auth
@require_admin
def admin_list_invites():
    with _db() as conn:
        rows = conn.execute("SELECT * FROM invites ORDER BY created_at DESC").fetchall()
    return jsonify([_invite_public(r) for r in rows])


def _send_invite_mail(row, inviter: str) -> None:
    """A meghívó levél kiküldése a meghívott címére (hiba esetén kivételt dob)."""
    import mail_templates
    import mailer
    from api_account import public_base
    link = f"{public_base()}/invite?t={row['token']}"
    months = ("január", "február", "március", "április", "május", "június", "július", "augusztus",
              "szeptember", "október", "november", "december")
    exp = row["expires_at"] or ""
    until = f"{months[int(exp[5:7]) - 1]} {int(exp[8:10])}" if len(exp) >= 10 else "a megadott időpont"
    who = inviter or "A Bringaterv csapata"
    intro = (f"Szia!\n\n{who} meghívott a Bringatervbe – útvonaltervező és edzésnapló egy helyen: "
             "megtervezed a túrát, utána visszanézed az edzést, és látod, hogyan fejlődsz.\n\n"
             "A regisztráció egy perc: a gombra kattintva add meg a neved és egy jelszót.")
    text = (f"{intro}\n\nRegisztráció: {link}\n\n"
            f"A meghívó {until}-ig érvényes, és csak egyszer használható. "
            "Ha nem számítottál rá, nyugodtan hagyd figyelmen kívül.\n\nBringaterv")
    mailer.send("Meghívó a Bringatervbe", text, to=[row["invited_email"]], html=mail_templates.render(
        "Meghívó a Bringatervbe", intro,
        button=("Regisztrálok", link),
        note=f"A meghívó {until}-ig érvényes, és csak egyszer használható. "
             "Ha nem számítottál rá, nyugodtan hagyd figyelmen kívül.",
        preheader=f"{who} meghívott a Bringatervbe"))


def _inviter_name(user_id: str) -> str:
    with _db() as conn:
        r = conn.execute("SELECT name FROM users WHERE id = ?", (user_id,)).fetchone()
    return (r["name"] if r else "") or ""


@bp.route("/api/admin/invites", methods=["POST"])
@require_auth
@require_admin
def admin_create_invite():
    """body: {role, days (1–90), max_uses (1–50), quota_routes?, note, email?, send?}
    Ha van e-mail-cím: a meghívó egyszer használható, és (send=true esetén) ki is küldjük."""
    import secrets
    from datetime import datetime, timedelta, timezone
    from api_account import EMAIL_RE
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    if email:
        if not EMAIL_RE.match(email) or len(email) > 120:
            abort(400, description="Érvénytelen e-mail-cím.")
        with _db() as conn:
            if conn.execute("SELECT id FROM users WHERE email = ? OR contact_email = ?", (email, email)).fetchone():
                abort(409, description="Ezzel az e-mail-címmel már van fiók.")
    role = body.get("role", "user")
    if role not in ("user", "readonly", "admin"):
        abort(400, description="Érvénytelen szerepkör")
    try:
        days = max(1, min(90, int(body.get("days", 7))))
        max_uses = 1 if email else max(1, min(50, int(body.get("max_uses", 1))))
        quota = int(body["quota_routes"]) if body.get("quota_routes") not in (None, "") else None
    except (TypeError, ValueError):
        abort(400, description="Érvénytelen szám")
    token = secrets.token_urlsafe(18)
    expires = (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with _db() as conn:
        conn.execute("""INSERT INTO invites (token, created_at, created_by, expires_at, max_uses, role, quota_routes, note,
                                             invited_email)
                        VALUES (?,?,?,?,?,?,?,?,?)""",
                     (token, _now_dt(), g.user["id"], expires, max_uses, role, quota, (body.get("note") or "").strip()[:200],
                      email))
        row = conn.execute("SELECT * FROM invites WHERE token = ?", (token,)).fetchone()
    log.info("Meghívó létrehozva (%s, %s nap, %sx%s) – admin: %s", role, days, max_uses,
             ", e-mailben" if email else "", g.user["email"])
    out = _invite_public(row)
    if email and body.get("send", True):
        out.update(_try_send_invite(row))
    return jsonify(out), 201


def _try_send_invite(row) -> dict:
    """Kiküldés + sent_at rögzítése; az eredményt a válaszba tesszük (a meghívó hiba esetén is megmarad)."""
    try:
        _send_invite_mail(row, _inviter_name(row["created_by"] or g.user["id"]))
    except Exception as exc:
        log.warning("Meghívó levél küldési hiba (%s): %s", row["invited_email"], exc)
        return {"mail_sent": False, "mail_error": str(exc)}
    with _db() as conn:
        conn.execute("UPDATE invites SET sent_at = ? WHERE token = ?", (_now_dt(), row["token"]))
    return {"mail_sent": True, "sent_at": _now_dt()}


@bp.route("/api/admin/invites/<token>/send", methods=["POST"])
@require_auth
@require_admin
def admin_send_invite(token: str):
    """E-mailes meghívó (újra)küldése – csak aktív, címhez kötött meghívónál."""
    with _db() as conn:
        row = conn.execute("SELECT * FROM invites WHERE token = ?", (token,)).fetchone()
    if not row:
        abort(404, description="Nincs ilyen meghívó.")
    if not row["invited_email"]:
        abort(400, description="Ehhez a meghívóhoz nincs e-mail-cím.")
    if _invite_public(row)["status"] != "active":
        abort(400, description="A meghívó már nem aktív.")
    res = _try_send_invite(row)
    if not res["mail_sent"]:
        abort(502, description=f"Nem sikerült elküldeni: {res['mail_error']}")
    return jsonify(res)


@bp.route("/api/admin/invites/<token>", methods=["DELETE"])
@require_auth
@require_admin
def admin_revoke_invite(token: str):
    with _db() as conn:
        conn.execute("UPDATE invites SET revoked = 1 WHERE token = ?", (token,))
    return jsonify({"ok": True})


# ── Üzenet a felhasználóknak (push és/vagy e-mail) ────────────────────────────

_GREETINGS = ("szia", "sziasztok", "helló", "hello", "hali", "kedves", "üdv", "jó napot", "tisztelt")


def _greeting(row, body: str) -> str:
    """„Szia Dániel!” – keresztnévvel; nincs, ha az üzenet maga is köszönéssel kezdődik."""
    if body.lstrip().lower().startswith(_GREETINGS):
        return ""
    first = (row["first_name"] or "").strip() or (row["name"] or "").strip().split(" ")[-1]
    return f"Szia {first}!\n\n" if first else "Szia!\n\n"


@bp.route("/api/admin/message", methods=["POST"])
@require_auth
@require_admin
def admin_message():
    """Push és/vagy e-mail egy, több vagy az összes aktív felhasználónak.
    body: {user_ids: [...] | "all", title, body, push: bool, email: bool}"""
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()[:120]
    body = (data.get("body") or "").strip()[:4000]
    want_push, want_email = bool(data.get("push")), bool(data.get("email"))
    if not title or not body:
        abort(400, description="Cím és üzenet kötelező.")
    if not want_push and not want_email:
        abort(400, description="Válassz legalább egy csatornát (push / e-mail).")
    if want_email and not mailer.status()["configured"]:
        abort(400, description="Az e-mail küldés nincs beállítva a szerveren.")
    ids = data.get("user_ids")
    with _db() as conn:
        if ids == "all":
            rows = conn.execute("SELECT id, name, first_name, contact_email FROM users WHERE active = 1").fetchall()
        elif isinstance(ids, list) and ids:
            ids = [str(i) for i in ids][:500]
            q = ",".join("?" * len(ids))
            rows = conn.execute(f"SELECT id, name, first_name, contact_email FROM users WHERE active = 1 AND id IN ({q})", ids).fetchall()
        else:
            abort(400, description="Nincs kiválasztott címzett.")
    if not rows:
        abort(400, description="Nincs aktív címzett.")

    base = (os.environ.get("PUBLIC_URL") or "").rstrip("/")
    tag = "admin-" + uuid.uuid4().hex[:6]
    res = {"recipients": len(rows), "push_users": 0, "push_devices": 0, "email_sent": 0,
           "email_missing": 0, "email_failed": 0, "errors": []}
    for r in rows:
        if want_push:
            try:
                n = notify.send(r["id"], "admin_message", title, body[:200], url="./index.html", tag=tag, force=True)
                res["push_devices"] += n
                res["push_users"] += 1 if n else 0
            except Exception as exc:
                log.warning("Admin push hiba (%s): %s", r["id"], exc)
        if want_email:
            if not r["contact_email"]:
                res["email_missing"] += 1
                continue
            try:
                greeting = _greeting(r, body)
                mailer.send(f"Bringaterv – {title}", f"{greeting}{body}\n\n{base or ''}\n\nBringaterv",
                            to=[r["contact_email"]],
                            html=mail_templates.render(title, greeting + body,
                                                       button=("Bringaterv megnyitása", base) if base else None))
                res["email_sent"] += 1
            except Exception as exc:
                res["email_failed"] += 1
                res["errors"].append(str(exc)[:160])
                log.warning("Admin e-mail hiba (%s): %s", r["id"], exc)
    res["errors"] = res["errors"][:3]
    log.info("Admin üzenet (%s): %s", g.user["email"], {k: v for k, v in res.items() if k != "errors"})
    return jsonify(res)
