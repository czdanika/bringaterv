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

import jwt as pyjwt
from flask import Blueprint, abort, jsonify, request

from config import MULTI_DATA_DIR, log
from security import _decode_token
from share import count_view, hidden, strip_gpx
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
        "avgTemp":     _num(e.get("avg_temp")),
        "tempSource":  e.get("temp_source") or None,
        "wind":        e.get("wind") if isinstance(e.get("wind"), dict) else None,
    }


# a tulajdonos által elrejtett adatok a metából is kikerülnek
_HIDE_META = {
    "hr": ("avgHr", "maxHr"), "power": ("avgPower", "maxPower", "kilojoules"), "cad": ("avgCadence",),
    "temp": ("avgTemp", "tempSource"), "desc": ("description",), "wind": ("wind",),
}


def _is_owner(routes_dir: str) -> bool:
    """A megnyitó maga a tulajdonos? (a nézőoldal elküldi a belépési tokent, ha van) – őt nem számoljuk."""
    h = request.headers.get("Authorization", "")
    if not h.startswith("Bearer "):
        return False
    try:
        sub = _decode_token(h[7:]).get("sub")
    except pyjwt.InvalidTokenError:
        return False
    return bool(sub) and os.path.basename(os.path.dirname(routes_dir)) == sub


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

    hide = hidden(entry)
    for k in hide:
        for f in _HIDE_META.get(k, ()):
            meta[f] = None
    meta["hide"] = sorted(hide)
    gpx = strip_gpx(gpx, hide)

    owner = _is_owner(routes_dir)
    if not owner:
        try:
            ip = (request.headers.get("X-Forwarded-For") or request.remote_addr or "").split(",")[0].strip()
            count_view(rid, ip, request.headers.get("User-Agent", ""))
        except Exception as exc:   # a számláló hibája ne akassza meg a megjelenítést
            log.warning("Megnyitás számlálása (%s): %s", rid, exc)
    meta["owner"] = owner
    return jsonify({"found": True, "type": meta["kind"], "meta": meta, "gpx": gpx})
