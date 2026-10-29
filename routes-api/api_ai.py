"""Bringaterv API – AI-funkciók (Claude API).

  GET    /api/ai/status                    a bejelentkezett felhasználó AI-állapota, napi kerete
  PUT    /api/ai/me                        saját kikapcsolás / bekapcsolás ({enabled})
  POST   /api/ai/workout/<id>              edzés elemzése (az összesítőt a kliens számolja)
  PATCH  /api/ai/workout/<id>              az elemzés kézi szerkesztése
  DELETE /api/ai/workout/<id>              az elemzés törlése
  GET    /api/admin/ai                     beállítás + felhasználás (admin)
  PUT    /api/admin/ai                     API-kulcs, alap napi limit (admin)
  POST   /api/admin/ai/test                kulcs ellenőrzése (admin)

Az API-kulcs csak a szerveren van; a kliens sosem kapja meg.
"""

from flask import Blueprint, abort, g, jsonify, request

import ai_service
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


def _route_entry(route_id: str):
    _, idx = _resolve_dirs()
    index = _load_index(idx)
    entry = next((r for r in index if r.get("id") == route_id), None)
    if not entry:
        abort(404, description="Az edzés nem található.")
    return index, idx, entry


@bp.route("/api/ai/workout/<route_id>", methods=["POST"])
@require_auth
def ai_workout(route_id: str):
    route_id = _safe_id(route_id)
    st = ai_service.status(g.user)
    if not st["configured"]:
        abort(503, description="Az AI-funkció nincs beállítva.")
    if not st["allowed"]:
        abort(403, description="Az AI-funkció nincs engedélyezve a fiókodban.")
    if st["user_off"]:
        abort(403, description="Az AI-funkciót kikapcsoltad a Beállításokban.")
    if st["remaining"] <= 0:
        abort(429, description=f"Elérted a mai AI-keretet ({st['limit']}). Holnap újra próbálhatod.")

    data = request.get_json(silent=True) or {}
    summary = data.get("summary")
    if not isinstance(summary, dict) or not summary:
        abort(400, description="Hiányzó edzésadat.")
    if len(str(summary)) > 20000:
        abort(400, description="Túl sok edzésadat.")
    history = data.get("history") if isinstance(data.get("history"), list) else []
    context = str(data.get("context") or "").strip()[:300]

    index, idx, entry = _route_entry(route_id)
    try:
        analysis, model, usage = ai_service.analyze_workout(summary, context, history)
    except ai_service.AIError as exc:
        abort(502, description=str(exc))
    ai_service.log_usage(g.user["id"], "workout", route_id, model, usage)

    entry["ai_analysis"] = {**analysis, "context": context, "model": model, "created_at": _now_dt(),
                            "data_sig": str(data.get("data_sig") or "")[:80], "edited": False}
    try:
        _save_index(index, idx)
    except OSError:
        abort(500)
    log.info("AI edzéselemzés: %s / %s", g.user["email"], route_id)
    return jsonify({"analysis": entry["ai_analysis"], "status": ai_service.status(g.user)})


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
    _save_index(index, idx)
    return jsonify({"ok": True})


# ── Admin ────────────────────────────────────────────────────────────────────

def _admin_payload() -> dict:
    return {"configured": bool(ai_service.api_key()), "key_hint": ai_service.masked_key(),
            "default_limit": ai_service.default_limit(), "model": ai_service.MODEL,
            "usage": ai_service.usage_summary()}


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
