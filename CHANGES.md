# Bringaterv – Változásnapló

## Multi-user rendszer (v2) – 2025-2026

### Áttekintés

Az alkalmazás korábban kétféle módban futhatott: **single** (egyfelhasználós) és **multi** (többfelhasználós).
A single módban nem volt valódi autentikáció – a jelszót a config.js tárolta kliens oldalon, sessionStorage-ba írt egy egyszerű flag-et.

**Döntés:** A single módot megszüntettük. Az alkalmazás mostantól mindig multi módban fut.

Indoklás:
- Single módban a "tulajdonos" (admin) egyébként is egyedüli felhasználó – most ugyanúgy adminként van jelen.
- A fejlesztés, tesztelés és bővítés egyszerűbb egyetlen kódútvonallal.
- Ha később más is hozzáférést kap (pl. família vagy közösség), csak felhasználót kell létrehozni – nem kell módot váltani.

---

### Multi-user infrastruktúra

#### Backend (Flask / `routes-api/app.py`)

- **SQLite adatbázis** (`/data/bringaterv.db`): `users`, `user_sessions`, `workouts`, `workout_zones`, `routes` táblák
- **JWT autentikáció** (PyJWT HS256, bcrypt jelszóhash)
- **Per-user útvonaltár**: minden felhasználó adatai a `/data/users/<uid>/routes/` mappában
- **DB séma verziók** (`PRAGMA user_version`):
  - v1: Alap sémák létrehozása, admin user init
  - v2: `settings` oszlop hozzáadása
  - v3: Single módos útvonalak átmigrálása az admin user mappájába (egyszeri)
  - v4: `first_name`, `last_name` oszlopok hozzáadása
  - v5: Névsorend javítása Vezetéknév Keresztnév sorrendűre
- **`fcntl.flock()` locking**: Gunicorn több worker esetén versenyhelyzet ellen – csak az első worker inicializálja a DB-t

#### Végpontok

| Metódus | URL | Leírás |
|---------|-----|--------|
| POST | `/api/auth/login` | Bejelentkezés → JWT token |
| GET | `/api/auth/me` | Bejelentkezett user adatai |
| GET/PUT | `/api/user/settings` | Személyes beállítások (szerver szinkron) |
| GET/POST | `/api/routes` | Útvonal lista / mentés |
| GET/PATCH/DELETE | `/api/routes/<id>` | Útvonal lekérés / módosítás / törlés |
| GET | `/api/samples` | Minta útvonalak listája |
| GET | `/api/samples/<id>` | Minta útvonal GPX |
| GET | `/api/health` | Állapot ellenőrzés |
| GET | `/api/admin/users` | Admin: felhasználók listája |
| POST | `/api/admin/users` | Admin: új felhasználó |
| GET | `/api/admin/users/<id>` | Admin: felhasználó részletei |
| PATCH | `/api/admin/users/<id>` | Admin: felhasználó módosítása (email, jelszó, nevek, szerepkör, kvóta) |
| POST | `/api/admin/users/<id>/password` | Admin: jelszó reset |
| GET | `/api/admin/users/<id>/routes` | Admin: felhasználó útvonalai |
| DELETE | `/api/admin/users/<id>/routes/<rid>` | Admin: útvonal törlése |
| GET | `/api/admin/stats` | Admin: összesített statisztika |

---

### Admin panel (`admin.html`)

- Felhasználók listája, létrehozás, szerkesztés
- **Felhasználónév (email)** és **jelszó** módosítható admin panelről
- **Keresztnév + Vezetéknév** mezők (Vezetéknév | Keresztnév sorrend, magyar konvenció)
- Admin szerepkörű usernél **nincs Tiltás gomb** (öndestrukció ellen)
- Jelszót az ENV határozza meg, nem az admin panelről állítható (admin saját jelszavát sem)
- **Útvonal kezelés**: mappa ikonra kattintva látható a felhasználó összes útvonala, törölhető

---

### Frontend autentikáció (`src/auth.js`)

- JWT tokent `localStorage`-ban tároljuk (`bringaterv_jwt`)
- Felhasználó adatai: `bringaterv_user` (JSON)
- `getToken()`, `getUser()`, `isAdmin()`, `authHeaders()` segédfüggvények
- `isAuthenticated()`: `LOGIN_ENABLED=false` esetén mindig `true`, egyébként JWT token meglétét ellenőrzi
- `login(username, password)`: JWT kérés a Flask API-tól
- `logout()`: localStorage ürítés + átirányítás login.html-re
- `requireAuth()`, `requireAdmin()`: oldalvédelem, nem jogosult user átirányítása

---

### API kliens (`src/api/routesApi.js`)

- Minden kérés `Authorization: Bearer <token>` fejlécet küld
- 401 válasz esetén automatikus kijelentkezés (`handle401()`)
- `routesApi.admin.*`: admin végpontok JS kliense
- `routesApi.getSettings()` / `routesApi.saveSettings()`: személyes beállítások szerver-szinkron

---

### Beállítások szerver-szinkron (`src/main.js`)

- Betöltéskor a szerver értékei felülírják a localStoraget (ha nem üresek)
- Módosításkor debounced (2 s) szerver mentés
- Szinkronizált beállítások: `hrZones`, `mapStyle`, `unit`, `startView`, `theme`

---

### CSS / Z-index javítások

- **Topnav dropdown** (`#topnavDropdown`): `position: fixed`, `z-index: 9000`, dinamikus pozicionálás `getBoundingClientRect()`-tel
  - Az elem a `<body>` végére került (volt: `.topnav-menu-wrap` belsejében)
  - Ok: sidebar `overflow: hidden` + `z-index: 610` stacking contextja egyes böngészőkben levágta a fixed elemet
- **Beállítások overlay** (`#settingsOverlay`): szintén `<body>` végére mozgatva (volt: `.sidebar` belsejében)
  - Könyvtár nézetben a sidebar stacking contextja blokkolta a megjelenést
- Lenyíló bezárás: `contains(e.target)` alapú document click listener (megbízhatóbb mint `stopPropagation()`)

---

### Docker konfiguráció

- `docker-compose.yml`: `APP_MODE` eltávolítva, mindig multi mód
- `docker-entrypoint.sh`: config.js-ből `mode`, `user`, `password` eltávolítva – csak `login: true/false` marad
- Környezeti változók:
  - `LOGIN_ENABLED`: `true` / `false` – be kell-e jelentkezni
  - `ADMIN_EMAIL`: admin felhasználó email-je (alapért.: `LOGIN_USER` értéke)
  - `ADMIN_PASSWORD`: admin jelszó (alapért.: `LOGIN_PASSWORD` értéke)
  - `JWT_SECRET`: JWT aláíró kulcs (kötelező éles üzemben megváltoztatni!)
  - `JWT_EXPIRY_DAYS`: token élettartama napban (alapért.: 30)

---

### Backup

A refaktor előtti állapot megőrzve a git historiban:
```
git show fa629d4  # "backup: multi-user rendszer teljes állapota – single/multi refaktor előtt"
```
