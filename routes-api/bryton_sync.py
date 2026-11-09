"""Bringaterv – automatikus Bryton import (háttér-szinkron) + lejárat-figyelmeztetés.

Mint az onelap_sync: felhasználónként bekapcsolható (Beállítások → Bryton, vagy az import
ablak teteje), 5 / 15 / 30 / 60 percenként lekérdezi az új edzéseket és importálja őket.
A Bryton-belépés 7 napig érvényes (refresh nincs) → a lejárat előtt egy nappal push-
értesítés, lejáratkor még egy; az új belépés ezeket visszaállítja (api_bryton.connect).

Gunicorn több workerrel fut → fájlzár: csak egy worker szinkronizál.
Állapot: /data/users/<uid>/bryton_sync.json
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
LOOKBACK_ITEMS = 20          # ennyi legutóbbi edzést néz egy kör
_TICK_S = 60
_WARN_BEFORE_S = 24 * 3600
_LOCK_PATH = os.path.join(os.path.dirname(MULTI_DATA_DIR.rstrip("/")) or "/data", "bryton_sync.lock")

_DEFAULT = {
    "enabled": False, "interval_min": DEFAULT_INTERVAL, "enabled_ts": None,
    "last_check": None, "last_error": None, "last_imported": 0, "total_imported": 0,
    "last_names": [], "skip_ids": [], "expiry_alerted": False, "conn_alerted": False,
}


def _path(user_id: str) -> str:
    return os.path.join(MULTI_DATA_DIR, user_id, "bryton_sync.json")


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
        data["enabled_ts"] = int(time.time())     # a bekapcsolás előtti (1 napnál régebbi) edzéseket nem hozza
        data["last_check"] = None
        data["last_error"] = None
    data["enabled"] = bool(enabled)
    data["interval_min"] = interval_min
    save_sync(user_id, data)
    return data


class _UserLock:
    """A kézi import és a háttérkör ne importáljon egyszerre."""
    def __init__(self, user_id: str):
        self.path = os.path.join(MULTI_DATA_DIR, user_id, ".bryton_import.lock")
        self.f = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.f = open(self.path, "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def _notify(user_id: str, title: str, body: str, tag: str) -> None:
    try:
        import notify
        notify.send(user_id, "connection", title, body, url="./index.html?settings=bryton", tag=tag)
    except Exception as exc:
        log.warning("Értesítés (Bryton) hiba: %s", exc)


def check_expiry(user_id: str, data: dict) -> None:
    """Lejárat előtt 1 nappal (és lejáratkor) push – csak egyszer."""
    from bryton_service import _load
    conn = _load(user_id)
    exp = int(conn.get("expires_at") or 0)
    if not conn.get("token") or not exp:
        return
    left = exp - time.time()
    if left <= 0 and not data.get("conn_alerted"):
        _notify(user_id, "⚠️ Lejárt a Bryton-belépés",
                "Az automatikus import szünetel – csatlakozz újra a Beállításokban.", "bryton-expired")
        data["conn_alerted"] = True
    elif 0 < left <= _WARN_BEFORE_S and not data.get("expiry_alerted"):
        _notify(user_id, "🔑 Holnap lejár a Bryton-belépés",
                "Lépj be újra a Beállítások → Bryton alatt, hogy az import és a küldés ne álljon le.", "bryton-expiry")
        data["expiry_alerted"] = True


def sync_user(user_id: str) -> dict:
    """Egy kör: új Bryton-edzések lekérdezése és importja."""
    from bryton_service import BrytonApiError, BrytonAuthError, bryton_import_activity, bryton_session, list_raw, load_deny
    from strava_sync import _notify_records, _notify_workout
    from utils import _load_index

    data = load_sync(user_id)
    data["last_check"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data["last_imported"] = 0
    data["last_error"] = None
    check_expiry(user_id, data)
    try:
        token = bryton_session(user_id)
    except BrytonAuthError as exc:
        data["last_error"] = f"{exc} Csatlakozz újra a Beállításokban."
        save_sync(user_id, data)
        return data
    if token is None:
        data["last_error"] = "Nincs Bryton-kapcsolat – csatlakozz a Beállításokban."
        save_sync(user_id, data)
        return data

    try:
        rows = list_raw(token)[:LOOKBACK_ITEMS]
    except BrytonAuthError:
        data["last_error"] = "A Bryton elutasította a hozzáférést – csatlakozz újra a Beállításokban."
        save_sync(user_id, data)
        return data
    except BrytonApiError as exc:
        data["last_error"] = str(exc)
        save_sync(user_id, data)
        return data

    idx_path = os.path.join(MULTI_DATA_DIR, user_id, "routes", "index.json")
    have = {str(r.get("bryton_id")) for r in _load_index(idx_path) if r.get("bryton_id")}
    deny, skip = load_deny(user_id), set(data.get("skip_ids") or [])
    # a bekapcsolás előtti napoknál régebbit nem hozza (a lista dátuma elég ehhez)
    since = int(data.get("enabled_ts") or time.time()) - 86400
    todo = [r for r in rows
            if str(r["_id"]) not in have and str(r["_id"]) not in deny and str(r["_id"]) not in skip
            and float((r.get("summary") or {}).get("total_distance") or 0) > 0
            and int(r.get("local_start_time") or 0) >= since - 14 * 3600]
    todo.reverse()                                   # régebbi elöl

    names, new_ids, dedup = [], [], import_dedup_enabled(user_id)
    for r in todo[:MAX_IMPORTS_PER_RUN]:
        rid = str(r["_id"])
        try:
            with _UserLock(user_id):
                res = bryton_import_activity(token, user_id, rid, dedup=dedup)
        except BrytonAuthError:
            data["last_error"] = "Lejárt a Bryton-belépés – csatlakozz újra a Beállításokban."
            break
        except BrytonApiError as exc:
            data["last_error"] = str(exc)
            break
        if not res.get("ok") or res.get("reason") == "duplicate":
            skip.add(rid)                            # nincs GPS / más forrásból megvan – nem próbáljuk újra
        elif not res.get("skipped"):
            e = res["entry"]
            names.append(e.get("name") or rid)
            new_ids.append(e["id"])
            _notify_workout(user_id, e)

    data["skip_ids"] = sorted(skip)[-500:]
    data["last_imported"] = len(names)
    data["total_imported"] = int(data.get("total_imported") or 0) + len(names)
    if names:
        data["last_names"] = names[-5:]
        log.info("Bryton auto-import (%s): %d új edzés", user_id, len(names))
        _notify_records(user_id, idx_path, new_ids)
    save_sync(user_id, data)
    return data


def _due(data: dict) -> bool:
    if not data.get("enabled"):
        return False
    last = data.get("last_check")
    if not last:
        return True
    try:
        return time.time() - datetime.fromisoformat(last).timestamp() >= int(data.get("interval_min") or DEFAULT_INTERVAL) * 60 - 5
    except ValueError:
        return True


def _loop():
    lock_file, last_expiry_scan = None, 0.0
    while True:
        try:
            if lock_file is None:
                f = open(_LOCK_PATH, "w")
                try:
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    lock_file = f
                    log.info("Bryton auto-sync ütemező aktív (pid %s)", os.getpid())
                except OSError:
                    f.close()
            if lock_file is not None and os.path.isdir(MULTI_DATA_DIR):
                scan_expiry = time.time() - last_expiry_scan > 3600     # óránként: lejárat-figyelés mindenkinél
                if scan_expiry:
                    last_expiry_scan = time.time()
                for uid in sorted(os.listdir(MULTI_DATA_DIR)):
                    if not os.path.isfile(os.path.join(MULTI_DATA_DIR, uid, "bryton.json")):
                        continue
                    data = load_sync(uid)
                    if _due(data):
                        sync_user(uid)
                    elif scan_expiry:
                        before = (data.get("expiry_alerted"), data.get("conn_alerted"))
                        check_expiry(uid, data)
                        if (data.get("expiry_alerted"), data.get("conn_alerted")) != before:
                            save_sync(uid, data)
        except Exception as exc:
            log.warning("Bryton auto-sync hiba: %s", exc)
        time.sleep(_TICK_S)


_started = False


def start_scheduler():
    global _started
    if _started or os.environ.get("BRYTON_AUTO_SYNC", "true").lower() == "false":
        return
    _started = True
    threading.Thread(target=_loop, name="bryton-auto-sync", daemon=True).start()
