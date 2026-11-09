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
  api_account.py      /api/account* (e-mail megerősítés, jelszócsere), /api/auth/forgot|reset
  api_admin.py        /api/admin/users*, /api/admin/stats
  api_routes.py       /api/routes*
  api_samples.py      /api/samples* + /api/admin/samples*
  api_submissions.py  /api/submissions + /api/admin/submissions* (közösségi útvonalak beküldése, jóváhagyás)
  api_backup.py       /api/user/backup|restore + admin párjaik
  strava_service.py   Strava helperek (token, app config, deny-list, GPX builder)
  api_strava.py       /api/strava/* + /api/admin/strava/config
  garmin_service.py   Garmin helperek (login, MFA state, tokenek, testsúly)
  api_garmin.py       /api/garmin/*
  onelap_service.py   OnelapFit (Magene) helperek (aláírt kérések, tokenek, FIT→GPX)
  api_onelap.py       /api/onelap/*
  onelap_sync.py      automatikus Onelap import (háttér-szinkron)
  igpsport_service.py iGPSport helperek (token, FIT-import, útvonal-feltöltés)
  api_igpsport.py     /api/igpsport/*
  igpsport_sync.py    automatikus iGPSport import + lejárat-figyelmeztetés
  bryton_service.py   Bryton Active (Meteor DDP): belépés, FIT-import, útvonal (BrytonDirections FIT)
  api_bryton.py       /api/bryton/*
  bryton_sync.py      automatikus Bryton import
  api_geo.py          /api/geo/place-name(s) – útpont-nevek a szerveren, gyorsítótárral
  garmin_sync.py      automatikus Garmin import (háttér-szinkron)
  device_import.py    Wahoo / Polar közös rész (OAuth state, tokenek, mentés FIT-ből)
  wahoo_service.py    Wahoo Cloud API (import)
  polar_service.py    Polar AccessLink v3 (import)
  device_sync.py      automatikus Wahoo / Polar import
  api_devices.py      /api/wahoo/*, /api/polar/*
  gpx_metrics.py      mért adatok (teljesítmény, pulzus, kadencia) a GPX-ből + régiek pótlása
  gear.py             Felszerelés: bringák, alkatrészek, karbantartás (gear.json, km-számítás)
  api_gear.py         /api/gear*, /api/routes/bulk-bike
  fit_gpx.py          FIT → GPX (Onelap, Garmin import)
  api_feedback.py     /api/feedback + /api/admin/feedback*, /api/admin/mail*
  mailer.py           SMTP e-mail küldés (env: SMTP_*, FEEDBACK_TO)
"""

import os

from flask import Flask, jsonify
from flask_cors import CORS

import api_account
import api_ai
import api_roadmap
import surface_local
import brouter_admin
import api_admin
import api_auth
import api_backup
import api_feedback
import api_garmin
import api_invite
import api_onelap
import api_igpsport
import api_bryton
import api_geo
import api_devices
import api_gear
import api_notify
import api_public
import api_records
import api_routes
import api_samples
import api_submissions
import api_strava
from config import _LEGACY_USER_DIR, SAMPLES_DIR
from db import _db, _db_init

# ── Flask app ─────────────────────────────────────────────────────────────────

app = Flask(__name__)
CORS(app)

os.makedirs(_LEGACY_USER_DIR, exist_ok=True)

app.register_blueprint(api_auth.bp)
app.register_blueprint(api_account.bp)
app.register_blueprint(api_admin.bp)
app.register_blueprint(api_routes.bp)
app.register_blueprint(api_samples.bp)
app.register_blueprint(api_submissions.bp)
app.register_blueprint(api_backup.bp)
app.register_blueprint(api_strava.bp)
app.register_blueprint(api_garmin.bp)
app.register_blueprint(api_onelap.bp)
app.register_blueprint(api_igpsport.bp)
app.register_blueprint(api_bryton.bp)
app.register_blueprint(api_geo.bp)
app.register_blueprint(api_devices.bp)
app.register_blueprint(api_gear.bp)
app.register_blueprint(api_public.bp)
app.register_blueprint(api_records.bp)
app.register_blueprint(api_notify.bp)
app.register_blueprint(api_invite.bp)
app.register_blueprint(api_feedback.bp)
app.register_blueprint(api_ai.bp)
app.register_blueprint(api_roadmap.bp)
app.register_blueprint(surface_local.bp)
app.register_blueprint(brouter_admin.bp)

# Automatikus Strava import – háttérszál (több worker közül csak egy dolgozik)
from strava_sync import start_scheduler  # noqa: E402
start_scheduler()
import onelap_sync  # noqa: E402
onelap_sync.start_scheduler()   # automatikus Onelap (Magene) import
import igpsport_sync  # noqa: E402
igpsport_sync.start_scheduler()   # automatikus iGPSport import
import bryton_sync  # noqa: E402
bryton_sync.start_scheduler()   # automatikus Bryton import
import garmin_sync  # noqa: E402
garmin_sync.start_scheduler()   # automatikus Garmin Connect import
import device_sync  # noqa: E402
device_sync.start_scheduler()   # automatikus Wahoo / Polar import
import gpx_metrics  # noqa: E402
gpx_metrics.backfill_all()      # régi edzések mért adatainak pótlása (egyszer, háttérben)
api_gear.start_scheduler()      # esedékes karbantartás → push (óránként)
surface_local.start_scheduler()   # havi burkolat-adatbázis frissítés


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
@app.errorhandler(410)
@app.errorhandler(429)
@app.errorhandler(500)
@app.errorhandler(502)
@app.errorhandler(503)
def json_error(e):
    return jsonify({"error": e.description}), e.code


# ══════════════════════════════════════════════════════════════════════════════
# INDÍTÁS
# ══════════════════════════════════════════════════════════════════════════════

with app.app_context():
    _db_init()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=False)
