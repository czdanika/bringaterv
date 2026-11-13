/**
 * Bringaterv – File Tab Module
 * =============================
 * Elemzés fül: fájl import (GPX/FIT), statisztikák, share card modal.
 *
 * Init:
 *   import { initFileTab } from './ui/fileTab.js';
 *   initFileTab({ store, mapAdapter, api, elements, i18n, showToast, switchTab,
 *                 updateElevationButton, applyRouteLayer, clearWindResult,
 *                 calculateImportedDistance, calcEstimatedTimeMixed,
 *                 loadRouteLibrary, openExportModal, renderHrZoneAnalysis,
 *                 formatDisplayDistance });
 */

import { importGpx, exportGpx, calcElevationFromGeometry } from '../gpx/gpx.js';
import { fitToGpx, fitHasPosition } from '../gpx/fit.js';
import { equipmentLine, sensorLabels } from '../equipment.js';
import { isSolidChartMode } from './elevationProfile.js';
import { createWorkoutShareCard, downloadShareCard, shareCardPoints, SHARE_LAYOUTS, SHARE_CHARTS, availableShareCharts, SHARE_STATS, DEFAULT_STATS, LAYOUT_CAPS } from './shareCard.js';
import { VIDEO_BGS, VIDEO_MAPS, VIDEO_DURATIONS, videoSupported, videoFormat, createVideoScene, playScene, recordScene, loadVideoMedia } from './shareVideo.js';
import { getShareHighlights } from './bestEfforts.js';
import { getWorkoutWind } from './workoutWind.js';
import { reverseGeocode } from './search.js';
import { openShareModal } from './shareModal.js';
import { openRoutePdfModal, shareRouteUrl, ensureLinkPublic } from './routePdfModal.js';
import { num, int, durMs } from "../format.js";
import { estimateKcal, hrTimeStats, keytelCalibration, keytelKcal, powerKcal } from "../calories.js";
import { getCyclistProfile, getHrZoneSettings } from "./settings.js";
import { renderZoneDists } from "./zoneDist.js";

// ── Injektált függőségek ──────────────────────────────────────────────────────
let _store, _mapAdapter, _api, _elements, _i18n, _showToast, _switchTab;
let _updateElevationButton, _applyRouteLayer, _clearWindResult;
let _calculateImportedDistance, _calcEstimatedTimeMixed;
let _openLibraryRoute;
let _loadRouteLibrary, _openExportModal, _renderHrZoneAnalysis, _formatDisplayDistance;

export function initFileTab({
  store, mapAdapter, api, elements, i18n, showToast, switchTab,
  updateElevationButton, applyRouteLayer, clearWindResult,
  calculateImportedDistance, calcEstimatedTimeMixed,
  loadRouteLibrary, openExportModal, renderHrZoneAnalysis, formatDisplayDistance,
  openLibraryRoute,
}) {
  _store = store; _mapAdapter = mapAdapter; _api = api; _elements = elements;
  _i18n = i18n; _showToast = showToast; _switchTab = switchTab;
  _updateElevationButton = updateElevationButton; _applyRouteLayer = applyRouteLayer;
  _clearWindResult = clearWindResult;
  _calculateImportedDistance = calculateImportedDistance;
  _calcEstimatedTimeMixed = calcEstimatedTimeMixed;
  _loadRouteLibrary = loadRouteLibrary; _openExportModal = openExportModal;
  _renderHrZoneAnalysis = renderHrZoneAnalysis; _formatDisplayDistance = formatDisplayDistance;
  _openLibraryRoute = openLibraryRoute;

  // File input
  _elements.gpxInput.addEventListener("change", async () => {
    const [file] = _elements.gpxInput.files;
    if (!file) return;
    await processImportedFile(file);
    _elements.gpxInput.value = "";
  });

  // Drag & drop
  {
    let dragCounter = 0;
    function isFileDrag(e) {
      return e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
    }
    window.addEventListener("dragenter", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragCounter++;
      document.body.classList.add("is-drag-over");
    });
    window.addEventListener("dragover", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("dragleave", (e) => {
      if (!isFileDrag(e)) return;
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) document.body.classList.remove("is-drag-over");
    });
    window.addEventListener("drop", async (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragCounter = 0;
      document.body.classList.remove("is-drag-over");
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      if (!/\.(gpx|fit)$/i.test(file.name)) {
        _showToast("Csak .gpx és .fit fájl tölthető be.");
        return;
      }
      await processImportedFile(file);
    });
  }

  // Üres állapot kattintás
  document.querySelector("#fileEmptyState")?.addEventListener("click", () => _elements.gpxInput.click());

  // File export gomb
  _elements.fileExportButton?.addEventListener("click", () => _openExportModal());

  // Mentés a könyvtárba gomb
  _elements.fileSaveToLibraryButton?.addEventListener("click", () => saveImportedToLibrary());

  // Share Card modal
  _initShareCardModal();
}

/** Az Elemzés fülön betöltött fájl mentése a könyvtárba (Edzések közé).
 *  Visszaadja az új azonosítót, hiba esetén null-t. A „Mentés könyvtárba"
 *  gomb és a Megosztás ablak „Mentés és link" opciója is ezt hívja. */
async function saveImportedToLibrary() {
  const btn = _elements.fileSaveToLibraryButton;
  if (btn?.disabled) return null;
  if (btn) {
    btn.disabled = true;
    const lbl = btn.querySelector("span");
    if (lbl) lbl.textContent = "Mentés…";
  }
  const state = _store.getState();
  // a fájlban tárolt edzésnév (pl. „Délutáni kerékpározás”), ha nincs: a fájlnév
  const meta = _importedMeta || {};
  const name = (meta.name || "").trim() || _importedFileName || "Edzés";

  const content = _importedGpxText ?? exportGpx({
    waypoints: state.waypoints,
    geometry:  state.routeGeometry,
    name,
    desc: "",
    mode: state.mode,
  });

  const distanceKm = state.distanceMeters > 0
    ? Math.round(state.distanceMeters / 100) / 10
    : null;
  const ascentMeters  = state.ascentMeters  > 0 ? state.ascentMeters  : null;
  const descentMeters = state.descentMeters > 0 ? state.descentMeters : 0;
  // felvett edzésnél a valódi mozgásidő (ennek híján a teljes idő); időadat nélkül a tervezési becslés
  const recordedMs = meta.movingDuration || meta.totalDuration || 0;
  const durationMin = recordedMs > 0 ? Math.round(recordedMs / 60000)
    : distanceKm != null
      ? _calcEstimatedTimeMixed(state.routeSegments, state.mode ?? 'asphalt', distanceKm, ascentMeters ?? 0, descentMeters, true)
      : null;
  const startTime = meta.startTime ? new Date(meta.startTime) : null;

  let fitContent = null;
  if (_importedFitBuffer) {
    fitContent = arrayBufferToBase64(_importedFitBuffer);
  }

  // edzés csak az, amit rögzítettek: FIT, indulási idő, vagy időbélyeges pontok. Egy letöltött /
  // tervezett útvonal (időadat nélkül) tervként kerül a könyvtárba – nem a statisztikába, rekordok közé
  const geo = state.routeGeometry || [];
  const recorded = !!fitContent || !!(startTime && !Number.isNaN(startTime.getTime()))
    || geo.filter((p) => p.time != null).length >= 4;
  const planType = ["gravel", "mtb", "hiking", "walking"].includes(state.mode) ? state.mode : "asphalt";

  try {
    const saved = await _api.saveRoute({
      name,
      gpxContent:  content,
      fitContent,
      distance:    distanceKm,
      duration:    durationMin,
      elevation:   ascentMeters,
      type:        recorded ? "workout" : planType,
      description: "",
      include_in_stats: recorded,
      // a dátum az edzés napja legyen, ne a mentésé (statisztika, Kezdőlap, könyvtár)
      startTime:   startTime && !Number.isNaN(startTime.getTime()) ? startTime.toISOString() : null,
    });
    _showToast(recorded
      ? `„${name}" mentve az Edzések közé${fitContent ? " (FIT-tel)" : ""}`
      : `„${name}" mentve a Tervek közé – nincs benne időadat, ezért nem edzés (nem kerül a statisztikába)`, recorded ? undefined : 6000);
    _loadedLibraryRouteId = saved?.id || saved?.route?.id || "saved";
    _loadedIsSample = false;
    updateFileSaveButtonState();
    if (typeof _loadRouteLibrary === "function") _loadRouteLibrary();
    return _loadedLibraryRouteId;
  } catch (err) {
    console.error("Edzés mentési hiba:", err);
    _showToast(err.message || "Nem sikerült menteni. Az API elérhető?");
    if (btn) {
      btn.disabled = false;
      const lbl = btn.querySelector("span");
      if (lbl) lbl.textContent = "Mentés";
    }
  }
  return null;
}

// ── Modul-szintű state ────────────────────────────────────────────────────────
let _hasImportedFile = false;
let _importedFileName = "";
let _importedMeta = null;
let _importedPeakPower = null;  // csúcsteljesítmény a teljes (ritkítás előtti) adatból       // a betöltött fájl metaadatai (név, kezdés, mozgásidő) – mentéshez
let _importedGpxText  = null;
let _importedFitBuffer = null;
let _loadedLibraryRouteId = null;
let _loadedIsSample = false;
let _shareCardData = null;
let _shareRestore = undefined;   // külső megosztó-kép hívás előtti adat
let _importedColoredGeometry = null;
let _importedHrGeometry      = null;
let _importedCadGeometry     = null;
let _importedPowerGeometry   = null;

// ── Getter-ek main.js számára ─────────────────────────────────────────────────
export function getHasImportedFile()          { return _hasImportedFile; }
export function getImportedColoredGeometry()  { return _importedColoredGeometry; }
export function getImportedHrGeometry()       { return _importedHrGeometry; }
export function getImportedCadGeometry()      { return _importedCadGeometry; }
export function getImportedPowerGeometry()    { return _importedPowerGeometry; }
/** A betöltött edzés csúcsteljesítménye a ritkítás előtti, teljes adatból (null, ha nincs). */
export function getImportedPeakPower()        { return _importedPeakPower; }
export function getLoadedLibraryRouteId()     { return _loadedLibraryRouteId; }
export function getLoadedIsSample()           { return _loadedIsSample; }
export function getImportedFileName()         { return _importedFileName; }
export function getImportedGpxText()          { return _importedGpxText; }

/** loadRouteFromLibrary hívja, hogy könyvtárból töltött fájl adatait állítsa be. */
export function setLoadedRoute(id, name, gpxText, isSample = false) {
  _loadedLibraryRouteId = id;
  _loadedIsSample       = !!isSample;
  _importedFileName     = name;
  _importedGpxText      = gpxText;
  _hasImportedFile      = true;
}

/** loadRouteFromLibrary hívja a geometria-state beállításához. */
export function setImportedGeometries({ colored, hr, cad, power }) {
  _importedColoredGeometry = colored ?? null;
  _importedHrGeometry      = hr      ?? null;
  _importedCadGeometry     = cad     ?? null;
  _importedPowerGeometry   = power   ?? null;
}

/** clearAllRouteState hívja. */
export function clearImportedGeometries() {
  _importedColoredGeometry = null;
  _importedHrGeometry      = null;
  _importedCadGeometry     = null;
  _importedPowerGeometry   = null;
  _importedGpxText         = null;
  _loadedLibraryRouteId    = null;
  updateFileSaveButtonState();
}

// ── Segédfüggvények ───────────────────────────────────────────────────────────
function formatDuration(ms) {
  return ms > 0 ? durMs(ms) : "";
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary  = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── Fájl fül megjelenítése ────────────────────────────────────────────────────
/** GPX <type> / Strava sporttípus → magyar felirat (ismeretlennél az eredeti) */
function sportTypeLabel(t) {
  const k = String(t).toLowerCase();
  if (/(e-?bike|ebike)/.test(k)) return "E-bike";
  if (/(gravel)/.test(k)) return "Gravel";
  if (/(mtb|mountain)/.test(k)) return "MTB";
  if (/(cycl|ride|bik)/.test(k)) return "Kerékpár";
  if (/(run)/.test(k)) return "Futás";
  if (/(hik)/.test(k)) return "Túra";
  if (/(walk)/.test(k)) return "Gyaloglás";
  if (/(swim)/.test(k)) return "Úszás";
  return t;
}

export function populateFileTab({ filename, geometry, distanceMeters, ascentMeters, descentMeters, speedColored = false, meta = {}, isFit = false }) {
  _importedPeakPower = Number(meta.maxPower) || null;
  document.querySelector("#fileEmptyState").hidden = true;
  const details = document.querySelector("#fileDetails");
  details.hidden = false;

  document.querySelector("#importedFileName").textContent = filename;
  const fitBadge = document.querySelector("#importedFitBadge");
  if (fitBadge) fitBadge.hidden = !isFit;

  const metaBlock = document.querySelector("#fileMetaBlock");
  const nameRow  = document.querySelector("#fileMetaNameRow");
  const typeRow  = document.querySelector("#fileMetaTypeRow");
  const descRow  = document.querySelector("#fileMetaDescRow");
  const startRow = document.querySelector("#fileMetaStartRow");
  // Felszerelés: bringa (a Felszerelés szerint feloldva) · eszköz + szenzorok
  const eq = meta.equipment || null;
  const equipRow = document.querySelector("#fileMetaEquipRow");
  const equipText = eq ? equipmentLine(eq) : "";
  const sensors = eq ? sensorLabels(eq) : [];
  if (equipRow) {
    equipRow.hidden = !equipText && !sensors.length;
    document.querySelector("#fileMetaEquip").textContent = equipText;
    document.querySelector("#fileMetaSensors").textContent = sensors.length ? `Szenzorok: ${sensors.join(", ")}` : "";
  }
  const hasMeta  = meta.name || meta.type || meta.desc || meta.startTime || equipText || sensors.length;
  if (metaBlock) metaBlock.hidden = !hasMeta;
  if (nameRow)  { nameRow.hidden  = !meta.name; if (meta.name)  document.querySelector("#fileMetaName").textContent = meta.name; }
  if (typeRow)  { typeRow.hidden  = !meta.type; if (meta.type)  document.querySelector("#fileMetaType").textContent = sportTypeLabel(meta.type); }
  if (descRow)  { descRow.hidden  = !meta.desc; if (meta.desc)  document.querySelector("#fileMetaDesc").textContent = meta.desc; }
  if (startRow && meta.startTime) {
    const d = new Date(meta.startTime);
    document.querySelector("#fileMetaStart").textContent =
      d.toLocaleDateString("hu-HU", { year: "numeric", month: "long", day: "numeric" }) + " " +
      d.toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
    startRow.hidden = false;
  } else if (startRow) startRow.hidden = true;

  const totalDurRow   = document.querySelector("#fileTotalDurRow");
  const movingDurRow  = document.querySelector("#fileMovingDurRow");
  const totalDurStr   = formatDuration(meta.totalDuration);
  const movingDurStr  = formatDuration(meta.movingDuration);
  if (totalDurRow)  { totalDurRow.hidden  = !totalDurStr; if (totalDurStr)  document.querySelector("#fileTotalDur").textContent  = totalDurStr; }
  // Ha kerekítve megegyezik az időtartammal, a mozgási idő külön kártyája felesleges
  const showMoving = !!movingDurStr && movingDurStr !== totalDurStr;
  if (movingDurRow) { movingDurRow.hidden = !showMoving; if (showMoving) document.querySelector("#fileMovingDur").textContent = movingDurStr; }
  document.querySelector("#fileDistance").textContent = _formatDisplayDistance(distanceMeters);
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
  // átlag = táv / mozgásidő (mint a Strava és a Kezdőlap); a pontonkénti sebességek egyszerű
  // átlaga torzít (a gyors szakaszokon több a pont), csak időadat híján marad tartaléknak
  const avgSpeedKmh = meta.movingDuration > 0 && distanceMeters > 0
    ? Math.round(distanceMeters / (meta.movingDuration / 3600000) / 100) / 10
    : hasSpeed ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length * 10) / 10 : 0;
  document.querySelector("#fileAvgSpeedRow").hidden = !hasSpeed;
  document.querySelector("#fileMaxSpeedRow").hidden = !hasSpeed;
  if (hasSpeed) {
    const max = Math.round(Math.max(...speeds) * 10) / 10;
    document.querySelector("#fileAvgSpeed").textContent = `${num(avgSpeedKmh, 1)} km/h`;
    document.querySelector("#fileMaxSpeed").textContent = `${num(max, 1)} km/h`;
  }

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
    try { _renderHrZoneAnalysis(geometry); } catch (err) { console.error('HR zone analysis hiba:', err); }
  }

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

  const legendEl = document.querySelector("#speedLegend");
  if (legendEl) legendEl.hidden = !speedColored;

  const hrLegendEl = document.querySelector("#hrLegend");
  if (hrLegendEl) hrLegendEl.hidden = !hasHr;
  if (hasHr) _renderHrZoneAnalysis(geometry);

  const cadLegendEl = document.querySelector("#cadLegend");
  if (cadLegendEl) cadLegendEl.hidden = !hasCad;

  const powers = geometry.map(p => p.power).filter(p => p != null && p >= 0);
  const hasPower = powers.length > 0;
  const avgPowerRowEl = document.querySelector("#fileAvgPowerRow");
  const maxPowerRowEl = document.querySelector("#fileMaxPowerRow");
  if (avgPowerRowEl) avgPowerRowEl.hidden = !hasPower;
  if (maxPowerRowEl) maxPowerRowEl.hidden = !hasPower;
  if (hasPower) {
    const avgPower = Math.round(powers.reduce((a, b) => a + b, 0) / powers.length);
    // a pontos csúcs a teljes (ritkítás előtti) adatból, ha megvan
    const maxPower = Math.round(Math.max(...powers, Number(meta.maxPower) || 0));
    const avgPowerEl = document.querySelector("#fileAvgPower");
    const maxPowerEl = document.querySelector("#fileMaxPower");
    if (avgPowerEl) avgPowerEl.textContent = `${avgPower} W`;
    if (maxPowerEl) maxPowerEl.textContent = `${maxPower} W`;
  }

  const powerLegendEl = document.querySelector("#powerLegend");
  if (powerLegendEl) powerLegendEl.hidden = !hasPower;

  // Hőmérséklet: az eszköz mérése (GPX atemp); ha nincs, a könyvtár időjárás-adata (meta.temp)
  {
    const temps = geometry.map(p => p.temp).filter(t => t != null);
    const row = document.querySelector("#fileTempRow");
    const legend = document.querySelector("#tempLegend");
    let t = null, weather = false;
    if (temps.length >= 5) {
      t = { avg: temps.reduce((a, b) => a + b, 0) / temps.length, min: Math.min(...temps), max: Math.max(...temps) };
    } else if (meta.temp?.avg_temp != null) {
      t = { avg: meta.temp.avg_temp, min: meta.temp.min_temp, max: meta.temp.max_temp };
      weather = meta.temp.temp_source === "weather";
    }
    const fmtT = (v) => `${num(v, 0)} °C`;
    if (row) {
      row.hidden = !t;
      if (t) {
        document.querySelector("#fileTemp").textContent = (weather ? "≈ " : "") + fmtT(t.avg);
        document.querySelector("#fileTempLabel").textContent = weather ? "⌀ Hőmérséklet (időjárás)" : "⌀ Hőmérséklet";
        row.title = (t.min != null && t.max != null ? `${fmtT(t.min)} – ${fmtT(t.max)}` : "")
          + (weather ? " · az indulás helyén mért időjárás (az eszköz nem mért hőmérsékletet)" : "");
      }
    }
    if (legend) legend.hidden = !(temps.length >= 5);       // grafikon és színezés csak mért adatból
  }
  // zónaeloszlás a lenyíló panelekben (sebesség, kadencia, teljesítmény, hőmérséklet, lejtés)
  try { renderZoneDists(geometry); } catch (err) { console.error("Zónaeloszlás hiba:", err); }

  // Kalória: minden elérhető számítás (eszköz / Strava, teljesítmény, pulzus – Keytel,
  // kalibrálva –, MET-becslés); a kártya a legmegbízhatóbbat mutatja, kattintásra összevetés
  {
    const row = document.querySelector("#fileKcalRow");
    _kcalMethods = calorieMethods({ geometry, meta, distanceMeters, ascentMeters });
    const best = _kcalMethods.find((m) => m.primary);
    if (row) {
      row.hidden = !best;
      if (best) {
        document.querySelector("#fileKcal").textContent = `${int(best.kcal)} kcal`;
        document.querySelector("#fileKcalLabel").textContent = `Kalória (${best.short})`;
        row.title = _kcalMethods.length > 1 ? "Kattints az összevetéshez (eszköz, teljesítmény, pulzus, becslés)" : best.note;
        row.classList.toggle("stat-card--click", _kcalMethods.length > 1);
        if (!row.dataset.kcalBound) {
          row.dataset.kcalBound = "1";
          row.addEventListener("click", () => { if (_kcalMethods.length > 1) openKcalCompare(_kcalMethods); });
        }
      }
    }
  }
  // Páratlan számú kártyánál az utolsó kitölti a sort (ne maradjon üres hely)
  {
    const cards = [...document.querySelectorAll(".file-stats > .stat-card")];
    cards.forEach(c => c.classList.remove("stat-card--wide"));
    const visible = cards.filter(c => !c.hidden);
    if (visible.length % 2 === 1) visible[visible.length - 1].classList.add("stat-card--wide");
  }

  // Share card adatok összegyűjtése
  {
    const titleStr  = meta.name || "Bringaterv edzés";
    const metaTitle = meta.name || "";
    let dateStr = "";
    if (meta.startTime) {
      const d = new Date(meta.startTime);
      dateStr = d.toLocaleDateString("hu-HU", { year: "numeric", month: "long", day: "numeric" });
    }
    const distKm = distanceMeters > 0 ? Math.round(distanceMeters / 100) / 10 : 0;
    const durStr = meta.movingDuration
      ? formatDuration(meta.movingDuration)
      : (meta.totalDuration ? formatDuration(meta.totalDuration) : "");
    const avgSpd = avgSpeedKmh;
    const simPts = shareCardPoints(geometry);
    const avgOf = (k, min = 0) => { const a = geometry.map((p) => p[k]).filter((v) => v != null && Number.isFinite(v) && v > min); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
    const spd = geometry.map((p) => p.speed).filter((v) => v != null && v > 0 && v < 120);
    _shareCardData = {
      extra: { hrAvg: avgOf("hr"), powerAvg: avgOf("power", -1), kcal: Number(meta.calories) || null, maxSpeed: spd.length ? Math.max(...spd) : null },
      geometry, descentMeters, startTime: meta.startTime || null,
      isWorkout: !!(meta.startTime || meta.totalDuration),
      title:        titleStr,
      metaTitle:    metaTitle,
      date:         dateStr,
      distanceKm:   distKm,
      durationText: durStr,
      avgSpeedKmh:  avgSpd,
      elevationM:   ascentMeters || 0,
      points:       simPts,
    };
    const shareBtn = document.querySelector("#fileShareButton");
    if (shareBtn) shareBtn.disabled = false;
  }

  window.lucide?.createIcons();
}

// ── Kalória: számítások és összevetés ────────────────────────────────────────
let _kcalMethods = [];

function calorieMethods({ geometry, meta, distanceMeters, ascentMeters }) {
  const out = [];
  const movingMin = (meta.movingDuration || meta.totalDuration || 0) / 60000;
  const isBike = !meta.type || /cycl|ride|bik|gravel|mtb/i.test(meta.type);
  const hrS = getHrZoneSettings(), prof = getCyclistProfile();
  const person = { kg: Number(prof.riderKg) || 75, age: hrS.age, sex: hrS.sex };
  if (Number(meta.calories) > 0) {
    out.push({ key: "ext", kcal: Math.round(meta.calories), short: meta.caloriesShort || "eszköz",
               label: meta.caloriesSource || "A rögzítő eszköz számítása",
               note: "A rögzítő eszköz / szolgáltatás saját értéke – ezt a te profiloddal (súly, pulzus, esetleg VO2max) számolja." });
  }
  // teljesítményből: a munka (kJ) – a könyvtári érték, különben átlag watt × mozgásidő
  const pw = geometry.map((p) => p.power).filter((v) => v != null);
  const kj = Number(meta.kilojoules) || (pw.length && movingMin > 0 ? pw.reduce((a, b) => a + b, 0) / pw.length * movingMin * 60 / 1000 : 0);
  if (kj > 0) {
    out.push({ key: "power", kcal: powerKcal(kj), short: "teljesítményből", label: "Teljesítményből (wattmérő)",
               note: `${int(kj)} kJ pedálmunka. Wattmérővel ez a legpontosabb: ~24%-os hatásfokkal a kJ ≈ kcal.` });
  }
  // pulzusból (Keytel), kalibrálva a wattmérős edzéseidből
  const hs = hrTimeStats(geometry);
  if (hs) {
    const minutes = movingMin > 0 ? movingMin : hs.minutes;
    const raw = keytelKcal({ ...person, avgHr: hs.avgHr, minutes });
    if (raw) {
      const cal = keytelCalibration(person);
      out.push({ key: "hr", kcal: Math.round(raw * cal.factor), short: "pulzusból",
                 label: cal.calibrated ? `Pulzusból (Keytel, kalibrálva ${cal.n} edzés alapján)` : "Pulzusból (Keytel-képlet)",
                 note: `Átlagpulzus ${Math.round(hs.avgHr)} bpm, ${person.age} év, ${person.kg} kg, ${person.sex === "female" ? "nő" : "férfi"} (Beállítások).`
                   + (cal.calibrated ? ` A képlet nyers értéke ${int(raw)} kcal; a wattmérős edzéseid alapján ×${cal.factor.toFixed(2)}.`
                                     : ` Kalibráláshoz legalább 3 wattmérős, pulzussal mért edzés kell (most ${cal.n}).`) });
    }
  }
  if (isBike && movingMin > 0 && distanceMeters > 0) {
    try {
      const e = estimateKcal(distanceMeters / 1000, movingMin / 60, ascentMeters || 0, prof).kcal;
      if (e > 0) out.push({ key: "met", kcal: e, short: "becsült", label: "Becslés (sebesség, szint, testsúly)",
                            note: "MET-táblázat az átlagsebességhez + az emelkedés munkája – pulzus és watt nélkül is működik." });
    } catch { /* nincs becslés */ }
  }
  const order = ["ext", "power", "hr", "met"];
  const best = order.map((k) => out.find((m) => m.key === k)).find(Boolean);
  if (best) best.primary = true;
  return out;
}

function openKcalCompare(methods) {
  const best = methods.find((m) => m.primary);
  const ov = document.createElement("div");
  ov.className = "shortcut-overlay";
  const diff = (m) => {
    if (m === best || !best?.kcal) return "";
    const d = Math.round((m.kcal - best.kcal) / best.kcal * 100);
    return `<span class="kcal-diff ${d > 0 ? "is-up" : d < 0 ? "is-down" : ""}">${d > 0 ? "+" : ""}${d}%</span>`;
  };
  ov.innerHTML = `<div class="export-panel kcal-compare" role="dialog" aria-modal="true">
    <div class="export-header"><h3>Kalória – összevetés</h3><button type="button" class="shortcut-close" data-x aria-label="Bezárás">×</button></div>
    <div class="export-body">
      ${methods.map((m) => `<div class="kcal-row${m.primary ? " is-primary" : ""}">
        <div class="kcal-row-head"><b>${m.label}</b><span><strong>${int(m.kcal)}</strong> kcal ${diff(m)}</span></div>
        <p>${m.note}</p></div>`).join("")}
      <p class="kcal-foot">Az eltérés a kiemelt értékhez képest. A kalória mindig becslés: a pulzus alapú képletek
        általánosak (edzett embernél gyakran 10–30%-kal eltérnek), a wattmérős érték a legpontosabb. Az életkor, a nem
        és a testsúly a Beállításokban (Pulzuszónák, Kerékpáros profil) módosítható.</p>
    </div></div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest("[data-x]")) ov.remove(); });
}

export function clearFileTab() {
  _hasImportedFile = false;
  document.querySelector("#fileEmptyState").hidden = false;
  document.querySelector("#fileDetails").hidden = true;
  const speedLeg = document.querySelector("#speedLegend");
  const hrLeg = document.querySelector("#hrLegend");
  const cadLeg = document.querySelector("#cadLegend");
  const powerLeg = document.querySelector("#powerLegend");
  const tempLeg = document.querySelector("#tempLegend");
  if (tempLeg) tempLeg.hidden = true;
  if (speedLeg) speedLeg.hidden = true;
  if (hrLeg) hrLeg.hidden = true;
  if (cadLeg) cadLeg.hidden = true;
  if (powerLeg) powerLeg.hidden = true;
  const metaBlock = document.querySelector("#fileMetaBlock");
  if (metaBlock) metaBlock.hidden = true;
  _shareCardData = null;
  const shareBtn = document.querySelector("#fileShareButton");
  if (shareBtn) shareBtn.disabled = true;
}

export function updateFileSaveButtonState() {
  const btn = _elements?.fileSaveToLibraryButton;
  if (!btn) return;
  const hasPoints = _store.getState().waypoints?.length > 0;
  if (!hasPoints) {
    btn.disabled = true;
    btn.hidden = false;
    return;
  }
  if (_loadedLibraryRouteId) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.disabled = false;
  const lbl = btn.querySelector("span");
  if (lbl) lbl.textContent = "Mentés";
}

// ── GPX / FIT import ──────────────────────────────────────────────────────────
// GPS nélküli (beltéri: görgő, Zwift) FIT: a szerver ugyanúgy menti, mint a komputeres
// importokat (routes-api/indoor.py), és rögtön megnyílik az Elemzésben
async function saveIndoorFit(buffer, filename) {
  const name = filename.replace(/\.fit$/i, "");
  _showToast?.("Beltéri edzés – mentés a könyvtárba…");
  let res;
  try {
    res = await _api.saveIndoorFit({ name, fitContent: arrayBufferToBase64(buffer) });
  } catch (err) {
    _showToast?.(err?.message || "Nem sikerült menteni a beltéri edzést.");
    console.error("Indoor FIT save error:", err);
    return;
  }
  const entry = res?.entry;
  if (res?.skipped) _showToast?.(res.reason === "same_file" ? "Ez a fájl már a könyvtárban van." : `Már megvan: ${entry?.name || "ugyanez az edzés"}.`);
  else _showToast?.("Beltéri edzés mentve.");
  if (typeof _loadRouteLibrary === "function") { try { await _loadRouteLibrary(); } catch { /* offline */ } }
  if (entry?.id) await _openLibraryRoute?.(entry.id, entry.name || name);
}

export async function processImportedFile(file) {
  if (!file) return;
  // A fájlválasztó szűrő nélkül nyílik (Safari a .fit-et nem engedné) → itt ellenőrzünk
  if (!/\.(gpx|fit)$/i.test(file.name)) {
    _showToast?.(`„${file.name}” nem GPX vagy FIT fájl – csak .gpx és .fit tölthető be.`);
    return;
  }
  const isFit = /\.fit$/i.test(file.name);
  let gpxText;
  let fitBuffer = null;

  if (isFit) {
    try {
      fitBuffer = await file.arrayBuffer();
      if (!fitHasPosition(fitBuffer)) { await saveIndoorFit(fitBuffer, file.name); return; }
      gpxText   = fitToGpx(fitBuffer, file.name);
    } catch (err) {
      _showToast("Nem sikerült feldolgozni a FIT fájlt.");
      console.error("FIT parse error:", err);
      return;
    }
  } else {
    gpxText = await file.text();
  }

  const gpxFile = isFit
    ? new File([gpxText], file.name.replace(/\.fit$/i, ".gpx"), { type: "application/gpx+xml" })
    : file;

  let imported;
  try {
    imported = await importGpx(gpxFile, { sampleWaypoints: (_elements.gpxSampleWaypointsSettings ?? _elements.gpxSampleWaypoints)?.checked });
  } catch (err) {
    _showToast(isFit
      ? "Nem sikerült betölteni a FIT fájlt."
      : "Nem sikerült betölteni a fájlt. Ellenőrizd, hogy érvényes GPX fájl-e.");
    console.error("Import error:", err);
    return;
  }

  _store.replaceWaypoints(imported.waypoints, {
    geometry: imported.geometry,
    importedRoute: true,
    sourcePointCount: imported.sourcePointCount,
  });
  const { ascentMeters, descentMeters } = calcElevationFromGeometry(imported.geometry);
  const distanceMeters = _calculateImportedDistance(imported.geometry);
  _store.setState({ distanceMeters, ascentMeters, descentMeters });

  const hasSpeed = imported.geometry.some(p => p.speed != null);
  const hasHr    = imported.geometry.some(p => p.hr    != null);
  const hasCad   = imported.geometry.some(p => p.cad   != null);
  const hasPower = imported.geometry.some(p => p.power != null);

  _importedColoredGeometry = hasSpeed ? imported.geometry : null;
  _importedCadGeometry     = hasCad   ? imported.geometry : null;
  _importedHrGeometry      = hasHr    ? imported.geometry : null;
  _importedPowerGeometry   = hasPower ? imported.geometry : null;

  _clearWindResult();
  _updateElevationButton(imported.geometry);
  _applyRouteLayer(null);
  _mapAdapter.renderRoute(imported.geometry, _store.getState().mode);

  _hasImportedFile   = true;
  _importedFileName  = file.name.replace(/\.(gpx|fit)$/i, "");
  _importedMeta      = imported.meta ?? null;
  _importedGpxText   = gpxText;
  _importedFitBuffer = fitBuffer;
  _loadedLibraryRouteId = null;
  _loadedIsSample = false;
  updateFileSaveButtonState();
  populateFileTab({
    filename: file.name,
    geometry: imported.geometry,
    distanceMeters, ascentMeters, descentMeters,
    speedColored: hasSpeed,
    meta: imported.meta ?? {},
    isFit,
  });
  _switchTab("file");

  if (imported.sourcePointCount > imported.geometry.length) {
    _showToast(`${isFit ? "FIT" : "GPX"} betöltve – ${imported.sourcePointCount} pont → ${imported.geometry.length} jelenik meg`, 5000);
  } else {
    _showToast(_i18n.t("route.imported", { points: imported.sourcePointCount }));
  }
  setTimeout(() => _mapAdapter.fitRoute(), 50);

  // a pontok elnevezése: közös, szerveroldali (gyorsítótáras) elnevező – main.js geocodeNamelessWaypoints
  if (window.__geocodeWaypoints) window.__geocodeWaypoints();
  else for (const wp of _store.getState().waypoints) {
    const name = await reverseGeocode(wp.lat, wp.lng);
    if (name && _store.getState().waypoints.some((w) => w.id === wp.id)) _store.updateWaypoint(wp.id, { name });
  }
}

// ── Share Card modal ──────────────────────────────────────────────────────────
function _initShareCardModal() {
  const lsGet = (k, ok) => { try { const v = localStorage.getItem(k); return ok(v) ? v : null; } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  let _shareTheme = lsGet("bt.shareTheme", (v) => ["light", "dark", "topo"].includes(v)) || "light";   // a fotó nem marad meg (a kép sem)
  let _shareSize  = lsGet("bt.shareSize", (v) => ["square", "portrait", "story"].includes(v)) || "square";
  let _shareInk   = lsGet("bt.shareInk", (v) => ["white", "black", "orange"].includes(v)) || "white";
  let _shareDate  = lsGet("bt.shareDate", (v) => v === "0" || v === "1") !== "0";
  let _shareStats = DEFAULT_STATS.slice();
  try { const v = JSON.parse(localStorage.getItem("bt.shareStats") || "null"); if (Array.isArray(v) && v.length) _shareStats = v.filter((id) => SHARE_STATS.some((x) => x.id === id)).slice(0, 4); } catch {}
  const MAX_STATS = 4;
  // A választott stílus megmarad a következő megosztásra is
  let _shareLayout = "panel";
  try { const v = localStorage.getItem("bt.shareLayout"); if (SHARE_LAYOUTS.some((l) => l.id === v)) _shareLayout = v; } catch {}
  // A választott grafikonok (sorrend: SHARE_CHARTS); ami az adott útvonalnál nincs, kimarad
  const MAX_CHARTS = 3;
  let _shareCharts = ["ele"];
  try {
    const v = JSON.parse(localStorage.getItem("bt.shareCharts") || "null");
    if (Array.isArray(v)) _shareCharts = v.filter((id) => SHARE_CHARTS.some((c) => c.id === id)).slice(0, MAX_CHARTS);
  } catch {}

  function renderChartPicker() {
    const row = document.querySelector("#shareChartRow");
    const picker = document.querySelector("#shareChartPicker");
    if (!row || !picker) return;
    const avail = availableShareCharts(_shareCardData?.points || []);
    row.hidden = !avail.length;
    const chosen = _shareCharts.filter((id) => avail.includes(id));
    picker.innerHTML = SHARE_CHARTS.filter((c) => avail.includes(c.id)).map((c) => {
      const on = chosen.includes(c.id);
      const full = !on && chosen.length >= MAX_CHARTS;
      return `<button type="button" class="sc-chip${on ? " sc-chip--on" : ""}" data-share-chart="${c.id}"
        aria-pressed="${on}" ${full ? "disabled" : ""}>${isSolidChartMode() ? "" : `<span class="sc-chip-dot" style="background:${c.color}"></span>`}${c.label}</button>`;
    }).join("");
  }
  const _sharePhoto = {
    img: null, scale: 1, offsetX: 0, offsetY: 0, blur: 6, headerBg: "translucent",
    routeColor: "#ff6a3d", routeOffsetX: 0, routeOffsetY: 0, routeScale: 1,
  };
  let _dragTarget = "photo";   // "photo" | "route" – mit mozgat a húzás

  let _refreshScheduled = false;
  function scheduleRefresh() {
    if (_refreshScheduled) return;
    _refreshScheduled = true;
    requestAnimationFrame(() => { _refreshScheduled = false; refreshSharePreview(); });
  }

  /** A kép összes beállítása (előnézet és letöltés ugyanezt használja). */
  function cardOpts() {
    const caps = LAYOUT_CAPS[_shareLayout] || {};
    const theme = caps.theme === false ? "light" : _shareTheme;
    return {
      ..._shareCardData,
      title: document.querySelector("#shareCardTitle")?.value?.trim() || _shareCardData.title,
      theme, layout: _shareLayout, charts: _shareCharts, size: _shareSize,
      photo: theme === "photo" ? _sharePhoto : null,
      qrUrl: _qrUrl(),
      stats: _shareStats, showDate: _shareDate, ink: _shareInk,
    };
  }

  // a kiválasztott adatok (chipek) – csak ami ennél az útvonalnál megvan
  function availableStats() {
    const d = _shareCardData || {}, x = d.extra || {};
    const has = { dist: d.distanceKm > 0, time: !!d.durationText, speed: d.avgSpeedKmh > 0, elev: d.elevationM > 0,
                  hr: x.hrAvg > 0, power: x.powerAvg > 0, kcal: x.kcal > 0, maxSpeed: x.maxSpeed > 0 };
    return SHARE_STATS.filter((it) => has[it.id]).map((it) => it.id);
  }
  function renderStatPicker() {
    const picker = document.querySelector("#shareStatPicker");
    if (!picker) return;
    const avail = availableStats();
    const chosen = _shareStats.filter((id) => avail.includes(id));
    picker.innerHTML = SHARE_STATS.filter((it) => avail.includes(it.id)).map((it) => {
      const on = chosen.includes(it.id);
      const full = !on && chosen.length >= MAX_STATS;
      return `<button type="button" class="sc-chip${on ? " sc-chip--on" : ""}" data-share-stat="${it.id}" aria-pressed="${on}" ${full ? "disabled" : ""}>${it.label}</button>`;
    }).join("");
  }
  document.querySelector("#shareStatPicker")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-share-stat]");
    if (!b || b.disabled) return;
    const id = b.dataset.shareStat;
    const avail = availableStats();
    let cur = _shareStats.filter((x) => avail.includes(x));
    cur = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    if (!cur.length) return;   // legalább egy adat maradjon
    // a sorrend a lista sorrendje (táv, idő, átlag, …)
    _shareStats = SHARE_STATS.map((x) => x.id).filter((x) => cur.includes(x));
    lsSet("bt.shareStats", JSON.stringify(_shareStats));
    renderStatPicker(); syncGroups(); refreshSharePreview();
  });
  document.querySelector("#shareDateToggle")?.addEventListener("change", (e) => {
    _shareDate = e.target.checked; lsSet("bt.shareDate", _shareDate ? "1" : "0");
    syncGroups(); refreshSharePreview();
  });
  document.querySelectorAll("[data-share-ink]").forEach((btn) => btn.addEventListener("click", () => {
    _shareInk = btn.dataset.shareInk; lsSet("bt.shareInk", _shareInk);
    syncGroups(); refreshSharePreview();
  }));

  /** A stílushoz tartozó beállítások mutatása / rejtése és a csoportfejlécek összefoglalója. */
  function syncGroups() {
    const caps = LAYOUT_CAPS[_shareLayout] || {};
    document.querySelectorAll("[data-sc-cap]").forEach((el) => {
      const k = el.dataset.scCap;
      if (k === "charts") return;   // a grafikonsor maga dönti el (van-e adat)
      el.hidden = !caps[k];
    });
    const chartRow = document.querySelector("#shareChartRow");
    if (chartRow && !caps.charts) chartRow.hidden = true;
    else if (chartRow) chartRow.hidden = !availableShareCharts(_shareCardData?.points || []).length;
    const photo = document.querySelector("#sharePhotoControls");
    if (photo) photo.hidden = !(caps.photo && _shareTheme === "photo");
    document.querySelectorAll("[data-share-theme]").forEach((b) => b.classList.toggle("share-opt-btn--active", b.dataset.shareTheme === _shareTheme));
    document.querySelectorAll("[data-share-size]").forEach((b) => b.classList.toggle("share-opt-btn--active", b.dataset.shareSize === _shareSize));
    document.querySelectorAll("[data-share-ink]").forEach((b) => b.classList.toggle("share-opt-btn--active", b.dataset.shareInk === _shareInk));
    const dt = document.querySelector("#shareDateToggle"); if (dt) dt.checked = _shareDate;
    const L = (sel) => document.querySelector(sel)?.textContent?.trim() || "";
    const sizeL = { square: "Négyzet", portrait: "4:5", story: "Sztori" }[_shareSize];
    const bgL = caps.ink ? `${L(`[data-share-ink="${_shareInk}"]`)} szín` : L(`[data-share-theme="${_shareTheme}"]`);
    const fmt = document.querySelector('[data-sc-sum="format"]'); if (fmt) fmt.textContent = [sizeL, bgL].filter(Boolean).join(" · ");
    const avail = availableStats();
    const st = _shareStats.filter((x) => avail.includes(x)).map((x) => SHARE_STATS.find((y) => y.id === x)?.label.toLowerCase());
    const extras = [caps.charts && _shareCharts.length ? `${_shareCharts.length} grafikon` : "", _qrUrl() ? "QR" : ""].filter(Boolean);
    const con = document.querySelector('[data-sc-sum="content"]'); if (con) con.textContent = [st.join(", "), ...extras].filter(Boolean).join(" · ");
    const hint = document.querySelector("#shareLayoutHint");
    if (hint) hint.textContent = SHARE_LAYOUTS.find((l) => l.id === _shareLayout)?.hint || "";
    syncMode();
  }

  // ── Videó (animált megosztás) ─────────────────────────────────────────────
  let _shareMode = "image";
  // háttér: térkép (típusa külön) / egyszínű / saját / zöld; a régi „light/dark/topo” értékek térképpé válnak
  let _videoMap = lsGet("bt.videoMap", (v) => VIDEO_MAPS.some((m) => m.id === v)) || "light";
  let _videoBg  = lsGet("bt.videoBg", (v) => !!v && v !== "media") || "map";
  if (VIDEO_MAPS.some((m) => m.id === _videoBg)) { _videoMap = _videoBg; _videoBg = "map"; }
  if (!VIDEO_BGS.some((b) => b.id === _videoBg)) _videoBg = "map";
  let _videoRoute = lsGet("bt.videoRoute", (v) => v === "0" || v === "1") === "1";
  let _videoDur = Number(lsGet("bt.videoDur", (v) => VIDEO_DURATIONS.includes(Number(v)))) || 12;
  // videóhoz két méret: sztori / Reels (9:16) és bejegyzés (4:5)
  let _videoSize = lsGet("bt.videoSize", (v) => ["portrait", "story"].includes(v)) || "story";
  let _videoChart = lsGet("bt.videoChart", (v) => v === "none" || SHARE_CHARTS.some((c) => c.id === v)) || "ele";
  let _videoZones = lsGet("bt.videoZones", (v) => v === "0" || v === "1") !== "0";
  let _videoZoom = lsGet("bt.videoZoom", (v) => v === "0" || v === "1") !== "0";
  let _videoAlign = lsGet("bt.videoAlign", (v) => v === "left" || v === "center") || "center";
  let _videoMedia = null;          // { kind, el } – saját fotó / videó
  let _stopVideo = null;           // az előnézet leállítója
  let _videoToken = 0;             // a régi (elavult) jelenet-építések eldobásához
  let _videoBusy = false;          // felvétel közben nincs előnézet-frissítés
  const hasTrack = () => (_shareCardData?.points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)).length > 1;
  const videoAvailable = () => videoSupported() && hasTrack();

  function videoOpts() {
    return {
      ...cardOpts(), title: _getShareTitle(),
      bg: _videoBg === "media" && !_videoMedia ? "solid" : _videoBg, media: _videoMedia, duration: _videoDur,
      size: _videoSize, chart: videoChart(), zoneColors: _videoZones, routeColors: _videoRoute, map: _videoMap, titleAlign: _videoAlign, autoZoom: _videoZoom,
    };
  }
  // a választott grafikon, ha ennél az edzésnél van hozzá adat (különben az első elérhető)
  function videoChart() {
    if (_videoChart === "none") return "none";
    const avail = availableShareCharts(_shareCardData?.points || []);
    return avail.includes(_videoChart) ? _videoChart : (avail[0] || "none");
  }
  function stopVideoPreview() { _stopVideo?.(); _stopVideo = null; }

  function renderVideoControls() {
    const bgP = document.querySelector("#shareVideoBgPicker");
    if (bgP) bgP.innerHTML = VIDEO_BGS.map((b) => `<button type="button" class="sc-chip${b.id === _videoBg ? " sc-chip--on" : ""}" data-video-bg="${b.id}" aria-pressed="${b.id === _videoBg}">${b.label}</button>`).join("");
    const chP = document.querySelector("#shareVideoChartPicker");
    if (chP) {
      const avail = availableShareCharts(_shareCardData?.points || []);
      const cur = videoChart();
      chP.innerHTML = [...SHARE_CHARTS.filter((c) => avail.includes(c.id)), { id: "none", label: "Nincs" }].map((c) =>
        `<button type="button" class="sc-chip${c.id === cur ? " sc-chip--on" : ""}" data-video-chart="${c.id}" aria-pressed="${c.id === cur}">${c.color && !isSolidChartMode() ? `<span class="sc-chip-dot" style="background:${c.id === "ele" ? "#fc4c02" : c.color}"></span>` : ""}${c.label}</button>`).join("");
    }
    const mapRow = document.querySelector("#shareVideoMapRow"); if (mapRow) mapRow.hidden = _videoBg !== "map";
    const zmIn = document.querySelector("#shareVideoZoom"); if (zmIn) zmIn.checked = _videoZoom;
    const mapP = document.querySelector("#shareVideoMapPicker");
    if (mapP) mapP.innerHTML = VIDEO_MAPS.map((m) => `<button type="button" class="sc-chip${m.id === _videoMap ? " sc-chip--on" : ""}" data-video-map="${m.id}" aria-pressed="${m.id === _videoMap}">${m.label}</button>`).join("");
    const noChart = videoChart() === "none";
    const zRow = document.querySelector("#shareVideoZonesRow"); if (zRow) zRow.hidden = noChart;
    const rRow = document.querySelector("#shareVideoRouteRow"); if (rRow) rRow.hidden = noChart;
    const rIn = document.querySelector("#shareVideoRoute"); if (rIn) rIn.checked = _videoRoute;
    const zIn = document.querySelector("#shareVideoZones"); if (zIn) zIn.checked = _videoZones;
    document.querySelectorAll("[data-video-align]").forEach((b) => b.classList.toggle("share-opt-btn--active", b.dataset.videoAlign === _videoAlign));
    const durS = document.querySelector("#shareVideoDurSeg");
    if (durS) durS.innerHTML = VIDEO_DURATIONS.map((d) => `<button class="share-opt-btn${d === _videoDur ? " share-opt-btn--active" : ""}" data-video-dur="${d}" type="button">${d} mp</button>`).join("");
    const mediaRow = document.querySelector("#shareVideoMediaRow"); if (mediaRow) mediaRow.hidden = _videoBg !== "media";
    const mediaLbl = document.querySelector("#shareVideoMediaBtn span");
    if (mediaLbl) mediaLbl.textContent = _videoMedia ? (_videoMedia.kind === "video" ? "Másik videó vagy fotó" : "Másik fotó vagy videó") : "Fotó vagy videó kiválasztása";
    const green = document.querySelector("#shareVideoGreenNote"); if (green) green.hidden = _videoBg !== "green";
    const fmt = document.querySelector("#shareVideoFormatNote");
    if (fmt) fmt.textContent = videoFormat() === "mp4" ? "MP4 videó, hang nélkül." : "WebM videó, hang nélkül (ez a böngésző MP4-et nem tud készíteni).";
    const sum = document.querySelector('[data-sc-sum="video"]');
    const chL = SHARE_CHARTS.find((c) => c.id === videoChart())?.label;
    const bgL = _videoBg === "map" ? `${VIDEO_MAPS.find((m) => m.id === _videoMap)?.label} térkép` : VIDEO_BGS.find((b) => b.id === _videoBg)?.label;
    if (sum) sum.textContent = [bgL, chL, `${_videoDur} mp`].filter(Boolean).join(" · ");
  }

  // videónál a méretgombok neve beszédesebb: Sztori (9:16) / Bejegyzés (4:5)
  function setSizeLabels(video) {
    const lbl = { portrait: video ? "Bejegyzés 4:5" : "4:5", story: video ? "Sztori 9:16" : "Sztori" };
    for (const [k, t] of Object.entries(lbl)) {
      const b = document.querySelector(`[data-share-size="${k}"]`);
      const node = b && [...b.childNodes].reverse().find((x) => x.nodeType === 3 && x.textContent.trim());
      if (node) node.textContent = " " + t;
    }
  }
  function syncMode() {
    const video = _shareMode === "video";
    document.querySelectorAll("[data-share-mode]").forEach((b) => b.classList.toggle("share-opt-btn--active", b.dataset.shareMode === _shareMode));
    document.querySelectorAll("[data-sc-video-only]").forEach((el) => { el.hidden = !video; });
    if (video) {
      document.querySelectorAll("[data-sc-image-only], #shareChartRow, #shareQrRow, #sharePhotoControls").forEach((el) => { el.hidden = true; });
      setSizeLabels(true);
      document.querySelectorAll("[data-share-size]").forEach((b) => {
        b.hidden = b.dataset.shareSize === "square";
        b.classList.toggle("share-opt-btn--active", b.dataset.shareSize === _videoSize);
      });
      const fmt = document.querySelector('[data-sc-sum="format"]'); if (fmt) fmt.textContent = { portrait: "Bejegyzés (4:5)", story: "Sztori (9:16)" }[_videoSize];
      const avail = availableStats();
      const con = document.querySelector('[data-sc-sum="content"]');
      if (con) con.textContent = _shareStats.filter((x) => avail.includes(x)).map((x) => SHARE_STATS.find((y) => y.id === x)?.label.toLowerCase()).join(", ");
      renderVideoControls();
    } else {
      // a stílushoz kötött részeket (data-sc-cap) a syncGroups már beállította
      document.querySelectorAll("[data-sc-image-only]:not([data-sc-cap])").forEach((el) => { el.hidden = false; });
      document.querySelectorAll('[data-share-size="square"]').forEach((b) => { b.hidden = false; });
      setSizeLabels(false);
      const qrRow = document.querySelector("#shareQrRow"); if (qrRow) qrRow.hidden = !_shareCardData?.shareUrl;
    }
    const head = document.querySelector("#shareCardHead"); if (head) head.textContent = video ? "Megosztó videó" : "Megosztó kép";
    const dl = document.querySelector("#shareCardDownload span"); if (dl && !_videoBusy) dl.textContent = video ? "Videó letöltése" : "Letöltés";
  }

  async function refreshVideoPreview() {
    const cv = document.querySelector("#shareCardPreview");
    if (!cv || _videoBusy) return;
    const token = ++_videoToken;
    let scene;
    try { scene = await createVideoScene(videoOpts()); }
    catch (err) { console.error("Videó-előnézet:", err); _showToast?.(err?.message || "A videó előnézete nem készült el."); return; }
    if (token !== _videoToken || _shareMode !== "video" || _videoBusy) { scene.stop(); return; }
    stopVideoPreview();
    cv.classList.remove("is-transparent");
    _stopVideo = playScene(cv, scene);
  }

  /** Felvétel → { file } (a gombok közös útja). */
  async function recordVideo(btn) {
    const span = btn?.querySelector("span");
    const orig = span?.textContent;
    _videoBusy = true; ++_videoToken;
    stopVideoPreview();
    document.querySelectorAll("#shareCardDownload, #shareCardNativeShare").forEach((b) => { b.disabled = true; });
    try {
      if (span) span.textContent = "Előkészítés…";
      const scene = await createVideoScene(videoOpts());
      const cv = document.querySelector("#shareCardPreview");
      const { blob, ext, mime } = await recordScene(cv, scene, {
        onProgress: (x) => { if (span) span.textContent = `Felvétel… ${Math.round(x * 100)}%`; },
      });
      return new File([blob], `${_safeName(_getShareTitle())}.${ext}`, { type: mime });
    } finally {
      _videoBusy = false;
      document.querySelectorAll("#shareCardDownload, #shareCardNativeShare").forEach((b) => { b.disabled = false; });
      if (span) span.textContent = orig;
      if (_shareMode === "video" && !document.querySelector("#shareCardOverlay")?.hidden) refreshVideoPreview();
    }
  }
  function downloadFile(file) {
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement("a"), { href: url, download: file.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  document.querySelector("#shareModeSeg")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-share-mode]");
    if (!b || b.dataset.shareMode === _shareMode || _videoBusy) return;
    _shareMode = b.dataset.shareMode;
    if (_shareMode === "image") stopVideoPreview();
    syncGroups(); refreshSharePreview();
  });
  document.querySelector("#shareVideoBgPicker")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-video-bg]");
    if (!b || _videoBusy) return;
    _videoBg = b.dataset.videoBg;
    if (_videoBg !== "media") lsSet("bt.videoBg", _videoBg);
    renderVideoControls();
    if (_videoBg === "media" && !_videoMedia) document.querySelector("#shareVideoMediaInput")?.click();
    refreshVideoPreview();
  });
  document.querySelector("#shareVideoAlignSeg")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-video-align]");
    if (!b || _videoBusy) return;
    _videoAlign = b.dataset.videoAlign; lsSet("bt.videoAlign", _videoAlign);
    renderVideoControls(); refreshVideoPreview();
  });
  document.querySelector("#shareVideoMapPicker")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-video-map]");
    if (!b || _videoBusy) return;
    _videoMap = b.dataset.videoMap; lsSet("bt.videoMap", _videoMap);
    renderVideoControls(); refreshVideoPreview();
  });
  document.querySelector("#shareVideoZoom")?.addEventListener("change", (e) => {
    _videoZoom = e.target.checked; lsSet("bt.videoZoom", _videoZoom ? "1" : "0");
    refreshVideoPreview();
  });
  document.querySelector("#shareVideoRoute")?.addEventListener("change", (e) => {
    _videoRoute = e.target.checked; lsSet("bt.videoRoute", _videoRoute ? "1" : "0");
    refreshVideoPreview();
  });
  document.querySelector("#shareVideoZones")?.addEventListener("change", (e) => {
    _videoZones = e.target.checked; lsSet("bt.videoZones", _videoZones ? "1" : "0");
    refreshVideoPreview();
  });
  document.querySelector("#shareVideoChartPicker")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-video-chart]");
    if (!b || _videoBusy) return;
    _videoChart = b.dataset.videoChart; lsSet("bt.videoChart", _videoChart);
    renderVideoControls(); refreshVideoPreview();
  });
  document.querySelector("#shareVideoDurSeg")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-video-dur]");
    if (!b || _videoBusy) return;
    _videoDur = Number(b.dataset.videoDur); lsSet("bt.videoDur", String(_videoDur));
    renderVideoControls(); refreshVideoPreview();
  });
  document.querySelector("#shareVideoMediaBtn")?.addEventListener("click", () => document.querySelector("#shareVideoMediaInput")?.click());
  document.querySelector("#shareVideoMediaInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      if (_videoMedia?.kind === "video") _videoMedia.el.pause();
      _videoMedia = await loadVideoMedia(file);
      _videoBg = "media";
    } catch (err) { _showToast?.(err.message); return; }
    renderVideoControls(); refreshVideoPreview();
  });

  async function refreshSharePreview() {
    if (!_shareCardData) return;
    if (_shareMode === "video") return refreshVideoPreview();
    const previewCanvas = document.querySelector("#shareCardPreview");
    if (!previewCanvas) return;
    const card = await createWorkoutShareCard(cardOpts());
    previewCanvas.width  = card.width;
    previewCanvas.height = card.height;
    const ctx = previewCanvas.getContext("2d");
    ctx.clearRect(0, 0, card.width, card.height);
    ctx.drawImage(card, 0, 0);
    // átlátszó (Matrica) képnél kockás háttér az előnézet mögött
    previewCanvas.classList.toggle("is-transparent", _shareLayout === "sticker");
  }

  // ── Fotó vezérlők ──────────────────────────────────────────────────────────
  function _togglePhotoControls() {
    const panel = document.querySelector("#sharePhotoControls");
    if (panel) panel.hidden = _shareTheme !== "photo";
  }

  document.querySelector("#sharePhotoUploadBtn")?.addEventListener("click", () => {
    document.querySelector("#sharePhotoInput")?.click();
  });
  document.querySelector("#sharePhotoInput")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      _sharePhoto.img = img;
      _sharePhoto.scale = 1; _sharePhoto.offsetX = 0; _sharePhoto.offsetY = 0;
      const scaleEl = document.querySelector("#sharePhotoScale");
      if (scaleEl) scaleEl.value = "1";
      const sv = document.querySelector("#sharePhotoScaleVal");
      if (sv) sv.textContent = "1.0×";
      const sliders = document.querySelector("#sharePhotoSliders");
      if (sliders) sliders.hidden = false;
      const lbl = document.querySelector("#sharePhotoUploadLabel");
      if (lbl) lbl.textContent = "Másik kép kiválasztása";
      refreshSharePreview();
    };
    img.src = url;
  });
  document.querySelector("#sharePhotoScale")?.addEventListener("input", (e) => {
    _sharePhoto.scale = parseFloat(e.target.value);
    const v = document.querySelector("#sharePhotoScaleVal");
    if (v) v.textContent = _sharePhoto.scale.toFixed(1) + "×";
    scheduleRefresh();
  });
  document.querySelector("#sharePhotoBlur")?.addEventListener("input", (e) => {
    _sharePhoto.blur = parseInt(e.target.value);
    const v = document.querySelector("#sharePhotoBlurVal");
    if (v) v.textContent = String(_sharePhoto.blur);
    scheduleRefresh();
  });
  document.querySelectorAll("[data-photo-headerbg]").forEach((btn) => {
    btn.addEventListener("click", () => {
      _sharePhoto.headerBg = btn.dataset.photoHeaderbg;
      document.querySelectorAll("[data-photo-headerbg]").forEach((b) => {
        b.classList.toggle("share-opt-btn--active", b.dataset.photoHeaderbg === _sharePhoto.headerBg);
      });
      refreshSharePreview();
    });
  });
  // Útvonal szín
  document.querySelector("#sharePhotoRouteColor")?.addEventListener("input", (e) => {
    _sharePhoto.routeColor = e.target.value;
    scheduleRefresh();
  });
  // Útvonal méret
  document.querySelector("#sharePhotoRouteScale")?.addEventListener("input", (e) => {
    _sharePhoto.routeScale = parseFloat(e.target.value);
    const v = document.querySelector("#sharePhotoRouteScaleVal");
    if (v) v.textContent = _sharePhoto.routeScale.toFixed(1) + "×";
    scheduleRefresh();
  });
  // Drag-cél kapcsoló: háttér vagy útvonal
  document.querySelectorAll("[data-photo-drag]").forEach((btn) => {
    btn.addEventListener("click", () => {
      _dragTarget = btn.dataset.photoDrag;
      document.querySelectorAll("[data-photo-drag]").forEach((b) => {
        b.classList.toggle("share-opt-btn--active", b.dataset.photoDrag === _dragTarget);
      });
    });
  });

  document.querySelector("#sharePhotoReset")?.addEventListener("click", () => {
    _sharePhoto.scale = 1; _sharePhoto.offsetX = 0; _sharePhoto.offsetY = 0;
    _sharePhoto.routeOffsetX = 0; _sharePhoto.routeOffsetY = 0; _sharePhoto.routeScale = 1;
    const scaleEl = document.querySelector("#sharePhotoScale");
    if (scaleEl) scaleEl.value = "1";
    const sv = document.querySelector("#sharePhotoScaleVal");
    if (sv) sv.textContent = "1.0×";
    const rScaleEl = document.querySelector("#sharePhotoRouteScale");
    if (rScaleEl) rScaleEl.value = "1";
    const rsv = document.querySelector("#sharePhotoRouteScaleVal");
    if (rsv) rsv.textContent = "1.0×";
    refreshSharePreview();
  });

  // Drag-to-position az előnézeten (csak fotó témánál, betöltött képpel)
  (() => {
    const cv = document.querySelector("#shareCardPreview");
    if (!cv) return;
    let dragging = false, lastX = 0, lastY = 0;
    cv.addEventListener("pointerdown", (e) => {
      if (_shareTheme !== "photo" || _shareMode === "video") return;
      // Háttér mozgatásához kell kép; útvonal mozgatásához nem
      if (_dragTarget === "photo" && !_sharePhoto.img) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      cv.setPointerCapture(e.pointerId);
      cv.style.cursor = "grabbing";
    });
    cv.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const rect = cv.getBoundingClientRect();
      const basePerPx = 360 / rect.width;   // base-360 egység / megjelenített px
      const dx = (e.clientX - lastX) * basePerPx;
      const dy = (e.clientY - lastY) * basePerPx;
      if (_dragTarget === "route") {
        _sharePhoto.routeOffsetX += dx;
        _sharePhoto.routeOffsetY += dy;
      } else {
        _sharePhoto.offsetX += dx;
        _sharePhoto.offsetY += dy;
      }
      lastX = e.clientX; lastY = e.clientY;
      scheduleRefresh();
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try { cv.releasePointerCapture(e.pointerId); } catch {}
      cv.style.cursor = "";
    };
    cv.addEventListener("pointerup", endDrag);
    cv.addEventListener("pointercancel", endDrag);
    cv.addEventListener("pointerleave", endDrag);
  })();

  // QR-kód: csak ha van nyilvános link, és a kapcsoló be van kapcsolva
  function _qrUrl() {
    const on = document.querySelector("#shareQrToggle")?.checked !== false;
    return on ? (_shareCardData?.shareUrl || null) : null;
  }
  document.querySelector("#shareQrToggle")?.addEventListener("change", () => { syncGroups(); refreshSharePreview(); });

  function openShareCardModal(mode) {
    if (!_shareCardData) return;
    if (mode === "image" || mode === "video") _shareMode = mode;
    const overlay = document.querySelector("#shareCardOverlay");
    if (!overlay) return;
    const qrRow = document.querySelector("#shareQrRow");
    if (qrRow) qrRow.hidden = !_shareCardData.shareUrl;
    const titleInput = document.querySelector("#shareCardTitle");
    if (titleInput) titleInput.value = _shareCardData.metaTitle || "";
    // az Elemzés saját edzésénél: érmes eredmények és szél (az „Eredmények” stílushoz); könyvtárból hívva nincs
    if (_shareRestore === undefined) {
      _shareCardData.highlights = getShareHighlights();
      _shareCardData.wind = getWorkoutWind()?.stats || null;
      const kcalTxt = document.querySelector("#fileKcal")?.textContent || "";
      const kcal = parseInt(kcalTxt.replace(/\D/g, ""), 10);
      if (_shareCardData.extra && !_shareCardData.extra.kcal && kcal > 0) _shareCardData.extra.kcal = kcal;
    }
    const modeSeg = document.querySelector("#shareModeSeg");
    if (modeSeg) modeSeg.hidden = !videoAvailable();
    if (!videoAvailable()) _shareMode = "image";
    renderChartPicker();
    renderStatPicker();
    syncGroups();
    overlay.hidden = false;
    refreshSharePreview();
    window.lucide?.createIcons();
  }

  document.querySelector("#shareChartPicker")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-share-chart]");
    if (!b || b.disabled) return;
    const id = b.dataset.shareChart;
    _shareCharts = _shareCharts.includes(id)
      ? _shareCharts.filter((x) => x !== id)
      : SHARE_CHARTS.map((c) => c.id).filter((x) => x === id || _shareCharts.includes(x));
    try { localStorage.setItem("bt.shareCharts", JSON.stringify(_shareCharts)); } catch {}
    renderChartPicker();
    syncGroups();
    refreshSharePreview();
  });

  function closeShareCardModal() {
    const overlay = document.querySelector("#shareCardOverlay");
    if (overlay) overlay.hidden = true;
    stopVideoPreview(); ++_videoToken;
    if (_shareRestore !== undefined) { _shareCardData = _shareRestore; _shareRestore = undefined; }
  }

  // Megosztás: közös ablak (kép, PDF, nyilvános link – ha könyvtári elem)
  function openFileShareMenu() {
    if (!_shareCardData) return;
    const id = _loadedLibraryRouteId;
    const hasLink = id && id !== "saved" && !_loadedIsSample;
    openShareModal({
      title: _shareCardData.title,
      url: hasLink ? shareRouteUrl(id) : null,
      noLinkText: _loadedIsSample
        ? "Közösségi útvonalhoz nincs külön nyilvános link."
        : "Nyilvános linkhez előbb mentsd el a könyvtárba.",
      onSaveForLink: _loadedIsSample ? undefined : async () => {
        const newId = await saveImportedToLibrary();
        if (!newId || newId === "saved") throw new Error("Mentés sikertelen");
        return shareRouteUrl(newId);
      },
      onImage: () => {
        _shareCardData.shareUrl = hasLink ? shareRouteUrl(id) : null;
        openShareCardModal("image");
      },
      onVideo: () => {
        _shareCardData.shareUrl = hasLink ? shareRouteUrl(id) : null;
        openShareCardModal("video");
      },
      onPdf: openFilePdf,
    });
  }

  function openFilePdf() {
    const d = _shareCardData;
    if (!d) return;
    const geo = d.geometry || [];
    const vals = (k) => geo.map((p) => p[k]).filter((v) => v != null && Number.isFinite(v));
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const fmt1 = (v) => v.toLocaleString("hu-HU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const extraStats = [];
    if (d.isWorkout) {
      const sp = vals("speed"), hr = vals("hr"), cad = vals("cad"), pw = vals("power");
      if (sp.length) extraStats.push([fmt1(Math.max(...sp)), "KM/H MAX"]);
      if (hr.length) { extraStats.push([`${Math.round(avg(hr))}`, "ÁTL. PULZUS"]); extraStats.push([`${Math.round(Math.max(...hr))}`, "MAX PULZUS"]); }
      if (cad.length) extraStats.push([`${Math.round(avg(cad.filter((c) => c > 0)) || 0)}`, "KADENCIA"]);
      if (pw.length) extraStats.push([`${Math.round(avg(pw))} W`, "ÁTL. TELJ."]);
    }
    const id = _loadedLibraryRouteId;
    const hasLink = id && id !== "saved" && !_loadedIsSample;
    openRoutePdfModal({
      title: d.metaTitle || d.title || "Útvonal",
      date: d.date || "",
      distanceKm: d.distanceKm || 0,
      ascentM: d.elevationM || 0,
      descentM: d.descentMeters ?? null,
      durationText: d.durationText || "",
      avgSpeedKmh: d.avgSpeedKmh || 0,
      isWorkout: d.isWorkout, extraStats,
      points: geo, geometry: geo,
      waypoints: geo.length >= 2 ? [geo[0], geo[geo.length - 1]] : [],
      shareUrl: hasLink ? shareRouteUrl(id) : null,   // link nélkül nincs QR
      filename: d.metaTitle || d.title || "utvonal",
    });
  }

  _elements.fileShareButton?.addEventListener("click", openFileShareMenu);
  document.querySelector("#shareCardClose")?.addEventListener("click", closeShareCardModal);
  document.querySelector("#shareCardOverlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeShareCardModal();
  });

  {
    let _titleDebounce = null;
    document.querySelector("#shareCardTitle")?.addEventListener("input", () => {
      clearTimeout(_titleDebounce);
      _titleDebounce = setTimeout(() => refreshSharePreview(), 400);
    });
  }

  // Stílusválasztó: kis rajzolt előnézet + név, a SHARE_LAYOUTS listából
  {
    const picker = document.querySelector("#shareLayoutPicker");
    if (picker) {
      picker.innerHTML = SHARE_LAYOUTS.map((l) => `
        <button type="button" class="sc-layout" role="radio" data-share-layout="${l.id}" title="${l.hint}">
          <span class="sc-layout-thumb sc-layout-thumb--${l.id}" aria-hidden="true"><i></i><b></b><em></em></span>
          <span class="sc-layout-name">${l.label}</span>
        </button>`).join("");
      const sync = () => {
        picker.querySelectorAll("[data-share-layout]").forEach((b) => {
          const on = b.dataset.shareLayout === _shareLayout;
          b.classList.toggle("sc-layout--active", on);
          b.setAttribute("aria-checked", on ? "true" : "false");
        });
        // Az „Adatsáv háttere” csak az adatpanelos stílusnál értelmes
        document.querySelectorAll("#sharePhotoControls [data-panel-only]")
          .forEach((el) => { el.hidden = _shareLayout !== "panel"; });
      };
      sync();
      picker.addEventListener("click", (e) => {
        const b = e.target.closest("[data-share-layout]");
        if (!b || b.dataset.shareLayout === _shareLayout) return;
        _shareLayout = b.dataset.shareLayout;
        try { localStorage.setItem("bt.shareLayout", _shareLayout); } catch {}
        sync();
        syncGroups();
        refreshSharePreview();
      });
    }
  }

  document.querySelectorAll("[data-share-theme]").forEach((btn) => {
    btn.addEventListener("click", () => {
      _shareTheme = btn.dataset.shareTheme;
      if (_shareTheme !== "photo") lsSet("bt.shareTheme", _shareTheme);
      _togglePhotoControls();
      syncGroups();
      refreshSharePreview();
    });
  });

  document.querySelectorAll("[data-share-size]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (_shareMode === "video") {
        _videoSize = btn.dataset.shareSize === "square" ? "story" : btn.dataset.shareSize;
        lsSet("bt.videoSize", _videoSize);
      } else {
        _shareSize = btn.dataset.shareSize;
        lsSet("bt.shareSize", _shareSize);
      }
      syncGroups();
      refreshSharePreview();
    });
  });

  function _getShareTitle() {
    const v = document.querySelector("#shareCardTitle")?.value?.trim();
    return v || _shareCardData?.title || "bringaterv";
  }

  function _safeName(title) {
    return title.toLowerCase().replace(/[^a-z0-9áéíóöőúüűäçšžñ]+/gi, "-").replace(/^-+|-+$/g, "");
  }

  async function _buildCard() {
    return createWorkoutShareCard({ ...cardOpts(), title: _getShareTitle() });
  }

  document.querySelector("#shareCardNativeShare")?.addEventListener("click", async () => {
    if (!_shareCardData || _videoBusy) return;
    if (_shareMode === "video") {
      let file;
      try { file = await recordVideo(document.querySelector("#shareCardNativeShare")); }
      catch (err) { console.error("Videó:", err); _showToast?.(err?.message || "Nem sikerült a videó."); return; }
      try {
        if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: "Bringaterv edzés" }); return; }
      } catch (err) { if (err?.name === "AbortError") return; }
      downloadFile(file);
      return;
    }
    const btn = document.querySelector("#shareCardNativeShare");
    const span = btn?.querySelector("span");
    if (btn) { btn.disabled = true; if (span) span.textContent = "Generálás…"; }
    try {
      if (_qrUrl()) await ensureLinkPublic(_qrUrl());   // QR a képen → a link legyen bekapcsolva
      const card = await _buildCard();
      const title = _getShareTitle();
      const filename = `${_safeName(title)}-share.png`;
      if (navigator.canShare) {
        const blob = await new Promise(res => card.toBlob(res, "image/png"));
        const file = new File([blob], filename, { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "Bringaterv edzés" });
          return;
        }
      }
      downloadShareCard(card, filename);
    } catch (err) {
      if (err?.name !== "AbortError") {
        try { downloadShareCard(await _buildCard(), `${_safeName(_getShareTitle())}-share.png`); } catch {}
      }
    } finally {
      if (btn) { btn.disabled = false; if (span) span.textContent = "Megosztás"; }
    }
  });

  document.querySelector("#shareCardDownload")?.addEventListener("click", async () => {
    if (!_shareCardData || _videoBusy) return;
    if (_shareMode === "video") {
      try { downloadFile(await recordVideo(document.querySelector("#shareCardDownload"))); }
      catch (err) { console.error("Videó:", err); _showToast?.(err?.message || "Nem sikerült a videó."); }
      return;
    }
    const dlBtn = document.querySelector("#shareCardDownload");
    const span  = dlBtn?.querySelector("span");
    if (dlBtn) { dlBtn.disabled = true; if (span) span.textContent = "Generálás…"; }
    try {
      if (_qrUrl()) await ensureLinkPublic(_qrUrl());   // QR a képen → a link legyen bekapcsolva
      const card = await _buildCard();
      downloadShareCard(card, `${_safeName(_getShareTitle())}-share.png`);
    } finally {
      if (dlBtn) { dlBtn.disabled = false; if (span) span.textContent = "Letöltés"; }
    }
  });

  // Külső hívás (könyvtár, tervező): csak ideiglenesen cseréli az Elemzés fül
  // megosztási adatát – bezáráskor visszaáll (különben az Elemzés fül
  // Megosztás/PDF funkciója a rossz geometriával dolgozna).
  window._openShareCardWith = function(data, { mode = "image" } = {}) {
    if (_shareRestore === undefined) _shareRestore = _shareCardData;
    _shareCardData = data;
    openShareCardModal(mode);
  };
}
