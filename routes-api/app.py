"""
Bringaterv – Útvonaltár API  v2
================================
JWT autentikáció, per-user adatok, admin felület, kvótakezelés, SQLite statisztika.

Belépési pont: gunicorn app:app

Modulok:
  config.py           env változók, logging
  utils.py            közös segédfüggvények (ID, index fájl, dátum)
  security.py         jelszó hash + JWT
  storage.py          per-user fájltárolás (mappák, settings.json)
  db.py               SQLite séma, migrációk, user létrehozás
  auth.py             require_auth / require_admin dekorátorok
  api_auth.py         /api/auth/* + /api/user/settings
  api_admin.py        /api/admin/users*, /api/admin/stats
  api_routes.py       /api/routes*
  api_samples.py      /api/samples* + /api/admin/samples*
  api_backup.py       /api/user/backup|restore + admin párjaik
  strava_service.py   Strava helperek (token, app config, deny-list, GPX builder)
  api_strava.py       /api/strava/* + /api/admin/strava/config
"""

import os

from flask import Flask, jsonify
from flask_cors import CORS

import api_admin
import api_auth
import api_backup
import api_routes
import api_samples
import api_strava
from config import _LEGACY_USER_DIR, SAMPLES_DIR
from db import _db, _db_init

# ── Flask app ─────────────────────────────────────────────────────────────────

app = Flask(__name__)
CORS(app)

os.makedirs(_LEGACY_USER_DIR, exist_ok=True)

app.register_blueprint(api_auth.bp)
app.register_blueprint(api_admin.bp)
app.register_blueprint(api_routes.bp)
app.register_blueprint(api_samples.bp)
app.register_blueprint(api_backup.bp)
app.register_blueprint(api_strava.bp)


# ══════════════════════════════════════════════════════════════════════════════
# HEALTH CHECK
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/health", methods=["GET"])
def health():
    sample_count = (
        sum(1 for f in os.listdir(SAMPLES_DIR) if f.endswith(".gpx"))
        if os.path.isdir(SAMPLES_DIR) else 0
    )
    with _db() as conn:
        active_users = conn.execute(
            "SELECT COUNT(*) FROM users WHERE active = 1"
        ).fetchone()[0]
    return jsonify({"status": "ok", "samples": sample_count, "active_users": active_users})


# ══════════════════════════════════════════════════════════════════════════════
# HIBAKEZELÉS
# ══════════════════════════════════════════════════════════════════════════════

@app.errorhandler(400)
@app.errorhandler(401)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(409)
@app.errorhandler(429)
@app.errorhandler(500)
def json_error(e):
    return jsonify({"error": e.description}), e.code


# ══════════════════════════════════════════════════════════════════════════════
# INDÍTÁS
# ══════════════════════════════════════════════════════════════════════════════

with app.app_context():
    _db_init()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=False)
