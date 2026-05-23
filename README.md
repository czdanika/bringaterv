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
- 4 tervezési mód: Aszfalt, Gravel, MTB, Túra (gyalogos)
- Útra illesztés BRouter segítségével – ha nem elérhető, egyenes vonalként jelenik meg
- Vegyes mód: szakaszonként eltérő tervezési mód egy útvonalon belül
- 7 térképstílus: Standard, Kerékpáros, Műholdas, Hybrid, Domborzat, Világos, Sötét
- Sötét és világos téma, automatikus rendszerfelismeréssel
- Waypoint közbeszúrás útvonalra kattintással
- Visszaút és oda-vissza tervezés

### Útvonalpontok kezelése
- Automatikus helynévadás Nominatim reverse geocoding alapján
- Drag and drop átrendezés
- Popup szerkesztő: pont neve, megjegyzés, törlés
- Az utolsó pont mindig célállomásként jelenik meg (sakk-tábla zászló)
- Marker húzás a térképen – cím automatikusan frissül

### GPX és FIT elemzés
- GPX és FIT (Garmin / Wahoo / Bryton / Hammerhead) fájlok importálása
- Drag and drop bárhonnan a böngészőablakba
- Importált GPX-ből automatikusan kiszámított emelkedő és ereszkedő
- Sebesség, pulzus, kadencia és teljesítmény alapú útvonalszínezés
- Szintprofil, sebesség, pulzus, kadencia és teljesítmény diagramok
- Lejtőtérkép (vörös az emelkedő, zöld a süllyedés)
- Hover tooltip: pillanatnyi sebesség és magasság

### Testreszabható zónák
- Sebesség, kadencia, teljesítmény zónák multi-sliderrel állíthatók (7 fogópont, 8 zóna)
- Pulzuszónák négy módszerrel: Karvonen, Max HR százalék, LTHR, vagy Egyedi BPM határok
- Max HR automatikus számítása Tanaka / Miller / klasszikus 220-kor képlettel, vagy egyedi érték
- Zónamodell: Friel (aszimmetrikus, Garmin / Strava / TrainingPeaks kompatibilis) vagy egyenlő sávok
- Egyenlő felosztás gomb minden zónaslideren a gyors reseteléshez
- Élő frissítés: drag közben a térkép és a jelmagyarázat azonnal újraszíneződik

### Diagram színek
- Két mód: egyszínű (minden diagramhoz külön szín választható) vagy zónaszín (a vonal szegmensenként a határértékek színeivel rajzolódik)
- 5 diagram konfigurálható: szintprofil, sebesség, pulzus, kadencia, teljesítmény

### Útvonalkönyvtár
- Mentett útvonalak – tervezett útvonalak elmenthetők a szerverre, szerkeszthetők és visszatölthetők
- Edzések – elemzett GPX fájlok eredeti adatokkal menthetők, és FIT eredetű importálásnál az eredeti FIT bináris is megőrződik a könyvtárban
- Minták – beépített minta útvonalak (Balatoni kör 204 km, Tisza-tó kör 90 km)
- Kártyákon statisztikák: távolság, időtartam, emelkedő, FIT címke ha elérhető
- GPX és (ha van) FIT letöltés könyvtárból

### Multi-user és admin panel
- JWT autentikáció, per-user adatok és beállítások
- Admin panel felhasználókezelése: létrehozás, szerkesztés, jelszó-reset, kvóták, aktiválás / tiltás
- Útvonalak adminisztrálása: GPX vagy FIT letöltés, metaadatok inline szerkesztése, törlés, feltöltés admin részéről
- Per-user beállítások JSON fájlban: `/data/users/<uid>/settings.json` (HR zónák, adatzónák, diagram színek, térképstílus, téma)
- Minta útvonalak webes admin kezelése: feltöltés, szerkesztés, törlés a "Minta útvonalak" panelből; GPX előelemzés (távolság, emelkedő, Overpass útburkolat-szegmensek) feltöltéskor
- Bejelentkezés kikapcsolható (`LOGIN_ENABLED=false` szerveren belüli LAN használatra)

### Szélelemzés
- Open-Meteo alapú szél- és időjárás-elemzés a tervezett útvonalra (7 napos órás bontású előrejelzés, kulcs nélküli ingyenes API)
- Szegmensenkénti hátszél / oldalszél / szembeszél dekompozíció + statisztika (százalék, km, átlagok)
- Térképszínezés szélirány szerint, kölcsönösen kizáró a szintprofil-térképszínezéssel
- Indulási idő picker (max +7 nap), átlagsebesség alapján szegmens-érkezési időre kéri le a szelet
- Szélhatás az időbecsléshez: kerékpáros profilból (tömeg, CdA, Crr) számolt teljesítmény + Newton-iteráció szegmensenként

### Kerékpáros profil
- Beállítások: kerékpáros és kerékpár tömege, vezetési pozíció (CdA 0.32–0.65)
- Per-user mentés, használja a szélhatás-számítás

### Waypoint szakaszhosszok és km-jelölők
- Tervezésnél a sidebar waypoint listán megjelennek a szakaszonkénti távolságok
- Térképen minden 5 kilométernél kis jelölő a km-számmal
- Beállításokból kapcsolható útirány-nyilak (▲) a route mentén ~1.5 km-enként – hurkos pályánál segít látni a haladási irányt

### Backup és visszaállítás
- Teljes profil (beállítások + útvonalak + edzések) ZIP archívumba menthető a Beállítások panelből
- Visszaállítás két módban: **Hozzáadás** (új ID-kkel a meglévők mellé) vagy **Teljes felülírás** (eredeti ID-kkel, törli az aktuális adatokat)
- Admin felületről bármely felhasználó profilja menthető és visszaállítható

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
                    routes-data volume (/data)
                    ├── bringaterv.db   ← SQLite (felhasználók, munkamenetek)
                    └── users/          ← per-user GPX könyvtárak
```

Két Docker konténer fut:
| Konténer | Kép | Feladat |
|---|---|---|
| `bringaterv` | `ghcr.io/czdanika/bringaterv:latest` | nginx – statikus frontend |
| `routes-api` | `ghcr.io/czdanika/bringaterv-api:latest` | Flask REST API – JWT auth, per-user GPX tárolás |

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
    depends_on:
      - routes-api
    networks:
      - bringaterv-net
    restart: unless-stopped

  routes-api:
    image: ghcr.io/czdanika/bringaterv-api:latest
    environment:
      SAMPLES_DIR:     /samples
      DB_PATH:         /data/bringaterv.db
      MULTI_DATA_DIR:  /data/users
      ADMIN_EMAIL:     bringa           # ← admin belépési email/felhasználónév
      ADMIN_PASSWORD:  terv             # ← admin jelszó (változtasd meg!)
      JWT_SECRET:      valtozd_meg      # ← kötelező megváltoztatni élesben!
    volumes:
      - routes-data:/data
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

| Változó | Konténer | Leírás | Alapértelmezett |
|---|---|---|---|
| `LOGIN_ENABLED` | bringaterv | Bejelentkezés be/ki | `true` |
| `ADMIN_EMAIL` | routes-api | Admin felhasználónév / email | `bringa` |
| `ADMIN_PASSWORD` | routes-api | Admin jelszó | `terv` |
| `JWT_SECRET` | routes-api | JWT aláíró kulcs – **élesben kötelező megváltoztatni!** | `change-me-please` |
| `JWT_EXPIRY_DAYS` | routes-api | Token élettartama napban | `30` |

### 3. Frissítés új verzióra

Ha új verzió jelent meg (GitHub Actions lefutott):

1. Portainer → **Stacks** → `bringaterv`
2. Kattints a **Pull and redeploy** gombra

> **Figyelem:** A `routes-data` volume megmarad frissítéskor – a mentett útvonalak, edzések és felhasználói adatok nem vesznek el.

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

## Linux / Raspberry Pi telepítés

Bármilyen Linux gépen (Ubuntu, Debian, Raspberry Pi OS) működik, ahol fut a Docker.

### 1. Docker telepítése (ha még nincs)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

### 2. Bringaterv telepítése

```bash
mkdir -p ~/bringaterv
cd ~/bringaterv

curl -o docker-compose.yml \
  "https://raw.githubusercontent.com/czdanika/bringaterv/main/docker-compose-nas.yml"

docker compose pull
docker compose up -d
```

Az alkalmazás elérhető: **http://[eszköz-ip]:8088**

> Raspberry Pi-n az IP-cím lekérdezése: `hostname -I`

### 3. Környezeti változók (opcionális)

A letöltött `docker-compose.yml` tartalma — itt módosítható a jelszó és a port:

```yaml
services:
  bringaterv:
    image: ghcr.io/czdanika/bringaterv:latest
    ports:
      - "8088:80"       # bal oldal: külső port (ezt változtasd, ha kell)
    environment:
      LOGIN_ENABLED: true
    depends_on:
      - routes-api
    networks:
      - bringaterv-net
    restart: unless-stopped

  routes-api:
    image: ghcr.io/czdanika/bringaterv-api:latest
    environment:
      SAMPLES_DIR:    /samples
      DB_PATH:        /data/bringaterv.db
      MULTI_DATA_DIR: /data/users
      ADMIN_EMAIL:    bringa            # ← admin felhasználónév
      ADMIN_PASSWORD: terv              # ← ezt érdemes megváltoztatni!
      JWT_SECRET:     valtozd_meg       # ← kötelező megváltoztatni élesben!
    volumes:
      - routes-data:/data
    networks:
      - bringaterv-net
    restart: unless-stopped

volumes:
  routes-data:

networks:
  bringaterv-net:
    driver: bridge
```

### 4. Automatikus indítás (rendszerindításkor)

A `restart: unless-stopped` alapból be van kapcsolva a compose fájlban, így újraindítás után automatikusan elindul.

Ellenőrzés:
```bash
docker compose ps
```

### 5. Frissítés

```bash
cd ~/bringaterv
docker compose pull
docker compose up -d
```

> **Adatok megmaradnak** – a `routes-data` Docker volume frissítéskor nem törlődik.

---

## Helyi fejlesztés

```bash
git clone https://github.com/czdanika/bringaterv.git
cd bringaterv
docker compose up -d --build
```

Az alkalmazás elérhető: **http://localhost:8088**

---

## Licenc

MIT License – szabad felhasználás, módosítás és terjesztés.

---

*Készítette: [@czdanika](https://github.com/czdanika) · © Czibolya Dániel 2026*
