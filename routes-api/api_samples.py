"""Bringaterv API – minta útvonalak (publikus lista + admin kezelés)."""

import json
import os
import re

from flask import Blueprint, abort, jsonify, request

from auth import require_admin, require_auth
from config import CUSTOM_SAMPLES_DIR, SAMPLES_DIR
from utils import _safe_id

bp = Blueprint("api_samples", __name__)


def _load_sample_meta(directory: str, sid: str) -> dict:
    meta = {}
    mp = os.path.join(directory, f"{sid}.json")
    if os.path.isfile(mp):
        try:
            with open(mp, encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            pass
    return meta


def _sample_entry(sid: str, meta: dict, custom: bool) -> dict:
    return {
        "id":          sid,
        "name":        meta.get("name", sid.replace("-", " ").title()),
        "distance":    meta.get("distance"),
        "duration":    meta.get("duration"),
        "elevation":   meta.get("elevation"),
        "type":        meta.get("type", "cycling"),
        "description": meta.get("description", ""),
        "custom":      custom,
    }


@bp.route("/api/samples", methods=["GET"])
def list_samples():
    seen = {}
    # custom előbb – felülírja a beépítetteket azonos ID esetén
    for directory, is_custom in [(CUSTOM_SAMPLES_DIR, True), (SAMPLES_DIR, False)]:
        if not os.path.isdir(directory):
            continue
        for fn in sorted(os.listdir(directory)):
            if not fn.endswith(".gpx"):
                continue
            sid = fn[:-4]
            if sid not in seen:
                meta = _load_sample_meta(directory, sid)
                seen[sid] = _sample_entry(sid, meta, is_custom)
    return jsonify(list(seen.values()))


@bp.route("/api/samples/<sample_id>", methods=["GET"])
def get_sample(sample_id: str):
    sample_id = _safe_id(sample_id)
    # custom előbb, aztán beépített
    for directory in (CUSTOM_SAMPLES_DIR, SAMPLES_DIR):
        gpx_path = os.path.join(directory, f"{sample_id}.gpx")
        if os.path.isfile(gpx_path):
            try:
                with open(gpx_path, encoding="utf-8") as f:
                    content = f.read()
            except OSError:
                abort(500)
            return content, 200, {"Content-Type": "application/gpx+xml; charset=utf-8"}
    abort(404, description=f"Minta nem található: {sample_id}")


# ── Admin: sample kezelés ─────────────────────────────────────────────────────

@bp.route("/api/admin/samples", methods=["GET"])
@require_auth
@require_admin
def admin_list_samples():
    result = []
    for directory, is_custom in [(CUSTOM_SAMPLES_DIR, True), (SAMPLES_DIR, False)]:
        if not os.path.isdir(directory):
            continue
        for fn in sorted(os.listdir(directory)):
            if not fn.endswith(".gpx"):
                continue
            sid  = fn[:-4]
            meta = _load_sample_meta(directory, sid)
            result.append(_sample_entry(sid, meta, is_custom))
    return jsonify(result)


@bp.route("/api/admin/samples", methods=["POST"])
@require_auth
@require_admin
def admin_create_sample():
    if "gpx" not in request.files:
        abort(400, description="gpx fájl kötelező")
    gpx_file = request.files["gpx"]
    raw_name = request.form.get("name", "").strip()
    sid = _safe_id(re.sub(r"\s+", "-", raw_name).lower() or gpx_file.filename.rsplit(".", 1)[0])
    if not sid:
        abort(400, description="Érvénytelen minta-azonosító")
    os.makedirs(CUSTOM_SAMPLES_DIR, exist_ok=True)
    gpx_path = os.path.join(CUSTOM_SAMPLES_DIR, f"{sid}.gpx")
    gpx_file.save(gpx_path)
    meta = {
        "name":        raw_name or sid.replace("-", " ").title(),
        "type":        request.form.get("type", "cycling"),
        "description": request.form.get("description", ""),
    }
    for key in ("distance", "duration", "elevation"):
        val = request.form.get(key, "").strip()
        if val:
            try:
                meta[key] = float(val)
            except ValueError:
                pass
    json_path = os.path.join(CUSTOM_SAMPLES_DIR, f"{sid}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return jsonify(_sample_entry(sid, meta, True)), 201


@bp.route("/api/admin/samples/<sample_id>", methods=["PATCH"])
@require_auth
@require_admin
def admin_update_sample(sample_id: str):
    sample_id = _safe_id(sample_id)
    # beépített mintát is lehet "felülírni" egy custom JSON-nal
    os.makedirs(CUSTOM_SAMPLES_DIR, exist_ok=True)
    json_path = os.path.join(CUSTOM_SAMPLES_DIR, f"{sample_id}.json")
    # meglévő meta betöltése (custom vagy builtin)
    meta = _load_sample_meta(CUSTOM_SAMPLES_DIR, sample_id)
    if not meta:
        meta = _load_sample_meta(SAMPLES_DIR, sample_id)
    data = request.get_json(force=True) or {}
    for key in ("name", "type", "description"):
        if key in data:
            meta[key] = data[key]
    for key in ("distance", "duration", "elevation"):
        if key in data:
            try:
                meta[key] = float(data[key])
            except (ValueError, TypeError):
                pass
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return jsonify(_sample_entry(sample_id, meta, True))


@bp.route("/api/admin/samples/<sample_id>", methods=["DELETE"])
@require_auth
@require_admin
def admin_delete_sample(sample_id: str):
    sample_id = _safe_id(sample_id)
    deleted = False
    for ext in (".gpx", ".json"):
        p = os.path.join(CUSTOM_SAMPLES_DIR, f"{sample_id}{ext}")
        if os.path.isfile(p):
            os.remove(p)
            deleted = True
    if not deleted:
        abort(404, description="Csak custom minta törölhető")
    return jsonify({"ok": True})
