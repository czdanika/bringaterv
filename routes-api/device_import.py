"""Bringaterv API – közös rész a hivatalos OAuth-os eszköz-integrációkhoz (Wahoo, Polar).

  • Fejlesztői app-kulcsok (client id / secret) felhasználónként: a Beállításokban
    (/data/users/<uid>/<provider>_app.json, 0600); tartalék: env (WAHOO_CLIENT_ID …).
  • OAuth: state-tár (fájl-alapú, worker-független), callback URL, popup-záró HTML.
  • Per-user tokenek: /data/users/<uid>/<provider>.json (0600) – jelszót nem látunk.
  • Törölt-lista: /data/users/<uid>/<provider>_deleted.json (a törölt edzést ne hozza vissza).
  • Edzés mentése FIT-ből (fit_gpx) a könyvtárba, ismétlődés-védelemmel.

A gyártó-specifikus rész: wahoo_service.py, polar_service.py.
"""

import json
import os
import secrets
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from flask import request

from config import log
from fit_gpx import _xml, equipment_fields, fit_to_gpx
from storage import _user_dir, _user_routes_dir
from utils import _load_index, _now_dt, _save_index, find_cross_source_duplicate

_TZ = ZoneInfo("Europe/Budapest")
_DATA_ROOT = os.path.dirname(os.environ.get("MULTI_DATA_DIR", "/data/users").rstrip("/")) or "/data"
_STATES_DIR = os.path.join(_DATA_ROOT, "device_oauth_states")
_STATE_TTL = 10 * 60

PROVIDERS = ("wahoo", "polar")
LABELS = {"wahoo": "Wahoo", "polar": "Polar"}


class DeviceAuthError(Exception):
    """A token érvénytelen / visszavonták – újra kell csatlakozni."""


class DeviceApiError(Exception):
    """A gyártó szervere hibát adott vagy nem érhető el."""


# ── Fejlesztői app-kulcsok (felhasználónként) ────────────────────────────────
# Mindenki a saját Wahoo / Polar fejlesztői alkalmazásának kulcsait adja meg a
# Beállításokban (mint a Stravánál) – így senkinek nem kell a gyártó éles
# jóváhagyására várnia, és senki nem fogyasztja a másik keretét.
# Szerverszintű tartalék: env WAHOO_CLIENT_ID / WAHOO_CLIENT_SECRET (POLAR_…).

def _app_path(user_id: str, provider: str) -> str:
    return os.path.join(_user_dir(user_id), f"{provider}_app.json")


def load_app(provider: str, user_id: str | None = None) -> dict:
    """{client_id, client_secret, source: user|env|none} – a felhasználó saját kulcsa az erősebb."""
    if user_id:
        try:
            with open(_app_path(user_id, provider), encoding="utf-8") as f:
                a = json.load(f) or {}
            if a.get("client_id") and a.get("client_secret"):
                return {"client_id": a["client_id"], "client_secret": a["client_secret"], "source": "user"}
        except (OSError, json.JSONDecodeError):
            pass
    cid = os.environ.get(f"{provider.upper()}_CLIENT_ID", "").strip()
    sec = os.environ.get(f"{provider.upper()}_CLIENT_SECRET", "").strip()
    if cid and sec:
        return {"client_id": cid, "client_secret": sec, "source": "env"}
    return {"client_id": "", "client_secret": "", "source": "none"}


def save_app(user_id: str, provider: str, client_id: str, client_secret: str | None) -> None:
    """Üres secret = a régi marad (a felület nem küldi vissza a mentettet)."""
    cur = load_app(provider, user_id)
    secret = client_secret or (cur["client_secret"] if cur["source"] == "user" else "")
    os.makedirs(_user_dir(user_id), exist_ok=True)
    path = _app_path(user_id, provider)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"client_id": client_id, "client_secret": secret}, f, ensure_ascii=False, indent=2)
    os.chmod(path + ".tmp", 0o600)
    os.replace(path + ".tmp", path)


def delete_app(user_id: str, provider: str) -> None:
    try:
        os.remove(_app_path(user_id, provider))
    except OSError:
        pass


def redirect_uri(provider: str) -> str:
    """A callback URL – ezt kell a gyártó fejlesztői portálján is megadni.
    Env (WAHOO_REDIRECT_URI …) felülírja, különben a böngésző címéből (Origin / Referer):
    az nginx a portot, a Cloudflare a https-t nem adja tovább, a böngésző viszont pontosan tudja."""
    env = os.environ.get(f"{provider.upper()}_REDIRECT_URI", "").strip()
    if env:
        return env
    origin = request.headers.get("Origin") or ""
    if not origin.startswith(("http://", "https://")):
        ref = urlparse(request.headers.get("Referer") or "")
        origin = f"{ref.scheme}://{ref.netloc}" if ref.scheme and ref.netloc else ""
    if not origin:
        proto = request.headers.get("X-Forwarded-Proto", request.scheme)
        host = request.headers.get("X-Forwarded-Host", request.host)
        origin = f"{proto}://{host}"
    return f"{origin.rstrip('/')}/api/{provider}/callback"


# ── OAuth state (fájl-alapú, 10 perc) ─────────────────────────────────────────

def new_state(user_id: str, provider: str, redirect: str) -> str:
    """A belépés indításakor: a redirect is a state mellé kerül – a tokencserénél
    pontosan ugyanazt kell küldeni (a callback-kérésnek nincs Origin fejléce)."""
    state = secrets.token_urlsafe(24)
    os.makedirs(_STATES_DIR, exist_ok=True)
    path = os.path.join(_STATES_DIR, f"{state}.json")
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"user_id": user_id, "provider": provider, "redirect": redirect,
                   "expiry_ts": time.time() + _STATE_TTL}, f)
    os.chmod(path + ".tmp", 0o600)
    os.replace(path + ".tmp", path)
    _cleanup_states()
    return state


def consume_state(state: str, provider: str) -> dict | None:
    """{user_id, redirect} vagy None (lejárt / ismeretlen / más gyártóé)."""
    if not state or not state.replace("-", "").replace("_", "").isalnum():
        return None
    path = os.path.join(_STATES_DIR, f"{state}.json")
    try:
        with open(path, encoding="utf-8") as f:
            rec = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    finally:
        try: os.remove(path)
        except OSError: pass
    if rec.get("provider") != provider or time.time() > rec.get("expiry_ts", 0):
        return None
    return {"user_id": rec.get("user_id"), "redirect": rec.get("redirect")}


def _cleanup_states() -> None:
    now = time.time()
    try:
        for name in os.listdir(_STATES_DIR):
            p = os.path.join(_STATES_DIR, name)
            if now - os.path.getmtime(p) > _STATE_TTL:
                os.remove(p)
    except OSError:
        pass


def close_window_html(provider: str, success: bool = False, name: str = "", error: str = ""):
    """A popup végső oldala: értesíti a Bringaterv ablakot (postMessage) és bezáródik."""
    label = LABELS.get(provider, provider)
    payload = {"type": "device-oauth", "provider": provider, "success": success, "name": name, "error": error}
    msg = f"{label}: sikeres kapcsolódás!" if success else f"{label}: {error}"
    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_xml(label)} kapcsolódás</title>
<style>
body {{ font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;color:#222 }}
.box {{ background:#fff;padding:24px 32px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.1);text-align:center;max-width:400px }}
.ok {{ color:#16a34a }} .err {{ color:#dc2626 }}
button {{ margin-top:14px;padding:8px 20px;font-size:14px;background:#222;color:#fff;border:none;border-radius:6px;cursor:pointer }}
</style></head><body>
<div class="box">
  <h2 class="{'ok' if success else 'err'}">{_xml(msg)}</h2>
  <p>Visszatérhetsz a Bringatervhez – ez az ablak bezárható.</p>
  <button onclick="window.close()">Ablak bezárása</button>
</div>
<script>
try {{ if (window.opener && !window.opener.closed) window.opener.postMessage({json.dumps(payload)}, location.origin); }} catch (e) {{}}
setTimeout(() => {{ try {{ window.close(); }} catch (e) {{}} }}, {1500 if success else 6000});
</script>
</body></html>"""
    return html, 200, {"Content-Type": "text/html; charset=utf-8"}


# ── Per-user tokenek ──────────────────────────────────────────────────────────

def _tok_path(user_id: str, provider: str) -> str:
    return os.path.join(_user_dir(user_id), f"{provider}.json")


def load_tokens(user_id: str, provider: str) -> dict:
    try:
        with open(_tok_path(user_id, provider), encoding="utf-8") as f:
            return json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_tokens(user_id: str, provider: str, data: dict) -> None:
    os.makedirs(_user_dir(user_id), exist_ok=True)
    path = _tok_path(user_id, provider)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(path + ".tmp", 0o600)
    os.replace(path + ".tmp", path)


def delete_tokens(user_id: str, provider: str) -> None:
    try:
        os.remove(_tok_path(user_id, provider))
    except OSError:
        pass


# ── Törölt-lista (a könyvtárból törölt edzés ne jöjjön vissza) ───────────────

def _deny_path(user_id: str, provider: str) -> str:
    return os.path.join(_user_dir(user_id), f"{provider}_deleted.json")


def load_deny(user_id: str, provider: str) -> dict:
    try:
        with open(_deny_path(user_id, provider), encoding="utf-8") as f:
            return (json.load(f) or {}).get("deleted_at") or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_deny(user_id: str, provider: str, deny: dict) -> None:
    os.makedirs(_user_dir(user_id), exist_ok=True)
    path = _deny_path(user_id, provider)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"deleted_at": deny}, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)


def add_deny(user_id: str, provider: str, item_id) -> None:
    deny = load_deny(user_id, provider)
    deny[str(item_id)] = _now_dt()
    _save_deny(user_id, provider, deny)


def remove_deny(user_id: str, provider: str, item_id) -> bool:
    deny = load_deny(user_id, provider)
    removed = deny.pop(str(item_id), None) is not None
    if removed:
        _save_deny(user_id, provider, deny)
    return removed


# ── Lista: dedup-státusz ──────────────────────────────────────────────────────

def mark_duplicates(user_id: str, provider: str, items: list) -> list:
    """items: [{id, start_ts, distance_m, …}] → kiegészíti duplicate_status /
    duplicate_local_id mezőkkel (mint a Strava / Garmin / Onelap listánál)."""
    key = f"{provider}_id"
    idx = _load_index(os.path.join(_user_routes_dir(user_id), "index.json"))
    have = {str(r.get(key)): r for r in idx if r.get(key)}
    deny = load_deny(user_id, provider)
    for it in items:
        sid = str(it["id"])
        local = have.get(sid)
        deleted = sid in deny
        cross = None if (local or deleted) else find_cross_source_duplicate(
            idx, it.get("start_ts"), it.get("distance_m"), key)
        it["duplicate_status"] = ("already_imported" if local else "previously_deleted" if deleted
                                  else "likely_duplicate" if cross else "new")
        it["duplicate_local_id"] = local["id"] if local else (cross["id"] if cross else None)
    return items


# ── Edzés mentése a könyvtárba ────────────────────────────────────────────────

def default_name(start_ts: int, sport: str = "cycling") -> str:
    """Strava-szerű napszakos név, ha a gyártó nem ad értelmes nevet."""
    h = datetime.fromtimestamp(start_ts, _TZ).hour if start_ts else 12
    part = ("Éjszakai" if h < 5 else "Reggeli" if h < 11 else "Déli" if h < 14
            else "Délutáni" if h < 18 else "Esti" if h < 22 else "Éjszakai")
    noun = {"running": "futás", "walking": "séta", "hiking": "túra"}.get(sport, "kerékpározás")
    return f"{part} {noun}"


def save_workout(user_id: str, provider: str, item_id, *, fit_bytes: bytes | None = None,
                 gpx_text: str | None = None, name: str | None = None, start_ts: int = 0,
                 distance_m: float | None = None, dedup: bool = False, extra: dict | None = None) -> dict:
    """FIT (vagy tartalékként GPX) → könyvtári edzés. Visszaad: {ok, skipped, reason, entry}.
    A név üresen napszakos név lesz; a mérőszámok a FIT session-ből, ennek híján `extra`-ból."""
    key = f"{provider}_id"
    routes_dir = _user_routes_dir(user_id)
    idx_path = os.path.join(routes_dir, "index.json")
    idx = _load_index(idx_path)
    if any(str(r.get(key)) == str(item_id) for r in idx):
        return {"ok": True, "skipped": True, "reason": "already_imported"}
    if dedup:
        dup = find_cross_source_duplicate(idx, start_ts, distance_m, key)
        if dup:
            return {"ok": True, "skipped": True, "reason": "duplicate",
                    "duplicate_local_id": dup["id"], "duplicate_name": dup.get("name")}

    s = {}
    if fit_bytes:
        try:
            gpx_from_fit, s = fit_to_gpx(fit_bytes, "__NAME__")
        except Exception as exc:
            log.warning("%s FIT feldolgozási hiba (%s): %s", provider, item_id, exc)
            gpx_from_fit = ""
        if gpx_from_fit:
            gpx_text = gpx_from_fit
        else:
            fit_bytes = None
    if not gpx_text or ("<trkpt" not in gpx_text and "<rtept" not in gpx_text):
        return {"ok": False, "error": "Nincs GPS adat ebben az edzésben (beltéri / görgős?)."}

    sport = s.get("sport") or (extra or {}).get("sport") or "cycling"
    if isinstance(s.get("start_time"), datetime):
        start_dt = s["start_time"]
    else:
        start_dt = datetime.fromtimestamp(start_ts or time.time(), timezone.utc)
    name = (name or "").strip() or default_name(int(start_dt.timestamp()), sport)
    gpx_text = gpx_text.replace("<name>__NAME__</name>", f"<name>{_xml(name)}</name>", 1)

    ex = extra or {}
    dist_m = s.get("distance_m") or distance_m or 0
    mov_s = s.get("moving_s") or ex.get("moving_s") or 0
    ele_m = s.get("ascent_m") if s.get("ascent_m") is not None else ex.get("ascent_m")
    avg_sp = s.get("avg_speed") or ex.get("avg_speed")
    max_sp = s.get("max_speed") or ex.get("max_speed")

    new_id = uuid.uuid4().hex[:8]
    with open(os.path.join(routes_dir, f"{new_id}.gpx"), "w", encoding="utf-8") as f:
        f.write(gpx_text)
    if fit_bytes:
        with open(os.path.join(routes_dir, f"{new_id}.fit"), "wb") as f:
            f.write(fit_bytes)
    entry = {
        "id":           new_id,
        "name":         name,
        "type":         "workout",
        "sport_type":   sport,
        "distance":     round(dist_m / 1000, 2),
        "duration":     round(mov_s / 60) if mov_s else None,
        "elevation":    round(ele_m) if ele_m else 0,
        "date":         start_dt.astimezone(_TZ).strftime("%Y-%m-%d"),
        "start_time":   start_dt.astimezone(timezone.utc).isoformat(),
        key:            item_id,
        "source":       provider,
        "has_fit":      bool(fit_bytes),
        "imported_at":  _now_dt(),
        "include_in_stats": True,
        "description":  "",
        "calories":      s.get("calories") or ex.get("calories"),
        "avg_heartrate": s.get("avg_hr") or ex.get("avg_hr"),
        "max_heartrate": s.get("max_hr") or ex.get("max_hr"),
        "avg_watts":     s.get("avg_power") or ex.get("avg_power"),
        "max_watts":     s.get("max_power"),
        "avg_cadence":   s.get("avg_cadence"),
        "avg_speed_kmh": round(avg_sp * 3.6, 2) if avg_sp else None,
        "max_speed_kmh": round(max_sp * 3.6, 2) if max_sp else None,
        **equipment_fields(s.get("equipment")),
    }
    idx = _load_index(idx_path)          # a letöltés alatt változhatott
    idx.append(entry)
    _save_index(idx, idx_path)
    return {"ok": True, "skipped": False, "entry": entry}
