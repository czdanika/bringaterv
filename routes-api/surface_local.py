"""Bringaterv API – burkolat a saját OSM-adatbázisból (surface_build.py építi).

  POST /api/surface/lookup         mintapontok → burkolat-osztály pontonként ({points: [[lat, lng], …]})
  GET  /api/admin/surface-db       az adatbázis és az építés állapota (admin)
  POST /api/admin/surface-db       építés / frissítés indítása (admin)

Ha nincs adatbázis, a lookup 503-at ad – a kliens ilyenkor az Overpass-lekérdezésre vált.
Havonta egyszer automatikusan frissít (csak ha már van adatbázis; az elsőt az admin indítja).
"""

import fcntl
import json
import math
import os
import sqlite3
import subprocess
import sys
import threading
import time
from array import array
from datetime import datetime, timezone

from flask import Blueprint, abort, g, jsonify, request

from auth import require_admin, require_auth
from config import log
from surface_build import DB, META, OSM_DIR, STATUS, _status

bp = Blueprint("surface_local", __name__)

MODES = {1: "asphalt", 2: "gravel", 3: "mtb", 4: "hiking"}
MAX_DIST_M = 40          # ennél messzebbi úthoz nem soroljuk a pontot
REFRESH_DAYS = 30
_LOCK = os.path.join(OSM_DIR, "build.lock")
_local = threading.local()
_started = False


def _read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _conn():
    """Szálanként egy csak olvasó kapcsolat; újranyit, ha az építés kicserélte a fájlt."""
    try:
        mtime = os.path.getmtime(DB)
    except OSError:
        return None
    c = getattr(_local, "conn", None)
    if c is None or getattr(_local, "mtime", None) != mtime:
        if c is not None:
            c.close()
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, check_same_thread=False)
        _local.conn, _local.mtime = c, mtime
    return c


def lookup(points: list) -> list:
    """Pontonként a legközelebbi út burkolat-osztálya (MAX_DIST_M-en belül), különben None."""
    c = _conn()
    if c is None:
        return None
    out = []
    for lat, lng in points:
        kx = 111320.0 * math.cos(math.radians(lat))
        ky = 110540.0
        dlat, dlng = MAX_DIST_M / ky, MAX_DIST_M / kx
        rows = c.execute(
            "SELECT s.mode, s.pts FROM seg_idx i JOIN seg s ON s.id = i.id"
            " WHERE i.minlat <= ? AND i.maxlat >= ? AND i.minlng <= ? AND i.maxlng >= ?",
            (lat + dlat, lat - dlat, lng + dlng, lng - dlng)).fetchall()
        best, best_d = None, MAX_DIST_M * MAX_DIST_M
        for mode, blob in rows:
            a = array("i")
            a.frombytes(blob)
            # helyi síkvetület méterben, a pont az origó
            px = [(a[k + 1] / 1e6 - lng) * kx for k in range(0, len(a), 2)]
            py = [(a[k] / 1e6 - lat) * ky for k in range(0, len(a), 2)]
            for k in range(len(px) - 1):
                ax, ay, bx, by = px[k], py[k], px[k + 1], py[k + 1]
                vx, vy = bx - ax, by - ay
                ll = vx * vx + vy * vy
                t = 0.0 if ll == 0 else max(0.0, min(1.0, -(ax * vx + ay * vy) / ll))
                cx, cy = ax + t * vx, ay + t * vy
                d = cx * cx + cy * cy
                if d < best_d:
                    best_d, best = d, mode
        out.append(MODES.get(best))
    return out


def status() -> dict:
    meta = _read_json(META) if os.path.exists(DB) else {}
    st = _read_json(STATUS)
    fresh = st.get("updated_at") and (time.time() - datetime.strptime(st["updated_at"], "%Y-%m-%dT%H:%M:%SZ")
                                       .replace(tzinfo=timezone.utc).timestamp()) < 60
    if st.get("running") and not fresh and not _build_running():
        st = {**st, "running": False, "phase": "error", "error": "Az építés megszakadt."}
    return {"available": bool(meta), "meta": meta, "build": st}


def _build_running() -> bool:
    os.makedirs(OSM_DIR, exist_ok=True)
    with open(_LOCK, "a") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(f, fcntl.LOCK_UN)
            return False
        except OSError:
            return True


def start_build() -> bool:
    """Elindítja az építést külön folyamatban; False, ha már fut."""
    if _build_running():
        return False
    here = os.path.dirname(os.path.abspath(__file__))
    # a zár a gyerekfolyamatot fogja végig (flock -c helyett Python-oldali wrapper)
    _status(phase="download", running=True)
    code = (f"import fcntl,sys,runpy; f=open({_LOCK!r},'a'); fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); "
            f"sys.argv=['surface_build.py']; runpy.run_path({os.path.join(here, 'surface_build.py')!r}, run_name='__main__')")
    subprocess.Popen([sys.executable, "-c", code], cwd=here, start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


def _age_days() -> float | None:
    built = _read_json(META).get("built_at")
    if not built:
        return None
    try:
        t = datetime.strptime(built, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - t).total_seconds() / 86400


def _loop():
    time.sleep(600)
    while True:
        try:
            age = _age_days()
            if age is not None and age >= REFRESH_DAYS and start_build():
                log.info("Burkolat-adatbázis: havi frissítés elindítva (%.0f napos)", age)
        except Exception as exc:
            log.warning("Burkolat-adatbázis ütemező hiba: %s", exc)
        time.sleep(6 * 3600)


def start_scheduler():
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, name="surface-db-refresh", daemon=True).start()


@bp.route("/api/surface/lookup", methods=["POST"])
@require_auth
def surface_lookup():
    pts = (request.get_json(silent=True) or {}).get("points")
    if not isinstance(pts, list) or not pts or len(pts) > 6000:
        abort(400, description="Érvénytelen pontlista.")
    try:
        points = [(float(p[0]), float(p[1])) for p in pts]
    except (TypeError, ValueError, IndexError):
        abort(400, description="Érvénytelen pontlista.")
    modes = lookup(points)
    if modes is None:
        abort(503, description="Nincs helyi burkolat-adatbázis.")
    return jsonify({"modes": modes, "built_at": _read_json(META).get("built_at")})


@bp.route("/api/admin/surface-db", methods=["GET"])
@require_auth
@require_admin
def admin_surface_status():
    return jsonify(status())


@bp.route("/api/admin/surface-db", methods=["POST"])
@require_auth
@require_admin
def admin_surface_build():
    if not start_build():
        abort(409, description="Az építés már fut.")
    log.info("Burkolat-adatbázis építése elindítva (admin: %s)", g.user["email"])
    return jsonify(status())
