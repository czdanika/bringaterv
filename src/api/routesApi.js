/**
 * Bringaterv – Útvonaltár API kliens
 * ====================================
 * A Flask routes-api végpontjaival kommunikál.
 * Az API nginx-en keresztül, /api/ prefix alatt érhető el.
 *
 * Minden függvény Promise-t ad vissza, hiba esetén Error-t dob.
 *
 * Használat (main.js-ben):
 *   import { routesApi } from "./api/routesApi.js";
 *
 *   const list  = await routesApi.listRoutes();
 *   const { id} = await routesApi.saveRoute({ name, gpxContent, distance, type, description });
 *   const gpx  = await routesApi.loadRoute(id);
 *   await routesApi.deleteRoute(id);
 *
 *   const samples = await routesApi.listSamples();
 *   const gpx     = await routesApi.loadSample(id);
 */

import { authHeaders, handle401 } from "../auth.js";

// ── Alap URL ──────────────────────────────────────────────────────────────────
// Relatív path: mindig ugyanazon a hoszt:porton keresztül, ahol a frontend fut.
// (nginx proxy-n át jut el a Flask API-hoz)
const BASE = "/api";

// ── Segédfüggvények ───────────────────────────────────────────────────────────

/**
 * Elvégez egy fetch kérést és a JSON választ adja vissza.
 * Nem 2xx válasz esetén Error-t dob a szerver hibaüzenetével.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(options.headers ?? {}),
    },
    ...options,
  });

  if (res.status === 401) {
    handle401();   // token lejárt → kijelentkezés + login.html
    throw new Error("Lejárt munkamenet");
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      message = err.error ?? message;
    } catch { /* marad az alapértelmezett */ }
    throw new Error(message);
  }

  return res.json();
}

/**
 * Elvégez egy fetch kérést és a szöveges választ adja vissza (GPX-hez).
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchText(url) {
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401) { handle401(); throw new Error("Lejárt munkamenet"); }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}


// ── API metódusok ─────────────────────────────────────────────────────────────

export const routesApi = {

  // ── Felhasználói útvonalak ──────────────────────────────────────────────────

  /**
   * Felhasználói útvonalak listázása (legújabb először).
   *
   * @returns {Promise<Array<{
   *   id: string,
   *   name: string,
   *   date: string,
   *   distance: number|null,
   *   type: string,
   *   description: string
   * }>>}
   */
  listRoutes() {
    return fetchJson(`${BASE}/routes`);
  },

  /**
   * Az összes útvonal/edzés egyszerűsített geometriája egyetlen kérésben (hőtérképhez).
   * @returns {Promise<{ tracks: Array<{ id: string, sport: string, points: [number,number][] }> }>}
   */
  geometryBulk() {
    return fetchJson(`${BASE}/routes/geometry-bulk`);
  },

  /**
   * Új útvonal mentése a szerverre.
   *
   * @param {{
   *   name: string,
   *   gpxContent: string,
   *   distance?: number,
   *   type?: "cycling"|"hiking",
   *   description?: string
   * }} params
   * @returns {Promise<{ id: string }>}
   */
  saveRoute({ name, gpxContent, fitContent = null, distance, duration, elevation, type = "cycling", description = "" }) {
    return fetchJson(`${BASE}/routes`, {
      method: "POST",
      body: JSON.stringify({ name, gpxContent, fitContent, distance, duration, elevation, type, description }),
    });
  },

  /**
   * Útvonal GPX tartalmának lekérése szövegként.
   *
   * @param {string} id
   * @returns {Promise<string>} GPX XML szöveg
   */
  loadRoute(id) {
    return fetchText(`${BASE}/routes/${encodeURIComponent(id)}`);
  },

  /**
   * Eredeti FIT bináris letöltése (Blob-ként). Csak FIT-ből mentett edzéseknél.
   *
   * @param {string} id
   * @returns {Promise<Blob>}
   */
  async loadRouteFit(id) {
    const res = await fetch(`${BASE}/routes/${encodeURIComponent(id)}/fit`, {
      headers: authHeaders(),
    });
    if (res.status === 401) { handle401(); throw new Error("Lejárt munkamenet"); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },

  /**
   * Útvonal metaadatainak frissítése (partial update, GPX fájlt nem érinti).
   *
   * @param {string} id
   * @param {{ name?: string, type?: string, description?: string }} fields
   * @returns {Promise<object>} frissített bejegyzés
   */
  updateRoute(id, fields) {
    return fetchJson(`${BASE}/routes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
  },

  /**
   * Útvonal törlése.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  async deleteRoute(id) {
    const res = await fetch(`${BASE}/routes/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (res.status === 401) { handle401(); throw new Error("Lejárt munkamenet"); }
    if (!res.ok && res.status !== 204) {
      throw new Error(`Törlési hiba: HTTP ${res.status}`);
    }
  },


  // ── Minta útvonalak ─────────────────────────────────────────────────────────

  /**
   * Beépített minta útvonalak listázása.
   *
   * @returns {Promise<Array<{
   *   id: string,
   *   name: string,
   *   distance: number|null,
   *   type: string,
   *   description: string
   * }>>}
   */
  listSamples() {
    return fetchJson(`${BASE}/samples`);
  },

  /**
   * Minta útvonal GPX tartalmának lekérése szövegként.
   *
   * @param {string} id
   * @returns {Promise<string>} GPX XML szöveg
   */
  loadSample(id) {
    return fetchText(`${BASE}/samples/${encodeURIComponent(id)}`);
  },


  // ── Health check ────────────────────────────────────────────────────────────

  /**
   * API elérhetőség ellenőrzése.
   */
  health() {
    return fetchJson(`${BASE}/health`);
  },


  // ── Személyes beállítások (multi mód) ──────────────────────────────────────

  /**
   * Felhasználó beállításainak lekérése a szerverről.
   * Single módban üres objektumot ad vissza.
   */
  getSettings() {
    return fetchJson(`${BASE}/user/settings`);
  },

  /**
   * Felhasználó beállításainak mentése a szerverre.
   * @param {object} settings
   */
  saveSettings(settings) {
    return fetchJson(`${BASE}/user/settings`, {
      method: "PUT",
      body:   JSON.stringify(settings),
    });
  },


  // ── Backup / Restore ────────────────────────────────────────────────────────

  /**
   * Saját profil ZIP backup letöltése (settings.json + routes/ + workouts/).
   * @returns {Promise<{blob: Blob, filename: string}>}
   */
  async downloadBackup() {
    const res = await fetch(`${BASE}/user/backup`, { headers: authHeaders() });
    if (res.status === 401) { handle401(); throw new Error("Lejárt munkamenet"); }
    if (!res.ok) throw new Error(`Backup hiba: HTTP ${res.status}`);
    const cd = res.headers.get("Content-Disposition") || "";
    const match = cd.match(/filename="([^"]+)"/);
    return { blob: await res.blob(), filename: match ? match[1] : "backup.zip" };
  },

  /**
   * Saját profil visszatöltése ZIP-ből.
   * @param {File}   file – ZIP fájl
   * @param {string} mode – "merge" (új ID-k) | "replace" (teljes felülírás)
   */
  async restoreBackup(file, mode = "merge") {
    const fd = new FormData();
    fd.append("backup", file);
    fd.append("mode", mode);
    const res = await fetch(`${BASE}/user/restore`, {
      method: "POST", headers: authHeaders(), body: fd,
    });
    if (res.status === 401) { handle401(); throw new Error("Lejárt munkamenet"); }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
    return res.json();
  },


  // ── Admin végpontok ─────────────────────────────────────────────────────────

  admin: {
    listUsers()                       { return fetchJson(`${BASE}/admin/users`); },
    createUser(data)                  { return fetchJson(`${BASE}/admin/users`, { method: "POST", body: JSON.stringify(data) }); },
    getUser(id)                       { return fetchJson(`${BASE}/admin/users/${id}`); },
    updateUser(id, data)              { return fetchJson(`${BASE}/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }); },
    resetPassword(id, pw)             { return fetchJson(`${BASE}/admin/users/${id}/password`, { method: "POST", body: JSON.stringify({ password: pw }) }); },
    stats()                           { return fetchJson(`${BASE}/admin/stats`); },
    listUserRoutes(userId)            { return fetchJson(`${BASE}/admin/users/${userId}/routes`); },
    getUserRouteGpx(userId, routeId)  { return fetchText(`${BASE}/admin/users/${userId}/routes/${encodeURIComponent(routeId)}/gpx`); },
    async getUserRouteFit(userId, routeId) {
      const res = await fetch(`${BASE}/admin/users/${userId}/routes/${encodeURIComponent(routeId)}/fit`, {
        headers: authHeaders(),
      });
      if (res.status === 401) { handle401(); throw new Error("Lejárt munkamenet"); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    },
    updateUserRoute(userId, routeId, fields) {
      return fetchJson(`${BASE}/admin/users/${userId}/routes/${encodeURIComponent(routeId)}`, {
        method: "PATCH",
        body: JSON.stringify(fields),
      });
    },
    uploadUserRoute(userId, data) {
      return fetchJson(`${BASE}/admin/users/${userId}/routes`, {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    async deleteUserRoute(userId, routeId) {
      const res = await fetch(`${BASE}/admin/users/${userId}/routes/${routeId}`, {
        method: "DELETE", headers: authHeaders(),
      });
      if (!res.ok && res.status !== 204) throw new Error(`Törlési hiba: HTTP ${res.status}`);
    },

    listSamples() { return fetchJson(`${BASE}/admin/samples`); },
    async createSample(formData) {
      const res = await fetch(`${BASE}/admin/samples`, {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
      return res.json();
    },
    updateSample(id, data) {
      return fetchJson(`${BASE}/admin/samples/${encodeURIComponent(id)}`, {
        method: "PATCH", body: JSON.stringify(data),
      });
    },
    async deleteSample(id) {
      const res = await fetch(`${BASE}/admin/samples/${encodeURIComponent(id)}`, {
        method: "DELETE", headers: authHeaders(),
      });
      if (!res.ok && res.status !== 204) throw new Error(`Törlési hiba: HTTP ${res.status}`);
    },

    async downloadUserBackup(userId) {
      const res = await fetch(`${BASE}/admin/users/${userId}/backup`, { headers: authHeaders() });
      if (res.status === 401) { handle401(); throw new Error("Lejárt munkamenet"); }
      if (!res.ok) throw new Error(`Backup hiba: HTTP ${res.status}`);
      const cd = res.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename="([^"]+)"/);
      return { blob: await res.blob(), filename: match ? match[1] : "backup.zip" };
    },
    async restoreUserBackup(userId, file, mode = "merge") {
      const fd = new FormData();
      fd.append("backup", file);
      fd.append("mode", mode);
      const res = await fetch(`${BASE}/admin/users/${userId}/restore`, {
        method: "POST", headers: authHeaders(), body: fd,
      });
      if (res.status === 401) { handle401(); throw new Error("Lejárt munkamenet"); }
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
      return res.json();
    },

    // Strava app credentials kezelése
    getStravaConfig() {
      return fetchJson(`${BASE}/admin/strava/config`);
    },
    saveStravaConfig(clientId, clientSecret) {
      return fetchJson(`${BASE}/admin/strava/config`, {
        method: "PUT",
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      });
    },
    async deleteStravaConfig() {
      const res = await fetch(`${BASE}/admin/strava/config`, {
        method: "DELETE", headers: authHeaders(),
      });
      if (!res.ok && res.status !== 204) throw new Error(`Törlési hiba: HTTP ${res.status}`);
    },
  },

  // Strava (user-szintű)
  strava: {
    status()      { return fetchJson(`${BASE}/strava/status`); },
    connect()     { return fetchJson(`${BASE}/strava/connect`); },
    async disconnect() {
      const res = await fetch(`${BASE}/strava/disconnect`, {
        method: "DELETE", headers: authHeaders(),
      });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      return true;
    },
    activities({ per_page = 30, page = 1, after = null, before = null } = {}) {
      const params = new URLSearchParams({ per_page, page });
      if (after)  params.set("after", after);
      if (before) params.set("before", before);
      return fetchJson(`${BASE}/strava/activities?${params}`);
    },
    importActivity(id) {
      return fetchJson(`${BASE}/strava/import/${id}`, { method: "POST" });
    },
    refreshActivity(routeId) {
      return fetchJson(`${BASE}/strava/refresh/${encodeURIComponent(routeId)}`, { method: "POST" });
    },
    async removeFromDenyList(id) {
      const res = await fetch(`${BASE}/strava/deny-list/${id}`, {
        method: "DELETE", headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    // User saját Strava app credentials kezelése
    appConfig: {
      get()  { return fetchJson(`${BASE}/strava/app-config`); },
      save(client_id, client_secret, callback_url = null) {
        return fetchJson(`${BASE}/strava/app-config`, {
          method: "PUT",
          body: JSON.stringify({ client_id, client_secret, callback_url }),
        });
      },
      async clear() {
        const res = await fetch(`${BASE}/strava/app-config`, {
          method: "DELETE", headers: authHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      },
    },
  },
};
