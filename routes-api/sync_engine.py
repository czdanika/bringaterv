"""Bringaterv – közös automatikus import-motor a komputer-integrációkhoz.

Egy integráció (OnelapFit, iGPSport, Bryton, Garmin…) csak a saját különbségeit adja meg
egy `SyncProvider` alosztályban:

    open(user_id)                       → munkamenet / token (None: nincs kapcsolat)
    candidates(sess, user_id, data, dedup)
                                        → [(azonosító, sor), …] az importálandók, régebbi elöl
                                          (a már meglévőt, töröltet, kihagyottat már kiszűrve)
    import_one(sess, user_id, rid, row, dedup) → az import eredménye ({ok, skipped, reason, entry})
    expires_at(user_id)                 → a belépés lejárata (epoch) – csak lejáró belépésnél

Hibát `SyncError`-ral jelez (üzenet a felhasználónak; alert=True: push-értesítés a
megszakadt kapcsolatról, egyszer, amíg meg nem javul). Minden más – állapotfájl
(<uid>/<key>_sync.json), beállítások, a kézi import és a háttérkör közti zár, ütemező
(csak egy gunicorn-worker fut), értesítés az új edzésről és a rekordokról, lejárat-
figyelmeztetés – itt van, egyszer.

A modul-szintű API, amit az api_*.py-k használnak, változatlan: az integráció
`<key>_sync.py`-ja az `AutoSync` példány metódusait adja tovább (load_sync, save_sync,
public, update_settings, _UserLock, sync_user, start_scheduler).
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
_TICK_S = 60
_WARN_BEFORE_S = 24 * 3600

_DEFAULT = {
    "enabled": False,
    "interval_min": DEFAULT_INTERVAL,
    "enabled_ts": None,      # bekapcsolás ideje – az ennél 1 nappal korábbi edzéseket nem hozza
    "last_check": None,
    "last_error": None,
    "last_imported": 0,
    "total_imported": 0,     # a kliens ebből veszi észre az újat
    "last_names": [],
    "skip_ids": [],          # GPS nélküli / más forrásból meglévő edzések – nem próbáljuk újra
    "expiry_alerted": False, # „holnap lejár” push elment
    "expired_alerted": False,# „lejárt” push elment
    "conn_alerted": False,   # „megszakadt a kapcsolat” push elment (amíg meg nem javul)
}


class SyncError(Exception):
    """A felhasználónak szóló hiba; alert=True: push a megszakadt kapcsolatról."""
    def __init__(self, message: str, alert: bool = False):
        super().__init__(message)
        self.alert = alert


class SyncProvider:
    key = ""                 # "igpsport" – állapotfájl, zárak, beállítás-link
    label = ""               # „iGPSport” – üzenetekben
    article = "az"           # „az iGPSport” / „a Bryton”
    env_flag = ""            # IGPSPORT_AUTO_SYNC=false → nincs háttérkör
    conn_file = None         # ha megadva (pl. "igpsport.json"): ezekre a felhasználókra fut az óránkénti
                             # lejárat-figyelés is; különben csak akinek van állapotfájlja
    alert_on_failure = False # kapcsolati hibánál push (egyszer, amíg meg nem javul)
    expiry_hint = ""         # lejárat-üzenet kiegészítése (pl. „(7 naponta kell)”)

    def open(self, user_id: str):
        raise NotImplementedError

    def candidates(self, sess, user_id: str, data: dict, dedup: bool) -> list:
        raise NotImplementedError

    def import_one(self, sess, user_id: str, rid: str, row, dedup: bool) -> dict:
        raise NotImplementedError

    def expires_at(self, user_id: str):
        return None

    # segédek az alosztályoknak
    @property
    def The(self) -> str:
        return f"{self.article[0].upper()}{self.article[1:]} {self.label}"

    def index_ids(self, user_id: str, field: str) -> set:
        """A könyvtárban már meglévő azonosítók (index.json <field>)."""
        from utils import _load_index
        idx = os.path.join(MULTI_DATA_DIR, user_id, "routes", "index.json")
        return {str(r.get(field)) for r in _load_index(idx) if r.get(field)}

    @staticmethod
    def since_ts(data: dict, lookback_days: int = None) -> int:
        """Az ennél régebbi edzéseket nem hozza: a bekapcsolás előtti nap (és legfeljebb lookback_days)."""
        now = int(time.time())
        since = int(data.get("enabled_ts") or now) - 86400
        return max(since, now - lookback_days * 86400) if lookback_days else since


class _UserLock:
    """A kézi import és a háttérkör ne importáljon egyszerre (dupla bejegyzés)."""
    def __init__(self, key: str, user_id: str):
        self.path = os.path.join(MULTI_DATA_DIR, user_id, f".{key}_import.lock")
        self.f = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.f = open(self.path, "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


class AutoSync:
    def __init__(self, provider: SyncProvider):
        self.p = provider
        self._started = False
        self._lock_path = os.path.join(os.path.dirname(MULTI_DATA_DIR.rstrip("/")) or "/data", f"{provider.key}_sync.lock")

    # ── állapot ──────────────────────────────────────────────────────────────
    def path(self, user_id: str) -> str:
        return os.path.join(MULTI_DATA_DIR, user_id, f"{self.p.key}_sync.json")

    def load_sync(self, user_id: str) -> dict:
        data = dict(_DEFAULT)
        try:
            with open(self.path(user_id), encoding="utf-8") as f:
                data.update(json.load(f) or {})
        except (OSError, json.JSONDecodeError):
            pass
        return data

    def save_sync(self, user_id: str, data: dict) -> None:
        path = self.path(user_id)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(path + ".tmp", path)

    @staticmethod
    def public(data: dict) -> dict:
        return {k: data.get(k) for k in ("enabled", "interval_min", "last_check", "last_error",
                                         "last_imported", "total_imported", "last_names")} | {"intervals": INTERVALS}

    def update_settings(self, user_id: str, enabled: bool, interval_min: int) -> dict:
        data = self.load_sync(user_id)
        if interval_min not in INTERVALS:
            interval_min = DEFAULT_INTERVAL
        if enabled and not data["enabled"]:
            # bekapcsoláskor az elmúlt 1 nap edzéseitől indulunk (a régieket a kézi import hozza)
            data["enabled_ts"] = int(time.time())
            data["last_check"] = None
            data["last_error"] = None
        data["enabled"] = bool(enabled)
        data["interval_min"] = interval_min
        self.save_sync(user_id, data)
        return data

    def reset_alerts(self, user_id: str) -> None:
        """Új belépés után: a lejárat- és kapcsolat-értesítések újra küldhetők."""
        data = self.load_sync(user_id)
        data["expiry_alerted"] = data["expired_alerted"] = data["conn_alerted"] = False
        self.save_sync(user_id, data)

    def user_lock(self, user_id: str) -> _UserLock:
        return _UserLock(self.p.key, user_id)

    # ── értesítések ──────────────────────────────────────────────────────────
    def _notify(self, user_id: str, title: str, body: str, tag: str) -> None:
        try:
            import notify
            notify.send(user_id, "connection", title, body, url=f"./index.html?settings={self.p.key}", tag=tag)
        except Exception as exc:
            log.warning("Értesítés (%s) hiba: %s", self.p.label, exc)

    def _alert_connection(self, user_id: str, data: dict) -> None:
        """Kapcsolati hiba – csak egyszer szólunk, amíg meg nem javul."""
        if data.get("conn_alerted"):
            return
        self._notify(user_id, f"{self.p.label}-kapcsolat megszakadt",
                     data.get("last_error") or "Csatlakozz újra a Beállításokban.", f"{self.p.key}-connection")
        data["conn_alerted"] = True

    def check_expiry(self, user_id: str, data: dict) -> None:
        """Lejáró belépésnél: 1 nappal előtte és lejáratkor push – mindkettő csak egyszer
        (az új belépés visszaállítja a jelzőket az api_<key>.connect-ben)."""
        exp = self.p.expires_at(user_id)
        if not exp:
            return
        left = exp - time.time()
        name = f"{self.p.article} {self.p.label}"
        if left <= 0 and not data.get("expired_alerted"):
            self._notify(user_id, f"Lejárt {name}-belépés",
                         f"Az automatikus import szünetel – csatlakozz újra a Beállításokban{self.p.expiry_hint}.", f"{self.p.key}-expired")
            data["expired_alerted"] = True
        elif 0 < left <= _WARN_BEFORE_S and not data.get("expiry_alerted"):
            self._notify(user_id, f"Holnap lejár {name}-belépés",
                         f"Lépj be újra a Beállítások → {self.p.label} alatt, hogy az automatikus import ne álljon le.", f"{self.p.key}-expiry")
            data["expiry_alerted"] = True

    # ── egy kör ──────────────────────────────────────────────────────────────
    def sync_user(self, user_id: str) -> dict:
        """Egy kör: új edzések lekérdezése és importja. Az állapotot menti és visszaadja."""
        from strava_sync import _notify_records, _notify_workout

        p = self.p
        data = self.load_sync(user_id)
        data["last_check"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        data["last_imported"] = 0
        data["last_error"] = None
        self.check_expiry(user_id, data)

        def fail(err: SyncError) -> dict:
            data["last_error"] = str(err)
            if err.alert and p.alert_on_failure:
                self._alert_connection(user_id, data)
            self.save_sync(user_id, data)
            return data

        dedup = import_dedup_enabled(user_id)
        try:
            sess = p.open(user_id)
            if sess is None:
                return fail(SyncError(f"Nincs {p.label}-kapcsolat – csatlakozz a Beállításokban.", alert=True))
            todo = p.candidates(sess, user_id, data, dedup)
        except SyncError as err:
            return fail(err)
        except Exception as exc:                     # váratlan hiba: a kör kimarad, a szál él
            return fail(SyncError(f"{p.label} lekérdezés sikertelen: {exc}"))
        if p.alert_on_failure:
            data["conn_alerted"] = False             # a kapcsolat újra működik

        skip = set(str(x) for x in (data.get("skip_ids") or []))
        names, new_ids = [], []
        for rid, row in todo[:MAX_IMPORTS_PER_RUN]:  # a maradékot a következő kör hozza
            try:
                with self.user_lock(user_id):
                    res = p.import_one(sess, user_id, rid, row, dedup)
            except SyncError as err:
                data["last_error"] = str(err)
                break
            except Exception as exc:
                data["last_error"] = f"{p.label} import sikertelen: {exc}"
                break
            if not res.get("ok") or res.get("reason") == "duplicate":
                skip.add(str(rid))                   # nincs GPS / más forrásból már megvan – nem próbáljuk újra
            elif not res.get("skipped"):
                e = res["entry"]
                names.append(e.get("name") or str(rid))
                new_ids.append(e["id"])
                _notify_workout(user_id, e)

        data["skip_ids"] = sorted(skip)[-500:]
        data["last_imported"] = len(names)
        data["total_imported"] = int(data.get("total_imported") or 0) + len(names)
        if names:
            data["last_names"] = names[-5:]
            log.info("%s auto-import (%s): %d új edzés", p.label, user_id, len(names))
            _notify_records(user_id, os.path.join(MULTI_DATA_DIR, user_id, "routes", "index.json"), new_ids)
        self.save_sync(user_id, data)
        return data

    # ── ütemező ──────────────────────────────────────────────────────────────
    @staticmethod
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

    def _loop(self):
        lock_file, last_expiry_scan = None, 0.0
        while True:
            try:
                if lock_file is None:
                    f = open(self._lock_path, "w")
                    try:
                        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        lock_file = f                # ez a worker szinkronizál
                        log.info("%s auto-sync ütemező aktív (pid %s)", self.p.label, os.getpid())
                    except OSError:
                        f.close()                    # egy másik worker már fut
                import integrations
                if lock_file is not None and os.path.isdir(MULTI_DATA_DIR) and integrations.is_enabled(self.p.key):
                    scan_expiry = bool(self.p.conn_file) and time.time() - last_expiry_scan > 3600
                    if scan_expiry:
                        last_expiry_scan = time.time()
                    for uid in sorted(os.listdir(MULTI_DATA_DIR)):
                        marker = self.p.conn_file or f"{self.p.key}_sync.json"
                        if not os.path.isfile(os.path.join(MULTI_DATA_DIR, uid, marker)):
                            continue
                        data = self.load_sync(uid)
                        if self._due(data):
                            self.sync_user(uid)
                        elif scan_expiry:            # óránként: lejárat-figyelés a kikapcsolt importnál is
                            before = (data.get("expiry_alerted"), data.get("expired_alerted"))
                            self.check_expiry(uid, data)
                            if (data.get("expiry_alerted"), data.get("expired_alerted")) != before:
                                self.save_sync(uid, data)
            except Exception as exc:                 # a szál sosem állhat le
                log.warning("%s auto-sync hiba: %s", self.p.label, exc)
            time.sleep(_TICK_S)

    def start_scheduler(self):
        if self._started or (self.p.env_flag and os.environ.get(self.p.env_flag, "true").lower() == "false"):
            return
        self._started = True
        threading.Thread(target=self._loop, name=f"{self.p.key}-auto-sync", daemon=True).start()

    def module_api(self) -> dict:
        """A régi modul-szintű nevek (api_<key>.py ezeket importálja)."""
        return {
            "load_sync": self.load_sync, "save_sync": self.save_sync, "public": self.public,
            "update_settings": self.update_settings, "sync_user": self.sync_user,
            "start_scheduler": self.start_scheduler, "check_expiry": self.check_expiry,
            "_UserLock": self.user_lock, "reset_alerts": self.reset_alerts, "INTERVALS": INTERVALS, "DEFAULT_INTERVAL": DEFAULT_INTERVAL,
        }
