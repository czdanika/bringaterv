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

import io
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import time
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from functools import wraps
from urllib.parse import urlencode

import requests

from flask import Flask, abort, g, jsonify, request, send_file
from flask_cors import CORS

# ── Konfiguráció ──────────────────────────────────────────────────────────────

DATA_DIR            = os.environ.get("DATA_DIR",            "/data/routes")   # migráció miatt
SAMPLES_DIR         = os.environ.get("SAMPLES_DIR",         "/samples")
CUSTOM_SAMPLES_DIR  = os.environ.get("CUSTOM_SAMPLES_DIR",  "/data/samples")
DB_PATH             = os.environ.get("DB_PATH",             "/data/bringaterv.db")
MULTI_DATA_DIR      = os.environ.get("MULTI_DATA_DIR",      "/data/users")
STRAVA_APP_CONFIG   = os.environ.get("STRAVA_APP_CONFIG",   "/data/strava_app_config.json")
STRAVA_REDIRECT_URI = os.environ.get("STRAVA_REDIRECT_URI", "")  # ha üres, request-ből derivelődik

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

SCHEMA_VERSION = 6

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
        if ver < 6:
            # v6: meglévő users.settings JSON oszlopot átköltöztetjük per-user settings.json fájlokba
            rows = conn.execute(
                "SELECT id, settings FROM users WHERE settings IS NOT NULL AND settings != '' AND settings != '{}'"
            ).fetchall()
            migrated = 0
            for r in rows:
                try:
                    parsed = json.loads(r["settings"])
                    if isinstance(parsed, dict) and parsed:
                        _save_user_settings_file(r["id"], parsed)
                        migrated += 1
                except (json.JSONDecodeError, OSError):
                    pass
            conn.execute("PRAGMA user_version = 6")
            log.info("DB migrálva v6-ra (settings → per-user JSON fájlok, %d user)", migrated)


def _user_dir(user_id: str) -> str:
    return os.path.join(MULTI_DATA_DIR, user_id)


def _user_routes_dir(user_id: str) -> str:
    d = os.path.join(_user_dir(user_id), "routes")
    os.makedirs(d, exist_ok=True)
    return d


# ── Per-user settings.json ────────────────────────────────────────────────────

def _user_settings_path(user_id: str) -> str:
    """Útvonal: /data/users/<uid>/settings.json"""
    return os.path.join(_user_dir(user_id), "settings.json")


def _load_user_settings_file(user_id: str) -> dict:
    """Betölti a user settings.json fájlját. Hiányzó/hibás fájl esetén üres dict."""
    path = _user_settings_path(user_id)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("Settings olvasási hiba (%s): %s", path, exc)
        return {}


def _save_user_settings_file(user_id: str, settings: dict) -> None:
    """Atomikus write: tmp + rename. Létrehozza a user mappát is ha kell."""
    os.makedirs(_user_dir(user_id), exist_ok=True)
    path = _user_settings_path(user_id)
    tmp  = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(settings, f, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(tmp, path)


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


@app.route("/api/user/settings", methods=["GET"])
@require_auth
def get_user_settings():
    """Felhasználó személyes beállításainak lekérése (per-user settings.json)."""
    return jsonify(_load_user_settings_file(g.user["id"]))


@app.route("/api/user/settings", methods=["PUT"])
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


@app.route("/api/admin/users/<user_id>/routes/<route_id>/fit", methods=["GET"])
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


@app.route("/api/admin/users/<user_id>/routes/<route_id>", methods=["DELETE"])
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


@app.route("/api/admin/users/<user_id>/routes/<route_id>/gpx", methods=["GET"])
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


@app.route("/api/admin/users/<user_id>/routes/<route_id>", methods=["PATCH"])
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


@app.route("/api/admin/users/<user_id>/routes", methods=["POST"])
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


# GPX trackpont regex (lat előbb – a saját és importált GPX-ek így állnak elő)
_TRKPT_RE = re.compile(r'<(?:trkpt|rtept)\b[^>]*\blat="([-\d.]+)"[^>]*\blon="([-\d.]+)"')


def _extract_track_points(gpx_path: str, every: int = 8, max_points: int = 300) -> list:
    """Egyszerűsített [lat, lon] lista egy GPX-ből (hőtérképhez – ritkított)."""
    try:
        with open(gpx_path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return []
    pts = []
    for i, m in enumerate(_TRKPT_RE.finditer(text)):
        if i % every:
            continue
        try:
            pts.append([round(float(m.group(1)), 5), round(float(m.group(2)), 5)])
        except ValueError:
            continue
    if len(pts) > max_points:
        step = len(pts) // max_points + 1
        pts = pts[::step]
    return pts


@app.route("/api/routes/geometry-bulk", methods=["GET"])
@require_auth
def routes_geometry_bulk():
    """Az összes saját útvonal/edzés egyszerűsített geometriája egyetlen válaszban.
    A hőtérkép használja – így nem kell fájlonként külön HTTP-kérés."""
    user_dir, idx = _resolve_dirs()
    index = _load_index(idx)
    out = []
    for entry in index:
        rid = entry.get("id")
        if not rid:
            continue
        gpx_path = os.path.join(user_dir, f"{rid}.gpx")
        if not os.path.isfile(gpx_path):
            continue
        pts = _extract_track_points(gpx_path)
        if len(pts) < 2:
            continue
        out.append({
            "id":       rid,
            "name":     entry.get("name") or "",
            "sport":    entry.get("sport_type") or entry.get("type") or "cycling",
            "distance": entry.get("distance"),
            "date":     entry.get("date"),
            "points":   pts,
        })
    return jsonify({"tracks": out})


@app.route("/api/routes", methods=["POST"])
@require_auth
def save_route():
    user_dir, idx = _resolve_dirs()
    data = request.get_json(silent=True)
    if not data:
        abort(400, description="Hiányzó JSON body")

    name        = (data.get("name") or "Névtelen útvonal").strip()
    gpx_content = data.get("gpxContent", "").strip()
    fit_b64     = data.get("fitContent")     # opcionális base64-kódolt FIT binary
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
    fit_path = os.path.join(user_dir, f"{route_id}.fit")
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
            fit_bytes = base64.b64decode(fit_b64, validate=True)
            with open(fit_path, "wb") as f:
                f.write(fit_bytes)
            has_fit = True
        except (ValueError, OSError) as exc:
            log.warning("FIT írási hiba (%s): %s – GPX megmarad, FIT kihagyva", route_id, exc)

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
    index = _load_index(idx)
    index.append(entry)
    try:
        _save_index(index, idx)
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
    if "include_in_stats" in data: entry["include_in_stats"] = bool(data["include_in_stats"])
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
    fit_path      = os.path.join(user_dir, f"{route_id}.fit")
    if not os.path.isfile(gpx_path):
        abort(404, description=f"Útvonal nem található: {route_id}")
    # Strava-os importnál → deny-listbe (hogy ne kerüljön re-importra a következő sync-en)
    existing = _load_index(idx)
    deleted_entry = next((r for r in existing if r.get("id") == route_id), None)
    if deleted_entry and deleted_entry.get("strava_id"):
        try: _add_strava_deny(g.user["id"], deleted_entry["strava_id"])
        except Exception as exc: log.warning("Strava deny-list update hiba: %s", exc)
    try:
        os.remove(gpx_path)
        if os.path.isfile(fit_path):
            os.remove(fit_path)
    except OSError as exc:
        log.error("Törlési hiba: %s", exc)
        abort(500)
    _save_index([r for r in existing if r.get("id") != route_id], idx)
    with _db() as conn:
        conn.execute("DELETE FROM routes WHERE id = ? AND user_id = ?",
                     (route_id, g.user["id"]))
    return "", 204


@app.route("/api/routes/<route_id>/fit", methods=["GET"])
@require_auth
def get_route_fit(route_id: str):
    """Eredeti FIT bináris letöltése (csak ha FIT-ből lett mentve)."""
    route_id     = _safe_id(route_id)
    user_dir, _  = _resolve_dirs()
    fit_path     = os.path.join(user_dir, f"{route_id}.fit")
    if not os.path.isfile(fit_path):
        abort(404, description="FIT fájl nem érhető el ehhez az útvonalhoz")
    with open(fit_path, "rb") as f:
        content = f.read()
    return content, 200, {
        "Content-Type": "application/vnd.ant.fit",
        "Content-Disposition": f'attachment; filename="{route_id}.fit"',
    }


# ══════════════════════════════════════════════════════════════════════════════
# MINTA ÚTVONALAK
# ══════════════════════════════════════════════════════════════════════════════

def _load_sample_meta(directory: str, sid: str) -> dict:
    meta = {}
    mp = os.path.join(directory, f"{sid}.json")
    if os.path.isfile(mp):
        try:
            with open(mp, encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            pass
    return meta


def _sample_entry(sid: str, meta: dict, custom: bool) -> dict:
    return {
        "id":          sid,
        "name":        meta.get("name", sid.replace("-", " ").title()),
        "distance":    meta.get("distance"),
        "duration":    meta.get("duration"),
        "elevation":   meta.get("elevation"),
        "type":        meta.get("type", "cycling"),
        "description": meta.get("description", ""),
        "custom":      custom,
    }


@app.route("/api/samples", methods=["GET"])
def list_samples():
    seen = {}
    # custom előbb – felülírja a beépítetteket azonos ID esetén
    for directory, is_custom in [(CUSTOM_SAMPLES_DIR, True), (SAMPLES_DIR, False)]:
        if not os.path.isdir(directory):
            continue
        for fn in sorted(os.listdir(directory)):
            if not fn.endswith(".gpx"):
                continue
            sid = fn[:-4]
            if sid not in seen:
                meta = _load_sample_meta(directory, sid)
                seen[sid] = _sample_entry(sid, meta, is_custom)
    return jsonify(list(seen.values()))


@app.route("/api/samples/<sample_id>", methods=["GET"])
def get_sample(sample_id: str):
    sample_id = _safe_id(sample_id)
    # custom előbb, aztán beépített
    for directory in (CUSTOM_SAMPLES_DIR, SAMPLES_DIR):
        gpx_path = os.path.join(directory, f"{sample_id}.gpx")
        if os.path.isfile(gpx_path):
            try:
                with open(gpx_path, encoding="utf-8") as f:
                    content = f.read()
            except OSError:
                abort(500)
            return content, 200, {"Content-Type": "application/gpx+xml; charset=utf-8"}
    abort(404, description=f"Minta nem található: {sample_id}")


# ── Admin: sample kezelés ─────────────────────────────────────────────────────

@app.route("/api/admin/samples", methods=["GET"])
@require_auth
@require_admin
def admin_list_samples():
    result = []
    for directory, is_custom in [(CUSTOM_SAMPLES_DIR, True), (SAMPLES_DIR, False)]:
        if not os.path.isdir(directory):
            continue
        for fn in sorted(os.listdir(directory)):
            if not fn.endswith(".gpx"):
                continue
            sid  = fn[:-4]
            meta = _load_sample_meta(directory, sid)
            result.append(_sample_entry(sid, meta, is_custom))
    return jsonify(result)


@app.route("/api/admin/samples", methods=["POST"])
@require_auth
@require_admin
def admin_create_sample():
    if "gpx" not in request.files:
        abort(400, description="gpx fájl kötelező")
    gpx_file = request.files["gpx"]
    raw_name = request.form.get("name", "").strip()
    sid = _safe_id(re.sub(r"\s+", "-", raw_name).lower() or gpx_file.filename.rsplit(".", 1)[0])
    if not sid:
        abort(400, description="Érvénytelen minta-azonosító")
    os.makedirs(CUSTOM_SAMPLES_DIR, exist_ok=True)
    gpx_path = os.path.join(CUSTOM_SAMPLES_DIR, f"{sid}.gpx")
    gpx_file.save(gpx_path)
    meta = {
        "name":        raw_name or sid.replace("-", " ").title(),
        "type":        request.form.get("type", "cycling"),
        "description": request.form.get("description", ""),
    }
    for key in ("distance", "duration", "elevation"):
        val = request.form.get(key, "").strip()
        if val:
            try:
                meta[key] = float(val)
            except ValueError:
                pass
    json_path = os.path.join(CUSTOM_SAMPLES_DIR, f"{sid}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return jsonify(_sample_entry(sid, meta, True)), 201


@app.route("/api/admin/samples/<sample_id>", methods=["PATCH"])
@require_auth
@require_admin
def admin_update_sample(sample_id: str):
    sample_id = _safe_id(sample_id)
    # beépített mintát is lehet "felülírni" egy custom JSON-nal
    os.makedirs(CUSTOM_SAMPLES_DIR, exist_ok=True)
    json_path = os.path.join(CUSTOM_SAMPLES_DIR, f"{sample_id}.json")
    # meglévő meta betöltése (custom vagy builtin)
    meta = _load_sample_meta(CUSTOM_SAMPLES_DIR, sample_id)
    if not meta:
        meta = _load_sample_meta(SAMPLES_DIR, sample_id)
    data = request.get_json(force=True) or {}
    for key in ("name", "type", "description"):
        if key in data:
            meta[key] = data[key]
    for key in ("distance", "duration", "elevation"):
        if key in data:
            try:
                meta[key] = float(data[key])
            except (ValueError, TypeError):
                pass
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return jsonify(_sample_entry(sample_id, meta, True))


@app.route("/api/admin/samples/<sample_id>", methods=["DELETE"])
@require_auth
@require_admin
def admin_delete_sample(sample_id: str):
    sample_id = _safe_id(sample_id)
    deleted = False
    for ext in (".gpx", ".json"):
        p = os.path.join(CUSTOM_SAMPLES_DIR, f"{sample_id}{ext}")
        if os.path.isfile(p):
            os.remove(p)
            deleted = True
    if not deleted:
        abort(404, description="Csak custom minta törölhető")
    return jsonify({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
# BACKUP / RESTORE
# ══════════════════════════════════════════════════════════════════════════════

BACKUP_VERSION = 1


def _build_user_backup_zip(user_id: str, user_email: str = None) -> io.BytesIO:
    """ZIP archívum a user teljes adatáról: settings.json + routes/ + workouts/."""
    buf  = io.BytesIO()
    base = _user_dir(user_id)
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("meta.json", json.dumps({
            "version":    BACKUP_VERSION,
            "user_id":    user_id,
            "user_email": user_email,
            "created_at": _now_dt(),
        }, ensure_ascii=False, indent=2))
        settings_path = _user_settings_path(user_id)
        if os.path.isfile(settings_path):
            zf.write(settings_path, "settings.json")
        for sub in ("routes", "workouts"):
            d = os.path.join(base, sub)
            if not os.path.isdir(d):
                continue
            for fn in sorted(os.listdir(d)):
                fp = os.path.join(d, fn)
                if os.path.isfile(fp):
                    zf.write(fp, f"{sub}/{fn}")
    buf.seek(0)
    return buf


def _restore_user_from_zip(user_id: str, zip_bytes: bytes, mode: str) -> dict:
    """Restore ZIP a user mappájába. mode: merge|replace.
    merge:   új ID-k generálódnak minden route-hoz; settings nem íródik felül.
    replace: a meglévő routes/+workouts/+settings törlődik, és a backup beíródik az eredeti ID-kkel.
    """
    if mode not in ("merge", "replace"):
        abort(400, description="Érvénytelen mód: merge vagy replace")

    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        abort(400, description="Érvénytelen ZIP fájl")

    base = _user_dir(user_id)
    os.makedirs(base, exist_ok=True)

    stats = {"routes_added": 0, "workouts_added": 0, "settings_restored": False}

    if mode == "replace":
        for sub in ("routes", "workouts"):
            d = os.path.join(base, sub)
            if os.path.isdir(d):
                shutil.rmtree(d)
        if os.path.isfile(_user_settings_path(user_id)):
            os.remove(_user_settings_path(user_id))

    # settings.json visszatöltése csak replace módban
    if mode == "replace":
        try:
            settings_raw = zf.read("settings.json")
            settings = json.loads(settings_raw.decode("utf-8"))
            if isinstance(settings, dict):
                _save_user_settings_file(user_id, settings)
                stats["settings_restored"] = True
        except KeyError:
            pass  # nincs settings.json a backupban
        except (json.JSONDecodeError, UnicodeDecodeError):
            log.warning("Restore: érvénytelen settings.json a backupban")

    # routes/ + workouts/ feldolgozása
    for sub in ("routes", "workouts"):
        sub_dir = os.path.join(base, sub)
        os.makedirs(sub_dir, exist_ok=True)
        idx_path = os.path.join(sub_dir, "index.json")

        # backupbeli index.json (ha van)
        backup_index = []
        try:
            backup_index = json.loads(zf.read(f"{sub}/index.json").decode("utf-8"))
            if not isinstance(backup_index, list):
                backup_index = []
        except KeyError:
            pass
        except (json.JSONDecodeError, UnicodeDecodeError):
            log.warning("Restore: érvénytelen %s/index.json", sub)

        if mode == "replace":
            # Mindent betöltünk az eredeti ID-kkel
            for entry in backup_index:
                rid = _safe_id(entry.get("id", ""))
                if not rid:
                    continue
                _copy_route_files_from_zip(zf, sub, rid, sub_dir, rid)
            _save_index(backup_index, idx_path)
            stats[f"{sub}_added"] = len(backup_index)
        else:  # merge
            current_index = _load_index(idx_path)
            for entry in backup_index:
                old_id = _safe_id(entry.get("id", ""))
                if not old_id:
                    continue
                new_id = "r_" + uuid.uuid4().hex[:8]
                if not _copy_route_files_from_zip(zf, sub, old_id, sub_dir, new_id):
                    continue
                new_entry = dict(entry)
                new_entry["id"] = new_id
                current_index.append(new_entry)
                stats[f"{sub}_added"] += 1
            _save_index(current_index, idx_path)

    return stats


def _copy_route_files_from_zip(zf, sub: str, old_id: str, dst_dir: str, new_id: str) -> bool:
    """Egy adott ID-jű GPX (+ opc. FIT) fájlt kimásol a ZIP-ből a cél mappába.
    Visszaad: True ha legalább a GPX kimásolódott."""
    copied = False
    for ext in (".gpx", ".fit"):
        try:
            data = zf.read(f"{sub}/{old_id}{ext}")
        except KeyError:
            continue
        with open(os.path.join(dst_dir, f"{new_id}{ext}"), "wb") as f:
            f.write(data)
        if ext == ".gpx":
            copied = True
    return copied


# ── User végpontok ────────────────────────────────────────────────────────────

@app.route("/api/user/backup", methods=["GET"])
@require_auth
def user_backup():
    uid   = g.user["id"]
    email = g.user.get("email")
    buf   = _build_user_backup_zip(uid, email)
    fname = f"{email or uid}-{_now_date()}.zip"
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=fname)


@app.route("/api/user/restore", methods=["POST"])
@require_auth
def user_restore():
    if "backup" not in request.files:
        abort(400, description="backup fájl kötelező")
    mode = request.form.get("mode", "merge")
    data = request.files["backup"].read()
    stats = _restore_user_from_zip(g.user["id"], data, mode)
    return jsonify({"ok": True, "mode": mode, **stats})


# ── Admin végpontok ───────────────────────────────────────────────────────────

@app.route("/api/admin/users/<user_id>/backup", methods=["GET"])
@require_auth
@require_admin
def admin_user_backup(user_id: str):
    with _db() as conn:
        row = conn.execute("SELECT email FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        abort(404, description="Felhasználó nem található")
    buf = _build_user_backup_zip(user_id, row["email"])
    fname = f"{row['email']}-{_now_date()}.zip"
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=fname)


@app.route("/api/admin/users/<user_id>/restore", methods=["POST"])
@require_auth
@require_admin
def admin_user_restore(user_id: str):
    with _db() as conn:
        row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        abort(404, description="Felhasználó nem található")
    if "backup" not in request.files:
        abort(400, description="backup fájl kötelező")
    mode = request.form.get("mode", "merge")
    data = request.files["backup"].read()
    stats = _restore_user_from_zip(user_id, data, mode)
    return jsonify({"ok": True, "mode": mode, **stats})


# ══════════════════════════════════════════════════════════════════════════════
# STRAVA INTEGRATION
# ══════════════════════════════════════════════════════════════════════════════

STRAVA_OAUTH_URL    = "https://www.strava.com/oauth/authorize"
STRAVA_TOKEN_URL    = "https://www.strava.com/oauth/token"
STRAVA_DEAUTH_URL   = "https://www.strava.com/oauth/deauthorize"
STRAVA_API_BASE     = "https://www.strava.com/api/v3"
STRAVA_DEFAULT_SCOPE = "read,activity:read_all"


# ── App credentials kezelés (env felülbírálja az admin UI-fájlt) ─────────────

def _load_strava_app_config(user_id: str = None) -> dict:
    """Visszaadja a Strava app credentialokat. Forrás-prioritás:
       1. User saját client_id/secret (strava.json-ban) — per-user app modell
       2. Env STRAVA_CLIENT_ID/SECRET — legacy fallback (régi tokenek refresh-éhez)
       3. Admin UI globális (legacy, deprecated)
    """
    # 1. User saját
    if user_id:
        ud = _load_user_strava(user_id)
        if ud.get("client_id") and ud.get("client_secret"):
            return {"client_id": ud["client_id"], "client_secret": ud["client_secret"], "source": "user"}
    # 2. Env (legacy)
    cid = os.environ.get("STRAVA_CLIENT_ID")
    sec = os.environ.get("STRAVA_CLIENT_SECRET")
    if cid and sec:
        return {"client_id": cid, "client_secret": sec, "source": "env"}
    # 3. Admin UI globális (legacy)
    if os.path.isfile(STRAVA_APP_CONFIG):
        try:
            with open(STRAVA_APP_CONFIG, encoding="utf-8") as f:
                data = json.load(f)
            if data.get("client_id") and data.get("client_secret"):
                return {**data, "source": "admin_ui"}
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("Strava app config olvasási hiba: %s", exc)
    return {"client_id": None, "client_secret": None, "source": "none"}


def _save_strava_app_config(client_id: str, client_secret: str) -> None:
    """Admin UI-ből beállított credentials mentése (0600 perm)."""
    os.makedirs(os.path.dirname(STRAVA_APP_CONFIG), exist_ok=True)
    tmp = STRAVA_APP_CONFIG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"client_id": client_id, "client_secret": client_secret}, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, STRAVA_APP_CONFIG)


def _delete_strava_app_config() -> None:
    if os.path.isfile(STRAVA_APP_CONFIG):
        os.remove(STRAVA_APP_CONFIG)


def _resolve_redirect_uri(user_id: str = None) -> str:
    """Visszaadja a callback URL-t. Prioritás:
       1. User saját override (strava.json callback_url)
       2. Env STRAVA_REDIRECT_URI
       3. Request-alapú auto-detect (scheme + host)
    """
    if user_id:
        ud = _load_user_strava(user_id)
        if ud.get("callback_url"):
            return ud["callback_url"]
    if STRAVA_REDIRECT_URI:
        return STRAVA_REDIRECT_URI
    # Request-alapú: scheme + host
    proto = request.headers.get("X-Forwarded-Proto", request.scheme)
    host  = request.headers.get("X-Forwarded-Host", request.host)
    return f"{proto}://{host}/api/strava/callback"


# ── Per-user token kezelés (/data/users/<uid>/strava.json) ────────────────────

def _user_strava_path(user_id: str) -> str:
    return os.path.join(_user_dir(user_id), "strava.json")


def _load_user_strava(user_id: str) -> dict:
    path = _user_strava_path(user_id)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_user_strava(user_id: str, data: dict) -> None:
    os.makedirs(_user_dir(user_id), exist_ok=True)
    path = _user_strava_path(user_id)
    tmp  = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _delete_user_strava(user_id: str) -> None:
    path = _user_strava_path(user_id)
    if os.path.isfile(path):
        os.remove(path)


# ── OAuth state (CSRF védelem) ────────────────────────────────────────────────
# Fájl-alapú state-tár (több gunicorn worker is látja).
# /data/strava_states/<state>.json {user_id, expiry_ts}
_STRAVA_STATES_DIR = os.environ.get("STRAVA_STATES_DIR", "/data/strava_states")
_STRAVA_STATE_TTL = 10 * 60  # 10 perc


def _strava_state_path(state: str) -> str:
    # Csak alfanumerikus state token engedélyezett a path-ban
    safe = "".join(c for c in state if c.isalnum() or c in "-_")
    return os.path.join(_STRAVA_STATES_DIR, f"{safe}.json")


def _new_strava_state(user_id: str) -> str:
    state = secrets.token_urlsafe(24)
    os.makedirs(_STRAVA_STATES_DIR, exist_ok=True)
    path = _strava_state_path(state)
    tmp  = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"user_id": user_id, "expiry_ts": time.time() + _STRAVA_STATE_TTL}, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    _cleanup_strava_states()
    return state


def _consume_strava_state(state: str) -> str | None:
    path = _strava_state_path(state)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            rec = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    finally:
        try: os.remove(path)
        except OSError: pass
    if not rec or time.time() > rec.get("expiry_ts", 0):
        return None
    return rec.get("user_id")


def _cleanup_strava_states():
    """Lejárt state fájlok törlése (best-effort, futás-időben)."""
    if not os.path.isdir(_STRAVA_STATES_DIR):
        return
    now = time.time()
    try:
        for name in os.listdir(_STRAVA_STATES_DIR):
            if not name.endswith(".json"): continue
            p = os.path.join(_STRAVA_STATES_DIR, name)
            try:
                with open(p, encoding="utf-8") as f:
                    rec = json.load(f)
                if now > rec.get("expiry_ts", 0):
                    os.remove(p)
            except (OSError, json.JSONDecodeError):
                try: os.remove(p)
                except OSError: pass
    except OSError:
        pass


# ── Token refresh ─────────────────────────────────────────────────────────────

def _ensure_strava_token(user_id: str) -> str | None:
    """Garantáltan érvényes access_token-t ad vissza, refresh-eli ha lejárt.
    None ha nincs csatlakoztatva vagy refresh sikertelen."""
    data = _load_user_strava(user_id)
    if not data.get("access_token") or not data.get("refresh_token"):
        return None
    # 60 sec buffer
    if data.get("expires_at", 0) > time.time() + 60:
        return data["access_token"]
    # Refresh — a user saját app credentials-jével (vagy env fallback)
    cfg = _load_strava_app_config(user_id)
    if not cfg["client_id"]:
        log.warning("Strava app credentials hiányoznak token refresh-hez (user=%s)", user_id)
        return None
    try:
        resp = requests.post(STRAVA_TOKEN_URL, data={
            "client_id":     cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "grant_type":    "refresh_token",
            "refresh_token": data["refresh_token"],
        }, timeout=15)
        if resp.status_code != 200:
            log.warning("Strava token refresh hiba (%s): %s", resp.status_code, resp.text[:200])
            return None
        td = resp.json()
        data.update({
            "access_token":  td["access_token"],
            "refresh_token": td["refresh_token"],
            "expires_at":    td["expires_at"],
        })
        _save_user_strava(user_id, data)
        return data["access_token"]
    except requests.RequestException as exc:
        log.warning("Strava token refresh exception: %s", exc)
        return None


# ── User-facing endpoint-ok ───────────────────────────────────────────────────

@app.route("/api/strava/status", methods=["GET"])
@require_auth
def strava_status():
    """Csatlakozott-e a user, ha igen mikor és athleta-név is."""
    user_id = g.user["id"]
    data = _load_user_strava(user_id)
    cfg  = _load_strava_app_config(user_id)
    return jsonify({
        "connected":     bool(data.get("access_token")),
        "athlete_id":    data.get("athlete_id"),
        "athlete_name":  data.get("athlete_name"),
        "connected_at":  data.get("connected_at"),
        "scope":         data.get("scope"),
        "app_configured": cfg["client_id"] is not None,
        "app_source":    cfg["source"],   # "user" / "env" / "admin_ui" / "none"
        "has_user_creds": bool(data.get("client_id") and data.get("client_secret")),
    })


@app.route("/api/strava/connect", methods=["GET"])
@require_auth
def strava_connect():
    """Visszaadja a Strava OAuth URL-t, ahova a usert irányítjuk."""
    user_id = g.user["id"]
    cfg = _load_strava_app_config(user_id)
    if not cfg["client_id"]:
        abort(503, description="Strava app credentials nincs megadva. A Beállítások → Strava szekcióban add meg a saját Strava app Client ID-t és Secret-jét.")
    state = _new_strava_state(user_id)
    params = {
        "client_id":     cfg["client_id"],
        "redirect_uri":  _resolve_redirect_uri(user_id),
        "response_type": "code",
        "scope":         STRAVA_DEFAULT_SCOPE,
        "state":         state,
        "approval_prompt": "auto",
    }
    return jsonify({"auth_url": f"{STRAVA_OAUTH_URL}?{urlencode(params)}"})


@app.route("/api/strava/callback", methods=["GET"])
def strava_callback():
    """Stravas redirect: code → access_token csere, mentés user mappájába.
    NEM @require_auth – maga a redirect publikus, a state azonosít.
    HTML választ ad vissza, ami az ablakot bezárja és értesíti a parent-et."""
    code  = request.args.get("code")
    state = request.args.get("state")
    err   = request.args.get("error")
    if err:
        return _strava_oauth_close_window(error=f"Strava elutasította: {err}")
    if not code or not state:
        return _strava_oauth_close_window(error="Hiányos visszahívás (code/state).")
    user_id = _consume_strava_state(state)
    if not user_id:
        return _strava_oauth_close_window(error="Érvénytelen vagy lejárt state.")
    cfg = _load_strava_app_config(user_id)
    if not cfg["client_id"]:
        return _strava_oauth_close_window(error="Strava app credentials nincs megadva.")
    # Token csere
    try:
        resp = requests.post(STRAVA_TOKEN_URL, data={
            "client_id":     cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "code":          code,
            "grant_type":    "authorization_code",
        }, timeout=15)
        if resp.status_code != 200:
            # 403 = a Strava app elérte a felhasználói (athlete) limitet.
            # Alapból 1 athlete/app a Strava-nál, ezt a developer dashboardon
            # ("Authorized athletes count") kell növeltetni.
            if resp.status_code == 403:
                return _strava_oauth_close_window(error=(
                    "A Strava app elérte a felhasználói limitet (alapból 1 athlete). "
                    "Ha más Strava-fiókod is van, hozz létre saját Strava app-ot a "
                    "strava.com/settings/api oldalon és add meg itt a credentials-jét."
                ))
            return _strava_oauth_close_window(error=f"Token csere hiba ({resp.status_code}).")
        td = resp.json()
    except requests.RequestException as exc:
        return _strava_oauth_close_window(error=f"Hálózati hiba: {exc}")
    # Athleta adatok
    athlete = td.get("athlete", {}) or {}
    athlete_name = (athlete.get("firstname", "") + " " + athlete.get("lastname", "")).strip() \
                or athlete.get("username") or f"#{athlete.get('id')}"
    # Mergelünk a meglévő adatokkal — a user által mentett client_id/secret megmarad
    existing = _load_user_strava(user_id)
    existing.update({
        "athlete_id":    athlete.get("id"),
        "athlete_name":  athlete_name,
        "access_token":  td["access_token"],
        "refresh_token": td["refresh_token"],
        "expires_at":    td["expires_at"],
        "scope":         td.get("scope") or STRAVA_DEFAULT_SCOPE,
        "connected_at":  _now_dt(),
    })
    _save_user_strava(user_id, existing)
    return _strava_oauth_close_window(success=True, athlete_name=athlete_name)


def _strava_oauth_close_window(success: bool = False, athlete_name: str = "", error: str = "") -> str:
    """HTML választ ad vissza, ami az popup ablakot bezárja és a parent ablakot
    értesíti a window.postMessage-en keresztül."""
    payload = {"type": "strava-oauth", "success": success, "athlete_name": athlete_name, "error": error}
    msg = "Sikeres kapcsolódás!" if success else f"Hiba: {error}"
    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Strava kapcsolódás</title>
<style>
body {{ font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;color:#222 }}
.box {{ background:#fff;padding:24px 32px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.1);text-align:center;max-width:400px }}
.ok {{ color:#16a34a }} .err {{ color:#dc2626 }}
button {{ margin-top:14px;padding:8px 20px;font-size:14px;background:#FC4C02;color:#fff;border:none;border-radius:6px;cursor:pointer }}
button:hover {{ filter:brightness(1.1) }}
.hint {{ margin-top:10px;font-size:12px;color:#666 }}
</style></head><body>
<div class="box">
  <h2 class="{'ok' if success else 'err'}">{msg}</h2>
  <p>A bringaterv ablakban már látszik az új állapot. Ezt a fület most már bezárhatod.</p>
  <button onclick="tryClose()">Ablak bezárása</button>
  <div class="hint" id="hint" style="display:none">Safari nem engedi auto-bezárni — zárd be kézzel (Cmd+W).</div>
</div>
<script>
try {{
  if (window.opener && !window.opener.closed) {{
    window.opener.postMessage({json.dumps(payload)}, "*");
  }}
}} catch(e) {{}}
function tryClose() {{
  try {{ window.close(); }} catch(e) {{}}
  // Ha 200ms után még itt vagyunk, mutatjuk a hint-et
  setTimeout(() => {{
    if (!window.closed) document.getElementById("hint").style.display = "block";
  }}, 200);
}}
</script>
</body></html>"""
    return html, 200, {"Content-Type": "text/html; charset=utf-8"}


@app.route("/api/strava/activities", methods=["GET"])
@require_auth
def strava_activities():
    """Visszaadja a user Strava activity-it (utolsó X). Duplicate-check is fut."""
    token = _ensure_strava_token(g.user["id"])
    if not token:
        abort(401, description="Nincs csatlakozva Stravához vagy a token érvénytelen.")
    per_page = max(1, min(100, int(request.args.get("per_page", 30))))
    page     = max(1, int(request.args.get("page", 1)))
    after    = request.args.get("after")   # UNIX timestamp – activities AFTER this date
    before   = request.args.get("before")  # UNIX timestamp – activities BEFORE this date
    params = {"per_page": per_page, "page": page}
    if after:  params["after"]  = after
    if before: params["before"] = before
    try:
        resp = requests.get(f"{STRAVA_API_BASE}/athlete/activities",
                            params=params,
                            headers={"Authorization": f"Bearer {token}"},
                            timeout=20)
        if resp.status_code == 401:
            # Token revoke-olódott vagy az app credentials hibásak. Töröljük a tokent
            # hogy a frontend újra-csatlakozást ajánljon.
            _delete_user_strava(g.user["id"])
            abort(401, description="A Strava kapcsolat érvénytelenné vált. Csatlakozz újra a Beállítások panelben.")
        if resp.status_code == 429:
            abort(429, description="Strava rate limit elérve. Próbáld 15 perc múlva.")
        if resp.status_code != 200:
            abort(502, description=f"Strava API hiba ({resp.status_code}).")
        data = resp.json()
    except requests.RequestException as exc:
        abort(502, description=f"Strava lekérdezés sikertelen: {exc}")

    # Lokális library + deny-list a duplicate-checkhez
    routes_dir = _user_routes_dir(g.user["id"])
    idx        = _load_index(os.path.join(routes_dir, "index.json"))
    by_strava  = {r.get("strava_id"): r for r in idx if r.get("strava_id")}
    deny_list  = _load_strava_deny_list(g.user["id"])

    # Nem útvonal-alapú (GPS nélküli) Strava aktivitás-típusok – ezeket nem listázzuk,
    # mert nincs térképük/útvonaluk (pl. konditermi "Workout", súlyzós edzés, jóga).
    NON_GPS_TYPES = {
        "workout", "weighttraining", "yoga", "crossfit", "elliptical",
        "stairstepper", "pilates", "rockclimbing", "hiit", "swim",
        "virtualrun", "velomobile",
    }

    items = []
    for a in data:
        sid = a.get("id")
        # Kihagyjuk a nem-térképes edzéseket (típus-alapon VAGY ha nincs se GPS-track, se táv)
        sport_t  = (a.get("sport_type") or a.get("type") or "").lower()
        polyline = (a.get("map") or {}).get("summary_polyline")
        dist_m   = a.get("distance") or 0
        if sport_t in NON_GPS_TYPES or (not polyline and dist_m <= 0):
            continue
        dup_local   = by_strava.get(sid)
        dup_deleted = sid in deny_list
        # Esetleges manuális-import egyezés (start_time + distance heurisztika)
        manual_match = None
        if not dup_local and not dup_deleted:
            manual_match = _find_manual_match(idx, a)
        items.append({
            "id":           sid,
            "name":         a.get("name") or "",
            "type":         a.get("sport_type") or a.get("type"),
            "start_date":   a.get("start_date"),
            "distance_m":   a.get("distance"),
            "moving_time_s": a.get("moving_time"),
            "elapsed_time_s": a.get("elapsed_time"),
            "total_elevation_gain": a.get("total_elevation_gain"),
            "trainer":      a.get("trainer"),
            "has_heartrate": a.get("has_heartrate"),
            "duplicate_status":
                "already_imported" if dup_local else
                ("previously_deleted" if dup_deleted else
                 ("likely_duplicate" if manual_match else "new")),
            "duplicate_local_id": dup_local["id"] if dup_local else (manual_match["id"] if manual_match else None),
        })
    return jsonify({"activities": items, "page": page, "per_page": per_page})


def _find_manual_match(idx: list, strava_activity: dict) -> dict | None:
    """Heurisztika: kb. ugyanaz a manuális import létezik-e?
    start_time ±60 sec ÉS distance ±2%."""
    s_start = strava_activity.get("start_date")
    s_dist  = strava_activity.get("distance")
    if not s_start or not s_dist:
        return None
    try:
        s_ts = datetime.fromisoformat(s_start.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return None
    for r in idx:
        # Csak nem-Strava-os elemekkel hasonlítunk
        if r.get("strava_id"):
            continue
        r_start = r.get("start_time") or r.get("date")
        if not r_start:
            continue
        try:
            r_ts = datetime.fromisoformat(r_start.replace("Z", "+00:00")).timestamp() if "T" in r_start \
                   else datetime.fromisoformat(r_start).timestamp()
        except (ValueError, AttributeError):
            continue
        if abs(r_ts - s_ts) > 60:
            continue
        r_dist_km = r.get("distance")
        if r_dist_km is None:
            continue
        r_dist_m = r_dist_km * 1000
        if abs(r_dist_m - s_dist) / s_dist > 0.02:
            continue
        return r
    return None


@app.route("/api/strava/import/<int:activity_id>", methods=["POST"])
@require_auth
def strava_import(activity_id: int):
    """Egy Strava activity-t letölt + GPX-szé konvertál + ment a könyvtárba."""
    token = _ensure_strava_token(g.user["id"])
    if not token:
        abort(401, description="Nincs csatlakozva Stravához.")
    user_id    = g.user["id"]
    routes_dir = _user_routes_dir(user_id)
    idx_path   = os.path.join(routes_dir, "index.json")
    idx        = _load_index(idx_path)

    # Duplikálás check – ha már megvan, skip
    if any(r.get("strava_id") == activity_id for r in idx):
        return jsonify({"ok": True, "skipped": True, "reason": "already_imported"})

    # Activity meta
    try:
        ar = requests.get(f"{STRAVA_API_BASE}/activities/{activity_id}",
                          headers={"Authorization": f"Bearer {token}"},
                          params={"include_all_efforts": "false"},
                          timeout=20)
        if ar.status_code == 401:
            _delete_user_strava(user_id)
            abort(401, description="A Strava kapcsolat érvénytelenné vált. Csatlakozz újra a Beállítások panelben.")
        if ar.status_code != 200:
            abort(502, description=f"Strava activity hiba ({ar.status_code}).")
        activity = ar.json()
    except requests.RequestException as exc:
        abort(502, description=f"Strava activity lekérdezés sikertelen: {exc}")

    # Streams (latlng, altitude, time, heartrate, cadence, watts)
    try:
        sr = requests.get(f"{STRAVA_API_BASE}/activities/{activity_id}/streams",
                          headers={"Authorization": f"Bearer {token}"},
                          params={"keys": "latlng,altitude,time,heartrate,cadence,watts", "key_by_type": "true"},
                          timeout=30)
        if sr.status_code == 401:
            _delete_user_strava(user_id)
            abort(401, description="A Strava kapcsolat érvénytelenné vált. Csatlakozz újra.")
        if sr.status_code != 200:
            abort(502, description=f"Strava streams hiba ({sr.status_code}). Lehet, hogy nincs GPS adat?")
        streams = sr.json()
    except requests.RequestException as exc:
        abort(502, description=f"Strava streams lekérdezés sikertelen: {exc}")

    latlng = streams.get("latlng", {}).get("data", [])
    if not latlng:
        return jsonify({"ok": False, "error": "Nincs GPS adat ehhez az activity-hez (talán beltéri vagy trainer)."}), 422

    altitude = streams.get("altitude", {}).get("data", []) or [None] * len(latlng)
    times    = streams.get("time", {}).get("data", []) or [None] * len(latlng)
    hr       = streams.get("heartrate", {}).get("data", []) or [None] * len(latlng)
    cad      = streams.get("cadence", {}).get("data", []) or [None] * len(latlng)
    pow_     = streams.get("watts", {}).get("data", []) or [None] * len(latlng)

    # Start timestamp ISO 8601
    try:
        start_dt = datetime.fromisoformat(activity["start_date"].replace("Z", "+00:00"))
    except (KeyError, ValueError, AttributeError):
        start_dt = datetime.now(timezone.utc)

    # GPX szöveg építés
    gpx = _build_gpx_from_streams(
        name=activity.get("name") or f"Strava {activity_id}",
        sport_type=activity.get("sport_type") or activity.get("type") or "cycling",
        start_dt=start_dt,
        latlng=latlng, altitude=altitude, times=times, hr=hr, cad=cad, power=pow_,
    )

    # Mentés
    new_id = uuid.uuid4().hex[:8]
    gpx_path = os.path.join(routes_dir, f"{new_id}.gpx")
    with open(gpx_path, "w", encoding="utf-8") as f:
        f.write(gpx)

    # Index bejegyzés
    dist_m  = activity.get("distance") or 0
    ele_m   = activity.get("total_elevation_gain") or 0
    mov_s   = activity.get("moving_time") or 0
    sport_t = (activity.get("sport_type") or activity.get("type") or "").lower()
    sport_subtype = "cycling" if "ride" in sport_t or "cycl" in sport_t else \
                    "running" if "run" in sport_t else \
                    "walking" if "walk" in sport_t else \
                    "hiking"  if "hik" in sport_t else "cycling"

    new_entry = {
        "id":           new_id,
        "name":         activity.get("name") or f"Strava {activity_id}",
        "type":         "workout",         # KATEGÓRIA: edzés (nem útvonal) – default Elemzés tab
        "sport_type":   sport_subtype,     # SPORT: cycling/running/walking/hiking
        "distance":     round(dist_m / 1000, 2),
        "duration":     round(mov_s / 60),
        "elevation":    round(ele_m),
        "date":         start_dt.strftime("%Y-%m-%d"),
        "start_time":   start_dt.isoformat(),
        "strava_id":    activity_id,
        "source":       "strava",
        "imported_at":  _now_dt(),
        "description":  activity.get("description") or "",
        # Strava-specifikus enrichment mezők (mind opcionális, None ha nincs)
        "calories":              activity.get("calories"),
        "suffer_score":          activity.get("suffer_score"),
        "weighted_avg_watts":    activity.get("weighted_average_watts"),
        "device_watts":          activity.get("device_watts"),
        "avg_watts":             activity.get("average_watts"),
        "max_watts":             activity.get("max_watts"),
        "kilojoules":            activity.get("kilojoules"),
        "avg_heartrate":         activity.get("average_heartrate"),
        "max_heartrate":         activity.get("max_heartrate"),
        "avg_cadence":           activity.get("average_cadence"),
        "avg_speed_kmh":         round(activity["average_speed"] * 3.6, 2) if activity.get("average_speed") else None,
        "max_speed_kmh":         round(activity["max_speed"] * 3.6, 2) if activity.get("max_speed") else None,
        "location_city":         activity.get("location_city"),
        "location_country":      activity.get("location_country"),
        "gear_id":               activity.get("gear_id"),
        "achievement_count":     activity.get("achievement_count"),
        "pr_count":              activity.get("pr_count"),
    }
    idx.append(new_entry)
    _save_index(idx, idx_path)

    return jsonify({"ok": True, "skipped": False, "entry": new_entry})


def _build_gpx_from_streams(name, sport_type, start_dt, latlng, altitude, times, hr, cad, power) -> str:
    """GPX XML építése Strava streams-ből."""
    import xml.sax.saxutils as sx
    out = []
    out.append('<?xml version="1.0" encoding="UTF-8"?>')
    out.append('<gpx version="1.1" creator="Bringaterv (Strava import)"')
    out.append('  xmlns="http://www.topografix.com/GPX/1/1"')
    out.append('  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"')
    out.append('  xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">')
    out.append(f'  <metadata><name>{sx.escape(name)}</name><time>{start_dt.strftime("%Y-%m-%dT%H:%M:%SZ")}</time></metadata>')
    out.append(f'  <trk><name>{sx.escape(name)}</name><type>{sx.escape(sport_type)}</type><trkseg>')
    for i, (lat, lng) in enumerate(latlng):
        ele = altitude[i] if i < len(altitude) and altitude[i] is not None else None
        t_off = times[i] if i < len(times) and times[i] is not None else None
        out.append(f'    <trkpt lat="{lat}" lon="{lng}">')
        if ele is not None:
            out.append(f'      <ele>{ele}</ele>')
        if t_off is not None:
            t = start_dt + timedelta(seconds=t_off)
            out.append(f'      <time>{t.strftime("%Y-%m-%dT%H:%M:%SZ")}</time>')
        h = hr[i]  if i < len(hr)  else None
        c = cad[i] if i < len(cad) else None
        p = power[i] if i < len(power) else None
        if h is not None or c is not None or p is not None:
            out.append('      <extensions>')
            if h is not None or c is not None:
                out.append('        <gpxtpx:TrackPointExtension>')
                if h is not None: out.append(f'          <gpxtpx:hr>{h}</gpxtpx:hr>')
                if c is not None: out.append(f'          <gpxtpx:cad>{c}</gpxtpx:cad>')
                out.append('        </gpxtpx:TrackPointExtension>')
            if p is not None:
                out.append(f'        <power>{p}</power>')
            out.append('      </extensions>')
        out.append('    </trkpt>')
    out.append('  </trkseg></trk>')
    out.append('</gpx>')
    return "\n".join(out)


# ── Strava deny-list (törölt activity-k) ──────────────────────────────────────

def _user_strava_deny_path(user_id: str) -> str:
    return os.path.join(_user_dir(user_id), "strava_deleted.json")


def _load_strava_deny_list(user_id: str) -> set:
    path = _user_strava_deny_path(user_id)
    if not os.path.isfile(path):
        return set()
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f) or {}
        return set(int(k) for k in (data.get("deleted_at") or {}).keys())
    except (OSError, json.JSONDecodeError, ValueError):
        return set()


def _add_strava_deny(user_id: str, strava_id: int) -> None:
    path = _user_strava_deny_path(user_id)
    data = {"deleted_at": {}}
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f) or {"deleted_at": {}}
        except (OSError, json.JSONDecodeError):
            pass
    data.setdefault("deleted_at", {})[str(strava_id)] = _now_dt()
    os.makedirs(_user_dir(user_id), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)


@app.route("/api/strava/refresh/<route_id>", methods=["POST"])
@require_auth
def strava_refresh(route_id: str):
    """Egy meglévő Strava-importált workout meta-adatait frissíti Stravából
    (a GPX fájl változatlan marad – csak a JSON mezők frissülnek)."""
    route_id   = _safe_id(route_id)
    user_id    = g.user["id"]
    routes_dir = _user_routes_dir(user_id)
    idx_path   = os.path.join(routes_dir, "index.json")
    idx        = _load_index(idx_path)
    entry      = next((r for r in idx if r.get("id") == route_id), None)
    if not entry:
        abort(404, description="Útvonal nem található.")
    sid = entry.get("strava_id")
    if not sid:
        abort(400, description="Ez nem Stravás bejegyzés.")

    token = _ensure_strava_token(user_id)
    if not token:
        abort(401, description="Nincs Strava kapcsolat. Csatlakozz újra a Beállítások panelben.")

    try:
        ar = requests.get(f"{STRAVA_API_BASE}/activities/{sid}",
                          headers={"Authorization": f"Bearer {token}"},
                          params={"include_all_efforts": "false"},
                          timeout=20)
        if ar.status_code == 401:
            _delete_user_strava(user_id)
            abort(401, description="A Strava kapcsolat érvénytelenné vált. Csatlakozz újra.")
        if ar.status_code == 404:
            abort(404, description="Ez az activity nincs meg a Stravádon (törölted onnan?).")
        if ar.status_code != 200:
            abort(502, description=f"Strava activity hiba ({ar.status_code}).")
        activity = ar.json()
    except requests.RequestException as exc:
        abort(502, description=f"Strava lekérdezés sikertelen: {exc}")

    # Frissítjük az entry-t a meglévő mezők megőrzésével (id, gpx fájl változatlan)
    sport_t = (activity.get("sport_type") or activity.get("type") or "").lower()
    sport_subtype = "cycling" if "ride" in sport_t or "cycl" in sport_t else \
                    "running" if "run" in sport_t else \
                    "walking" if "walk" in sport_t else \
                    "hiking"  if "hik" in sport_t else "cycling"
    dist_m  = activity.get("distance") or 0
    ele_m   = activity.get("total_elevation_gain") or 0
    mov_s   = activity.get("moving_time") or 0

    entry.update({
        "name":         activity.get("name") or entry.get("name"),
        "type":         "workout",
        "sport_type":   sport_subtype,
        "distance":     round(dist_m / 1000, 2),
        "duration":     round(mov_s / 60),
        "elevation":    round(ele_m),
        "description":  activity.get("description") or entry.get("description", ""),
        "calories":              activity.get("calories"),
        "suffer_score":          activity.get("suffer_score"),
        "weighted_avg_watts":    activity.get("weighted_average_watts"),
        "device_watts":          activity.get("device_watts"),
        "avg_watts":             activity.get("average_watts"),
        "max_watts":             activity.get("max_watts"),
        "kilojoules":            activity.get("kilojoules"),
        "avg_heartrate":         activity.get("average_heartrate"),
        "max_heartrate":         activity.get("max_heartrate"),
        "avg_cadence":           activity.get("average_cadence"),
        "avg_speed_kmh":         round(activity["average_speed"] * 3.6, 2) if activity.get("average_speed") else None,
        "max_speed_kmh":         round(activity["max_speed"] * 3.6, 2) if activity.get("max_speed") else None,
        "location_city":         activity.get("location_city"),
        "location_country":      activity.get("location_country"),
        "gear_id":               activity.get("gear_id"),
        "achievement_count":     activity.get("achievement_count"),
        "pr_count":              activity.get("pr_count"),
        "refreshed_at":          _now_dt(),
    })
    _save_index(idx, idx_path)
    return jsonify({"ok": True, "entry": entry})


@app.route("/api/strava/deny-list/<int:strava_id>", methods=["DELETE"])
@require_auth
def strava_deny_remove(strava_id: int):
    """Eltávolít egy strava_id-t a deny-listből (re-import újra lehetségessé válik)."""
    path = _user_strava_deny_path(g.user["id"])
    if not os.path.isfile(path):
        return jsonify({"ok": True, "removed": False})
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return jsonify({"ok": True, "removed": False})
    removed = data.get("deleted_at", {}).pop(str(strava_id), None) is not None
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)
    return jsonify({"ok": True, "removed": removed})


@app.route("/api/strava/disconnect", methods=["DELETE"])
@require_auth
def strava_disconnect():
    """Lecsatlakozás: token deauth + token/athlete törlés.
    A user által mentett client_id/secret (saját app creds) MARAD,
    hogy ne kelljen újra beírni csatlakozáskor."""
    user_id = g.user["id"]
    data = _load_user_strava(user_id)
    if data.get("access_token"):
        try:
            requests.post(STRAVA_DEAUTH_URL, data={"access_token": data["access_token"]}, timeout=10)
        except requests.RequestException as exc:
            log.warning("Strava deauth exception: %s", exc)
    # Csak a session-jellegű mezőket töröljük, a creds marad
    for k in ("access_token", "refresh_token", "expires_at",
              "athlete_id", "athlete_name", "scope", "connected_at"):
        data.pop(k, None)
    if data:
        _save_user_strava(user_id, data)
    else:
        _delete_user_strava(user_id)
    return jsonify({"ok": True})


# ── User-szintű Strava app credentials kezelés (saját Strava-app) ─────────────

@app.route("/api/strava/app-config", methods=["GET"])
@require_auth
def user_strava_app_config_get():
    """User által beállított Strava app credentials állapota."""
    user_id = g.user["id"]
    data = _load_user_strava(user_id)
    return jsonify({
        "client_id":    data.get("client_id"),        # publikus érték
        "secret_set":   bool(data.get("client_secret")),
        "callback_url": data.get("callback_url"),     # user override (vagy None)
        "redirect_uri": _resolve_redirect_uri(user_id),  # tényleges (override vagy auto)
    })


@app.route("/api/strava/app-config", methods=["PUT"])
@require_auth
def user_strava_app_config_set():
    """User mentse a saját Strava app Client ID + Secret-jét (+ opcionális callback URL)."""
    body = request.get_json(silent=True) or {}
    cid  = (body.get("client_id") or "").strip()
    sec  = (body.get("client_secret") or "").strip()
    cb   = (body.get("callback_url") or "").strip() or None
    if not cid:
        abort(400, description="Client ID kötelező.")
    user_id = g.user["id"]
    data = _load_user_strava(user_id)
    data["client_id"] = cid
    # Secret-et csak akkor írjuk felül, ha küldött újat (üres string = ne piszkáld)
    if sec:
        data["client_secret"] = sec
    elif not data.get("client_secret"):
        abort(400, description="Client Secret kötelező (első mentésnél).")
    # Callback URL: opcionális override, üresnél töröljük
    if cb:
        data["callback_url"] = cb
    else:
        data.pop("callback_url", None)
    _save_user_strava(user_id, data)
    return jsonify({"ok": True})


@app.route("/api/strava/app-config", methods=["DELETE"])
@require_auth
def user_strava_app_config_delete():
    """User saját Strava app credentials törlése (a tokenek megmaradnak,
    de refresh fail-elni fog ha nincs env fallback)."""
    user_id = g.user["id"]
    data = _load_user_strava(user_id)
    data.pop("client_id", None)
    data.pop("client_secret", None)
    data.pop("callback_url", None)
    if data:
        _save_user_strava(user_id, data)
    else:
        _delete_user_strava(user_id)
    return jsonify({"ok": True})


# ── Admin endpoint-ok (app credentials) ───────────────────────────────────────

@app.route("/api/admin/strava/config", methods=["GET"])
@require_auth
@require_admin
def admin_strava_config_get():
    cfg = _load_strava_app_config()
    return jsonify({
        "source":         cfg["source"],      # "env" | "admin_ui" | "none"
        "client_id":      cfg["client_id"],   # publikus – mehet a frontendre
        "secret_set":     bool(cfg["client_secret"]),
        "redirect_uri":   _resolve_redirect_uri(),
    })


@app.route("/api/admin/strava/config", methods=["PUT"])
@require_auth
@require_admin
def admin_strava_config_set():
    data = request.get_json(silent=True) or {}
    cid  = (data.get("client_id") or "").strip()
    sec  = (data.get("client_secret") or "").strip()
    if not cid or not sec:
        abort(400, description="Client ID és Client Secret kötelező.")
    _save_strava_app_config(cid, sec)
    return jsonify({"ok": True, "source": "admin_ui"})


@app.route("/api/admin/strava/config", methods=["DELETE"])
@require_auth
@require_admin
def admin_strava_config_delete():
    """Csak az admin UI-s konfig törlésére – env-változó változatlan."""
    _delete_strava_app_config()
    return jsonify({"ok": True})


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
