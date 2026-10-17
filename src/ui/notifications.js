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

const withTimeout = (p, ms, msg) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
]);

/** Aktív service worker – ha még nincs regisztrálva, most regisztráljuk (időkorláttal) */
async function ensureServiceWorker() {
  let reg = await navigator.serviceWorker.getRegistration();
  if (!reg) reg = await navigator.serviceWorker.register("./sw.js");
  return withTimeout(navigator.serviceWorker.ready, 10000,
    "a service worker nem indult el (frissítsd az oldalt / indítsd újra az appot)");
}

/** Állapot-sor hibakereséshez: engedély · service worker · feliratkozás */
async function diagnostics() {
  const parts = [];
  try { parts.push("engedély: " + ({ granted: "megadva", denied: "tiltva", default: "nincs kérve" }[Notification.permission] || Notification.permission)); } catch { parts.push("engedély: –"); }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    parts.push("service worker: " + (reg?.active ? "aktív" : reg ? "települ" : "nincs"));
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    parts.push("feliratkozás: " + (sub ? (_cfg?.this_device ? "rendben" : "csak az eszközön") : "nincs"));
  } catch { parts.push("service worker: –"); }
  parts.push(isStandalone() ? "telepített app" : "böngészőben");
  return parts.join(" · ");
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
    statusEl.textContent = Notification.permission === "granted"
      ? "Engedély megvan, de még nincs feliratkozva – koppints az Engedélyezésre"
      : "Kikapcsolva";
    enableBtn.hidden = false;
  }
  const diag = $("#notifyDiag");
  if (diag) diag.textContent = await diagnostics();
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
  const note = $("#notifyNote");
  btn.disabled = true;
  btn.textContent = "Engedélyezés…";
  let step = "engedélykérés";
  try {
    // Az engedélykérésnek közvetlenül a koppintásból kell indulnia (iOS feltétel)
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (perm !== "granted") throw new Error("az engedélyt nem adtad meg");
    step = "service worker";
    const reg = await ensureServiceWorker();
    step = "kulcs lekérése";
    const key = _cfg?.vapid_public_key || (await routesApi.notify.config()).vapid_public_key;
    step = "feliratkozás";
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await withTimeout(
        reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToUint8(key) }),
        15000, "a rendszer nem válaszolt");
    }
    step = "mentés a szerveren";
    await routesApi.notify.subscribe(sub.toJSON());
    note.hidden = true;
    _toast?.("Értesítések bekapcsolva ezen az eszközön");
  } catch (err) {
    note.textContent = `Nem sikerült bekapcsolni (${step}): ${err.message || err}`;
    note.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Engedélyezés";
    await refresh().catch(() => {});
    if (!$("#notifyNote").textContent.startsWith("Nem sikerült")) return;
    $("#notifyNote").hidden = false;     // a refresh ne tüntesse el a hibát
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
  // Próbaértesítés 5 mp múlva – a szerver küldi, így közben be lehet zárni az appot
  $("#notifyTestBtn")?.addEventListener("click", async () => {
    const btn = $("#notifyTestBtn");
    try {
      const res = await routesApi.notify.test(5);
      if (!res.devices) {
        _toast?.("Nincs feliratkozott eszköz – előbb koppints az Engedélyezésre.");
        return;
      }
      btn.disabled = true;
      for (let i = 5; i > 0; i--) {
        btn.textContent = `${i} mp – zárd be az appot`;
        await new Promise((r) => setTimeout(r, 1000));
      }
      btn.textContent = "Elküldve ✓";
      setTimeout(() => { btn.textContent = "Próbaértesítés"; btn.disabled = false; }, 2500);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Próbaértesítés";
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
