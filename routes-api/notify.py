"""Bringaterv – értesítések (Web Push).

Csatorna: szabványos Web Push (VAPID) – iPhone/iPad (főképernyőre telepített
appból, iOS 16.4+), Android, asztali böngészők. Csak HTTPS-en működik.

  • A szerver első használatkor generál magának egy VAPID kulcspárt:
      /data/vapid_private.pem  +  /data/vapid_public.txt (base64url, a kliensnek)
  • Felhasználónként: /data/users/<uid>/notifications.json
      { "events": {"new_workout": true, …}, "subscriptions": [ {endpoint, keys, …} ] }
    Minden eszköz (telefon, tablet, böngésző) külön feliratkozás.
  • send(user_id, event, title, body, url) – ha az esemény be van kapcsolva,
    minden eszközre elküldi; a lejárt feliratkozásokat (404/410) törli.

Események: new_workout (új edzés importálva), new_record (új személyes rekord),
connection (Strava-kapcsolat megszakadt). A lista bővíthető (EVENTS).
"""

import base64
import json
import os
import threading
from datetime import datetime, timezone

from config import MULTI_DATA_DIR, log

EVENTS = {
    "new_workout": "Új edzés importálva",
    "new_record":  "Új személyes rekord",
    "connection":  "Kapcsolati hiba (Strava)",
}
_DEFAULT_EVENTS = {k: True for k in EVENTS}

_DATA_ROOT = os.path.dirname(MULTI_DATA_DIR.rstrip("/")) or "/data"
_VAPID_PRIV = os.path.join(_DATA_ROOT, "vapid_private.pem")
_VAPID_PUB = os.path.join(_DATA_ROOT, "vapid_public.txt")


def _contact() -> str:
    """VAPID „sub”: mailto: e-mail cím, vagy https://host (elérési út NÉLKÜL –
    a py_vapid mást elutasít, és ilyenkor egy push sem megy ki).
    Sorrend: NOTIFY_CONTACT → ADMIN_EMAIL (ha valódi e-mail) → semleges noreply cím."""
    import re
    from config import ADMIN_EMAIL
    valid = re.compile(r"^(mailto:[^@\s]+@[\w-]+(\.[\w-]+)+|https://[\w-]+(\.[\w-]+)+)$")
    for cand in (os.environ.get("NOTIFY_CONTACT", "").strip(), (ADMIN_EMAIL or "").strip()):
        if not cand:
            continue
        if "@" in cand and not cand.startswith("mailto:"):
            cand = "mailto:" + cand
        cand = cand.rstrip("/")
        if valid.match(cand):
            return cand
    return "mailto:bringaterv@users.noreply.github.com"


_VAPID_SUB = _contact()
_lock = threading.Lock()


# ── VAPID kulcspár ────────────────────────────────────────────────────────────

def vapid_public_key() -> str:
    """A kliens applicationServerKey-e (base64url, tömörítetlen P-256 pont)."""
    with _lock:
        if not (os.path.isfile(_VAPID_PRIV) and os.path.isfile(_VAPID_PUB)):
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric import ec
            key = ec.generate_private_key(ec.SECP256R1())
            pem = key.private_bytes(serialization.Encoding.PEM,
                                    serialization.PrivateFormat.TraditionalOpenSSL,
                                    serialization.NoEncryption())
            raw = key.public_key().public_bytes(serialization.Encoding.X962,
                                                serialization.PublicFormat.UncompressedPoint)
            os.makedirs(_DATA_ROOT, exist_ok=True)
            with open(_VAPID_PRIV, "wb") as f:
                f.write(pem)
            os.chmod(_VAPID_PRIV, 0o600)
            with open(_VAPID_PUB, "w") as f:
                f.write(base64.urlsafe_b64encode(raw).rstrip(b"=").decode())
            log.info("VAPID kulcspár létrehozva (%s)", _VAPID_PRIV)
        with open(_VAPID_PUB) as f:
            return f.read().strip()


# ── Felhasználói beállítás + feliratkozások ───────────────────────────────────

def _path(user_id: str) -> str:
    return os.path.join(MULTI_DATA_DIR, user_id, "notifications.json")


def load(user_id: str) -> dict:
    data = {"events": dict(_DEFAULT_EVENTS), "subscriptions": []}
    try:
        with open(_path(user_id), encoding="utf-8") as f:
            stored = json.load(f) or {}
        data["events"].update({k: bool(v) for k, v in (stored.get("events") or {}).items() if k in EVENTS})
        data["subscriptions"] = stored.get("subscriptions") or []
        data["last_send"] = stored.get("last_send")
    except (OSError, json.JSONDecodeError):
        pass
    return data


def save(user_id: str, data: dict) -> None:
    path = _path(user_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(path + ".tmp", 0o600)
    os.replace(path + ".tmp", path)


def subscribe(user_id: str, sub: dict, user_agent: str = "") -> dict:
    endpoint = (sub or {}).get("endpoint")
    keys = (sub or {}).get("keys") or {}
    if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
        raise ValueError("Hiányos feliratkozás")
    with _lock:
        data = load(user_id)
        data["subscriptions"] = [s for s in data["subscriptions"] if s.get("endpoint") != endpoint]
        data["subscriptions"].append({
            "endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]},
            "ua": (user_agent or "")[:160],
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        save(user_id, data)
    return data


def unsubscribe(user_id: str, endpoint: str) -> dict:
    with _lock:
        data = load(user_id)
        data["subscriptions"] = [s for s in data["subscriptions"] if s.get("endpoint") != endpoint]
        save(user_id, data)
    return data


# ── Küldés ────────────────────────────────────────────────────────────────────

def send(user_id: str, event: str, title: str, body: str, url: str = "./index.html",
         tag: str | None = None, force: bool = False) -> int:
    """Értesítés minden eszközre. Visszaadja a sikeres kézbesítések számát."""
    data = load(user_id)
    if not force and not data["events"].get(event, False):
        return 0
    if not data["subscriptions"]:
        return 0
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        log.warning("pywebpush nincs telepítve – push értesítés kihagyva")
        return 0
    vapid_public_key()   # biztosan létezzen a kulcs
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag or event},
                         ensure_ascii=False)
    from urllib.parse import urlparse
    ok, dead, results = 0, [], []
    for sub in data["subscriptions"]:
        host = urlparse(sub["endpoint"]).netloc
        try:
            resp = webpush(subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
                           data=payload, vapid_private_key=_VAPID_PRIV,
                           vapid_claims={"sub": _VAPID_SUB}, ttl=24 * 3600, timeout=15)
            code = getattr(resp, "status_code", 201)
            results.append({"host": host, "status": code, "ok": True})
            log.info("Push elküldve (%s → %s)", host, code)
            ok += 1
        except WebPushException as exc:
            status = getattr(exc.response, "status_code", None)
            reason = ""
            try:
                reason = (exc.response.text or "")[:160]
            except Exception:
                pass
            results.append({"host": host, "status": status, "ok": False, "reason": reason or str(exc)[:160]})
            if status in (404, 410):          # az eszköz leiratkozott / lejárt
                dead.append(sub["endpoint"])
            else:
                log.warning("Push hiba (%s %s): %s", host, status, reason or str(exc)[:200])
        except Exception as exc:              # hálózati hiba – a többi eszköz menjen
            results.append({"host": host, "status": None, "ok": False, "reason": str(exc)[:160]})
            log.warning("Push hiba (%s): %s", host, exc)
    # Az utolsó küldés eredménye a kliens diagnosztikájához (Beállítások → Értesítések)
    with _lock:
        d = load(user_id)
        if dead:
            d["subscriptions"] = [s for s in d["subscriptions"] if s.get("endpoint") not in dead]
        d["last_send"] = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                          "event": event, "results": results}
        save(user_id, d)
    return ok


# ── Új személyes rekordok felismerése (az új edzések vs. a korábbiak) ─────────

_SPORT_DISTANCES = {
    "cycling": [5000, 10000, 20000, 30000, 40000, 50000, 80000, 100000, 150000, 200000],
    "running": [400, 1000, 5000, 10000, 21097, 42195],
    "walking": [1000, 5000, 10000, 20000, 21097, 30000, 42195],
    "hiking":  [1000, 5000, 10000, 20000, 21097, 30000, 42195],
}
_DIST_LABEL = {21097: "Félmaraton", 42195: "Maraton"}


def _fmt_sec(s: float) -> str:
    s = int(round(s))
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def _fmt_dist(m: int) -> str:
    if m in _DIST_LABEL:
        return _DIST_LABEL[m]
    return f"{m} m" if m < 1000 else f"{m // 1000} km"


def detect_new_records(routes_dir: str, index: list, new_ids: list) -> dict:
    """{route_id: [szöveges rekordok]} – csak az azonos sportú korábbi edzésekhez képest."""
    from records import records_for_index
    items, _ = records_for_index(routes_dir, index, budget_s=60)
    rec = {i["id"]: i for i in items}
    entries = {e.get("id"): e for e in index}
    out = {}
    for nid in new_ids:
        e, r = entries.get(nid), rec.get(nid)
        if not e or not r:
            continue
        sport = e.get("sport_type") or "cycling"
        others = [x for x in index if x.get("type") == "workout" and x.get("id") != nid
                  and (x.get("sport_type") or "cycling") == sport
                  and x.get("include_in_stats") is not False]
        if not others:
            continue                           # az első edzés nem „rekord”
        lines = []
        prev_dist = max((x.get("distance") or 0 for x in others), default=0)
        if (e.get("distance") or 0) > prev_dist > 0:
            lines.append(f"Leghosszabb táv: {e['distance']:.1f} km".replace(".", ","))
        for d in _SPORT_DISTANCES.get(sport, []):
            t = (r.get("efforts") or {}).get(str(d))
            if not t:
                continue
            prev = [rec[x["id"]]["efforts"].get(str(d)) for x in others if x.get("id") in rec]
            prev = [p for p in prev if p]
            if prev and t < min(prev):
                lines.append(f"{_fmt_dist(d)}: {_fmt_sec(t)} (−{_fmt_sec(min(prev) - t)})")
        if lines:
            out[nid] = lines
    return out
