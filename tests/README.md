# Böngészős tesztek (Playwright)

Valódi Chrome-ot vezérelnek a futó app ellen (alapból a Pi: `http://192.168.0.136:8088`),
három eszközön: **iPhone 13**, **Pixel 7** (mobil emuláció, érintés) és **asztali** 1440×900.

## Futtatás

```bash
tests/run.sh                          # minden teszt, minden eszköz (~9 perc VPN-en)
tests/run.sh -k iphone                # csak iPhone
tests/run.sh tests/test_planning.py   # csak tervezés
BT_HEADED=1 tests/run.sh -k desktop   # látható böngészőablakkal
BT_BASE=http://localhost:8088 tests/run.sh
```

Első futáskor a `run.sh` létrehozza a `tests/.venv`-et (playwright + pytest). A rendszer
Google Chrome-ját használja (`channel="chrome"`), külön böngészőletöltés nem kell.

Belépés: `tests/.env` (git-ignorált):
```
BT_USER=...
BT_PASS=...
```

## Mit ellenőriz

| Fájl | Teszt |
|---|---|
| `test_ui.py` | login oldal; az 5 fül (Kezdő, Tervezés, Elemzés, Könyvtár, Statok); a 6 statisztika-nézet |
| `test_planning.py` | 3 pont lerakása a térképre Aszfalt és Túra módban → BRouter útvonal, táv / idő / emelkedés |
| `test_admin.py` | admin → Közösségi útvonalak: minden sorban van nyomvonal-miniatűr, a térkép ablak megnyílik (admin jogú fiók kell, különben kihagyja) |

Minden tesztnél: nincs vízszintes görgetés, nincs JS-hiba, nincs hibás válasz a saját
szervertől (API, `/brouter`). Külső szolgáltatás (Open-Meteo, csempék) átmeneti hibája csak
figyelmeztetés.

## Biztonság

A tesztek **nem írnak a szerverre**: minden POST/PUT/PATCH/DELETE `/api/` hívást blokkolnak
(a belépés kivételével), és kiírják, ha az app írni próbált. Tiszta böngészőprofillal futnak,
így a fiók félkész terve (localStorage) sem sérül.

## Kimenet

- `tests/screenshots/` – képernyőkép minden fülről / nézetről / tervről, eszközönként
- `tests/last-run.log` – ha a `run.sh` kimenetét ide irányítod

## Trükkök

- `window.__map`: a Leaflet térkép-példány – egy init-script akasztja rá (`conftest.MAP_HOOK`),
  így a tesztek koordinátára tudnak kattintani.
- Mobilon a térkép alját a tervező lap takarja: `fit_points_into_visible_map()` kiméri a
  ténylegesen látható részt, és minden pont előtt újraillesztja (a 2. pont után az app
  automatikusan ráközelít az útvonalra).
