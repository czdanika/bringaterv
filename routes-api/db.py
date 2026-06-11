"""Bringaterv API – SQLite séma, migrációk, user létrehozás."""

import json
import os
import sqlite3
import uuid

from config import ADMIN_EMAIL, ADMIN_PASSWORD, DB_PATH, log
from security import _hash_pw
from storage import (
    _migrate_single_routes_to_user,
    _save_user_settings_file,
    _user_dir,
    _user_routes_dir,
)
from utils import _now_dt

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
