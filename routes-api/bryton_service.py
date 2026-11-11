"""Bringaterv API – Bryton Active helperek: belépés, edzés-import (FIT), útvonal-feltöltés.

Nem hivatalos API: a Bryton Active (active.brytonsport.com, Meteor 2) webes / mobil hívásai.
  – belépés és edzéslista: Meteor DDP websocket (m1–m3.brytonactive.com), a jelszó SHA-256-ja megy;
    a munkamenet-token kb. 90 napig érvényes (tokenExpires) – a jelszót SOHA nem tároljuk;
  – FIT letöltés: GET https://<ddp-host>/api/activity?id=… (X-User-Id / X-Auth-Token / x-api-key);
  – útvonal: POST https://active.brytonsport.com/route/upload/<userId> – NEM GPX, hanem a Bryton saját
    „BrytonDirections” FIT-je (saját üzenetszámok 248–254: áttekintő, kanyarok, pontok), lásd encode_route.
Élőben kipróbálva 2026-11-09 (belépés, lista, útvonal → megjelent a telefonos appban).
Token tárolás: /data/users/<uid>/bryton.json (0600).
"""

import hashlib
import json
import math
import os
import re
import struct
import time
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import requests

from config import log
from storage import _user_dir, _user_routes_dir
from utils import _load_index, _now_dt, append_index, find_cross_source_duplicate

from fit_gpx import FIT_AVAILABLE, _xml, equipment_fields, fit_to_gpx

_DDP_HOSTS = ("m3.brytonactive.com", "m2.brytonactive.com", "m1.brytonactive.com")
_WEB = "https://active.brytonsport.com"
_API_KEY = "UHIJdntFZFkZaVJsInRHfRcYES08Fwp0Bwkf"     # a Bryton Active Android app protokoll-kulcsa (FIT-letöltés)
_TZ = ZoneInfo("Europe/Budapest")


class BrytonAuthError(Exception):
    """Hibás jelszó, vagy a munkamenet lejárt / érvénytelen."""


class BrytonApiError(Exception):
    """A Bryton szerver hibát adott vagy nem érhető el."""


# ── Minimális Meteor DDP kliens ───────────────────────────────────────────────

class _DDP:
    def __init__(self, timeout: int = 30):
        import websocket                      # csak itt kell – az app nélküle is elindul
        last = None
        for host in _DDP_HOSTS:
            try:
                self.ws = websocket.create_connection(f"wss://{host}/websocket", timeout=timeout)
                self.host = host
                break
            except Exception as exc:          # a következő szerver
                last = exc
        else:
            raise BrytonApiError(f"A Bryton szerver nem érhető el: {last}")
        self.n, self.coll = 0, {}
        self._send({"msg": "connect", "version": "1", "support": ["1"]})
        self._pump(lambda m: True if m.get("msg") == "connected" else
                   (_raise(BrytonApiError("A Bryton szerver elutasította a kapcsolatot.")) if m.get("msg") == "failed" else None))

    def _send(self, obj):
        self.ws.send(json.dumps(obj))

    def _pump(self, until):
        try:
            while True:
                m = json.loads(self.ws.recv())
                t = m.get("msg")
                if t == "ping":
                    self._send({"msg": "pong", **({"id": m["id"]} if "id" in m else {})})
                    continue
                if t == "added":
                    self.coll.setdefault(m["collection"], {})[m["id"]] = m.get("fields") or {}
                elif t == "changed":
                    self.coll.setdefault(m["collection"], {}).setdefault(m["id"], {}).update(m.get("fields") or {})
                r = until(m)
                if r is not None:
                    return r
        except (BrytonApiError, BrytonAuthError):
            raise
        except Exception as exc:
            raise BrytonApiError(f"Bryton kapcsolati hiba: {exc}") from exc

    def call(self, method, params):
        self.n += 1
        mid = str(self.n)
        self._send({"msg": "method", "method": method, "params": params, "id": mid})
        res = self._pump(lambda m: m if m.get("msg") == "result" and m.get("id") == mid else None)
        if "error" in res:
            err = res["error"] or {}
            if method == "login" or err.get("error") in (403, "403", "too-many-requests"):
                raise BrytonAuthError(err.get("reason") or err.get("message") or "Hibás belépés.")
            raise BrytonApiError(err.get("reason") or err.get("message") or str(err))
        return res.get("result")

    def sub(self, name, params=()):
        self.n += 1
        sid = str(self.n)
        self._send({"msg": "sub", "id": sid, "name": name, "params": list(params)})
        self._pump(lambda m: True if (m.get("msg") == "ready" and sid in m.get("subs", []))
                   or (m.get("msg") == "nosub" and m.get("id") == sid) else None)

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def _raise(exc):
    raise exc


# ── Token tárolás ─────────────────────────────────────────────────────────────

def _path(user_id: str) -> str:
    return os.path.join(_user_dir(user_id), "bryton.json")


def _load(user_id: str) -> dict:
    try:
        with open(_path(user_id), encoding="utf-8") as f:
            return json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save(user_id: str, data: dict) -> None:
    os.makedirs(_user_dir(user_id), exist_ok=True)
    with open(_path(user_id) + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(_path(user_id) + ".tmp", 0o600)
    os.replace(_path(user_id) + ".tmp", _path(user_id))


def bryton_disconnect(user_id: str) -> None:
    if os.path.isfile(_path(user_id)):
        os.remove(_path(user_id))


def bryton_login(user_id: str, email: str, password: str) -> dict:
    d = _DDP()
    try:
        res = d.call("login", [{"user": {"email": email},
                                "password": {"digest": hashlib.sha256(password.encode("utf-8")).hexdigest(),
                                             "algorithm": "sha-256"}}])
    finally:
        d.close()
    if not isinstance(res, dict) or not res.get("id") or not res.get("token"):
        raise BrytonApiError("A Bryton belépés nem adott tokent.")
    exp = (res.get("tokenExpires") or {}).get("$date")
    data = {"account": email, "bryton_user": res["id"], "token": res["token"],
            "expires_at": int(exp / 1000) if exp else int(time.time()) + 90 * 86400,
            "connected_at": _now_dt()}
    _save(user_id, data)
    log.info("Bryton csatlakoztatva (user=%s)", user_id)
    return data


def bryton_session(user_id: str) -> dict | None:
    """{bryton_user, token} vagy None (nincs kapcsolat). Lejárt → BrytonAuthError."""
    data = _load(user_id)
    if not data.get("token"):
        return None
    if int(data.get("expires_at") or 0) <= time.time():
        raise BrytonAuthError("Lejárt a Bryton-belépés.")
    return {"bryton_user": data["bryton_user"], "token": data["token"]}


def bryton_status(user_id: str) -> dict:
    data = _load(user_id)
    exp = int(data.get("expires_at") or 0)
    return {"available": FIT_AVAILABLE,
            "connected": bool(data.get("token")) and exp > time.time(),
            "expired": bool(data.get("token")) and exp <= time.time(),
            "account": data.get("account"), "connected_at": data.get("connected_at"),
            "expires_at": datetime.fromtimestamp(exp, timezone.utc).isoformat() if exp else None}


def _resumed(sess: dict) -> _DDP:
    d = _DDP()
    try:
        d.call("login", [{"resume": sess["token"]}])
    except BrytonAuthError:
        d.close()
        raise BrytonAuthError("A Bryton-munkamenet érvénytelen – csatlakozz újra.")
    return d


# ══════════════════════════════════════════════════════════════════════════════
# EDZÉS-IMPORT
# ══════════════════════════════════════════════════════════════════════════════

def _deny_path(user_id: str) -> str:
    return os.path.join(_user_dir(user_id), "bryton_deleted.json")


def load_deny(user_id: str) -> dict:
    try:
        with open(_deny_path(user_id), encoding="utf-8") as f:
            return (json.load(f) or {}).get("deleted_at") or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_deny(user_id: str, deny: dict) -> None:
    os.makedirs(_user_dir(user_id), exist_ok=True)
    with open(_deny_path(user_id) + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"deleted_at": deny}, f, ensure_ascii=False, indent=2)
    os.replace(_deny_path(user_id) + ".tmp", _deny_path(user_id))


def add_deny(user_id: str, act_id: str) -> None:
    deny = load_deny(user_id)
    deny[str(act_id)] = _now_dt()
    _save_deny(user_id, deny)


def remove_deny(user_id: str, act_id: str) -> bool:
    deny = load_deny(user_id)
    removed = deny.pop(str(act_id), None) is not None
    if removed:
        _save_deny(user_id, deny)
    return removed


def list_raw(sess: dict) -> list:
    """Az activityList előfizetés edzései (törölt nélkül), legújabb elöl."""
    d = _resumed(sess)
    try:
        d.sub("activityList")
        docs = d.coll.get("userActivities") or {}
    finally:
        d.close()
    acts = [{"_id": k, **v} for k, v in docs.items()
            if not v.get("_deleted") and (v.get("name") or v.get("title")) != "_deleted"]
    acts.sort(key=lambda a: a.get("local_start_time") or 0, reverse=True)
    return acts


def _local_ts(a: dict) -> int | None:
    """local_start_time: helyi idő másodpercben (időzóna nélkül) → unix (a magyar időzónával)."""
    v = a.get("local_start_time")
    if not v:
        return None
    try:
        naive = datetime.fromtimestamp(int(v), timezone.utc).replace(tzinfo=None)
        return int(naive.replace(tzinfo=_TZ).timestamp())
    except (ValueError, OverflowError, OSError):
        return None


def _default_name(ts, sport="cycling") -> str:
    h = datetime.fromtimestamp(ts, _TZ).hour if ts else 12
    part = ("Éjszakai" if h < 5 else "Reggeli" if h < 11 else "Déli" if h < 14
            else "Délutáni" if h < 18 else "Esti" if h < 22 else "Éjszakai")
    noun = {"running": "futás", "walking": "séta", "hiking": "túra"}.get(sport, "kerékpározás")
    return f"{part} {noun}"


def _name(a: dict, ts, sport="cycling") -> str:
    t = (a.get("name") or a.get("title") or "").strip()
    if t and not re.fullmatch(r"[0-9_\-.: ]+|Ride|Cycling|Running", t, flags=re.I):
        return t
    return _default_name(ts, sport)


def bryton_list_activities(sess: dict, user_id: str, limit: int = 30) -> list:
    acts = list_raw(sess)[:limit]
    idx = _load_index(os.path.join(_user_routes_dir(user_id), "index.json"))
    by_id = {str(r.get("bryton_id")): r for r in idx if r.get("bryton_id")}
    deny = load_deny(user_id)
    out = []
    for a in acts:
        aid = str(a["_id"])
        summ = a.get("summary") or {}
        ts = _local_ts(a)
        dist_m = float(summ.get("total_distance") or 0)
        local = by_id.get(aid)
        cross = None if (local or aid in deny or not ts) else find_cross_source_duplicate(idx, ts, dist_m, "bryton_id")
        out.append({
            "id": aid, "name": (local or {}).get("name") or _name(a, ts, a.get("sport") or "cycling"),
            "start_ts": ts, "start_date": datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None,
            "distance_m": dist_m or None, "moving_time_s": summ.get("total_moving_time") or summ.get("total_timer_time"),
            "total_elevation_gain": summ.get("total_ascent"),
            "duplicate_status": "already_imported" if local else ("previously_deleted" if aid in deny
                                else ("likely_duplicate" if cross else "new")),
            "duplicate_local_id": local["id"] if local else (cross["id"] if cross else None),
        })
    return out


def _download_fit(sess: dict, act_id: str) -> bytes:
    last = None
    for host in _DDP_HOSTS:
        try:
            r = requests.get(f"https://{host}/api/activity", params={"id": act_id}, timeout=120,
                             headers={"X-User-Id": sess["bryton_user"], "X-Auth-Token": sess["token"],
                                      "x-api-key": _API_KEY, "User-Agent": "okhttp/4.12.0"})
            if r.status_code in (401, 403):
                raise BrytonAuthError("A Bryton elutasította a letöltést – csatlakozz újra.")
            r.raise_for_status()
            return r.content
        except BrytonAuthError:
            raise
        except requests.RequestException as exc:
            last = exc
    raise BrytonApiError(f"A FIT letöltése sikertelen: {last}")


def bryton_import_activity(sess: dict, user_id: str, act_id: str, dedup: bool = False) -> dict:
    routes_dir = _user_routes_dir(user_id)
    idx_path = os.path.join(routes_dir, "index.json")
    idx = _load_index(idx_path)
    if any(str(r.get("bryton_id")) == act_id for r in idx):
        return {"ok": True, "skipped": True, "reason": "already_imported"}
    fit_bytes = _download_fit(sess, act_id)
    if len(fit_bytes) < 14 or fit_bytes[8:12] != b".FIT":
        return {"ok": False, "error": "A Bryton nem FIT fájlt adott vissza."}
    gpx_text, s = fit_to_gpx(fit_bytes, "Bryton")
    if not gpx_text:   # GPS nélkül: beltéri edzés – adatsorként mentjük
        from indoor import save_indoor_from_fit
        return save_indoor_from_fit(user_id, fit_bytes, name="Beltéri tekerés", source="bryton", id_field="bryton_id", source_id=act_id)
    sport = s.get("sport") or "cycling"
    from utils import gpx_first_time   # tartalék: a nyomvonal első időbélyege – soha nem az import ideje
    start_dt = s.get("start_time") if isinstance(s.get("start_time"), datetime) else (gpx_first_time(gpx_text) or datetime.now(timezone.utc))
    dist_m = s.get("distance_m") or 0
    if dedup:
        dup = find_cross_source_duplicate(idx, int(start_dt.timestamp()), float(dist_m), "bryton_id")
        if dup:
            return {"ok": True, "skipped": True, "reason": "duplicate",
                    "duplicate_local_id": dup["id"], "duplicate_name": dup.get("name")}
    name = _default_name(int(start_dt.timestamp()), sport)
    gpx_text = gpx_text.replace("<name>Bryton</name>", f"<name>{_xml(name)}</name>", 1)
    new_id = uuid.uuid4().hex[:8]
    with open(os.path.join(routes_dir, f"{new_id}.gpx"), "w", encoding="utf-8") as f:
        f.write(gpx_text)
    with open(os.path.join(routes_dir, f"{new_id}.fit"), "wb") as f:
        f.write(fit_bytes)
    mov_s, ele_m = s.get("moving_s") or 0, s.get("ascent_m")
    avg_sp, max_sp = s.get("avg_speed"), s.get("max_speed")
    entry = {
        "id": new_id, "name": name, "type": "workout", "sport_type": sport,
        "distance": round(float(dist_m) / 1000, 2), "duration": round(mov_s / 60) if mov_s else None,
        "elevation": round(ele_m) if ele_m else 0,
        "date": start_dt.astimezone(_TZ).strftime("%Y-%m-%d"),
        "start_time": start_dt.astimezone(timezone.utc).isoformat(),
        "bryton_id": act_id, "source": "bryton", "has_fit": True, "imported_at": _now_dt(),
        "include_in_stats": True, "description": "", "calories": s.get("calories"),
        "avg_heartrate": s.get("avg_hr"), "max_heartrate": s.get("max_hr"),
        "avg_watts": s.get("avg_power"), "max_watts": s.get("max_power"), "avg_cadence": s.get("avg_cadence"),
        "avg_speed_kmh": round(avg_sp * 3.6, 2) if avg_sp else None,
        "max_speed_kmh": round(max_sp * 3.6, 2) if max_sp else None,
        **equipment_fields(s.get("equipment")),
    }
    append_index(idx_path, entry)
    try:
        import temp_weather
        temp_weather.fill_soon(user_id)
    except Exception:
        pass
    return {"ok": True, "skipped": False, "entry": entry}


# ══════════════════════════════════════════════════════════════════════════════
# ÚTVONAL: „BrytonDirections” FIT (a Bryton Active web @brytonfit/file alapján, saját kód)
# ══════════════════════════════════════════════════════════════════════════════

_CRC = [0, 52225, 55297, 5120, 61441, 15360, 10240, 58369, 40961, 27648, 30720, 46081, 20480, 39937, 34817, 17408]


def _crc16(data: bytes, crc: int = 0) -> int:
    for b in data:
        t = _CRC[crc & 15]; crc = (crc >> 4) & 4095; crc = crc ^ t ^ _CRC[b & 15]
        t = _CRC[crc & 15]; crc = (crc >> 4) & 4095; crc = crc ^ t ^ _CRC[(b >> 4) & 15]
    return crc


_T = {"enum": ("<B", 0, 255, 1), "uint16": ("<H", 132, 65535, 2), "sint16": ("<h", 131, 32767, 2),
      "sint32": ("<i", 133, 2147483647, 4), "uint32": ("<I", 134, 4294967295, 4), "string": ("s", 7, 0, 1)}
_MSG = {"overview": 254, "turn": 253, "track": 252, "overview_record": 251, "turn_record": 250, "track_record": 249}


class _Enc:
    def __init__(self):
        self.buf = bytearray(14)

    def define(self, gmsg, loc, fields):
        self.buf += bytes([0x40 | loc]) + struct.pack("<BBHB", 0, 0, gmsg, len(fields))
        for f in fields:
            n = f[4] if len(f) > 4 else 1
            self.buf += struct.pack("BBB", f[0], _T[f[1]][3] * n, _T[f[1]][1])

    def data(self, loc, fields, values):
        out = bytearray([loc])
        for f, v in zip(fields, values):
            typ = f[1]
            scale = f[2] if len(f) > 2 else None
            offset = f[3] if len(f) > 3 else None
            n = f[4] if len(f) > 4 else 1
            fmt, _, inv, _ = _T[typ]
            if typ == "string":
                raw = (v or "").encode("utf-8")[:n - 1]
                out += raw + b"\x00" * (n - len(raw))
                continue
            if v is None:
                out += struct.pack(fmt, inv)
                continue
            if offset is not None:
                v = offset + v
            if scale is not None:
                v = scale * v
            lo, hi = {"<B": (0, 254), "<H": (0, 65534), "<h": (-32767, 32766), "<i": (-2**31 + 1, 2**31 - 2), "<I": (0, 2**32 - 2)}[fmt]
            out += struct.pack(fmt, max(lo, min(hi, int(v))))
        self.buf += out

    def message(self, gmsg, loc, fields, values):
        self.define(gmsg, loc, fields)
        self.data(loc, fields, values)

    def finish(self) -> bytes:
        hdr = struct.pack("<BBHI4s", 14, 16, 108, len(self.buf) - 14, b".FIT")
        self.buf[0:12] = hdr
        self.buf[12:14] = struct.pack("<H", _crc16(hdr))
        self.buf += struct.pack("<H", _crc16(bytes(self.buf)))
        return bytes(self.buf)


def encode_route(points: list, distance_m: float, steps: list | None = None,
                 gain: float | None = None, loss: float | None = None) -> bytes:
    """points: [(lat, lng, alt|None)]; steps: [(pont-index, kanyarkód, táv m, idő ms, név)]."""
    e = _Enc()
    lats, lngs = [p[0] for p in points], [p[1] for p in points]
    alts = [p[2] for p in points if p[2] is not None]
    ov = [(1, "uint16"), (2, "sint32", 1e6), (3, "sint32", 1e6), (4, "sint32", 1e6), (5, "sint32", 1e6),
          (6, "uint32"), (7, "uint16", 5, 500), (8, "uint16", 5, 500)]
    vals = [len(points), max(lats), min(lats), max(lngs), min(lngs), round(distance_m),
            max(alts) if alts else None, min(alts) if alts else None]
    if gain is not None:
        ov.append((9, "uint16")); vals.append(round(gain))
    if loss is not None:
        ov.append((10, "uint16")); vals.append(round(loss))
    e.message(_MSG["overview"], 1, ov, vals)
    orf = [(1, "uint16")]
    e.define(_MSG["overview_record"], 2, orf)
    for i in range(len(points)):
        e.data(2, orf, [i])
    if steps:
        e.message(_MSG["turn"], 3, [(1, "uint16")], [len(steps)])
        trf = [(1, "uint16"), (2, "enum"), (3, "uint32"), (4, "uint32"), (5, "string", None, None, 32)]
        e.define(_MSG["turn_record"], 4, trf)
        for st in steps:
            e.data(4, trf, list(st))
    e.message(_MSG["track"], 5, [(1, "uint16")], [len(points)])
    tkf = [(1, "sint32", 1e6), (2, "sint32", 1e6), (3, "uint16", 5, 500)]
    e.define(_MSG["track_record"], 6, tkf)
    for la, lo, al in points:
        e.data(6, tkf, [la, lo, al])
    return e.finish()


# BRouter voicehint-kód → Bryton kanyarkód (a webes Google-leképezés szerint)
_BR = {1: 1, 2: 3, 3: 5, 4: 7, 5: 2, 6: 4, 7: 6, 8: 14, 9: 13, 10: 12, 11: 12, 15: 12, 13: 24, 14: 25, 17: 16, 18: 15}
_FINISH = 33
_TURN_NAMES = {1: "Egyenesen", 2: "Jobbra", 3: "Balra", 4: "Enyhén jobbra", 5: "Enyhén balra", 6: "Élesen jobbra",
               7: "Élesen balra", 12: "Fordulj vissza", 13: "Tarts jobbra", 14: "Tarts balra",
               24: "Körforgalom", 25: "Körforgalom", 15: "Kijárat jobbra", 16: "Kijárat balra"}


def _hav(a, b) -> float:
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b[1] - a[1]) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(min(1.0, h)))


def _bearing(a, b) -> float:
    la1, la2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    return math.degrees(math.atan2(math.sin(dl) * math.cos(la2), math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dl)))


def _turns_from_geometry(pts: list) -> list:
    """Kanyarok a nyomvonal irányváltásaiból (ha nincs BRouter-utasítás): ~40 m-es irány a pont előtt / után."""
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + _hav(a, b))
    out, last_at = [], -1e9
    j0 = j1 = 0
    for i in range(1, len(pts) - 1):
        while j0 < i and cum[i] - cum[j0] > 40:
            j0 += 1
        j1 = max(j1, i)
        while j1 < len(pts) - 1 and cum[j1] - cum[i] < 40:
            j1 += 1
        if j0 >= i or j1 <= i or cum[i] - last_at < 60:
            continue
        d = (_bearing(pts[i], pts[j1]) - _bearing(pts[j0], pts[i]) + 540) % 360 - 180
        ad = abs(d)
        if ad < 35:
            continue
        code = (4 if d > 0 else 5) if ad < 60 else (2 if d > 0 else 3) if ad < 130 else (6 if d > 0 else 7)
        out.append((i, code))
        last_at = cum[i]
    return out


def build_steps(pts: list, hints: list | None) -> list:
    """Bryton-lépések: (pont-index, kód, táv a következő lépésig, idő ms ~20 km/h, név)."""
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + _hav(a, b))
    raw = []
    for h in hints or []:
        try:
            i, cmd = int(h.get("i")), int(h.get("cmd"))
        except (TypeError, ValueError, AttributeError):
            continue
        if 0 < i < len(pts) - 1 and cmd in _BR:
            raw.append((i, _BR[cmd]))
    if not raw:
        raw = _turns_from_geometry(pts)
    marks = [(0, 1)] + sorted(set(raw)) + [(len(pts) - 1, _FINISH)]
    steps = []
    for k, (i, code) in enumerate(marks):
        nxt = marks[k + 1][0] if k + 1 < len(marks) else i
        dist = max(0.0, cum[nxt] - cum[i])
        steps.append((i, code, round(dist), round(dist / (20 / 3.6) * 1000),
                      "Cél" if code == _FINISH else ("Rajt" if k == 0 else _TURN_NAMES.get(code, ""))))
    return steps


_PT_RE = re.compile(r'<(?:trkpt|rtept)\b[^>]*?\blat="([-\d.]+)"[^>]*?\blon="([-\d.]+)"[^>]*?(?:/>|>(.*?)</(?:trkpt|rtept)>)', re.S)
_ELE_RE = re.compile(r"<ele>\s*([-\d.]+)\s*</ele>")


def bryton_upload_route(sess: dict, name: str, gpx_text: str, hints: list | None = None) -> dict:
    """GPX (+ BRouter-kanyarok) → BrytonDirections FIT → feltöltés a „Tervezett utak” közé."""
    pts = []
    for m in _PT_RE.finditer(gpx_text):
        e = _ELE_RE.search(m.group(3) or "")
        try:
            pts.append((float(m.group(1)), float(m.group(2)), float(e.group(1)) if e else None))
        except ValueError:
            continue
    if len(pts) < 2:
        return {"ok": False, "error": "Az útvonalban nincsenek pontok."}
    if len(pts) > 6000:                       # a komputer memóriája – ritkítás (a kanyar-indexek a ritkított pontokra)
        step = math.ceil(len(pts) / 6000)
        keep = list(range(0, len(pts), step))
        if keep[-1] != len(pts) - 1:
            keep.append(len(pts) - 1)
        last = len(keep) - 1
        hints = [{**h, "i": min(last, round(int(h["i"]) / step))} for h in (hints or [])
                 if isinstance(h, dict) and str(h.get("i", "")).lstrip("-").isdigit()]
        pts = [pts[k] for k in keep]
    dist = sum(_hav(a, b) for a, b in zip(pts, pts[1:]))
    gain = loss = 0.0
    base = None
    for p in pts:
        if p[2] is None:
            continue
        if base is None:
            base = p[2]
        elif p[2] - base >= 3:
            gain += p[2] - base; base = p[2]
        elif base - p[2] >= 3:
            loss += base - p[2]; base = p[2]
    steps = build_steps(pts, hints)
    fit = encode_route(pts, dist, steps, gain=gain or None, loss=loss or None)
    name = (name or "Bringaterv útvonal").strip()[:60]
    try:
        r = requests.post(f"{_WEB}/route/upload/{sess['bryton_user']}", timeout=90,
                          headers={"X-User-Id": sess["bryton_user"], "X-Auth-Token": sess["token"]},
                          files={"file": (name, fit, "application/octet-stream")}, data={"name": name})
    except requests.RequestException as exc:
        raise BrytonApiError(f"A Bryton nem érhető el: {exc}") from exc
    if r.status_code in (401, 403):
        raise BrytonAuthError("A Bryton elutasította a feltöltést – csatlakozz újra.")
    if not r.ok:
        raise BrytonApiError(f"A Bryton nem fogadta el az útvonalat (HTTP {r.status_code}).")
    try:
        fid = (r.json() or {}).get("fileid")
    except ValueError:
        fid = None
    return {"ok": True, "file_id": fid, "name": name, "distance_km": round(dist / 1000, 1),
            "turns": max(0, len(steps) - 2)}
