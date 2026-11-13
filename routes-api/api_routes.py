"""Bringaterv API – útvonal végpontok (CRUD, geometry-bulk, FIT letöltés)."""

import os
import re
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from flask import Blueprint, abort, g, jsonify, request

from auth import require_auth
from config import log
from db import _db
from storage import _resolve_dirs
from share import clean_share, reset_views, views_of
from strava_service import _add_strava_deny
from utils import _clean_surface, _load_index, _now_date, _now_dt, _safe_id, _save_index, append_index, is_recorded_entry

bp = Blueprint("api_routes", __name__)
_TZ = ZoneInfo("Europe/Budapest")


@bp.route("/api/routes", methods=["GET"])
@require_auth
def list_routes():
    _, idx = _resolve_dirs()
    return jsonify(sorted(_load_index(idx), key=lambda r: r.get("date", ""), reverse=True))


# GPX trackpont regex (lat előbb – a saját és importált GPX-ek így állnak elő)
_TRKPT_RE = re.compile(r'<(?:trkpt|rtept)\b[^>]*\blat="([-\d.]+)"[^>]*\blon="([-\d.]+)"')


_TIME_RE = re.compile(r"<time>")


def _is_recorded(entry: dict, gpx_text: str) -> bool:
    """Valódi (rögzített) edzés-e – nem pedig tervezett útvonal (utils.is_recorded_entry)."""
    return entry.get("type") == "workout" or is_recorded_entry(entry, gpx_text)


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
    """Egyszerűsített geometria egyetlen válaszban (hőtérképhez).
    Minden elemnél „kind”: workout (rögzített edzés) vagy route (tervezett útvonal) –
    a kliens alapból csak az edzéseket mutatja. A statisztikából kizárt edzések kimaradnak."""
    user_dir, idx = _resolve_dirs()
    index = _load_index(idx)
    out = []
    for entry in index:
        rid = entry.get("id")
        if not rid:
            continue
        gpx_path = os.path.join(user_dir, f"{rid}.gpx")
        if not os.path.isfile(gpx_path):
            continue
        try:
            with open(gpx_path, encoding="utf-8") as f:
                head = f.read(200000)
        except OSError:
            continue
        kind = "workout" if _is_recorded(entry, head) else "route"
        if kind == "workout" and entry.get("include_in_stats") is False:
            continue
        pts = _extract_track_points(gpx_path)
        if len(pts) < 2:
            continue
        sport = entry.get("sport_type") or ("cycling" if kind == "route" else entry.get("type")) or "cycling"
        out.append({
            "id":       rid,
            "name":     entry.get("name") or "",
            "kind":     kind,
            "sport":    sport,
            "distance": entry.get("distance"),
            "date":     entry.get("date"),
            "points":   pts,
        })
    return jsonify({"tracks": out})


def _xy(lat0):
    """Egyenközű vetítés méterbe egy referencia-szélesség körül (rövid távokra elég pontos)."""
    import math
    kx = 111320.0 * math.cos(math.radians(lat0))
    return lambda p: (p[1] * kx, p[0] * 110540.0)


def _seg_dist(p, a, b) -> float:
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    qx, qy = ax + t * dx - px, ay + t * dy - py
    return (qx * qx + qy * qy) ** 0.5


@bp.route("/api/routes/similar", methods=["POST"])
@require_auth
def similar_routes():
    """Ugyanazon az útvonalon (ugyanabba az irányba) megtett korábbi edzések.
    Bemenet: {points: [[lat, lng], …] (≤ 400), distance_km, exclude_id?, sport?}
    Egyezés: táv ±12%, rajt és cél 400 m-en belül, és a nyomvonal mintapontjainak ≥ 85%-a
    120 m-en belül van a másik edzés vonalától."""
    data = request.get_json(silent=True) or {}
    pts = data.get("points") or []
    try:
        pts = [(float(p[0]), float(p[1])) for p in pts[:400]]
        dist_km = float(data.get("distance_km") or 0)
    except (TypeError, ValueError, IndexError):
        abort(400, description="Hibás bemenet.")
    if len(pts) < 5 or dist_km <= 0:
        return jsonify({"items": []})
    exclude = str(data.get("exclude_id") or "")
    sport = (data.get("sport") or "cycling").lower()
    proj = _xy(pts[0][0])
    q = [proj(p) for p in pts]
    step = max(1, len(q) // 60)
    samples = q[::step]

    user_dir, idx = _resolve_dirs()
    out = []
    checked = 0
    for e in _load_index(idx):
        rid = e.get("id")
        if not rid or rid == exclude or e.get("type") != "workout":
            continue
        d = e.get("distance")
        if not isinstance(d, (int, float)) or abs(d - dist_km) > dist_km * 0.12:
            continue
        if (e.get("sport_type") or "cycling").lower() != sport:
            continue
        checked += 1
        if checked > 400:
            break
        cand = _extract_track_points(os.path.join(user_dir, f"{rid}.gpx"), every=2, max_points=1500)
        if len(cand) < 5:
            continue
        c = [proj(p) for p in cand]
        dd = lambda a, b: ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
        if dd(c[0], q[0]) > 400 or dd(c[-1], q[-1]) > 400:
            continue
        hits = 0
        for sp in samples:
            if any(_seg_dist(sp, c[i], c[i + 1]) <= 120 for i in range(len(c) - 1)):
                hits += 1
        if hits / len(samples) < 0.85:
            continue
        out.append({
            "id": rid, "name": e.get("name") or "", "date": e.get("date"),
            "start_time": e.get("start_time"), "distance": d, "duration": e.get("duration"),
            "include_in_stats": e.get("include_in_stats", True),
            "match": round(hits / len(samples), 2),
        })
    out.sort(key=lambda r: r.get("start_time") or r.get("date") or "", reverse=True)
    return jsonify({"items": out[:12]})


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
    # felvett edzés kezdete (ISO) – ebből lesz a dátum is, nem a mentés napjából
    start_dt = None
    if data.get("start_time"):
        try:
            start_dt = datetime.fromisoformat(str(data["start_time"]).replace("Z", "+00:00"))
            if start_dt.tzinfo is None:
                start_dt = start_dt.replace(tzinfo=timezone.utc)
        except ValueError:
            start_dt = None

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
        "date":             start_dt.astimezone(_TZ).strftime("%Y-%m-%d") if start_dt else _now_date(),
        "distance":         round(distance, 1) if isinstance(distance, (int, float)) else None,
        "duration":         int(duration)      if isinstance(duration,  (int, float)) else None,
        "elevation":        int(elevation)     if isinstance(elevation, (int, float)) else None,
        "type":             route_type,
        "description":      description,
        "has_fit":          has_fit,
        "include_in_stats": bool(include_in_stats),
    }
    if start_dt:
        entry["start_time"] = start_dt.astimezone(timezone.utc).isoformat()
    if route_type == "workout" and not is_recorded_entry(entry, gpx_content):
        # időadat nélküli GPX (pl. letöltött vagy tervezett útvonal az Elemzés fülről mentve):
        # ez terv, nem edzés – nem kerül a statisztikába, a rekordok közé és a hőtérképre
        route_type = "hiking" if data.get("sport_type") in ("running", "walking", "hiking") else "asphalt"
        entry["type"] = route_type
    if route_type != "workout":
        entry["include_in_stats"] = False          # terv sosem számít a statisztikába
    if route_type == "workout" and data.get("sport_type") in ("cycling", "running", "walking", "hiking"):
        entry["sport_type"] = data["sport_type"]          # a kliens tudja (pl. FIT sport, GPX <type>)
    if route_type == "workout":
        # mért adatok (teljesítmény, pulzus, kadencia) a teljes GPX-ből – a könyvtár-kártya,
        # a Kezdőlap és a „Mért adat” szűrő ezekből dolgozik
        try:
            from gpx_metrics import fill_missing
            fill_missing(entry, gpx_content)
        except Exception as exc:
            log.warning("Mért adatok számolása sikertelen (%s): %s", route_id, exc)
        # felszerelés (eszköz, bringa, szenzorok): az eredeti FIT-ből, ennek híján a GPX
        # metaadatából (a böngészős FIT → GPX is beleírja)
        try:
            from fit_gpx import equipment_fields, fit_equipment, gpx_equipment
            entry.update(equipment_fields(fit_equipment(fit_bytes) if has_fit else gpx_equipment(gpx_content)))
        except Exception as exc:
            log.warning("Felszerelés kiolvasása sikertelen (%s): %s", route_id, exc)
        if has_fit and entry.get("calories") is None:
            # a rögzítő eszköz saját kalóriája (Elemzés → Kalória összevetés)
            try:
                from fit_gpx import fit_to_gpx
                cal = (fit_to_gpx(fit_bytes, name)[1] or {}).get("calories")
                if cal:
                    entry["calories"] = int(cal)
            except Exception as exc:
                log.warning("FIT kalória kiolvasása sikertelen (%s): %s", route_id, exc)
    try:
        append_index(idx, entry)          # zár alatt friss olvasás + írás
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
            route_id, g.user["id"], name, entry["date"], _now_dt(),
            distance * 1000 if isinstance(distance, (int, float)) else None,
            int(duration)   if isinstance(duration,  (int, float)) else None,
            int(elevation)  if isinstance(elevation, (int, float)) else None,
            route_type, description, gpx_path,
        ))

    log.info("Új útvonal: %s (%s)", route_id, name)
    if route_type == "workout" and entry.get("temp_source") != "device":
        try:
            import temp_weather
            temp_weather.fill_soon(g.user["id"])       # mért hőmérséklet nélkül: időjárásból
        except Exception as exc:
            log.warning("Időjárás-hőmérséklet indítása sikertelen: %s", exc)
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


@bp.route("/api/routes/indoor-fit", methods=["POST"])
@require_auth
def save_indoor_fit():
    """GPS nélküli (beltéri) FIT kézi feltöltése az Elemzésből: ugyanaz a mentés, mint a komputeres
    importoknál (indoor.save_indoor_from_fit). body: {name, fitContent (base64)}.
    Ugyanaz a fájl (SHA-1) másodszor nem jön be – a meglévő bejegyzést adja vissza."""
    import base64
    import hashlib
    from indoor import save_indoor_from_fit
    from storage import import_dedup_enabled
    data = request.get_json(silent=True) or {}
    try:
        fit_bytes = base64.b64decode(data.get("fitContent") or "", validate=True)
    except (ValueError, TypeError):
        abort(400, description="Hibás FIT tartalom")
    if not fit_bytes or len(fit_bytes) > 20 * 1024 * 1024:
        abort(400, description="Hiányzó vagy túl nagy FIT fájl")
    user_dir, idx = _resolve_dirs()
    index = _load_index(idx)
    fit_hash = hashlib.sha1(fit_bytes).hexdigest()[:16]
    same = next((r for r in index if r.get("fit_hash") == fit_hash), None)
    if same:
        return jsonify({"ok": True, "skipped": True, "reason": "same_file", "entry": same})
    if len(index) >= g.user.get("quota_routes", 50):
        abort(429, description=f"Edzés kvóta elérve ({g.user['quota_routes']} db max). Törölj néhányat a könyvtárból.")
    name = (data.get("name") or "").strip()[:120] or "Beltéri tekerés"
    uid = g.user["id"]
    res = save_indoor_from_fit(uid, fit_bytes, name=name, source="file", id_field="fit_hash",
                               source_id=fit_hash, dedup=import_dedup_enabled(uid))
    if not res.get("ok"):
        abort(400, description=res.get("error") or "A FIT-fájl nem menthető.")
    if res.get("skipped"):
        dup = next((r for r in index if r.get("id") == res.get("duplicate_local_id")), None)
        return jsonify({**res, "entry": dup})
    return jsonify(res), 201


@bp.route("/api/routes/<route_id>/streams", methods=["GET"])
@require_auth
def get_route_streams(route_id: str):
    """Beltéri (GPS nélküli) edzés mért adatsorai – az Elemzés ebből rajzol (térkép nélkül)."""
    from indoor import load_streams
    route_id = _safe_id(route_id)
    user_dir, _ = _resolve_dirs()
    data = load_streams(user_dir, route_id)
    if data is None:
        abort(404, description="Ehhez az edzéshez nincs adatsor.")
    return jsonify(data)


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
    if "type" in data:
        # rögzített edzés nem válhat tervvé (pl. a szerkesztő ablak útvonaltípusa miatt), és fordítva
        if entry.get("type") != "workout" and data["type"] != "workout":
            entry["type"] = data["type"]
    if "description" in data: entry["description"] = (data["description"] or "").strip()
    if "include_in_stats" in data:
        entry["include_in_stats"] = bool(data["include_in_stats"])
        entry["stats_user"] = True   # a felhasználó állította be (a v18 migráció ezt nem írja felül)
    if "public" in data:
        # nyilvános megosztási link be / ki (a /view.html?route=<id> csak bekapcsolva működik)
        entry["public"] = bool(data["public"])
        if entry["public"]:
            entry.setdefault("shared_at", _now_dt())
    if "share" in data:
        # mi látszódjon a nyilvános linken (elrejtett adatok)
        entry["share"] = clean_share(data["share"])
    if "surface" in data:
        surface = _clean_surface(data["surface"])
        if surface: entry["surface"] = surface
        else: entry.pop("surface", None)
    if "rpe" in data:
        # érzés (RPE, Borg CR10: 1 nagyon könnyű … 10 maximális); üres = törlés
        try:
            rpe = int(data["rpe"]) if data["rpe"] not in (None, "") else None
        except (TypeError, ValueError):
            rpe = None
        if rpe is not None and 1 <= rpe <= 10: entry["rpe"] = rpe
        else: entry.pop("rpe", None)
    if "wind" in data:
        # „Szél az edzés alatt” összesítő (a kliens számolja az Open-Meteóból, egyszer) – tömör, ≤ 8 KB
        import json as _json
        w = data["wind"]
        if w is None:
            entry.pop("wind", None)
        elif isinstance(w, dict) and isinstance(w.get("runs"), list) and isinstance(w.get("stats"), dict) \
                and len(w["runs"]) <= 300 and len(_json.dumps(w)) <= 8192:
            entry["wind"] = {k: w[k] for k in ("v", "at", "stats", "runs") if k in w}
    if "notes" in data:
        notes = str(data["notes"] or "").strip()[:2000]
        if notes: entry["notes"] = notes
        else: entry.pop("notes", None)
    if "bike_id" in data:
        # „Bringáim”: a felhasználó kézzel rendelte hozzá (üres = automatikus, a bike_name alapján)
        bid = str(data["bike_id"] or "").strip()[:40]
        if bid: entry["bike_id"] = bid
        else: entry.pop("bike_id", None)
    try:
        _save_index(index, idx)
    except OSError:
        abort(500)
    return jsonify(entry)


@bp.route("/api/routes/<route_id>/public", methods=["GET"])
@require_auth
def route_public_state(route_id: str):
    """A nyilvános megosztási link állapota (a megosztó ablak kapcsolójához)."""
    route_id = _safe_id(route_id)
    _, idx = _resolve_dirs()
    entry = next((r for r in _load_index(idx) if r.get("id") == route_id), None)
    if not entry:
        abort(404, description="Útvonal nem található.")
    v = views_of([route_id]).get(route_id) or {}
    return jsonify({"public": entry.get("public") is True, "shared_at": entry.get("shared_at"),
                    "share": entry.get("share") or {"hide": []},
                    "views": v.get("views", 0), "last_view_at": v.get("last_at")})


@bp.route("/api/routes/shared", methods=["GET"])
@require_auth
def shared_routes():
    """A nyilvánosan megosztott útvonalak / edzések: megnyitások, mi van elrejtve."""
    _, idx = _resolve_dirs()
    items = [e for e in _load_index(idx) if e.get("public") is True]
    views = views_of([e.get("id") for e in items])
    out = [{"id": e.get("id"), "name": e.get("name"), "type": e.get("type"), "sport_type": e.get("sport_type"),
            "date": e.get("start_time") or e.get("date"), "distance": e.get("distance"),
            "shared_at": e.get("shared_at"), "share": e.get("share") or {"hide": []},
            "views": (views.get(e.get("id")) or {}).get("views", 0),
            "last_view_at": (views.get(e.get("id")) or {}).get("last_at")} for e in items]
    out.sort(key=lambda x: x.get("shared_at") or "", reverse=True)
    return jsonify({"items": out})


@bp.route("/api/routes/<route_id>/share-views", methods=["DELETE"])
@require_auth
def reset_share_views(route_id: str):
    """A megnyitás-számláló nullázása."""
    route_id = _safe_id(route_id)
    _, idx = _resolve_dirs()
    if not any(r.get("id") == route_id for r in _load_index(idx)):
        abort(404, description="Útvonal nem található.")
    reset_views(route_id)
    return jsonify({"ok": True})


@bp.route("/api/routes/<route_id>", methods=["DELETE"])
@require_auth
def delete_route(route_id: str):
    route_id      = _safe_id(route_id)
    user_dir, idx = _resolve_dirs()
    gpx_path      = os.path.join(user_dir, f"{route_id}.gpx")
    fit_path      = os.path.join(user_dir, f"{route_id}.fit")
    json_path     = os.path.join(user_dir, f"{route_id}.json")   # beltéri edzés adatsora (GPX nélkül)
    if not os.path.isfile(gpx_path) and not os.path.isfile(json_path):
        abort(404, description=f"Útvonal nem található: {route_id}")
    # Strava/Garmin/Onelap-os importnál → deny-listbe (hogy ne kerüljön re-importra a következő sync-en)
    existing = _load_index(idx)
    deleted_entry = next((r for r in existing if r.get("id") == route_id), None)
    if deleted_entry and deleted_entry.get("strava_id"):
        try: _add_strava_deny(g.user["id"], deleted_entry["strava_id"])
        except Exception as exc: log.warning("Strava deny-list update hiba: %s", exc)
    if deleted_entry and deleted_entry.get("garmin_id"):
        try:
            from garmin_service import _add_garmin_deny
            _add_garmin_deny(g.user["id"], deleted_entry["garmin_id"])
        except Exception as exc: log.warning("Garmin deny-list update hiba: %s", exc)
    for prov in ("wahoo", "polar"):
        if deleted_entry and deleted_entry.get(f"{prov}_id"):
            try:
                from device_import import add_deny
                add_deny(g.user["id"], prov, deleted_entry[f"{prov}_id"])
            except Exception as exc: log.warning("%s deny-list update hiba: %s", prov, exc)
    if deleted_entry and deleted_entry.get("bryton_id"):
        try:
            from bryton_service import add_deny as _br_deny
            _br_deny(g.user["id"], deleted_entry["bryton_id"])
        except Exception as exc: log.warning("Bryton deny-list update hiba: %s", exc)
    if deleted_entry and deleted_entry.get("igpsport_id"):
        try:
            from igpsport_service import add_deny as _igp_deny
            _igp_deny(g.user["id"], deleted_entry["igpsport_id"])
        except Exception as exc: log.warning("iGPSport deny-list update hiba: %s", exc)
    if deleted_entry and deleted_entry.get("onelap_id"):
        try:
            from onelap_service import _add_onelap_deny
            _add_onelap_deny(g.user["id"], deleted_entry["onelap_id"])
        except Exception as exc: log.warning("Onelap deny-list update hiba: %s", exc)
    try:
        for p in (gpx_path, fit_path, json_path):
            if os.path.isfile(p):
                os.remove(p)
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
