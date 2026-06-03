/**
 * Bringaterv – Strava Module
 * ===========================
 * Strava kapcsolat (settings), user app credentials, import modal.
 *
 * Init:
 *   import { initStrava } from './ui/strava.js';
 *   initStrava({ showToast, loadRouteLibrary });
 */

import { routesApi } from '../api/routesApi.js';

// ── Injektált függőségek ──────────────────────────────────────────────────────
let _showToast, _loadRouteLibrary;

export function initStrava({ showToast, loadRouteLibrary }) {
  _showToast = showToast;
  _loadRouteLibrary = loadRouteLibrary;

  // Settings panel gombok
  document.querySelector("#stravaUserAppSaveBtn")?.addEventListener("click", saveStravaUserAppConfig);
  document.querySelector("#stravaUserAppClearBtn")?.addEventListener("click", clearStravaUserAppConfig);
  document.querySelector("#stravaUserAppOpenBtn")?.addEventListener("click", openStravaAppConfigModal);
  document.querySelector("#stravaAppConfigCloseBtn")?.addEventListener("click", closeStravaAppConfigModal);
  document.querySelector("#stravaAppConfigOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "stravaAppConfigOverlay") closeStravaAppConfigModal();
  });

  // Import modal gombok
  document.querySelector("#stravaImportClose")?.addEventListener("click", closeStravaImportModal);
  document.querySelector("#stravaImportOverlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeStravaImportModal();
  });
  document.querySelector("#stravaImportListBtn")?.addEventListener("click", fetchAndRenderStravaActivities);
  document.querySelector("#stravaImportRunBtn")?.addEventListener("click", runStravaImport);
  document.querySelector("#stravaImportSelectAll")?.addEventListener("change", (e) => {
    const onlyNew = e.target.checked;
    document.querySelectorAll("#stravaImportList .strava-import-row").forEach(row => {
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb.disabled) return;
      const isNew = row.querySelector(".strava-import-badge--new") !== null;
      cb.checked = onlyNew ? isNew : false;
    });
    updateStravaImportSummary();
  });

  // OAuth popup → szülő ablak értesítés
  window.addEventListener("message", (e) => {
    if (!e.data || e.data.type !== "strava-oauth") return;
    if (e.data.success) {
      refreshStravaStatus();
      _showToast?.(`Strava csatlakoztatva: ${e.data.athlete_name || ""}`);
    } else {
      alert("Strava kapcsolódás sikertelen: " + (e.data.error || "ismeretlen hiba"));
    }
  });

  // Inicializáció
  refreshStravaStatus();
}

// ── State ─────────────────────────────────────────────────────────────────────
let _stravaStatus     = null;
let _stravaActivities = [];

export function getStravaStatus() { return _stravaStatus; }

// ── Helper ────────────────────────────────────────────────────────────────────
function escapeHtmlStr(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Strava kapcsolat ──────────────────────────────────────────────────────────
export async function refreshStravaStatus() {
  const stateEl = document.querySelector("#stravaConnectionState");
  const stravaImportItem = document.querySelector("#libraryImportStravaItem");
  const stravaImportStatus = stravaImportItem?.querySelector(".lib-import-strava-status");
  try {
    _stravaStatus = await routesApi.strava.status();
  } catch (err) {
    _stravaStatus = null;
    if (stateEl) stateEl.innerHTML = `<div class="strava-conn-error">Hiba a státusz lekérésekor: ${err.message}</div>`;
    return;
  }
  renderStravaState(stateEl, _stravaStatus);
  await refreshStravaUserAppConfig();
  if (stravaImportItem) {
    const ok = _stravaStatus.connected;
    stravaImportItem.disabled = !ok;
    stravaImportItem.title = ok
      ? "Strava activity-k importálása a könyvtárba"
      : (_stravaStatus.app_configured
          ? "Csatlakozz először Stravához (Beállítások → Strava kapcsolat)"
          : "Add meg a saját Strava app credentials-t (Beállítások → Strava kapcsolat)");
    if (stravaImportStatus) {
      stravaImportStatus.textContent = ok ? "" : (_stravaStatus.app_configured ? "nincs csatlakoztatva" : "nincs app credential");
    }
  }
}

function renderStravaState(el, status) {
  if (!el) return;
  if (!status) {
    el.innerHTML = `<div class="strava-conn-loading">Állapot lekérdezése…</div>`;
    return;
  }
  if (!status.app_configured) {
    el.innerHTML = `<div class="strava-conn-meta" style="font-size:12px;color:var(--muted)">Először állítsd be a Strava API adatokat fent (API beállítás gomb), utána tudsz csatlakozni.</div>`;
    return;
  }
  if (status.connected) {
    const dt = status.connected_at ? new Date(status.connected_at).toLocaleString("hu-HU") : "—";
    el.innerHTML = `
      <div class="strava-conn-meta">
        Csatlakozva mint: <strong>${escapeHtmlStr(status.athlete_name || "ismeretlen")}</strong>
        <br>Athlete ID: ${status.athlete_id || "—"}
        <br>Csatlakozás dátuma: ${dt}
        ${status.scope ? `<br>Engedélyek: ${escapeHtmlStr(status.scope)}` : ""}
      </div>
      <div class="strava-conn-row">
        <button class="strava-conn-btn strava-conn-btn--ghost" id="stravaDisconnectBtn" type="button">Lecsatlakoztatás</button>
      </div>`;
    el.querySelector("#stravaDisconnectBtn")?.addEventListener("click", stravaDisconnect);
  } else {
    el.innerHTML = `
      <div class="strava-conn-meta">Még nincs csatlakoztatva. Kattints a gombra a Strava-engedélyezéshez.</div>
      <div class="strava-conn-row">
        <button class="strava-conn-btn" id="stravaConnectBtn" type="button">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;background:#fff;color:#FC4C02;border-radius:2px;font-size:9px;font-weight:800">S</span>
          Kapcsolódás Strava-hoz
        </button>
      </div>`;
    el.querySelector("#stravaConnectBtn")?.addEventListener("click", stravaConnect);
  }
}

// ── User saját Strava app credentials ────────────────────────────────────────
async function refreshStravaUserAppConfig() {
  const badge    = document.querySelector("#stravaAppStatusBadge");
  const cidEl    = document.querySelector("#stravaUserClientId");
  const secEl    = document.querySelector("#stravaUserClientSecret");
  const cbEl     = document.querySelector("#stravaUserCallbackInput");
  const cbDomEl  = document.querySelector("#stravaUserCallbackDomain");
  const clearBtn = document.querySelector("#stravaUserAppClearBtn");
  try {
    const cfg = await routesApi.strava.appConfig.get();
    if (badge) {
      if (cfg.client_id && cfg.secret_set) {
        badge.innerHTML = `<span style="color:#16a34a">✓ Beállítva</span> · Client ID: ${cfg.client_id}`;
      } else {
        badge.innerHTML = `<span style="color:#dc2626">Nincs beállítva</span>`;
      }
    }
    if (cidEl) {
      cidEl.value = cfg.client_id || "";
      secEl.value = "";
      secEl.placeholder = cfg.secret_set ? "•••••• (mentve – csak felülíráshoz írj újat)" : "Másold ide a Strava-tól";
      cbEl.value       = cfg.callback_url || "";
      cbEl.placeholder = `auto: ${cfg.redirect_uri || "—"}`;
      const effective = cfg.callback_url || cfg.redirect_uri;
      if (effective && cbDomEl) {
        try {
          const u = new URL(effective);
          cbDomEl.textContent = `Authorization Callback Domain a Strava-nál: ${u.host}`;
        } catch { cbDomEl.textContent = ""; }
      }
      clearBtn.style.display = (cfg.client_id || cfg.secret_set) ? "" : "none";
    }
  } catch (err) {
    console.warn("Strava app config lekérési hiba:", err);
  }
}

function openStravaAppConfigModal() {
  const o = document.querySelector("#stravaAppConfigOverlay");
  if (o) { o.hidden = false; refreshStravaUserAppConfig(); }
}
function closeStravaAppConfigModal() {
  const o = document.querySelector("#stravaAppConfigOverlay");
  if (o) o.hidden = true;
}

async function saveStravaUserAppConfig() {
  const cid = document.querySelector("#stravaUserClientId")?.value.trim();
  const sec = document.querySelector("#stravaUserClientSecret")?.value.trim();
  const cb  = document.querySelector("#stravaUserCallbackInput")?.value.trim() || null;
  const msg = document.querySelector("#stravaUserAppMsg");
  if (!cid) {
    if (msg) { msg.textContent = "Client ID kötelező."; msg.style.color = "#dc2626"; }
    return;
  }
  try {
    await routesApi.strava.appConfig.save(cid, sec, cb);
    if (msg) { msg.textContent = "Mentve ✓"; msg.style.color = "#16a34a"; }
    await refreshStravaStatus();
    setTimeout(() => { if (msg) msg.textContent = ""; closeStravaAppConfigModal(); }, 600);
  } catch (err) {
    if (msg) { msg.textContent = "Hiba: " + err.message; msg.style.color = "#dc2626"; }
  }
}

async function clearStravaUserAppConfig() {
  if (!confirm("Biztosan törlöd a Strava app credentials-t? Ezután újra kell csatlakozni Stravához.")) return;
  try {
    await routesApi.strava.appConfig.clear();
    await refreshStravaStatus();
  } catch (err) {
    alert("Törlési hiba: " + err.message);
  }
}

async function stravaConnect() {
  try {
    const { auth_url } = await routesApi.strava.connect();
    const w = 600, h = 800;
    const left = window.screenX + (window.innerWidth - w) / 2;
    const top  = window.screenY + (window.innerHeight - h) / 2;
    const popup = window.open(auth_url, "strava-oauth", `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) {
      alert("A popup-ablakot a böngésző blokkolta. Engedélyezd a popup-okat erre az oldalra.");
    }
  } catch (err) {
    alert("Strava connect hiba: " + err.message);
  }
}

async function stravaDisconnect() {
  if (!confirm("Biztosan lecsatlakozol a Strava-tól? A bringaterv elveszíti a hozzáférését a Strava-fiókodhoz (de a már importált edzések megmaradnak).")) return;
  try {
    await routesApi.strava.disconnect();
    await refreshStravaStatus();
  } catch (err) {
    alert("Lecsatlakozás hiba: " + err.message);
  }
}

// ── Strava import modal ───────────────────────────────────────────────────────
export function openStravaImportModal() {
  const overlay = document.querySelector("#stravaImportOverlay");
  if (!overlay) return;
  overlay.hidden = false;
  document.querySelector("#stravaImportList").innerHTML = "";
  document.querySelector("#stravaImportStatus").textContent = "Kattints a Listázás gombra a Strava-edzéseid betöltéséhez.";
  document.querySelector("#stravaImportRunBtn").disabled = true;
  document.querySelector("#stravaImportSummary").textContent = "";
  document.querySelector("#stravaImportFooter").hidden = true;
  document.querySelector("#stravaImportProgress").hidden = true;
  document.querySelector("#stravaProgressBar").style.width = "0%";
  const selectAll = document.querySelector("#stravaImportSelectAll");
  if (selectAll) selectAll.checked = false;
  _stravaActivities = [];
}

function closeStravaImportModal() {
  const overlay = document.querySelector("#stravaImportOverlay");
  if (overlay) overlay.hidden = true;
}

async function fetchAndRenderStravaActivities() {
  const listEl   = document.querySelector("#stravaImportList");
  const statusEl = document.querySelector("#stravaImportStatus");
  const runBtn   = document.querySelector("#stravaImportRunBtn");
  const summary  = document.querySelector("#stravaImportSummary");
  const range    = parseInt(document.querySelector("#stravaImportRange").value);
  const limit    = parseInt(document.querySelector("#stravaImportLimit").value);

  listEl.innerHTML = "";
  summary.textContent = "";
  runBtn.disabled = true;
  statusEl.textContent = "Lekérdezés folyamatban…";

  const params = { per_page: limit };
  if (range > 0) params.after = Math.floor((Date.now() - range * 86400000) / 1000);

  let res;
  try {
    res = await routesApi.strava.activities(params);
  } catch (err) {
    if (err.message?.includes("401") || err.message?.toLowerCase().includes("érvénytelen")) {
      statusEl.innerHTML = `<span style="color:#dc2626">A Strava kapcsolat érvénytelenné vált. <strong>Csatlakozz újra a Beállítások → Strava kapcsolat panelben.</strong></span>`;
      document.querySelector("#stravaImportFooter").hidden = true;
      await refreshStravaStatus();
      return;
    }
    statusEl.innerHTML = `<span style="color:#dc2626">Hiba: ${escapeHtmlStr(err.message)}</span>`;
    document.querySelector("#stravaImportFooter").hidden = true;
    return;
  }
  try {
    let activities = res.activities || [];
    activities.sort((a, b) => {
      const ta = a.start_date ? new Date(a.start_date).getTime() : 0;
      const tb = b.start_date ? new Date(b.start_date).getTime() : 0;
      return tb - ta;
    });
    _stravaActivities = activities;
    if (_stravaActivities.length === 0) {
      statusEl.textContent = "Nincs activity ebben az időszakban.";
      document.querySelector("#stravaImportFooter").hidden = true;
      return;
    }
    statusEl.textContent = `${_stravaActivities.length} activity betöltve.`;
    document.querySelector("#stravaImportFooter").hidden = false;
    renderStravaActivityList();
  } catch (err) {
    statusEl.innerHTML = `<span style="color:#dc2626">Hiba: ${escapeHtmlStr(err.message)}</span>`;
    document.querySelector("#stravaImportFooter").hidden = true;
  }
}

function renderStravaActivityList() {
  const listEl  = document.querySelector("#stravaImportList");
  listEl.innerHTML = "";
  for (const a of _stravaActivities) {
    const date = a.start_date ? new Date(a.start_date).toLocaleDateString("hu-HU", { month:"2-digit", day:"2-digit" }) : "—";
    const distKm = a.distance_m ? (a.distance_m / 1000).toFixed(1) : "—";
    const movMin = a.moving_time_s ? Math.round(a.moving_time_s / 60) : "—";
    const isNew      = a.duplicate_status === "new";
    const isImported = a.duplicate_status === "already_imported";
    const isLikely   = a.duplicate_status === "likely_duplicate";
    const badgeCls  = isNew ? "new" : isImported ? "imported" : isLikely ? "likely" : "deleted";
    const badgeText = isNew ? "Új" : isImported ? "Már megvan" : isLikely ? "Hasonló van" : "Korábban törölted";
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
      if (e.target.tagName === "INPUT") { updateStravaImportSummary(); return; }
      const cb = row.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
      updateStravaImportSummary();
    });
    listEl.append(row);
  }
  updateStravaImportSummary();
}

function updateStravaImportSummary() {
  const runBtn  = document.querySelector("#stravaImportRunBtn");
  const summary = document.querySelector("#stravaImportSummary");
  const checked = document.querySelectorAll("#stravaImportList input[type='checkbox']:checked").length;
  const newCount = _stravaActivities.filter(a => a.duplicate_status === "new").length;
  summary.textContent = `${checked} kiválasztva · ${newCount} új a listán`;
  runBtn.disabled = (checked === 0);
}

async function runStravaImport() {
  const runBtn      = document.querySelector("#stravaImportRunBtn");
  const listBtn     = document.querySelector("#stravaImportListBtn");
  const statusEl    = document.querySelector("#stravaImportStatus");
  const progressEl  = document.querySelector("#stravaImportProgress");
  const progressBar = document.querySelector("#stravaProgressBar");
  const progressCnt = document.querySelector("#stravaProgressCount");
  const progressCur = document.querySelector("#stravaProgressCurrent");
  const checkedRows = [...document.querySelectorAll("#stravaImportList .strava-import-row")]
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
    const name = row.querySelector(".strava-import-name")?.textContent || `Activity ${id}`;

    row.classList.add("is-importing");
    progressCur.textContent = `Most: ${name}`;
    progressCur.className   = "strava-progress-current";

    try {
      await routesApi.strava.importActivity(id);
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
      console.error("Strava import hiba:", id, err);
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
  if (done > 0) _loadRouteLibrary?.();
  runBtn.disabled  = false;
  listBtn.disabled = false;
}
