"""Bringaterv – AI-funkciók (Claude API).

Beállítás (admin felületről, /data/ai_config.json, 0600):
  api_key        Anthropic API-kulcs – csak a szerveren, a böngésző sosem kapja meg
  default_limit  alap napi limit felhasználónként (hívásszám), ha a felhasználónál nincs külön

Keret: a users.ai_enabled (admin be/ki), users.ai_daily_limit (NULL = alapérték) és
users.ai_user_off (a felhasználó saját kikapcsolása) alapján; a hívások az ai_usage
táblába naplózódnak – ebből számolódik a napi keret és a költség.
"""

import json
import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from config import AI_CONFIG, log
from db import _db
from utils import _now_dt

MODEL = "claude-opus-5-5"
# USD / millió token (bemenet, kimenet) – a költségkijelzéshez
PRICES = {"claude-opus-5-5": (4.0, 20.0)}
DEFAULT_LIMIT = 5
_TZ = ZoneInfo("Europe/Budapest")


# ── Beállítás ────────────────────────────────────────────────────────────────

def load_config() -> dict:
    if os.path.isfile(AI_CONFIG):
        try:
            with open(AI_CONFIG, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("AI config olvasási hiba: %s", exc)
    return {}


def save_config(cfg: dict) -> None:
    os.makedirs(os.path.dirname(AI_CONFIG), exist_ok=True)
    tmp = AI_CONFIG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, AI_CONFIG)


def api_key() -> str:
    return (load_config().get("api_key") or os.environ.get("ANTHROPIC_API_KEY") or "").strip()


def default_limit() -> int:
    try:
        return max(0, int(load_config().get("default_limit", DEFAULT_LIMIT)))
    except (TypeError, ValueError):
        return DEFAULT_LIMIT


def masked_key() -> str:
    k = api_key()
    return f"{k[:7]}…{k[-4:]}" if len(k) > 14 else ("beállítva" if k else "")


# ── Keret ────────────────────────────────────────────────────────────────────

def _day_start_utc() -> str:
    """A mai nap (Budapest) kezdete UTC-ben, az ai_usage.created_at formátumában."""
    now = datetime.now(_TZ)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    return start.strftime("%Y-%m-%dT%H:%M:%SZ")


def _month_start_utc() -> str:
    now = datetime.now(_TZ)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    return start.strftime("%Y-%m-%dT%H:%M:%SZ")


def user_limit(user: dict) -> int:
    lim = user.get("ai_daily_limit")
    return default_limit() if lim is None else max(0, int(lim))


# Az admin eszközök (ötlet-feldolgozás, közösségi leírás) a költségnaplóban szerepelnek, de a
# személyes napi keretből nem vonnak le
_ADMIN_KINDS = ("roadmap", "sample_description")


def used_today(user_id: str) -> int:
    with _db() as conn:
        return conn.execute("SELECT COUNT(*) FROM ai_usage WHERE user_id = ? AND created_at >= ?"
                            f" AND kind NOT IN ({','.join('?' * len(_ADMIN_KINDS))})",
                            (user_id, _day_start_utc(), *_ADMIN_KINDS)).fetchone()[0]


def status(user: dict) -> dict:
    """A felhasználó AI-állapota a felületnek (a kulcsot sosem adja ki)."""
    configured = bool(api_key())
    allowed = configured and bool(user.get("ai_enabled", 1))
    limit = user_limit(user)
    used = used_today(user["id"]) if allowed else 0
    return {
        "configured": configured,                     # van API-kulcs a szerveren
        "allowed": allowed,                           # az admin engedélyezte
        "user_off": bool(user.get("ai_user_off")),    # a felhasználó kikapcsolta magának
        "limit": limit,
        "used_today": used,
        "remaining": max(0, limit - used) if allowed else 0,
    }


def log_usage(user_id: str, kind: str, ref_id: str, model: str, usage) -> float:
    inp = int(getattr(usage, "input_tokens", 0) or 0) + int(getattr(usage, "cache_read_input_tokens", 0) or 0)
    out = int(getattr(usage, "output_tokens", 0) or 0)
    p_in, p_out = PRICES.get(model, PRICES[MODEL])
    cost = inp / 1e6 * p_in + out / 1e6 * p_out
    with _db() as conn:
        conn.execute("INSERT INTO ai_usage (user_id, created_at, kind, ref_id, model, input_tokens, output_tokens, cost_usd)"
                     " VALUES (?,?,?,?,?,?,?,?)", (user_id, _now_dt(), kind, ref_id, model, inp, out, cost))
    return cost


def usage_summary() -> dict:
    """Felhasználónkénti és összesített felhasználás (ma / hónap) az admin felületnek."""
    day, month = _day_start_utc(), _month_start_utc()
    with _db() as conn:
        rows = conn.execute("""
            SELECT user_id,
                   SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END)         AS today,
                   COUNT(*)                                                 AS month,
                   SUM(cost_usd)                                            AS cost_month
            FROM ai_usage WHERE created_at >= ? GROUP BY user_id""", (day, month)).fetchall()
    per_user = {r["user_id"]: {"today": r["today"] or 0, "month": r["month"] or 0,
                               "cost_month": round(r["cost_month"] or 0, 4)} for r in rows}
    total = {"today": sum(v["today"] for v in per_user.values()),
             "month": sum(v["month"] for v in per_user.values()),
             "cost_month": round(sum(v["cost_month"] for v in per_user.values()), 4)}
    return {"per_user": per_user, "total": total}


# ── Claude hívás ─────────────────────────────────────────────────────────────

class AIError(Exception):
    """Felhasználónak megjeleníthető hiba."""


def _client():
    import anthropic  # csak itt kell – az app AI nélkül is elindul
    key = api_key()
    if not key:
        raise AIError("Az AI-funkció nincs beállítva.")
    # Cloudflare a 100 mp-en túl válaszoló kérést megszakítja (524) – ezért egy próbálkozás,
    # 85 mp-es korláttal: a felhasználó mindig választ kap, és nem fut le „láthatatlan” hívás
    return anthropic, anthropic.Anthropic(api_key=key, timeout=85.0, max_retries=0)


def _call(system: str, payload: dict, schema: dict, max_tokens: int = 4000, effort: str = "low"):
    """Egy Claude-hívás strukturált (JSON) válasszal. Visszaad: (dict, model, usage)."""
    anthropic, client = _client()
    try:
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            # elutasítás esetén a szerver automatikusan egy másik modellel próbálja újra
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
            system=system,
            messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
        )
    except anthropic.AuthenticationError:
        raise AIError("Érvénytelen API-kulcs – szólj az adminnak.")
    except anthropic.PermissionDeniedError:
        raise AIError("Az API-kulcsnak nincs jogosultsága ehhez.")
    except anthropic.RateLimitError:
        raise AIError("Túl sok kérés az AI felé – próbáld újra pár perc múlva.")
    except anthropic.BadRequestError as exc:
        log.warning("AI hibás kérés: %s", exc)
        raise AIError("Az AI nem tudta feldolgozni a kérést.")
    except anthropic.APIStatusError as exc:
        log.warning("AI szerverhiba (%s): %s", exc.status_code, exc)
        raise AIError("Az AI-szolgáltatás most nem érhető el – próbáld újra később.")
    except anthropic.APITimeoutError:
        raise AIError("Az AI most túl sokáig dolgozott a válaszon – próbáld újra kicsit később.")
    except anthropic.APIConnectionError:
        raise AIError("Nem sikerült kapcsolódni az AI-szolgáltatáshoz.")
    if resp.stop_reason == "refusal":
        raise AIError("Az AI ezt az elemzést nem tudta elkészíteni.")
    if resp.stop_reason == "max_tokens":
        raise AIError("Az AI válasza túl hosszú lett – próbáld újra.")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        log.warning("AI érvénytelen JSON: %r", text[:200])
        raise AIError("Az AI válasza hibás volt – próbáld újra.")
    return data, resp.model or MODEL, resp.usage


def test_key(key: str) -> None:
    """Rövid próbahívás a kulcs ellenőrzéséhez (admin „Kapcsolat tesztelése”)."""
    import anthropic
    try:
        anthropic.Anthropic(api_key=key, timeout=30.0, max_retries=0).models.retrieve(MODEL)
    except anthropic.AuthenticationError:
        raise AIError("Érvénytelen API-kulcs.")
    except anthropic.PermissionDeniedError:
        raise AIError("A kulcsnak nincs jogosultsága.")
    except anthropic.NotFoundError:
        raise AIError(f"A {MODEL} modell nem érhető el ezzel a kulccsal.")
    except anthropic.APIConnectionError:
        raise AIError("Nem sikerült kapcsolódni az Anthropic API-hoz.")
    except anthropic.APIStatusError as exc:
        raise AIError(f"API-hiba ({exc.status_code}).")


# ── Edzéselemzés ─────────────────────────────────────────────────────────────

_WORKOUT_SYSTEM = """Te egy tapasztalt, barátságos kerékpáros és állóképességi edző vagy egy magyar \
útvonaltervező és edzésnapló alkalmazásban. A felhasználó egy edzésének összesített adatait kapod \
JSON-ban (táv, idő, tempó, pulzus- és egyéb zónák, szakaszonkénti bontás, szint, időjárás, ha van), \
valamint néhány korábbi hasonló edzését összehasonlításként, és opcionálisan egy saját megjegyzést.

Írj NAGYON RÖVID, konkrét elemzést magyarul, tegezve – egy telefon képernyőjén is elférjen:
- "lead": EGY mondat, legfeljebb 25 szó: milyen jellegű edzés volt, és mi a legfontosabb tanulság.
- "points": pontosan 3 pont, mindegyik legfeljebb 20 szó, és csak EGY konkrét megfigyelés, \
  legfeljebb 1–2 számmal (pl. hol esett vissza a tempó, pulzus-drift azonos tempónál, emelkedők \
  hatása, összevetés a korábbi hasonló edzésekkel). Ne sorolj fel több szakaszt egy pontban. \
  "tone": "good" (erősség), "warn" (figyelendő), "info" (semleges érdekesség).
- A szakaszok tempója mozgásidőből számolt; a "megallas_perc" a pihenőt jelzi – a megállást ne \
  értékeld lassú tekerésnek, legfeljebb egy szóval említsd.
- "title": rövid, kifejező edzésnév (2–5 szó), pl. „Szeles Tisza-tavi kör”.

Szabályok: csak a kapott adatokra támaszkodj, ne találj ki számot vagy helyet. Ha a felhasználó \
megjegyzése szerint szándékosan könnyű edzés volt, ne kérd számon a lassú tempót. Ne adj orvosi \
tanácsot. Kerüld a túlzó dicséretet és az általánosságokat. Számoknál magyar formátum (tizedesvessző)."""

_WORKOUT_SCHEMA = {
    "type": "object",
    "properties": {
        "lead": {"type": "string"},
        "points": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "tone": {"type": "string", "enum": ["good", "warn", "info"]},
                    "text": {"type": "string"},
                },
                "required": ["tone", "text"],
                "additionalProperties": False,
            },
        },
        "title": {"type": "string"},
    },
    "required": ["lead", "points", "title"],
    "additionalProperties": False,
}


def clean_analysis(data: dict) -> dict:
    """A modell (vagy a felhasználó szerkesztése) kimenetének egységesítése, hosszkorlátokkal."""
    def txt(v, n): return str(v or "").strip()[:n]
    points = []
    for p in (data.get("points") or [])[:4]:
        if isinstance(p, dict) and txt(p.get("text"), 400):
            tone = p.get("tone") if p.get("tone") in ("good", "warn", "info") else "info"
            points.append({"tone": tone, "text": txt(p.get("text"), 400)})
    return {"lead": txt(data.get("lead"), 600), "points": points, "title": txt(data.get("title"), 80)}


def analyze_workout(summary: dict, context: str, history: list) -> tuple[dict, str, object]:
    payload = {"edzes": summary, "korabbi_hasonlo_edzesek": history[:8]}
    if context:
        payload["felhasznalo_megjegyzese"] = context[:300]
    data, model, usage = _call(_WORKOUT_SYSTEM, payload, _WORKOUT_SCHEMA)
    return clean_analysis(data), model, usage


# ── Részletes edzéselemzés (külön kérésre) ───────────────────────────────────

_WORKOUT_EXT_SYSTEM = """Te egy tapasztalt, barátságos kerékpáros és állóképességi edző vagy egy magyar \
útvonaltervező és edzésnapló alkalmazásban. A felhasználó egy edzésének összesített adatait kapod \
JSON-ban (táv, idő, tempó, pulzus- és egyéb zónák, szakaszonkénti bontás mozgásidőből, megállások, \
szint), néhány korábbi hasonló edzését összehasonlításként, és opcionálisan egy saját megjegyzést.

Most RÉSZLETES elemzést kér, magyarul, tegezve:
- "sections": 3–5 rövid fejezet, mindegyik "title" (2–4 szó) és "text" (2–4 mondat, konkrét számokkal). \
  Javasolt fejezetek, ha van rá adat: Tempó és erőbeosztás · Pulzus és terhelés · Terep és szint · \
  Összevetés a korábbiakkal · Megállások és ritmus. Ami nem releváns vagy nincs rá adat, hagyd ki.
- "tips": 2–3 rövid, gyakorlatias javaslat a következő edzésekhez (egy-egy mondat).

Szabályok: csak a kapott adatokra támaszkodj, ne találj ki számot vagy helyet. A megállást ne értékeld \
lassú tekerésnek. Ha a felhasználó szerint szándékosan könnyű edzés volt, ne kérd számon a tempót. \
Ne adj orvosi tanácsot. Kerüld a túlzó dicséretet és az általánosságokat. Számoknál magyar formátum."""

_WORKOUT_EXT_SCHEMA = {
    "type": "object",
    "properties": {
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"title": {"type": "string"}, "text": {"type": "string"}},
                "required": ["title", "text"],
                "additionalProperties": False,
            },
        },
        "tips": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["sections", "tips"],
    "additionalProperties": False,
}


def clean_extended(data: dict) -> dict:
    def txt(v, n): return str(v or "").strip()[:n]
    sections = [{"title": txt(s.get("title"), 60), "text": txt(s.get("text"), 900)}
                for s in (data.get("sections") or [])[:6] if isinstance(s, dict) and txt(s.get("text"), 900)]
    tips = [txt(t, 300) for t in (data.get("tips") or [])[:4] if txt(t, 300)]
    return {"sections": sections, "tips": tips}


def analyze_workout_extended(summary: dict, context: str, history: list) -> tuple[dict, str, object]:
    payload = {"edzes": summary, "korabbi_hasonlo_edzesek": history[:8]}
    if context:
        payload["felhasznalo_megjegyzese"] = context[:300]
    data, model, usage = _call(_WORKOUT_EXT_SYSTEM, payload, _WORKOUT_EXT_SCHEMA, max_tokens=8000, effort="medium")
    return clean_extended(data), model, usage


# ── Közösségi útvonal leírása (admin) ────────────────────────────────────────

_SAMPLE_SYSTEM = """Egy magyar kerékpáros útvonaltervező alkalmazás közösségi útvonal-gyűjteményébe írsz \
rövid ismertetőt. Az útvonal adatait JSON-ban kapod: név, táv, szint, kör vagy A → B, érintett \
települések, megye, burkolat-arányok, típus, és ha van, a jelenlegi leírás.

Írj magyarul:
- "description": 2–3 mondat (legfeljebb ~45 szó), tárgyilagos, kedvcsináló hangon: milyen jellegű az út \
  (sík / dombos, burkolat), merre visz (a megadott települések közül 2–4-et említs), kinek ajánlott. \
  Ne írd bele a pontos km-t és a szintet (azok külön látszanak), és ne használj felkiáltójelet.
- "difficulty": "easy" | "medium" | "hard" – a táv, a szint és a burkolat alapján.
- "season": "all" | "spring-autumn" | "summer" | "dry" – burkolatlan, földutas útnál "dry".

Szabályok: csak a megadott adatokra és a megnevezett települések közismert jellemzőire támaszkodj; ne \
találj ki konkrét látnivalót, kávézót vagy útszakaszt. Ha van jelenlegi leírás, annak tényeit tartsd meg."""

_SAMPLE_SCHEMA = {
    "type": "object",
    "properties": {
        "description": {"type": "string"},
        "difficulty": {"type": "string", "enum": ["easy", "medium", "hard"]},
        "season": {"type": "string", "enum": ["all", "spring-autumn", "summer", "dry"]},
    },
    "required": ["description", "difficulty", "season"],
    "additionalProperties": False,
}


def describe_sample(info: dict) -> tuple[dict, str, object]:
    data, model, usage = _call(_SAMPLE_SYSTEM, info, _SAMPLE_SCHEMA, max_tokens=3000)
    return {"description": str(data.get("description") or "").strip()[:600],
            "difficulty": data.get("difficulty") if data.get("difficulty") in ("easy", "medium", "hard") else "",
            "season": data.get("season") if data.get("season") in ("all", "spring-autumn", "summer", "dry") else ""}, model, usage


# ── Fejlesztési fa: szabad szöveges ötlet → elhelyezett, megfogalmazott elemek (admin) ─────

_ROADMAP_SYSTEM = """Egy magyar kerékpáros útvonaltervező és edzésnapló alkalmazás (Bringaterv) fejlesztési \
fáját kezeled. Kapsz egy szabad szöveges ötletet, amit az üzemeltető gyorsan leírt, és a jelenlegi fát \
(elemek: id, terület, szülő, cím, állapot – done = kész, todo = tervben).

Feladat: helyezd el az ötletet a fában, és fogalmazd meg szépen.
- Bontsd 1–4 elemre, ha több, egymástól függetlenül megvalósítható részből áll; különben 1 elem.
- Minden elemhez: "cat" (terület azonosítója a listából), "parent" (egy MEGLÉVŐ elem id-ja, ha az ötlet \
annak a kiegészítése vagy része; vagy egy általad adott "temp_id", ha egy másik új elem alá kerül; vagy \
üres szöveg, ha a terület közvetlen eleme), "title" (rövid, tárgyilagos, a fa stílusában: főnévi szerkezet, \
max ~70 karakter, nincs felkiáltójel), "note" (1–2 mondat: mit jelent pontosan, ha az ötletből kiderül; \
különben üres), "temp_id" (egyedi rövid azonosító, pl. "n1").
- Ha az ötlet LÉNYEGÉBEN már szerepel a fában, ne duplikáld: add meg a meglévő elem id-ját a "duplicates" \
listában egy rövid magyarázattal (pl. hogy már kész, vagy már tervben van), és csak az új, eltérő részt \
vedd fel elemként (ha nincs ilyen, az "items" legyen üres).
- Magyarul írj, ne találj ki olyat, ami az ötletben nincs benne."""

_ROADMAP_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {"type": "array", "items": {
            "type": "object",
            "properties": {"temp_id": {"type": "string"}, "cat": {"type": "string"}, "parent": {"type": "string"},
                           "title": {"type": "string"}, "note": {"type": "string"}},
            "required": ["temp_id", "cat", "parent", "title", "note"], "additionalProperties": False}},
        "duplicates": {"type": "array", "items": {
            "type": "object",
            "properties": {"id": {"type": "string"}, "reason": {"type": "string"}},
            "required": ["id", "reason"], "additionalProperties": False}},
    },
    "required": ["items", "duplicates"],
    "additionalProperties": False,
}


def roadmap_suggest(idea: str, cats: dict, tree: list) -> tuple[dict, str, object]:
    payload = {"otlet": idea[:2000], "teruletek": cats, "fa": tree}
    data, model, usage = _call(_ROADMAP_SYSTEM, payload, _ROADMAP_SCHEMA, max_tokens=4000)
    return data, model, usage


# ── Útvonal-javaslat: szabad szöveges kérés → a generátor beállításai ──────────────────────

_ROUTE_SYSTEM = """Egy magyar kerékpáros útvonaltervező (Bringaterv) útvonal-javaslat funkciójához \
fordítod le a felhasználó szabad szöveges kérését beállításokká. A javaslatot egy algoritmus készíti \
(körök vagy A → B kitérők, BRouter-tervezés), te csak a beállításokat töltöd ki.

Mezők:
- "start_place": a rajt helyneve, ha a szöveg megnevezi (pl. "Szentendre", "Budapest, Római part"); \
különben üres. Ha a kapott "jelenlegi_rajt" már be van állítva és a szöveg nem nevez meg mást, legyen üres.
- "loop": true, ha körtúra (oda-vissza ugyanoda); false, ha A-ból B-be (ilyenkor "end_place" a cél).
- "end_place": a cél helyneve A → B esetén; különben üres.
- "km": kért táv km-ben, ha meg van adva; különben 0. "hours": kért időtartam órában (pl. "másfél óra" → 1.5), \
ha az időt adja meg; különben 0. Ha egyik sincs, km legyen 0 és hours 0.
- "surface": "asphalt" (aszfalt, országúti), "gravel" (gravel, murva, földutak), "mixed" (vegyes), \
vagy "" ha nem derül ki.
- "hills": "flat" (sík, kevés emelkedő), "hilly" (dombos, szintes, edzés hegyekkel), "any" vagy "" ha nem derül ki.
- "direction": "N", "E", "S", "W" ha a kör menjen egy égtáj felé (pl. "északra", "a Pilis felé" → a \
rajthoz képest becsült égtáj); különben "".
- "avoid_traffic": true, ha kevés forgalmat, kis utakat, főutak kerülését kéri.
- "prefer_cycleways": true, ha kifejezetten kerékpárutakon, bicikliutakon szeretne menni.
- "max_climb": a leghosszabb egybefüggő emelkedő felső határa méterben, ha erre utal ("nagy emelkedő \
nélkül" → 40, "max 100 m-es emelkedők" → 100); különben 0.
- "summary": egy rövid magyar mondat arról, hogyan értetted ("Így értettem: 2 órás gravel kör \
Szentendréről, kevés forgalommal.").
- "unsupported": a kérés azon részei rövid magyar kifejezésként, amelyeket a fenti mezők nem fednek le \
(pl. "kávézó a felénél", "kilátó érintése", "Esztergomon át"); ha nincs ilyen, üres lista.
Ne találj ki adatot, ami a szövegben nincs benne."""

_ROUTE_SCHEMA = {
    "type": "object",
    "properties": {
        "start_place": {"type": "string"}, "loop": {"type": "boolean"}, "end_place": {"type": "string"},
        "km": {"type": "number"}, "hours": {"type": "number"},
        "surface": {"type": "string", "enum": ["asphalt", "gravel", "mixed", ""]},
        "hills": {"type": "string", "enum": ["flat", "hilly", "any", ""]},
        "direction": {"type": "string", "enum": ["N", "E", "S", "W", ""]},
        "avoid_traffic": {"type": "boolean"}, "prefer_cycleways": {"type": "boolean"}, "max_climb": {"type": "number"},
        "summary": {"type": "string"},
        "unsupported": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["start_place", "loop", "end_place", "km", "hours", "surface", "hills", "direction",
                 "avoid_traffic", "prefer_cycleways", "max_climb", "summary", "unsupported"],
    "additionalProperties": False,
}


def route_request(text: str, current_start: str, loop: bool) -> tuple[dict, str, object]:
    payload = {"keres": text[:500], "jelenlegi_rajt": current_start or "", "jelenleg_kor": loop}
    data, model, usage = _call(_ROUTE_SYSTEM, payload, _ROUTE_SCHEMA, max_tokens=1500)
    num = lambda v, hi: max(0.0, min(hi, float(v or 0)))
    params = {
        "start_place": str(data.get("start_place") or "").strip()[:80],
        "loop": bool(data.get("loop", True)),
        "end_place": str(data.get("end_place") or "").strip()[:80],
        "km": num(data.get("km"), 300), "hours": num(data.get("hours"), 12),
        "surface": data.get("surface") or "", "hills": data.get("hills") or "",
        "direction": data.get("direction") or "", "avoid_traffic": bool(data.get("avoid_traffic")),
        "prefer_cycleways": bool(data.get("prefer_cycleways")),
        "max_climb": num(data.get("max_climb"), 2000),
    }
    unsupported = [str(x).strip()[:80] for x in (data.get("unsupported") or []) if str(x).strip()][:5]
    return {"params": params, "summary": str(data.get("summary") or "").strip()[:300], "unsupported": unsupported}, model, usage
