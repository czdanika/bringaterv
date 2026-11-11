"""Nyilvános linkek: mi látszik rajtuk, és hányszor nyitották meg.

  SHARE_KEYS            a tulajdonos által elrejthető adatok (index-bejegyzés: share.hide)
  clean_share(data)     a PATCH-ben kapott beállítás megtisztítása
  strip_gpx(gpx, hide)  az elrejtett mért adatok (pulzus, watt, kadencia, hőmérséklet) törlése a GPX-ből
  count_view(rid, …)    megnyitás számolása (ugyanaz a néző 30 percen belül egyszer; a tulajdonos nem)
  views_of(rids)        {rid: {views, first_at, last_at}}
"""

import hashlib
import re
import time

from db import _db
from utils import _now_dt

# elrejthető adatok – a mért adatsorok a GPX-ből is kikerülnek, nem csak a felületről
SHARE_KEYS = ("hr", "power", "cad", "temp", "desc", "wind", "cards")

_GPX_TAGS = {
    "hr":    ("hr", "heartrate"),
    "power": ("power", "watts", "PowerInWatts"),
    "cad":   ("cad", "cadence"),
    "temp":  ("atemp", "temp"),
}


def clean_share(data) -> dict:
    hide = data.get("hide") if isinstance(data, dict) else None
    if not isinstance(hide, list):
        hide = []
    return {"hide": [k for k in SHARE_KEYS if k in hide]}


def hidden(entry: dict) -> set:
    return set((entry.get("share") or {}).get("hide") or [])


def strip_gpx(gpx: str, hide) -> str:
    tags = [t for k in hide for t in _GPX_TAGS.get(k, ())]
    if not tags:
        return gpx
    alt = "|".join(re.escape(t) for t in tags)
    # <ns:tag>…</ns:tag> (névtérrel vagy anélkül)
    gpx = re.sub(rf"<((?:[\w.-]+:)?(?:{alt}))>[^<]*</\1>\s*", "", gpx)
    # az üresen maradt kiterjesztés-blokkok
    for _ in range(2):
        gpx = re.sub(r"<((?:[\w.-]+:)?(?:TrackPointExtension|TrackPointExtensions|PowerExtension))>\s*</\1>\s*", "", gpx)
        gpx = re.sub(r"<extensions>\s*</extensions>\s*", "", gpx)
    return gpx


# ── Számláló ──────────────────────────────────────────────────────────────────
# ugyanaz a néző (IP + böngésző, kivonatolva) 30 percen belül csak egyszer számít – a szűrő az
# adatbázisban van (share_seen), így a több gunicorn-folyamat is ugyanazt látja
_SEEN_TTL = 30 * 60
_BOT_RE = re.compile(r"bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|curl|wget|python-requests",
                     re.I)


def count_view(rid: str, ip: str, ua: str) -> bool:
    if not ua or _BOT_RE.search(ua):
        return False
    key = hashlib.sha256(f"{rid}|{ip}|{ua}".encode()).hexdigest()[:32]
    now = time.time()
    ts = _now_dt()
    with _db() as conn:
        conn.execute("DELETE FROM share_seen WHERE at < ?", (now - _SEEN_TTL,))
        if conn.execute("INSERT OR IGNORE INTO share_seen (key, at) VALUES (?, ?)", (key, now)).rowcount == 0:
            return False
        conn.execute("INSERT INTO share_views (rid, views, first_at, last_at) VALUES (?, 1, ?, ?)"
                     " ON CONFLICT(rid) DO UPDATE SET views = views + 1, last_at = excluded.last_at", (rid, ts, ts))
    return True


def views_of(rids) -> dict:
    rids = [r for r in rids if r]
    if not rids:
        return {}
    out = {}
    with _db() as conn:
        for i in range(0, len(rids), 500):
            part = rids[i:i + 500]
            for r in conn.execute(f"SELECT rid, views, first_at, last_at FROM share_views WHERE rid IN ({','.join('?' * len(part))})",
                                  part):
                out[r["rid"]] = {"views": r["views"], "first_at": r["first_at"], "last_at": r["last_at"]}
    return out


def reset_views(rid: str):
    with _db() as conn:
        conn.execute("DELETE FROM share_views WHERE rid = ?", (rid,))
