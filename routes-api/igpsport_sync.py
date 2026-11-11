"""Bringaterv – automatikus iGPSport import (háttér-szinkron) + lejárat-figyelmeztetés.

A közös motor (sync_engine.py) végzi az ütemezést, az állapotot és az értesítéseket; itt
csak az iGPSport sajátosságai vannak. Felhasználónként bekapcsolható (Beállítások →
iGPSport, vagy az import ablak teteje), 5 / 15 / 30 / 60 percenként a legutóbbi 20 edzést
nézi. Az iGPSport-belépés 7 napig érvényes (refresh nincs) → a lejárat előtt egy nappal
push-értesítés, lejáratkor még egy; az új belépés ezeket visszaállítja (api_igpsport.connect).

Állapot: /data/users/<uid>/igpsport_sync.json
"""

from datetime import datetime, timezone

from sync_engine import AutoSync, SyncError, SyncProvider

LOOKBACK_ITEMS = 20


class IgpsportSync(SyncProvider):
    key, label, article = "igpsport", "iGPSport", "az"
    env_flag = "IGPSPORT_AUTO_SYNC"
    conn_file = "igpsport.json"
    expiry_hint = " (7 naponta kell)"

    def open(self, user_id):
        from igpsport_service import IgpAuthError, igp_token
        try:
            return igp_token(user_id)
        except IgpAuthError as exc:
            raise SyncError(f"{exc} Csatlakozz újra a Beállításokban.")

    def candidates(self, token, user_id, data, dedup):
        from igpsport_service import IgpApiError, IgpAuthError, list_rides, load_deny
        try:
            rows = list_rides(token, LOOKBACK_ITEMS)
        except IgpAuthError:
            raise SyncError("Az iGPSport elutasította a hozzáférést – csatlakozz újra a Beállításokban.")
        except IgpApiError as exc:
            raise SyncError(str(exc))
        have, deny, skip = self.index_ids(user_id, "igpsport_id"), load_deny(user_id), set(data.get("skip_ids") or [])
        # a bekapcsolás előtti napoknál régebbit nem hozza (a lista dátuma elég ehhez)
        since = datetime.fromtimestamp(self.since_ts(data), timezone.utc).strftime("%Y.%m.%d")
        todo = [r for r in rows
                if str(r["rideId"]) not in have and str(r["rideId"]) not in deny and str(r["rideId"]) not in skip
                and float(r.get("rideDistance") or 0) > 0 and str(r.get("startTime") or "")[:10] >= since]
        return [(str(r["rideId"]), r) for r in reversed(todo)]        # régebbi elöl

    def import_one(self, token, user_id, rid, row, dedup):
        from igpsport_service import IgpApiError, IgpAuthError, igp_import_activity
        try:
            return igp_import_activity(token, user_id, rid, dedup=dedup)
        except IgpAuthError:
            raise SyncError("Lejárt az iGPSport-belépés – csatlakozz újra a Beállításokban.")
        except IgpApiError as exc:
            raise SyncError(str(exc))

    def expires_at(self, user_id):
        from igpsport_service import _load
        conn = _load(user_id)
        return int(conn.get("expires_at") or 0) if conn.get("token") else 0


_SYNC = AutoSync(IgpsportSync())
globals().update(_SYNC.module_api())
