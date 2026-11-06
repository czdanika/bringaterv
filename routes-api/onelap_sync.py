"""Bringaterv – automatikus OnelapFit (Magene) import (háttér-szinkron).

Felhasználónként bekapcsolható (Könyvtár → Import → OnelapFitből ablak): adott
időközönként (5 / 15 / 30 / 60 perc) lekérdezi az új OnelapFit-edzéseket, és a
GPS-eseket ugyanúgy importálja, mint a kézi import. Az Onelapnak nincs webhookja,
ezért csak időközös ellenőrzés van.

Egy kör az utolsó LOOKBACK_DAYS nap edzéseit nézi (a bekapcsolás előttieket nem):
a később szinkronizált (pl. csak másnap feltöltött) edzés is bekerül. Kihagyja a
már importáltat, a könyvtárból töröltet (tiltólista), a GPS nélkülit, és – ha az
ismétlődés-védelem be van kapcsolva – a más forrásból (Strava, Garmin) meglévőt.

Gunicorn több workerrel fut → fájlzár: csak egy worker szinkronizál.
Állapot: /data/users/<uid>/onelap_sync.json
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
_LOCK_PATH = os.path.join(os.path.dirname(MULTI_DATA_DIR.rstrip("/")) or "/data", "onelap_sync.lock")

_DEFAULT = {
    "enabled": False,
    "interval_min": DEFAULT_INTERVAL,
    "enabled_ts": None,      # bekapcsolás ideje – az ennél 1 nappal korábbi edzéseket nem hozza
    "last_check": None,
    "last_error": None,
    "last_imported": 0,
    "total_imported": 0,     # a kliens ebből veszi észre az újat
    "last_names": [],
    "skip_ids": [],          # GPS nélküli / hibás edzések – nem próbáljuk újra
}


def _path(user_id: str) -> str:
    return os.path.join(MULTI_DATA_DIR, user_id, "onelap_sync.json")


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
        self.path = os.path.join(MULTI_DATA_DIR, user_id, ".onelap_import.lock")
        self.f = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.f = open(self.path, "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def sync_user(user_id: str) -> dict:
    """Egy kör: új OnelapFit-edzések lekérdezése és importja. Az állapotot menti és visszaadja."""
    from onelap_service import (OnelapApiError, OnelapAuthError, _delete_user_onelap,
                                _list_rides, _load_onelap_deny, onelap_import_activity,
                                onelap_session)
    from strava_sync import _notify_records, _notify_workout
    from utils import _load_index

    data = load_sync(user_id)
    data["last_check"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data["last_imported"] = 0
    data["last_error"] = None

    try:
        sess = onelap_session(user_id)
    except OnelapAuthError:
        _delete_user_onelap(user_id)
        sess = None
    except OnelapApiError as exc:
        data["last_error"] = str(exc)
        save_sync(user_id, data)
        return data
    if sess is None:
        data["last_error"] = "Nincs érvényes OnelapFit-kapcsolat – csatlakozz újra a Beállításokban."
        _alert_connection(user_id, data)
        save_sync(user_id, data)
        return data
    data["conn_alerted"] = False

    now = int(time.time())
    start = max(now - LOOKBACK_DAYS * 86400, int(data.get("enabled_ts") or now) - 86400)
    try:
        rides = _list_rides(sess, start, now + 86400)
    except OnelapAuthError:
        _delete_user_onelap(user_id)
        data["last_error"] = "Az OnelapFit elutasította a hozzáférést – csatlakozz újra a Beállításokban."
        _alert_connection(user_id, data)
        save_sync(user_id, data)
        return data
    except OnelapApiError as exc:
        data["last_error"] = str(exc)
        save_sync(user_id, data)
        return data

    routes_dir = os.path.join(MULTI_DATA_DIR, user_id, "routes")
    idx_path = os.path.join(routes_dir, "index.json")
    have = {r.get("onelap_id") for r in _load_index(idx_path) if r.get("onelap_id")}
    deny = _load_onelap_deny(user_id)
    skip = set(data.get("skip_ids") or [])
    dedup = import_dedup_enabled(user_id)
    todo = sorted((r for r in rides
                   if r.get("did") and (r.get("distance") or 0) > 0
                   and str(r["did"]) not in have and str(r["did"]) not in deny
                   and str(r["did"]) not in skip),
                  key=lambda r: int(r.get("start_time") or 0))

    names, new_ids = [], []
    for r in todo[:MAX_IMPORTS_PER_RUN]:            # a maradékot a következő kör hozza
        did = str(r["did"])
        try:
            with _UserLock(user_id):
                res = onelap_import_activity(sess, user_id, did, int(r.get("start_time") or 0), dedup=dedup)
        except OnelapApiError as exc:
            data["last_error"] = str(exc)
            break
        except OnelapAuthError:
            data["last_error"] = "Az OnelapFit elutasította a hozzáférést – csatlakozz újra a Beállításokban."
            break
        if not res.get("ok"):
            skip.add(did)                           # pl. nincs GPS – nem próbáljuk újra
        elif res.get("reason") == "duplicate":
            skip.add(did)                           # más forrásból már megvan
        elif not res.get("skipped"):
            e = res["entry"]
            names.append(e.get("name") or did)
            new_ids.append(e["id"])
            _notify_workout(user_id, e)

    data["skip_ids"] = sorted(skip)[-500:]
    data["last_imported"] = len(names)
    data["total_imported"] = int(data.get("total_imported") or 0) + len(names)
    if names:
        data["last_names"] = names[-5:]
        log.info("Onelap auto-import (%s): %d új edzés", user_id, len(names))
        _notify_records(user_id, idx_path, new_ids)
    save_sync(user_id, data)
    return data


def _alert_connection(user_id: str, data: dict) -> None:
    """Kapcsolati hiba – csak egyszer szólunk, amíg meg nem javul."""
    if data.get("conn_alerted"):
        return
    try:
        import notify
        notify.send(user_id, "connection", "⚠️ OnelapFit-kapcsolat megszakadt",
                    data.get("last_error") or "Csatlakozz újra a Beállításokban.",
                    url="./index.html?settings=onelap", tag="onelap-connection")
        data["conn_alerted"] = True
    except Exception as exc:
        log.warning("Értesítés (Onelap kapcsolat) hiba: %s", exc)


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
                    log.info("Onelap auto-sync ütemező aktív (pid %s)", os.getpid())
                except OSError:
                    f.close()                  # egy másik worker már fut
            if lock_file is not None and os.path.isdir(MULTI_DATA_DIR):
                for uid in sorted(os.listdir(MULTI_DATA_DIR)):
                    if os.path.isfile(_path(uid)) and _due(load_sync(uid)):
                        sync_user(uid)
        except Exception as exc:               # a szál sosem állhat le
            log.warning("Onelap auto-sync hiba: %s", exc)
        time.sleep(_TICK_S)


_started = False


def start_scheduler():
    global _started
    if _started or os.environ.get("ONELAP_AUTO_SYNC", "true").lower() == "false":
        return
    _started = True
    threading.Thread(target=_loop, name="onelap-auto-sync", daemon=True).start()
