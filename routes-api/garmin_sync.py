"""Bringaterv – automatikus Garmin Connect import (háttér-szinkron).

Felhasználónként bekapcsolható (Könyvtár → Import → Garminból ablak): adott
időközönként (5 / 15 / 30 / 60 perc) lekérdezi az új Garmin-edzéseket, és a
GPS-eseket ugyanúgy importálja, mint a kézi import (eredeti FIT → GPX). A Dreeve
Garmin-connectora is így dolgozik: időközös lekérdezés, a FIT-ek letöltése.

Egy kör a legutóbbi 50 edzésből az utolsó LOOKBACK_DAYS napot nézi (a bekapcsolás
előttieket nem). Kihagyja a már importáltat, a könyvtárból töröltet, a GPS nélkülit,
és – ha az ismétlődés-védelem be van kapcsolva – a más forrásból meglévőt.

Nem hivatalos Garmin API: körönként legfeljebb MAX_IMPORTS_PER_RUN letöltés, a
429-es (túl sok kérés) válasznál a kör kimarad.

Gunicorn több workerrel fut → fájlzár: csak egy worker szinkronizál.
Állapot: /data/users/<uid>/garmin_sync.json
"""

import fcntl
import json
import os
import threading
import time
from datetime import datetime, timezone

from config import MULTI_DATA_DIR, log
from storage import import_dedup_enabled

INTERVALS = (5, 15, 30, 60)
DEFAULT_INTERVAL = 15
MAX_IMPORTS_PER_RUN = 10
LOOKBACK_DAYS = 7
_TICK_S = 60
_LOCK_PATH = os.path.join(os.path.dirname(MULTI_DATA_DIR.rstrip("/")) or "/data", "garmin_sync.lock")

_DEFAULT = {
    "enabled": False,
    "interval_min": DEFAULT_INTERVAL,
    "enabled_ts": None,      # bekapcsolás ideje – az ennél 1 nappal korábbi edzéseket nem hozza
    "last_check": None,
    "last_error": None,
    "last_imported": 0,
    "total_imported": 0,     # a kliens ebből veszi észre az újat
    "last_names": [],
    "skip_ids": [],          # GPS nélküli / hibás / duplikátum edzések – nem próbáljuk újra
}


def _path(user_id: str) -> str:
    return os.path.join(MULTI_DATA_DIR, user_id, "garmin_sync.json")


def load_sync(user_id: str) -> dict:
    data = dict(_DEFAULT)
    try:
        with open(_path(user_id), encoding="utf-8") as f:
            data.update(json.load(f) or {})
    except (OSError, json.JSONDecodeError):
        pass
    return data


def save_sync(user_id: str, data: dict) -> None:
    path = _path(user_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)


def public(data: dict) -> dict:
    return {k: data.get(k) for k in ("enabled", "interval_min", "last_check", "last_error",
                                     "last_imported", "total_imported", "last_names")} | {"intervals": INTERVALS}


def update_settings(user_id: str, enabled: bool, interval_min: int) -> dict:
    data = load_sync(user_id)
    if interval_min not in INTERVALS:
        interval_min = DEFAULT_INTERVAL
    if enabled and not data["enabled"]:
        # Bekapcsoláskor az elmúlt 1 nap edzéseitől indulunk (a régieket a kézi import hozza)
        data["enabled_ts"] = int(time.time())
        data["last_check"] = None
        data["last_error"] = None
    data["enabled"] = bool(enabled)
    data["interval_min"] = interval_min
    save_sync(user_id, data)
    return data


class _UserLock:
    """A kézi import és a háttérkör ne importáljon egyszerre (dupla bejegyzés)."""
    def __init__(self, user_id: str):
        self.path = os.path.join(MULTI_DATA_DIR, user_id, ".garmin_import.lock")
        self.f = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.f = open(self.path, "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def _start_ts(a: dict) -> int:
    try:
        return int(datetime.fromisoformat(a["start_date"]).timestamp())
    except (KeyError, TypeError, ValueError):
        return 0


def sync_user(user_id: str) -> dict:
    """Egy kör: új Garmin-edzések lekérdezése és importja. Az állapotot menti és visszaadja."""
    from garmin_service import (GarminConnectAuthenticationError, GarminConnectTooManyRequestsError,
                                garmin_client, garmin_import_activity, garmin_list_activities)
    from strava_sync import _notify_records, _notify_workout

    data = load_sync(user_id)
    data["last_check"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data["last_imported"] = 0
    data["last_error"] = None

    try:
        garmin = garmin_client(user_id)
        if garmin is None:
            data["last_error"] = "Nincs Garmin-kapcsolat – csatlakozz a Beállításokban."
            _alert_connection(user_id, data)
            save_sync(user_id, data)
            return data
        items = garmin_list_activities(garmin, user_id, limit=50)
    except GarminConnectAuthenticationError:
        data["last_error"] = "A Garmin elutasította a belépést – csatlakozz újra a Beállításokban."
        _alert_connection(user_id, data)
        save_sync(user_id, data)
        return data
    except GarminConnectTooManyRequestsError:
        data["last_error"] = "A Garmin átmenetileg korlátozza a lekérdezést – a következő körben újra próbálja."
        save_sync(user_id, data)
        return data
    except Exception as exc:
        data["last_error"] = f"Garmin lekérdezés sikertelen: {exc}"
        save_sync(user_id, data)
        return data
    data["conn_alerted"] = False

    now = int(time.time())
    start = max(now - LOOKBACK_DAYS * 86400, int(data.get("enabled_ts") or now) - 86400)
    dedup = import_dedup_enabled(user_id)
    skip = set(str(x) for x in (data.get("skip_ids") or []))
    wanted = ("new",) if dedup else ("new", "likely_duplicate")
    todo = sorted((a for a in items
                   if a["duplicate_status"] in wanted and _start_ts(a) >= start and str(a["id"]) not in skip),
                  key=_start_ts)

    names, new_ids = [], []
    idx_path = os.path.join(MULTI_DATA_DIR, user_id, "routes", "index.json")
    for a in todo[:MAX_IMPORTS_PER_RUN]:            # a maradékot a következő kör hozza
        aid = a["id"]
        try:
            with _UserLock(user_id):
                res = garmin_import_activity(garmin, user_id, aid, dedup=dedup)
        except GarminConnectTooManyRequestsError:
            data["last_error"] = "A Garmin átmenetileg korlátozza a letöltést – a következő körben folytatja."
            break
        except Exception as exc:
            data["last_error"] = f"Garmin import sikertelen: {exc}"
            break
        if not res.get("ok") or res.get("reason") == "duplicate":
            skip.add(str(aid))                      # nincs GPS / más forrásból már megvan
        elif not res.get("skipped"):
            e = res["entry"]
            names.append(e.get("name") or str(aid))
            new_ids.append(e["id"])
            _notify_workout(user_id, e)

    data["skip_ids"] = sorted(skip)[-500:]
    data["last_imported"] = len(names)
    data["total_imported"] = int(data.get("total_imported") or 0) + len(names)
    if names:
        data["last_names"] = names[-5:]
        log.info("Garmin auto-import (%s): %d új edzés", user_id, len(names))
        _notify_records(user_id, idx_path, new_ids)
    save_sync(user_id, data)
    return data


def _alert_connection(user_id: str, data: dict) -> None:
    """Kapcsolati hiba – csak egyszer szólunk, amíg meg nem javul."""
    if data.get("conn_alerted"):
        return
    try:
        import notify
        notify.send(user_id, "connection", "⚠️ Garmin-kapcsolat megszakadt",
                    data.get("last_error") or "Csatlakozz újra a Beállításokban.",
                    url="./index.html?settings=garmin", tag="garmin-connection")
        data["conn_alerted"] = True
    except Exception as exc:
        log.warning("Értesítés (Garmin kapcsolat) hiba: %s", exc)


def _due(data: dict) -> bool:
    if not data.get("enabled"):
        return False
    last = data.get("last_check")
    if not last:
        return True
    try:
        elapsed = time.time() - datetime.fromisoformat(last).timestamp()
    except ValueError:
        return True
    return elapsed >= int(data.get("interval_min") or DEFAULT_INTERVAL) * 60 - 5


def _loop():
    lock_file = None
    while True:
        try:
            if lock_file is None:
                f = open(_LOCK_PATH, "w")
                try:
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    lock_file = f              # ez a worker szinkronizál
                    log.info("Garmin auto-sync ütemező aktív (pid %s)", os.getpid())
                except OSError:
                    f.close()                  # egy másik worker már fut
            if lock_file is not None and os.path.isdir(MULTI_DATA_DIR):
                for uid in sorted(os.listdir(MULTI_DATA_DIR)):
                    if os.path.isfile(_path(uid)) and _due(load_sync(uid)):
                        sync_user(uid)
        except Exception as exc:               # a szál sosem állhat le
            log.warning("Garmin auto-sync hiba: %s", exc)
        time.sleep(_TICK_S)


_started = False


def start_scheduler():
    global _started
    if _started or os.environ.get("GARMIN_AUTO_SYNC", "true").lower() == "false":
        return
    _started = True
    threading.Thread(target=_loop, name="garmin-auto-sync", daemon=True).start()
