# Turistajelzések és jelzéskövetés

Gyalogos módban (Séta, Túra) a Bringaterv a jelzett turistautakra építve is tervez, ahogy egy
turistatérképen: „Mátraházáról a piros sávon fel a Kékesre, onnan a kék háromszögön le
Mátrafüredre”. Ez a leírás a funkciót és a működését mutatja be. A felhasználói leírás az appban
van: Súgó → Tervezés → *Turistajelzések és jelzéskövetés*.

Bevezetve: **v1.30.0** (a turistajelzés-réteg a v1.29.0 óta van).

---

## Mit tud

| Funkció | Hol | Mit csinál |
|---|---|---|
| **Turistajelzések réteg** | térképstílus-választó (jobb felső sarok) | a jelzett utak színes vonallal és jelzésképpel, bármelyik térkép fölött; amíg a felhasználó nem állítja, gyalogos módban magától bekapcsol |
| **Csak jelzett turistaúton** | tervezés ⚙ panel (csak gyalogos módban látszik) | a jelzett utak erős előnyben; csak a be- és kivezetésnél tér le róluk |
| **Jelzés követése a következő pontig** | pont ablaka (asztalon felugró, mobilon pontkártya) | egy adott jelzés (pl. P) a két pont között; a pontlistában a jelzés képe látszik |
| **Jelzések a térkép egy pontján** | jobb gomb (asztalon) / hosszú érintés (telefonon) | az ott futó jelzések listája → kiemelés, „Pont ide, ezen a jelzésen”, „Egész jelzés tervként” (≤ 120 km), „Mutasd egészben” |

Kerékpáros módban a jelzéskövetés nem érhető el: tevékenységváltáskor (gyalog → kerékpár) a
pontokról a követett jelzés lekerül, ahogy a szakaszonkénti mód is. Ha a jobb gombos ablakból
kerékpáros módban kérsz tervezést, az app Túra módra vált.

---

## Adatforrás

A **[Waymarked Trails](https://hiking.waymarkedtrails.org)** az OpenStreetMap túraútvonal-relációit
(`route=hiking`) dolgozza fel. A magyar jelzéseket a `jel` címkéből ismeri: `jel_REG_p` = piros
sáv, `jel_LOC_k3` = kék háromszög, `jel_NAT_k` = Kéktúra. Ugyanez az adat van a
turistautak.openstreetmap.hu mögött is.

| Mire | Végpont |
|---|---|
| Térképréteg | `https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png` |
| Jelzések egy terület körül | `GET /api/v1/list/by_area?bbox=x1,y1,x2,y2&limit=20` (**EPSG:3857**) |
| Egy jelzés adatai + nyomvonala | `GET /api/v1/details/relation/{id}` → `route` fa (`route` → `linear` / `split` → `base` útszakaszok, koordináta EPSG:3857) |
| Jelzéskép | `GET /api/v1/symbols/id/{symbol_id}.svg` |

Az API CORS-engedélyes (`Access-Control-Allow-Origin: *`), ezért a böngésző közvetlenül hívja,
backend nem kell hozzá. Egy hosszú jelzés (Kéktúra) adata kb. 2,2 MB, utána a munkamenetben
gyorsítótárban marad.

---

## Működés

### Jelzés követése (`src/map/trails.js` + `mapAdapter.routeTrailSegment`)

1. A szakasz kezdőpontján tárolva: `waypoint.trail = { id, ref, name, sym }`.
2. `trailPath(id)`: a reláció fáját (`flatten`) összefüggő vonalakká fűzi (`joinWays`, 5 m-es
   illesztés). Ahol a relációban szakadás van, ott új darab kezdődik.
3. `trailSection(id, from, to)`: mindkét pontot a legközelebbi töréspontra illeszti (legfeljebb
   `ON_TRAIL_M` = 150 m), és kivágja a kettő közti részt, a haladási irányban.
4. `sampleVias`: kb. 300 m-enként segédpont, legfeljebb 80 darab. Ezen át a BRouter tervez
   (`hiking-mountain`, a jelzett út erős előnyével), így magasság-, burkolat- és
   jelzésadat is jön, és a geometria a jelzésen marad. Próba: a piros sáv 7,7 km-es szakasza
   7,68 km lett.
5. Ha a pontok nincsenek a jelzésen, vagy hiba van, a szakasz a tervezési mód szerint tervez
   (nincs kiesés).

A pontablakban csak azok a jelzések jelennek meg, amelyek a ponton **és** a következő ponton is
átmennek (`trailsNear`, 100 m-es környezet). A már kiválasztott jelzés akkor is látszik, ha a
pontot közben elhúzták róla.

### Csak jelzett turistaúton

A gyalogos profil `profile:hiking_routes_preference` paramétere 1,5 helyett 5 (`MARKED_ONLY` a
`mapAdapter.js`-ben). Ennél nagyobb értéknél a BRouter már nem tér el. Mérések:

| Útvonal | 1,5 | 5 |
|---|---|---|
| Hűvösvölgy → János-hegy | 96% jelzett | 96% |
| Mátra, 14 km | 87% | 91% |

A maradék jellemzően a rajthoz és a célhoz vezető bekötés. Egy adott jelzés követésére a
„Jelzés követése” való.

### Mentés

- **GPX:** `<wpt><extensions><bringaterv:trail>{json}</bringaterv:trail></extensions>` (a
  `segmentMode` mellett). Visszatöltéskor a jelzéskövetés is visszajön.
- **Piszkozat** (`bringaterv.planDraft`) és **útvonal-aláírás** (`routeSignatureOf`): a `trail`
  és a `markedOnly` is benne van, így ezek változása újratervezést indít.
- **Beállítás:** `bringaterv.markedOnly` (localStorage), `bringaterv.hikingOverlay` (a réteg;
  ha nincs megadva, a mód dönt).

---

## Fájlok

| Fájl | Tartalom |
|---|---|
| `src/map/trails.js` | API-hívások, nyomvonal-fűzés, szakasz-kivágás, segédpontok, illesztés |
| `src/map/mapAdapter.js` | `routeTrailSegment`, `MARKED_ONLY` profil, pontablak „Jelzés követése”, réteg, kiemelés, jobb gombos ablak |
| `src/ui/trailInfo.js` | jobb gomb / hosszú érintés ablak, „Pont ide”, „Egész jelzés tervként” |
| `src/ui/planning.js` | jelzéskép a pontlistában; tevékenységváltáskor a jelzés törlése |
| `src/state/routeStore.js` | a `trail` mező megőrzése (hozzáadás, beszúrás, csere) |
| `src/gpx/gpx.js` | `bringaterv:trail` export / import |
| `help.html` | felhasználói leírás (`#turistajelzesek`) |

---

## Korlátok, hibakeresés

- **„Nem jelenik meg a jelzés a pontnál”:** a pontnak kb. 100 m-en belül kell lennie a jelzett
  úttól, és a következő pontnak is ugyanazon a jelzésen kell lennie. Húzd a pontot a vonalra,
  vagy használd a jobb gombos „Pont ide, ezen a jelzésen”-t.
- **Hiányzó vagy hibás jelzés:** az OpenStreetMap adatán múlik. Javítás az OSM-ben (a
  túraútvonal-reláció), a Waymarked Trails néhány napon belül frissül.
- **Körbejáró jelzés** (a jelzés önmagába tér vissza): a szakaszkivágás a legközelebbi
  töréspontok közti rövidebb utat nem keresi, hanem a vonal sorrendjében vág. Ilyenkor tegyél
  közbenső pontot.
- **Elágazó jelzés** (`split`, külön oda- és visszairány): csak az előre („forward”) ágat
  használjuk.
- **Egész jelzés tervként:** 120 km-ig (`WHOLE_MAX_KM` a `trailInfo.js`-ben). A hosszabb
  jelzéseknél (Kéktúra) pontonként kell tervezni.
- **Ha a Waymarked Trails nem érhető el:** a réteg csempéi nem töltenek be, a jelzéslisták üresek,
  a jelzéskövető szakaszok sima tervezéssel készülnek. Az app többi része működik.
