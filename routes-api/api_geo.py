"""Bringaterv API – útpont-nevek (visszafelé geokódolás a szerveren, gyorsítótárral).

  POST /api/geo/place-names   {points: [[lat, lng], …]}  → {names: [str | null, …]}
        csak a már tárolt nevek (azonnal); null = még nem kérdeztük
  GET  /api/geo/place-name?lat=&lng=                     → {name: str | null}
        egy pont neve – ha nincs tárolva, a Nominatimtól (1 kérés/mp, sorban)
"""

from flask import Blueprint, abort, jsonify, request

import geo_location
from auth import require_auth

bp = Blueprint("api_geo", __name__)


def _coord(v, lo, hi):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if lo <= x <= hi else None


@bp.route("/api/geo/place-names", methods=["POST"])
@require_auth
def place_names():
    pts = (request.get_json(silent=True) or {}).get("points") or []
    if not isinstance(pts, list) or len(pts) > 1000:
        abort(400, description="Legfeljebb 1000 pont.")
    out = []
    for p in pts:
        lat = _coord(p[0], -90, 90) if isinstance(p, (list, tuple)) and len(p) >= 2 else None
        lng = _coord(p[1], -180, 180) if lat is not None else None
        out.append(geo_location.place_name_cached(lat, lng) if lng is not None else None)
    return jsonify({"names": out})


@bp.route("/api/geo/place-name", methods=["GET"])
@require_auth
def place_name():
    lat = _coord(request.args.get("lat"), -90, 90)
    lng = _coord(request.args.get("lng"), -180, 180)
    if lat is None or lng is None:
        abort(400, description="Érvénytelen koordináta.")
    return jsonify({"name": geo_location.place_name(lat, lng)})
