"""Bringaterv API – közös segédfüggvények (ID, index fájl, dátum)."""

import fcntl
import json
import os
import re
import shutil
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

from config import log


def _safe_id(raw: str) -> str:
    """Path traversal védelem – csak alfanumerikus és kötőjel."""
    return re.sub(r"[^a-zA-Z0-9\-]", "", raw)


def _clean_surface(raw):
    """Tárolt burkolat-vizsgálat (útvonal / minta) ellenőrzése: csak az ismert mezők, korlátozott méret."""
    if not isinstance(raw, dict) or not isinstance(raw.get("segments"), list):
        return None
    def f(v):
        try:
            return round(float(v), 6)
        except (TypeError, ValueError):
            return None
    segs = []
    for s in raw["segments"][:200]:
        if not isinstance(s, dict) or s.get("mode") not in ("asphalt", "gravel", "mtb", "hiking"):
            continue
        segs.append({"mode": s["mode"], "fromKm": f(s.get("fromKm")), "toKm": f(s.get("toKm")),
                     "distanceKm": f(s.get("distanceKm")), "lat": f(s.get("lat")), "lng": f(s.get("lng"))})
    if not segs:
        return None
    return {"segments": segs, "totalDistKm": f(raw.get("totalDistKm")),
            "analyzed_at": str(raw.get("analyzed_at") or "")[:40]}


# ── Index zárolás ─────────────────────────────────────────────────────────────
# Az index.json-t a kérések és a háttérszálak (mért adatok, hőmérséklet, időjárás pótlása)
# is írják. A zár: szálon belül újra beléphető (threading), a gunicorn-folyamatok között
# fájlzár (fcntl a <index>.lock fájlon). Írás közben mindig ez fogja, a háttér-írók pedig
# az olvasás–módosítás–írás teljes idejére (index_lock).
_locks: dict = {}
_locks_guard = threading.Lock()
_held = threading.local()


@contextmanager
def index_lock(path: str):
    depth = getattr(_held, "d", {})
    _held.d = depth
    if depth.get(path):                         # ez a szál már fogja (pl. _save_index a zár alatt)
        depth[path] += 1
        try:
            yield
        finally:
            depth[path] -= 1
        return
    with _locks_guard:
        tl = _locks.setdefault(path, threading.Lock())
    with tl:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path + ".lock", "a") as lf:
            fcntl.flock(lf, fcntl.LOCK_EX)
            depth[path] = 1
            try:
                yield
            finally:
                depth[path] = 0
                fcntl.flock(lf, fcntl.LOCK_UN)


def _load_index(path: str) -> list:
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        log.error("Index olvasási hiba (%s): %s", path, exc)
        # sérült fájl: az utolsó ép másolatból – üres listával a következő mentés az egész
        # könyvtárat felülírná
        try:
            with open(path + ".bak", encoding="utf-8") as f:
                data = json.load(f)
            log.warning("Index visszaállítva a biztonsági másolatból (%s)", path)
            return data
        except (json.JSONDecodeError, OSError):
            raise RuntimeError(f"Az index sérült, és nincs ép másolata: {path}") from exc


def _save_index(index: list, path: str) -> None:
    # egyedi ideiglenes fájl (két író soha nem keveredik egy fájlba), atomi csere, előtte
    # az előző ép változat másolata (.bak)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with index_lock(path):
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(index, f, ensure_ascii=False, indent=2)
            if os.path.exists(path):
                try:
                    with open(path, encoding="utf-8") as f:
                        json.load(f)                    # csak ép fájlról készül másolat
                    shutil.copyfile(path, path + ".bak")
                except (json.JSONDecodeError, OSError):
                    pass
            os.replace(tmp, path)
        except OSError as exc:
            log.error("Index írási hiba (%s): %s", path, exc)
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise


def append_index(path: str, entry: dict) -> None:
    """Új bejegyzés hozzáfűzése: zár alatt friss olvasás + írás (a hívó korábban betöltött listája
    elavult lehet – pl. a letöltés alatt egy másik import vagy a háttér-pótlás is írt)."""
    with index_lock(path):
        idx = _load_index(path)
        idx.append(entry)
        _save_index(idx, path)


def _now_date() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _now_dt() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── Ismétlődés-védelem: ugyanaz az edzés több forrásból (Strava, Garmin, Onelap, FIT) ──
# Egy eszköz (pl. Magene) az edzést az Onelapra ÉS a Stravára is feltöltheti. A Strava a
# távot újraszámolja, és más indulási időt tárolhat (élesben 9 perc eltérés volt) →
# tágabb tűrés, mint a 60 mp / 2%. 15 percen belül két külön, ±5%-ra azonos távú edzés nem jellemző.
_DUP_START_TOLERANCE_S = 15 * 60
_DUP_DIST_TOLERANCE    = 0.05


def _entry_start_ts(r: dict):
    s = r.get("start_time")
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def find_cross_source_duplicate(idx: list, start_ts, distance_m, own_key: str):
    """Már meglévő, valószínűleg azonos edzés MÁS forrásból (a saját forrás azonosító-
    kulcsával – pl. "strava_id" – rendelkező bejegyzéseket kihagyja).
    Egyezés: indulás ±15 perc ÉS táv ±5%. Nincs egyezés → None."""
    if not start_ts or not distance_m:
        return None
    for r in idx:
        if r.get(own_key) or r.get("type") != "workout" or r.get("distance") is None:
            continue
        r_ts = _entry_start_ts(r)
        if r_ts is None or abs(r_ts - start_ts) > _DUP_START_TOLERANCE_S:
            continue
        if abs(r["distance"] * 1000 - distance_m) / distance_m <= _DUP_DIST_TOLERANCE:
            return r
    return None


# ── Edzés vagy terv? (egy helyen – a mentés, a módosítás és a migráció is ezt használja) ──
# A forrás-azonosítók: az importált edzések mindig rögzített adatok
SOURCE_ID_FIELDS = ("strava_id", "garmin_id", "onelap_id", "igpsport_id", "bryton_id", "wahoo_id", "polar_id")
_TRKPT_TIME_RE = re.compile(r"<trkpt\b[^>]*>(?:(?!</trkpt>).)*?<time>", re.S)


def gpx_has_times(gpx_text: str, min_points: int = 4) -> bool:
    """A nyomvonal pontjainak van időbélyege (rögzített edzés) – a tervezett útvonalnak nincs."""
    n = 0
    for _ in _TRKPT_TIME_RE.finditer(gpx_text[:400000]):
        n += 1
        if n >= min_points:
            return True
    return False


def is_recorded_entry(entry: dict, gpx_text: str = None) -> bool:
    """Valódi (rögzített) edzés-e: importált (forrás-azonosító), FIT-tel mentett, indulási idővel,
    vagy a GPX pontjainak időbélyege van."""
    if any(entry.get(k) for k in SOURCE_ID_FIELDS) or entry.get("has_fit") or entry.get("start_time"):
        return True
    return bool(gpx_text) and gpx_has_times(gpx_text)


_TRKPT_FIRST_TIME_RE = re.compile(r"<trkpt\b[^>]*>(?:(?!</trkpt>).)*?<time>([^<]+)</time>", re.S)


def gpx_first_time(gpx_text: str):
    """A nyomvonal első pontjának időbélyege (UTC datetime) – az edzés valódi kezdete."""
    m = _TRKPT_FIRST_TIME_RE.search(gpx_text or "")
    if not m:
        return None
    try:
        dt = datetime.fromisoformat(m.group(1).strip().replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None
