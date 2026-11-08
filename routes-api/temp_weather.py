"""Bringaterv API – hőmérséklet az időjárásból, ahol az eszköz nem mért.

Az Apple Watch, a telefon és sok óra nem mér környezeti hőmérsékletet, ezért ezeknél
az edzéseknél az Open-Meteo óránkénti adatából (az indulás helyén, az edzés idejére)
számoljuk az átlagot, a minimumot és a maximumot. Az indexben temp_source = „weather”
jelöli – a felület „időjárás szerint” felirattal mutatja, mert ez nem az eszköz mérése.

  • régebbi edzés (7 napnál régebbi): archive-api.open-meteo.com (ERA5, ~5 nap késés);
  • friss edzés: api.open-meteo.com forecast (a múltbeli órákra is ad adatot).

Mikor fut: óránként a háttérben (gpx_metrics.backfill_all), és mentés / import után
pár másodperccel (fill_soon) – a mért hőmérsékletű (temp_source „device”) és a még
Strava-ellenőrzésre váró edzéseket kihagyja. Kész: entry["temp_v"].
"""

import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone

import requests

from config import MULTI_DATA_DIR, log
from gpx_metrics import METRICS_VERSION, TEMP_VERSION, _merge_save, temp_summary
from utils import _load_index

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_PER_RUN = 200                      # felhasználónként óránként (Open-Meteo: 10 000 / nap ingyen)
_UA = {"User-Agent": "Bringaterv/1.0 (self-hosted)"}

_TRKPT_RE = re.compile(r"<trkpt\b([^>]*)>(.*?)</trkpt>", re.S)
_LAT_RE = re.compile(r'\blat="(-?\d+(?:\.\d+)?)"')
_LON_RE = re.compile(r'\blon="(-?\d+(?:\.\d+)?)"')
_TIME_RE = re.compile(r"<time>([^<]+)</time>")


def _dt(s: str):
    try:
        d = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def track_window(gpx: str):
    """(lat, lon, kezdés, vége) a GPX első / utolsó időbélyeges pontjából – vagy None."""
    lat = lon = start = end = None
    for m in _TRKPT_RE.finditer(gpx or ""):
        tm = _TIME_RE.search(m.group(2))
        if not tm:
            continue
        t = _dt(tm.group(1))
        if not t:
            continue
        if start is None:
            la, lo = _LAT_RE.search(m.group(1)), _LON_RE.search(m.group(1))
            if not la or not lo:
                continue
            lat, lon, start = float(la.group(1)), float(lo.group(1)), t
        end = t
    if start is None or end is None:
        return None
    return lat, lon, start, end


def weather_temps(lat: float, lon: float, start: datetime, end: datetime):
    """{avg_temp, min_temp, max_temp} az edzés óráira (UTC), vagy None."""
    start, end = start.astimezone(timezone.utc), end.astimezone(timezone.utc)
    if end < start:
        start, end = end, start
    if end - start > timedelta(days=3):          # hibás időbélyeg – ne kérjünk le heteket
        end = start + timedelta(hours=12)
    old = datetime.now(timezone.utc) - end > timedelta(days=7)
    params = {"latitude": round(lat, 3), "longitude": round(lon, 3), "hourly": "temperature_2m",
              "start_date": start.strftime("%Y-%m-%d"), "end_date": end.strftime("%Y-%m-%d"), "timezone": "GMT"}
    r = requests.get(ARCHIVE_URL if old else FORECAST_URL, params=params, headers=_UA, timeout=20)
    if r.status_code == 429:
        raise RuntimeError("Open-Meteo: túl sok kérés")
    if r.status_code != 200:
        return None
    h = r.json().get("hourly") or {}
    lo = start.replace(minute=0, second=0, microsecond=0)
    hi = end.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    vals = []
    for ts, v in zip(h.get("time") or [], h.get("temperature_2m") or []):
        t = _dt(ts)
        if v is not None and t and lo <= t <= hi:
            vals.append(float(v))
    return temp_summary(vals) if vals else None


def _candidates(idx: list) -> list:
    return [e for e in idx if e.get("type") == "workout"
            and e.get("temp_v") != TEMP_VERSION
            and e.get("temp_source") != "device"
            and e.get("metrics_v") == METRICS_VERSION                       # a GPX-et már átnéztük
            and (not e.get("strava_id") or e.get("strava_temp_v") == TEMP_VERSION)]  # a Strava előbb


def fill_user(uid: str, limit: int = _PER_RUN) -> int:
    routes_dir = os.path.join(MULTI_DATA_DIR, uid, "routes")
    idx_path = os.path.join(routes_dir, "index.json")
    if not os.path.isfile(idx_path):
        return 0
    todo = _candidates(_load_index(idx_path))[:limit]
    updates = {}
    for e in todo:
        try:
            with open(os.path.join(routes_dir, f"{e['id']}.gpx"), encoding="utf-8") as f:
                win = track_window(f.read())
        except OSError:
            win = None
        upd = {"temp_v": TEMP_VERSION}
        if win:
            try:
                res = weather_temps(*win)
            except RuntimeError:
                break                                   # keret: a következő körben folytatja
            except (requests.RequestException, ValueError):
                continue                                # átmeneti hiba – később újra
            if res:
                upd.update(res, temp_source="weather")
            elif datetime.now(timezone.utc) - win[3] < timedelta(days=2):
                continue                                # friss edzés: az adat még jöhet
            time.sleep(0.2)
        updates[e["id"]] = upd
    if updates:
        _merge_save(idx_path, updates)
    return len(updates)


def fill_soon(uid: str, delay: float = 4.0) -> None:
    """Mentés / import után: pár mp múlva, háttérszálon (az új edzés hamar kapjon hőmérsékletet)."""
    def run():
        time.sleep(delay)
        try:
            from gpx_metrics import _backfill_user
            _backfill_user(uid)                     # mért adatok + hőmérséklet a GPX-ből (importoknál)
            fill_user(uid, limit=10)
        except Exception as exc:
            log.warning("Időjárás-hőmérséklet sikertelen (%s): %s", uid, exc)
    threading.Thread(target=run, name="temp-weather", daemon=True).start()
