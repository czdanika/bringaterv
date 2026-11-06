"""Bringaterv – automatikus import a hivatalos API-s eszközökhöz (Wahoo, Polar).

Ugyanaz a működés, mint az onelap_sync / garmin_sync: felhasználónként bekapcsolható,
5 / 15 / 30 / 60 percenként lekérdezi az új edzéseket, és importálja őket (FIT → GPX).
A bekapcsolás előttieket nem hozza, a törölteket nem hozza vissza, a GPS nélkülieket
és – ismétlődés-védelemnél – a más forrásból meglévőket kihagyja.

Gunicorn több workerrel fut → fájlzár: csak egy worker szinkronizál.
Állapot: /data/users/<uid>/<provider>_sync.json
"""

import fcntl
import json
import os
import threading
import time
from datetime import datetime, timezone

from config import MULTI_DATA_DIR, log
from device_import import LABELS, PROVIDERS, DeviceApiError, DeviceAuthError, load_tokens
from storage import import_dedup_enabled

INTERVALS = (5, 15, 30, 60)
DEFAULT_INTERVAL = 15
MAX_IMPORTS_PER_RUN = 10
LOOKBACK_DAYS = 7
_TICK_S = 60
_LOCK_PATH = os.path.join(os.path.dirname(MULTI_DATA_DIR.rstrip("/")) or "/data", "device_sync.lock")

_DEFAULT = {
    "enabled": False, "interval_min": DEFAULT_INTERVAL, "enabled_ts": None,
    "last_check": None, "last_error": None, "last_imported": 0, "total_imported": 0,
    "last_names": [], "skip_ids": [],
}


def _service(provider: str):
    if provider == "wahoo":
        import wahoo_service as s
    elif provider == "polar":
        import polar_service as s
    else:
        raise ValueError(provider)
    return s


def _path(user_id: str, provider: str) -> str:
    return os.path.join(MULTI_DATA_DIR, user_id, f"{provider}_sync.json")


def load_sync(user_id: str, provider: str) -> dict:
    data = dict(_DEFAULT)
    try:
        with open(_path(user_id, provider), encoding="utf-8") as f:
            data.update(json.load(f) or {})
    except (OSError, json.JSONDecodeError):
        pass
    return data


def save_sync(user_id: str, provider: str, data: dict) -> None:
    path = _path(user_id, provider)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)


def public(data: dict) -> dict:
    return {k: data.get(k) for k in ("enabled", "interval_min", "last_check", "last_error",
                                     "last_imported", "total_imported", "last_names")} | {"intervals": INTERVALS}


def update_settings(user_id: str, provider: str, enabled: bool, interval_min: int) -> dict:
    data = load_sync(user_id, provider)
    if interval_min not in INTERVALS:
        interval_min = DEFAULT_INTERVAL
    if enabled and not data["enabled"]:
        data["enabled_ts"] = int(time.time())      # az elmúlt 1 naptól indul
        data["last_check"] = None
        data["last_error"] = None
    data["enabled"] = bool(enabled)
    data["interval_min"] = interval_min
    save_sync(user_id, provider, data)
    return data


class UserLock:
    """A kézi import és a háttérkör ne importáljon egyszerre (dupla bejegyzés)."""
    def __init__(self, user_id: str, provider: str):
        self.path = os.path.join(MULTI_DATA_DIR, user_id, f".{provider}_import.lock")
        self.f = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.f = open(self.path, "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def sync_user(user_id: str, provider: str) -> dict:
    """Egy kör: új edzések lekérdezése és importja. Az állapotot menti és visszaadja."""
    from strava_sync import _notify_records, _notify_workout
    svc = _service(provider)
    label = LABELS[provider]
    data = load_sync(user_id, provider)
    data["last_check"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data["last_imported"] = 0
    data["last_error"] = None

    try:
        items = svc.list_activities(user_id, days=LOOKBACK_DAYS, limit=50)
    except DeviceAuthError:
        data["last_error"] = f"A {label}-kapcsolat nem él – csatlakozz újra a Beállításokban."
        _alert_connection(user_id, provider, data)
        save_sync(user_id, provider, data)
        return data
    except DeviceApiError as exc:
        data["last_error"] = str(exc)
        save_sync(user_id, provider, data)
        return data
    data["conn_alerted"] = False

    now = int(time.time())
    start = max(now - LOOKBACK_DAYS * 86400, int(data.get("enabled_ts") or now) - 86400)
    dedup = import_dedup_enabled(user_id)
    skip = set(str(x) for x in (data.get("skip_ids") or []))
    wanted = ("new",) if dedup else ("new", "likely_duplicate")
    todo = sorted((a for a in items if a["duplicate_status"] in wanted
                   and (a.get("start_ts") or 0) >= start and str(a["id"]) not in skip),
                  key=lambda a: a.get("start_ts") or 0)

    names, new_ids = [], []
    for a in todo[:MAX_IMPORTS_PER_RUN]:            # a maradékot a következő kör hozza
        try:
            with UserLock(user_id, provider):
                res = svc.import_activity(user_id, a["id"], dedup=dedup)
        except (DeviceApiError, DeviceAuthError) as exc:
            data["last_error"] = str(exc)
            break
        if not res.get("ok") or res.get("reason") == "duplicate":
            skip.add(str(a["id"]))                  # nincs GPS / más forrásból már megvan
        elif not res.get("skipped"):
            e = res["entry"]
            names.append(e.get("name") or str(a["id"]))
            new_ids.append(e["id"])
            _notify_workout(user_id, e)

    data["skip_ids"] = sorted(skip)[-500:]
    data["last_imported"] = len(names)
    data["total_imported"] = int(data.get("total_imported") or 0) + len(names)
    if names:
        data["last_names"] = names[-5:]
        log.info("%s auto-import (%s): %d új edzés", label, user_id, len(names))
        _notify_records(user_id, os.path.join(MULTI_DATA_DIR, user_id, "routes", "index.json"), new_ids)
    save_sync(user_id, provider, data)
    return data


def _alert_connection(user_id: str, provider: str, data: dict) -> None:
    if data.get("conn_alerted"):
        return
    try:
        import notify
        notify.send(user_id, "connection", f"⚠️ {LABELS[provider]}-kapcsolat megszakadt",
                    data.get("last_error") or "Csatlakozz újra a Beállításokban.",
                    url=f"./index.html?settings={provider}", tag=f"{provider}-connection")
        data["conn_alerted"] = True
    except Exception as exc:
        log.warning("Értesítés (%s kapcsolat) hiba: %s", provider, exc)


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
                    lock_file = f
                    log.info("Wahoo/Polar auto-sync ütemező aktív (pid %s)", os.getpid())
                except OSError:
                    f.close()
            if lock_file is not None and os.path.isdir(MULTI_DATA_DIR):
                for uid in sorted(os.listdir(MULTI_DATA_DIR)):
                    for provider in PROVIDERS:
                        if (os.path.isfile(_path(uid, provider)) and load_tokens(uid, provider)
                                and _due(load_sync(uid, provider))):
                            sync_user(uid, provider)
        except Exception as exc:               # a szál sosem állhat le
            log.warning("Wahoo/Polar auto-sync hiba: %s", exc)
        time.sleep(_TICK_S)


_started = False


def start_scheduler():
    global _started
    if _started or os.environ.get("DEVICE_AUTO_SYNC", "true").lower() == "false":
        return
    _started = True
    threading.Thread(target=_loop, name="device-auto-sync", daemon=True).start()
