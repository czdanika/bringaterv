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
   * Edzésenkénti rekordadatok (legjobb idők távokra, csúcspulzus/-watt, mászás).
   * A szerver cache-el; sok új edzésnél részletekben számol (`pending` > 0 → újrakérés).
   * @returns {Promise<{ items: Array<{id, efforts, peaks, climb}>, pending: number }>}
   */
  getRecords() {
    return fetchJson(`${BASE}/records`);
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
  saveRoute({ name, gpxContent, fitContent = null, distance, duration, elevation, type = "cycling", description = "",
              startTime = null, include_in_stats = true }) {
    return fetchJson(`${BASE}/routes`, {
      method: "POST",
      // include_in_stats: a tervek false-szal mennek (különben a Statisztika edzésnek számolná őket)
      body: JSON.stringify({ name, gpxContent, fitContent, distance, duration, elevation, type, description,
                             start_time: startTime, include_in_stats }),
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
  /** Nyilvános megosztási link állapota / be-ki kapcsolása. */
  getRoutePublic(id) { return fetchJson(`${BASE}/routes/${encodeURIComponent(id)}/public`); },
  setRoutePublic(id, on) { return this.updateRoute(id, { public: !!on }); },

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


  // ── AI (a kulcs a szerveren van; itt csak a saját keret és az elemzések) ────

  aiStatus() { return fetchJson(`${BASE}/ai/status`); },
  /** Útvonal-javaslat: szabad szöveges kérés → beállítások ({ params, summary, unsupported, status }) */
  aiRouteRequest(data) { return fetchJson(`${BASE}/ai/route-request`, { method: "POST", body: JSON.stringify(data) }); },
  aiSetEnabled(enabled) {
    return fetchJson(`${BASE}/ai/me`, { method: "PUT", body: JSON.stringify({ enabled }) });
  },
  aiAnalyzeWorkout(id, body) {
    return fetchJson(`${BASE}/ai/workout/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) });
  },
  aiEditWorkout(id, fields) {
    return fetchJson(`${BASE}/ai/workout/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(fields) });
  },
  aiDeleteWorkout(id) {
    return fetchJson(`${BASE}/ai/workout/${encodeURIComponent(id)}`, { method: "DELETE" });
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
    roadmapList()                     { return fetchJson(`${BASE}/admin/roadmap`); },
    roadmapCreate(data)               { return fetchJson(`${BASE}/admin/roadmap`, { method: "POST", body: JSON.stringify(data) }); },
    roadmapUpdate(id, data)           { return fetchJson(`${BASE}/admin/roadmap/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(data) }); },
    roadmapDelete(id)                 { return fetchJson(`${BASE}/admin/roadmap/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    roadmapAi(idea)                   { return fetchJson(`${BASE}/admin/roadmap/ai`, { method: "POST", body: JSON.stringify({ idea }) }); },
    roadmapImport(data)               { return fetchJson(`${BASE}/admin/roadmap/import`, { method: "POST", body: JSON.stringify(data) }); },
    siteGet()                         { return fetchJson(`${BASE}/admin/site`); },
    sitePut(data)                     { return fetchJson(`${BASE}/admin/site`, { method: "PUT", body: JSON.stringify(data) }); },
    aiGet()                           { return fetchJson(`${BASE}/admin/ai`); },
    aiPut(data)                       { return fetchJson(`${BASE}/admin/ai`, { method: "PUT", body: JSON.stringify(data) }); },
    aiSampleDescription(data)         { return fetchJson(`${BASE}/admin/ai/sample-description`, { method: "POST", body: JSON.stringify(data) }); },
    impersonate(userId)               { return fetchJson(`${BASE}/admin/users/${encodeURIComponent(userId)}/impersonate`, { method: "POST" }); },
    surfaceDbStatus()                 { return fetchJson(`${BASE}/admin/surface-db`); },
    surfaceDbBuild()                  { return fetchJson(`${BASE}/admin/surface-db`, { method: "POST" }); },
    brouterStatus()                   { return fetchJson(`${BASE}/admin/brouter`); },
    brouterUpdate()                   { return fetchJson(`${BASE}/admin/brouter`, { method: "POST" }); },
    aiTest(apiKey)                    { return fetchJson(`${BASE}/admin/ai/test`, { method: "POST", body: JSON.stringify({ api_key: apiKey || "" }) }); },
    resetPassword(id, pw)             { return fetchJson(`${BASE}/admin/users/${id}/password`, { method: "POST", body: JSON.stringify({ password: pw }) }); },
    stats()                           { return fetchJson(`${BASE}/admin/stats`); },
    deleteUser(id, confirmEmail)      { return fetchJson(`${BASE}/admin/users/${id}`, { method: "DELETE", body: JSON.stringify({ confirm_email: confirmEmail }) }); },
    listInvites()                     { return fetchJson(`${BASE}/admin/invites`); },
    createInvite(data)                { return fetchJson(`${BASE}/admin/invites`, { method: "POST", body: JSON.stringify(data) }); },
    revokeInvite(token)               { return fetchJson(`${BASE}/admin/invites/${encodeURIComponent(token)}`, { method: "DELETE" }); },
    sendInvite(token)                 { return fetchJson(`${BASE}/admin/invites/${encodeURIComponent(token)}/send`, { method: "POST" }); },
    listFeedback()                    { return fetchJson(`${BASE}/admin/feedback`); },
    setFeedbackStatus(id, status)     { return fetchJson(`${BASE}/admin/feedback/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status }) }); },
    deleteFeedback(id)                { return fetchJson(`${BASE}/admin/feedback/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    async feedbackImage(id) {
      const res = await fetch(`${BASE}/admin/feedback/${encodeURIComponent(id)}/image`, { headers: authHeaders() });
      if (res.status === 401) { handle401(); throw new Error("Lejárt munkamenet"); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    },
    testMail()                        { return fetchJson(`${BASE}/admin/mail/test`, { method: "POST" }); },
    sendMessage(data)                 { return fetchJson(`${BASE}/admin/message`, { method: "POST", body: JSON.stringify(data) }); },
    listSubmissions()                 { return fetchJson(`${BASE}/admin/submissions`); },
    updateSubmission(id, data)        { return fetchJson(`${BASE}/admin/submissions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(data) }); },
    approveSubmission(id, data)       { return fetchJson(`${BASE}/admin/submissions/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify(data || {}) }); },
    rejectSubmission(id, reason)      { return fetchJson(`${BASE}/admin/submissions/${encodeURIComponent(id)}/reject`, { method: "POST", body: JSON.stringify({ reason }) }); },
    deleteSubmission(id)              { return fetchJson(`${BASE}/admin/submissions/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    submissionGpx(id)                 { return fetchText(`${BASE}/admin/submissions/${encodeURIComponent(id)}/gpx`); },
    locateSample(id)                  { return fetchJson(`${BASE}/admin/samples/${encodeURIComponent(id)}/locate`, { method: "POST" }); },
    locateSamples(start)              { return fetchJson(`${BASE}/admin/samples/locate`, start ? { method: "POST" } : {}); },
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
  // Push értesítések (notify.py)
  notify: {
    config(endpoint = "") {
      return fetchJson(`${BASE}/notify/config${endpoint ? "?endpoint=" + encodeURIComponent(endpoint) : ""}`);
    },
    setEvents(events) {
      return fetchJson(`${BASE}/notify/events`, { method: "PUT", body: JSON.stringify({ events }) });
    },
    subscribe(subscription) {
      return fetchJson(`${BASE}/notify/subscribe`, { method: "POST", body: JSON.stringify({ subscription }) });
    },
    unsubscribe(endpoint) {
      return fetchJson(`${BASE}/notify/unsubscribe`, { method: "POST", body: JSON.stringify({ endpoint }) });
    },
    test(delay = 0) { return fetchJson(`${BASE}/notify/test`, { method: "POST", body: JSON.stringify({ delay }) }); },
  },

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
    // Automatikus import (háttér-szinkron): állapot, beállítás, azonnali ellenőrzés
    autoSync: {
      get()  { return fetchJson(`${BASE}/strava/auto-sync`); },
      save({ enabled, interval_min, sports, reimport_deleted }) {
        return fetchJson(`${BASE}/strava/auto-sync`, {
          method: "PUT",
          body: JSON.stringify({ enabled, interval_min, sports, reimport_deleted }),
        });
      },
      runNow() { return fetchJson(`${BASE}/strava/auto-sync/run`, { method: "POST" }); },
    },
    // Webhook (azonnali import): a Strava maga szól az új edzésről
    webhook: {
      async enable(base_url, force = false) {
        const res = await fetch(`${BASE}/strava/webhook-config`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ base_url, force }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.status = res.status; e.body = body; throw e; }
        return body;
      },
      disable() { return fetchJson(`${BASE}/strava/webhook-config`, { method: "DELETE" }); },
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

  // Garmin Connect (user-szintű)
  garmin: {
    status() { return fetchJson(`${BASE}/garmin/status`); },
    connect(email, password) {
      return fetchJson(`${BASE}/garmin/connect`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
    },
    mfa(code) {
      return fetchJson(`${BASE}/garmin/mfa`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
    },
    async disconnect() {
      const res = await fetch(`${BASE}/garmin/disconnect`, {
        method: "DELETE", headers: authHeaders(),
      });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      return true;
    },
    weight(days = 365) { return fetchJson(`${BASE}/garmin/weight?days=${days}`); },
    activities({ limit = 30, after = null } = {}) {
      const params = new URLSearchParams({ limit });
      if (after) params.set("after", after);
      return fetchJson(`${BASE}/garmin/activities?${params}`);
    },
    importActivity(id) {
      return fetchJson(`${BASE}/garmin/import/${id}`, { method: "POST" });
    },
    uploadCourse(routeId) {
      return fetchJson(`${BASE}/garmin/course/${encodeURIComponent(routeId)}`, { method: "POST" });
    },
    autoSync: {
      get()  { return fetchJson(`${BASE}/garmin/auto-sync`); },
      save(body) { return fetchJson(`${BASE}/garmin/auto-sync`, { method: "PUT", body: JSON.stringify(body) }); },
      runNow() { return fetchJson(`${BASE}/garmin/auto-sync/run`, { method: "POST" }); },
    },
    // könyvtári mentés nélkül (pl. betelt kvótánál)
    uploadCourseGpx(name, gpx, type) {
      return fetchJson(`${BASE}/garmin/course`, { method: "POST", body: JSON.stringify({ name, gpx, type }) });
    },
    async removeFromDenyList(id) {
      const res = await fetch(`${BASE}/garmin/deny-list/${id}`, {
        method: "DELETE", headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  },

  // OnelapFit / Magene (user-szintű)
  onelap: {
    status() { return fetchJson(`${BASE}/onelap/status`); },
    connect(email, password) {
      return fetchJson(`${BASE}/onelap/connect`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
    },
    disconnect() { return fetchJson(`${BASE}/onelap/disconnect`, { method: "DELETE" }); },
    activities({ days = 30, limit = 30 } = {}) {
      return fetchJson(`${BASE}/onelap/activities?${new URLSearchParams({ days, limit })}`);
    },
    importActivity(id, startTs) {
      return fetchJson(`${BASE}/onelap/import/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify({ start_ts: startTs }),
      });
    },
    removeFromDenyList(id) {
      return fetchJson(`${BASE}/onelap/deny-list/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    uploadRoute(routeId) {
      return fetchJson(`${BASE}/onelap/route/${encodeURIComponent(routeId)}`, { method: "POST" });
    },
    autoSync: {
      get()  { return fetchJson(`${BASE}/onelap/auto-sync`); },
      save(body) { return fetchJson(`${BASE}/onelap/auto-sync`, { method: "PUT", body: JSON.stringify(body) }); },
      runNow() { return fetchJson(`${BASE}/onelap/auto-sync/run`, { method: "POST" }); },
    },
    // könyvtári mentés nélkül (pl. betelt kvótánál)
    uploadGpx(name, gpx) {
      return fetchJson(`${BASE}/onelap/route`, { method: "POST", body: JSON.stringify({ name, gpx }) });
    },
  },

  // Wahoo / Polar (hivatalos OAuth-os API-k, csak import)
  devices(provider) {
    const P = `${BASE}/${provider}`;
    return {
      status()     { return fetchJson(`${P}/status`); },
      connect()    { return fetchJson(`${P}/connect`); },
      disconnect() { return fetchJson(`${P}/disconnect`, { method: "DELETE" }); },
      activities({ days = 30, limit = 30 } = {}) {
        return fetchJson(`${P}/activities?${new URLSearchParams({ days, limit })}`);
      },
      importActivity(id)     { return fetchJson(`${P}/import/${encodeURIComponent(id)}`, { method: "POST" }); },
      removeFromDenyList(id) { return fetchJson(`${P}/deny-list/${encodeURIComponent(id)}`, { method: "DELETE" }); },
      appConfig: {
        get()      { return fetchJson(`${P}/app-config`); },
        save(client_id, client_secret) {
          return fetchJson(`${P}/app-config`, { method: "PUT", body: JSON.stringify({ client_id, client_secret }) });
        },
        remove()   { return fetchJson(`${P}/app-config`, { method: "DELETE" }); },
      },
      autoSync: {
        get()      { return fetchJson(`${P}/auto-sync`); },
        save(body) { return fetchJson(`${P}/auto-sync`, { method: "PUT", body: JSON.stringify(body) }); },
        runNow()   { return fetchJson(`${P}/auto-sync/run`, { method: "POST" }); },
      },
    };
  },

  // Felszerelés (Könyvtár → Felszerelés): bringák, alkatrészek, karbantartás
  gear: {
    get()          { return fetchJson(`${BASE}/gear`); },
    save(doc)      { return fetchJson(`${BASE}/gear`, { method: "PUT", body: JSON.stringify(doc) }); },
    taskDone(body) { return fetchJson(`${BASE}/gear/task-done`, { method: "POST", body: JSON.stringify(body) }); },
    bulkBike(ids, bike_id) {
      return fetchJson(`${BASE}/routes/bulk-bike`, { method: "POST", body: JSON.stringify({ ids, bike_id }) });
    },
    /** Fotó feltöltése (a hívó már átméretezte – JPEG blob). */
    async uploadPhoto(type, id, blob) {
      // közvetlen fetch: a fetchJson az egyéni fejlécnél elhagyná az Authorization-t
      const res = await fetch(`${BASE}/gear/photo/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
        method: "POST", body: blob, headers: { ...authHeaders(), "Content-Type": blob.type || "image/jpeg" },
      });
      if (res.status === 401) { handle401(); throw new Error("Lejárt munkamenet"); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    deletePhoto(type, id) {
      return fetchJson(`${BASE}/gear/photo/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    /** A kép csak bejelentkezve érhető el → blob (az <img> nem küld Authorization fejlécet). */
    async photoBlob(name) {
      const res = await fetch(`${BASE}/gear/photo/${encodeURIComponent(name)}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    },
  },
};
