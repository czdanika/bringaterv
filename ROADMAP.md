# Bringaterv – Fejlesztési terv

Tervezett funkciók és fejlesztési irányok. Prioritás sorrendben.

---

## 📱 Mobil nézet

**Cél:** teljes értékű mobilos élmény, touch-barát kezelés.

### Koncepció: Bottom sheet + teljes képernyős térkép

```
┌─────────────────────┐
│                     │
│      TÉRKÉP         │  ← 100% képernyő
│   (Leaflet, touch)  │
│                     │
│  [↩][🗺][↺][🗑][📐][💾]  │  ← lebegő toolbar
├─────────────────────┤
│  Tervezés  Elemzés  Könyvtár  │  ← tab sáv (mindig látszik)
├─────────────────────┤
│                     │  ← bottom sheet
│   sidebar tartalom  │    3 snap pozíció: csukva / fél / teli
│   (waypoints, lib)  │    húzható felfelé/lefelé
│                     │
└─────────────────────┘
```

### Snap pozíciók
- **Csukva** – csak a tab sáv (~60px), térkép teljes képernyő
- **Félig nyitva** – ~45% magasság, waypoint lista + gombok látszanak
- **Teljesen nyitva** – ~90% magasság, teljes panel scrollolható

### Megvalósítandó
- [ ] CSS: `@media (max-width: 768px)` teljes átírás
- [ ] Bottom sheet pozicionálás, 3 snap pozíció
- [ ] iPhone safe area: `env(safe-area-inset-bottom)`
- [ ] JS: touch/swipe kezelés + snap animáció (~80 sor)
- [ ] Lebegő toolbar a térképen (hamburger + mentés + zoom)
- [ ] Touch-barát gombméretek (min 44×44px)
- [ ] Waypoint átrendezés mobilon: nyilakkal (drag & drop helyett)
- [ ] Tesztelés: iOS Safari, Android Chrome

### Ami már működik mobilon
- Leaflet pinch-zoom, drag, tap
- Tab váltás
- Könyvtár böngészés

---

## 🔗 Megosztható link

**Cél:** egy útvonalat URL-ben kódolva meg lehessen osztani.

- Waypontok lat/lng koordinátái URL paraméterbe kódolva
- Link megnyitásakor automatikusan betölti az útvonalat
- Opcionálisan: közvetlen GPX letöltési link a könyvtárból

---

## 📲 PWA / Offline mód

**Cél:** telepíthető app, alapfunkciók internet nélkül is.

- `manifest.json` + service worker
- Térkép tile-ok cache-elése (utoljára megtekintett terület)
- Offline: waypontok felvétele, GPX mentése lokálisan
- Sync amikor visszajön a kapcsolat

---

## 🗺️ Mobilbarát waypoint kezelés

- Hosszú nyomással új waypoint felvétele a térképen
- Swipe-to-delete waypoint listában
- Nyilakkal átrendezés (↑↓ gombok) drag & drop helyett

---

*Utoljára frissítve: 2026-05-17*
