"""Bringaterv API – per-user fájltárolás (mappák, settings.json, statisztika)."""

import json
import os

from flask import g

from config import _LEGACY_INDEX_FILE, _LEGACY_USER_DIR, MULTI_DATA_DIR, log


def _user_dir(user_id: str) -> str:
    return os.path.join(MULTI_DATA_DIR, user_id)


def _user_routes_dir(user_id: str) -> str:
    d = os.path.join(_user_dir(user_id), "routes")
    os.makedirs(d, exist_ok=True)
    return d


def _resolve_dirs():
    """Felhasználó-specifikus útvonal mappa."""
    d = _user_routes_dir(g.user["id"])
    return d, os.path.join(d, "index.json")


# ── Per-user settings.json ────────────────────────────────────────────────────

def _user_settings_path(user_id: str) -> str:
    """Útvonal: /data/users/<uid>/settings.json"""
    return os.path.join(_user_dir(user_id), "settings.json")


def _load_user_settings_file(user_id: str) -> dict:
    """Betölti a user settings.json fájlját. Hiányzó/hibás fájl esetén üres dict."""
    path = _user_settings_path(user_id)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("Settings olvasási hiba (%s): %s", path, exc)
        return {}


def _save_user_settings_file(user_id: str, settings: dict) -> None:
    """Atomikus write: tmp + rename. Létrehozza a user mappát is ha kell."""
    os.makedirs(_user_dir(user_id), exist_ok=True)
    path = _user_settings_path(user_id)
    tmp  = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(settings, f, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(tmp, path)


def _migrate_single_routes_to_user(user_id: str) -> None:
    """Régi single-módos útvonalakat átmásolja az admin user mappájába (egyszeri migráció)."""
    import shutil
    src_index = _LEGACY_INDEX_FILE
    src_dir   = _LEGACY_USER_DIR
    if not os.path.isfile(src_index):
        log.info("Migráció: nincs single-módos index, kihagyva.")
        return
    dst_dir   = _user_routes_dir(user_id)
    dst_index = os.path.join(dst_dir, "index.json")
    if os.path.isfile(dst_index):
        log.info("Migráció: admin user már rendelkezik index.json-nal, kihagyva.")
        return
    # index.json másolása
    shutil.copy2(src_index, dst_index)
    # GPX fájlok másolása
    migrated = 0
    if os.path.isdir(src_dir):
        for fn in os.listdir(src_dir):
            if fn.endswith(".gpx"):
                shutil.copy2(os.path.join(src_dir, fn), os.path.join(dst_dir, fn))
                migrated += 1
    log.info("Migráció kész: %d GPX + index.json → user %s", migrated, user_id)


def _user_storage_stats(user_id: str) -> dict:
    base = _user_dir(user_id)
    routes_dir   = os.path.join(base, "routes")
    workouts_dir = os.path.join(base, "workouts")
    routes = workouts = total_bytes = 0
    for folder, key in [(routes_dir, "routes"), (workouts_dir, "workouts")]:
        if os.path.isdir(folder):
            for fn in os.listdir(folder):
                fp = os.path.join(folder, fn)
                if os.path.isfile(fp):
                    total_bytes += os.path.getsize(fp)
                    if fn.endswith(".gpx"):
                        if key == "routes":
                            routes += 1
                        else:
                            workouts += 1
    return {
        "routes":        routes,
        "workouts":      workouts,
        "storage_mb":    round(total_bytes / 1_048_576, 2),
        "storage_bytes": total_bytes,
    }
