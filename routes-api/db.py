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

SCHEMA_VERSION = 14

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
        if ver < 7:
            # v7: meghívók (regisztrációs link)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS invites (
                    token         TEXT    PRIMARY KEY,
                    created_at    TEXT    NOT NULL,
                    created_by    TEXT,
                    expires_at    TEXT,
                    max_uses      INTEGER NOT NULL DEFAULT 1,
                    uses          INTEGER NOT NULL DEFAULT 0,
                    role          TEXT    NOT NULL DEFAULT 'user',
                    quota_routes  INTEGER,
                    note          TEXT    NOT NULL DEFAULT '',
                    revoked       INTEGER NOT NULL DEFAULT 0,
                    used_by       TEXT    NOT NULL DEFAULT ''
                )
            """)
            conn.execute("PRAGMA user_version = 7")
            log.info("DB migrálva v7-re (invites tábla)")
        if ver < 8:
            # v8: visszajelzések (hibajelentés, ötlet, kérdés)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS feedback (
                    id          TEXT    PRIMARY KEY,
                    created_at  TEXT    NOT NULL,
                    user_id     TEXT,
                    user_email  TEXT,
                    user_name   TEXT,
                    category    TEXT    NOT NULL,
                    area        TEXT    NOT NULL DEFAULT '',
                    title       TEXT    NOT NULL,
                    description TEXT    NOT NULL,
                    tech        TEXT    NOT NULL DEFAULT '',
                    attachment  TEXT,
                    status      TEXT    NOT NULL DEFAULT 'new',
                    emailed     INTEGER NOT NULL DEFAULT 0,
                    mail_error  TEXT    NOT NULL DEFAULT ''
                )
            """)
            conn.execute("PRAGMA user_version = 8")
            log.info("DB migrálva v8-ra (feedback tábla)")
        if ver < 9:
            # v9: értesítési e-mail-cím + megerősítés, jelszócsere időpontja,
            #     egyszer használható e-mailes tokenek (megerősítés, jelszó-visszaállítás)
            cols = {r[1] for r in conn.execute("PRAGMA table_info(users)")}
            for col in ("contact_email", "email_verified_at", "pw_changed_at"):
                if col not in cols:
                    conn.execute(f"ALTER TABLE users ADD COLUMN {col} TEXT")
            # Akinek a belépési neve e-mail-cím, annak ez lesz az értesítési címe (még nem megerősítve)
            conn.execute("UPDATE users SET contact_email = email WHERE contact_email IS NULL AND email LIKE '%_@_%._%'")
            conn.execute("""
                CREATE TABLE IF NOT EXISTS auth_tokens (
                    token_hash  TEXT    PRIMARY KEY,
                    user_id     TEXT    NOT NULL,
                    kind        TEXT    NOT NULL,
                    email       TEXT,
                    created_at  TEXT    NOT NULL,
                    expires_at  TEXT    NOT NULL,
                    used_at     TEXT
                )
            """)
            conn.execute("PRAGMA user_version = 9")
            log.info("DB migrálva v9-re (e-mail megerősítés, jelszó-visszaállítás)")
        if ver < 10:
            # v10: 6 számjegyű megerősítő kód – rossz próbálkozások száma
            cols = {r[1] for r in conn.execute("PRAGMA table_info(auth_tokens)")}
            if "attempts" not in cols:
                conn.execute("ALTER TABLE auth_tokens ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
            conn.execute("PRAGMA user_version = 10")
            log.info("DB migrálva v10-re (megerősítő kód)")
        if ver < 11:
            # v11: közösségi útvonal-beküldések (admin jóváhagyással kerülnek a közösségi útvonalak közé)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS route_submissions (
                    id           TEXT    PRIMARY KEY,
                    created_at   TEXT    NOT NULL,
                    user_id      TEXT,
                    user_name    TEXT,
                    user_email   TEXT,
                    source_id    TEXT,
                    source_kind  TEXT,
                    name         TEXT    NOT NULL,
                    description  TEXT    NOT NULL DEFAULT '',
                    route_type   TEXT    NOT NULL DEFAULT 'asphalt',
                    difficulty   TEXT    NOT NULL DEFAULT '',
                    season       TEXT    NOT NULL DEFAULT '',
                    show_author  INTEGER NOT NULL DEFAULT 1,
                    distance_km  REAL,
                    elevation_m  INTEGER,
                    status       TEXT    NOT NULL DEFAULT 'pending',
                    admin_note   TEXT    NOT NULL DEFAULT '',
                    reviewed_at  TEXT,
                    sample_id    TEXT
                )
            """)
            conn.execute("PRAGMA user_version = 11")
            log.info("DB migrálva v11-re (közösségi útvonal-beküldések)")
        if ver < 12:
            # v12: helyadat a beküldésekhez (ország, régió, település, érintett helyek – JSON)
            cols = {r[1] for r in conn.execute("PRAGMA table_info(route_submissions)")}
            if "location" not in cols:
                conn.execute("ALTER TABLE route_submissions ADD COLUMN location TEXT NOT NULL DEFAULT ''")
            conn.execute("PRAGMA user_version = 12")
            log.info("DB migrálva v12-re (beküldések helyadata)")
        if ver < 13:
            # v13: megjelenő beküldő-név (becenév) – üresen a felhasználó neve, show_author=0 → névtelen
            cols = {r[1] for r in conn.execute("PRAGMA table_info(route_submissions)")}
            if "author_alias" not in cols:
                conn.execute("ALTER TABLE route_submissions ADD COLUMN author_alias TEXT NOT NULL DEFAULT ''")
            conn.execute("PRAGMA user_version = 13")
            log.info("DB migrálva v13-ra (beküldő beceneve)")
        if ver < 14:
            # v14: e-mailben kiküldött meghívó – a meghívott címe és a küldés ideje
            cols = {r[1] for r in conn.execute("PRAGMA table_info(invites)")}
            if "invited_email" not in cols:
                conn.execute("ALTER TABLE invites ADD COLUMN invited_email TEXT NOT NULL DEFAULT ''")
            if "sent_at" not in cols:
                conn.execute("ALTER TABLE invites ADD COLUMN sent_at TEXT")
            conn.execute("PRAGMA user_version = 14")
            log.info("DB migrálva v14-re (meghívó e-mailben)")


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
