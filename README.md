# Bringaterv

![Bringaterv](src/assets/banner.jpg)

**Nyílt forráskódú GPX útvonaltervező kerékpárosoknak és gyalogosoknak.**
Böngészőben fut, nincs backend – egyszerűen megnyitod és tervezel.

---

## Funkciók

### Térképes tervezés
- Kattintással pontokat helyezhetsz el a térképen
- Kerékpáros és gyalogos tervezési mód
- Útra illesztés BRouter segítségével – ha nem elérhető, egyenes vonalként jelenik meg
- 7 térképstílus: Standard, Kerékpáros, Műholdas, Hybrid, Domborzat, Világos, Sötét
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
- Export modal: útvonal neve, aktivitástípus, leírás, egyedi fájlnév
- GPX exportálás Strava-kompatibilis formátumban
- Billentyűparancsok: `Ctrl+I` import, `Ctrl+E` export, `Ctrl+R` nullázás, `Ctrl+Z` visszavonás

### Magassági és sebességadatok
- Importált GPX-ből automatikusan kiszámított emelkedő (↑) és ereszkedő (↓)
- Sebesség, pulzus és kadencia alapú útvonalszínezés
- Hover tooltip: pillanatnyi sebesség és magasság

### Beállítások
- Bejelentkezés (opcionális, config.js-ben kapcsolható)
- Perzisztens beállítások: térképstílus, mértékegység, induló nézet
- Hint tooltipek minden beállítás elemhez

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

A Docker image automatikusan épül a GitHub Actions-szel minden `main` branch-re kerülő pushnál, és elérhető a GitHub Container Registry-ben:

```
ghcr.io/czdanika/bringaterv:latest
```

### Indítás Docker Compose-zal

```bash
docker compose up -d
```

Az alkalmazás elérhető: **http://localhost:8080**

### Manuális indítás

```bash
docker run -d -p 8080:80 ghcr.io/czdanika/bringaterv:latest
```

---

## Portainer telepítés

### Web editor módszer (ajánlott)

1. Portainer → **Stacks** → **Add Stack**
2. Add meg a stack nevét: pl. `bringaterv`
3. Válaszd a **Web editor** fület
4. Illeszd be:

```yaml
services:
  bringaterv:
    image: ghcr.io/czdanika/bringaterv:latest
    ports:
      - "8080:80"
    restart: unless-stopped
```

5. Kattints a **Deploy the stack** gombra

Az alkalmazás elérhető: **http://[szerver-ip]:8080**

### Frissítés új verzióra

Ha új verzió jelent meg (GitHub Actions lefutott):

1. Portainer → **Stacks** → `bringaterv`
2. **Pull and redeploy** gomb

---

## Hogyan működik a CI/CD?

```
git push → GitHub repó
     ↓
GitHub Actions (automatikus build)
     ↓
ghcr.io/czdanika/bringaterv:latest (Docker image)
     ↓
Portainer lehúzza → az app fut a szerveren
```

---

## Projekt struktúra

```
bringaterv/
├── index.html
├── login.html
├── favicon.ico
├── Dockerfile
├── docker-compose.yml
├── CHANGELOG.md
└── src/
    ├── main.js
    ├── styles.css
    ├── config.js
    ├── auth.js
    ├── appSettings.js
    ├── assets/
    ├── i18n/
    ├── state/
    ├── map/
    ├── gpx/
    └── ui/
```

---

## Tervezett fejlesztések

- [ ] Magassági profil grafikon
- [ ] Útvonal mentése / betöltése (localStorage)
- [ ] Megosztható link generálása
- [ ] Mobilbarát nézet és érintéses drag & drop
- [ ] PWA / offline mód

---

## Licenc

MIT License – szabad felhasználás, módosítás és terjesztés.

---

*Készítette: [@czdanika](https://github.com/czdanika) · © Czibolya Dániel 2026*
