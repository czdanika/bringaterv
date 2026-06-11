"""Bringaterv API – útvonal végpontok (CRUD, geometry-bulk, FIT letöltés)."""

import os
import re
import uuid

from flask import Blueprint, abort, g, jsonify, request

from auth import require_auth
from config import log
from db import _db
from storage import _resolve_dirs
from strava_service import _add_strava_deny
from utils import _load_index, _now_date, _now_dt, _safe_id, _save_index

bp = Blueprint("api_routes", __name__)


@bp.route("/api/routes", methods=["GET"])
@require_auth
def list_routes():
    _, idx = _resolve_dirs()
    return jsonify(sorted(_load_index(idx), key=lambda r: r.get("date", ""), reverse=True))


# GPX trackpont regex (lat előbb – a saját és importált GPX-ek így állnak elő)
_TRKPT_RE = re.compile(r'<(?:trkpt|rtept)\b[^>]*\blat="([-\d.]+)"[^>]*\blon="([-\d.]+)"')


def _extract_track_points(gpx_path: str, every: int = 8, max_points: int = 300) -> list:
    """Egyszerűsített [lat, lon] lista egy GPX-ből (hőtérképhez – ritkított)."""
    try:
        with open(gpx_path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return []
    pts = []
    for i, m in enumerate(_TRKPT_RE.finditer(text)):
        if i % every:
            continue
        try:
            pts.append([round(float(m.group(1)), 5), round(float(m.group(2)), 5)])
        except ValueError:
            continue
    if len(pts) > max_points:
        step = len(pts) // max_points + 1
        pts = pts[::step]
    return pts


@bp.route("/api/routes/geometry-bulk", methods=["GET"])
@require_auth
def routes_geometry_bulk():
    """Edzések egyszerűsített geometriája egyetlen válaszban (hőtérképhez).
    Csak type=workout bejegyzések kerülnek be, és csak ha include_in_stats nincs False-ra állítva."""
    user_dir, idx = _resolve_dirs()
    index = _load_index(idx)
    out = []
    for entry in index:
        # Csak edzések – tervezett útvonalak nem kerülnek a hőtérképre
        if entry.get("type") != "workout":
            continue
        # Statisztikákból kizárt edzések sem kellenek
        if entry.get("include_in_stats") is False:
            continue
        rid = entry.get("id")
        if not rid:
            continue
        gpx_path = os.path.join(user_dir, f"{rid}.gpx")
        if not os.path.isfile(gpx_path):
            continue
        pts = _extract_track_points(gpx_path)
        if len(pts) < 2:
            continue
        out.append({
            "id":       rid,
            "name":     entry.get("name") or "",
            "sport":    entry.get("sport_type") or entry.get("type") or "cycling",
            "distance": entry.get("distance"),
            "date":     entry.get("date"),
            "points":   pts,
        })
    return jsonify({"tracks": out})


@bp.route("/api/routes", methods=["POST"])
@require_auth
def save_route():
    user_dir, idx = _resolve_dirs()
    data = request.get_json(silent=True)
    if not data:
        abort(400, description="Hiányzó JSON body")

    name             = (data.get("name") or "Névtelen útvonal").strip()
    gpx_content      = data.get("gpxContent", "").strip()
    fit_b64          = data.get("fitContent")     # opcionális base64-kódolt FIT binary
    distance         = data.get("distance")
    duration         = data.get("duration")
    elevation        = data.get("elevation")
    route_type       = data.get("type", "cycling")
    description      = (data.get("description") or "").strip()
    include_in_stats = data.get("include_in_stats", True)  # tervezett útvonalak False-t küldenek

    if not gpx_content:
        abort(400, description="Hiányzó gpxContent mező")

    index = _load_index(idx)
    if len(index) >= g.user.get("quota_routes", 50):
        kind = "Edzés" if route_type == "workout" else "Útvonal"
        abort(429, description=f"{kind} kvóta elérve ({g.user['quota_routes']} db max). Törölj néhányat a könyvtárból.")

    route_id = uuid.uuid4().hex[:8]
    gpx_path = os.path.join(user_dir, f"{route_id}.gpx")
    fit_path = os.path.join(user_dir, f"{route_id}.fit")
    try:
        with open(gpx_path, "w", encoding="utf-8") as f:
            f.write(gpx_content)
    except OSError as exc:
        log.error("GPX írási hiba: %s", exc)
        abort(500, description="Fájl írási hiba")

    has_fit = False
    if fit_b64:
        try:
            import base64
            fit_bytes = base64.b64decode(fit_b64, validate=True)
            with open(fit_path, "wb") as f:
                f.write(fit_bytes)
            has_fit = True
        except (ValueError, OSError) as exc:
            log.warning("FIT írási hiba (%s): %s – GPX megmarad, FIT kihagyva", route_id, exc)

    entry = {
        "id":          route_id,
        "name":             name,
        "date":             _now_date(),
        "distance":         round(distance, 1) if isinstance(distance, (int, float)) else None,
        "duration":         int(duration)      if isinstance(duration,  (int, float)) else None,
        "elevation":        int(elevation)     if isinstance(elevation, (int, float)) else None,
        "type":             route_type,
        "description":      description,
        "has_fit":          has_fit,
        "include_in_stats": bool(include_in_stats),
    }
    index = _load_index(idx)
    index.append(entry)
    try:
        _save_index(index, idx)
    except OSError:
        os.remove(gpx_path)
        if has_fit: os.remove(fit_path)
        abort(500, description="Index írási hiba")

    with _db() as conn:
        conn.execute("""
            INSERT INTO routes
              (id, user_id, name, date, created_at, distance_m,
               duration_min, elevation_m, route_type, description, gpx_path)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """, (
            route_id, g.user["id"], name, _now_date(), _now_dt(),
            distance * 1000 if isinstance(distance, (int, float)) else None,
            int(duration)   if isinstance(duration,  (int, float)) else None,
            int(elevation)  if isinstance(elevation, (int, float)) else None,
            route_type, description, gpx_path,
        ))

    log.info("Új útvonal: %s (%s)", route_id, name)
    return jsonify({"id": route_id}), 201


@bp.route("/api/routes/<route_id>", methods=["GET"])
@require_auth
def get_route(route_id: str):
    route_id = _safe_id(route_id)
    user_dir, _ = _resolve_dirs()
    gpx_path = os.path.join(user_dir, f"{route_id}.gpx")
    if not os.path.isfile(gpx_path):
        abort(404, description=f"Útvonal nem található: {route_id}")
    try:
        with open(gpx_path, encoding="utf-8") as f:
            content = f.read()
    except OSError as exc:
        log.error("GPX olvasási hiba: %s", exc)
        abort(500)
    return content, 200, {"Content-Type": "application/gpx+xml; charset=utf-8"}


@bp.route("/api/routes/<route_id>", methods=["PATCH"])
@require_auth
def update_route(route_id: str):
    route_id = _safe_id(route_id)
    _, idx   = _resolve_dirs()
    data     = request.get_json(silent=True) or {}
    index    = _load_index(idx)
    entry    = next((r for r in index if r.get("id") == route_id), None)
    if not entry:
        abort(404, description=f"Útvonal nem található: {route_id}")
    if "name"        in data: entry["name"]        = (data["name"] or "Névtelen").strip()
    if "type"        in data: entry["type"]        = data["type"]
    if "description" in data: entry["description"] = (data["description"] or "").strip()
    if "include_in_stats" in data: entry["include_in_stats"] = bool(data["include_in_stats"])
    try:
        _save_index(index, idx)
    except OSError:
        abort(500)
    return jsonify(entry)


@bp.route("/api/routes/<route_id>", methods=["DELETE"])
@require_auth
def delete_route(route_id: str):
    route_id      = _safe_id(route_id)
    user_dir, idx = _resolve_dirs()
    gpx_path      = os.path.join(user_dir, f"{route_id}.gpx")
    fit_path      = os.path.join(user_dir, f"{route_id}.fit")
    if not os.path.isfile(gpx_path):
        abort(404, description=f"Útvonal nem található: {route_id}")
    # Strava-os importnál → deny-listbe (hogy ne kerüljön re-importra a következő sync-en)
    existing = _load_index(idx)
    deleted_entry = next((r for r in existing if r.get("id") == route_id), None)
    if deleted_entry and deleted_entry.get("strava_id"):
        try: _add_strava_deny(g.user["id"], deleted_entry["strava_id"])
        except Exception as exc: log.warning("Strava deny-list update hiba: %s", exc)
    try:
        os.remove(gpx_path)
        if os.path.isfile(fit_path):
            os.remove(fit_path)
    except OSError as exc:
        log.error("Törlési hiba: %s", exc)
        abort(500)
    _save_index([r for r in existing if r.get("id") != route_id], idx)
    with _db() as conn:
        conn.execute("DELETE FROM routes WHERE id = ? AND user_id = ?",
                     (route_id, g.user["id"]))
    return "", 204


@bp.route("/api/routes/<route_id>/fit", methods=["GET"])
@require_auth
def get_route_fit(route_id: str):
    """Eredeti FIT bináris letöltése (csak ha FIT-ből lett mentve)."""
    route_id     = _safe_id(route_id)
    user_dir, _  = _resolve_dirs()
    fit_path     = os.path.join(user_dir, f"{route_id}.fit")
    if not os.path.isfile(fit_path):
        abort(404, description="FIT fájl nem érhető el ehhez az útvonalhoz")
    with open(fit_path, "rb") as f:
        content = f.read()
    return content, 200, {
        "Content-Type": "application/vnd.ant.fit",
        "Content-Disposition": f'attachment; filename="{route_id}.fit"',
    }
