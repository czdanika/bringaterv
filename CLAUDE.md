# Bringaterv – fejlesztési kontextus

## Projekt összefoglalás
Kerékpáros/túra útvonaltervező és edzésnaplózó web app.
- **Frontend:** Vanilla JS (ES modules), Leaflet térkép, nginx statikus szerver
- **Backend:** Flask + gunicorn Python API, SQLite + per-user JSON fájltárolás
- **Deployment:** Docker Compose, Pi (teszt) / TerrraMaster NAS (éles)

## Repó struktúra
```
/
├── index.html              # SPA belépési pont
├── login.html              # Bejelentkezési oldal
├── docker-compose.yml      # Pi / lokális build
├── docker-compose-nas.yml  # NAS / éles (ghcr.io image-ek)
├── nginx.conf              # Frontend szerver + /api/ proxy → routes-api:5001
├── routes-api/
│   ├── app.py              # Teljes Flask backend (egyetlen fájl, ~2000 sor)
│   └── Dockerfile          # Python 3.13-alpine, gunicorn :5001
└── src/
    ├── main.js             # Fő app belépési pont (~2864 sor) – orchestrálja a modulokat
    ├── styles.css          # Teljes CSS
    ├── version.js          # APP_VERSION egyetlen forrás
    ├── config.js           # Login enabled flag (docker-entrypoint injektálja)
    ├── auth.js             # JWT kezelés, requireAuth, logout
    ├── appSettings.js      # LocalStorage beállítások (getSettings, saveSetting)
    ├── karvonen.js         # HR zóna számítás (calculateZones, calculateTRIMP)
    ├── calories.js         # MET-alapú kalóriaszámítás (nincs UI-on, jövőre)
    ├── api/
    │   └── routesApi.js    # Backend API kliens (fetch wrapper-ek)
    ├── gpx/
    │   ├── gpx.js          # GPX import/export, calcElevationFromGeometry
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
        ├── elevationProfile.js  # Canvas szintprofil/sebesség/HR/cad/power chart
        ├── shareCard.js    # Canvas megosztó kép generálás (createWorkoutShareCard)
        ├── statsPanel.js   # Statisztikák renderelése (renderStats, calcEddington stb.)
        ├── statsManager.js # Stats fül orchestrátor (initStats, loadAndRenderStats)
        ├── library.js      # Könyvtár fül teljes UI (initLibrary, loadRouteLibrary)
        ├── wind.js         # Szélelemzés UI (initWind, renderWindResult, scheduleWindRunIfActive)
        ├── fileTab.js      # Elemzés fül: GPX/FIT import, share card modal (initFileTab)
        ├── strava.js       # Strava kapcsolat + import modal (initStrava)
        ├── settings.js     # Beállítások panel: Karvonen, zóna csúszkák, kerékpáros profil, backup (initSettings)
        └── planning.js     # Tervező fül: renderSidebar, waypontok, navigáció, sebességcsúszkák (initPlanning)
```

## Modulok – melyik mit tartalmaz

Ha egy területen fejlesztesz, **csak az adott modult** kell megnyitnod:

| Modul | Tartalom | Init hívás |
|-------|----------|------------|
| `ui/wind.js` | Szélelemzés UI, időpont-picker, eredmény renderelés, térkép-színezés | `initWind({...})` |
| `ui/fileTab.js` | GPX/FIT import, fájl statisztikák, drag&drop, share card modal, mentés könyvtárba | `initFileTab({...})` |
| `ui/strava.js` | Strava OAuth, app credentials, aktivitás lista, import modal | `initStrava({...})` |
| `ui/settings.js` | HR zóna beállítások (Karvonen), sebesség/kad/power zóna csúszkák, diagram színek, kerékpáros profil, backup/restore | `initSettings({...})` |
| `ui/planning.js` | `renderSidebar`, waypont lista, szegmens-picker, navigáció toggle, sebességcsúszkák, `formatDisplayDistance`, `calculateImportedDistance` | `initPlanning({...})` |
| `ui/library.js` | Könyvtár fül: kártya nézet, lista nézet, szűrők, könyvtár szerkesztő | `initLibrary({...})` |
| `ui/statsPanel.js` | Statisztika renderelők (áttekintés, havi, rekordok, Eddington, edzésterhelés, hőtérkép) | közvetlen importok |
| `ui/statsManager.js` | Stats fül állapot, betöltés, nézet váltás | `initStats({...})` |

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
- `ui/settings.js` → `buildHrZoneColorFn()`, `getCyclistProfile()`, `gradeColorForGrade()`, stb.
- `ui/planning.js` → `renderSidebar()`, `formatDisplayDistance()`, `getSelectedWaypointId()`, stb.

## main.js – mi maradt benne

`main.js` (~2864 sor) már csak az orchestrátor szerepet tölti be:
- Import-ok és init hívások sorrendje
- `elements` DOM referencia objektum
- `store`, `mapAdapter` példányosítás
- `switchTab()`, `applyRouteLayer()`, `updateElevationButton()` – UI koordinátor függvények
- Chart példányok (elevation, speed, HR, cad, power)
- Export modal (`buildExportPayload`, `openExportModal`)
- `loadRouteFromLibrary()`, `showLoadPreview()` – könyvtár→tervező híd
- `calcEstimatedTimeMixed()`, `calcEstimatedTime()` – időbecslés (exportálva planning.js-be is injektálva)
- `clearAllRouteState()` – teljes reset
- Douglas-Peucker + `buildAnchorWaypoints` – waypoint-generáló
- `runSearch()`, `renderSearchResults()` – helykeresés
- Toolbar drag&drop, eszköztár sorrend
- Kezdő nézet mentés/GPS

## Frontend főbb state változók (main.js-ben)

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

State a modulokban (getterekkel érhetők el):
```js
// ui/fileTab.js
getHasImportedFile()          // bool
getImportedColoredGeometry()  // geometry | null (sebességszínezéshez)
getImportedHrGeometry()       // geometry | null
getImportedCadGeometry()      // geometry | null
getImportedPowerGeometry()    // geometry | null

// ui/planning.js
getSelectedWaypointId()       // string | null

// ui/wind.js
getWindResult()               // { segments, stats, coverage } | null

// ui/strava.js
getStravaStatus()             // { connected, app_configured, ... } | null
```

## Navigáció / tab rendszer
- Fő fülek: `data-tab="plan|file|library|stats"` – `switchTab(name)` váltja
- Stats al-navigáció: `data-stats-view="overview|monthly|records|eddington|training|heatmap"`
- Collapse: `#navToggle` (header) + `#railNavToggle` (rail alján) – `is-nav-collapsed` class
- Library / Stats módban a térkép rejtett, `#libraryMain` / `#statsMain` látható

## Backend API végpontok (app.py)
```
POST   /api/auth/login                  Bejelentkezés → JWT
GET    /api/routes                      Útvonalak listája
POST   /api/routes                      Új útvonal mentése
GET    /api/routes/geometry-bulk        Bulk geometria hőtérképhez
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
GET    /api/strava/status               Strava kapcsolat állapot
GET    /api/strava/connect              OAuth URL lekérése
DELETE /api/strava/disconnect           Lecsatlakozás
GET    /api/strava/activities           Strava aktivitások listája
POST   /api/strava/import/<id>          Strava edzés importálása
GET/PUT/DELETE /api/strava/app-config   Per-user Strava app credentials
/api/admin/...                          Admin végpontok
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
# Teljes ui/ könyvtár kiküldése:
# sshpass -p 'admin' rsync -avz --relative src/ui/ src/main.js src/styles.css admin@192.168.0.136:/home/admin/bringaterv/

# Ha backend (routes-api/app.py) változott – force rebuild kell:
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
v1.2.0

## Fontos szabályok
- **Soha nem commitolunk Claude-attribúciót** (no Co-Authored-By)
- **Githubra terveket nem tolunk** – csak kész kód
- Az `index.html` szlogenje: „Tervezz, tekerj, fedezd fel!"
- A `src/version.js` az egyetlen forrás a verzióhoz
