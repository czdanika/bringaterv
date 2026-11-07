"""Bringaterv API – OnelapFit (Magene) helperek: belépés, tokenek, edzés-import, útvonal-feltöltés.

Nem hivatalos API: az OnelapFit app (com.onelap.fitness 1.9.x) visszafejtéséből
ismert, a nemzetközi (onelap.com) fiókhoz. Ha az Onelap változtat, csak ez a
modul áll le – a többi integrációt nem érinti.

Belépés: e-mail + jelszó (a jelszót az app MD5-ben küldi). Siker esetén
token (30 nap) + refresh_token (60 nap). A refresh minden frissítéskor új
refresh_tokent ad, így a kapcsolat jelszótárolás nélkül életben marad.

Token tárolás: /data/users/<uid>/onelap.json (0600) – jelszót SOHA nem tárolunk.

Minden kérés aláírt: sign = md5(path + "?" + rendezett(nonce, timestamp,
nem-üres query) + "key=" + APIKEY). A body nem része az aláírásnak.
"""

import base64
import re
import fcntl
import hashlib
import json
import os
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from urllib.parse import urlencode, urlparse
from zoneinfo import ZoneInfo

import requests

from config import log
from storage import _user_dir, _user_routes_dir
from utils import _load_index, _now_dt, _save_index, find_cross_source_duplicate

from fit_gpx import FIT_AVAILABLE, _xml, equipment_fields, fit_to_gpx

_BASE        = "https://api-fitness.rfsvr.com"
_APIKEY      = "6b14dcd729a8234487734f50c6335995"   # az app BuildConfigjából (protokoll-kulcs)
_APP_VERSION = "1.9.1"
_USER_AGENT  = "wanlu/1.9.1 (iPhone; iOS 26.5.2; Scale/3.00)"
_TZ          = ZoneInfo("Europe/Budapest")

# Ennyi napon belüli lejáratnál frissítjük a tokent (30 napos token → kb. 10 naponta)
_REFRESH_BEFORE_S = 20 * 86400
# A nyers GPX feltöltés korlátja (az appé)
_MAX_GPX_BYTES = 20 * 1024 * 1024
# Csak innen töltünk le FIT-et (a lista presigned fileAddr-je)
_FIT_HOST_SUFFIX = ".onelap.com"


class OnelapAuthError(Exception):
    """Hibás jelszó, vagy a token / refresh token érvénytelenné vált."""


class OnelapApiError(Exception):
    """Az Onelap szerver hibát adott vagy nem érhető el."""


# ── Per-user token tárolás (/data/users/<uid>/onelap.json) ───────────────────

def _user_onelap_path(user_id: str) -> str:
    return os.path.join(_user_dir(user_id), "onelap.json")


def _load_user_onelap(user_id: str) -> dict:
    path = _user_onelap_path(user_id)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_user_onelap(user_id: str, data: dict) -> None:
    os.makedirs(_user_dir(user_id), exist_ok=True)
    path = _user_onelap_path(user_id)
    tmp  = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _delete_user_onelap(user_id: str) -> None:
    path = _user_onelap_path(user_id)
    if os.path.isfile(path):
        os.remove(path)


@contextmanager
def _token_lock(user_id: str):
    """A refresh_token frissítéskor cserélődik – két gunicorn worker ne frissítsen egyszerre."""
    os.makedirs(_user_dir(user_id), exist_ok=True)
    with open(_user_onelap_path(user_id) + ".lock", "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


def _token_exp(token: str) -> int:
    """A token első része base64-JSON ({iss, nbf, exp, region}) → exp (unix). 0 ha nem olvasható."""
    try:
        part = (token or "").split(".")[0]
        part += "=" * (-len(part) % 4)
        return int(json.loads(base64.b64decode(part)).get("exp") or 0)
    except (ValueError, TypeError):
        return 0


# ── Aláírt kérések ────────────────────────────────────────────────────────────

def _md5(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def _headers(path: str, query: dict | None, sess: dict, ctype: str | None) -> dict:
    ts = str(int(time.time()))
    nc = base64.b64encode(os.urandom(6)).decode()
    m = {"nonce": nc, "timestamp": ts}
    for k, v in (query or {}).items():
        if v not in (None, ""):
            m[k] = str(v)
    sign_str = path + "?" + "".join(f"{k}={m[k]}&" for k in sorted(m)) + "key=" + _APIKEY
    h = {
        "userid": str(sess.get("uid") or "0"), "language": "en", "app-language": "en",
        "user-agent": _USER_AGENT, "version": _APP_VERSION, "app-version": _APP_VERSION,
        "nonce": nc, "sign": _md5(sign_str), "timestamp": ts,
        "platform": "43", "app-name": "onelapfit",
        "deviceid": sess.get("device_id") or str(uuid.uuid4()),
        "timezone": "Europe/Budapest", "accept": "*/*",
        "onelap-region": str(sess.get("region") or "2"),
    }
    if sess.get("auth"):
        h["authorization"] = sess["auth"]
    if ctype:
        h["content-type"] = ctype
    return h


def _call(method: str, path: str, sess: dict, query: dict | None = None,
          body: dict | None = None, raw: bytes | None = None, ctype: str | None = None,
          timeout: int = 30):
    """Aláírt kérés. Visszaad: a válasz `data` mezője. Hibák: OnelapAuthError / OnelapApiError."""
    if raw is None and body is not None:
        raw, ctype = json.dumps(body).encode(), "application/json"
    url = _BASE + path + ("?" + urlencode(query) if query else "")
    try:
        resp = requests.request(method, url, data=raw, timeout=timeout,
                                headers=_headers(path, query, sess, ctype))
    except requests.RequestException as exc:
        raise OnelapApiError(f"Az OnelapFit szerver nem érhető el: {exc}") from exc
    try:
        j = resp.json()
    except ValueError:
        raise OnelapApiError(f"Váratlan válasz az OnelapFittől (HTTP {resp.status_code})")
    code = j.get("code")
    if code == 403 or resp.status_code in (401, 403):
        raise OnelapAuthError(j.get("error") or "Authorization fail")
    if code != 200:
        raise OnelapApiError(j.get("error") or j.get("msg") or f"OnelapFit hiba (code {code})")
    return j.get("data")


# ── Belépés, token-frissítés ──────────────────────────────────────────────────

def onelap_login(user_id: str, account: str, password: str) -> dict:
    """Belépés e-mail + jelszóval. Siker → tokenek mentve. Hibás jelszó → OnelapAuthError."""
    device_id = str(uuid.uuid4())
    d = _call("POST", "/api/v1/app/login", {"device_id": device_id},
              body={"account": account, "password": _md5(password)})
    uid = str((d.get("userinfo") or {}).get("uid") or "")
    if not d.get("token") or not uid:
        raise OnelapApiError("Az OnelapFit belépés nem adott tokent.")
    data = {
        "account":       account,
        "uid":           uid,
        "region":        str(d.get("region") or 2),
        "token":         d["token"],
        "refresh_token": d.get("refresh_token") or "",
        "device_id":     device_id,
        "connected_at":  _now_dt(),
    }
    _save_user_onelap(user_id, data)
    log.info("Onelap csatlakoztatva (user=%s, uid=%s, region=%s)", user_id, uid, data["region"])
    return data


def _refresh(user_id: str, data: dict) -> dict:
    """Új token a refresh_tokennel (Authorization: refresh_token, üres body)."""
    sess = {**data, "auth": data.get("refresh_token")}
    d = _call("POST", "/api/v1/app/refresh_token", sess, raw=b"", ctype="application/json")
    if not (d or {}).get("token"):
        raise OnelapAuthError("A token-frissítés nem adott új tokent.")
    data["token"] = d["token"]
    if d.get("refresh_token"):
        data["refresh_token"] = d["refresh_token"]
    data["refreshed_at"] = _now_dt()
    _save_user_onelap(user_id, data)
    log.info("Onelap token frissítve (user=%s)", user_id)
    return data


def onelap_session(user_id: str) -> dict | None:
    """Hívásra kész munkamenet ({uid, region, auth, device_id}). None ha nincs kapcsolat.
    Lejárat közelében frissít; ha a frissítés is érvénytelen → OnelapAuthError."""
    data = _load_user_onelap(user_id)
    if not data.get("token"):
        return None
    if _token_exp(data["token"]) - time.time() < _REFRESH_BEFORE_S:
        with _token_lock(user_id):
            data = _load_user_onelap(user_id)   # a másik worker közben frissíthetett
            if data.get("token") and _token_exp(data["token"]) - time.time() < _REFRESH_BEFORE_S:
                if _token_exp(data.get("refresh_token")) <= time.time():
                    raise OnelapAuthError("Lejárt az OnelapFit munkamenet.")
                data = _refresh(user_id, data)
    return {"uid": data["uid"], "region": data.get("region") or "2",
            "auth": data["token"], "device_id": data.get("device_id")}


def onelap_status(user_id: str) -> dict:
    data = _load_user_onelap(user_id)
    return {
        "available":     FIT_AVAILABLE,
        "connected":     bool(data.get("token")),
        "account":       data.get("account"),
        "connected_at":  data.get("connected_at"),
        "token_expires": _token_exp(data.get("token")) or None,
    }


# ══════════════════════════════════════════════════════════════════════════════
# EDZÉS-IMPORT
# ══════════════════════════════════════════════════════════════════════════════

# ── Deny-list (törölt edzések – ne ajánljuk újra importra) ───────────────────

def _user_onelap_deny_path(user_id: str) -> str:
    return os.path.join(_user_dir(user_id), "onelap_deleted.json")


def _load_onelap_deny(user_id: str) -> dict:
    path = _user_onelap_deny_path(user_id)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return (json.load(f) or {}).get("deleted_at") or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_onelap_deny(user_id: str, deny: dict) -> None:
    os.makedirs(_user_dir(user_id), exist_ok=True)
    path = _user_onelap_deny_path(user_id)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"deleted_at": deny}, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)


def _add_onelap_deny(user_id: str, ride_id: str) -> None:
    deny = _load_onelap_deny(user_id)
    deny[str(ride_id)] = _now_dt()
    _save_onelap_deny(user_id, deny)


def _remove_onelap_deny(user_id: str, ride_id: str) -> bool:
    deny = _load_onelap_deny(user_id)
    removed = deny.pop(str(ride_id), None) is not None
    if removed:
        _save_onelap_deny(user_id, deny)
    return removed


def _list_rides(sess: dict, start_ts: int, end_ts: int) -> list:
    """Nyers edzéslista [start_ts, end_ts] között (az összes oldal)."""
    rides, page, pages = [], 1, 1
    while page <= pages and page <= 50:
        q = {"data_type": "all", "source": "all", "start_time": str(start_ts),
             "end_time": str(end_ts), "p": str(page)}
        d = _call("GET", "/api/v1/app/record/riding/list", sess, query=q) or {}
        pages = int(d.get("page_count") or 1)
        days = d.get("days")
        if isinstance(days, dict):
            for day in days.values():
                rides.extend(day.get("info") or [])
        page += 1
    return rides


def _default_name(start_ts: int, sport: str = "cycling") -> str:
    """Az Onelap minden edzést „Ride”-nak hív – helyette Strava-szerű napszakos név."""
    h = datetime.fromtimestamp(start_ts, _TZ).hour if start_ts else 12
    part = ("Éjszakai" if h < 5 else "Reggeli" if h < 11 else "Déli" if h < 14
            else "Délutáni" if h < 18 else "Esti" if h < 22 else "Éjszakai")
    noun = {"running": "futás", "walking": "séta", "hiking": "túra"}.get(sport, "kerékpározás")
    return f"{part} {noun}"


def _ride_name(ride: dict, sport: str = "cycling") -> str:
    name = (ride.get("name") or "").strip()
    if name and name.lower() != "ride":
        return name
    return _default_name(int(ride.get("start_time") or 0), sport)


def onelap_list_activities(sess: dict, user_id: str, days: int = 30, limit: int = 30) -> list:
    """Edzések normalizált listája dedup-státusszal (legújabb elöl)."""
    now = int(time.time())
    rides = _list_rides(sess, now - days * 86400, now + 86400)
    rides = [r for r in rides if r.get("did") and (r.get("distance") or 0) > 0]
    rides.sort(key=lambda r: int(r.get("start_time") or 0), reverse=True)
    rides = rides[:limit]

    idx = _load_index(os.path.join(_user_routes_dir(user_id), "index.json"))
    by_onelap = {r.get("onelap_id"): r for r in idx if r.get("onelap_id")}
    deny = _load_onelap_deny(user_id)

    out = []
    for r in rides:
        did      = str(r["did"])
        start_ts = int(r.get("start_time") or 0)
        dist_m   = float(r.get("distance") or 0)
        local    = by_onelap.get(did)
        deleted  = did in deny
        cross    = None if (local or deleted) else find_cross_source_duplicate(idx, start_ts, dist_m, "onelap_id")
        out.append({
            "id":             did,
            "name":           _ride_name(r),
            "start_ts":       start_ts,
            "start_date":     datetime.fromtimestamp(start_ts, timezone.utc).isoformat() if start_ts else None,
            "distance_m":     dist_m or None,
            "moving_time_s":  r.get("time"),
            "elapsed_time_s": r.get("total_time"),
            "total_elevation_gain": r.get("elevation"),
            "calories":       r.get("cal"),
            "duplicate_status":
                "already_imported" if local else
                ("previously_deleted" if deleted else
                 ("likely_duplicate" if cross else "new")),
            "duplicate_local_id": local["id"] if local else (cross["id"] if cross else None),
        })
    return out


def onelap_import_activity(sess: dict, user_id: str, ride_id: str, start_ts: int,
                           dedup: bool = False) -> dict:
    """Egy Onelap-edzés FIT-jét letölti, GPX-et készít belőle, és menti a könyvtárba
    (type=workout, az eredeti FIT is megmarad)."""
    routes_dir = _user_routes_dir(user_id)
    idx_path   = os.path.join(routes_dir, "index.json")
    idx        = _load_index(idx_path)
    if any(r.get("onelap_id") == ride_id for r in idx):
        return {"ok": True, "skipped": True, "reason": "already_imported"}

    # A FIT presigned URL-je lejár → az edzés napjának friss listájából keressük ki
    rides = _list_rides(sess, start_ts - 86400, start_ts + 86400) if start_ts else []
    ride = next((r for r in rides if str(r.get("did")) == ride_id), None)
    if ride is None:
        return {"ok": False, "error": "Az edzés nem található az OnelapFitben (törölték?)."}
    # Ismétlődés-védelem: ugyanez az edzés más forrásból (pl. Strava) már megvan
    if dedup:
        dup = find_cross_source_duplicate(idx, int(ride.get("start_time") or 0),
                                          float(ride.get("distance") or 0), "onelap_id")
        if dup:
            return {"ok": True, "skipped": True, "reason": "duplicate",
                    "duplicate_local_id": dup["id"], "duplicate_name": dup.get("name")}
    addr = ride.get("fileAddr") or ""
    host = urlparse(addr).hostname or ""
    if urlparse(addr).scheme != "https" or not host.endswith(_FIT_HOST_SUFFIX):
        return {"ok": False, "error": "Ehhez az edzéshez nincs letölthető FIT."}
    try:
        resp = requests.get(addr, headers={"User-Agent": _USER_AGENT}, timeout=60)
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise OnelapApiError(f"A FIT letöltése sikertelen: {exc}") from exc
    fit_bytes = resp.content
    if fit_bytes[8:12] != b".FIT":
        return {"ok": False, "error": "Az OnelapFit nem FIT fájlt adott vissza."}

    gpx_text, s = fit_to_gpx(fit_bytes, "Onelap")
    sport = s.get("sport") or "cycling"
    name  = _ride_name(ride, sport)
    if not gpx_text:
        return {"ok": False, "error": "Nincs GPS adat ebben az edzésben (beltéri / görgős?)."}
    gpx_text = gpx_text.replace("<name>Onelap</name>", f"<name>{_xml(name)}</name>", 1)

    new_id = uuid.uuid4().hex[:8]
    with open(os.path.join(routes_dir, f"{new_id}.gpx"), "w", encoding="utf-8") as f:
        f.write(gpx_text)
    with open(os.path.join(routes_dir, f"{new_id}.fit"), "wb") as f:
        f.write(fit_bytes)

    start_dt = s.get("start_time") if isinstance(s.get("start_time"), datetime) \
        else datetime.fromtimestamp(int(ride.get("start_time") or time.time()), timezone.utc)
    dist_m = s.get("distance_m") or ride.get("distance") or 0
    mov_s  = s.get("moving_s") or ride.get("time") or 0
    ele_m  = s.get("ascent_m") if s.get("ascent_m") is not None else ride.get("elevation")
    avg_sp, max_sp = s.get("avg_speed"), s.get("max_speed")
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
        "onelap_id":    ride_id,
        "source":       "onelap",
        "has_fit":      True,
        "imported_at":  _now_dt(),
        "include_in_stats": True,
        "description":  "",
        "calories":      s.get("calories") or ride.get("cal"),
        "avg_heartrate": s.get("avg_hr"),
        "max_heartrate": s.get("max_hr"),
        "avg_watts":     s.get("avg_power"),
        "max_watts":     s.get("max_power"),
        "avg_cadence":   s.get("avg_cadence"),
        "avg_speed_kmh": round(avg_sp * 3.6, 2) if avg_sp else None,
        "max_speed_kmh": round(max_sp * 3.6, 2) if max_sp else None,
        **equipment_fields(s.get("equipment")),
    }
    idx = _load_index(idx_path)   # a letöltés alatt változhatott
    idx.append(entry)
    _save_index(idx, idx_path)
    return {"ok": True, "skipped": False, "entry": entry}


# ══════════════════════════════════════════════════════════════════════════════
# ÚTVONAL-FELTÖLTÉS (tervezett útvonal → OnelapFit útvonalkönyv → Magene)
# ══════════════════════════════════════════════════════════════════════════════

def _prepare_route_gpx(gpx_text: str, name: str) -> str:
    """Feltöltés előtti tisztítás:
    – az útpontok (<wpt>: a tervezés fordulópontjai utcanevekkel) kikerülnek – az OnelapFit
      ezeket külön pontokként rakja az útvonalra (élesben 101 db egy 204 km-es körön);
      a komputer a nyomvonalon navigál;
    – minden <name> (metaadat, nyomvonal) a könyvtári név legyen – az OnelapFit innen veszi."""
    gpx_text = re.sub(r"<wpt\b.*?</wpt>\s*", "", gpx_text, flags=re.DOTALL)
    tag = f"<name>{_xml(name)}</name>"
    if re.search(r"<name>.*?</name>", gpx_text, re.DOTALL):
        return re.sub(r"<name>.*?</name>", lambda _m: tag, gpx_text, flags=re.DOTALL)
    return re.sub(r"(<(?:trk|rte)>)", lambda m: m.group(1) + tag, gpx_text, count=1)


def onelap_upload_route(sess: dict, name: str, gpx_text: str) -> dict:
    """Nyers GPX feltöltése a roadbook végpontra (nem multipart, application/xml).
    Visszaad: {ok, nid, name, points}."""
    raw = _prepare_route_gpx(gpx_text, (name or "Bringaterv útvonal")[:60]).encode("utf-8")
    if len(raw) > _MAX_GPX_BYTES:
        return {"ok": False, "error": "Az útvonal GPX-e nagyobb 20 MB-nál."}
    if b"<trkpt" not in raw and b"<rtept" not in raw:
        return {"ok": False, "error": "Az útvonalban nincsenek pontok."}
    d = _call("POST", "/api/v1/app/roadbook/gpx/save", sess, raw=raw,
              ctype="application/xml;charset=UTF-8", timeout=60) or {}
    return {"ok": True, "nid": d.get("nid"), "name": name}
