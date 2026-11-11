"""Bringaterv – beltéri (GPS nélküli) edzések: görgő, okosgörgő, Zwift / MyWhoosh, spinning.

Ezeknek nincs nyomvonaluk, ezért nem GPX-ként tárolódnak: a könyvtári bejegyzés `indoor: true`
jelzést kap, a mért adatsorok (idő, táv, sebesség, pulzus, kadencia, watt, hőmérséklet) egy
kísérő `<id>.json` fájlba kerülnek (oszloponként, tömören). A statisztika, a forma, a
felszerelés és a Kezdőlap a bejegyzés számaiból dolgozik, így ezeket is beszámolja; az
Elemzés az adatsorokból rajzol grafikont (térkép nélkül).

  fit_streams(fit_bytes)            → (session, streams) – a FIT „record” üzenetei pozíció nélkül is
  strava_streams(streams_json)      → streams – a Strava időalapú adatsoraiból
  save_indoor(user_id, …)           → {ok, entry} – mentés (+ eredeti FIT), mint a többi import
  load_streams(routes_dir, rid)     → streams dict vagy None

Adatsor-formátum (`<id>.json`): {"v": 1, "start": ISO, "t": [mp], "d": [m], "v_kmh": [...],
"hr": [...], "cad": [...], "p": [...], "temp": [...]} – a hiányzó sorok elmaradnak.
"""

import io
import json
import os
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from config import log
from storage import _user_routes_dir
from utils import _load_index, _now_dt, append_index, find_cross_source_duplicate

STREAMS_V = 1
_TZ = ZoneInfo("Europe/Budapest")
MAX_POINTS = 20000          # ~5,5 óra 1 Hz-en; hosszabbnál ritkítunk


def _r(v, nd=1):
    return None if v is None else (round(float(v), nd) if nd else int(round(float(v))))


def _compact(rows: list) -> dict:
    """Soronkénti mérésekből oszlopos, tömör adatsor (a teljesen üres oszlopok elmaradnak)."""
    if len(rows) > MAX_POINTS:
        step = len(rows) / MAX_POINTS
        rows = [rows[int(i * step)] for i in range(MAX_POINTS)]
    out = {"v": STREAMS_V}
    for key, nd in (("t", 0), ("d", 1), ("v_kmh", 2), ("hr", 0), ("cad", 0), ("p", 0), ("temp", 1)):
        col = [_r(r.get(key), nd) for r in rows]
        if any(x is not None for x in col):
            out[key] = col
    return out


def fit_streams(fit_bytes: bytes) -> tuple:
    """FIT → (session-összesítő, adatsor-sorok). A pozíció nélküli rekordokat is megtartja."""
    import fitdecode
    from fit_gpx import _equipment_collect, _fit_sport, _fv
    rows, session, equipment, t0 = [], {}, {}, None
    with fitdecode.FitReader(io.BytesIO(fit_bytes), check_crc=fitdecode.CrcCheck.DISABLED) as fr:
        for frame in fr:
            if frame.frame_type != fitdecode.FIT_FRAME_DATA:
                continue
            if frame.name == "record":
                ts = _fv(frame, "timestamp")
                if not isinstance(ts, datetime):
                    continue
                t0 = t0 or ts
                sp = _fv(frame, "enhanced_speed", "speed")
                rows.append({
                    "t": (ts - t0).total_seconds(), "d": _fv(frame, "distance"),
                    "v_kmh": sp * 3.6 if sp is not None else None,
                    "hr": _fv(frame, "heart_rate"), "cad": _fv(frame, "cadence"),
                    "p": _fv(frame, "power"), "temp": _fv(frame, "temperature"),
                })
            elif frame.name in ("file_id", "bike_profile", "device_info"):
                _equipment_collect(frame, equipment)
            elif frame.name == "session" and not session:
                session = {
                    "sport":       _fit_sport(_fv(frame, "sport")),
                    "sub_sport":   str(_fv(frame, "sub_sport") or ""),
                    "start_time":  _fv(frame, "start_time"),
                    "moving_s":    _fv(frame, "total_timer_time"),
                    "elapsed_s":   _fv(frame, "total_elapsed_time"),
                    "distance_m":  _fv(frame, "total_distance"),
                    "calories":    _fv(frame, "total_calories"),
                    "avg_hr":      _fv(frame, "avg_heart_rate"),
                    "max_hr":      _fv(frame, "max_heart_rate"),
                    "avg_power":   _fv(frame, "avg_power"),
                    "max_power":   _fv(frame, "max_power"),
                    "avg_cadence": _fv(frame, "avg_cadence"),
                    "avg_speed":   _fv(frame, "enhanced_avg_speed", "avg_speed"),
                    "max_speed":   _fv(frame, "enhanced_max_speed", "max_speed"),
                }
    if equipment:
        session["equipment"] = equipment
    if not session.get("start_time") and t0:
        session["start_time"] = t0
    return session, rows


def strava_streams(streams: dict) -> list:
    """A Strava időalapú adatsoraiból (key_by_type) soronkénti mérések."""
    t = (streams.get("time") or {}).get("data") or []
    col = lambda k: (streams.get(k) or {}).get("data") or [None] * len(t)   # noqa: E731
    d, v, hr, cad, p, temp = col("distance"), col("velocity_smooth"), col("heartrate"), col("cadence"), col("watts"), col("temp")
    return [{"t": t[i], "d": d[i], "v_kmh": v[i] * 3.6 if v[i] is not None else None,
             "hr": hr[i], "cad": cad[i], "p": p[i], "temp": temp[i]} for i in range(len(t))]


def _stats(rows: list) -> dict:
    """Összesítő az adatsorból (ha a forrás nem adta meg)."""
    vals = lambda k, lo=0: [r[k] for r in rows if r.get(k) is not None and r[k] > lo]   # noqa: E731
    avg = lambda a: sum(a) / len(a) if a else None                                     # noqa: E731
    hr, cad, p, v = vals("hr"), vals("cad"), vals("p", -1), vals("v_kmh")
    dists = [r["d"] for r in rows if r.get("d") is not None]
    # mozgásidő: ahol halad (sebesség vagy kadencia / watt van), 30 mp-nél kisebb szünetekkel
    moving = 0.0
    for a, b in zip(rows, rows[1:]):
        dt = (b.get("t") or 0) - (a.get("t") or 0)
        if 0 < dt <= 30 and ((b.get("v_kmh") or 0) > 2 or (b.get("cad") or 0) > 0 or (b.get("p") or 0) > 0):
            moving += dt
    # mechanikai munka: watt × idő (kJ)
    work = 0.0
    for a, b in zip(rows, rows[1:]):
        dt = (b.get("t") or 0) - (a.get("t") or 0)
        if 0 < dt <= 30 and b.get("p") is not None:
            work += b["p"] * dt
    return {
        "distance_m": max(dists) if dists else 0, "moving_s": moving or ((rows[-1].get("t") or 0) if rows else 0),
        "elapsed_s": (rows[-1].get("t") or 0) if rows else 0,
        "avg_hr": avg(hr), "max_hr": max(hr) if hr else None, "avg_cadence": avg(cad),
        "avg_power": avg(p), "max_power": max(p) if p else None, "max_speed_kmh": max(v) if v else None,
        "kilojoules": work / 1000 if work else None,
    }


def save_indoor(user_id: str, *, rows: list, session: dict, name: str, source: str, id_field: str, source_id,
                start_dt: datetime = None, fit_bytes: bytes = None, dedup: bool = False, extra: dict = None) -> dict:
    """Beltéri edzés mentése a könyvtárba. Visszaad: {ok, skipped?, reason?, entry?}."""
    if not rows and not (session.get("moving_s") or session.get("elapsed_s")):
        return {"ok": False, "error": "Az edzésben nincs mért adat."}
    routes_dir = _user_routes_dir(user_id)
    idx_path = os.path.join(routes_dir, "index.json")
    s = {**_stats(rows), **{k: v for k, v in session.items() if v is not None}}
    start = start_dt or session.get("start_time")
    if not isinstance(start, datetime):
        start = datetime.now(timezone.utc)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    dist_m = float(s.get("distance_m") or 0)
    if dedup and dist_m:
        dup = find_cross_source_duplicate(_load_index(idx_path), start.timestamp(), dist_m, id_field)
        if dup:
            return {"ok": True, "skipped": True, "reason": "duplicate", "duplicate_local_id": dup["id"], "duplicate_name": dup.get("name")}

    new_id = uuid.uuid4().hex[:8]
    data = _compact(rows)
    data["start"] = start.astimezone(timezone.utc).isoformat()
    with open(os.path.join(routes_dir, f"{new_id}.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    if fit_bytes:
        with open(os.path.join(routes_dir, f"{new_id}.fit"), "wb") as f:
            f.write(fit_bytes)
    from fit_gpx import equipment_fields
    mov = s.get("moving_s") or s.get("elapsed_s")
    avg_sp = s.get("avg_speed")
    entry = {
        "id":            new_id,
        "name":          name or "Beltéri tekerés",
        "type":          "workout",
        "indoor":        True,
        "sport_type":    s.get("sport") if s.get("sport") and s.get("sport") != "other" else "cycling",
        "distance":      round(dist_m / 1000, 2),
        "duration":      round(mov / 60) if mov else None,
        "elevation":     0,
        "date":          start.astimezone(_TZ).strftime("%Y-%m-%d"),
        "start_time":    start.astimezone(timezone.utc).isoformat(),
        id_field:        source_id,
        "source":        source,
        "has_fit":       bool(fit_bytes),
        "imported_at":   _now_dt(),
        "include_in_stats": True,
        "description":   "",
        "calories":      _r(s.get("calories"), 0),
        "kilojoules":    _r(s.get("kilojoules"), 0),
        "avg_heartrate": _r(s.get("avg_hr"), 0),
        "max_heartrate": _r(s.get("max_hr"), 0),
        "avg_watts":     _r(s.get("avg_power"), 0),
        "max_watts":     _r(s.get("max_power"), 0),
        "avg_cadence":   _r(s.get("avg_cadence"), 0),
        "avg_speed_kmh": round(avg_sp * 3.6, 2) if avg_sp else (round(dist_m / 1000 / (mov / 3600), 2) if dist_m and mov else None),
        "max_speed_kmh": round(s["max_speed"] * 3.6, 2) if s.get("max_speed") else _r(s.get("max_speed_kmh"), 2),
        **equipment_fields(s.get("equipment")),
        **(extra or {}),
    }
    append_index(idx_path, entry)
    log.info("Beltéri edzés mentve (%s, %s): %s km, %s perc", source, new_id, entry["distance"], entry["duration"])
    return {"ok": True, "skipped": False, "entry": entry}


def load_streams(routes_dir: str, rid: str):
    try:
        with open(os.path.join(routes_dir, f"{rid}.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def save_indoor_from_fit(user_id: str, fit_bytes: bytes, *, name: str, source: str, id_field: str, source_id,
                         start_dt: datetime = None, dedup: bool = False, extra: dict = None) -> dict:
    """FIT-ből (pozíció nélkül) – a komputeres importok közös útja."""
    try:
        session, rows = fit_streams(fit_bytes)
    except Exception as exc:
        log.warning("Beltéri FIT feldolgozási hiba (%s %s): %s", source, source_id, exc)
        return {"ok": False, "error": "A FIT-fájl nem olvasható."}
    return save_indoor(user_id, rows=rows, session=session, name=name, source=source, id_field=id_field,
                       source_id=source_id, start_dt=start_dt, fit_bytes=fit_bytes, dedup=dedup, extra=extra)
