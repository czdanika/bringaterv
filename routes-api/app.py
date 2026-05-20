"""
Bringaterv – Útvonaltár API  v2
================================
APP_MODE=single  →  Egyfelhasználós mód. Nincs auth, minden adat közös.
                     Teljes visszafelé kompatibilitás az eredeti API-val.
APP_MODE=multi   →  Többfelhasználós mód. JWT auth, per-user adatok,
                     admin felület, kvótakezelés, SQLite statisztika.

Környezeti változók:
  APP_MODE          single | multi            (alapért.: single)
  DATA_DIR          felhasználói adatok       (alapért.: /data/routes)
  SAMPLES_DIR       minta fájlok              (alapért.: /samples)
  DB_PATH           SQLite adatbázis          (alapért.: /data/bringaterv.db)
  MULTI_DATA_DIR    multi mód user mappák     (alapért.: /data/users)
  ADMIN_EMAIL       admin email               (alapért.: admin@bringaterv.local)
  ADMIN_PASSWORD    admin jelszó              (kötelező multi módban)
  JWT_SECRET        JWT aláíró kulcs          (kötelező multi módban)
  JWT_EXPIRY_DAYS   token élettartam napban   (alapért.: 30)

single mód végpontok (változatlan):
  GET/POST          /api/routes
  GET/PATCH/DELETE  /api/routes/<id>
  GET               /api/samples
  GET               /api/samples/<id>
  GET               /api/health

multi mód extra végpontok:
  POST  /api/auth/login
  GET   /api/auth/me
  GET   /api/admin/users
  POST  /api/admin/users
  GET   /api/admin/users/<id>
  PATCH /api/admin/users/<id>
  POST  /api/admin/users/<id>/password
  GET   /api/admin/stats
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

APP_MODE       = os.environ.get("APP_MODE", "single").lower()
IS_MULTI       = APP_MODE == "multi"

DATA_DIR       = os.environ.get("DATA_DIR",       "/data/routes")
SAMPLES_DIR    = os.environ.get("SAMPLES_DIR",    "/samples")
DB_PATH        = os.environ.get("DB_PATH",        "/data/bringaterv.db")
MULTI_DATA_DIR = os.environ.get("MULTI_DATA_DIR", "/data/users")

ADMIN_EMAIL     = os.environ.get("ADMIN_EMAIL",    "admin@bringaterv.local")
ADMIN_PASSWORD  = os.environ.get("ADMIN_PASSWORD", "password123")
JWT_SECRET      = os.environ.get("JWT_SECRET",     "change-me-in-production")
JWT_EXPIRY_DAYS = int(os.environ.get("JWT_EXPIRY_DAYS", "30"))

# single mód fix útvonalak (változatlan)
USER_DIR   = os.path.join(DATA_DIR, "user")
INDEX_FILE = os.path.join(DATA_DIR, "index.json")

# Multi módhoz szükséges csomagok
if IS_MULTI:
    try:
        import jwt as pyjwt
        import bcrypt
    except ImportError as exc:
        raise ImportError(
            "Multi módhoz PyJWT és bcrypt szükséges. "
            "Telepítsd: pip install PyJWT bcrypt"
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

log.info("APP_MODE: %s", APP_MODE)
os.makedirs(USER_DIR, exist_ok=True)


# ══════════════════════════════════════════════════════════════════════════════
# KÖZÖS SEGÉDFÜGGVÉNYEK
# ══════════════════════════════════════════════════════════════════════════════

def _safe_id(raw: str) -> str:
    """Path traversal védelem – csak alfanumerikus és kötőjel."""
    return re.sub(r"[^a-zA-Z0-9\-]", "", raw)


def _load_index(path=None) -> list:
    path = path or INDEX_FILE
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        log.error("Index olvasási hiba (%s): %s", path, exc)
        return []


def _save_index(index: list, path=None) -> None:
    path = path or INDEX_FILE
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

SCHEMA_VERSION = 1

_SCHEMA_SQL = """
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
    id              TEXT    PRIMARY KEY,
    email           TEXT    UNIQUE NOT NULL,
    name            TEXT    NOT NULL,
    password_hash   TEXT    NOT NULL,
    role            TEXT    NOT NULL DEFAULT 'user',
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL,
    last_login_at   TEXT,
    login_count     INTEGER NOT NULL DEFAULT 0,
    quota_routes    INTEGER NOT NULL DEFAULT 50,
    quota_workouts  INTEGER NOT NULL DEFAULT 200,
    quota_mb        INTEGER NOT NULL DEFAULT 100
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
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with _db() as conn:
        ver = conn.execute("PRAGMA user_version").fetchone()[0]
        if ver < SCHEMA_VERSION:
            conn.executescript(_SCHEMA_SQL)
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            log.info("DB séma inicializálva (v%d)", SCHEMA_VERSION)
        count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if count == 0:
            _db_create_user(conn, ADMIN_EMAIL, "Admin", ADMIN_PASSWORD, "admin")
            log.info("Admin user létrehozva: %s", ADMIN_EMAIL)


def _user_dir(user_id: str) -> str:
    return os.path.join(MULTI_DATA_DIR, user_id)


def _user_routes_dir(user_id: str) -> str:
    d = os.path.join(_user_dir(user_id), "routes")
    os.makedirs(d, exist_ok=True)
    return d


def _db_create_user(conn, email: str, name: str, password: str, role: str = "user") -> str:
    uid = "u_" + uuid.uuid4().hex[:8]
    conn.execute(
        "INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)",
        (uid, email.strip().lower(),
         name.strip() or email.split("@")[0],
         _hash_pw(password), role, _now_dt()),
    )
    os.makedirs(_user_routes_dir(uid), exist_ok=True)
    os.makedirs(os.path.join(_user_dir(uid), "workouts"), exist_ok=True)
    return uid


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
    """JWT ellenőrzés. Single módban mindig átengedi a kérést (g.user = None)."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not IS_MULTI:
            g.user = None
            return f(*args, **kwargs)
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
        if IS_MULTI and g.user.get("role") != "admin":
            abort(403, description="Admin jogkör szükséges")
        return f(*args, **kwargs)
    return wrapper


def _resolve_dirs():
    """Single: közös mappa. Multi: user-specifikus mappa."""
    if not IS_MULTI:
        return USER_DIR, INDEX_FILE
    d = _user_routes_dir(g.user["id"])
    return d, os.path.join(d, "index.json")


# ══════════════════════════════════════════════════════════════════════════════
# AUTH VÉGPONTOK
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    if not IS_MULTI:
        abort(404)
    data     = request.get_json(silent=True) or {}
    email    = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not email or not password:
        abort(400, description="Email és jelszó kötelező")
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
    if not IS_MULTI:
        return jsonify({"mode": "single"})
    u = g.user
    return jsonify({"id": u["id"], "email": u["email"],
                    "name": u["name"], "role": u["role"]})


# ══════════════════════════════════════════════════════════════════════════════
# ADMIN VÉGPONTOK
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/admin/users", methods=["GET"])
@require_auth
@require_admin
def admin_list_users():
    with _db() as conn:
        rows = conn.execute("""
            SELECT id, email, name, role, active, created_at,
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
    data     = request.get_json(silent=True) or {}
    email    = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    name     = (data.get("name") or email.split("@")[0]).strip()
    role     = data.get("role", "user")
    if not email or not password:
        abort(400, description="Email és jelszó kötelező")
    if len(password) < 6:
        abort(400, description="A jelszó legalább 6 karakter legyen")
    if role not in ("admin", "user", "readonly"):
        abort(400, description="Érvénytelen szerepkör: admin | user | readonly")
    with _db() as conn:
        if conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone():
            abort(409, description="Ez az email már regisztrált")
        uid = _db_create_user(conn, email, name, password, role)
    log.info("Új user: %s [%s]  (admin: %s)", email, role, g.user["email"])
    return jsonify({"id": uid, "email": email, "name": name, "role": role}), 201


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
    allowed = {"name", "role", "active", "quota_routes", "quota_workouts", "quota_mb"}
    updates = {k: v for k, v in data.items() if k in allowed}
    if not updates:
        abort(400, description="Nincs módosítható mező")
    if user_id == g.user["id"] and "active" in updates and not updates["active"]:
        abort(400, description="Saját magad nem tilthatod le")
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    with _db() as conn:
        conn.execute(f"UPDATE users SET {set_clause} WHERE id = ?",
                     [*updates.values(), user_id])
        row = conn.execute(
            "SELECT id, email, name, role, active, "
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
    return jsonify({"mode": APP_MODE, "total_users": total,
                    "active_users": active, "logins_today": today})


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES VÉGPONTOK  (single + multi – közös logika)
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

    if IS_MULTI:
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

    if IS_MULTI:
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
    if IS_MULTI:
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
    index        = _load_index()
    sample_count = (
        sum(1 for f in os.listdir(SAMPLES_DIR) if f.endswith(".gpx"))
        if os.path.isdir(SAMPLES_DIR) else 0
    )
    result = {"status": "ok", "mode": APP_MODE,
              "user_routes": len(index), "samples": sample_count}
    if IS_MULTI:
        with _db() as conn:
            result["active_users"] = conn.execute(
                "SELECT COUNT(*) FROM users WHERE active = 1"
            ).fetchone()[0]
    return jsonify(result)


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

if IS_MULTI:
    with app.app_context():
        _db_init()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=False)
