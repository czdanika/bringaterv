"""
Bringaterv – Útvonaltár API
============================
Egyszerű Flask REST API a tervezett útvonalak szerver oldali tárolásához.

Végpontok:
  GET    /api/routes          – Felhasználói útvonalak listája
  POST   /api/routes          – Új útvonal mentése
  GET    /api/routes/<id>     – Útvonal GPX tartalmának lekérése
  DELETE /api/routes/<id>     – Útvonal törlése

  GET    /api/samples         – Beépített minta útvonalak listája
  GET    /api/samples/<id>    – Minta útvonal GPX tartalma

  GET    /api/health          – Health check (Docker, nginx upstream ellenőrzés)

Fájlstruktúra (Docker volume):
  /data/routes/
    index.json          ← metaadat lista (id, name, date, distance, type, description)
    user/
      <id>.gpx          ← felhasználói GPX fájlok

Minták (Docker image-be égetett):
  /samples/
    <id>.gpx
    <id>.json           ← minta metaadat (name, distance, type, description)

Konfiguráció (környezeti változók):
  DATA_DIR    – felhasználói adatok könyvtára  (alapért.: /data/routes)
  SAMPLES_DIR – minta fájlok könyvtára         (alapért.: /samples)
"""

import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone

from flask import Flask, abort, jsonify, request
from flask_cors import CORS

# ── Konfiguráció ──────────────────────────────────────────────────────────────
DATA_DIR    = os.environ.get("DATA_DIR",    "/data/routes")
SAMPLES_DIR = os.environ.get("SAMPLES_DIR", "/samples")
USER_DIR    = os.path.join(DATA_DIR, "user")
INDEX_FILE  = os.path.join(DATA_DIR, "index.json")

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ── App inicializálás ─────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)  # nginx proxy mögül is elérhető legyen

# Könyvtárak létrehozása induláskor
os.makedirs(USER_DIR, exist_ok=True)
log.info("Adatkönyvtár: %s", DATA_DIR)
log.info("Minta könyvtár: %s", SAMPLES_DIR)


# ── Segédfüggvények ───────────────────────────────────────────────────────────

def _safe_id(raw: str) -> str:
    """Biztonságos azonosító – csak alfanumerikus és kötőjel megengedett (path traversal védelem)."""
    return re.sub(r"[^a-zA-Z0-9\-]", "", raw)


def _load_index() -> list:
    """Index JSON betöltése. Ha nem létezik, üres listával tér vissza."""
    if not os.path.exists(INDEX_FILE):
        return []
    try:
        with open(INDEX_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        log.error("Index olvasási hiba: %s", e)
        return []


def _save_index(index: list) -> None:
    """Index JSON kiírása atomikusan (temp fájl → rename)."""
    tmp = INDEX_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)
        os.replace(tmp, INDEX_FILE)
    except OSError as e:
        log.error("Index írási hiba: %s", e)
        raise


def _now_iso() -> str:
    """Aktuális dátum ISO formátumban (UTC, csak dátum rész)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ── Health check ──────────────────────────────────────────────────────────────

@app.route("/api/health", methods=["GET"])
def health():
    """
    Egyszerű health check – nginx upstream ellenőrzéshez.
    Visszaadja az aktuális mentett és minta útvonalak számát is.
    """
    index = _load_index()

    sample_count = 0
    if os.path.isdir(SAMPLES_DIR):
        sample_count = sum(1 for f in os.listdir(SAMPLES_DIR) if f.endswith(".gpx"))

    return jsonify({
        "status": "ok",
        "user_routes": len(index),
        "samples": sample_count,
        "data_dir": DATA_DIR,
    })


# ── Felhasználói útvonalak ────────────────────────────────────────────────────

@app.route("/api/routes", methods=["GET"])
def list_routes():
    """
    Felhasználói útvonalak listája.

    Válasz: JSON tömb, legújabb először rendezve.
    [
      {
        "id": "a1b2c3d4",
        "name": "Balatoni kör",
        "date": "2026-05-17",
        "distance": 204.5,       ← km, lehet null
        "type": "cycling",       ← "cycling" | "hiking"
        "description": "..."
      },
      ...
    ]
    """
    index = _load_index()
    # Legújabb először (dátum alapján)
    index_sorted = sorted(index, key=lambda r: r.get("date", ""), reverse=True)
    return jsonify(index_sorted)


@app.route("/api/routes", methods=["POST"])
def save_route():
    """
    Új útvonal mentése.

    Kérés body (JSON):
    {
      "name":        "Balatoni kör",      ← kötelező
      "gpxContent":  "<gpx>...</gpx>",   ← kötelező
      "distance":    204.5,              ← opcionális, km
      "duration":    615,                ← opcionális, percben
      "elevation":   850,                ← opcionális, méter (emelkedő)
      "type":        "cycling",          ← opcionális, alapért. "cycling"
      "description": "..."               ← opcionális
    }

    Válasz: {"id": "a1b2c3d4"}, HTTP 201
    """
    data = request.get_json(silent=True)
    if not data:
        abort(400, description="Hiányzó JSON body")

    name        = (data.get("name") or "Névtelen útvonal").strip()
    gpx_content = data.get("gpxContent", "").strip()
    distance    = data.get("distance")   # lehet None, km
    duration    = data.get("duration")   # lehet None, perc
    elevation   = data.get("elevation")  # lehet None, méter (emelkedő)
    route_type  = data.get("type", "cycling")
    description = (data.get("description") or "").strip()

    if not gpx_content:
        abort(400, description="Hiányzó gpxContent mező")

    # Rövid, olvasható azonosító (8 hex karakter)
    route_id = uuid.uuid4().hex[:8]
    gpx_path = os.path.join(USER_DIR, f"{route_id}.gpx")

    # GPX fájl mentése
    try:
        with open(gpx_path, "w", encoding="utf-8") as f:
            f.write(gpx_content)
    except OSError as e:
        log.error("GPX írási hiba (%s): %s", route_id, e)
        abort(500, description="Fájl írási hiba")

    # Index frissítése
    entry = {
        "id":          route_id,
        "name":        name,
        "date":        _now_iso(),
        "distance":    round(distance, 1) if isinstance(distance, (int, float)) else None,
        "duration":    int(duration)      if isinstance(duration, (int, float)) else None,
        "elevation":   int(elevation)     if isinstance(elevation, (int, float)) else None,
        "type":        route_type,
        "description": description,
    }
    index = _load_index()
    index.append(entry)
    try:
        _save_index(index)
    except OSError:
        # Ha az index írása sikertelen, a GPX-et is töröljük (konzisztencia)
        os.remove(gpx_path)
        abort(500, description="Index írási hiba")

    log.info("Új útvonal mentve: %s (%s)", route_id, name)
    return jsonify({"id": route_id}), 201


@app.route("/api/routes/<route_id>", methods=["GET"])
def get_route(route_id: str):
    """
    Útvonal GPX tartalmának lekérése.

    Válasz: GPX XML szöveg (Content-Type: application/gpx+xml)
    """
    route_id = _safe_id(route_id)
    gpx_path = os.path.join(USER_DIR, f"{route_id}.gpx")

    if not os.path.isfile(gpx_path):
        abort(404, description=f"Útvonal nem található: {route_id}")

    try:
        with open(gpx_path, encoding="utf-8") as f:
            content = f.read()
    except OSError as e:
        log.error("GPX olvasási hiba (%s): %s", route_id, e)
        abort(500, description="Fájl olvasási hiba")

    return content, 200, {"Content-Type": "application/gpx+xml; charset=utf-8"}


@app.route("/api/routes/<route_id>", methods=["PATCH"])
def update_route(route_id: str):
    """
    Útvonal metaadatainak frissítése (GPX fájlt NEM érinti).
    Csak a megadott mezők frissülnek (partial update).

    Kérés body (JSON) – mind opcionális:
    {
      "name":        "Új név",
      "type":        "hiking",
      "description": "Új leírás"
    }

    Válasz: a frissített index bejegyzés, HTTP 200
    """
    route_id = _safe_id(route_id)
    data = request.get_json(silent=True) or {}

    index = _load_index()
    entry = next((r for r in index if r.get("id") == route_id), None)
    if not entry:
        abort(404, description=f"Útvonal nem található: {route_id}")

    # Csak a megadott mezőket frissítjük
    if "name" in data:
        entry["name"] = (data["name"] or "Névtelen útvonal").strip()
    if "type" in data:
        entry["type"] = data["type"]
    if "description" in data:
        entry["description"] = (data["description"] or "").strip()

    try:
        _save_index(index)
    except OSError:
        abort(500, description="Index írási hiba")

    log.info("Útvonal frissítve: %s (%s)", route_id, entry["name"])
    return jsonify(entry), 200


@app.route("/api/routes/<route_id>", methods=["DELETE"])
def delete_route(route_id: str):
    """
    Útvonal törlése (GPX fájl + index bejegyzés).

    Válasz: HTTP 204 No Content
    """
    route_id = _safe_id(route_id)
    gpx_path = os.path.join(USER_DIR, f"{route_id}.gpx")

    if not os.path.isfile(gpx_path):
        abort(404, description=f"Útvonal nem található: {route_id}")

    # Fájl törlése
    try:
        os.remove(gpx_path)
    except OSError as e:
        log.error("GPX törlési hiba (%s): %s", route_id, e)
        abort(500, description="Fájl törlési hiba")

    # Index frissítése
    index = [r for r in _load_index() if r.get("id") != route_id]
    try:
        _save_index(index)
    except OSError:
        abort(500, description="Index frissítési hiba")

    log.info("Útvonal törölve: %s", route_id)
    return "", 204


# ── Minta útvonalak ───────────────────────────────────────────────────────────

@app.route("/api/samples", methods=["GET"])
def list_samples():
    """
    Beépített minta útvonalak listája.
    Minden mintához keresünk egy <id>.json metaadat fájlt.
    Ha nincs, a fájlnévből generálunk nevet.

    Válasz: JSON tömb (névsorban rendezve).
    [
      {
        "id":          "balatoni-kor",
        "name":        "Balatoni kör",
        "distance":    204,
        "type":        "cycling",
        "description": "A Balaton teljes kerülése..."
      },
      ...
    ]
    """
    if not os.path.isdir(SAMPLES_DIR):
        return jsonify([])

    samples = []
    for filename in sorted(os.listdir(SAMPLES_DIR)):
        if not filename.endswith(".gpx"):
            continue

        sample_id = filename[:-4]  # kiterjesztés nélkül
        meta_path = os.path.join(SAMPLES_DIR, f"{sample_id}.json")

        if os.path.isfile(meta_path):
            try:
                with open(meta_path, encoding="utf-8") as f:
                    meta = json.load(f)
            except (json.JSONDecodeError, OSError):
                meta = {}
        else:
            meta = {}

        samples.append({
            "id":          sample_id,
            "name":        meta.get("name", sample_id.replace("-", " ").title()),
            "distance":    meta.get("distance"),
            "duration":    meta.get("duration"),
            "elevation":   meta.get("elevation"),
            "type":        meta.get("type", "cycling"),
            "description": meta.get("description", ""),
        })

    return jsonify(samples)


@app.route("/api/samples/<sample_id>", methods=["GET"])
def get_sample(sample_id: str):
    """
    Minta útvonal GPX tartalmának lekérése.

    Válasz: GPX XML szöveg (Content-Type: application/gpx+xml)
    """
    sample_id = _safe_id(sample_id)
    gpx_path  = os.path.join(SAMPLES_DIR, f"{sample_id}.gpx")

    if not os.path.isfile(gpx_path):
        abort(404, description=f"Minta nem található: {sample_id}")

    try:
        with open(gpx_path, encoding="utf-8") as f:
            content = f.read()
    except OSError as e:
        log.error("Minta olvasási hiba (%s): %s", sample_id, e)
        abort(500, description="Fájl olvasási hiba")

    return content, 200, {"Content-Type": "application/gpx+xml; charset=utf-8"}


# ── Hibakezelés ───────────────────────────────────────────────────────────────

@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(500)
def json_error(e):
    """Minden HTTP hiba JSON formátumban tér vissza."""
    return jsonify({"error": e.description}), e.code


# ── Belépési pont ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Fejlesztői szerver (Docker-ben gunicorn fut helyette)
    app.run(host="0.0.0.0", port=5001, debug=False)
