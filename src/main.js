import { requireAuth, logout } from "./auth.js";
import { config } from "./config.js";
import { getSettings, saveSetting } from "./appSettings.js";
import { createI18n } from "./i18n/i18n.js";
import { createRouteStore } from "./state/routeStore.js";
import { createMapAdapter } from "./map/mapAdapter.js";
import { downloadGpx, exportGpx, importGpx, calcElevationFromGeometry, calcTiming } from "./gpx/gpx.js";
import { createToast, formatDistance } from "./ui/dom.js";
import { searchPlaces, reverseGeocode } from "./ui/search.js";
import { buildElevationData, buildSpeedData, buildHrData, initElevationChart } from "./ui/elevationProfile.js";

requireAuth();

// ── Verzióellenőrzés ──────────────────────────────────────────────────────────
const APP_VERSION = "v0.9.1";

function parseVersion(v) {
  return String(v).replace(/^v/, "").split(".").map(Number);
}
function isNewerVersion(latest, current) {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] ?? 0;
    const cv = c[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}
async function checkForUpdate() {
  try {
    const res = await fetch(
      "https://api.github.com/repos/czdanika/bringaterv/releases/latest",
      { cache: "no-store" }
    );
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.tag_name;
    if (latest && isNewerVersion(latest, APP_VERSION)) {
      const dot = document.querySelector("#updateDot");
      if (dot) {
        dot.hidden = false;
        dot.title = `Új verzió elérhető: ${latest}`;
      }
    }
  } catch {
    // hálózati hiba – csendben ignoráljuk
  }
}

const initialLanguage = localStorage.getItem("routePlannerLanguage") || "hu";
const i18n = createI18n(initialLanguage);
const store = createRouteStore();
const showToast = createToast(document.querySelector("#toast"));

// Theme
(function initTheme() {
  const saved = localStorage.getItem("route4meTheme");
  if (saved) document.documentElement.dataset.theme = saved;
})();

function toggleTheme() {
  const isDark = document.documentElement.dataset.theme === "dark";
  const next = isDark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("route4meTheme", next);
  updateThemeIcon();
}

function updateThemeIcon() {
  const isDark = document.documentElement.dataset.theme === "dark";
  const btn = document.querySelector("#themeToggle");
  if (!btn) return;
  btn.innerHTML = `<i data-lucide="${isDark ? "moon" : "sun"}" aria-hidden="true"></i>`;
  btn.title = isDark ? "Váltás világos módra" : "Váltás sötét módra";
  window.lucide?.createIcons();
}

// ── Tab state ──────────────────────────────────────────────
const tabButtons = document.querySelectorAll(".sidebar-tab");
const tabPlan   = document.querySelector("#tabPlan");
const tabFile   = document.querySelector("#tabFile");
let currentTab = "plan";

function switchTab(name) {
  currentTab = name;
  elements.appShell.classList.toggle("is-file-mode", name === "file");
  tabButtons.forEach(b => b.classList.toggle("is-active", b.dataset.tab === name));
  tabPlan.hidden = name !== "plan";
  tabFile.hidden = name !== "file";
  window.lucide?.createIcons();
}

tabButtons.forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

// ── File tab helpers ────────────────────────────────────────
function formatDuration(ms) {
  if (ms == null || ms <= 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function populateFileTab({ filename, geometry, distanceMeters, ascentMeters, descentMeters, speedColored = false, meta = {} }) {
  document.querySelector("#fileEmptyState").hidden = true;
  const details = document.querySelector("#fileDetails");
  details.hidden = false;

  document.querySelector("#importedFileName").textContent = filename;

  // Metaadatok
  const metaBlock = document.querySelector("#fileMetaBlock");
  const nameRow  = document.querySelector("#fileMetaNameRow");
  const typeRow  = document.querySelector("#fileMetaTypeRow");
  const descRow  = document.querySelector("#fileMetaDescRow");
  const startRow = document.querySelector("#fileMetaStartRow");
  const hasMeta  = meta.name || meta.type || meta.desc || meta.startTime;
  if (metaBlock) metaBlock.hidden = !hasMeta;
  if (nameRow)  { nameRow.hidden  = !meta.name; if (meta.name)  document.querySelector("#fileMetaName").textContent = meta.name; }
  if (typeRow)  { typeRow.hidden  = !meta.type; if (meta.type)  document.querySelector("#fileMetaType").textContent = meta.type; }
  if (descRow)  { descRow.hidden  = !meta.desc; if (meta.desc)  document.querySelector("#fileMetaDesc").textContent = meta.desc; }
  if (startRow && meta.startTime) {
    const d = new Date(meta.startTime);
    document.querySelector("#fileMetaStart").textContent =
      d.toLocaleDateString("hu-HU", { year: "numeric", month: "long", day: "numeric" }) + " " +
      d.toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
    startRow.hidden = false;
  } else if (startRow) startRow.hidden = true;

  // Időtartam
  const totalDurRow   = document.querySelector("#fileTotalDurRow");
  const movingDurRow  = document.querySelector("#fileMovingDurRow");
  const totalDurStr   = formatDuration(meta.totalDuration);
  const movingDurStr  = formatDuration(meta.movingDuration);
  if (totalDurRow)  { totalDurRow.hidden  = !totalDurStr; if (totalDurStr)  document.querySelector("#fileTotalDur").textContent  = totalDurStr; }
  if (movingDurRow) { movingDurRow.hidden = !movingDurStr; if (movingDurStr) document.querySelector("#fileMovingDur").textContent = movingDurStr; }
  document.querySelector("#fileDistance").textContent = formatDisplayDistance(distanceMeters);
  document.querySelector("#filePoints").textContent = geometry.length.toLocaleString();

  const hasEle = ascentMeters > 0 || descentMeters > 0;
  document.querySelector("#fileAscentRow").hidden = !hasEle;
  document.querySelector("#fileDescentRow").hidden = !hasEle;
  if (hasEle) {
    document.querySelector("#fileAscent").textContent = `${ascentMeters} m`;
    document.querySelector("#fileDescent").textContent = `${descentMeters} m`;
  }

  const speeds = geometry.map(p => p.speed).filter(s => s != null && s < 120 && s > 0);
  const hasSpeed = speeds.length > 0;
  document.querySelector("#fileAvgSpeedRow").hidden = !hasSpeed;
  document.querySelector("#fileMaxSpeedRow").hidden = !hasSpeed;
  if (hasSpeed) {
    const avg = Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length * 10) / 10;
    const max = Math.round(Math.max(...speeds) * 10) / 10;
    document.querySelector("#fileAvgSpeed").textContent = `${avg} km/h`;
    document.querySelector("#fileMaxSpeed").textContent = `${max} km/h`;
  }

  // HR stats
  const hrs = geometry.map(p => p.hr).filter(h => h != null && h > 0);
  const hasHr = hrs.length > 0;
  const avgHrRowEl = document.querySelector("#fileAvgHrRow");
  const maxHrRowEl = document.querySelector("#fileMaxHrRow");
  if (avgHrRowEl) avgHrRowEl.hidden = !hasHr;
  if (maxHrRowEl) maxHrRowEl.hidden = !hasHr;
  if (hasHr) {
    const avgHr = Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length);
    const maxHr = Math.max(...hrs);
    const avgHrEl = document.querySelector("#fileAvgHr");
    const maxHrEl = document.querySelector("#fileMaxHr");
    if (avgHrEl) avgHrEl.textContent = `${avgHr} bpm`;
    if (maxHrEl) maxHrEl.textContent = `${maxHr} bpm`;
  }

  // Cadence stats
  const cads = geometry.map(p => p.cad).filter(c => c != null && c > 0);
  const hasCad = cads.length > 0;
  const avgCadRowEl = document.querySelector("#fileAvgCadRow");
  const maxCadRowEl = document.querySelector("#fileMaxCadRow");
  if (avgCadRowEl) avgCadRowEl.hidden = !hasCad;
  if (maxCadRowEl) maxCadRowEl.hidden = !hasCad;
  if (hasCad) {
    const avgCad = Math.round(cads.reduce((a, b) => a + b, 0) / cads.length);
    const maxCad = Math.max(...cads);
    const avgCadEl = document.querySelector("#fileAvgCad");
    const maxCadEl = document.querySelector("#fileMaxCad");
    if (avgCadEl) avgCadEl.textContent = `${avgCad} rpm`;
    if (maxCadEl) maxCadEl.textContent = `${maxCad} rpm`;
  }

  // Speed legend
  const legendEl = document.querySelector("#speedLegend");
  if (legendEl) legendEl.hidden = !speedColored;

  // HR legend
  const hrLegendEl = document.querySelector("#hrLegend");
  if (hrLegendEl) hrLegendEl.hidden = !hasHr;

  // Cadence legend
  const cadLegendEl = document.querySelector("#cadLegend");
  if (cadLegendEl) cadLegendEl.hidden = !hasCad;

  window.lucide?.createIcons();
}

function clearFileTab() {
  document.querySelector("#fileEmptyState").hidden = false;
  document.querySelector("#fileDetails").hidden = true;
  const speedLeg = document.querySelector("#speedLegend");
  const hrLeg = document.querySelector("#hrLegend");
  const cadLeg = document.querySelector("#cadLegend");
  if (speedLeg) speedLeg.hidden = true;
  if (hrLeg) hrLeg.hidden = true;
  if (cadLeg) cadLeg.hidden = true;
  const metaBlock = document.querySelector("#fileMetaBlock");
  if (metaBlock) metaBlock.hidden = true;
}

const elements = {
  appShell: document.querySelector("#appShell"),
  navToggle: document.querySelector("#navToggle"),
  mapStyleButtons: document.querySelectorAll("[data-map-style]"),
  unitInputs: document.querySelectorAll("input[name='units']"),
  showStageInfo: document.querySelector("#showStageInfo"),
  snapToRoads: document.querySelector("#snapToRoads"),
  showStageInfoSettings: document.querySelector("#settingsShowStageInfo"),
  snapToRoadsSettings: document.querySelector("#settingsSnapToRoads"),
  routeModeButtons: document.querySelectorAll("[data-route-mode]"),
  toolButtons: document.querySelectorAll("[data-tool]"),
  waypointList: document.querySelector("#waypointList"),
  emptyState: document.querySelector("#emptyState"),
  distanceValue: document.querySelector("#distanceValue"),
  pointCount: document.querySelector("#pointCount"),
  ascentRow: document.querySelector("#ascentRow"),
  ascentValue: document.querySelector("#ascentValue"),
  descentRow: document.querySelector("#descentRow"),
  descentValue: document.querySelector("#descentValue"),
  searchForm: document.querySelector("#searchForm"),
  searchInput: document.querySelector("#searchInput"),
  searchResults: document.querySelector("#searchResults"),
  locateButton: document.querySelector("#locateButton"),
  clearRoute: document.querySelector("#clearRoute"),
  exportButton: document.querySelector("#exportButton"),
  importButton: document.querySelector("#importButton"),
  resetRouteButton: document.querySelector("#resetRouteButton"),
  reverseRouteButton: document.querySelector("#reverseRouteButton"),
  undoButton: document.querySelector("#undoButton"),
  redoButton: document.querySelector("#redoButton"),
  gpxInput: document.querySelector("#gpxInput"),
  saveRouteButton: document.querySelector("#saveRouteButton"),
  shareRouteButton: document.querySelector("#shareRouteButton"),
  shortcutButton: document.querySelector("#shortcutButton"),
  shortcutOverlay: document.querySelector("#shortcutOverlay"),
  shortcutClose: document.querySelector("#shortcutClose"),
  settingsButton: document.querySelector("#settingsButton"),
  measureBar: document.querySelector("#measureBar"),
  measureTotal: document.querySelector("#measureTotal"),
  measurePointCount: document.querySelector("#measurePointCount"),
  measureClear: document.querySelector("#measureClear"),
  gpxSampleWaypoints: document.querySelector("#gpxSampleWaypoints"),
  gpxSampleWaypointsSettings: document.querySelector("#settingsGpxSampleWaypoints"),
  sidebarExportButton: document.querySelector("#sidebarExportButton"),
  exportOverlay: document.querySelector("#exportOverlay"),
  exportClose: document.querySelector("#exportClose"),
  exportConfirm: document.querySelector("#exportConfirm"),
  exportName: document.querySelector("#exportName"),
  exportDesc: document.querySelector("#exportDesc"),
  exportFilename: document.querySelector("#exportFilename"),
  fileExportButton: document.querySelector("#fileExportButton"),
  elevationBtn: document.querySelector("#elevationBtn"),
  elevationPanel: document.querySelector("#elevationPanel"),
  elevationClose: document.querySelector("#elevationClose"),
  elevationCanvas: document.querySelector("#elevationCanvas"),
  elevationTooltip: document.querySelector("#elevationTooltip"),
  elevationTooltipDist: document.querySelector("#elevationTooltipDist"),
  elevationTooltipEle: document.querySelector("#elevationTooltipEle"),
  elevationTooltipGrade: document.querySelector("#elevationTooltipGrade"),
  elevationInfo: document.querySelector("#elevationInfo"),
  speedMapToggle: document.querySelector("#speedMapToggle"),
  hrMapToggle: document.querySelector("#hrMapToggle"),
  cadMapToggle: document.querySelector("#cadMapToggle"),
  gradeLegend: document.querySelector("#gradeLegend"),
  gradeLegendPlan: document.querySelector("#gradeLegendPlan"),
  gradeMapToggle: document.querySelector("#gradeMapToggle"),
  gradeMapTogglePlan: document.querySelector("#gradeMapTogglePlan"),
  gradeLegendChartBtn: document.querySelector("#gradeLegendChartBtn"),
  gradeLegendChartBtnPlan: document.querySelector("#gradeLegendChartBtnPlan"),
  speedLegend: document.querySelector("#speedLegend"),
  hrLegend: document.querySelector("#hrLegend"),
  cadLegend: document.querySelector("#cadLegend"),
  speedChartBtn: document.querySelector("#speedChartBtn"),
  hrChartBtn: document.querySelector("#hrChartBtn"),
};

const STYLE_ICONS = {
  standard:  "map",
  cycling:   "bike",
  topo:      "mountain",
  satellite: "satellite",
  hybrid:    "satellite",
  light:     "sun",
  dark:      "moon",
};

function syncLayerPickerBtn(style) {
  const pickerBtn = document.querySelector("#layerPickerBtn");
  if (!pickerBtn) return;
  const icon = STYLE_ICONS[style] ?? "layers";
  pickerBtn.innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i>`;
  pickerBtn.title = `Térképstílus: ${style}`;
  window.lucide?.createIcons();
}

const STYLE_LABELS = {
  standard:  "Standard",
  cycling:   "Kerékpár",
  topo:      "Domborzat",
  satellite: "Műhold",
  hybrid:    "Hybrid",
  light:     "Világos",
  dark:      "Sötét",
};

function syncSidebarStyleBtn(style) {
  const btn = document.querySelector("#sidebarStyleBtn");
  if (!btn) return;
  const icon = STYLE_ICONS[style] ?? "map";
  btn.innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i><span id="sidebarStyleLabel">${STYLE_LABELS[style] ?? style}</span><i data-lucide="chevron-down" class="sidebar-style-chevron" aria-hidden="true"></i>`;
  window.lucide?.createIcons();
}

function syncFileStyleBtn(style) {
  const btn = document.querySelector("#fileStyleBtn");
  if (!btn) return;
  const icon = STYLE_ICONS[style] ?? "map";
  btn.innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i><span id="fileStyleLabel">${STYLE_LABELS[style] ?? style}</span><i data-lucide="chevron-down" class="sidebar-style-chevron" aria-hidden="true"></i>`;
  window.lucide?.createIcons();
}

async function addWaypointWithName(point) {
  store.addWaypoint(point);
  const id = store.getState().waypoints.at(-1)?.id;
  if (!id) return;
  const name = await reverseGeocode(point.lat, point.lng);
  if (name && store.getState().waypoints.some((wp) => wp.id === id)) {
    store.updateWaypoint(id, { name });
  }
}

async function relocateWaypointWithName(id, lat, lng) {
  store.updateWaypointPosition(id, lat, lng);
  const name = await reverseGeocode(lat, lng);
  if (name && store.getState().waypoints.some((wp) => wp.id === id)) {
    store.updateWaypoint(id, { name });
  }
}

const appSettings = getSettings();

const mapAdapter = createMapAdapter({
  elementId: "map",
  startView: appSettings.startView ?? null,
  onMapClick: (point) => {
    if (currentTab === "file") return; // view-only in file tab
    addWaypointWithName(point);
  },
  onRouteFallback: () => showToast(i18n.t("map.routeFailed")),
  onMarkerDrag: (id, lat, lng) => relocateWaypointWithName(id, lat, lng),
  onWaypointDelete: (id) => {
    if (selectedWaypointId === id) selectedWaypointId = null;
    store.removeWaypoint(id);
  },
  onWaypointUpdate: (id, changes) => store.updateWaypoint(id, changes),
  onMeasureUpdate: (totalMeters, pointCount) => {
    const bar = elements.measureBar;
    if (!bar) return;
    if (pointCount === 0) {
      bar.hidden = true;
    } else {
      bar.hidden = false;
      elements.measureTotal.textContent = totalMeters >= 1000
        ? `${(totalMeters / 1000).toFixed(2)} km`
        : `${Math.round(totalMeters)} m`;
      elements.measurePointCount.textContent = `${pointCount} pont`;
    }
  },
});

let routeRequestId = 0;
let lastRouteSignature = "";
let units = localStorage.getItem("route4meUnits") || "metric";
let selectedWaypointId = null;
let dragSrcIndex = null;
let activeTool = "route";
let importedColoredGeometry = null; // ha van sebességszínezés
let importedHrGeometry = null;      // ha van pulzusszínezés
let importedCadGeometry = null;     // ha van kadenciaszínezés

store.setState({
  mode: localStorage.getItem("route4meDefaultRouteMode") || "cycling",
  snapToRoads: getSettings().snapToRoads,
});

i18n.apply();
setupNavigation();
window.lucide?.createIcons();
updateThemeIcon();
document.querySelector("#themeToggle")?.addEventListener("click", toggleTheme);
const savedMapStyle = localStorage.getItem("route4meMapStyle") || "standard";
syncMapStyleButtons(savedMapStyle);
syncLayerPickerBtn(savedMapStyle);
syncSidebarStyleBtn(savedMapStyle);
syncFileStyleBtn(savedMapStyle);
mapAdapter.setMapStyle(savedMapStyle);
checkForUpdate(); // GitHub release ellenőrzés – oldalbetöltéskor
elements.unitInputs.forEach((input) => {
  input.checked = input.value === units;
});
// Export buttons start disabled (no waypoints yet)
elements.exportButton.disabled = true;
if (elements.fileExportButton) elements.fileExportButton.disabled = true;

// Szintprofil – aktív geometry (tervezett vagy importált)
let activeGeometry = [];

// Aktív chart típus: "elevation" | "speed" | "hr"
let activeChartType = "elevation";

// Chart panel inicializálása
const elevationChart = initElevationChart(elements.elevationCanvas, {
  onHover(pt, opts) {
    if (!pt || pt.value == null) return;
    mapAdapter.setElevationMarker(pt.lat, pt.lng);
    if (elements.elevationTooltip) elements.elevationTooltip.hidden = false;
    if (elements.elevationTooltipDist) {
      elements.elevationTooltipDist.innerHTML = `<b>${(pt.dist / 1000).toFixed(2)} km</b>`;
    }
    if (elements.elevationTooltipEle) {
      const unit = opts?.unit ?? "m";
      const icons = { m: "⛰", "km/h": "🚴", bpm: "❤️" };
      const icon = icons[unit] ?? "";
      elements.elevationTooltipEle.innerHTML = `${icon} <b>${Math.round(pt.value)} ${unit}</b>`;
    }
    if (elements.elevationTooltipGrade) elements.elevationTooltipGrade.innerHTML = "";
  },
  onLeave() {
    mapAdapter.clearElevationMarker();
    if (elements.elevationTooltip) elements.elevationTooltip.hidden = true;
  },
});

function updateElevationButton(geometry) {
  activeGeometry = geometry ?? [];
  const hasEle = activeGeometry.length > 1 && activeGeometry.some((p) => p.ele != null);
  if (elements.elevationBtn) elements.elevationBtn.disabled = !hasEle;
  if (elements.gradeLegend) elements.gradeLegend.hidden = !hasEle;
  if (elements.gradeLegendPlan) elements.gradeLegendPlan.hidden = !hasEle;
  // Ha nincs ele adat, töröld a grade route-ot és reseteld a togglekat
  if (!hasEle) {
    mapAdapter.clearGradeRoute();
    if (elements.gradeMapToggle) elements.gradeMapToggle.checked = false;
    if (elements.gradeMapTogglePlan) elements.gradeMapTogglePlan.checked = false;
  }
  // Ha a panel nyitva van, frissítsd a chartot
  if (!elements.elevationPanel?.hidden) {
    const data = buildElevationData(activeGeometry);
    elevationChart.setData(data);
    updateElevationPanelInfo(data);
  }
}

function syncElevationBtnState(isOpen) {
  // Toolbar gomb: aktív ha bármely chart nyitva van
  if (elements.elevationBtn) elements.elevationBtn.classList.toggle("is-active", isOpen);

  // Chart icon gombok: csak az aktív típus kiemelve
  const typeMap = {
    elevation: [elements.gradeLegendChartBtn, elements.gradeLegendChartBtnPlan],
    speed:     [elements.speedChartBtn],
    hr:        [elements.hrChartBtn],
  };
  Object.entries(typeMap).forEach(([type, btns]) => {
    const active = isOpen && activeChartType === type;
    btns.forEach((btn) => { if (btn) btn.classList.toggle("is-active", active); });
  });
}

// Egységes réteg-kapcsoló: csak egy lehet aktív egyszerre
function applyRouteLayer(type) {
  // 1. Minden toggle kikapcsol
  if (elements.speedMapToggle) elements.speedMapToggle.checked = false;
  if (elements.hrMapToggle)    elements.hrMapToggle.checked    = false;
  if (elements.cadMapToggle)   elements.cadMapToggle.checked   = false;
  if (elements.gradeMapToggle) elements.gradeMapToggle.checked = false;
  if (elements.gradeMapTogglePlan) elements.gradeMapTogglePlan.checked = false;

  // 2. Minden réteg törlése
  mapAdapter.clearColoredRoute();
  mapAdapter.clearHrRoute();
  mapAdapter.clearCadRoute();
  mapAdapter.clearGradeRoute();

  // 3. Aktív réteg bekapcsolása
  switch (type) {
    case "speed":
      if (importedColoredGeometry) {
        if (elements.speedMapToggle) elements.speedMapToggle.checked = true;
        mapAdapter.renderColoredRoute(importedColoredGeometry);
      }
      break;
    case "hr":
      if (importedHrGeometry) {
        if (elements.hrMapToggle) elements.hrMapToggle.checked = true;
        mapAdapter.renderHrRoute(importedHrGeometry);
      }
      break;
    case "cad":
      if (importedCadGeometry) {
        if (elements.cadMapToggle) elements.cadMapToggle.checked = true;
        mapAdapter.renderCadRoute(importedCadGeometry);
      }
      break;
    case "grade":
      if (activeGeometry.length > 1) {
        if (elements.gradeMapToggle) elements.gradeMapToggle.checked = true;
        if (elements.gradeMapTogglePlan) elements.gradeMapTogglePlan.checked = true;
        mapAdapter.renderGradeRoute(activeGeometry);
      }
      break;
    default:
      // Sima útvonal
      if (activeGeometry.length > 1) mapAdapter.renderRoute(activeGeometry);
  }
}

// Toggle event handlerek — kizárólagos logika
elements.speedMapToggle?.addEventListener("change", (e) => {
  applyRouteLayer(e.target.checked ? "speed" : null);
});
elements.hrMapToggle?.addEventListener("change", (e) => {
  applyRouteLayer(e.target.checked ? "hr" : null);
});
elements.cadMapToggle?.addEventListener("change", (e) => {
  applyRouteLayer(e.target.checked ? "cad" : null);
});
[elements.gradeMapToggle, elements.gradeMapTogglePlan].forEach((toggle) => {
  toggle?.addEventListener("change", (e) => applyRouteLayer(e.target.checked ? "grade" : null));
});

// Chart gombok — kizárólagos: csak egy típus lehet aktív
function handleChartBtn(type) {
  if (!elements.elevationPanel?.hidden && activeChartType === type) {
    closeElevationPanel();
  } else {
    openChartPanel(type);
  }
}

[elements.gradeLegendChartBtn, elements.gradeLegendChartBtnPlan].forEach((btn) => {
  btn?.addEventListener("click", () => handleChartBtn("elevation"));
});
elements.speedChartBtn?.addEventListener("click", () => handleChartBtn("speed"));
elements.hrChartBtn?.addEventListener("click",    () => handleChartBtn("hr"));

function updateElevationPanelInfo(data) {
  if (!elements.elevationInfo || !data.length) return;
  const eles = data.map((p) => p.ele).filter((e) => e != null);
  if (!eles.length) return;
  const minEle = Math.min(...eles);
  const maxEle = Math.max(...eles);
  // Emelkedés / ereszkedés
  let asc = 0, desc = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i].ele == null || data[i - 1].ele == null) continue;
    const d = data[i].ele - data[i - 1].ele;
    if (d > 0) asc += d; else desc += Math.abs(d);
  }
  elements.elevationInfo.innerHTML =
    `<span>↑ <b>${Math.round(asc)} m</b></span>` +
    `<span>↓ <b>${Math.round(desc)} m</b></span>` +
    `<span>Min <b>${Math.round(minEle)} m</b></span>` +
    `<span>Max <b>${Math.round(maxEle)} m</b></span>`;
}

// Chart panel megnyitása adott típussal
function openChartPanel(type) {
  if (!elements.elevationPanel) return;
  activeChartType = type ?? "elevation";

  let data, opts, title;
  if (type === "speed") {
    data = buildSpeedData(activeGeometry);
    opts = { color: "#3B82F6", unit: "km/h" };
    title = "Sebesség";
  } else if (type === "hr") {
    data = buildHrData(activeGeometry);
    opts = { color: "#EF4444", unit: "bpm" };
    title = "Pulzus";
  } else {
    data = buildElevationData(activeGeometry);
    opts = { color: "#fc4c02", unit: "m" };
    title = "Szintprofil";
  }

  elements.elevationPanel.hidden = false;
  if (elements.elevationPanel.querySelector(".elevation-panel-title")) {
    elements.elevationPanel.querySelector(".elevation-panel-title").textContent = title;
  }
  elevationChart.setData(data, opts);
  updateElevationPanelInfo(data);
  syncElevationBtnState(true);
}

// Szintprofil megnyitása
function openElevationPanel() {
  openChartPanel("elevation");
}

// Szintprofil bezárása
function closeElevationPanel() {
  if (elements.elevationPanel) elements.elevationPanel.hidden = true;
  mapAdapter.clearElevationMarker();
  if (elements.elevationTooltip) elements.elevationTooltip.hidden = true;
  syncElevationBtnState(false);
}

// Toggle logika minden gombhoz
function toggleElevationPanel() {
  if (elements.elevationPanel?.hidden) {
    openElevationPanel();
  } else {
    closeElevationPanel();
  }
}

elements.elevationBtn?.addEventListener("click", toggleElevationPanel);

// Szintprofil panel bezárása (X gomb)
elements.elevationClose?.addEventListener("click", closeElevationPanel);

// Resize observer a canvas újrarajzoláshoz
const elevationResizeObserver = new ResizeObserver(() => elevationChart.resize());
if (elements.elevationPanel) elevationResizeObserver.observe(elements.elevationPanel);

const _initSettings = getSettings();
// sidebar toggles
if (elements.snapToRoads) elements.snapToRoads.checked = _initSettings.snapToRoads;
if (elements.showStageInfo) elements.showStageInfo.checked = _initSettings.showStageInfo;
if (elements.gpxSampleWaypoints) elements.gpxSampleWaypoints.checked = _initSettings.gpxSampleWaypoints;
// settings panel toggles
if (elements.snapToRoadsSettings) elements.snapToRoadsSettings.checked = _initSettings.snapToRoads;
if (elements.showStageInfoSettings) elements.showStageInfoSettings.checked = _initSettings.showStageInfo;
if (elements.gpxSampleWaypointsSettings) elements.gpxSampleWaypointsSettings.checked = _initSettings.gpxSampleWaypoints;
// Apply showStageInfo on load
if (document.querySelector(".stats-panel")) {
  document.querySelector(".stats-panel").hidden = !_initSettings.showStageInfo;
}
syncRouteModeButtons(store.getState().mode);
const _sv = getSettings().startView;
setTimeout(() => {
  mapAdapter.invalidateSize();
  if (_sv) mapAdapter.setView(_sv.lat, _sv.lng, _sv.zoom);
}, 100);
if (_sv) setTimeout(() => mapAdapter.setView(_sv.lat, _sv.lng, _sv.zoom), 500);

store.subscribe(async (state) => {
  renderSidebar(state);
  elements.undoButton.disabled = !state.canUndo;
  elements.redoButton.disabled = !state.canRedo;
  const hasPoints = state.waypoints.length > 0;
  elements.exportButton.disabled = !hasPoints;
  if (elements.fileExportButton) elements.fileExportButton.disabled = !hasPoints;
  if (elements.sidebarExportButton) elements.sidebarExportButton.hidden = !hasPoints;
  mapAdapter.renderWaypoints(state.waypoints);
  if (state.importedRoute) {
    // Az aktív toggle határozza meg a megjelenítést
    return;
  }
  const routeSignature = JSON.stringify({
    mode: state.mode,
    snapToRoads: state.snapToRoads,
    waypoints: state.waypoints.map(({ lat, lng }) => [lat, lng]),
  });
  if (routeSignature === lastRouteSignature) return;
  lastRouteSignature = routeSignature;

  const requestId = ++routeRequestId;
  const route = await mapAdapter.calculateRoute(state, activeTool === "waypoint");
  if (requestId !== routeRequestId) return;

  store.setState({
    routeGeometry: route.geometry,
    distanceMeters: route.distanceMeters,
    ascentMeters: route.ascentMeters ?? 0,
    descentMeters: route.descentMeters ?? 0,
    sourcePointCount: 0,
  });
  mapAdapter.renderRoute(route.geometry);
  updateElevationButton(route.geometry);
});

elements.routeModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setRouteMode(button.dataset.routeMode, { persistDefault: true });
  });
});

// Helper: apply a boolean setting and keep sidebar + settings in sync
function applySnapToRoads(val) {
  store.setState({ snapToRoads: val });
  saveSetting("snapToRoads", val);
  if (elements.snapToRoads) elements.snapToRoads.checked = val;
  if (elements.snapToRoadsSettings) elements.snapToRoadsSettings.checked = val;
}
function applyShowStageInfo(val) {
  const statsPanel = document.querySelector(".stats-panel");
  if (statsPanel) statsPanel.hidden = !val;
  saveSetting("showStageInfo", val);
  if (elements.showStageInfo) elements.showStageInfo.checked = val;
  if (elements.showStageInfoSettings) elements.showStageInfoSettings.checked = val;
}
function applyGpxSampleWaypoints(val) {
  saveSetting("gpxSampleWaypoints", val);
  if (elements.gpxSampleWaypoints) elements.gpxSampleWaypoints.checked = val;
  if (elements.gpxSampleWaypointsSettings) elements.gpxSampleWaypointsSettings.checked = val;
}

elements.snapToRoads?.addEventListener("change", () => applySnapToRoads(elements.snapToRoads.checked));
elements.snapToRoadsSettings?.addEventListener("change", () => applySnapToRoads(elements.snapToRoadsSettings.checked));

elements.showStageInfo?.addEventListener("change", () => applyShowStageInfo(elements.showStageInfo.checked));
elements.showStageInfoSettings?.addEventListener("change", () => applyShowStageInfo(elements.showStageInfoSettings.checked));

elements.gpxSampleWaypoints?.addEventListener("change", () => applyGpxSampleWaypoints(elements.gpxSampleWaypoints.checked));
elements.gpxSampleWaypointsSettings?.addEventListener("change", () => applyGpxSampleWaypoints(elements.gpxSampleWaypointsSettings.checked));

elements.mapStyleButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const style = btn.dataset.mapStyle;
    localStorage.setItem("route4meMapStyle", style);
    saveSetting("mapStyle", style);
    syncMapStyleButtons(style);
    mapAdapter.setMapStyle(style);
    // close layer picker
    const picker = document.querySelector("#layerPicker");
    const pickerBtn = document.querySelector("#layerPickerBtn");
    if (picker) picker.hidden = true;
    if (pickerBtn) {
      pickerBtn.classList.remove("is-active");
      syncLayerPickerBtn(style);
    }
    // close sidebar style picker
    const sidebarPicker = document.querySelector("#sidebarStylePicker");
    const sidebarBtn = document.querySelector("#sidebarStyleBtn");
    if (sidebarPicker) sidebarPicker.hidden = true;
    if (sidebarBtn) sidebarBtn.classList.remove("is-open");
    syncSidebarStyleBtn(style);
    syncFileStyleBtn(style);
    // close file style picker
    const filePicker = document.querySelector("#fileStylePicker");
    const fileBtn = document.querySelector("#fileStyleBtn");
    if (filePicker) filePicker.hidden = true;
    if (fileBtn) fileBtn.classList.remove("is-open");
  });
});

// File tab style picker toggle
const fileStyleBtn = document.querySelector("#fileStyleBtn");
const fileStylePicker = document.querySelector("#fileStylePicker");
fileStyleBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !fileStylePicker.hidden;
  fileStylePicker.hidden = isOpen;
  fileStyleBtn.classList.toggle("is-open", !isOpen);
  if (!isOpen) window.lucide?.createIcons();
});
document.addEventListener("click", () => {
  if (fileStylePicker && !fileStylePicker.hidden) {
    fileStylePicker.hidden = true;
    fileStyleBtn?.classList.remove("is-open");
  }
});
fileStylePicker?.addEventListener("click", (e) => e.stopPropagation());

// Sidebar style picker toggle
const sidebarStyleBtn = document.querySelector("#sidebarStyleBtn");
const sidebarStylePicker = document.querySelector("#sidebarStylePicker");
sidebarStyleBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !sidebarStylePicker.hidden;
  sidebarStylePicker.hidden = isOpen;
  sidebarStyleBtn.classList.toggle("is-open", !isOpen);
  if (!isOpen) window.lucide?.createIcons();
});
document.addEventListener("click", () => {
  if (sidebarStylePicker && !sidebarStylePicker.hidden) {
    sidebarStylePicker.hidden = true;
    sidebarStyleBtn?.classList.remove("is-open");
  }
});
sidebarStylePicker?.addEventListener("click", (e) => e.stopPropagation());

// Layer picker toggle
const layerPickerBtn = document.querySelector("#layerPickerBtn");
const layerPicker = document.querySelector("#layerPicker");
layerPickerBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !layerPicker.hidden;
  layerPicker.hidden = isOpen;
  layerPickerBtn.classList.toggle("is-active", !isOpen);
  if (!isOpen) window.lucide?.createIcons();
});
document.addEventListener("click", () => {
  if (layerPicker && !layerPicker.hidden) {
    layerPicker.hidden = true;
    layerPickerBtn?.classList.remove("is-active");
  }
});
layerPicker?.addEventListener("click", (e) => e.stopPropagation());

elements.toolButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    elements.toolButtons.forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    activeTool = btn.dataset.tool;
    mapAdapter.setActiveTool(activeTool);
    if (elements.measureBar) elements.measureBar.hidden = activeTool !== "measure";
  });
});

elements.measureClear?.addEventListener("click", () => {
  mapAdapter.clearMeasurement();
});

// Topnav dropdown
const topnavMenuBtn = document.querySelector("#topnavMenuBtn");
const topnavDropdown = document.querySelector("#topnavDropdown");
topnavMenuBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  topnavDropdown.hidden = !topnavDropdown.hidden;
});
document.addEventListener("click", () => {
  if (topnavDropdown) topnavDropdown.hidden = true;
});
topnavDropdown?.addEventListener("click", (e) => e.stopPropagation());

elements.shortcutButton.addEventListener("click", () => {
  if (topnavDropdown) topnavDropdown.hidden = true;
  elements.shortcutOverlay.hidden = false;
});
elements.shortcutClose.addEventListener("click", () => {
  elements.shortcutOverlay.hidden = true;
});
elements.shortcutOverlay.addEventListener("click", (e) => {
  if (e.target === elements.shortcutOverlay) elements.shortcutOverlay.hidden = true;
});

// Logout — only shown when login is enabled in config
if (config.login) {
  const logoutBtn = document.querySelector("#logoutButton");
  const logoutDivider = document.querySelector("#logoutDivider");
  if (logoutBtn) logoutBtn.hidden = false;
  if (logoutDivider) logoutDivider.hidden = false;
  logoutBtn?.addEventListener("click", () => {
    logout();
    window.location.replace("./login.html");
  });
}

elements.saveRouteButton.addEventListener("click", () => {
  showToast("Mentés hamarosan elérhető.");
});
elements.shareRouteButton.addEventListener("click", () => {
  showToast("Megosztás hamarosan elérhető.");
});

// Settings overlay
const settingsOverlay = document.querySelector("#settingsOverlay");
const settingsClose   = document.querySelector("#settingsClose");

function openSettings() {
  if (topnavDropdown) topnavDropdown.hidden = true;
  syncStartViewDisplay();
  settingsOverlay.hidden = false;
  window.lucide?.createIcons();
}

elements.settingsButton.addEventListener("click", openSettings);
settingsClose?.addEventListener("click", () => { settingsOverlay.hidden = true; });
settingsOverlay?.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.hidden = true;
});

// ── Kezdő nézet ────────────────────────────────────────────
function syncStartViewDisplay() {
  const sv = getSettings().startView;
  const currentEl  = document.querySelector("#startViewCurrent");
  const labelEl    = document.querySelector("#startViewLabel");
  if (!currentEl || !labelEl) return;
  if (sv) {
    labelEl.textContent = sv.label || `${sv.lat.toFixed(4)}, ${sv.lng.toFixed(4)} — zoom ${sv.zoom}`;
    currentEl.hidden = false;
  } else {
    currentEl.hidden = true;
  }
  window.lucide?.createIcons();
}

// Jelenlegi nézet mentése
document.querySelector("#startViewCurrentBtn")?.addEventListener("click", () => {
  const view = mapAdapter.getCurrentView();
  const label = `${view.lat.toFixed(5)}, ${view.lng.toFixed(5)}  (zoom ${view.zoom})`;
  saveSetting("startView", { ...view, label });
  syncStartViewDisplay();
  // Flash the map to the saved location so the user sees it in the background
  mapAdapter.setView(view.lat, view.lng, view.zoom);
  showToast("Induló nézet mentve.");
});

// GPS pozíció lekérése
document.querySelector("#startViewGpsBtn")?.addEventListener("click", () => {
  if (!navigator.geolocation) {
    showToast("GPS nem elérhető a böngészőben.");
    return;
  }
  const btn = document.querySelector("#startViewGpsBtn");
  if (btn) btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const label = `GPS: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      saveSetting("startView", { lat, lng, zoom: 13, label });
      syncStartViewDisplay();
      mapAdapter.setView(lat, lng, 13);
      if (btn) btn.disabled = false;
      showToast("GPS pozíció mentve induló nézetként.");
    },
    (error) => {
      const msg =
        error.code === 1 ? "GPS engedély megtagadva." :
        error.code === 3 ? "GPS időtúllépés." :
        "GPS hiba.";
      showToast(msg);
      if (btn) btn.disabled = false;
    },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 },
  );
});

// Törlés
document.querySelector("#startViewClearBtn")?.addEventListener("click", () => {
  saveSetting("startView", null);
  syncStartViewDisplay();
});

// Keresés — dropdown position: fixed, viewport-relatív
function positionStartViewResults() {
  const input = document.querySelector("#startViewSearch");
  const resultsEl = document.querySelector("#startViewResults");
  if (!input || !resultsEl) return;
  const rect = input.getBoundingClientRect();
  resultsEl.style.top  = `${rect.bottom + 4}px`;
  resultsEl.style.left = `${rect.left}px`;
  resultsEl.style.width = `${rect.width}px`;
}

let startViewSearchTimer = null;
document.querySelector("#startViewSearch")?.addEventListener("input", (e) => {
  clearTimeout(startViewSearchTimer);
  const q = e.target.value.trim();
  const resultsEl = document.querySelector("#startViewResults");
  if (!q) { resultsEl.hidden = true; return; }
  startViewSearchTimer = setTimeout(async () => {
    try {
      const places = await searchPlaces(q, "hu");
      resultsEl.innerHTML = "";
      if (!places.length) {
        resultsEl.hidden = true;
        return;
      }
      places.slice(0, 5).forEach((place) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-result-btn";
        btn.textContent = place.name;
        btn.addEventListener("click", () => {
          mapAdapter.focusWaypoint(place.lat, place.lng);
          // Save after focus so zoom reflects the actual displayed zoom
          setTimeout(() => {
            const view = mapAdapter.getCurrentView();
            saveSetting("startView", { lat: view.lat, lng: view.lng, zoom: view.zoom, label: place.name });
            syncStartViewDisplay();
          }, 350);
          document.querySelector("#startViewSearch").value = "";
          resultsEl.hidden = true;
          showToast("Induló nézet mentve.");
        });
        resultsEl.append(btn);
      });
      positionStartViewResults();
      resultsEl.hidden = false;
    } catch { resultsEl.hidden = true; }
  }, 350);
});
document.querySelector("#startViewSearch")?.addEventListener("blur", () => {
  setTimeout(() => {
    const resultsEl = document.querySelector("#startViewResults");
    if (resultsEl) resultsEl.hidden = true;
  }, 200);
});

elements.unitInputs.forEach((input) => {
  input.addEventListener("change", () => {
    units = input.value;
    localStorage.setItem("route4meUnits", units);
    renderSidebar(store.getState());
  });
});

function syncMapStyleButtons(style) {
  elements.mapStyleButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.mapStyle === style);
  });
}

function clearAllRouteState() {
  importedColoredGeometry = null;
  importedHrGeometry = null;
  importedCadGeometry = null;
  mapAdapter.clearColoredRoute();
  mapAdapter.clearHrRoute();
  mapAdapter.clearCadRoute();
  mapAdapter.clearGradeRoute();
  store.clear();
  clearFileTab();
  updateElevationButton([]);
  closeElevationPanel();
}

elements.clearRoute.addEventListener("click", () => {
  clearAllRouteState();
  showToast(i18n.t("route.cleared"));
});

elements.resetRouteButton.addEventListener("click", () => {
  clearAllRouteState();
  showToast(i18n.t("route.cleared"));
});

elements.undoButton.addEventListener("click", () => store.undo());
elements.redoButton.addEventListener("click", () => store.redo());

elements.reverseRouteButton.addEventListener("click", () => {
  const state = store.getState();
  store.replaceWaypoints([...state.waypoints].reverse(), {
    geometry: [...state.routeGeometry].reverse(),
    importedRoute: state.importedRoute,
    sourcePointCount: state.sourcePointCount,
  });
});

elements.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = elements.searchInput.value.trim();
  if (!query) return;

  elements.searchResults.textContent = "";
  try {
    const places = await searchPlaces(query, i18n.language);
    if (!places.length) {
      elements.searchResults.textContent = i18n.t("search.noResults");
      return;
    }
    renderSearchResults(places);
  } catch {
    showToast(i18n.t("search.failed"));
  }
});

elements.locateButton.addEventListener("click", () => {
  if (!navigator.geolocation) {
    showToast(i18n.t("location.unsupported"));
    return;
  }

  elements.locateButton.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const point = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      mapAdapter.showUserLocation(point);
      showToast(i18n.t("location.found"));
      elements.locateButton.disabled = false;
    },
    (error) => {
      const msg =
        error.code === 1 ? i18n.t("location.denied") :
        error.code === 3 ? i18n.t("location.timeout") :
        i18n.t("location.failed");
      showToast(msg);
      elements.locateButton.disabled = false;
    },
    {
      enableHighAccuracy: true,
      maximumAge: 30000,
      timeout: 10000,
    },
  );
});

// ── Export modal ───────────────────────────────────────────
function slugify(text) {
  return text
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // ékezetek eltávolítása
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "utvonal";
}

function buildExportName(waypoints) {
  const first = waypoints[0]?.name;
  const last = waypoints[waypoints.length - 1]?.name;
  if (first && last && first !== last) return `${first} – ${last}`;
  if (first) return first;
  return "Bringaterv útvonal";
}

function openExportModal() {
  const state = store.getState();
  const suggestedName = buildExportName(state.waypoints);
  const today = new Date().toISOString().slice(0, 10);
  const suggestedFilename = `${slugify(suggestedName)}-${today}`;

  elements.exportName.value = suggestedName;
  elements.exportDesc.value = "";
  elements.exportFilename.value = suggestedFilename;
  // Set mode radio to current route mode
  const modeRadio = elements.exportOverlay.querySelector(`input[name="exportMode"][value="${state.mode}"]`);
  if (modeRadio) modeRadio.checked = true;
  elements.exportOverlay.hidden = false;
  window.lucide?.createIcons();
  setTimeout(() => elements.exportName.select(), 50);
}

// Auto-update filename when name changes
elements.exportName?.addEventListener("input", () => {
  const today = new Date().toISOString().slice(0, 10);
  elements.exportFilename.value = `${slugify(elements.exportName.value)}-${today}`;
});

// Confirm: build GPX and download
elements.exportConfirm?.addEventListener("click", () => {
  const state = store.getState();
  const name = elements.exportName.value.trim() || "Bringaterv útvonal";
  const desc = elements.exportDesc.value.trim();
  const filename = (elements.exportFilename.value.trim() || slugify(name)) + ".gpx";

  const selectedMode = elements.exportOverlay.querySelector("input[name=\"exportMode\"]:checked")?.value ?? state.mode;
  const content = exportGpx({
    waypoints: state.waypoints,
    geometry: state.routeGeometry,
    name,
    desc,
    mode: selectedMode,
  });
  downloadGpx(filename, content);
  elements.exportOverlay.hidden = true;
});

// Close modal
elements.exportClose?.addEventListener("click", () => {
  elements.exportOverlay.hidden = true;
});
elements.exportOverlay?.addEventListener("click", (e) => {
  if (e.target === elements.exportOverlay) elements.exportOverlay.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && elements.exportOverlay && !elements.exportOverlay.hidden) {
    elements.exportOverlay.hidden = true;
  }
});

// All export buttons open the modal
elements.exportButton.addEventListener("click", () => openExportModal());
elements.sidebarExportButton?.addEventListener("click", () => openExportModal());

elements.importButton.addEventListener("click", () => elements.gpxInput.click());
document.querySelector("#fileEmptyState")?.addEventListener("click", () => elements.gpxInput.click());
elements.gpxInput.addEventListener("change", async () => {
  const [file] = elements.gpxInput.files;
  if (!file) return;
  let imported;
  try {
    imported = await importGpx(file, { sampleWaypoints: elements.gpxSampleWaypoints?.checked });
  } catch (err) {
    showToast("Nem sikerült betölteni a fájlt. Ellenőrizd, hogy érvényes GPX fájl-e.");
    elements.gpxInput.value = "";
    console.error("GPX import error:", err);
    return;
  }
  store.replaceWaypoints(imported.waypoints, {
    geometry: imported.geometry,
    importedRoute: true,
    sourcePointCount: imported.sourcePointCount,
  });
  const { ascentMeters, descentMeters } = calcElevationFromGeometry(imported.geometry);
  const distanceMeters = calculateImportedDistance(imported.geometry);
  store.setState({ distanceMeters, ascentMeters, descentMeters });

  const hasSpeed = imported.geometry.some(p => p.speed != null);
  const hasHr = imported.geometry.some(p => p.hr != null);
  const hasCad = imported.geometry.some(p => p.cad != null);

  // Geometriák tárolása (togglekhoz)
  importedColoredGeometry = hasSpeed ? imported.geometry : null;
  importedCadGeometry     = hasCad  ? imported.geometry : null;
  importedHrGeometry      = hasHr   ? imported.geometry : null;

  // activeGeometry beállítása előbb, hogy applyRouteLayer(null) renderelhessen
  updateElevationButton(imported.geometry);
  // Alapértelmezett megjelenítés: sima útvonal, togglek kikapcsolva
  applyRouteLayer(null);
  // Biztosítjuk hogy a plain route mindig látszik
  mapAdapter.renderRoute(imported.geometry);

  populateFileTab({ filename: file.name, geometry: imported.geometry, distanceMeters, ascentMeters, descentMeters, speedColored: hasSpeed, meta: imported.meta ?? {} });
  switchTab("file");

  showToast(i18n.t("route.imported", { points: imported.sourcePointCount }));
  setTimeout(() => mapAdapter.fitRoute(), 50);
  elements.gpxInput.value = "";

  // Reverse geocode imported waypoints in the background
  for (const wp of store.getState().waypoints) {
    const name = await reverseGeocode(wp.lat, wp.lng);
    if (name && store.getState().waypoints.some((w) => w.id === wp.id)) {
      store.updateWaypoint(wp.id, { name });
    }
  }
});

// File tab export button — same modal
elements.fileExportButton?.addEventListener("click", () => openExportModal());

// Legend accordion (expand/collapse color items on header click)
document.querySelectorAll(".speed-legend-expand").forEach((btn) => {
  btn.addEventListener("click", () => {
    const legend = btn.closest(".speed-legend");
    const expanded = legend.classList.toggle("is-expanded");
    btn.setAttribute("aria-expanded", String(expanded));
    window.lucide?.createIcons();
  });
});

document.querySelector("#fileClearButton")?.addEventListener("click", () => {
  clearAllRouteState();
  switchTab("plan");
});

document.addEventListener("keydown", (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) { event.preventDefault(); store.undo(); }
  if (key === "z" && event.shiftKey)  { event.preventDefault(); store.redo(); }
  if (key === "y") { event.preventDefault(); store.redo(); }
  if (key === "i") { event.preventDefault(); elements.gpxInput.click(); }
  if (key === "e") { event.preventDefault(); elements.exportButton.click(); }
  if (key === "r") { event.preventDefault(); elements.resetRouteButton.click(); }
});

function setupNavigation() {
  const shouldCollapse = localStorage.getItem("route4meNavCollapsed") === "true";
  elements.appShell.classList.toggle("is-nav-collapsed", shouldCollapse);
  updateNavToggle();

  elements.navToggle.addEventListener("click", () => {
    const nextCollapsed = !elements.appShell.classList.contains("is-nav-collapsed");
    elements.appShell.classList.toggle("is-nav-collapsed", nextCollapsed);
    localStorage.setItem("route4meNavCollapsed", String(nextCollapsed));
    updateNavToggle();
    setTimeout(() => mapAdapter.invalidateSize(), 210);
  });
}

function updateNavToggle() {
  const isCollapsed = elements.appShell.classList.contains("is-nav-collapsed");
  const label = i18n.t(isCollapsed ? "nav.expand" : "nav.collapse");
  elements.navToggle.title = label;
  elements.navToggle.ariaLabel = label;
  elements.navToggle.setAttribute("aria-expanded", String(!isCollapsed));
  elements.navToggle.innerHTML = `<i data-lucide="${isCollapsed ? "panel-left-open" : "panel-left-close"}" aria-hidden="true"></i>`;
  window.lucide?.createIcons();
}

function setRouteMode(mode, { persistDefault }) {
  syncRouteModeButtons(mode);
  store.setState({ mode });
  if (persistDefault) {
    localStorage.setItem("route4meDefaultRouteMode", mode);
  }
}

function syncRouteModeButtons(mode) {
  elements.routeModeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.routeMode === mode);
    button.classList.toggle("mode-btn", true);
  });
}

function renderSidebar(state) {
  elements.waypointList.innerHTML = "";
  elements.emptyState.hidden = state.waypoints.length > 0;
  elements.distanceValue.textContent = state.distanceMeters > 0 ? formatDisplayDistance(state.distanceMeters) : "—";
  elements.pointCount.textContent = String(state.waypoints.length);
  const hasElevation = state.ascentMeters > 0 || state.descentMeters > 0;
  elements.ascentRow.hidden = !hasElevation;
  elements.descentRow.hidden = !hasElevation;
  if (hasElevation) {
    elements.ascentValue.textContent = `${state.ascentMeters} m`;
    elements.descentValue.textContent = `${state.descentMeters} m`;
  }

  if (state.importedRoute && state.sourcePointCount > 0) {
    const summary = document.createElement("li");
    summary.className = "route-summary";
    summary.textContent = i18n.t("route.importedSummary", {
      source: state.sourcePointCount,
      shown: state.routeGeometry.length,
    });
    elements.waypointList.append(summary);
  }

  state.waypoints.forEach((point, index) => {
    const isSelected = point.id === selectedWaypointId;
    const item = document.createElement("li");
    item.className = "waypoint" + (isSelected ? " is-selected" : "");
    item.draggable = true;
    item.dataset.index = String(index);

    item.addEventListener("dragstart", (e) => {
      dragSrcIndex = index;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
      setTimeout(() => item.classList.add("is-dragging"), 0);
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("is-dragging");
      dragSrcIndex = null;
    });
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      item.classList.add("drag-over");
    });
    item.addEventListener("dragleave", (e) => {
      if (!item.contains(e.relatedTarget)) item.classList.remove("drag-over");
    });
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove("drag-over");
      const from = Number(e.dataTransfer.getData("text/plain"));
      if (!Number.isNaN(from) && from !== index) {
        store.reorderWaypoints(from, index);
      }
      dragSrcIndex = null;
    });

    const handle = document.createElement("span");
    handle.className = "waypoint-handle";
    handle.innerHTML = `<i data-lucide="grip-vertical" aria-hidden="true"></i>`;
    handle.title = "Húzd a sorrend módosításához";

    const badge = document.createElement("span");
    badge.className = "waypoint-index";
    badge.textContent = String(index + 1);

    const label = document.createElement("span");
    label.className = "waypoint-label";
    label.textContent = point.name || i18n.t("route.point", { number: index + 1 });
    label.addEventListener("click", () => {
      selectedWaypointId = isSelected ? null : point.id;
      renderSidebar(store.getState());
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini-button";
    remove.innerHTML = `<i data-lucide="x" aria-hidden="true"></i>`;
    remove.title = i18n.t("actions.remove");
    remove.ariaLabel = i18n.t("actions.remove");
    remove.addEventListener("click", () => {
      if (selectedWaypointId === point.id) selectedWaypointId = null;
      store.removeWaypoint(point.id);
    });

    const labelWrap = document.createElement("div");
    labelWrap.className = "waypoint-label-wrap";
    labelWrap.append(label);
    if (point.note) {
      const note = document.createElement("span");
      note.className = "waypoint-note";
      note.textContent = point.note;
      labelWrap.append(note);
    }

    item.append(handle, badge, labelWrap, remove);

    if (isSelected) {
      const options = document.createElement("div");
      options.className = "waypoint-options";

      const setDest = document.createElement("button");
      setDest.type = "button";
      setDest.className = "waypoint-option-btn";
      setDest.textContent = i18n.t("waypoint.setDestination");
      setDest.addEventListener("click", () => {
        const s = store.getState();
        if (s.waypoints.length > 1 && index !== s.waypoints.length - 1) {
          store.reorderWaypoints(index, s.waypoints.length - 1);
        }
        selectedWaypointId = null;
      });

      const focus = document.createElement("button");
      focus.type = "button";
      focus.className = "waypoint-option-btn";
      focus.textContent = i18n.t("waypoint.focusMap");
      focus.addEventListener("click", () => {
        mapAdapter.focusWaypoint(point.lat, point.lng);
        selectedWaypointId = null;
        renderSidebar(store.getState());
      });

      options.append(setDest, focus);
      item.append(options);
    }

    elements.waypointList.append(item);
  });

  window.lucide?.createIcons();
}

function formatDisplayDistance(meters) {
  if (units === "imperial") {
    const miles = meters / 1609.344;
    if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
    return `${miles.toFixed(1)} mi`;
  }
  return formatDistance(meters);
}

function calculateImportedDistance(geometry) {
  return geometry.slice(1).reduce((total, point, index) => {
    const previous = geometry[index];
    const earthRadius = 6371000;
    const dLat = ((point.lat - previous.lat) * Math.PI) / 180;
    const dLng = ((point.lng - previous.lng) * Math.PI) / 180;
    const lat1 = (previous.lat * Math.PI) / 180;
    const lat2 = (point.lat * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return total + earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }, 0);
}

// ── Hint tooltips ─────────────────────────────────────────
(function setupHintTooltips() {
  const tooltip = document.getElementById("hintTooltip");
  if (!tooltip) return;

  let activeBtn = null;

  function showTooltip(btn) {
    const text = btn.dataset.hint;
    if (!text) return;
    tooltip.textContent = text;
    tooltip.hidden = false;
    activeBtn = btn;
    positionTooltip(btn);
  }

  function positionTooltip(btn) {
    const rect = btn.getBoundingClientRect();
    const tw = 240;
    const gap = 8;
    let left = rect.left + rect.width / 2 - tw / 2;
    let top = rect.top - gap;

    // clamp horizontally
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));

    // decide above or below
    tooltip.style.maxWidth = tw + "px";
    tooltip.style.left = left + "px";

    // first render above, then check if it fits
    tooltip.style.top = (top - tooltip.offsetHeight) + "px";
    if (rect.top - tooltip.offsetHeight - gap < 8) {
      // show below
      tooltip.style.top = (rect.bottom + gap) + "px";
    }
  }

  function hideTooltip() {
    tooltip.hidden = true;
    activeBtn = null;
  }

  document.addEventListener("mouseover", (e) => {
    const btn = e.target.closest(".hint-btn");
    if (btn && btn !== activeBtn) showTooltip(btn);
  });

  document.addEventListener("mouseout", (e) => {
    if (e.target.closest(".hint-btn")) hideTooltip();
  });

  document.addEventListener("click", hideTooltip);
  document.addEventListener("scroll", () => {
    if (activeBtn) positionTooltip(activeBtn);
  }, true);
})();

function renderSearchResults(places) {
  elements.searchResults.innerHTML = "";
  places.forEach((place) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-button";
    button.textContent = place.name;
    button.addEventListener("click", () => {
      store.addWaypoint(place);
      elements.searchResults.textContent = "";
      elements.searchInput.value = "";
    });
    elements.searchResults.append(button);
  });
}
