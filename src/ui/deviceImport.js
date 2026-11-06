/**
 * Bringaterv – Wahoo / Polar import (hivatalos OAuth-os API-k)
 * ============================================================
 * Egy modul mindkét gyártóhoz:
 *   • Beállítások → Wahoo / Polar: a saját fejlesztői alkalmazás kulcsai (útmutatóval),
 *     csatlakozás (popupban a gyártó belépési oldala, a /api/<provider>/callback
 *     postMessage-dzsel szól vissza), állapot, lecsatlakozás;
 *   • Könyvtár → Import → Wahoo-ból / Polarból: import ablak (lista, kijelölés, import,
 *     automatikus import panel – autoSync.js). Az ablakot ez a modul rajzolja.
 *
 * Elemek az index.html-ben: #<provider>ConnectionState (beállítás-szekció),
 * #libraryImport<Label>Item (import menüpont, .lib-import-<provider>-status felirattal).
 */

import { routesApi } from "../api/routesApi.js";
import { createToast, showResultDialog } from "./dom.js";
import { loadRouteLibrary } from "./library.js";
import { num } from "../format.js";
import { createAutoSyncPanel } from "./autoSync.js";

const PROVIDERS = {
  wahoo: {
    label: "Wahoo", from: "Wahoo-ból", icon: "./assets/brands/wahoo.png", color: "#000",
    note: "Csak a Wahoo saját eszközein / appjaiban rögzített edzéseket adja ki.",
    portal: "https://developers.wahooligan.com/applications",
    steps: [
      `Nyisd meg a <a href="https://developers.wahooligan.com/applications" target="_blank" rel="noopener">developers.wahooligan.com</a> oldalt, és lépj be a Wahoo-fiókoddal.`,
      `Hozz létre egy új alkalmazást (<b>Sandbox</b> – azonnal használható, nem kell a Wahoo jóváhagyására várni). Név pl. „Bringaterv – saját”, leírás: „Saját edzéseim importálása”.`,
      `<b>Redirect URI</b>: másold be az alábbi címet.`,
      `Jogosultságok (scopes): <b>user_read</b>, <b>workouts_read</b>, <b>offline_data</b>.`,
      `Mentés után másold ide a <b>Client ID</b>-t és a <b>Client Secret</b>-et, majd Csatlakozás.`,
    ],
    tip: "A Sandbox napi 250 kérést enged – egy embernek bőven elég (a 15 perces automatikus import kb. napi 100).",
  },
  polar: {
    label: "Polar", from: "Polarból", icon: "./assets/brands/polar.png", color: "#D10027",
    note: "A Polar csak a csatlakozás után feltöltött, legfeljebb 30 napos edzéseket adja ki – a régebbieket a Polar Flow-ból exportálva, fájlból hozhatod be.",
    portal: "https://admin.polaraccesslink.com",
    steps: [
      `Nyisd meg az <a href="https://admin.polaraccesslink.com" target="_blank" rel="noopener">admin.polaraccesslink.com</a> oldalt, és lépj be a Polar Flow fiókoddal.`,
      `<b>Create new client</b>: név pl. „Bringaterv – saját”, leírás, elérhetőség (ingyenes, jóváhagyás nélkül).`,
      `<b>Authorization callback / Redirect URL</b>: másold be az alábbi címet.`,
      `Mentés után másold ide a <b>Client ID</b>-t és a <b>Client Secret</b>-et, majd Csatlakozás.`,
    ],
    tip: "A Polar adatainak forrása a Polar Flow – a könyvtárban „Polar” forrásként jelennek meg.",
  },
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let _showToast = () => {};
const _status = {};
const _auto = {};

export function getDeviceStatus(provider) { return _status[provider] || null; }

export function initDeviceImports({ showToast } = {}) {
  const toastEl = document.querySelector("#toast");
  _showToast = showToast || (toastEl ? createToast(toastEl) : (() => {}));

  // A callback-oldal postMessage-e (csak a saját originről fogadjuk el)
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || e.data?.type !== "device-oauth") return;
    const p = PROVIDERS[e.data.provider];
    if (!p) return;
    if (e.data.success) _showToast(`${p.label} csatlakoztatva${e.data.name ? ": " + e.data.name : ""}`);
    else _showToast(`${p.label} csatlakozás sikertelen: ${e.data.error || "ismeretlen hiba"}`, 8000);
    refreshStatus(e.data.provider);
  });

  for (const [key, p] of Object.entries(PROVIDERS)) {
    buildModal(key, p);
    _auto[key] = createAutoSyncPanel({
      prefix: key, api: routesApi.devices(key).autoSync, label: p.label,
      showToast: (...a) => _showToast(...a), onNewWorkouts: loadRouteLibrary,
    });
    document.querySelector(`#libraryImport${p.label}Item`)?.addEventListener("click", () => {
      document.querySelector("#libraryImportMenu")?.setAttribute("hidden", "");
      if (_status[key]?.connected) openModal(key);
      else _showToast(`Előbb csatlakozz: Beállítások → ${p.label}`);
    });
    refreshStatus(key);
  }
}

// ── Állapot + beállítás-szekció ───────────────────────────────────────────────
async function refreshStatus(key) {
  const p = PROVIDERS[key];
  const el = document.querySelector(`#${key}ConnectionState`);
  const api = routesApi.devices(key);
  let app;
  try {
    [_status[key], app] = await Promise.all([api.status(), api.appConfig.get()]);
  } catch (err) {
    _status[key] = null;
    if (el) el.innerHTML = `<div class="strava-conn-error">Nem sikerült lekérdezni a ${esc(p.label)}-állapotot: ${esc(err.message)}</div>`;
    updateMenuItem(key);
    return;
  }
  const s = _status[key];
  if (el) {
    if (!s.app_configured) {
      el.innerHTML = `
        <div class="strava-conn-meta" style="margin-bottom:8px">A ${esc(p.label)}-import a ${esc(p.label)} hivatalos kapcsolatán megy. Ehhez egyszer létre kell hoznod egy saját (ingyenes) fejlesztői alkalmazást – kb. 5 perc:</div>
        ${appForm(key, app, true)}`;
    } else if (s.connected) {
      const dt = s.connected_at ? new Date(s.connected_at).toLocaleString("hu-HU") : "—";
      el.innerHTML = `
        <div class="strava-conn-meta">Csatlakozva${s.name ? " mint: <strong>" + esc(s.name) + "</strong>" : ""}<br>Csatlakozás dátuma: ${dt}</div>
        <div class="strava-conn-meta" style="margin-top:6px">${esc(p.note)}</div>
        <div class="strava-conn-row"><button class="strava-conn-btn strava-conn-btn--ghost" data-dev-disconnect type="button">Lecsatlakoztatás</button></div>
        ${app.source === "user" ? `<details class="device-app-details"><summary>Saját alkalmazás kulcsai</summary>${appForm(key, app, false)}</details>` : ""}`;
      el.querySelector("[data-dev-disconnect]").addEventListener("click", () => disconnect(key));
    } else {
      el.innerHTML = `
        <div class="strava-conn-meta" style="margin-bottom:8px">Csatlakoztasd a ${esc(p.label)}-fiókodat: a ${esc(p.label)} saját belépési oldala nyílik meg, a jelszavadat a Bringaterv nem látja. ${esc(p.note)}</div>
        <button class="strava-conn-btn" data-dev-connect type="button" style="background:${p.color}">
          <img class="brand-icon" src="${p.icon}" width="14" height="14" alt=""> Csatlakozás
        </button>
        ${app.source === "user" ? `<details class="device-app-details"><summary>Saját alkalmazás kulcsai</summary>${appForm(key, app, false)}</details>` : ""}`;
      el.querySelector("[data-dev-connect]").addEventListener("click", () => connect(key));
    }
    bindAppForm(key, el);
  }
  updateMenuItem(key);
  if (s.connected) _auto[key]?.start(); else _auto[key]?.stop();
}

/** A saját fejlesztői alkalmazás űrlapja (útmutatóval, ha még nincs kulcs). */
function appForm(key, app, withGuide) {
  const p = PROVIDERS[key];
  return `
    ${withGuide ? `<ol class="device-app-steps">${p.steps.map((t) => `<li>${t}</li>`).join("")}</ol>` : ""}
    <div class="device-app-form" data-dev-app-form>
      <label class="device-app-field"><span>Redirect URI</span>
        <span class="device-app-copy"><code data-dev-redirect>${esc(app.redirect_uri)}</code>
        <button class="strava-conn-btn strava-conn-btn--ghost" data-dev-copy type="button">Másolás</button></span></label>
      <label class="device-app-field"><span>Client ID</span>
        <input class="form-input" data-dev-cid type="text" autocomplete="off" spellcheck="false" value="${esc(app.client_id)}"></label>
      <label class="device-app-field"><span>Client Secret</span>
        <input class="form-input" data-dev-secret type="password" autocomplete="off" spellcheck="false"
               placeholder="${app.secret_set ? "•••• (megadva – új megadásához írd be)" : ""}"></label>
      <div class="strava-conn-row">
        <button class="strava-conn-btn" data-dev-save type="button" style="background:${p.color}">Mentés</button>
        ${app.source === "user" ? `<button class="strava-conn-btn strava-conn-btn--ghost" data-dev-app-remove type="button">Kulcsok törlése</button>` : ""}
        <span class="device-app-msg" data-dev-app-msg></span>
      </div>
      ${withGuide ? `<div class="strava-conn-meta" style="margin-top:6px">${esc(p.tip)} Részletek: Súgó → Wahoo és Polar.</div>` : ""}
    </div>`;
}

function bindAppForm(key, el) {
  const form = el.querySelector("[data-dev-app-form]");
  if (!form) return;
  const msg = form.querySelector("[data-dev-app-msg]");
  form.querySelector("[data-dev-copy]")?.addEventListener("click", async () => {
    const uri = form.querySelector("[data-dev-redirect]").textContent;
    try { await navigator.clipboard.writeText(uri); msg.textContent = "Kimásolva."; }
    catch { msg.textContent = "Jelöld ki és másold kézzel."; }
  });
  form.querySelector("[data-dev-save]")?.addEventListener("click", async () => {
    msg.textContent = "Mentés…"; msg.style.color = "";
    try {
      await routesApi.devices(key).appConfig.save(form.querySelector("[data-dev-cid]").value.trim(),
                                                   form.querySelector("[data-dev-secret]").value.trim());
      _showToast(`${PROVIDERS[key].label}: kulcsok elmentve – most már csatlakozhatsz.`);
      refreshStatus(key);
    } catch (err) { msg.textContent = err.message; msg.style.color = "#dc2626"; }
  });
  form.querySelector("[data-dev-app-remove]")?.addEventListener("click", async () => {
    if (!confirm(`Törlöd a saját ${PROVIDERS[key].label}-alkalmazásod kulcsait? A kapcsolat is megszűnik (a már importált edzések megmaradnak).`)) return;
    try { await routesApi.devices(key).appConfig.remove(); refreshStatus(key); }
    catch (err) { msg.textContent = err.message; msg.style.color = "#dc2626"; }
  });
}

function updateMenuItem(key) {
  const p = PROVIDERS[key];
  const item = document.querySelector(`#libraryImport${p.label}Item`);
  if (!item) return;
  const ok = !!_status[key]?.connected;
  item.disabled = !ok;
  item.title = ok ? `${p.label}-edzések importálása` : `${p.label}-kapcsolat szükséges – Beállítások → ${p.label}`;
  const st = item.querySelector(`.lib-import-${key}-status`);
  if (st) st.textContent = ok ? "" : "nincs kapcsolat";
}

async function connect(key) {
  // A popupot még a kattintás alatt nyitjuk meg (különben a böngésző blokkolja)
  const w = 520, h = 720;
  const popup = window.open("about:blank", `${key}-oauth`,
    `width=${w},height=${h},left=${(screen.width - w) / 2},top=${(screen.height - h) / 2}`);
  try {
    const { auth_url } = await routesApi.devices(key).connect();
    if (popup) popup.location.href = auth_url; else location.href = auth_url;
  } catch (err) {
    popup?.close();
    _showToast(`${PROVIDERS[key].label}: ${err.message}`, 8000);
  }
}

async function disconnect(key) {
  if (!confirm(`Biztosan lecsatlakozol a ${PROVIDERS[key].label}-fiókról? (A már importált edzések megmaradnak.)`)) return;
  try {
    await routesApi.devices(key).disconnect();
    await refreshStatus(key);
  } catch (err) {
    alert("Lecsatlakozás hiba: " + err.message);
  }
}

// ── Import ablak ──────────────────────────────────────────────────────────────
function buildModal(key, p) {
  const ov = document.createElement("div");
  ov.id = `${key}ImportOverlay`;
  ov.className = "shortcut-overlay device-import-overlay";
  ov.hidden = true;
  ov.innerHTML = `
    <div class="strava-import-panel">
      <div class="strava-import-header">
        <h3><img class="brand-icon" src="${p.icon}" width="20" height="20" alt=""> ${esc(p.label)} import</h3>
        <button class="shortcut-close" data-dev-close type="button" aria-label="Bezárás">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="strava-import-body">
        <section class="strava-auto">
          <div class="strava-auto-row">
            <div class="strava-auto-text">
              <strong>Automatikus import</strong>
              <span>Az új ${esc(p.label)}-edzések maguktól bekerülnek a könyvtárba.</span>
            </div>
            <label class="toggle-switch" title="Automatikus import be/ki">
              <input id="${key}AutoToggle" type="checkbox"><span class="toggle-track"></span>
            </label>
          </div>
          <div class="strava-auto-opts" id="${key}AutoOpts" hidden>
            <label class="strava-import-control">
              <span>Ellenőrzés</span>
              <select id="${key}AutoInterval">
                <option value="5">5 percenként</option>
                <option value="15" selected>15 percenként</option>
                <option value="30">30 percenként</option>
                <option value="60">óránként</option>
              </select>
            </label>
            <div class="strava-auto-foot">
              <span id="${key}AutoStatus" class="strava-auto-status"></span>
              <button id="${key}AutoRunBtn" class="strava-list-btn" type="button">Ellenőrzés most</button>
            </div>
          </div>
        </section>
        <div class="strava-import-controls">
          <label class="strava-import-control"><span>Időszak</span>
            <select data-dev-range>
              <option value="30">Utolsó 30 nap</option><option value="90">Utolsó 90 nap</option>
              <option value="365">Utolsó 1 év</option><option value="1095">Utolsó 3 év</option>
            </select></label>
          <label class="strava-import-control"><span>Max edzés</span>
            <select data-dev-limit>
              <option value="30" selected>30</option><option value="60">60</option><option value="100">100</option><option value="200">200 (lassú)</option>
            </select></label>
          <button class="strava-list-btn" data-dev-list type="button">Listázás</button>
        </div>
        <div class="strava-import-status" data-dev-status></div>
        <div class="strava-import-progress" data-dev-progress hidden>
          <div class="strava-progress-header"><span>Importálás folyamatban…</span><span class="strava-progress-count" data-dev-count>0 / 0</span></div>
          <div class="strava-progress-track"><div class="strava-progress-bar" data-dev-bar style="width:0%"></div></div>
          <div class="strava-progress-current" data-dev-current></div>
        </div>
        <div class="strava-import-list" data-dev-rows></div>
      </div>
      <div class="strava-import-footer" data-dev-footer hidden>
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
          <input type="checkbox" data-dev-selectall> Mindent ami új
        </label>
        <span data-dev-summary style="margin-left:auto;color:var(--muted);font-size:12px"></span>
        <button class="strava-list-btn strava-list-btn--primary" data-dev-run type="button" disabled>Import kiválasztottakat</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const q = (sel) => ov.querySelector(sel);
  q("[data-dev-close]").addEventListener("click", () => { ov.hidden = true; });
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !ov.hidden) ov.hidden = true; });
  q("[data-dev-list]").addEventListener("click", () => listActivities(key));
  q("[data-dev-run]").addEventListener("click", () => runImport(key));
  q("[data-dev-selectall]").addEventListener("change", (e) => {
    ov.querySelectorAll(".strava-import-row").forEach((row) => {
      const cb = row.querySelector('input[type="checkbox"]');
      if (!cb.disabled) cb.checked = e.target.checked && !!row.querySelector(".strava-import-badge--new");
    });
    updateSummary(key);
  });
}

const modal = (key) => document.querySelector(`#${key}ImportOverlay`);

export function openModal(key) {
  const ov = modal(key);
  ov.hidden = false;
  ov.querySelector("[data-dev-rows]").innerHTML = "";
  ov.querySelector("[data-dev-status]").textContent = `Kattints a Listázás gombra a ${PROVIDERS[key].label}-edzéseid betöltéséhez.`;
  ov.querySelector("[data-dev-footer]").hidden = true;
  ov.querySelector("[data-dev-progress]").hidden = true;
  ov.querySelector("[data-dev-selectall]").checked = false;
}

const _lists = {};

async function listActivities(key) {
  const ov = modal(key);
  const statusEl = ov.querySelector("[data-dev-status]");
  const days = Number(ov.querySelector("[data-dev-range]").value);
  const limit = Number(ov.querySelector("[data-dev-limit]").value);
  ov.querySelector("[data-dev-rows]").innerHTML = "";
  ov.querySelector("[data-dev-footer]").hidden = true;
  statusEl.textContent = "Lekérdezés folyamatban…";
  let res;
  try {
    res = await routesApi.devices(key).activities({ days, limit });
  } catch (err) {
    statusEl.innerHTML = `<span style="color:#dc2626">Hiba: ${esc(err.message)}</span>`;
    if ((err.message || "").toLowerCase().includes("kapcsolat")) refreshStatus(key);
    return;
  }
  const list = _lists[key] = res.activities || [];
  if (!list.length) {
    statusEl.textContent = key === "polar"
      ? "Nincs importálható edzés. (A Polar csak a csatlakozás után feltöltött, legfeljebb 30 napos edzéseket adja ki.)"
      : "Nincs edzés ebben az időszakban.";
    return;
  }
  statusEl.textContent = `${list.length} edzés betöltve.`;
  ov.querySelector("[data-dev-footer]").hidden = false;
  const rows = ov.querySelector("[data-dev-rows]");
  for (const a of list) {
    const st = a.duplicate_status;
    const isNew = st === "new", isImported = st === "already_imported", isLikely = st === "likely_duplicate";
    const badgeCls = isNew ? "new" : isImported ? "imported" : isLikely ? "likely" : "deleted";
    const badgeText = isNew ? "Új" : isImported ? "Már megvan" : isLikely ? "Hasonló van (más forrás)" : "Korábban törölted";
    const row = document.createElement("div");
    row.className = "strava-import-row" + (isImported ? " is-disabled" : "");
    row.dataset.id = a.id;
    row.innerHTML = `
      <input type="checkbox" ${isNew ? "checked" : ""} ${isImported ? "disabled" : ""}>
      <span class="strava-import-date">${a.start_date ? new Date(a.start_date).toLocaleDateString("hu-HU", { month: "2-digit", day: "2-digit" }) : "—"}</span>
      <span class="strava-import-name">${esc(a.name || "Edzés")}</span>
      <span class="strava-import-num strava-import-time">${a.moving_time_s ? Math.round(a.moving_time_s / 60) : "—"} p</span>
      <span class="strava-import-num strava-import-dist">${a.distance_m ? num(a.distance_m / 1000, 1) : "—"} km</span>
      <span class="strava-import-badge strava-import-badge--${badgeCls}">${badgeText}</span>`;
    row.addEventListener("click", (e) => {
      if (isImported) return;
      if (e.target.tagName !== "INPUT") { const cb = row.querySelector("input"); cb.checked = !cb.checked; }
      updateSummary(key);
    });
    rows.append(row);
  }
  updateSummary(key);
}

function updateSummary(key) {
  const ov = modal(key);
  const checked = ov.querySelectorAll("[data-dev-rows] input:checked").length;
  const newCount = (_lists[key] || []).filter((a) => a.duplicate_status === "new").length;
  ov.querySelector("[data-dev-summary]").textContent = `${checked} kiválasztva · ${newCount} új a listán`;
  ov.querySelector("[data-dev-run]").disabled = checked === 0;
}

async function runImport(key) {
  const ov = modal(key);
  const api = routesApi.devices(key);
  const rows = [...ov.querySelectorAll(".strava-import-row")].filter((r) => r.querySelector("input")?.checked);
  if (!rows.length) return;
  const bar = ov.querySelector("[data-dev-bar]"), cnt = ov.querySelector("[data-dev-count]"), cur = ov.querySelector("[data-dev-current]");
  ov.querySelector("[data-dev-progress]").hidden = false;
  ov.querySelector("[data-dev-run]").disabled = true;
  ov.querySelector("[data-dev-list]").disabled = true;
  let done = 0, fail = 0, dup = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = row.querySelector(".strava-import-name")?.textContent || "Edzés";
    const badge = row.querySelector(".strava-import-badge");
    row.classList.add("is-importing");
    cur.textContent = `Most: ${name}`; cur.className = "strava-progress-current";
    try {
      if (badge?.classList.contains("strava-import-badge--deleted")) await api.removeFromDenyList(row.dataset.id).catch(() => {});
      const r = await api.importActivity(row.dataset.id);
      if (r && r.ok === false) throw new Error(r.error || "Nincs GPS adat");
      if (r?.skipped && r.reason === "duplicate") {
        dup++;
        badge.textContent = "Kihagyva – már megvan"; badge.className = "strava-import-badge strava-import-badge--likely";
      } else {
        done++;
        badge.textContent = "Importálva"; badge.className = "strava-import-badge strava-import-badge--imported";
      }
      row.style.opacity = "0.55";
      const cb = row.querySelector("input"); cb.checked = false; cb.disabled = true;
    } catch (err) {
      fail++;
      cur.textContent = `Hiba: ${name} – ${err.message}`; cur.className = "strava-progress-current is-error";
    }
    row.classList.remove("is-importing");
    bar.style.width = Math.round(((i + 1) / rows.length) * 100) + "%";
    cnt.textContent = `${i + 1} / ${rows.length}`;
  }
  cur.textContent = `Kész: ${done} importálva${dup ? `, ${dup} kihagyva (már megvan más forrásból)` : ""}${fail ? `, ${fail} hiba` : ""}`;
  cur.className = "strava-progress-current " + (fail ? "is-error" : "is-success");
  if (done) { try { await loadRouteLibrary(); } catch { /* nem kritikus */ } }
  ov.querySelector("[data-dev-list]").disabled = false;
  updateSummary(key);
  if (done || fail) {
    showResultDialog({ ok: !fail, icon: PROVIDERS[key].icon,
      title: fail ? `${PROVIDERS[key].label} import: ${fail} hiba` : `${PROVIDERS[key].label} import kész`,
      lines: [`${done} edzés bekerült a könyvtárba.`, ...(dup ? [`${dup} kimaradt, mert más forrásból már megvan.`] : []),
              ...(fail ? ["A hibás edzések mellett a lista alján látod az okot."] : [])] });
  }
}
