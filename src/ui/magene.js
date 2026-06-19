/**
 * Bringaterv – Magene / OneLapFit Module
 * ======================================
 * Magene fejegység kapcsolat a Beállítások panelen: OneLapFit email+jelszó
 * belépés, státusz, lecsatlakozás. A tervezett útvonal feltöltése a könyvtár
 * „Küldés Magene-re" gombjával történik (library.js).
 *
 * Init a main.js-ből: initMagene({ showToast });
 */

import { routesApi } from '../api/routesApi.js';
import { createToast } from './dom.js';

let _showToast = () => {};
let _mageneStatus = null;

export function getMageneStatus() { return _mageneStatus; }

export function initMagene({ showToast } = {}) {
  const toastEl = document.querySelector("#toast");
  _showToast = showToast || (toastEl ? createToast(toastEl) : (() => {}));
  refreshMageneStatus();
}

function escapeHtmlStr(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function refreshMageneStatus() {
  const stateEl = document.querySelector("#mageneConnectionState");
  try {
    _mageneStatus = await Promise.race([
      routesApi.magene.status(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Időtúllépés")), 12000)),
    ]);
  } catch (err) {
    _mageneStatus = null;
    if (stateEl) {
      stateEl.innerHTML = `
        <div class="strava-conn-error" style="margin-bottom:8px">Nem sikerült lekérdezni a Magene állapotot: ${escapeHtmlStr(err.message)}</div>
        <button class="strava-conn-btn strava-conn-btn--ghost" id="mageneRetryBtn" type="button">Újrapróbálkozás</button>`;
      stateEl.querySelector("#mageneRetryBtn")?.addEventListener("click", refreshMageneStatus);
    }
    updateMageneLibraryButtons();
    return;
  }
  renderMageneState(stateEl, _mageneStatus);
  updateMageneLibraryButtons();
}

// Jelzés a könyvtár felé (a „Küldés Magene-re" gomb a library.js-ben a státusztól függ)
function updateMageneLibraryButtons() {
  window.dispatchEvent(new CustomEvent("bringaterv:mageneStatus", {
    detail: { connected: !!_mageneStatus?.connected },
  }));
}

function renderMageneState(el, status) {
  if (!el) return;
  if (!status || !status.available) {
    el.innerHTML = `<div class="strava-conn-loading">Állapot lekérdezése…</div>`;
    return;
  }
  if (status.connected) {
    const dt = status.connected_at ? new Date(status.connected_at).toLocaleString("hu-HU") : "—";
    el.innerHTML = `
      <div class="strava-conn-meta">
        Csatlakozva mint: <strong>${escapeHtmlStr(status.nickname || status.account || "ismeretlen")}</strong>
        <br>Csatlakozás dátuma: ${dt}
      </div>
      <div class="strava-conn-row">
        <button class="strava-conn-btn strava-conn-btn--ghost" id="mageneDisconnectBtn" type="button">Lecsatlakoztatás</button>
      </div>`;
    el.querySelector("#mageneDisconnectBtn")?.addEventListener("click", mageneDisconnect);
  } else {
    renderLoginForm(el);
  }
}

function renderLoginForm(el) {
  el.innerHTML = `
    <div class="strava-conn-meta" style="margin-bottom:8px">
      Lépj be az OneLapFit (Magene) fiókoddal. A jelszót nem tároljuk – csak a belépési tokent.
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;max-width:320px">
      <input id="mageneEmail" class="form-input" type="email" placeholder="OneLapFit email" autocomplete="off" style="font-size:13px">
      <input id="magenePassword" class="form-input" type="password" placeholder="OneLapFit jelszó" autocomplete="off" style="font-size:13px">
      <div style="display:flex;gap:8px;align-items:center">
        <button id="mageneConnectBtn" class="strava-conn-btn" type="button" style="background:#1769ff">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;background:#fff;color:#1769ff;border-radius:2px;font-size:9px;font-weight:800">M</span>
          Csatlakozás
        </button>
        <span id="mageneConnectMsg" style="font-size:11px;color:var(--muted)"></span>
      </div>
    </div>`;
  el.querySelector("#mageneConnectBtn")?.addEventListener("click", submitMageneLogin);
  el.querySelector("#magenePassword")?.addEventListener("keydown", e => { if (e.key === "Enter") submitMageneLogin(); });
}

async function submitMageneLogin() {
  const emailEl = document.querySelector("#mageneEmail");
  const pwEl    = document.querySelector("#magenePassword");
  const msgEl   = document.querySelector("#mageneConnectMsg");
  const btn     = document.querySelector("#mageneConnectBtn");
  const setMsg  = (t, color) => { if (msgEl) { msgEl.textContent = t; msgEl.style.color = color || "var(--muted)"; } };
  const email = emailEl?.value.trim();
  const pw    = pwEl?.value;
  if (!email || !pw) { setMsg("Email és jelszó kötelező.", "#dc2626"); return; }
  try {
    btn.disabled = true;
    setMsg("Belépés a Magene-be…");
    const res = await routesApi.magene.connect(email, pw);
    _showToast?.(`Magene csatlakoztatva: ${res.nickname || res.account || ""}`);
    refreshMageneStatus();
  } catch (err) {
    setMsg("Hiba: " + err.message, "#dc2626");
  } finally {
    btn.disabled = false;
  }
}

async function mageneDisconnect() {
  if (!confirm("Biztosan lecsatlakozol a Magene/OneLapFit fiókról?")) return;
  try {
    await routesApi.magene.disconnect();
    await refreshMageneStatus();
  } catch (err) {
    alert("Lecsatlakozás hiba: " + err.message);
  }
}
