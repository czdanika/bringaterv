import { requireAuth, logout } from "./auth.js";
import { config } from "./config.js";
import { getSettings, saveSetting } from "./appSettings.js";
import { createI18n } from "./i18n/i18n.js";
import { createRouteStore } from "./state/routeStore.js";
import { createMapAdapter, SEGMENT_COLORS } from "./map/mapAdapter.js";
import { downloadGpx, exportGpx, importGpx, calcElevationFromGeometry, calcTiming } from "./gpx/gpx.js";
import { createToast, formatDistance } from "./ui/dom.js";
import { searchPlaces, reverseGeocode } from "./ui/search.js";
import { buildElevationData, buildSpeedData, buildHrData, buildCadData, initElevationChart } from "./ui/elevationProfile.js";
import { routesApi } from "./api/routesApi.js";

requireAuth();

// ── Verzióellenőrzés ──────────────────────────────────────────────────────────
// Forrás: src/version.js (window.APP_VERSION) — egyetlen helyen kell frissíteni
const APP_VERSION = window.APP_VERSION ?? "v0.70";

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
const tabButtons  = document.querySelectorAll(".sidebar-tab");
const tabPlan     = document.querySelector("#tabPlan");
const tabFile     = document.querySelector("#tabFile");
const tabLibrary  = document.querySelector("#tabLibrary");
let currentTab = "plan";
let hasImportedFile = false;   // igaz, ha az Elemzés fülön van betöltött fájl
let importedFileName = "";    // az importált fájl neve (edzés mentéshez)
let importedGpxText  = null;  // az eredeti GPX tartalom (edzés könyvtár-mentéshez)

// ── Library state ──────────────────────────────────────────
let _libraryData   = { routes: [], workouts: [], samples: [] };
let _libraryFilter = { type: 'all', query: '', sort: 'newest', distMin: 0, distMax: 500, durMin: 0, durMax: 600 };
const DIST_MAX = 500;  // km
const DUR_MAX  = 600;  // perc (10 óra)

// ── Sebességbeállítások ─────────────────────────────────────────────────────
const DEFAULT_SPEEDS = { asphalt: 22, gravel: 18, mtb: 12, hiking: 5 };
const SEGMENT_LABELS = { asphalt: "Aszfalt", gravel: "Gravel", mtb: "MTB", hiking: "Túra" };
const LS_SPEED_PREFIX = 'bringaterv-speed-';

function getSpeedSettings() {
  const s = {};
  for (const [k, def] of Object.entries(DEFAULT_SPEEDS)) {
    const stored = Number(localStorage.getItem(LS_SPEED_PREFIX + k));
    s[k] = (stored > 0) ? stored : def;
  }
  s.cycling = s.asphalt;
  s.walking  = s.hiking;
  return s;
}

// elevationTimeDefault: a Beállításokban mentett alapértelmezett
// elevationTimeEnabled: az aktuális munkamenet értéke (alapból = default, de session-szinten felülírható)
const elevationTimeDefault = () => localStorage.getItem('bringaterv-elevation-default') !== 'false';
let elevationTimeEnabled = elevationTimeDefault();

function switchTab(name) {
  currentTab = name;
  elements.appShell.classList.toggle("is-file-mode",    name === "file");
  elements.appShell.classList.toggle("is-library-mode", name === "library");
  tabButtons.forEach(b => b.classList.toggle("is-active", b.dataset.tab === name));
  tabPlan.hidden    = name !== "plan";
  tabFile.hidden    = name !== "file";
  if (tabLibrary) tabLibrary.hidden = name !== "library";
  const libraryMain = document.querySelector("#libraryMain");
  if (libraryMain) libraryMain.hidden = name !== "library";
  // Tervezés fülön crosshair + route kattintás engedélyezett, Elemzésen/Könyvtáron nem
  mapAdapter?.setRouteInteractive(name === "plan");
  // Könyvtár fül megnyitásakor mindig frissítjük a listát
  if (name === "library" && tabLibrary) loadRouteLibrary();
  window.lucide?.createIcons();
}

// ── Tab váltás megerősítő ─────────────────────────────────────────────────────
let pendingTabSwitch = null;

function requestTabSwitch(targetTab) {
  if (targetTab === currentTab) return;

  const hasPlanData = store.getState().waypoints.length > 0;

  // Könyvtár fülre/könyvtárból való váltásnál nincs megerősítés szükséges
  if (!tabLibrary || targetTab === "library" || currentTab === "library") {
    switchTab(targetTab);
    return;
  }

  if (currentTab === "plan" && targetTab === "file" && hasPlanData) {
    showTabSwitchModal("plan→file");
    pendingTabSwitch = targetTab;
    return;
  }
  if (currentTab === "file" && targetTab === "plan" && hasImportedFile) {
    showTabSwitchModal("file→plan");
    pendingTabSwitch = targetTab;
    return;
  }

  switchTab(targetTab);
}

function showTabSwitchModal(direction) {
  const modal  = document.querySelector("#tabSwitchModal");
  const msg    = document.querySelector("#tabSwitchMsg");
  const saveBtn = document.querySelector("#tabSwitchSave");

  if (direction === "plan→file") {
    msg.textContent = "Van egy tervezett útvonalad. Exportálod GPX-ként mielőtt váltasz, vagy törlöd?";
    saveBtn.hidden = false;
  } else {
    msg.textContent = "Van egy betöltött fájlod az Elemzés fülön. Törlöd és váltasz Tervezésre?";
    saveBtn.hidden = true;
  }
  modal.hidden = false;
}

document.querySelector("#tabSwitchCancel")?.addEventListener("click", () => {
  document.querySelector("#tabSwitchModal").hidden = true;
  pendingTabSwitch = null;
});

document.querySelector("#tabSwitchDiscard")?.addEventListener("click", () => {
  document.querySelector("#tabSwitchModal").hidden = true;
  const target = pendingTabSwitch;
  pendingTabSwitch = null;
  clearAllRouteState();
  switchTab(target);
});

document.querySelector("#tabSwitchSave")?.addEventListener("click", () => {
  document.querySelector("#tabSwitchModal").hidden = true;
  const target = pendingTabSwitch;
  pendingTabSwitch = null;
  openExportModal();
  // Export után a felhasználó manuálisan vált – nem kényszerítjük
  // Ha a pendingTabSwitch-t meg akarjuk tartani: a user az exportModalClose után vált
  // Jelenlegi design: megnyílik az export, aztán marad a Tervezés fülön
  // Ha exportál és utána valóban vált, a guard már nem fog tüzelni (nincs adat)
});

tabButtons.forEach(btn => btn.addEventListener("click", () => requestTabSwitch(btn.dataset.tab)));

// ── Waypoint közbeszúrás: geometria-index alapján meghatározza a helyes pozíciót ──
function findWaypointInsertIndex(waypoints, geometry, clickGeomIdx) {
  if (!geometry || geometry.length === 0) return waypoints.length;

  const N = geometry.length;
  const numWp = waypoints.length;
  if (numWp < 2) return numWp;

  // Forward-search: minden waypointot az előző után keresünk a geometriában.
  // Ez loop-útvonalaknál is helyes indexet ad (Start≈End esetén End → geometry vége).
  const wpGeomIndices = [];
  let searchFrom = 0;

  for (let i = 0; i < numWp; i++) {
    const wp = waypoints[i];
    const isLast = i === numWp - 1;

    // Loop detektálás: ha az utolsó waypoint nagyon közel van az elsőhöz,
    // a geometria végéhez rendeljük (ne az elejéhez)
    if (isLast && wpGeomIndices.length > 0) {
      const dToFirst = Math.hypot(wp.lat - waypoints[0].lat, wp.lng - waypoints[0].lng);
      if (dToFirst < 0.002) { // ~200m – loop esetén Start≈End
        wpGeomIndices.push(N - 1);
        continue;
      }
    }

    let minD = Infinity;
    let idx = searchFrom;
    for (let j = searchFrom; j < N; j++) {
      const d = Math.hypot(geometry[j].lat - wp.lat, geometry[j].lng - wp.lng);
      if (d < minD) { minD = d; idx = j; }
    }
    wpGeomIndices.push(idx);
    searchFrom = Math.min(idx + 1, N - 1);
  }

  // Az utolsó waypoint amelynek geom-indexe <= clickGeomIdx után szúrjuk be
  let insertAfter = 0;
  for (let i = 0; i < wpGeomIndices.length; i++) {
    if (wpGeomIndices[i] <= clickGeomIdx) insertAfter = i;
  }
  return insertAfter + 1;
}

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
  hasImportedFile = false;
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
  routeModeButtons:    document.querySelectorAll("[data-route-mode]"),
  routeModePicker:     document.querySelector("#routeModePicker"),
  routeModePopup:      document.querySelector("#routeModePopup"),
  mapRouteModePicker:  document.querySelector("#mapRouteModePicker"),
  mapRouteModePopup:   document.querySelector("#mapRouteModePopup"),
  toolButtons: document.querySelectorAll("[data-tool]"),
  waypointList: document.querySelector("#waypointList"),
  emptyState: document.querySelector("#emptyState"),
  distanceValue: document.querySelector("#distanceValue"),
  pointCount: document.querySelector("#pointCount"),
  ascentRow: document.querySelector("#ascentRow"),
  ascentValue: document.querySelector("#ascentValue"),
  descentRow: document.querySelector("#descentRow"),
  descentValue: document.querySelector("#descentValue"),
  estimatedTimeRow: document.querySelector("#estimatedTimeRow"),
  estimatedTimeValue: document.querySelector("#estimatedTimeValue"),
  searchForm: document.querySelector("#searchForm"),
  searchInput: document.querySelector("#searchInput"),
  searchResults: document.querySelector("#searchResults"),
  locateButton: document.querySelector("#locateButton"),
  clearRoute: document.querySelector("#clearRoute"),
  exportButton: document.querySelector("#exportButton"),
  importButton: document.querySelector("#importButton"),
  resetRouteButton: document.querySelector("#resetRouteButton"),
  reverseRouteButton:  document.querySelector("#reverseRouteButton"),
  returnRouteButton:   document.querySelector("#returnRouteButton"),
  roundTripButton:     document.querySelector("#roundTripButton"),
  undoButton: document.querySelector("#undoButton"),
  redoButton: document.querySelector("#redoButton"),
  gpxInput: document.querySelector("#gpxInput"),
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
  fileSaveToLibraryButton: document.querySelector("#fileSaveToLibraryButton"),
  elevationBtn: document.querySelector("#elevationBtn"),
  elevationPanel: document.querySelector("#elevationPanel"),
  chartElevation: document.querySelector("#chartElevation"),
  chartSpeed: document.querySelector("#chartSpeed"),
  chartHr: document.querySelector("#chartHr"),
  chartCad: document.querySelector("#chartCad"),
  elevationCanvas: document.querySelector("#elevationCanvas"),
  speedCanvas: document.querySelector("#speedCanvas"),
  hrCanvas: document.querySelector("#hrCanvas"),
  cadCanvas: document.querySelector("#cadCanvas"),
  closeChartElevation: document.querySelector("#closeChartElevation"),
  closeChartSpeed: document.querySelector("#closeChartSpeed"),
  closeChartHr: document.querySelector("#closeChartHr"),
  closeChartCad: document.querySelector("#closeChartCad"),
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
  cadChartBtn: document.querySelector("#cadChartBtn"),
};

const ROUTE_MODE_META = {
  asphalt: { label: "Aszfalt", lucide: "bike" },
  gravel:  { label: "Gravel",  lucide: null },
  mtb:     { label: "MTB",     lucide: "mountain" },
  walking: { label: "Túra",    lucide: "footprints" },
  cycling: { label: "Aszfalt", lucide: "bike" },
};
const GRAVEL_PICKER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M3 17 Q6 13 9 15 Q12 17 15 13 Q18 9 21 11"/><line x1="3" y1="20" x2="21" y2="20"/></svg>`;

const TOOLBAR_ITEMS_META = {
  search:      { label: 'Keresés',       group: 'nav',      icon: 'search' },
  routeMode:   { label: 'Tervezési mód', group: 'nav',      icon: null },
  mapStyle:    { label: 'Térképstílus',  group: 'nav',      icon: 'layers' },
  import:      { label: 'GPX import',    group: 'file',     icon: 'upload' },
  reverse:     { label: 'Megfordítás',   group: 'edit',     icon: 'arrow-left-right' },
  returnRoute: { label: 'Visszaút',      group: 'edit',     icon: 'corner-down-left' },
  roundTrip:   { label: 'Oda-vissza',    group: 'edit',     icon: 'repeat' },
  undo:        { label: 'Visszavonás',   group: 'edit',     icon: 'undo-2' },
  redo:        { label: 'Újra',          group: 'edit',     icon: 'redo-2' },
  reset:       { label: 'Törlés',        group: 'edit',     icon: 'trash-2' },
  elevation:   { label: 'Szintprofil',   group: 'analysis', icon: null },
  export:      { label: 'Mentés',        group: 'output',   icon: 'save' },
};

const DEFAULT_TOOLBAR_ORDER = [
  'routeMode', 'mapStyle', 'search', 'import',
  'reverse', 'returnRoute', 'roundTrip', 'undo', 'redo', 'reset',
  'elevation', 'export',
];

function getHiddenItems() {
  try {
    const s = localStorage.getItem('bringaterv-toolbar-hidden');
    if (s) return new Set(JSON.parse(s));
  } catch (_) {}
  return new Set();
}

function saveHiddenItems(set) {
  localStorage.setItem('bringaterv-toolbar-hidden', JSON.stringify([...set]));
}

function applyToolbarOrder(order) {
  const content = document.querySelector('#toolbarContent');
  if (!content) return;
  const hidden = getHiddenItems();

  // Remove existing injected dividers
  content.querySelectorAll('.toolbar-divider--auto').forEach(d => d.remove());

  // Apply flex order + visibility
  let prevGroup = null;
  let visIdx = 0;
  order.forEach((id) => {
    const el = content.querySelector(`[data-toolbar-item="${id}"]`);
    if (!el) return;
    const isHidden = hidden.has(id);
    el.style.display = isHidden ? 'none' : '';
    if (isHidden) return;
    el.style.order = visIdx * 2;
    const group = TOOLBAR_ITEMS_META[id]?.group;
    if (prevGroup && group !== prevGroup) {
      const div = document.createElement('div');
      div.className = 'toolbar-divider toolbar-divider--auto';
      div.style.order = visIdx * 2 - 1;
      content.appendChild(div);
    }
    prevGroup = group;
    visIdx++;
  });
}

function getToolbarOrder() {
  try {
    const saved = localStorage.getItem('bringaterv-toolbar-order');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (DEFAULT_TOOLBAR_ORDER.every(id => parsed.includes(id))) return parsed;
    }
  } catch (_) {}
  return [...DEFAULT_TOOLBAR_ORDER];
}

function saveAndApplyToolbarOrder(order) {
  localStorage.setItem('bringaterv-toolbar-order', JSON.stringify(order));
  applyToolbarOrder(order);
}

function renderToolbarOrderSettings() {
  const list = document.querySelector('#toolbarOrderList');
  if (!list) return;
  const order  = getToolbarOrder();
  const hidden = getHiddenItems();
  list.innerHTML = '';
  order.forEach(id => {
    const meta = TOOLBAR_ITEMS_META[id];
    if (!meta) return;
    const isHidden = hidden.has(id);
    const li = document.createElement('li');
    li.className = 'toolbar-order-item' + (isHidden ? ' is-hidden' : '');
    li.draggable = true;
    li.dataset.id = id;
    const iconHtml = meta.icon
      ? `<i data-lucide="${meta.icon}" aria-hidden="true"></i>`
      : (id === 'routeMode'
          ? GRAVEL_PICKER_SVG
          : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 17 8 12 13 15 18 7 21 10"/><line x1="3" y1="20" x2="21" y2="20"/></svg>');
    li.innerHTML = `
      <span class="toolbar-order-handle"><i data-lucide="grip-vertical" aria-hidden="true"></i></span>
      <span class="toolbar-order-icon">${iconHtml}</span>
      <span class="toolbar-order-label">${meta.label}</span>
      <span class="toolbar-order-group toolbar-order-group--${meta.group}"></span>
      <button class="toolbar-order-vis-btn" type="button" title="${isHidden ? 'Megjelenítés' : 'Elrejtés'}">
        <i data-lucide="${isHidden ? 'eye-off' : 'eye'}" aria-hidden="true"></i>
      </button>
    `;
    // szem gomb toggle
    li.querySelector('.toolbar-order-vis-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const h = getHiddenItems();
      h.has(id) ? h.delete(id) : h.add(id);
      saveHiddenItems(h);
      applyToolbarOrder(getToolbarOrder());
      renderToolbarOrderSettings();
    });
    list.append(li);
  });
  window.lucide?.createIcons({ nodes: [list] });
  initToolbarDragDrop(list);
}

function initToolbarDragDrop(list) {
  let dragSrc = null;

  list.addEventListener('dragstart', e => {
    dragSrc = e.target.closest('[draggable]');
    if (!dragSrc) return;
    dragSrc.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  list.addEventListener('dragend', () => {
    dragSrc?.classList.remove('is-dragging');
    list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    dragSrc = null;
    const order = [...list.querySelectorAll('[data-id]')].map(el => el.dataset.id);
    saveAndApplyToolbarOrder(order);
  });

  list.addEventListener('dragover', e => {
    e.preventDefault();
    if (!dragSrc) return;
    const target = e.target.closest('[draggable]');
    if (!target || target === dragSrc) return;
    const rect = target.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      list.insertBefore(dragSrc, target);
    } else {
      list.insertBefore(dragSrc, target.nextSibling);
    }
  });

  list.addEventListener('dragenter', e => e.preventDefault());
}

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
  // Mindig layers ikon – így nem ütközik a tervezési mód ikonjával
  pickerBtn.innerHTML = `<i data-lucide="layers" aria-hidden="true"></i>`;
  pickerBtn.title = `Térképstílus: ${STYLE_LABELS[style] ?? style}`;
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
  onRouteClick: async ({ lat, lng, geometryIndex }) => {
    const { waypoints } = store.getState();
    if (waypoints.length < 2) {
      addWaypointWithName({ lat, lng });
      return;
    }
    const insertIdx = findWaypointInsertIndex(waypoints, activeGeometry, geometryIndex);
    store.insertWaypointAt(insertIdx, { lat, lng });
    // Az új waypoint ID-ja az insertIdx pozícióban van
    const newId = store.getState().waypoints[insertIdx]?.id;
    if (newId) {
      const name = await reverseGeocode(lat, lng);
      if (name && store.getState().waypoints.some(wp => wp.id === newId)) {
        store.updateWaypoint(newId, { name });
      }
    }
    showToast("Köztes waypoint hozzáadva");
  },
  onReturnRoute: () => {
    // Visszaút: a startpontot hozzáadjuk x+1-ként – a meglévő út folytatásaként navigál haza
    const { waypoints } = store.getState();
    if (waypoints.length < 2) return;
    const first = waypoints[0];
    store.addWaypoint({ lat: first.lat, lng: first.lng, name: first.name });
    showToast("Hazaút hozzáadva");
  },
  onRoundTrip: () => {
    // Oda-vissza: az útvonal + visszaút egybe összefűzve (A→B→C→B→A)
    const state = store.getState();
    if (state.waypoints.length < 2) return;
    const there = state.waypoints;
    const back  = [...there].reverse().slice(1); // az első pont ne duplázódjon
    store.replaceWaypoints([...there, ...back], {
      importedRoute: false,
      routeGeometry: [],
      sourcePointCount: 0,
    });
    showToast("Oda-vissza útvonal létrehozva");
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
let activeSegmentPickerId = null; // melyik waypointhoz van nyitva a szegmens-picker
let dragSrcIndex = null;
let activeTool = "route";
let importedColoredGeometry = null; // ha van sebességszínezés
let importedHrGeometry = null;      // ha van pulzusszínezés
let importedCadGeometry = null;     // ha van kadenciaszínezés

store.setState({
  mode: (() => { const m = localStorage.getItem("route4meDefaultRouteMode") || "asphalt"; return m === "cycling" ? "asphalt" : m; })(),
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
// Verzió megjelenítése a sidebarban (src/version.js-ből)
const appVersionEl = document.querySelector("#appVersion");
if (appVersionEl) appVersionEl.textContent = APP_VERSION;
elements.unitInputs.forEach((input) => {
  input.checked = input.value === units;
});
// Export buttons start disabled (no waypoints yet)
elements.exportButton.disabled = true;
if (elements.fileExportButton) elements.fileExportButton.disabled = true;
if (elements.fileSaveToLibraryButton) elements.fileSaveToLibraryButton.disabled = true;

// Szintprofil – aktív geometry (tervezett vagy importált)
let activeGeometry = [];
let autoOpenElevation = false; // könyvtárból tervezésbe töltéskor automatikusan nyitja a szintprofilt

// ── Chart példányok (mindhárom független, egymás alatt jelenhetnek meg) ───────

// Megosztott szinkron objektum: az összes chart instance ide kerül feltöltés után,
// hogy hover eseménykor egymást szinkronizálhassák.
const chartSync = { all: [] };

function makeHoverHandler(unit) {
  return {
    onHover(pt) {
      if (!pt || pt.value == null) return;
      mapAdapter.setElevationMarker(pt.lat, pt.lng);
      if (elements.elevationTooltip) elements.elevationTooltip.hidden = false;
      if (elements.elevationTooltipDist) {
        elements.elevationTooltipDist.innerHTML = `<b>${(pt.dist / 1000).toFixed(2)} km</b>`;
      }
      if (elements.elevationTooltipEle) {
        const icons = { m: "⛰", "km/h": "🚴", bpm: "❤️" };
        const icon = icons[unit] ?? "";
        elements.elevationTooltipEle.innerHTML = `${icon} <b>${Math.round(pt.value)} ${unit}</b>`;
      }
      if (elements.elevationTooltipGrade) elements.elevationTooltipGrade.innerHTML = "";
      // Szinkronizálás: az összes többi chart ugyanarra a távolságra ugrik
      chartSync.all.forEach(c => c?.setHoverByDist(pt.dist));
    },
    onLeave() {
      mapAdapter.clearElevationMarker();
      if (elements.elevationTooltip) elements.elevationTooltip.hidden = true;
      // Minden chart hover törlése
      chartSync.all.forEach(c => c?.clearHover());
    },
  };
}

const elevationChart = initElevationChart(elements.elevationCanvas, makeHoverHandler("m"));
const speedChart     = elements.speedCanvas
  ? initElevationChart(elements.speedCanvas, makeHoverHandler("km/h"))
  : null;
const hrChart        = elements.hrCanvas
  ? initElevationChart(elements.hrCanvas, makeHoverHandler("bpm"))
  : null;
const cadChart       = elements.cadCanvas
  ? initElevationChart(elements.cadCanvas, makeHoverHandler("rpm"))
  : null;

// Az összes chart feltöltve — szinkronizálás mostantól működik
chartSync.all = [elevationChart, speedChart, hrChart, cadChart].filter(Boolean);

// Melyik chart szekciók látszanak (elevation / speed / hr) — itt deklarálva, hogy
// updateElevationButton() és a chart control függvények egyaránt hozzáférjenek
const visibleSections = new Set();

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
  } else {
    // Ha a grade réteg aktív (pl. útvonal megfordítása után), frissítsd az új geometriával
    const gradeActive = elements.gradeMapTogglePlan?.checked || elements.gradeMapToggle?.checked;
    if (gradeActive) mapAdapter.renderGradeRoute(activeGeometry);
  }
  // Ha bármelyik szekció nyitva van, frissítsd az adatot
  if (visibleSections.has("elevation")) {
    const data = buildElevationData(activeGeometry);
    elevationChart.setData(data, { color: "#fc4c02", unit: "m" });
    updateElevationPanelInfo(data);
  }
  if (visibleSections.has("speed") && speedChart) {
    speedChart.setData(buildSpeedData(activeGeometry), { color: "#3B82F6", unit: "km/h" });
  }
  if (visibleSections.has("hr") && hrChart) {
    hrChart.setData(buildHrData(activeGeometry), { color: "#EF4444", unit: "bpm" });
  }
  if (visibleSections.has("cad") && cadChart) {
    cadChart.setData(buildCadData(activeGeometry), { color: "#A855F7", unit: "rpm" });
  }
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
      if (activeGeometry.length > 1) mapAdapter.renderRoute(activeGeometry, store.getState().mode);
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

// ── Multi-chart: minden szekció önállóan nyitható/zárható ─────────────────────

// Segéd: visszaadja az adott típushoz tartozó elemeket és builder-t
function chartConfig(type) {
  if (type === "speed") {
    return {
      sectionEl: elements.chartSpeed,
      chartInst: speedChart,
      build: () => buildSpeedData(activeGeometry),
      opts: { color: "#3B82F6", unit: "km/h" },
      btns: [elements.speedChartBtn],
    };
  }
  if (type === "hr") {
    return {
      sectionEl: elements.chartHr,
      chartInst: hrChart,
      build: () => buildHrData(activeGeometry),
      opts: { color: "#EF4444", unit: "bpm" },
      btns: [elements.hrChartBtn],
    };
  }
  if (type === "cad") {
    return {
      sectionEl: elements.chartCad,
      chartInst: cadChart,
      build: () => buildCadData(activeGeometry),
      opts: { color: "#A855F7", unit: "rpm" },
      btns: [elements.cadChartBtn],
    };
  }
  // "elevation" (alapértelmezett)
  return {
    sectionEl: elements.chartElevation,
    chartInst: elevationChart,
    build: () => buildElevationData(activeGeometry),
    opts: { color: "#fc4c02", unit: "m" },
    btns: [elements.gradeLegendChartBtn, elements.gradeLegendChartBtnPlan],
  };
}

function syncElevationBtnState() {
  const anyOpen = visibleSections.size > 0;
  if (elements.elevationBtn) elements.elevationBtn.classList.toggle("is-active", anyOpen);

  ["elevation", "speed", "hr", "cad"].forEach((type) => {
    const { btns } = chartConfig(type);
    const active = visibleSections.has(type);
    btns.forEach((btn) => { if (btn) btn.classList.toggle("is-active", active); });
  });
}

// Adott szekció megjelenítése (a többit NEM zárja be)
function showChartSection(type) {
  if (!elements.elevationPanel) return;
  const cfg = chartConfig(type);
  if (!cfg.sectionEl || !cfg.chartInst) return;

  const data = cfg.build();
  if (!data.length) return; // nincs adat ehhez a típushoz

  // Először mutassuk meg a DOM elemeket, hogy a canvas mérete kiszámítható legyen
  elements.elevationPanel.hidden = false;
  cfg.sectionEl.hidden = false;
  visibleSections.add(type);

  // Ezután rajzoljuk a chartot (resize() a látható canvas méretét veszi)
  cfg.chartInst.setData(data, cfg.opts);

  // Szintprofil info sávot csak elevation típusnál frissítjük
  if (type === "elevation") updateElevationPanelInfo(data);

  syncElevationBtnState();
}

// Adott szekció elrejtése
function hideChartSection(type) {
  const cfg = chartConfig(type);
  if (cfg.sectionEl) cfg.sectionEl.hidden = true;
  visibleSections.delete(type);

  // Ha egyik sem látszik, zárjuk be a panelt is
  if (visibleSections.size === 0) {
    if (elements.elevationPanel) elements.elevationPanel.hidden = true;
    mapAdapter.clearElevationMarker();
    if (elements.elevationTooltip) elements.elevationTooltip.hidden = true;
  }
  syncElevationBtnState();
}

// Gombokhoz: toggle az adott szekció
function handleChartBtn(type) {
  if (visibleSections.has(type)) {
    hideChartSection(type);
  } else {
    showChartSection(type);
  }
}

[elements.gradeLegendChartBtn, elements.gradeLegendChartBtnPlan].forEach((btn) => {
  btn?.addEventListener("click", () => handleChartBtn("elevation"));
});
elements.speedChartBtn?.addEventListener("click", () => handleChartBtn("speed"));
elements.hrChartBtn?.addEventListener("click",    () => handleChartBtn("hr"));
elements.cadChartBtn?.addEventListener("click",   () => handleChartBtn("cad"));

// X gombok az egyes szekciókhoz
elements.closeChartElevation?.addEventListener("click", () => hideChartSection("elevation"));
elements.closeChartSpeed?.addEventListener("click",     () => hideChartSection("speed"));
elements.closeChartHr?.addEventListener("click",        () => hideChartSection("hr"));
elements.closeChartCad?.addEventListener("click",       () => hideChartSection("cad"));

function updateElevationPanelInfo(data) {
  if (!elements.elevationInfo || !data.length) return;
  const eles = data.map((p) => p.ele).filter((e) => e != null);
  if (!eles.length) return;
  const minEle = Math.min(...eles);
  const maxEle = Math.max(...eles);
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

// Kompatibilitás: openElevationPanel() az elevation szekcióra nyit
function openElevationPanel() {
  showChartSection("elevation");
}

// Minden szekció bezárása (pl. új fájl betöltésekor)
function closeElevationPanel() {
  ["elevation", "speed", "hr", "cad"].forEach((type) => {
    const cfg = chartConfig(type);
    if (cfg.sectionEl) cfg.sectionEl.hidden = true;
  });
  visibleSections.clear();
  if (elements.elevationPanel) elements.elevationPanel.hidden = true;
  mapAdapter.clearElevationMarker();
  if (elements.elevationTooltip) elements.elevationTooltip.hidden = true;
  syncElevationBtnState();
}

// Toolbar elevationBtn: ha semmi nincs nyitva → elevation szekció; ha bármi nyitva → mindent zár
function toggleElevationPanel() {
  if (visibleSections.size === 0) {
    openElevationPanel();
  } else {
    closeElevationPanel();
  }
}

elements.elevationBtn?.addEventListener("click", toggleElevationPanel);
elements.elevationClose?.addEventListener("click", closeElevationPanel);

// Resize observer – mindhárom canvas frissítése
const elevationResizeObserver = new ResizeObserver(() => {
  elevationChart.resize();
  speedChart?.resize();
  hrChart?.resize();
  cadChart?.resize();
});
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
applyToolbarOrder(getToolbarOrder());
renderToolbarOrderSettings();

document.querySelector('#toolbarOrderReset')?.addEventListener('click', () => {
  localStorage.removeItem('bringaterv-toolbar-order');
  localStorage.removeItem('bringaterv-toolbar-hidden');
  applyToolbarOrder(getToolbarOrder());
  renderToolbarOrderSettings();
});
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
  const hasPoints  = state.waypoints.length > 0;
  const hasRoute   = state.waypoints.length >= 2;
  elements.exportButton.disabled = !hasPoints;
  if (elements.returnRouteButton) elements.returnRouteButton.disabled = !hasRoute;
  if (elements.roundTripButton)   elements.roundTripButton.disabled   = !hasRoute;
  if (elements.fileExportButton) elements.fileExportButton.disabled = !hasPoints;
  if (elements.fileSaveToLibraryButton) elements.fileSaveToLibraryButton.disabled = !hasPoints;
  if (elements.sidebarExportButton) elements.sidebarExportButton.hidden = !hasPoints;
  mapAdapter.renderWaypoints(state.waypoints, state.mode);
  if (state.importedRoute) {
    // Az aktív toggle határozza meg a megjelenítést
    // routeRequestId növelése hogy az esetleg folyamatban lévő korábbi routing kérés ne írja felül
    routeRequestId++;
    return;
  }
  const routeSignature = JSON.stringify({
    mode: state.mode,
    snapToRoads: state.snapToRoads,
    waypoints: state.waypoints.map(({ lat, lng, segmentMode }) => [lat, lng, segmentMode ?? null]),
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
  if (route.segments) {
    mapAdapter.renderSegmentedRoute(route.segments);
  } else {
    mapAdapter.renderRoute(route.geometry, state.mode);
  }
  updateElevationButton(route.geometry);
  if (autoOpenElevation) {
    autoOpenElevation = false;
    openElevationPanel(); // csak akkor nyit, ha buildElevationData() nem üres
  }
});

elements.routeModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setRouteMode(button.dataset.routeMode, { persistDefault: true });
    // mindkét popup bezárása
    if (elements.routeModePopup) elements.routeModePopup.hidden = true;
    elements.routeModePicker?.classList.remove("is-open");
    if (elements.mapRouteModePopup) elements.mapRouteModePopup.hidden = true;
    elements.mapRouteModePicker?.classList.remove("is-open");
  });
});

// Tervezési mód picker popup toggle
elements.routeModePicker?.addEventListener("click", (e) => {
  e.stopPropagation();
  const popup = elements.routeModePopup;
  if (!popup) return;
  const isOpen = !popup.hidden;
  if (!isOpen) {
    // fixed pozíció számítása – sidebar overflow-y:auto levágná az absolute-ot
    const rect = elements.routeModePicker.getBoundingClientRect();
    popup.style.top  = `${rect.bottom + 6}px`;
    popup.style.right = `${window.innerWidth - rect.right}px`;
    popup.style.left  = "auto";
  }
  popup.hidden = isOpen;
  elements.routeModePicker.classList.toggle("is-open", !isOpen);
});

document.addEventListener("click", (e) => {
  if (!elements.routeModePopup || elements.routeModePopup.hidden) return;
  if (!elements.routeModePicker?.contains(e.target) && !elements.routeModePopup.contains(e.target)) {
    elements.routeModePopup.hidden = true;
    elements.routeModePicker?.classList.remove("is-open");
  }
});

// Map toolbar mód picker
elements.mapRouteModePicker?.addEventListener("click", (e) => {
  e.stopPropagation();
  const popup = elements.mapRouteModePopup;
  if (!popup) return;
  const isOpen = !popup.hidden;
  popup.hidden = isOpen;
  elements.mapRouteModePicker.classList.toggle("is-open", !isOpen);
  if (!isOpen) window.lucide?.createIcons();
});
elements.mapRouteModePopup?.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => {
  if (elements.mapRouteModePopup && !elements.mapRouteModePopup.hidden) {
    elements.mapRouteModePopup.hidden = true;
    elements.mapRouteModePicker?.classList.remove("is-open");
  }
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

// ── Toolbar kereső popup ──────────────────────────────────────────────────────
(function initToolbarSearch() {
  const btn     = document.querySelector("#toolbarSearchBtn");
  const popup   = document.querySelector("#toolbarSearchPopup");
  const input   = document.querySelector("#toolbarSearchInput");
  const results = document.querySelector("#toolbarSearchResults");
  if (!btn || !popup || !input || !results) return;

  let searchTimer;

  function openPopup() {
    const rect = btn.getBoundingClientRect();
    const popupW = 300;
    // vízszintes pozíció: középre igazítva a gombhoz, viewport határain belül
    let left = rect.left + rect.width / 2 - popupW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - popupW - 8));
    // függőleges: alapból felülre, ha nincs elég hely akkor alulra
    const popupH = 80; // becsült min magasság
    const top = rect.top > popupH + 16 ? null : rect.bottom + 8;
    const bottom = rect.top > popupH + 16 ? window.innerHeight - rect.top + 8 : null;
    popup.style.left   = left + "px";
    popup.style.right  = "auto";
    if (bottom !== null) { popup.style.bottom = bottom + "px"; popup.style.top = "auto"; }
    else                 { popup.style.top = top + "px";    popup.style.bottom = "auto"; }
    popup.hidden = false;
    window.lucide?.createIcons({ nodes: [popup] });
    setTimeout(() => input.focus(), 30);
  }

  function closePopup() {
    popup.hidden = true;
    results.innerHTML = "";
    input.value = "";
    clearTimeout(searchTimer);
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    popup.hidden ? openPopup() : closePopup();
  });

  popup.addEventListener("click", (e) => e.stopPropagation());

  document.addEventListener("click", () => { if (!popup.hidden) closePopup(); });

  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) { results.innerHTML = ""; return; }
    searchTimer = setTimeout(async () => {
      results.innerHTML = "";
      try {
        const places = await searchPlaces(q, i18n.language);
        if (!places.length) { results.textContent = i18n.t("search.noResults"); return; }
        places.forEach((place) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "result-button";
          b.textContent = place.name;
          b.addEventListener("click", () => {
            store.addWaypoint(place);
            closePopup();
          });
          results.append(b);
        });
      } catch { showToast(i18n.t("search.failed")); }
    }, 300);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePopup();
    if (e.key === "Enter") { clearTimeout(searchTimer); input.dispatchEvent(new Event("input")); }
  });
})();

// ── Toolbar: drag + collapse (grip gomb) ─────────────────────────────────────
(function initToolbar() {
  const toolbar    = document.querySelector("#mapToolbar");
  const dragHandle = document.querySelector("#toolbarDragHandle");
  if (!toolbar || !dragHandle) return;

  // Összecsukás állapot visszaállítása
  if (localStorage.getItem("bringaterv-toolbar-collapsed") === "1")
    toolbar.classList.add("is-collapsed");

  // --- Drag + click szétválasztás ---
  const DRAG_THRESHOLD = 5; // px – ennél kisebb mozgás = kattintás
  let pointerStartX, pointerStartY, startLeft, startTop;
  let didDrag = false;

  function getMapWrap() { return document.querySelector(".map-wrap"); }

  function applyPos(x, y) {
    const mw = getMapWrap(); if (!mw) return;
    const mwR = mw.getBoundingClientRect();
    toolbar.style.left = Math.max(0, Math.min(x, mwR.width  - toolbar.offsetWidth))  + "px";
    toolbar.style.top  = Math.max(0, Math.min(y, mwR.height - toolbar.offsetHeight)) + "px";
    toolbar.dataset.dragged = "1";
  }

  function onPointerDown(clientX, clientY) {
    const mw = getMapWrap(); if (!mw) return;
    const mwR = mw.getBoundingClientRect();
    const tR  = toolbar.getBoundingClientRect();
    pointerStartX = clientX;
    pointerStartY = clientY;
    startLeft = tR.left - mwR.left;
    startTop  = tR.top  - mwR.top;
    didDrag   = false;
    // CSS centering → JS positioning átváltás előkészítése
    toolbar.style.transform = "none";
    toolbar.style.bottom    = "auto";
    toolbar.dataset.dragged = "1";
  }

  function onPointerMove(clientX, clientY) {
    const dx = clientX - pointerStartX;
    const dy = clientY - pointerStartY;
    if (!didDrag && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    didDrag = true;
    dragHandle.style.cursor = "grabbing";
    applyPos(startLeft + dx, startTop + dy);
  }

  function onPointerUp() {
    dragHandle.style.cursor = "";
    if (!didDrag) {
      // kattintás → összecsukás toggle
      const collapsed = toolbar.classList.toggle("is-collapsed");
      localStorage.setItem("bringaterv-toolbar-collapsed", collapsed ? "1" : "0");
    }
    // drag vége → pozíciót NEM mentjük, mindig CSS alapértelmezés (center-bottom)
    didDrag = false;
  }

  // Mouse events
  dragHandle.addEventListener("mousedown", (e) => { e.preventDefault(); onPointerDown(e.clientX, e.clientY); });
  document.addEventListener("mousemove",  (e) => { if (pointerStartX !== undefined) onPointerMove(e.clientX, e.clientY); });
  document.addEventListener("mouseup",    () => { if (pointerStartX !== undefined) { onPointerUp(); pointerStartX = undefined; } });

  // Touch events
  dragHandle.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; onPointerDown(t.clientX, t.clientY);
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (pointerStartX === undefined) return;
    if (didDrag) e.preventDefault();
    const t = e.touches[0]; onPointerMove(t.clientX, t.clientY);
  }, { passive: false });
  document.addEventListener("touchend", () => {
    if (pointerStartX !== undefined) { onPointerUp(); pointerStartX = undefined; }
  });

  // Pozíció NEM mentődik/töltődik vissza – mindig CSS alapértelmezés (center-bottom)
  localStorage.removeItem("bringaterv-toolbar-pos");
})();

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
  importedGpxText = null;
  mapAdapter.clearColoredRoute();
  mapAdapter.clearHrRoute();
  mapAdapter.clearCadRoute();
  mapAdapter.clearGradeRoute();
  mapAdapter.renderRoute([]);
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

elements.returnRouteButton?.addEventListener("click", () => {
  const { waypoints } = store.getState();
  if (waypoints.length < 2) return;
  const first = waypoints[0];
  store.addWaypoint({ lat: first.lat, lng: first.lng, name: first.name });
  showToast("Hazaút hozzáadva");
});

elements.roundTripButton?.addEventListener("click", () => {
  const state = store.getState();
  if (state.waypoints.length < 2) return;
  const there = state.waypoints;
  const back  = [...there].reverse().slice(1);
  store.replaceWaypoints([...there, ...back], {
    importedRoute: false,
    routeGeometry: [],
    sourcePointCount: 0,
  });
  showToast("Oda-vissza útvonal létrehozva");
});

// Helykeresés – live (gépelés közben, 300 ms debounce)
let _searchTimer;
async function runSearch(query) {
  elements.searchResults.innerHTML = "";
  if (!query) return;
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
}

elements.searchInput?.addEventListener("input", () => {
  clearTimeout(_searchTimer);
  const q = elements.searchInput.value.trim();
  if (!q) { elements.searchResults.innerHTML = ""; return; }
  _searchTimer = setTimeout(() => runSearch(q), 300);
});

// Enter – azonnal keres (debounce nélkül)
elements.searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(_searchTimer);
  runSearch(elements.searchInput.value.trim());
});

// Escape – eredmények törlése
elements.searchInput?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { elements.searchResults.innerHTML = ""; elements.searchInput.value = ""; }
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

/**
 * Fájlnév prompt modal – megkérdezi a letöltési fájlnevet a könyvtárból való GPX letöltés előtt.
 * @param {string} suggested – előre kitöltött fájlnév (kiterjesztés nélkül)
 * @returns {Promise<string|null>} fájlnév kiterjesztés nélkül, vagy null ha a felhasználó megszakította
 */
function promptFilename(suggested) {
  return new Promise((resolve) => {
    const overlay = document.querySelector("#filenamePromptOverlay");
    const input   = document.querySelector("#filenamePromptInput");
    const btnOk   = document.querySelector("#filenamePromptConfirm");
    const btnCancel = document.querySelector("#filenamePromptCancel");
    const btnClose  = document.querySelector("#filenamePromptClose");

    input.value = suggested;
    overlay.hidden = false;
    window.lucide?.createIcons();
    setTimeout(() => { input.select(); input.focus(); }, 50);

    function finish(value) {
      overlay.hidden = true;
      cleanup();
      resolve(value);
    }

    function onConfirm() {
      const name = input.value.trim();
      finish(name || suggested);
    }
    function onCancel() { finish(null); }
    function onKey(e) {
      if (e.key === "Enter")  { e.preventDefault(); onConfirm(); }
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    }
    function onOverlayClick(e) { if (e.target === overlay) onCancel(); }

    function cleanup() {
      btnOk.removeEventListener("click", onConfirm);
      btnCancel.removeEventListener("click", onCancel);
      btnClose.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlayClick);
      document.removeEventListener("keydown", onKey);
    }

    btnOk.addEventListener("click", onConfirm);
    btnCancel.addEventListener("click", onCancel);
    btnClose.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlayClick);
    document.addEventListener("keydown", onKey);
  });
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
  // Set mode radio to current route mode (cycling → asphalt for backwards compat)
  const exportModeVal = state.mode === "cycling" ? "asphalt" : state.mode;
  const modeRadio = elements.exportOverlay.querySelector(`input[name="exportMode"][value="${exportModeVal}"]`);
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

// ── Export modal közös segédfüggvény ─────────────────────────────────────────

/**
 * Naismith-szabály kiterjesztése süllyedővel.
 * Lapos idő + emelkedő idő − süllyedő megtakarítás.
 *
 * @param {number} distanceKm
 * @param {number} ascentM
 * @param {number} descentM
 * @param {string} mode  asphalt | gravel | mtb | hiking | cycling | walking
 * @returns {number} percek (egész szám)
 */
function calcEstimatedTime(distanceKm, ascentM = 0, descentM = 0, mode = 'asphalt') {
  const speeds = getSpeedSettings();
  const baseSpeed = speeds[mode] ?? speeds.asphalt ?? 22;

  // vam: m/h mászási sebesség; descentRate: m/h süllyedő megtakarítás
  const VAM = { asphalt: 700, gravel: 500, mtb: 400, hiking: 300, cycling: 700, walking: 300 };
  const DESCENT = { asphalt: 1200, gravel: 700, mtb: 350, hiking: 500, cycling: 1200, walking: 500 };

  const vam         = VAM[mode]     ?? 600;
  const descentRate = DESCENT[mode] ?? 800;

  const flatMin    = (distanceKm / baseSpeed) * 60;
  const climbMin   = (ascentM    / vam)         * 60;
  const descentMin = (descentM   / descentRate)  * 60;

  return Math.round(Math.max(flatMin * 0.3, flatMin + climbMin - descentMin));
}

/** Az export modal aktuális értékeiből GPX tartalmat és metaadatot állít elő. */
function buildExportPayload() {
  const state = store.getState();
  const name  = elements.exportName.value.trim() || "Bringaterv útvonal";
  const desc  = elements.exportDesc.value.trim();
  const filename = (elements.exportFilename.value.trim() || slugify(name)) + ".gpx";
  const selectedMode = elements.exportOverlay
    .querySelector("input[name=\"exportMode\"]:checked")?.value ?? state.mode;

  const content = exportGpx({
    waypoints: state.waypoints,
    geometry:  state.routeGeometry,
    name, desc, mode: selectedMode,
  });

  // Távolság (km) – közvetlenül a store-ból (BRouter / import egyaránt beállítja)
  const distanceKm = state.distanceMeters > 0
    ? Math.round(state.distanceMeters / 100) / 10  // méter → km, 1 tizedesjegy
    : null;

  // Szintkülönbség – store-ból (BRouter / import egyaránt beállítja)
  const ascentMeters  = state.ascentMeters  > 0 ? state.ascentMeters  : 0;
  const descentMeters = state.descentMeters > 0 ? state.descentMeters : 0;

  // Becsült időtartam – Naismith-formula: lapos idő + emelkedő − süllyedő megtakarítás
  const durationMin = distanceKm != null
    ? calcEstimatedTime(distanceKm, ascentMeters, descentMeters, selectedMode)
    : null;

  return { name, desc, filename, content, selectedMode, distanceKm, ascentMeters, durationMin };
}

// ── GPX letöltés gomb ─────────────────────────────────────────────────────────
elements.exportConfirm?.addEventListener("click", () => {
  const { filename, content } = buildExportPayload();
  downloadGpx(filename, content);
  elements.exportOverlay.hidden = true;
});

// ── Mentés a könyvtárba gomb ──────────────────────────────────────────────────
document.querySelector("#exportSaveToLibrary")?.addEventListener("click", async () => {
  const { name, desc, content, selectedMode, distanceKm, ascentMeters, durationMin } = buildExportPayload();
  elements.exportOverlay.hidden = true;

  try {
    await routesApi.saveRoute({
      name,
      gpxContent: content,
      distance:  distanceKm,
      duration:  durationMin,
      elevation: ascentMeters || null,
      type:      selectedMode === "walking" ? "hiking" : selectedMode,
      description: desc,
    });
    showToast(`„${name}" elmentve a könyvtárba`);
  } catch (err) {
    console.error("Könyvtár mentési hiba:", err);
    showToast("Nem sikerült menteni a könyvtárba. Az API elérhető?");
  }
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

elements.importButton.addEventListener("click", () => {
  // A térképes import gomb: Tervezés fülön waypontokat tölt be, Elemzés fülön teljes analízist
  if (currentTab === "plan") {
    planGpxInput?.click();
  } else {
    elements.gpxInput.click();
  }
});
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
  mapAdapter.renderRoute(imported.geometry, store.getState().mode);

  hasImportedFile = true;
  importedFileName = file.name.replace(/\.gpx$/i, ""); // fájlnév kiterjesztés nélkül
  importedGpxText  = await file.text();                // eredeti GPX megőrzése mentéshez
  populateFileTab({ filename: file.name, geometry: imported.geometry, distanceMeters, ascentMeters, descentMeters, speedColored: hasSpeed, meta: imported.meta ?? {} });
  switchTab("file");

  if (imported.sourcePointCount > imported.geometry.length) {
    showToast(`GPX betöltve – ${imported.sourcePointCount} pont → ${imported.geometry.length} jelenik meg`, 5000);
  } else {
    showToast(i18n.t("route.imported", { points: imported.sourcePointCount }));
  }
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

// ── Edzés mentése könyvtárba (Elemzés fül) ────────────────────────────────────
elements.fileSaveToLibraryButton?.addEventListener("click", async () => {
  const state = store.getState();
  const name = importedFileName || "Edzés";

  // Eredeti GPX tartalom használata ha elérhető (megőrzi a sebesség/pulzus/idő adatokat),
  // különben fallback: újragenerálás geometriából (adatvesztéssel jár)
  const content = importedGpxText ?? exportGpx({
    waypoints: state.waypoints,
    geometry:  state.routeGeometry,
    name,
    desc: "",
    mode: state.mode,
  });

  const distanceKm = state.distanceMeters > 0
    ? Math.round(state.distanceMeters / 100) / 10
    : null;
  const ascentMeters = state.ascentMeters > 0 ? state.ascentMeters : null;
  // Becsült időtartam: kerékpár 20 km/h
  const durationMin = distanceKm != null
    ? Math.round((distanceKm / 20) * 60)
    : null;

  try {
    await routesApi.saveRoute({
      name,
      gpxContent: content,
      distance:   distanceKm,
      duration:   durationMin,
      elevation:  ascentMeters,
      type:       "workout",
      description: "",
    });
    showToast(`„${name}" mentve az Edzések közé`);
  } catch (err) {
    console.error("Edzés mentési hiba:", err);
    showToast("Nem sikerült menteni. Az API elérhető?");
  }
});

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
  // Maradunk az Elemzés nézetben, nem váltunk Tervezésre
});

// ── Plan tab: GPX importálása (csak waypontok, nincs Elemzés váltás) ──────────
const planGpxInput = document.querySelector("#planGpxInput");

document.querySelector("#planImportBtn")?.addEventListener("click", () => planGpxInput?.click());

planGpxInput?.addEventListener("change", async () => {
  const [file] = planGpxInput.files;
  if (!file) return;
  let imported;
  try {
    imported = await importGpx(file, { sampleWaypoints: false });
  } catch (err) {
    showToast("Nem sikerült betölteni a fájlt. Ellenőrizd, hogy érvényes GPX fájl-e.");
    planGpxInput.value = "";
    console.error("Plan GPX import error:", err);
    return;
  }

  // Waypontok betöltése – importedRoute:true hogy ne induljon el auto-routing
  // (fontos körbeutak esetén ahol start≈end, BRouter sikertelen lenne)
  store.replaceWaypoints(imported.waypoints, { importedRoute: true });
  // Az útvonal geometriáját mutatjuk előnézetként (tervezés közben eltűnik)
  updateElevationButton(imported.geometry);
  mapAdapter.renderRoute(imported.geometry, store.getState().mode);
  setTimeout(() => mapAdapter.fitRoute(), 50);
  showToast(`${imported.waypoints.length} pont betöltve – kattints a térképre a tervezéshez`);
  planGpxInput.value = "";
});

// ── Elemzés → Tervezés ez alapján ────────────────────────────────────────────
document.querySelector("#planFromFileBtn")?.addEventListener("click", () => {
  // A waypontok már a store-ban vannak (az import feltöltötte)
  // Csak az elemzés-specifikus állapotot töröljük, majd váltunk
  importedColoredGeometry = null;
  importedHrGeometry = null;
  importedCadGeometry = null;
  mapAdapter.clearColoredRoute();
  mapAdapter.clearHrRoute();
  mapAdapter.clearCadRoute();
  mapAdapter.clearGradeRoute();
  hasImportedFile = false;
  clearFileTab();
  applyRouteLayer(null);
  switchTab("plan");
  showToast("Útvonalpontok betöltve – folytathatod a tervezést");
});

// ── Útvonalkönyvtár (Library tab) ────────────────────────────────────────────

/**
 * Útvonal betöltése könyvtárból.
 * - target="plan"    → Tervezés fül (útvonalak, minták)
 * - target="file"    → Elemzés fül  (edzések – teljes analízis, sebesség, pulzus stb.)
 *
 * @param {string}  id        – útvonal azonosítója
 * @param {boolean} isSample  – true ha minta
 * @param {string}  routeName – megjelenítési név
 * @param {"plan"|"file"} [target="plan"]
 */
async function loadRouteFromLibrary(id, isSample, routeName, target = "plan") {
  let gpxText;
  try {
    gpxText = isSample
      ? await routesApi.loadSample(id)
      : await routesApi.loadRoute(id);
  } catch (err) {
    console.error("Könyvtár betöltési hiba:", err);
    showToast("Nem sikerült betölteni az útvonalat.");
    return;
  }

  let imported;
  try {
    const blob = new Blob([gpxText], { type: "application/gpx+xml" });
    imported = await importGpx(blob, { sampleWaypoints: false });
  } catch (err) {
    console.error("GPX parse hiba:", err);
    showToast("Érvénytelen GPX fájl a könyvtárban.");
    return;
  }

  clearAllRouteState();

  if (target === "file") {
    // ── Elemzés fülre töltés (azonos logika mint a kézi GPX feltöltésnél) ──
    store.replaceWaypoints(imported.waypoints, {
      geometry: imported.geometry,
      importedRoute: true,
      sourcePointCount: imported.sourcePointCount,
    });
    const { ascentMeters, descentMeters } = calcElevationFromGeometry(imported.geometry);
    const distanceMeters = calculateImportedDistance(imported.geometry);
    store.setState({ distanceMeters, ascentMeters, descentMeters });

    const hasSpeed = imported.geometry.some(p => p.speed != null);
    const hasHr    = imported.geometry.some(p => p.hr    != null);
    const hasCad   = imported.geometry.some(p => p.cad   != null);

    importedColoredGeometry = hasSpeed ? imported.geometry : null;
    importedHrGeometry      = hasHr   ? imported.geometry : null;
    importedCadGeometry     = hasCad  ? imported.geometry : null;

    updateElevationButton(imported.geometry);
    applyRouteLayer(null);
    mapAdapter.renderRoute(imported.geometry, store.getState().mode);

    hasImportedFile = true;
    importedFileName = routeName;
    importedGpxText  = gpxText; // eredeti GPX megőrzése (esetleges újramentéshez)
    populateFileTab({
      filename: `${routeName}.gpx`,
      geometry: imported.geometry,
      distanceMeters, ascentMeters, descentMeters,
      speedColored: hasSpeed,
      meta: imported.meta ?? {},
    });
    switchTab("file");
    setTimeout(() => mapAdapter.fitRoute(), 50);
    if (imported.sourcePointCount > imported.geometry.length) {
      showToast(`„${routeName}" betöltve – ${imported.sourcePointCount} pont → ${imported.geometry.length} jelenik meg`, 5000);
    } else {
      showToast(`„${routeName}" betöltve az Elemzés fülre`);
    }

  } else {
    // ── Tervezés fülre töltés ─────────────────────────────────────────────
    // importedRoute: false → BRouter re-route-olja a waypontokat → SRTM szintadat
    switchTab("plan");
    autoOpenElevation = true; // BRouter visszatérése után automatikusan megnyitja a szintprofilt
    store.replaceWaypoints(imported.waypoints, {
      geometry: imported.geometry,
      sourcePointCount: imported.sourcePointCount,
    });
    mapAdapter.renderRoute(imported.geometry, store.getState().mode); // azonnali megjelenítés, BRouter felváltja majd
    setTimeout(() => mapAdapter.fitRoute(), 50);
    if (imported.sourcePointCount > imported.geometry.length) {
      showToast(`„${routeName}" betöltve – ${imported.sourcePointCount} pont → ${imported.geometry.length} jelenik meg`, 5000);
    } else {
      showToast(`„${routeName}" betöltve – kattints a térképre a tervezéshez`);
    }
  }
}

/**
 * Perceket olvasható formátumra alakít a könyvtár kártyákhoz.
 * @param {number|null} minutes
 * @returns {string}  pl. "3 ó 20 p" vagy ""
 */
function formatRouteDuration(minutes) {
  if (minutes == null) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} p`;
  if (m === 0) return `${h} ó`;
  return `${h} ó ${m} p`;
}

/**
 * Könyvtár lista egy elemének HTML-je.
 * Visszaad egy <li> elemet a betöltés és (saját útvonalon) törlés gombokkal.
 *
 * @param {{ id: string, name: string, date?: string, distance?: number|null,
 *           duration?: number|null, elevation?: number|null,
 *           type?: string, description?: string }} route
 * @param {boolean} isSample
 * @returns {HTMLLIElement}
 */
function createLibraryItem(route, isSample) {
  const li = document.createElement("li");
  li.className = "library-item";
  li.dataset.id = route.id;

  // Típus ikon és felirat
  const isWorkout = route.type === "workout";
  const TYPE_ICONS   = { hiking: "footprints", mtb: "mountain", workout: "chart-line" };
  const TYPE_LABELS  = { asphalt: "Aszfalt", gravel: "Gravel", mtb: "MTB", hiking: "Gyalogos", workout: "Edzés", cycling: "Kerékpár" };
  const typeIcon  = TYPE_ICONS[route.type] ?? "bike";
  const typeLabel = TYPE_LABELS[route.type] ?? "Kerékpár";

  // Statisztika chipek
  const chips = [];
  if (route.distance != null)
    chips.push(`<span class="lib-chip"><i data-lucide="route" aria-hidden="true"></i>${route.distance} km</span>`);
  if (route.duration != null)
    chips.push(`<span class="lib-chip"><i data-lucide="clock" aria-hidden="true"></i>${formatRouteDuration(route.duration)}</span>`);
  if (route.elevation != null)
    chips.push(`<span class="lib-chip"><i data-lucide="triangle" aria-hidden="true"></i>${route.elevation} m</span>`);

  // Dátum (csak saját útvonalon)
  const dateLabel = !isSample && route.date
    ? `<span class="library-item-date">${route.date}</span>`
    : "";

  // Leírás (ha van)
  const descEl = route.description
    ? `<p class="library-item-desc">${route.description}</p>`
    : "";

  li.innerHTML = `
    <div class="library-item-header">
      <div class="library-item-type-badge library-item-type-badge--${route.type ?? "cycling"}">
        <i data-lucide="${typeIcon}" aria-hidden="true"></i>
      </div>
      <div class="library-item-meta">
        <span class="library-item-name">${route.name}</span>
        ${dateLabel ? `<span class="library-item-date">${route.date}</span>` : ""}
      </div>
      <div class="library-item-actions">
        <button class="library-load-btn" type="button"
          title="${isWorkout ? "Betöltés elemzéshez" : "Betöltés tervezéshez"}">
          <i data-lucide="${isWorkout ? "chart-line" : "map-pin-plus"}" aria-hidden="true"></i>
        </button>
        <button class="library-download-btn" type="button" title="GPX letöltés">
          <i data-lucide="download" aria-hidden="true"></i>
        </button>
        ${!isSample ? `
        <button class="library-edit-btn" type="button" title="Szerkesztés">
          <i data-lucide="pencil" aria-hidden="true"></i>
        </button>
        <button class="library-delete-btn" type="button" title="Törlés">
          <i data-lucide="trash-2" aria-hidden="true"></i>
        </button>` : ""}
      </div>
    </div>
    ${chips.length ? `<div class="library-item-chips">${chips.join("")}</div>` : ""}
    ${descEl}
  `;

  // Betöltés gomb – edzésnél Elemzés fülre, egyébként Tervezés fülre
  li.querySelector(".library-load-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<svg class="lib-load-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" width="14" height="14"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;
    try {
      await loadRouteFromLibrary(route.id, isSample, route.name, isWorkout ? "file" : "plan");
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
      window.lucide?.createIcons({ nodes: [btn] });
    }
  });

  // GPX letöltés gomb
  li.querySelector(".library-download-btn").addEventListener("click", async () => {
    // Fájlnév kérése – útvonal neve alapján javasolt, szerkeszthető
    const suggested = slugify(route.name) || route.id;
    const filename  = await promptFilename(suggested);
    if (filename === null) return; // felhasználó megszakította

    try {
      const gpxText = isSample
        ? await routesApi.loadSample(route.id)
        : await routesApi.loadRoute(route.id);
      downloadGpx(`${filename}.gpx`, gpxText);
    } catch (err) {
      console.error("GPX letöltési hiba:", err);
      showToast("Nem sikerült letölteni a GPX fájlt.");
    }
  });

  // Szerkesztés gomb (csak saját útvonalakon)
  li.querySelector(".library-edit-btn")?.addEventListener("click", () => {
    openLibraryEditModal(route, li);
  });

  // Törlés gomb (csak saját útvonalakhoz)
  li.querySelector(".library-delete-btn")?.addEventListener("click", async () => {
    if (!confirm(`Biztosan törlöd: „${route.name}"?`)) return;
    try {
      await routesApi.deleteRoute(route.id);
      li.remove();
      showToast(`„${route.name}" törölve`);
      // Ha az utolsó elem volt, megjelenítjük az üres állapotot
      const list = document.querySelector("#libraryUserList");
      if (list && !list.children.length) {
        document.querySelector("#libraryUserEmpty").hidden = false;
      }
    } catch (err) {
      console.error("Törlési hiba:", err);
      showToast("Nem sikerült törölni az útvonalat.");
    }
  });

  return li;
}

/**
 * Megnyitja a szerkesztő modalt egy könyvtári útvonalhoz.
 * Mentéskor PATCH kérést küld az API-nak, majd újrarendereli a rácsot.
 *
 * @param {{ id: string, name: string, type: string, description: string }} route
 */
function openLibraryEditModal(route) {
  const overlay  = document.querySelector("#libraryEditOverlay");
  const nameInput = document.querySelector("#libraryEditName");
  const descInput = document.querySelector("#libraryEditDesc");
  const saveBtn  = document.querySelector("#libraryEditSave");

  if (!overlay) return;

  // Meglévő értékek betöltése
  nameInput.value = route.name;
  descInput.value = route.description ?? "";
  // cycling → asphalt backwards compat
  const editTypeVal = (route.type === "cycling" ? "asphalt" : route.type) ?? "asphalt";
  const typeRadio = overlay.querySelector(`input[name="libraryEditType"][value="${editTypeVal}"]`);
  if (typeRadio) typeRadio.checked = true;

  overlay.hidden = false;
  window.lucide?.createIcons();
  setTimeout(() => nameInput.select(), 50);

  // Mentés gomb – új handler minden megnyitáskor (removeEventListener helyett klónozás)
  const newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.replaceWith(newSaveBtn);

  newSaveBtn.addEventListener("click", async () => {
    const newName = nameInput.value.trim() || route.name;
    const newType = overlay.querySelector("input[name=\"libraryEditType\"]:checked")?.value ?? route.type;
    const newDesc = descInput.value.trim();

    try {
      const updated = await routesApi.updateRoute(route.id, {
        name:        newName,
        type:        newType,
        description: newDesc,
      });

      // _libraryData helyi frissítése, majd rács újrarenderelése
      route.name        = updated.name;
      route.type        = updated.type;
      route.description = updated.description;

      // Frissítjük a _libraryData-ban tárolt referenciát is
      const updateInList = (list) => {
        const idx = list.findIndex(r => r.id === updated.id);
        if (idx !== -1) { list[idx].name = updated.name; list[idx].type = updated.type; list[idx].description = updated.description; }
      };
      updateInList(_libraryData.routes);
      updateInList(_libraryData.workouts);

      overlay.hidden = true;
      renderLibraryGrid();
      showToast(`„${updated.name}" frissítve`);
    } catch (err) {
      console.error("Szerkesztési hiba:", err);
      showToast("Nem sikerült menteni a módosítást.");
    }
  });
}

// Edit modal bezárás
document.querySelector("#libraryEditClose")?.addEventListener("click", () => {
  document.querySelector("#libraryEditOverlay").hidden = true;
});
document.querySelector("#libraryEditOverlay")?.addEventListener("click", (e) => {
  if (e.target === document.querySelector("#libraryEditOverlay"))
    document.querySelector("#libraryEditOverlay").hidden = true;
});

/**
 * Betölti az útvonalkönyvtár adatait és megjeleníti a kártyarácsot.
 * Ha az API nem elérhető, az offline üzenet jelenik meg.
 */
async function loadRouteLibrary() {
  const elLoading = document.querySelector("#libraryLoading");
  const elOffline = document.querySelector("#libraryOffline");
  const elFilter  = document.querySelector("#libraryFilterPanel");

  elLoading.hidden = false;
  elOffline.hidden = true;
  if (elFilter) elFilter.hidden = true;

  try {
    const [userRoutes, samples] = await Promise.all([
      routesApi.listRoutes(),
      routesApi.listSamples(),
    ]);
    _libraryData.routes   = userRoutes.filter(r => r.type !== "workout");
    _libraryData.workouts = userRoutes.filter(r => r.type === "workout");
    _libraryData.samples  = samples;
    if (elFilter) elFilter.hidden = false;
    renderLibraryGrid();
  } catch (err) {
    console.error("Könyvtár betöltési hiba:", err);
    elOffline.hidden = false;
  } finally {
    elLoading.hidden = true;
    window.lucide?.createIcons();
  }
}

/**
 * Szűri, rendezi és újrarendereli a könyvtár kártyarácsát.
 */
function renderLibraryGrid() {
  const grid    = document.querySelector("#libraryGrid");
  const emptyEl = document.querySelector("#libraryGridEmpty");
  const countEl = document.querySelector("#libraryResultCount");
  if (!grid) return;

  // Összes elem összegyűjtése
  const all = [
    ..._libraryData.routes.map(r   => ({ route: r, category: 'route',   isSample: false })),
    ..._libraryData.workouts.map(r => ({ route: r, category: 'workout', isSample: false })),
    ..._libraryData.samples.map(r  => ({ route: r, category: 'sample',  isSample: true  })),
  ];

  // Szűrés típus szerint
  let filtered = _libraryFilter.type === 'all'
    ? all
    : all.filter(({ category }) => category === _libraryFilter.type);

  // Szűrés keresési kifejezés szerint
  const q = _libraryFilter.query.toLowerCase().trim();
  if (q) {
    filtered = filtered.filter(({ route }) =>
      (route.name ?? '').toLowerCase().includes(q) ||
      (route.description ?? '').toLowerCase().includes(q)
    );
  }

  // Távolság range szűrő (csak ha nem az alapértelmezett 0–max)
  if (_libraryFilter.distMin > 0 || _libraryFilter.distMax < DIST_MAX) {
    filtered = filtered.filter(({ route }) => {
      const d = route.distance ?? null;
      if (d == null) return _libraryFilter.distMin === 0; // nincs adat → csak ha min=0
      return d >= _libraryFilter.distMin && d <= _libraryFilter.distMax;
    });
  }

  // Edzésidő range szűrő (percben)
  if (_libraryFilter.durMin > 0 || _libraryFilter.durMax < DUR_MAX) {
    filtered = filtered.filter(({ route }) => {
      const dur = route.duration ?? null;
      if (dur == null) return _libraryFilter.durMin === 0;
      return dur >= _libraryFilter.durMin && dur <= _libraryFilter.durMax;
    });
  }

  // Rendezés
  filtered = [...filtered].sort((a, b) => {
    switch (_libraryFilter.sort) {
      case 'oldest':   return (a.route.date ?? '') < (b.route.date ?? '') ? -1 : 1;
      case 'name':     return (a.route.name ?? '').localeCompare(b.route.name ?? '');
      case 'distance': return (b.route.distance ?? 0) - (a.route.distance ?? 0);
      case 'duration': return (b.route.duration ?? 0) - (a.route.duration ?? 0);
      default:         return (a.route.date ?? '') < (b.route.date ?? '') ? 1 : -1; // newest
    }
  });

  // Eredményszámláló
  if (countEl) countEl.textContent = `${filtered.length} találat`;

  // Megjelenítés
  grid.innerHTML = '';
  if (filtered.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
  } else {
    if (emptyEl) emptyEl.hidden = true;
    filtered.forEach(({ route, category, isSample }) => {
      grid.append(createLibraryCard(route, category, isSample));
    });
    window.lucide?.createIcons({ nodes: [grid] });
  }
}

/**
 * Létrehoz egy könyvtárkártyát a megadott útvonalhoz.
 *
 * @param {{ id: string, name: string, date?: string, distance?: number|null,
 *           duration?: number|null, elevation?: number|null,
 *           type?: string, description?: string }} route
 * @param {'route'|'workout'|'sample'} category
 * @param {boolean} isSample
 * @returns {HTMLDivElement}
 */
function createLibraryCard(route, category, isSample) {
  const isWorkout = category === 'workout';
  const TYPE_ICONS  = { hiking: 'footprints', mtb: 'mountain', workout: 'chart-line', sample: 'map' };
  const TYPE_LABELS = { asphalt: 'Aszfalt', gravel: 'Gravel', mtb: 'MTB', hiking: 'Gyalogos', workout: 'Edzés', cycling: 'Kerékpár', sample: 'Minta' };
  const badgeType = isSample ? 'sample' : (route.type ?? 'cycling');
  const typeIcon  = TYPE_ICONS[isWorkout ? 'workout' : badgeType] ?? 'bike';
  const typeLabel = TYPE_LABELS[badgeType] ?? 'Kerékpár';

  const chips = [];
  if (route.distance != null)
    chips.push(`<span class="lib-chip"><i data-lucide="route" aria-hidden="true"></i>${route.distance} km</span>`);
  if (route.duration != null)
    chips.push(`<span class="lib-chip"><i data-lucide="clock" aria-hidden="true"></i>${formatRouteDuration(route.duration)}</span>`);
  if (route.elevation != null)
    chips.push(`<span class="lib-chip"><i data-lucide="triangle" aria-hidden="true"></i>${route.elevation} m</span>`);

  const card = document.createElement('div');
  card.className = 'library-card';
  card.dataset.id = route.id;
  card.innerHTML = `
    <div class="library-card-header">
      <div class="library-card-badge library-card-badge--${badgeType}">
        <i data-lucide="${typeIcon}" aria-hidden="true"></i>
      </div>
      <div class="library-card-info">
        <div class="library-card-name" title="${route.name}">${route.name}</div>
        ${!isSample && route.date
          ? `<div class="library-card-date">${route.date}</div>`
          : `<div class="library-card-date">${typeLabel}</div>`}
      </div>
    </div>
    ${chips.length ? `<div class="library-card-chips">${chips.join('')}</div>` : ''}
    ${route.description ? `<div class="library-card-desc">${route.description}</div>` : ''}
    <div class="library-card-actions">
      <button class="library-card-btn library-card-btn--primary library-load-btn" type="button" title="${isWorkout ? 'Betöltés elemzéshez' : 'Betöltés tervezéshez'}">
        <i data-lucide="${isWorkout ? 'chart-line' : 'map-pin-plus'}" aria-hidden="true"></i>
        ${isWorkout ? 'Elemzés' : 'Betöltés'}
      </button>
      <button class="library-card-btn library-download-btn" type="button" title="GPX letöltés">
        <i data-lucide="download" aria-hidden="true"></i>
      </button>
      ${!isSample ? `
      <button class="library-card-btn library-edit-btn" type="button" title="Szerkesztés">
        <i data-lucide="pencil" aria-hidden="true"></i>
      </button>
      <button class="library-card-btn library-card-btn--danger library-delete-btn" type="button" title="Törlés">
        <i data-lucide="trash-2" aria-hidden="true"></i>
      </button>` : ''}
    </div>
  `;

  // Betöltés gomb
  card.querySelector('.library-load-btn').addEventListener('click', async () => {
    await loadRouteFromLibrary(route.id, isSample, route.name, isWorkout ? 'file' : 'plan');
  });

  // GPX letöltés gomb
  card.querySelector('.library-download-btn').addEventListener('click', async () => {
    try {
      const gpxText = isSample
        ? await routesApi.loadSample(route.id)
        : await routesApi.loadRoute(route.id);
      downloadGpx(`${route.name}.gpx`, gpxText);
    } catch { showToast('Nem sikerült letölteni a GPX fájlt.'); }
  });

  if (!isSample) {
    // Szerkesztés gomb
    card.querySelector('.library-edit-btn').addEventListener('click', () => {
      openLibraryEditModal(route);
    });

    // Törlés gomb
    card.querySelector('.library-delete-btn').addEventListener('click', async () => {
      if (!confirm(`Biztosan törlöd: „${route.name}"?`)) return;
      try {
        await routesApi.deleteRoute(route.id);
        _libraryData.routes   = _libraryData.routes.filter(r => r.id !== route.id);
        _libraryData.workouts = _libraryData.workouts.filter(r => r.id !== route.id);
        renderLibraryGrid();
        showToast(`„${route.name}" törölve`);
      } catch (err) {
        console.error("Törlési hiba:", err);
        showToast('Nem sikerült törölni az útvonalat.');
      }
    });
  }

  return card;
}

// ── Könyvtár frissítés és újrapróbálás ───────────────────────────────────────
document.querySelector("#libraryRefreshBtn")?.addEventListener("click", loadRouteLibrary);
document.querySelector("#libraryRetryBtn")?.addEventListener("click", loadRouteLibrary);

// ── Könyvtár szűrő események ─────────────────────────────────────────────────
document.querySelector('#librarySearchInput')?.addEventListener('input', (e) => {
  _libraryFilter.query = e.target.value;
  renderLibraryGrid();
});
document.querySelectorAll('[data-lib-type]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('[data-lib-type]').forEach(c => c.classList.remove('is-active'));
    chip.classList.add('is-active');
    _libraryFilter.type = chip.dataset.libType;
    renderLibraryGrid();
  });
});
// ── Dual range slider inicializálás ──────────────────────────────────────────
function initRangeSlider({ minId, maxId, fillId, labelId, maxVal, format, onUpdate }) {
  const minEl  = document.querySelector(`#${minId}`);
  const maxEl  = document.querySelector(`#${maxId}`);
  const fillEl = document.querySelector(`#${fillId}`);
  const lblEl  = document.querySelector(`#${labelId}`);
  if (!minEl || !maxEl) return;

  function updateUI() {
    const lo = parseInt(minEl.value);
    const hi = parseInt(maxEl.value);
    const pLo = (lo / maxVal) * 100;
    const pHi = (hi / maxVal) * 100;
    if (fillEl) { fillEl.style.left = pLo + '%'; fillEl.style.width = (pHi - pLo) + '%'; }
    if (lblEl)  lblEl.textContent = format(lo, hi, maxVal);
  }

  minEl.addEventListener('input', () => {
    if (parseInt(minEl.value) > parseInt(maxEl.value)) minEl.value = maxEl.value;
    updateUI();
    onUpdate(parseInt(minEl.value), parseInt(maxEl.value));
  });
  maxEl.addEventListener('input', () => {
    if (parseInt(maxEl.value) < parseInt(minEl.value)) maxEl.value = minEl.value;
    updateUI();
    onUpdate(parseInt(minEl.value), parseInt(maxEl.value));
  });
  updateUI();
}

initRangeSlider({
  minId: 'libraryDistMin', maxId: 'libraryDistMax',
  fillId: 'libraryDistFill', labelId: 'libraryDistLabel',
  maxVal: DIST_MAX,
  format: (lo, hi, max) => (lo === 0 && hi === max) ? 'Bármely' : `${lo} – ${hi === max ? hi + '+' : hi} km`,
  onUpdate: (lo, hi) => { _libraryFilter.distMin = lo; _libraryFilter.distMax = hi; renderLibraryGrid(); },
});

initRangeSlider({
  minId: 'libraryDurMin', maxId: 'libraryDurMax',
  fillId: 'libraryDurFill', labelId: 'libraryDurLabel',
  maxVal: DUR_MAX,
  format: (lo, hi, max) => {
    if (lo === 0 && hi === max) return 'Bármely';
    const fmt = m => m < 60 ? `${m} p` : (m % 60 === 0 ? `${m/60} ó` : `${Math.floor(m/60)}ó ${m%60}p`);
    return `${fmt(lo)} – ${hi === max ? fmt(hi) + '+' : fmt(hi)}`;
  },
  onUpdate: (lo, hi) => { _libraryFilter.durMin = lo; _libraryFilter.durMax = hi; renderLibraryGrid(); },
});
document.querySelectorAll('[data-lib-sort]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('[data-lib-sort]').forEach(c => c.classList.remove('is-active'));
    chip.classList.add('is-active');
    _libraryFilter.sort = chip.dataset.libSort;
    renderLibraryGrid();
  });
});

// ── Szintadat időbecslés kapcsolók ───────────────────────────────────────────
// Beállítások toggle: az alapértelmezett értéket menti → következő betöltésnél ez lesz az alap
// Az aktuális munkamenetre NINCS hatással (a tervezés fül toggleja az irányadó)
document.querySelector('#elevationTimeToggle')?.addEventListener('change', (e) => {
  localStorage.setItem('bringaterv-elevation-default', String(e.target.checked));
});
// Tervezés fül toggle: csak az aktuális munkamenetre hat, nem ment semmit
document.querySelector('#planElevTimeToggle')?.addEventListener('change', (e) => {
  elevationTimeEnabled = e.target.checked;
  renderSidebar(store.getState());
});


// ── Átlagsebesség csúszkák (beállítások) ─────────────────────────────────────
function initSpeedSliders() {
  const speeds = getSpeedSettings();
  const sliderMap = {
    asphalt: { sliderId: 'speedAsphalt', valId: 'speedAsphaltVal' },
    gravel:  { sliderId: 'speedGravel',  valId: 'speedGravelVal'  },
    mtb:     { sliderId: 'speedMtb',     valId: 'speedMtbVal'     },
    hiking:  { sliderId: 'speedHiking',  valId: 'speedHikingVal'  },
  };
  for (const [mode, { sliderId, valId }] of Object.entries(sliderMap)) {
    const slider = document.querySelector(`#${sliderId}`);
    const valEl  = document.querySelector(`#${valId}`);
    if (!slider) continue;
    slider.value = speeds[mode];
    if (valEl) valEl.textContent = speeds[mode];
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      if (valEl) valEl.textContent = v;
      localStorage.setItem(LS_SPEED_PREFIX + mode, String(v));
      renderSidebar(store.getState());
    });
  }

  document.querySelector('#resetSpeedDefaults')?.addEventListener('click', () => {
    for (const [mode, def] of Object.entries(DEFAULT_SPEEDS)) {
      localStorage.removeItem(LS_SPEED_PREFIX + mode);
      const { sliderId, valId } = sliderMap[mode];
      const slider = document.querySelector(`#${sliderId}`);
      const valEl  = document.querySelector(`#${valId}`);
      if (slider) slider.value = def;
      if (valEl)  valEl.textContent = def;
    }
    renderSidebar(store.getState());
  });

  // Settings toggle = elmentett alapértelmezett; plan tab toggle = munkamenet (elevationTimeEnabled)
  const settingsToggle = document.querySelector('#elevationTimeToggle');
  const planToggle     = document.querySelector('#planElevTimeToggle');
  if (settingsToggle) settingsToggle.checked = elevationTimeDefault();
  if (planToggle)     planToggle.checked     = elevationTimeEnabled;
}
initSpeedSliders();

document.addEventListener("keydown", (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) { event.preventDefault(); store.undo(); }
  if (key === "z" && event.shiftKey)  { event.preventDefault(); store.redo(); }
  if (key === "y") { event.preventDefault(); store.redo(); }
  if (key === "i") { event.preventDefault(); currentTab === "plan" ? planGpxInput?.click() : elements.gpxInput.click(); }
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
  // popup elemek active állapota
  elements.routeModeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.routeMode === mode);
  });
  // picker gomb ikon + felirat frissítése
  const meta = ROUTE_MODE_META[mode] ?? ROUTE_MODE_META.asphalt;
  const iconHtml = meta.lucide
    ? `<i data-lucide="${meta.lucide}" aria-hidden="true"></i>`
    : GRAVEL_PICKER_SVG;
  if (elements.routeModePicker) {
    elements.routeModePicker.innerHTML =
      `${iconHtml}<span>${meta.label}</span><i data-lucide="chevron-down" class="sidebar-style-chevron" aria-hidden="true"></i>`;
    window.lucide?.createIcons({ nodes: [elements.routeModePicker] });
  }
  // toolbar gomb: ikon + title frissítés
  if (elements.mapRouteModePicker) {
    const toolbarIcon = meta.lucide
      ? `<i data-lucide="${meta.lucide}" aria-hidden="true"></i>`
      : GRAVEL_PICKER_SVG;
    elements.mapRouteModePicker.innerHTML = toolbarIcon;
    elements.mapRouteModePicker.title = `Tervezési mód: ${meta.label}`;
    window.lucide?.createIcons({ nodes: [elements.mapRouteModePicker] });
  }
}

// ── Szegmens-profil picker ─────────────────────────────────────────────────────
let _segmentPickerEl = null;

function getSegmentPicker() {
  if (!_segmentPickerEl) {
    _segmentPickerEl = document.createElement("div");
    _segmentPickerEl.className = "segment-picker";
    _segmentPickerEl.hidden = true;
    document.body.appendChild(_segmentPickerEl);
  }
  return _segmentPickerEl;
}

function openSegmentPicker(waypointId, currentMode, anchorEl) {
  const picker = getSegmentPicker();
  activeSegmentPickerId = waypointId;

  picker.innerHTML = Object.keys(SEGMENT_COLORS)
    .map((m) => {
      const isActive = m === currentMode;
      return `<button class="seg-picker-btn${isActive ? " is-active" : ""}" data-mode="${m}" data-id="${waypointId}">
        <span class="seg-dot" style="background:${SEGMENT_COLORS[m]}"></span>
        <span>${SEGMENT_LABELS[m] ?? m}</span>
      </button>`;
    })
    .join("");

  picker.querySelectorAll(".seg-picker-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const newMode = btn.dataset.mode;
      const id = btn.dataset.id;
      store.updateWaypoint(id, { segmentMode: newMode });
      closeSegmentPicker();
    });
  });

  // Pozícionálás az anchor elem alá
  const rect = anchorEl.getBoundingClientRect();
  picker.hidden = false;
  picker.style.top  = `${rect.bottom + 4}px`;
  picker.style.left = `${rect.left}px`;
}

function closeSegmentPicker() {
  if (_segmentPickerEl) _segmentPickerEl.hidden = true;
  activeSegmentPickerId = null;
}

document.addEventListener("click", (e) => {
  if (!_segmentPickerEl || _segmentPickerEl.hidden) return;
  if (!_segmentPickerEl.contains(e.target)) closeSegmentPicker();
});

function renderSidebar(state) {
  elements.waypointList.innerHTML = "";
  elements.emptyState.hidden = state.waypoints.length > 0;

  const hasDistance = state.distanceMeters > 0;

  elements.distanceValue.textContent = state.distanceMeters > 0 ? formatDisplayDistance(state.distanceMeters) : "—";
  if (elements.pointCount) elements.pointCount.textContent = String(state.waypoints.length);
  const hasElevation = state.ascentMeters > 0 || state.descentMeters > 0;
  elements.ascentRow.hidden = !hasElevation;
  elements.descentRow.hidden = !hasElevation;
  if (hasElevation) {
    elements.ascentValue.textContent = `${state.ascentMeters} m`;
    elements.descentValue.textContent = `${state.descentMeters} m`;
  }

  // Becsült idő – csak ha van távolság
  if (elements.estimatedTimeRow) {
    elements.estimatedTimeRow.hidden = !hasDistance;
    if (hasDistance) {
      const distKm = Math.round(state.distanceMeters / 100) / 10;
      const ascM   = elevationTimeEnabled ? (state.ascentMeters  > 0 ? state.ascentMeters  : 0) : 0;
      const descM  = elevationTimeEnabled ? (state.descentMeters > 0 ? state.descentMeters : 0) : 0;
      const mins   = calcEstimatedTime(distKm, ascM, descM, state.mode ?? 'asphalt');
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      elements.estimatedTimeValue.textContent = h > 0
        ? `${h} ó ${m > 0 ? m + ' p' : ''}`
        : `${m} p`;
    }
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

    // Szegmens-profil badge – csak az utolsó kivételével minden waypointnál
    const isLastWaypoint = index === state.waypoints.length - 1;
    if (!isLastWaypoint && state.waypoints.length >= 2) {
      const isExplicit = point.segmentMode != null;
      const segMode = point.segmentMode ?? state.mode ?? "asphalt";

      // Wrapper: badge gomb + opcionális × gomb
      const segWrap = document.createElement("span");
      segWrap.className = "segment-badge-wrap";

      const segBadge = document.createElement("button");
      segBadge.type = "button";
      segBadge.className = `segment-mode-badge${isExplicit ? " is-explicit" : " is-inherited"}`;
      segBadge.title = `Szakasz módja: ${SEGMENT_LABELS[segMode] ?? segMode} – kattints a módosításhoz`;
      segBadge.innerHTML = `<span class="seg-dot" style="background:${SEGMENT_COLORS[segMode] ?? "#1976d2"}"></span>`;
      segBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        if (activeSegmentPickerId === point.id) {
          closeSegmentPicker();
        } else {
          openSegmentPicker(point.id, segMode, segBadge);
        }
      });
      segWrap.append(segBadge);

      if (isExplicit) {
        const resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.className = "seg-reset-btn";
        resetBtn.title = "Visszaállítás alapértelmezésre";
        resetBtn.innerHTML = `<i data-lucide="x" aria-hidden="true"></i>`;
        resetBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          store.updateWaypoint(point.id, { segmentMode: null });
        });
        segWrap.append(resetBtn);
      }

      item.classList.add("has-seg-badge");
      item.append(handle, badge, labelWrap, segWrap, remove);
    } else {
      item.append(handle, badge, labelWrap, remove);
    }

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

// ── Beállítások szekciók összecsukása ─────────────────────────────────────────
(function initSettingsCollapse() {
  const LS_KEY      = "bringaterv-settings-collapsed";
  const LS_VER_KEY  = "bringaterv-settings-version";
  const CURRENT_VER = "3"; // bump ha új szekció kerül az alapból-csukott halmazba
  const ALL_SECTIONS = ['mapStyle', 'units', 'planningDefaults', 'startView', 'toolbarOrder'];

  function loadCollapsed() {
    const saved   = localStorage.getItem(LS_KEY);
    const version = localStorage.getItem(LS_VER_KEY);
    // Első látogatás VAGY verzió változás → minden szekció becsukva alapból
    if (saved === null || version !== CURRENT_VER) {
      localStorage.setItem(LS_VER_KEY, CURRENT_VER);
      return new Set(ALL_SECTIONS);
    }
    try { return new Set(JSON.parse(saved) || []); }
    catch { return new Set(); }
  }
  function saveCollapsed(set) {
    localStorage.setItem(LS_KEY, JSON.stringify([...set]));
  }

  const collapsed = loadCollapsed();

  document.querySelectorAll(".settings-section[data-settings-section]").forEach(section => {
    const key = section.dataset.settingsSection;
    const title = section.querySelector(".settings-section-title");
    const body  = section.querySelector(".settings-section-body");
    if (!title || !body) return;

    if (collapsed.has(key)) section.classList.add("is-collapsed");

    title.addEventListener("click", (e) => {
      // Don't collapse when clicking hint-btn
      if (e.target.closest(".hint-btn")) return;
      const isNowCollapsed = section.classList.toggle("is-collapsed");
      if (isNowCollapsed) collapsed.add(key);
      else collapsed.delete(key);
      saveCollapsed(collapsed);
    });
  });
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
