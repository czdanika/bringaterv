"""Bringaterv API – AI-funkciók (Claude API).

  GET    /api/ai/status                    a bejelentkezett felhasználó AI-állapota, napi kerete
  PUT    /api/ai/me                        saját kikapcsolás / bekapcsolás ({enabled})
  POST   /api/ai/workout/<id>              edzés elemzése ({mode: "extended"} → részletes); az összesítőt a kliens számolja
  PATCH  /api/ai/workout/<id>              az elemzés kézi szerkesztése
  DELETE /api/ai/workout/<id>              az elemzés törlése
  POST   /api/ai/route-request             útvonal-javaslat: szabad szöveges kérés → beállítások
  POST   /api/ai/route-description         saját útvonal / edzés leírás-javaslata (megye, települések, burkolat, terep);
                                            want: "name" → rövid névjavaslat ugyanebből
  GET    /api/admin/ai                     beállítás + felhasználás (admin)
  PUT    /api/admin/ai                     API-kulcs, alap napi limit (admin)
  POST   /api/admin/ai/test                kulcs ellenőrzése (admin)
  POST   /api/admin/ai/sample-description  közösségi útvonal leírása AI-val (admin)

Az API-kulcs csak a szerveren van; a kliens sosem kapja meg.
"""

import os
import re

from flask import Blueprint, abort, g, jsonify, request

import ai_service
import geo_location
from auth import require_admin, require_auth
from config import log
from db import _db
from storage import _resolve_dirs
from utils import _load_index, _now_dt, _safe_id, _save_index

bp = Blueprint("api_ai", __name__)


@bp.route("/api/ai/status", methods=["GET"])
@require_auth
def ai_status():
    return jsonify(ai_service.status(g.user))


@bp.route("/api/ai/me", methods=["PUT"])
@require_auth
def ai_me():
    enabled = bool((request.get_json(silent=True) or {}).get("enabled", True))
    with _db() as conn:
        conn.execute("UPDATE users SET ai_user_off = ? WHERE id = ?", (0 if enabled else 1, g.user["id"]))
    g.user["ai_user_off"] = 0 if enabled else 1
    return jsonify(ai_service.status(g.user))


def _is_workout(entry: dict) -> bool:
    """Elvégzett edzés (nem útvonalterv) – ugyanaz a feltétel, mint a könyvtárban."""
    return entry.get("type") == "workout" or bool(entry.get("strava_id")) or bool(entry.get("start_time"))


def _route_entry(route_id: str):
    _, idx = _resolve_dirs()
    index = _load_index(idx)
    entry = next((r for r in index if r.get("id") == route_id), None)
    if not entry:
        abort(404, description="Az edzés nem található.")
    return index, idx, entry


def _check_quota() -> dict:
    """A bejelentkezett felhasználó használhatja-e most az AI-t (beállítva, engedélyezve, van kerete)."""
    st = ai_service.status(g.user)
    if not st["configured"]:
        abort(503, description="Az AI-funkció nincs beállítva.")
    if not st["allowed"]:
        abort(403, description="Az AI-funkció nincs engedélyezve a fiókodban.")
    if st["user_off"]:
        abort(403, description="Az AI-funkciót kikapcsoltad a Beállításokban.")
    if st.get("unavailable"):
        abort(503, description=st["message"])
    if st["remaining"] <= 0:
        abort(429, description=f"Elérted a mai AI-keretet ({st['limit']}). Holnap újra próbálhatod.")
    return st


@bp.route("/api/ai/route-request", methods=["POST"])
@require_auth
def ai_route_request():
    _check_quota()
    data = request.get_json(silent=True) or {}
    text = str(data.get("text") or "").strip()
    if len(text) < 3:
        abort(400, description="Írd le, milyen túrát szeretnél.")
    try:
        result, model, usage = ai_service.route_request(text[:500], str(data.get("start_name") or "")[:80],
                                                        bool(data.get("loop", True)))
    except ai_service.AIError as exc:
        abort(502, description=str(exc))
    ai_service.log_usage(g.user["id"], "route_request", "", model, usage)
    return jsonify({**result, "status": ai_service.status(g.user)})


_TYPE_LABELS = {"asphalt": "aszfalt (országúti)", "cycling": "aszfalt (országúti)", "gravel": "gravel", "mtb": "MTB",
                "walking": "séta", "hiking": "gyalogtúra", "workout": "megtett edzés"}
_SURF_LABELS = {"asphalt": "aszfalt", "gravel": "murva", "mtb": "földút", "hiking": "ösvény"}
_PT_RE = re.compile(r'<(trkpt|rtept)\b[^>]*?\blat="([-\d.]+)"[^>]*?\blon="([-\d.]+)"[^>]*?(?:/>|>(.*?)</\1>)', re.S)
_ELE_RE = re.compile(r"<ele>\s*([-\d.]+)\s*</ele>")
_WPT_NAME_RE = re.compile(r"<wpt\b[^>]*>.*?<name>([^<]{1,80})</name>.*?</wpt>", re.S)


def _gpx_points(text: str) -> list:
    """[[lat, lon, ele|None], …] a GPX track- / route-pontjaiból."""
    out = []
    for m in _PT_RE.finditer(text):
        try:
            ele = _ELE_RE.search(m.group(4) or "")
            out.append([float(m.group(2)), float(m.group(3)), float(ele.group(1)) if ele else None])
        except ValueError:
            continue
    return out


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


@bp.route("/api/ai/route-description", methods=["POST"])
@require_auth
def ai_route_description():
    """Leírás-javaslat egy útvonalhoz: a nyomvonalból helyadat (megye, települések), a burkolat-
    arányokból és a domborzatból. Tervezőből: points (+ surface, waypoints); könyvtárból: route_id."""
    _check_quota()
    data = request.get_json(silent=True) or {}
    name, rtype = str(data.get("name") or "")[:120], str(data.get("type") or "")
    dist, elev = _num(data.get("distance_km")), _num(data.get("elevation_m"))
    surface = data.get("surface") if isinstance(data.get("surface"), dict) else {}
    waypoints = [str(w)[:80] for w in (data.get("waypoints") or []) if isinstance(w, str) and w.strip()][:15]
    pts = []
    if data.get("route_id"):
        user_dir, idx = _resolve_dirs()
        rid = _safe_id(str(data["route_id"]))
        entry = next((r for r in _load_index(idx) if r.get("id") == rid), None)
        if not entry:
            abort(404, description="Az útvonal nem található.")
        try:
            with open(os.path.join(user_dir, f"{rid}.gpx"), encoding="utf-8") as f:
                text = f.read()
        except OSError:
            abort(404, description="Az útvonal nyomvonala nem található.")
        pts = _gpx_points(text)
        if not waypoints:
            waypoints = [w.strip() for w in _WPT_NAME_RE.findall(text) if w.strip()][:15]
        name = name or entry.get("name") or ""
        rtype = rtype or entry.get("type") or ""
        dist = dist if dist is not None else _num(entry.get("distance"))
        elev = elev if elev is not None else _num(entry.get("elevation"))
        if not surface and isinstance(entry.get("surface"), dict):
            for s in entry["surface"].get("segments") or []:
                surface[s.get("mode")] = surface.get(s.get("mode"), 0) + (_num(s.get("distanceKm")) or 0)
    else:
        for p in (data.get("points") or [])[:2000]:
            if isinstance(p, (list, tuple)) and len(p) >= 2 and _num(p[0]) is not None and _num(p[1]) is not None:
                pts.append([_num(p[0]), _num(p[1]), _num(p[2]) if len(p) > 2 else None])
    pts = [p for p in pts if -90 <= p[0] <= 90 and -180 <= p[1] <= 180]
    if len(pts) < 2:
        abort(400, description="Előbb tervezz egy útvonalat.")

    loc = geo_location.locate(pts) or {}
    eles = [p[2] for p in pts if p[2] is not None]
    surf_total = sum(v for v in surface.values() if isinstance(v, (int, float)) and v > 0)
    info = {
        "nev": name, "tipus": _TYPE_LABELS.get(rtype, rtype),
        "tav_km": round(dist, 1) if dist else None, "emelkedo_m": round(elev) if elev else None,
        "legalacsonyabb_m": round(min(eles)) if eles else None, "legmagasabb_m": round(max(eles)) if eles else None,
        "kor": loc.get("loop"), "orszagok": loc.get("countries"), "megye": loc.get("region"),
        "rajt": loc.get("settlement"), "cel": (loc.get("places") or [None])[-1],
        "telepulesek": (loc.get("places") or [])[:15], "utpontok": waypoints,
        "burkolat": {(_SURF_LABELS.get(k, k)): f"{round(v / surf_total * 100)}%" for k, v in surface.items()
                     if isinstance(v, (int, float)) and v > 0 and v / surf_total >= 0.01} if surf_total else None,
        "jelenlegi_leiras": str(data.get("current") or "").strip()[:1000],
    }
    info = {k: v for k, v in info.items() if v not in (None, "", [], {})}
    if data.get("want") == "name":
        info.pop("jelenlegi_leiras", None)
        info["jelenlegi_nev"] = info.pop("nev", None) or ""
        try:
            new_name, model, usage = ai_service.name_route(info)
        except ai_service.AIError as exc:
            abort(502, description=str(exc))
        ai_service.log_usage(g.user["id"], "route_name", str(data.get("route_id") or "")[:60], model, usage)
        return jsonify({"name": new_name, "status": ai_service.status(g.user)})
    try:
        desc, model, usage = ai_service.describe_route(info)
    except ai_service.AIError as exc:
        abort(502, description=str(exc))
    ai_service.log_usage(g.user["id"], "route_description", str(data.get("route_id") or "")[:60], model, usage)
    return jsonify({"description": desc, "location": {k: loc.get(k) for k in ("region", "settlement", "places")},
                    "status": ai_service.status(g.user)})


@bp.route("/api/ai/workout/<route_id>", methods=["POST"])
@require_auth
def ai_workout(route_id: str):
    route_id = _safe_id(route_id)
    _check_quota()

    data = request.get_json(silent=True) or {}
    summary = data.get("summary")
    if not isinstance(summary, dict) or not summary:
        abort(400, description="Hiányzó edzésadat.")
    if len(str(summary)) > 20000:
        abort(400, description="Túl sok edzésadat.")
    history = data.get("history") if isinstance(data.get("history"), list) else []
    context = str(data.get("context") or "").strip()[:300]

    extended = data.get("mode") == "extended"
    index, idx, entry = _route_entry(route_id)
    if not _is_workout(entry):
        abort(400, description="AI-elemzés csak elvégzett edzéshez kérhető.")
    # a felhasználó érzése (RPE) és jegyzete is számít – pl. „7/10, fáradt voltam”
    if isinstance(entry.get("rpe"), int):
        summary = {**summary, "erzes_rpe_1_10": entry["rpe"]}
    if entry.get("notes") and not context:
        context = str(entry["notes"]).strip()[:300]
    try:
        if extended:
            analysis, model, usage = ai_service.analyze_workout_extended(summary, context, history)
        else:
            analysis, model, usage = ai_service.analyze_workout(summary, context, history)
    except ai_service.AIError as exc:
        abort(502, description=str(exc))
    ai_service.log_usage(g.user["id"], "workout_ext" if extended else "workout", route_id, model, usage)

    field = "ai_analysis_ext" if extended else "ai_analysis"
    entry[field] = {**analysis, "context": context, "model": model, "created_at": _now_dt(),
                    "data_sig": str(data.get("data_sig") or "")[:80], "edited": False}
    try:
        _save_index(index, idx)
    except OSError:
        abort(500)
    log.info("AI edzéselemzés%s: %s / %s", " (részletes)" if extended else "", g.user["email"], route_id)
    return jsonify({"analysis": entry[field], "status": ai_service.status(g.user)})


@bp.route("/api/ai/workout/<route_id>", methods=["PATCH"])
@require_auth
def ai_workout_edit(route_id: str):
    route_id = _safe_id(route_id)
    index, idx, entry = _route_entry(route_id)
    cur = entry.get("ai_analysis")
    if not isinstance(cur, dict):
        abort(404, description="Ehhez az edzéshez még nincs elemzés.")
    data = request.get_json(silent=True) or {}
    edited = ai_service.clean_analysis({**cur, **{k: data[k] for k in ("lead", "points") if k in data}})
    entry["ai_analysis"] = {**cur, "lead": edited["lead"], "points": edited["points"], "edited": True}
    _save_index(index, idx)
    return jsonify({"analysis": entry["ai_analysis"]})


@bp.route("/api/ai/workout/<route_id>", methods=["DELETE"])
@require_auth
def ai_workout_delete(route_id: str):
    route_id = _safe_id(route_id)
    index, idx, entry = _route_entry(route_id)
    entry.pop("ai_analysis", None)
    entry.pop("ai_analysis_ext", None)
    _save_index(index, idx)
    return jsonify({"ok": True})


# ── Admin ────────────────────────────────────────────────────────────────────

def _admin_payload() -> dict:
    return {"configured": bool(ai_service.api_key()), "key_hint": ai_service.masked_key(),
            "default_limit": ai_service.default_limit(), "model": ai_service.MODEL,
            "usage": ai_service.usage_summary(), "outage": ai_service.outage()}


@bp.route("/api/admin/ai/resume", methods=["POST"])
@require_auth
@require_admin
def admin_ai_resume():
    """Feltöltés után: a szünet azonnali feloldása (a következő kérés újra próbál)."""
    ai_service._clear_outage_if_any()
    log.info("AI szünet feloldva (admin: %s)", g.user["email"])
    return jsonify(_admin_payload())


@bp.route("/api/admin/ai", methods=["GET"])
@require_auth
@require_admin
def admin_ai_get():
    return jsonify(_admin_payload())


@bp.route("/api/admin/ai", methods=["PUT"])
@require_auth
@require_admin
def admin_ai_put():
    data = request.get_json(silent=True) or {}
    cfg = ai_service.load_config()
    if "api_key" in data:
        key = str(data.get("api_key") or "").strip()
        if key:
            try:
                ai_service.test_key(key)
            except ai_service.AIError as exc:
                abort(400, description=str(exc))
            cfg["api_key"] = key
        else:
            cfg.pop("api_key", None)
    if "default_limit" in data:
        try:
            cfg["default_limit"] = max(0, min(1000, int(data["default_limit"])))
        except (TypeError, ValueError):
            abort(400, description="Érvénytelen limit.")
    ai_service.save_config(cfg)
    log.info("AI beállítás módosítva (admin: %s)", g.user["email"])
    return jsonify(_admin_payload())


@bp.route("/api/admin/ai/test", methods=["POST"])
@require_auth
@require_admin
def admin_ai_test():
    key = str((request.get_json(silent=True) or {}).get("api_key") or "").strip() or ai_service.api_key()
    if not key:
        abort(400, description="Nincs API-kulcs megadva.")
    try:
        ai_service.test_key(key)
    except ai_service.AIError as exc:
        abort(400, description=str(exc))
    return jsonify({"ok": True})


@bp.route("/api/admin/ai/sample-description", methods=["POST"])
@require_auth
@require_admin
def admin_ai_sample_description():
    """Közösségi útvonal leírása, nehézsége és évszaka AI-javaslatként (a mentést az admin végzi)."""
    if not ai_service.api_key():
        abort(503, description="Az AI-funkció nincs beállítva (admin → AI).")
    data = request.get_json(silent=True) or {}
    info = {k: data.get(k) for k in ("nev", "tipus", "tav_km", "szint_m", "kor", "megye", "rajt", "telepulesek",
                                     "burkolat", "jelenlegi_leiras") if data.get(k) not in (None, "", [])}
    if not info.get("nev"):
        abort(400, description="Hiányzik az útvonal neve.")
    if len(str(info)) > 6000:
        abort(400, description="Túl sok adat.")
    try:
        result, model, usage = ai_service.describe_sample(info)
    except ai_service.AIError as exc:
        abort(502, description=str(exc))
    ai_service.log_usage(g.user["id"], "sample_description", str(data.get("id") or "")[:60], model, usage)
    return jsonify(result)
