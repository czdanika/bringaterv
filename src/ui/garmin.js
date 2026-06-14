/**
 * Bringaterv – Garmin Connect Module (önálló, plug-in modul)
 * ==========================================================
 * Garmin kapcsolat a Beállítások panelen: email+jelszó (+MFA) belépés,
 * státusz, lecsatlakozás, testsúly-szinkron a kerékpáros profilba.
 *
 * NEM épül be a main.js-be – önállóan bootstrapel. Bekötés:
 *   <script type="module" src="./src/ui/garmin.js"></script>
 *
 * A main.js-szel csak lazán, megosztott DOM-on (#toast, #garminConnectionState)
 * és a bringaterv:settingChanged eseményen keresztül érintkezik.
 */

import { routesApi } from '../api/routesApi.js';
import { createToast } from './dom.js';
import { isAuthenticated } from '../auth.js';
import { loadRouteLibrary } from './library.js';

// ── Saját toast (nem injektált) ───────────────────────────────────────────────
let _showToast = () => {};

export function initGarmin({ showToast } = {}) {
  const toastEl = document.querySelector("#toast");
  _showToast = showToast || (toastEl ? createToast(toastEl) : (() => {}));

  // Import modal gombok
  document.querySelector("#garminImportClose")?.addEventListener("click", closeGarminImportModal);
  document.querySelector("#garminImportOverlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeGarminImportModal();
  });
  document.querySelector("#garminImportListBtn")?.addEventListener("click", fetchAndRenderGarminActivities);
  document.querySelector("#garminImportRunBtn")?.addEventListener("click", runGarminImport);
  document.querySelector("#garminImportSelectAll")?.addEventListener("change", (e) => {
    const onlyNew = e.target.checked;
    document.querySelectorAll("#garminImportList .strava-import-row").forEach(row => {
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb.disabled) return;
      cb.checked = onlyNew ? (row.querySelector(".strava-import-badge--new") !== null) : false;
    });
    updateGarminImportSummary();
  });

  // Könyvtár import dropdown – Garmin elem (a library.js generikus loopja ezt nem kezeli)
  document.querySelector("#libraryImportGarminItem")?.addEventListener("click", () => {
    document.querySelector("#libraryImportMenu")?.setAttribute("hidden", "");
    if (_garminStatus?.connected) openGarminImportModal();
    else _showToast("Előbb csatlakozz Garminhoz: Beállítások → Garmin Connect");
  });

  refreshGarminStatus();
}

// ── Önálló bootstrap – csak ha be vagyunk jelentkezve és van DOM csatlakozási pont ──
function bootstrap() {
  if (!isAuthenticated()) return;            // login.html / kijelentkezett állapot
  if (!document.querySelector("#garminConnectionState")) return;  // nincs settings panel
  initGarmin();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}

// ── State ─────────────────────────────────────────────────────────────────────
let _garminStatus = null;

export function getGarminStatus() { return _garminStatus; }

function escapeHtmlStr(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Státusz ───────────────────────────────────────────────────────────────────
export async function refreshGarminStatus() {
  const stateEl = document.querySelector("#garminConnectionState");
  try {
    // Időkorlát: ha 12 mp alatt nincs válasz, ne ragadjon be a „lekérdezés"
    _garminStatus = await Promise.race([
      routesApi.garmin.status(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Időtúllépés")), 12000)),
    ]);
  } catch (err) {
    _garminStatus = null;
    if (stateEl) {
      stateEl.innerHTML = `
        <div class="strava-conn-error" style="margin-bottom:8px">Nem sikerült lekérdezni a Garmin állapotot: ${escapeHtmlStr(err.message)}</div>
        <button class="strava-conn-btn strava-conn-btn--ghost" id="garminRetryBtn" type="button">Újrapróbálkozás</button>`;
      stateEl.querySelector("#garminRetryBtn")?.addEventListener("click", refreshGarminStatus);
    }
    updateGarminImportButton();
    return;
  }
  renderGarminState(stateEl, _garminStatus);
  updateGarminImportButton();
}

// A könyvtár import-dropdown Garmin elemének engedélyezése a kapcsolat alapján
function updateGarminImportButton() {
  const item   = document.querySelector("#libraryImportGarminItem");
  const status = item?.querySelector(".lib-import-garmin-status");
  if (!item) return;
  const ok = !!_garminStatus?.connected;
  item.disabled = !ok;
  item.title = ok ? "Garmin aktivitások importálása a könyvtárba"
                  : "Garmin kapcsolat szükséges – Beállítások → Garmin Connect";
  if (status) status.textContent = ok ? "" : "nincs kapcsolat";
}

function renderGarminState(el, status) {
  if (!el) return;
  if (!status) {
    el.innerHTML = `<div class="strava-conn-loading">Állapot lekérdezése…</div>`;
    return;
  }
  if (!status.available) {
    el.innerHTML = `<div class="strava-conn-error">A Garmin integráció nincs telepítve a szerveren (garminconnect csomag hiányzik).</div>`;
    return;
  }
  if (status.connected) {
    renderConnectedState(el, status);
  } else {
    renderLoginForm(el);
  }
}

// ── Csatlakoztatott állapot ───────────────────────────────────────────────────
function renderConnectedState(el, status) {
  const dt = status.connected_at ? new Date(status.connected_at).toLocaleString("hu-HU") : "—";
  el.innerHTML = `
    <div class="strava-conn-meta">
      Csatlakozva mint: <strong>${escapeHtmlStr(status.full_name || "ismeretlen")}</strong>
      <br>Csatlakozás dátuma: ${dt}
    </div>
    <div id="garminWeightRow" style="margin:10px 0;padding:10px;background:var(--panel-strong);border-radius:8px;font-size:12px">
      <span style="color:var(--muted)">⚖️ Testsúly lekérdezése…</span>
    </div>
    <div class="strava-conn-row">
      <button class="strava-conn-btn strava-conn-btn--ghost" id="garminDisconnectBtn" type="button">Lecsatlakoztatás</button>
    </div>`;
  el.querySelector("#garminDisconnectBtn")?.addEventListener("click", garminDisconnect);
  loadGarminWeight();
}

async function loadGarminWeight() {
  const row = document.querySelector("#garminWeightRow");
  if (!row) return;
  let w;
  try {
    w = await routesApi.garmin.weight();
  } catch (err) {
    row.innerHTML = `<span style="color:var(--muted)">⚖️ Testsúly nem elérhető: ${escapeHtmlStr(err.message)}</span>`;
    return;
  }
  if (!w.has_data) {
    row.innerHTML = `<span style="color:var(--muted)">⚖️ Nincs testsúly-adat a Garmin fiókban (az elmúlt 1 évben). Ha van Garmin mérleged, az első mérés után itt megjelenik.</span>`;
    return;
  }
  const dateStr = w.date ? new Date(w.date).toLocaleDateString("hu-HU") : "—";
  const fat = w.body_fat ? ` · testzsír ${w.body_fat.toFixed(1)}%` : "";
  row.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span>⚖️ Legutóbbi mérés: <strong>${w.weight_kg} kg</strong> (${dateStr})${fat}</span>
      <button id="garminWeightSyncBtn" class="strava-conn-btn strava-conn-btn--ghost" type="button" style="font-size:11px;padding:4px 10px">
        Beírás a kerékpáros profilba
      </button>
    </div>`;
  row.querySelector("#garminWeightSyncBtn")?.addEventListener("click", () => syncWeightToProfile(w.weight_kg));
}

function syncWeightToProfile(weightKg) {
  // Ugyanaz a mentési út, mint a kézi profilszerkesztésnél:
  // localStorage + settingChanged event → debounced szerver sync (main.js)
  let profile = {};
  try { profile = JSON.parse(localStorage.getItem("bringaterv.cyclistProfile") || "{}") || {}; } catch {}
  profile.riderKg = weightKg;
  localStorage.setItem("bringaterv.cyclistProfile", JSON.stringify(profile));
  window.dispatchEvent(new CustomEvent("bringaterv:settingChanged", { detail: { kind: "cyclistProfile" } }));
  // Ha nyitva van a profil szekció, frissítsük a mezőt is
  const riderEl = document.getElementById("profileRiderKg");
  if (riderEl) riderEl.value = weightKg;
  _showToast?.(`Testsúly frissítve a profilban: ${weightKg} kg`);
}

// ── Belépési űrlap (email + jelszó, majd MFA) ─────────────────────────────────
function renderLoginForm(el) {
  el.innerHTML = `
    <div class="strava-conn-meta" style="margin-bottom:8px">
      Csatlakoztasd a Garmin Connect fiókodat. A jelszót nem tároljuk – csak a belépési tokent.
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;max-width:320px">
      <input id="garminEmail" class="form-input" type="email" placeholder="Garmin email" autocomplete="off" style="font-size:13px">
      <input id="garminPassword" class="form-input" type="password" placeholder="Garmin jelszó" autocomplete="off" style="font-size:13px">
      <div id="garminMfaBlock" hidden>
        <div style="font-size:12px;color:var(--accent);margin-bottom:6px">
          📧 A Garmin ellenőrző kódot küldött (email/SMS). Írd be ide:
        </div>
        <input id="garminMfaCode" class="form-input" type="text" inputmode="numeric" placeholder="MFA kód" autocomplete="off" style="font-size:13px;letter-spacing:2px">
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button id="garminConnectBtn" class="strava-conn-btn" type="button" style="background:#007CC3">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;background:#fff;color:#007CC3;border-radius:2px;font-size:9px;font-weight:800">G</span>
          Csatlakozás
        </button>
        <span id="garminConnectMsg" style="font-size:11px;color:var(--muted)"></span>
      </div>
    </div>`;
  el.querySelector("#garminConnectBtn")?.addEventListener("click", submitGarminLogin);
  el.querySelector("#garminPassword")?.addEventListener("keydown", e => { if (e.key === "Enter") submitGarminLogin(); });
  el.querySelector("#garminMfaCode")?.addEventListener("keydown", e => { if (e.key === "Enter") submitGarminLogin(); });
}

let _mfaPending = false;

async function submitGarminLogin() {
  const emailEl = document.querySelector("#garminEmail");
  const pwEl    = document.querySelector("#garminPassword");
  const mfaEl   = document.querySelector("#garminMfaCode");
  const msgEl   = document.querySelector("#garminConnectMsg");
  const btn     = document.querySelector("#garminConnectBtn");
  const setMsg  = (t, color) => { if (msgEl) { msgEl.textContent = t; msgEl.style.color = color || "var(--muted)"; } };

  try {
    btn.disabled = true;

    if (_mfaPending) {
      const code = mfaEl?.value.trim();
      if (!code) { setMsg("Írd be a kapott kódot.", "#dc2626"); return; }
      setMsg("Kód ellenőrzése…");
      const res = await routesApi.garmin.mfa(code);
      onGarminConnected(res);
      return;
    }

    const email = emailEl?.value.trim();
    const pw    = pwEl?.value;
    if (!email || !pw) { setMsg("Email és jelszó kötelező.", "#dc2626"); return; }
    setMsg("Belépés a Garminba… (eltarthat pár másodpercig)");
    const res = await routesApi.garmin.connect(email, pw);
    if (res.mfa_required) {
      _mfaPending = true;
      const block = document.querySelector("#garminMfaBlock");
      if (block) block.hidden = false;
      emailEl.disabled = pwEl.disabled = true;
      setMsg("Kód elküldve – írd be fent.", "var(--accent)");
      mfaEl?.focus();
      return;
    }
    onGarminConnected(res);
  } catch (err) {
    // Lejárt MFA folyamat (410) vagy hibás kód → vissza az elejére
    if (_mfaPending) {
      _mfaPending = false;
      setMsg("Hiba: " + err.message, "#dc2626");
      setTimeout(() => refreshGarminStatus(), 2500);
    } else {
      setMsg("Hiba: " + err.message, "#dc2626");
    }
  } finally {
    const b = document.querySelector("#garminConnectBtn");
    if (b) b.disabled = false;
  }
}

function onGarminConnected(res) {
  _mfaPending = false;
  _showToast?.(`Garmin csatlakoztatva: ${res.full_name || ""}`);
  refreshGarminStatus();
}

async function garminDisconnect() {
  if (!confirm("Biztosan lecsatlakozol a Garmin Connectről? (A már szinkronizált adatok megmaradnak.)")) return;
  try {
    await routesApi.garmin.disconnect();
    _mfaPending = false;
    await refreshGarminStatus();
  } catch (err) {
    alert("Lecsatlakozás hiba: " + err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GARMIN IMPORT MODAL  (a Strava modál stílusát/osztályait újrahasználja)
// ══════════════════════════════════════════════════════════════════════════════

let _garminActivities = [];

export function openGarminImportModal() {
  const overlay = document.querySelector("#garminImportOverlay");
  if (!overlay) return;
  overlay.hidden = false;
  document.querySelector("#garminImportList").innerHTML = "";
  document.querySelector("#garminImportStatus").textContent = "Kattints a Listázás gombra a Garmin-aktivitásaid betöltéséhez.";
  document.querySelector("#garminImportRunBtn").disabled = true;
  document.querySelector("#garminImportSummary").textContent = "";
  document.querySelector("#garminImportFooter").hidden = true;
  document.querySelector("#garminImportProgress").hidden = true;
  document.querySelector("#garminProgressBar").style.width = "0%";
  const selectAll = document.querySelector("#garminImportSelectAll");
  if (selectAll) selectAll.checked = false;
  _garminActivities = [];
}

function closeGarminImportModal() {
  const overlay = document.querySelector("#garminImportOverlay");
  if (overlay) overlay.hidden = true;
}

async function fetchAndRenderGarminActivities() {
  const listEl   = document.querySelector("#garminImportList");
  const statusEl = document.querySelector("#garminImportStatus");
  const runBtn   = document.querySelector("#garminImportRunBtn");
  const summary  = document.querySelector("#garminImportSummary");
  const range    = parseInt(document.querySelector("#garminImportRange").value);
  const limit    = parseInt(document.querySelector("#garminImportLimit").value);

  listEl.innerHTML = "";
  summary.textContent = "";
  runBtn.disabled = true;
  statusEl.textContent = "Lekérdezés folyamatban…";

  let after = null;
  if (range > 0) {
    const d = new Date(Date.now() - range * 86400000);
    after = d.toISOString().slice(0, 10);  // YYYY-MM-DD
  }

  let res;
  try {
    res = await routesApi.garmin.activities({ limit, after });
  } catch (err) {
    if (err.message?.includes("409") || err.message?.toLowerCase().includes("érvénytelen") || err.message?.toLowerCase().includes("nincs garmin")) {
      statusEl.innerHTML = `<span style="color:#dc2626">A Garmin kapcsolat érvénytelenné vált. <strong>Csatlakozz újra a Beállítások → Garmin Connect panelben.</strong></span>`;
      document.querySelector("#garminImportFooter").hidden = true;
      await refreshGarminStatus();
      return;
    }
    statusEl.innerHTML = `<span style="color:#dc2626">Hiba: ${escapeHtmlStr(err.message)}</span>`;
    document.querySelector("#garminImportFooter").hidden = true;
    return;
  }

  let activities = res.activities || [];
  activities.sort((a, b) => {
    const ta = a.start_date ? new Date(a.start_date).getTime() : 0;
    const tb = b.start_date ? new Date(b.start_date).getTime() : 0;
    return tb - ta;
  });
  _garminActivities = activities;
  if (_garminActivities.length === 0) {
    statusEl.textContent = "Nincs aktivitás ebben az időszakban.";
    document.querySelector("#garminImportFooter").hidden = true;
    return;
  }
  statusEl.textContent = `${_garminActivities.length} aktivitás betöltve.`;
  document.querySelector("#garminImportFooter").hidden = false;
  renderGarminActivityList();
}

function renderGarminActivityList() {
  const listEl = document.querySelector("#garminImportList");
  listEl.innerHTML = "";
  for (const a of _garminActivities) {
    const date = a.start_date ? new Date(a.start_date).toLocaleDateString("hu-HU", { month:"2-digit", day:"2-digit" }) : "—";
    const distKm = a.distance_m ? (a.distance_m / 1000).toFixed(1) : "—";
    const movMin = a.moving_time_s ? Math.round(a.moving_time_s / 60) : "—";
    const st = a.duplicate_status;
    const isNew      = st === "new";
    const isImported = st === "already_imported";
    const isLikely   = st === "likely_duplicate";
    const badgeCls  = isNew ? "new" : isImported ? "imported" : isLikely ? "likely" : "deleted";
    const badgeText = isNew ? "Új" : isImported ? "Már megvan" : isLikely ? "Hasonló van (más forrás)" : "Korábban törölted";
    const disabled  = isImported;
    const row = document.createElement("div");
    row.className = "strava-import-row" + (disabled ? " is-disabled" : "");
    row.dataset.id = a.id;
    row.innerHTML = `
      <input type="checkbox" ${isNew ? "checked" : ""} ${disabled ? "disabled" : ""}>
      <span class="strava-import-date">${date}</span>
      <span class="strava-import-name">${escapeHtmlStr(a.name || "—")}</span>
      <span class="strava-import-num strava-import-time">${movMin} p</span>
      <span class="strava-import-num strava-import-dist">${distKm} km</span>
      <span class="strava-import-badge strava-import-badge--${badgeCls}">${badgeText}</span>
    `;
    row.addEventListener("click", (e) => {
      if (disabled) return;
      if (e.target.tagName === "INPUT") { updateGarminImportSummary(); return; }
      const cb = row.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
      updateGarminImportSummary();
    });
    listEl.append(row);
  }
  updateGarminImportSummary();
}

function updateGarminImportSummary() {
  const runBtn  = document.querySelector("#garminImportRunBtn");
  const summary = document.querySelector("#garminImportSummary");
  const checked = document.querySelectorAll("#garminImportList input[type='checkbox']:checked").length;
  const newCount = _garminActivities.filter(a => a.duplicate_status === "new").length;
  summary.textContent = `${checked} kiválasztva · ${newCount} új a listán`;
  runBtn.disabled = (checked === 0);
}

async function runGarminImport() {
  const runBtn      = document.querySelector("#garminImportRunBtn");
  const listBtn     = document.querySelector("#garminImportListBtn");
  const statusEl    = document.querySelector("#garminImportStatus");
  const progressEl  = document.querySelector("#garminImportProgress");
  const progressBar = document.querySelector("#garminProgressBar");
  const progressCnt = document.querySelector("#garminProgressCount");
  const progressCur = document.querySelector("#garminProgressCurrent");
  const checkedRows = [...document.querySelectorAll("#garminImportList .strava-import-row")]
    .filter(r => r.querySelector('input[type="checkbox"]')?.checked);
  if (checkedRows.length === 0) return;

  progressEl.hidden = false;
  progressBar.style.width = "0%";
  progressCnt.textContent = `0 / ${checkedRows.length}`;
  progressCur.textContent = "";
  progressCur.className = "strava-progress-current";
  statusEl.textContent = "";
  runBtn.disabled  = true;
  listBtn.disabled = true;

  let done = 0, fail = 0;
  for (let i = 0; i < checkedRows.length; i++) {
    const row  = checkedRows[i];
    const id   = parseInt(row.dataset.id);
    const name = row.querySelector(".strava-import-name")?.textContent || `Aktivitás ${id}`;

    row.classList.add("is-importing");
    progressCur.textContent = `Most: ${name}`;
    progressCur.className   = "strava-progress-current";

    try {
      const r = await routesApi.garmin.importActivity(id);
      if (r && r.ok === false) throw new Error(r.error || "Nincs GPS adat");
      done++;
      row.classList.remove("is-importing");
      row.style.opacity = "0.55";
      const badge = row.querySelector(".strava-import-badge");
      if (badge) { badge.textContent = "Importálva"; badge.className = "strava-import-badge strava-import-badge--imported"; }
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) { cb.checked = false; cb.disabled = true; }
    } catch (err) {
      fail++;
      row.classList.remove("is-importing");
      console.error("Garmin import hiba:", id, err);
      progressCur.textContent = `Hiba: ${name} – ${err.message}`;
      progressCur.className   = "strava-progress-current is-error";
    }

    const pct = Math.round(((i + 1) / checkedRows.length) * 100);
    progressBar.style.width = pct + "%";
    progressCnt.textContent = `${i + 1} / ${checkedRows.length}`;
    if (i < checkedRows.length - 1) await new Promise(r => setTimeout(r, 800));
  }

  progressCur.textContent = `Kész: ${done} importálva${fail > 0 ? `, ${fail} hiba` : ""}`;
  progressCur.className   = "strava-progress-current " + (fail > 0 ? "is-error" : "is-success");
  if (done > 0) { try { await loadRouteLibrary(); } catch {} }
  runBtn.disabled  = false;
  listBtn.disabled = false;
}
