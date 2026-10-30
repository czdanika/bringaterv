"""Bringaterv API – publikus (auth nélküli) megosztás.

Egyetlen végpont: egy útvonal vagy edzés (workout) nyilvános megtekintése a
8-hex id alapján. A QR-kódos megosztáshoz / nézőoldalhoz (view.html) készült.
Csak olvasás, szerkesztés nincs.

A könyvtár forrása a felhasználónkénti index.json (<MULTI_DATA_DIR>/<uid>/routes/),
ezért elsődlegesen ott keresünk; a régi SQLite `routes` tábla csak tartalék.

Csak a felhasználó által nyilvánossá tett elem látszik (index-bejegyzés: "public": true –
a megosztó ablak kapcsolója állítja, a QR-kódos PDF / kép magától bekapcsolja).
Teljesen kikapcsolható a PUBLIC_SHARE_ENABLED=false környezeti változóval.
"""

import glob
import json
import os

from flask import Blueprint, abort, jsonify

from config import MULTI_DATA_DIR, log
from storage import _user_routes_dir
from utils import _safe_id

bp = Blueprint("api_public", __name__)

PUBLIC_SHARE_ENABLED = os.environ.get("PUBLIC_SHARE_ENABLED", "true").lower() not in (
    "0", "false", "no", "off",
)


def _read_gpx(routes_dir: str, rid: str):
    path = os.path.join(routes_dir, f"{rid}.gpx")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError as exc:
        log.error("Publikus GPX olvasási hiba (%s): %s", rid, exc)
        return None


def _find_in_indexes(rid: str):
    """(routes_dir, index-bejegyzés) a felhasználói index.json-okból, vagy None."""
    for ix in glob.glob(os.path.join(MULTI_DATA_DIR, "*", "routes", "index.json")):
        try:
            with open(ix, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, list):
            continue
        for entry in data:
            if isinstance(entry, dict) and entry.get("id") == rid:
                return os.path.dirname(ix), entry
    return None


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _meta_from_index(e: dict) -> dict:
    kind = "workout" if e.get("type") == "workout" else "route"
    dist_km = _num(e.get("distance"))
    return {
        "name":        e.get("name"),
        "date":        e.get("start_time") or e.get("date"),
        "distanceM":   dist_km * 1000 if dist_km is not None else None,
        "durationMin": _num(e.get("duration")),
        "elevationM":  _num(e.get("elevation")),
        "type":        e.get("sport_type") or (e.get("type") if kind == "route" else "cycling"),
        "kind":        kind,
        "description": e.get("description") or None,
        "avgSpeed":    _num(e.get("avg_speed_kmh")),
        "maxSpeed":    _num(e.get("max_speed_kmh")),
        "avgHr":       _num(e.get("avg_heartrate")),
        "maxHr":       _num(e.get("max_heartrate")),
        "avgCadence":  _num(e.get("avg_cadence")),
        "avgPower":    _num(e.get("avg_watts")),
        "maxPower":    _num(e.get("max_watts")),
        "calories":    _num(e.get("calories")),
        "kilojoules":  _num(e.get("kilojoules")),
    }


@bp.route("/api/public/route/<rid>", methods=["GET"])
def public_route(rid: str):
    if not PUBLIC_SHARE_ENABLED:
        abort(404)
    rid = _safe_id(rid)

    found = _find_in_indexes(rid)
    if found:
        routes_dir, entry = found
        if entry.get("public") is not True:
            return jsonify({"found": False}), 404   # a tulajdonos nem tette nyilvánossá
        meta = _meta_from_index(entry)
    else:
        # A régi SQLite tábla elemeinek nincs megosztási jelzője – nem nyilvánosak
        return jsonify({"found": False}), 404

    gpx = _read_gpx(routes_dir, rid)
    if gpx is None:
        return jsonify({"found": False}), 404

    return jsonify({"found": True, "type": meta["kind"], "meta": meta, "gpx": gpx})
