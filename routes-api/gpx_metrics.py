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
"""

import fcntl
import os
import re
import threading
import time
from datetime import datetime

from config import MULTI_DATA_DIR, log
from utils import _load_index, _save_index

METRICS_VERSION = 1
_PT_RE = re.compile(r"<trkpt\b.*?</trkpt>", re.S)
_TIME_RE = re.compile(r"<time>([^<]+)</time>")
_HR_RE = re.compile(r"<(?:\w+:)?hr>(\d+(?:\.\d+)?)</")
_CAD_RE = re.compile(r"<(?:\w+:)?cad>(\d+(?:\.\d+)?)</")
_PWR_RE = re.compile(r"<(?:\w+:)?(?:PowerInWatts|watts|power)>(\d+(?:\.\d+)?)</")


def _ts(s: str):
    try:
        return datetime.fromisoformat(s.strip().replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def gpx_metrics(gpx_text: str) -> dict:
    """{avg_watts, max_watts, weighted_avg_watts (NP), avg_heartrate, max_heartrate,
    avg_cadence} – csak ami a GPX-ben tényleg megvan."""
    pw, hr, cad = [], [], []
    for blk in _PT_RE.findall(gpx_text or ""):
        t = _TIME_RE.search(blk)
        ts = _ts(t.group(1)) if t else None
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
    return out


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
    return changed


_MERGE_KEYS = ("avg_watts", "max_watts", "weighted_avg_watts", "avg_heartrate", "max_heartrate",
               "avg_cadence", "metrics_v", "device", "device_maker", "bike_name", "sensors",
               "power_meter", "equip_v")


def _merge_save(idx_path: str, updates: dict) -> None:
    """Friss index + összefésülés: a számolás alatt a felhasználó is írhatott."""
    idx = _load_index(idx_path)
    for r in idx:
        u = updates.get(r.get("id"))
        if u:
            for k in _MERGE_KEYS:
                if r.get(k) is None and u.get(k) is not None:
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
        if e.get("equip_v") != EQUIP_VERSION and not e.get("strava_id"):
            fit_path = os.path.join(routes_dir, f"{e['id']}.fit")
            eq = {}
            if os.path.isfile(fit_path):
                with open(fit_path, "rb") as f:
                    eq = fit_equipment(f.read())
            e.update({k: v for k, v in equipment_fields(eq or gpx_equipment(gpx)).items() if e.get(k) is None})
        updates[e["id"]] = e
    _merge_save(idx_path, updates)
    return len(updates)


_STRAVA_EQUIP_PER_RUN = 40


def _strava_equipment_user(uid: str) -> int:
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
    for e in todo[:_STRAVA_EQUIP_PER_RUN]:
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
        # Stravás edzések felszerelése: óránként egy adag (a Strava API-keret miatt)
        while True:
            n = 0
            try:
                for uid in sorted(os.listdir(MULTI_DATA_DIR)):
                    try:
                        n += _strava_equipment_user(uid)
                    except Exception as exc:
                        log.warning("Strava-felszerelés pótlása sikertelen (%s): %s", uid, exc)
            except OSError:
                pass
            if n:
                log.info("Strava-felszerelés pótolva: %d edzés", n)
            time.sleep(3600)
    threading.Thread(target=run, name="metrics-backfill", daemon=True).start()
