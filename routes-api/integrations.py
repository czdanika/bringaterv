"""Bringaterv – integrációk nyilvántartása: ki-be kapcsolás az adminból, egészségjelző.

Ha egy szolgáltató (pl. a nem hivatalos iGPSport- vagy Garmin-API) megváltozik és hibázni
kezd, az admin kiadás nélkül lekapcsolhatja (site_settings.integrations_off):
  - a /api/<key>/… végpontok 503-at adnak érthető üzenettel (a /status „disabled” jelzést),
  - az automatikus import kimarad (sync_engine / device_sync / strava_sync ellenőrzi),
  - a felület a Beállításokban és a Könyvtár import-listájában jelzi.

Egészség (GET /api/admin/integrations): felhasználónként a <key>.json (kapcsolat) és a
<key>_sync.json (automatikus import állapota) alapján – hány kapcsolat, hány automatikus
import, hánynál volt hiba legutóbb, mikor futott utoljára, összesen hány edzést hozott.
"""

import json
import os
import re

from flask import Blueprint, jsonify, request

import site_settings
from auth import require_auth
from config import MULTI_DATA_DIR

bp = Blueprint("integrations", __name__)

INTEGRATIONS = [
    {"key": "strava", "article": "A",   "label": "Strava",    "kind": "Import (hivatalos API, webhook)"},
    {"key": "garmin", "article": "A",   "label": "Garmin",    "kind": "Import + útvonal küldése (nem hivatalos API)"},
    {"key": "onelap", "article": "Az",   "label": "OnelapFit", "kind": "Import + útvonal küldése (Magene, GEOID)"},
    {"key": "igpsport", "article": "Az", "label": "iGPSport",  "kind": "Import + útvonal küldése (nem hivatalos API)"},
    {"key": "bryton", "article": "A",   "label": "Bryton",    "kind": "Import + útvonal küldése (nem hivatalos API)"},
    {"key": "wahoo", "article": "A",    "label": "Wahoo",     "kind": "Import (hivatalos API)"},
    {"key": "polar", "article": "A",    "label": "Polar",     "kind": "Import (hivatalos API)"},
]
KEYS = {i["key"] for i in INTEGRATIONS}
LABELS = {i["key"]: i["label"] for i in INTEGRATIONS}
ARTICLES = {i["key"]: i["article"] for i in INTEGRATIONS}
_PATH_RE = re.compile(r"^/api/([a-z]+)(/|$)")


def disabled() -> set:
    return set(site_settings.load().get("integrations_off") or []) & KEYS


def is_enabled(key: str) -> bool:
    return key not in disabled()


def message(key: str) -> str:
    return f"{ARTICLES.get(key, 'A')} {LABELS.get(key, key)}-kapcsolat ideiglenesen nem érhető el (karbantartás). Az edzéseid megmaradnak, később újra működik."


def gate():
    """before_request: a kikapcsolt integráció végpontjai nem futnak."""
    m = _PATH_RE.match(request.path)
    if not m or m.group(1) not in KEYS:
        return None
    key = m.group(1)
    if is_enabled(key):
        return None
    if request.path.endswith("/status"):
        return jsonify({"connected": False, "disabled": True, "message": message(key)})
    if key == "strava" and "/webhook" in request.path:
        return jsonify({"ok": True})                 # a Strava ne próbálkozzon újra
    resp = jsonify({"error": message(key), "disabled": True})
    resp.status_code = 503
    return resp


def _read(path: str):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def health() -> list:
    off = disabled()
    out = []
    users = sorted(os.listdir(MULTI_DATA_DIR)) if os.path.isdir(MULTI_DATA_DIR) else []
    for it in INTEGRATIONS:
        k = it["key"]
        h = {**it, "enabled": k not in off, "connected": 0, "auto": 0, "errors": 0,
             "last_check": None, "last_error": None, "total_imported": 0}
        for uid in users:
            d = os.path.join(MULTI_DATA_DIR, uid)
            if os.path.isfile(os.path.join(d, f"{k}.json")):
                h["connected"] += 1
            st = _read(os.path.join(d, f"{k}_sync.json"))
            if not isinstance(st, dict):
                continue
            if st.get("enabled"):
                h["auto"] += 1
            if st.get("last_error"):
                h["errors"] += 1
                h["last_error"] = st["last_error"]
            lc = st.get("last_check")
            if lc and (not h["last_check"] or lc > h["last_check"]):
                h["last_check"] = lc
            h["total_imported"] += int(st.get("total_imported") or 0)
        out.append(h)
    return out


@bp.route("/api/integrations", methods=["GET"])
@require_auth
def user_integrations():
    """A felületnek: mely integrációk vannak most lekapcsolva (és az üzenet hozzájuk)."""
    off = sorted(disabled())
    return jsonify({"disabled": off, "messages": {k: message(k) for k in off}})
