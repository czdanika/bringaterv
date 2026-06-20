"""Bringaterv API – Magene / OneLapFit helperek (belépés, útvonal-feltöltés).

A Magene fejegységek (OneLapFit rendszer) nem hivatalos felhő-API-jára épül,
a magpx (github.com/jeromecornet/magpx) projekt nyomán. „C" megközelítés:
csak a vonal-geometria + magasság megy fel, forduló-utasítások (Mapbox) nélkül.

Belépés: email + MD5(jelszó) → access token + user id. Jelszót NEM tárolunk,
csak a tokent: /data/users/<uid>/magene.json (0600).

⚠️ Nem hivatalos végpont (HTTP!), izolált hibakezeléssel.
"""

import hashlib
import json
import os
import uuid

import requests

from config import log
from storage import _user_dir, _user_routes_dir
from utils import _load_index, _now_dt

# garmin_service-ben már megvannak ezek a helperek – újrahasználjuk
from garmin_service import _haversine_m, _parse_gpx_points

MAGENE_BASE     = "https://rfs-fitness.rfsvr.com"  # a szerver már csak HTTPS (a 80-as port halott)
LOGIN_URL       = f"{MAGENE_BASE}/api/v1/app/login"
ROUTE_SAVE_URL  = f"{MAGENE_BASE}/api/navigation/app/navigation/save"
SHOW_ID         = "1fafed1b-77aa-4e75-8fb2-a31a99285731"  # magpx-ből

MAGENE_AVAILABLE = True  # tisztán requests-alapú, nincs külső függőség


# ── Per-user token tárolás ─────────────────────────────────────────────────────

def _user_magene_path(user_id: str) -> str:
    return os.path.join(_user_dir(user_id), "magene.json")


def _load_user_magene(user_id: str) -> dict:
    path = _user_magene_path(user_id)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_user_magene(user_id: str, data: dict) -> None:
    os.makedirs(_user_dir(user_id), exist_ok=True)
    path = _user_magene_path(user_id)
    tmp  = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _delete_user_magene(user_id: str) -> None:
    path = _user_magene_path(user_id)
    if os.path.isfile(path):
        os.remove(path)


def _md5_hex(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()


def _magene_headers(data: dict, authenticated: bool = True, extra: dict = None) -> dict:
    headers = {
        "Language":        "en",
        "User-Agent":      "wanlu/1.5.3 (iPad; iOS 16.4; Scale/2.00)",
        "Version":         "1.5.3",
        "Platform":        "43",
        "Accept-Language": "en;q=1",
        "DeviceId":        data.get("device_id", ""),
        "SessionId":       data.get("session_id", ""),
        "Timezone":        "Europe/Budapest",
        "Content-Type":    "application/json",
        "App-Version":     "1.5.3",
        "App-Name":        "onelapfit",
    }
    if authenticated:
        headers["Authorization"] = data.get("token", "")
        headers["UserId"]        = str(data.get("user_id", ""))
    if extra:
        headers.update(extra)
    return headers


# ── Belépés ────────────────────────────────────────────────────────────────────

def magene_login(user_id: str, email: str, password: str) -> dict:
    """Belépés OneLapFit email + jelszóval. Token mentve, profil vissza."""
    data = _load_user_magene(user_id)
    # device/session id-k állandóak per-user (login után is ugyanazok)
    data.setdefault("device_id", str(uuid.uuid4()))
    data.setdefault("session_id", str(uuid.uuid4()))

    resp = requests.post(
        LOGIN_URL,
        data=json.dumps({"account": email, "password": _md5_hex(password)}),
        headers=_magene_headers(data, authenticated=False),
        timeout=20,
    )
    try:
        body = resp.json()
    except ValueError:
        raise RuntimeError(f"Magene login: érvénytelen válasz ({resp.status_code})")
    if body.get("code") != 200:
        raise RuntimeError(body.get("msg") or body.get("error") or f"Belépés sikertelen ({body.get('code')})")

    d = body.get("data") or {}
    info = d.get("userinfo") or {}
    data.update({
        "token":        d.get("token"),
        "user_id":      info.get("uid"),
        "account":      email,
        "nickname":     info.get("nickname") or info.get("name") or "",
        "connected_at": data.get("connected_at") or _now_dt(),
    })
    if not data.get("token") or data.get("user_id") is None:
        raise RuntimeError("Magene login: hiányzó token/uid a válaszban")
    _save_user_magene(user_id, data)
    return data


# ── Polyline (Google encoded polyline, precision 6) ────────────────────────────

def _encode_polyline6(coords, precision: int = 6) -> str:
    """coords: [(lat, lng), ...] → encoded polyline (precision 6)."""
    factor = 10 ** precision
    out = []
    prev_lat = prev_lng = 0
    for lat, lng in coords:
        ilat = round(lat * factor)
        ilng = round(lng * factor)
        for delta in (ilat - prev_lat, ilng - prev_lng):
            delta = ~(delta << 1) if delta < 0 else (delta << 1)
            while delta >= 0x20:
                out.append(chr((0x20 | (delta & 0x1f)) + 63))
                delta >>= 5
            out.append(chr(delta + 63))
        prev_lat, prev_lng = ilat, ilng
    return "".join(out)


# ── Útvonal payload (C: csak vonal + magasság) ─────────────────────────────────

def _simplify(points, min_dist_m: float = 10.0):
    """Ritkítás: max 1 pont / min_dist_m. points: [(lat,lon,ele)]."""
    out = []
    last = None
    for (lat, lon, ele) in points:
        if last is None or _haversine_m(last[0], last[1], lat, lon) >= min_dist_m:
            out.append((lat, lon, ele))
            last = (lat, lon)
    if out and out[-1] != (points[-1][0], points[-1][1], points[-1][2]):
        out.append(points[-1])
    return out


def magene_build_payload(gpx_text: str, name: str) -> dict:
    """GPX → OneLapFit save payload, forduló-utasítások nélkül (C)."""
    raw = _parse_gpx_points(gpx_text)
    if len(raw) < 2:
        return {"ok": False, "error": "Az útvonalból nem sikerült pontokat kinyerni."}

    pts = _simplify(raw, 10.0)
    if len(pts) < 2:
        pts = raw

    # Teljes táv + szint
    total_dist = 0.0
    total_climb = 0.0
    highest_slope = 0.0
    prev = None
    for (lat, lon, ele) in pts:
        if prev is not None:
            d = _haversine_m(prev[0], prev[1], lat, lon)
            total_dist += d
            if prev[2] is not None and ele is not None and ele > prev[2] and d > 0:
                gain = ele - prev[2]
                total_climb += gain
                slope = gain / d
                if slope > highest_slope:
                    highest_slope = slope
        prev = (lat, lon, ele)

    # Becsült idő (~20 km/h)
    total_time = total_dist / (20.0 / 3.6)

    # geometry: a teljes vonal polyline6-ban ([lat,lng])
    geometry = _encode_polyline6([(lat, lon) for (lat, lon, _e) in pts])

    # path_point: néhány fő pont a vonal mentén (~2 km-enként), legalább start+vég
    waypoints = []
    seg_dist = 0.0
    last_wp = None
    STEP_M = 2000.0
    prev = None
    for i, (lat, lon, ele) in enumerate(pts):
        if prev is not None:
            seg_dist += _haversine_m(prev[0], prev[1], lat, lon)
        is_last = (i == len(pts) - 1)
        if last_wp is None or seg_dist >= STEP_M or is_last:
            waypoints.append({
                "name": "",
                "lat": round(lat, 6),
                "lng": round(lon, 6),
                "distance": round(seg_dist, 1),
                "duration": round(seg_dist / (20.0 / 3.6), 1),
                "intersectionsSize": 14,
            })
            seg_dist = 0.0
            last_wp = (lat, lon)
        prev = (lat, lon, ele)

    # altitude_info.steps_info: 50 pontonkénti legek
    SLICE = 50
    steps_info = []
    for i in range(0, len(pts), SLICE):
        leg = pts[i:i + SLICE]
        climb = 0.0
        p = None
        for (lat, lon, ele) in leg:
            if p is not None and p[2] is not None and ele is not None and ele > p[2]:
                climb += ele - p[2]
            p = (lat, lon, ele)
        steps_info.append({
            "climb": int(climb),
            "altitude_info": [{"lat": round(la, 6), "lng": round(lo, 6),
                               "elevation": int(e) if e is not None else 0} for (la, lo, e) in leg],
            "altitude": int(leg[0][2]) if leg[0][2] is not None else 0,
        })

    first_ele = int(pts[0][2]) if pts[0][2] is not None else 0

    payload = {
        "name":       (name or "Bringaterv útvonal")[:60],
        "size":       128,
        "distance":   round(total_dist, 1),
        "time":       round(total_time, 1),
        "path_point": waypoints,
        "path_steps": [],            # C: nincs forduló-utasítás
        "import_path": [],           # C: nincs lépésenkénti geometria
        "altitude":   first_ele,
        "altitude_info": {
            "slope":      round(highest_slope, 3),
            "steps_info": steps_info,
        },
        "geometry":   geometry,
        "climb":      int(total_climb),
    }
    return {"ok": True, "payload": payload,
            "distance_km": round(total_dist / 1000, 2),
            "climb_m": int(total_climb), "points": len(pts)}


def magene_upload_route(user_id: str, payload: dict) -> dict:
    """A payload feltöltése OneLapFitbe. {ok, nid} vagy hiba."""
    data = _load_user_magene(user_id)
    if not data.get("token"):
        return {"ok": False, "error": "Nincs Magene kapcsolat."}
    resp = requests.post(
        ROUTE_SAVE_URL,
        data=json.dumps(payload),
        headers=_magene_headers(data, authenticated=True, extra={"ShowId": SHOW_ID}),
        timeout=30,
    )
    try:
        body = resp.json()
    except ValueError:
        raise RuntimeError(f"Magene feltöltés: érvénytelen válasz ({resp.status_code}): {resp.text[:300]}")
    if body.get("code") != 200:
        raise RuntimeError(f"Magene elutasította ({body.get('code')}): {body.get('msg') or body.get('error') or resp.text[:300]}")
    d = body.get("data") or {}
    return {"ok": True, "nid": d.get("nid"), "name": d.get("name") or payload.get("name")}
