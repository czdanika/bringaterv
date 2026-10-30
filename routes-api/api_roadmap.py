"""Bringaterv API – fejlesztési fa (admin → Fejlesztések).

  GET    /api/admin/roadmap              minden elem
  POST   /api/admin/roadmap              új ötlet ({cat, parent, title, note})
  PATCH  /api/admin/roadmap/<id>         módosítás (cím, megjegyzés, állapot, verzió, terület, szülő, sorrend)
  DELETE /api/admin/roadmap/<id>         törlés az alpontokkal együtt
  POST   /api/admin/roadmap/import       JSON betöltése ({items: [...], mode: merge | replace})
  POST   /api/admin/roadmap/ai           szabad szöveges ötlet → AI-javaslat (elhelyezés, megfogalmazás); nem ment

A tartalom a szerver adatbázisában van (nem a nyilvános repóban); exportálni a GET-tel lehet.
"""

import re
import uuid

from flask import Blueprint, abort, g, jsonify, request

import ai_service
from auth import require_admin, require_auth
from config import log
from db import _db
from utils import _now_dt

bp = Blueprint("api_roadmap", __name__)

CAT_NAMES = {"ui": "Kezelőfelület", "plan": "Tervezés", "analysis": "Elemzés és edzés", "library": "Könyvtár és közösség",
             "stats": "Statisztika", "ai": "AI-funkciók", "backend": "Háttérfeladatok", "maps": "Saját térképszolgáltatások",
             "ops": "Üzemeltetés és mentés", "security": "Biztonság és adatvédelem", "integr": "Integrációk",
             "docs": "Dokumentáció és bemutató"}
CATS = set(CAT_NAMES)
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _public(r) -> dict:
    return {"id": r["id"], "cat": r["cat"], "parent": r["parent"], "title": r["title"], "note": r["note"],
            "status": r["status"], "version": r["version"], "order": r["ord"], "idea": bool(r["idea"]),
            "created_at": r["created_at"], "updated_at": r["updated_at"]}


def _clean(data: dict, partial: bool) -> dict:
    out = {}
    if "title" in data or not partial:
        title = str(data.get("title") or "").strip()[:140]
        if not title:
            abort(400, description="A cím kötelező.")
        out["title"] = title
    if "note" in data:
        out["note"] = str(data.get("note") or "").strip()[:1500]
    if "cat" in data or not partial:
        if data.get("cat") not in CATS:
            abort(400, description="Ismeretlen terület.")
        out["cat"] = data["cat"]
    if "parent" in data:
        p = data.get("parent") or None
        if p is not None and not _ID_RE.match(str(p)):
            abort(400, description="Érvénytelen szülő.")
        out["parent"] = p
    if "status" in data:
        out["status"] = "done" if data.get("status") == "done" else "todo"
    if "version" in data:
        out["version"] = str(data.get("version") or "").strip()[:20]
    if "order" in data:
        try:
            out["ord"] = int(data["order"])
        except (TypeError, ValueError):
            abort(400, description="Érvénytelen sorrend.")
    return out


@bp.route("/api/admin/roadmap", methods=["GET"])
@require_auth
@require_admin
def roadmap_list():
    with _db() as conn:
        rows = conn.execute("SELECT * FROM roadmap_items ORDER BY cat, ord, title").fetchall()
    return jsonify({"items": [_public(r) for r in rows]})


@bp.route("/api/admin/roadmap", methods=["POST"])
@require_auth
@require_admin
def roadmap_create():
    data = request.get_json(silent=True) or {}
    f = _clean(data, partial=False)
    now = _now_dt()
    rid = uuid.uuid4().hex[:12]
    with _db() as conn:
        if f.get("parent") and not conn.execute("SELECT 1 FROM roadmap_items WHERE id = ?", (f["parent"],)).fetchone():
            abort(400, description="A szülő elem nem létezik.")
        ord_ = conn.execute("SELECT COALESCE(MAX(ord), 0) + 10 FROM roadmap_items WHERE cat = ? AND parent IS ?",
                            (f["cat"], f.get("parent"))).fetchone()[0]
        conn.execute("INSERT INTO roadmap_items (id, cat, parent, title, note, status, version, ord, idea, created_at, updated_at)"
                     " VALUES (?,?,?,?,?,?,?,?,1,?,?)",
                     (rid, f["cat"], f.get("parent"), f["title"], f.get("note", ""), "todo", "", ord_, now, now))
        row = conn.execute("SELECT * FROM roadmap_items WHERE id = ?", (rid,)).fetchone()
    return jsonify(_public(row)), 201


def _descendants(conn, rid: str) -> list:
    out, todo = [], [rid]
    while todo:
        kids = [r["id"] for r in conn.execute(
            f"SELECT id FROM roadmap_items WHERE parent IN ({','.join('?' * len(todo))})", todo)]
        out += kids
        todo = kids
    return out


@bp.route("/api/admin/roadmap/<rid>", methods=["PATCH"])
@require_auth
@require_admin
def roadmap_update(rid: str):
    if not _ID_RE.match(rid):
        abort(404)
    f = _clean(request.get_json(silent=True) or {}, partial=True)
    if not f:
        abort(400, description="Nincs módosítandó mező.")
    with _db() as conn:
        if not conn.execute("SELECT 1 FROM roadmap_items WHERE id = ?", (rid,)).fetchone():
            abort(404, description="Az elem nem található.")
        if f.get("parent") and (f["parent"] == rid or f["parent"] in _descendants(conn, rid)):
            abort(400, description="Egy elem nem lehet a saját alpontja alatt.")
        # szülő alá kerülve a szülő területét veszi fel; területváltáskor a régi szülő elmarad
        if f.get("parent"):
            prow = conn.execute("SELECT cat FROM roadmap_items WHERE id = ?", (f["parent"],)).fetchone()
            if not prow:
                abort(400, description="A szülő elem nem létezik.")
            f["cat"] = prow["cat"]
        elif "cat" in f and "parent" not in f:
            cur = conn.execute("SELECT p.cat FROM roadmap_items i JOIN roadmap_items p ON p.id = i.parent"
                               " WHERE i.id = ?", (rid,)).fetchone()
            if cur and cur["cat"] != f["cat"]:
                f["parent"] = None
        if "parent" in f and "ord" not in f:
            cat = f.get("cat") or conn.execute("SELECT cat FROM roadmap_items WHERE id = ?", (rid,)).fetchone()["cat"]
            f["ord"] = conn.execute("SELECT COALESCE(MAX(ord), 0) + 10 FROM roadmap_items WHERE cat = ? AND parent IS ?"
                                    " AND id != ?", (cat, f["parent"], rid)).fetchone()[0]
        f["updated_at"] = _now_dt()
        conn.execute(f"UPDATE roadmap_items SET {', '.join(k + ' = ?' for k in f)} WHERE id = ?", [*f.values(), rid])
        # területváltásnál az alpontok is mennek
        if "cat" in f:
            for d in _descendants(conn, rid):
                conn.execute("UPDATE roadmap_items SET cat = ? WHERE id = ?", (f["cat"], d))
        row = conn.execute("SELECT * FROM roadmap_items WHERE id = ?", (rid,)).fetchone()
    return jsonify(_public(row))


@bp.route("/api/admin/roadmap/<rid>", methods=["DELETE"])
@require_auth
@require_admin
def roadmap_delete(rid: str):
    if not _ID_RE.match(rid):
        abort(404)
    with _db() as conn:
        ids = [rid, *_descendants(conn, rid)]
        conn.execute(f"DELETE FROM roadmap_items WHERE id IN ({','.join('?' * len(ids))})", ids)
    return jsonify({"deleted": len(ids)})


@bp.route("/api/admin/roadmap/import", methods=["POST"])
@require_auth
@require_admin
def roadmap_import():
    data = request.get_json(silent=True) or {}
    items = data.get("items")
    if not isinstance(items, list) or len(items) > 5000:
        abort(400, description="Érvénytelen fájl: hiányzik az elemlista.")
    replace = data.get("mode") == "replace"
    now = _now_dt()
    n = 0
    with _db() as conn:
        if replace:
            conn.execute("DELETE FROM roadmap_items")
        for it in items:
            if not isinstance(it, dict) or not _ID_RE.match(str(it.get("id") or "")):
                continue
            if it.get("cat") not in CATS or not str(it.get("title") or "").strip():
                continue
            parent = it.get("parent") or None
            conn.execute("""INSERT INTO roadmap_items (id, cat, parent, title, note, status, version, ord, idea, created_at, updated_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?)
                            ON CONFLICT(id) DO UPDATE SET cat=excluded.cat, parent=excluded.parent, title=excluded.title,
                              note=excluded.note, status=excluded.status, version=excluded.version, ord=excluded.ord,
                              idea=excluded.idea, updated_at=excluded.updated_at""",
                         (it["id"], it["cat"], parent if parent and _ID_RE.match(str(parent)) else None,
                          str(it["title"]).strip()[:140], str(it.get("note") or "").strip()[:1500],
                          "done" if it.get("status") == "done" else "todo", str(it.get("version") or "")[:20],
                          int(it.get("order") or 0), 1 if it.get("idea") else 0, now, now))
            n += 1
    log.info("Fejlesztési fa import: %d elem (%s, admin: %s)", n, "csere" if replace else "összefésülés", g.user["email"])
    return jsonify({"imported": n})


@bp.route("/api/admin/roadmap/ai", methods=["POST"])
@require_auth
@require_admin
def roadmap_ai():
    """Javaslat: az AI elhelyezi és megfogalmazza az ötletet. Nem ment – az admin hagyja jóvá."""
    if not ai_service.api_key():
        abort(503, description="Az AI-funkció nincs beállítva (admin → AI).")
    idea = str((request.get_json(silent=True) or {}).get("idea") or "").strip()
    if len(idea) < 3:
        abort(400, description="Írd le az ötletet.")
    with _db() as conn:
        rows = conn.execute("SELECT id, cat, parent, title, status, version FROM roadmap_items ORDER BY cat, ord").fetchall()
    tree = [{"id": r["id"], "cat": r["cat"], "parent": r["parent"] or "", "title": r["title"],
             "status": r["status"], **({"version": r["version"]} if r["version"] else {})} for r in rows]
    try:
        data, model, usage = ai_service.roadmap_suggest(idea, CAT_NAMES, tree)
    except ai_service.AIError as exc:
        abort(502, description=str(exc))
    ai_service.log_usage(g.user["id"], "roadmap", "", model, usage)

    existing = {t["id"]: t for t in tree}
    items, temp_ids = [], set()
    for it in (data.get("items") or [])[:4]:
        cat = it.get("cat") if it.get("cat") in CATS else None
        title = str(it.get("title") or "").strip()[:140]
        tid = re.sub(r"[^A-Za-z0-9_-]", "", str(it.get("temp_id") or ""))[:20] or f"n{len(items) + 1}"
        if not cat or not title or tid in temp_ids:
            continue
        parent = str(it.get("parent") or "").strip()
        if parent in existing:
            cat = existing[parent]["cat"]          # alpont: a szülő területén
        elif parent not in temp_ids:
            parent = ""                            # ismeretlen szülő → a terület közvetlen eleme
        temp_ids.add(tid)
        items.append({"temp_id": tid, "cat": cat, "parent": parent, "title": title,
                      "note": str(it.get("note") or "").strip()[:1500]})
    dups = [{"id": d["id"], "title": existing[d["id"]]["title"], "status": existing[d["id"]]["status"],
             "version": existing[d["id"]].get("version", ""), "reason": str(d.get("reason") or "")[:300]}
            for d in (data.get("duplicates") or []) if isinstance(d, dict) and d.get("id") in existing][:5]
    return jsonify({"items": items, "duplicates": dups})
