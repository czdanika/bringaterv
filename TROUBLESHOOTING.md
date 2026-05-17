# Bringaterv – Hibaelhárítási útmutató

Ismert problémák és megoldásaik, hogy legközelebb ne menjen el sok idő a debuggolással.

---

## 1. Frissítés után az app a régi verziót mutatja

### Tünet
- Új funkciók nem jelennek meg
- Verziószám régi marad
- A konzolban régi kód fut

### Ok
Az nginx **1 napig cachelte** a `.js` és `.css` fájlokat. A böngésző nem töltötte le az új `main.js`-t, hanem a memóriából szolgálta ki.

### Megoldás
- Az nginx.conf-ban `no-cache` beállítás van a JS/CSS fájlokra (v0.9 óta). Régebbi verzióknál ez hiányzott.
- **Azonnali megoldás:** Inkognito mód vagy Cmd+Shift+R (force refresh) NEM biztos hogy segít, ha az nginx cache header nem `no-cache`.
- **Helyes frissítés:** NAS container újralétrehozása (ld. lent).

---

## 2. NAS frissítés: pull + restart nem elég

### Tünet
- `docker pull` lefut, "Image is up to date" vagy új image letölt
- Az app mégis a régi verziót mutatja

### Ok
A `restart` csak megállítja és elindítja a meglévő containert. Az már a **régi image rétegeit** használja. Az új image-ből csak **új container létrehozásával** fut az app.

### Megoldás – helyes frissítési parancs

```bash
docker pull ghcr.io/czdanika/bringaterv:latest && \
docker stop bringaterv && \
docker rm bringaterv && \
docker run -d -p 8088:80 \
  -e LOGIN_ENABLED=true \
  -e LOGIN_USER=bringa \
  -e LOGIN_PASSWORD=terv \
  --restart unless-stopped \
  --name bringaterv \
  ghcr.io/czdanika/bringaterv:latest
```

### Ellenőrzés – fut-e az új verzió?

```bash
docker exec $(docker ps -q --filter "publish=8088") cat /usr/share/nginx/html/CHANGELOG.md | head -5
```

---

## 3. GPX import nem működik HTTP-n (NAS helyi cím)

### Tünet
- Localhoston működik, HTTPS-en (Cloudflare) működik
- Helyi hálózaton (pl. `192.168.0.100:8088`) nem töltődik be a GPX / console hiba

### Ok
A `crypto.randomUUID()` függvény csak **Secure Contextben** (HTTPS vagy localhost) érhető el. HTTP-n a helyi hálózaton nem működik.

### Megoldás
A `src/state/routeStore.js` elején van egy `generateId()` polyfill, ami HTTP-n is működik (v0.9 óta):

```js
function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
```

Ha ez hiányzik, a GPX import eldobja a hibát és megáll – de a szokásos JS konzolban **nem látszik hiba**, mert az async event handler elnyeli.

---

## 4. Új elem/funkció nem jelenik meg a UI-ban

### Tünet
- Az elem létezik a DOM-ban (`document.querySelector('#elem')` nem null)
- De `hidden: true` marad, vagy a funkció nem működik

### Diagnosztika lépései

**1. Fut-e az új kód?**
```bash
docker exec $(docker ps -q --filter "publish=8088") grep -c "keresett_szöveg" /usr/share/nginx/html/src/main.js
```

**2. Mi az elem aktuális állapota?** (böngésző DevTools Console):
```js
const el = document.querySelector('#gradeLegend');
console.log('hidden:', el?.hidden, 'exists:', !!el);
```

**3. Változik-e az elem?** (MutationObserver – futtasd importálás előtt):
```js
new MutationObserver(function(m) {
  m.forEach(function(r) {
    console.log('attr changed:', document.querySelector('#gradeLegend').hidden);
    console.trace();
  });
}).observe(document.querySelector('#gradeLegend'), {attributes: true});
```

**4. Ideiglenes debug log a kódban:**
```js
function updateElevationButton(geometry) {
  console.log('[DEBUG] len=', geometry?.length, 'hasEle=', geometry?.some(p => p.ele != null));
  // ... eredeti kód
}
```

---

## 5. CI/CD folyamat – hogyan jut el a kód a NAS-ra?

```
Helyi szerkesztés
       ↓
git push origin main
       ↓
GitHub Actions (automatikus, ~20 mp)
  - Docker image build
  - Push → ghcr.io/czdanika/bringaterv:latest
       ↓
NAS: docker pull + container újralétrehozás
       ↓
Böngésző: oldal frissítése (no-cache miatt azonnal új JS töltődik)
```

### GitHub Actions futás ellenőrzése:
```bash
gh run list --limit 5
```

---

## 6. Portainer frissítés (alternatív módszer)

Ha a Portainerben a **"Pull and redeploy"** gomb elérhető, az helyesen újralétrehozza a containert (nem csak restart). Ha ez nem működik, használd a fenti parancssoros módszert.

---

## 7. nginx MIME típus hiba (ES modulok)

### Tünet
- `Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/plain"`

### Ok
Az nginx nem ismeri az `.js` fájlok helyes MIME típusát.

### Megoldás (nginx.conf):
```nginx
types {
    application/javascript  js mjs;
    # ... többi típus
}
```

---

## Gyors diagnosztikai parancsok

```bash
# Fut-e a container?
docker ps --filter "publish=8088"

# Melyik verzió fut?
docker exec $(docker ps -q --filter "publish=8088") cat /usr/share/nginx/html/CHANGELOG.md | head -5

# Az image SHA egyezik-e?
docker inspect $(docker ps -q --filter "publish=8088") --format '{{.Image}}' | cut -c1-20
docker inspect ghcr.io/czdanika/bringaterv:latest --format '{{.Id}}' | cut -c1-20

# Adott kód megvan-e a konténerben?
docker exec $(docker ps -q --filter "publish=8088") grep -c "keresett_szöveg" /usr/share/nginx/html/src/main.js
```
