# Changelog

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
