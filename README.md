# Bringaterv

![Bringaterv](src/assets/banner.jpg)

**Nyílt forráskódú GPX útvonaltervező kerékpárosoknak és gyalogosoknak.**
Böngészőben fut, nincs backend, nincs regisztráció – egyszerűen megnyitod és tervezel.

---

## Funkciók

### Térképes tervezés
- Kattintással pontokat helyezhetsz el a térképen
- Kerékpáros és gyalogos tervezési mód
- Útra illesztés BRouter segítségével – ha nem elérhető, egyenes vonalként jelenik meg
- Térképstílusok: Standard, Kerékpáros (CyclOSM), Műholdas, Domborzat (OpenTopoMap)
- Sötét és világos téma, automatikus rendszerfelismeréssel

### Útvonalpontok kezelése
- Automatikus helynévadás Nominatim reverse geocoding alapján
- Drag & drop átrendezés
- Popup szerkesztő: pont neve, megjegyzés, törlés
- Az utolsó pont mindig célállomásként jelenik meg (sakk-tábla zászló)
- Marker húzás a térképen – cím automatikusan frissül

### Keresés és helymeghatározás
- Nominatim alapú helynévkeresés
- GPS-alapú saját helyzet meghatározás

### GPX import / export
- GPX fájl importálása trackpontokkal
- GPX exportálás Strava-kompatibilis formátumban (`<type>` mező, waypoint nevek, megjegyzések)
- Billentyűparancsok: `Ctrl+I` import, `Ctrl+E` export, `Ctrl+R` nullázás, `Ctrl+Z` visszavonás
- Opcionális köztes pontok generálása importáláskor (beállításban kapcsolható)

### Magassági és sebességadatok
- Importált GPX-ből automatikusan kiszámított összesített emelkedő (↑) és ereszkedő (↓)
- Egérrel az útvonal fölé húzva megjelenik a pillanatnyi sebesség és magasság (ha a GPX tartalmaz `<time>` és `<ele>` adatokat)

### Szerkesztőeszközök
- Visszavonás / Újra (undo/redo) korlátlan lépésben
- Útvonal megfordítása
- Összesített távolság, pontszám, emelkedő és ereszkedő megjelenítése
- Metrikus és imperial mértékegység

---

## Változások

### v0.4
- Emelkedő és ereszkedő megjelenítése importált GPX alapján (`<ele>` adatokból)
- Hover tooltip az útvonal fölött: sebesség (km/h) és magasság (m), ha a GPX tartalmaz időbélyeget és magassági adatot
- GPX köztes pontok kapcsoló a beállításokban (Start+Finish helyett 12 köztes pont)
- Stabil hover érzékelés: pixeltávolság alapú detektálás, villogásmentes tooltip

### v0.3
- Teljes UI átdolgozás: vízszintes topnav, szélesebb sidebar (320px)
- GitHub és Buy Me a Coffee linkek a fejlécben
- Térkép stílusváltó ikonsor (Kerékpáros, Standard, Műholdas, Domborzat)
- Verziószám megjelenítése a sidebar alján
- Docker és docker-compose támogatás

---

## Projekt struktúra

```
bringaterv/
├── index.html
├── Dockerfile
├── docker-compose.yml
└── src/
    ├── assets/
    │   └── logo.png
    ├── styles.css
    ├── i18n/
    │   ├── i18n.js
    │   └── translations.js
    ├── state/
    │   └── routeStore.js
    ├── map/
    │   └── mapAdapter.js
    ├── gpx/
    │   └── gpx.js
    └── ui/
        ├── dom.js
        └── search.js
```

---

## Helyi futtatás

ES modulok miatt HTTP-szerver szükséges (a `file://` protokoll nem működik):

```bash
git clone https://github.com/czdanika/bringaterv.git
cd bringaterv
python3 -m http.server 8000
```

Majd böngészőben: `http://localhost:8000`

---

## Docker

### Indítás Docker Compose-zal

```bash
git clone https://github.com/czdanika/bringaterv.git
cd bringaterv
docker compose up -d
```

Az alkalmazás elérhető: **http://localhost:8080**

### Leállítás

```bash
docker compose down
```

### Manuális build (opcionális)

```bash
docker build -t bringaterv .
docker run -d -p 8080:80 bringaterv
```

### Hogyan működik?

A Bringaterv egy teljesen statikus webalkalmazás – nincs szerver oldali logika, nincs adatbázis. A Docker konténer egy egyszerű **nginx** webszervert futtat, amely kiszolgálja a fájlokat:

```
Dockerfile
│
├── Alap: nginx:alpine  (kb. 15 MB)
└── Tartalom: összes projektfájl → /usr/share/nginx/html
```

A konténer mérete kb. **15–20 MB**, indulási ideje másodperceken belül van.

---

## Portainer

### Telepítés Repository módszerrel (ajánlott)

Ez a módszer a GitHub repóból buildeli az alkalmazást – nem kell semmit kézzel letölteni.

1. Portainer → **Stacks** → **Add Stack**
2. Válaszd a **Repository** fület
3. Töltsd ki:
   - **Repository URL:** `https://github.com/czdanika/bringaterv`
   - **Branch:** `main`
   - **Compose path:** `docker-compose.yml`
4. Kattints a **Deploy the stack** gombra

Az alkalmazás elérhető: **http://[szerver-ip]:8080**

---

### Stack leíró (Web editor módszer)

Ha nem Repository-ból, hanem kézzel szeretnéd beilleszteni, a Portainer **Stacks → Add Stack → Web editor** felületén másold be az alábbi YAML-t:

```yaml
services:
  bringaterv:
    image: nginx:alpine
    ports:
      - "8080:80"
    volumes:
      - bringaterv_data:/usr/share/nginx/html
    restart: unless-stopped

volumes:
  bringaterv_data:
```

> **Megjegyzés:** Web editor módban a `build:` direktíva nem támogatott, ezért az alkalmazás fájljait külön kell a volume-ba másolni, vagy használd a Repository módszert.

---

## Tervezett fejlesztések

- [ ] Magassági profil grafikon
- [ ] Útvonal mentése / betöltése (localStorage)
- [ ] Megosztható link generálása
- [ ] Mobilbarát nézet és érintéses drag & drop
- [ ] PWA / offline mód
- [ ] Autós útvonalprofil

---

## Licenc

MIT License – szabad felhasználás, módosítás és terjesztés.

---

*Készítette: [@czdanika](https://github.com/czdanika)*
