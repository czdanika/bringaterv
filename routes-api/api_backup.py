"""Bringaterv API – backup / restore (user + admin végpontok és ZIP helperek)."""

import io
import json
import os
import shutil
import uuid
import zipfile

from flask import Blueprint, abort, g, jsonify, request, send_file

from auth import require_admin, require_auth
from config import log
from db import _db
from storage import _save_user_settings_file, _user_dir, _user_settings_path
from utils import _load_index, _now_date, _now_dt, _safe_id, _save_index

bp = Blueprint("api_backup", __name__)

BACKUP_VERSION = 1

# A settings.json mellett ezek is a profil részei (replace módban visszaállnak).
# A strava.json (tokenek, client secret) és a strava_sync.json (webhook) szándékosan
# kimarad: a Strava-kapcsolatot visszaállítás után újra kell csatlakoztatni.
EXTRA_FILES = ("notifications.json", "strava_deleted.json")
PRE_RESTORE_NAME = "pre_restore.zip"


def _build_user_backup_zip(user_id: str, user_email: str = None) -> io.BytesIO:
    """ZIP archívum a user teljes adatáról: settings.json + routes/ + workouts/."""
    buf  = io.BytesIO()
    base = _user_dir(user_id)
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("meta.json", json.dumps({
            "version":    BACKUP_VERSION,
            "user_id":    user_id,
            "user_email": user_email,
            "created_at": _now_dt(),
        }, ensure_ascii=False, indent=2))
        settings_path = _user_settings_path(user_id)
        if os.path.isfile(settings_path):
            zf.write(settings_path, "settings.json")
        for fn in EXTRA_FILES:
            fp = os.path.join(base, fn)
            if os.path.isfile(fp):
                zf.write(fp, fn)
        for sub in ("routes", "workouts"):
            d = os.path.join(base, sub)
            if not os.path.isdir(d):
                continue
            for fn in sorted(os.listdir(d)):
                fp = os.path.join(d, fn)
                if os.path.isfile(fp):
                    zf.write(fp, f"{sub}/{fn}")
    buf.seek(0)
    return buf


def _restore_user_from_zip(user_id: str, zip_bytes: bytes, mode: str) -> dict:
    """Restore ZIP a user mappájába. mode: merge|replace.
    merge:   a backup elemei új ID-vel kerülnek a meglévők mellé; ami már megvan
             (azonos Strava-azonosító, vagy azonos név + dátum + távolság), kimarad. A beállítások nem változnak.
    replace: előbb automatikus mentés készül (pre_restore.zip), majd a meglévő
             routes/ + workouts/ + beállítások törlődnek, és a backup az eredeti ID-kkel íródik vissza.
    """
    if mode not in ("merge", "replace"):
        abort(400, description="Érvénytelen mód: merge vagy replace")

    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
        names = set(zf.namelist())
    except zipfile.BadZipFile:
        abort(400, description="Érvénytelen ZIP fájl")

    # Csak Bringaterv-backupot fogadunk el – különben a replace mindent törölne
    if not ({"meta.json", "routes/index.json", "workouts/index.json", "settings.json"} & names):
        abort(400, description="Ez nem Bringaterv backup (hiányzik a meta.json / index.json).")

    base = _user_dir(user_id)
    os.makedirs(base, exist_ok=True)

    stats = {"routes_added": 0, "workouts_added": 0, "skipped": 0, "settings_restored": False}

    if mode == "replace":
        # Biztonsági mentés a felülírás előtt (a legutóbbi felülírás előtti állapot)
        try:
            with open(os.path.join(base, PRE_RESTORE_NAME), "wb") as f:
                f.write(_build_user_backup_zip(user_id).getvalue())
        except OSError as exc:
            log.warning("Restore: pre_restore mentés sikertelen (%s): %s", user_id, exc)
            abort(500, description="Nem sikerült biztonsági mentést készíteni – a visszaállítás megszakítva.")
        for sub in ("routes", "workouts"):
            d = os.path.join(base, sub)
            if os.path.isdir(d):
                shutil.rmtree(d)
        if os.path.isfile(_user_settings_path(user_id)):
            os.remove(_user_settings_path(user_id))

        try:
            settings = json.loads(zf.read("settings.json").decode("utf-8"))
            if isinstance(settings, dict):
                _save_user_settings_file(user_id, settings)
                stats["settings_restored"] = True
        except KeyError:
            pass  # nincs settings.json a backupban
        except (json.JSONDecodeError, UnicodeDecodeError):
            log.warning("Restore: érvénytelen settings.json a backupban")

        for fn in EXTRA_FILES:
            if fn in names:
                with open(os.path.join(base, fn), "wb") as f:
                    f.write(zf.read(fn))

    # routes/ + workouts/ feldolgozása
    for sub in ("routes", "workouts"):
        sub_dir = os.path.join(base, sub)
        os.makedirs(sub_dir, exist_ok=True)
        idx_path = os.path.join(sub_dir, "index.json")

        backup_index = []
        try:
            backup_index = json.loads(zf.read(f"{sub}/index.json").decode("utf-8"))
            if not isinstance(backup_index, list):
                backup_index = []
        except KeyError:
            pass
        except (json.JSONDecodeError, UnicodeDecodeError):
            log.warning("Restore: érvénytelen %s/index.json", sub)

        if mode == "replace":
            restored = []
            for entry in backup_index:
                rid = _safe_id(str(entry.get("id", "")))
                if rid and rid == entry.get("id") and _copy_route_files_from_zip(zf, sub, rid, sub_dir, rid):
                    restored.append(entry)
            _save_index(restored, idx_path)
            stats[f"{sub}_added"] = len(restored)
        else:  # merge
            current_index = _load_index(idx_path)
            have_strava = {e.get("strava_id") for e in current_index if e.get("strava_id")}
            have_keys = {_dup_key(e) for e in current_index}
            for entry in backup_index:
                old_id = _safe_id(str(entry.get("id", "")))
                if not old_id:
                    continue
                # Strava-edzésnél a Strava-azonosító dönt, egyébként név + dátum + távolság
                dup = entry["strava_id"] in have_strava if entry.get("strava_id") else _dup_key(entry) in have_keys
                if dup:
                    stats["skipped"] += 1
                    continue
                # Csak hex ID – a _safe_id az aláhúzást kiszűrné, és az elem megnyithatatlan lenne
                new_id = uuid.uuid4().hex[:8]
                if not _copy_route_files_from_zip(zf, sub, old_id, sub_dir, new_id):
                    continue
                new_entry = dict(entry)
                new_entry["id"] = new_id
                current_index.append(new_entry)
                have_keys.add(_dup_key(entry))
                if entry.get("strava_id"):
                    have_strava.add(entry["strava_id"])
                stats[f"{sub}_added"] += 1
            _save_index(current_index, idx_path)

    log.info("Restore (%s, %s): %s", user_id, mode, stats)
    return stats


def _dup_key(e: dict) -> tuple:
    d = e.get("distance")
    return (e.get("name"), e.get("date"), round(d, 1) if isinstance(d, (int, float)) else None)


def _copy_route_files_from_zip(zf, sub: str, old_id: str, dst_dir: str, new_id: str) -> bool:
    """Egy adott ID-jű GPX (+ opc. FIT) fájlt kimásol a ZIP-ből a cél mappába.
    Visszaad: True ha legalább a GPX kimásolódott."""
    copied = False
    for ext in (".gpx", ".fit"):
        try:
            data = zf.read(f"{sub}/{old_id}{ext}")
        except KeyError:
            continue
        with open(os.path.join(dst_dir, f"{new_id}{ext}"), "wb") as f:
            f.write(data)
        if ext == ".gpx":
            copied = True
    return copied


# ── User végpontok ────────────────────────────────────────────────────────────

@bp.route("/api/user/backup", methods=["GET"])
@require_auth
def user_backup():
    uid   = g.user["id"]
    email = g.user.get("email")
    buf   = _build_user_backup_zip(uid, email)
    fname = f"{email or uid}-{_now_date()}.zip"
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=fname)


@bp.route("/api/user/restore", methods=["POST"])
@require_auth
def user_restore():
    if "backup" not in request.files:
        abort(400, description="backup fájl kötelező")
    mode = request.form.get("mode", "merge")
    data = request.files["backup"].read()
    stats = _restore_user_from_zip(g.user["id"], data, mode)
    return jsonify({"ok": True, "mode": mode, **stats})


# ── Admin végpontok ───────────────────────────────────────────────────────────

@bp.route("/api/admin/users/<user_id>/backup", methods=["GET"])
@require_auth
@require_admin
def admin_user_backup(user_id: str):
    with _db() as conn:
        row = conn.execute("SELECT email FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        abort(404, description="Felhasználó nem található")
    buf = _build_user_backup_zip(user_id, row["email"])
    fname = f"{row['email']}-{_now_date()}.zip"
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=fname)


@bp.route("/api/admin/users/<user_id>/restore", methods=["POST"])
@require_auth
@require_admin
def admin_user_restore(user_id: str):
    with _db() as conn:
        row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        abort(404, description="Felhasználó nem található")
    if "backup" not in request.files:
        abort(400, description="backup fájl kötelező")
    mode = request.form.get("mode", "merge")
    data = request.files["backup"].read()
    stats = _restore_user_from_zip(user_id, data, mode)
    return jsonify({"ok": True, "mode": mode, **stats})
