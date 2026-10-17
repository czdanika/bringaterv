"""Bringaterv – automatikus Strava import (háttér-szinkron).

Felhasználónként bekapcsolható (Könyvtár → Import → Strava ablak): adott
időközönként (5 / 15 / 30 / 60 perc) lekérdezi az új Strava-edzéseket, és a
térképes (GPS-es) újakat ugyanúgy importálja, mint a kézi import.

Strava API-keret (alkalmazásonként, és itt mindenkinek saját app-ja van):
alapból 200 kérés / 15 perc és 2000 / nap (olvasásra 100 / 1000). Egy ellenőrzés
1 kérés, egy új edzés importja 2 (adatok + streamek) – 5 perces időközzel is
napi ~300 kérés, bőven a keret alatt. 429-es válasznál kihagyjuk a kört.

Gunicorn több workerrel fut → az ütemező szál fájlzárral biztosítja, hogy
csak egy worker szinkronizáljon (ha az leáll, egy másik veszi át).

Állapot: /data/users/<uid>/strava_sync.json
"""

import fcntl
import json
import os
import threading
import time
from datetime import datetime, timezone

import requests

from config import MULTI_DATA_DIR, log
from strava_service import STRAVA_API_BASE, _ensure_strava_token, _load_strava_deny_list
from utils import _load_index

INTERVALS = (5, 15, 30, 60)
DEFAULT_INTERVAL = 15
MAX_IMPORTS_PER_RUN = 10
_TICK_S = 60
_LOCK_PATH = os.path.join(os.path.dirname(MULTI_DATA_DIR.rstrip("/")) or "/data", "strava_sync.lock")

_DEFAULT = {
    "enabled": False,
    "interval_min": DEFAULT_INTERVAL,
    "since_ts": None,        # ennél későbbi kezdésű edzéseket keresünk
    "last_check": None,      # ISO idő
    "last_error": None,
    "last_imported": 0,      # az utolsó körben importált darab
    "total_imported": 0,     # bekapcsolás óta összesen (a kliens ebből veszi észre az újat)
    "last_names": [],
    "sports": [],            # üres = minden sport; különben: cycling / running / walking / hiking
    "reimport_deleted": False,  # True: a törölt edzéseket is visszahozza (az elmúlt REIMPORT_DAYS napból)
}

REIMPORT_DAYS = 7

SPORTS = ("cycling", "running", "walking", "hiking")


def sport_category(a: dict) -> str:
    """Strava sport_type → Bringaterv kategória (ugyanaz a leképezés, mint az importnál)."""
    t = (a.get("sport_type") or a.get("type") or "").lower()
    if "ride" in t or "cycl" in t or "bike" in t:
        return "cycling"
    if "run" in t:
        return "running"
    if "walk" in t:
        return "walking"
    if "hik" in t:
        return "hiking"
    return "other"


def _path(user_id: str) -> str:
    return os.path.join(MULTI_DATA_DIR, user_id, "strava_sync.json")


def load_sync(user_id: str) -> dict:
    data = dict(_DEFAULT)
    try:
        with open(_path(user_id), encoding="utf-8") as f:
            data.update(json.load(f) or {})
    except (OSError, json.JSONDecodeError):
        pass
    return data


def save_sync(user_id: str, data: dict, keep_webhook: bool = True) -> None:
    """keep_webhook: a „webhook” részt csak a strava_webhook.py írja – máshonnan
    mentve a lemezen lévőt őrizzük meg (egy közben futó kör ne írja felül)."""
    path = _path(user_id)
    if keep_webhook:
        try:
            with open(path, encoding="utf-8") as f:
                on_disk = (json.load(f) or {}).get("webhook")
            data = {**data, "webhook": on_disk} if on_disk is not None else {k: v for k, v in data.items() if k != "webhook"}
        except (OSError, json.JSONDecodeError):
            pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)


def update_settings(user_id: str, enabled: bool, interval_min: int, sports=None,
                    reimport_deleted=None) -> dict:
    data = load_sync(user_id)
    if interval_min not in INTERVALS:
        interval_min = DEFAULT_INTERVAL
    if enabled and not data["enabled"]:
        # Bekapcsoláskor az elmúlt 1 nap edzéseitől indulunk (a régieket a kézi import hozza)
        data["since_ts"] = int(time.time()) - 86400
        data["last_check"] = None
        data["last_error"] = None
    if sports is not None:
        data["sports"] = [x for x in sports if x in SPORTS]
    if reimport_deleted is not None:
        data["reimport_deleted"] = bool(reimport_deleted)
    data["enabled"] = bool(enabled)
    data["interval_min"] = interval_min
    save_sync(user_id, data)
    return data


def sync_user(user_id: str) -> dict:
    """Egy kör: új Strava-edzések lekérdezése és importja. Az állapotot menti és visszaadja."""
    from api_strava import StravaImportError  # körkörös import elkerülése

    data = load_sync(user_id)
    data["last_check"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data["last_imported"] = 0
    data["last_error"] = None

    token = _ensure_strava_token(user_id)
    if not token:
        data["last_error"] = "Nincs érvényes Strava-kapcsolat – csatlakozz újra a Beállításokban."
        _alert_connection(user_id, data)
        save_sync(user_id, data)
        return data

    since = data.get("since_ts") or int(time.time()) - 86400
    reimport = bool(data.get("reimport_deleted"))
    query_after = since
    if reimport:
        # A törölt (de már „látott”) edzések is újra a lekérdezésbe kerüljenek
        query_after = min(since, int(time.time()) - REIMPORT_DAYS * 86400)
    try:
        resp = requests.get(f"{STRAVA_API_BASE}/athlete/activities",
                            params={"after": query_after, "per_page": 50},
                            headers={"Authorization": f"Bearer {token}"}, timeout=20)
    except requests.RequestException as exc:
        data["last_error"] = f"A Strava nem érhető el ({exc.__class__.__name__})."
        save_sync(user_id, data)
        return data
    if resp.status_code == 429:
        data["last_error"] = "Strava API-keret elérve – a következő körben újra próbálja."
        save_sync(user_id, data)
        return data
    if resp.status_code != 200:
        data["last_error"] = f"Strava API hiba ({resp.status_code})."
        if resp.status_code in (401, 403):
            data["last_error"] = ("A Strava elutasította a hozzáférést – ellenőrizd a kapcsolatot "
                                  "(Beállítások → Strava kapcsolat).")
            _alert_connection(user_id, data)
        save_sync(user_id, data)
        return data
    data["conn_alerted"] = False          # a kapcsolat rendben – újabb hibánál ismét szólunk

    if _rate_limit_tight(resp):
        data["last_error"] = "A Strava API-keret közel a határhoz – ebben a körben kihagyva."
        save_sync(user_id, data)
        return data

    activities = sorted(resp.json() or [], key=lambda a: a.get("start_date") or "")
    routes_dir = os.path.join(MULTI_DATA_DIR, user_id, "routes")
    idx_path = os.path.join(routes_dir, "index.json")
    deny = _load_strava_deny_list(user_id)
    names = []
    new_ids = []
    newest = since
    for a in activities:
        try:
            start_ts = int(datetime.fromisoformat(a["start_date"].replace("Z", "+00:00")).timestamp())
        except (KeyError, ValueError, AttributeError):
            continue
        if len(names) >= MAX_IMPORTS_PER_RUN:
            break                             # a maradékot a következő kör hozza
        try:
            entry = _try_import(user_id, a, token, data, idx_path, deny, reimport)
            if entry:
                names.append(entry.get("name") or str(a.get("id")))
                new_ids.append(entry["id"])
                _notify_workout(user_id, entry)
        except StravaImportError as exc:
            if exc.status != 422:             # 422 = nincs GPS – nem próbáljuk újra
                data["last_error"] = exc.message
                break
        newest = max(newest, start_ts)

    data["since_ts"] = newest
    data["last_imported"] = len(names)
    data["total_imported"] = int(data.get("total_imported") or 0) + len(names)
    if names:
        data["last_names"] = names[-5:]
        log.info("Strava auto-import (%s): %d új edzés", user_id, len(names))
        _notify_records(user_id, idx_path, new_ids)
    save_sync(user_id, data)
    return data


# ── Értesítések (notify.py) – hiba esetén csendben kihagyjuk ──────────────────

def _notify_workout(user_id: str, e: dict) -> None:
    try:
        import notify
        parts = []
        if e.get("distance"):
            parts.append(f"{e['distance']:.1f} km".replace(".", ","))
        if e.get("duration"):
            h, m = divmod(int(e["duration"]), 60)
            parts.append(f"{h} ó {m} p" if h else f"{m} p")
        if e.get("elevation"):
            parts.append(f"{int(e['elevation'])} m szint")
        notify.send(user_id, "new_workout", f"🟠 {e.get('name') or 'Új edzés'}",
                    " · ".join(parts) + " – megnyitás az Elemzésben",
                    url=f"./index.html?open={e['id']}", tag=f"workout-{e['id']}")
    except Exception as exc:
        log.warning("Értesítés (új edzés) hiba: %s", exc)


def _notify_records(user_id: str, idx_path: str, new_ids: list) -> None:
    try:
        import notify
        idx = _load_index(idx_path)
        found = notify.detect_new_records(os.path.dirname(idx_path), idx, new_ids)
        names = {e.get("id"): e.get("name") for e in idx}
        for rid, lines in found.items():
            notify.send(user_id, "new_record", f"🏆 Új rekord – {names.get(rid) or 'edzés'}",
                        "\n".join(lines[:3]), url=f"./index.html?open={rid}", tag=f"record-{rid}")
    except Exception as exc:
        log.warning("Értesítés (rekord) hiba: %s", exc)


def _alert_connection(user_id: str, data: dict) -> None:
    """Kapcsolati hiba – csak egyszer szólunk, amíg meg nem javul."""
    if data.get("conn_alerted"):
        return
    try:
        import notify
        notify.send(user_id, "connection", "⚠️ Strava-kapcsolat megszakadt",
                    data.get("last_error") or "Csatlakozz újra a Beállításokban.",
                    url="./index.html?settings=strava", tag="strava-connection")
        data["conn_alerted"] = True
    except Exception as exc:
        log.warning("Értesítés (kapcsolat) hiba: %s", exc)


def _rate_limit_tight(resp) -> bool:
    """A Strava minden válaszban visszaküldi a keret-használatot (15 perces, napi):
    x-ratelimit-usage / x-readratelimit-usage. Ha a 15 perces vagy a napi keret
    80%-a elfogyott, abban a körben nem importálunk (a Dreeve is így figyel)."""
    for usage_h, limit_h in (("x-readratelimit-usage", "x-readratelimit-limit"),
                             ("x-ratelimit-usage", "x-ratelimit-limit")):
        try:
            used = [int(x) for x in resp.headers.get(usage_h, "").split(",")]
            lim = [int(x) for x in resp.headers.get(limit_h, "").split(",")]
        except ValueError:
            continue
        if any(l and u >= 0.8 * l for u, l in zip(used, lim)):
            return True
    return False


class _UserLock:
    """Felhasználónkénti fájlzár: a webhook és az időközös kör ne importáljon
    egyszerre (különben ugyanaz az edzés kétszer kerülhetne be)."""
    def __init__(self, user_id: str):
        self.path = os.path.join(MULTI_DATA_DIR, user_id, ".strava_import.lock")
        self.f = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.f = open(self.path, "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def _try_import(user_id: str, a: dict, token: str, data: dict, idx_path: str, deny: set, reimport: bool):
    """Egy Strava-edzés importja, ha kell (szűrők, duplikáció, tiltólista).
    Visszaadja az új bejegyzést, vagy None-t, ha kihagytuk."""
    from api_strava import _find_manual_match, import_strava_activity, is_gps_activity
    sid = a.get("id")
    wanted = data.get("sports") or []
    with _UserLock(user_id):
        idx = _load_index(idx_path)           # friss index (közben a user / a webhook is írhatott)
        if (not is_gps_activity(a) or (sid in deny and not reimport)
                or (wanted and sport_category(a) not in wanted)
                or any(r.get("strava_id") == sid for r in idx)
                or _find_manual_match(idx, a)):
            return None
        entry = import_strava_activity(user_id, sid, token, idx, idx_path)
    if sid in deny:
        from api_strava import _remove_from_deny
        _remove_from_deny(user_id, sid)
    return entry


def import_single(user_id: str, activity_id: int, source: str = "webhook") -> dict | None:
    """Egy konkrét edzés importja (a webhook hívja): szűrők, import, értesítések,
    és a kliens-figyelő számlálójának léptetése."""
    from api_strava import StravaImportError
    data = load_sync(user_id)
    token = _ensure_strava_token(user_id)
    if not token:
        data["last_error"] = "Nincs érvényes Strava-kapcsolat – csatlakozz újra a Beállításokban."
        _alert_connection(user_id, data)
        save_sync(user_id, data)
        return None
    try:
        r = requests.get(f"{STRAVA_API_BASE}/activities/{activity_id}",
                         headers={"Authorization": f"Bearer {token}"}, timeout=20)
    except requests.RequestException as exc:
        log.warning("Strava webhook import (%s): %s", activity_id, exc)
        return None
    if r.status_code != 200:
        log.warning("Strava webhook import (%s): HTTP %s", activity_id, r.status_code)
        return None
    idx_path = os.path.join(MULTI_DATA_DIR, user_id, "routes", "index.json")
    try:
        entry = _try_import(user_id, r.json(), token, data, idx_path,
                            _load_strava_deny_list(user_id), bool(data.get("reimport_deleted")))
    except StravaImportError as exc:
        log.warning("Strava webhook import (%s): %s", activity_id, exc.message)
        return None
    if not entry:
        return None
    log.info("Strava %s import (%s): %s", source, user_id, entry.get("name"))
    _notify_workout(user_id, entry)
    _notify_records(user_id, idx_path, [entry["id"]])
    data = load_sync(user_id)                 # friss állapot (közben futhatott egy kör)
    data["total_imported"] = int(data.get("total_imported") or 0) + 1
    data["last_names"] = ((data.get("last_names") or []) + [entry.get("name") or str(activity_id)])[-5:]
    save_sync(user_id, data)
    return entry


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
                    log.info("Strava auto-sync ütemező aktív (pid %s)", os.getpid())
                except OSError:
                    f.close()                  # egy másik worker már fut
            if lock_file is not None and os.path.isdir(MULTI_DATA_DIR):
                for uid in sorted(os.listdir(MULTI_DATA_DIR)):
                    if not os.path.isfile(_path(uid)):
                        continue
                    if _due(load_sync(uid)):
                        sync_user(uid)
        except Exception as exc:               # a szál sosem állhat le
            log.warning("Strava auto-sync hiba: %s", exc)
        time.sleep(_TICK_S)


_started = False


def start_scheduler():
    global _started
    if _started or os.environ.get("STRAVA_AUTO_SYNC", "true").lower() == "false":
        return
    _started = True
    threading.Thread(target=_loop, name="strava-auto-sync", daemon=True).start()
