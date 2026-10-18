"""Bringaterv – e-mail küldés (SMTP).

Jelenleg a visszajelzések (hibajelentés, ötlet) mennek e-mailben. Beállítás
környezeti változókkal (docker-compose / Portainer stack):

  SMTP_HOST       pl. smtp.gmail.com            (üresen: nincs e-mail küldés)
  SMTP_PORT       587 (STARTTLS) vagy 465 (SSL)  (alapért.: 587)
  SMTP_SECURITY   starttls | ssl | none          (alapért.: a portból: 465 → ssl, egyébként starttls)
  SMTP_USER       bejelentkezési név (Gmailnél a teljes cím)
  SMTP_PASSWORD   jelszó (Gmailnél alkalmazásjelszó)
  SMTP_FROM       feladó (alapért.: SMTP_USER)
  FEEDBACK_TO     címzett(ek), vesszővel elválasztva (alapért.: SMTP_FROM)
  PUBLIC_URL      a levelekben lévő linkek alapcíme, pl. https://bringaterv.hu
  REQUIRE_EMAIL_VERIFICATION  true (alapért.) | false – kötelező-e megerősíteni az e-mail-címet
"""

import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from config import log


def config() -> dict:
    port = int(os.environ.get("SMTP_PORT") or 587)
    sec = (os.environ.get("SMTP_SECURITY") or ("ssl" if port == 465 else "starttls")).lower()
    user = os.environ.get("SMTP_USER", "").strip()
    sender = os.environ.get("SMTP_FROM", "").strip() or user
    to = [a.strip() for a in (os.environ.get("FEEDBACK_TO") or sender).split(",") if a.strip()]
    return {
        "host": os.environ.get("SMTP_HOST", "").strip(),
        "port": port, "security": sec, "user": user,
        "password": os.environ.get("SMTP_PASSWORD", ""),
        "sender": sender, "to": to,
    }


def status() -> dict:
    """A kliensnek (admin): be van-e állítva – jelszó nélkül."""
    c = config()
    return {"configured": bool(c["host"] and c["sender"] and c["to"]),
            "host": c["host"], "port": c["port"], "security": c["security"],
            "sender": c["sender"], "to": c["to"]}


def verification_required() -> bool:
    """Kötelező-e az e-mail-cím megerősítése: csak ha van mivel levelet küldeni."""
    flag = (os.environ.get("REQUIRE_EMAIL_VERIFICATION") or "true").strip().lower()
    return flag not in ("0", "false", "no", "off") and status()["configured"]


def send(subject: str, text: str, reply_to: str | None = None,
         attachments: list[tuple[str, bytes, str]] | None = None, to: list[str] | None = None,
         html: str | None = None) -> None:
    """E-mail küldése (sima szöveg + opcionális HTML változat, beágyazott logóval).
    Hiba esetén kivételt dob (a hívó dönti el, mi legyen)."""
    c = config()
    if not (c["host"] and c["sender"] and (to or c["to"])):
        raise RuntimeError("Nincs e-mail küldés beállítva (SMTP_HOST, SMTP_FROM / SMTP_USER, FEEDBACK_TO).")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr(("Bringaterv", c["sender"]))
    msg["To"] = ", ".join(to or c["to"])
    msg["Message-ID"] = make_msgid(domain=c["sender"].split("@")[-1] or "bringaterv")
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
        if "cid:logo" in html:
            from mail_templates import logo_bytes
            logo = logo_bytes()
            if logo:
                msg.get_payload()[1].add_related(logo, maintype="image", subtype="png", cid="<logo>",
                                                 filename="bringaterv.png", disposition="inline")
    for name, data, mime in attachments or []:
        maintype, _, subtype = mime.partition("/")
        msg.add_attachment(data, maintype=maintype, subtype=subtype or "octet-stream", filename=name)

    ctx = ssl.create_default_context()
    if c["security"] == "ssl":
        server = smtplib.SMTP_SSL(c["host"], c["port"], context=ctx, timeout=20)
    else:
        server = smtplib.SMTP(c["host"], c["port"], timeout=20)
    try:
        if c["security"] == "starttls":
            server.starttls(context=ctx)
        if c["user"]:
            server.login(c["user"], c["password"])
        server.send_message(msg)
    finally:
        try:
            server.quit()
        except Exception:
            pass
    log.info("E-mail elküldve: %s → %s", subject, msg["To"])
