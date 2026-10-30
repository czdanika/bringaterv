"""Bringaterv – adminból állítható oldalszintű beállítások (/data/site_settings.json).

  registration_open   nyílt regisztráció (a meghívós regisztráció ettől függetlenül működik)
"""

import json
import os

from config import SITE_SETTINGS, log

DEFAULTS = {"registration_open": False}


def load() -> dict:
    data = dict(DEFAULTS)
    if os.path.isfile(SITE_SETTINGS):
        try:
            with open(SITE_SETTINGS, encoding="utf-8") as f:
                stored = json.load(f)
            if isinstance(stored, dict):
                data.update({k: stored[k] for k in DEFAULTS if k in stored})
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("Site settings olvasási hiba: %s", exc)
    return data


def save(updates: dict) -> dict:
    data = load()
    data.update({k: updates[k] for k in DEFAULTS if k in updates})
    os.makedirs(os.path.dirname(SITE_SETTINGS), exist_ok=True)
    tmp = SITE_SETTINGS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, SITE_SETTINGS)
    return data
