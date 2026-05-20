# Changelog

## v2.0 – 2026-05-20 – Multi-user rendszer, admin panel

### Összefoglalás

Az alkalmazás most már kizárólag **multi-user módban** fut. A korábbi single/multi mód megkülönböztetés megszűnt. Az admin felhasználó ugyanúgy belép, mint bárki más – az egyetlen különbség a `role=admin` jogkör.

### Főbb változások

#### Multi-user infrastruktúra
- **JWT autentikáció** – PyJWT HS256, bcrypt jelszóhashek
- **SQLite adatbázis** – `users`, `user_sessions`, `workouts`, `routes` táblák
- **Per-user útvonaltár** – minden felhasználó saját `/data/users/<uid>/routes/` mappában tárol
- **DB séma v5** – verziózott migrációk, `first_name` + `last_name` oszlopok, névsorend javítás
- **`fcntl.flock()`** – gunicorn több worker esetén biztonságos DB inicializáció

#### Admin panel (`admin.html`)
- Felhasználólista, létrehozás, szerkesztés
- Felhasználónév/email és jelszó módosítható adminból
- Vezetéknév + Keresztnév mezők (magyar sorrend)
- Admin szerepkörű usernél nincs Tiltás gomb
- Útvonalkezelés: felhasználó fájljainak listája, törlés

#### Beállítások szerver-szinkron
- `GET/PUT /api/user/settings` – HR zónák, térképstílus, mértékegység, induló nézet szinkronizálva

#### CSS / Z-index javítások
- `#topnavDropdown` és `#settingsOverlay` a `<body>` végére mozgatva – sidebar stacking context okozta levágás kiküszöbölve
- Könyvtár nézetben is megjelenik a beállítások overlay és a navigáció dropdown

#### Single mód eltávolítása
- `APP_MODE` env változó megszűnt – mindig multi mód
- `config.js`-ben csak `login: true/false` marad
- `LOGIN_USER` / `LOGIN_PASSWORD` a frontend containerből kikerült – csak az API-ban kellenek (admin init)
- `isMultiMode()` JS függvény törölve mindenhonnan
- `docker-compose-nas.yml` és `docker-compose.yml` frissítve

### Migráció régi verzióról

Ha korábban single módban használtad az alkalmazást és van mentett útvonalad (`/data/routes/index.json`), az első induláskor automatikusan átmigrálódnak az admin user mappájába (v3 DB migráció).

---

## v0.12 – 2026-05-18 *(nem pusholva)*

### 4 tervezési mód

A korábbi „Kerékpár / Gyalogos" váltó helyett 4 önálló tervezési mód:

- **Aszfalt** – BRouter `fastbike` profil; kerékpársávokat, burkolt utakat részesít előnyben; átlagsebesség-becslés: 22 km/h
- **Gravel** – BRouter `gravel` profil; kavicsos és földes utak aszfalttal vegyítve; 18 km/h
- **MTB** – BRouter `mtb` profil; erdei utak, ösvények, nehezebb terep; 12 km/h
- **Túra / Gyalogos** – BRouter `trekking` profil; gyalogutak, erdei ösvények, turistajelzések; 5 km/h

Minden módhoz hover-hint tartozik a gombon.

#### Érintett fájlok
- `src/map/mapAdapter.js` – `profileMap` bővítve; `cycling` → `fastbike` visszafelé kompatibilitás megmarad
- `index.html` – 2 gomb helyett 4 mód gomb (`data-route-mode`), export modal és könyvtár-szerkesztő modal 4 rádió opcióval
- `src/gpx/gpx.js` – `sportTypeMap` bővítve (asphalt/gravel/mtb → `cycling` GPX típus)
- `src/main.js`:
  - Alapértelmezett mód: `cycling` → `asphalt` (localStorage-ban tárolt `cycling` érték is konvertálódik)
  - `avgSpeedMap` módtól függő sebességbecslés
  - Könyvtár mentéskor `type` mező: `asphalt` / `gravel` / `mtb` / `hiking` (walking → hiking)
  - Badge ikonok: `mtb` → mountain, `hiking` → footprints, többi → bike
  - Könyvtár-szerkesztő modal: `cycling` típusú régi kártyákon `asphalt` rádió van előre kiválasztva
- `src/styles.css` – badge színek: asphalt (kék), gravel (barna), mtb (zöld), hiking (halvány zöld), workout (narancs)

### Hibajavítás: könyvtárból tervezésre töltés – távolság 0

Könyvtárból „Betöltés tervezéshez" után a távolságmező nem maradt 0. A `loadRouteFromLibrary` függvény most kiszámítja és beállítja a `distanceMeters`, `ascentMeters`, `descentMeters` értékeket a betöltött geometriából.

---

## v0.10 – 2026-05-17

### Útvonalkönyvtár

Szerver oldali GPX tároló Flask + Docker volume alapon. A könyvtár három szekcióból áll – mindhárom lenyíló (accordion) menüként jelenik meg.

#### Backend (`routes-api`)
- **Flask REST API** – külön Docker konténer, csak belső hálózaton elérhető (nginx proxy-n át)
- **Végpontok:** `GET/POST /api/routes`, `GET/PATCH/DELETE /api/routes/:id`, `GET /api/samples`, `GET /api/samples/:id`, `GET /api/health`
- **Adattárolás:** Docker volume (`routes-data`) – perzisztens, újraindítás után is megmarad
- **Atomikus index írás** – temp fájl + rename, hogy ne sérüljön az `index.json`
- **Metaadat mezők:** távolság (km), időtartam (perc), emelkedő (m), típus, leírás
- **Minta útvonalak** – Docker image-be égetett GPX + JSON párok (Balatoni kör, Tisza-tó kör)

#### nginx proxy
- `/api/` prefix → `routes-api:5001` belső proxy, max 10 MB GPX méret

#### Könyvtár fül – Mentett útvonalak
- **Új „Könyvtár" fül** az oldalsávban – saját mentések, edzések és beépített minták
- **Mentés** – az export modalban külön „Mentés a könyvtárba" gomb (GPX letöltéstől elválasztva)
- **Kártyák** – távolság, időtartam és emelkedő chipek az egyes útvonalak alatt
- **Szerkesztés** – mentett útvonal neve, típusa (kerékpár/gyalogos) és leírása módosítható
- **GPX letöltés** – könyvtárból közvetlenül letölthető bármelyik útvonal
- **Törlés** – saját útvonalak törölhetők megerősítés után
- **Betöltés** – egy kattintással töltődik be a Tervezés fülre

#### Könyvtár fül – Edzések
- **Edzés mentése** – Elemzés fülön „Mentés könyvtárba" gomb: az eredeti GPX fájl (összes adatával) kerül a szerverre `workout` típusként
- **Betöltés elemzésre** – edzés kártyákon a betöltés gomb az Elemzés fülre tölti vissza a fájlt, megőrizve a sebesség/pulzus/kadencia/időadat adatokat
- **Eredeti GPX megőrzése** – mentéskor nem generált, hanem az eredeti nyers GPX kerül tárolásra

#### Hibajavítások
- Mentett útvonalaknál a távolság és időtartam mostantól helyesen jelenik meg a kártyán
- Könyvtárból visszatöltött edzéseknél a togglek (sebesség, pulzus, szintprofil) működnek

---

## v0.9.2 – 2026-05-17

### Új funkciók

- **Waypoint közbeszúrás útvonalra kattintással** – Tervezés fülön az egeret az útvonal fölé víve crosshair kurzor jelzi az interakciót, kattintásra új köztes waypoint kerül be a helyes pozícióba (loop-útvonalaknál is). A waypoint neve automatikusan kitöltődik visszafordított geocoding alapján. Az importált geometria megmarad, nem triggerel újratervezést.
- **Visszaút és oda-vissza** – A cél-zászlóra kattintva két új gomb jelenik meg a marker popupban:
  - *Visszaút* – hozzáadja a startpontot új végpontként (x+1), a BRouter megtervezi a legrövidebb hazautat a meglévő útvonal folytatásaképpen
  - *Oda-vissza (automatikus)* – az útvonalat megduplázzá (A→B→C→B→A), teljes körútvonalat alkot

### Tervezés / Elemzés szétválasztás

- Tervezés fülön saját GPX import gomb: csak waypontokat tölt be, marad a Tervezés fülön
- Tab váltás guard: ha van aktív adat, megerősítő párbeszéd jelenik meg (Mégse / Törlés / Mentés)
- Elemzés fülön „Tervezés ez alapján" gomb: a fájl waypontjait betölti a Tervezés fülre

### Hibajavítások

- Race condition fix: importálás közben folyamatban lévő BRouter kérés már nem írja felül az importált geometriát
- Loop-útvonal (körút) betöltésekor a start és végpont közötti közvetlen vonal helyett a teljes geometria jelenik meg
- Waypoint közbeszúrás loop-útvonalnál helyes pozícióba kerül (végpont a geometria végéhez képez le, nem az elejéhez)

---

## v0.9.1 – 2026-05-17

### Javítások
- Alapértelmezett megjelenítés: GPX betöltés után a sima útvonal azonnal látszik, a réteg kapcsolók (sebesség/pulzus/kadencia/lejtő) alapból kikapcsolva
- Elemzés fülön megjelent a **Térképstílus** választó – kompakt gombként, a fájlnév mellett
- Verzióellenőrzés: az app oldalbetöltéskor megnézi, elérhető-e újabb GitHub release; ha igen, pulzáló narancs pont jelzi az oldalsávban

---

## v0.9 – 2026-05-17

### Szintprofil és diagramok
- **Szintprofil diagram** – alul felcsúszó panel, egér húzásra a pozíció jelölve a térképen és a diagramon
- **Sebességdiagram** – a sebesség térkép kapcsoló melletti ikon megnyitja a sebességprofilt (kék vonal, km/h)
- **Pulzusdiagram** – a pulzus térkép kapcsoló melletti ikon megnyitja a pulzusprofit (piros vonal, bpm)
- Diagramok kizárólagosak: egyszerre csak egy nyitható meg

### Lejtőtérkép
- **Szintprofil / lejtőtérkép kapcsoló** – a Sebesség/Pulzus/Kadencia togglekhoz hasonlóan, kizárólagos megjelenítés
- Emelkedő piros árnyalatokban, süllyedő zöld árnyalatokban, egyenes szürkén
- 0,5%-os küszöb: már enyhe emelkedők/süllyedők is láthatók
- 150 méteres simítás: nem pöttyek, összefüggő szakaszok
- Tervezett útvonalnál és betöltött GPX-nél egyaránt elérhető

### Térkép rétegek
- Kapcsolók kizárólagosak – egyszerre csak egy réteg (sebesség / pulzus / kadencia / lejtő) lehet aktív

### Egyéb
- „Betöltött fájl" fül átnevezve **„Elemzés"**-re
- `crypto.randomUUID` polyfill: HTTP-n (helyi hálózat, NAS) is működik az app
- GPX import hibakezelés: érvénytelen fájl esetén toast üzenet jelenik meg
- nginx MIME típus javítás: ES modulok helyes `application/javascript` típussal töltődnek

---

## v0.8 – 2026-05-17

### Docker / telepítés
- Bejelentkezési adatok és port konfigurálható docker-compose environment változókkal
- `LOGIN_ENABLED`, `LOGIN_USER`, `LOGIN_PASSWORD`, `PORT` változók támogatása
- Entrypoint script generálja a `config.js`-t induláskor
- Alapértelmezett port: 8088

---

## v0.7 – 2026-05-17

### Bejelentkezés
- Bejelentkezési oldal (`login.html`) háttérképpel (`btervlogin.png`)
- `config.js` – bejelentkezés be/ki kapcsolható, felhasználónév és jelszó beállítható
- `auth.js` – munkamenet kezelés `sessionStorage`-ban
- Kilépés gomb a jobb felső menüben (csak ha a bejelentkezés engedélyezve van)

### Beállítások panel
- Új Beállítások menüpont a jobb felső menüben
- **Térképstílus** – 7 térkép nézet közt váltható thumbnailekkel
- **Mértékegység** – metrikus / imperial választó
- **Induló nézet** – helykereséssel, jelenlegi térkép nézettel vagy GPS pozícióval mentható
- **Tervezési beállítások** – Útra illesztés, Szakasz infó, GPX köztes pontok; a beállítások mentődnek, ezek az alapértelmezett értékek induláskor

### Bal oldali menü
- Mód gombok (Kerékpár / Gyalog) egymás mellé kerültek, Kerékpár bal oldalt
- Térképstílus választó: egyetlen gomb, kattintásra popup lista az elérhető stílusokkal
- Útra illesztés, Szakasz infó, GPX köztes pontok visszakerültek a bal menübe is; szinkronban vannak a beállításokkal
- Hint tooltip (ⓘ) minden beállítás elemhez – ráhúzásra magyarázat jelenik meg
- GPX exportálás gomb megjelenik a bal menüben, ha már vannak útvonalpontok

### GPX exportálás
- Export gomb (toolbar + bal menü + Elemzés fül) csak aktív, ha van legalább egy pont
- Export modal: útvonal neve, aktivitás típusa (kerékpározás / gyaloglás), leírás, javasolt fájlnév (szerkeszthető)
- A fájlnév automatikusan az első–utolsó pont nevéből generálódik
- A leírás bekerül a GPX `<metadata><desc>` mezőjébe

### Térkép toolbar
- Réteg / térképstílus gomb a toolbaron: popup thumbnailekkel, aktív stílus jelölve
- Aktív stílus ikonja frissül a gomb feliratán

### Elemzés fül (GPX import)
- Metaadatok megjelenítése: útvonal neve, típusa, leírása, kezdési idő, össz- és mozgási idő

### Egyéb
- Favicon hozzáadva
- Tab neve: „Elemzés" (korábban „Betöltött fájl")
- GitHub link javítva a helyes repóra
- Verziószám összecsukott menüben nem lóg ki
- Copyright: © Czibolya Dániel 2026 – megjelenik a login oldalon és az app bal menüjének alján
- `appSettings.js` – perzisztens beállítások tárolása `localStorage`-ban

---

## v0.6 – 2025

- Pulzustérkép megjelenítés
- Fájl mód view-only nézet
- Accordion alapú jelmagyarázat
- Sebesség simítás mozgó átlaggal

## v0.5 – 2025

- Sebesség alapú útvonal színezés és jelmagyarázat
- Tervezés / Elemzés tab szétválasztás

## v0.4 – 2025

- Magassági adatok megjelenítése
- Sebesség hover tooltip
- GPX köztes pontok kapcsoló
