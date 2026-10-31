"""Bringaterv API – a saját BRouter-szerver állapota (admin).

  GET  /api/admin/brouter     csempék, verzió, utolsó ellenőrzés + élő próbatervezés
  POST /api/admin/brouter     csempefrissítés kérése (a brouter konténer percenként figyeli)

A brouter konténer kötete a routes-api-ban a BROUTER_DATA (alapért.: /brouter) alatt látszik;
ha nincs (a stackben még nincs brouter), az állapot „nincs telepítve”.
"""

import json
import os
import time

import requests
from flask import Blueprint, abort, g, jsonify

from auth import require_admin, require_auth
from config import log

bp = Blueprint("brouter_admin", __name__)

BROUTER_DATA = os.environ.get("BROUTER_DATA", "/brouter")
BROUTER_URL = os.environ.get("BROUTER_URL", "http://brouter:17777")
# rövid próbaútvonal Budapesten (Lánchíd → Margitsziget)
_PROBE = "lonlats=19.0437,47.4989|19.0486,47.5268&profile=fastbike&alternativeidx=0&format=geojson"


def _status() -> dict:
    data = {}
    try:
        with open(os.path.join(BROUTER_DATA, "status.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        pass
    probe = {"ok": False}
    t = time.time()
    try:
        r = requests.get(f"{BROUTER_URL}/brouter?{_PROBE}", timeout=5)
        probe = {"ok": r.ok, "ms": round((time.time() - t) * 1000), "http": r.status_code}
        if not r.ok:
            probe["error"] = r.text[:160]
    except requests.RequestException as exc:
        probe = {"ok": False, "error": type(exc).__name__}
    return {"installed": bool(data) or probe["ok"], "status": data, "probe": probe,
            "update_requested": os.path.exists(os.path.join(BROUTER_DATA, "update.request"))}


@bp.route("/api/admin/brouter", methods=["GET"])
@require_auth
@require_admin
def admin_brouter_status():
    return jsonify(_status())


@bp.route("/api/admin/brouter", methods=["POST"])
@require_auth
@require_admin
def admin_brouter_update():
    if not os.path.isdir(BROUTER_DATA):
        abort(409, description="A brouter szolgáltatás nincs a stackben (lásd brouter/README.md).")
    try:
        open(os.path.join(BROUTER_DATA, "update.request"), "w").close()
    except OSError as exc:
        abort(500, description=f"A frissítési kérés nem írható: {exc}")
    log.info("BRouter csempefrissítés kérve (admin: %s)", g.user["email"])
    return jsonify(_status())
