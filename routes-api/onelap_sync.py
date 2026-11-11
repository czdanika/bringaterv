"""Bringaterv – automatikus OnelapFit (Magene, GEOID) import (háttér-szinkron).

A közös motor (sync_engine.py) végzi az ütemezést, az állapotot és az értesítéseket; itt
csak az OnelapFit sajátosságai vannak. Az Onelapnak nincs webhookja, ezért időközös
ellenőrzés: egy kör az utolsó LOOKBACK_DAYS nap edzéseit nézi (a bekapcsolás előttieket
nem), így a később szinkronizált edzés is bekerül. Elutasított belépésnél a tárolt
kapcsolat törlődik, és egyszer push-értesítés megy.

Állapot: /data/users/<uid>/onelap_sync.json
"""

import time

from sync_engine import AutoSync, SyncError, SyncProvider

LOOKBACK_DAYS = 7


class OnelapSync(SyncProvider):
    key, label, article = "onelap", "OnelapFit", "az"
    env_flag = "ONELAP_AUTO_SYNC"
    alert_on_failure = True

    def open(self, user_id):
        from onelap_service import OnelapApiError, OnelapAuthError, _delete_user_onelap, onelap_session
        try:
            return onelap_session(user_id)
        except OnelapAuthError:
            _delete_user_onelap(user_id)
            return None                              # → „Nincs OnelapFit-kapcsolat”, push
        except OnelapApiError as exc:
            raise SyncError(str(exc))

    def candidates(self, sess, user_id, data, dedup):
        from onelap_service import OnelapApiError, OnelapAuthError, _delete_user_onelap, _list_rides, _load_onelap_deny
        now = int(time.time())
        try:
            rides = _list_rides(sess, self.since_ts(data, LOOKBACK_DAYS), now + 86400)
        except OnelapAuthError:
            _delete_user_onelap(user_id)
            raise SyncError("Az OnelapFit elutasította a hozzáférést – csatlakozz újra a Beállításokban.", alert=True)
        except OnelapApiError as exc:
            raise SyncError(str(exc))
        have, deny, skip = self.index_ids(user_id, "onelap_id"), _load_onelap_deny(user_id), set(data.get("skip_ids") or [])
        todo = sorted((r for r in rides
                       if r.get("did") and (r.get("distance") or 0) > 0
                       and str(r["did"]) not in have and str(r["did"]) not in deny and str(r["did"]) not in skip),
                      key=lambda r: int(r.get("start_time") or 0))
        return [(str(r["did"]), r) for r in todo]

    def import_one(self, sess, user_id, rid, row, dedup):
        from onelap_service import OnelapApiError, OnelapAuthError, onelap_import_activity
        try:
            return onelap_import_activity(sess, user_id, rid, int(row.get("start_time") or 0), dedup=dedup)
        except OnelapAuthError:
            raise SyncError("Az OnelapFit elutasította a hozzáférést – csatlakozz újra a Beállításokban.")
        except OnelapApiError as exc:
            raise SyncError(str(exc))


_SYNC = AutoSync(OnelapSync())
globals().update(_SYNC.module_api())
