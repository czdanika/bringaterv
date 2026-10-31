# Saját BRouter útvonaltervező

A Bringaterv a kézi tervezést és az útvonal-javaslatot a [BRouter](https://github.com/abrensch/brouter)
útvonaltervezővel számolja. Ez a leírás a **saját, a stackben futó BRouter-szervert** írja le:
miért van, hogyan épül fel, hogyan kell telepíteni és üzemeltetni.

---

## Miért saját szerver?

| | Nyilvános brouter.de | Saját szerver |
|---|---|---|
| Terhelési korlát | van – sok kérésnél „Please, retry later” | nincs |
| Útvonal-javaslat | 13–16 tervezés / javaslatkör, korlát miatt ennyi fér bele | több változat is kipróbálható |
| Saját tervezési profilok | nem lehet | lehet (`brouter/profiles/`) |
| Adatvédelem | a tervezett pontok külső szerverre mennek | a pontok a saját szerveren maradnak |
| Elérhetőség | külső szolgáltatás | saját; ha nem fut, automatikusan a brouter.de tervez |

A brouter.de tartalékként megmarad: ha a saját szerver nem érhető el, vagy a túra kilóg a
letöltött térképadatból, a böngésző automatikusan oda fordul. Kiesés tehát nincs.

---

## Felépítés

```
Böngésző ──► /brouter?lonlats=…&profile=…      (ugyanaz a domain, a frontend nginx-e)
                 │
                 ▼  nginx: location = /brouter (csak GET, IP-nként 20 kérés/s, burst 60)
           brouter konténer (belső hálózat, port 17777, kívülről nem látszik)
             ├─ BRouter szerver (Java, btools.server.RouteServer)
             ├─ /data/segments4/*.rd5   térképadat-csempék (kötet: brouter-data)
             ├─ /opt/brouter/profiles2  gyári + saját profilok
             └─ /data/status.json       állapot az admin felületnek

routes-api ──► /brouter (ugyanaz a kötet) → admin állapot és „frissítés most”
           ──► http://brouter:17777      → próbatervezés (él-e a szerver)
```

### Kliens oldali tartalék (`src/map/mapAdapter.js` → `brouterFetch`)

1. Először a saját szervert hívja (`/brouter?…`).
2. Ha a válasz **502 / 503 / 504 / 404** (nincs vagy épp indul a konténer, régi konfig), vagy hálózati
   hiba van: a nyilvános brouter.de-t hívja, és **10 percig** egyből azt (ne várjon minden kérés a hibára).
3. Egyéb hiba (pl. a túra kilóg a csempékből): csak az adott kérés megy a brouter.de-re.

### nginx (`nginx.conf`)

- `location = /brouter` – **csak GET** (`limit_except`), a BRouter többi végpontja (pl. profilfeltöltés)
  kívülről nem érhető el.
- A célt változón át (`resolver 127.0.0.11`) adjuk meg, így az nginx **akkor is elindul, ha nincs
  brouter konténer** (ilyenkor 502 → a kliens a brouter.de-re vált). Ezért a frontend frissíthető
  a stack módosítása előtt is.
- Terheléskorlát: `limit_req zone=brouter` – IP-nként 20 kérés/s, 60-as löket. Ha a NAS előtt
  proxy / Cloudflare-alagút áll, minden kérés ugyanarról az IP-ről jöhet – ilyenkor a korlát
  az összes felhasználóra együtt érvényes (egy javaslatkör ~16 kérés, ez bőven belefér).

---

## Fájlok

| Fájl | Szerep |
|---|---|
| `brouter/Dockerfile` | `eclipse-temurin:21-jre` + a BRouter kiadás (`BROUTER_VERSION`, most 1.7.10) |
| `brouter/entrypoint.sh` | csempék letöltése / heti frissítése, szerver indítása és felügyelete, `status.json` |
| `brouter/profiles/` | saját profilok (`bringaterv-*.brf`), a build a gyáriak mellé másolja |
| `nginx.conf` | `/brouter` továbbítás, terheléskorlát |
| `src/map/mapAdapter.js` | `brouterFetch` – saját szerver, tartalékként brouter.de |
| `routes-api/brouter_admin.py` | `GET/POST /api/admin/brouter` – állapot, próbatervezés, frissítés kérése |
| `admin.html` | Közösségi útvonalak fül → „Saját útvonaltervező (BRouter)” panel |
| `docker-compose.yml` | helyi / Pi: `brouter` szolgáltatás buildből |
| `docker-compose-nas.yml` | éles stack: `ghcr.io/czdanika/bringaterv-brouter:latest` |
| `.github/workflows/docker-publish.yml` | `build-brouter` job – a CI a harmadik képet is buildeli |

### Környezeti változók (brouter konténer)

| Változó | Alap | Leírás |
|---|---|---|
| `TILES` | `E15_N45 E20_N45` | letöltendő 5°×5°-os csempék (bal alsó sarok szerint) |
| `JAVA_MEM` | `1g` | a Java memóriakerete (`-Xmx`) |
| `THREADS` | `8` | párhuzamos tervezések száma |
| `UPDATE_DAYS` | `7` | ennyi naponta ellenőrzi a csempék frissességét |
| `SEGMENTS_URL` | `https://brouter.de/brouter/segments4` | a csempék forrása |
| `BROUTER_VERSION` | `1.7.10` | build-argumentum (`--build-arg`) |

routes-api oldalon: `BROUTER_DATA` (alap `/brouter`), `BROUTER_URL` (alap `http://brouter:17777`).

### Csempék

Magyarország két csempére esik (a név a csempe bal alsó sarka):

| Csempe | Terület | Méret (2026. okt.) |
|---|---|---|
| `E15_N45` | K 15–20°, É 45–50°: Dunántúl, Budapest, Kelet-Ausztria (Bécs), Szlovénia és Észak-Horvátország, Nyugat-Szlovákia | ~124 MB |
| `E20_N45` | K 20–25°, É 45–50°: Tiszántúl, Kelet-Szlovákia, Nyugat-Erdély | ~64 MB |

Más terület hozzáadása: a `TILES` bővítése (pl. `E10_N45` → Ausztria nyugati része, Észak-Olaszország).
A csempék listája: <https://brouter.de/brouter/segments4/>.

---

## Telepítés

### Pi (teszt)

A Pi `docker-compose.yml`-je helyi változat (saját alapértékekkel), ezért nem a repóból
másoljuk: a `brouter` szolgáltatást, a `brouter-data` kötetet és a routes-api
`- brouter-data:/brouter` csatolását kell beleírni (a repó `docker-compose.yml`-jével azonos módon).
Biztonsági másolat: `docker-compose.yml.bak-brouter`.

```bash
rsync … brouter/ nginx.conf routes-api/brouter_admin.py …
docker-compose up -d --build --force-recreate
```

### NAS (éles, Portainer stack)

Egyszeri teendő: a stack szerkesztőjében (Portainer → Stacks → bringaterv → Editor)

1. a **routes-api** szolgáltatás `volumes:` listájába:

   ```yaml
         - brouter-data:/brouter   # a BRouter állapota / frissítés kérése (admin)
   ```

2. új szolgáltatás a `services:` alá (a routes-api után):

   ```yaml
     brouter:
       image: ghcr.io/czdanika/bringaterv-brouter:latest
       environment:
         JAVA_MEM: 2g
         TILES: "E15_N45 E20_N45"
       volumes:
         - brouter-data:/data
       networks:
         - bringaterv-net
       restart: unless-stopped
   ```

3. a `volumes:` (legfelső szint) alá:

   ```yaml
     brouter-data:
   ```

4. **Update the stack** (a „Re-pull image” bepipálva).

Első induláskor a konténer letölti a csempéket (~190 MB, pár perc) – addig a tervezés a
brouter.de-n megy. Ellenőrzés: admin → Közösségi útvonalak → „Saját útvonaltervező (BRouter)”:
„Működik (… ms)”.

Később a frissítés változatlan: **Pull and redeploy** – mindhárom kép együtt frissül.

---

## Üzemeltetés

- **Csempefrissítés:** `UPDATE_DAYS` naponta feltételes letöltés (`If-Modified-Since`): ha nincs
  újabb, nem tölt le semmit. Ha valamelyik csempe frissült, a szerver újraindul (pár másodperc;
  közben a kliens a brouter.de-re vált). Az új csempe ideiglenes fájlba jön, a régi addig használható.
- **Frissítés most:** az admin panel „Térképadat frissítése” gombja egy `update.request` fájlt ír a
  kötetbe, a konténer percenként figyeli.
- **Felügyelet:** ha a Java-folyamat leáll (pl. memóriahiány), az entrypoint újraindítja.
- **Mentés:** a `brouter-data` kötetet nem kell menteni – a csempék bármikor újra letölthetők.
- **Naplók:** `docker compose logs brouter` – minden kérés látszik (ms, IP, lekérdezés).

### Mért teljesítmény

| Gép | Budapest → Szentendre (30 km) | Rövid (3 km) |
|---|---|---|
| Raspberry Pi 4 (4 GB) | ~4,4 s | ~0,8 s |
| brouter.de | ~1 s | – |
| NAS (i5, 12 mag, 24 GB) | várhatóan < 1 s | – |

Az eredmény azonos a brouter.de-vel (ugyanaz a program és ugyanazok a csempék): a 30 km-es
próbán 30 004 m és 410 m szint mindkettőn.

### Erőforrás

| | Igény |
|---|---|
| RAM | 1–2 GB (`JAVA_MEM`) |
| Lemez | ~0,4 GB (kép + csempék) |
| CPU | kérésenként rövid csúcs |

---

## Hibaelhárítás

| Tünet | Ok / teendő |
|---|---|
| Admin panel: „Nincs a stackben” | a routes-api nem látja a `brouter-data` kötetet és a szervert sem éri el – a stack 1–3. lépése hiányzik |
| „Nem válaszol”, a csempék rendben | a konténer indul vagy újraindul – `docker compose logs brouter` |
| Letöltési hiba a panelen | a brouter.de csempeszervere nem érhető el; a régi csempe marad, a következő ellenőrzés újrapróbálja |
| A tervezés lassú | `JAVA_MEM` növelése, `THREADS` a magok számához igazítva |
| Határon túli túra a brouter.de-n tervez | a terület nincs a `TILES` között – bővíthető |

Visszaállás: a `brouter` szolgáltatás törlése a stackből – a kliens 502-t kap, és a brouter.de tervez.

---

## Saját profilok

A profil egy szöveges szabályfájl (`.brf`), ami megmondja, mennyibe „kerül” egy úttípus,
burkolat, emelkedő vagy kanyar. A gyári profilok a `profiles2/` mappában vannak
(`fastbike`, `fastbike-lowtraffic`, `safety`, `trekking`, `gravel`, `mtb` …); a sajátok a
`brouter/profiles/bringaterv-*.brf`, a build a gyáriak mellé másolja őket.

Mindhárom a gyári `fastbike.brf`-ből készült, a módosított sorok mellett `# Bringaterv:` megjegyzés áll,
és mindháromban be van kapcsolva a `correctMisplacedViaPoints` (a segédpontoknál nincs oda-vissza „tüske”).

| Profil | Mire | Változtatás a fastbike-hoz képest |
|---|---|---|
| `bringaterv-csendes` | aszfalt, kevés forgalom | `consider_traffic` 0,1 → 1,0; főút (primary) 1,2 → 2,5, másodrendű 1,1 → 1,8, harmadrendű 1,0 → 1,15; kerékpárút 1,3 → 1,0 |
| `bringaterv-sik` | kevés emelkedő | a csendes profil + `uphillcost` 0 → 70, `uphillcutoff` 1,5 → 2,0 |
| `bringaterv-kerekparut` | kerékpárút előnyben | `consider_traffic` 1,0; kerékpárút / kijelölt kerékpáros út / kerékpáros útvonal 1×, kerékpársávos út 1,25×, minden más 1,6× |

### Mérések (a saját szerveren, Pi)

Budapest (Lánchíd) → Szentendre, egyirányú:

| Profil | Táv | Szint | Főút | Burkolatlan | Kerékpárút |
|---|---|---|---|---|---|
| fastbike | 30,0 km | 410 m | 53% | 9% | 42% |
| safety | 34,1 km | 369 m | 1% | 21% | 57% |
| fastbike-lowtraffic | 30,1 km | 478 m | 21% | 12% | 35% |
| **bringaterv-csendes** | 33,9 km | 341 m | **9%** | 11% | **62%** |

Római part → Szentendre: fastbike 91% főút, bringaterv-csendes 2% (14,0 → 15,0 km).

A `bringaterv-sik` csak ott tud segíteni, ahol van síkabb alternatíva (pl. Budapest → Budakeszi
vagy a Pilis felé nincs – ott minden profil ugyanannyi szintet ad); az útvonal-javaslatnál,
ahol a segédpontok között több út közül választhat, érezhetően számít.

### Hol használjuk

Az útvonal-javaslat aszfaltos kérésnél (`src/map/routeSuggest.js`):

- „Kerékpárút előnyben” → `bringaterv-kerekparut`
- „Sík” szint → `bringaterv-sik`
- „Főutak kerülése” → `bringaterv-csendes`

Ha a kérés a nyilvános brouter.de-re kerül (a saját szerver nem érhető el), a saját profil helyett a
gyári `fastbike-lowtraffic` megy (`PUBLIC_PROFILE` a `mapAdapter.js`-ben).

### Sűrűbb mintavétel

Ha a saját szerver az elmúlt 10 percben válaszolt (`localBrouterOk()`; a javaslat panel megnyitásakor
egy olcsó próbahívás frissíti), a javaslat több változatot próbál ki: körnél 12 irány (8 helyett),
megadott iránynál ±60° 15°-onként, A → B-nél oldalanként 3 kitérő-mélység; 4 párhuzamos tervezéssel.
Egy javaslatkör így ~23–24 tervezés (a nyilvános szerveren 13–17).

### Új profil készítése

1. A gyári profilt másold `brouter/profiles/bringaterv-<név>.brf` néven, a módosított sorokhoz `# Bringaterv:` megjegyzés.
2. Próba a futó konténerben újraépítés nélkül:
   `docker cp bringaterv-<név>.brf <brouter-konténer>:/opt/brouter/profiles2/`, majd
   `/brouter?lonlats=…&profile=bringaterv-<név>&format=geojson`.
3. A `PUBLIC_PROFILE` táblába a nyilvános megfelelője.

A gyári profilok paraméterei (`%név%` megjegyzésű `assign` sorok) URL-ben is átadhatók, pl.
`&profile:consider_traffic=1` – egy próbához nem kell új fájl.

## Licenc és forrásmegjelölés

- BRouter: MIT licenc – <https://github.com/abrensch/brouter>
- Térképadat: © OpenStreetMap közreműködők, ODbL – a térképen a forrásmegjelölés már szerepel.
