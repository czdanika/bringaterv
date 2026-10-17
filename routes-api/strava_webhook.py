"""Bringaterv – Strava webhook (azonnali import).

A Strava „push subscription”-nel maga szól, ha a sportoló új edzést tölt fel,
módosít vagy töröl – így nem kell percenként lekérdezni. Mivel mindenkinek saját
Strava appja van, a feliratkozás felhasználónként (appónként) történik:

  1. enable(): POST /push_subscriptions (client_id, client_secret, callback_url,
     verify_token). A Strava AZONNAL GET-tel ellenőrzi a callbacket
     (hub.challenge) – erre a public végpont 2 mp-en belül válaszol.
  2. A Strava ezután POST-ol a callbackre: {object_type, aspect_type, object_id,
     owner_id, subscription_id, updates}. 200-zal azonnal válaszolunk, a
     feldolgozás háttérszálon fut (import + értesítés).

Callback: <nyilvános cím>/api/strava/webhook/<user_id> – a nyilvános címet a
kliens adja (location.origin), mert a szerver a Cloudflare / reverse proxy
mögött nem tudja megbízhatóan.

Egy Strava apphoz csak EGY feliratkozás tartozhat. Ha ugyanazt az appot több
szerveren (pl. teszt + éles) használod, a webhook csak az egyiken lehet aktív.

Az időközös lekérdezés (strava_sync.py) tartalékként tovább fut.
Állapot: strava_sync.json → "webhook": {...}
"""

import secrets
import threading
from datetime import datetime, timezone

import requests

from config import log
from strava_service import STRAVA_API_BASE, _load_strava_app_config, _load_user_strava
from strava_sync import load_sync, save_sync

PUSH_URL = f"{STRAVA_API_BASE}/push_subscriptions"


class WebhookError(Exception):
    def __init__(self, status: int, message: str, extra: dict | None = None):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra or {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _wh(data: dict) -> dict:
    return data.get("webhook") or {}


def status(user_id: str) -> dict:
    w = _wh(load_sync(user_id))
    return {
        "enabled": bool(w.get("subscription_id")),
        "callback_url": w.get("callback_url"),
        "created": w.get("created"),
        "last_event_at": w.get("last_event_at"),
        "last_event": w.get("last_event"),
    }


def _app(user_id: str) -> dict:
    cfg = _load_strava_app_config(user_id)
    if not cfg.get("client_id") or not cfg.get("client_secret"):
        raise WebhookError(400, "Nincs Strava app beállítva (Beállítások → Strava kapcsolat → API beállítás).")
    return cfg


def _list_subscriptions(cfg: dict) -> list:
    r = requests.get(PUSH_URL, params={"client_id": cfg["client_id"], "client_secret": cfg["client_secret"]}, timeout=15)
    if r.status_code != 200:
        raise WebhookError(502, f"Strava feliratkozás lekérdezése sikertelen ({r.status_code}).")
    return r.json() or []


def _delete_subscription(cfg: dict, sub_id) -> None:
    requests.delete(f"{PUSH_URL}/{sub_id}",
                    params={"client_id": cfg["client_id"], "client_secret": cfg["client_secret"]}, timeout=15)


def enable(user_id: str, base_url: str, force: bool = False) -> dict:
    base_url = (base_url or "").strip().rstrip("/")
    if not base_url.startswith("https://"):
        raise WebhookError(400, "A webhookhoz nyilvános HTTPS-cím kell (pl. saját domain). Helyi http címen nem működik.")
    cfg = _app(user_id)
    callback = f"{base_url}/api/strava/webhook/{user_id}"

    # Egy apphoz csak egy feliratkozás lehet – ha másik címre szól, csak kérésre cseréljük
    existing = _list_subscriptions(cfg)
    for s in existing:
        if s.get("callback_url") == callback:
            continue
        if not force:
            raise WebhookError(409, "Ehhez a Strava apphoz már tartozik webhook egy másik címen.",
                               {"other_callback": s.get("callback_url")})
    for s in existing:
        _delete_subscription(cfg, s.get("id"))

    data = load_sync(user_id)
    token = secrets.token_urlsafe(24)
    data["webhook"] = {"verify_token": token, "callback_url": callback, "pending": True}
    save_sync(user_id, data, keep_webhook=False)          # a Strava ellenőrző GET-je már ezt látja

    r = requests.post(PUSH_URL, data={
        "client_id": cfg["client_id"], "client_secret": cfg["client_secret"],
        "callback_url": callback, "verify_token": token,
    }, timeout=30)
    data = load_sync(user_id)
    if r.status_code not in (200, 201):
        data["webhook"] = {}
        save_sync(user_id, data, keep_webhook=False)
        detail = ""
        try:
            detail = "; ".join(f"{e.get('field', '')} {e.get('code', '')}".strip() for e in (r.json().get("errors") or []))
        except Exception:
            pass
        raise WebhookError(502, f"A Strava nem fogadta el a feliratkozást ({r.status_code}"
                                f"{': ' + detail if detail else ''}). Ellenőrizd, hogy a cím kívülről elérhető-e "
                                f"(Cloudflare alatt a „Bot Fight Mode” blokkolhatja).")
    w = data.get("webhook") or {}
    w.update({"subscription_id": r.json().get("id"), "created": _now(), "pending": False})
    data["webhook"] = w
    save_sync(user_id, data, keep_webhook=False)
    log.info("Strava webhook bekapcsolva (%s): %s", user_id, callback)
    return status(user_id)


def disable(user_id: str) -> dict:
    data = load_sync(user_id)
    sub_id = _wh(data).get("subscription_id")
    if sub_id:
        try:
            _delete_subscription(_app(user_id), sub_id)
        except Exception as exc:
            log.warning("Strava webhook törlés hiba: %s", exc)
    data["webhook"] = {}
    save_sync(user_id, data, keep_webhook=False)
    return status(user_id)


# ── Public végpontok logikája ─────────────────────────────────────────────────

def validate(user_id: str, args) -> str | None:
    """A Strava GET-ellenőrzése: a hub.challenge-t adjuk vissza, ha a token egyezik."""
    w = _wh(load_sync(user_id))
    if args.get("hub.mode") == "subscribe" and w.get("verify_token") and \
            secrets.compare_digest(args.get("hub.verify_token", ""), w["verify_token"]):
        return args.get("hub.challenge")
    return None


def accept_event(user_id: str, ev: dict) -> bool:
    """Gyors ellenőrzés (feliratkozás + sportoló), a feldolgozás háttérszálon."""
    data = load_sync(user_id)
    w = _wh(data)
    if not w.get("subscription_id") or str(ev.get("subscription_id")) != str(w["subscription_id"]):
        return False
    athlete = _load_user_strava(user_id).get("athlete_id")
    if athlete and str(ev.get("owner_id")) != str(athlete):
        return False
    w["last_event_at"] = _now()
    w["last_event"] = f"{ev.get('object_type')}/{ev.get('aspect_type')} {ev.get('object_id')}"
    data["webhook"] = w
    save_sync(user_id, data, keep_webhook=False)
    threading.Thread(target=_process, args=(user_id, ev), daemon=True).start()
    return True


def _process(user_id: str, ev: dict) -> None:
    try:
        otype, aspect, oid = ev.get("object_type"), ev.get("aspect_type"), ev.get("object_id")
        if otype == "activity" and aspect == "create":
            from strava_sync import import_single
            import_single(user_id, int(oid), source="webhook")
        elif otype == "activity" and aspect == "update":
            _apply_update(user_id, int(oid), ev.get("updates") or {})
        elif otype == "athlete" and (ev.get("updates") or {}).get("authorized") == "false":
            # A sportoló visszavonta a hozzáférést a Strava oldalán
            data = load_sync(user_id)
            data["last_error"] = "A Strava-hozzáférést visszavonták – csatlakozz újra a Beállításokban."
            from strava_sync import _alert_connection
            _alert_connection(user_id, data)
            save_sync(user_id, data, keep_webhook=False)
        # activity/delete: a könyvtárból nem törlünk automatikusan (a felhasználó adatai)
    except Exception as exc:
        log.warning("Strava webhook feldolgozási hiba (%s): %s", user_id, exc)


def _apply_update(user_id: str, activity_id: int, updates: dict) -> None:
    """Átnevezés a Stravában → a könyvtárban is frissül a név."""
    title = updates.get("title")
    if not title:
        return
    import os
    from config import MULTI_DATA_DIR
    from utils import _load_index, _save_index
    idx_path = os.path.join(MULTI_DATA_DIR, user_id, "routes", "index.json")
    idx = _load_index(idx_path)
    changed = False
    for e in idx:
        if e.get("strava_id") == activity_id and e.get("name") != title:
            e["name"] = title
            changed = True
    if changed:
        _save_index(idx, idx_path)
        log.info("Strava webhook: átnevezés (%s) → %s", activity_id, title)
