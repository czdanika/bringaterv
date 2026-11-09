/**
 * Bringaterv – Bryton modul
 * =====================================
 * A Bryton (Rider) kerékpáros komputerek a Bryton Active appal szinkronizálnak. A kapcsolat
 * a Beállítások panelen: e-mail + jelszó belépés (a munkamenet kb. 90 napig él), státusz.
 * Könyvtár → Import → „Brytonból”: edzések letöltése (eredeti FIT → GPX a szerveren).
 * Útvonal küldése: library.js „bryton-route” művelet és a Tervező Mentés ablaka – a Bryton saját
 * útvonal-formátumában, kanyar-utasításokkal (nem hivatalos API – routes-api/bryton_service.py).
 */

import { routesApi } from '../api/routesApi.js';
import { createToast } from './dom.js';
import { loadRouteLibrary } from './library.js';
import { num } from "../format.js";
import { createAutoSyncPanel } from "./autoSync.js";

let _showToast = () => {};
let _brStatus = null;
let _brActivities = [];

export function getBrytonStatus() { return _brStatus; }

export function initBryton({ showToast } = {}) {
  const toastEl = document.querySelector("#toast");
  _showToast = showToast || (toastEl ? createToast(toastEl) : (() => {}));

  document.querySelector("#brytonImportClose")?.addEventListener("click", closeIgpImportModal);
  document.querySelector("#brytonImportOverlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeIgpImportModal();
  });
  document.querySelector("#brytonImportListBtn")?.addEventListener("click", fetchAndRenderIgpActivities);
  document.querySelector("#brytonImportRunBtn")?.addEventListener("click", runIgpImport);
  document.querySelector("#brytonImportSelectAll")?.addEventListener("change", (e) => {
    const onlyNew = e.target.checked;
    document.querySelectorAll("#brytonImportList .strava-import-row").forEach(row => {
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb.disabled) return;
      cb.checked = onlyNew ? (row.querySelector(".strava-import-badge--new") !== null) : false;
    });
    updateIgpImportSummary();
  });

  document.querySelector("#libraryImportBrytonItem")?.addEventListener("click", () => {
    document.querySelector("#libraryImportMenu")?.setAttribute("hidden", "");
    if (_brStatus?.connected) openIgpImportModal();
    else _showToast("Előbb csatlakozz a Brytonhoz: Beállítások → Bryton");
  });

  _autoSync = createAutoSyncPanel({
    prefix: "bryton", api: routesApi.bryton.autoSync, label: "Bryton",
    showToast: (...a) => _showToast(...a), onNewWorkouts: loadRouteLibrary,
  });

  refreshBrytonStatus();
}

// Automatikus import panel (autoSync.js) – a kapcsolat megléte esetén figyel
let _autoSync = null;

function escapeHtmlStr(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Státusz ───────────────────────────────────────────────────────────────────
export async function refreshBrytonStatus() {
  const stateEl = document.querySelector("#brytonConnectionState");
  try {
    _brStatus = await Promise.race([
      routesApi.bryton.status(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Időtúllépés")), 12000)),
    ]);
  } catch (err) {
    _brStatus = null;
    if (stateEl) {
      stateEl.innerHTML = `
        <div class="strava-conn-error" style="margin-bottom:8px">Nem sikerült lekérdezni a Bryton állapotot: ${escapeHtmlStr(err.message)}</div>
        <button class="strava-conn-btn strava-conn-btn--ghost" id="brytonRetryBtn" type="button">Újrapróbálkozás</button>`;
      stateEl.querySelector("#brytonRetryBtn")?.addEventListener("click", refreshBrytonStatus);
    }
    updateIgpImportButton();
    return;
  }
  renderIgpState(stateEl, _brStatus);
  updateIgpImportButton();
  if (_brStatus?.connected) _autoSync?.start();
  else _autoSync?.stop();
}

function updateIgpImportButton() {
  const item   = document.querySelector("#libraryImportBrytonItem");
  const status = item?.querySelector(".lib-import-bryton-status");
  if (!item) return;
  const ok = !!_brStatus?.connected;
  item.disabled = !ok;
  item.title = ok ? "Bryton-edzések importálása (eredeti FIT)"
                  : "Bryton kapcsolat szükséges – Beállítások → Bryton";
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
    if (status.expired) el.insertAdjacentHTML("afterbegin", `<div class="strava-conn-error" style="margin-bottom:8px">Lejárt a Bryton-belépés (${escapeHtmlStr(status.account || "")}) – lépj be újra; az importált edzéseid megmaradnak.</div>`);
    const em = el.querySelector("#brytonEmail");
    if (em && status.account) em.value = status.account;
  }
}

function renderConnectedState(el, status) {
  const dt = status.connected_at ? new Date(status.connected_at).toLocaleString("hu-HU") : "—";
  el.innerHTML = `
    <div class="strava-conn-meta">
      Csatlakozva mint: <strong>${escapeHtmlStr(status.account || "ismeretlen")}</strong>
      <br>Csatlakozás dátuma: ${dt}
      ${status.expires_at ? `<br>A belépés érvényes: <strong>${new Date(status.expires_at).toLocaleString("hu-HU", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</strong>-ig
        <span class="igp-exp-note">(utána újra be kell lépni – előtte értesítünk)</span>` : ""}
    </div>
    <div class="strava-conn-row">
      <button class="strava-conn-btn strava-conn-btn--ghost" id="brDisconnectBtn" type="button">Lecsatlakoztatás</button>
    </div>`;
  el.querySelector("#brDisconnectBtn")?.addEventListener("click", brDisconnect);
}

function renderLoginForm(el) {
  el.innerHTML = `
    <div class="strava-conn-meta" style="margin-bottom:8px">
      Csatlakoztasd a Bryton Active fiókodat (active.brytonsport.com – e-mail címmel).
      A jelszót nem tároljuk – csak a belépési tokent (kb. 90 napig érvényes, lejárat előtt értesítünk).
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;max-width:320px">
      <input id="brytonEmail" class="form-input" type="email" placeholder="Bryton Active e-mail" autocomplete="off" style="font-size:13px">
      <input id="brytonPassword" class="form-input" type="password" placeholder="Bryton Active jelszó" autocomplete="off" style="font-size:13px">
      <div style="display:flex;gap:8px;align-items:center">
        <button id="brytonConnectBtn" class="strava-conn-btn" type="button" style="background:#2b2b2b">
          <img class="brand-icon" src="./assets/brands/bryton.png" width="14" height="14" alt="Bryton">
          Csatlakozás
        </button>
        <span id="brytonConnectMsg" style="font-size:11px;color:var(--muted)"></span>
      </div>
    </div>`;
  el.querySelector("#brytonConnectBtn")?.addEventListener("click", submitIgpLogin);
  el.querySelector("#brytonPassword")?.addEventListener("keydown", e => { if (e.key === "Enter") submitIgpLogin(); });
}

async function submitIgpLogin() {
  const email = document.querySelector("#brytonEmail")?.value.trim();
  const pw    = document.querySelector("#brytonPassword")?.value;
  const msgEl = document.querySelector("#brytonConnectMsg");
  const btn   = document.querySelector("#brytonConnectBtn");
  const setMsg = (t, color) => { if (msgEl) { msgEl.textContent = t; msgEl.style.color = color || "var(--muted)"; } };
  if (!email || !pw) { setMsg("E-mail és jelszó kötelező.", "#dc2626"); return; }
  try {
    btn.disabled = true;
    setMsg("Belépés a Brytonba…");
    const res = await routesApi.bryton.connect(email, pw);
    _showToast(`Bryton csatlakoztatva: ${res.account || ""}`);
    refreshBrytonStatus();
  } catch (err) {
    setMsg("Hiba: " + err.message, "#dc2626");
  } finally {
    const b = document.querySelector("#brytonConnectBtn");
    if (b) b.disabled = false;
  }
}

async function brDisconnect() {
  if (!confirm("Biztosan lecsatlakozol a Brytonról? (A már importált edzések megmaradnak.)")) return;
  try {
    await routesApi.bryton.disconnect();
    await refreshBrytonStatus();
  } catch (err) {
    alert("Lecsatlakozás hiba: " + err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// IMPORT ABLAK  (a Strava/Garmin import-ablak osztályait használja)
// ══════════════════════════════════════════════════════════════════════════════

export function openIgpImportModal() {
  const overlay = document.querySelector("#brytonImportOverlay");
  if (!overlay) return;
  overlay.hidden = false;
  document.querySelector("#brytonImportList").innerHTML = "";
  document.querySelector("#brytonImportStatus").textContent = "Kattints a Listázás gombra a Bryton-edzéseid betöltéséhez.";
  document.querySelector("#brytonImportRunBtn").disabled = true;
  document.querySelector("#brytonImportSummary").textContent = "";
  document.querySelector("#brytonImportFooter").hidden = true;
  document.querySelector("#brytonImportProgress").hidden = true;
  document.querySelector("#brytonProgressBar").style.width = "0%";
  const selectAll = document.querySelector("#brytonImportSelectAll");
  if (selectAll) selectAll.checked = false;
  _brActivities = [];
}

function closeIgpImportModal() {
  const overlay = document.querySelector("#brytonImportOverlay");
  if (overlay) overlay.hidden = true;
}

async function fetchAndRenderIgpActivities() {
  const listEl   = document.querySelector("#brytonImportList");
  const statusEl = document.querySelector("#brytonImportStatus");
  const footer   = document.querySelector("#brytonImportFooter");
    const limit    = parseInt(document.querySelector("#brytonImportLimit").value);

  listEl.innerHTML = "";
  document.querySelector("#brytonImportSummary").textContent = "";
  document.querySelector("#brytonImportRunBtn").disabled = true;
  statusEl.textContent = "Lekérdezés folyamatban…";

  let res;
  try {
    res = await routesApi.bryton.activities({ limit });
  } catch (err) {
    footer.hidden = true;
    if (err.message?.toLowerCase().includes("érvénytelen") || err.message?.toLowerCase().includes("nincs bryton") || err.message?.toLowerCase().includes("lejárt")) {
      statusEl.innerHTML = `<span style="color:#dc2626">A Bryton-belépés lejárt vagy érvénytelen. <strong>Csatlakozz újra a Beállítások → Bryton panelben.</strong></span>`;
      await refreshBrytonStatus();
      return;
    }
    statusEl.innerHTML = `<span style="color:#dc2626">Hiba: ${escapeHtmlStr(err.message)}</span>`;
    return;
  }

  _brActivities = res.activities || [];
  if (_brActivities.length === 0) {
    statusEl.textContent = "Nincs edzés a Bryton Active fiókodban.";
    footer.hidden = true;
    return;
  }
  statusEl.textContent = `${_brActivities.length} edzés betöltve.`;
  footer.hidden = false;
  renderIgpActivityList();
}

function renderIgpActivityList() {
  const listEl = document.querySelector("#brytonImportList");
  listEl.innerHTML = "";
  for (const a of _brActivities) {
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
  const checked  = document.querySelectorAll("#brytonImportList input[type='checkbox']:checked").length;
  const newCount = _brActivities.filter(a => a.duplicate_status === "new").length;
  document.querySelector("#brytonImportSummary").textContent = `${checked} kiválasztva · ${newCount} új a listán`;
  document.querySelector("#brytonImportRunBtn").disabled = (checked === 0);
}

async function runIgpImport() {
  const runBtn      = document.querySelector("#brytonImportRunBtn");
  const listBtn     = document.querySelector("#brytonImportListBtn");
  const progressBar = document.querySelector("#brytonProgressBar");
  const progressCnt = document.querySelector("#brytonProgressCount");
  const progressCur = document.querySelector("#brytonProgressCurrent");
  const checkedRows = [...document.querySelectorAll("#brytonImportList .strava-import-row")]
    .filter(r => r.querySelector('input[type="checkbox"]')?.checked);
  if (checkedRows.length === 0) return;

  document.querySelector("#brytonImportProgress").hidden = false;
  document.querySelector("#brytonImportStatus").textContent = "";
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
        await routesApi.bryton.removeFromDenyList(row.dataset.id).catch(() => {});
      }
      const r = await routesApi.bryton.importActivity(row.dataset.id);
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
      console.error("Bryton import hiba:", row.dataset.id, err);
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
