"""Bringaterv API – közös segédfüggvények (ID, index fájl, dátum)."""

import json
import os
import re
from datetime import datetime, timezone

from config import log


def _safe_id(raw: str) -> str:
    """Path traversal védelem – csak alfanumerikus és kötőjel."""
    return re.sub(r"[^a-zA-Z0-9\-]", "", raw)


def _clean_surface(raw):
    """Tárolt burkolat-vizsgálat (útvonal / minta) ellenőrzése: csak az ismert mezők, korlátozott méret."""
    if not isinstance(raw, dict) or not isinstance(raw.get("segments"), list):
        return None
    def f(v):
        try:
            return round(float(v), 6)
        except (TypeError, ValueError):
            return None
    segs = []
    for s in raw["segments"][:200]:
        if not isinstance(s, dict) or s.get("mode") not in ("asphalt", "gravel", "mtb", "hiking"):
            continue
        segs.append({"mode": s["mode"], "fromKm": f(s.get("fromKm")), "toKm": f(s.get("toKm")),
                     "distanceKm": f(s.get("distanceKm")), "lat": f(s.get("lat")), "lng": f(s.get("lng"))})
    if not segs:
        return None
    return {"segments": segs, "totalDistKm": f(raw.get("totalDistKm")),
            "analyzed_at": str(raw.get("analyzed_at") or "")[:40]}


def _load_index(path: str) -> list:
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        log.error("Index olvasási hiba (%s): %s", path, exc)
        return []


def _save_index(index: list, path: str) -> None:
    tmp  = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError as exc:
        log.error("Index írási hiba (%s): %s", path, exc)
        raise


def _now_date() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _now_dt() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
