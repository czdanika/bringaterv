"""
Bringaterv – Útvonaltár API  v2
================================
JWT autentikáció, per-user adatok, admin felület, kvótakezelés, SQLite statisztika.

Környezeti változók:
  DATA_DIR          (migráció miatt megőrizve, alapért.: /data/routes)
  SAMPLES_DIR       minta fájlok              (alapért.: /samples)
  DB_PATH           SQLite adatbázis          (alapért.: /data/bringaterv.db)
  MULTI_DATA_DIR    per-user mappák           (alapért.: /data/users)
  ADMIN_EMAIL       admin email               (alapért.: admin@bringaterv.local)
  ADMIN_PASSWORD    admin jelszó
  JWT_SECRET        JWT aláíró kulcs
  JWT_EXPIRY_DAYS   token élettartam napban   (alapért.: 30)

Végpontok:
  POST              /api/auth/login
  GET               /api/auth/me
  GET/PUT           /api/user/settings
  GET/POST          /api/routes
  GET/PATCH/DELETE  /api/routes/<id>
  GET               /api/samples
  GET               /api/samples/<id>
  GET               /api/health
  GET               /api/admin/users
  POST              /api/admin/users
  GET/PATCH         /api/admin/users/<id>
  POST              /api/admin/users/<id>/password
  GET               /api/admin/users/<id>/routes
  DELETE            /api/admin/users/<id>/routes/<rid>
  GET               /api/admin/stats
"""

import json
import logging
import os
import re
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import Flask, abort, g, jsonify, request
from flask_cors import CORS

# ── Konfiguráció ──────────────────────────────────────────────────────────────

DATA_DIR       = os.environ.get("DATA_DIR",       "/data/routes")   # migráció miatt
SAMPLES_DIR    = os.environ.get("SAMPLES_DIR",    "/samples")
DB_PATH        = os.environ.get("DB_PATH",        "/data/bringaterv.db")
MULTI_DATA_DIR = os.environ.get("MULTI_DATA_DIR", "/data/users")

ADMIN_EMAIL     = os.environ.get("ADMIN_EMAIL",    "admin@bringaterv.local")
ADMIN_PASSWORD  = os.environ.get("ADMIN_PASSWORD", "password123")
JWT_SECRET      = os.environ.get("JWT_SECRET",     "change-me-in-production")
JWT_EXPIRY_DAYS = int(os.environ.get("JWT_EXPIRY_DAYS", "30"))

# Single módos útvonalak helye (csak a v3 migrációhoz szükséges)
_LEGACY_USER_DIR   = os.path.join(DATA_DIR, "user")
_LEGACY_INDEX_FILE = os.path.join(DATA_DIR, "index.json")

try:
    import jwt as pyjwt
    import bcrypt
except ImportError as exc:
    raise ImportError(
        "PyJWT és bcrypt szükséges. Telepítsd: pip install PyJWT bcrypt"
    ) from exc

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Flask app ─────────────────────────────────────────────────────────────────

app = Flask(__name__)
CORS(app)

os.makedirs(_LEGACY_USER_DIR, exist_ok=True)


# ══════════════════════════════════════════════════════════════════════════════
# KÖZÖS SEGÉDFÜGGVÉNYEK
# ══════════════════════════════════════════════════════════════════════════════

def _safe_id(raw: str) -> str:
    """Path traversal védelem – csak alfanumerikus és kötőjel."""
    return re.sub(r"[^a-zA-Z0-9\-]", "", raw)


def _load_index(path: str) -> list:
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        log.error("Index olvasási hiba (%s): %s", path, exc)
        return []


def _save_index(index: list, path: str) -> None:
    tmp  = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError as exc:
        log.error("Index írási hiba (%s): %s", path, exc)
        raise


def _now_date() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _now_dt() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ══════════════════════════════════════════════════════════════════════════════
# MULTI MÓD – SQLite
# ══════════════════════════════════════════════════════════════════════════════

SCHEMA_VERSION = 5

_SCHEMA_SQL = """
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
    id              TEXT    PRIMARY KEY,
    email           TEXT    UNIQUE NOT NULL,
    name            TEXT    NOT NULL,
    first_name      TEXT    NOT NULL DEFAULT '',
    last_name       TEXT    NOT NULL DEFAULT '',
    password_hash   TEXT    NOT NULL,
    role            TEXT    NOT NULL DEFAULT 'user',
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL,
    last_login_at   TEXT,
    login_count     INTEGER NOT NULL DEFAULT 0,
    quota_routes    INTEGER NOT NULL DEFAULT 50,
    quota_workouts  INTEGER NOT NULL DEFAULT 200,
    quota_mb        INTEGER NOT NULL DEFAULT 100,
    settings        TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS user_sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT    NOT NULL,
    logged_in_at TEXT    NOT NULL,
    ip_address   TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS workouts (
    id           TEXT    PRIMARY KEY,
    user_id      TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    sport        TEXT    DEFAULT 'cycling',
    date         TEXT,
    created_at   TEXT    NOT NULL,
    duration_sec INTEGER,
    distance_m   REAL,
    elevation_m  REAL,
    avg_hr       INTEGER,
    max_hr       INTEGER,
    avg_speed    REAL,
    trimp        INTEGER,
    effort       INTEGER,
    gpx_path     TEXT,
    source       TEXT    DEFAULT 'gpx_upload',
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS workout_zones (
    workout_id   TEXT NOT NULL,
    zone_id      TEXT NOT NULL,
    duration_sec INTEGER,
    pct          REAL,
    PRIMARY KEY (workout_id, zone_id),
    FOREIGN KEY (workout_id) REFERENCES workouts(id)
);

CREATE TABLE IF NOT EXISTS routes (
    id           TEXT    PRIMARY KEY,
    user_id      TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    date         TEXT,
    created_at   TEXT    NOT NULL,
    distance_m   REAL,
    duration_min INTEGER,
    elevation_m  INTEGER,
    route_type   TEXT    DEFAULT 'cycling',
    description  TEXT,
    gpx_path     TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
"""


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _db_init() -> None:
    import fcntl
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    lock_path = DB_PATH + ".lock"
    with open(lock_path, "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            _db_init_locked()
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


def _db_init_locked() -> None:
    with _db() as conn:
        ver = conn.execute("PRAGMA user_version").fetchone()[0]
        if ver < 1:
            conn.executescript(_SCHEMA_SQL)
            conn.execute("PRAGMA user_version = 1")
            log.info("DB séma inicializálva (v1)")
        if ver < 2:
            # v2: settings oszlop hozzáadása (meglévő DB-khez)
            try:
                conn.execute("ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'")
            except Exception:
                pass  # már létezik
            conn.execute("PRAGMA user_version = 2")
            log.info("DB migrálva v2-re (settings oszlop)")
        count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if count == 0:
            uid = _db_create_user(conn, ADMIN_EMAIL, "Admin", ADMIN_PASSWORD, "admin")
            log.info("Admin user létrehozva: %s  (id: %s)", ADMIN_EMAIL, uid)
        if ver < 3:
            # v3: single-módos útvonalak átmigrálása az első admin userhez
            admin_row = conn.execute(
                "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if admin_row:
                _migrate_single_routes_to_user(admin_row["id"])
            conn.execute("PRAGMA user_version = 3")
            log.info("DB migrálva v3-ra (single-route migráció)")
        if ver < 4:
            # v4: kereszt- és vezetéknév oszlopok
            for col in ("first_name TEXT NOT NULL DEFAULT ''",
                        "last_name  TEXT NOT NULL DEFAULT ''"):
                try:
                    conn.execute(f"ALTER TABLE users ADD COLUMN {col}")
                except Exception:
                    pass  # már létezik
            conn.execute("PRAGMA user_version = 4")
            log.info("DB migrálva v4-re (first_name, last_name oszlopok)")
        if ver < 5:
            # v5: meglévő userek name mezőjének javítása: vezetéknév + keresztnév sorrend
            conn.execute("""
                UPDATE users
                SET name = TRIM(last_name || ' ' || first_name)
                WHERE first_name != '' AND last_name != ''
            """)
            conn.execute("PRAGMA user_version = 5")
            log.info("DB migrálva v5-re (névsorend javítás)")


def _user_dir(user_id: str) -> str:
    return os.path.join(MULTI_DATA_DIR, user_id)


def _user_routes_dir(user_id: str) -> str:
    d = os.path.join(_user_dir(user_id), "routes")
    os.makedirs(d, exist_ok=True)
    return d


def _db_create_user(conn, email: str, name: str, password: str, role: str = "user",
                    first_name: str = "", last_name: str = "") -> str:
    uid = "u_" + uuid.uuid4().hex[:8]
    first_name = first_name.strip()
    last_name  = last_name.strip()
    # Ha van kereszt+vezték, az adja a display nevet; különben a name paramétert használjuk
    display = f"{last_name} {first_name}".strip() or name.strip() or email.split("@")[0]
    conn.execute(
        "INSERT INTO users (id, email, name, first_name, last_name, password_hash, role, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (uid, email.strip().lower(), display, first_name, last_name,
         _hash_pw(password), role, _now_dt()),
    )
    os.makedirs(_user_routes_dir(uid), exist_ok=True)
    os.makedirs(os.path.join(_user_dir(uid), "workouts"), exist_ok=True)
    return uid


def _migrate_single_routes_to_user(user_id: str) -> None:
    """Régi single-módos útvonalakat átmásolja az admin user mappájába (egyszeri migráció)."""
    import shutil
    src_index = _LEGACY_INDEX_FILE
    src_dir   = _LEGACY_USER_DIR
    if not os.path.isfile(src_index):
        log.info("Migráció: nincs single-módos index, kihagyva.")
        return
    dst_dir   = _user_routes_dir(user_id)
    dst_index = os.path.join(dst_dir, "index.json")
    if os.path.isfile(dst_index):
        log.info("Migráció: admin user már rendelkezik index.json-nal, kihagyva.")
        return
    # index.json másolása
    shutil.copy2(src_index, dst_index)
    # GPX fájlok másolása
    migrated = 0
    if os.path.isdir(src_dir):
        for fn in os.listdir(src_dir):
            if fn.endswith(".gpx"):
                shutil.copy2(os.path.join(src_dir, fn), os.path.join(dst_dir, fn))
                migrated += 1
    log.info("Migráció kész: %d GPX + index.json → user %s", migrated, user_id)


def _user_storage_stats(user_id: str) -> dict:
    base = _user_dir(user_id)
    routes_dir   = os.path.join(base, "routes")
    workouts_dir = os.path.join(base, "workouts")
    routes = workouts = total_bytes = 0
    for folder, key in [(routes_dir, "routes"), (workouts_dir, "workouts")]:
        if os.path.isdir(folder):
            for fn in os.listdir(folder):
                fp = os.path.join(folder, fn)
                if os.path.isfile(fp):
                    total_bytes += os.path.getsize(fp)
                    if fn.endswith(".gpx"):
                        if key == "routes":
                            routes += 1
                        else:
                            workouts += 1
    return {
        "routes":        routes,
        "workouts":      workouts,
        "storage_mb":    round(total_bytes / 1_048_576, 2),
        "storage_bytes": total_bytes,
    }


# ── Jelszó + JWT ──────────────────────────────────────────────────────────────

def _hash_pw(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def _check_pw(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def _make_token(user_id: str, email: str, role: str) -> str:
    return pyjwt.encode(
        {
            "sub":   user_id,
            "email": email,
            "role":  role,
            "iat":   datetime.now(timezone.utc),
            "exp":   datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRY_DAYS),
        },
        JWT_SECRET,
        algorithm="HS256",
    )


def _decode_token(token: str) -> dict:
    return pyjwt.decode(token, JWT_SECRET, algorithms=["HS256"])


# ── Auth dekorátorok ──────────────────────────────────────────────────────────

def require_auth(f):
    """JWT ellenőrzés."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            abort(401, description="Hiányzó token")
        try:
            payload = _decode_token(header[7:])
        except pyjwt.ExpiredSignatureError:
            abort(401, description="Lejárt token")
        except pyjwt.InvalidTokenError:
            abort(401, description="Érvénytelen token")
        with _db() as conn:
            user = conn.execute(
                "SELECT * FROM users WHERE id = ? AND active = 1", (payload["sub"],)
            ).fetchone()
        if not user:
            abort(401, description="Ismeretlen vagy tiltott felhasználó")
        g.user = dict(user)
        return f(*args, **kwargs)
    return wrapper


def require_admin(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if g.user.get("role") != "admin":
            abort(403, description="Admin jogkör szükséges")
        return f(*args, **kwargs)
    return wrapper


def _resolve_dirs():
    """Felhasználó-specifikus útvonal mappa."""
    d = _user_routes_dir(g.user["id"])
    return d, os.path.join(d, "index.json")


# ══════════════════════════════════════════════════════════════════════════════
# AUTH VÉGPONTOK
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/auth/login", methods=["POST"])
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


@app.route("/api/auth/me", methods=["GET"])
@require_auth
def auth_me():
    u = g.user
    return jsonify({"id": u["id"], "email": u["email"],
                    "name": u["name"], "role": u["role"]})


@app.route("/api/user/settings", methods=["GET"])
@require_auth
def get_user_settings():
    """Felhasználó személyes beállításainak lekérése."""
    raw = g.user.get("settings") or "{}"
    try:
        return jsonify(json.loads(raw))
    except (json.JSONDecodeError, TypeError):
        return jsonify({})


@app.route("/api/user/settings", methods=["PUT"])
@require_auth
def put_user_settings():
    """Felhasználó személyes beállításainak mentése."""
    data = request.get_json(silent=True)
    if data is None:
        abort(400, description="Hiányzó JSON body")
    # Csak ismert kulcsokat engedünk tárolni
    allowed = {"hrZones", "mapStyle", "unit", "startView", "theme",
               "snapToRoads", "showStageInfo", "gpxSampleWaypoints",
               "toolbarOrder", "toolbarHidden"}
    filtered = {k: v for k, v in data.items() if k in allowed}
    with _db() as conn:
        conn.execute(
            "UPDATE users SET settings = ? WHERE id = ?",
            (json.dumps(filtered, ensure_ascii=False), g.user["id"])
        )
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
# ADMIN VÉGPONTOK
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/admin/users", methods=["GET"])
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


@app.route("/api/admin/users", methods=["POST"])
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


@app.route("/api/admin/users/<user_id>", methods=["GET"])
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


@app.route("/api/admin/users/<user_id>", methods=["PATCH"])
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


@app.route("/api/admin/users/<user_id>/password", methods=["POST"])
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


@app.route("/api/admin/users/<user_id>/routes", methods=["GET"])
@require_auth
@require_admin
def admin_list_user_routes(user_id: str):
    """Admin: adott user útvonalainak listája."""
    routes_dir = _user_routes_dir(user_id)
    idx_path   = os.path.join(routes_dir, "index.json")
    routes     = _load_index(idx_path)
    # GPX fájlméret hozzáadása
    for r in routes:
        gpx = os.path.join(routes_dir, f"{r['id']}.gpx")
        r["size_kb"] = round(os.path.getsize(gpx) / 1024, 1) if os.path.isfile(gpx) else 0
    return jsonify(sorted(routes, key=lambda r: r.get("date", ""), reverse=True))


@app.route("/api/admin/users/<user_id>/routes/<route_id>", methods=["DELETE"])
@require_auth
@require_admin
def admin_delete_user_route(user_id: str, route_id: str):
    """Admin: adott user útvonalának törlése."""
    route_id   = _safe_id(route_id)
    routes_dir = _user_routes_dir(user_id)
    idx_path   = os.path.join(routes_dir, "index.json")
    gpx_path   = os.path.join(routes_dir, f"{route_id}.gpx")
    if not os.path.isfile(gpx_path):
        abort(404, description="Útvonal nem található")
    os.remove(gpx_path)
    _save_index([r for r in _load_index(idx_path) if r.get("id") != route_id], idx_path)
    with _db() as conn:
        conn.execute("DELETE FROM routes WHERE id = ? AND user_id = ?", (route_id, user_id))
    return "", 204


@app.route("/api/admin/stats", methods=["GET"])
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


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES VÉGPONTOK
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/routes", methods=["GET"])
@require_auth
def list_routes():
    _, idx = _resolve_dirs()
    return jsonify(sorted(_load_index(idx), key=lambda r: r.get("date", ""), reverse=True))


@app.route("/api/routes", methods=["POST"])
@require_auth
def save_route():
    user_dir, idx = _resolve_dirs()
    data = request.get_json(silent=True)
    if not data:
        abort(400, description="Hiányzó JSON body")

    name        = (data.get("name") or "Névtelen útvonal").strip()
    gpx_content = data.get("gpxContent", "").strip()
    distance    = data.get("distance")
    duration    = data.get("duration")
    elevation   = data.get("elevation")
    route_type  = data.get("type", "cycling")
    description = (data.get("description") or "").strip()

    if not gpx_content:
        abort(400, description="Hiányzó gpxContent mező")

    index = _load_index(idx)
    if len(index) >= g.user.get("quota_routes", 50):
        abort(429, description=f"Útvonal kvóta elérve ({g.user['quota_routes']} db)")

    route_id = uuid.uuid4().hex[:8]
    gpx_path = os.path.join(user_dir, f"{route_id}.gpx")
    try:
        with open(gpx_path, "w", encoding="utf-8") as f:
            f.write(gpx_content)
    except OSError as exc:
        log.error("GPX írási hiba: %s", exc)
        abort(500, description="Fájl írási hiba")

    entry = {
        "id":          route_id,
        "name":        name,
        "date":        _now_date(),
        "distance":    round(distance, 1) if isinstance(distance, (int, float)) else None,
        "duration":    int(duration)      if isinstance(duration,  (int, float)) else None,
        "elevation":   int(elevation)     if isinstance(elevation, (int, float)) else None,
        "type":        route_type,
        "description": description,
    }
    index = _load_index(idx)
    index.append(entry)
    try:
        _save_index(index, idx)
    except OSError:
        os.remove(gpx_path)
        abort(500, description="Index írási hiba")

    with _db() as conn:
        conn.execute("""
            INSERT INTO routes
              (id, user_id, name, date, created_at, distance_m,
               duration_min, elevation_m, route_type, description, gpx_path)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """, (
            route_id, g.user["id"], name, _now_date(), _now_dt(),
            distance * 1000 if isinstance(distance, (int, float)) else None,
            int(duration)   if isinstance(duration,  (int, float)) else None,
            int(elevation)  if isinstance(elevation, (int, float)) else None,
            route_type, description, gpx_path,
        ))

    log.info("Új útvonal: %s (%s)", route_id, name)
    return jsonify({"id": route_id}), 201


@app.route("/api/routes/<route_id>", methods=["GET"])
@require_auth
def get_route(route_id: str):
    route_id = _safe_id(route_id)
    user_dir, _ = _resolve_dirs()
    gpx_path = os.path.join(user_dir, f"{route_id}.gpx")
    if not os.path.isfile(gpx_path):
        abort(404, description=f"Útvonal nem található: {route_id}")
    try:
        with open(gpx_path, encoding="utf-8") as f:
            content = f.read()
    except OSError as exc:
        log.error("GPX olvasási hiba: %s", exc)
        abort(500)
    return content, 200, {"Content-Type": "application/gpx+xml; charset=utf-8"}


@app.route("/api/routes/<route_id>", methods=["PATCH"])
@require_auth
def update_route(route_id: str):
    route_id = _safe_id(route_id)
    _, idx   = _resolve_dirs()
    data     = request.get_json(silent=True) or {}
    index    = _load_index(idx)
    entry    = next((r for r in index if r.get("id") == route_id), None)
    if not entry:
        abort(404, description=f"Útvonal nem található: {route_id}")
    if "name"        in data: entry["name"]        = (data["name"] or "Névtelen").strip()
    if "type"        in data: entry["type"]        = data["type"]
    if "description" in data: entry["description"] = (data["description"] or "").strip()
    try:
        _save_index(index, idx)
    except OSError:
        abort(500)
    return jsonify(entry)


@app.route("/api/routes/<route_id>", methods=["DELETE"])
@require_auth
def delete_route(route_id: str):
    route_id      = _safe_id(route_id)
    user_dir, idx = _resolve_dirs()
    gpx_path      = os.path.join(user_dir, f"{route_id}.gpx")
    if not os.path.isfile(gpx_path):
        abort(404, description=f"Útvonal nem található: {route_id}")
    try:
        os.remove(gpx_path)
    except OSError as exc:
        log.error("GPX törlési hiba: %s", exc)
        abort(500)
    _save_index([r for r in _load_index(idx) if r.get("id") != route_id], idx)
    with _db() as conn:
        conn.execute("DELETE FROM routes WHERE id = ? AND user_id = ?",
                     (route_id, g.user["id"]))
    return "", 204


# ══════════════════════════════════════════════════════════════════════════════
# MINTA ÚTVONALAK
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/samples", methods=["GET"])
def list_samples():
    if not os.path.isdir(SAMPLES_DIR):
        return jsonify([])
    samples = []
    for fn in sorted(os.listdir(SAMPLES_DIR)):
        if not fn.endswith(".gpx"):
            continue
        sid  = fn[:-4]
        meta = {}
        mp   = os.path.join(SAMPLES_DIR, f"{sid}.json")
        if os.path.isfile(mp):
            try:
                with open(mp, encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception:
                pass
        samples.append({
            "id":          sid,
            "name":        meta.get("name", sid.replace("-", " ").title()),
            "distance":    meta.get("distance"),
            "duration":    meta.get("duration"),
            "elevation":   meta.get("elevation"),
            "type":        meta.get("type", "cycling"),
            "description": meta.get("description", ""),
        })
    return jsonify(samples)


@app.route("/api/samples/<sample_id>", methods=["GET"])
def get_sample(sample_id: str):
    sample_id = _safe_id(sample_id)
    gpx_path  = os.path.join(SAMPLES_DIR, f"{sample_id}.gpx")
    if not os.path.isfile(gpx_path):
        abort(404, description=f"Minta nem található: {sample_id}")
    try:
        with open(gpx_path, encoding="utf-8") as f:
            content = f.read()
    except OSError:
        abort(500)
    return content, 200, {"Content-Type": "application/gpx+xml; charset=utf-8"}


# ══════════════════════════════════════════════════════════════════════════════
# HEALTH CHECK
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/health", methods=["GET"])
def health():
    sample_count = (
        sum(1 for f in os.listdir(SAMPLES_DIR) if f.endswith(".gpx"))
        if os.path.isdir(SAMPLES_DIR) else 0
    )
    with _db() as conn:
        active_users = conn.execute(
            "SELECT COUNT(*) FROM users WHERE active = 1"
        ).fetchone()[0]
    return jsonify({"status": "ok", "samples": sample_count, "active_users": active_users})


# ══════════════════════════════════════════════════════════════════════════════
# HIBAKEZELÉS
# ══════════════════════════════════════════════════════════════════════════════

@app.errorhandler(400)
@app.errorhandler(401)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(409)
@app.errorhandler(429)
@app.errorhandler(500)
def json_error(e):
    return jsonify({"error": e.description}), e.code


# ══════════════════════════════════════════════════════════════════════════════
# INDÍTÁS
# ══════════════════════════════════════════════════════════════════════════════

with app.app_context():
    _db_init()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=False)
