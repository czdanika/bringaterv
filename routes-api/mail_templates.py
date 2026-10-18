"""Bringaterv – HTML e-mail sablon.

Egy közös, levelezőbarát (táblázatos, inline stílusú) keret: logó, cím, szöveg,
opcionális kiemelt kód, gomb, apró lábléc. Gmail, Outlook, iPhone Mail alatt is
jól jelenik meg; a sima szöveges változatot a hívó adja mellé (mailer.send).

A logó a levélbe ágyazva megy (cid:logo), így nem kell külső képet letölteni.
"""

import html
import os

BRAND = "#fc4c02"
TEXT = "#1f2937"
MUTED = "#6b7280"
BG = "#f3f4f6"

_LOGO_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "mail-logo.png")


def logo_bytes() -> bytes | None:
    try:
        with open(_LOGO_PATH, "rb") as f:
            return f.read()
    except OSError:
        return None


def _p(text: str) -> str:
    """Bekezdés(ek) – a sortörések megmaradnak, a szöveg escape-elve."""
    parts = [html.escape(x).replace("\n", "<br>") for x in str(text).split("\n\n") if x.strip()]
    return "".join(
        f'<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:{TEXT};">{x}</p>' for x in parts)


def render(title: str, intro: str = "", *, code: str | None = None, code_note: str = "",
           button: tuple[str, str] | None = None, after: str = "", note: str = "",
           details: list[tuple[str, str]] | None = None, preheader: str = "", no_reply: bool = True) -> str:
    """Teljes HTML levél.

    title    nagy cím            intro   bevezető szöveg (bekezdésekre bontva)
    code     kiemelt kód (pl. 6 számjegy)      code_note  apró szöveg alatta
    button   (felirat, URL)       after   szöveg a kód után, a gomb előtt
    details  [(címke, érték)] táblázat (pl. visszajelzés adatai)
    note     halvány apró szöveg a végén (pl. „ha nem te kérted…”)
    """
    has_logo = logo_bytes() is not None
    logo = (f'<img src="cid:logo" width="48" height="48" alt="" '
            f'style="display:block;width:48px;height:48px;max-width:48px;margin:0 auto 8px;border-radius:12px;border:0;">'
            if has_logo else "")
    code_html = ""
    if code:
        spaced = "&nbsp;".join(html.escape(code))
        code_html = f'''
          <tr><td align="center" style="padding:6px 0 18px;">
            <div style="display:inline-block;padding:16px 26px;border-radius:12px;background:#fff7ed;border:1px solid #fed7aa;
                        font-family:'SF Mono',Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:6px;color:{TEXT};">{spaced}</div>
            {f'<div style="margin-top:8px;font-size:13px;color:{MUTED};">{html.escape(code_note)}</div>' if code_note else ''}
          </td></tr>'''
    button_html = ""
    if button:
        label, url = button
        button_html = f'''
          <tr><td align="center" style="padding:4px 0 20px;">
            <a href="{html.escape(url, quote=True)}" target="_blank"
               style="display:inline-block;padding:13px 28px;border-radius:10px;background:{BRAND};color:#ffffff;
                      font-size:15px;font-weight:700;text-decoration:none;">{html.escape(label)}</a>
          </td></tr>'''
    details_html = ""
    if details:
        rows = "".join(
            f'<tr><td style="padding:6px 12px 6px 0;font-size:13px;color:{MUTED};vertical-align:top;white-space:nowrap;">{html.escape(k)}</td>'
            f'<td style="padding:6px 0;font-size:14px;color:{TEXT};">{html.escape(str(v)).replace(chr(10), "<br>")}</td></tr>'
            for k, v in details)
        details_html = f'''
          <tr><td style="padding:0 0 16px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
                   style="border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">{rows}</table>
          </td></tr>'''
    note_html = (f'<tr><td style="padding:6px 0 0;font-size:12px;line-height:1.5;color:{MUTED};">{html.escape(note)}</td></tr>'
                 if note else "")
    return f'''<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>{html.escape(title)}</title></head>
<body style="margin:0;padding:0;background:{BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">{html.escape(preheader or intro[:90])}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:{BG};">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;">
        <tr><td align="center" style="padding:0 0 18px;">
          {logo}
          <div style="font-size:22px;font-weight:800;letter-spacing:-0.3px;color:{TEXT};">Bringa<span style="color:{BRAND};">terv</span></div>
        </td></tr>
        <tr><td style="background:#ffffff;border-radius:16px;padding:28px 28px 22px;box-shadow:0 2px 10px rgba(0,0,0,.06);">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr><td style="padding:0 0 14px;font-size:21px;font-weight:700;line-height:1.3;color:{TEXT};">{html.escape(title)}</td></tr>
            <tr><td>{_p(intro)}</td></tr>
            {code_html}
            {details_html}
            {f'<tr><td>{_p(after)}</td></tr>' if after else ''}
            {button_html}
            {note_html}
          </table>
        </td></tr>
        <tr><td align="center" style="padding:16px 8px 0;font-size:12px;line-height:1.5;color:#9ca3af;">
          Bringaterv · útvonaltervezés és edzésnapló{'<br>Ez egy automatikus üzenet, kérjük, ne válaszolj rá.' if no_reply else ''}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>'''
