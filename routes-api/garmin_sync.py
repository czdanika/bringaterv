"""Bringaterv – automatikus Garmin Connect import (háttér-szinkron).

A közös motor (sync_engine.py) végzi az ütemezést, az állapotot és az értesítéseket; itt
csak a Garmin sajátosságai vannak: a legutóbbi 50 edzésből az utolsó LOOKBACK_DAYS nap
(a bekapcsolás előttieket nem), eredeti FIT → GPX. Nem hivatalos API: a 429-es (túl sok
kérés) válasznál a kör kimarad, és a következő körben folytatja.

Állapot: /data/users/<uid>/garmin_sync.json
"""

from datetime import datetime

from sync_engine import AutoSync, SyncError, SyncProvider

LOOKBACK_DAYS = 7


def _start_ts(a: dict) -> int:
    try:
        return int(datetime.fromisoformat(a["start_date"]).timestamp())
    except (KeyError, TypeError, ValueError):
        return 0


class GarminSync(SyncProvider):
    key, label, article = "garmin", "Garmin", "a"
    env_flag = "GARMIN_AUTO_SYNC"
    alert_on_failure = True

    def open(self, user_id):
        from garmin_service import GarminConnectAuthenticationError, garmin_client
        try:
            return garmin_client(user_id)
        except GarminConnectAuthenticationError:
            raise SyncError("A Garmin elutasította a belépést – csatlakozz újra a Beállításokban.", alert=True)

    def candidates(self, garmin, user_id, data, dedup):
        from garmin_service import (GarminConnectAuthenticationError, GarminConnectTooManyRequestsError,
                                    garmin_list_activities)
        try:
            items = garmin_list_activities(garmin, user_id, limit=50)
        except GarminConnectAuthenticationError:
            raise SyncError("A Garmin elutasította a belépést – csatlakozz újra a Beállításokban.", alert=True)
        except GarminConnectTooManyRequestsError:
            raise SyncError("A Garmin átmenetileg korlátozza a lekérdezést – a következő körben újra próbálja.")
        start = self.since_ts(data, LOOKBACK_DAYS)
        skip = set(str(x) for x in (data.get("skip_ids") or []))
        # a duplikátum-jelzést a lista adja (már importált / más forrásból meglévő)
        wanted = ("new",) if dedup else ("new", "likely_duplicate")
        todo = sorted((a for a in items
                       if a["duplicate_status"] in wanted and _start_ts(a) >= start and str(a["id"]) not in skip),
                      key=_start_ts)
        return [(a["id"], a) for a in todo]

    def import_one(self, garmin, user_id, rid, row, dedup):
        from garmin_service import GarminConnectTooManyRequestsError, garmin_import_activity
        try:
            return garmin_import_activity(garmin, user_id, rid, dedup=dedup)
        except GarminConnectTooManyRequestsError:
            raise SyncError("A Garmin átmenetileg korlátozza a letöltést – a következő körben folytatja.")


_SYNC = AutoSync(GarminSync())
globals().update(_SYNC.module_api())
