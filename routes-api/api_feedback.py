"""Bringaterv API – visszajelzések (hibajelentés, ötlet, kérdés).

  POST   /api/feedback                    bejelentkezett felhasználó küldi (multipart)
  GET    /api/admin/feedback              lista (admin)
  PATCH  /api/admin/feedback/<id>         állapot: new | done (admin)
  DELETE /api/admin/feedback/<id>         törlés (admin)
  GET    /api/admin/feedback/<id>/image   csatolt képernyőkép (admin)
  GET    /api/admin/mail                  e-mail beállítás állapota (admin)
  POST   /api/admin/mail/test             teszt e-mail (admin)

A visszajelzés mindig az adatbázisba kerül; ha az SMTP be van állítva, e-mailben
is elmegy (háttérszálon), és az adminok push értesítést kapnak.
"""

import json
import os
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from flask import Blueprint, abort, g, jsonify, request, send_file

import mail_templates
import mailer
import notify
from auth import require_admin, require_auth
from config import MULTI_DATA_DIR, log
from db import _db
from utils import _now_dt

bp = Blueprint("api_feedback", __name__)

CATEGORIES = {"bug": "Hiba", "idea": "Ötlet, javaslat", "question": "Kérdés", "other": "Egyéb",
              "account_deleted": "Fióktörlés"}
USER_CATEGORIES = ("bug", "idea", "question", "other")   # ezek közül választhat a felhasználó
AREAS = {
    "planning": "Tervezés", "analysis": "Elemzés", "library": "Könyvtár",
    "stats": "Statisztikák, rekordok", "sync": "Strava / Garmin", "share": "Megosztás",
    "mobile": "Mobil, telepített app", "settings": "Beállítások, fiók", "other": "Egyéb",
}
MAX_IMAGE = 8 * 1024 * 1024
PER_HOUR = 10
_DIR = os.path.join(os.path.dirname(MULTI_DATA_DIR.rstrip("/")) or "/data", "feedback")
_ID_RE = re.compile(r"[a-f0-9]{12}")


def _image_type(data: bytes) -> tuple[str, str] | None:
    """(kiterjesztés, MIME) a fájl tartalmából – csak képet fogadunk el."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp", "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif", "image/gif"
    if data[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1", b"ftyphevc"):
        return "heic", "image/heic"
    return None


def _row(r) -> dict:
    d = dict(r)
    try:
        d["tech"] = json.loads(d.get("tech") or "{}")
    except json.JSONDecodeError:
        d["tech"] = {}
    d["category_label"] = CATEGORIES.get(d["category"], d["category"])
    d["area_label"] = AREAS.get(d["area"], d["area"])
    d["has_image"] = bool(d.pop("attachment", None))
    return d


def _local_time(iso: str) -> str:
    try:
        dt = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        return dt.astimezone(ZoneInfo(os.environ.get("TZ") or "Europe/Budapest")).strftime("%Y.%m.%d. %H:%M")
    except Exception:
        return iso


def _mail_text(fb: dict) -> str:
    lines = [
        f"{CATEGORIES.get(fb['category'])} – {AREAS.get(fb['area'], 'Egyéb')}",
        f"Cím: {fb['title']}",
        f"Beküldő: {fb['user_name'] or '-'} ({fb['user_email'] or '-'})",
        f"Időpont: {_local_time(fb['created_at'])}",
        "",
        fb["description"],
        "",
    ]
    if fb["tech"]:
        lines.append("── Technikai adatok ──")
        lines += [f"{k}: {v}" for k, v in fb["tech"].items()]
        lines.append("")
    lines.append(f"Azonosító: {fb['id']} · Az admin felület Visszajelzések fülén is megtalálod.")
    return "\n".join(lines)


def record_account_deletion(user: dict, reason: str, comment: str) -> None:
    """Önálló fióktörlés: visszajelzésként elmentjük (miért törölte), és az adminok
    e-mailt / pusht kapnak róla. A fiók adatai ekkor már törlődnek."""
    fid = uuid.uuid4().hex[:12]
    fb = {
        "id": fid, "created_at": _now_dt(), "user_id": user["id"],
        "user_email": user.get("contact_email") or user.get("email"), "user_name": user.get("name"),
        "category": "account_deleted", "area": "settings",
        "title": f"Ok: {reason}"[:140],
        "description": (comment or "(nem írt megjegyzést)")[:8000],
        "tech": {"Belépési név": user.get("email") or "", "Regisztrált": user.get("created_at") or "",
                 "Utolsó belépés": user.get("last_login_at") or "", "Belépések": str(user.get("login_count") or 0)},
    }
    with _db() as conn:
        conn.execute(
            "INSERT INTO feedback (id, created_at, user_id, user_email, user_name, category, area, "
            "title, description, tech) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (fid, fb["created_at"], user["id"], fb["user_email"], fb["user_name"], fb["category"], fb["area"],
             fb["title"], fb["description"], json.dumps(fb["tech"], ensure_ascii=False)))
    threading.Thread(target=_deliver, args=(fb, None), daemon=True).start()


def _deliver(fb: dict, image: tuple[str, bytes, str] | None) -> None:
    """Háttérszál: e-mail + push az adminoknak."""
    err = ""
    if mailer.status()["configured"]:
        try:
            reply = fb["user_email"] if "@" in (fb["user_email"] or "") else None
            details = [("Típus", CATEGORIES.get(fb["category"])), ("Terület", AREAS.get(fb["area"], "Egyéb")),
                       ("Beküldő", f"{fb['user_name'] or '-'} ({fb['user_email'] or '-'})"),
                       ("Időpont", _local_time(fb["created_at"]))]
            details += [(k, v) for k, v in (fb["tech"] or {}).items()]
            base = (os.environ.get("PUBLIC_URL") or "").rstrip("/")
            html = mail_templates.render(
                fb["title"], fb["description"], details=details,
                button=("Megnyitás az admin felületen", f"{base}/admin#feedback") if base else None,
                note=("A képernyőkép csatolmányként érkezik. " if image else "")
                     + ("Válaszolj erre a levélre, és a beküldő megkapja." if reply else ""),
                no_reply=False)
            mailer.send(f"[Bringaterv] {CATEGORIES.get(fb['category'])}: {fb['title']}",
                        _mail_text(fb), reply_to=reply, attachments=[image] if image else None, html=html)
        except Exception as exc:
            err = str(exc)[:300]
            log.warning("Visszajelzés e-mail hiba (%s): %s", fb["id"], exc)
    else:
        err = "nincs beállítva"
    with _db() as conn:
        conn.execute("UPDATE feedback SET emailed = ?, mail_error = ? WHERE id = ?",
                     (0 if err else 1, err, fb["id"]))
        admins = [r["id"] for r in conn.execute("SELECT id FROM users WHERE role = 'admin' AND active = 1")]
    for uid in admins:
        try:
            notify.send(uid, "feedback", f"Új visszajelzés – {CATEGORIES.get(fb['category'])}",
                        fb["title"], url="./admin#feedback", tag=f"feedback-{fb['id']}", force=True)
        except Exception as exc:
            log.warning("Visszajelzés push hiba: %s", exc)


@bp.route("/api/feedback", methods=["POST"])
@require_auth
def submit_feedback():
    f = request.form
    category = f.get("category", "")
    area = f.get("area", "other")
    title = (f.get("title") or "").strip()[:140]
    description = (f.get("description") or "").strip()[:8000]
    if category not in USER_CATEGORIES:
        abort(400, description="Válassz típust.")
    if area not in AREAS:
        area = "other"
    if len(title) < 3:
        abort(400, description="Adj meg egy rövid címet.")
    if len(description) < 5:
        abort(400, description="Írd le röviden, mi történt.")

    tech = {}
    if f.get("tech"):
        try:
            raw = json.loads(f["tech"][:6000])
            if isinstance(raw, dict):
                tech = {str(k)[:40]: str(v)[:300] for k, v in list(raw.items())[:25]}
        except json.JSONDecodeError:
            pass
        tech["User-Agent"] = request.headers.get("User-Agent", "")[:300]

    image = None
    file = request.files.get("image")
    if file and file.filename:
        data = file.read(MAX_IMAGE + 1)
        if len(data) > MAX_IMAGE:
            abort(400, description="A kép legfeljebb 8 MB lehet.")
        kind = _image_type(data)
        if not kind:
            abort(400, description="Csak képet lehet csatolni (PNG, JPG, WEBP, GIF, HEIC).")
        image = (kind[0], data, kind[1])   # (kiterjesztés, tartalom, MIME)

    user = g.user
    since = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with _db() as conn:
        n = conn.execute("SELECT COUNT(*) FROM feedback WHERE user_id = ? AND created_at >= ?",
                         (user["id"], since)).fetchone()[0]
        if n >= PER_HOUR:
            abort(429, description="Túl sok visszajelzés egy órán belül – próbáld később.")

        fid = uuid.uuid4().hex[:12]
        attachment = None
        if image:
            os.makedirs(_DIR, exist_ok=True)
            attachment = f"{fid}.{image[0]}"
            with open(os.path.join(_DIR, attachment), "wb") as fh:
                fh.write(image[1])
        fb = {
            "id": fid, "created_at": _now_dt(), "user_id": user["id"],
            "user_email": user.get("email"), "user_name": user.get("name"),
            "category": category, "area": area, "title": title, "description": description,
            "tech": tech,
        }
        conn.execute(
            "INSERT INTO feedback (id, created_at, user_id, user_email, user_name, category, area, "
            "title, description, tech, attachment) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (fid, fb["created_at"], user["id"], fb["user_email"], fb["user_name"], category, area,
             title, description, json.dumps(tech, ensure_ascii=False), attachment))

    mail_image = (f"kepernyokep.{image[0]}", image[1], image[2]) if image else None
    threading.Thread(target=_deliver, args=(fb, mail_image), daemon=True).start()
    log.info("Új visszajelzés (%s, %s): %s", category, user["id"], title)
    return jsonify({"ok": True, "id": fid}), 201


# ── Admin ─────────────────────────────────────────────────────────────────────

def _get(conn, fid: str):
    if not _ID_RE.fullmatch(fid or ""):
        abort(404)
    r = conn.execute("SELECT * FROM feedback WHERE id = ?", (fid,)).fetchone()
    if not r:
        abort(404, description="Nincs ilyen visszajelzés")
    return r


@bp.route("/api/admin/feedback", methods=["GET"])
@require_auth
@require_admin
def list_feedback():
    with _db() as conn:
        rows = conn.execute("SELECT * FROM feedback ORDER BY created_at DESC LIMIT 500").fetchall()
    return jsonify({"items": [_row(r) for r in rows], "mail": mailer.status(),
                    "categories": CATEGORIES, "areas": AREAS})


@bp.route("/api/admin/feedback/<fid>", methods=["PATCH"])
@require_auth
@require_admin
def update_feedback(fid: str):
    status = (request.get_json(silent=True) or {}).get("status")
    if status not in ("new", "done"):
        abort(400, description="Érvénytelen állapot")
    with _db() as conn:
        _get(conn, fid)
        conn.execute("UPDATE feedback SET status = ? WHERE id = ?", (status, fid))
        r = _get(conn, fid)
    return jsonify(_row(r))


@bp.route("/api/admin/feedback/<fid>", methods=["DELETE"])
@require_auth
@require_admin
def delete_feedback(fid: str):
    with _db() as conn:
        r = _get(conn, fid)
        conn.execute("DELETE FROM feedback WHERE id = ?", (fid,))
    if r["attachment"]:
        try:
            os.remove(os.path.join(_DIR, r["attachment"]))
        except OSError:
            pass
    return jsonify({"ok": True})


@bp.route("/api/admin/feedback/<fid>/image", methods=["GET"])
@require_auth
@require_admin
def feedback_image(fid: str):
    with _db() as conn:
        r = _get(conn, fid)
    if not r["attachment"]:
        abort(404)
    path = os.path.join(_DIR, r["attachment"])
    if not os.path.isfile(path):
        abort(404)
    with open(path, "rb") as fh:
        head = fh.read(16)
    kind = _image_type(head) or ("bin", "application/octet-stream")
    return send_file(path, mimetype=kind[1])


@bp.route("/api/admin/mail", methods=["GET"])
@require_auth
@require_admin
def mail_status():
    return jsonify(mailer.status())


@bp.route("/api/admin/mail/test", methods=["POST"])
@require_auth
@require_admin
def mail_test():
    try:
        mailer.send("[Bringaterv] Teszt e-mail",
                    "Ez egy teszt üzenet a Bringaterv admin felületéről.\n"
                    "Ha megkaptad, a visszajelzések e-mailben is meg fognak érkezni.",
                    html=mail_templates.render(
                        "Teszt e-mail ✓",
                        "Ez egy teszt üzenet a Bringaterv admin felületéről.\n\n"
                        "Ha megkaptad, az e-mail-küldés működik: a visszajelzések, megerősítő kódok és "
                        "jelszó-visszaállító levelek is meg fognak érkezni."))
    except Exception as exc:
        abort(502, description=f"Nem sikerült elküldeni: {str(exc)[:300]}")
    return jsonify({"ok": True, "to": mailer.status()["to"]})
