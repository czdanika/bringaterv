#!/usr/bin/env python3
"""Bringaterv – bemutató fiók („Példa Anna”) kitalált adatokkal a Mi ez? / súgó képernyőképeihez.

A közösségi útvonalakból valószerű edzéseket generál (idő az emelkedőkhöz igazított
sebességgel, pulzus, kadencia, fizikából számolt teljesítmény, évszakhoz illő hőmérséklet,
rögzítő eszköz és bringa a GPX metaadatában), plusz néhány tervet, két bringát
alkatrészekkel / karbantartással és a profilbeállításokat. Valódi személyes adat nincs benne.

  tools/demo/seed_demo.py            # létrehozza (ha van: törli és újra)
Környezet (tests/.env): BT_BASE (alap: http://192.168.0.136:8088), BT_USER / BT_PASS (admin),
DEMO_USER / DEMO_PASS (a bemutató fiók – ha nincs megadva: anna / véletlen jelszó, kiírja).
"""

import json
import math
import os
import random
import re
import secrets
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
ENV = {}
if (ROOT / "tests/.env").exists():
    ENV = dict(l.strip().split("=", 1) for l in (ROOT / "tests/.env").read_text().splitlines() if "=" in l and not l.startswith("#"))
BASE = os.environ.get("BT_BASE") or ENV.get("BT_BASE") or "http://192.168.0.136:8088"
API = BASE.rstrip("/") + "/api"
ADMIN = (os.environ.get("BT_USER") or ENV.get("BT_USER"), os.environ.get("BT_PASS") or ENV.get("BT_PASS"))
DEMO_USER = os.environ.get("DEMO_USER") or ENV.get("DEMO_USER") or "anna"
DEMO_PASS = os.environ.get("DEMO_PASS") or ENV.get("DEMO_PASS") or ("Demo-" + secrets.token_urlsafe(8))

rnd = random.Random(20261108)
TODAY = date.today()


def post_retry(url, **kw):
    """POST a szerver korlátjának (429) tiszteletben tartásával."""
    for _ in range(30):
        r = requests.post(url, **kw)
        if r.status_code != 429:
            return r
        time.sleep(int(r.headers.get("Retry-After") or 10))
    return r


def login(user, pw):
    r = requests.post(f"{API}/auth/login", json={"username": user, "password": pw}, timeout=20)
    r.raise_for_status()
    return {"Authorization": f"Bearer {r.json()['token']}"}


# ── Felhasználó ───────────────────────────────────────────────────────────────

def ensure_user(adm):
    users = requests.get(f"{API}/admin/users", headers=adm, timeout=20).json()
    users = users.get("users", users) if isinstance(users, dict) else users
    for u in users:
        if (u.get("email") or "").lower() == DEMO_USER.lower():
            print("Meglévő bemutató fiók törlése:", u["id"])
            requests.delete(f"{API}/admin/users/{u['id']}", headers=adm, timeout=30, json={"confirm_email": u["email"]}).raise_for_status()
    r = requests.post(f"{API}/admin/users", headers=adm, timeout=20, json={
        "email": DEMO_USER, "password": DEMO_PASS, "first_name": "Anna", "last_name": "Példa",
        "name": "Példa Anna", "role": "user"})
    r.raise_for_status()
    # megerősített e-mail nélkül a fiók nem használható (a fenntartott example.com címre nem megy levél)
    requests.patch(f"{API}/admin/users/{r.json()['id']}", headers=adm, timeout=20,
                   json={"contact_email": "anna@example.com", "email_verified": True,
                         "quota_routes": 300, "quota_workouts": 300}).raise_for_status()
    print("Bemutató fiók:", DEMO_USER, "/", DEMO_PASS)


# ── GPX-generálás ─────────────────────────────────────────────────────────────

def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(h))


def sample_points(gpx):
    pts = []
    for m in re.finditer(r"<(?:trkpt|rtept)\b([^>]*)>(.*?)</(?:trkpt|rtept)>", gpx, re.S):
        la = re.search(r'lat="([-\d.]+)"', m.group(1)); lo = re.search(r'lon="([-\d.]+)"', m.group(1))
        el = re.search(r"<ele>([-\d.]+)</ele>", m.group(2))
        if la and lo:
            pts.append([float(la.group(1)), float(lo.group(1)), float(el.group(1)) if el else None])
    # sűrítés: 40 m-nél ritkább pontok közé interpolált pontok (folyamatos grafikonokhoz)
    out = []
    for i, p in enumerate(pts):
        if i:
            q = pts[i - 1]; d = hav(q, p); n = int(d // 40)
            for k in range(1, n + 1):
                t = k / (n + 1)
                e = None if p[2] is None or q[2] is None else q[2] + (p[2] - q[2]) * t
                out.append([q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t, e])
        out.append(p)
    return out


def season_temp(d: date, hour: float) -> float:
    doy = d.timetuple().tm_yday
    base = 11 + 11 * math.sin((doy - 110) / 365 * 2 * math.pi)       # január ~0 °C, július ~22 °C
    return base + 4 * math.sin((hour - 9) / 24 * 2 * math.pi)        # délután melegebb


def build_workout(name, pts, start: datetime, *, walk=False, power=True, device="Wahoo ELEMNT BOLT",
                  maker="wahoo", bike=None, v0=24.0, intensity=0.68, sensors=None):
    rest, mx, mass = 55, 186, 62 + 9
    out, t, hr, prev_grade = [], start, 100.0, 0.0
    dist = 0.0
    for i, p in enumerate(pts):
        if i:
            d = hav(pts[i - 1], p)
            dist += d
            # lejtés ~150 m-es ablakban (zajmentes)
            j = i
            while j > 0 and hav(pts[j], p) < 150:
                j -= 1
            g = 0.0
            if p[2] is not None and pts[j][2] is not None and hav(pts[j], p) > 30:
                g = (p[2] - pts[j][2]) / hav(pts[j], p)
            g = max(-0.12, min(0.12, g))
            prev_grade = g
            if walk:
                v = max(3.2, 5.2 * (1 - 3 * max(g, 0)) + rnd.uniform(-0.3, 0.3)) / 3.6
            else:
                v = max(7.0, min(52.0, v0 * (1 - 6 * g) * (1 + rnd.uniform(-0.05, 0.05)))) / 3.6
            t += timedelta(seconds=d / v)
        else:
            v, g = (5 / 3.6 if walk else v0 / 3.6), 0.0
        # teljesítmény (fizika) és pulzus (késleltetve követi a terhelést)
        pw = None
        if not walk:
            pw = (mass * 9.81 * v * (g + 0.005) + 0.5 * 1.2 * 0.34 * v ** 3) / 0.97
            pw = max(0.0, pw + rnd.gauss(0, 12)) if pw > 15 else 0.0
        load = (pw / 230 if pw is not None else 0.45 + 4 * max(g, 0)) if not walk else 0.4 + 5 * max(g, 0)
        target = rest + (mx - rest) * min(0.95, intensity * (0.75 + 0.45 * load))
        hr += (target - hr) * 0.08
        cad = None if walk else (0 if (pw or 0) < 20 else int(rnd.gauss(86, 5)))
        temp = round(season_temp(start.date(), t.hour + t.minute / 60) + rnd.uniform(-0.6, 0.6))
        out.append((p, t, int(hr + rnd.gauss(0, 1.5)), cad, None if pw is None else int(pw), temp))
    eq = {"device": device, "device_maker": maker, "sensors": sensors or (["heart_rate"] if walk else ["heart_rate", "cadence", "power"] if power else ["heart_rate", "cadence"])}
    if bike:
        eq["bike_name"] = bike
    if power and not walk:
        eq["power_meter"] = "Favero Assioma Duo"
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<gpx version="1.1" creator="Bringaterv demo" xmlns="http://www.topografix.com/GPX/1/1" '
             'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" '
             'xmlns:gpxpx="http://www.garmin.com/xmlschemas/PowerExtension/v1" xmlns:bringaterv="https://bringaterv.app/gpx/1">',
             f'  <metadata><name>{name}</name><time>{start.strftime("%Y-%m-%dT%H:%M:%SZ")}</time>'
             f'<extensions><bringaterv:equipment>{json.dumps(eq, ensure_ascii=False)}</bringaterv:equipment></extensions></metadata>',
             f'  <trk><name>{name}</name><type>{"walking" if walk else "cycling"}</type><trkseg>']
    for p, tt, h, c, pw, tc in out:
        # az Apple Watch nem mér környezeti hőmérsékletet (ott az időjárás szerinti látszik)
        ext = "<gpxtpx:TrackPointExtension>" + ("" if walk else f"<gpxtpx:atemp>{tc}</gpxtpx:atemp>") + f"<gpxtpx:hr>{h}</gpxtpx:hr>"
        if c is not None:
            ext += f"<gpxtpx:cad>{c}</gpxtpx:cad>"
        ext += "</gpxtpx:TrackPointExtension>"
        if power and pw is not None:
            ext += f"<gpxpx:PowerExtension><gpxpx:PowerInWatts>{pw}</gpxpx:PowerInWatts></gpxpx:PowerExtension>"
        ele = f"<ele>{p[2]:.1f}</ele>" if p[2] is not None else ""
        lines.append(f'    <trkpt lat="{p[0]:.6f}" lon="{p[1]:.6f}">{ele}<time>{tt.strftime("%Y-%m-%dT%H:%M:%SZ")}</time><extensions>{ext}</extensions></trkpt>')
    lines.append("  </trkseg></trk>\n</gpx>")
    asc = sum(max(0, (b[0][2] or 0) - (a[0][2] or 0)) for a, b in zip(out, out[1:]) if a[0][2] is not None and b[0][2] is not None)
    return "\n".join(lines), dist / 1000, (out[-1][1] - start).total_seconds() / 60, asc * 0.6


# ── Adatok ────────────────────────────────────────────────────────────────────

RIDES = [  # (minta, név, sebesség, intenzitás, bringa)
    ("kis-balaton-kr-classic", "Kis-Balaton kör", 25, 0.66, "Grail"),
    ("velencei-t", "Esti kör a Velencei-tó körül", 26, 0.64, "Trek 1.1"),
    ("kali-medence-kor", "Káli-medencei gravel", 20, 0.7, "Grail"),
    ("zanka-nagyvazsony-zirc", "Bakonyi mászás", 21, 0.74, "Grail"),
    ("tisza-to-kor", "Tisza-tó kör", 25, 0.66, "Trek 1.1"),
    ("orseg-6", "Őrségi dombok", 22, 0.7, "Grail"),
    ("zempleni-zold-szolo", "Zempléni szőlők között", 21, 0.68, "Grail"),
    ("kaposvar-balatonlelle", "Kaposvár–Balatonlelle", 26, 0.65, "Trek 1.1"),
    ("ferto-hansag", "Fertő–Hanság", 27, 0.63, "Trek 1.1"),
    ("szekesfehervar-velencei-to", "Reggeli kerékpározás", 25, 0.62, "Trek 1.1"),
    ("eger-bogacs", "Bükkalja", 22, 0.72, "Grail"),
    ("budapest-balaton", "Hétvégi hosszú túra", 26, 0.67, "Trek 1.1"),
]
WALKS = [("horhosok-utja", "Horhosok útja – túra", "hiking"), ("csakvar-verteskozma", "Vértesi séta", "walking"),
         ("neszmely-szomod-tata", "Gerecsei túra", "hiking")]
PLANS = [("zanka-nagyvazsony-zirc", "Balaton-felvidéki gravel", "gravel"), ("tisza-to-kor", "Tisza-tó teljes kör", "cycling"),
         ("orseg-6", "Őrségi kör", "cycling"), ("balatoni-kor", "Balaton-kör egy nap alatt", "cycling")]


def main():
    adm = login(*ADMIN)
    ensure_user(adm)
    me = login(DEMO_USER, DEMO_PASS)
    samples = {}

    def gpx_of(sid):
        if sid not in samples:
            samples[sid] = requests.get(f"{API}/samples/{sid}", headers=me, timeout=30).text
        return samples[sid]

    # beállítások: életkor, nem, pulzus, profil
    settings = requests.get(f"{API}/user/settings", headers=me, timeout=20).json() or {}
    settings.update({
        "hrZones": {"sex": "female", "birthYear": 1991, "rest": 55, "max": 186, "lthr": 168, "method": "lthr",
                    "zoneModel": "friel", "zoneCount": 5},
        "cyclistProfile": {"riderKg": 62, "bikeKg": 9, "position": "road"},
        "theme": "light", "mapStyle": "light",
    })
    requests.put(f"{API}/user/settings", headers=me, json=settings, timeout=20).raise_for_status()

    # edzések: az elmúlt ~13 hónapban, hetente 1–2, nyáron sűrűbben
    plan = []
    d = TODAY - timedelta(days=395)
    while d <= TODAY - timedelta(days=1):
        summer = 4 <= d.month <= 9
        if rnd.random() < (0.32 if summer else 0.16):
            plan.append(d)
        d += timedelta(days=1)
    plan.append(TODAY - timedelta(days=1))
    saved = []
    for k, day in enumerate(plan):
        walk = rnd.random() < 0.12
        if walk:
            sid, name, sport = rnd.choice(WALKS)
            hour = rnd.choice([9, 10, 15])
        else:
            sid, name, v0, inten, bike = RIDES[k % len(RIDES)] if day != TODAY - timedelta(days=1) else RIDES[11]
            sport = "cycling"
            hour = rnd.choice([7, 9, 16, 17]) if day.weekday() < 5 else rnd.choice([8, 9, 10])
        pts = sample_points(gpx_of(sid))
        if len(pts) < 20:
            continue
        start = datetime(day.year, day.month, day.day, hour, rnd.randint(0, 50), tzinfo=timezone.utc) - timedelta(hours=1)
        if walk:
            gpx, km, mins, asc = build_workout(name, pts, start, walk=True, power=False, device="Apple Watch Series 7",
                                               maker="apple", intensity=0.55)
        else:
            gpx, km, mins, asc = build_workout(name, pts, start, power=bike == "Grail" or rnd.random() < 0.4, bike=bike,
                                               v0=v0 + rnd.uniform(-1.5, 1.5), intensity=inten + rnd.uniform(-0.04, 0.04))
        r = post_retry(f"{API}/routes", headers=me, timeout=60, json={
            "name": name, "gpxContent": gpx, "distance": round(km, 2), "duration": round(mins),
            "elevation": round(asc), "type": "workout", "start_time": start.isoformat(), "include_in_stats": True,
            "sport_type": sport})
        r.raise_for_status()
        saved.append(r.json().get("id"))
        print(f"  {day} {name} ({km:.1f} km)")
    for sid, name, typ in PLANS:
        pts = sample_points(gpx_of(sid))
        body = gpx_of(sid)
        r = post_retry(f"{API}/routes", headers=me, timeout=60, json={
            "name": name, "gpxContent": body, "distance": round(sum(hav(a, b) for a, b in zip(pts, pts[1:])) / 1000, 1),
            "type": typ, "include_in_stats": False})
        r.raise_for_status()
        print("  terv:", name)

    # felszerelés: két bringa (fotóval), alkatrészek, karbantartás
    gear = {"bikes": [
        {"id": "bgrail", "name": "Canyon Grail CF SL 7", "brand": "Canyon", "model": "Grail CF SL 7", "type": "gravel",
         "weight": 8.9, "purchase_date": (TODAY - timedelta(days=420)).isoformat(), "price": 1290000, "start_km": 0,
         "aliases": ["Grail"], "is_default": True, "retired": False, "notes": "",
         "tasks": [{"id": "t1", "name": "Nagyszerviz", "unit": "days", "interval": 365,
                    "last_done": (TODAY - timedelta(days=120)).isoformat()}]},
        {"id": "btrek", "name": "Trek 1.1", "brand": "Trek", "model": "1.1", "type": "road", "weight": 10.2,
         "purchase_date": "2021-04-10", "price": 380000, "start_km": 6200, "aliases": [], "is_default": False,
         "retired": False, "notes": "", "tasks": []}],
        "components": [
            {"id": "c1", "name": "Shimano GRX lánc", "kind": "chain", "brand": "Shimano",
             "installs": [{"bike_id": "bgrail", "from": (TODAY - timedelta(days=150)).isoformat()}],
             "tasks": [{"id": "t2", "name": "Láncolajozás", "unit": "km", "interval": 300,
                        "last_done": (TODAY - timedelta(days=4)).isoformat()},
                       {"id": "t3", "name": "Csere", "unit": "km", "interval": 3000}]},
            {"id": "c2", "name": "Schwalbe G-One gumik", "kind": "tire", "brand": "Schwalbe",
             "installs": [{"bike_id": "bgrail", "from": (TODAY - timedelta(days=420)).isoformat()}],
             "tasks": [{"id": "t4", "name": "Csere", "unit": "km", "interval": 4000}]},
            {"id": "c3", "name": "Fékbetét (első)", "kind": "brake", "brand": "Shimano",
             "installs": [{"bike_id": "btrek", "from": (TODAY - timedelta(days=300)).isoformat()}],
             "tasks": [{"id": "t5", "name": "Csere", "unit": "km", "interval": 2400}]}],
        "logs": [{"id": "l1", "target_type": "component", "target_id": "c1", "task_id": "t2", "task_name": "Láncolajozás",
                  "date": (TODAY - timedelta(days=4)).isoformat(), "cost": 0, "note": "viasz"},
                 {"id": "l2", "target_type": "bike", "target_id": "bgrail", "task_id": "t1", "task_name": "Nagyszerviz",
                  "date": (TODAY - timedelta(days=120)).isoformat(), "cost": 32000, "note": "csapágyak, bowdenek"}]}
    requests.put(f"{API}/gear", headers=me, json=gear, timeout=30).raise_for_status()
    for bid, url in (("bgrail", "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e6/Canyon_Grail_CFT%2C_Koblenz_%28LRM_20231021_130252%29.jpg/960px-Canyon_Grail_CFT%2C_Koblenz_%28LRM_20231021_130252%29.jpg"),
                     ("btrek", "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/33/2012_Trek_1.1_Road_Bike.jpg/960px-2012_Trek_1.1_Road_Bike.jpg")):
        r = requests.post(f"{API}/gear/photo/bike/{bid}/from-url", headers=me, json={"url": url}, timeout=60)
        print("  bringafotó:", bid, r.status_code)
    r = requests.post(f"{API}/gear/devices/auto-photos", headers=me, timeout=120)
    print("  eszközképek:", r.status_code, r.json().get("pending") if r.ok else r.text[:200])
    print(f"Kész: {len(saved)} edzés, {len(PLANS)} terv. Belépés: {DEMO_USER} / {DEMO_PASS}")
    if "DEMO_PASS" not in ENV and not os.environ.get("DEMO_PASS"):
        with open(ROOT / "tests/.env", "a") as f:
            f.write(f"\nDEMO_USER={DEMO_USER}\nDEMO_PASS={DEMO_PASS}\n")
        print("A belépési adatok a tests/.env fájlba kerültek (git-ignored).")


if __name__ == "__main__":
    sys.exit(main())
