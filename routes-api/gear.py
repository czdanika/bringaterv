"""Bringaterv API – Felszerelés: bringák, alkatrészek, karbantartás (felhasználónként).

Tárolás: /data/users/<uid>/gear.json
  {
    "bikes":      [{id, name, brand, model, type, weight, purchase_date, price, start_km,
                    aliases: [], is_default, retired, notes, tasks: [...]}],
    "components": [{id, name, kind, brand, price, notes, retired,
                    installs: [{bike_id, from, until}], tasks: [...]}],
    "logs":       [{id, target_type: bike|component, target_id, task_id, date, cost, note}],
    "notified":   {"<target>:<task>": "<date>"}       # push-értesítés már ment
  }
  task: {id, name, unit: km|hours|days, interval, last_done}

Egy edzés bringája (ugyanaz, mint a frontend src/equipment.js):
  kézi bike_id → a bike_name egyezik egy bringa nevével / „más néven” listájával →
  kerékpáros edzésnél az alapértelmezett bringa.
Alkatrész km: csak az alatt az idő alatt (from–until) az adott bringán megtett edzések.
Feladat: a legutóbbi elvégzés (last_done; ennek híján a felszerelés / felvétel napja) óta
megtett km / üzemóra / eltelt nap a határhoz mérve. 90% = hamarosan, 100% = esedékes.

A régi „Bringáim” (settings["bikes"]) első betöltéskor ide költözik.
"""

import json
import os
import re
import secrets
from datetime import date, datetime

from config import log
from storage import _load_user_settings_file, _user_dir, _user_routes_dir
from utils import _load_index

BIKE_TYPES = ("road", "gravel", "mtb", "trekking", "tt", "indoor", "other")
COMPONENT_KINDS = ("chain", "tire", "brake", "cassette", "chainring", "wheel", "cable", "battery", "other")
UNITS = ("km", "hours", "days")


def _path(uid: str) -> str:
    return os.path.join(_user_dir(uid), "gear.json")


PHOTO_RE = re.compile(r"^[A-Za-z0-9_-]{1,60}\.(jpg|png|webp)$")


def photo_dir(uid: str) -> str:
    return os.path.join(_user_dir(uid), "gear_photos")


def _photo(v, uid: str | None = None):
    """Érvényes, létező fotófájl neve – különben None."""
    s = str(v or "")
    if not PHOTO_RE.match(s):
        return None
    return s if uid is None or os.path.isfile(os.path.join(photo_dir(uid), s)) else None


def cleanup_photos(uid: str, gear: dict) -> None:
    """A már egyik bringához / alkatrészhez sem tartozó képek törlése."""
    d = photo_dir(uid)
    if not os.path.isdir(d):
        return
    used = {x.get("photo") for x in gear.get("bikes", []) + gear.get("components", []) if x.get("photo")}
    for fn in os.listdir(d):
        if fn not in used:
            try: os.remove(os.path.join(d, fn))
            except OSError: pass


def new_id(prefix: str = "g") -> str:
    return prefix + secrets.token_hex(4)


def _today() -> str:
    return date.today().isoformat()


# ── Betöltés / mentés (+ a régi „Bringáim” átköltöztetése) ───────────────────

def load_gear(uid: str) -> dict:
    try:
        with open(_path(uid), encoding="utf-8") as f:
            data = json.load(f) or {}
    except FileNotFoundError:
        data = _migrate_from_settings(uid)
    except (OSError, json.JSONDecodeError):
        data = {}
    for k in ("bikes", "components", "logs"):
        data.setdefault(k, [])
    data.setdefault("notified", {})
    return data


def save_gear(uid: str, data: dict) -> None:
    os.makedirs(_user_dir(uid), exist_ok=True)
    path = _path(uid)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)


def _migrate_from_settings(uid: str) -> dict:
    """A Beállítások → Bringáim listája (settings["bikes"]) → gear.json. A régi
    „alkatrész + km-határ” emlékeztetőkből alkatrész lesz egy km-alapú feladattal."""
    data = {"bikes": [], "components": [], "logs": [], "notified": {}}
    old = (_load_user_settings_file(uid) or {}).get("bikes") or []
    for b in old if isinstance(old, list) else []:
        if not isinstance(b, dict) or not b.get("name"):
            continue
        bid = str(b.get("id") or new_id("b"))
        data["bikes"].append({
            "id": bid, "name": str(b["name"])[:60], "type": b.get("type") if b.get("type") in BIKE_TYPES else "road",
            "weight": b.get("weight"), "aliases": [str(a)[:60] for a in (b.get("aliases") or [])][:20],
            "retired": bool(b.get("retired")), "start_km": 0, "tasks": [],
        })
        for p in b.get("parts") or []:
            since = str(p.get("since") or _today())[:10]
            data["components"].append({
                "id": new_id("c"), "name": str(p.get("name") or "Alkatrész")[:60], "kind": "other",
                "installs": [{"bike_id": bid, "from": since, "until": None}],
                "tasks": [{"id": new_id("t"), "name": "Csere", "unit": "km",
                           "interval": float(p.get("limitKm") or 0) or 1000, "last_done": since}],
            })
    if data["bikes"]:
        save_gear(uid, data)
        log.info("Bringáim → gear.json átköltöztetve (user=%s, %d bringa)", uid, len(data["bikes"]))
    return data


# ── Érvényesítés (a frontend a teljes dokumentumot küldi) ────────────────────

def _num(v, lo=None, hi=None):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if (lo is not None and x < lo) or (hi is not None and x > hi):
        return None
    return round(x, 2)


def _date(v):
    s = str(v or "")[:10]
    return s if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) else None


def _str(v, n=60):
    return str(v or "").strip()[:n]


def _tasks(raw) -> list:
    out = []
    for t in (raw or [])[:30]:
        if not isinstance(t, dict) or not _str(t.get("name")):
            continue
        unit = t.get("unit") if t.get("unit") in UNITS else "km"
        interval = _num(t.get("interval"), 1, 1_000_000)
        if not interval:
            continue
        out.append({"id": _str(t.get("id"), 20) or new_id("t"), "name": _str(t.get("name")),
                    "unit": unit, "interval": interval, "last_done": _date(t.get("last_done"))})
    return out


def clean_gear(raw: dict, prev: dict, uid: str | None = None) -> dict:
    """A kliensről jött dokumentum szűrése (csak az ismert mezők, korlátozott méret)."""
    bikes, comps, logs = [], [], []
    for b in (raw.get("bikes") or [])[:50]:
        if not isinstance(b, dict) or not _str(b.get("name")):
            continue
        bikes.append({
            "id": _str(b.get("id"), 20) or new_id("b"), "name": _str(b.get("name")),
            "brand": _str(b.get("brand")), "model": _str(b.get("model")),
            "type": b.get("type") if b.get("type") in BIKE_TYPES else "road",
            "weight": _num(b.get("weight"), 1, 60), "purchase_date": _date(b.get("purchase_date")),
            "price": _num(b.get("price"), 0, 100_000_000), "start_km": _num(b.get("start_km"), 0, 1_000_000) or 0,
            "aliases": [_str(a) for a in (b.get("aliases") or []) if _str(a)][:20],
            "is_default": bool(b.get("is_default")), "retired": bool(b.get("retired")),
            "notes": _str(b.get("notes"), 500), "tasks": _tasks(b.get("tasks")),
            "photo": _photo(b.get("photo"), uid),
        })
    if sum(1 for b in bikes if b["is_default"]) > 1:      # csak egy alapértelmezett lehet
        first = next(b for b in bikes if b["is_default"])
        for b in bikes:
            b["is_default"] = b is first
    bike_ids = {b["id"] for b in bikes}
    for c in (raw.get("components") or [])[:300]:
        if not isinstance(c, dict) or not _str(c.get("name")):
            continue
        installs = []
        for i in (c.get("installs") or [])[:50]:
            if isinstance(i, dict) and i.get("bike_id") in bike_ids and _date(i.get("from")):
                installs.append({"bike_id": i["bike_id"], "from": _date(i["from"]), "until": _date(i.get("until"))})
        comps.append({
            "id": _str(c.get("id"), 20) or new_id("c"), "name": _str(c.get("name")),
            "kind": c.get("kind") if c.get("kind") in COMPONENT_KINDS else "other",
            "brand": _str(c.get("brand")), "price": _num(c.get("price"), 0, 100_000_000),
            "notes": _str(c.get("notes"), 500), "retired": bool(c.get("retired")),
            "installs": installs, "tasks": _tasks(c.get("tasks")),
            "photo": _photo(c.get("photo"), uid),
        })
    for lg in (raw.get("logs") or [])[-2000:]:
        if not isinstance(lg, dict) or lg.get("target_type") not in ("bike", "component") or not _date(lg.get("date")):
            continue
        logs.append({"id": _str(lg.get("id"), 20) or new_id("l"), "target_type": lg["target_type"],
                     "target_id": _str(lg.get("target_id"), 20), "task_id": _str(lg.get("task_id"), 20),
                     "task_name": _str(lg.get("task_name")), "date": _date(lg["date"]),
                     "cost": _num(lg.get("cost"), 0, 100_000_000), "note": _str(lg.get("note"), 300)})
    return {"bikes": bikes, "components": comps, "logs": logs, "notified": prev.get("notified") or {}}


# ── Edzés → bringa, km-számítás ───────────────────────────────────────────────

def _norm(s) -> str:
    return str(s or "").strip().lower()


def _is_cycling(e: dict) -> bool:
    t = _norm(e.get("sport_type") or "cycling")
    return "cycl" in t or "ride" in t or "bike" in t


def resolve_bike(e: dict, bikes: list):
    """Az edzés bringája (bike dict) vagy None; plusz a nem felvett név (str) vagy None."""
    if e.get("bike_id"):
        b = next((x for x in bikes if x["id"] == e["bike_id"]), None)
        if b:
            return b, None
    n = _norm(e.get("bike_name"))
    if n:
        b = next((x for x in bikes if _norm(x["name"]) == n or n in {_norm(a) for a in x.get("aliases") or []}), None)
        if b:
            return b, None
    default = next((x for x in bikes if x.get("is_default") and not x.get("retired")), None)
    if default and _is_cycling(e) and not n:
        return default, None
    return None, (e.get("bike_name") or "").strip() or None


def _workout_day(e: dict) -> str:
    return (e.get("date") or (e.get("start_time") or "")[:10] or "")[:10]


def _progress(task: dict, rides: list, start: str | None) -> dict:
    """rides: [(day, km, min)] – a feladat céljára (bringa / alkatrész-időablak) szűrve."""
    since = task.get("last_done") or start or "0000-00-00"
    after = [r for r in rides if r[0] >= since]
    if task["unit"] == "km":
        used = sum(r[1] for r in after)
    elif task["unit"] == "hours":
        used = sum(r[2] for r in after) / 60
    else:
        try:
            used = (date.today() - date.fromisoformat(since)).days if since != "0000-00-00" else 0
        except ValueError:
            used = 0
    pct = used / task["interval"] if task["interval"] else 0
    status = "due" if pct >= 1 else "soon" if pct >= 0.9 else "ok"
    return {"used": round(used, 1), "pct": round(pct, 3), "status": status, "since": since}


def compute_usage(uid: str, gear: dict | None = None) -> dict:
    gear = gear or load_gear(uid)
    bikes = gear["bikes"]
    idx = _load_index(os.path.join(_user_routes_dir(uid), "index.json"))
    workouts = [e for e in idx if e.get("type") == "workout"]
    per_bike, unknown, devices = {}, {}, {}
    year = str(date.today().year)
    for e in workouts:
        day, km, mins = _workout_day(e), float(e.get("distance") or 0), float(e.get("duration") or 0)
        b, uname = resolve_bike(e, bikes)
        if b:
            s = per_bike.setdefault(b["id"], {"km": 0.0, "min": 0.0, "elev": 0.0, "count": 0, "last": None, "year_km": 0.0, "rides": []})
            s["km"] += km; s["min"] += mins; s["elev"] += float(e.get("elevation") or 0); s["count"] += 1
            s["rides"].append((day, km, mins))
            if day.startswith(year):
                s["year_km"] += km
            if day and (not s["last"] or day > s["last"]):
                s["last"] = day
        elif uname:
            u = unknown.setdefault(_norm(uname), {"name": uname, "count": 0, "km": 0.0})
            u["count"] += 1; u["km"] += km
        if e.get("device"):
            d = devices.setdefault(_norm(e["device"]), {"name": e["device"], "count": 0, "km": 0.0, "min": 0.0, "last": None})
            d["count"] += 1; d["km"] += km; d["min"] += mins
            if day and (not d["last"] or day > d["last"]):
                d["last"] = day

    tasks = []
    bike_out = {}
    for b in bikes:
        s = per_bike.get(b["id"], {"km": 0.0, "min": 0.0, "elev": 0.0, "count": 0, "last": None, "year_km": 0.0, "rides": []})
        bike_out[b["id"]] = {"km": round(s["km"] + (b.get("start_km") or 0), 1), "ride_km": round(s["km"], 1),
                             "min": round(s["min"]), "elev": round(s["elev"]), "count": s["count"],
                             "last": s["last"], "year_km": round(s["year_km"], 1)}
        for t in b.get("tasks") or []:
            tasks.append({"target_type": "bike", "target_id": b["id"], "target_name": b["name"], "bike_name": b["name"],
                          "task_id": t["id"], "name": t["name"], "unit": t["unit"], "interval": t["interval"],
                          "retired": b.get("retired"), **_progress(t, s["rides"], b.get("purchase_date"))})
    comp_out = {}
    for c in gear["components"]:
        rides, km, mins, cur = [], 0.0, 0.0, None
        for ins in c.get("installs") or []:
            frm, until = ins["from"], ins.get("until") or "9999-12-31"
            for r in per_bike.get(ins["bike_id"], {}).get("rides", []):
                if frm <= r[0] <= until:
                    rides.append(r); km += r[1]; mins += r[2]
            if not ins.get("until"):
                cur = ins["bike_id"]
        bname = next((b["name"] for b in bikes if b["id"] == cur), None)
        comp_out[c["id"]] = {"km": round(km, 1), "min": round(mins), "bike_id": cur, "bike_name": bname}
        first = min((i["from"] for i in c.get("installs") or []), default=None)
        for t in c.get("tasks") or []:
            tasks.append({"target_type": "component", "target_id": c["id"], "target_name": c["name"], "bike_name": bname,
                          "task_id": t["id"], "name": t["name"], "unit": t["unit"], "interval": t["interval"],
                          "retired": c.get("retired") or not cur, **_progress(t, rides, first)})
    order = {"due": 0, "soon": 1, "ok": 2}
    tasks.sort(key=lambda t: (order[t["status"]], -t["pct"]))
    return {
        "bikes": bike_out, "components": comp_out, "tasks": tasks,
        "unknown_bikes": sorted(({**u, "km": round(u["km"], 1)} for u in unknown.values()), key=lambda u: -u["count"]),
        "devices": sorted(({**d, "km": round(d["km"], 1), "min": round(d["min"])} for d in devices.values()),
                          key=lambda d: -d["count"]),
    }


# ── Push: esedékes karbantartás (óránként, a háttérszálból) ──────────────────

def notify_due(uid: str) -> int:
    """Az újonnan esedékessé vált feladatokról egyszer szól (a „notified” jelzi)."""
    gear = load_gear(uid)
    if not gear["bikes"] and not gear["components"]:
        return 0
    usage = compute_usage(uid, gear)
    sent = 0
    notified = dict(gear.get("notified") or {})
    live = set()
    for t in usage["tasks"]:
        key = f"{t['target_id']}:{t['task_id']}:{t['since']}"
        if t["status"] != "due" or t.get("retired"):
            continue
        live.add(key)
        if key in notified:
            continue
        try:
            import notify
            where = t["target_name"] + (f" ({t['bike_name']})" if t["target_type"] == "component" and t.get("bike_name") else "")
            unit = {"km": "km", "hours": "óra", "days": "nap"}[t["unit"]]
            notify.send(uid, "gear_due", f"🔧 Szerviz esedékes: {where}",
                        f"{t['name']} – {t['used']:.0f} / {t['interval']:.0f} {unit}. Elvégezted? Felszerelés menü.",
                        url="./index.html?gear=1", tag=f"gear-{t['target_id']}-{t['task_id']}")
            sent += 1
        except Exception as exc:
            log.warning("Felszerelés-értesítés hiba (%s): %s", uid, exc)
        notified[key] = _today()
    new = {k: v for k, v in notified.items() if k in live}   # a nullázottak kikerülnek
    if new != (gear.get("notified") or {}):
        fresh = load_gear(uid)                                 # közben a felhasználó is menthetett
        fresh["notified"] = new
        save_gear(uid, fresh)
    return sent
