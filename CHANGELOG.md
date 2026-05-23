# Changelog

## v0.85 – 2026-05-23 – Útirány-nyilak, szélelemzés finomítások

### Útirány-nyilak a térképen

- Új vizuális segédlet: kis háromszög nyilak (▲) a route mentén ~1.5 km-enként, pontosan a haladási irányba forgatva (helyi bearing alapján).
- Hurkos vagy oda-vissza pályán segít azonnal eldönteni, hogy melyik irányba megyünk.
- Tervezésnél (BRouter route) és Elemzésnél (importált GPX/FIT) is működik, mert mindkét kontextusban az `activeGeometry`-re fut.
- Beállítások panel új szekciója: „Útirány a térképen" – toggle „Útirány-nyilak megjelenítése". A toggle állapota `localStorage`-ben mentődik (`bringaterv.directionArrows`).
- Halvány szín (rgba 70% szürke) + fehér text-shadow, hogy bármilyen háttéren olvasható maradjon.

### Szélelemzés finomítások

- A szélelemzés többé **nem fut automatikusan** tervezéskor – csak akkor, ha kifejezetten aktiválod (a térkép toolbaron lévő szél-ikonnal, a sidebar wind szekciójának chart-gombjával, vagy a „térképszínezés" kapcsolóval).
- A wind térképszínezés kapcsoló (`#windMapTogglePlan`) mostantól **kattintásra el is indítja az elemzést**, nem csak az utólagos vizualizációt vezérli. Egy lépésben aktiválható az egész feature.
- Az auto re-run (útvonal / indulási idő / sebesség változásra) megmaradt, de **csak akkor fut**, ha a wind már egyszer manuálisan aktiválódott.
- **Importált fájl bug fix**: korábban a GPX/FIT betöltése után a route szélirány-szerint színeződött (mert a store waypointjai bekerültek a "tervezési" kontextusba). Most a `state.importedRoute` flag alapján szűrjük: importált útvonalra a wind nem aktivál sem a sidebar legendát, sem a toolbar gombot, sem a térképszínezést.

### Verzió

- v0.84 → v0.85

---

## v0.84 – 2026-05-22 – Szélelemzés, kerékpáros profil, szakaszhossz, km-jelölők

### Szélelemzés (Open-Meteo)

- Új modul: `src/wind/windService.js`. Az Open-Meteo nyilvános API-ból (kulcs nélkül, 7 napos óránkénti előrejelzés) lekérdezzük a szél irányát és sebességét, hőmérsékletet, csapadék-valószínűséget és felhőzetet az útvonal mentén.
- Mintavételezés: rövid útvonalon legalább 4 szegmens, hosszabb útvonalon ~10 km-enként, max. 30 párhuzamos API hívás.
- Szegmensenkénti dekompozíció: a szelet a haladási irányhoz képest hátszél / oldalszél / szembeszél komponensre bontjuk a útszakasz iránya és a szél iránya közti szög alapján (0–60° = hátszél, 60–120° = oldalszél, 120–180° = szembeszél).
- Az érkezési időt is figyelembe veszi: a megadott indulási idő + a tervezett átlagsebességből számolt szakasz-érkezési időpontra kérjük le a szelet (nem a startidő szelét vesszük az egész útra).
- Független implementáció: a wind-ahead (AGPL) projekttel azonos célt szolgál, de saját algoritmussal és kóddal készült, az Open-Meteo nyilvános dokumentációja alapján.

### Szélelemzés UI

- Új toggle a térkép toolbaron („Szél" ikon), automatikusan aktiválódik amint a route 2 vagy több pontot tartalmaz.
- Bal oldali sidebar új „Szélelemzés" szekciója: 3 színes legenda (hátszél / oldalszél / szembeszél), gyors statisztika sor (hátszél %, oldalszél %, szembeszél %, átlag szélerősség), datetime picker (max +7 nap), átlagsebesség mező és térképszínezés-kapcsoló a fejlécben.
- Részletes panel a térkép alatt nyitható a chart-gombbal: stats kártyák (7 mező: hátszél/oldalszél/szembeszél %-ban és km-ben, átlag szélerősség, hőmérséklet, max csapadék-valószínűség, felhőzet), színes sávdiagram a route teljes hosszán, szegmens-táblázat (km-tartomány, szélirány-nyíl, szélerősség, érkezési idő).
- Térképszínezés szélirány szerint, kapcsolható a sidebar fejlécében (zöld = hátszél, sárga = oldalszél, piros = szembeszél). Kölcsönösen kizáró a szintprofil térképszínezéssel.
- Automatikus újraszámolás minden útvonal-, indulási idő- vagy átlagsebesség-változásra (400-800 ms debounce).

### Kerékpáros profil (fizikai paraméterek)

- Új beállítási szekció a Beállítások panelben: „Kerékpáros profil".
- Kerékpáros tömege (kg), kerékpár tömege (kg), vezetési pozíció (Felső kormány / Bricsesz / Országúti / Aero → CdA 0.32–0.65).
- Gördülési ellenállás (Crr) automatikusan a tervezési módból: aszfalt 0.005, gravel 0.010, MTB 0.018.
- A profil per-user `settings.json`-ben mentődik (frontend localStorage + backend `SETTINGS_ALLOWED_KEYS` whitelist + szinkronizáció), tehát userváltáskor más profil töltődik be.

### Szélhatás az időbecsléshez

- Új toggle a tervezés sidebar-ban (a „Szintadat az időbecsléshez" alatt): „Szélhatás az időbecsléshez". Csak akkor jelenik meg, ha a szélelemzés lefutott.
- Pontos fizikai modell: a kerékpáros profilból (tömeg, CdA, Crr) visszafejtjük a tervezett sebességhez tartozó referencia-teljesítményt, majd minden szegmensben Newton-iterációval megoldjuk a `P = (Crr·m·g + 0.5·ρ·CdA·(v + v_szembeszél)²) × v` egyenletet a tényleges szélkomponenssel. A szegmensek időit összeadva kapunk egy szélhatás-szorzót, amit az időbecslésre alkalmazunk.
- Ezzel a szembeszélnél a becsült idő hosszabb lesz, hátszélnél rövidebb – a valós sebesség- és teljesítmény-összefüggésnek megfelelően.

### Szakaszhossz waypontok között

- A tervezési sidebar waypoint listáján minden szomszédos pont között megjelenik egy halvány „↓ 5.2 km" stb. címke a két pont közti tényleges szakaszhosszal.
- A számítás a BRouter által visszaadott geometriából történik: minden waypointhoz a legközelebbi geometria-pontot keressük (monoton kereséssel), majd a köztük lévő kumulatív haversine-távolságot adjuk vissza. Mixed-mode routing esetén a `routeSegments` tömb adatait használjuk közvetlenül.

### 5 km-es jelölők a térképen

- A route mentén minden 5 kilométernél megjelenik egy kis fehér ovális marker a kilométer-számmal (5, 10, 15, …).
- A marker pozíció interpolációval pontosan a vonalon van, a két szomszédos geometria-pont között.
- Automatikusan frissül minden geometria-változásra.

### Egyéb

- Sidebar átrendezve: a GPX importálás és a Mentés gomb a tervezési szekció aljára került (a stat-kártyák, szintprofil legenda és szélelemzés alá).
- Új modul: `src/calories.js` – MET-alapú kalóriabecslés Compendium 2011 értékekkel. Jelenleg nincs UI-on rendszerezve (4 ride összevetés Strava-val 5-145%-os szórással), de a függvény elérhető későbbi újra-aktiváláshoz.

### Verzió

- v0.83 → v0.84

---

## v0.83 – 2026-05-22 – Admin minta-kezelő, GPX előelemzés, profil backup/restore

### Profil backup és visszaállítás

- A teljes felhasználói profil (beállítások + mentett útvonalak + edzések) ZIP archívumba menthető és visszaállítható.
- A backup ZIP tartalma: `meta.json` (verzió, készítés dátuma), `settings.json` (HR zónák, adatzónák, diagram színek, térképstílus stb.), `routes/index.json` + `routes/<id>.gpx` + opcionális `routes/<id>.fit`, valamint ugyanez `workouts/` mappában.
- Fájlnév formátum: `<email-vagy-uid>-<dátum>.zip` (pl. `bringa-2026-05-22.zip`).
- Visszatöltéskor két mód közül választható:
  - **Hozzáadás (merge)** – minden visszatöltött útvonal új ID-t kap és a meglévők mellé kerül, a `settings.json` változatlan marad. Biztonságos default.
  - **Teljes felülírás (replace)** – a jelenlegi `settings.json`, `routes/`, `workouts/` mappa törlődik, majd a backup eredeti ID-kkel visszaíródik.
- Atomikus index-írás (`tmp + rename`) restore közben is, így nem sérülhet az `index.json`.

### Backend bővítés (`routes-api`)

- Új végpontok:
  - `GET  /api/user/backup` – saját ZIP letöltés (Bearer token alapján)
  - `POST /api/user/restore` – saját visszaállítás multipart `backup` mezővel, `mode=merge|replace`
  - `GET  /api/admin/users/<uid>/backup` – admin által bármely felhasználó backup-ja
  - `POST /api/admin/users/<uid>/restore` – admin által bármely felhasználó visszaállítása
- A ZIP a memóriában készül a Python `zipfile` modullal (`io.BytesIO`), és `send_file` adja vissza streamként.
- A merge mód a backup `index.json`-jából minden bejegyzéshez új `r_` prefixű UUID-t generál, és az érintett `<id>.gpx` (+ opc. `.fit`) fájlokat átnevezve másolja a célmappába.

### Frontend API helper (`src/api/routesApi.js`)

- `routesApi.downloadBackup()` – ZIP letöltés `{ blob, filename }` formában (a `Content-Disposition` header alapján parse-olja a fájlnevet).
- `routesApi.restoreBackup(file, mode)` – ZIP feltöltés, JSON statisztika visszaadása (`routes_added`, `workouts_added`, `settings_restored`).
- `routesApi.admin.downloadUserBackup(userId)` / `restoreUserBackup(userId, file, mode)` – admin verziók.

### UI – Beállítások panel (`index.html`)

- Új "Backup és visszaállítás" szekció a beállítások panel alján.
- "Backup letöltése (.zip)" gomb – kattintásra letöltődik a felhasználó saját ZIP-je.
- Visszaállítás: fájlválasztó + radio gomb (Hozzáadás / Teljes felülírás) + Visszaállítás gomb.
- Megerősítő `confirm()` dialógus a `replace` módra ("Visszafordíthatatlan!"), és discreet figyelmeztetés a `merge` módra.
- Replace után 1.5 másodperc múlva `location.reload()` hogy a frissített `settings.json` betöltődjön a UI-ra.

### UI – Admin panel (`admin.html`)

- Új "Backup" gomb minden felhasználói sorban (Útvonalak / Backup / Szerkeszt / Tiltás).
- Külön Backup modal a kattintásra: backup letöltése + visszaállítás (fájl + mode + gomb), kompakt 520px szélességben.
- A korábbi placeholder rendszer-szintű "Backup / Restore" gomb a panel fejlécben megmaradt, kattintásra most már informatív üzenet jelzi, hogy per-user backup elérhető a sorokban.

### Minta útvonalak admin kezelése

- Új "Minta útvonalak" szekció az admin panelen (`admin.html`): a globális, mindenki által látható minta útvonalak (Balatoni kör, Tisza-tó kör stb.) most webes felületről kezelhetők – nem kell Docker image-be égetni vagy kézzel fájlt másolni a szerverre.
- Új minták feltöltése: GPX fájl + név, típus (Aszfalt / Gravel / MTB / Túra), leírás, távolság, időtartam, emelkedő.
- Meglévő minták szerkesztése: a beépített minták metaadatai is felülírhatók (a felülírás külön JSON fájlba kerül a `/data/samples` volume-ba, az eredeti Docker image-ben lévő minta változatlan marad).
- Egyedi (admin által feltöltött) minták törölhetők. A beépített minták nem törölhetők, csak felülírhatók metaadatszinten.
- Forrás jelzés a táblázatban: `Beépített` (image-be égetve) vagy `Egyedi` (admin által feltöltve).

### GPX előelemzés minta feltöltéskor

- Új minta feltöltésekor a GPX kiválasztása után automatikus elemzés indul (az `index.html` Elemzés fülén használt `showLoadPreview` panel logikája alapján):
  - Távolság (haversine), emelkedő, trackpontok száma és időtartam (ha van GPS idő a fájlban) kiszámolva és a stats kártyákon megjelenítve.
  - Mezők automatikusan kitöltődnek (Távolság, Emelkedő, Időtartam, Név – utóbbi csak ha üres és van a GPX-ben `<name>`).
  - "Szegmensvizsgálat futtatása" gombbal Overpass OSM lekérdezés indítható: az útvonal mentén lekérdezi az útburkolatot, és megjeleníti a szegmenseket (pl. Aszfalt 12.3 km, Gravel 5.8 km, MTB 2.1 km) színes sávon és lista formában – ugyanolyan vizuál, mint a főoldali GPX import.

### Backend bővítés – minta-kezelés (`routes-api`)

- Új környezeti változó: `CUSTOM_SAMPLES_DIR` (alapért.: `/data/samples`) – a perzisztens, admin által feltöltött minták helye. A meglévő `SAMPLES_DIR` (image-be égetett minták) változatlanul `read-only`.
- `GET /api/samples` mostantól a két könyvtárat egyesíti: a custom felülírja a beépítettet azonos ID esetén. Az új `custom: bool` mező jelzi a forrást.
- Új admin végpontok (mind `@require_auth + @require_admin` védve):
  - `GET    /api/admin/samples` – beépített és custom minták listája, forrás jelzéssel
  - `POST   /api/admin/samples` – új minta feltöltése multipart/form-data-ként (`gpx` fájl + `name`, `type`, `description`, `distance`, `duration`, `elevation` mezők)
  - `PATCH  /api/admin/samples/<id>` – meta felülírás (beépített mintára is alkalmazható, ekkor a felülírás custom JSON-ba kerül)
  - `DELETE /api/admin/samples/<id>` – csak custom minták törölhetők (HTTP 404 ha beépített)

### Frontend API helper – minta-kezelés (`src/api/routesApi.js`)

- Új admin metódusok: `routesApi.admin.listSamples()`, `createSample(formData)`, `updateSample(id, data)`, `deleteSample(id)`.

### Egyéb

- `admin.html` `<style>` szekciója bővítve a load-preview panel CSS osztályaival (`.load-preview-stats`, `.load-preview-stat`, `.load-preview-bar`, `.load-preview-analysis-row` stb.) – így ugyanaz a vizuál, mint a főoldali import panel.
- A docker-compose nem változott: a `/data/samples` mappa és a backup mappastruktúra a meglévő `routes-data` volume-on belül jön létre automatikusan.
- Verziószám: `v0.82` → `v0.83`.

---

## v0.82 – 2026-05-21 – FIT import, testreszabható zónák, diagram színek

### FIT fájl importálás

- Az Elemzés fülön mostantól nemcsak GPX, hanem FIT fájlok is betölthetők (Garmin, Wahoo, Bryton, Hammerhead órák és komputerek alapformátuma).
- Saját, böngészőben futó FIT decoder (`src/gpx/fit.js`): a FIT bináris fájlt GPX 1.1 szöveggé konvertálja Garmin TrackPointExtension (pulzus, kadencia, hőmérséklet) és PowerExtension (W) mezőkkel. A meglévő GPX elemzés változatlanul működik a konvertált adatokon.
- Drag and drop: GPX vagy FIT fájl húzható a böngészőablakba bárhonnan, narancssárga overlay jelzi a fogadási területet.
- Importálás után a fájlnév mellett FIT címke jelenik meg, ha az eredeti fájl FIT volt.
- Edzés mentésekor a könyvtárba az eredeti FIT bináris is megőrződik a konvertált GPX mellett (`<route_id>.fit` a `<route_id>.gpx` mellé). A könyvtár- és admin kártyán FIT címke + külön letöltés gomb jelzi.
- Új végpontok: `GET /api/routes/<id>/fit`, `GET /api/admin/users/<uid>/routes/<rid>/fit`, valamint a meglévő `POST /api/routes` és `POST /api/admin/users/<uid>/routes` opcionális `fitContent` (base64) mezőt fogad.

### Testreszabható zónák (sebesség, kadencia, teljesítmény)

- Új beállítási szekció: "Adatzónák (sebesség / kadencia / teljesítmény)".
- Mindhárom adattípushoz 8 zónás (7 fogópontos) multi-slider, amelyen húzva állíthatók a határértékek.
- Színskála progresszív gradiens: szürke, kék, cián, zöld, lime, sárga, narancs, piros (Strava / Garmin színskálához hasonló).
- Élő frissítés: drag közben a térképi sebesség- / kadencia- / teljesítmény-réteg azonnal újraszíneződik, a jelmagyarázatok automatikusan a választott BPM / km/h / W tartományokat mutatják.
- "Egyenlő felosztás" gomb mindhárom sliderhez: a tartományt 8 egyenlő részre osztja egy kattintással (reset funkció).
- 2 oszlopos, 4 soros rácsban listázott zónacímkék (Z1 ... Z8) a határértékek alatti megjelenítéshez.

### HR beállítások átdolgozás

- A "Személyes adatok" blokk most kompaktabb: nem, születési év (életkor automatikusan számolva), majd duál-fogópontos pulzustartomány slider 35-220 bpm között.
- A nyugalmi pulzus a bal, a max pulzus a jobb fogópont; a két fogópont között színátmenetes sáv (zöld - narancs - piros).
- Új blokk: "Pulzusszámítás (max HR)" három opcióval: Tanaka (208 - 0.7 * kor; nőknél automatikusan Miller, 216 - 1.09 * kor), klasszikus 220 - kor, valamint Egyedi (kézi értékmegadás). Az automatikus módokban a max fogópont rögzített és szürkén látszik, Egyedi módban szabadon mozgatható.
- A "Zónaszámítás módszere" radio (Karvonen, Max HR %, LTHR, Egyedi zónák) hint tooltipekkel: minden gomb fölé húzva megjelenik a Strava / Garmin / TrainingPeaks kompatibilitási információ. LTHR módban külön csúszka, Egyedi módban multi-slider 4 fogóponttal a BPM határokhoz.
- Zónamodell választó (Friel, Egyenlő sávok) hoverre megjelenő magyarázattal a fix szöveg helyett.

### Diagram színek

- Új beállítási szekció: "Diagram színek".
- Két mód: Egyszínű (minden adattípushoz külön szín választható HTML5 színpickerrel) és Zónaszín (a diagram vonala szegmensenként a zónaszínekkel rajzolódik).
- 5 diagram konfigurálható: Szintprofil, Sebesség, Pulzus, Kadencia, Teljesítmény.
- Zónaszín módban a szintprofil vonala a lejtés (grade %) alapján színeződik (vörös az emelkedő, zöld a süllyedés); a sebesség/kadencia/teljesítmény az Adatzónákban beállított határokkal; a pulzus a HR zónákkal egyezően.

### Admin panel fájlkezelő

- A felhasználói táblában új "Útvonalak" gomb jelenik meg minden sornál (a Szerkeszt / Tiltás gombok mellett), nem a korábbi alig látható mappa ikon.
- Az Útvonalak modalban: GPX letöltés, FIT letöltés (ha elérhető), inline szerkesztés (név, típus, leírás), törlés.
- Új felhasználói GPX vagy FIT feltöltés admin részéről a modal "Feltöltés" gombjával.
- Modal szélessége: 1080px (vagy a viewport 95%-a), oszlopok pontosan illeszkednek, vízszintes scrollozás megszüntetve.

### Per-user beállítások (settings.json)

- A felhasználói beállítások (HR zónák, adatzónák, diagram színek, térképstílus, mértékegység, induló nézet, téma) mostantól per-user JSON fájlban tárolódnak a szerveren: `/data/users/<uid>/settings.json`.
- A korábbi SQLite `users.settings` oszlop tartalma automatikusan átköltöztetődik (v6 séma migráció).
- Új beállítás hozzáadása nem igényel DB séma változást, csak a `SETTINGS_ALLOWED_KEYS` lista bővítését.

### Felhasználói izoláció

- Logout-kor minden user-specifikus localStorage kulcs törlődik (`bringaterv.hrZones`, `bringaterv.speedZones`, `bringaterv.cadZones`, `bringaterv.powerZones`, `bringaterv.chartColors`, `bringaterv.startView`, `route4meMapStyle`, `route4meUnit`, `route4meTheme`, `bringaterv.settings.collapsed`).
- Új `bringaterv_settings_owner` localStorage kulcs azonosítja, kihez tartoznak a tárolt beállítások. Main.js induláskor, az IIFE-k előtt ellenőrzés: ha a tárolt owner ID nem egyezik az aktuális user-rel, a settings törlődik és új owner kerül beállításra. Ezzel a "user A beállításai látszanak user B-nél" bug megoldva.
- A szerver sync utáni hidratáció: új `bringaterv:settingsHydrated` event, a HR settings UI és az adatzóna sliderek erre újraolvasnak a localStorage-ból, így a frissen szerverről érkezett beállítások azonnal érvényesülnek a UI-ban (page reload nélkül).

### Egyéb UI és bugfixek

- Felhasználói táblában az oszlopok `width: 1%` és `white-space: nowrap` trükkel a tartalomhoz zsugorodnak, az akciós gombok jobbra igazítva (Útvonalak / Szerkeszt / Tiltás többé nem csúszik le a viewportból).
- `.main` szélesebb (1100 -> 1400px), cellapaddingek 20px -> 12px (oldalsó cellákon 20px maradt).
- Fájlmodal `scrollbar-gutter: stable` (a függőleges scrollbar nem ugratja meg a tábla szélességét).
- Zónamodell és zónaszámítás módszerei mostantól hint tooltipként jelennek meg a fix szöveg helyett (mint a többi opciónál).

---

## v0.8 – 2026-05-20 – Multi-user rendszer, admin panel

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
