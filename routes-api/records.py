"""Bringaterv – edzésenkénti rekordszámítás GPX-ből (legjobb idők, csúcsértékek).

Egy edzés GPX-éből kiszámolja:
  • efforts – a leggyorsabb idő (mp) minden szabványos távra (pl. 10 km), akkor is,
              ha a táv egy hosszabb edzés közepén volt (csúszóablak a megtett távon);
  • peaks   – a legmagasabb átlagpulzus / átlagteljesítmény adott időablakokra
              (pl. 5 perc), 1 Hz-re mintavételezett adatsoron;
  • climb   – a legnagyobb egybefüggő emelkedés (m) és annak hossza (km).

Az eredményt felhasználónként cache-eljük (records_cache.json a routes mappában),
a GPX módosítási ideje + algoritmusverzió alapján érvénytelenítve – így a
rekordoldal csak az új/változott edzéseket számolja újra.
"""

import json
import math
import os
import re
from datetime import datetime

from config import log

ALGO_VERSION = 1

# Szabványos távok méterben – minden sportra ugyanazt számoljuk, a frontend
# sportonként választja ki a relevánsakat.
EFFORT_DISTANCES_M = [
    400, 1000, 5000, 10000, 20000, 21097, 30000, 40000, 42195,
    50000, 80000, 100000, 150000, 200000,
]
# Csúcsérték-ablakok másodpercben
PEAK_WINDOWS_S = [5, 30, 60, 300, 1200, 3600]

_MAX_GAP_S = 10          # ennél hosszabb adatszünet = megszakítás (csúcsértékeknél)
_MAX_SPEED_MS = 35.0     # ~126 km/h – e fölötti ugrás GPS-hiba, kihagyjuk
_CLIMB_HYST_M = 10.0     # mászás vége: ennyi méter visszaesés a csúcshoz képest

_PT_RE = re.compile(
    r'<(?:trkpt|rtept)\b([^>]*?)(?:/>|>(.*?)</(?:trkpt|rtept)>)', re.DOTALL)
_LAT_RE = re.compile(r'\blat="([-\d.]+)"')
_LON_RE = re.compile(r'\blon="([-\d.]+)"')
_TIME_RE = re.compile(r'<time>([^<]+)</time>')
_ELE_RE = re.compile(r'<ele>([-\d.]+)</ele>')
_HR_RE = re.compile(r'<(?:\w+:)?hr>(\d+(?:\.\d+)?)</(?:\w+:)?hr>')
_PWR_RE = re.compile(r'<(?:\w+:)?(?:power|PowerInWatts)>(\d+(?:\.\d+)?)</(?:\w+:)?(?:power|PowerInWatts)>')


def _parse_time(s: str):
    try:
        s = s.strip().replace("Z", "+00:00")
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        return None


def _haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def parse_points(gpx_text: str) -> list:
    """[(t_sec, cum_dist_m, ele|None, hr|None, power|None), ...] – csak időbélyeges pontok."""
    out = []
    prev = None
    cum = 0.0
    for m in _PT_RE.finditer(gpx_text):
        attrs, inner = m.group(1), m.group(2) or ""
        la, lo, tm = _LAT_RE.search(attrs), _LON_RE.search(attrs), _TIME_RE.search(inner)
        if not (la and lo and tm):
            continue
        t = _parse_time(tm.group(1))
        if t is None:
            continue
        lat, lon = float(la.group(1)), float(lo.group(1))
        if prev is not None:
            dt = t - prev[2]
            if dt < 0:
                continue
            d = _haversine_m(prev[0], prev[1], lat, lon)
            if dt > 0 and d / dt > _MAX_SPEED_MS:
                continue                      # GPS-ugrás
            if dt == 0 and d > 0:
                continue
            cum += d
        ele_m, hr_m, pw_m = _ELE_RE.search(inner), _HR_RE.search(inner), _PWR_RE.search(inner)
        out.append((
            t, cum,
            float(ele_m.group(1)) if ele_m else None,
            float(hr_m.group(1)) if hr_m else None,
            float(pw_m.group(1)) if pw_m else None,
        ))
        prev = (lat, lon, t)
    return out


def _best_efforts(pts: list) -> dict:
    """Táv (m) → leggyorsabb idő (mp). Kétmutatós csúszóablak a kumulált távon."""
    if len(pts) < 2:
        return {}
    total = pts[-1][1] - pts[0][1]
    res = {}
    n = len(pts)
    for dist in EFFORT_DISTANCES_M:
        if total < dist:
            break
        best = None
        start = 0
        for end in range(n):
            while start < end and pts[end][1] - pts[start + 1][1] >= dist:
                start += 1
            covered = pts[end][1] - pts[start][1]
            if covered >= dist:
                # lineáris interpoláció: pontosan `dist` méterre eső idő
                dt = pts[end][0] - pts[start][0]
                t = dt * dist / covered if covered > 0 else dt
                if best is None or t < best:
                    best = t
        if best:
            res[str(dist)] = round(best, 1)
    return res


def _resample_1hz(pts: list, idx: int) -> list:
    """Adatsor 1 Hz-re: érték minden egész másodpercre, None ott, ahol nincs adat
    vagy a szünet hosszabb _MAX_GAP_S-nél."""
    samples = [(p[0], p[idx]) for p in pts if p[idx] is not None]
    if len(samples) < 2:
        return []
    t0 = samples[0][0]
    length = int(samples[-1][0] - t0) + 1
    if length > 12 * 3600 * 2:                # extrém hosszú/rossz időbélyeg
        return []
    arr = [None] * length
    for (ta, va), (tb, _) in zip(samples, samples[1:]):
        a, b = int(ta - t0), int(tb - t0)
        if b - a > _MAX_GAP_S:
            arr[a] = va
            continue
        for k in range(a, max(a + 1, b)):
            arr[k] = va
    arr[int(samples[-1][0] - t0)] = samples[-1][1]
    return arr


def _peaks(arr: list) -> dict:
    """Időablak (mp) → legmagasabb átlag, csak megszakítás nélküli ablakokra."""
    res = {}
    n = len(arr)
    if n == 0:
        return res
    pre = [0.0] * (n + 1)
    gaps = [0] * (n + 1)
    for i, v in enumerate(arr):
        pre[i + 1] = pre[i] + (v or 0.0)
        gaps[i + 1] = gaps[i] + (1 if v is None else 0)
    for w in PEAK_WINDOWS_S:
        if w > n:
            break
        best = None
        for i in range(0, n - w + 1):
            if gaps[i + w] - gaps[i]:
                continue
            avg = (pre[i + w] - pre[i]) / w
            if best is None or avg > best:
                best = avg
        if best is not None and best > 0:
            res[str(w)] = round(best, 1)
    return res


def _biggest_climb(pts: list) -> dict | None:
    """Legnagyobb egybefüggő emelkedés hiszterézissel: _CLIMB_HYST_M-nél kisebb
    visszaesés nem szakítja meg a mászást."""
    ele = [(p[1], p[2]) for p in pts if p[2] is not None]
    if len(ele) < 2:
        return None
    best = (0.0, 0.0)
    low = peak = ele[0]

    def consider(lo, pk):
        nonlocal best
        if pk[1] - lo[1] > best[0]:
            best = (pk[1] - lo[1], pk[0] - lo[0])

    for d, e in ele[1:]:
        if e > peak[1]:
            peak = (d, e)
        elif peak[1] - e > _CLIMB_HYST_M:
            consider(low, peak)
            low = peak = (d, e)
        if e < low[1]:
            low = peak = (d, e)
    consider(low, peak)
    if best[0] < 5:
        return None
    return {"gain_m": round(best[0]), "length_km": round(best[1] / 1000, 2)}


def compute_records(gpx_text: str) -> dict:
    pts = parse_points(gpx_text)
    if len(pts) < 10:
        return {"v": ALGO_VERSION, "efforts": {}, "peaks": {}, "climb": None}
    peaks = {}
    for key, idx in (("hr", 3), ("power", 4)):
        p = _peaks(_resample_1hz(pts, idx))
        if p:
            peaks[key] = p
    return {
        "v": ALGO_VERSION,
        "efforts": _best_efforts(pts),
        "peaks": peaks,
        "climb": _biggest_climb(pts),
    }


# ── Cache ─────────────────────────────────────────────────────────────────────

def _cache_path(routes_dir: str) -> str:
    return os.path.join(routes_dir, "records_cache.json")


def records_for_index(routes_dir: str, index: list, budget_s: float = 8.0) -> tuple:
    """Minden edzés rekordadata; a hiányzókat/elavultakat kiszámolja és cache-eli.
    Egy hívás legfeljebb `budget_s` másodpercig számol (lassú gépen sok új edzés
    esetén); a maradék darabszámát `pending`-ként adja vissza – a kliens újrakér.
    Visszatér: (items, pending)."""
    import time
    deadline = time.monotonic() + budget_s
    pending = 0
    path = _cache_path(routes_dir)
    try:
        with open(path, encoding="utf-8") as f:
            cache = json.load(f)
    except (OSError, json.JSONDecodeError):
        cache = {}

    changed = False
    out = []
    live_ids = set()
    for entry in index:
        rid = entry.get("id")
        if not rid or entry.get("type") != "workout":
            continue
        gpx_path = os.path.join(routes_dir, f"{rid}.gpx")
        try:
            mtime = int(os.path.getmtime(gpx_path))
        except OSError:
            continue
        live_ids.add(rid)
        c = cache.get(rid)
        if not c or c.get("mtime") != mtime or c.get("v") != ALGO_VERSION:
            if time.monotonic() > deadline:
                pending += 1
                continue
            try:
                with open(gpx_path, encoding="utf-8") as f:
                    c = compute_records(f.read())
            except Exception as exc:          # egy hibás GPX ne döntse el az egészet
                log.warning("Rekordszámítás hiba (%s): %s", rid, exc)
                c = {"v": ALGO_VERSION, "efforts": {}, "peaks": {}, "climb": None}
            c["mtime"] = mtime
            cache[rid] = c
            changed = True
        out.append({"id": rid, "efforts": c.get("efforts", {}),
                    "peaks": c.get("peaks", {}), "climb": c.get("climb")})

    stale = [k for k in cache if k not in live_ids]
    for k in stale:
        del cache[k]
    if changed or stale:
        try:
            with open(path + ".tmp", "w", encoding="utf-8") as f:
                json.dump(cache, f)
            os.replace(path + ".tmp", path)
        except OSError as exc:
            log.warning("Rekord cache írási hiba: %s", exc)
    return out, pending
