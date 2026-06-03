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
import { fitToGpx } from '../gpx/fit.js';
import { createWorkoutShareCard, downloadShareCard } from './shareCard.js';
import { reverseGeocode } from './search.js';

// ── Injektált függőségek ──────────────────────────────────────────────────────
let _store, _mapAdapter, _api, _elements, _i18n, _showToast, _switchTab;
let _updateElevationButton, _applyRouteLayer, _clearWindResult;
let _calculateImportedDistance, _calcEstimatedTimeMixed;
let _loadRouteLibrary, _openExportModal, _renderHrZoneAnalysis, _formatDisplayDistance;

export function initFileTab({
  store, mapAdapter, api, elements, i18n, showToast, switchTab,
  updateElevationButton, applyRouteLayer, clearWindResult,
  calculateImportedDistance, calcEstimatedTimeMixed,
  loadRouteLibrary, openExportModal, renderHrZoneAnalysis, formatDisplayDistance,
}) {
  _store = store; _mapAdapter = mapAdapter; _api = api; _elements = elements;
  _i18n = i18n; _showToast = showToast; _switchTab = switchTab;
  _updateElevationButton = updateElevationButton; _applyRouteLayer = applyRouteLayer;
  _clearWindResult = clearWindResult;
  _calculateImportedDistance = calculateImportedDistance;
  _calcEstimatedTimeMixed = calcEstimatedTimeMixed;
  _loadRouteLibrary = loadRouteLibrary; _openExportModal = openExportModal;
  _renderHrZoneAnalysis = renderHrZoneAnalysis; _formatDisplayDistance = formatDisplayDistance;

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
  _elements.fileSaveToLibraryButton?.addEventListener("click", async () => {
    const btn = _elements.fileSaveToLibraryButton;
    if (btn?.disabled) return;
    if (btn) {
      btn.disabled = true;
      const lbl = btn.querySelector("span");
      if (lbl) lbl.textContent = "Mentés…";
    }
    const state = _store.getState();
    const name = _importedFileName || "Edzés";

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
    const durationMin = distanceKm != null
      ? _calcEstimatedTimeMixed(state.routeSegments, state.mode ?? 'asphalt', distanceKm, ascentMeters ?? 0, descentMeters, true)
      : null;

    let fitContent = null;
    if (_importedFitBuffer) {
      fitContent = arrayBufferToBase64(_importedFitBuffer);
    }

    try {
      const saved = await _api.saveRoute({
        name,
        gpxContent:  content,
        fitContent,
        distance:    distanceKm,
        duration:    durationMin,
        elevation:   ascentMeters,
        type:        "workout",
        description: "",
      });
      _showToast(`„${name}" mentve az Edzések közé${fitContent ? " (FIT-tel)" : ""}`);
      _loadedLibraryRouteId = saved?.id || saved?.route?.id || "saved";
      updateFileSaveButtonState();
      if (typeof _loadRouteLibrary === "function") _loadRouteLibrary();
    } catch (err) {
      console.error("Edzés mentési hiba:", err);
      _showToast("Nem sikerült menteni. Az API elérhető?");
      if (btn) {
        btn.disabled = false;
        const lbl = btn.querySelector("span");
        if (lbl) lbl.textContent = "Mentés könyvtárba";
      }
    }
  });

  // Share Card modal
  _initShareCardModal();
}

// ── Modul-szintű state ────────────────────────────────────────────────────────
let _hasImportedFile = false;
let _importedFileName = "";
let _importedGpxText  = null;
let _importedFitBuffer = null;
let _loadedLibraryRouteId = null;
let _shareCardData = null;
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
export function getLoadedLibraryRouteId()     { return _loadedLibraryRouteId; }
export function getImportedFileName()         { return _importedFileName; }
export function getImportedGpxText()          { return _importedGpxText; }

/** loadRouteFromLibrary hívja, hogy könyvtárból töltött fájl adatait állítsa be. */
export function setLoadedRoute(id, name, gpxText) {
  _loadedLibraryRouteId = id;
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
  if (!ms || ms <= 0) return "";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h} ó ${m > 0 ? m + " p" : ""}`.trim();
  if (m > 0) return `${m} p ${s > 0 ? s + " mp" : ""}`.trim();
  return `${s} mp`;
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
export function populateFileTab({ filename, geometry, distanceMeters, ascentMeters, descentMeters, speedColored = false, meta = {}, isFit = false }) {
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

  const totalDurRow   = document.querySelector("#fileTotalDurRow");
  const movingDurRow  = document.querySelector("#fileMovingDurRow");
  const totalDurStr   = formatDuration(meta.totalDuration);
  const movingDurStr  = formatDuration(meta.movingDuration);
  if (totalDurRow)  { totalDurRow.hidden  = !totalDurStr; if (totalDurStr)  document.querySelector("#fileTotalDur").textContent  = totalDurStr; }
  if (movingDurRow) { movingDurRow.hidden = !movingDurStr; if (movingDurStr) document.querySelector("#fileMovingDur").textContent = movingDurStr; }
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
  document.querySelector("#fileAvgSpeedRow").hidden = !hasSpeed;
  document.querySelector("#fileMaxSpeedRow").hidden = !hasSpeed;
  if (hasSpeed) {
    const avg = Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length * 10) / 10;
    const max = Math.round(Math.max(...speeds) * 10) / 10;
    document.querySelector("#fileAvgSpeed").textContent = `${avg} km/h`;
    document.querySelector("#fileMaxSpeed").textContent = `${max} km/h`;
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
    const maxPower = Math.round(Math.max(...powers));
    const avgPowerEl = document.querySelector("#fileAvgPower");
    const maxPowerEl = document.querySelector("#fileMaxPower");
    if (avgPowerEl) avgPowerEl.textContent = `${avgPower} W`;
    if (maxPowerEl) maxPowerEl.textContent = `${maxPower} W`;
  }

  const powerLegendEl = document.querySelector("#powerLegend");
  if (powerLegendEl) powerLegendEl.hidden = !hasPower;

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
    const avgSpd = hasSpeed
      ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length * 10) / 10
      : 0;
    const step = Math.max(1, Math.floor(geometry.length / 400));
    const simPts = [];
    for (let i = 0; i < geometry.length; i += step) simPts.push({ lat: geometry[i].lat, lng: geometry[i].lng });
    if (simPts.length && simPts[simPts.length - 1] !== geometry[geometry.length - 1]) {
      const last = geometry[geometry.length - 1];
      simPts.push({ lat: last.lat, lng: last.lng });
    }
    _shareCardData = {
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

export function clearFileTab() {
  _hasImportedFile = false;
  document.querySelector("#fileEmptyState").hidden = false;
  document.querySelector("#fileDetails").hidden = true;
  const speedLeg = document.querySelector("#speedLegend");
  const hrLeg = document.querySelector("#hrLegend");
  const cadLeg = document.querySelector("#cadLegend");
  const powerLeg = document.querySelector("#powerLegend");
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
  if (lbl) lbl.textContent = "Mentés könyvtárba";
}

// ── GPX / FIT import ──────────────────────────────────────────────────────────
export async function processImportedFile(file) {
  if (!file) return;
  const isFit = /\.fit$/i.test(file.name);
  let gpxText;
  let fitBuffer = null;

  if (isFit) {
    try {
      fitBuffer = await file.arrayBuffer();
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
    imported = await importGpx(gpxFile, { sampleWaypoints: _elements.gpxSampleWaypoints?.checked });
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
  _importedGpxText   = gpxText;
  _importedFitBuffer = fitBuffer;
  _loadedLibraryRouteId = null;
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

  for (const wp of _store.getState().waypoints) {
    const name = await reverseGeocode(wp.lat, wp.lng);
    if (name && _store.getState().waypoints.some((w) => w.id === wp.id)) {
      _store.updateWaypoint(wp.id, { name });
    }
  }
}

// ── Share Card modal ──────────────────────────────────────────────────────────
function _initShareCardModal() {
  let _shareTheme = "light";
  let _shareSize  = "square";

  async function refreshSharePreview() {
    if (!_shareCardData) return;
    const previewCanvas = document.querySelector("#shareCardPreview");
    if (!previewCanvas) return;
    const titleInput = document.querySelector("#shareCardTitle");
    const titleVal   = titleInput?.value?.trim() || _shareCardData.title;
    const card = await createWorkoutShareCard({
      ..._shareCardData,
      title: titleVal,
      theme: _shareTheme,
      size:  _shareSize,
    });
    previewCanvas.width  = card.width;
    previewCanvas.height = card.height;
    const ctx = previewCanvas.getContext("2d");
    ctx.drawImage(card, 0, 0);
  }

  function openShareCardModal() {
    if (!_shareCardData) return;
    const overlay = document.querySelector("#shareCardOverlay");
    if (!overlay) return;
    const titleInput = document.querySelector("#shareCardTitle");
    if (titleInput) titleInput.value = _shareCardData.metaTitle || "";
    overlay.hidden = false;
    refreshSharePreview();
    window.lucide?.createIcons();
  }

  function closeShareCardModal() {
    const overlay = document.querySelector("#shareCardOverlay");
    if (overlay) overlay.hidden = true;
  }

  _elements.fileShareButton?.addEventListener("click", openShareCardModal);
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

  document.querySelectorAll("[data-share-theme]").forEach((btn) => {
    btn.addEventListener("click", () => {
      _shareTheme = btn.dataset.shareTheme;
      document.querySelectorAll("[data-share-theme]").forEach((b) => {
        b.classList.toggle("share-opt-btn--active", b.dataset.shareTheme === _shareTheme);
      });
      refreshSharePreview();
    });
  });

  document.querySelectorAll("[data-share-size]").forEach((btn) => {
    btn.addEventListener("click", () => {
      _shareSize = btn.dataset.shareSize;
      document.querySelectorAll("[data-share-size]").forEach((b) => {
        b.classList.toggle("share-opt-btn--active", b.dataset.shareSize === _shareSize);
      });
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
    return createWorkoutShareCard({
      ..._shareCardData,
      title: _getShareTitle(),
      theme: _shareTheme,
      size:  _shareSize,
    });
  }

  document.querySelector("#shareCardNativeShare")?.addEventListener("click", async () => {
    if (!_shareCardData) return;
    const btn = document.querySelector("#shareCardNativeShare");
    const span = btn?.querySelector("span");
    if (btn) { btn.disabled = true; if (span) span.textContent = "Generálás…"; }
    try {
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
    if (!_shareCardData) return;
    const dlBtn = document.querySelector("#shareCardDownload");
    const span  = dlBtn?.querySelector("span");
    if (dlBtn) { dlBtn.disabled = true; if (span) span.textContent = "Generálás…"; }
    try {
      const card = await _buildCard();
      downloadShareCard(card, `${_safeName(_getShareTitle())}-share.png`);
    } finally {
      if (dlBtn) { dlBtn.disabled = false; if (span) span.textContent = "Letöltés (PNG)"; }
    }
  });

  window._openShareCardWith = function(data) {
    _shareCardData = data;
    openShareCardModal();
  };
}
