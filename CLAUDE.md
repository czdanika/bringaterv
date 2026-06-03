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
    ├── main.js             # Fő app logika (~7000 sor → modulokra bontás folyamatban)
    ├── styles.css          # Teljes CSS
    ├── version.js          # APP_VERSION egyetlen forrás
    ├── config.js           # Login enabled flag (docker-entrypoint injektálja)
    ├── auth.js             # JWT kezelés, requireAuth, logout
    ├── appSettings.js      # LocalStorage beállítások
    ├── karvonen.js         # HR zóna számítás, TRIMP
    ├── calories.js         # MET-alapú kalóriaszámítás
    ├── api/
    │   └── routesApi.js    # Backend API kliens (fetch wrapper-ek)
    ├── gpx/
    │   ├── gpx.js          # GPX import/export
    │   └── fit.js          # FIT → GPX konverzió
    ├── i18n/
    │   ├── i18n.js
    │   └── translations.js # hu / en szótár
    ├── map/
    │   ├── mapAdapter.js   # Leaflet wrapper (createMapAdapter)
    │   └── surfaceAnalysis.js
    ├── state/
    │   └── routeStore.js   # Tervező route state (waypoints, geometry)
    ├── wind/
    │   └── windService.js  # Open-Meteo + szélkomponens
    └── ui/
        ├── dom.js          # createToast, formatDistance
        ├── search.js       # Nominatim helykeresés
        ├── elevationProfile.js  # Canvas szintprofil/sebesség/HR/cad/power chart
        ├── shareCard.js    # Canvas megosztó kép generálás
        └── statsPanel.js   # Statisztikák renderelése (renderStats, calcEddington stb.)
```

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

## Frontend főbb state változók (main.js-ben)
```js
store           // createRouteStore() – tervező waypoints + geometry
mapAdapter      // createMapAdapter() – Leaflet wrapper
_libraryData    // { routes: [], workouts: [], samples: [] }
_libraryFilter  // { type, source, sport, query, sort, ... }
elements        // DOM referenciák objektuma
currentTab      // "plan" | "file" | "library" | "stats"
importedFileName, importedGpxText, importedFitBuffer  // Elemzés fül betöltött fájl
_shareCardData  // Megosztó kép adatai
_statsPeriod, _statsSport, _statsView, _trainingRange  // Statisztikák szűrők
```

## Navigáció / tab rendszer
- Fő fülek: `data-tab="plan|file|library|stats"` – `switchTab(name)` váltja
- Stats al-navigáció: `data-stats-view="overview|monthly|records|eddington|training|heatmap"`
- Collapse: `#navToggle` (header) + `#railNavToggle` (rail alján) – `is-nav-collapsed` class
- Library / Stats módban a térkép rejtett, `#libraryMain` / `#statsMain` látható

## Deployment – Pi (teszt)
```bash
# Fájlok másolása
sshpass -p 'admin' rsync -avz --relative <fájlok> admin@192.168.0.136:/home/admin/bringaterv/

# Ha backend (app.py) változott:
docker-compose down && docker-compose up -d --build

# Ha csak frontend változott:
docker-compose up -d --build bringaterv
```
**Fontos:** a frontend az image-be van bake-elve (Dockerfile COPY), ezért `restart` nem elég – mindig `up -d --build` kell frontend változásnál.

## Deployment – NAS (éles)
Portainer → Stacks → Pull and redeploy.
A `ghcr.io/czdanika/bringaterv*:latest` image-eket a GitHub Actions buildeli push/release-kor.

## Jelenlegi verzió
v1.1.2

## Aktív fejlesztési irány
- `main.js` (~7000 sor) felbontása modulokra
- Tervezett modulok: `ui/library.js`, `ui/fileTab.js`, `ui/stats.js`, `ui/wind.js`, `ui/strava.js`, `ui/settings.js`, `ui/planning.js`
- Minden modul `init(deps)` mintával kapja a függőségeit (routesApi, showToast, store, mapAdapter)

## Fontos szabályok
- **Soha nem commitolunk Claude-attribúciót** (no Co-Authored-By)
- **Githubra terveket nem tolunk** – csak kész kód
- Az `index.html` szlogenje: „Tervezz, tekerj, fedezd fel!"
- A `src/version.js` az egyetlen forrás a verzióhoz
