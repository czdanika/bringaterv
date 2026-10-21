# Changelog

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
