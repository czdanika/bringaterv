"""Bringaterv – helyadat egy nyomvonalhoz (visszafelé geokódolás, OpenStreetMap / Nominatim).

  locate(points) → {
      "country": "Magyarország", "country_code": "hu",
      "region": "Pest vármegye",          # megye / tartomány / kraj / županija …
      "settlement": "Szentendre",         # a rajtpont települése
      "places": ["Szentendre", "Leányfalu", …],   # érintett települések, útvonal-sorrendben
      "countries": ["Magyarország"],      # érintett országok (határon átnyúló útvonalnál több)
      "loop": True,                       # körtúra-e (a rajt és a cél 1 km-en belül)
      "start": [47.67, 19.07],            # rajtpont (térképes nézethez)
  }

A neveket magyarul kérjük (accept-language=hu): ahol van magyar név, az jön
(Bécs, Pozsony), máshol a helyi. A Nominatim felhasználási szabályai szerint
legfeljebb 1 kérés / másodperc, azonosítható User-Agenttel; az eredményeket
gyorsítótárazzuk (/data/geocode_cache.json), így ugyanazt a helyet nem kérdezzük újra.
"""

import json
import math
import os
import threading
import time

import requests

from config import MULTI_DATA_DIR, log

_URL = "https://nominatim.openstreetmap.org/reverse"
_CACHE_PATH = os.path.join(os.path.dirname(MULTI_DATA_DIR.rstrip("/")) or "/data", "geocode_cache.json")
_lock = threading.Lock()
_last = [0.0]
_cache = None
STEP_M = 5000          # érintett települések mintavétele kb. ennyi méterenként
MAX_SAMPLES = 10       # legfeljebb ennyi lekérés útvonalanként (a rajt és a cél is beleszámít)


def _ua() -> str:
    contact = (os.environ.get("CONTACT_EMAIL") or os.environ.get("PUBLIC_URL") or "").strip()
    return f"Bringaterv/1.0 ({contact})" if contact else "Bringaterv/1.0 (self-hosted route planner)"


def _load_cache() -> dict:
    global _cache
    if _cache is None:
        try:
            with open(_CACHE_PATH, encoding="utf-8") as f:
                _cache = json.load(f)
        except (OSError, json.JSONDecodeError):
            _cache = {}
    return _cache


def _save_cache() -> None:
    try:
        tmp = _CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_cache, f, ensure_ascii=False)
        os.replace(tmp, _CACHE_PATH)
    except OSError as exc:
        log.warning("Geokód-gyorsítótár mentési hiba: %s", exc)


def _reverse(lat: float, lon: float) -> dict | None:
    """Egy pont címadatai (gyorsítótárral, 1 kérés/mp korláttal)."""
    key = f"{lat:.3f},{lon:.3f}"
    with _lock:
        cache = _load_cache()
        if key in cache:
            return cache[key]
        wait = 1.1 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        try:
            r = requests.get(_URL, params={"format": "jsonv2", "lat": lat, "lon": lon, "zoom": 14,
                                           "addressdetails": 1, "accept-language": "hu"},
                             headers={"User-Agent": _ua()}, timeout=12)
            _last[0] = time.time()
            if r.status_code != 200:
                log.warning("Nominatim %s (%s)", r.status_code, key)
                return None
            addr = (r.json() or {}).get("address") or {}
        except Exception as exc:
            _last[0] = time.time()
            log.warning("Nominatim hiba (%s): %s", key, exc)
            return None
        res = {
            "country": addr.get("country", ""),
            "country_code": (addr.get("country_code") or "").lower(),
            # Régió: nálunk a megye (county); ahol az nincs, a tartomány / állam
            "region": addr.get("county") or addr.get("state") or addr.get("region") or "",
            "settlement": (addr.get("city") or addr.get("town") or addr.get("village")
                           or addr.get("municipality") or addr.get("hamlet") or addr.get("suburb") or ""),
        }
        cache[key] = res
        _save_cache()
        return res


def _hav(a, b) -> float:
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b[1] - a[1]) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def _sample_points(pts: list) -> list:
    """A rajt, kb. STEP_M méterenként egy pont, és a cél – legfeljebb MAX_SAMPLES darab."""
    total = sum(_hav(a, b) for a, b in zip(pts, pts[1:]))
    step = max(STEP_M, total / max(1, MAX_SAMPLES - 1))
    out, acc = [pts[0]], 0.0
    for a, b in zip(pts, pts[1:]):
        acc += _hav(a, b)
        if acc >= step:
            out.append(b); acc = 0.0
    if out[-1] is not pts[-1]:
        out.append(pts[-1])
    return out[:MAX_SAMPLES]


def locate(points: list) -> dict | None:
    """points: [(lat, lon, …), …] → helyadat (lásd a modul leírását), vagy None, ha nem sikerült."""
    pts = [(p[0], p[1]) for p in points if p and p[0] is not None and p[1] is not None]
    if len(pts) < 2:
        return None
    start = _reverse(*pts[0])
    if not start:
        return None
    places, countries = [], []
    for p in _sample_points(pts):
        r = _reverse(*p) if p is not pts[0] else start
        if not r:
            continue
        if r["settlement"] and r["settlement"] not in places:
            places.append(r["settlement"])
        if r["country"] and r["country"] not in countries:
            countries.append(r["country"])
    return {
        "country": start["country"], "country_code": start["country_code"],
        "region": start["region"], "settlement": start["settlement"],
        "places": places, "countries": countries or ([start["country"]] if start["country"] else []),
        "loop": _hav(pts[0], pts[-1]) < 1000,
        "start": [round(pts[0][0], 5), round(pts[0][1], 5)],
    }


# ══════════════════════════════════════════════════════════════════════════════
# Útpont-nevek (utcaszint) – a tervező pontjaihoz („Móricz Zsigmond utca 12”, „Tihany, kikötő”)
# A böngésző eddig közvetlenül, ~8 kérés/mp-cel kérdezte a Nominatimot → sok pontnál letiltott,
# a pontok név nélkül maradtak. Most a szerver kérdez (1 kérés/mp, a workerek között is),
# és ~11 m-es rácson tárolja: ugyanazt a pontot senkinek nem kell újra lekérdezni.
# ══════════════════════════════════════════════════════════════════════════════

import fcntl

_NAMES_PATH = os.path.join(os.path.dirname(_CACHE_PATH), "geocode_names.json")
_THROTTLE_PATH = os.path.join(os.path.dirname(_CACHE_PATH), "nominatim.throttle")
_names = None
_names_dirty = [0, 0.0]          # [nem mentett db, utolsó mentés ideje]


def _names_cache() -> dict:
    global _names
    if _names is None:
        try:
            with open(_NAMES_PATH, encoding="utf-8") as f:
                _names = json.load(f)
        except (OSError, json.JSONDecodeError):
            _names = {}
    return _names


def _flush_names(force: bool = False) -> None:
    if not _names_dirty[0] or (not force and _names_dirty[0] < 20 and time.time() - _names_dirty[1] < 30):
        return
    try:
        disk = {}
        try:
            with open(_NAMES_PATH, encoding="utf-8") as f:
                disk = json.load(f)                      # a többi worker közben írhatott
        except (OSError, json.JSONDecodeError):
            pass
        disk.update(_names)
        with open(_NAMES_PATH + ".tmp", "w", encoding="utf-8") as f:
            json.dump(disk, f, ensure_ascii=False)
        os.replace(_NAMES_PATH + ".tmp", _NAMES_PATH)
        _names.update(disk)
        _names_dirty[0], _names_dirty[1] = 0, time.time()
    except OSError as exc:
        log.warning("Útpontnév-gyorsítótár mentési hiba: %s", exc)


def _name_key(lat: float, lon: float) -> str:
    return f"{lat:.4f},{lon:.4f}"


def place_name_cached(lat: float, lon: float):
    """A tárolt név (str), "" ha ismert, hogy nincs neve, None ha még nem kérdeztük."""
    return _names_cache().get(_name_key(lat, lon))


def _label(addr: dict) -> str:
    """Mint a kliens buildPlaceName-je: nevezetesség (út) / utca házszám / utca / településrész."""
    poi = next((addr.get(k) for k in ("amenity", "tourism", "leisure", "shop", "historic", "office", "public_transport") if addr.get(k)), "")
    road = next((addr.get(k) for k in ("road", "pedestrian", "path", "footway", "cycleway", "track") if addr.get(k)), "")
    if poi and road:
        return f"{poi} ({road})"
    if poi:
        return poi
    if road and addr.get("house_number"):
        return f"{road} {addr['house_number']}"
    if road:
        return road
    return next((addr.get(k) for k in ("suburb", "quarter", "neighbourhood", "village", "town", "city", "hamlet") if addr.get(k)), "")


def place_name(lat: float, lon: float):
    """Útpont neve (gyorsítótárral). None: a Nominatim most nem válaszolt (később újra lehet próbálni)."""
    key = _name_key(lat, lon)
    hit = _names_cache().get(key)
    if hit is not None:
        return hit
    os.makedirs(os.path.dirname(_THROTTLE_PATH), exist_ok=True)
    with open(_THROTTLE_PATH, "a+") as tf:               # 1 kérés / mp az összes worker között
        fcntl.flock(tf, fcntl.LOCK_EX)
        try:
            hit = _names_cache().get(key)
            if hit is not None:
                return hit
            tf.seek(0)
            try:
                last = float(tf.read().strip() or 0)
            except ValueError:
                last = 0.0
            wait = 1.05 - (time.time() - last)
            if wait > 0:
                time.sleep(wait)
            try:
                r = requests.get(_URL, params={"format": "jsonv2", "lat": lat, "lon": lon, "zoom": 18,
                                               "addressdetails": 1, "accept-language": "hu"},
                                 headers={"User-Agent": _ua()}, timeout=12)
                ok = r.status_code == 200
                addr = ((r.json() or {}).get("address") or {}) if ok else None
            except Exception as exc:
                log.warning("Nominatim (név) hiba: %s", exc)
                addr = None
            tf.seek(0); tf.truncate(); tf.write(str(time.time())); tf.flush()
        finally:
            fcntl.flock(tf, fcntl.LOCK_UN)
    if addr is None:
        return None
    name = _label(addr)[:80]
    _names[key] = name
    _names_dirty[0] += 1
    _flush_names()
    return name
