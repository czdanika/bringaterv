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
6. [APP_MODE: single vs. multi](#6-app_mode-single-vs-multi)
7. [Multi-user rendszer részletesen](#7-multi-user-rendszer-részletesen)
8. [HR zónaszámítás](#8-hr-zónaszámítás)
9. [Deployment – Raspberry Pi (fejlesztés)](#9-deployment--raspberry-pi-fejlesztés)
10. [Deployment – NAS / éles](#10-deployment--nas--éles)
11. [Docker Compose konfiguráció](#11-docker-compose-konfiguráció)
12. [localStorage kulcsok](#12-localstorage-kulcsok)
13. [API végpontok összefoglaló](#13-api-végpontok-összefoglaló)

---

## 1. Mi ez a projekt?

A **Bringaterv** egy önhosztolt GPX útvonaltervező és edzésnapló alkalmazás, amely böngészőből elérhető, és Docker Compose-zal telepíthető bármilyen Linux gépre, NAS-ra vagy Raspberry Pi-re.

**Fő funkciók:**
- Kattintásos útvonaltervezés Leaflet térképen, BRouter útra illesztéssel
- 4 tervezési mód: Aszfalt / Gravel / MTB / Túra
- GPX import + teljes elemzés: szintprofil, sebesség, pulzus, kadencia, lejtőtérkép
- Szerver oldali útvonalkönyvtár: mentett útvonalak + edzések GPX fájlokkal
- HR zónaszámítás: Karvonen, Max HR%, LTHR, Egyedi (saját BPM határok)
- Sötét/világos téma, 7 térképstílus
- Opcionális bejelentkezés (nginx basic auth)

**Technológia:**
- Frontend: Vanilla JS ES modulok, Leaflet.js, Chart.js
- Backend: Python Flask, gunicorn
- Szerver: nginx + Docker Compose
- Adattárolás: JSON index + GPX fájlok (single), SQLite (multi)

---

## 2. Architektúra áttekintés

```
Böngésző
    │
    ├── http://[ip]:8088/          → nginx (bringaterv konténer)
    │       ├── /                  → statikus HTML/JS/CSS
    │       ├── /config.js         → docker-entrypoint.sh generálja (LOGIN_*)
    │       └── /api/              → proxy → routes-api:5001 (belső hálózat)
    │
    └── routes-api konténer (Flask, gunicorn)
              │
         routes-data volume (/data)
              ├── /data/routes/        ← single mód: GPX fájlok + index.json
              ├── /data/bringaterv.db  ← multi mód: SQLite adatbázis
              └── /data/users/         ← multi mód: per-user GPX könyvtárak
```

**Két konténer:**

| Konténer | Image | Feladat | Port |
|---|---|---|---|
| `bringaterv` | `ghcr.io/czdanika/bringaterv:latest` | nginx, statikus frontend | `8088:80` (külső:belső) |
| `routes-api` | `ghcr.io/czdanika/bringaterv-api:latest` | Flask REST API | nincs külső port |

A `routes-api` szándékosan **nem érhető el kívülről** – csak az nginx proxyn keresztül, belső `bringaterv-net` Docker hálózaton.

---

## 3. Fájlstruktúra

```
bringaterv/
├── index.html                  # Fő alkalmazás oldal
├── login.html                  # Bejelentkezési oldal (LOGIN_ENABLED esetén)
├── nginx.conf                  # nginx konfiguráció (proxy + auth)
├── Dockerfile                  # Frontend image: nginx + statikus fájlok
├── docker-entrypoint.sh        # Induláskor generálja a config.js-t
├── docker-compose.yml          # Fejlesztési / Pi compose
├── docker-compose-nas.yml      # NAS-ra telepítési compose (csak image-ből)
│
├── src/
│   ├── version.js              # APP_VERSION – egyetlen forrás, itt kell frissíteni
│   ├── main.js                 # Fő alkalmazás logika, IIFE-k, event kötések
│   ├── styles.css              # Minden CSS – nincs külső framework
│   ├── karvonen.js             # HR zónaszámítás logika (export)
│   ├── appSettings.js          # localStorage-alapú beállítás kezelés
│   ├── auth.js                 # Bejelentkezés / munkamenet kezelés
│   ├── gpx/
│   │   └── gpx.js              # GPX import/export logika
│   └── map/
│       └── mapAdapter.js       # Leaflet térkép, BRouter hívások, rétegek
│
├── assets/
│   └── banner.jpg              # README banner kép
│
└── routes-api/
    ├── Dockerfile              # Flask API image
    ├── app.py                  # Teljes Flask alkalmazás (v2 – APP_MODE támogatás)
    ├── requirements.txt        # Python függőségek
    └── samples/                # Beépített minta útvonalak (image-be égetve)
        ├── index.json
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

**`src/main.js`**  
Az összes fő logika IIFE blokkokban szervezve:
- `initHrZoneSettings()` – HR zóna beállítások panel, multi-slider
- `initSettingsCollapse()` – Beállítások szekciók összecsukható állapota (CURRENT_VER="8")
- `getHrZoneSettings()` – localStorage olvasás, alapértelmezések
- `resolveZones()` – delegál a karvonen.js-be a method alapján

**`src/karvonen.js`**  
Exportált függvények:
- `calculateZones(rest, max, defs?)` – Karvonen formula
- `calculateZonesMaxHR(max, defs?)` – Max HR% alapú
- `calculateZonesLTHR(lthr)` – Laktát küszöb alapú
- `calculateZonesCustom(boundaries)` – Egyedi BPM határok
- `calculateTRIMP(zones, duration)` – TRIMP edzésterhelés index

### localStorage séma

Lásd: [12. fejezet](#12-localstorage-kulcsok)

### Eseménykezelés

HR beállítások változásakor a rendszer `hrZonesChanged` custom eventet dob, amelyet a térkép réteg és az elemzés panel hallgat.

---

## 5. Backend – routes-api

### Flask app (`routes-api/app.py`)

**Verzió:** v2 – APP_MODE támogatással

**Python függőségek:**
```
flask==3.1.1
flask-cors==5.0.1
gunicorn==23.0.0
PyJWT==2.9.0        ← csak multi módban szükséges
bcrypt==4.2.1       ← csak multi módban szükséges
```

### Single mód adattárolás

```
/data/routes/
├── index.json          ← metaadatok listája (atomikusan írva: temp + rename)
└── user/
    ├── abc123.gpx
    └── def456.gpx
```

Az `index.json` egy JSON tömb, minden elem tartalmaz: `id`, `name`, `type`, `description`, `distance_km`, `duration_min`, `ascent_m`, `created_at`, `updated_at`.

### Minta útvonalak

A `/samples` mappa az image-be van égetve, nem módosítható futás közben. A `SAMPLES_DIR` env változóval adható meg az elérési útja.

---

## 6. APP_MODE: single vs. multi

A `routes-api` konténer `APP_MODE` environment változóval irányítható.

| | `single` (alapértelmezett) | `multi` |
|---|---|---|
| Auth | Nincs (nginx basic auth opcionálisan) | JWT Bearer token |
| Adattárolás | Fájlrendszer (index.json + GPX) | SQLite + per-user mappák |
| Admin felület | Nincs | `/api/admin/*` végpontok |
| Visszafelé kompatibilitás | ✅ Teljes | ✅ Meglévő `/api/routes` végpontok megmaradnak |
| Python deps | Csak flask, flask-cors, gunicorn | + PyJWT, bcrypt |

**`APP_MODE=single`** – teljesen azonos az eredeti API v1-gyel. Semmit nem kell módosítani a frontenden.

**`APP_MODE=multi`** – extra végpontok jelennek meg, JWT auth szükséges a route végpontokhoz (felhasználónként külön adatok).

---

## 7. Multi-user rendszer részletesen

### Aktiválás

`docker-compose.yml`-ben (vagy env fájlban):
```env
APP_MODE=multi
ADMIN_EMAIL=admin@pelda.hu
ADMIN_PASSWORD=erős_jelszó
JWT_SECRET=véletlenszerű_hosszú_string
JWT_EXPIRY_DAYS=30
```

> ⚠️ **Éles deployban kötelező** a JWT_SECRET megváltoztatása!

### SQLite séma (`SCHEMA_VERSION=1`)

```sql
CREATE TABLE users (
    id            TEXT PRIMARY KEY,     -- UUID
    email         TEXT UNIQUE NOT NULL,
    pw_hash       TEXT NOT NULL,        -- bcrypt hash
    role          TEXT DEFAULT 'user',  -- 'user' | 'admin'
    quota_mb      INTEGER DEFAULT 500,  -- tárhelykorlát MB-ban
    is_active     INTEGER DEFAULT 1,
    created_at    TEXT,
    last_login_at TEXT
);

CREATE TABLE routes (                   -- jövőbeli: útvonalak metaadatai DB-ben
    id         TEXT PRIMARY KEY,
    user_id    TEXT REFERENCES users(id),
    name       TEXT,
    type       TEXT,
    ...
);

CREATE TABLE workouts (                 -- jövőbeli: edzés összefoglalók
    id         TEXT PRIMARY KEY,
    user_id    TEXT REFERENCES users(id),
    gpx_path   TEXT,
    ...
);

CREATE TABLE workout_zones (           -- jövőbeli: zóna statisztikák
    workout_id TEXT REFERENCES workouts(id),
    zone       INTEGER,
    seconds    INTEGER
);
```

### Per-user adatok

```
/data/
├── bringaterv.db          ← SQLite DB
└── users/
    ├── {user_id}/
    │   └── routes/        ← GPX + index.json (felhasználónként)
    └── {user_id}/
        └── routes/
```

### Auth flow

```
1. POST /api/auth/login  { email, password }
   → 200 { token: "eyJ...", user: { id, email, role } }

2. Minden kéréshez:
   Authorization: Bearer eyJ...

3. GET /api/auth/me
   → 200 { id, email, role, quota_mb, ... }
```

### Admin API végpontok

| Metódus | Végpont | Leírás |
|---|---|---|
| `GET` | `/api/admin/users` | Összes felhasználó listája |
| `POST` | `/api/admin/users` | Új felhasználó létrehozása |
| `GET` | `/api/admin/users/<id>` | Egy felhasználó adatai |
| `PATCH` | `/api/admin/users/<id>` | Email, kvóta, státusz szerkesztés |
| `POST` | `/api/admin/users/<id>/password` | Jelszó csere |
| `GET` | `/api/admin/stats` | Rendszer szintű statisztikák |

A `/api/admin/*` végpontok csak `role=admin` JWT tokennel érhetők el.

### Felhasználói tárhelyhasználat

Az admin stats végpont visszaadja minden userhez: fájlok száma, összes tárolt byte (`_user_storage_stats(user_id)` alapján).

### Tervezett (még nem kész)

- Admin HTML frontend (`admin.html`) – felhasználólista, kvóta, utolsó belépés
- Frontend JWT integráció – `login.html` + `auth.js` frissítés multi módhoz
- Email alapú regisztráció (opcionális, jelenleg admin hozza létre a usereket)

---

## 8. HR zónaszámítás

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

### Egyedi módszer – multi-slider

Az „Egyedi" módban a felhasználó egy 5 zónára osztott csúszkán húzza a 4 határpontot (BPM értékek). Az input értékek rejtett `<input>` elemekben tárolódnak (`#hrCustomB1`–`#hrCustomB4`), a megjelenítést a `#hrCustomZoneDisplay` div frissíti.

**localStorage kulcs:** `bringaterv.hrZones`
```json
{
  "rest": 55,
  "max": 190,
  "method": "custom",
  "sex": "male",
  "age": 35,
  "zoneModel": "friel",
  "lthr": 160,
  "customBoundaries": [105, 139, 156, 173]
}
```

### TRIMP (Training Impulse)

Az edzésfájl elemzésekor a rendszer kiszámítja a TRIMP értéket:
```
TRIMP = Σ (zone_i_duration × zone_i_weight)
```
Ahol a zóna súlyok: Z1=1, Z2=2, Z3=3, Z4=4, Z5=5.

---

## 9. Deployment – Raspberry Pi (fejlesztés)

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
  index.html login.html nginx.conf docker-entrypoint.sh \
  admin@192.168.0.136:/home/admin/bringaterv/

sshpass -p 'admin' rsync -avz \
  src/ \
  admin@192.168.0.136:/home/admin/bringaterv/src/

# Backend API
sshpass -p 'admin' rsync -avz \
  routes-api/app.py \
  admin@192.168.0.136:/home/admin/bringaterv/routes-api/

# Docker újraépítés (szükséges ha Dockerfile vagy routes-api változott)
sshpass -p 'admin' ssh admin@192.168.0.136 \
  "cd /home/admin/bringaterv && docker compose down --remove-orphans && docker compose up -d --build"

# Gyors újraindítás (csak config változott)
sshpass -p 'admin' ssh admin@192.168.0.136 \
  "cd /home/admin/bringaterv && docker compose restart"
```

### Mikor kell `--build`?

| Változott | Szükséges |
|---|---|
| `src/*.js`, `index.html`, `nginx.conf` | Restart elég (nginx cache-eli) |
| `routes-api/app.py` | Restart elég |
| `routes-api/requirements.txt` | `--build` kötelező |
| `Dockerfile` bármelyik | `--build` kötelező |

---

## 10. Deployment – NAS / éles

A NAS a **éles szerver**. A GitHub main branch-ről frissül.

**Adatok:**
- IP: `192.168.2.101`
- NAS mappa: `/volume1/docker/ANPR_PROJEKT` ← (más projekt, bringaterv-nek külön mappa kellhet)
- Bringaterv-nek: `/volume1/docker/bringaterv/`

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

> ⚠️ **Fontos:** `cp -rf` kell, nem `mv`! Az `mv` nem írja felül a meglévő mappákat, hanem belemozgatja (`templates/templates/` létrejön a helyes felülírás helyett).

### Portainer (ajánlott)

1. Portainer → Stacks → `bringaterv` → **Pull and redeploy**

A `routes-data` volume **megmarad** frissítéskor – a mentett GPX-ek és edzések nem vesznek el.

---

## 11. Docker Compose konfiguráció

### Fejlesztési (`docker-compose.yml`)

```yaml
services:
  bringaterv:
    build: .                        # helyi build
    ports:
      - "${PORT:-8088}:80"
    environment:
      LOGIN_ENABLED: ${LOGIN_ENABLED:-true}
      LOGIN_USER:    ${LOGIN_USER:-bringa}
      LOGIN_PASSWORD: ${LOGIN_PASSWORD:-terv}
    depends_on: [routes-api]
    networks: [bringaterv-net]
    restart: unless-stopped

  routes-api:
    build: ./routes-api             # helyi build
    environment:
      DATA_DIR:         /data/routes
      SAMPLES_DIR:      /samples
      APP_MODE:         ${APP_MODE:-single}
      DB_PATH:          /data/bringaterv.db
      MULTI_DATA_DIR:   /data/users
      ADMIN_EMAIL:      ${ADMIN_EMAIL:-admin@bringaterv.local}
      ADMIN_PASSWORD:   ${ADMIN_PASSWORD:-password123}
      JWT_SECRET:       ${JWT_SECRET:-change-me-please}
      JWT_EXPIRY_DAYS:  ${JWT_EXPIRY_DAYS:-30}
    volumes:
      - routes-data:/data           # teljes /data volume (routes + db + users)
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
| `LOGIN_USER` | bringaterv | nginx basic auth user | `bringa` |
| `LOGIN_PASSWORD` | bringaterv | nginx basic auth jelszó | `terv` |
| `APP_MODE` | routes-api | `single` vagy `multi` | `single` |
| `DATA_DIR` | routes-api | Single mód adatmappa | `/data/routes` |
| `SAMPLES_DIR` | routes-api | Minta útvonalak mappája | `/samples` |
| `DB_PATH` | routes-api | SQLite DB elérési út | `/data/bringaterv.db` |
| `MULTI_DATA_DIR` | routes-api | Multi mód user mappák | `/data/users` |
| `ADMIN_EMAIL` | routes-api | Első admin email | `admin@bringaterv.local` |
| `ADMIN_PASSWORD` | routes-api | Első admin jelszó | `password123` |
| `JWT_SECRET` | routes-api | JWT aláíró kulcs | `change-me-please` |
| `JWT_EXPIRY_DAYS` | routes-api | Token élettartam | `30` |

---

## 12. localStorage kulcsok

| Kulcs | Tartalom |
|---|---|
| `bringaterv.hrZones` | HR zóna beállítások (rest, max, method, lthr, customBoundaries, ...) |
| `bringaterv.mapStyle` | Aktív térképstílus neve |
| `bringaterv.unit` | Mértékegység: `metric` / `imperial` |
| `bringaterv.startView` | Kezdő térképnézet (center + zoom) |
| `bringaterv.routingEnabled` | Útra illesztés be/ki |
| `bringaterv.segmentInfo` | Szakasz info be/ki |
| `bringaterv.gpxVia` | GPX köztes pontok be/ki |
| `bringaterv.settings.collapsed` | Összecsukott beállítás szekciók listája |
| `bringaterv.settings.ver` | Verzió kulcs a beállítás reset kezeléséhez (jelenleg: `"8"`) |

---

## 13. API végpontok összefoglaló

### Közös (single + multi)

| Metódus | Végpont | Leírás |
|---|---|---|
| `GET` | `/api/health` | Állapot + APP_MODE visszajelzés |
| `GET` | `/api/routes` | Útvonalak listája |
| `POST` | `/api/routes` | Új útvonal feltöltése (multipart: gpx + metadata) |
| `GET` | `/api/routes/<id>` | Egy útvonal metaadatai |
| `GET` | `/api/routes/<id>/gpx` | GPX fájl letöltése |
| `PATCH` | `/api/routes/<id>` | Metaadatok szerkesztése |
| `DELETE` | `/api/routes/<id>` | Útvonal törlése |
| `GET` | `/api/samples` | Beépített minta útvonalak listája |
| `GET` | `/api/samples/<id>` | Minta GPX fájl letöltése |

### Multi mód extra végpontok

| Metódus | Végpont | Auth | Leírás |
|---|---|---|---|
| `POST` | `/api/auth/login` | Nincs | JWT token igénylés |
| `GET` | `/api/auth/me` | user | Saját profil |
| `GET` | `/api/admin/users` | admin | Felhasználók listája |
| `POST` | `/api/admin/users` | admin | Új felhasználó |
| `GET` | `/api/admin/users/<id>` | admin | Egy user adatai |
| `PATCH` | `/api/admin/users/<id>` | admin | User szerkesztés |
| `POST` | `/api/admin/users/<id>/password` | admin | Jelszó csere |
| `GET` | `/api/admin/stats` | admin | Rendszer statisztikák |

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
```

### GitHub Actions

A main branch-re pusholt commit automatikusan buildeli és GHCR-re tölti fel a Docker image-eket:
- `ghcr.io/czdanika/bringaterv:latest`
- `ghcr.io/czdanika/bringaterv-api:latest`

---

*Dokumentáció utoljára frissítve: 2026-05-20*
