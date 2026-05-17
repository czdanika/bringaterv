# Bringaterv

![Bringaterv](src/assets/banner.jpg)

**Nyílt forráskódú GPX útvonaltervező és edzésnapló kerékpárosoknak és gyalogosoknak.**
Böngészőben fut, Docker Compose-zal telepíthető – tervezés, elemzés és könyvtár egy helyen.

![Elemzés – egymás alatti diagramok](https://github.com/czdanika/bringaterv/releases/download/v0.11/screen1_small.png)

![Tervezés – útvonaltervező](https://github.com/czdanika/bringaterv/releases/download/v0.11/screen2_small.png)

---

## Funkciók

### Térképes tervezés
- Kattintással pontokat helyezhetsz el a térképen
- Kerékpáros és gyalogos tervezési mód
- Útra illesztés BRouter segítségével – ha nem elérhető, egyenes vonalként jelenik meg
- 7 térképstílus: Standard, Kerékpáros, Műholdas, Hybrid, Domborzat, Világos, Sötét
- Sötét és világos téma, automatikus rendszerfelismeréssel
- Waypoint közbeszúrás útvonalra kattintással
- Visszaút és oda-vissza tervezés

### Útvonalpontok kezelése
- Automatikus helynévadás Nominatim reverse geocoding alapján
- Drag & drop átrendezés
- Popup szerkesztő: pont neve, megjegyzés, törlés
- Az utolsó pont mindig célállomásként jelenik meg (sakk-tábla zászló)
- Marker húzás a térképen – cím automatikusan frissül

### GPX elemzés
- Importált GPX-ből automatikusan kiszámított emelkedő (↑) és ereszkedő (↓)
- Sebesség, pulzus és kadencia alapú útvonalszínezés
- Szintprofil, sebességdiagram, pulzusdiagram
- Lejtőtérkép (piros = emelkedő, zöld = süllyedő)
- Hover tooltip: pillanatnyi sebesség és magasság

### Útvonalkönyvtár
- **Mentett útvonalak** – tervezett útvonalak elmenthetők a szerverre, szerkeszthetők és visszatölthetők
- **Edzések** – elemzett GPX fájlok (eredeti adatokkal) menthetők és visszatölthetők az Elemzés fülre
- **Minták** – beépített minta útvonalak (Balatoni kör 204 km, Tisza-tó kör 90 km)
- Kártyákon statisztikák: távolság, időtartam, emelkedő
- GPX letöltés könyvtárból

### Beállítások
- Bejelentkezés (opcionális, config.js-ben kapcsolható)
- Perzisztens beállítások: térképstílus, mértékegység, induló nézet
- Hint tooltipek minden beállítás elemhez

---

## Architektúra

```
Böngésző
    │
    ├── / (statikus frontend)
    │       nginx konténer
    │
    └── /api/ (REST API proxy)
            nginx → routes-api konténer (Flask)
                         │
                    routes-data volume
                    (GPX fájlok, index.json)
```

Két Docker konténer fut:
| Konténer | Kép | Feladat |
|---|---|---|
| `bringaterv` | `ghcr.io/czdanika/bringaterv:latest` | nginx – statikus frontend |
| `routes-api` | `ghcr.io/czdanika/bringaterv-api:latest` | Flask REST API – GPX tárolás |

A `routes-api` konténer kívülről **nem érhető el** – csak az nginx-en keresztül, belső hálózaton kommunikál.

---

## Portainer telepítés (ajánlott)

### 1. Stack létrehozása

1. Portainer → **Stacks** → **Add Stack**
2. Stack neve: `bringaterv`
3. Válaszd a **Web editor** fület
4. Illeszd be az alábbi konfigurációt:

```yaml
services:
  bringaterv:
    image: ghcr.io/czdanika/bringaterv:latest
    ports:
      - "8088:80"
    environment:
      LOGIN_ENABLED: true
      LOGIN_USER: bringa
      LOGIN_PASSWORD: terv
    depends_on:
      - routes-api
    networks:
      - bringaterv-net
    restart: unless-stopped

  routes-api:
    image: ghcr.io/czdanika/bringaterv-api:latest
    environment:
      DATA_DIR:    /data/routes
      SAMPLES_DIR: /samples
    volumes:
      - routes-data:/data/routes
    networks:
      - bringaterv-net
    restart: unless-stopped

volumes:
  routes-data:

networks:
  bringaterv-net:
    driver: bridge
```

5. Kattints a **Deploy the stack** gombra

Az alkalmazás elérhető: **http://[szerver-ip]:8088**

### 2. Környezeti változók

| Változó | Leírás | Alapértelmezett |
|---|---|---|
| `LOGIN_ENABLED` | Bejelentkezés be/ki | `true` |
| `LOGIN_USER` | Felhasználónév | `bringa` |
| `LOGIN_PASSWORD` | Jelszó | `terv` |

### 3. Frissítés új verzióra

Ha új verzió jelent meg (GitHub Actions lefutott):

1. Portainer → **Stacks** → `bringaterv`
2. Kattints a **Pull and redeploy** gombra

> **Figyelem:** A `routes-data` volume megmarad frissítéskor – a mentett útvonalak és edzések nem vesznek el.

---

## NAS / parancssoros telepítés

Ha nincs Portainer, a NAS-on SSH-n keresztül:

```bash
# 1. Mappát létrehozni
mkdir -p /volume1/docker/bringaterv
cd /volume1/docker/bringaterv

# 2. docker-compose.yml letöltése a GitHub-ról
curl -o docker-compose.yml \
  "https://raw.githubusercontent.com/czdanika/bringaterv/main/docker-compose-nas.yml"

# 3. Indítás (a volume és hálózat automatikusan létrejön)
docker compose pull
docker compose up -d
```

### Frissítés

```bash
cd /volume1/docker/bringaterv
docker compose pull
docker compose up -d
```

---

## Helyi fejlesztés

```bash
git clone https://github.com/czdanika/bringaterv.git
cd bringaterv
docker compose up -d --build
```

Az alkalmazás elérhető: **http://localhost:8088**

---

## CI/CD folyamat

```
git push → GitHub repó
     ↓
GitHub Actions (automatikus build)
     ├── ghcr.io/czdanika/bringaterv:latest     (nginx frontend)
     └── ghcr.io/czdanika/bringaterv-api:latest (Flask API)
          ↓
Portainer Pull and redeploy → mindkét konténer frissül
```

---

## Projekt struktúra

```
bringaterv/
├── index.html
├── login.html
├── favicon.ico
├── Dockerfile               ← frontend (nginx)
├── docker-compose.yml       ← fejlesztés / Pi teszt
├── nginx.conf
├── CHANGELOG.md
├── routes-api/              ← Flask REST API
│   ├── Dockerfile
│   ├── app.py
│   ├── requirements.txt
│   └── samples/             ← beépített minta GPX-ek
│       ├── balatoni-kor.gpx
│       ├── balatoni-kor.json
│       ├── tisza-to-kor.gpx
│       └── tisza-to-kor.json
└── src/
    ├── main.js
    ├── styles.css
    ├── config.js
    ├── auth.js
    ├── appSettings.js
    ├── api/
    │   └── routesApi.js     ← API kliens
    ├── assets/
    ├── i18n/
    ├── state/
    ├── map/
    ├── gpx/
    └── ui/
```

---

## Licenc

MIT License – szabad felhasználás, módosítás és terjesztés.

---

*Készítette: [@czdanika](https://github.com/czdanika) · © Czibolya Dániel 2026*
