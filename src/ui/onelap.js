/**
 * Bringaterv – OnelapFit modul
 * =====================================
 * A Magene kerékpáros komputerek az OnelapFit appal szinkronizálnak. A kapcsolat
 * a Beállítások panelen: e-mail + jelszó belépés, státusz, lecsatlakozás.
 * Könyvtár → Import → „OnelapFitből”: edzések letöltése (FIT → GPX a szerveren).
 * Útvonal küldése az OnelapFit útvonalkönyvébe: library.js „onelap-route” művelet.
 *
 * A Garmin-modul mintája: main.js-ből inicializálva (initOnelap), a Strava
 * import-ablakának osztályait használja.
 */

import { routesApi } from '../api/routesApi.js';
import { createToast } from './dom.js';
import { loadRouteLibrary } from './library.js';
import { num } from "../format.js";
import { createAutoSyncPanel } from "./autoSync.js";

let _showToast = () => {};
let _onelapStatus = null;
let _onelapActivities = [];

export function getOnelapStatus() { return _onelapStatus; }

export function initOnelap({ showToast } = {}) {
  const toastEl = document.querySelector("#toast");
  _showToast = showToast || (toastEl ? createToast(toastEl) : (() => {}));

  document.querySelector("#onelapImportClose")?.addEventListener("click", closeOnelapImportModal);
  document.querySelector("#onelapImportOverlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeOnelapImportModal();
  });
  document.querySelector("#onelapImportListBtn")?.addEventListener("click", fetchAndRenderOnelapActivities);
  document.querySelector("#onelapImportRunBtn")?.addEventListener("click", runOnelapImport);
  document.querySelector("#onelapImportSelectAll")?.addEventListener("change", (e) => {
    const onlyNew = e.target.checked;
    document.querySelectorAll("#onelapImportList .strava-import-row").forEach(row => {
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb.disabled) return;
      cb.checked = onlyNew ? (row.querySelector(".strava-import-badge--new") !== null) : false;
    });
    updateOnelapImportSummary();
  });

  document.querySelector("#libraryImportOnelapItem")?.addEventListener("click", () => {
    document.querySelector("#libraryImportMenu")?.setAttribute("hidden", "");
    if (_onelapStatus?.connected) openOnelapImportModal();
    else _showToast("Előbb csatlakozz az OnelapFithez: Beállítások → OnelapFit");
  });

  _autoSync = createAutoSyncPanel({
    prefix: "onelap", api: routesApi.onelap.autoSync, label: "OnelapFit",
    showToast: (...a) => _showToast(...a), onNewWorkouts: loadRouteLibrary,
  });

  refreshOnelapStatus();
}

// Automatikus import panel (autoSync.js) – a kapcsolat megléte esetén figyel
let _autoSync = null;

function escapeHtmlStr(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Státusz ───────────────────────────────────────────────────────────────────
export async function refreshOnelapStatus() {
  const stateEl = document.querySelector("#onelapConnectionState");
  try {
    _onelapStatus = await Promise.race([
      routesApi.onelap.status(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Időtúllépés")), 12000)),
    ]);
  } catch (err) {
    _onelapStatus = null;
    if (stateEl) {
      stateEl.innerHTML = `
        <div class="strava-conn-error" style="margin-bottom:8px">Nem sikerült lekérdezni az OnelapFit állapotot: ${escapeHtmlStr(err.message)}</div>
        <button class="strava-conn-btn strava-conn-btn--ghost" id="onelapRetryBtn" type="button">Újrapróbálkozás</button>`;
      stateEl.querySelector("#onelapRetryBtn")?.addEventListener("click", refreshOnelapStatus);
    }
    updateOnelapImportButton();
    return;
  }
  renderOnelapState(stateEl, _onelapStatus);
  updateOnelapImportButton();
  if (_onelapStatus?.connected) _autoSync?.start();
  else _autoSync?.stop();
}

function updateOnelapImportButton() {
  const item   = document.querySelector("#libraryImportOnelapItem");
  const status = item?.querySelector(".lib-import-onelap-status");
  if (!item) return;
  const ok = !!_onelapStatus?.connected;
  item.disabled = !ok;
  item.title = ok ? "Magene-edzések importálása az OnelapFitből"
                  : "OnelapFit kapcsolat szükséges – Beállítások → OnelapFit";
  if (status) status.textContent = ok ? "" : "nincs kapcsolat";
}

function renderOnelapState(el, status) {
  if (!el) return;
  if (!status) {
    el.innerHTML = `<div class="strava-conn-loading">Állapot lekérdezése…</div>`;
    return;
  }
  if (status.connected) renderConnectedState(el, status);
  else renderLoginForm(el);
}

function renderConnectedState(el, status) {
  const dt = status.connected_at ? new Date(status.connected_at).toLocaleString("hu-HU") : "—";
  el.innerHTML = `
    <div class="strava-conn-meta">
      Csatlakozva mint: <strong>${escapeHtmlStr(status.account || "ismeretlen")}</strong>
      <br>Csatlakozás dátuma: ${dt}
    </div>
    <div class="strava-conn-row">
      <button class="strava-conn-btn strava-conn-btn--ghost" id="onelapDisconnectBtn" type="button">Lecsatlakoztatás</button>
    </div>`;
  el.querySelector("#onelapDisconnectBtn")?.addEventListener("click", onelapDisconnect);
}

function renderLoginForm(el) {
  el.innerHTML = `
    <div class="strava-conn-meta" style="margin-bottom:8px">
      Csatlakoztasd az OnelapFit fiókodat (ezzel szinkronizál a Magene komputered).
      A jelszót nem tároljuk – csak a belépési tokent. Ha az appba e-mailes kóddal lépsz be,
      előbb állíts be jelszót az appban (Elfelejtett jelszó).
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;max-width:320px">
      <input id="onelapEmail" class="form-input" type="email" placeholder="OnelapFit e-mail" autocomplete="off" style="font-size:13px">
      <input id="onelapPassword" class="form-input" type="password" placeholder="OnelapFit jelszó" autocomplete="off" style="font-size:13px">
      <div style="display:flex;gap:8px;align-items:center">
        <button id="onelapConnectBtn" class="strava-conn-btn" type="button" style="background:#0055FE">
          <img class="brand-icon" src="./assets/brands/onelapfit.png" width="14" height="14" alt="OnelapFit">
          Csatlakozás
        </button>
        <span id="onelapConnectMsg" style="font-size:11px;color:var(--muted)"></span>
      </div>
    </div>`;
  el.querySelector("#onelapConnectBtn")?.addEventListener("click", submitOnelapLogin);
  el.querySelector("#onelapPassword")?.addEventListener("keydown", e => { if (e.key === "Enter") submitOnelapLogin(); });
}

async function submitOnelapLogin() {
  const email = document.querySelector("#onelapEmail")?.value.trim();
  const pw    = document.querySelector("#onelapPassword")?.value;
  const msgEl = document.querySelector("#onelapConnectMsg");
  const btn   = document.querySelector("#onelapConnectBtn");
  const setMsg = (t, color) => { if (msgEl) { msgEl.textContent = t; msgEl.style.color = color || "var(--muted)"; } };
  if (!email || !pw) { setMsg("E-mail és jelszó kötelező.", "#dc2626"); return; }
  try {
    btn.disabled = true;
    setMsg("Belépés az OnelapFitbe…");
    const res = await routesApi.onelap.connect(email, pw);
    _showToast(`OnelapFit csatlakoztatva: ${res.account || ""}`);
    refreshOnelapStatus();
  } catch (err) {
    setMsg("Hiba: " + err.message, "#dc2626");
  } finally {
    const b = document.querySelector("#onelapConnectBtn");
    if (b) b.disabled = false;
  }
}

async function onelapDisconnect() {
  if (!confirm("Biztosan lecsatlakozol az OnelapFitről? (A már importált edzések megmaradnak.)")) return;
  try {
    await routesApi.onelap.disconnect();
    await refreshOnelapStatus();
  } catch (err) {
    alert("Lecsatlakozás hiba: " + err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// IMPORT ABLAK  (a Strava/Garmin import-ablak osztályait használja)
// ══════════════════════════════════════════════════════════════════════════════

export function openOnelapImportModal() {
  const overlay = document.querySelector("#onelapImportOverlay");
  if (!overlay) return;
  overlay.hidden = false;
  document.querySelector("#onelapImportList").innerHTML = "";
  document.querySelector("#onelapImportStatus").textContent = "Kattints a Listázás gombra a Magene-edzéseid betöltéséhez.";
  document.querySelector("#onelapImportRunBtn").disabled = true;
  document.querySelector("#onelapImportSummary").textContent = "";
  document.querySelector("#onelapImportFooter").hidden = true;
  document.querySelector("#onelapImportProgress").hidden = true;
  document.querySelector("#onelapProgressBar").style.width = "0%";
  const selectAll = document.querySelector("#onelapImportSelectAll");
  if (selectAll) selectAll.checked = false;
  _onelapActivities = [];
}

function closeOnelapImportModal() {
  const overlay = document.querySelector("#onelapImportOverlay");
  if (overlay) overlay.hidden = true;
}

async function fetchAndRenderOnelapActivities() {
  const listEl   = document.querySelector("#onelapImportList");
  const statusEl = document.querySelector("#onelapImportStatus");
  const footer   = document.querySelector("#onelapImportFooter");
  const days     = parseInt(document.querySelector("#onelapImportRange").value);
  const limit    = parseInt(document.querySelector("#onelapImportLimit").value);

  listEl.innerHTML = "";
  document.querySelector("#onelapImportSummary").textContent = "";
  document.querySelector("#onelapImportRunBtn").disabled = true;
  statusEl.textContent = "Lekérdezés folyamatban…";

  let res;
  try {
    res = await routesApi.onelap.activities({ days, limit });
  } catch (err) {
    footer.hidden = true;
    if (err.message?.toLowerCase().includes("érvénytelen") || err.message?.toLowerCase().includes("nincs onelap")) {
      statusEl.innerHTML = `<span style="color:#dc2626">Az OnelapFit kapcsolat érvénytelenné vált. <strong>Csatlakozz újra a Beállítások → OnelapFit panelben.</strong></span>`;
      await refreshOnelapStatus();
      return;
    }
    statusEl.innerHTML = `<span style="color:#dc2626">Hiba: ${escapeHtmlStr(err.message)}</span>`;
    return;
  }

  _onelapActivities = res.activities || [];
  if (_onelapActivities.length === 0) {
    statusEl.textContent = "Nincs edzés ebben az időszakban.";
    footer.hidden = true;
    return;
  }
  statusEl.textContent = `${_onelapActivities.length} edzés betöltve.`;
  footer.hidden = false;
  renderOnelapActivityList();
}

function renderOnelapActivityList() {
  const listEl = document.querySelector("#onelapImportList");
  listEl.innerHTML = "";
  for (const a of _onelapActivities) {
    const date = a.start_date ? new Date(a.start_date).toLocaleDateString("hu-HU", { month: "2-digit", day: "2-digit" }) : "—";
    const distKm = a.distance_m ? num((a.distance_m / 1000), 1) : "—";
    const movMin = a.moving_time_s ? Math.round(a.moving_time_s / 60) : "—";
    const st = a.duplicate_status;
    const isNew      = st === "new";
    const isImported = st === "already_imported";
    const isLikely   = st === "likely_duplicate";
    const badgeCls  = isNew ? "new" : isImported ? "imported" : isLikely ? "likely" : "deleted";
    const badgeText = isNew ? "Új" : isImported ? "Már megvan" : isLikely ? "Hasonló van (más forrás)" : "Korábban törölted";
    const row = document.createElement("div");
    row.className = "strava-import-row" + (isImported ? " is-disabled" : "");
    row.dataset.id = a.id;
    row.dataset.startTs = a.start_ts;
    row.innerHTML = `
      <input type="checkbox" ${isNew ? "checked" : ""} ${isImported ? "disabled" : ""}>
      <span class="strava-import-date">${date}</span>
      <span class="strava-import-name">${escapeHtmlStr(a.name || "—")}</span>
      <span class="strava-import-num strava-import-time">${movMin} p</span>
      <span class="strava-import-num strava-import-dist">${distKm} km</span>
      <span class="strava-import-badge strava-import-badge--${badgeCls}">${badgeText}</span>
    `;
    row.addEventListener("click", (e) => {
      if (isImported) return;
      if (e.target.tagName === "INPUT") { updateOnelapImportSummary(); return; }
      const cb = row.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
      updateOnelapImportSummary();
    });
    listEl.append(row);
  }
  updateOnelapImportSummary();
}

function updateOnelapImportSummary() {
  const checked  = document.querySelectorAll("#onelapImportList input[type='checkbox']:checked").length;
  const newCount = _onelapActivities.filter(a => a.duplicate_status === "new").length;
  document.querySelector("#onelapImportSummary").textContent = `${checked} kiválasztva · ${newCount} új a listán`;
  document.querySelector("#onelapImportRunBtn").disabled = (checked === 0);
}

async function runOnelapImport() {
  const runBtn      = document.querySelector("#onelapImportRunBtn");
  const listBtn     = document.querySelector("#onelapImportListBtn");
  const progressBar = document.querySelector("#onelapProgressBar");
  const progressCnt = document.querySelector("#onelapProgressCount");
  const progressCur = document.querySelector("#onelapProgressCurrent");
  const checkedRows = [...document.querySelectorAll("#onelapImportList .strava-import-row")]
    .filter(r => r.querySelector('input[type="checkbox"]')?.checked);
  if (checkedRows.length === 0) return;

  document.querySelector("#onelapImportProgress").hidden = false;
  document.querySelector("#onelapImportStatus").textContent = "";
  progressBar.style.width = "0%";
  progressCnt.textContent = `0 / ${checkedRows.length}`;
  progressCur.textContent = "";
  progressCur.className = "strava-progress-current";
  runBtn.disabled  = true;
  listBtn.disabled = true;

  let done = 0, fail = 0, dupSkipped = 0;
  for (let i = 0; i < checkedRows.length; i++) {
    const row  = checkedRows[i];
    const name = row.querySelector(".strava-import-name")?.textContent || "Edzés";
    row.classList.add("is-importing");
    progressCur.textContent = `Most: ${name}`;
    progressCur.className   = "strava-progress-current";

    try {
      // a tiltólistáról (korábban törölt) visszahozott edzés ne kerüljön oda újra
      if (row.querySelector(".strava-import-badge--deleted")) {
        await routesApi.onelap.removeFromDenyList(row.dataset.id).catch(() => {});
      }
      const r = await routesApi.onelap.importActivity(row.dataset.id, Number(row.dataset.startTs));
      if (r && r.ok === false) throw new Error(r.error || "Nincs GPS adat");
      if (r?.skipped && r.reason === "duplicate") {
        dupSkipped++;
        row.classList.remove("is-importing");
        row.style.opacity = "0.55";
        const b = row.querySelector(".strava-import-badge");
        if (b) { b.textContent = "Kihagyva – már megvan"; b.className = "strava-import-badge strava-import-badge--likely"; b.title = `Más forrásból már a könyvtárban: „${r.duplicate_name || ""}”. Ha mégis kell: Beállítások → Edzés-import → Ismétlődés-védelem ki.`; }
        const c = row.querySelector('input[type="checkbox"]');
        if (c) { c.checked = false; c.disabled = true; }
      } else {
        done++;
        row.classList.remove("is-importing");
        row.style.opacity = "0.55";
        const badge = row.querySelector(".strava-import-badge");
        if (badge) { badge.textContent = "Importálva"; badge.className = "strava-import-badge strava-import-badge--imported"; }
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb) { cb.checked = false; cb.disabled = true; }
      }
    } catch (err) {
      fail++;
      row.classList.remove("is-importing");
      console.error("OnelapFit import hiba:", row.dataset.id, err);
      progressCur.textContent = `Hiba: ${name} – ${err.message}`;
      progressCur.className   = "strava-progress-current is-error";
    }

    progressBar.style.width = Math.round(((i + 1) / checkedRows.length) * 100) + "%";
    progressCnt.textContent = `${i + 1} / ${checkedRows.length}`;
    if (i < checkedRows.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  progressCur.textContent = `Kész: ${done} importálva${dupSkipped > 0 ? `, ${dupSkipped} kihagyva (már megvan más forrásból)` : ""}${fail > 0 ? `, ${fail} hiba` : ""}`;
  progressCur.className   = "strava-progress-current " + (fail > 0 ? "is-error" : "is-success");
  if (done > 0) { try { await loadRouteLibrary(); } catch {} }
  runBtn.disabled  = false;
  listBtn.disabled = false;
}
