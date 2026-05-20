# Bringaterv – Fejlesztői Dokumentáció

> Belső referencia: architektúra, telepítés, kódszervezés, multi-user rendszer.  
> Külső felhasználóknak lásd: [README.md](README.md)

---

## Tartalomjegyzék

1. [Mi ez a projekt?](#1-mi-ez-a-projekt)
2. [Architektúra áttekintés](#2-architektúra-áttekintés)
3. [Fájlstruktúra](#3-fájlstruktúra)
4. [Frontend – kódszervezés](#4-frontend--kódszervezés)
5. [Backend – routes-api](#5-backend--routes-api)
6. [Multi-user rendszer](#6-multi-user-rendszer)
7. [HR zónaszámítás](#7-hr-zónaszámítás)
8. [Deployment – Raspberry Pi (fejlesztés)](#8-deployment--raspberry-pi-fejlesztés)
9. [Deployment – NAS / éles](#9-deployment--nas--éles)
10. [Docker Compose konfiguráció](#10-docker-compose-konfiguráció)
11. [localStorage kulcsok](#11-localstorage-kulcsok)
12. [API végpontok összefoglaló](#12-api-végpontok-összefoglaló)

---

## 1. Mi ez a projekt?

A **Bringaterv** egy önhosztolt GPX útvonaltervező és edzésnapló alkalmazás, amely böngészőből elérhető, és Docker Compose-zal telepíthető bármilyen Linux gépre, NAS-ra vagy Raspberry Pi-re.

**Fő funkciók:**
- Kattintásos útvonaltervezés Leaflet térképen, BRouter útra illesztéssel
- 4 tervezési mód: Aszfalt / Gravel / MTB / Túra
- GPX import + teljes elemzés: szintprofil, sebesség, pulzus, kadencia, lejtőtérkép
- Szerver oldali útvonalkönyvtár: mentett útvonalak + edzések GPX fájlokkal
- **Multi-user:** JWT autentikáció, per-user adatok, admin panel
- HR zónaszámítás: Karvonen, Max HR%, LTHR, Egyedi (saját BPM határok)
- Sötét/világos téma, 7 térképstílus

**Technológia:**
- Frontend: Vanilla JS ES modulok, Leaflet.js, Chart.js
- Backend: Python Flask, gunicorn
- Szerver: nginx + Docker Compose
- Adattárolás: SQLite (felhasználók) + JSON index + GPX fájlok (per-user)

---

## 2. Architektúra áttekintés

```
Böngésző
    │
    ├── http://[ip]:8088/          → nginx (bringaterv konténer)
    │       ├── /                  → statikus HTML/JS/CSS
    │       ├── /src/config.js     → docker-entrypoint.sh generálja (LOGIN_ENABLED)
    │       └── /api/              → proxy → routes-api:5001 (belső hálózat)
    │
    └── routes-api konténer (Flask, gunicorn)
              │
         routes-data volume (/data)
              ├── /data/bringaterv.db  ← SQLite (users, sessions, routes, workouts)
              └── /data/users/         ← per-user GPX könyvtárak
                    ├── u_abc123/routes/
                    └── u_def456/routes/
```

**Két konténer:**

| Konténer | Image | Feladat | Port |
|---|---|---|---|
| `bringaterv` | `ghcr.io/czdanika/bringaterv:latest` | nginx, statikus frontend | `8088:80` (külső:belső) |
| `routes-api` | `ghcr.io/czdanika/bringaterv-api:latest` | Flask REST API, JWT auth | nincs külső port |

A `routes-api` szándékosan **nem érhető el kívülről** – csak az nginx proxyn keresztül, belső `bringaterv-net` Docker hálózaton.

---

## 3. Fájlstruktúra

```
bringaterv/
├── index.html                  # Fő alkalmazás oldal
├── admin.html                  # Admin panel (felhasználókezelés)
├── login.html                  # Bejelentkezési oldal (LOGIN_ENABLED esetén)
├── nginx.conf                  # nginx konfiguráció (proxy)
├── Dockerfile                  # Frontend image: nginx + statikus fájlok
├── docker-entrypoint.sh        # Induláskor generálja a config.js-t
├── docker-compose.yml          # Fejlesztési / Pi compose
├── docker-compose-nas.yml      # NAS-ra telepítési compose (csak image-ből)
│
├── src/
│   ├── version.js              # APP_VERSION – egyetlen forrás, itt kell frissíteni
│   ├── config.js               # Runtime konfiguráció (docker-entrypoint generálja)
│   ├── main.js                 # Fő alkalmazás logika, event kötések
│   ├── styles.css              # Minden CSS – nincs külső framework
│   ├── auth.js                 # JWT autentikáció, token kezelés
│   ├── karvonen.js             # HR zónaszámítás logika (export)
│   ├── appSettings.js          # localStorage-alapú beállítás kezelés
│   ├── api/
│   │   └── routesApi.js        # API kliens (fetch wrapper, admin végpontok)
│   ├── gpx/
│   │   └── gpx.js              # GPX import/export logika
│   ├── map/
│   │   └── mapAdapter.js       # Leaflet térkép, BRouter hívások, rétegek
│   └── ui/
│       └── elevationProfile.js # Szintprofil diagram (Chart.js)
│
└── routes-api/
    ├── Dockerfile              # Flask API image
    ├── app.py                  # Teljes Flask alkalmazás
    ├── requirements.txt        # Python függőségek
    └── samples/                # Beépített minta útvonalak (image-be égetve)
        ├── balaton.gpx
        └── tiszato.gpx
```

---

## 4. Frontend – kódszervezés

### ES modulok

Az alkalmazás ES6 modulokat használ (`type="module"` a script tageken). Nincs bundler, a böngésző natívan tölt be.

### Kulcsfájlok

**`src/version.js`**  
```js
window.APP_VERSION = "v0.73";
```
Ezt kell módosítani verzióbumpnál. Beolvassa: `main.js`, `index.html` sidebar, `login.html` footer.

**`src/config.js`** (futásidőben generált)  
```js
export const config = {
  login: true,   // LOGIN_ENABLED env alapján
};
```
A `docker-entrypoint.sh` generálja induláskor. Soha ne szerkeszd kézzel.

**`src/auth.js`**  
JWT alapú autentikáció:
- `login(username, password)` → JWT kérés a Flask API-tól, localStorage mentés
- `logout()` → localStorage törlés
- `getToken()` / `getUser()` / `isAdmin()` – token olvasás
- `authHeaders()` → `{ Authorization: "Bearer ..." }` objektum, minden API kéréshez
- `requireAuth()` / `requireAdmin()` → oldalvédelem, nem jogosult user átirányítása
- `handle401()` → token lejárt → kijelentkezés

**`src/api/routesApi.js`**  
Minden API hívás ezen keresztül megy. Automatikusan csatolja az auth headert, 401-re kijelentkeztet.

**`src/main.js`**  
Az összes fő logika. Fontosabb belépési pontok:
- `initHrZoneSettings()` – HR zóna beállítások panel, multi-slider
- Settings szerver-szinkron blokk – betöltéskor + módosításkor 1.5s debounce-szal

### Eseménykezelés

HR beállítások változásakor a rendszer `hrZonesChanged` custom eventet dob, amelyet a térkép réteg és az elemzés panel hallgat.

---

## 5. Backend – routes-api

### Flask app (`routes-api/app.py`)

**Python függőségek:**
```
flask==3.1.1
flask-cors==5.0.1
gunicorn==23.0.0
PyJWT==2.9.0
bcrypt==4.2.1
```

### DB séma (`SCHEMA_VERSION=5`)

```sql
CREATE TABLE users (
    id              TEXT PRIMARY KEY,       -- "u_" + 8 hex karakter
    email           TEXT UNIQUE NOT NULL,   -- belépési azonosító (email vagy username)
    name            TEXT NOT NULL,          -- megjelenítési név: "Vezetéknév Keresztnév"
    first_name      TEXT NOT NULL DEFAULT '',
    last_name       TEXT NOT NULL DEFAULT '',
    password_hash   TEXT NOT NULL,          -- bcrypt hash
    role            TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'admin' | 'readonly'
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    last_login_at   TEXT,
    login_count     INTEGER NOT NULL DEFAULT 0,
    quota_routes    INTEGER NOT NULL DEFAULT 50,
    quota_workouts  INTEGER NOT NULL DEFAULT 200,
    quota_mb        INTEGER NOT NULL DEFAULT 100,
    settings        TEXT NOT NULL DEFAULT '{}'  -- JSON: hrZones, mapStyle, unit, stb.
);
```

### Sémamigrációk

A `_db_init()` függvény `PRAGMA user_version` alapján futtatja a migrációkat:

| Verzió | Változás |
|---|---|
| v1 | Alap sémák (users, workouts, routes, stb.), első admin user létrehozása |
| v2 | `settings` TEXT oszlop hozzáadása |
| v3 | Régi egyfelhasználós (legacy) útvonalak átmigrálása az első admin user mappájába |
| v4 | `first_name`, `last_name` oszlopok hozzáadása |
| v5 | Névsorend javítása: `Vezetéknév Keresztnév` sorrend |

### File locking

A `_db_init()` `fcntl.flock()` exkluzív zárral védi az inicializációt, így gunicorn több worker esetén sem fut párhuzamosan:

```python
def _db_init() -> None:
    import fcntl
    with open(DB_PATH + ".lock", "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            _db_init_locked()
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)
```

### Per-user adattárolás

```
/data/
├── bringaterv.db              ← SQLite
└── users/
    ├── u_abc123/
    │   ├── routes/
    │   │   ├── index.json     ← metaadatok
    │   │   ├── 0a1b2c3d.gpx
    │   │   └── ...
    │   └── workouts/
    └── u_def456/
        └── routes/
```

### Minta útvonalak

A `/samples` mappa az image-be van égetve. A `SAMPLES_DIR` env változóval adható meg az elérési útja. Minden GPX mellé opcionálisan `.json` metaadatfájl is helyezhető.

---

## 6. Multi-user rendszer

### Auth flow

```
1. POST /api/auth/login  { email, password }
   → 200 { token: "eyJ...", user: { id, email, name, role } }

2. Minden védett kéréshez:
   Authorization: Bearer eyJ...

3. GET /api/auth/me  → saját profil visszaadása
```

### Bejelentkezési azonosító

Az `email` mező ténylegesen bármilyen string lehet (email cím vagy egyszerű felhasználónév). Az app.py `email` varchar névvel tárolja, de az értéke `bringa` is lehet.

### Felhasználó létrehozása

Az első admin automatikusan jön létre induláskor (`ADMIN_EMAIL` + `ADMIN_PASSWORD` env alapján). Új felhasználókat az admin panel `/admin.html`-en lehet hozzáadni.

### Beállítások szerver-szinkron

A személyes beállítások (HR zónák, térképstílus, mértékegység, induló nézet, téma) JSON-ként tárolódnak a `users.settings` oszlopban, és szinkronizálódnak:
- **Betöltéskor:** `GET /api/user/settings` → localStorage felülírás (ha nem üres)
- **Módosításkor:** `PUT /api/user/settings` debounced (1.5 s) szerver mentés

### Admin API végpontok

| Metódus | Végpont | Leírás |
|---|---|---|
| `GET` | `/api/admin/users` | Felhasználók listája (stats-szal) |
| `POST` | `/api/admin/users` | Új felhasználó (email, password, first_name, last_name, role) |
| `GET` | `/api/admin/users/<id>` | Egy user részletei + session history |
| `PATCH` | `/api/admin/users/<id>` | Email, jelszó, nevek, szerepkör, kvóta, aktív/tiltott |
| `POST` | `/api/admin/users/<id>/password` | Jelszó reset |
| `GET` | `/api/admin/users/<id>/routes` | User útvonalainak listája (mérettel) |
| `DELETE` | `/api/admin/users/<id>/routes/<rid>` | Admin töröl egy user útvonalát |
| `GET` | `/api/admin/stats` | Összesített statisztika |

A `/api/admin/*` végpontok csak `role=admin` JWT tokennel érhetők el.

### Kvóta

Alapértelmezés: 50 útvonal / 200 edzés / 100 MB. Felhasználónként állítható az admin panelről.

---

## 7. HR zónaszámítás

Az alkalmazás 4 zónaszámítási módszert támogat, amelyek mind 5 zónát adnak vissza.

### Módszerek

| Módszer | Azonosító | Leírás |
|---|---|---|
| Karvonen | `karvonen` | `(maxHR - restHR) × pct + restHR` – figyelembe veszi a nyugalmi pulzust |
| Max HR% | `maxhr` | `maxHR × pct` – egyszerű százalék |
| LTHR | `lthr` | Laktát küszöbpulzus alapú, Friel-féle zónák |
| Egyedi | `custom` | Felhasználó által beállított BPM határok |

### Zóna határok (Friel modell)

| Zóna | Szín | Leírás | Karvonen % | LTHR % |
|---|---|---|---|---|
| Z1 | `#888780` | Aktív regeneráció | <68% | <81% |
| Z2 | `#1D9E75` | Aerob alap | 68–83% | 81–89% |
| Z3 | `#378ADD` | Tempo | 83–94% | 89–93% |
| Z4 | `#EF9F27` | Laktát küszöb | 94–105% | 93–99% |
| Z5 | `#E24B4A` | Anaerob | >105% | >99% |

### TRIMP (Training Impulse)

Az edzésfájl elemzésekor a rendszer kiszámítja a TRIMP értéket:
```
TRIMP = Σ (zone_i_duration × zone_i_weight)
```
Ahol a zóna súlyok: Z1=1, Z2=2, Z3=3, Z4=4, Z5=5.

---

## 8. Deployment – Raspberry Pi (fejlesztés)

A Pi a **teszt szerver**. Ide rsync-kel küldünk, nem git-tel.

**Adatok:**
- IP: `192.168.0.136`
- SSH user/pass: `admin` / `admin`
- App URL: `http://192.168.0.136:8088`
- Projekt mappa: `/home/admin/bringaterv/`

### Deploy parancsok

```bash
# Frontend fájlok másolása
sshpass -p 'admin' rsync -avz \
  index.html login.html admin.html nginx.conf docker-entrypoint.sh docker-compose.yml \
  admin@192.168.0.136:/home/admin/bringaterv/

sshpass -p 'admin' rsync -avz \
  src/ \
  admin@192.168.0.136:/home/admin/bringaterv/src/

# Backend API (routes-api alkönyvtárba!)
sshpass -p 'admin' rsync -avz \
  routes-api/app.py \
  admin@192.168.0.136:/home/admin/bringaterv/routes-api/

# Docker újraépítés (szükséges ha Dockerfile vagy routes-api változott)
sshpass -p 'admin' ssh admin@192.168.0.136 \
  "cd /home/admin/bringaterv && docker compose down && docker compose up -d --build"

# Csak routes-api újraépítés (app.py változott)
sshpass -p 'admin' ssh admin@192.168.0.136 \
  "cd /home/admin/bringaterv && docker compose stop routes-api && docker compose build --no-cache routes-api && docker compose up -d"

# Gyors újraindítás (csak config/statikus fájl változott)
sshpass -p 'admin' ssh admin@192.168.0.136 \
  "cd /home/admin/bringaterv && docker compose restart"
```

> ⚠️ **Fontos:** Az `rsync routes-api/app.py` parancsban a cél **`.../routes-api/`** legyen, nem a projekt gyökere! A Docker build context a `./routes-api/` almappa.

### Mikor kell `--build`?

| Változott | Szükséges |
|---|---|
| `src/*.js`, `index.html`, `*.html` | Restart elég |
| `routes-api/app.py` | `--no-cache` build + up |
| `routes-api/requirements.txt` | `--build` kötelező |
| `Dockerfile` bármelyik | `--build` kötelező |

---

## 9. Deployment – NAS / éles

A NAS a **éles szerver**. A GitHub main branch-ről frissül.

### Frissítés GitHub-ról

```bash
cd /volume1/docker/bringaterv

# 1. Letöltés
curl -L -o bringaterv.zip \
  "https://github.com/czdanika/bringaterv/archive/refs/heads/main.zip"

# 2. Kicsomagolás és felülírás (cp -rf, NEM mv!)
python3 -c "import zipfile; zipfile.ZipFile('bringaterv.zip').extractall('.')"
cp -rf bringaterv-main/. .
rm -rf bringaterv-main bringaterv.zip

# 3. Újraépítés
sudo docker compose up -d --build
```

> ⚠️ **`cp -rf` kell, nem `mv`!** Az `mv` nem írja felül a meglévő mappákat, hanem belemozgatja (`templates/templates/` jön létre). A `cp -rf` minden fájlt felülír.

### Portainer (ajánlott)

1. Portainer → Stacks → `bringaterv` → **Pull and redeploy**

A `routes-data` volume **megmarad** frissítéskor – a mentett GPX-ek, edzések és felhasználói adatok nem vesznek el.

---

## 10. Docker Compose konfiguráció

### Fejlesztési (`docker-compose.yml`)

```yaml
services:
  bringaterv:
    build: .
    ports:
      - "${PORT:-8088}:80"
    environment:
      LOGIN_ENABLED: ${LOGIN_ENABLED:-true}
    depends_on: [routes-api]
    networks: [bringaterv-net]
    restart: unless-stopped

  routes-api:
    build: ./routes-api
    environment:
      DATA_DIR:        /data/routes       # (legacy migráció miatt megőrizve)
      SAMPLES_DIR:     /samples
      DB_PATH:         /data/bringaterv.db
      MULTI_DATA_DIR:  /data/users
      ADMIN_EMAIL:     ${ADMIN_EMAIL:-${LOGIN_USER:-bringa}}
      ADMIN_PASSWORD:  ${ADMIN_PASSWORD:-${LOGIN_PASSWORD:-terv}}
      JWT_SECRET:      ${JWT_SECRET:-change-me-please}
      JWT_EXPIRY_DAYS: ${JWT_EXPIRY_DAYS:-30}
    volumes:
      - routes-data:/data
    networks: [bringaterv-net]
    restart: unless-stopped

volumes:
  routes-data:

networks:
  bringaterv-net:
    driver: bridge
```

### Összes környezeti változó

| Változó | Konténer | Leírás | Alapértelmezett |
|---|---|---|---|
| `PORT` | bringaterv | Külső HTTP port | `8088` |
| `LOGIN_ENABLED` | bringaterv | Bejelentkezés be/ki | `true` |
| `SAMPLES_DIR` | routes-api | Minta útvonalak mappája | `/samples` |
| `DB_PATH` | routes-api | SQLite DB elérési út | `/data/bringaterv.db` |
| `MULTI_DATA_DIR` | routes-api | Per-user GPX mappák | `/data/users` |
| `ADMIN_EMAIL` | routes-api | Első admin email/username | `bringa` |
| `ADMIN_PASSWORD` | routes-api | Első admin jelszó | `terv` |
| `JWT_SECRET` | routes-api | JWT aláíró kulcs | `change-me-please` |
| `JWT_EXPIRY_DAYS` | routes-api | Token élettartam napban | `30` |

> ⚠️ **`JWT_SECRET` éles üzemben kötelező megváltoztatni!** Véletlenszerű, legalább 32 karakteres string legyen.

---

## 11. localStorage kulcsok

| Kulcs | Tartalom |
|---|---|
| `bringaterv_jwt` | JWT token |
| `bringaterv_user` | Bejelentkezett user JSON (id, email, name, role) |
| `bringaterv.hrZones` | HR zóna beállítások (rest, max, method, lthr, customBoundaries, ...) |
| `route4meMapStyle` | Aktív térképstílus neve |
| `route4meUnit` | Mértékegység: `metric` / `imperial` |
| `bringaterv.startView` | Kezdő térképnézet (center + zoom) |
| `route4meTheme` | Téma: `dark` / `light` |
| `bringaterv.settings.collapsed` | Összecsukott beállítás szekciók listája |
| `bringaterv.settings.ver` | Verzió kulcs a beállítás reset kezeléséhez |

---

## 12. API végpontok összefoglaló

### Nyilvános

| Metódus | Végpont | Auth | Leírás |
|---|---|---|---|
| `POST` | `/api/auth/login` | Nincs | JWT token igénylés |
| `GET` | `/api/health` | Nincs | Állapot ellenőrzés |
| `GET` | `/api/samples` | Nincs | Minta útvonalak listája |
| `GET` | `/api/samples/<id>` | Nincs | Minta GPX fájl |

### Felhasználói (Bearer token szükséges)

| Metódus | Végpont | Leírás |
|---|---|---|
| `GET` | `/api/auth/me` | Saját profil |
| `GET` | `/api/user/settings` | Személyes beállítások lekérése |
| `PUT` | `/api/user/settings` | Személyes beállítások mentése |
| `GET` | `/api/routes` | Saját útvonalak listája |
| `POST` | `/api/routes` | Új útvonal feltöltése |
| `GET` | `/api/routes/<id>` | Útvonal GPX tartalma |
| `PATCH` | `/api/routes/<id>` | Metaadatok szerkesztése (name, type, description) |
| `DELETE` | `/api/routes/<id>` | Útvonal törlése |

### Admin (admin role szükséges)

| Metódus | Végpont | Leírás |
|---|---|---|
| `GET` | `/api/admin/users` | Felhasználók listája |
| `POST` | `/api/admin/users` | Új felhasználó |
| `GET` | `/api/admin/users/<id>` | Egy user adatai + session history |
| `PATCH` | `/api/admin/users/<id>` | User szerkesztés (email, jelszó, nevek, role, kvóta, aktív) |
| `POST` | `/api/admin/users/<id>/password` | Jelszó reset |
| `GET` | `/api/admin/users/<id>/routes` | User útvonalainak listája |
| `DELETE` | `/api/admin/users/<id>/routes/<rid>` | User útvonalának törlése |
| `GET` | `/api/admin/stats` | Rendszer statisztikák |

---

## Fejlesztési megjegyzések

### Verzióbump teendők

1. `src/version.js` – `APP_VERSION` frissítése
2. `CHANGELOG.md` – új verzió bejegyzése
3. GitHub release létrehozása (ha éles)

### Debuggolás

```bash
# Pi logok
sshpass -p 'admin' ssh admin@192.168.0.136 \
  "cd /home/admin/bringaterv && docker compose logs -f"

# Csak az API logjai
sshpass -p 'admin' ssh admin@192.168.0.136 \
  "cd /home/admin/bringaterv && docker compose logs -f routes-api"

# Health check
curl http://192.168.0.136:8088/api/health

# Login teszt
curl -s -X POST http://192.168.0.136:8088/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"bringa","password":"terv"}'
```

### GitHub Actions

A main branch-re pusholt commit automatikusan buildeli és GHCR-re tölti fel a Docker image-eket:
- `ghcr.io/czdanika/bringaterv:latest`
- `ghcr.io/czdanika/bringaterv-api:latest`

---

*Dokumentáció utoljára frissítve: 2026-05-20*
