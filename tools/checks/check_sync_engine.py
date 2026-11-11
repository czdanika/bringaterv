"""Ellenőrzés: a közös automatikus import-motor (routes-api/sync_engine.py) egy kitalált
szolgáltatóval – hálózat és valódi fiók nélkül. A szerver konténerében fut (ott vannak a
függőségek), ideiglenes adatmappával:

    sshpass -p 'admin' ssh admin@192.168.0.136 \
      "cd /home/admin/bringaterv && docker-compose exec -T routes-api python -" < tools/checks/check_sync_engine.py

Kimenet: „OK …” soronként, hibánál AssertionError. Mit néz:
  - nincs kapcsolat → hibaüzenet + push (alert_on_failure), és csak egyszer
  - lekérdezési hiba → hibaüzenet, push nélkül; a kapcsolat helyreállta törli a jelzést
  - import: az új edzés bekerül, a GPS nélküli / ismétlődő kihagyva (skip_ids), körönként legfeljebb 10
  - importhiba → a kör megáll, a hiba látszik
  - lejárat: 1 nappal előtte és lejáratkor egy-egy push
  - kikapcsolt integráció → a háttérkör nem fut (integrations.is_enabled)
"""
import os
import sys
import tempfile
import time

tmp = tempfile.mkdtemp()
os.environ["MULTI_DATA_DIR"] = os.path.join(tmp, "users")
os.environ["SITE_SETTINGS"] = os.path.join(tmp, "site_settings.json")
sys.path.insert(0, "/app")
os.makedirs(os.path.join(tmp, "users", "u1", "routes"), exist_ok=True)

import notify          # noqa: E402
import strava_sync     # noqa: E402
import sync_engine as se  # noqa: E402

sent = []
notify.send = lambda uid, kind, title, body, **kw: sent.append(title)
strava_sync._notify_workout = lambda uid, e: sent.append("workout:" + e["name"])
strava_sync._notify_records = lambda *a, **k: None


class Fake(se.SyncProvider):
    key, label, article = "fake", "Teszt", "a"
    alert_on_failure = True

    def __init__(self):
        self.mode, self.rows, self.exp, self.fail_import = "ok", [], 0, None
        self.have = set()      # a valódi szolgáltatók ezt a könyvtárból (index.json) nézik

    def open(self, uid):
        return None if self.mode == "nocon" else "sess"

    def candidates(self, sess, uid, data, dedup):
        if self.mode == "listfail":
            raise se.SyncError("lista hiba")
        skip = set(data.get("skip_ids") or [])
        return [(r["id"], r) for r in self.rows if r["id"] not in skip and r["id"] not in self.have]

    def import_one(self, sess, uid, rid, row, dedup):
        if self.fail_import == rid:
            raise se.SyncError("import hiba")
        if row.get("nogps"):
            return {"ok": False}
        if row.get("dup"):
            return {"ok": True, "reason": "duplicate"}
        self.have.add(rid)
        return {"ok": True, "entry": {"id": "w" + rid, "name": "Edzés " + rid}}

    def expires_at(self, uid):
        return self.exp


p = Fake()
s = se.AutoSync(p)
s.update_settings("u1", True, 15)

p.mode = "nocon"
d = s.sync_user("u1"); d2 = s.sync_user("u1")
assert "Nincs Teszt-kapcsolat" in d["last_error"] and sent.count("Teszt-kapcsolat megszakadt") == 1, sent
print("OK nincs kapcsolat → hiba + egyszeri push")

p.mode = "listfail"; sent.clear()
d = s.sync_user("u1")
assert d["last_error"] == "lista hiba" and not sent
print("OK lekérdezési hiba → üzenet, push nélkül")

p.mode = "ok"
p.rows = [{"id": "1"}, {"id": "2", "nogps": True}, {"id": "3", "dup": True}] + [{"id": str(i)} for i in range(10, 22)]
d = s.sync_user("u1")
assert d["last_error"] is None and not d["conn_alerted"]
assert d["last_imported"] == 8 and set(d["skip_ids"]) == {"2", "3"}, d     # 10 próbálkozás: 1 + 8 új, 2 kihagyva (a sorrend: 1,2,3,10..16)
d = s.sync_user("u1")
assert d["last_imported"] == 5 and d["total_imported"] == 13, d           # a maradék a következő körben
print("OK import: új bekerül, GPS nélküli / ismétlődő kihagyva, körönként legfeljebb 10")

p.rows = [{"id": "50"}, {"id": "51"}]; p.fail_import = "50"
d = s.sync_user("u1")
assert d["last_error"] == "import hiba" and d["last_imported"] == 0
print("OK importhiba → a kör megáll")

sent.clear(); p.fail_import = None
p.exp = time.time() + 3600
d = s.sync_user("u1"); s.sync_user("u1")
assert sent.count("Holnap lejár a Teszt-belépés") == 1, sent
p.exp = time.time() - 10
s.sync_user("u1"); s.sync_user("u1")
assert sent.count("Lejárt a Teszt-belépés") == 1, sent
print("OK lejárat: egy push előtte, egy lejáratkor")

import integrations  # noqa: E402
import site_settings  # noqa: E402
integrations.KEYS.add("fake")
site_settings.save({"integrations_off": ["fake"]})
assert not integrations.is_enabled("fake")
site_settings.save({"integrations_off": []})
assert integrations.is_enabled("fake")
print("OK kikapcsolás az adminból")
print("MINDEN ELLENŐRZÉS RENDBEN")
