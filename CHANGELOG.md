# Changelog

## v1.40.0 – 2026-11-09 – iGPSport, köztes pontok elrejtése

### Verzió

- **iGPSport kapcsolat (új):** Beállítások → iGPSport (e-mail + jelszó, a jelszót nem tároljuk; a belépés 7 napig érvényes, lejárat előtt push). Könyvtár → Import → iGPSportból: edzéslista dedup-jelzéssel, import az eredeti FIT-tel (az iGPSport kínai idő szerinti indulási idejét a FIT UTC-idejével váltjuk ki), automatikus import, törlés → tiltólista. Útvonal küldése: Tervező → Mentés → „Küldés iGPSportra” és a könyvtár ⋯ menüje – privát útvonalként, típussal és kör / A→B formával. Forrás-szűrő, ismétlődés-kezelés, kalória-forrás is ismeri. Nem hivatalos API (`igpsport_service.py`, `api_igpsport.py`, `igpsport_sync.py`, `src/ui/igpsport.js`).
- **Tervező – köztes pontok elrejtése:** sok útpontnál a jelölők eltakarták a térképet és a színezést. Új gomb a térkép jobb felső sarkában (legalább 3 pontnál) és a Tervező ⋯ menüjében: a köztes pontok eltűnnek, a rajt, a cél és az útvonal (színezéssel, km-jelekkel) marad; a beállítást a böngésző megjegyzi.
- **Mi ez? oldal:** iGPSport a leírásban és saját kártyával a kapcsolatok között; a telefonos képek újra iPhone-arányúak (780×1688) – a nyitókép telefonja zömök volt, mert a fotózó a böngészősáv nélküli, 3×-os iPhone-profilt használta (`tools/demo/shoot.py` javítva).

## v1.39.0 – 2026-11-09 – Ismétlődő edzések, admin nyomvonal-szerkesztés

### Verzió

- **Ismétlődő edzések:** a Könyvtárban új „Ismétlődések” gomb (gépen és mobilon is) – kilistázza az ugyanabból az edzésből több forrásból bekerült példányokat (indulás ±15 perc, táv ±5%), csoportonként kiválasztható, melyik maradjon (javaslat: a több mért adattal), a többi kihagyható a statisztikából vagy törölhető. A „Beleszámít a statisztikába” bekapcsolásakor felugró ablak, ha ugyanez az edzés már számít: „Csak ez számítson” (a másik kimarad) / „Mindkettő” / „Mégse”. (`src/ui/duplicates.js`)
- **Admin – közösségi útvonal nyomvonalának szerkesztése:** a Közösségi útvonalak listájában „✎ Nyomvonal” gomb (és a Szerkeszt ablakban) → az útvonal új lapon a Tervezőben nyílik, minden tervezőeszközzel (pontok húzása, beszúrása, törlése, szakaszmód, BRouter); a fül tetején „Mentés a közösségi útvonalba”. A szerver lecseréli a GPX-et, frissíti a távot / szintet / időt, újraszámolja a helyadatot; az előző nyomvonal megmarad, „↶ Előző” gombbal visszaállítható (oda-vissza). Beépített útvonalnál a felülírás a custom mappába kerül. (`PUT /api/admin/samples/<id>/gpx`, `POST …/gpx/restore`, `src/ui/sampleEdit.js`)
- **Javítás – nyilvános nézőoldal:** az emelkedő a forrás (Strava / eszköz) értéke volt, az ereszkedő viszont a nyomvonalból számolt – a kettő nem illett össze (pl. sík körön 16 m fel / 12 m le). Most az ereszkedő is a forrás emelkedőjéből jön, a rajt és a cél magasságkülönbségével korrigálva.

## v1.38.0 – 2026-11-08 – Tájoló térkép, karcsúbb Kezdőlap-gombok

### Verzió

- **Tájoló térkép:** hol van az útvonal az országon belül – kis Magyarország-körvonal (a szomszédokkal, ha az út átnyúlik), Balatonnal és Dunával, benne az útvonal helye (rövid útnál pont, hosszabbnál a nyomvonal). Könyvtár: a kártyákon a bélyegkép mellett és a lenyitott sor térképének sarkában; nyilvános nézőoldal: a térkép jobb alsó sarkában; PDF útvonallap: abban a sarokban, ahol nem takarja a nyomvonalat. Csempe-letöltés nélkül (`src/map/locator.js`, Natural Earth 50m körvonalak).
- **Kezdőlap:** a gyorsgombok (Új útvonal, GPX / FIT betöltése, Könyvtár, Közösségi utak, Statisztikák) kisebbek, vékonyabbak – 34 px-es kapszulák 42 px helyett.
- **Javítás – Elemzés:** ha egy edzés után idő / pulzus nélküli GPX-et (pl. tervet) töltöttél be, az összefoglalóban az előző fájl dátuma, időtartama és TRIMP / Edwards értéke maradt.

## v1.37.0 – 2026-11-08 – AI-leírás az útvonalakhoz, rendezett Elemzés-összefoglaló

### Verzió

- **Elemzés – rendezett adatblokk (gépen):** a fő számok alatt a korábbi sortörő „halk sor” helyett Strava-mintára szürke sáv (Kalória – kattintásra az összevetés –, TRIMP, Edwards), alatta Átlag | Max táblázat (sebesség, pulzus, kadencia, teljesítmény, hőmérséklet, teljes idő); az ereszkedés az Emelkedés alatt (pl. „Emelkedés · 810 m ↓”) – a „Lejtés” szó a meredekség-színezésé marad. Minden felirat (Táv, Mozgásidő, Átlagsebesség, Emelkedés, Kalória, TRIMP, Edwards, a táblázat sorai, Átlag / Max) magyarázó buborékot kapott (pontozott aláhúzás, egérrel fölé vagy Tab-bal).
- **AI-leírás az útvonalakhoz:** a tervező Mentés ablakában és a könyvtár Szerkesztés ablakában a leírás mellett „AI-leírás” gomb – a nyomvonalból a szerver kiszámolja a megyét, a rajtot / célt és az érintett településeket (OSM), a burkolat-arányokat (BRouter / tárolt vizsgálat) és a domborzatot, és ebből 2–3 mondatos leírást ír („Körtúra Veszprém vármegyében, … Vegyes burkolatú …”). A napi AI-keretből számít; a meglévő leírás tényeit megtartja. (`POST /api/ai/route-description`, `src/ui/aiDescribe.js`)

## v1.36.0 – 2026-11-08 – Hőmérséklet, kalória-összevetés, eszközképek, egységes Elemzés

### Verzió

- **Hőmérséklet:** a komputer mérése (Garmin, Magene, Wahoo…) az Elemzésben kártyán, grafikonon (átlag, legalacsonyabb, legmagasabb) és térképszínezéssel; a Stravás edzéseknél is (az új importoknál azonnal, a régieknél a háttérben, fokozatosan). Ahol az óra nem mér (Apple Watch, telefon), az Open-Meteo időjárás-archívumából az indulás helyén, az edzés óráiban mért érték – „(időjárás)” jelöléssel. A Könyvtár lenyitott sorában és a PDF-ben is.
- **Kalória-összevetés:** a „Kalória (forrás) ›” sorra kattintva egymás mellett a rögzítő eszköz / Strava / Garmin / OnelapFit értéke, a wattmérős munkából számolt, a pulzus alapú (Keytel-képlet az életkorod, nemed, testsúlyod alapján – legalább 3 wattmérős edzésből személyesen kalibrálva) és a sebességből becsült érték, eltéréssel. A Strava wattmérő nélkül becsült teljesítménye nem számít mérésnek. A kézzel feltöltött FIT-ből az eszköz saját kalóriája is bekerül.
- **Energia a statisztikában:** új Energia csempe az Áttekintésben (forrásonkénti bontással), a havi táblázat és a „Legtöbb kalória” rekord is ugyanazt a sorrendet használja (eszköz → wattmérő → pulzus → becslés); a becslés csak kerékpárra (eddig a sétákat is a bringás táblázattal számolta).
- **Elemzés – egységes adatpanelek (gépen):** Sebesség, Kadencia, Pulzus – zónák, Teljesítmény, Hőmérséklet, Szintprofil: a fejlécben a grafikon-ikon és a térképszínezés kapcsolója (egyszerre egy), lenyitva a zónaeloszlás színnel, tartománnyal, idővel (lejtésnél távval) és százalékkal; a térkép sarkában ugyanez a jelmagyarázat.
- **Eszközök képpel:** a felismert rögzítők (komputerek, órák) magától képet kapnak – Magene-nél a gyártó oldaláról, másoknál a Wikimedia Commons szabad képei közül, csak biztos találatnál. Kép cseréje: keresés más néven, webcím, saját fotó. Eszközkártyák rácsban (edzés, km, idő, utoljára, képforrás).
- **Eszközök összevonása:** a Strava ugyanazt az órát két néven adhatja át („Apple Watch Series 7” és „Strava App (Apple Watch Series 7)”) – a „Strava App (…)” magától összevonódik, bármely két eszköz kézzel is (kártya → Összevonás), és bármikor szétválasztható. A számokra, a könyvtár Eszköz szűrőjére és a feliratokra is érvényes.
- **Javítás – bringa a vásárlás előtt:** a bringa vásárlási dátuma előtti edzésekhez az automatikus hozzárendelés (komputer / Strava bringaneve, alapértelmezett bringa) már nem rendeli hozzá a bringát; kézzel továbbra is lehet.
- **Garmin-testsúly automatikusan (opció):** Beállítások → Garmin Connect – pipával az okosmérleg új mérése magától frissíti a kerékpáros profil testsúlyát (értesítéssel).
- **Automatikus import a Beállításokban is:** a Strava, Garmin, OnelapFit, Wahoo és Polar szakaszban pipa és időköz – mindig egyformán áll az import ablakkal.
- **Maximális sebesség** a kézzel feltöltött edzéseknél is (a GPX-ből, simítva).
- **Javítás – könyvtár index:** az egyszerre futó mentések és háttér-pótlások már nem írhatják egymásra az index fájlt (zárolás, egyedi ideiglenes fájl); sérült indexnél a biztonsági másolatból olvas, nem üres listából.
- **Javítás – felület:** az Elemzés összefoglalója üresjáratban folyamatosan újrarajzolta magát (az ikonok hibás frissítése miatt), ezért a kalória-sorra kattintás elveszett; a Kezdőlapról nyitott edzésnél hiányzott a kalória, a hőmérséklet és a felszerelés.
- **„Mi ez?” oldal és súgó:** az új funkciók leírása, új képernyőképek egy bemutató fiók kitalált adataival.
- **Belül:** új `routes-api/temp_weather.py`, `device_images.py`; `src/ui/zoneDist.js`; `tools/demo/` (bemutató fiók és a képernyőképek elkészítése szkripttel); lucide ikonkönyvtár rögzítve (1.70.0).

---

## v1.35.0 – 2026-11-07 – Felszerelés, teljesítmény mindenhol, 7 pulzuszóna

### Verzió

- **Felszerelés (új főmenüpont):** a bal oldali sávban (telefonon az alsó sávban) bringa ikonnal. Bringák (márka, modell, típus, súly, vásárlás, ár, kezdő km, „más néven”, alapértelmezett, nyugdíjazva) – a km, az idő, az edzésszám, az idei km és a szint magától számolódik a hozzárendelt edzésekből.
- **Melyik bringával mentél:** kézi beállítás (az edzés szerkesztőjében, vagy a bringánál „Edzések hozzárendelése…” – tömegesen, eszköz és dátum szerint szűrve, csak a kerékpáros edzések) → a komputer bringaprofilja / a Strava bringaneve → bringanév nélküli kerékpáros edzésnél az alapértelmezett bringa. A Stravából jött név is felülírható. A fájlokból / Stravából jött, még fel nem vett bringanevek egy kattintással felvehetők vagy egy meglévőhöz köthetők (pl. a komputer „Cube” és a Strava „Cube AIM EX” neve).
- **Alkatrészek és karbantartás:** lánc, gumi, fékbetét, kazetta, kerék, elem… – melyik bringán és mióta (bringát válthatnak, a km mindig a megfelelő helyre kerül; a leszerelt alkatrész a Raktárba). Emlékeztetők km, üzemóra vagy nap alapján, javaslatokkal (láncolajozás, lánccsere, nagyszerviz…); 90%-nál „hamarosan”, 100%-nál „esedékes”: Teendők a Felszerelés tetején, figyelmeztetés a Kezdőlapon, push-értesítés („Szerviz esedékes”, kikapcsolható). „Elvégezve” dátummal, költséggel, megjegyzéssel – a számláló újraindul, a munka a naplóba kerül.
- **Bringafotó:** a bringa és az alkatrész kártyáján kép tölthető fel (telefonon a kamerával is). A böngésző feltöltés előtt kicsinyíti (legfeljebb 1280 px, néhány száz KB), a kártyán 4:3-as keretben, egészében látszik; nagyítható, cserélhető, törölhető. Csak a tulajdonos látja, és a mentésbe (backup) is bekerül.
- **Rögzítő eszköz és szenzorok:** minden edzésnél látszik, milyen eszközzel (Magene C506, Garmin Edge, Apple Watch…), melyik bringával és milyen szenzorokkal (pulzusöv, kadencia, wattmérő, radar, lámpa…) készült – a FIT-fájlból, illetve a Stravából. Az Elemzés fejlécében, a könyvtár kártyáján és lenyitott sorában; a régebbi edzéseknél a háttérben töltődik be.
- **Könyvtár szűrők:** új **Bringa**, **Eszköz** és **Mért adat** (pulzus, teljesítmény, kadencia) szűrő.
- **Teljesítmény mindenhol:** a FIT-ből jött edzések wattadata eddig elveszett a könyvtárban – most mindenhol megvan (grafikon, térképszínezés, megosztó kép, PDF, statisztika). A teljesítmény-grafikon fejléce: Átlag, NP (normalizált teljesítmény), Max, Munka (kJ), W/kg; a vonal simítható (Nyers / 10 mp / 30 mp). A csúcsteljesítmény a pontos, simítás nélküli érték.
- **7 pulzuszóna (opció):** Beállítások → Pulzuszónák → LTHR → Zónák száma: 5 vagy 7 (Friel – a Z5 három részre bomlik: Z5a, Z5b, Z5c; az OnelapFit / Magene is így mutatja). Mindenhol érvényes: térképszínezés, grafikonok és jelmagyarázat, zónaelemzés, AI-elemzés, megosztó kép és PDF (zónaszín módban), a beállítások zónaszínei.
- **LTHR csúszka** 100-tól (eddig 130-tól).
- **Beállítások:** a korábbi „Bringáim” szakasz kikerült – a bringák a Felszerelés menübe költöztek (a meglévők maguktól átjönnek).
- **„Mi ez?” oldal és súgó:** a Felszerelés, a teljesítmény-elemzés és a 7 zóna leírása.
- **Belül:** új `routes-api/gear.py`, `api_gear.py` (`/api/gear*`, `/api/routes/bulk-bike`, óránkénti szerviz-értesítő, fotók), `gpx_metrics.py` (mért adatok és felszerelés pótlása a régi edzéseknél), `fit_gpx.py` felszerelés-olvasás; frontend `src/equipment.js`, `src/ui/gear.js`. nginx: a statikus fájlok szabálya nem nyúl az `/api/` kérésekhez. Tesztek: `tests/test_gear.py`.

---

## v1.34.0 – 2026-11-06 – Wahoo és Polar import, automatikus Garmin-import

### Verzió

- **Wahoo import (új):** a Wahoo (ELEMNT, KICKR) edzései a hivatalos Wahoo Cloud API-n – Beállítások → Wahoo → Csatlakozás (a Wahoo saját belépési oldalán), Könyvtár → Import → Wahoo-ból. Az eredeti FIT is megmarad.
- **Polar import (új):** a Polar edzései a hivatalos Polar AccessLink API-n – Beállítások → Polar, Könyvtár → Import → Polarból. A Polar csak a csatlakozás után feltöltött, legfeljebb 30 napos edzéseket adja ki; a beltéri (GPS nélküli) edzések kimaradnak.
- **Saját fejlesztői alkalmazás:** a Wahoo- és Polar-kapcsolathoz mindenki a saját (ingyenes) fejlesztői alkalmazásának kulcsait adja meg a Beállításokban – lépésről lépésre útmutatóval, a Redirect URI-val és Másolás gombbal. Nem kell admin, és nem kell a gyártó jóváhagyására várni (Wahoo: Sandbox).
- **Automatikus import mindenhol:** a Garmin, OnelapFit, Wahoo és Polar import ablak tetején bekapcsolható – 5, 15, 30 percenként vagy óránként, „Ellenőrzés most” gombbal, értesítéssel. A bekapcsolás előtti edzéseket nem hozza, a könyvtárból törölteket nem hozza vissza, és az ismétlődés-védelem itt is érvényes.
- **Garmin import:** az eredeti FIT-et tölti le (teljesítmény, hőmérséklet is), és az a könyvtárban is megmarad; ha nincs, a Garmin GPX-exportja a tartalék.
- **OnelapFit:** mindenhol „OnelapFit” néven (OnelapFitből, Küldés OnelapFitre). Útvonal küldésekor a tervezés fordulópontjai (útpontok) nem mennek fel – az OnelapFit eddig külön pontokként rakta ki őket –, és az útvonal a saját nevén megy fel (könyvtárból / közösségi útvonalból töltött tervnél is).
- **Küldés visszajelzéssel:** a Küldés Garminra / OnelapFitre után felugró ablak mutatja, sikerült-e (név, táv, hol találod); küldés közben a gomb jelzi, hogy dolgozik.
- **Márka-ikonok:** Strava, Garmin, OnelapFit, Wahoo, Polar ikon a betűjelek helyett (menük, import ablakok, Beállítások).
- **„Mi ez?” oldal és súgó:** az új kapcsolatok, az automatikus import és a Wahoo / Polar beállítás leírása.
- **Belül:** közös FIT → GPX (`fit_gpx.py`), automatikus importok (`garmin_sync.py`, `device_sync.py`), Wahoo / Polar (`device_import.py`, `wahoo_service.py`, `polar_service.py`, `api_devices.py`), frontend `src/ui/deviceImport.js`, `src/ui/autoSync.js`. Tesztek: `tests/test_garmin.py`, `tests/test_devices.py`.

---

## v1.33.0 – 2026-11-05 – OnelapFit (Magene) kapcsolat, ismétlődés-védelem

### Verzió

- **OnelapFit (Magene) kapcsolat:** Beállítások → OnelapFit – belépés az OnelapFit e-mail címmel és jelszóval (ezzel szinkronizálnak a Magene kerékpáros komputerek). A jelszót nem tároljuk, csak a belépési tokent, ami magától frissül; csak 60 nap használat nélkül kell újra belépni.
- **Edzés-import az Onelapból:** Könyvtár → Import → Onelapból – lista dátummal, távval, idővel és „Új / Már megvan / Hasonló van / Korábban törölted” jelöléssel. A szerver a FIT-ből készít GPX-et, az eredeti FIT is megmarad (pulzus, kadencia, teljesítmény, hőmérséklet). Az Onelap „Ride” neve helyett napszakos név („Délutáni kerékpározás”). A GPS nélküli edzések kimaradnak.
- **Automatikus Onelap-import:** az import ablakban kapcsolható be – 5, 15, 30 percenként vagy óránként ellenőrzi az új edzéseket, és magától behozza őket, értesítéssel (az Onelapnak nincs azonnali webhookja). „Ellenőrzés most” gomb, utolsó ellenőrzés állapota.
- **Útvonal küldése a Magene-re:** tervezés után a Mentés ablakban **Küldés Onelapra**, vagy a könyvtárban egy tervnél **… → Küldés Onelapra** – az OnelapFit útvonalai közé kerül a könyvtárbeli névvel, onnan szinkronizálható a komputerre navigációhoz.
- **Küldés Garminra a Mentés ablakból is:** a tervezésből egy gombbal Garmin Connect course. A Küldés Garminra / Onelapra gombok és menüpontok csak akkor látszanak, ha az adott kapcsolat be van állítva.
- **Küldés mentés nélkül is:** ha a könyvtárba mentés nem sikerül (pl. betelt a kvóta), az útvonal akkor is elmegy az eszközre, és az app szól, hogy a könyvtárba nem került be.
- **Értesítés sikeres küldésről:** push-értesítés, ha az útvonal felment az Onelapra vagy a Garminra (Beállítások → Értesítések → „Útvonal elküldve az eszközre”, kikapcsolható); az appban a visszajelzés tovább látszik.
- **Ismétlődés-védelem:** Beállítások → Edzés-import (alapból bekapcsolva) – ugyanaz az edzés több forrásból (pl. a Magene az Onelapra és a Stravára is feltölti) csak egyszer kerül a könyvtárba. Azonosnak számít, ha az indulás legfeljebb 15 perccel, a táv legfeljebb 5%-kal tér el. Minden importra érvényes: Strava (kézi, automatikus, webhook), Garmin, Onelap; az import ablakban „Kihagyva – már megvan”. Kikapcsolva minden forrás külön bekerül.
- **Javítás:** a Garmin-import ablakban duplán szerepelt a Strava automatikus import blokkja.
- **Bemutató és súgó:** az OnelapFit (Magene) kapcsolat és az ismétlődés-védelem leírása.
- **Belül:** új `routes-api/onelap_service.py`, `api_onelap.py`, `onelap_sync.py`, `src/ui/onelap.js`; új Python-függőség: `fitdecode`. Közös ismétlődés-vizsgálat: `utils.find_cross_source_duplicate`. Tesztek: `tests/test_onelap.py`.

---

## v1.32.0 – 2026-11-03 – Admin: útvonalak térképen, szűrő; gyorsabb betöltés

### Verzió

- **Közösségi útvonalak (admin):** minden sor elején a nyomvonal kis rajza (egy kérésben töltődik); rákattintva vagy a „Térkép” gombbal az útvonal nagy térképen nyílik meg, rajt- és célponttal.
- **Térképstílus a térkép ablakban:** Standard, Kerékpár, Domborzat, Terep, Műhold, Hybrid, Világos, Sötét – ugyanazok, mint az appban; az admin felület megjegyzi a választást.
- **Szűrősáv a Közösségi útvonalak fölött:** keresés névre, leírásra, településre, megyére (ékezet nélkül is), szűrés típusra, forrásra (beépített / egyedi / beküldött), távra, kör / A → B formára; rendezés név, táv, emelkedő vagy helyszín szerint; találatszám és „Szűrők törlése”.
- **Felhasználó útvonalai (admin):** új 🗺 gomb – a felhasználó útvonala vagy edzése térképen. **Beküldések:** az előnézetre kattintva nagy térkép.
- **Gyorsabb betöltés:** a szerver mostantól tömörítve küldi a GPX-et, a JSON-t és a programfájlokat – egy edzés GPX-e kb. 20×, a fő programfájl kb. 3,5× kisebb; mobilneten és VPN-en érezhetően gyorsabb a Könyvtár és az útvonalak megnyitása.
- **Belül:** az alaptérkép-rétegek külön modulban (`src/map/tileLayers.js`), az app és az admin közösen használja. Böngészős tesztek (Playwright, mobil és asztali nézet): `tests/`.

---

## v1.31.0 – 2026-11-02 – Navigáció a megtervezett útvonalon

### Verzió

- **Béta, alapból kikapcsolva:** Beállítások → Navigáció (béta) – bekapcsolás eszközönként, utasítás-mód (beszéd / csak hangjelzés és rezgés / csak rezgés), felolvasó hang választása, próba.
- **Navigáció:** a térkép jobb felső sarkában a „Navigáció” gombbal a megtervezett útvonalon végigvezet – gyalog és kerékpárral. Teljes képernyős térkép, a saját hely iránnyal, a térkép követi a mozgást (elhúzva megáll, „Követés”-sel vissza); a megtett rész szürke.
- **Irányutasítások:** felül nyíl, táv és utasítás („200 m múlva balra”, körforgalom kijárattal, jelzéskövetésnél „a P jelzésen tovább”), alatta a rákövetkező. A tervezett útvonalnál a BRouter kanyar-utasításaiból, betöltött GPX-nél a vonal töréseiből.
- **Természetes hang:** két beépített magyar hang – Berta (női) és Imre (férfi), a Piper nyílt neurális felolvasóval előre legenerálva (CC0 adatkészlet), offline is szól; a mondatok elemekből állnak össze. A telefon felolvasója választható, és tartalékként marad. Generátor: `tools/voice/generate.py`.
- **Hang:** magyar felolvasás (gyalog kb. 70 és 15 m-rel előtte, kerékpárral a sebességhez igazítva korábban), némítható.
- **Letérés-figyelés:** gyalog 40, kerékpárral 50 m felett rezgés, hang és piros szaggatott vonal vissza az útra; visszatéréskor jelez.
- **Adatok:** hátralévő táv, várható érkezés (előbb a tervezési, utána a valós tempóval, emelkedővel), hátralévő emelkedő, sebesség; célba éréskor összegzés.
- **Indulás onnan, ahol vagy:** az első GPS-jel után – az útvonal közepén megkérdezi, innen folytatod-e vagy az elejéről; ahol az út többször is elhalad (kör, oda-vissza), azt is, melyik részénél tartasz (a haladási irány szerinti az első).
- **Rajthoz vezetés:** ha messze vagy az úttól, bekötő szakaszt tervez a legközelebbi ponthoz vagy a rajthoz (kék pöttyözött vonal, „itt rátérsz az útvonalra”).
- **Félbehagyott út folytatása:** a cél előtt befejezett navigáció haladása 14 napig megmarad (eszközönként); újraindításkor „Folytatod onnan?”.
- **Képernyő ébren tartása** navigáció közben (Wake Lock). A böngésző zárolt képernyőnél / háttérben nem ad helyet – erről a súgó is szól.
- **Próba otthon:** az URL végére `?navsim` → „Próba” gomb a navigációban, ami végigmegy az útvonalon; `?navsim=5:400` az 5. km-nél, 400 m-re északra indul (a középről indulás és a bekötés kipróbálásához).

---

## v1.30.0 – 2026-11-02 – Jelzéskövetés: tervezés a turistajelzéseken

### Verzió

- **Jelzés követése a következő pontig:** gyalogos módban a pont ablakában kiválasztható egy jelzés, amely a ponton és a következőn is átmegy (pl. P, K▲, OKT – a jelzés képével). A szakasz pontosan azon a jelzésen vezet; a pontlistában a pont mellett a jelzés képe látszik.
- **Jelzések a térkép egy pontján:** jobb gomb (asztalon) / hosszú érintés (telefonon) → az ott futó jelzések; kiválasztva kiemelődik a térképen, és „Pont ide, ezen a jelzésen” (pontról pontra a jelzésen), „Egész jelzés tervként” (120 km-ig) vagy „Mutasd egészben”.
- **Csak jelzett turistaúton:** új kapcsoló a tervezés ⚙ paneljében (gyalogos módban): a jelzett utak erős előnye, csak a be- és kivezetésnél tér le róluk.
- **Mentés:** a követett jelzés a GPX-be és a félkész tervbe is bekerül, visszatöltéskor megmarad.
- **Súgó:** új rész – Turistajelzések és jelzéskövetés; műszaki leírás: `TURISTAJELZESEK.md`.

---

## v1.29.0 – 2026-11-02 – Séta és Túra: két gyalogos mód, turistajelzések

### Verzió

- **Két tevékenység:** a tervezési módok csoportosítva – **Kerékpár** (Aszfalt / Gravel / MTB) és **Gyalog** (Séta / Túra). Az eddigi egyetlen gyalogos mód („Túra”, belül `walking`) kettévált.
- **Séta:** utcák, járdák, parkok, könnyű utak – nehéz ösvényre nem visz. **Túra:** a jelzett turistautakat részesíti előnyben, ösvényen is. Mindkettő a BRouter gyalogos (hiking-mountain) profiljával tervez, eltérő beállítással – eddig a gyalogos mód kerékpáros (trekking) profillal tervezett.
- **Szakaszonkénti mód:** a pontablakban és a pontlista színes pöttyén csak a tevékenység saját módjai választhatók (bringás úton nincs gyalogos szakasz). Tevékenységváltáskor a szakaszonkénti módok visszaállnak az alapra.
- **Turistajelzések réteg:** a térképstílus-választóban kapcsolható (Waymarked Trails), bármelyik térkép fölött; amíg nem állítod át, Séta és Túra módban magától bekapcsol.
- **Útvonal-javaslat gyalog is:** Kerékpár / Gyalog választó, gyalog Séta / Túra / Vegyes terep, 2–40 km; Túránál a jelzett turistaúton haladó arány számít, és a kártyán is látszik. Az AI-kérés a sétát és a túrát is felismeri.
- **Ikonok és sebesség:** a Séta lábnyom, a Túra bakancs ikont kapott; a Sétának külön tervezési sebessége van (alap 5 km/h).
- **Mentés, GPX, Könyvtár, beküldés, admin:** a Séta külön típus (`walking`), a Túra marad `hiking`. A Könyvtárból betöltött terv a saját típusának megfelelő tervezési móddal töltődik be.
- **Burkolat-vizsgálat importnál:** a szakaszmód a tevékenységhez igazodik (bringás úton az ösvény MTB, gyalog a burkolt út Séta, az ösvény Túra).
- **Átállás:** a korábban „Túra” néven mentett alapmód és félkész terv Túra marad.

---

## v1.28.3 – 2026-11-02 – Automatikus zoom kapcsoló

### Verzió

- **Automatikus zoom az útvonalra:** új kapcsoló (súgóval) a tervezés ⚙ paneljének Térkép blokkjában és a Beállításokban. Bekapcsolva (alapértelmezés) új pont után a térkép a teljes útvonalra nagyít, mint eddig; kikapcsolva a nagyítás és a térképrészlet marad, ahol volt (visszajelzés: új pont hozzáadásakor visszaállt a nagyítás). A teljes útvonalat a „Teljes útvonal” gomb mutatja.
- **Súgó:** a ⚙ panel Térkép blokkjában a futó animáció és az útirány-nyilak mellé is került ⓘ magyarázat.
- **Vegyes módú útvonal:** bekapcsolt automatikus zoomnál ez is a teljes útvonalra nagyít, mint az egyprofilos.

---

## v1.28.2 – 2026-11-01 – Javítások a tesztelés második köréből

### Verzió

- **Félkész terv:** a piszkozat fiókhoz kötött – fiókváltáskor és kijelentkezéskor törlődik, más felhasználó nem látja ugyanazon a böngészőn.
- **Útvonal-javaslat:** az elfogadott javaslat útvonala változatlanul töltődik be (nem tervezi újra a sima profillal, így megmarad a csendes / sík / kerékpárutas nyomvonal, és nem megy ki fölösleges kérés).
- **Útvonal-javaslat távja:** akadályos terepen (folyó, hegy) egy harmadik méretkorrekció is fut, így a javaslat közelebb lesz a kért távhoz (pl. Szentendréről 42 km helyett eddig 21–27, most ~38 km).
- **Saját terv betöltése:** a Könyvtárból a saját mentett terv burkolat-vizsgálós előnézet nélkül, egyből töltődik be.
- **AI-keret:** az admin eszközök (ötlet-feldolgozás, közösségi leírás) a költségnaplóban szerepelnek, de a személyes napi keretből nem vonnak le.
- **Belépés:** a mező felirata „E-mail-cím vagy felhasználónév”.

---

## v1.28.1 – 2026-10-31 – Javítások az átfogó tesztelés első köréből

### Verzió

- **Statisztika:** a mentett tervek tévesen edzésként számítottak bele (a „ne számíts” jelző nem jutott el a szerverhez); a meglévő adatokat egy egyszeri javítás rendbe teszi. A Könyvtárban kifejezetten bekapcsolt terv (pl. letekert) továbbra is számít – most a Kezdőlapon is.
- **Edzés mentése:** a dátum az edzés napja (nem a mentésé), a név a fájlban tárolt edzésnév (nem a fájlnév), az időtartam a valódi mozgásidő (nem a tervezési becslés).
- **Átlagsebesség:** az Elemzésben táv ÷ mozgásidő (mint a Kezdőlapon és a Stravánál) – a pontonkénti átlag felfelé torzított.
- **Emelkedés:** tervezésnél a BRouter szűrt értéke, betöltött fájlnál 3 m-es simítás – a magassági adat zaja eddig akár kétszeres emelkedést adott (sík terepen is), és a becsült időt is növelte.
- **Új útvonal:** a Kezdőlap gombja tiszta lappal indít (az Elemzésből ottmaradt edzést elengedi, félkész saját tervnél rákérdez).
- **Félkész terv megőrzése:** újratöltés vagy a mobilböngésző háttérből való visszatérése után a terv visszatöltődik (7 napig).
- **Tervezési sebességek:** a szerveren is tárolódnak – minden eszközön ugyanaz, fiókváltáskor nem öröklődik át.

---

## v1.28.0 – 2026-10-31 – Saját tervezési profilok, több javaslat-változat

### Verzió

- **Saját BRouter-profilok:** „csendes” (aszfalt, a forgalmas utak erős kerülésével – a korábbi safety profillal ellentétben burkolatlanra nem visz), „sík” (az emelkedő eleve drága) és „kerékpárút előnyben”. Mindháromban a segédpontoknál nincs oda-vissza szakasz. Budapest → Szentendre: főút 53% → 9%, kerékpárút 42% → 62%.
- **Útvonal-javaslat:** a „Forgalom” beállítás háromállású lett (Mindegy / Főutak kerülése / Kerékpárút előnyben), az aszfaltos kérés a hozzá illő profillal tervez; az AI-kérés a kerékpárutas kívánságot is felismeri.
- **Több változat:** ha a saját útvonaltervező elérhető, a javaslat több irányt és kitérő-mélységet próbál ki (kb. 24 tervezés a korábbi 13–17 helyett), így dombos környéken is jobb találat jön.
- **Javítás:** az északi irányú köröknél elmaradt a távkorrekció, ezért rövidebbek lettek a kértnél.
- **Tartalék:** ha a nyilvános brouter.de tervez, a saját profilok helyett a gyári forgalomkerülő profil megy.

---

## v1.27.0 – 2026-10-31 – Saját BRouter útvonaltervező

### Verzió

- **Saját útvonaltervező:** a kézi tervezés és az útvonal-javaslat a stack saját BRouter-szerverén fut (Magyarország és a környező területek térképadatával) – nincs terhelési korlát, és a tervezett pontok nem mennek külső szerverre. Ha a saját szerver nem érhető el, vagy a túra kilóg a térképadatból, automatikusan a nyilvános brouter.de tervez.
- **Térképadat:** első induláskor letöltődik (~190 MB), utána hetente magától frissül; az admin felületen (Közösségi útvonalak) látszik az állapota, és kézzel is frissíthető.
- **Telepítés:** a NAS-stackbe egy új szolgáltatás kerül (`brouter`) – leírás: `brouter/README.md`. Amíg nincs a stackben, minden a korábbiak szerint működik.
- **Adatkezelési tájékoztató és súgó:** a brouter.de és az Overpass már csak tartalékként szerepel; a súgó az útvonal-javaslat új beállításaival bővült.

---

## v1.26.0 – 2026-10-31 – Útvonal-javaslat: idő, irány, forgalom, emelkedő és AI-kérés

### Verzió

- **Táv vagy idő:** a javaslatnál a táv helyett idő is megadható („1 óra 30 perc ≈ 34 km”) – az átszámítás a Beállításokban megadott tervezési sebességgel történik.
- **További beállítások:** irány (É / K / D / Ny – a kör arra induljon), főutak kerülése (aszfaltnál forgalomkerülő tervezés) és a leghosszabb egybefüggő emelkedő felső határa (30 / 60 / 100 m).
- **Több javaslat:** alapból 3, a „Több javaslat” gombbal 6 különböző irányú útvonal, újraszámolás nélkül.
- **„Hasonló, de…”:** a kiválasztott javaslatból egy kattintással rövidebb, hosszabb, kevesebb szintes, másik irányú, aszfaltosabb vagy kisebb forgalmú változat.
- **Kérés AI-val:** szabad szöveggel leírható a túra („másfél órás gravel kör Szentendréről, kevés forgalommal, nagy emelkedő nélkül”) – az AI kitölti a beállításokat, megkeresi a helyet, és jelzi, mit értett és mit nem tud még figyelembe venni (pl. kávézó érintése). A napi AI-keretbe számít.
- **Kártyák:** jelzik a beállított emelkedő túllépését és a főúton megtett arányt is.

---

## v1.25.1 – 2026-10-30 – Szélelemzés: kevesebb időjárás-lekérdezés

### Verzió

- **Szélelemzés:** az útvonal összes pontjára egyetlen Open-Meteo kérés megy (korábban pontonként külön, egyszerre akár 30), a közeli pontok közös előrejelzést kapnak, és fél órás gyorsítótár miatt az indulási idő, a sebesség vagy kisebb útvonal-módosítás nem kér újra. Így megszűnik a „HTTP 429” (túl sok kérés) hiba; ha mégis előfordul, egyszer újrapróbál, és érthető üzenetet ad.

---

## v1.25.0 – 2026-10-30 – Saját burkolat-adatbázis, pontosabb útvonal-javaslat

### Verzió

- **Saját burkolat-adatbázis:** a burkolat-vizsgálat (aszfalt / murva / földút / ösvény) a szerveren tárolt magyar OpenStreetMap-kivonatból azonnal megy – egy teljes útvonal tizedmásodperc alatt, a külső, gyakran túlterhelt térképadat-szerver nélkül. Külföldi útvonalnál továbbra is a külső szerver válaszol. Az admin a Közösségi útvonalak fülön építi és frissíti (állapot, térképadat dátuma, méret); havonta magától frissül.
- **Útvonal-javaslat – sík:** a pontozás az átlagos szint mellett a leghosszabb egybefüggő emelkedőt is figyeli, így „sík” kérésnél nem kerül be egy nagy kaptató.
- **Útvonal-javaslat – aszfalt:** a burkolatlan, főleg a földutas és ösvényes szakaszok már néhány százaléknál is erősen számítanak; szigorú kérésnél több irányt próbál.
- **Őszinte jelzés:** ha egy javaslat nem felel meg teljesen a kérésnek (pl. emelkedő, burkolatlan szakasz), a kártya jelzi; ha a környéken egyik sem felel meg, erről külön tájékoztat.
- **Szerver:** a routes-api konténer Debian slim alapra váltott (az OSM-feldolgozó könyvtár miatt).

---

## v1.24.1 – 2026-10-30 – Belépés a felhasználó nevében, szél és burkolat edzésből lett tervnél

### Verzió

- **Admin – belépés a felhasználó nevében:** a felhasználólistában „Belépés” gomb: a felhasználó felülete új lapon nyílik, jelszó nélkül, 2 órára. A lap elszigetelt tárolót használ, így az admin saját munkamenete a többi lapon érintetlen; alul sáv jelzi a nézetet „Kilépés” gombbal. Jelszó, e-mail-cím, fióktörlés, visszaállítás és admin funkciók a nézetben nem érhetők el; minden belépést a szerver naplóz. Admin és tiltott felhasználó nevében nem lehet belépni.
- **Tervezés ez alapján:** az Elemzésből a Tervezésbe vitt edzésnél a szélelemzés és a színezés gombjai újra aktívak.
- **Burkolat edzésből lett tervnél:** a könyvtárban tárolt burkolat-vizsgálatot azonnal mutatja; ha még nincs, a lekérdezés eredményét az edzés mellé menti. Hosszú útnál látszik a haladás („2/4 rész”).

---

## v1.24.0 – 2026-10-30 – Nyílt regisztráció, nyilvános link kapcsoló, fejlesztési fa az adminban

### Verzió

- **Nyílt regisztráció:** a belépő oldalon „Nincs fiókod? Regisztrálj” link, külön regisztrációs oldal (név, e-mail, jelszó) az adatkezelési tájékoztató kötelező elfogadásával; az admin a „Regisztráció” fülön (korábban „Meghívók”) be- és kikapcsolhatja – kikapcsolva „A regisztráció jelenleg nem elérhető” üzenet jelenik meg. Botvédelem (rejtett csapdamező, óránkénti korlát IP-címenként), új regisztrációról értesítés az adminoknak.
- **Erős jelszó:** legalább 8 karakter, nagybetű, szám és speciális karakter – regisztrációnál, meghívós regisztrációnál, jelszócserénél és jelszó-visszaállításnál is; a regisztrációs oldalon élő ellenőrzőlista mutatja, mi hiányzik.
- **Adatkezelési tájékoztató:** átdolgozva – AI-elemzés, külső szolgáltatások (térképek, betűtípusok, push-értesítés, e-mail, Anthropic, közösségi megosztás), az adatkategóriák és a megosztott linkek pontos leírása; új változat (2026. október), amit belépéskor újra el kell fogadni.
- **Nyilvános link kapcsoló:** a megosztás ablakban ki- és bekapcsolható, hogy a tervhez tartozó link bárki számára megnyitható legyen-e; a PDF és a megosztó kép QR-kódja bekapcsolja. A meglévő megosztott linkek nyilvánosak maradnak.
- **Admin – Fejlesztések:** új fül a fejlesztési ötletek fájával területenként (kezelőfelület, tervezés, elemzés, könyvtár, statisztika, AI, háttérfeladatok, térképszolgáltatások, üzemeltetés, biztonság, integrációk, dokumentáció); pipával jelölhető, ami elkészült, verziószámmal. Új ötlet, alpont, szerkesztés, áthelyezés másik szülő vagy terület alá, törlés; szűrés és keresés; exportálás és importálás JSON-fájlba.
- **Ötlet AI-val:** szabad szöveges ötletből az AI javaslatot ad a fába: elhelyezi a megfelelő terület vagy elem alá, megfogalmazza, szükség esetén több elemre bontja, és jelzi, ha már szerepel a fában. Jóváhagyás előtt minden átírható, és semmi nem kerül be.
- **Szélelemzés betöltött útvonaltervnél:** a Tervezésbe betöltött GPX-tervnél is elérhető (korábban csak a kézzel rakott pontoknál).
- **AI-hívások:** legfeljebb 85 másodpercig várnak és nem ismétlődnek, így a Cloudflare 100 másodperces korlátja előtt mindig érthető üzenet jön.
- **Súgó:** a nyilvános link kapcsoló leírása.

---

## v1.23.1 – 2026-10-29 – Súgó és bemutató az új funkciókkal

### Verzió

- **Súgó:** új alfejezetek – „Útvonal-javaslat” (lépésről lépésre, a kártyák, az automatikus újratervezés) és „AI-elemzés” (rövid és részletes elemzés, megjegyzés, mentés és szerkesztés, napi keret, adatvédelem, kikapcsolás); kiegészítve a tervezés ⋯ menüje, a GPX-betöltés (saját terv ablak nélkül, tárolt burkolat-vizsgálat), a közösségi útvonalak szűrői és a Beállítások.
- **Admin súgó:** új „AI” rész (kulcs, alap és felhasználónkénti napi limit, költség), valamint a „Burkolat pótlása” és az „AI-val kitöltés” leírása.
- **Bemutató oldal:** új szakaszok az útvonal-javaslatról és az AI-edzéselemzésről, új asztali és mobil képernyőképekkel; az adatvédelmi megjegyzés pontosítva az opcionális AI-elemzéssel.

---

## v1.23.0 – 2026-10-29 – Útvonal-javaslat, AI-leírás az adminban, új megosztó kép ablak

### Verzió

- **Útvonal-javaslat:** a Tervezésben (üres tervnél a pontlista alatt, illetve a ⋯ menüben) rajtpont a térképre bökve vagy a saját helyről, táv, kör vagy A → B, burkolat (aszfalt / gravel / vegyes) és szint (sík / dombos / bármi) → 3 javaslat a térképen és kártyákon (táv, szint, aszfalt- és burkolatlan arány, település szerinti név). A kiválasztott szerkeszthető tervként töltődik be a burkolathoz illő tervezési móddal.
- **Javaslatok minősége:** a zsákutcába eső segédpontok okozta oda-vissza „tüskéket” levágja, az önátfedést bünteti; közeli célnál az A → B körszerűen tervez, és a célnál ér véget. Beállítás változásakor (burkolat, szint, táv, kör / A → B, új rajt vagy cél) automatikusan újratervez.
- **Admin – AI-leírás:** a közösségi útvonal szerkesztőjében „AI-val kitöltés”: rövid leírás, nehézség és évszak javaslat az útvonal adataiból (táv, szint, települések, burkolat); mentés előtt átírható, a forrásmegjelölés megmarad. A „Szegmensvizsgálat” helyett itt is „Burkolat vizsgálata”.
- **Megosztó kép ablak:** asztalon két oszlop – bal oldalt végig látható, nagy előnézet, jobbra a beállítások; mobilon az előnézet felül tapad. Az új panelek stílusa: kis nagybetűs címkék, szürke sávos választók, fekete kiemelés.

---

## v1.22.1 – 2026-10-29 – Részletes AI-elemzés, tárolt burkolat-vizsgálat

### Verzió

- **AI-elemzés csak elvégzett edzésre:** útvonaltervnél, közösségi mintánál és időadat nélküli fájlnál nem jelenik meg (a szerver is ellenőrzi). A Kezdőlapról megnyitott edzésnél is elérhető.
- **Részletes AI-elemzés:** a rövid mellé külön kérésre hosszabb változat felugró ablakban – fejezetek (tempó és erőbeosztás, pulzus és terhelés, terep, összevetés a korábbiakkal) és javaslatok a következő edzésekre; az edzéssel együtt mentődik.
- **Rövidebb alapelemzés:** egy mondatos összefoglaló és 3 rövid pont, összecsukva soronként, „Részletek” lenyitással. A szakaszok tempója mozgásidőből számol, a megállás külön szerepel.
- **Újragenerálás elrejtve:** a kártyáról kikerült; szerkesztés módban, az elavult elemzésnél és a részletes ablakban érhető el, mindig megerősítéssel.
- **Saját terv betöltése ablak nélkül:** a Bringatervben tervezett és mentett útvonal a mentett tervezési módokkal azonnal betöltődik.
- **Tárolt burkolat-vizsgálat:** a közösségi minták (26 megyei minta előre vizsgálva) és a saját feltöltött GPX-ek vizsgálata eltárolódik – betöltéskor azonnal látszik, újravizsgálni csak kérésre kell. Admin: „Burkolat pótlása” gomb (hiányzóknál, illetve teljes újravizsgálat); új minta feltöltésekor automatikusan lefut.
- **Megbízhatóbb burkolat-vizsgálat:** hosszú útvonalnál darabokban kérdez, túlterhelt térképadat-szervernél szünet után újrapróbál, és a hibás üres választ nem veszi „nincs útadat”-nak.

---

## v1.22.0 – 2026-10-29 – AI-edzéselemzés, gyorsabb burkolatvizsgálat

### Verzió

- **AI-edzéselemzés (Claude):** mentett edzésnél az Elemzés oldalon „AI-elemzés” kártya – egy gombnyomásra rövid értékelés (egy mondatos összefoglaló és 3 pont: tempó, pulzus-drift, szint, összevetés a korábbi hasonló edzésekkel), opcionális saját megjegyzéssel („regeneráló kör volt”). Az elemzés az edzéssel együtt mentődik, szerkeszthető, újrakérhető; ha az edzés később változik, jelzi, hogy elavult. A modell az összesített adatokat kapja (mozgásidős szakaszok, megállások külön), nem a nyers GPX-et.
- **AI-keret és adatvédelem:** az API-kulcs csak a szerveren van. Admin → új „AI” fül: kulcs és kapcsolatteszt, alap napi limit, felhasználónként be/ki és saját limit, napi / havi felhasználás és becsült költség. A felhasználó a Beállításokban magának is kikapcsolhatja. Kulcs nélkül sehol nem jelenik meg AI-elem.
- **Könyvtár:** a közösségi kártyákon rövid leírás, nehézség és évszak; a Körtúra / A → B választó a szűrősáv jobb oldalára került (mobilon nem kell oldalra görgetni).
- **Burkolat vizsgálata:** nagy útvonalnál sem fagy le – csak a nyomvonal sávját kérdezi le, és gyors térbeli kereséssel párosít; pontosabb is (a címke nélküli aszfaltutakat is figyelembe veszi).
- **Érthetőbb feliratok:** „Szegmensvizsgálat” helyett „Burkolat vizsgálata”, az „OSM” rövidítés helyett „térképadatok (OpenStreetMap)”, barátságosabb hibaüzenetek.

---

## v1.21.0 – 2026-10-29 – Megyénkénti minta-útvonalak, körtúra-szűrő

### Verzió

- **26 új közösségi minta-útvonal 18 megyéből:** az OpenStreetMap kerékpáros útvonalaiból (pl. Bőköz Zöldút, Őrség 6, Káli-medence kör, Budapest–Balaton, Eger–Bogács, Tour de Gát) – magasságadattal, saját leírással, nehézséggel, ajánlott évszakkal és előre kitöltött helyadattal (megye, érintett települések, kör / A → B). Forrás: OpenStreetMap közreműködők (ODbL).
- **Körtúra-szűrő:** a Könyvtár Közösségi fülén a sport-gombok mellett „Körtúra” és „A → B” kapcsoló; a körtúrák a listában, a kártyán és a térképen is jelölve.
- **Térképes könyvtár:** útvonal fölé mutatva buborék a fő adatokkal – táv, idő, szint, hely, kör / A → B, nehézség és rövid leírás.
- **Felugró ablakok kisebb kijelzőn:** a tervezés ⚙ panelje sok pontnál felfelé nyílik és görgethető; az admin és az alkalmazás felugró ablakai (pl. új útvonal betöltése) laptop-kijelzőn is kiférnek, a tartalmuk görgethető.
- **Javítás:** a grafikonon az útvonalpont neve akkor is megjelenik, ha a címkeresés később érkezik; körtúránál a rajt közelébe visszatérő pont nem ugrik a 0 km-hez.

---

## v1.20.0 – 2026-10-29 – Új kezdőoldal, Statok és Elemzés, burkolat, futó animáció

### Verzió

- **Új Kezdőlap:** gyors műveletek (Új útvonal, GPX / FIT betöltése, Könyvtár és Közösségi utak darabszámmal, Statisztikák); a legutóbbi edzés térképes előnézettel, fő számokkal, egy kattintásos Elemzéssel; „Mai / holnapi tekerés” – Open-Meteo előrejelzés a legutóbbi edzés rajtjánál (hőmérséklet, szél, lökések, eső, órás sáv) és ajánlás, merre indulj; a mentett tervek kis térképpel; összesítő a célokkal egy kártyán; forma Eddington-számmal és sorozattal; „Egy éve ezen a napon” emlék; aktivitás-naptár.
- **Új Statok:** a bal oldali sáv helyett felül fülek (Áttekintés · Napló · Rekordok · Forma · Hőtérkép · Évösszefoglaló) és egy sor szűrő (időszak – korábbi évek is –, sport). Áttekintés: fő számok a tavalyihoz mért változással, évek összehasonlítása (halmozott km, egymásra rajzolva), melyik napon és napszakban tekersz, heti km az utolsó 52 hétre átlagvonallal, táv-eloszlás, sportágak, mérföldkövek. Napló: könnyű hónapnaptár (a km-mel arányos körök), alatta a havi táblázat. Forma: edzésterhelés és Eddington egy helyen. Új Évösszefoglaló: az év egy oldalon, szemléletes hasonlatokkal, havi oszlopokkal, legaktívabb hónap, leghosszabb túra, kedvenc nap, legtöbbet járt hely – és sztori méretű megosztó kép.
- **Elemzés asztalon:** név és ⋯ menü (GPX, megosztás / PDF, trackpontok, bezárás), négy fő szám és halk sor a többi adattal (pulzus és kadencia átlag / max, TRIMP, Edwards), Mentés / Tervezés gomb; a 4–5 kapcsolós blokk helyett egy „Térkép színezése” választó, alatta új zónaeloszlás-sáv (pulzuszónák, illetve sebesség-, kadencia-, teljesítményzónák); grafikonok chipekkel. Mobilon a műveletek a színezés fölé kerültek, és ott is megjelenik a zónasáv.
- **Burkolat a tervezésben:** az „Útvonal színezése → Burkolat” mutatja, milyen utakon vezet az útvonal (aszfalt, murva, földút, ösvény – arányban, km-ben és a térképen). Tervezett útvonalnál azonnal (az útvonaltervező adataiból), importált GPX-nél OSM-lekérdezéssel – időkorláttal és tartalék szerverrel.
- **Futó animáció:** apró fehér jelek futnak az útvonalon a haladás irányába (tervezésnél és elemzésnél is); a tervezés ⚙ paneljében és a Beállításokban kapcsolható, az útirány-nyilakkal együtt.
- **Grafikon:** útvonalpont közelében a buborék a pontra ugrik, és mutatja a nevét (importált útvonalnál is a köztes pontokkal).
- **Térképi buborék:** az emojik helyett vonalas ikonok, félkövér értékek.
- **Körtúra importált nyomvonalnál** (pl. Elemzés → Tervezés): a nyomvonal megmarad – közeli célnál a cél a rajtra kerül, távolinál a visszaút hozzátervezve, két pontnál egy fordulópont is bekerül; kikapcsolva visszaáll.
- **Javítások:** importált útvonal megfordításakor a vonal, a km-jelölők, az irány és az animáció is megfordul; „Rajt” és „Cél” a „Start” / „Finish” helyett (régi mentéseknél is); a könyvtárban a tegnap délutáni edzés nem „Ma”; a tervek nem kapnak „nem számít bele” jelölést; nem szerepel kétszer a teljesítmény; a lebegő menü összecsukva kis gomb marad.
- **Súgó és bemutató oldal:** az új funkciókkal frissítve, új képernyőképekkel (demó adatokkal).

---

## v1.19.0 – 2026-10-29 – Letisztultabb tervezés és könyvtár

### Verzió

- **Tervezés oldalsáv átrendezve:** felül „Útvonal” cím ⋯ menüvel (GPX importálása, Irány megfordítása, Oda-vissza út, Mentés/megosztás, Útvonal törlése), alatta „Pontok” a tervezési mód kis választójával, majd a pontlista. A pontok alatt a kereső, mellette a Körtúra kapcsoló és egy ⚙ gomb: ebben a ritkán állított beállítások (Útra illesztés, Szakasz infó, szintadat és szélhatás az időbecsléshez). A statok dobozok nélkül, tömören. Mobilon ugyanez a lapban nyílik („Beállítások”), üres útvonalnál csak a kereső és a módválasztó látszik.
- **Útvonal színezése:** a Szintprofil és Szélelemzés nagy blokkjai helyett egy választó (Nincs · Szintprofil · Szélelemzés); szélelemzésnél rögtön lenyílik az indulási idő és a sebesség.
- **„GPX köztes pontok”:** a kapcsoló kikerült a tervezésből (csak az Elemzés fájlbetöltésére hat) – a Beállítások menüben állítható.
- **Könyvtár szűrők a lista fölött:** a bal oldali szűrősáv helyett típusfülek darabszámmal (Összes · Edzés · Terv · Közösségi), kereső és sportchipek; a Forrás, Távolság, Edzésidő (és közösségi útvonalaknál a Helyszín) a „Szűrők” gombban, rajta az aktív szűrők száma, mellette „Törlés”. Rendezés az oszlopfejlécekkel. Mobilon a Szűrők alsó lapként nyílik.
- **Könyvtár lenyitott sora:** térképes előnézet (halvány alaptérkép, vékony vonal fehér kontúrral, zöld rajt), négy fő szám és egy halk sor a többi adattal; két fő gomb (Elemzés, Tervezés), Megosztás és ⋯ menü (GPX, Strava, Garmin, közösbe küldés, Szerkesztés, Törlés); „Beleszámít a statisztikába” kapcsoló. A kártyanézet kis előnézetei is térképesek.
- **Könyvtár lista:** a forrás halk felirat a színes címke helyett, a tervek mellett „terv” jelölés, a statisztikából kizárt sorok halványak; a színes bal szegély megszűnt.
- **Javítás:** a lebegő szerkesztő menü összecsukva nem nyúlik magas, üres oszloppá.

---

## v1.18.0 – 2026-10-28 – Megújult mobil nézet

### Verzió

- **Tervezés mobilon – alsó lap az Apple Térkép mintájára:** a lap tetején összefoglaló: kereső, nagy számok (táv, becsült idő, emelkedés) kis „Mentés” gombbal, mini szintprofil (koppintásra a nagy diagram), szürke szegmentált módváltó, Körtúra kapcsoló és ikonos eszközsor (Szintprofil · Fordítás · Oda-vissza · Szél · Törlés). Lejjebb húzva a pontlista, majd a beállítások. A lebegő eszköztár mobilon eltűnt; helyette a térkép jobb szélén Visszavonás / Újra gombpár. Keresés közben a lap felugrik, hogy a találatok látsszanak.
- **Pontkártya mobilon:** pontra koppintva buborék helyett a lap a pont kártyáját mutatja (a lap akkora, mint a kártya, a pont kiemelve és látható helyre görgetve); szakaszmód-váltáskor nyitva marad és frissül; bezárás ×-szel vagy a térképre koppintva.
- **Elemzés mobilon:** összefoglaló a lap tetején: név, dátum, három fő szám (a harmadik a színezett adat átlaga), húzható mini szintprofil (a térképen mozog a pont, buborékban km, magasság, pulzus, kadencia, watt), „Térkép színezése” választó (Nincs · Sebesség · Pulzus · Kadencia · Teljesítmény · Szint), ikonos műveletek és grafikon-választó. A 16 adatdoboz helyett tömör kétoszlopos lista. A mérőszámok egy közös listából épülnek – új szenzor esetén csak ott kell felvenni, és csak az adott edzés meglévő adatai jelennek meg.
- **Könyvtár mobilon:** a lenyitott sor tíz nagy gombja helyett 5×2-es ikonrács rövid feliratokkal; a kártyanézet gombjai visszafogottabbak.
- **Egységesebb mobil megjelenés:** Statok aláhúzásos fülsorral és doboz nélküli számokkal, Kezdőlap Forma/Sorozatok számai doboz nélkül, tömörebb Beállítások-sorok, mobilon rejtve a felesleges „Eszköztár sorrend” és „Billentyűparancsok”, a rekordkártyákról lekerült az ismétlődő „Első rekord…” szöveg, „Gyalogos” helyett mindenhol „Túra”; a szintprofil fejléce mobilon tördelődik (nem lóg ki); a mentés ablak címe „Útvonal mentése”.

---

## v1.17.0 – 2026-10-22 – Körtúra kapcsoló, „Rajt ide”, új útvonalpont-ablak

### Verzió

- **Körtúra kapcsoló a tervezésben:** a rajt (és a cél) ablakában, valamint az Útvonal beállításai között „Körtúra” kapcsoló – bekapcsolva az útvonal mindig visszaér a rajthoz: a végére kerül a rajt, az új pontok a visszaút elé szúródnak be, a rajt elhúzásakor a cél is vele mozog, a rajt törlésekor a következő pont lesz a rajt és a cél. Zárt körnél a célzászló nem takarja el a rajtot („Rajt és cél”). A célpont ablakában a „Visszaút a rajthoz” gombot ez a kapcsoló váltja.
- **Körtúra indítása bármelyik pontról:** körtúránál (a cél a rajttól 300 m-en belül) a köztes pontok ablakában „Rajt ide” gomb – a kör ettől a ponttól indul és oda ér vissza; a pontok sorrendje körbefordul, a szakaszmódok a helyükön maradnak, importált GPX-nyomvonalnál a nyomvonal is elfordul (nem tervez újra). Tetszőleges helyhez: kattintás az útvonalra (köztes pont), majd Rajt ide. Visszavonható.
- **Letisztultabb útvonalpont-ablak:** nagyobb cím, alatta halvány koordináta másolás ikonnal, vonalas ikonok emoji helyett, címke–érték sorok. A következő szakasz módja egyetlen szürke, szegmentált kapcsoló (Alap / Aszfalt / Gravel / MTB / Túra) – a kiválasztottnál a felirat alatt kis csík jelzi a szakasz színét. Puha, ikonos gombok (Visszaút, Oda-vissza, Pont törlése). Telefonon tömörebb, és amíg nyitva van, a felhúzható lap a legkisebb állásba megy, a térkép pedig úgy görget, hogy az ablak teljesen látsszon (bezáráskor a lap visszaáll).

---

## v1.16.0 – 2026-10-22 – Egységes diagramok, új útvonalpont-ablak

### Verzió

- **Egységes, letisztult diagramok:** mind a hat grafikon (szintprofil, sebesség, pulzus, kadencia, teljesítmény, szél) új, közös rajzolót és fejlécet kapott. A fejlécben a fő számok nagyban (szintprofilnál táv, becsült idő, emelkedés, ereszkedés, legmagasabb pont, nehézség és a tempó – utóbbira kattintva a tervezési sebességek állíthatók), szaggatott rácsvonalak, a táv szerint igazodó km-feliratok, halvány kitöltés a vonal alatt. A „Zónaszín” gombbal egy kattintással váltható az egyszínű és a zóna/lejtés szerinti színezés, jelmagyarázattal. A rámutatás minden nyitott diagramon ugyanannál a km-nél látszik, a címke csak azon, amelyik fölött az egér van. Tervezésnél a rajt (A), cél (B) és a közbenső útvonalpontok a diagramon is jelölve.
- **Szél grafikonon:** a szélelemzés eredménye a többi diagrammal egyező grafikonon is látszik (szélerősség a táv mentén, hát-/oldal-/szembeszél szerint színezve), fejlécben az arányokkal; a szakaszlista lenyitható részletként.
- **Megosztott oldal diagramjai:** a nyilvános nézőoldal (link / QR) ugyanazokat a diagramokat használja, mint az alkalmazás – egyező színekkel, összehangolt rámutatással és térképjelölővel.
- **Új útvonalpont-ablak:** a pontra kattintva rendezett kártya jelenik meg: rajttól mért táv (becsült idő, emelkedés), magasság, meredekség színjelöléssel, célig hátralévő táv, másolható koordináták. Innen átnevezhető, megjegyzés írható hozzá, a következő szakasz tervezési módja egy kattintással váltható, a célnál a visszaút / oda-vissza is indítható, és a pont törölhető.
- **Egyszínű mód mindenhol szürke:** az „Egyszínű” diagrambeállítás mind a hat grafikont egységes, semleges szürkével rajzolja – az Elemzés fülön, a megosztó képen és a PDF útvonallapon is (a diagramonkénti színválasztók megszűntek). Zónaszín módban marad a színes zóna-/lejtésszínezés.
- **Átméretezhető diagrampanel:** a térkép alján nyíló grafikonpanel felső fogantyújával a panel magasabbra húzható (több nyitott diagram is kifér), a magasság megmarad; dupla kattintás: alaphelyzet. A diagramok nem nyomódnak össze, a panel szükség esetén görget. A tervező eszköztár, a térkép +/− gombjai és a „Kattints a térképre” felirat a nyitott panel fölé csúszik.
- **Megosztott oldal:** a diagramok fejlécének végén Egyszínű / Zónaszín váltó (jelmagyarázattal), és a térkép alatti fogantyúval a grafikonok magassága állítható.
- **Megosztó kép grafikonjai:** az új diagramstílusban – félkövér szám kis mértékegységgel, szaggatott rács, elhalványuló kitöltés.
- **Könyvtár lenyitott sora:** a statok a diagramfejlécek stílusában (nagy szám, kis mértékegység, halvány felirat, dobozok nélkül), egységes, lekerekített gombok.
- **Útvonal a térképen:** vékonyabb vonal fehér körvonallal; elemzésnél a Bringaterv saját színével (nem a tervezési mód színével).
- **Javítás:** nyitott diagrampanelnél a PDF- és más ablakok nem kerülnek a grafikonok mögé; mobilon a térkép forrásmegjelölése nem lóg a panelre.
- **Megosztott link, ami már nem él:** a nyilvános nézőoldal (link / QR-kód) üres félmondat helyett rendes hibaoldalt mutat: „Ez a megosztott útvonal vagy edzés már nem elérhető” magyarázattal, „Mi a Bringaterv?” és „Belépés” gombbal. Külön üzenet jön, ha a szerver épp nem érhető el („Újrapróbálom” gombbal – nem tűnik töröltnek), és ha a link hiányos. Bejelentkezve egy törölt útvonal mélylinkjénél is pontos üzenet jelenik meg.

---

## v1.15.0 – 2026-10-22 – Meghívó e-mailben

- **Meghívó e-mailben (admin):** az új meghívónál megadható a jelentkező e-mail-címe – ilyenkor a meghívó egyszer használható, és a „Létrehozás és küldés” gombbal a Bringaterv HTML-levélben ki is küldi („Regisztrálok” gomb, lejárat). A regisztrációs oldalon a cím előre kitöltve; ha a meghívott ezzel a címmel regisztrál, a cím rögtön igazolt (nincs megerősítő kód). A meghívók listájában látszik a cím és a küldés ideje, aktív meghívónál „Újraküldés”. Adatbázis-migráció: v14.

### Verzió
- v1.14.0 → v1.15.0

---

## v1.14.0 – 2026-10-22 – Statok mobilon, Strava-beállítás képes leírással

- **Strava-beállítás képes leírással:** a súgóban lépésről lépésre, képernyőképekkel, hogyan hozz létre saját Strava API-alkalmazást (mezőnként mit írj be, ikon, Client ID / Secret), mit tegyél, ha már van alkalmazásod, és hogyan töltsd fel kézzel az edzéseket, ha a kapcsolat nem sikerül. A Bringaterv „Strava API beállítás” ablaka is megújult: a Strava űrlapjába írandó értékek (Website, Callback Domain, Category, Description) **másolás gombbal**, link a képes leírásra, letölthető logó az ikonhoz; a haladó visszatérési cím felülírás becsukva.
- **Statok mobilon – felső fülsor:** a nézetválasztó (Áttekintés, Havi, Rekordok, Eddington, Edzésterhelés, Hőtérkép) és a szűrők (Időszak, Sporttípus) a felcsúszó alsó lap helyett a Statok tetejére kerültek: vízszintesen görgethető fülsor + szűrősor, görgetéskor is látható; a kiválasztott fül középre görgetődik. Gépen változatlanul a bal oldali sávban.
- **Edzésterhelés:** a bevezető magyarázat becsukható („Hogyan számoljuk?”), az időszakválasztó közvetlenül a grafikonok fölé került „Grafikonok időszaka” felirattal (a kártyák mindig a mai állapotot mutatják); mobilon a kártyák 2 oszlopban, a hosszú leírások ⓘ mögött.
- **Havi statisztikák mobilon:** kártyás elrendezés (hónap fent, az értékek rácsban felirattal, rövid időformátum) a kilógó táblázat helyett. Javítva: újrarajzolás után a hónap lenyitása nem működött.
- **Áttekintés:** a km teljes számmal („5 755 km” az „5,8 e km” helyett), az összes idő órában („283 óra”), mobilon a nagy számok egy sorban maradnak; a grafikonok tengelyfeliratai egységesek.
- **Eddington mobilon:** a nagy szám és a magyarázat egymás alatt.

### Verzió
- v1.13.3 → v1.14.0

---

## v1.13.3 – 2026-10-21 – Javítás: térkép az Elemzésben

- **Javítás – üres / elcsúszott térkép az Elemzésben:** mióta az app a Kezdőlappal indul, a térkép rejtve volt, és a Kezdőlapról átváltva nem töltötte be a csempéket, illetve az első betöltött útvonal elcsúszva, rossz nagyítással jelent meg. A térkép most fülváltáskor újraméri magát, a keskeny és széles oldalsáv közti váltás nem animál, és a betöltés előbb vált fület, csak utána rajzol.

### Verzió
- v1.13.2 → v1.13.3

---

## v1.13.2 – 2026-10-21 – Frissített bemutató oldal

- **Bemutató oldal („Mi ez?”):** új „Kezdőlap” és „Közösség” szakasz képernyőképpel (összesítő, forma, sorozatok, célok, aktivitás-naptár; közösségi útvonalak térképen, helyszín szerinti szűrés, beküldés névvel / becenévvel / névtelenül), a Könyvtárnál a térképes nézet és a helyszín-szűrés, a megosztásnál a megosztó kép stílusai, hátterei és grafikonjai; frissített bevezető és menü.

### Verzió
- v1.13.1 → v1.13.2

---

## v1.13.1 – 2026-10-21 – Szebb gombok az útvonal betöltésénél

- **Útvonal betöltése (Tervezés) – szebb gombok:** vizsgálat előtt egyetlen, teljes szélességű „Betöltés” gomb (nincs halvány, letiltott gomb); a szegmensvizsgálat után két egyforma gomb egymás mellett: „Csak betöltés” és „Betöltés burkolat szerint” (ez utóbbi az útburkolat alapján szakaszonként beállítja a tervezési módot).

### Verzió
- v1.13.0 → v1.13.1

---

## v1.13.0 – 2026-10-21 – Kezdőlap

- **Kezdőlap fül** (a fülsor elején; indításkor ez nyílik, kivéve mélylinknél): gépen a térkép helyén, teljes szélességben, mobilon teljes képernyőn. Köszönés keresztnévvel; négy gyors indítás – útvonal tervezése (a keresőre ugrik), edzés elemzése (fájlválasztó), közösségi utak (Könyvtár a Közösségi szűrővel), statisztikák. Kártyák az edzésadatokból: **összesítő** (e hét, a hónap, az év – km, edzésszám, szint, idő), **forma** (fittség / fáradtság / forma, a Statok edzésterhelése alapján), **sorozatok** (egymást követő napok, hetek, hónapok edzéssel), **Eddington-szám** a következő céllal, **Céljaim** – saját célok a „Beállítás” gombbal (heti táv, éves táv, éves szint; a szerverrel szinkronizálva, minden eszközön ugyanaz), ami nincs megadva, ahhoz automatikus cél (a következő kerek szám); soronként „mostani / cél · %”, a csík 0-tól a célig mér, éves saját célnál jel mutatja az időarányos állást és hogy mennyivel jársz előtte / mögötte, **aktivitás-naptár** (gépen az elmúlt év, mobilon 18 hét), és a **legutóbbi 6 elem** egy kattintással betölthetően. A „Részletek →” linkek a Statok megfelelő nézetére visznek. A Forma, Sorozatok, Eddington, Célok és Aktivitás kártyák címe mellett ⓘ súgó magyarázza, mit mutat a kártya; 5-nél kevesebb edzésnél a Forma és az Eddington kártyán „néhány edzés után lesz pontos” megjegyzés áll. Ha még nincs edzés, rövid útmutató áll a kártyák helyén.
- **Tervezés – kezdő felirat a térképen:** amíg nincs pont, a térkép közepén halvány, pulzáló „Kattints a térképre a rajtponthoz” (mobilon „Koppints…”) jelzés.

### Verzió
- v1.12.0 → v1.13.0

---

## v1.12.0 – 2026-10-21 – Megosztó kép stílusok és grafikonok, könyvtár térképnézet

- **Megosztó kép – stílusválasztó:** a megosztó kép ablakban külön választható a **stílus** (kis rajzolt előnézettel) és a **háttér**. Stílusok: *Adatpanel* (a korábbi: térkép felül, adatok alul panelen) és az új *Térképen* (az adatok fehér betűkkel, alul sötét átmeneten, közvetlenül a térképen; vékony, elegáns nyomvonal; álló képen két oszlopban nagy számok). Háttér: Világos, Sötét, az új **Terep** (zöld, domborzatos térkép) vagy Fotó – bármelyik stílussal kombinálható. A választott stílust a böngésző megjegyzi; a lista később bővíthető.
- **Megosztó kép – választható grafikonok:** a szintprofil mellé (vagy helyett) **sebesség, pulzus, kadencia és teljesítmény** csík is kérhető – legfeljebb három, egymás alatt, mindegyik felett a neve és az összegzése (szintnél max/min, a többinél átlag/max). Csak az jelenik meg a választóban, amihez az edzésben van adat; a választást a böngésző megjegyzi. A szenzoradat enyhén simítva kerül a képre, a kilógó csúcsok nem torzítják a skálát.
- **Megosztó kép – vékonyabb nyomvonal** az Adatpanel stílusban is, kisebb rajt- és célponttal.
- **Megosztó kép – finomítások:** kis „SZINTPROFIL” felirat a csík fölött (és a többi grafikon neve), kb. 15%-kal nagyobb „Bringaterv” jelvény.
- **Megosztó kép – finomabb betűk:** az adatsor számai keskeny, sportos számbetűvel (Barlow Semi Condensed) jelennek meg a vastag, kerek Inter helyett; a mértékegységek és a feliratok könnyebbek, a cím Inter félkövér a nehéz Montserrat helyett. Az elrendezés változatlan.
- **PDF – „Terep” térkép:** a PDF útvonallap térképstílusai közé bekerült a megosztó kép zöld, domborzatos Terep térképe.
- **Könyvtár – térképes nézet** (harmadik nézet a kártya és a lista mellett): a szűrt elemek nyomvonala egy térképen, színnel jelölve (edzés / útvonal / közösségi). Rámutatva kiemelődik és kiírja a nevét; kattintásra felugró lista az ott futó összes elemmel (név, dátum vagy helyszín, táv, szint), „Elemzés” / „Tervezés” gombbal és a „⋯” menüvel. A szűrők itt is működnek, a nézet a szűrés változásakor igazodik.
- **Admin – Közösségi útvonalak:** új „Helyszín” oszlop (település, megye, ország, körtúra / A → B), soronként „↻ Hely” gomb a kézi újraszámoláshoz. A szerkesztő ablakban minden adat szerkeszthető, mint beküldéskor: nehézség, ajánlott évszak, megjelenő név, helyszín (ország, régió, település, érintett települések, körtúra) – „Újraszámolás” gombbal. Új útvonal feltöltésekor a helyadat magától kiszámolódik.

### Verzió
- v1.11.0 → v1.12.0

---

## v1.11.0 – 2026-10-21 – Közösségi útvonalak, helyszín-szűrés, könyvtár-menü

- **Könyvtár, kártyás nézet:** a kártyán „Elemzés” / „Tervezés” betöltő gomb és egy „⋯” gomb, ami menüt nyit az összes művelettel (eddig csak a lista nézetben voltak elérhetők): betöltés a másik nézetbe, megosztás, GPX / FIT letöltés, Strava-frissítés és -megnyitás, Garminra küldés, statisztika-kapcsoló, szerkesztés, és a menü alján a törlés. Gépen a gomb mellett nyílik, mobilon alulról. A kártya és a lista ugyanazt a műveletkészletet használja.
- **Közösségi útvonalak** (a korábbi „Minta” útvonalak új neve): a felhasználók egy mentett útvonalat vagy edzést **beküldhetnek** a könyvtár „⋯” menüjéből vagy a lenyitott sorból, egy kötelező űrlappal (név, leírás, típus, nehézség, ajánlott évszak, beküldőként névtelenül / saját névvel / becenévvel). Csak a nyomvonal és a szint kerül át. Az admin push- és e-mail-értesítést kap; az admin felület új **Beküldések** fülén nyomvonal-előnézettel látja, a leírást és az adatokat szerkesztheti, majd **jóváhagyja** (→ megjelenik a Közösségi útvonalak között) vagy **elutasítja** indoklással. A beküldő mindkét esetben értesítést kap. A lenyitott sorban a nehézség, az évszak és a beküldő is látszik. Adatbázis-migráció: v11, v13 (becenév).
- **Helyadat a közösségi útvonalakhoz**: ország, régió / megye, rajt települése, érintett települések, érintett országok, körtúra vagy A → B – automatikusan a nyomvonalból (OpenStreetMap / Nominatim, magyar nevekkel, 1 kérés/mp, gyorsítótárral). Beküldéskor a háttérben számolódik, az admin jóváhagyás előtt javíthatja; a meglévőkhöz „Helyadatok pótlása” gomb. A Könyvtár Közösségi nézetében **Régió / megye** (és több országnál **Ország**) választó, **Körtúra / A → B** szűrő, a kereső a településekben is keres; a kártyán a település és a megye, a lenyitott sorban a teljes helyadat látszik. Adatbázis-migráció: v12.
- **Hőtérkép:** alapból csak a rögzített edzések látszanak; a tervezett útvonalak a „Tervezett útvonalak is” kapcsolóval kapcsolhatók be. Az edzés / útvonal megkülönböztetés a fájl tartalmán alapul (Strava / Garmin / FIT forrás, vagy időbélyeges nyomvonal), így a régebben rosszul jelölt elemek is jó helyre kerülnek. A számláló külön mutatja az edzéseket és az útvonalakat.

### Verzió
- v1.10.0 → v1.11.0

---

## v1.10.0 – 2026-10-18 – Új megosztó kép és megosztás ablak

- **Új megosztó kép**: valódi térkép (világos / sötét) a nyomvonal alatt, fehér körvonalas narancs útvonal, zöld rajt- és célpont; kis „Bringaterv” jelvény a sarokban a nehéz fejléc helyett; alul adatpanel nagy címmel, dátummal, **szintprofil-csíkkal** és nagy számokkal (táv, idő 1:05 formában, átlag, szint – ami nincs, kimarad). A Fotó téma ugyanezt az elrendezést kapta.
- **QR-kód a megosztó képen** (kapcsolható): ha az útvonalnak van nyilvános linkje (könyvtárban mentett elem), egy kis QR-kód kerül az adatpanel jobb felső sarkába, ami a nézőoldalra visz.
- **Megosztás ablak**: a csatornák (Facebook, WhatsApp, Telegram, X, e-mail…) egyforma, egyszínű kör-ikonok kis felirattal (mobilon vízszintesen görgethetők); a „Másolás” gomb és a Megosztó kép / PDF kártyák az app többi gombjához igazodnak.
- **Megosztó kép ablak**: nagyobb előnézet, szegmentált téma- és méretválasztó, egységes „Letöltés” / „Megosztás” gombok egymás mellett; mobilon alulról nyílik.

### Verzió
- v1.9.1 → v1.10.0

---

## v1.9.1 – 2026-10-18 – Bemutató oldal, kapcsolati cím, egyszerűbb Névjegy

- **Bemutató oldal** (`/bemutato`): mit tud a Bringaterv – tervezés, tárolás, elemzés (milyen elemzések), statisztikák és rekordok, mobil / telepíthető app, Strava, Garmin, megosztás, csatlakozás; asztali és mobilos képernyőképekkel, telefonon is olvasható. Bejelentkezés nélkül elérhető.
- Belépő oldal: a logó és egy „Mi ez?” link a bemutató oldalra visz.
- **Névjegy** egyszerűsítve: logó, verzió, Súgó / Hibajelentés / Adatkezelés, a fejlesztő képpel. Kikerült a GitHub-link, a bejelentkezett felhasználó és a szerveradatok; a frissítési állapot csak adminnak látszik.
- **Push értesítés:** ha a domain mögött kicserélődik a szerver (más VAPID-kulcs), az app engedélyezéskor magától újra feliratkozik (eddig a régi feliratkozás csendben nem működött).
- **Kapcsolati e-mail-cím** (`CONTACT_EMAIL`, a `bringaterv` és a `routes-api` konténernél): megjelenik a bemutató oldalon, a Névjegyben és az adatkezelési tájékoztatóban; a kimenő levelek láblécében a „ne válaszolj” helyett ez áll, és a válaszok ide mennek (Reply-To).
- Adatkezelési tájékoztató: a fiók törlése már a felhasználónak is elérhető (Beállítások → Fiók).

### Verzió
- v1.9.0 → v1.9.1

---

## v1.9.0 – 2026-10-18 – Admin felület, meghívók, e-mail (megerősítés, elfelejtett jelszó, fióktörlés), visszajelzések

### Fiók, e-mail-megerősítés, elfelejtett jelszó
- **Elfelejtett jelszó** a belépő oldalon (`/reset`): e-mailben küldött, egyszer használható, 60 percig érvényes link; csak megerősített címre (vagy ha a belépési név maga az e-mail-cím). Óránként legfeljebb 3 kérés fiókonként; a válasz nem árulja el, létezik-e a fiók.
- **Megerősítés 6 számjegyű kóddal**: a levélben kód (15 perc, max. 5 próbálkozás) és link (48 óra) is van; a kódot az app ablakában kell beírni (iPhone-on a billentyűzet felajánlja, 6 jegynél magától beküldi) – nem kell ablakot váltani.
- **Kötelező e-mail-megerősítés** (ha a szerveren van e-mail-küldés): a meg nem erősített, nem admin felhasználó belépés után záróablakot lát, a szerver addig csak a fiók-végpontokat szolgálja ki. Megerősítő link (`/verify`): 48 óra, egyszer használható. Kikapcsolható: `REQUIRE_EMAIL_VERIFICATION=false`.
- **Saját fiók törlése** (Beállítások → Fiók, admin kivételével): ok kiválasztása + megjegyzés, adatmentés letöltése előtte, jelszavas megerősítés; minden adat törlődik (Strava webhook és hozzáférés is). Az ok „Fióktörlés” visszajelzésként az adminhoz kerül (push + e-mail), a felhasználó visszaigazoló levelet kap.
- **Beállítások → Fiók** (új): belépési név, e-mail-cím állapotjelzéssel (megerősítve / vár / nincs), megerősítő levél újraküldése, saját jelszó cseréje.
- **Jelszócsere után** (felhasználó, admin vagy visszaállító link) minden korábbi belépés érvénytelen – a többi eszközön újra be kell lépni.
- Meghívóval csak e-mail-címmel lehet regisztrálni; a megerősítő levél azonnal kimegy.
- Admin: a felhasználók listájában látszik az e-mail-cím állapota; a Szerkeszt ablakban megadható / kézzel megerősítettnek jelölhető.
- A tokenekből csak SHA-256 lenyomat kerül az adatbázisba (`auth_tokens` tábla).

### Üzenetek, e-mail megjelenés
- **Üzenet a felhasználóknak** az admin felületről: push és/vagy e-mail egy felhasználónak (sorában az „Üzenet” gomb) vagy minden aktív felhasználónak („Üzenet mindenkinek”). Az ablak mutatja, hány eszközön van engedélyezett push és kinek van e-mail-címe; küldés után összesít. Mindenki külön levelet kap.
- **Új, igényes HTML e-mail sablon** minden levélhez (megerősítő kód, új jelszó, visszajelzés, teszt, admin üzenet): beágyazott logó, kártyás elrendezés, nagy kódmező, narancs gomb; a sima szöveges változat is megmarad.

### Hibajelentés, ötlet (visszajelzés)
- **☰ → Hibajelentés, ötlet** (és a Névjegyből): típus (Hiba / Ötlet / Kérdés / Egyéb), érintett terület (alapból az aktuális nézet), cím, leírás, opcionális képernyőkép (max. 8 MB), technikai adatok (verzió, böngésző, képernyő, nézet – a felhasználó látja és kikapcsolhatja). Mobilon is kényelmes.
- A visszajelzés az adatbázisba kerül, az adminok push értesítést kapnak, és ha be van állítva, **e-mailben** is megérkezik (kép csatolmányként, válaszcím a beküldő). Felhasználónként óránként max. 10.
- **Admin → Visszajelzések** fül: új / kész / mind szűrő, számláló a fülön, képernyőkép megtekintése, technikai adatok, „Kész” jelölés, válasz e-mailben, törlés, e-mail-beállítás állapota és **Teszt e-mail** gomb.
- Új e-mail-küldő modul (SMTP, STARTTLS / SSL), beállítás környezeti változókkal.

### Admin felület
- Külön címen: **`/admin`**, mobilbarát (a táblázatok kártyákká alakulnak, az ablakok alulról nyílnak); fülek: Felhasználók / Meghívók / Visszajelzések / Minta útvonalak / Súgó.
- **Felhasználó törlése**: megerősítéshez be kell írni az e-mail-címét; saját magad és az utolsó aktív admin nem törölhető; a Strava-hozzáférés visszavonása és az összes adat törlése.
- **Meghívók**: szerepkör, érvényesség (1–90 nap), használatszám (1–50), opcionális kvóta; QR-kód, link másolása, megosztás, e-mail, WhatsApp, Messenger; visszavonás. A meghívó oldalán nem jelenik meg a meghívó neve és a megjegyzés.
- **Regisztráció meghívóval** (`/invite`): az adatkezelési tájékoztató elfogadása kötelező.
- **Admin súgó** az admin felület saját Súgó fülén (a fő súgóban nincs admin fejezet): felhasználók, szerepkörök, meghívók, visszajelzések és e-mail-beállítás, e-mail-megerősítés, backup.

### Backup / visszaállítás
- **Javítva:** „Hozzáadás” módban visszatöltött útvonalak nem voltak megnyithatók / törölhetők (érvénytelen azonosítót kaptak).
- „Hozzáadás” módban a már meglévő elemek kimaradnak (Strava-azonosító, egyébként név + dátum + táv alapján) – kétszer betöltve sem duplikálódik.
- „Teljes felülírás” előtt automatikus mentés készül a szerveren (`pre_restore.zip`); nem Bringaterv-mentés ZIP-et elutasít (korábban egy rossz ZIP is mindent törölt).
- A mentés tartalmazza az értesítési beállításokat és a törölt Strava-edzések listáját (a Strava-tokenek szándékosan nem).
- Visszaállításnál a feltöltési korlát 100 MB (a többi API-hívásnál 10 MB marad).

### Biztonság
- **Javítva:** ha a `JWT_SECRET` nincs megadva vagy a példaérték maradt, bárki hamisíthatott belépést. Ilyenkor a szerver most első induláskor erős véletlen kulcsot generál és eltárol (`/data/jwt_secret`), a párhuzamosan induló workerek is biztosan ugyanazt olvassák. A kulcscsere egyszeri kiléptetéssel jár.

### Mobil, felület
- **Névjegy** (☰ → Névjegy, és a menü alján a verziószám): verzió, frissítés-ellenőrzés, futtatási mód, linkek – mobilon is.
- Mobilon a szél-adat bekapcsolásakor nem tűnik el a térkép (a diagram-panel magassága korlátozott, a térkép újraigazodik).
- Mentés (export) ablak mobilon: görgethető, a gombok mindig látszanak.
- **Javítva:** az Elemzésnél a fájlválasztóval (nem húzással) megnyitott FIT fájl nem töltődött be, telefonon sem.

### Konfiguráció (új környezeti változók)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `FEEDBACK_TO` – e-mail-küldés.
- `PUBLIC_URL` – a levelekben lévő linkek alapcíme (erősen ajánlott).
- `REQUIRE_EMAIL_VERIFICATION` – kötelező-e az e-mail-megerősítés (alapból igen, ha van e-mail-küldés).
- Adatbázis-migrációk: v7 (meghívók), v8 (visszajelzések), v9 (e-mail-megerősítés, jelszó-visszaállító tokenek), v10 (megerősítő kód) – induláskor maguktól lefutnak.

### Verzió
- v1.8.0 → v1.9.0

---

## v1.8.0 – 2026-10-17 – Kézikönyv, jelmagyarázat a térképen, színezés a megosztott nézetben, Strava webhook

### Súgó és kézikönyv
- Új **☰ → Súgó és kézikönyv** oldal (`help.html`): menüpontonkénti leírás – tervezés és tervezési módok, elemzés, könyvtár, megosztás, statisztikák és rekordok, Strava (app létrehozása, kézi és automatikus import, webhook), Garmin, értesítések, összes beállítás, pulzuszónák és képletek, billentyűparancsok, adatmentés, GYIK.
- Tartalomjegyzék (mobilon lenyitható), kereső kiemeléssel, fejezetlinkek (pl. `help.html#strava`), világos/sötét téma.

### Térkép és megosztás
- **Jelmagyarázat a térképen** (Elemzés, Tervezés): a színezett útvonal sávjai a térkép sarkában, a saját zónabeállítások szerint; koppintásra összecsukható.
- **Nyilvános nézőoldal**: az útvonal a térképen is színezhető (sebesség, pulzus, kadencia, teljesítmény, lejtés) – a sorok és kapcsolók ugyanúgy néznek ki és működnek, mint az Elemzésben (kapcsoló = színezés, diagram gomb = grafikon). Páratlan kártyaszámnál az utolsó kitölti a sort.
- **Diagramok érintéssel**: ujjal vízszintesen húzva a térképen is mutatja a pontot (eddig csak egérrel).

### Strava
- **Azonnali import (webhook)**: a Strava maga szól az új edzésről – másodperceken belül importál és értesít; átnevezéskor a könyvtárban is frissül a név. Feltétel: nyilvános HTTPS-cím; egy Strava apphoz egy webhook. Az időközös ellenőrzés tartalékként fut tovább.
- **Törölt edzések visszatöltése** kapcsoló az automatikus importnál (alapból ki): bekapcsolva a szinkron a könyvtárból törölt edzést újra letölti (az elmúlt 7 napból).
- Webhook és időközös kör egyszerre sem importálja kétszer ugyanazt (felhasználónkénti zár).

### Mobil / iOS
- iPhone / iPad fájlválasztó: a FIT fájlok kiválaszthatók (az iOS az ismeretlen kiterjesztést szürkén hagyta); a kiterjesztést az app ellenőrzi.
- Bejelentkezés álló képernyőn: a kör alakú embléma a kártya fölött (eddig a széles kép közepe, levágva).
- ☰ menü: a link-menüpontok nincsenek aláhúzva.

### Verzió
- v1.7.3 → v1.8.0

---

## v1.7.3 – 2026-10-17 – Push értesítés javítás

### Értesítések
- **Javítva:** egyetlen push sem ment ki – a VAPID kapcsolati cím (`sub`) elérési utat tartalmazó https-cím volt, amit a push-könyvtár elutasít. Most `mailto:` cím: `NOTIFY_CONTACT` → `ADMIN_EMAIL` (ha e-mail) → semleges noreply cím. Az Apple push-szervere 201-gyel fogadja.

### Verzió
- v1.7.2 → v1.7.3

---

## v1.7.2 – 2026-10-17 – Értesítés-diagnosztika, Strava újraimport

### Értesítések
- A szerver eltárolja az **utolsó push-küldés eredményét** (a push-szolgáltató – pl. Apple – válaszkódját és okát), a Beállítások → Értesítések diagnosztika sora kiírja.
- A service worker feljegyzi, mikor **érkezett** utoljára értesítés az eszközre – így látszik, hogy a küldés vagy a kézbesítés akad el.
- A naplóban a sikeres küldés is megjelenik (`Push elküldve (host → kód)`).

### Strava
- Törölt, majd kézzel újraimportált Strava-edzés lekerül a tiltólistáról.

### Verzió
- v1.7.1 → v1.7.2

---

## v1.7.1 – 2026-10-17 – Javítások: értesítések, mobil ablakok, beállítások

### Értesítések
- Engedélyezéskor a service worker szükség esetén elindul (időkorláttal); ha egy lépés elakad, konkrét hibaüzenet jelenik meg (eddig csendben megállt, és nem jött létre feliratkozás).
- Diagnosztika sor: engedély · service worker · feliratkozás · telepített app / böngésző.
- „Engedély megvan, de még nincs feliratkozva” állapot külön jelezve; az Engedélyezés pótolja.
- **Próbaértesítés 5 mp késleltetéssel** visszaszámlálással – közben be lehet zárni az appot (a szerver küldi).

### Mobil
- Könyvtár → Import menü nem lóg ki a képernyőből (a gomb bal széléhez igazodik).
- Felugró ablakok (Strava import, Megosztás, Beállítások) a ténylegesen látható magassághoz és a notch / home-csík sávokhoz igazodnak – iPhone-on nem lógnak ki az alsó gombok.

### Beállítások
- Alapból minden szakasz csukva (eddig egy régi, rögzített lista miatt az újabb szakaszok nyitva jelentek meg); csak a kinyitottakat jegyzi meg.

### Megosztás
- Nyilvános nézőoldal: a kadencia és a teljesítmény diagramja is alapból látszik, ha van adat. PDF: a teljesítmény is alapból bekerül.

### Verzió
- v1.7.0 → v1.7.1

---

## v1.7.0 – 2026-10-17 – Telepíthető app (iPhone / iPad), automatikus Strava import, értesítések

### Telepíthető app (PWA)
- A Bringaterv **appként telepíthető** – App Store nélkül: iPhone / iPad: Safari → Megosztás → Főképernyőhöz adás; Android / asztali Chrome / Edge: „Telepítés” gomb.
- Saját app-ikon a logóból, teljes képernyős futás, manifest + service worker („hálózat először” – deploy után azonnal az új verzió fut, offline legalább a felület betölt).
- **„Telepítés appként”** menüpont és egyszer felugró tipp-sáv telefonon/tableten, iOS-en lépésenkénti útmutatóval.
- Biztonságos sávok (notch, home-csík), `100dvh` magasság.

### iPad és fekvő telefon
- iPad állóban és fekvőben az asztali elrendezés; álló iPaden tömörebb, egysoros eszköztár, a nagyítás-gombok fölötte.
- iPad mini álló és **fekvő telefon**: telefonos elrendezés (eddig a fekvő telefon asztali nézetet kapott görgetéssel).
- Érintőképernyőn nagyobb menü- és sávgombok.
- Javítva: keskeny térképen az eszköztár becsúszott az oldalsáv alá.

### Automatikus Strava import
- Könyvtár → Import → Strava: **Automatikus import** kapcsoló, időköz (5 / 15 / 30 perc, óránként), sportszűrő (Kerékpár / Futás / Séta / Túra), „Ellenőrzés most”, állapotsor.
- A szerver a háttérben importál (akkor is, ha nincs nyitva az app); a nyitott app frissíti a könyvtárat és szól.
- Strava API-keret figyelése (80% fölött kihagyja a kört), tiltólista és GPS nélküli edzések kihagyása, körönként max. 10 import.
- Több gunicorn worker mellett fájlzár biztosítja, hogy csak egy ütemező fusson. Kikapcsolható: `STRAVA_AUTO_SYNC=false`.

### Értesítések (push)
- Beállítások → **Értesítések**: eszközönkénti engedélyezés, próbaértesítés, eseménykapcsolók.
- Események: **új edzés importálva**, **új személyes rekord** (pl. „30 km: 1:24:36 (−5:09)”), **Strava-kapcsolat megszakadt**. Koppintásra az edzés megnyílik az Elemzésben.
- Szabványos Web Push (VAPID kulcs az első indításkor generálódik a `/data` volume-ba). HTTPS kell; iOS-en a főképernyőre telepített appból (iOS 16.4+).
- Új függőség: `pywebpush`.

### Elemzés
- Új **Kalória** kártya (Stravából, vagy becslés a kerékpáros profilból); páratlan kártyaszámnál az utolsó kitölti a sort.

### Verzió
- v1.6.0 → v1.7.0

---

## v1.6.0 – 2026-10-17 – Mobil nézet, személyes rekordok

### Mobil elrendezés
- Telefonon (768 px alatt) saját elrendezés: teljes képernyős térkép, alsó navigációs sáv (Tervezés · Elemzés · Könyvtár · Statok), az oldalsáv tartalma alulról felhúzható panelben (4 magasság, húzással vagy koppintással).
- Tervezés telefonon is: keresés, útvonalpontok, eszköztár a panel fölött; a térkép az útvonal illesztésénél figyelembe veszi a panelt.
- Könyvtár lista nézet mobilon: második sor (táv · idő · szint), lenyitható részletek.
- Elemzés üres állapot: azonnal látható betöltés gomb.
- Javítva: az eszköztár „pontok” fogantyújára koppintva eltűnt az eszköztár.

### Személyes rekordok (új oldal)
- Kerékpár / Futás / Gyalog fülek, időszakválasztó (Összes · 1 év · 6 hónap · 12 hét · 4 hét).
- **Kiemelt rekordok**: leghosszabb táv, legtöbb szint, leghosszabb edzés, legjobb átlagsebesség/tempó, legnagyobb sebesség, leghosszabb mászás, legtöbb kalória – mindegyiknél az előző rekord és fejlődési mini grafikon.
- **Legjobb idők távokra** (5 / 10 / 20 / … km, futásnál 400 m – maraton): a GPS-adatból számolva, akkor is, ha a táv egy hosszabb edzés közepén volt; előző rekord, javulás, fejlődési görbe.
- **Csúcsértékek**: legmagasabb átlagpulzus és -teljesítmény 5 mp – 60 perc ablakokra.
- Új API: `GET /api/records` – edzésenként egyszer számol, cache-eli; sok új edzésnél részletekben.

### Megjelenés
- Inter betűtípus ténylegesen betöltve (eddig a rendszerbetű látszott), táblázatos számok.
- Új közös mini grafikon komponens (`src/ui/sparkline.js`): oszlopos és lépcsős változat.
- Súgó („i”) gombok: koppintásra nyíló, címmel ellátott magyarázó doboz; új súgók a tervezési módhoz, a szintadat/szélhatás időbecsléshez, az összes grafikon-fejléchez és az útirány-nyilakhoz.
- Igazítások: keresőmező, útvonalpontok és stat-kártyák egy vonalban; szekciócímek „i”-je a sorok oszlopában.
- Elemzés fül gombjai egységesek (azonos méret, „Tervezés ez alapján” kiemelve, páratlan gomb teljes szélességben).

### Biztonság
- Megerősítés kérése az útvonal törlésekor (Tervezés: oldalsáv és eszköztár kuka; Elemzés: Törlés).

### Javítások
- Könyvtár rácsnézet: az útvonal-bélyegkép most megjelenik (eddig a kártya DOM-ba kerülése előtt kereste a helyét), a kártya jobb felső sarkában.
- Színezett útvonal (sebesség / pulzus / kadencia / teljesítmény / lejtő): a rövid színfoltok simítva, folytonos alapvonallal – kevesebb térképréteg, nem szakadozik.
- Km-jelölők kis nagyításnál ritkítva (5 → 10 / 25 / 50 / 100 km), nem takarják el az útvonalat (telefonon a teljes kör nézetben).
- Elemzés fejléc: a sporttípus magyarul („Kerékpár” a nyers „cycling” helyett).
- Mobil könyvtár fejléc: 16 px-es margó, mint a többi elem.

### Dokumentáció
- README: új képernyőképek (kitalált demóadatokkal), mobil nézet, újdonságok táblázat, `SHARE_BASE_URL` / `PUBLIC_SHARE_ENABLED` leírás.
- A példa admin belépés (`bringa` / `terv`) helyett semleges minta (`admin` / `ide-ird-a-jelszot`) a README-ben, a compose fájlokban és a DOCS-ban; a `src/config.js` fel nem használt belépési mezői törölve.

### Verzió
- v1.5.2 → v1.6.0

---

## v1.5.2 – 2026-10-17 – Egységes megjelenés

### Színek és stílus
- Egyetlen márka-narancs (a logóé) mindenhol; sötét módban világosabb árnyalat. A Strava-elemek a saját színükön maradnak.
- Javítva: négy alap színváltozó hiányzott (`--border`, `--text-muted`, `--panel`, `--fg`) – kb. 100 helyen nem látszott keret vagy halvány szín.
- Stílus nélküli gombok pótolva (könyvtár-kártya ikon-gombok, lista-fejléc rendezés); a kék hover-szín megszűnt.
- Egységes gombnyelv: semleges másodlagos gombok, csak a veszélyes művelet piros (Elemzés fül, könyvtár).
- Egységes chipek: mindenhol fekete aktív állapot (sötét módban világos), azonos méret.
- Lekerekítés- és betűméret-skála egyszerűsítve.

### Számok és időtartamok
- Új közös formázó (`src/format.js`): magyar tizedesvessző (48,7 km), egységes időtartam (2 ó 20 p) – könyvtár, Elemzés, Statok, PDF, megosztó kép, szélelemzés.
- A PDF-ben a 46 perc nem jelenik meg többé „46:00”-ként.

### Könyvtár és Statok
- A kinyitott sor átrendezve: előnézet, fejléc (sport · dátum), a teljes szélességet kitöltő stat-kártyák, kétrészes gombsor.
- Statok rekord-kártyái a stat-kártyák stílusában.
- Magyar feliratok: „Terhelés”, „Eszköztár sorrend”, „Megnyitás Stravában”, nyers „workout” helyett „Edzés · Kerékpár”.

### Igazítások
- A beállítás-sorok „i” ikonjai egy oszlopban, a stat-kártyák a sorokkal egy vonalban.
- Ha a mozgási idő kerekítve megegyezik az időtartammal, csak egy kártya jelenik meg.
- A Beállítások példa-domainje általános (`bringaterv.example.hu`).

### Verzió
- v1.5.1 → v1.5.2

---

## v1.5.1 – 2026-10-16 – Megosztás mindenhol, térképstílus a térképen

### Megosztás
- Az **Elemzés** fülön a „Megosztó kép” helyén **Megosztás** gomb: megosztó kép, PDF (edzésadatokkal) és – könyvtári elemnél – nyilvános link.
- A **Tervezés** fül Mentés ablakában a „PDF letöltés” helyén szintén **Megosztás**.
- Mentetlen tervnél / helyi fájlnál **„Mentés és link”** gomb: elmenti a könyvtárba, és azonnal megjelenik a link QR-ral, megosztási gombokkal. Link nélkül a PDF-be nem kerül félrevezető QR.

### Térképstílus a térképen
- A stílusválasztó a térkép **jobb felső sarkába** került (Tervezés + Elemzés), mellette „teljes útvonal” gomb. A régi helyek (oldalsáv, fájl-fejléc, eszköztár) megszűntek; a mentett eszköztár-sorrend kezeli a változást.

### Nézőoldal
- Új stat-kártya: **Mechanikai munka (kJ)**.
- Arányosabb cím-blokk (kisebb sport-ikon és cím a logóhoz képest).

### Egyéb
- A felső és alsó menü-elrejtő gomb egy tengelyben a menüikonokkal.
- A könyvtár Sport szűrőjében emoji helyett egységes vonalas ikonok.
- Javítás: a könyvtárból/tervezőből nyitott megosztó kép nem írja felül tartósan az Elemzés fül adatait.

### Verzió
- v1.5.0 → v1.5.1

---

## v1.5.0 – 2026-10-16 – Megosztás: nyilvános nézőoldal, link, edzésadatok a PDF-ben

### Megosztás ablak (Könyvtár)

- A kártya „Megosztó kép” és „PDF” gombja helyett egyetlen **„Megosztás”** gomb, ami közös ablakot nyit: megosztó kép, PDF útvonallap, nyilvános link.
- A link mellett **QR-kód** és **Másolás** gomb, alatta megosztási csatornák: natív megosztás (iOS/macOS/Android – Üzenetek, AirDrop stb.), Facebook, WhatsApp, Telegram, X, e-mail; telefonon Messenger és SMS is.
- Figyelmeztet, ha a link helyi hálózati címre (pl. 192.168…) mutat, és nem lesz elérhető mobilnetről.

### Nyilvános, csak-olvasható nézőoldal (`view.html`)

- A QR-kód és a megosztási link ide mutat: belépés nélkül megtekinthető, szerkeszteni nem lehet.
- A fő app elrendezése: fejléc téma-váltóval, adatlap sport-ikonnal, dátummal és stat-kártyákkal (időtartam, mozgási idő, emelkedő/ereszkedő, sebesség, pulzus, kadencia, teljesítmény, kalória).
- **Térkép** külön kártyán; a jobb felső sarokban térképstílus-választó (az app 7 stílusa) és „teljes útvonal” gomb.
- **Grafikonok** (szintprofil, sebesség, pulzus, kadencia, teljesítmény), ki-be kapcsolhatók; egérrel/ujjal végighúzva szinkronizált jelölő minden grafikonon és a térképen.
- Mobilon egymás alatt: térkép → adatlap → grafikonok.
- Új backend végpont: `GET /api/public/route/<id>` (auth nélkül, a könyvtár `index.json`-jából, a régi DB tartalékként). Kikapcsolható: `PUBLIC_SHARE_ENABLED=false`.

### Megosztási domain beállítása

- A QR/link alap-URL-je állítható: **Beállítások → Megosztás** mező, vagy `SHARE_BASE_URL` környezeti változó. Üresen a böngésző aktuális címét használja (lokális Docker-használatnál is működik).

### PDF útvonallap

- A QR-kód alatt a **link is megjelenik**; PDF-nézőben a szöveg és a QR-kép is kattintható.
- Edzésnél **második stat-sor**: max sebesség, átlag/max pulzus, kadencia, átlagteljesítmény, kalória; „Becsült idő” helyett „Idő”.
- Új grafikonok: **sebesség, pulzus, kadencia, teljesítmény** (kapcsolókkal); 3+ grafikonnál rácsban, fekvő lapon a térkép alatt.
- A PDF-ben is mind a **7 térképstílus** választható (az app saját csempe-definícióiból).
- Kisebb fájlméret: a grafikonok JPEG-ként kerülnek be (~8 MB → ~0,8 MB).

### Javítások

- A sötét módban láthatatlan térképstílus-gomb felirata (fő app is).
- HTML-oldalak gyorsítótárazása: `Cache-Control: no-cache` + a nézőoldal JS cache-bustingja – deploy után nem keveredik régi oldal új scripttel.
- A szintprofil színe smaragdzöld (eddig összekeverhető volt a pulzussal).
- A `bringaterv.hu` domain említése eltávolítva (PDF lábléc, megosztó kép).

### Verzió

- v1.4.0 → v1.5.0

---

## v1.4.0 – 2026-10-16 – PDF útvonallap export

### Nyomtatható PDF útvonallap

- Új funkció: egy útvonalból **nyomtatható, egy kattintással letölthető PDF lap** készíthető (A4 álló vagy fekvő).
- Elérhető **két helyről**: a Könyvtárban a kártya „PDF" gombja, a Tervezőben az export ablak „PDF letöltés" gombja – mindkettő a beállító + előnézet ablakot nyitja.
- A lap tartalma: fejléc (logó + márkanév + útvonalnév + dátum), **valódi térkép** a route-tal (saját Web-Mercator csempe-összeállítás, 5 km-es jelölők, start/cél), stat-sor (táv · emelkedés · becsült idő · süllyedés), **szintprofil**, **burkolat-bontás**, **pontok listája**, **megjegyzés** és **QR-kód**.

### Beállító + előnézet ablak

- **Térképstílus**: Standard / Világos / Domborzat / Műhold (alapból az appban kiválasztott).
- **Tájolás**: álló vagy fekvő (fekvőben kétoszlopos, nagyobb térkép).
- **Kapcsolók**: szintprofil, burkolat-bontás, pontok listája, QR-kód.
- Szerkeszthető **cím**, **fájlnév** és szabad **megjegyzés** mező.
- **„Előnézet frissítése"** gomb – a kész lap a böngésző PDF-nézőjében jelenik meg letöltés előtt.

### Technikai részletek

- A térkép CORS-barát csempékből (OSM / Esri) épül, saját vetítéssel – nyomtatva is éles.
- **Roboto Unicode betűtípus beágyazva** a PDF-be, így a magyar ő/ű és az ékezetek hibátlanul jelennek meg (a jsPDF beépített Helvetica ezt nem tudta).
- jsPDF és a QR-könyvtár CDN-ről, igény szerint (lazy) töltődik.
- A burkolat-elemzés (Overpass) **12 mp időkorláttal** fut; ha lassú, anélkül készül el a lap.
- QR mély-link: a mentett útvonal `?route=<id>` címmel telefonról megnyitható.

### Verzió

- v1.3.5 → v1.4.0

---

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
