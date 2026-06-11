"""
Bringaterv API – konfiguráció és logging.

Környezeti változók:
  DATA_DIR          (migráció miatt megőrizve, alapért.: /data/routes)
  SAMPLES_DIR       minta fájlok              (alapért.: /samples)
  DB_PATH           SQLite adatbázis          (alapért.: /data/bringaterv.db)
  MULTI_DATA_DIR    per-user mappák           (alapért.: /data/users)
  ADMIN_EMAIL       admin email               (alapért.: admin@bringaterv.local)
  ADMIN_PASSWORD    admin jelszó
  JWT_SECRET        JWT aláíró kulcs
  JWT_EXPIRY_DAYS   token élettartam napban   (alapért.: 30)
"""

import logging
import os

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

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("bringaterv")
