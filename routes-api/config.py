"""
Bringaterv API – konfiguráció és logging.

Környezeti változók:
  DATA_DIR          (migráció miatt megőrizve, alapért.: /data/routes)
  SAMPLES_DIR       minta fájlok              (alapért.: /samples)
  DB_PATH           SQLite adatbázis          (alapért.: /data/bringaterv.db)
  MULTI_DATA_DIR    per-user mappák           (alapért.: /data/users)
  ADMIN_EMAIL       admin email               (alapért.: admin@bringaterv.local)
  ADMIN_PASSWORD    admin jelszó
  JWT_SECRET        JWT aláíró kulcs (üresen / gyengén: generált, /data/jwt_secret)
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
JWT_SECRET      = os.environ.get("JWT_SECRET",     "")
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


# ── JWT kulcs: gyenge / alapértelmezett érték helyett saját, tartós véletlen kulcs ─
# A repóban szereplő példaértékekkel bárki hamisíthatna belépést, ezért ilyenkor
# a szerver első induláskor generál egyet: /data/jwt_secret (minden worker ugyanazt olvassa).
_WEAK_SECRETS = {"", "change-me-in-production", "change-me-please", "changeme", "secret"}


def _persistent_secret() -> str:
    import secrets
    import time
    path = os.path.join(os.path.dirname(DB_PATH) or "/data", "jwt_secret")
    if not os.path.isfile(path):
        # Előbb ideiglenes fájlba írjuk, majd atomikusan a helyére linkeljük – így a
        # párhuzamosan induló workerek sosem olvasnak félkész (üres) kulcsot.
        tmp = f"{path}.{os.getpid()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_urlsafe(48))
        try:
            os.link(tmp, path)
            log.warning("JWT_SECRET nincs megadva (vagy alapértelmezett) – generált kulcs: %s", path)
        except FileExistsError:
            pass
        finally:
            os.remove(tmp)
    for _ in range(50):
        with open(path) as f:
            secret = f.read().strip()
        if len(secret) >= 32:
            return secret
        time.sleep(0.1)
    raise RuntimeError(f"Érvénytelen JWT kulcsfájl: {path}")


if JWT_SECRET in _WEAK_SECRETS or len(JWT_SECRET) < 16:
    JWT_SECRET = _persistent_secret()
