"""Bringaterv API – FIT → GPX átalakítás (OnelapFit, Garmin import).

A frontend fit.js-ével azonos GPX-formátum (Garmin TrackPointExtension + PowerExtension),
így a könyvtár / Elemzés ugyanúgy olvassa a pulzust, kadenciát, teljesítményt.
"""

import io
import json
import re
from datetime import datetime, timezone

try:
    import fitdecode
    FIT_AVAILABLE = True
except ImportError:
    fitdecode = None
    FIT_AVAILABLE = False


_SEMI = 180.0 / 2 ** 31


def _fv(frame, *names):
    """Az első létező, nem-None mező értéke a FIT üzenetből."""
    for n in names:
        if frame.has_field(n):
            v = frame.get_value(n)
            if v is not None:
                return v
    return None


def _fit_sport(sport) -> str:
    s = str(sport or "").lower()
    if "run" in s:  return "running"
    if "walk" in s: return "walking"
    if "hik" in s:  return "hiking"
    return "cycling"


def _xml(s: str) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


# ── Felszerelés: rögzítő eszköz, bringa (a komputer bringaprofilja), szenzorok ──

_MAKERS = {
    "garmin": "Garmin", "wahoo_fitness": "Wahoo", "polar_electro": "Polar", "magene": "Magene",
    "coros": "Coros", "suunto": "Suunto", "hammerhead": "Hammerhead", "bryton": "Bryton",
    "bryton_sensors": "Bryton", "igpsport": "iGPSPORT", "onelap": "Onelap", "zwift": "Zwift",
    "stages_cycling": "Stages", "favero_electronics": "Favero", "sram": "SRAM", "shimano": "Shimano",
    "4iiiis": "4iiii", "quarq": "Quarq", "sigmasport": "Sigma", "lezyne": "Lezyne", "decathlon": "Decathlon",
    "tacx": "Tacx", "elite": "Elite", "srm": "SRM", "rotor": "Rotor", "pioneer": "Pioneer", "look": "Look",
    "specialized": "Specialized", "strava": "Strava", "cycplus": "CYCPLUS", "dynastream": "Garmin",
}
# ANT+ / Bluetooth szenzortípus → egységes kulcs (a felület fordítja)
_SENSOR_KEYS = {
    "heart_rate": "heart_rate", "bike_power": "power", "bike_cadence": "cadence", "bike_speed": "speed",
    "bike_speed_cadence": "speed_cadence", "bike_radar": "radar", "bike_light_main": "light",
    "bike_light_shared": "light", "fitness_equipment": "trainer", "bike_trainer": "trainer",
    "stride_speed_distance": "footpod", "footpod": "footpod", "control": "remote", "control_hub": "remote",
    "muscle_oxygen": "muscle_oxygen", "bike_aero": "aero",
}


def _maker(v) -> str:
    if v is None:
        return ""
    return _MAKERS.get(str(v), "" if str(v).isdigit() else str(v).replace("_", " ").title())


def _product(frame) -> str:
    """Termékmegjelölés: product_name (pl. „C506_09470” → „C506”), Garminnál a garmin_product
    neve (edge_530 → „Edge 530”)."""
    pn = _fv(frame, "product_name")
    if isinstance(pn, str) and pn.strip():
        head, _, tail = pn.strip().partition("_")
        return head if tail.isdigit() else pn.strip()
    gp = _fv(frame, "garmin_product")
    if isinstance(gp, str) and not gp.isdigit():
        return gp.replace("_", " ").title().replace("Edge", "Edge")
    return ""


def _equipment_collect(frame, eq: dict) -> None:
    """Egy FIT-üzenetből a felszerelés-adatok gyűjtése (file_id, bike_profile, device_info)."""
    if frame.name == "file_id" and "device" not in eq:
        maker, prod = _maker(_fv(frame, "manufacturer")), _product(frame)
        name = " ".join(x for x in (maker, prod) if x)
        if name:
            eq["device"], eq["device_maker"] = name, maker.lower()
    elif frame.name == "bike_profile" and not eq.get("bike_name"):
        n = _fv(frame, "name")
        if isinstance(n, str) and n.strip():
            eq["bike_name"] = n.strip()
    elif frame.name == "device_info":
        idx = _fv(frame, "device_index")
        if idx in (0, "creator"):                      # maga a rögzítő eszköz, nem szenzor
            return
        typ = _fv(frame, "antplus_device_type", "ble_device_type", "local_device_type", "device_type")
        key = _SENSOR_KEYS.get(str(typ)) if typ is not None else None
        if not key:
            return
        sensors = eq.setdefault("sensors", [])
        if key not in sensors:
            sensors.append(key)
        if key == "power" and not eq.get("power_meter"):
            pm = " ".join(x for x in (_maker(_fv(frame, "manufacturer")), _product(frame)) if x)
            if pm:
                eq["power_meter"] = pm


def fit_equipment(fit_bytes: bytes) -> dict:
    """Csak a felszerelés kiolvasása egy FIT-ből: {device, device_maker, bike_name, sensors, power_meter}."""
    eq = {}
    try:
        with fitdecode.FitReader(io.BytesIO(fit_bytes), check_crc=fitdecode.CrcCheck.DISABLED) as fr:
            for frame in fr:
                if frame.frame_type == fitdecode.FIT_FRAME_DATA and frame.name in ("file_id", "bike_profile", "device_info"):
                    _equipment_collect(frame, eq)
    except Exception:
        pass
    return eq


EQUIP_KEYS = ("device", "device_maker", "bike_name", "sensors", "power_meter")
EQUIP_VERSION = 1


def equipment_fields(eq: dict | None) -> dict:
    """Index-mezők a felszerelésből (csak a meglévők) + jelző, hogy meg volt vizsgálva."""
    out = {k: eq[k] for k in EQUIP_KEYS if (eq or {}).get(k)}
    out["equip_v"] = EQUIP_VERSION
    return out
_EQ_RE = re.compile(r"<(?:\w+:)?equipment>(.*?)</(?:\w+:)?equipment>", re.S)


def gpx_equipment(gpx_text: str) -> dict:
    """A GPX metaadatába (bringaterv:equipment, JSON) írt felszerelés – a böngészős és a
    szerveroldali FIT → GPX is ide teszi."""
    m = _EQ_RE.search(gpx_text or "")
    if not m:
        return {}
    try:
        import html
        d = json.loads(html.unescape(m.group(1)))
        return {k: d[k] for k in EQUIP_KEYS if d.get(k)} if isinstance(d, dict) else {}
    except ValueError:
        return {}


def fit_to_gpx(fit_bytes: bytes, name: str) -> tuple:
    """FIT → (GPX szöveg, session-összesítő dict). Pont nélküli FIT → ("", {...})."""
    points, session, equipment = [], {}, {}
    with fitdecode.FitReader(io.BytesIO(fit_bytes), check_crc=fitdecode.CrcCheck.DISABLED) as fr:
        for frame in fr:
            if frame.frame_type != fitdecode.FIT_FRAME_DATA:
                continue
            if frame.name == "record":
                lat, lon = _fv(frame, "position_lat"), _fv(frame, "position_long")
                if lat is None or lon is None:
                    continue
                points.append({
                    "lat":   lat * _SEMI, "lon": lon * _SEMI,
                    "ele":   _fv(frame, "enhanced_altitude", "altitude"),
                    "time":  _fv(frame, "timestamp"),
                    "hr":    _fv(frame, "heart_rate"),
                    "cad":   _fv(frame, "cadence"),
                    "power": _fv(frame, "power"),
                    "temp":  _fv(frame, "temperature"),
                })
            elif frame.name in ("file_id", "bike_profile", "device_info"):
                _equipment_collect(frame, equipment)
            elif frame.name == "session" and not session:
                session = {
                    "sport":       _fit_sport(_fv(frame, "sport")),
                    "start_time":  _fv(frame, "start_time"),
                    "moving_s":    _fv(frame, "total_timer_time"),
                    "elapsed_s":   _fv(frame, "total_elapsed_time"),
                    "distance_m":  _fv(frame, "total_distance"),
                    "ascent_m":    _fv(frame, "total_ascent"),
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
    if not points:
        return "", session

    def iso(t):
        return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(t, datetime) else None

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="Bringaterv (FIT import)"',
        '  xmlns="http://www.topografix.com/GPX/1/1"',
        '  xmlns:bringaterv="https://bringaterv.app/gpx/1"',
        '  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"',
        '  xmlns:gpxpx="http://www.garmin.com/xmlschemas/PowerExtension/v1">',
    ]
    start = iso(session.get("start_time")) or iso(points[0]["time"])
    meta = f"<time>{start}</time>" if start else ""
    if equipment:
        meta += f"<extensions><bringaterv:equipment>{_xml(json.dumps(equipment, ensure_ascii=False))}</bringaterv:equipment></extensions>"
    if meta:
        lines.append(f"  <metadata>{meta}</metadata>")
    lines += ["  <trk>", f"    <name>{_xml(name)}</name>", "    <trkseg>"]
    for p in points:
        lines.append(f'      <trkpt lat="{p["lat"]:.7f}" lon="{p["lon"]:.7f}">')
        if p["ele"] is not None:
            lines.append(f"        <ele>{float(p['ele']):.2f}</ele>")
        t = iso(p["time"])
        if t:
            lines.append(f"        <time>{t}</time>")
        tpx = [(k, tag) for k, tag in (("hr", "hr"), ("cad", "cad"), ("temp", "atemp")) if p[k] is not None]
        if tpx or p["power"] is not None:
            lines.append("        <extensions>")
            if tpx:
                lines.append("          <gpxtpx:TrackPointExtension>")
                lines += [f"            <gpxtpx:{tag}>{p[k]}</gpxtpx:{tag}>" for k, tag in tpx]
                lines.append("          </gpxtpx:TrackPointExtension>")
            if p["power"] is not None:
                lines.append(f"          <gpxpx:PowerExtension><gpxpx:PowerInWatts>{p['power']}</gpxpx:PowerInWatts></gpxpx:PowerExtension>")
            lines.append("        </extensions>")
        lines.append("      </trkpt>")
    lines += ["    </trkseg>", "  </trk>", "</gpx>"]
    return "\n".join(lines), session
