/**
 * Bringaterv – service worker (PWA)
 * ==================================
 * Szándékosan egyszerű, „hálózat először” stratégia:
 *   – az alkalmazás fájljai (HTML/JS/CSS/képek) mindig a szerverről jönnek,
 *     így deploy után azonnal az új verzió fut (nincs elavult gyorsítótár);
 *   – minden sikeres választ eltárolunk, és hálózat nélkül ebből indul az app
 *     (legalább a felület betölt, és kiírja, hogy nincs kapcsolat);
 *   – az /api/ hívásokat és a külső kéréseket (térképcsempék, betűk) nem
 *     érintjük – ezek mindig közvetlenül mennek.
 * A gyorsítótár kulcsa az útvonal query nélkül (a ?b=… cache-bust token minden
 * deploy-nál változik – így nem gyűlnek a régi példányok).
 */

const CACHE = "bringaterv-shell-v2";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  const key = url.origin + url.pathname;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(key);
      if (hit) return hit;
      if (req.mode === "navigate") {
        const shell = await caches.match(new URL("./index.html", self.registration.scope).href);
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

// ── Push értesítések ─────────────────────────────────────────────────────────
// A szerver (routes-api/notify.py) JSON-t küld: { title, body, url, tag }.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }
  const title = data.title || "Bringaterv";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: "src/assets/icons/icon-192.png",
    badge: "src/assets/icons/icon-192.png",
    tag: data.tag || undefined,
    data: { url: data.url || "./index.html" },
  }));
});

// Koppintás: a már nyitott ablakot hozzuk előre (és oda navigálunk), különben új ablak
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./index.html", self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        if ("navigate" in w) return w.navigate(target);
        return;
      }
    }
    return self.clients.openWindow(target);
  })());
});
