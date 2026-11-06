"""Bringaterv API – FIT → GPX átalakítás (OnelapFit, Garmin import).

A frontend fit.js-ével azonos GPX-formátum (Garmin TrackPointExtension + PowerExtension),
így a könyvtár / Elemzés ugyanúgy olvassa a pulzust, kadenciát, teljesítményt.
"""

import io
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


def fit_to_gpx(fit_bytes: bytes, name: str) -> tuple:
    """FIT → (GPX szöveg, session-összesítő dict). Pont nélküli FIT → ("", {...})."""
    points, session = [], {}
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
    if not points:
        return "", session

    def iso(t):
        return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(t, datetime) else None

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="Bringaterv (OnelapFit import)"',
        '  xmlns="http://www.topografix.com/GPX/1/1"',
        '  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"',
        '  xmlns:gpxpx="http://www.garmin.com/xmlschemas/PowerExtension/v1">',
    ]
    start = iso(session.get("start_time")) or iso(points[0]["time"])
    if start:
        lines.append(f"  <metadata><time>{start}</time></metadata>")
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
