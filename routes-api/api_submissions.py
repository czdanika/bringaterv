"""Bringaterv API – közösségi útvonalak: beküldés és admin jóváhagyás.

A felhasználó egy mentett útvonalát vagy edzését beküldheti a közösségi útvonalak
(korábban: minta útvonalak) közé egy űrlappal (név, leírás, típus, nehézség,
évszak). Az admin értesítést kap, az admin felületen szerkesztheti és jóváhagyja
vagy elutasítja; jóváhagyáskor a nyomvonal a közösségi útvonalak közé kerül
(CUSTOM_SAMPLES_DIR), a beküldő pedig értesítést kap az eredményről.

Adatvédelem: a beküldött nyomvonalból csak a koordináták és a magasság maradnak
meg – időbélyeg, pulzus, kadencia, teljesítmény és egyéb kiterjesztés nem.

  POST   /api/submissions                       beküldés (bejelentkezett felhasználó)
  GET    /api/submissions                       saját beküldések állapota
  GET    /api/admin/submissions                 lista (admin)
  GET    /api/admin/submissions/<id>/gpx        a megtisztított nyomvonal (admin előnézet)
  PATCH  /api/admin/submissions/<id>            adatok szerkesztése (admin)
  POST   /api/admin/submissions/<id>/approve    jóváhagyás → közösségi útvonal
  POST   /api/admin/submissions/<id>/reject     elutasítás (indoklással)
  DELETE /api/admin/submissions/<id>            törlés (admin)
"""

import json
import math
import os
import re
import threading
import unicodedata
import uuid
from xml.sax.saxutils import escape

from flask import Blueprint, abort, g, jsonify, request

import geo_location
import mail_templates
import mailer
import notify
from auth import require_admin, require_auth
from config import CUSTOM_SAMPLES_DIR, MULTI_DATA_DIR, log
from db import _db
from storage import _resolve_dirs
from utils import _load_index, _now_dt, _safe_id

bp = Blueprint("api_submissions", __name__)

TYPES = {"asphalt": "Aszfalt", "gravel": "Gravel", "mtb": "MTB", "hiking": "Túra"}
DIFFICULTIES = {"easy": "Könnyű", "medium": "Közepes", "hard": "Nehéz"}
SEASONS = {"all": "Egész évben", "spring-autumn": "Tavasztól őszig", "summer": "Nyáron", "dry": "Száraz időben"}
_DIR = os.path.join(os.path.dirname(MULTI_DATA_DIR.rstrip("/")) or "/data", "submissions")
_ID_RE = re.compile(r"[a-f0-9]{12}")
_PT_RE = re.compile(r'<(trkpt|rtept)\b([^>]*?)(/>|>(.*?)</\1>)', re.S)
_ATTR_RE = lambda name: re.compile(rf'\b{name}="([-\d.]+)"')
_ELE_RE = re.compile(r"<ele>\s*([-\d.]+)\s*</ele>")


# ── Nyomvonal megtisztítása ──────────────────────────────────────────────────

def _clean_points(gpx_text: str) -> list:
    """[(lat, lon, ele|None), …] – csak koordináta és magasság, minden más eldobva."""
    pts = []
    lat_re, lon_re = _ATTR_RE("lat"), _ATTR_RE("lon")
    for m in _PT_RE.finditer(gpx_text):
        attrs, inner = m.group(2), m.group(4) or ""
        la, lo = lat_re.search(attrs), lon_re.search(attrs)
        if not la or not lo:
            continue
        try:
            lat, lon = float(la.group(1)), float(lo.group(1))
        except ValueError:
            continue
        e = _ELE_RE.search(inner)
        pts.append((lat, lon, float(e.group(1)) if e else None))
    return pts


def _clean_gpx(name: str, pts: list) -> str:
    seg = "\n".join(
        f'      <trkpt lat="{lat:.6f}" lon="{lon:.6f}">' + (f"<ele>{ele:.1f}</ele>" if ele is not None else "") + "</trkpt>"
        for lat, lon, ele in pts)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<gpx version="1.1" creator="Bringaterv" xmlns="http://www.topografix.com/GPX/1/1">\n'
            f'  <metadata><name>{escape(name)}</name></metadata>\n'
            f'  <trk>\n    <name>{escape(name)}</name>\n    <trkseg>\n{seg}\n    </trkseg>\n  </trk>\n</gpx>\n')


def _stats(pts: list) -> tuple:
    """(táv km, szintemelkedés m) – a szintnél 3 m-es hiszterézissel a zaj ellen."""
    dist = 0.0
    for (a, b, _), (c, d, _) in zip(pts, pts[1:]):
        p1, p2 = math.radians(a), math.radians(c)
        h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(d - b) / 2) ** 2
        dist += 2 * 6371000 * math.asin(math.sqrt(h))
    gain, ref = 0.0, None
    for _, _, e in pts:
        if e is None:
            continue
        if ref is None:
            ref = e
        elif e - ref >= 3:
            gain += e - ref; ref = e
        elif e < ref:
            ref = e
    return round(dist / 1000, 1), int(round(gain))


# ── Értesítések ──────────────────────────────────────────────────────────────

def _notify_async(fn, *args):
    threading.Thread(target=fn, args=args, daemon=True).start()


def _notify_admins(sub: dict) -> None:
    base = (os.environ.get("PUBLIC_URL") or "").rstrip("/")
    with _db() as conn:
        admins = [r["id"] for r in conn.execute("SELECT id FROM users WHERE role = 'admin' AND active = 1")]
    for uid in admins:
        try:
            notify.send(uid, "submission", "Új beküldött útvonal", f"{sub['name']} – {sub['user_name'] or ''}",
                        url="./admin#submissions", tag=f"sub-{sub['id']}", force=True)
        except Exception as exc:
            log.warning("Beküldés push hiba: %s", exc)
    if mailer.status()["configured"]:
        try:
            details = [("Beküldő", f"{sub['user_name'] or '-'} ({sub['user_email'] or '-'})"),
                       ("Típus", TYPES.get(sub["route_type"], sub["route_type"])),
                       ("Táv / szint", f"{sub['distance_km']} km · {sub['elevation_m']} m")]
            if sub["difficulty"]:
                details.append(("Nehézség", DIFFICULTIES.get(sub["difficulty"], sub["difficulty"])))
            mailer.send(f"[Bringaterv] Beküldött útvonal: {sub['name']}",
                        f"Új útvonalat küldtek be a közösségi útvonalak közé.\n\n{sub['name']}\n\n{sub['description']}\n\n"
                        f"Jóváhagyás: {base}/admin#submissions",
                        html=mail_templates.render(
                            sub["name"], sub["description"] or "(nincs leírás)", details=details,
                            button=("Megnézem és jóváhagyom", f"{base}/admin#submissions") if base else None,
                            note="Jóváhagyás előtt a leírás és az adatok szerkeszthetők.", no_reply=False))
        except Exception as exc:
            log.warning("Beküldés e-mail hiba: %s", exc)


def _notify_submitter(sub: dict, approved: bool, reason: str = "") -> None:
    if not sub.get("user_id"):
        return
    title = "Útvonalad bekerült a közösségiek közé" if approved else "Beküldött útvonalad nem került be"
    body = (f"„{sub['name']}” mostantól mindenki számára elérhető a Könyvtár → Közösségi útvonalak között. Köszönjük!"
            if approved else f"„{sub['name']}” most nem került be." + (f" Indoklás: {reason}" if reason else ""))
    try:
        notify.send(sub["user_id"], "submission_result", title, body, url="./index.html", tag=f"subres-{sub['id']}", force=True)
    except Exception as exc:
        log.warning("Beküldés-eredmény push hiba: %s", exc)
    with _db() as conn:
        u = conn.execute("SELECT contact_email, email_verified_at, name, first_name FROM users WHERE id = ?",
                         (sub["user_id"],)).fetchone()
    if u and u["contact_email"] and mailer.status()["configured"]:
        first = (u["first_name"] or "").strip() or ((u["name"] or "").split(" ")[-1] if u["name"] else "")
        hello = f"Szia {first}!" if first else "Szia!"
        base = (os.environ.get("PUBLIC_URL") or "").rstrip("/")
        try:
            mailer.send(f"Bringaterv – {title}", f"{hello}\n\n{body}\n\nBringaterv", to=[u["contact_email"]],
                        html=mail_templates.render(title, f"{hello}\n\n{body}",
                                                   button=("Bringaterv megnyitása", base) if (approved and base) else None))
        except Exception as exc:
            log.warning("Beküldés-eredmény e-mail hiba: %s", exc)


# ── Felhasználói végpontok ───────────────────────────────────────────────────

def _clean_location(loc) -> dict:
    """Szerkesztett / számolt helyadat egységesítése (csak az ismert mezők)."""
    if not isinstance(loc, dict):
        return {}
    def txt(v): return str(v or "").strip()[:80]
    places = loc.get("places") or []
    if isinstance(places, str):
        places = [p.strip() for p in places.split(",")]
    countries = loc.get("countries") or []
    if isinstance(countries, str):
        countries = [p.strip() for p in countries.split(",")]
    out = {
        "country": txt(loc.get("country")), "country_code": txt(loc.get("country_code")).lower()[:2],
        "region": txt(loc.get("region")), "settlement": txt(loc.get("settlement")),
        "places": [txt(p) for p in places if txt(p)][:30],
        "countries": [txt(c) for c in countries if txt(c)][:10],
        "loop": bool(loc.get("loop")),
    }
    if out["country"] and out["country"] not in out["countries"]:
        out["countries"].insert(0, out["country"])
    st = loc.get("start")
    if isinstance(st, (list, tuple)) and len(st) == 2:
        try:
            out["start"] = [round(float(st[0]), 5), round(float(st[1]), 5)]
        except (TypeError, ValueError):
            pass
    return out


def _locate_submission(sid: str) -> None:
    """Háttérszál: a beküldött nyomvonal helyadata (Nominatim), utána mentés."""
    try:
        with open(os.path.join(_DIR, f"{sid}.gpx"), encoding="utf-8") as f:
            pts = _clean_points(f.read())
        loc = geo_location.locate(pts)
        if loc:
            with _db() as conn:
                conn.execute("UPDATE route_submissions SET location = ? WHERE id = ? AND location = ''",
                             (json.dumps(loc, ensure_ascii=False), sid))
    except Exception as exc:
        log.warning("Beküldés helyadat hiba (%s): %s", sid, exc)


def _public(r) -> dict:
    d = dict(r)
    try:
        d["location"] = json.loads(d.get("location") or "{}")
    except json.JSONDecodeError:
        d["location"] = {}
    d["type_label"] = TYPES.get(d["route_type"], d["route_type"])
    d["difficulty_label"] = DIFFICULTIES.get(d["difficulty"], "")
    d["season_label"] = SEASONS.get(d["season"], "")
    d["author_display"] = ((d.get("author_alias") or d.get("user_name") or "") if d.get("show_author") else "")
    return d


@bp.route("/api/submissions", methods=["POST"])
@require_auth
def submit_route():
    body = request.get_json(silent=True) or {}
    rid = _safe_id(str(body.get("route_id") or ""))
    name = (body.get("name") or "").strip()[:100]
    description = (body.get("description") or "").strip()[:4000]
    route_type = body.get("type") if body.get("type") in TYPES else "asphalt"
    difficulty = body.get("difficulty") if body.get("difficulty") in DIFFICULTIES else ""
    season = body.get("season") if body.get("season") in SEASONS else ""
    # Megjelenés: anonymous | name | alias (becenév)
    author_mode = body.get("author_mode") if body.get("author_mode") in ("anonymous", "name", "alias") else (
        "name" if body.get("show_author", True) else "anonymous")
    author_alias = (body.get("author_alias") or "").strip()[:40] if author_mode == "alias" else ""
    if author_mode == "alias" and len(author_alias) < 2:
        abort(400, description="Add meg a becenevet, vagy válaszd a névtelen / saját név lehetőséget.")
    show_author = author_mode != "anonymous"
    if not rid:
        abort(400, description="Hiányzik az útvonal.")
    if len(name) < 3:
        abort(400, description="Adj meg egy nevet az útvonalnak.")
    if len(description) < 20:
        abort(400, description="Írj egy rövid leírást (legalább 1–2 mondat): milyen az út, mire figyeljenek.")

    user_dir, idx = _resolve_dirs()
    entry = next((e for e in _load_index(idx) if e.get("id") == rid), None)
    gpx_path = os.path.join(user_dir, f"{rid}.gpx")
    if not entry or not os.path.isfile(gpx_path):
        abort(404, description="Az útvonal nem található a könyvtáradban.")
    with open(gpx_path, encoding="utf-8") as f:
        pts = _clean_points(f.read())
    if len(pts) < 10:
        abort(400, description="Ennek az elemnek nincs használható nyomvonala.")
    dist, gain = _stats(pts)

    u = g.user
    with _db() as conn:
        if conn.execute("SELECT 1 FROM route_submissions WHERE user_id = ? AND source_id = ? AND status = 'pending'",
                        (u["id"], rid)).fetchone():
            abort(409, description="Ezt az útvonalat már beküldted, jóváhagyásra vár.")
        if conn.execute("SELECT COUNT(*) FROM route_submissions WHERE user_id = ? AND status = 'pending'",
                        (u["id"],)).fetchone()[0] >= 10:
            abort(429, description="Egyszerre legfeljebb 10 beküldésed várhat jóváhagyásra.")
        sid = uuid.uuid4().hex[:12]
        os.makedirs(_DIR, exist_ok=True)
        with open(os.path.join(_DIR, f"{sid}.gpx"), "w", encoding="utf-8") as f:
            f.write(_clean_gpx(name, pts))
        sub = {
            "id": sid, "created_at": _now_dt(), "user_id": u["id"], "user_name": u.get("name"),
            "user_email": u.get("contact_email") or u.get("email"), "source_id": rid,
            "source_kind": "workout" if (entry.get("strava_id") or entry.get("start_time") or entry.get("type") == "workout") else "route",
            "name": name, "description": description, "route_type": route_type, "difficulty": difficulty,
            "season": season, "show_author": 1 if show_author else 0, "author_alias": author_alias,
            "distance_km": dist, "elevation_m": gain,
        }
        conn.execute(f"INSERT INTO route_submissions ({', '.join(sub)}) VALUES ({', '.join('?' * len(sub))})",
                     tuple(sub.values()))
    _notify_async(_notify_admins, sub)
    _notify_async(_locate_submission, sid)
    log.info("Útvonal beküldve (%s): %s", u["id"], name)
    return jsonify({"ok": True, "id": sid}), 201


@bp.route("/api/submissions", methods=["GET"])
@require_auth
def my_submissions():
    with _db() as conn:
        rows = conn.execute("SELECT * FROM route_submissions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100",
                            (g.user["id"],)).fetchall()
    return jsonify([_public(r) for r in rows])


# ── Admin végpontok ──────────────────────────────────────────────────────────

def _get(conn, sid: str):
    if not _ID_RE.fullmatch(sid or ""):
        abort(404)
    r = conn.execute("SELECT * FROM route_submissions WHERE id = ?", (sid,)).fetchone()
    if not r:
        abort(404, description="Nincs ilyen beküldés.")
    return r


@bp.route("/api/admin/submissions", methods=["GET"])
@require_auth
@require_admin
def admin_list_submissions():
    with _db() as conn:
        rows = conn.execute("SELECT * FROM route_submissions ORDER BY created_at DESC LIMIT 300").fetchall()
    return jsonify({"items": [_public(r) for r in rows], "types": TYPES, "difficulties": DIFFICULTIES, "seasons": SEASONS})


@bp.route("/api/admin/submissions/<sid>/gpx", methods=["GET"])
@require_auth
@require_admin
def admin_submission_gpx(sid: str):
    with _db() as conn:
        _get(conn, sid)
    path = os.path.join(_DIR, f"{sid}.gpx")
    if not os.path.isfile(path):
        abort(404)
    with open(path, encoding="utf-8") as f:
        return f.read(), 200, {"Content-Type": "application/gpx+xml; charset=utf-8"}


def _apply_edits(conn, sid: str, data: dict) -> None:
    upd = {}
    if "name" in data:
        n = (data.get("name") or "").strip()[:100]
        if len(n) < 3:
            abort(400, description="A név legalább 3 karakter legyen.")
        upd["name"] = n
    if "description" in data:
        upd["description"] = (data.get("description") or "").strip()[:4000]
    if data.get("type") in TYPES:
        upd["route_type"] = data["type"]
    if "difficulty" in data and (data["difficulty"] in DIFFICULTIES or data["difficulty"] == ""):
        upd["difficulty"] = data["difficulty"]
    if "season" in data and (data["season"] in SEASONS or data["season"] == ""):
        upd["season"] = data["season"]
    if "show_author" in data:
        upd["show_author"] = 1 if data["show_author"] else 0
    if "author_alias" in data:
        upd["author_alias"] = (data.get("author_alias") or "").strip()[:40]
    if isinstance(data.get("location"), dict):
        # A számolt adatokat (rajtpont, körtúra) megtartjuk, csak a szerkeszthető mezők íródnak felül
        cur = conn.execute("SELECT location FROM route_submissions WHERE id = ?", (sid,)).fetchone()
        try:
            base = json.loads(cur["location"] or "{}") if cur else {}
        except json.JSONDecodeError:
            base = {}
        upd["location"] = json.dumps(_clean_location({**base, **data["location"]}), ensure_ascii=False)
    if upd:
        conn.execute(f"UPDATE route_submissions SET {', '.join(f'{k} = ?' for k in upd)} WHERE id = ?",
                     (*upd.values(), sid))


@bp.route("/api/admin/submissions/<sid>", methods=["PATCH"])
@require_auth
@require_admin
def admin_update_submission(sid: str):
    with _db() as conn:
        _get(conn, sid)
        _apply_edits(conn, sid, request.get_json(silent=True) or {})
        return jsonify(_public(_get(conn, sid)))


@bp.route("/api/admin/submissions/<sid>/approve", methods=["POST"])
@require_auth
@require_admin
def admin_approve_submission(sid: str):
    with _db() as conn:
        r = _get(conn, sid)
        if r["status"] == "approved":
            abort(409, description="Már jóvá van hagyva.")
        _apply_edits(conn, sid, request.get_json(silent=True) or {})   # a jóváhagyás előtti utolsó szerkesztés is
        r = dict(_get(conn, sid))
        src = os.path.join(_DIR, f"{sid}.gpx")
        if not os.path.isfile(src):
            abort(404, description="A beküldött nyomvonal fájlja hiányzik.")
        ascii_name = unicodedata.normalize("NFKD", r["name"].lower()).encode("ascii", "ignore").decode()
        slug = _safe_id(re.sub(r"\s+", "-", ascii_name))[:40].strip("-") or "utvonal"
        sample_id = f"{slug}-{sid[:6]}"
        os.makedirs(CUSTOM_SAMPLES_DIR, exist_ok=True)
        with open(src, encoding="utf-8") as f:
            gpx = f.read()
        with open(os.path.join(CUSTOM_SAMPLES_DIR, f"{sample_id}.gpx"), "w", encoding="utf-8") as f:
            f.write(gpx)
        meta = {
            "name": r["name"], "type": r["route_type"], "description": r["description"],
            "distance": r["distance_km"], "elevation": r["elevation_m"],
            "difficulty": r["difficulty"], "season": r["season"],
            "author": ((r.get("author_alias") or r["user_name"] or "") if r["show_author"] else ""),
            "community": True, "submission_id": sid, "approved_at": _now_dt(),
        }
        try:
            loc = json.loads(r.get("location") or "{}")
        except json.JSONDecodeError:
            loc = {}
        if not loc:
            loc = geo_location.locate(_clean_points(gpx)) or {}
        if loc:
            meta["location"] = _clean_location(loc)
        with open(os.path.join(CUSTOM_SAMPLES_DIR, f"{sample_id}.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        conn.execute("UPDATE route_submissions SET status = 'approved', reviewed_at = ?, sample_id = ?, admin_note = '' "
                     "WHERE id = ?", (_now_dt(), sample_id, sid))
        r = dict(_get(conn, sid))
    _notify_async(_notify_submitter, r, True)
    log.info("Beküldés jóváhagyva (%s) → közösségi útvonal: %s", sid, sample_id)
    return jsonify(_public(r))


@bp.route("/api/admin/submissions/<sid>/reject", methods=["POST"])
@require_auth
@require_admin
def admin_reject_submission(sid: str):
    reason = ((request.get_json(silent=True) or {}).get("reason") or "").strip()[:1000]
    with _db() as conn:
        r = _get(conn, sid)
        if r["status"] == "approved":
            abort(409, description="Jóváhagyott beküldés nem utasítható el – a közösségi útvonalak között törölhető.")
        conn.execute("UPDATE route_submissions SET status = 'rejected', reviewed_at = ?, admin_note = ? WHERE id = ?",
                     (_now_dt(), reason, sid))
        r = dict(_get(conn, sid))
    _notify_async(_notify_submitter, r, False, reason)
    return jsonify(_public(r))


@bp.route("/api/admin/submissions/<sid>", methods=["DELETE"])
@require_auth
@require_admin
def admin_delete_submission(sid: str):
    with _db() as conn:
        _get(conn, sid)
        conn.execute("DELETE FROM route_submissions WHERE id = ?", (sid,))
    try:
        os.remove(os.path.join(_DIR, f"{sid}.gpx"))
    except OSError:
        pass
    return jsonify({"ok": True})
