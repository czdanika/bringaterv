import { requireAuth, logout, isAdmin, getUser, ensureSettingsOwner } from "./auth.js";

// User-váltás detektálás: ha másik felhasználó beállításai vannak a localStorage-ban,
// töröljük őket, mielőtt bármelyik IIFE elindulna és kiolvasná.
// Ez fedi a {logout → login másik userrel} és a {direct JWT swap} eseteket.
ensureSettingsOwner();
import { config } from "./config.js";
import { getSettings, saveSetting } from "./appSettings.js";
import { createI18n } from "./i18n/i18n.js";
import { createRouteStore } from "./state/routeStore.js";
import { createMapAdapter, SEGMENT_COLORS } from "./map/mapAdapter.js";
import { downloadGpx, exportGpx, importGpx, calcElevationFromGeometry, calcTiming } from "./gpx/gpx.js";
import { fitToGpx } from "./gpx/fit.js";
import { createToast, formatDistance } from "./ui/dom.js";
import { searchPlaces, reverseGeocode } from "./ui/search.js";
import { buildElevationData, buildSpeedData, buildHrData, buildCadData, buildPowerData, initElevationChart } from "./ui/elevationProfile.js";
import { routesApi } from "./api/routesApi.js";
import { analyzeSurface, MODE_LABELS } from "./map/surfaceAnalysis.js";
import { defaultAvgSpeed, windTimeMultiplier } from "./wind/windService.js";
import { initWind, clearWindResult, scheduleWindRunIfActive, initWindPlanInputsIfNeeded, getWindResult } from "./ui/wind.js";
import {
  initFileTab, populateFileTab, clearFileTab, processImportedFile,
  updateFileSaveButtonState, setLoadedRoute, setImportedGeometries, clearImportedGeometries,
  getHasImportedFile, getImportedColoredGeometry, getImportedHrGeometry,
  getImportedCadGeometry, getImportedPowerGeometry, getLoadedLibraryRouteId,
  getImportedFileName, getImportedGpxText,
} from "./ui/fileTab.js";
// Kalóriaszámítás modul (calories.js) – elérhető, de a UI-on jelenleg nincs használva.
// Jövőbeli újra-aktiváláshoz: import + render a sidebar és file tabon.
import { calculateZones, calculateZonesMaxHR, calculateZonesLTHR, calculateZonesCustom, calculateTRIMP, ZONE_DEFS_FRIEL } from "./karvonen.js";
import { renderStats, renderMonthlyTable, renderRecordsFull, renderEddington, renderTrainingLoad } from "./ui/statsPanel.js";
import { initStats, loadAndRenderStats, switchStatsView } from "./ui/statsManager.js";
import {
  initLibrary, loadRouteLibrary, renderLibraryGrid, setLibraryViewMode, setLibraryListSort,
  buildLibraryListRow, createLibraryCard, openLibraryEditModal, toggleLibraryRowExpand,
  loadAndRenderExpandPreview, loadCardPreview, renderRouteSvgMini, escapeHtml,
  libraryRouteSportKey, libraryRouteSource, smartDateFormat,
} from "./ui/library.js";

requireAuth();

// ── Verzióellenőrzés ──────────────────────────────────────────────────────────
// Forrás: src/version.js (window.APP_VERSION) — egyetlen helyen kell frissíteni
const APP_VERSION = window.APP_VERSION ?? "v0.71";

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
const tabStats    = document.querySelector("#tabStats");
let currentTab = "plan";
// ── Library state ──────────────────────────────────────────
let _libraryData   = { routes: [], workouts: [], samples: [] };
let _libraryFilter = { type: 'all', source: 'all', sport: 'all', query: '', sort: 'newest', distMin: 0, distMax: 500, durMin: 0, durMax: 600 };
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
  elements.appShell.classList.toggle("is-stats-mode",   name === "stats");
  tabButtons.forEach(b => b.classList.toggle("is-active", b.dataset.tab === name));
  tabPlan.hidden    = name !== "plan";
  tabFile.hidden    = name !== "file";
  if (tabLibrary) tabLibrary.hidden = name !== "library";
  if (tabStats)   tabStats.hidden   = name !== "stats";
  const libraryMain = document.querySelector("#libraryMain");
  if (libraryMain) libraryMain.hidden = name !== "library";
  const statsMain = document.querySelector("#statsMain");
  if (statsMain) statsMain.hidden = name !== "stats";
  // Tervezés fülön crosshair + route kattintás engedélyezett, Elemzésen/Könyvtáron nem
  mapAdapter?.setRouteInteractive(name === "plan");
  // Könyvtár fül megnyitásakor mindig frissítjük a listát
  if (name === "library" && tabLibrary) loadRouteLibrary();
  // Statisztikák fül megnyitásakor: betölt ha szükséges, majd renderel (statsManager.js)
  if (name === "stats") loadAndRenderStats();
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
  if (currentTab === "file" && targetTab === "plan" && getHasImportedFile()) {
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
  fileShareButton: document.querySelector("#fileShareButton"),
  elevationBtn: document.querySelector("#elevationBtn"),
  windBtn: document.querySelector("#windBtn"),
  chartWind: document.querySelector("#chartWind"),
  closeChartWind: document.querySelector("#closeChartWind"),
  windHeaderInfo: document.querySelector("#windHeaderInfo"),
  windStats: document.querySelector("#windStats"),
  windBar: document.querySelector("#windBar"),
  windSegments: document.querySelector("#windSegments"),
  windStatus: document.querySelector("#windStatus"),
  windLegendPlan: document.querySelector("#windLegendPlan"),
  windChartBtnPlan: document.querySelector("#windChartBtnPlan"),
  windQuickStats: document.querySelector("#windQuickStats"),
  windDeparturePlan: document.querySelector("#windDeparturePlan"),
  windAvgSpeedPlan: document.querySelector("#windAvgSpeedPlan"),
  windStatusPlan: document.querySelector("#windStatusPlan"),
  windMapTogglePlan: document.querySelector("#windMapTogglePlan"),
  elevationPanel: document.querySelector("#elevationPanel"),
  chartElevation: document.querySelector("#chartElevation"),
  chartSpeed: document.querySelector("#chartSpeed"),
  chartHr: document.querySelector("#chartHr"),
  chartCad: document.querySelector("#chartCad"),
  elevationCanvas: document.querySelector("#elevationCanvas"),
  speedCanvas: document.querySelector("#speedCanvas"),
  hrCanvas: document.querySelector("#hrCanvas"),
  cadCanvas: document.querySelector("#cadCanvas"),
  powerCanvas: document.querySelector("#powerCanvas"),
  closeChartElevation: document.querySelector("#closeChartElevation"),
  closeChartSpeed: document.querySelector("#closeChartSpeed"),
  closeChartHr: document.querySelector("#closeChartHr"),
  closeChartCad: document.querySelector("#closeChartCad"),
  closeChartPower: document.querySelector("#closeChartPower"),
  elevationTooltip: document.querySelector("#elevationTooltip"),
  elevationTooltipDist: document.querySelector("#elevationTooltipDist"),
  elevationTooltipEle: document.querySelector("#elevationTooltipEle"),
  elevationTooltipGrade: document.querySelector("#elevationTooltipGrade"),
  elevationInfo: document.querySelector("#elevationInfo"),
  speedMapToggle: document.querySelector("#speedMapToggle"),
  hrMapToggle: document.querySelector("#hrMapToggle"),
  cadMapToggle: document.querySelector("#cadMapToggle"),
  powerMapToggle: document.querySelector("#powerMapToggle"),
  gradeLegend: document.querySelector("#gradeLegend"),
  gradeLegendPlan: document.querySelector("#gradeLegendPlan"),
  gradeMapToggle: document.querySelector("#gradeMapToggle"),
  gradeMapTogglePlan: document.querySelector("#gradeMapTogglePlan"),
  gradeLegendChartBtn: document.querySelector("#gradeLegendChartBtn"),
  gradeLegendChartBtnPlan: document.querySelector("#gradeLegendChartBtnPlan"),
  speedLegend: document.querySelector("#speedLegend"),
  hrLegend: document.querySelector("#hrLegend"),
  cadLegend: document.querySelector("#cadLegend"),
  powerLegend: document.querySelector("#powerLegend"),
  speedChartBtn: document.querySelector("#speedChartBtn"),
  hrChartBtn: document.querySelector("#hrChartBtn"),
  cadChartBtn: document.querySelector("#cadChartBtn"),
  powerChartBtn: document.querySelector("#powerChartBtn"),
  chartPower: document.querySelector("#chartPower"),
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

store.setState({
  mode: (() => { const m = localStorage.getItem("route4meDefaultRouteMode") || "asphalt"; return m === "cycling" ? "asphalt" : m; })(),
  snapToRoads: getSettings().snapToRoads,
});

i18n.apply();
setupNavigation();

// ── Modulok inicializálása ────────────────────────────────────────────────────
initLibrary({
  api:                routesApi,
  toast:              showToast,
  downloadGpx:        (name, txt) => downloadGpx(name, txt),
  loadRoute:          (id, isSample, name, target) => loadRouteFromLibrary(id, isSample, name, target),
  openShareCardWith:  (data) => window._openShareCardWith?.(data),
  openStravaImportModal: () => openStravaImportModal(),
  processImportedFile:   (file) => processImportedFile(file),
  refreshStravaStatus:   () => refreshStravaStatus(),
  getStravaStatus:       () => _stravaStatus,
  libraryData:        _libraryData,
  libraryFilter:      _libraryFilter,
  DIST_MAX,
  DUR_MAX,
});

initStats({
  api:            routesApi,
  getLibraryData: () => _libraryData,
  onLoadRoute:    (id, isSample, name, target) => loadRouteFromLibrary(id, isSample, name, target),
});

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
if (elements.fileShareButton) elements.fileShareButton.disabled = true;

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
const powerChart     = elements.powerCanvas
  ? initElevationChart(elements.powerCanvas, makeHoverHandler("W"))
  : null;

// Az összes chart feltöltve — szinkronizálás mostantól működik
chartSync.all = [elevationChart, speedChart, hrChart, cadChart, powerChart].filter(Boolean);

// Melyik chart szekciók látszanak (elevation / speed / hr) — itt deklarálva, hogy
// updateElevationButton() és a chart control függvények egyaránt hozzáférjenek
const visibleSections = new Set();

function updateElevationButton(geometry) {
  activeGeometry = geometry ?? [];
  const hasEle = activeGeometry.length > 1 && activeGeometry.some((p) => p.ele != null);
  if (elements.elevationBtn) elements.elevationBtn.disabled = !hasEle;
  // Wind gomb: csak tervezési kontextusban (importált fájl esetén nem releváns)
  if (elements.windBtn) {
    const st = store?.getState?.();
    const planning = !st?.importedRoute && (st?.waypoints?.length ?? 0) >= 2;
    elements.windBtn.disabled = !planning;
  }
  // 5 km-es jelölők a térképen
  if (mapAdapter.renderKmMarkers) {
    if (activeGeometry.length >= 2) {
      mapAdapter.renderKmMarkers(activeGeometry, 5);
    } else {
      mapAdapter.clearKmMarkers?.();
    }
  }
  // Útirány-nyilak (toggle alapján)
  if (mapAdapter.renderDirectionArrows) {
    const showArrows = localStorage.getItem("bringaterv.directionArrows") === "true";
    if (showArrows && activeGeometry.length >= 2) {
      mapAdapter.renderDirectionArrows(activeGeometry, 1.5);
    } else {
      mapAdapter.clearDirectionArrows?.();
    }
  }
  // Wind sidebar legend csak tervezési kontextusban (nem importált fájl)
  if (elements.windLegendPlan) {
    const st = store?.getState?.();
    const planning = !st?.importedRoute && (st?.waypoints?.length ?? 0) >= 2;
    elements.windLegendPlan.hidden = !planning;
    if (planning) {
      initWindPlanInputsIfNeeded();
      if (getWindResult()) scheduleWindRunIfActive("geometry");
    } else {
      clearWindResult();
    }
  }
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
  const cc = getChartColors();
  const isZones = cc.mode === "zones";
  // Ha bármelyik szekció nyitva van, frissítsd az adatot
  if (visibleSections.has("elevation")) {
    const data = buildElevationData(activeGeometry);
    elevationChart.setData(data, {
      color: cc.ele, unit: "m",
      // Zónaszín módban a szintprofil vonala a lejtés (grade) alapján színeződik
      colorFn: isZones ? ((_v, pt) => gradeColorForGrade(pt?.grade)) : null,
    });
    updateElevationPanelInfo(data);
  }
  if (visibleSections.has("speed") && speedChart) {
    speedChart.setData(buildSpeedData(activeGeometry), {
      color: cc.speed, unit: "km/h",
      colorFn: isZones ? (v => getZoneColor("speed", v)) : null,
    });
  }
  if (visibleSections.has("hr") && hrChart) {
    hrChart.setData(buildHrData(activeGeometry), {
      color: cc.hr, unit: "bpm",
      // Pulzusnál a zónaszín a HR beállításokból jön (buildHrZoneColorFn)
      colorFn: isZones ? buildHrZoneColorFn() : null,
    });
  }
  if (visibleSections.has("cad") && cadChart) {
    cadChart.setData(buildCadData(activeGeometry), {
      color: cc.cad, unit: "rpm",
      colorFn: isZones ? (v => getZoneColor("cad", v)) : null,
    });
  }
  if (visibleSections.has("power") && powerChart) {
    powerChart.setData(buildPowerData(activeGeometry), {
      color: cc.power, unit: "W",
      colorFn: isZones ? (v => getZoneColor("power", v)) : null,
    });
  }
}

// Egységes réteg-kapcsoló: csak egy lehet aktív egyszerre
function applyRouteLayer(type) {
  // 1. Minden toggle kikapcsol
  if (elements.speedMapToggle) elements.speedMapToggle.checked = false;
  if (elements.hrMapToggle)    elements.hrMapToggle.checked    = false;
  if (elements.cadMapToggle)   elements.cadMapToggle.checked   = false;
  if (elements.powerMapToggle) elements.powerMapToggle.checked = false;
  if (elements.gradeMapToggle) elements.gradeMapToggle.checked = false;
  if (elements.gradeMapTogglePlan) elements.gradeMapTogglePlan.checked = false;

  // 2. Minden réteg törlése
  mapAdapter.clearColoredRoute();
  mapAdapter.clearHrRoute();
  mapAdapter.clearCadRoute();
  mapAdapter.clearPowerRoute();
  mapAdapter.clearGradeRoute();

  // 3. Aktív réteg bekapcsolása
  switch (type) {
    case "speed":
      if (getImportedColoredGeometry()) {
        if (elements.speedMapToggle) elements.speedMapToggle.checked = true;
        mapAdapter.renderColoredRoute(getImportedColoredGeometry());
      }
      break;
    case "hr":
      if (getImportedHrGeometry()) {
        if (elements.hrMapToggle) elements.hrMapToggle.checked = true;
        mapAdapter.renderHrRoute(getImportedHrGeometry(), buildHrZoneColorFn());
      }
      break;
    case "cad":
      if (getImportedCadGeometry()) {
        if (elements.cadMapToggle) elements.cadMapToggle.checked = true;
        mapAdapter.renderCadRoute(getImportedCadGeometry());
      }
      break;
    case "power":
      if (getImportedPowerGeometry()) {
        if (elements.powerMapToggle) elements.powerMapToggle.checked = true;
        mapAdapter.renderPowerRoute(getImportedPowerGeometry());
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
elements.powerMapToggle?.addEventListener("change", (e) => {
  applyRouteLayer(e.target.checked ? "power" : null);
});
[elements.gradeMapToggle, elements.gradeMapTogglePlan].forEach((toggle) => {
  toggle?.addEventListener("change", (e) => {
    if (e.target.checked) {
      // Kölcsönösen kizáró: szintprofil bekapcsolásakor a szélszínezést kikapcsoljuk
      if (elements.windMapTogglePlan?.checked) {
        elements.windMapTogglePlan.checked = false;
        mapAdapter.clearWindRoute?.();
      }
    }
    applyRouteLayer(e.target.checked ? "grade" : null);
  });
});

// ── Multi-chart: minden szekció önállóan nyitható/zárható ─────────────────────

// Segéd: visszaadja az adott típushoz tartozó elemeket és builder-t.
// Az opts (szín + colorFn) dinamikusan a felhasználói beállításokból (chartColors) jön.
function chartConfig(type) {
  const cc = (typeof getChartColors === "function") ? getChartColors() : null;
  const isZones = cc?.mode === "zones";
  const buildOpts = (color, unit, colorFn = null) => ({
    color: cc?.[opts2Key(type)] ?? color,
    unit,
    colorFn: isZones ? colorFn : null,
  });
  if (type === "speed") {
    return {
      sectionEl: elements.chartSpeed,
      chartInst: speedChart,
      build: () => buildSpeedData(activeGeometry),
      opts:  buildOpts("#3B82F6", "km/h", v => getZoneColor("speed", v)),
      btns: [elements.speedChartBtn],
    };
  }
  if (type === "hr") {
    return {
      sectionEl: elements.chartHr,
      chartInst: hrChart,
      build: () => buildHrData(activeGeometry),
      opts:  buildOpts("#EF4444", "bpm", buildHrZoneColorFn()),
      btns: [elements.hrChartBtn],
    };
  }
  if (type === "cad") {
    return {
      sectionEl: elements.chartCad,
      chartInst: cadChart,
      build: () => buildCadData(activeGeometry),
      opts:  buildOpts("#A855F7", "rpm", v => getZoneColor("cad", v)),
      btns: [elements.cadChartBtn],
    };
  }
  if (type === "power") {
    return {
      sectionEl: elements.chartPower,
      chartInst: powerChart,
      build: () => buildPowerData(activeGeometry),
      opts:  buildOpts("#EAB308", "W", v => getZoneColor("power", v)),
      btns: [elements.powerChartBtn],
    };
  }
  // "elevation" (alapértelmezett)
  return {
    sectionEl: elements.chartElevation,
    chartInst: elevationChart,
    build: () => buildElevationData(activeGeometry),
    opts:  buildOpts("#fc4c02", "m", (_v, pt) => gradeColorForGrade(pt?.grade)),
    btns: [elements.gradeLegendChartBtn, elements.gradeLegendChartBtnPlan],
  };
}

/** chart típus → chartColors mező név */
function opts2Key(type) {
  return type === "elevation" ? "ele" : type;
}

function syncElevationBtnState() {
  const anyOpen = visibleSections.size > 0;
  if (elements.elevationBtn) elements.elevationBtn.classList.toggle("is-active", anyOpen);

  ["elevation", "speed", "hr", "cad", "power"].forEach((type) => {
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
elements.powerChartBtn?.addEventListener("click", () => handleChartBtn("power"));

// X gombok az egyes szekciókhoz
elements.closeChartElevation?.addEventListener("click", () => hideChartSection("elevation"));
elements.closeChartSpeed?.addEventListener("click",     () => hideChartSection("speed"));
elements.closeChartHr?.addEventListener("click",        () => hideChartSection("hr"));
elements.closeChartCad?.addEventListener("click",       () => hideChartSection("cad"));
elements.closeChartPower?.addEventListener("click",     () => hideChartSection("power"));

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
  ["elevation", "speed", "hr", "cad", "power"].forEach((type) => {
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
  powerChart?.resize();
});
if (elements.elevationPanel) elevationResizeObserver.observe(elements.elevationPanel);


// ── Szél (Wind) UI ──────────────────────────────────────────────────────────
initWind({
  mapAdapter,
  store,
  onRenderSidebar: () => renderSidebar(store.getState()),
  getActiveGeometry: () => activeGeometry,
  elements,
  visibleSections,
  applyRouteLayer,
  syncElevationBtnState,
});

// ── Elemzés (File Tab) ────────────────────────────────────────────────────────
initFileTab({
  store,
  mapAdapter,
  api:                      routesApi,
  elements,
  i18n,
  showToast,
  switchTab,
  updateElevationButton,
  applyRouteLayer,
  clearWindResult,
  calculateImportedDistance,
  calcEstimatedTimeMixed,
  loadRouteLibrary,
  openExportModal,
  renderHrZoneAnalysis,
  formatDisplayDistance,
});


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
    routeSegments: route.segments ?? [],
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
topnavMenuBtn?.addEventListener("click", () => {
  if (!topnavDropdown) return;
  const open = topnavDropdown.hidden;
  if (open) {
    const rect = topnavMenuBtn.getBoundingClientRect();
    topnavDropdown.style.top   = (rect.bottom + 8) + "px";
    topnavDropdown.style.right = (window.innerWidth - rect.right) + "px";
    topnavDropdown.style.left  = "auto";
  }
  topnavDropdown.hidden = !open;
});
document.addEventListener("click", (e) => {
  if (!topnavDropdown || topnavDropdown.hidden) return;
  if (!topnavMenuBtn?.contains(e.target) && !topnavDropdown.contains(e.target)) {
    topnavDropdown.hidden = true;
  }
});

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

// Admin link – admin szerepkörrel
if (isAdmin()) {
  const adminBtn = document.querySelector("#adminButton");
  const adminDivider = document.querySelector("#adminDivider");
  if (adminBtn) adminBtn.hidden = false;
  if (adminDivider) adminDivider.hidden = false;
}

// Felhasználó neve a dropdown tetején
{
  const user = getUser();
  const userLabel = document.querySelector("#topnavUserLabel");
  if (userLabel && user) {
    userLabel.textContent = user.name || user.email;
    userLabel.hidden = false;
  }
}

// Beállítások szinkronizálása a szerverrel
{
  // Betöltéskor szerver → localStorage felülírás
  routesApi.getSettings().then(serverSettings => {
    let changed = false;
    if (serverSettings && Object.keys(serverSettings).length > 0) {
      if (serverSettings.hrZones)     { localStorage.setItem("bringaterv.hrZones",     JSON.stringify(serverSettings.hrZones));     changed = true; }
      if (serverSettings.speedZones)  { localStorage.setItem("bringaterv.speedZones",  JSON.stringify(serverSettings.speedZones));  changed = true; }
      if (serverSettings.cadZones)    { localStorage.setItem("bringaterv.cadZones",    JSON.stringify(serverSettings.cadZones));    changed = true; }
      if (serverSettings.powerZones)  { localStorage.setItem("bringaterv.powerZones",  JSON.stringify(serverSettings.powerZones));  changed = true; }
      if (serverSettings.chartColors) { localStorage.setItem("bringaterv.chartColors", JSON.stringify(serverSettings.chartColors)); changed = true; }
      if (serverSettings.cyclistProfile) { localStorage.setItem("bringaterv.cyclistProfile", JSON.stringify(serverSettings.cyclistProfile)); changed = true; }
      if (serverSettings.mapStyle)   { localStorage.setItem("route4meMapStyle",      serverSettings.mapStyle);                  changed = true; }
      if (serverSettings.unit)       { localStorage.setItem("route4meUnit",          serverSettings.unit);                      changed = true; }
      if (serverSettings.startView)  { localStorage.setItem("bringaterv.startView",  JSON.stringify(serverSettings.startView)); changed = true; }
      if (serverSettings.theme)      { localStorage.setItem("route4meTheme",         serverSettings.theme);                     changed = true; }
    }
    // A UI elemek értesítése, hogy újraolvassanak a localStorage-ból
    if (changed) {
      window.dispatchEvent(new CustomEvent('bringaterv:settingsHydrated'));
    }
  }).catch(() => { /* offline – marad a localStorage */ });

  // Mentéskor (saveSetting felülírása) – debounced szerver sync
  let _settingsSyncTimer = null;
  function syncSettingsToServer() {
    clearTimeout(_settingsSyncTimer);
    _settingsSyncTimer = setTimeout(() => {
      const payload = {};
      try { payload.hrZones    = JSON.parse(localStorage.getItem("bringaterv.hrZones")    || "{}");   } catch {}
      try { payload.speedZones = JSON.parse(localStorage.getItem("bringaterv.speedZones") || "null"); } catch {}
      try { payload.cadZones   = JSON.parse(localStorage.getItem("bringaterv.cadZones")   || "null"); } catch {}
      try { payload.powerZones  = JSON.parse(localStorage.getItem("bringaterv.powerZones")  || "null"); } catch {}
      try { payload.chartColors    = JSON.parse(localStorage.getItem("bringaterv.chartColors")    || "null"); } catch {}
      try { payload.cyclistProfile = JSON.parse(localStorage.getItem("bringaterv.cyclistProfile") || "null"); } catch {}
      payload.mapStyle         = localStorage.getItem("route4meMapStyle")     || undefined;
      payload.unit             = localStorage.getItem("route4meUnit")         || undefined;
      try { payload.startView = JSON.parse(localStorage.getItem("bringaterv.startView") || "null"); } catch {}
      payload.theme            = localStorage.getItem("route4meTheme")        || undefined;
      routesApi.saveSettings(payload).catch(() => {});
    }, 1500);
  }
  // Figyeljük a localStorage változásokat (saját tab: custom event)
  window.addEventListener("bringaterv:settingChanged", syncSettingsToServer);
  // HR zóna változás
  window.addEventListener("hrZonesChanged", syncSettingsToServer);
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

// ── Karvonen pulzuszóna beállítások ──────────────────────────────────────────

const HR_ZONES_KEY = 'bringaterv.hrZones';

function getHrZoneSettings() {
  const CURRENT_YEAR = new Date().getFullYear();
  try {
    const s = JSON.parse(localStorage.getItem(HR_ZONES_KEY) || '{}');
    // Visszafelé kompatibilitás: ha csak `age` van mentve, abból számolunk birthYear-t
    const birthYear = s.birthYear ?? (s.age ? CURRENT_YEAR - s.age : 1985);
    const age = Math.max(10, Math.min(100, CURRENT_YEAR - birthYear));
    return {
      sex:       s.sex ?? 'male',
      birthYear,
      age,
      restHR:    s.rest ?? 60,
      maxHR:     s.max  ?? 190,
      maxMethod: s.maxMethod ?? 'tanaka',                // tanaka | classic | custom (max HR meghatározása)
      method:    s.method    ?? 'karvonen',              // karvonen | maxhr | lthr | custom (zónaszámítás)
      zoneModel: s.zoneModel ?? 'friel',                 // friel | equal
      lthr:      s.lthr      ?? 160,
      customBoundaries: s.customBoundaries ?? [105, 139, 156, 173],
    };
  } catch {
    return {
      sex: 'male', birthYear: 1985, age: CURRENT_YEAR - 1985,
      restHR: 60, maxHR: 190, maxMethod: 'tanaka', zoneModel: 'friel',
      method: 'karvonen', lthr: 160, customBoundaries: [105, 139, 156, 173],
    };
  }
}

/** Max HR kiszámítása életkor+nem alapján a választott módszer szerint. */
function computeMaxHr(method, age, sex) {
  if (method === 'classic') return Math.round(220 - age);
  if (method === 'tanaka') {
    return sex === 'female'
      ? Math.round(216 - 1.09 * age)   // Miller – nőkre pontosabb
      : Math.round(208 - 0.7  * age);  // Tanaka – ajánlott aktív felnőtteknek
  }
  return null; // custom: nem számítunk, a user adja meg
}

/** Zone-alapú HR szín-függvény a térképhez */
function buildHrZoneColorFn() {
  const { restHR, maxHR, method, zoneModel, lthr, customBoundaries } = getHrZoneSettings();
  const zones = resolveZones(restHR, maxHR, method, zoneModel, lthr, customBoundaries);
  return (hr) => {
    if (hr == null) return null;
    for (const z of zones) {
      if (hr >= z.low && hr <= z.high) return z.color;
    }
    return hr < zones[0].low ? zones[0].color : zones[zones.length - 1].color;
  };
}

/** Zónák kiszámolása a beállított módszer és zónamodell szerint */
function resolveZones(restHR, maxHR, method, zoneModel = 'friel', lthr = 160, customBoundaries = [105, 139, 156, 173]) {
  if (method === 'lthr')   return calculateZonesLTHR(lthr);
  if (method === 'custom') return calculateZonesCustom(customBoundaries);
  const defs = zoneModel === 'friel' ? ZONE_DEFS_FRIEL : undefined;
  return method === 'maxhr' ? calculateZonesMaxHR(maxHR, defs) : calculateZones(restHR, maxHR, defs);
}

function renderKarvonenZonesList(restHR, maxHR, method = 'karvonen', zoneModel = 'friel', lthr = 160, customBoundaries = [105, 139, 156, 173]) {
  const list = document.getElementById('karvonenZonesList');
  if (!list) return;
  const zones = resolveZones(restHR, maxHR, method, zoneModel, lthr, customBoundaries);
  const refLabel = method === 'maxhr' ? 'HRmax' : method === 'lthr' ? 'LTHR' : method === 'custom' ? '' : 'HRR';
  list.innerHTML = zones.map(z => `
    <div class="karvonen-zone-row" style="--zone-color:${z.color}">
      <div class="karvonen-zone-name">
        <div class="karvonen-zone-title">${z.name}</div>
        <div class="karvonen-zone-subtitle">${z.sub}</div>
      </div>
      <div class="karvonen-zone-pct-hrr">${z.pctLow != null ? `${z.pctLow}–${z.pctHigh}% ${refLabel}` : 'egyedi'}</div>
      <div class="karvonen-zone-range">${z.low === 0 ? '0' : z.low}–${z.high === 999 ? '∞' : z.high}</div>
    </div>`).join('');
}

(function initHrZoneSettings() {
  const sexRadios       = document.querySelectorAll('input[name="hrSex"]');
  const maxMethodRadios = document.querySelectorAll('input[name="hrMaxMethod"]');
  const methodRadios    = document.querySelectorAll('input[name="hrMethod"]');
  const zoneModelRadios = document.querySelectorAll('input[name="hrZoneModel"]');
  const birthYearInput  = document.getElementById('hrBirthYearInput');
  const ageDisplay      = document.getElementById('hrAgeDisplay');
  const rangeSlider     = document.getElementById('hrRangeSlider');
  const restHandle      = document.getElementById('hrRangeRestHandle');
  const maxHandle       = document.getElementById('hrRangeMaxHandle');
  const activeTrack     = document.getElementById('hrRangeActive');
  const restDisplay     = document.getElementById('hrRestDisplay');
  const maxDisplay      = document.getElementById('hrMaxDisplay');
  const maxSourceHint   = document.getElementById('hrMaxSourceHint');
  const tanakaName      = document.getElementById('hrMaxMethodTanakaName');
  const tanakaEq        = document.getElementById('hrMaxMethodTanakaEq');
  const tanakaHint      = document.getElementById('hrMaxMethodTanakaHint');
  const lthrSlider      = document.getElementById('hrLthrSlider');
  const lthrOut         = document.getElementById('hrLthrOut');
  const lthrRow         = document.getElementById('hrLthrSliderRow');
  const zoneModelRow    = document.getElementById('hrZoneModelRow');
  const customRow       = document.getElementById('hrCustomBoundariesRow');
  const customInputs    = [
    document.getElementById('hrCustomB1'),
    document.getElementById('hrCustomB2'),
    document.getElementById('hrCustomB3'),
    document.getElementById('hrCustomB4'),
  ];
  if (!birthYearInput || !rangeSlider) return;

  // Pulzus tartomány állapot (a slider source-of-truth)
  const RANGE_MIN = 35;
  const RANGE_MAX = 220;
  const MIN_GAP   = 30;  // max ≥ rest + 30
  let restValue = 60;
  let maxValue  = 190;

  const init = getHrZoneSettings();
  sexRadios.forEach(r => { r.checked = r.value === init.sex; });
  maxMethodRadios.forEach(r => { r.checked = r.value === init.maxMethod; });
  methodRadios.forEach(r => { r.checked = r.value === init.method; });
  zoneModelRadios.forEach(r => { r.checked = r.value === init.zoneModel; });
  birthYearInput.value = init.birthYear;
  restValue = init.restHR;
  maxValue  = init.maxHR;
  if (lthrSlider) lthrSlider.value = init.lthr;
  if (lthrOut)    lthrOut.textContent = init.lthr;
  customInputs.forEach((inp, i) => { if (inp) inp.value = init.customBoundaries[i]; });

  function currentSex()       { return [...sexRadios].find(r => r.checked)?.value ?? 'male'; }
  function currentMaxMethod() { return [...maxMethodRadios].find(r => r.checked)?.value ?? 'tanaka'; }
  function currentMethod()    { return [...methodRadios].find(r => r.checked)?.value ?? 'karvonen'; }
  function currentZoneModel() { return [...zoneModelRadios].find(r => r.checked)?.value ?? 'friel'; }
  function currentLthr()      { return parseInt(lthrSlider?.value ?? 160, 10); }
  function currentCustomBoundaries() {
    return customInputs.map(inp => parseInt(inp?.value ?? 0, 10));
  }
  function currentAge() {
    const year = parseInt(birthYearInput.value, 10);
    if (!year || isNaN(year)) return 40;
    return Math.max(10, Math.min(100, new Date().getFullYear() - year));
  }

  function updateTanakaLabel() {
    const female = currentSex() === 'female';
    if (tanakaName) tanakaName.textContent = female ? 'Miller' : 'Tanaka';
    if (tanakaEq)   tanakaEq.textContent   = female ? '216 − 1.09 × kor' : '208 − 0.7 × kor';
    if (tanakaHint) tanakaHint.dataset.hint = female
      ? 'Miller (1993): 216 − 1.09 × kor. Nőkre optimalizált, pontosabb mint a Tanaka nőknél.'
      : 'Tanaka (2001): 208 − 0.7 × kor. Meta-analízis alapú, pontosabb aktív felnőtteknél.';
  }

  function updateAgeDisplay() {
    if (ageDisplay) ageDisplay.textContent = `${currentAge()} éves`;
  }

  function rangeValToPct(v) { return (v - RANGE_MIN) / (RANGE_MAX - RANGE_MIN) * 100; }
  function rangePctToVal(p) { return Math.round(RANGE_MIN + p / 100 * (RANGE_MAX - RANGE_MIN)); }

  function renderRangeSlider() {
    if (restValue < RANGE_MIN) restValue = RANGE_MIN;
    if (maxValue  > RANGE_MAX) maxValue  = RANGE_MAX;
    if (maxValue  < restValue + MIN_GAP) maxValue = restValue + MIN_GAP;
    const restPct = rangeValToPct(restValue);
    const maxPct  = rangeValToPct(maxValue);
    if (restHandle)  restHandle.style.left  = restPct + '%';
    if (maxHandle)   maxHandle.style.left   = maxPct  + '%';
    if (activeTrack) { activeTrack.style.left = restPct + '%'; activeTrack.style.width = (maxPct - restPct) + '%'; }
    if (restDisplay) restDisplay.textContent = restValue;
    if (maxDisplay)  maxDisplay.textContent  = maxValue;
  }

  function updateMaxFromMethod() {
    const method = currentMaxMethod();
    if (method === 'custom') {
      maxHandle?.classList.remove('is-disabled');
      if (maxSourceHint) maxSourceHint.textContent = '(egyedi)';
      return;
    }
    // Auto-számítás: max handle nem mozgatható
    maxHandle?.classList.add('is-disabled');
    const val = computeMaxHr(method, currentAge(), currentSex());
    if (val != null) {
      maxValue = Math.max(restValue + MIN_GAP, Math.min(RANGE_MAX, val));
      renderRangeSlider();
      if (maxSourceHint) maxSourceHint.textContent = method === 'tanaka'
        ? (currentSex() === 'female' ? 'Miller' : 'Tanaka')
        : '220 − év';
    }
  }

  /** Zónaszámítási módszer alapján mutatjuk/rejtjük a kapcsolódó vezérlőket. */
  function updateMethodVisibility() {
    const method = currentMethod();
    if (lthrRow)      lthrRow.hidden      = method !== 'lthr';
    if (customRow)    customRow.hidden    = method !== 'custom';
    if (zoneModelRow) zoneModelRow.hidden = method === 'lthr' || method === 'custom';
  }

  function saveAndDispatch() {
    const sex       = currentSex();
    const birthYear = parseInt(birthYearInput.value, 10) || 1985;
    const age       = currentAge();
    const maxMethod = currentMaxMethod();
    const method    = currentMethod();
    const zoneModel = currentZoneModel();
    const lthr      = currentLthr();
    const customBoundaries = currentCustomBoundaries();
    const payload = {
      sex, birthYear, age,
      rest: restValue, max: maxValue, maxMethod,
      method, zoneModel, lthr, customBoundaries,
    };
    localStorage.setItem(HR_ZONES_KEY, JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent('hrZonesChanged', { detail: payload }));
    renderKarvonenZonesList(restValue, maxValue, method, zoneModel, lthr, customBoundaries);
  }

  // Dual-handle slider drag logika
  function attachRangeHandle(handle, isMax) {
    if (!handle) return;
    handle.addEventListener('pointerdown', e => {
      // Auto-mód esetén a max handle nem mozgatható
      if (isMax && currentMaxMethod() !== 'custom') return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      function onMove(ev) {
        const rect = rangeSlider.getBoundingClientRect();
        let pct = (ev.clientX - rect.left) / rect.width * 100;
        pct = Math.max(0, Math.min(100, pct));
        let val = rangePctToVal(pct);
        if (isMax) {
          val = Math.max(restValue + MIN_GAP, Math.min(RANGE_MAX, val));
          maxValue = val;
        } else {
          val = Math.max(RANGE_MIN, Math.min(maxValue - MIN_GAP, val));
          restValue = val;
          // Ha auto-mód aktív, a max-ot újraszámoljuk (rest nem befolyásolja, csak a clamp miatt frissítjük)
        }
        renderRangeSlider();
        // Live update: zónalista is azonnal mutatja
        renderKarvonenZonesList(restValue, maxValue, currentMethod(), currentZoneModel(), currentLthr(), currentCustomBoundaries());
      }
      function onUp() {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        saveAndDispatch();
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }
  attachRangeHandle(restHandle, false);
  attachRangeHandle(maxHandle,  true);

  // ── Multi-slider az egyedi zónahatárokhoz ────────────────────────────────
  const SLIDER_MIN = 40, SLIDER_MAX = 220;
  const ZONE_COLORS = ['#888780', '#1D9E75', '#378ADD', '#EF9F27', '#E24B4A'];
  const sliderEl = document.getElementById('hrMultiSlider');
  const sliderHandles = [];
  const sliderSegments = [];

  function valToPct(v) { return (v - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN) * 100; }
  function pctToVal(p) { return Math.round(SLIDER_MIN + p / 100 * (SLIDER_MAX - SLIDER_MIN)); }

  function updateMultiSlider() {
    if (!sliderEl || sliderSegments.length === 0) return;
    const cb = currentCustomBoundaries();
    const pcts = [0, ...cb.map(valToPct), 100];
    sliderSegments.forEach((seg, i) => {
      seg.style.left  = pcts[i] + '%';
      seg.style.width = (pcts[i + 1] - pcts[i]) + '%';
    });
    sliderHandles.forEach((h, i) => {
      h.style.left = valToPct(cb[i]) + '%';
    });
  }

  function updateZoneDisplay() {
    const el = document.getElementById('hrCustomZoneDisplay');
    if (!el) return;
    const cb = currentCustomBoundaries();
    const ranges = [`0–${cb[0]}`, `${cb[0]}–${cb[1]}`, `${cb[1]}–${cb[2]}`, `${cb[2]}–${cb[3]}`, `${cb[3]}+`];
    el.innerHTML = ZONE_COLORS.map((c, i) =>
      `<span class="hr-czd-item">
        <span class="hr-czd-dot" style="background:${c}"></span>
        <span class="hr-czd-name" style="color:${c}">Z${i + 1}</span>
        <span class="hr-czd-val">${ranges[i]}</span>
      </span>`
    ).join('');
  }

  if (sliderEl) {
    const track = sliderEl.querySelector('.hr-multi-slider-track');
    for (let i = 0; i < 5; i++) {
      const seg = document.createElement('div');
      seg.className = 'hr-multi-slider-segment';
      seg.style.background = ZONE_COLORS[i];
      track.appendChild(seg);
      sliderSegments.push(seg);
    }
    for (let i = 0; i < 4; i++) {
      const h = document.createElement('div');
      h.className = 'hr-multi-slider-handle';
      h.style.borderColor = ZONE_COLORS[i + 1];
      sliderEl.appendChild(h);
      sliderHandles.push(h);
      h.addEventListener('pointerdown', e => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        function onMove(ev) {
          const rect = sliderEl.getBoundingClientRect();
          let pct = (ev.clientX - rect.left) / rect.width * 100;
          pct = Math.max(0, Math.min(100, pct));
          let val = pctToVal(pct);
          const cb = currentCustomBoundaries();
          const minV = i > 0 ? cb[i - 1] + 2 : SLIDER_MIN + 2;
          const maxV = i < 3 ? cb[i + 1] - 2 : SLIDER_MAX - 2;
          val = Math.max(minV, Math.min(maxV, val));
          if (customInputs[i]) customInputs[i].value = val;
          updateMultiSlider();
          updateZoneDisplay();
        }
        function onUp() {
          h.removeEventListener('pointermove', onMove);
          h.removeEventListener('pointerup', onUp);
          saveAndDispatch();
        }
        h.addEventListener('pointermove', onMove);
        h.addEventListener('pointerup', onUp);
      });
    }
    updateMultiSlider();
    updateZoneDisplay();
  }

  /**
   * Form újratöltése a localStorage aktuális tartalmából.
   * Akkor hívódik, amikor a szerver sync friss adatokkal felülírja a localStorage-t
   * (pl. új user bejelentkezés után, miután az IIFE már lefutott a defaults-szal).
   */
  function applySettingsFromStorage() {
    const fresh = getHrZoneSettings();
    sexRadios.forEach(r => { r.checked = r.value === fresh.sex; });
    maxMethodRadios.forEach(r => { r.checked = r.value === fresh.maxMethod; });
    methodRadios.forEach(r => { r.checked = r.value === fresh.method; });
    zoneModelRadios.forEach(r => { r.checked = r.value === fresh.zoneModel; });
    birthYearInput.value = fresh.birthYear;
    restValue = fresh.restHR;
    maxValue  = fresh.maxHR;
    if (lthrSlider) lthrSlider.value = fresh.lthr;
    if (lthrOut)    lthrOut.textContent = fresh.lthr;
    customInputs.forEach((inp, i) => { if (inp) inp.value = fresh.customBoundaries[i]; });
    updateTanakaLabel();
    updateAgeDisplay();
    updateMaxFromMethod();
    renderRangeSlider();
    updateMethodVisibility();
    if (sliderEl) { updateMultiSlider(); updateZoneDisplay(); }
    renderKarvonenZonesList(restValue, maxValue, fresh.method, fresh.zoneModel, fresh.lthr, fresh.customBoundaries);
  }
  window.addEventListener('bringaterv:settingsHydrated', applySettingsFromStorage);

  // Kezdeti renderelés
  updateTanakaLabel();
  updateAgeDisplay();
  updateMaxFromMethod();   // ez állítja be a max handle-t és visibility-t
  renderRangeSlider();
  updateMethodVisibility();
  renderKarvonenZonesList(restValue, maxValue, init.method, init.zoneModel, init.lthr, init.customBoundaries);

  // Eseménykötések
  sexRadios.forEach(r => r.addEventListener('change', () => {
    updateTanakaLabel();
    updateMaxFromMethod();
    saveAndDispatch();
  }));
  birthYearInput.addEventListener('input', () => {
    updateAgeDisplay();
    updateMaxFromMethod();
    saveAndDispatch();
  });
  maxMethodRadios.forEach(r => r.addEventListener('change', () => {
    updateMaxFromMethod();
    saveAndDispatch();
  }));
  methodRadios.forEach(r => r.addEventListener('change', () => {
    updateMethodVisibility();
    saveAndDispatch();
  }));
  zoneModelRadios.forEach(r => r.addEventListener('change', saveAndDispatch));
  lthrSlider?.addEventListener('input', () => {
    if (lthrOut) lthrOut.textContent = currentLthr();
    saveAndDispatch();
  });
  customInputs.forEach(inp => inp?.addEventListener('change', () => {
    updateMultiSlider();
    updateZoneDisplay();
    saveAndDispatch();
  }));
})();

// Panel csúszkák eltávolítva – beállítás csak a Beállítások menüben lehetséges

// ── Sebesség / Kadencia / Teljesítmény zónák (multi-slider beállítások) ──────
// 8 sáv, 7 fogópont. Színátmenet: szürke → kék → cián → zöld → lime → sárga → narancs → piros
const ZONE_COLORS = ['#9CA3AF', '#3B82F6', '#06B6D4', '#22C55E', '#84CC16', '#EAB308', '#F97316', '#EF4444'];
const ZONE_HANDLE_COUNT = 7;   // = ZONE_COLORS.length - 1

const ZONE_CONFIGS = {
  speed: {
    storageKey: 'bringaterv.speedZones',
    defaults: [5, 12, 18, 22, 26, 30, 35],
    unit: 'km/h',
    sliderId: 'speedZoneSlider',
    displayId: 'speedZoneDisplay',
    inputIds: ['speedZoneB1', 'speedZoneB2', 'speedZoneB3', 'speedZoneB4', 'speedZoneB5', 'speedZoneB6', 'speedZoneB7'],
    legendId: 'speedLegend',
  },
  cad: {
    storageKey: 'bringaterv.cadZones',
    defaults: [55, 70, 80, 88, 94, 100, 108],
    unit: 'rpm',
    sliderId: 'cadZoneSlider',
    displayId: 'cadZoneDisplay',
    inputIds: ['cadZoneB1', 'cadZoneB2', 'cadZoneB3', 'cadZoneB4', 'cadZoneB5', 'cadZoneB6', 'cadZoneB7'],
    legendId: 'cadLegend',
  },
  power: {
    storageKey: 'bringaterv.powerZones',
    defaults: [75, 130, 180, 220, 260, 310, 380],
    unit: 'W',
    sliderId: 'powerZoneSlider',
    displayId: 'powerZoneDisplay',
    inputIds: ['powerZoneB1', 'powerZoneB2', 'powerZoneB3', 'powerZoneB4', 'powerZoneB5', 'powerZoneB6', 'powerZoneB7'],
    legendId: 'powerLegend',
  },
};

/** localStorage-ból olvassa a zónahatárokat, defaultokra esik vissza ha hibás/üres. */
function getZoneBoundaries(kind) {
  const cfg = ZONE_CONFIGS[kind];
  if (!cfg) return [];
  try {
    const s = JSON.parse(localStorage.getItem(cfg.storageKey) || 'null');
    if (s?.boundaries?.length === ZONE_HANDLE_COUNT && s.boundaries.every(n => Number.isFinite(n))) {
      return s.boundaries;
    }
  } catch {}
  return [...cfg.defaults];
}

/** Egy érték (sebesség / kadencia / power) színe a felhasználói zónahatárok alapján. */
function getZoneColor(kind, value) {
  if (value == null) return null;
  const b = getZoneBoundaries(kind);
  for (let i = 0; i < b.length; i++) {
    if (value < b[i]) return ZONE_COLORS[i];
  }
  return ZONE_COLORS[b.length];
}

/** Jelmagyarázat (térkép alatti színes legend) újrarajzolása az aktuális határok alapján. */
function rebuildZoneLegend(kind) {
  const cfg = ZONE_CONFIGS[kind];
  if (!cfg) return;
  const legend = document.querySelector(`#${cfg.legendId} .speed-legend-items`);
  if (!legend) return;
  const b = getZoneBoundaries(kind);
  const ranges = [];
  for (let i = 0; i <= ZONE_HANDLE_COUNT; i++) {
    if (i === 0)                          ranges.push(`&lt; ${b[0]} ${cfg.unit}`);
    else if (i === ZONE_HANDLE_COUNT)     ranges.push(`${b[i - 1]}+ ${cfg.unit}`);
    else                                  ranges.push(`${b[i - 1]}–${b[i]} ${cfg.unit}`);
  }
  legend.innerHTML = ZONE_COLORS.map((c, i) =>
    `<div class="speed-legend-item"><span class="speed-dot" style="background:${c}"></span>${ranges[i]}</div>`
  ).join('');
}

/** Generikus multi-slider init: 7 fogópont + 8 színes szegmens + zónacímkék. */
function initZoneMultiSlider(kind) {
  const cfg = ZONE_CONFIGS[kind];
  const sliderEl = document.getElementById(cfg.sliderId);
  const displayEl = document.getElementById(cfg.displayId);
  const inputs = cfg.inputIds.map(id => document.getElementById(id));
  if (!sliderEl || inputs.some(i => !i)) return;

  const SLIDER_MIN = parseInt(sliderEl.dataset.zoneMin, 10);
  const SLIDER_MAX = parseInt(sliderEl.dataset.zoneMax, 10);
  const N = ZONE_HANDLE_COUNT; // 7 fogópont, 8 szegmens

  // Kezdeti értékek betöltése localStorage-ból
  const initial = getZoneBoundaries(kind);
  inputs.forEach((inp, i) => { inp.value = initial[i]; });

  function currentBoundaries() {
    return inputs.map(inp => parseInt(inp.value, 10));
  }
  function valToPct(v) { return (v - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN) * 100; }
  function pctToVal(p) { return Math.round(SLIDER_MIN + p / 100 * (SLIDER_MAX - SLIDER_MIN)); }

  const handles = [];
  const segments = [];
  const track = sliderEl.querySelector('.hr-multi-slider-track');
  for (let i = 0; i <= N; i++) {
    const seg = document.createElement('div');
    seg.className = 'hr-multi-slider-segment';
    seg.style.background = ZONE_COLORS[i];
    track.appendChild(seg);
    segments.push(seg);
  }
  for (let i = 0; i < N; i++) {
    const h = document.createElement('div');
    h.className = 'hr-multi-slider-handle';
    h.style.borderColor = ZONE_COLORS[i + 1];
    sliderEl.appendChild(h);
    handles.push(h);
    h.addEventListener('pointerdown', e => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      function onMove(ev) {
        const rect = sliderEl.getBoundingClientRect();
        let pct = (ev.clientX - rect.left) / rect.width * 100;
        pct = Math.max(0, Math.min(100, pct));
        let val = pctToVal(pct);
        const cb = currentBoundaries();
        const minV = i > 0      ? cb[i - 1] + 1 : SLIDER_MIN;
        const maxV = i < N - 1  ? cb[i + 1] - 1 : SLIDER_MAX;
        val = Math.max(minV, Math.min(maxV, val));
        inputs[i].value = val;
        renderSlider();
        renderZoneDisplay();
        rebuildZoneLegend(kind);
        // Élő újraszínezés a térképen (ha be van töltve a megfelelő geometry)
        if (kind === 'speed' && getImportedColoredGeometry()) mapAdapter.renderColoredRoute(getImportedColoredGeometry());
        if (kind === 'cad'   && getImportedCadGeometry())     mapAdapter.renderCadRoute(getImportedCadGeometry());
        if (kind === 'power' && getImportedPowerGeometry())   mapAdapter.renderPowerRoute(getImportedPowerGeometry());
      }
      function onUp() {
        h.removeEventListener('pointermove', onMove);
        h.removeEventListener('pointerup', onUp);
        saveZones();
      }
      h.addEventListener('pointermove', onMove);
      h.addEventListener('pointerup', onUp);
    });
  }

  function renderSlider() {
    const cb = currentBoundaries();
    const pcts = [0, ...cb.map(valToPct), 100];
    segments.forEach((seg, i) => {
      seg.style.left = pcts[i] + '%';
      seg.style.width = (pcts[i + 1] - pcts[i]) + '%';
    });
    handles.forEach((h, i) => { h.style.left = valToPct(cb[i]) + '%'; });
  }

  function renderZoneDisplay() {
    if (!displayEl) return;
    const cb = currentBoundaries();
    const ranges = [];
    for (let i = 0; i <= N; i++) {
      if (i === 0)      ranges.push(`< ${cb[0]}`);
      else if (i === N) ranges.push(`${cb[i - 1]}+`);
      else              ranges.push(`${cb[i - 1]}–${cb[i]}`);
    }
    // Egység már a szekció címben szerepel (pl. "Sebesség zónák (km/h)") –
    // nem ismételjük zónánként, hogy elférjen 2 oszlopos rácsban
    displayEl.innerHTML = ZONE_COLORS.map((c, i) =>
      `<span class="hr-czd-item">
        <span class="hr-czd-dot" style="background:${c}"></span>
        <span class="hr-czd-name" style="color:${c}">Z${i + 1}</span>
        <span class="hr-czd-val">${ranges[i]}</span>
      </span>`
    ).join('');
  }

  function saveZones() {
    const boundaries = currentBoundaries();
    localStorage.setItem(cfg.storageKey, JSON.stringify({ boundaries }));
    window.dispatchEvent(new CustomEvent('bringaterv:settingChanged', { detail: { kind } }));
  }

  renderSlider();
  renderZoneDisplay();
  rebuildZoneLegend(kind);

  // Egyenlő felosztás gomb: a teljes [SLIDER_MIN, SLIDER_MAX] tartományt
  // 8 egyenlő szegmensre osztja, és a 7 határértéket beállítja
  const resetBtn = document.querySelector(`[data-zone-reset="${kind}"]`);
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      const span = SLIDER_MAX - SLIDER_MIN;
      const step = span / (N + 1);
      for (let i = 0; i < N; i++) {
        inputs[i].value = Math.round(SLIDER_MIN + step * (i + 1));
      }
      renderSlider();
      renderZoneDisplay();
      rebuildZoneLegend(kind);
      saveZones();
      // Élő újraszínezés a térképen
      if (kind === 'speed' && getImportedColoredGeometry()) mapAdapter.renderColoredRoute(getImportedColoredGeometry());
      if (kind === 'cad'   && getImportedCadGeometry())     mapAdapter.renderCadRoute(getImportedCadGeometry());
      if (kind === 'power' && getImportedPowerGeometry())   mapAdapter.renderPowerRoute(getImportedPowerGeometry());
    });
  }

  // Hydration after server sync
  window.addEventListener('bringaterv:settingsHydrated', () => {
    const fresh = getZoneBoundaries(kind);
    inputs.forEach((inp, i) => { inp.value = fresh[i]; });
    renderSlider();
    renderZoneDisplay();
    rebuildZoneLegend(kind);
    if (kind === 'speed' && getImportedColoredGeometry()) mapAdapter.renderColoredRoute(getImportedColoredGeometry());
    if (kind === 'cad'   && getImportedCadGeometry())     mapAdapter.renderCadRoute(getImportedCadGeometry());
    if (kind === 'power' && getImportedPowerGeometry())   mapAdapter.renderPowerRoute(getImportedPowerGeometry());
  });
}

// 3 zóna slider init
initZoneMultiSlider('speed');
initZoneMultiSlider('cad');
initZoneMultiSlider('power');

// ── Diagram színek (solid / zónaszín mód + 4 színválasztó) ───────────────────
const CHART_COLOR_DEFAULTS = {
  mode:  'solid',
  ele:   '#fc4c02',
  speed: '#3B82F6',
  hr:    '#EF4444',
  cad:   '#A855F7',
  power: '#EAB308',
};

/** Lejtés (%) alapú szín – a térképes grade legend színeivel egyezik. */
function gradeColorForGrade(grade) {
  if (grade == null)  return '#9CA3AF';
  if (grade > 8)      return '#7F1D1D';
  if (grade > 4)      return '#DC2626';
  if (grade > 2)      return '#EF4444';
  if (grade > 0.5)    return '#FCA5A5';
  if (grade > -0.5)   return '#9CA3AF';
  if (grade > -2)     return '#86EFAC';
  if (grade > -4)     return '#22C55E';
  if (grade > -8)     return '#15803D';
  return '#14532D';
}

function getChartColors() {
  try {
    const s = JSON.parse(localStorage.getItem('bringaterv.chartColors') || 'null');
    if (s && typeof s === 'object') return { ...CHART_COLOR_DEFAULTS, ...s };
  } catch {}
  return { ...CHART_COLOR_DEFAULTS };
}

(function initChartColorSettings() {
  const modeRadios = document.querySelectorAll('input[name="chartColorMode"]');
  const solidRow   = document.getElementById('chartColorSolidRow');
  const inputs = {
    ele:   document.getElementById('chartColorEle'),
    speed: document.getElementById('chartColorSpeed'),
    hr:    document.getElementById('chartColorHr'),
    cad:   document.getElementById('chartColorCad'),
    power: document.getElementById('chartColorPower'),
  };
  if (!modeRadios.length) return;

  function applyToUI() {
    const cc = getChartColors();
    modeRadios.forEach(r => { r.checked = r.value === cc.mode; });
    for (const k in inputs) if (inputs[k]) inputs[k].value = cc[k];
    if (solidRow) solidRow.style.display = (cc.mode === 'zones') ? 'none' : '';
  }

  function save() {
    const mode = [...modeRadios].find(r => r.checked)?.value ?? 'solid';
    const payload = { mode };
    for (const k in inputs) if (inputs[k]) payload[k] = inputs[k].value;
    localStorage.setItem('bringaterv.chartColors', JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent('bringaterv:settingChanged', { detail: { kind: 'chartColors' } }));
    if (solidRow) solidRow.style.display = (mode === 'zones') ? 'none' : '';
    // Diagramok újrarajzolása az aktuális geometriából
    if (typeof activeGeometry !== 'undefined' && activeGeometry?.length) {
      updateElevationButton(activeGeometry);
    }
  }

  applyToUI();
  modeRadios.forEach(r => r.addEventListener('change', save));
  for (const k in inputs) inputs[k]?.addEventListener('input', save);

  // Hydration after server sync
  window.addEventListener('bringaterv:settingsHydrated', () => {
    applyToUI();
    if (typeof activeGeometry !== 'undefined' && activeGeometry?.length) {
      updateElevationButton(activeGeometry);
    }
  });
})();

// ── Útirány-nyilak toggle ────────────────────────────────────────────────────
(function initDirectionArrowsToggle() {
  const toggle = document.getElementById("directionArrowsToggle");
  if (!toggle) return;
  // Hidratálás localStorage-ból
  toggle.checked = localStorage.getItem("bringaterv.directionArrows") === "true";
  toggle.addEventListener("change", () => {
    localStorage.setItem("bringaterv.directionArrows", String(toggle.checked));
    if (toggle.checked) {
      if (activeGeometry?.length >= 2 && mapAdapter.renderDirectionArrows) {
        mapAdapter.renderDirectionArrows(activeGeometry, 1.5);
      }
    } else {
      mapAdapter.clearDirectionArrows?.();
    }
  });
})();

// ── Kerékpáros profil (fizikai paraméterek a szélhatáshoz / kalóriához) ─────
const CYCLIST_PROFILE_DEFAULTS = { riderKg: 75, bikeKg: 10, position: "road" };

function getCyclistProfile() {
  try {
    const s = JSON.parse(localStorage.getItem("bringaterv.cyclistProfile") || "null");
    if (s && typeof s === "object") return { ...CYCLIST_PROFILE_DEFAULTS, ...s };
  } catch {}
  return { ...CYCLIST_PROFILE_DEFAULTS };
}

(function initCyclistProfileSettings() {
  const riderEl = document.getElementById("profileRiderKg");
  const bikeEl  = document.getElementById("profileBikeKg");
  const posEl   = document.getElementById("profilePosition");
  if (!riderEl || !bikeEl || !posEl) return;

  function applyToUI() {
    const p = getCyclistProfile();
    riderEl.value = p.riderKg;
    bikeEl.value  = p.bikeKg;
    posEl.value   = p.position;
  }
  function save() {
    const payload = {
      riderKg:  parseFloat(riderEl.value) || CYCLIST_PROFILE_DEFAULTS.riderKg,
      bikeKg:   parseFloat(bikeEl.value)  || CYCLIST_PROFILE_DEFAULTS.bikeKg,
      position: posEl.value || CYCLIST_PROFILE_DEFAULTS.position,
    };
    localStorage.setItem("bringaterv.cyclistProfile", JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent("bringaterv:settingChanged", { detail: { kind: "cyclistProfile" } }));
    if (getWindResult()) renderSidebar(store.getState());
  }

  applyToUI();
  [riderEl, bikeEl, posEl].forEach(el => el.addEventListener("change", save));
  window.addEventListener("bringaterv:settingsHydrated", applyToUI);
})();

// Ha a zónák változnak és van betöltött edzés → újraszámoljuk az elemzést + térképszínt
window.addEventListener('hrZonesChanged', () => {
  if (getImportedHrGeometry()) {
    renderHrZoneAnalysis(getImportedHrGeometry());
    mapAdapter.recolorHrRoute(getImportedHrGeometry(), buildHrZoneColorFn());
  }
});

settingsOverlay?.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.hidden = true;
});

// ── Backup / Restore ──────────────────────────────────────────────────────────
(function initBackupRestore() {
  const downloadBtn = document.querySelector("#settingsBackupDownloadBtn");
  const fileInput   = document.querySelector("#settingsRestoreFile");
  const restoreBtn  = document.querySelector("#settingsRestoreBtn");
  const statusEl    = document.querySelector("#settingsRestoreStatus");
  if (!downloadBtn || !fileInput || !restoreBtn) return;

  downloadBtn.addEventListener("click", async () => {
    downloadBtn.disabled = true;
    const oldHtml = downloadBtn.innerHTML;
    downloadBtn.innerHTML = `<span class="spinner-inline"></span> Backup készítése…`;
    try {
      const { blob, filename } = await routesApi.downloadBackup();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Backup hiba: " + err.message);
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = oldHtml;
    }
  });

  fileInput.addEventListener("change", () => {
    restoreBtn.disabled = !fileInput.files[0];
    statusEl.textContent = "";
  });

  restoreBtn.addEventListener("click", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const mode = document.querySelector('input[name="settingsRestoreMode"]:checked')?.value || "merge";
    const confirmMsg = mode === "replace"
      ? "Biztosan teljesen felülírod a jelenlegi profilodat?\n\nA jelenlegi beállításaid, útvonalaid és edzéseid TÖRLŐDNEK, és a backupbeli adatok kerülnek a helyükre.\n\nEz a művelet visszafordíthatatlan!"
      : "Backup hozzáadása a meglévő tartalom mellé?\n\nAz útvonalak új ID-kkel kerülnek be, a beállításaid változatlanok maradnak.";
    if (!confirm(confirmMsg)) return;

    restoreBtn.disabled = true;
    statusEl.textContent = "Visszaállítás folyamatban…";
    try {
      const result = await routesApi.restoreBackup(file, mode);
      statusEl.textContent = `Kész: ${result.routes_added} útvonal, ${result.workouts_added} edzés${result.settings_restored ? ", beállítások visszaállítva" : ""}.`;
      fileInput.value = "";
      // Settings reload mert a szerver oldali változások a localStorage-ot is érintik
      if (mode === "replace") {
        setTimeout(() => location.reload(), 1500);
      }
    } catch (err) {
      statusEl.textContent = "Hiba: " + err.message;
      restoreBtn.disabled = false;
    }
  });
})();

// ── Strava kapcsolat (Settings panel + Library Import dropdown sync) ─────────
let _stravaStatus = null;

async function refreshStravaStatus() {
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
  // User saját app config szekció állapotának frissítése
  await refreshStravaUserAppConfig();
  // Library import dropdown frissítés
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

// ── User saját Strava app credentials (Settings) ──────────────────────────────
async function refreshStravaUserAppConfig() {
  const badge    = document.querySelector("#stravaAppStatusBadge");
  const cidEl    = document.querySelector("#stravaUserClientId");
  const secEl    = document.querySelector("#stravaUserClientSecret");
  const cbEl     = document.querySelector("#stravaUserCallbackInput");
  const cbDomEl  = document.querySelector("#stravaUserCallbackDomain");
  const clearBtn = document.querySelector("#stravaUserAppClearBtn");
  try {
    const cfg = await routesApi.strava.appConfig.get();
    // Status badge a Beállítások panelen
    if (badge) {
      if (cfg.client_id && cfg.secret_set) {
        badge.innerHTML = `<span style="color:#16a34a">✓ Beállítva</span> · Client ID: ${cfg.client_id}`;
      } else {
        badge.innerHTML = `<span style="color:#dc2626">Nincs beállítva</span>`;
      }
    }
    // Modal mezők (csak ha létezik)
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
    setTimeout(() => {
      if (msg) msg.textContent = "";
      closeStravaAppConfigModal();
    }, 600);
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
    // OAuth popup ablak
    const w = 600, h = 800;
    const left = window.screenX + (window.innerWidth - w) / 2;
    const top  = window.screenY + (window.innerHeight - h) / 2;
    const popup = window.open(auth_url, "strava-oauth", `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) {
      alert("A popup-ablakot a böngésző blokkolta. Engedélyezd a popup-okat erre az oldalra.");
      return;
    }
  } catch (err) {
    alert("Strava connect hiba: " + err.message);
  }
}

async function stravaDisconnect() {
  if (!confirm("Biztosan lecsatlakozol a Strava-tól? A bringaterv elveszíti a hozzáférést a Strava-fiókodhoz (de a már importált edzések megmaradnak).")) return;
  try {
    await routesApi.strava.disconnect();
    await refreshStravaStatus();
  } catch (err) {
    alert("Lecsatlakozás hiba: " + err.message);
  }
}

function escapeHtmlStr(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// OAuth popup → parent ablak értesítés a callback HTML-ből
window.addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "strava-oauth") return;
  if (e.data.success) {
    refreshStravaStatus();
    showToast?.(`Strava csatlakoztatva: ${e.data.athlete_name || ""}`);
  } else {
    alert("Strava kapcsolódás sikertelen: " + (e.data.error || "ismeretlen hiba"));
  }
});

// Inicializáció (és újrafutás amikor a user belép)
refreshStravaStatus();
document.querySelector("#stravaUserAppSaveBtn")?.addEventListener("click", saveStravaUserAppConfig);
document.querySelector("#stravaUserAppClearBtn")?.addEventListener("click", clearStravaUserAppConfig);
document.querySelector("#stravaUserAppOpenBtn")?.addEventListener("click", openStravaAppConfigModal);
document.querySelector("#stravaAppConfigCloseBtn")?.addEventListener("click", closeStravaAppConfigModal);
// Overlay-en kívülre kattintásra is záródjon
document.querySelector("#stravaAppConfigOverlay")?.addEventListener("click", (e) => {
  if (e.target.id === "stravaAppConfigOverlay") closeStravaAppConfigModal();
});

// ── Strava import modal ─────────────────────────────────────────────────────
let _stravaActivities = [];

function openStravaImportModal() {
  const overlay = document.querySelector("#stravaImportOverlay");
  if (!overlay) return;
  overlay.hidden = false;
  // Resetelés – induló állapot: nincs lista, footer rejtve, progress bar rejtve
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
  if (range > 0) {
    params.after = Math.floor((Date.now() - range * 86400000) / 1000);
  }
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
    // Időrendben visszafelé: legutolsó edzés legelől
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
  const listEl = document.querySelector("#stravaImportList");
  const runBtn = document.querySelector("#stravaImportRunBtn");
  const summary = document.querySelector("#stravaImportSummary");
  listEl.innerHTML = "";
  for (const a of _stravaActivities) {
    const date = a.start_date ? new Date(a.start_date).toLocaleDateString("hu-HU", { month:"2-digit", day:"2-digit" }) : "—";
    const distKm = a.distance_m ? (a.distance_m / 1000).toFixed(1) : "—";
    const movMin = a.moving_time_s ? Math.round(a.moving_time_s / 60) : "—";
    const isNew    = a.duplicate_status === "new";
    const isLikely = a.duplicate_status === "likely_duplicate";
    const isImported = a.duplicate_status === "already_imported";
    const isDeleted  = a.duplicate_status === "previously_deleted";
    const badgeCls = isNew ? "new" : isImported ? "imported" : isLikely ? "likely" : "deleted";
    const badgeText = isNew ? "Új" : isImported ? "Már megvan" : isLikely ? "Hasonló van" : "Korábban törölted";
    const disabled = isImported;
    const checked  = isNew;
    const row = document.createElement("div");
    row.className = "strava-import-row" + (disabled ? " is-disabled" : "");
    row.dataset.id = a.id;
    row.innerHTML = `
      <input type="checkbox" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}>
      <span class="strava-import-date">${date}</span>
      <span class="strava-import-name">${escapeHtmlStr(a.name || "—")}</span>
      <span class="strava-import-num strava-import-time">${movMin} p</span>
      <span class="strava-import-num strava-import-dist">${distKm} km</span>
      <span class="strava-import-badge strava-import-badge--${badgeCls}">${badgeText}</span>
    `;
    // Klikk a sorra → checkbox toggle
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
  const runBtn = document.querySelector("#stravaImportRunBtn");
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
  const closeBtn    = document.querySelector("#stravaImportClose");
  const checkedRows = [...document.querySelectorAll("#stravaImportList .strava-import-row")]
    .filter(r => r.querySelector('input[type="checkbox"]')?.checked);
  if (checkedRows.length === 0) return;

  // Progress bar megjelenítés, gombok tiltása
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
    const row = checkedRows[i];
    const id = parseInt(row.dataset.id);
    const name = row.querySelector(".strava-import-name")?.textContent || `Activity ${id}`;

    // Aktuális sor kiemelése
    row.classList.add("is-importing");
    progressCur.textContent = `Most: ${name}`;
    progressCur.className   = "strava-progress-current";

    try {
      await routesApi.strava.importActivity(id);
      done++;
      row.classList.remove("is-importing");
      row.style.opacity = "0.55";
      const badge = row.querySelector(".strava-import-badge");
      if (badge) {
        badge.textContent = "Importálva";
        badge.className = "strava-import-badge strava-import-badge--imported";
      }
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) { cb.checked = false; cb.disabled = true; }
    } catch (err) {
      fail++;
      row.classList.remove("is-importing");
      console.error("Strava import hiba:", id, err);
      progressCur.textContent = `Hiba: ${name} – ${err.message}`;
      progressCur.className   = "strava-progress-current is-error";
    }

    // Progress frissítés
    const pct = Math.round(((i + 1) / checkedRows.length) * 100);
    progressBar.style.width = pct + "%";
    progressCnt.textContent = `${i + 1} / ${checkedRows.length}`;

    // Kis pihenő a rate-limit miatt
    if (i < checkedRows.length - 1) {
      await new Promise(r => setTimeout(r, 800));
    }
  }

  // Befejezés
  progressCur.textContent = `Kész: ${done} importálva${fail > 0 ? `, ${fail} hiba` : ""}`;
  progressCur.className   = "strava-progress-current " + (fail > 0 ? "is-error" : "is-success");
  // Frissítsük a könyvtár listát (új edzések megjelennek)
  if (done > 0 && typeof loadRouteLibrary === "function") {
    loadRouteLibrary();
  }
  runBtn.disabled  = false;
  listBtn.disabled = false;
  // A progress bar marad látható befejezés után is, hogy lássák az eredményt
}

// Event listeners – modal
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
  clearImportedGeometries();
  mapAdapter.clearColoredRoute();
  mapAdapter.clearHrRoute();
  mapAdapter.clearCadRoute();
  mapAdapter.clearPowerRoute();
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

// ── Douglas-Peucker rögzítő pont algoritmus ───────────────────────────────────

/** Útvonal-rögzítő pontok toleranciája méterben */
const DP_EPSILON_M = 200;

/** Merőleges távolság méterben (pont a line segment-től), equirectangular közelítéssel */
function _dpPerpendicularDistM(pt, a, b) {
  const R   = 6371000;
  const s   = R * Math.PI / 180;
  const cosL = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  const ax = a.lng * cosL * s, ay = a.lat * s;
  const bx = b.lng * cosL * s, by = b.lat * s;
  const px = pt.lng * cosL * s, py = pt.lat * s;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.sqrt((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2);
}

/**
 * Douglas-Peucker egyszerűsítés – visszaadja a megtartandó indexek rendezett listáját.
 * Iteratív implementáció (nem rekurzív), biztonságos nagy geometriákon is.
 */
function douglasPeuckerIdx(points, epsilonM) {
  const n = points.length;
  if (n <= 2) return points.map((_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi <= lo + 1) continue;
    let maxD = 0, maxI = lo + 1;
    for (let i = lo + 1; i < hi; i++) {
      const d = _dpPerpendicularDistM(points[i], points[lo], points[hi]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilonM) {
      keep[maxI] = 1;
      stack.push([lo, maxI], [maxI, hi]);
    }
  }
  const result = [];
  for (let i = 0; i < n; i++) if (keep[i]) result.push(i);
  return result;
}

/**
 * Anchor waypontok összeállítása D-P indexekből.
 * Ha van surface-analysis eredmény (segments), minden pont megkapja
 * a saját szegmensének módját (BRouter per-segment profilehoz szükséges).
 *
 * @param {number[]}  dpIndices  – douglasPeuckerIdx() eredménye
 * @param {object}    imported   – importGpx() eredménye
 * @param {Array|null} segments  – analyzeSurface() szegmensei (opcionális)
 */
function buildAnchorWaypoints(dpIndices, imported, segments = null) {
  const geo      = imported.geometry;
  const origStart = imported.waypoints[0];
  const origEnd   = imported.waypoints[imported.waypoints.length - 1];

  // DP indexek + surface átmeneti pontok egyesítése
  const idxSet = new Set(dpIndices);
  if (segments) {
    for (const seg of segments) idxSet.add(seg.geomIdx);
  }
  const sortedIdx = [...idxSet].sort((a, b) => a - b);

  return sortedIdx.map(idx => {
    const pt      = geo[idx];
    const isFirst = idx === 0;
    const isLast  = idx === geo.length - 1;

    // Meghatározzuk melyik surface szegmensbe esik ez a pont
    // → hogy a BRouter a helyes profillal tervezzen
    let mode = null;
    if (segments && segments.length > 0) {
      for (let s = segments.length - 1; s >= 0; s--) {
        if (idx >= segments[s].geomIdx) { mode = segments[s].mode; break; }
      }
    }

    return {
      lat:         pt.lat,
      lng:         pt.lng,
      name:        isFirst ? (origStart?.name ?? "") : isLast ? (origEnd?.name ?? "") : "",
      note:        isFirst ? (origStart?.note ?? "") : isLast ? (origEnd?.note ?? "") : "",
      segmentMode: mode,
    };
  });
}

// ── Névtelen waypontok geokódolása (háttér) ───────────────────────────────────

/**
 * A store-ban lévő, névtelen waypontokat sorra megnevezi Nominatim
 * fordított geokódolással. Tűz-és-elfelejt (nem kell await-elni).
 * 120 ms szünet van minden kérés között a rate limit betartásához.
 */
async function geocodeNamelessWaypoints() {
  const toGeocode = store.getState().waypoints.filter(wp => !wp.name);
  for (const wp of toGeocode) {
    if (!store.getState().waypoints.some(w => w.id === wp.id)) continue;
    const name = await reverseGeocode(wp.lat, wp.lng);
    if (name && store.getState().waypoints.some(w => w.id === wp.id)) {
      store.updateWaypoint(wp.id, { name });
    }
    await new Promise(r => setTimeout(r, 120));
  }
}

// ── GPX betöltés előnézet + szegmensvizsgálat modal ──────────────────────────

/**
 * Megmutatja az import előnézeti modalt és opcionálisan futtatja
 * az OSM felületelemzést. Promise alapú: a hívó await-el vár rá.
 *
 * @param {object} imported        – importGpx() eredménye
 * @param {string} routeName       – megjelenítendő név
 * @param {number} distanceMeters  – előre kalkulált távolság
 * @param {number} ascentMeters    – előre kalkulált emelkedő
 * @returns {Promise<Array|null>}  – waypontok (esetleg segmentMode-dal),
 *                                   vagy null ha a felhasználó X-szel bezárja
 */
function showLoadPreview(imported, routeName, distanceMeters, ascentMeters) {
  return new Promise((resolve) => {
    const overlay        = document.getElementById("loadPreviewOverlay");
    const titleEl        = document.getElementById("loadPreviewTitle");
    const statsEl        = document.getElementById("loadPreviewStats");
    const segExistingEl  = document.getElementById("loadPreviewSegExisting");
    const analysisEl     = document.getElementById("loadPreviewAnalysisResult");
    const analyzeBtn     = document.getElementById("loadPreviewAnalyzeBtn");
    const analyzeHint    = overlay.querySelector(".load-preview-analyze-hint");
    const skipBtn        = document.getElementById("loadPreviewSkipBtn");
    const confirmBtn     = document.getElementById("loadPreviewConfirmBtn");
    const closeBtn       = document.getElementById("loadPreviewClose");
    const anchorSection  = document.getElementById("loadPreviewAnchorSection");
    const anchorCheck    = document.getElementById("loadPreviewAnchorCheck");
    const anchorCountEl  = document.getElementById("loadPreviewAnchorCount");

    // --- reset ---
    analysisEl.hidden  = true;
    analysisEl.innerHTML = "";
    analyzeBtn.hidden  = false;
    analyzeBtn.disabled = false;
    confirmBtn.disabled = true;
    analyzeHint.hidden  = false;

    // --- Rögzítő pontok szekció ---
    // Csak akkor mutatjuk ha van elegendő geometria és kevés az eredeti waypont
    const geoLen = imported.geometry.length;
    const showAnchor = geoLen >= 20 && imported.waypoints.length <= 4;
    anchorSection.hidden = !showAnchor;
    if (showAnchor) {
      anchorCheck.checked = true;
      const dpIdx = douglasPeuckerIdx(imported.geometry, DP_EPSILON_M);
      const intermediateCount = dpIdx.length - 2; // start és finish nem számít újnak
      anchorCountEl.textContent = `(~${intermediateCount} köztes pont)`;
    }

    // --- cím ---
    titleEl.textContent = routeName || "Útvonal betöltése";

    // --- statisztikák ---
    const distKm = distanceMeters > 0 ? (distanceMeters / 1000).toFixed(1) : "—";
    const ascStr = ascentMeters  > 0 ? `${Math.round(ascentMeters)} m` : "—";
    statsEl.innerHTML = `
      <div class="load-preview-stat">
        <span class="load-preview-stat-label">Távolság</span>
        <span class="load-preview-stat-value">${distKm} km</span>
      </div>
      <div class="load-preview-stat">
        <span class="load-preview-stat-label">Waypont</span>
        <span class="load-preview-stat-value">${imported.waypoints.length} db</span>
      </div>
      <div class="load-preview-stat">
        <span class="load-preview-stat-label">Emelkedő</span>
        <span class="load-preview-stat-value">${ascStr}</span>
      </div>
      <div class="load-preview-stat">
        <span class="load-preview-stat-label">Trackpont</span>
        <span class="load-preview-stat-value">${imported.geometry.length}</span>
      </div>`;

    // --- meglévő segmentMode info ---
    const existingModes = imported.waypoints.filter(w => w.segmentMode != null);
    if (existingModes.length > 0) {
      const modeSet = [...new Set(existingModes.map(w => w.segmentMode))];
      segExistingEl.innerHTML =
        `<i data-lucide="info" aria-hidden="true"></i> Mentett módok: ${modeSet.map(m => MODE_LABELS[m] ?? m).join(", ")}`;
      segExistingEl.hidden = false;
    } else {
      segExistingEl.hidden = true;
    }

    overlay.hidden = false;
    if (typeof lucide !== "undefined") lucide.createIcons();

    let resolvedResult  = null; // { waypoints, segmentedGeom, _segments }
    let latestSegments  = null; // surface analysis szegmensek (D-P merge-hez confirm-kor)

    function close(result) {
      overlay.hidden = true;
      closeBtn.onclick   = null;
      skipBtn.onclick    = null;
      confirmBtn.onclick = null;
      analyzeBtn.onclick = null;
      resolve(result);
    }

    /** D-P anchor waypontokat ad vissza, vagy az eredeti waypontokat ha nincs elég geometria */
    function applyAnchor(segments = null) {
      if (showAnchor && anchorCheck.checked) {
        const dpIdx = douglasPeuckerIdx(imported.geometry, DP_EPSILON_M);
        return buildAnchorWaypoints(dpIdx, imported, segments);
      }
      // Anchor nélkül: ha van surface analysis → az adja a waypontokat
      if (segments) {
        const origStart = imported.waypoints[0];
        const origEnd   = imported.waypoints[imported.waypoints.length - 1];
        const wps = [{ ...origStart, segmentMode: segments[0]?.mode ?? null }];
        for (let i = 1; i < segments.length; i++) {
          const pt = segments[i].geomPoint;
          wps.push({ lat: pt.lat, lng: pt.lng, name: "", note: "", segmentMode: segments[i].mode });
        }
        wps.push({ ...origEnd, segmentMode: null });
        return wps;
      }
      return imported.waypoints;
    }

    closeBtn.onclick   = () => close(null);
    skipBtn.onclick    = () => close({ waypoints: applyAnchor(null), segmentedGeom: null });
    confirmBtn.onclick = () => {
      if (!resolvedResult) return;
      const waypoints = applyAnchor(latestSegments);
      close({ waypoints, segmentedGeom: resolvedResult.segmentedGeom });
    };

    analyzeBtn.onclick = async () => {
      analyzeBtn.disabled = true;
      analyzeHint.hidden  = true;
      analysisEl.hidden   = false;
      analysisEl.innerHTML = `<div class="load-preview-spinner">
        <span class="spinner-inline"></span> OSM adatok lekérdezése…
      </div>`;

      try {
        const { segments, totalDistKm } = await analyzeSurface(imported.geometry);

        // ── Vizuális útvonalsáv ────────────────────────────────────────────
        const barSegs = segments.map(seg => {
          const pct = (seg.distanceKm / totalDistKm * 100).toFixed(1);
          const color = SEGMENT_COLORS[seg.mode] ?? "#888";
          return `<div class="load-preview-bar-seg" style="width:${pct}%;background:${color}"
            title="${MODE_LABELS[seg.mode] ?? seg.mode}: ${seg.fromKm.toFixed(1)}–${seg.toKm.toFixed(1)} km"></div>`;
        }).join("");

        // ── Összesítés módok szerint ───────────────────────────────────────
        const modeSummary = {};
        for (const seg of segments) {
          modeSummary[seg.mode] = (modeSummary[seg.mode] ?? 0) + seg.distanceKm;
        }

        const rows = segments.map(seg => `
          <div class="load-preview-analysis-row">
            <div class="load-preview-analysis-dot" style="background:${SEGMENT_COLORS[seg.mode] ?? "#888"}"></div>
            <span class="load-preview-analysis-mode">${MODE_LABELS[seg.mode] ?? seg.mode}</span>
            <span class="load-preview-analysis-dist">${seg.fromKm.toFixed(1)}–${seg.toKm.toFixed(1)} km</span>
            <span class="load-preview-analysis-pct">${seg.distanceKm.toFixed(1)} km</span>
          </div>`).join("");

        const insertCount = segments.length - 1; // közbenső waypontok száma
        analysisEl.innerHTML = `
          <div class="load-preview-bar">${barSegs}</div>
          <div class="load-preview-analysis-header">Szegmensek (${segments.length} db)</div>
          <div class="load-preview-analysis-rows">${rows}</div>
          <p class="load-preview-analyze-hint" style="padding:8px 12px;border-top:1px solid var(--line)">
            Alkalmazáskor ${insertCount > 0 ? `${insertCount} közbenső waypont kerül beillesztésre` : "a mód beállítódik"} az átmeneti pontoknál.
          </p>`;

        // ── Waypontok összeállítása az elemzés alapján ────────────────────
        // ── Szegmentált térkép-geometria (renderSegmentedRoute-hoz) ──────
        const segmentedGeom = segments.map((seg, i) => {
          const startIdx = seg.geomIdx;
          const endIdx   = i + 1 < segments.length
            ? segments[i + 1].geomIdx
            : imported.geometry.length - 1;
          return {
            mode:     seg.mode,
            geometry: imported.geometry.slice(startIdx, endIdx + 1),
          };
        });

        latestSegments = segments; // confirmBtn-hoz szükséges (D-P merge)
        resolvedResult = { segmentedGeom };
        confirmBtn.disabled = false;
        if (typeof lucide !== "undefined") lucide.createIcons();

      } catch (err) {
        console.error("Surface analysis hiba:", err);
        analysisEl.innerHTML = `<div class="load-preview-spinner" style="color:var(--error,#e53935)">
          Nem sikerült az elemzés: ${err.message}
        </div>`;
        analyzeBtn.disabled = false;
        analyzeHint.hidden  = false;
      }
    };
  });
}

/**
 * Vegyes tervezési módoknál szegmensenként számolja az időt, majd összegzi.
 * Ha nincs szegmens adat (pl. egységes mód, importált útvonal), visszaesik
 * a teljes távolság + globális mód alapú számításra.
 *
 * @param {Array}   segments         – store.routeSegments tömb
 * @param {string}  globalMode       – a globális tervezési mód (fallback)
 * @param {number}  totalDistKm      – teljes távolság km-ben (fallback)
 * @param {number}  totalAscM        – teljes emelkedő méterben (fallback)
 * @param {number}  totalDescM       – teljes süllyedő méterben (fallback)
 * @param {boolean} elevationEnabled – figyelembe vegye-e a szintet
 * @returns {number} percek (egész szám)
 */
function calcEstimatedTimeMixed(segments, globalMode, totalDistKm, totalAscM, totalDescM, elevationEnabled = true) {
  if (segments && segments.length > 0) {
    return segments.reduce((sum, seg) => {
      const segDistKm = (seg.distanceMeters ?? 0) / 1000;
      const segAsc    = elevationEnabled ? (seg.ascentMeters  ?? 0) : 0;
      const segDesc   = elevationEnabled ? (seg.descentMeters ?? 0) : 0;
      return sum + calcEstimatedTime(segDistKm, segAsc, segDesc, seg.mode ?? globalMode);
    }, 0);
  }
  return calcEstimatedTime(totalDistKm, totalAscM, totalDescM, globalMode);
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

  // Becsült időtartam – szegmensenként ha vegyes mód, egyébként Naismith-formula
  const durationMin = distanceKm != null
    ? calcEstimatedTimeMixed(state.routeSegments, selectedMode, distanceKm, ascentMeters, descentMeters, true)
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

/**
 * Egy importálandó fájl (GPX vagy FIT) feldolgozása.
 * FIT-et bemenettől konvertál GPX-szé memóriában; az eredeti FIT buffer-t
 * tárolja a `importedFitBuffer` változóban (későbbi `.fit` mellé-mentéshez).
 */
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

  const { ascentMeters } = calcElevationFromGeometry(imported.geometry);
  const distanceMeters   = calculateImportedDistance(imported.geometry);
  const routeName        = file.name.replace(/\.gpx$/i, "");

  const loadResult = await showLoadPreview(imported, routeName, distanceMeters, ascentMeters);
  planGpxInput.value = "";
  if (loadResult === null) return; // X-szel bezárva
  const { waypoints, segmentedGeom } = loadResult;

  store.replaceWaypoints(waypoints, { importedRoute: true });
  updateElevationButton(imported.geometry);
  if (segmentedGeom) {
    mapAdapter.renderSegmentedRoute(segmentedGeom, { fitView: true });
  } else {
    mapAdapter.renderRoute(imported.geometry, store.getState().mode);
  }
  showToast(`${waypoints.length} pont betöltve`);
  geocodeNamelessWaypoints(); // névtelen anchor pontok elnevezése háttérben
});

// ── Elemzés → Tervezés ez alapján ────────────────────────────────────────────
document.querySelector("#planFromFileBtn")?.addEventListener("click", () => {
  // A waypontok már a store-ban vannak (az import feltöltötte)
  // Csak az elemzés-specifikus állapotot töröljük, majd váltunk
  clearImportedGeometries();
  mapAdapter.clearColoredRoute();
  mapAdapter.clearHrRoute();
  mapAdapter.clearCadRoute();
  mapAdapter.clearPowerRoute();
  mapAdapter.clearGradeRoute();
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

  if (target === "file") {
    clearAllRouteState();
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
    const hasPower = imported.geometry.some(p => p.power != null);

    setImportedGeometries({
      colored: hasSpeed ? imported.geometry : null,
      hr:      hasHr    ? imported.geometry : null,
      cad:     hasCad   ? imported.geometry : null,
      power:   hasPower ? imported.geometry : null,
    });

    updateElevationButton(imported.geometry);
    applyRouteLayer(null);
    mapAdapter.renderRoute(imported.geometry, store.getState().mode);

    setLoadedRoute(id, routeName, gpxText);
    updateFileSaveButtonState();
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
    const { ascentMeters: asc } = calcElevationFromGeometry(imported.geometry);
    const distMeters = calculateImportedDistance(imported.geometry);

    const loadResult = await showLoadPreview(imported, routeName, distMeters, asc);
    if (loadResult === null) return; // felhasználó X-szel bezárta
    const { waypoints, segmentedGeom } = loadResult;

    clearAllRouteState();
    switchTab("plan");
    autoOpenElevation = true;
    store.replaceWaypoints(waypoints, {
      geometry: imported.geometry,
      sourcePointCount: imported.sourcePointCount,
    });
    if (segmentedGeom) {
      mapAdapter.renderSegmentedRoute(segmentedGeom, { fitView: true });
    } else {
      mapAdapter.renderRoute(imported.geometry, store.getState().mode);
    }
    if (imported.sourcePointCount > imported.geometry.length) {
      showToast(`„${routeName}" betöltve – ${imported.sourcePointCount} pont → ${imported.geometry.length} jelenik meg`, 5000);
    } else {
      showToast(`„${routeName}" betöltve`);
    }
    geocodeNamelessWaypoints(); // névtelen anchor pontok elnevezése háttérben
  }
}

/**
 * Perceket olvasható formátumra alakít a könyvtár kártyákhoz.
 * @param {number|null} minutes
 * @returns {string}  pl. "3 ó 20 p" vagy ""
 */
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
// Szélhatás toggle: ha be van kapcsolva és van wind eredmény, alkalmazódik a szorzó
document.querySelector('#planWindTimeToggle')?.addEventListener('change', () => {
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

  const toggleNav = () => {
    const nextCollapsed = !elements.appShell.classList.contains("is-nav-collapsed");
    elements.appShell.classList.toggle("is-nav-collapsed", nextCollapsed);
    localStorage.setItem("route4meNavCollapsed", String(nextCollapsed));
    updateNavToggle();
    setTimeout(() => mapAdapter.invalidateSize(), 210);
  };

  elements.navToggle.addEventListener("click", toggleNav);
  document.getElementById("railNavToggle")?.addEventListener("click", toggleNav);
}

function updateNavToggle() {
  const isCollapsed = elements.appShell.classList.contains("is-nav-collapsed");
  const label = i18n.t(isCollapsed ? "nav.expand" : "nav.collapse");
  const icon  = isCollapsed ? "panel-left-open" : "panel-left-close";
  const railBtn = document.getElementById("railNavToggle");
  for (const btn of [elements.navToggle, railBtn]) {
    if (!btn) continue;
    btn.title = label;
    btn.ariaLabel = label;
    btn.setAttribute("aria-expanded", String(!isCollapsed));
    btn.innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i>`;
  }
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

/**
 * Szakaszonkénti távolságot számol minden szomszédos waypoint pár között,
 * a tényleges route geometria alapján (haversine összegezve).
 * Visszaad: tömb, hossza = waypoints.length - 1.
 */
function computeWaypointSegmentDistances(state) {
  const wps  = state.waypoints || [];
  const geom = state.routeGeometry || [];
  const N    = wps.length;
  if (N < 2) return [];

  // Ha van per-segment routing eredmény (mixed mode), abból olvassuk
  if (state.routeSegments?.length === N - 1 && state.routeSegments[0]?.distanceMeters != null) {
    return state.routeSegments.map(s => s.distanceMeters);
  }

  // Egyébként: minden waypointhoz megkeressük a legközelebbi geometria-indexet (monoton),
  // és a köztük lévő haversine távolságot összegezzük.
  if (geom.length < 2) {
    // Nincs geometria → légvonal becsült távolság
    return wps.slice(1).map((b, i) => haversineMeters(wps[i], b));
  }

  // Kumulatív távolság a geometrián
  const cumDist = new Array(geom.length).fill(0);
  for (let i = 1; i < geom.length; i++) {
    cumDist[i] = cumDist[i - 1] + haversineMeters(geom[i - 1], geom[i]);
  }

  // Minden waypointhoz a legközelebbi geometria-index (kereső pointerrel, monoton)
  const wpIdx = new Array(N);
  let searchFrom = 0;
  for (let w = 0; w < N; w++) {
    const wp = wps[w];
    let bestI = searchFrom, bestD = Infinity;
    for (let i = searchFrom; i < geom.length; i++) {
      const d = haversineMeters(wp, geom[i]);
      if (d < bestD) { bestD = d; bestI = i; }
      // Optimalizáció: ha már messzebb vagyunk és a távolság elkezd nőni, megállhatunk.
      // Egyelőre lineáris végigjárás – elég gyors (geom max ~2000 pont).
    }
    wpIdx[w] = bestI;
    searchFrom = bestI;  // monoton: a következő waypoint nem lehet előbb
  }

  const result = [];
  for (let w = 1; w < N; w++) {
    result.push(Math.max(0, cumDist[wpIdx[w]] - cumDist[wpIdx[w - 1]]));
  }
  return result;
}

function haversineMeters(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

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
      let mins     = calcEstimatedTimeMixed(
        state.routeSegments, state.mode ?? 'asphalt',
        distKm, ascM, descM, elevationTimeEnabled
      );
      // Szélhatás: ha be van kapcsolva és van eredmény, alkalmazzuk a szorzót
      const windToggle = document.querySelector('#planWindTimeToggle');
      if (windToggle?.checked && getWindResult()) {
        const planned = parseFloat(elements.windAvgSpeedPlan?.value) || defaultAvgSpeed(state.mode);
        const profile = { ...getCyclistProfile(), routeMode: state.mode ?? "asphalt" };
        const mul = windTimeMultiplier(getWindResult().segments, planned, profile);
        mins = Math.round(mins * mul);
      }
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      elements.estimatedTimeValue.textContent = h > 0
        ? `${h} ó ${m > 0 ? m + ' p' : ''}`
        : `${m} p`;
    }
  }


  // Szakasz-távolságok kiszámítása: vagy per-segment (mixed mode) vagy a geometriából
  const wpSegDistances = computeWaypointSegmentDistances(state);

  state.waypoints.forEach((point, index) => {
    // Szakaszhossz az előző waypointtól (a 0. előtt nincs)
    if (index > 0 && wpSegDistances[index - 1] > 0) {
      const segDist = wpSegDistances[index - 1];
      const distLabel = document.createElement("li");
      distLabel.className = "waypoint-segment-label";
      distLabel.innerHTML = `<span class="waypoint-segment-arrow">↓</span><span class="waypoint-segment-dist">${formatDisplayDistance(segDist)}</span>`;
      elements.waypointList.append(distLabel);
    }

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
    const btn = e.target.closest(".hint-btn, .hint-target");
    if (btn && btn !== activeBtn) showTooltip(btn);
  });

  document.addEventListener("mouseout", (e) => {
    if (e.target.closest(".hint-btn, .hint-target")) hideTooltip();
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
  const CURRENT_VER = "8"; // bump ha új szekció kerül az alapból-csukott halmazba
  const ALL_SECTIONS = ['mapStyle', 'units', 'planningDefaults', 'startView', 'toolbarOrder', 'hrZones'];

  function saveCollapsed(set) {
    localStorage.setItem(LS_KEY, JSON.stringify([...set]));
  }

  function loadCollapsed() {
    const saved   = localStorage.getItem(LS_KEY);
    const version = localStorage.getItem(LS_VER_KEY);
    // Első látogatás VAGY verzió változás → minden szekció becsukva alapból
    if (saved === null || version !== CURRENT_VER) {
      localStorage.setItem(LS_VER_KEY, CURRENT_VER);
      const defaultSet = new Set(ALL_SECTIONS);
      saveCollapsed(defaultSet); // ← mentés is, ne csak memóriában legyen
      return defaultSet;
    }
    try { return new Set(JSON.parse(saved) || []); }
    catch { return new Set(); }
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

