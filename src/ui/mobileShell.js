/**
 * Bringaterv – mobil elrendezés: felhúzható panel (bottom sheet)
 * ===============================================================
 * 768px alatt az oldalsáv tartalma alulról felhúzható panel (ld. styles.css
 * „MOBIL ELRENDEZÉS”). Itt csak az állapotot kezeljük:
 *   data-sheet = mini | peek | half | full   (az .app-shell-en)
 * – fogantyú: koppintás → következő állás, húzás → szabad mozgatás, elengedéskor
 *   a legközelebbi állásra ugrik;
 * – fülváltáskor alapállás: térképes fülön „peek”, Könyvtár/Statok „mini”.
 */

import { mobileMQ } from "../layout.js";

const MQ = mobileMQ;
const ORDER = ["mini", "peek", "half", "full"];

let _shell = null, _inner = null;

export function initMobileShell() {
  _shell = document.getElementById("appShell");
  _inner = _shell?.querySelector(".sidebar-inner");
  if (!_shell || !_inner) return;

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "sheet-handle";
  handle.setAttribute("aria-label", "Panel méretezése");
  handle.innerHTML = "<span></span>";
  _inner.prepend(handle);

  setupDrag(handle);
  applyDefault();

  // Fülváltás (mód-osztályok változása) → alapállás
  let lastMode = modeKey();
  new MutationObserver(() => {
    const m = modeKey();
    if (m !== lastMode) { lastMode = m; applyDefault(); }
  }).observe(_shell, { attributes: true, attributeFilter: ["class"] });

  MQ.addEventListener?.("change", applyDefault);

  // Diagram / szél panel nyitásakor a felhúzható panel a legkisebb állásba megy,
  // hogy a térkép látsszon a kettő között; bezáráskor visszaáll.
  const charts = document.getElementById("elevationPanel") || document.querySelector(".elevation-panel");
  if (charts) {
    let restore = null;
    new MutationObserver(() => {
      if (!MQ.matches) return;
      const open = !charts.hidden;
      if (open && restore === null && _shell.dataset.sheet !== "mini") {
        restore = _shell.dataset.sheet;
        setSheet("mini");
      } else if (!open && restore !== null) {
        setSheet(restore);
        restore = null;
      }
      // az útvonal a látható (panelek közti) részre illeszkedjen – az animáció után
      if (open) setTimeout(() => window.dispatchEvent(new Event("bringaterv:refit")), 400);
    }).observe(charts, { attributes: true, attributeFilter: ["hidden"] });
  }

  // Útvonalpont-ablak a térképen: amíg nyitva van, a lap a legkisebb állásban
  let popupRestore = null;
  window.addEventListener("bringaterv:map-popup", (e) => {
    if (!MQ.matches) return;
    if (e.detail?.open) {
      if (popupRestore === null && _shell.dataset.sheet !== "mini") {
        popupRestore = _shell.dataset.sheet;
        setSheet("mini");
      }
    } else if (popupRestore !== null) {
      // új pont ablakára váltáskor ne ugráljon: csak akkor álljon vissza, ha nincs nyitott ablak
      setTimeout(() => {
        if (document.querySelector(".leaflet-popup.marker-popup-wrap")) return;
        if (popupRestore !== null) { setSheet(popupRestore); popupRestore = null; }
      }, 60);
    }
  });
}

function modeKey() {
  const c = _shell.classList;
  return c.contains("is-home-mode") ? "home" : c.contains("is-library-mode") ? "library" : c.contains("is-stats-mode") ? "stats"
       : c.contains("is-file-mode") ? "file" : "plan";
}

function applyDefault() {
  if (!MQ.matches) { delete _shell.dataset.sheet; return; }
  const m = modeKey();
  setSheet(m === "library" || m === "stats" ? "mini" : "peek");
}

export function setSheet(state) {
  if (!_shell || !ORDER.includes(state)) return;
  _shell.dataset.sheet = state;
  _inner.style.removeProperty("height");
}

/** Az állások magassága px-ben (a CSS-sel azonos képletek). */
function heights() {
  const vh = window.innerHeight;
  const top = document.querySelector(".topnav")?.getBoundingClientRect().height || 48;   // notch-csal együtt
  const nav = document.querySelector(".app-rail")?.getBoundingClientRect().height || 58;
  return { mini: 64, peek: vh * 0.34, half: vh * 0.58, full: vh - top - nav - 12 };
}

function setupDrag(handle) {
  let startY = 0, startH = 0, moved = false, dragging = false;

  handle.addEventListener("pointerdown", (e) => {
    if (!MQ.matches) return;
    dragging = true; moved = false;
    startY = e.clientY;
    startH = _inner.getBoundingClientRect().height;
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    if (!moved) return;
    _shell.classList.add("is-sheet-dragging");
    const h = heights();
    const next = Math.min(h.full, Math.max(h.mini, startH - dy));
    _inner.style.height = `${next}px`;
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    _shell.classList.remove("is-sheet-dragging");
    if (!moved) {                       // koppintás: következő állás (full után vissza)
      const cur = _shell.dataset.sheet || "peek";
      const i = ORDER.indexOf(cur);
      setSheet(i >= ORDER.length - 1 ? (modeKey() === "library" || modeKey() === "stats" ? "mini" : "peek") : ORDER[i + 1]);
      return;
    }
    const cur = _inner.getBoundingClientRect().height;
    const h = heights();
    const nearest = ORDER.reduce((a, b) => (Math.abs(h[b] - cur) < Math.abs(h[a] - cur) ? b : a));
    setSheet(nearest);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}
