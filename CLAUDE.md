# Bringaterv – fejlesztési kontextus

## Projekt összefoglalás
Kerékpáros/túra útvonaltervező és edzésnaplózó web app.
- **Frontend:** Vanilla JS (ES modules), Leaflet térkép, nginx statikus szerver
- **Backend:** Flask + gunicorn Python API, SQLite + per-user JSON fájltárolás
- **Deployment:** Docker Compose, Pi (teszt) / TerrraMaster NAS (éles)

**Főbb funkciók:**
- GPX és FIT fájl import, elemzés (sebesség, HR, kadencia, teljesítmény, szintemelkedés)
- Útvonaltervezés (BRouter alapú routing, szegmensenként eltérő mód, szél-elemzés)
- Edzéskönyvtár: kártya/lista nézet, sport-szűrő, szerkesztés, megosztó kép generálás
- **Strava integráció:** OAuth kapcsolat, aktivitások importálása, per-user app credentials
- Statisztikák: havi bontás (kalória, Eddington, sport-lebontás), rekordok, Eddington-szám sportonként, edzésterhelés (CTL/ATL/TSB, A:C arány, monotonitás), hőtérkép
- Beállítások: HR zóna (Karvonen), sebesség/kadencia/power zóna csúszkák, kerékpáros profil, backup/restore

## Repó struktúra
```
/
├── index.html              # SPA belépési pont
├── login.html              # Bejelentkezési oldal
├── docker-compose.yml      # Pi / lokális build
├── docker-compose-nas.yml  # NAS / éles (ghcr.io image-ek)
├── nginx.conf              # Frontend szerver + /api/ proxy → routes-api:5001
├── routes-api/
│   ├── app.py              # Flask app + blueprint regisztráció + health + hibakezelés (~100 sor)
│   ├── config.py           # Env változók, logging
│   ├── utils.py            # Közös helperek (_safe_id, index load/save, dátum)
│   ├── security.py         # bcrypt jelszó hash + JWT token
│   ├── storage.py          # Per-user fájltárolás (mappák, settings.json, storage stats)
│   ├── db.py               # SQLite séma, migrációk (v1–v6), _db_create_user
│   ├── auth.py             # require_auth / require_admin dekorátorok
│   ├── api_auth.py         # /api/auth/* + /api/user/settings
│   ├── api_admin.py        # /api/admin/users*, /api/admin/stats
│   ├── api_routes.py       # /api/routes* (CRUD, geometry-bulk, FIT)
│   ├── api_samples.py      # /api/samples* + /api/admin/samples*
│   ├── api_backup.py       # backup/restore ZIP (user + admin)
│   ├── strava_service.py   # Strava helperek (token refresh, app config, deny-list, GPX builder)
│   ├── api_strava.py       # /api/strava/* + /api/admin/strava/config
│   └── Dockerfile          # Python 3.13-alpine, gunicorn :5001 (COPY *.py)
└── src/
    ├── main.js             # Fő app belépési pont (~2865 sor) – orchestrálja a modulokat
    ├── styles.css          # Teljes CSS
    ├── version.js          # APP_VERSION egyetlen forrás
    ├── config.js           # Login enabled flag (docker-entrypoint injektálja)
    ├── auth.js             # JWT kezelés, requireAuth, logout
    ├── appSettings.js      # LocalStorage beállítások (getSettings, saveSetting)
    ├── karvonen.js         # HR zóna számítás (calculateZones, calculateTRIMP, ZONE_DEFS_FRIEL)
    ├── calories.js         # MET-alapú kalóriabecslés (estimateKcal) – használja statsPanel.js
    ├── api/
    │   └── routesApi.js    # Backend API kliens (fetch wrapper-ek, strava.* alcsoport)
    ├── gpx/
    │   ├── gpx.js          # GPX import/export, calcElevationFromGeometry, calcTiming
    │   └── fit.js          # FIT → GPX konverzió (fitToGpx)
    ├── i18n/
    │   ├── i18n.js
    │   └── translations.js # hu / en szótár
    ├── map/
    │   ├── mapAdapter.js   # Leaflet wrapper (createMapAdapter, SEGMENT_COLORS)
    │   └── surfaceAnalysis.js
    ├── state/
    │   └── routeStore.js   # Tervező route state (waypoints, geometry)
    ├── wind/
    │   └── windService.js  # Open-Meteo API + szélkomponens számítás
    └── ui/
        ├── dom.js          # createToast, formatDistance
        ├── search.js       # Nominatim helykeresés (searchPlaces, reverseGeocode)
        ├── elevationProfile.js  # Canvas szintprofil/sebesség/HR/kad/power chart
        ├── shareCard.js    # Canvas megosztó kép generálás (createWorkoutShareCard)
        ├── statsPanel.js   # Statisztika renderelők: renderStats, renderMonthlyTable
        │                   #   (kalória+Eddington+sport-bontás), renderRecordsFull,
        │                   #   renderEddington (sportonkénti chipek), renderTrainingLoad
        │                   #   (CTL/ATL/TSB + A:C + monotonitás + napi bars), renderHeatmapCanvas
        ├── statsManager.js # Stats fül orchestrátor (initStats, loadAndRenderStats,
        │                   #   showHeatmap – csak edzéseket mutat, Elemzés gomb a popupban)
        ├── library.js      # Könyvtár fül: kártya/lista nézet, szűrők, szerkesztő,
        │                   #   Strava import indítása, loadRouteLibrary
        ├── wind.js         # Szélelemzés UI (initWind, renderWindResult,
        │                   #   scheduleWindRunIfActive, getWindResult)
        ├── fileTab.js      # Elemzés fül: GPX/FIT import, fájl statisztikák,
        │                   #   drag&drop, share card modal, mentés könyvtárba (initFileTab)
        ├── strava.js       # Strava OAuth, app credentials beállítás, aktivitás lista,
        │                   #   import modal progress bar (initStrava, getStravaStatus)
        ├── settings.js     # Beállítások panel: HR zóna (Karvonen), sebesség/kad/power
        │                   #   zóna csúszkák, diagram színek, kerékpáros profil,
        │                   #   backup/restore (initSettings, getCyclistProfile,
        │                   #   buildHrZoneColorFn, renderHrZoneAnalysis)
        └── planning.js     # Tervező fül: renderSidebar, waypont lista drag&drop,
                            #   szegmens-picker, navigáció toggle, sebességcsúszkák,
                            #   formatDisplayDistance, calculateImportedDistance (initPlanning)
```

## Modulok – melyik mit tartalmaz

Ha egy területen fejlesztesz, **csak az adott modult** kell megnyitnod:

| Modul | Tartalom | Init hívás |
|-------|----------|------------|
| `ui/wind.js` | Szélelemzés UI, időpont-picker, eredmény renderelés, térkép-színezés | `initWind({...})` |
| `ui/fileTab.js` | GPX/FIT import, fájl statisztikák, drag&drop, share card modal, mentés könyvtárba | `initFileTab({...})` |
| `ui/strava.js` | Strava OAuth, per-user app credentials, aktivitás lista, import modal (progress bar, szűrés, duplikátum-jelzés) | `initStrava({...})` |
| `ui/settings.js` | HR zóna (Karvonen dual-handle slider), sebesség/kad/power multi-slider, diagram színek, kerékpáros profil, backup/restore | `initSettings({...})` |
| `ui/planning.js` | `renderSidebar`, waypont lista, szegmens-picker, navigáció toggle, sebességcsúszkák, `formatDisplayDistance`, `calculateImportedDistance` | `initPlanning({...})` |
| `ui/library.js` | Könyvtár fül: kártya/lista nézet, szűrők, szerkesztő modal, Strava import indítása | `initLibrary({...})` |
| `ui/statsPanel.js` | Statisztika renderelők: KPI áttekintő, havi tábla (kalória, Eddington, sport-bontás expand), rekordok, Eddington (sportonkénti chipek), edzésterhelés (CTL/ATL/TSB, A:C, monotonitás, napi bars, TSB ref-vonalak), hőtérkép canvas | közvetlen importok |
| `ui/statsManager.js` | Stats fül: nézet váltás, hőtérkép (csak edzések, Elemzés gomb popupban) | `initStats({...})` |

## Strava integráció – adatfolyam

```
library.js  →  openStravaImportModal()  →  strava.js (import UI)
                                                ↓
                                    routesApi.strava.importActivity(id)
                                                ↓
                                    backend: POST /api/strava/import/<id>
                                    (GPX generálás Strava API-ból, mentés type=workout)
                                                ↓
                                    loadRouteLibrary()  →  library frissítés
```

A Strava kapcsolat beállítása a **Beállítások** panelen belül van (`settings.js` + `strava.js`).  
Az import-gomb a **Könyvtár** fül importálás dropdown-jában jelenik meg (`library.js`).

## Dependency Injection minta

Minden modul `initXxx(deps)` hívással kap injektált függőségeket. Példa:

```js
// main.js
import { initWind, clearWindResult } from "./ui/wind.js";

initWind({
  mapAdapter,
  store,
  onRenderSidebar: () => renderSidebar(store.getState()),
  getActiveGeometry: () => activeGeometry,
  elements,
  visibleSections,
  applyRouteLayer,
  syncElevationBtnState,
});
```

A modulok belső state-je privát (`let _mapAdapter, ...`), a szükséges getterek exportálva:
- `ui/wind.js` → `getWindResult()`
- `ui/fileTab.js` → `getHasImportedFile()`, `getImportedColoredGeometry()`, `setLoadedRoute()`, stb.
- `ui/settings.js` → `buildHrZoneColorFn()`, `getCyclistProfile()`, `gradeColorForGrade()`, `renderHrZoneAnalysis()`, stb.
- `ui/planning.js` → `renderSidebar()`, `formatDisplayDistance()`, `getSelectedWaypointId()`, stb.
- `ui/strava.js` → `getStravaStatus()`

## main.js – mi maradt benne

`main.js` (~2865 sor) az orchestrátor:
- Import-ok és init hívások sorrendje (initLibrary → initStats → initWind → initFileTab → initPlanning → initSettings → initStrava)
- `elements` DOM referencia objektum
- `store`, `mapAdapter` példányosítás
- `switchTab()`, `applyRouteLayer()`, `updateElevationButton()` – UI koordinátor
- Chart példányok (elevation, speed, HR, cad, power) + chart section management
- Export modal (`buildExportPayload`, `openExportModal`, `calcEstimatedTime`)
- `loadRouteFromLibrary()`, `showLoadPreview()` – könyvtár→tervező híd
- `calcEstimatedTimeMixed()` – időbecslés (injektálva planning.js-be és fileTab.js-be)
- `clearAllRouteState()` – teljes reset
- Douglas-Peucker + `buildAnchorWaypoints` – waypoint-generáló
- `runSearch()`, `renderSearchResults()` – helykeresés
- Toolbar drag&drop, eszköztár sorrend, térkép/szintprofil stílus váltók
- Kezdő nézet mentés/GPS, settings togglek inicializálása

## Frontend főbb state változók

**main.js-ben:**
```js
store             // createRouteStore() – tervező waypoints + geometry
mapAdapter        // createMapAdapter() – Leaflet wrapper
elements          // DOM referenciák objektuma (egyetlen helyen definiált)
currentTab        // "plan" | "file" | "library" | "stats"
activeGeometry    // aktuálisan megjelenített geometria tömb
visibleSections   // Set – nyitott chart szekciók ("elevation", "wind" stb.)
elevationTimeEnabled  // bool – szintkülönbség figyelembe vétele az időbecslésben
_libraryData      // { routes: [], workouts: [], samples: [] }
_libraryFilter    // { type, source, sport, query, sort, ... }
units             // "metric" | "imperial"
```

**Modulokban (getterekkel):**
```js
// ui/fileTab.js
getHasImportedFile()          // bool
getImportedColoredGeometry()  // geometry | null
getImportedHrGeometry()       // geometry | null
getImportedCadGeometry()      // geometry | null
getImportedPowerGeometry()    // geometry | null

// ui/planning.js
getSelectedWaypointId()       // string | null

// ui/wind.js
getWindResult()               // { segments, stats, coverage } | null

// ui/strava.js
getStravaStatus()             // { connected, app_configured, athlete_name, ... } | null
```

## Navigáció / tab rendszer
- Fő fülek: `data-tab="plan|file|library|stats"` – `switchTab(name)` váltja
- Stats al-navigáció: `data-stats-view="overview|monthly|records|eddington|training|heatmap"`
- Collapse: `#navToggle` (header) + `#railNavToggle` (rail alján) – `is-nav-collapsed` class
- Library / Stats módban a térkép rejtett, `#libraryMain` / `#statsMain` látható

## Adatmodell – edzés vs. útvonal

Az index.json bejegyzésekben:
- `type: "workout"` → edzés (FIT/Strava import, vagy Elemzés fülről mentett GPX)
- `type: "cycling"|"gravel"|"mtb"|"hiking"` → tervezett útvonal
- `include_in_stats: false` → kizárva a statisztikákból (tervezett útvonalaknál alapból)
- `sport_type` → a tényleges sport (cycling/running/walking/hiking) – Strava importnál töltődik

A statisztikák csak `type === "workout"` és `include_in_stats !== false` bejegyzésekből számolnak.

## Backend API végpontok (routes-api/api_*.py modulok)
```
POST   /api/auth/login                  Bejelentkezés → JWT
GET    /api/routes                      Útvonalak listája (routes + workouts)
POST   /api/routes                      Új útvonal/edzés mentése
GET    /api/routes/geometry-bulk        Csak edzések geometriája (hőtérképhez)
GET    /api/routes/<id>                 GPX szöveg letöltése
PATCH  /api/routes/<id>                 Metaadat frissítés (name, type, include_in_stats stb.)
DELETE /api/routes/<id>                 Törlés
GET    /api/routes/<id>/fit             Eredeti FIT bináris
GET    /api/samples                     Minta útvonalak lista
GET    /api/samples/<id>                Minta GPX
GET    /api/user/settings               Felhasználó beállítások
PUT    /api/user/settings               Beállítások mentése
GET    /api/user/backup                 ZIP backup letöltés
POST   /api/user/restore                ZIP restore
GET    /api/strava/status               Strava kapcsolat állapot + app_configured flag
GET    /api/strava/connect              OAuth URL lekérése (popup nyitáshoz)
DELETE /api/strava/disconnect           Lecsatlakozás
GET    /api/strava/activities           Aktivitások listája (duplikátum-jelzéssel)
POST   /api/strava/import/<id>          Strava edzés importálása GPX-sé
GET    /api/strava/app-config           Per-user Strava app credentials lekérése
PUT    /api/strava/app-config           Per-user credentials mentése
DELETE /api/strava/app-config           Credentials törlése
/api/admin/...                          Admin végpontok (felhasználók, kvóták)
```

## Deployment – Pi (teszt)
- **IP:** 192.168.0.136 | **SSH user:** admin | **SSH password:** admin
- **App URL:** http://192.168.0.136:8088
- **Projekt mappa:** /home/admin/bringaterv

```bash
# Fájlok másolása (--relative megőrzi a könyvtárstruktúrát!)
sshpass -p 'admin' rsync -avz --relative <fájlok> admin@192.168.0.136:/home/admin/bringaterv/

# ⚠️ FONTOS: ha új src/ui/*.js modult hozol létre, azt is ki kell küldeni!
# A Docker a Pi helyi fájljaiból buildel – csak azt látja, amit rsync-kel kaptott.
# Teljes ui/ kiküldése (ajánlott ha sok fájl változott):
# sshpass -p 'admin' rsync -avz --relative src/ui/ src/main.js src/styles.css index.html admin@192.168.0.136:/home/admin/bringaterv/

# Ha backend (routes-api/*.py) változott – force rebuild kell:
# ⚠️ Backend modulok: app.py mellett config/db/auth/api_*/strava_service stb. – mindet rsync-elni kell!
sshpass -p 'admin' ssh admin@192.168.0.136 \
  "cd /home/admin/bringaterv && docker-compose build --no-cache routes-api && docker-compose up -d"

# Ha csak frontend változott:
sshpass -p 'admin' ssh admin@192.168.0.136 \
  "cd /home/admin/bringaterv && docker-compose up -d --build bringaterv"
```
**Fontos:** a frontend az image-be van bake-elve (Dockerfile COPY), ezért `restart` nem elég – mindig `up -d --build` kell frontend változásnál. Backend változásnál `--no-cache` kell, különben Docker cache-ből buildel.

## Deployment – NAS (éles)
Portainer → Stacks → Pull and redeploy.
A `ghcr.io/czdanika/bringaterv*:latest` image-eket a GitHub Actions buildeli push/release-kor.

## Jelenlegi verzió
v1.2.1

## Fontos szabályok
- **Soha nem commitolunk Claude-attribúciót** (no Co-Authored-By)
- **Githubra terveket nem tolunk** – csak kész kód
- Az `index.html` szlogenje: „Tervezz, tekerj, fedezd fel!"
- A `src/version.js` az egyetlen forrás a verzióhoz
