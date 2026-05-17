# Minta útvonalak

Ebbe a könyvtárba kerülnek a beépített minta GPX fájlok és a hozzájuk tartozó metaadat JSON-ok.

## Fájlstruktúra

Minden mintához két fájl kell:

```
<id>.gpx   – az útvonal GPX adatai
<id>.json  – metaadat (név, távolság, típus, leírás)
```

A JSON formátuma:
```json
{
  "name":        "Balatoni kör",
  "distance":    204,
  "type":        "cycling",
  "description": "Rövid leírás..."
}
```

`type` értéke: `"cycling"` vagy `"hiking"`

## Elérhető minták (GPX hozzáadandó)

| ID | Név | ~km |
|----|-----|-----|
| `balatoni-kor` | Balatoni kör | 204 |
| `velencei-to-kor` | Velencei-tó kör | 35 |
| `tisza-to-kor` | Tisza-tó kör | 90 |

## GPX fájlok forrása

A GPX fájlokat az alábbi forrásokból lehet begyűjteni:
- [Wikiloc](https://www.wikiloc.com) – nyilvánosan megosztott útvonalak
- [Komoot](https://www.komoot.com) – fiókhoz kötött, exportálható
- [OpenStreetMap + BRouter](https://brouter.de/brouter-web/) – saját generálás
- Kerékpáros szövetségek nyilvános GPX gyűjteményei

## GPX hozzáadása

1. Töltsd le / generáld a GPX fájlt
2. Nevezd el `<id>.gpx`-nek (pl. `balatoni-kor.gpx`)
3. Másold ebbe a könyvtárba
4. Buildeld újra a Docker image-et:
   ```bash
   docker compose build routes-api
   docker compose up -d routes-api
   ```
