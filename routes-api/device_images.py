"""Bringaterv API – képek a felismert rögzítő eszközökhöz (Felszerelés → Eszközök).

Források:
  • Magene: a gyártó oldalának keresője → a termékoldal og:image képe (a modell
    pontos egyezésével: a „C506” nem a „C506SE” lapja);
  • minden más (Apple Watch, Garmin, Wahoo…): Wikimedia Commons szabad licencű képei.

Automatikusan (auto_pick) csak biztos találatot rakunk be: Magene pontos modell, vagy
Commons-kép, amelynek a címében az eszköznév minden szava benne van. Különben a
felhasználó választ a javaslatokból (candidates), feltölt saját képet, vagy webcímet ad meg.

fetch_image: a kép letöltése (http/https, csak nyilvános cím – belső hálózat nem,
legfeljebb 3 átirányítás, 3 MB, JPEG / PNG / WebP).
"""

import ipaddress
import re
import socket
from urllib.parse import urljoin, urlparse

import requests

_UA = {"User-Agent": "Bringaterv/1.0 (self-hosted; device photos)"}
_BROWSER_UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"}
MAX_BYTES = 3_000_000
_MAGIC = ((b"\xff\xd8\xff", "jpg"), (b"\x89PNG\r\n\x1a\n", "png"))


def _tokens(s: str) -> list:
    return [t for t in re.split(r"[^a-z0-9]+", (s or "").lower()) if t]


def search_name(name: str) -> str:
    """„Strava App (Apple Watch Series 7)” → „Apple Watch Series 7” (a zárójelben a valódi eszköz)."""
    m = re.match(r"^\s*strava\s+app\s*\((.+)\)\s*$", name or "", re.I)
    return (m.group(1) if m else name or "").strip()


# ── Magene ────────────────────────────────────────────────────────────────────

def _magene(name: str) -> list:
    toks = _tokens(name)
    if "magene" not in toks:
        return []
    model = [t for t in toks if t != "magene"]
    if not model:
        return []
    # a kereső a változatra (pl. „c506se”) nem mindig talál – ilyenkor az alapmodellre (c506)
    queries = [" ".join(model)]
    base = [re.sub(r"^([a-z]*\d+)[a-z]+$", r"\1", t) for t in model]
    if base != model:
        queries.append(" ".join(base))
    html = ""
    for q in queries:
        r = requests.get("https://www.magene.com/en/search", params={"controller": "search", "s": q},
                         headers=_BROWSER_UA, timeout=15)
        if r.status_code == 200:
            html += r.text
    links = list(dict.fromkeys(re.findall(r'https://www\.magene\.com/en/[a-z0-9-]+/\d+-([a-z0-9-]+)\.html', html)))
    links.sort(key=lambda slug: not all(t in slug.split("-") for t in model))     # a pontos egyezés előre
    out = []
    for slug in links[:6]:
        exact = all(t in slug.split("-") for t in model)
        url = next((u for u in re.findall(r'https://www\.magene\.com/en/[a-z0-9-]+/\d+-' + re.escape(slug) + r'\.html', html)), None)
        if not url:
            continue
        try:
            p = requests.get(url, headers=_BROWSER_UA, timeout=15)
        except requests.RequestException:
            continue
        m = re.search(r'<meta property="og:image" content="([^"]+)"', p.text)
        if m:
            out.append({"url": m.group(1), "thumb": m.group(1), "title": slug.replace("-", " "),
                        "source": "magene.com", "exact": exact})
        if exact:
            break
    out.sort(key=lambda c: not c["exact"])
    return out


# ── Wikimedia Commons ─────────────────────────────────────────────────────────

def _commons(name: str) -> list:
    r = requests.get("https://commons.wikimedia.org/w/api.php", headers=_UA, timeout=15, params={
        "action": "query", "generator": "search", "gsrsearch": f"{name} filetype:bitmap", "gsrnamespace": 6,
        "gsrlimit": 8, "prop": "imageinfo", "iiprop": "url|mime", "iiurlwidth": 900, "format": "json"})
    if r.status_code != 200:
        return []
    pages = sorted((r.json().get("query") or {}).get("pages", {}).values(), key=lambda p: p.get("index", 99))
    want = _tokens(name)
    out = []
    for p in pages:
        ii = (p.get("imageinfo") or [{}])[0]
        if ii.get("mime") not in ("image/jpeg", "image/png", "image/webp"):
            continue
        title = re.sub(r"^File:|\.\w+$", "", p.get("title", ""))
        have = set(_tokens(title))
        # a márka (első szó) és legfeljebb egy hiányzó szó – különben más tárgy (pl. „Edge 540” repülő)
        if want and (want[0] not in have or sum(t not in have for t in want) > 1):
            continue
        out.append({"url": ii.get("thumburl") or ii.get("url"), "thumb": ii.get("thumburl") or ii.get("url"),
                    "title": title, "source": "Wikimedia Commons", "page": ii.get("descriptionurl"),
                    "exact": bool(want) and all(t in have for t in want)})
    out.sort(key=lambda c: not c["exact"])
    return out


def candidates(name: str) -> list:
    q = search_name(name)
    out = []
    for fn in (_magene, _commons):
        try:
            out += fn(q)
        except (requests.RequestException, ValueError):
            pass
    return out[:10]


def auto_pick(name: str):
    """A biztos találat (url) vagy None."""
    return next((c for c in candidates(name) if c["exact"]), None)


# ── Letöltés ──────────────────────────────────────────────────────────────────

def _public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError):
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return True


def fetch_image(url: str):
    """(bytes, kiterjesztés) – vagy ValueError érthető üzenettel."""
    for _ in range(4):
        u = urlparse(url or "")
        if u.scheme not in ("http", "https") or not u.hostname:
            raise ValueError("Csak http(s) webcím adható meg.")
        if not _public_host(u.hostname):
            raise ValueError("Ez a cím nem érhető el (belső hálózat).")
        r = requests.get(url, headers=_BROWSER_UA, timeout=20, stream=True, allow_redirects=False)
        if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("Location"):
            url = urljoin(url, r.headers["Location"])
            continue
        if r.status_code != 200:
            raise ValueError(f"A kép nem tölthető le (HTTP {r.status_code}).")
        data = b""
        for chunk in r.iter_content(65536):
            data += chunk
            if len(data) > MAX_BYTES:
                raise ValueError("A kép túl nagy (legfeljebb 3 MB).")
        ext = next((e for m, e in _MAGIC if data.startswith(m)), None)
        if not ext and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            ext = "webp"
        if not ext:
            raise ValueError("Ez nem JPEG, PNG vagy WebP kép.")
        return data, ext
    raise ValueError("Túl sok átirányítás.")

