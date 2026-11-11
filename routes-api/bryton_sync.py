"""Bringaterv – automatikus Bryton import (háttér-szinkron) + lejárat-figyelmeztetés.

A közös motor (sync_engine.py) végzi az ütemezést, az állapotot és az értesítéseket; itt
csak a Bryton sajátosságai vannak (Meteor DDP munkamenet, a legutóbbi 20 edzés). A
belépés ~90 napig érvényes → lejárat előtt egy nappal push, lejáratkor még egy.

Állapot: /data/users/<uid>/bryton_sync.json
"""

from sync_engine import AutoSync, SyncError, SyncProvider

LOOKBACK_ITEMS = 20


class BrytonSync(SyncProvider):
    key, label, article = "bryton", "Bryton", "a"
    env_flag = "BRYTON_AUTO_SYNC"
    conn_file = "bryton.json"

    def open(self, user_id):
        from bryton_service import BrytonAuthError, bryton_session
        try:
            return bryton_session(user_id)
        except BrytonAuthError as exc:
            raise SyncError(f"{exc} Csatlakozz újra a Beállításokban.")

    def candidates(self, sess, user_id, data, dedup):
        from bryton_service import BrytonApiError, BrytonAuthError, list_raw, load_deny
        try:
            rows = list_raw(sess)[:LOOKBACK_ITEMS]
        except BrytonAuthError:
            raise SyncError("A Bryton elutasította a hozzáférést – csatlakozz újra a Beállításokban.")
        except BrytonApiError as exc:
            raise SyncError(str(exc))
        have, deny, skip = self.index_ids(user_id, "bryton_id"), load_deny(user_id), set(data.get("skip_ids") or [])
        since = self.since_ts(data) - 14 * 3600      # a helyi kezdési idő miatt kis ráhagyás
        todo = [r for r in rows
                if str(r["_id"]) not in have and str(r["_id"]) not in deny and str(r["_id"]) not in skip
                and float((r.get("summary") or {}).get("total_distance") or 0) > 0
                and int(r.get("local_start_time") or 0) >= since]
        return [(str(r["_id"]), r) for r in reversed(todo)]           # régebbi elöl

    def import_one(self, sess, user_id, rid, row, dedup):
        from bryton_service import BrytonApiError, BrytonAuthError, bryton_import_activity
        try:
            return bryton_import_activity(sess, user_id, rid, dedup=dedup)
        except BrytonAuthError:
            raise SyncError("Lejárt a Bryton-belépés – csatlakozz újra a Beállításokban.")
        except BrytonApiError as exc:
            raise SyncError(str(exc))

    def expires_at(self, user_id):
        from bryton_service import _load
        conn = _load(user_id)
        return int(conn.get("expires_at") or 0) if conn.get("token") else 0


_SYNC = AutoSync(BrytonSync())
globals().update(_SYNC.module_api())
