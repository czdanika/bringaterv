/**
 * Bringaterv – Értesítések (Web Push) beállítás
 * ===============================================
 * Beállítások → Értesítések:
 *   – „Ezen az eszközön”: engedélyezés (rendszer-engedélykérés + push feliratkozás),
 *     kikapcsolás; minden eszköz külön feliratkozás a szerveren;
 *   – eseménykapcsolók (új edzés, új rekord, kapcsolati hiba) – felhasználónként;
 *   – próbaértesítés.
 * iOS: csak a főképernyőre telepített appból (standalone) és HTTPS-en működik –
 * ilyenkor magyarázatot mutatunk az engedélyezés gomb helyett.
 */

import { routesApi } from "../api/routesApi.js";
import { isIOS, isStandalone } from "./installPrompt.js";

let _toast = null;
let _cfg = null;

const $ = (sel) => document.querySelector(sel);

function supported() {
  return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function b64urlToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function refresh() {
  const statusEl = $("#notifyDeviceStatus");
  const enableBtn = $("#notifyEnableBtn");
  const disableBtn = $("#notifyDisableBtn");
  const note = $("#notifyNote");
  if (!statusEl) return;

  const sub = await currentSubscription().catch(() => null);
  try {
    _cfg = await routesApi.notify.config(sub?.endpoint || "");
  } catch {
    statusEl.textContent = "Az értesítések most nem érhetők el.";
    return;
  }
  renderEvents();
  $("#notifyDevices").textContent = _cfg.devices
    ? `${_cfg.devices} eszköz kap értesítést`
    : "Még egy eszköz sem kap értesítést.";

  enableBtn.hidden = disableBtn.hidden = true;
  note.hidden = true;
  if (!window.isSecureContext) {
    statusEl.textContent = "Nem elérhető";
    note.textContent = "Push értesítéshez HTTPS-kapcsolat kell (pl. a saját domainen keresztül), helyi http címen nem működik.";
    note.hidden = false;
    return;
  }
  if (isIOS() && !isStandalone()) {
    statusEl.textContent = "Először telepítsd appként";
    note.textContent = "iPhone-on és iPaden az értesítés csak a főképernyőre telepített appban működik: Safari → Megosztás → Főképernyőhöz adás, majd az ikonról indítva kapcsold be itt.";
    note.hidden = false;
    return;
  }
  if (!supported()) {
    statusEl.textContent = "Ez a böngésző nem támogatja";
    return;
  }
  if (Notification.permission === "denied") {
    statusEl.textContent = "Letiltva a böngészőben / rendszerben";
    note.textContent = isIOS()
      ? "Kapcsold vissza: iPhone Beállítások → Értesítések → Bringaterv."
      : "Kapcsold vissza a böngésző webhely-beállításaiban (lakat ikon a címsor mellett).";
    note.hidden = false;
    return;
  }
  if (sub && _cfg.this_device) {
    statusEl.textContent = "Bekapcsolva ✓";
    disableBtn.hidden = false;
  } else {
    statusEl.textContent = "Kikapcsolva";
    enableBtn.hidden = false;
  }
}

function renderEvents() {
  const box = $("#notifyEvents");
  if (!box || !_cfg?.event_labels) return;
  box.innerHTML = Object.entries(_cfg.event_labels).map(([key, label]) => `
    <div class="plan-elev-toggle-row notify-event-row">
      <span class="plan-elev-toggle-label">${label}</span>
      <label class="toggle-switch">
        <input type="checkbox" data-notify-event="${key}" ${_cfg.events[key] ? "checked" : ""}>
        <span class="toggle-track"></span>
      </label>
    </div>`).join("");
}

async function enable() {
  const btn = $("#notifyEnableBtn");
  btn.disabled = true;
  try {
    // Az engedélykérésnek közvetlenül a koppintásból kell indulnia (iOS feltétel)
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { await refresh(); return; }
    const reg = await navigator.serviceWorker.ready;
    const key = _cfg?.vapid_public_key || (await routesApi.notify.config()).vapid_public_key;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToUint8(key) });
    }
    await routesApi.notify.subscribe(sub.toJSON());
    _toast?.("Értesítések bekapcsolva ezen az eszközön");
  } catch (err) {
    _toast?.("Nem sikerült bekapcsolni: " + err.message);
  } finally {
    btn.disabled = false;
    refresh();
  }
}

async function disable() {
  try {
    const sub = await currentSubscription();
    if (sub) {
      await routesApi.notify.unsubscribe(sub.endpoint);
      await sub.unsubscribe();
    }
    _toast?.("Értesítések kikapcsolva ezen az eszközön");
  } catch (err) {
    _toast?.("Hiba: " + err.message);
  }
  refresh();
}

export function initNotifications({ showToast } = {}) {
  _toast = showToast;
  $("#notifyEnableBtn")?.addEventListener("click", enable);
  $("#notifyDisableBtn")?.addEventListener("click", disable);
  $("#notifyTestBtn")?.addEventListener("click", async () => {
    try {
      const { sent } = await routesApi.notify.test();
      _toast?.(sent ? `Próbaértesítés elküldve (${sent} eszköz)` : "Nincs feliratkozott eszköz – előbb engedélyezd.");
    } catch (err) {
      _toast?.("Hiba: " + err.message);
    }
  });
  $("#notifyEvents")?.addEventListener("change", async (e) => {
    const key = e.target.dataset?.notifyEvent;
    if (!key) return;
    try {
      _cfg = { ..._cfg, ...(await routesApi.notify.setEvents({ [key]: e.target.checked })) };
    } catch (err) {
      e.target.checked = !e.target.checked;
      _toast?.("Nem sikerült menteni: " + err.message);
    }
  });
  // A Beállítások megnyitásakor frissítjük az állapotot
  $("#settingsButton")?.addEventListener("click", () => setTimeout(refresh, 0));
}
