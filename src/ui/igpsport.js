/**
 * Bringaterv – iGPSport modul
 * =====================================
 * Az iGPSport kerékpáros komputerek az iGPSport appal szinkronizálnak. A kapcsolat
 * a Beállítások panelen: e-mail + jelszó belépés (a token 7 napig él – utána újra kell
 * csatlakozni, a szerver előtte push-értesítést küld), státusz, lecsatlakozás.
 * Könyvtár → Import → „iGPSportból”: edzések letöltése (eredeti FIT → GPX a szerveren).
 * Útvonal küldése: library.js „igpsport-route” művelet és a Tervező Mentés ablaka.
 * Az onelap.js mintájára (nem hivatalos API – docs/IGPSPORT_NOTES.md).
 */

import { routesApi } from '../api/routesApi.js';
import { createToast } from './dom.js';
import { loadRouteLibrary } from './library.js';
import { num } from "../format.js";
import { createAutoSyncPanel } from "./autoSync.js";

let _showToast = () => {};
let _igpStatus = null;
let _igpActivities = [];

export function getIgpsportStatus() { return _igpStatus; }

export function initIgpsport({ showToast } = {}) {
  const toastEl = document.querySelector("#toast");
  _showToast = showToast || (toastEl ? createToast(toastEl) : (() => {}));

  document.querySelector("#igpsportImportClose")?.addEventListener("click", closeIgpImportModal);
  document.querySelector("#igpsportImportOverlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeIgpImportModal();
  });
  document.querySelector("#igpsportImportListBtn")?.addEventListener("click", fetchAndRenderIgpActivities);
  document.querySelector("#igpsportImportRunBtn")?.addEventListener("click", runIgpImport);
  document.querySelector("#igpsportImportSelectAll")?.addEventListener("change", (e) => {
    const onlyNew = e.target.checked;
    document.querySelectorAll("#igpsportImportList .strava-import-row").forEach(row => {
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb.disabled) return;
      cb.checked = onlyNew ? (row.querySelector(".strava-import-badge--new") !== null) : false;
    });
    updateIgpImportSummary();
  });

  document.querySelector("#libraryImportIgpsportItem")?.addEventListener("click", () => {
    document.querySelector("#libraryImportMenu")?.setAttribute("hidden", "");
    if (_igpStatus?.connected) openIgpImportModal();
    else _showToast("Előbb csatlakozz az iGPSporthoz: Beállítások → iGPSport");
  });

  _autoSync = createAutoSyncPanel({
    prefix: "igpsport", api: routesApi.igpsport.autoSync, label: "iGPSport",
    showToast: (...a) => _showToast(...a), onNewWorkouts: loadRouteLibrary,
  });

  refreshIgpsportStatus();
}

// Automatikus import panel (autoSync.js) – a kapcsolat megléte esetén figyel
let _autoSync = null;

function escapeHtmlStr(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Státusz ───────────────────────────────────────────────────────────────────
export async function refreshIgpsportStatus() {
  const stateEl = document.querySelector("#igpsportConnectionState");
  try {
    _igpStatus = await Promise.race([
      routesApi.igpsport.status(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Időtúllépés")), 12000)),
    ]);
  } catch (err) {
    _igpStatus = null;
    if (stateEl) {
      stateEl.innerHTML = `
        <div class="strava-conn-error" style="margin-bottom:8px">Nem sikerült lekérdezni az iGPSport állapotot: ${escapeHtmlStr(err.message)}</div>
        <button class="strava-conn-btn strava-conn-btn--ghost" id="igpsportRetryBtn" type="button">Újrapróbálkozás</button>`;
      stateEl.querySelector("#igpsportRetryBtn")?.addEventListener("click", refreshIgpsportStatus);
    }
    updateIgpImportButton();
    return;
  }
  renderIgpState(stateEl, _igpStatus);
  updateIgpImportButton();
  if (_igpStatus?.connected) _autoSync?.start();
  else _autoSync?.stop();
}

function updateIgpImportButton() {
  const item   = document.querySelector("#libraryImportIgpsportItem");
  const status = item?.querySelector(".lib-import-igpsport-status");
  if (!item) return;
  const ok = !!_igpStatus?.connected;
  item.disabled = !ok;
  item.title = ok ? "iGPSport-edzések importálása (eredeti FIT)"
                  : "iGPSport kapcsolat szükséges – Beállítások → iGPSport";
  if (status) status.textContent = ok ? "" : "nincs kapcsolat";
}

function renderIgpState(el, status) {
  if (!el) return;
  if (!status) {
    el.innerHTML = `<div class="strava-conn-loading">Állapot lekérdezése…</div>`;
    return;
  }
  if (status.connected) renderConnectedState(el, status);
  else {
    renderLoginForm(el);
    if (status.expired) el.insertAdjacentHTML("afterbegin", `<div class="strava-conn-error" style="margin-bottom:8px">Lejárt az iGPSport-belépés (${escapeHtmlStr(status.account || "")}) – lépj be újra; az importált edzéseid megmaradnak.</div>`);
    const em = el.querySelector("#igpsportEmail");
    if (em && status.account) em.value = status.account;
  }
}

function renderConnectedState(el, status) {
  const dt = status.connected_at ? new Date(status.connected_at).toLocaleString("hu-HU") : "—";
  el.innerHTML = `
    <div class="strava-conn-meta">
      Csatlakozva mint: <strong>${escapeHtmlStr(status.nickname || status.account || "ismeretlen")}</strong>${status.nickname && status.account ? ` (${escapeHtmlStr(status.account)})` : ""}
      <br>Csatlakozás dátuma: ${dt}
      ${status.expires_at ? `<br>A belépés érvényes: <strong>${new Date(status.expires_at).toLocaleString("hu-HU", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</strong>-ig
        <span class="igp-exp-note">(az iGPSport 7 naponta új belépést kér – előtte értesítünk)</span>` : ""}
    </div>
    <div class="strava-conn-row">
      <button class="strava-conn-btn strava-conn-btn--ghost" id="igpDisconnectBtn" type="button">Lecsatlakoztatás</button>
    </div>`;
  el.querySelector("#igpDisconnectBtn")?.addEventListener("click", igpDisconnect);
}

function renderLoginForm(el) {
  el.innerHTML = `
    <div class="strava-conn-meta" style="margin-bottom:8px">
      Csatlakoztasd az iGPSport fiókodat (app.igpsport.com – nemzetközi fiók, e-mail címmel).
      A jelszót nem tároljuk – csak a belépési tokent, ami 7 napig érvényes; lejárat előtt
      értesítünk, és itt egy kattintással újra beléphetsz.
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;max-width:320px">
      <input id="igpsportEmail" class="form-input" type="email" placeholder="iGPSport e-mail" autocomplete="off" style="font-size:13px">
      <input id="igpsportPassword" class="form-input" type="password" placeholder="iGPSport jelszó" autocomplete="off" style="font-size:13px">
      <div style="display:flex;gap:8px;align-items:center">
        <button id="igpsportConnectBtn" class="strava-conn-btn" type="button" style="background:#EB3D2E">
          <img class="brand-icon" src="./assets/brands/igpsport.png" width="14" height="14" alt="iGPSport">
          Csatlakozás
        </button>
        <span id="igpsportConnectMsg" style="font-size:11px;color:var(--muted)"></span>
      </div>
    </div>`;
  el.querySelector("#igpsportConnectBtn")?.addEventListener("click", submitIgpLogin);
  el.querySelector("#igpsportPassword")?.addEventListener("keydown", e => { if (e.key === "Enter") submitIgpLogin(); });
}

async function submitIgpLogin() {
  const email = document.querySelector("#igpsportEmail")?.value.trim();
  const pw    = document.querySelector("#igpsportPassword")?.value;
  const msgEl = document.querySelector("#igpsportConnectMsg");
  const btn   = document.querySelector("#igpsportConnectBtn");
  const setMsg = (t, color) => { if (msgEl) { msgEl.textContent = t; msgEl.style.color = color || "var(--muted)"; } };
  if (!email || !pw) { setMsg("E-mail és jelszó kötelező.", "#dc2626"); return; }
  try {
    btn.disabled = true;
    setMsg("Belépés az iGPSportba…");
    const res = await routesApi.igpsport.connect(email, pw);
    _showToast(`iGPSport csatlakoztatva: ${res.account || ""}`);
    refreshIgpsportStatus();
  } catch (err) {
    setMsg("Hiba: " + err.message, "#dc2626");
  } finally {
    const b = document.querySelector("#igpsportConnectBtn");
    if (b) b.disabled = false;
  }
}

async function igpDisconnect() {
  if (!confirm("Biztosan lecsatlakozol az iGPSportról? (A már importált edzések megmaradnak.)")) return;
  try {
    await routesApi.igpsport.disconnect();
    await refreshIgpsportStatus();
  } catch (err) {
    alert("Lecsatlakozás hiba: " + err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// IMPORT ABLAK  (a Strava/Garmin import-ablak osztályait használja)
// ══════════════════════════════════════════════════════════════════════════════

export function openIgpImportModal() {
  const overlay = document.querySelector("#igpsportImportOverlay");
  if (!overlay) return;
  overlay.hidden = false;
  document.querySelector("#igpsportImportList").innerHTML = "";
  document.querySelector("#igpsportImportStatus").textContent = "Kattints a Listázás gombra az iGPSport-edzéseid betöltéséhez.";
  document.querySelector("#igpsportImportRunBtn").disabled = true;
  document.querySelector("#igpsportImportSummary").textContent = "";
  document.querySelector("#igpsportImportFooter").hidden = true;
  document.querySelector("#igpsportImportProgress").hidden = true;
  document.querySelector("#igpsportProgressBar").style.width = "0%";
  const selectAll = document.querySelector("#igpsportImportSelectAll");
  if (selectAll) selectAll.checked = false;
  _igpActivities = [];
}

function closeIgpImportModal() {
  const overlay = document.querySelector("#igpsportImportOverlay");
  if (overlay) overlay.hidden = true;
}

async function fetchAndRenderIgpActivities() {
  const listEl   = document.querySelector("#igpsportImportList");
  const statusEl = document.querySelector("#igpsportImportStatus");
  const footer   = document.querySelector("#igpsportImportFooter");
    const limit    = parseInt(document.querySelector("#igpsportImportLimit").value);

  listEl.innerHTML = "";
  document.querySelector("#igpsportImportSummary").textContent = "";
  document.querySelector("#igpsportImportRunBtn").disabled = true;
  statusEl.textContent = "Lekérdezés folyamatban… (edzésenként a pontos indulási időt is lekérjük – pár másodperc)";

  let res;
  try {
    res = await routesApi.igpsport.activities({ limit });
  } catch (err) {
    footer.hidden = true;
    if (err.message?.toLowerCase().includes("érvénytelen") || err.message?.toLowerCase().includes("nincs igpsport") || err.message?.toLowerCase().includes("lejárt")) {
      statusEl.innerHTML = `<span style="color:#dc2626">Az iGPSport-belépés lejárt vagy érvénytelen. <strong>Csatlakozz újra a Beállítások → iGPSport panelben.</strong></span>`;
      await refreshIgpsportStatus();
      return;
    }
    statusEl.innerHTML = `<span style="color:#dc2626">Hiba: ${escapeHtmlStr(err.message)}</span>`;
    return;
  }

  _igpActivities = res.activities || [];
  if (_igpActivities.length === 0) {
    statusEl.textContent = "Nincs edzés az iGPSport-fiókodban.";
    footer.hidden = true;
    return;
  }
  statusEl.textContent = `${_igpActivities.length} edzés betöltve.`;
  footer.hidden = false;
  renderIgpActivityList();
}

function renderIgpActivityList() {
  const listEl = document.querySelector("#igpsportImportList");
  listEl.innerHTML = "";
  for (const a of _igpActivities) {
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
      if (e.target.tagName === "INPUT") { updateIgpImportSummary(); return; }
      const cb = row.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
      updateIgpImportSummary();
    });
    listEl.append(row);
  }
  updateIgpImportSummary();
}

function updateIgpImportSummary() {
  const checked  = document.querySelectorAll("#igpsportImportList input[type='checkbox']:checked").length;
  const newCount = _igpActivities.filter(a => a.duplicate_status === "new").length;
  document.querySelector("#igpsportImportSummary").textContent = `${checked} kiválasztva · ${newCount} új a listán`;
  document.querySelector("#igpsportImportRunBtn").disabled = (checked === 0);
}

async function runIgpImport() {
  const runBtn      = document.querySelector("#igpsportImportRunBtn");
  const listBtn     = document.querySelector("#igpsportImportListBtn");
  const progressBar = document.querySelector("#igpsportProgressBar");
  const progressCnt = document.querySelector("#igpsportProgressCount");
  const progressCur = document.querySelector("#igpsportProgressCurrent");
  const checkedRows = [...document.querySelectorAll("#igpsportImportList .strava-import-row")]
    .filter(r => r.querySelector('input[type="checkbox"]')?.checked);
  if (checkedRows.length === 0) return;

  document.querySelector("#igpsportImportProgress").hidden = false;
  document.querySelector("#igpsportImportStatus").textContent = "";
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
        await routesApi.igpsport.removeFromDenyList(row.dataset.id).catch(() => {});
      }
      const r = await routesApi.igpsport.importActivity(row.dataset.id);
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
      console.error("iGPSport import hiba:", row.dataset.id, err);
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
