"""Bringaterv API – saját fiók: e-mail-cím megerősítése, jelszócsere, elfelejtett jelszó.

  GET  /api/account                  fiók állapota (belépési név, e-mail, megerősítve-e)
  PUT  /api/account/email            értesítési e-mail-cím beállítása + megerősítő levél
  POST /api/account/email/resend     megerősítő levél újraküldése
  POST /api/account/verify           (nyilvános) megerősítés a levélben kapott linkkel
  POST /api/account/verify-code      megerősítés a levélben kapott 6 számjegyű kóddal
  PUT  /api/account/password         saját jelszó cseréje (a régi jelszóval)
  POST /api/auth/forgot              (nyilvános) jelszó-visszaállító levél kérése
  GET  /api/auth/reset/<token>       (nyilvános) a visszaállító link érvényes-e
  POST /api/auth/reset               (nyilvános) új jelszó a visszaállító tokennel

A tokenek véletlenszerűek, egyszer használhatók, és csak a SHA-256 lenyomatuk kerül
az adatbázisba (auth_tokens). Megerősítő link: 48 óra, visszaállító link: 60 perc.
A megerősítő levélben a link mellett egy 6 számjegyű kód is van (15 perc, legfeljebb
5 rossz próbálkozás) – telefonon / telepített appban kényelmesebb, nem kell ablakot váltani.
A levelekben lévő linkek alapcíme: PUBLIC_URL env, ha nincs megadva, a kérés címe.

Kötelező megerősítés: ha az e-mail küldés be van állítva (és REQUIRE_EMAIL_VERIFICATION
nem false), a meg nem erősített, nem admin felhasználók csak a fiók-végpontokat
érik el, amíg meg nem erősítik a címüket (lásd auth.require_auth).
"""

import hashlib
import os
import re
import secrets
import threading
from datetime import datetime, timedelta, timezone

from flask import Blueprint, abort, g, jsonify, request

import mail_templates
import mailer
from auth import require_auth
from config import log
from db import _db
from security import _check_pw, _hash_pw, _make_token
from utils import _now_dt

bp = Blueprint("api_account", __name__)

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")
VERIFY_HOURS = 48
CODE_MINUTES = 15
CODE_ATTEMPTS = 5
RESET_MINUTES = 60
MAX_PER_HOUR = 5


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def public_base() -> str:
    base = (os.environ.get("PUBLIC_URL") or "").strip().rstrip("/")
    if base:
        return base
    proto = request.headers.get("X-Forwarded-Proto", request.scheme).split(",")[0].strip()
    return f"{proto}://{request.host}"


def _issue(conn, user_id: str, kind: str, email: str, ttl: timedelta) -> str:
    raw = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    conn.execute("INSERT INTO auth_tokens (token_hash, user_id, kind, email, created_at, expires_at) "
                 "VALUES (?,?,?,?,?,?)", (_hash(raw), user_id, kind, email, _iso(now), _iso(now + ttl)))
    return raw


def _recent(conn, user_id: str, kind: str) -> int:
    since = _iso(datetime.now(timezone.utc) - timedelta(hours=1))
    return conn.execute("SELECT COUNT(*) FROM auth_tokens WHERE user_id = ? AND kind = ? AND created_at >= ?",
                        (user_id, kind, since)).fetchone()[0]


def _lookup(conn, raw: str, kind: str):
    """Érvényes (fel nem használt, le nem járt) token sora, vagy None."""
    if not raw or len(raw) > 200:
        return None
    r = conn.execute("SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = ?", (_hash(raw), kind)).fetchone()
    if not r or r["used_at"] or r["expires_at"] < _now_dt():
        return None
    return r


def _send_async(subject: str, text: str, to: str, html: str | None = None) -> None:
    def run():
        try:
            mailer.send(subject, text, to=[to], html=html)
        except Exception as exc:
            log.warning("Fiók e-mail hiba (%s): %s", to, exc)
    threading.Thread(target=run, daemon=True).start()


def _first(user: dict) -> str:
    """Megszólításhoz a keresztnév (ha nincs, a teljes név utolsó tagja)."""
    first = (user.get("first_name") or "").strip()
    if first:
        return first
    name = (user.get("name") or "").strip()
    return name.split(" ")[-1] if name else ""


def _hello(user: dict) -> str:
    first = _first(user)
    return f"Szia {first}!" if first else "Szia!"


def _code_hash(user_id: str, code: str) -> str:
    return _hash(f"code:{user_id}:{code}")


def send_verification(conn, user: dict, email: str, base: str) -> None:
    raw = _issue(conn, user["id"], "verify", email, timedelta(hours=VERIFY_HOURS))
    link = f"{base}/verify?t={raw}"
    # Új kód: a korábbi, még élő kódok érvénytelenek
    now = datetime.now(timezone.utc)
    conn.execute("UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND kind = 'verify_code' AND used_at IS NULL",
                 (_iso(now), user["id"]))
    code = f"{secrets.randbelow(1_000_000):06d}"
    conn.execute("INSERT OR REPLACE INTO auth_tokens (token_hash, user_id, kind, email, created_at, expires_at) "
                 "VALUES (?,?,?,?,?,?)", (_code_hash(user["id"], code), user["id"], "verify_code", email,
                                          _iso(now), _iso(now + timedelta(minutes=CODE_MINUTES))))
    _send_async(f"Bringaterv megerősítő kód: {code}", (
        f"{_hello(user)}\n\n"
        "A Bringaterv fiókod e-mail-címének megerősítéséhez írd be ezt a kódot az appban:\n\n"
        f"    {code}\n\n"
        f"A kód {CODE_MINUTES} percig érvényes.\n\n"
        "Vagy kattints erre a linkre:\n\n"
        f"{link}\n\n"
        f"(A link {VERIFY_HOURS} óráig érvényes.)\n\n"
        "Ha nem te kérted, hagyd figyelmen kívül ezt a levelet.\n\n"
        "Bringaterv"), email, mail_templates.render(
        "Erősítsd meg az e-mail-címed",
        f"{_hello(user)}\n\nA Bringaterv fiókod e-mail-címének megerősítéséhez írd be ezt a kódot az appban:",
        code=code, code_note=f"A kód {CODE_MINUTES} percig érvényes.",
        after="Gépen egyszerűbb lehet a gomb – ugyanazt teszi:",
        button=("E-mail-cím megerősítése", link),
        note=f"A gomb {VERIFY_HOURS} óráig érvényes. Ha nem te kérted, hagyd figyelmen kívül ezt a levelet.",
        preheader=f"A megerősítő kódod: {code}"))


def account_state(user: dict) -> dict:
    return {
        "login": user["email"],
        "name": user["name"],
        "email": user.get("contact_email"),
        "email_verified": bool(user.get("email_verified_at")),
        "verification_required": mailer.verification_required() and user.get("role") != "admin",
        "mail_configured": mailer.status()["configured"],
        "can_delete": user.get("role") != "admin",
    }


def _clean_email(raw) -> str:
    email = (raw or "").strip().lower()
    if not EMAIL_RE.match(email) or len(email) > 120:
        abort(400, description="Adj meg egy érvényes e-mail-címet.")
    return email


# ── Bejelentkezett felhasználó ────────────────────────────────────────────────

@bp.route("/api/account", methods=["GET"])
@require_auth
def get_account():
    return jsonify(account_state(g.user))


@bp.route("/api/account/email", methods=["PUT"])
@require_auth
def set_email():
    email = _clean_email((request.get_json(silent=True) or {}).get("email"))
    u = g.user
    if not mailer.status()["configured"]:
        abort(503, description="Az e-mail küldés nincs beállítva a szerveren – szólj az adminnak.")
    with _db() as conn:
        clash = conn.execute("SELECT id FROM users WHERE (contact_email = ? OR email = ?) AND id != ?",
                             (email, email, u["id"])).fetchone()
        if clash:
            abort(409, description="Ez az e-mail-cím már egy másik fiókhoz tartozik.")
        if _recent(conn, u["id"], "verify") >= MAX_PER_HOUR:
            abort(429, description="Túl sok kérés – próbáld újra egy óra múlva.")
        if email != (u.get("contact_email") or ""):
            conn.execute("UPDATE users SET contact_email = ?, email_verified_at = NULL WHERE id = ?", (email, u["id"]))
            u = {**u, "contact_email": email, "email_verified_at": None}
        if not u.get("email_verified_at"):
            send_verification(conn, u, email, public_base())
    log.info("E-mail-cím beállítva (%s): %s", u["id"], email)
    return jsonify({**account_state(u), "sent": not u.get("email_verified_at")})


@bp.route("/api/account/email/resend", methods=["POST"])
@require_auth
def resend_verification():
    u = g.user
    if not u.get("contact_email"):
        abort(400, description="Még nincs megadva e-mail-cím.")
    if u.get("email_verified_at"):
        return jsonify({**account_state(u), "sent": False})
    if not mailer.status()["configured"]:
        abort(503, description="Az e-mail küldés nincs beállítva a szerveren – szólj az adminnak.")
    with _db() as conn:
        if _recent(conn, u["id"], "verify") >= MAX_PER_HOUR:
            abort(429, description="Túl sok kérés – próbáld újra egy óra múlva.")
        send_verification(conn, u, u["contact_email"], public_base())
    return jsonify({**account_state(u), "sent": True})


@bp.route("/api/account/verify-code", methods=["POST"])
@require_auth
def verify_code():
    code = re.sub(r"\D", "", str((request.get_json(silent=True) or {}).get("code") or ""))
    u = g.user
    if u.get("email_verified_at"):
        return jsonify(account_state(u))
    if len(code) != 6:
        abort(400, description="A kód 6 számjegyből áll.")
    with _db() as conn:
        t = conn.execute("SELECT * FROM auth_tokens WHERE user_id = ? AND kind = 'verify_code' AND used_at IS NULL "
                         "ORDER BY created_at DESC LIMIT 1", (u["id"],)).fetchone()
        if not t or t["expires_at"] < _now_dt():
            abort(400, description="A kód lejárt – kérj újat a „Levél újraküldése” gombbal.")
        if t["attempts"] >= CODE_ATTEMPTS:
            abort(400, description="Túl sok hibás próbálkozás – kérj új kódot.")
        if not secrets.compare_digest(t["token_hash"], _code_hash(u["id"], code)):
            conn.execute("UPDATE auth_tokens SET attempts = attempts + 1 WHERE token_hash = ?", (t["token_hash"],))
            left = CODE_ATTEMPTS - t["attempts"] - 1
            # a hibás próbálkozás számlálója maradjon meg akkor is, ha az abort visszagörgetne
            conn.commit()
            abort(400, description=f"Hibás kód – még {left} próbálkozás." if left > 0
                  else "Hibás kód – túl sok próbálkozás, kérj új kódot.")
        if (u.get("contact_email") or "") != t["email"]:
            abort(400, description="Ez a kód egy korábbi e-mail-címhez tartozik – kérj újat.")
        now = _now_dt()
        conn.execute("UPDATE users SET email_verified_at = ? WHERE id = ?", (now, u["id"]))
        conn.execute("UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND kind IN ('verify', 'verify_code') "
                     "AND used_at IS NULL", (now, u["id"]))
    log.info("E-mail megerősítve kóddal (%s): %s", u["id"], t["email"])
    return jsonify(account_state({**u, "email_verified_at": now}))


@bp.route("/api/account/password", methods=["PUT"])
@require_auth
def change_password():
    body = request.get_json(silent=True) or {}
    current, new = body.get("current") or "", body.get("password") or ""
    if len(new) < 8:
        abort(400, description="Az új jelszó legalább 8 karakter legyen.")
    with _db() as conn:
        row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (g.user["id"],)).fetchone()
        if not _check_pw(current, row["password_hash"]):
            abort(403, description="A jelenlegi jelszó nem stimmel.")
        conn.execute("UPDATE users SET password_hash = ?, pw_changed_at = ? WHERE id = ?",
                     (_hash_pw(new), _now_dt(), g.user["id"]))
    log.info("Jelszócsere: %s", g.user["id"])
    # A többi eszközön kilép (régebbi token), ezen az eszközön új tokennel marad bent
    return jsonify({"ok": True, "token": _make_token(g.user["id"], g.user["email"], g.user["role"])})


# ── Nyilvános: megerősítés, elfelejtett jelszó ────────────────────────────────

@bp.route("/api/account/verify", methods=["POST"])
def verify_email():
    raw = (request.get_json(silent=True) or {}).get("token") or ""
    with _db() as conn:
        t = _lookup(conn, raw, "verify")
        if not t:
            abort(400, description="A megerősítő link érvénytelen vagy lejárt – kérj újat a Beállításokban.")
        u = conn.execute("SELECT * FROM users WHERE id = ? AND active = 1", (t["user_id"],)).fetchone()
        if not u or (u["contact_email"] or "") != t["email"]:
            abort(400, description="Ez a link egy korábbi e-mail-címhez tartozik – kérj újat a Beállításokban.")
        now = _now_dt()
        conn.execute("UPDATE users SET email_verified_at = ? WHERE id = ?", (now, u["id"]))
        conn.execute("UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND kind IN ('verify', 'verify_code') "
                     "AND used_at IS NULL", (now, u["id"]))
    log.info("E-mail megerősítve (%s): %s", u["id"], t["email"])
    return jsonify({"ok": True, "email": t["email"]})


@bp.route("/api/auth/forgot", methods=["POST"])
def forgot_password():
    login = ((request.get_json(silent=True) or {}).get("login") or "").strip().lower()
    generic = {"ok": True, "message": "Ha van ilyen fiók megerősített e-mail-címmel, elküldtük rá a visszaállító linket."}
    if not login or len(login) > 120 or not mailer.status()["configured"]:
        if not mailer.status()["configured"]:
            abort(503, description="Az e-mail küldés nincs beállítva – kérd az admint, hogy állítson be új jelszót.")
        return jsonify(generic)
    with _db() as conn:
        u = conn.execute("SELECT * FROM users WHERE active = 1 AND (email = ? OR contact_email = ?) "
                         "ORDER BY (email = ?) DESC LIMIT 1", (login, login, login)).fetchone()
        # Csak megerősített címre, vagy ha a belépési név maga az e-mail-cím
        to = None
        if u and u["contact_email"] and (u["email_verified_at"] or u["contact_email"] == u["email"]):
            to = u["contact_email"]
        if to and _recent(conn, u["id"], "reset") < 3:
            raw = _issue(conn, u["id"], "reset", to, timedelta(minutes=RESET_MINUTES))
            link = f"{public_base()}/reset?t={raw}"
            _send_async("Bringaterv – új jelszó beállítása", (
                f"{_hello(dict(u))}\n\n"
                "Valaki (remélhetőleg te) új jelszót kért a Bringaterv fiókodhoz.\n"
                f"Belépési neved: {u['email']}\n\n"
                f"Új jelszót ezen a linken állíthatsz be ({RESET_MINUTES} percig érvényes):\n\n{link}\n\n"
                "Ha nem te kérted, hagyd figyelmen kívül ezt a levelet – a jelszavad nem változik.\n\n"
                "Bringaterv"), to, mail_templates.render(
                "Új jelszó beállítása",
                f"{_hello(dict(u))}\n\nValaki (remélhetőleg te) új jelszót kért a Bringaterv fiókodhoz.",
                details=[("Belépési név", u["email"])],
                button=("Új jelszó beállítása", link),
                note=f"A gomb {RESET_MINUTES} percig érvényes és egyszer használható. Ha nem te kérted, "
                     "hagyd figyelmen kívül ezt a levelet – a jelszavad nem változik."))
            log.info("Jelszó-visszaállító link elküldve (%s)", u["id"])
        elif u:
            log.info("Jelszó-visszaállítás kérve, de nincs küldhető cím vagy túl sok kérés (%s)", u["id"])
    return jsonify(generic)


@bp.route("/api/auth/reset/<raw>", methods=["GET"])
def reset_check(raw: str):
    with _db() as conn:
        t = _lookup(conn, raw, "reset")
        if not t:
            return jsonify({"valid": False}), 404
        u = conn.execute("SELECT email FROM users WHERE id = ?", (t["user_id"],)).fetchone()
    return jsonify({"valid": True, "login": u["email"] if u else ""})


@bp.route("/api/auth/reset", methods=["POST"])
def reset_password():
    body = request.get_json(silent=True) or {}
    raw, new = body.get("token") or "", body.get("password") or ""
    if len(new) < 8:
        abort(400, description="Az új jelszó legalább 8 karakter legyen.")
    with _db() as conn:
        t = _lookup(conn, raw, "reset")
        if not t:
            abort(400, description="A link érvénytelen vagy lejárt – kérj újat.")
        u = conn.execute("SELECT * FROM users WHERE id = ? AND active = 1", (t["user_id"],)).fetchone()
        if not u:
            abort(400, description="A fiók nem elérhető.")
        now = _now_dt()
        conn.execute("UPDATE users SET password_hash = ?, pw_changed_at = ?, last_login_at = ?, "
                     "login_count = login_count + 1 WHERE id = ?", (_hash_pw(new), now, now, u["id"]))
        # A levél megérkezett erre a címre → a cím egyben meg is erősítve
        if (u["contact_email"] or "") == t["email"] and not u["email_verified_at"]:
            conn.execute("UPDATE users SET email_verified_at = ? WHERE id = ?", (now, u["id"]))
        conn.execute("UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND kind = 'reset' AND used_at IS NULL",
                     (now, u["id"]))
    log.info("Jelszó visszaállítva (%s)", u["id"])
    return jsonify({"token": _make_token(u["id"], u["email"], u["role"]),
                    "user": {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"]}})


# ── Saját fiók törlése ────────────────────────────────────────────────────────

DELETE_REASONS = {
    "not_using": "Nem használom",
    "missing_feature": "Hiányzik egy funkció",
    "hard_to_use": "Nehéz használni",
    "bugs": "Hibák miatt",
    "privacy": "Adatvédelmi okok",
    "other_app": "Másik appot használok",
    "other": "Egyéb",
}


@bp.route("/api/account", methods=["DELETE"])
@require_auth
def delete_own_account():
    """A felhasználó törli a saját fiókját és minden adatát (admin nem – őt egy másik
    admin törölheti). A jelszóval kell megerősíteni; az okot az admin visszajelzésként kapja."""
    from api_admin import purge_user
    from api_feedback import record_account_deletion
    u = g.user
    if u.get("role") == "admin":
        abort(403, description="Admin fiókot itt nem lehet törölni – ehhez egy másik admin kell.")
    body = request.get_json(silent=True) or {}
    with _db() as conn:
        row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (u["id"],)).fetchone()
    if not _check_pw(body.get("password") or "", row["password_hash"]):
        abort(403, description="A jelszó nem stimmel.")
    reason = DELETE_REASONS.get(body.get("reason"), "Nem adta meg")
    comment = (body.get("comment") or "").strip()[:4000]

    record_account_deletion(u, reason, comment)
    purge_user(u["id"])
    log.info("Fiók törölve a felhasználó kérésére: %s (%s) – ok: %s", u["email"], u["id"], reason)

    # Visszaigazoló levél (ha volt megerősített címe)
    if u.get("contact_email") and u.get("email_verified_at") and mailer.status()["configured"]:
        _send_async("Bringaterv – a fiókodat töröltük", (
            f"{_hello(u)}\n\nA Bringaterv fiókodat és minden adatodat (útvonalak, edzések, beállítások, "
            "Strava-kapcsolat) a kérésedre töröltük.\n\nKöszönjük, hogy kipróbáltad!\n\nBringaterv"),
            u["contact_email"], mail_templates.render(
                "A fiókodat töröltük",
                f"{_hello(u)}\n\nA Bringaterv fiókodat és minden adatodat (útvonalak, edzések, beállítások, "
                "Strava-kapcsolat) a kérésedre töröltük.\n\nKöszönjük, hogy kipróbáltad!",
                note="Ha nem te kérted a törlést, jelezd a meghívódnak."))
    return jsonify({"ok": True})
