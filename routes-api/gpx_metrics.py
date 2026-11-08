"""Bringaterv API – mért adatok összesítése GPX-ből (teljesítmény, pulzus, kadencia).

A kézzel feltöltött (FIT / GPX) edzéseknél az index nem kapta meg az avg_watts /
avg_heartrate … mezőket (azokat csak a Strava / Garmin / OnelapFit / Wahoo / Polar
import töltötte), ezért a könyvtár-kártya, a Kezdőlap és a „Mért adat” szűrő nem
látta őket. Itt a TELJES felbontású GPX-ből számoljuk (a böngésző ritkít).

  • save_route: mentéskor kitölti a hiányzó mezőket;
  • backfill_all: induláskor egyszer, a háttérben pótolja a régi edzéseknél
    (jelző: entry["metrics_v"]); a felszerelést (eszköz, bringa, szenzorok) az eredeti
    FIT-ből / GPX-ből, a Stravás edzéseknél óránként egy adag Strava API-hívással
    (jelző: entry["equip_v"]).
  • hőmérséklet: a GPX <atemp> mezőjéből (avg_temp / min_temp / max_temp, temp_source
    „device”); a régi Stravás edzéseknél a Strava „temp” adatsorát utólag beírjuk a GPX-be
    (jelző: entry["strava_temp_v"]); ahol így sincs mért adat, ott a temp_weather modul
    az időjárás-archívumból pótolja (temp_source „weather”). Kész: entry["temp_v"].
"""

import fcntl
import os
import re
import threading
import time
from datetime import datetime

from config import MULTI_DATA_DIR, log
from utils import _load_index, _save_index, index_lock

METRICS_VERSION = 4          # 2: hőmérséklet, 3: az eszköz kalóriája a kézi FIT-ből, 4: max. sebesség
TEMP_VERSION = 1
_PT_RE = re.compile(r"<trkpt\b.*?</trkpt>", re.S)
_TIME_RE = re.compile(r"<time>([^<]+)</time>")
_HR_RE = re.compile(r"<(?:\w+:)?hr>(\d+(?:\.\d+)?)</")
_CAD_RE = re.compile(r"<(?:\w+:)?cad>(\d+(?:\.\d+)?)</")
_PWR_RE = re.compile(r"<(?:\w+:)?(?:PowerInWatts|watts|power)>(\d+(?:\.\d+)?)</")
_LATLON_RE = re.compile(r'lat="(-?[\d.]+)"\s+lon="(-?[\d.]+)"')
_TEMP_RE = re.compile(r"<(?:\w+:)?atemp>(-?\d+(?:\.\d+)?)</")


def _ts(s: str):
    try:
        return datetime.fromisoformat(s.strip().replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def gpx_metrics(gpx_text: str) -> dict:
    """{avg_watts, max_watts, weighted_avg_watts (NP), avg_heartrate, max_heartrate,
    avg_cadence, avg_temp, min_temp, max_temp} – csak ami a GPX-ben tényleg megvan."""
    pw, hr, cad, tmp, pos = [], [], [], [], []
    for blk in _PT_RE.findall(gpx_text or ""):
        t = _TIME_RE.search(blk)
        ts = _ts(t.group(1)) if t else None
        ll = _LATLON_RE.search(blk)
        if ll and ts is not None:
            pos.append((ts, float(ll.group(1)), float(ll.group(2))))
        m = _PWR_RE.search(blk)
        if m:
            v = float(m.group(1))
            if 0 <= v < 2500:                    # a hibás kiugró (2,5 kW+) mérés kimarad
                pw.append((ts, v))
        m = _HR_RE.search(blk)
        if m and 25 < float(m.group(1)) < 250:
            hr.append(float(m.group(1)))
        m = _CAD_RE.search(blk)
        if m:
            cad.append(float(m.group(1)))
        m = _TEMP_RE.search(blk)
        if m and -40 < float(m.group(1)) < 60:
            tmp.append(float(m.group(1)))
    out = {}
    if pw:
        vals = [v for _, v in pw]
        out["avg_watts"] = round(sum(vals) / len(vals))
        out["max_watts"] = round(max(vals))
        if all(t is not None for t, _ in pw) and len(pw) > 30:
            # NP: 30 mp-es (idő szerinti) mozgóátlag 4. hatványainak átlaga, 4. gyök
            roll, j, s = [], 0, 0.0
            for i, (t, v) in enumerate(pw):
                s += v
                while t - pw[j][0] > 30:
                    s -= pw[j][1]
                    j += 1
                roll.append(s / (i - j + 1))
            out["weighted_avg_watts"] = round((sum(x ** 4 for x in roll) / len(roll)) ** 0.25)
    if hr:
        out["avg_heartrate"] = round(sum(hr) / len(hr))
        out["max_heartrate"] = round(max(hr))
    pedal = [c for c in cad if c > 0]                # a gurulás (0 rpm) nem számít
    if pedal:
        out["avg_cadence"] = round(sum(pedal) / len(pedal))
    if len(tmp) >= 5:
        out.update(temp_summary(tmp), temp_source="device")
    ms = _max_speed(pos)
    if ms:
        out["max_speed_kmh"] = ms
    return out


def _max_speed(pos) -> float | None:
    """Maximális sebesség (km/h) ~10 mp-es csúszó ablakban – a GPS-ugrások nem számítanak."""
    import math
    if len(pos) < 10:
        return None
    best, j, dist = 0.0, 0, [0.0]
    for i in range(1, len(pos)):
        (_, a1, o1), (_, a2, o2) = pos[i - 1], pos[i]
        x = math.radians(o2 - o1) * math.cos(math.radians((a1 + a2) / 2))
        y = math.radians(a2 - a1)
        dist.append(dist[-1] + 6371000 * math.hypot(x, y))
    for i in range(1, len(pos)):
        while j < i and pos[i][0] - pos[j][0] > 10:
            j += 1
        dt = pos[i][0] - pos[j][0]
        if dt >= 5:
            best = max(best, (dist[i] - dist[j]) / dt * 3.6)
    return round(best, 1) if 0 < best < 110 else None


def temp_summary(vals) -> dict:
    return {"avg_temp": round(sum(vals) / len(vals), 1), "min_temp": round(min(vals), 1), "max_temp": round(max(vals), 1)}


def fill_missing(entry: dict, gpx_text: str) -> bool:
    """A hiányzó mért mezők pótlása (a gyártói / Strava-értéket nem írja felül).
    Igaz, ha változott valami."""
    changed = False
    for k, v in gpx_metrics(gpx_text).items():
        if entry.get(k) is None:
            entry[k] = v
            changed = True
    if entry.get("metrics_v") != METRICS_VERSION:
        entry["metrics_v"] = METRICS_VERSION
        changed = True
    if entry.get("temp_source") == "device" and entry.get("temp_v") != TEMP_VERSION:
        entry["temp_v"] = TEMP_VERSION                  # mért hőmérséklet van – időjárás nem kell
        changed = True
    return changed


_MERGE_KEYS = ("max_speed_kmh", "avg_watts", "max_watts", "weighted_avg_watts", "avg_heartrate", "max_heartrate",
               "avg_cadence", "metrics_v", "device", "device_maker", "bike_name", "sensors",
               "power_meter", "equip_v", "avg_temp", "min_temp", "max_temp", "temp_source", "temp_v",
               "strava_temp_v", "calories")


_VERSION_KEYS = {"metrics_v", "equip_v", "temp_v", "strava_temp_v"}


def _merge_save(idx_path: str, updates: dict) -> None:
    """Friss index + összefésülés: a számolás alatt a felhasználó is írhatott. A zár az
    olvasástól az írásig fogja – közben egy mentés nem csúszhat be (és nem veszhet el)."""
    with index_lock(idx_path):
        _merge_save_locked(idx_path, updates)


def _merge_save_locked(idx_path: str, updates: dict) -> None:
    idx = _load_index(idx_path)
    for r in idx:
        u = updates.get(r.get("id"))
        if u:
            for k in _MERGE_KEYS:
                # a mért értéket nem írjuk felül (a felhasználó / gyártó adata erősebb), a
                # verziójelzőt viszont igen – különben a régi jelző miatt újra és újra számolna
                if u.get(k) is not None and (r.get(k) is None or k in _VERSION_KEYS):
                    r[k] = u[k]
    _save_index(idx, idx_path)


def _backfill_user(uid: str) -> int:
    """Mért adatok + felszerelés a helyben lévő fájlokból (GPX, eredeti FIT)."""
    from fit_gpx import EQUIP_VERSION, equipment_fields, fit_equipment, gpx_equipment
    routes_dir = os.path.join(MULTI_DATA_DIR, uid, "routes")
    idx_path = os.path.join(routes_dir, "index.json")
    if not os.path.isfile(idx_path):
        return 0
    todo = [e for e in _load_index(idx_path) if e.get("type") == "workout"
            and (e.get("metrics_v") != METRICS_VERSION
                 or (e.get("equip_v") != EQUIP_VERSION and not e.get("strava_id")))]
    if not todo:
        return 0
    updates = {}
    for e in todo:
        try:
            with open(os.path.join(routes_dir, f"{e['id']}.gpx"), encoding="utf-8") as f:
                gpx = f.read()
        except OSError:
            gpx = ""
        fill_missing(e, gpx)
        fit_path = os.path.join(routes_dir, f"{e['id']}.fit")
        if e.get("calories") is None and os.path.isfile(fit_path):
            e["calories"] = _fit_calories(fit_path)            # a rögzítő eszköz saját értéke
        if e.get("equip_v") != EQUIP_VERSION and not e.get("strava_id"):
            eq = {}
            if os.path.isfile(fit_path):
                with open(fit_path, "rb") as f:
                    eq = fit_equipment(f.read())
            e.update({k: v for k, v in equipment_fields(eq or gpx_equipment(gpx)).items() if e.get(k) is None})
        updates[e["id"]] = e
    _merge_save(idx_path, updates)
    return len(updates)


def _fit_calories(path: str):
    try:
        from fit_gpx import fit_to_gpx
        with open(path, "rb") as f:
            cal = (fit_to_gpx(f.read(), "x")[1] or {}).get("calories")
        return int(cal) if cal else None
    except Exception:
        return None


_STRAVA_EQUIP_PER_RUN = 40


def _strava_equipment_user(uid: str, budget: int = _STRAVA_EQUIP_PER_RUN) -> int:
    """Stravás edzések eszköze és bringája (FIT nincs) – adag lekérdezés a Strava API-ból."""
    import requests
    from api_strava import strava_equipment
    from fit_gpx import EQUIP_VERSION
    from strava_service import STRAVA_API_BASE, _ensure_strava_token
    from strava_sync import _rate_limit_tight
    idx_path = os.path.join(MULTI_DATA_DIR, uid, "routes", "index.json")
    if not os.path.isfile(idx_path):
        return 0
    todo = [e for e in _load_index(idx_path) if e.get("strava_id") and e.get("equip_v") != EQUIP_VERSION]
    if not todo:
        return 0
    token = _ensure_strava_token(uid)
    if not token:
        return 0
    updates = {}
    for e in todo[:budget]:
        try:
            r = requests.get(f"{STRAVA_API_BASE}/activities/{e['strava_id']}", timeout=20,
                             headers={"Authorization": f"Bearer {token}"})
        except requests.RequestException:
            break
        if r.status_code == 404:                       # törölték a Stravából – nincs mit pótolni
            updates[e["id"]] = {"equip_v": EQUIP_VERSION}
            continue
        if r.status_code != 200:
            break                                      # 429 / hiba: a következő órában folytatja
        updates[e["id"]] = strava_equipment(r.json())
        if _rate_limit_tight(r):
            break
    _merge_save(idx_path, updates)
    return len(updates)


def inject_temps(gpx: str, times: list, temps: list):
    """A Strava „temp” adatsorát (másodperc-eltolás → °C) beírja a saját Stravás GPX-ünk
    pontjaiba (<gpxtpx:atemp>). None, ha nincs mit / nem lehet."""
    if not temps or "xmlns:gpxtpx" not in gpx[:800] or "atemp>" in gpx:
        return None
    t0 = times[0] if times and times[0] is not None else 0
    by_off = {int(t - t0): v for t, v in zip(times, temps) if t is not None and v is not None}
    if not by_off:
        return None
    first = [None]
    hits = [0]

    def put(m):
        blk = m.group(0)
        tm = _TIME_RE.search(blk)
        ts = _ts(tm.group(1)) if tm else None
        if ts is None:
            return blk
        if first[0] is None:
            first[0] = ts
        v = by_off.get(int(round(ts - first[0])))
        if v is None:
            return blk
        hits[0] += 1
        tag = f"<gpxtpx:atemp>{v}</gpxtpx:atemp>"
        if "</gpxtpx:TrackPointExtension>" in blk:
            return blk.replace("</gpxtpx:TrackPointExtension>", tag + "</gpxtpx:TrackPointExtension>", 1)
        ext = f"<gpxtpx:TrackPointExtension>{tag}</gpxtpx:TrackPointExtension>"
        if "<extensions>" in blk:
            return blk.replace("<extensions>", "<extensions>" + ext, 1)
        return blk.replace("</trkpt>", f"<extensions>{ext}</extensions></trkpt>", 1)
    out = _PT_RE.sub(put, gpx)
    return out if hits[0] >= 5 else None


def _strava_temp_user(uid: str, budget: int) -> int:
    """Régi Stravás edzések hőmérséklete: a Strava „temp” adatsora a GPX-be (adagonként)."""
    import requests
    from strava_service import STRAVA_API_BASE, _ensure_strava_token
    from strava_sync import _rate_limit_tight
    routes_dir = os.path.join(MULTI_DATA_DIR, uid, "routes")
    idx_path = os.path.join(routes_dir, "index.json")
    if budget <= 0 or not os.path.isfile(idx_path):
        return 0
    todo = [e for e in _load_index(idx_path) if e.get("type") == "workout" and e.get("strava_id")
            and e.get("strava_temp_v") != TEMP_VERSION and e.get("temp_source") != "device"]
    if not todo:
        return 0
    token = _ensure_strava_token(uid)
    updates = {}
    if not token:
        # nincs Strava-kapcsolat: nem tudjuk lekérni – jöhet az időjárás-tartalék
        _merge_save(idx_path, {e["id"]: {"strava_temp_v": TEMP_VERSION} for e in todo})
        return 0
    for e in todo[:budget]:
        try:
            r = requests.get(f"{STRAVA_API_BASE}/activities/{e['strava_id']}/streams", timeout=30,
                             params={"keys": "time,temp", "key_by_type": "true"},
                             headers={"Authorization": f"Bearer {token}"})
        except requests.RequestException:
            break
        if r.status_code not in (200, 404):
            break                                      # 429 / hiba: a következő órában folytatja
        upd = {"strava_temp_v": TEMP_VERSION}
        if r.status_code == 200:
            st = r.json() if isinstance(r.json(), dict) else {}
            temps = (st.get("temp") or {}).get("data") or []
            times = (st.get("time") or {}).get("data") or []
            path = os.path.join(routes_dir, f"{e['id']}.gpx")
            try:
                with open(path, encoding="utf-8") as f:
                    gpx = f.read()
                new = inject_temps(gpx, times, temps) if temps and times else None
                if new:
                    tmp_path = path + ".tmp"
                    with open(tmp_path, "w", encoding="utf-8") as f:
                        f.write(new)
                    os.replace(tmp_path, path)
                    vals = [v for v in temps if v is not None and -40 < v < 60]
                    if vals:
                        upd.update(temp_summary(vals), temp_source="device", temp_v=TEMP_VERSION)
            except OSError:
                pass
        updates[e["id"]] = upd
        if r.status_code == 200 and _rate_limit_tight(r):
            break
    _merge_save(idx_path, updates)
    return len(updates)


def backfill_all() -> None:
    """Induláskor egyszer, háttérszálon – a régi edzések mért adatainak pótlása."""
    def run():
        # több gunicorn worker: csak az egyik dolgozzon (a zár a folyamat végéig él)
        try:
            lf = open(os.path.join(os.path.dirname(MULTI_DATA_DIR.rstrip("/")) or "/data", "metrics_backfill.lock"), "w")
            fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return
        total = 0
        try:
            for uid in sorted(os.listdir(MULTI_DATA_DIR)):
                try:
                    total += _backfill_user(uid)
                except Exception as exc:
                    log.warning("Mért adatok pótlása sikertelen (%s): %s", uid, exc)
        except OSError:
            return
        if total:
            log.info("Mért adatok / felszerelés pótolva: %d edzés", total)
        # Stravás edzések felszerelése, majd hőmérséklete: óránként felhasználónként összesen
        # egy adag Strava-hívás (az API-keret miatt); utána az időjárás-tartalék
        import temp_weather
        while True:
            n = t = w = 0
            try:
                for uid in sorted(os.listdir(MULTI_DATA_DIR)):
                    try:
                        _backfill_user(uid)            # az óra közben importált edzések (GPX-ből)
                        used = _strava_equipment_user(uid)
                        n += used
                        t += _strava_temp_user(uid, _STRAVA_EQUIP_PER_RUN - used)
                    except Exception as exc:
                        log.warning("Strava-felszerelés / hőmérséklet pótlása sikertelen (%s): %s", uid, exc)
                    try:
                        w += temp_weather.fill_user(uid)
                    except Exception as exc:
                        log.warning("Időjárás-hőmérséklet pótlása sikertelen (%s): %s", uid, exc)
            except OSError:
                pass
            if n or t or w:
                log.info("Pótolva – Strava-felszerelés: %d, Strava-hőmérséklet: %d, időjárás: %d edzés", n, t, w)
            time.sleep(3600)
    threading.Thread(target=run, name="metrics-backfill", daemon=True).start()
