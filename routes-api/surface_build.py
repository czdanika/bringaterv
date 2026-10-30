"""Saját burkolat-adatbázis építése a Geofabrik magyar OSM-kivonatából.

Külön folyamatként fut (surface_local.start_build indítja), hogy a webkiszolgálót ne terhelje:
  1. letölti a hungary-latest.osm.pbf-et (~300 MB),
  2. kiszedi az utakat (highway) a burkolat-osztályukkal (aszfalt / murva / földút / ösvény),
  3. rövid darabokra bontva SQLite-ba írja, R*Tree térbeli indexszel,
  4. a kész fájlt atomikusan a helyére teszi; a letöltött kivonatot törli.

Állapot: OSM_DIR/status.json (fázis, haladás, hiba), eredmény: OSM_DIR/surface.sqlite + meta.json.
"""

import json
import os
import sqlite3
import sys
import time
from array import array
from datetime import datetime, timezone

OSM_DIR = os.environ.get("OSM_DIR", "/data/osm")
PBF_URL = os.environ.get("OSM_PBF_URL", "https://download.geofabrik.de/europe/hungary-latest.osm.pbf")
DB = os.path.join(OSM_DIR, "surface.sqlite")
STATUS = os.path.join(OSM_DIR, "status.json")
META = os.path.join(OSM_DIR, "meta.json")

# A kliens (src/map/surfaceAnalysis.js) wayMode()-jával azonos besorolás
SURFACE_TO_MODE = {
    "asphalt": "asphalt", "paved": "asphalt", "concrete": "asphalt", "concrete:plates": "asphalt",
    "concrete:lanes": "asphalt", "metal": "asphalt",
    "cobblestone": "gravel", "sett": "gravel", "paving_stones": "gravel", "gravel": "gravel",
    "fine_gravel": "gravel", "compacted": "gravel", "pebblestone": "gravel", "unpaved": "gravel",
    "gravel;grass": "gravel",
    "dirt": "mtb", "ground": "mtb", "grass": "mtb", "earth": "mtb", "mud": "mtb", "sand": "mtb",
    "woodchips": "mtb", "rock": "mtb",
}
HIGHWAY_TO_MODE = {
    "motorway": "asphalt", "trunk": "asphalt", "primary": "asphalt", "secondary": "asphalt",
    "tertiary": "asphalt", "residential": "asphalt", "service": "asphalt", "living_street": "asphalt",
    "unclassified": "asphalt", "cycleway": "asphalt", "road": "asphalt",
    "track": "mtb", "path": "hiking", "footway": "hiking", "bridleway": "hiking",
}
MODE_CODE = {"asphalt": 1, "gravel": 2, "mtb": 3, "hiking": 4}
# Nem járható vagy nem valódi út – kimarad
SKIP_HIGHWAY = {"proposed", "construction", "abandoned", "disused", "platform", "corridor", "elevator",
                "bus_stop", "services", "rest_area", "raceway", "razed"}
CHUNK = 12          # pont / darab – kis befoglaló téglalap, gyors térbeli keresés


def way_mode(tags) -> str:
    surface = tags.get("surface")
    highway = tags.get("highway")
    if surface in SURFACE_TO_MODE:
        return SURFACE_TO_MODE[surface]
    if highway == "track":
        return "gravel" if tags.get("tracktype") in ("grade1", "grade2") else "mtb"
    return HIGHWAY_TO_MODE.get(highway) or "asphalt"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _status(**kw) -> None:
    data = {"updated_at": _now(), **kw}
    tmp = STATUS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, STATUS)


def _download(dest: str) -> None:
    import requests
    with requests.get(PBF_URL, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("Content-Length") or 0)
        got, last = 0, 0.0
        with open(dest + ".part", "wb") as f:
            for block in r.iter_content(1 << 20):
                f.write(block)
                got += len(block)
                if time.time() - last > 2:
                    last = time.time()
                    _status(phase="download", running=True, done_mb=round(got / 1e6), total_mb=round(total / 1e6) or None)
    os.replace(dest + ".part", dest)


def _build(pbf: str, out: str) -> dict:
    import osmium
    if os.path.exists(out):
        os.remove(out)
    conn = sqlite3.connect(out)
    conn.executescript("""
        PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
        CREATE TABLE seg (id INTEGER PRIMARY KEY, mode INTEGER NOT NULL, pts BLOB NOT NULL);
        CREATE VIRTUAL TABLE seg_idx USING rtree(id, minlat, maxlat, minlng, maxlng);
    """)
    sid, ways, batch_s, batch_i = 0, 0, [], []
    last = 0.0
    fp = (osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY)
          .with_locations()
          .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
          .with_filter(osmium.filter.KeyFilter("highway")))
    for w in fp:
        hw = w.tags.get("highway")
        if not hw or hw in SKIP_HIGHWAY:
            continue
        pts = [(n.lat, n.lon) for n in w.nodes if n.location.valid()]
        if len(pts) < 2:
            continue
        mode = MODE_CODE[way_mode(w.tags)]
        ways += 1
        for i in range(0, len(pts) - 1, CHUNK - 1):
            part = pts[i:i + CHUNK]
            if len(part) < 2:
                break
            sid += 1
            a = array("i")
            for lat, lng in part:
                a.append(round(lat * 1e6))
                a.append(round(lng * 1e6))
            lats = [p[0] for p in part]
            lngs = [p[1] for p in part]
            batch_s.append((sid, mode, a.tobytes()))
            batch_i.append((sid, min(lats), max(lats), min(lngs), max(lngs)))
        if len(batch_s) >= 20000:
            conn.executemany("INSERT INTO seg VALUES (?,?,?)", batch_s)
            conn.executemany("INSERT INTO seg_idx VALUES (?,?,?,?,?)", batch_i)
            batch_s, batch_i = [], []
            if time.time() - last > 2:
                last = time.time()
                _status(phase="process", running=True, ways=ways)
    if batch_s:
        conn.executemany("INSERT INTO seg VALUES (?,?,?)", batch_s)
        conn.executemany("INSERT INTO seg_idx VALUES (?,?,?,?,?)", batch_i)
    conn.commit()
    conn.close()
    try:
        data_ts = osmium.io.Reader(pbf, osmium.osm.NOTHING).header().get("osmosis_replication_timestamp") or None
    except Exception:
        data_ts = None
    return {"ways": ways, "segments": sid, "data_timestamp": data_ts}


def main() -> int:
    os.makedirs(OSM_DIR, exist_ok=True)
    pbf = os.path.join(OSM_DIR, "hungary-latest.osm.pbf")
    started = time.time()
    try:
        _status(phase="download", running=True)
        _download(pbf)
        _status(phase="process", running=True, ways=0)
        info = _build(pbf, DB + ".new")
        os.replace(DB + ".new", DB)
        meta = {"built_at": _now(), "source": PBF_URL, "seconds": round(time.time() - started),
                "size_mb": round(os.path.getsize(DB) / 1e6, 1), **info}
        with open(META, "w", encoding="utf-8") as f:
            json.dump(meta, f)
        _status(phase="done", running=False, **meta)
        return 0
    except Exception as exc:  # az admin felület mutatja
        _status(phase="error", running=False, error=f"{type(exc).__name__}: {exc}"[:300])
        return 1
    finally:
        for p in (pbf, pbf + ".part", DB + ".new"):
            try:
                os.remove(p)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
