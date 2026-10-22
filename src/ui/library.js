/**
 * Bringaterv – Library Module
 * ============================
 * Az útvonalkönyvtár teljes logikája: betöltés, renderelés, szerkesztés, szűrés.
 *
 * Init:
 *   import { initLibrary, loadRouteLibrary, renderLibraryGrid } from './ui/library.js';
 *   initLibrary({ api, toast, downloadGpx, loadRoute, openShareCardWith,
 *                 openStravaImportModal, processImportedFile, refreshStravaStatus,
 *                 getStravaStatus, libraryData, libraryFilter, DIST_MAX, DUR_MAX });
 */

import { openRoutePdfModal, resolveShareBase, shareRouteUrl } from "./routePdfModal.js";
import { importGpx } from "../gpx/gpx.js";
import { openShareModal } from "./shareModal.js";
import { openSubmitRouteModal } from "./submitRoute.js";
import { shareCardPoints } from "./shareCard.js";
import { num, int, dur, durMs } from "../format.js";

// ── Injektált függőségek ──────────────────────────────────────────────────────
let _api, _toast, _downloadGpx, _loadRoute, _openShareCardWith;
let _openStravaImportModal, _processImportedFile, _refreshStravaStatus, _getStravaStatus;
let _data, _filter, _DIST_MAX, _DUR_MAX;

export function initLibrary({
  api, toast, downloadGpx, loadRoute, openShareCardWith,
  openStravaImportModal, processImportedFile, refreshStravaStatus, getStravaStatus,
  libraryData, libraryFilter, DIST_MAX, DUR_MAX,
}) {
  _api = api; _toast = toast; _downloadGpx = downloadGpx; _loadRoute = loadRoute;
  _openShareCardWith = openShareCardWith; _openStravaImportModal = openStravaImportModal;
  _processImportedFile = processImportedFile; _refreshStravaStatus = refreshStravaStatus;
  _getStravaStatus = getStravaStatus;
  _data = libraryData; _filter = libraryFilter;
  _DIST_MAX = DIST_MAX; _DUR_MAX = DUR_MAX;
  _registerListeners();
}

// ── Modul-szintű state ────────────────────────────────────────────────────────
let _viewMode     = localStorage.getItem("bringaterv.libraryView") || "cards";
let _expandedId   = null;
const _geomCache  = new Map();
let _listSort     = JSON.parse(localStorage.getItem("bringaterv.libraryListSort") || "null")
                    || { key: "date", dir: "desc" };

// ── Betöltés ──────────────────────────────────────────────────────────────────
export async function loadRouteLibrary() {
  const elLoading = document.querySelector("#libraryLoading");
  const elOffline = document.querySelector("#libraryOffline");
  const elFilter  = document.querySelector("#libraryFilterPanel");
  elLoading.hidden = false;
  elOffline.hidden = true;
  invalidateLibraryGeometry();   // a térképes nézet újratölti a nyomvonalakat
  if (elFilter) elFilter.hidden = true;
  try {
    const [userRoutes, samples] = await Promise.all([_api.listRoutes(), _api.listSamples()]);
    const isWorkoutEntry = r => r.type === "workout" || !!r.strava_id || !!r.start_time;
    _data.routes   = userRoutes.filter(r => !isWorkoutEntry(r));
    _data.workouts = userRoutes.filter(isWorkoutEntry);
    _data.samples  = samples;
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

// ── View mód ─────────────────────────────────────────────────────────────────
export function setLibraryViewMode(mode) {
  _viewMode = ["list", "map"].includes(mode) ? mode : "cards";
  localStorage.setItem("bringaterv.libraryView", _viewMode);
  document.querySelectorAll(".library-view-btn").forEach(btn =>
    btn.classList.toggle("is-active", btn.dataset.view === _viewMode));
  renderLibraryGrid();
}

// ── List-view rendezés ────────────────────────────────────────────────────────
export function setLibraryListSort(key) {
  if (_listSort.key === key) {
    _listSort.dir = _listSort.dir === "desc" ? "asc" : "desc";
  } else {
    _listSort = { key, dir: "desc" };
  }
  localStorage.setItem("bringaterv.libraryListSort", JSON.stringify(_listSort));
  renderLibraryGrid();
}

function _applyListSort(items) {
  const k = _listSort.key, dir = _listSort.dir === "asc" ? 1 : -1;
  const acc = {
    date:      x => x.route.start_time || x.route.date || "",
    name:      x => (x.route.name || "").toLowerCase(),
    duration:  x => x.route.duration  ?? 0,
    distance:  x => x.route.distance  ?? 0,
    elevation: x => x.route.elevation ?? 0,
    calories:  x => x.route.calories  ?? 0,
    effort:    x => x.route.suffer_score ?? 0,
  }[k] || (x => x.route.start_time || x.route.date || "");
  return [...items].sort((a, b) => {
    const va = acc(a), vb = acc(b);
    return va < vb ? -dir : va > vb ? dir : 0;
  });
}

// ── Segédfüggvények ───────────────────────────────────────────────────────────
export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function sourceLabel(src) {
  return { strava: "STRAVA", garmin: "GARMIN", fit: "FIT", manual: "SAJÁT", sample: "KÖZÖSSÉGI" }[src] ?? src?.toUpperCase() ?? "—";
}

export function libraryRouteSportKey(route) {
  const t = (route.sport_type || route.type || "").toLowerCase();
  if (!t) return "cycling";
  if (t.includes("cycl") || t.includes("ride") || t.includes("bike")
      || t === "asphalt" || t === "gravel" || t === "mtb") return "cycling";
  if (t.includes("hik")) return "hike";
  if (t.includes("walk")) return "walk";
  if (t.includes("run")) return "run";
  return "other";
}

function libraryRouteSport(route) {
  const k = libraryRouteSportKey(route);
  return { cycling: "Kerékpár", run: "Futás", hike: "Túra", walk: "Gyaloglás", other: "Egyéb" }[k] ?? k;
}

export function libraryRouteSource(route, category) {
  if (category === "sample") return "sample";
  if (route.strava_id) return "strava";
  if (route.garmin_id) return "garmin";
  if (route.has_fit)   return "fit";
  return "manual";
}

function libraryFormatDuration(min) {
  return min == null ? "—" : dur(min);
}

function formatRouteDuration(minutes) {
  return minutes == null ? "" : dur(minutes);
}

export function smartDateFormat(isoDate) {
  if (!isoDate) return "";
  try {
    const d = new Date(isoDate); const now = new Date();
    const diffD = Math.floor((now - d) / 86400000);
    if (diffD === 0) return "Ma";
    if (diffD === 1) return "Tegnap";
    if (diffD < 7)  return `${diffD} napja`;
    return d.toLocaleDateString("hu-HU", { month: "short", day: "numeric" });
  } catch { return isoDate; }
}

function smartDateTimeFormat(route) {
  const dateLbl = smartDateFormat(route.start_time || route.date);
  if (!route.start_time) return dateLbl;
  const d = new Date(route.start_time);
  const t = d.toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
  return `${dateLbl} ${t}`;
}

// ── SVG mini preview ──────────────────────────────────────────────────────────
export function renderRouteSvgMini(points) {
  if (!points || points.length < 2) return '';
  const SIZE = 56, PAD = 3;
  const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const lngScale = Math.cos(midLat * Math.PI / 180);
  const dLat = maxLat - minLat || 1e-9, dLng = (maxLng - minLng) * lngScale || 1e-9;
  const scale = (SIZE - 2 * PAD) / Math.max(dLat, dLng);
  const offX = (SIZE - dLng * scale) / 2, offY = (SIZE - dLat * scale) / 2;
  const toX = lng => offX + (lng - minLng) * lngScale * scale;
  const toY = lat => SIZE - offY - (lat - minLat) * scale;
  const d = points.map((p, i) => (i === 0 ? 'M' : 'L') + toX(p.lng).toFixed(1) + ',' + toY(p.lat).toFixed(1)).join(' ');
  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;display:block">
    <path d="${d}" fill="none" stroke="#e8461e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
  </svg>`;
}

function renderRouteSvg(points) {
  if (!points || points.length < 2) return '';
  const SIZE = 160, PAD = 8;
  const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const lngScale = Math.cos(midLat * Math.PI / 180);
  const dLat = maxLat - minLat || 1e-9, dLng = (maxLng - minLng) * lngScale || 1e-9;
  const scale = (SIZE - 2 * PAD) / Math.max(dLat, dLng);
  const offX = (SIZE - dLng * scale) / 2, offY = (SIZE - dLat * scale) / 2;
  const toX = lng => offX + (lng - minLng) * lngScale * scale;
  const toY = lat => SIZE - offY - (lat - minLat) * scale;
  const d = points.map((p, i) => (i === 0 ? 'M' : 'L') + toX(p.lng).toFixed(1) + ',' + toY(p.lat).toFixed(1)).join(' ');
  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    <path d="${d}" fill="none" stroke="#e8461e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// ── GPX statisztikák (expand row-hoz) ─────────────────────────────────────────
function aggregateGpxStats(points) {
  const hrs = points.map(p => p.hr).filter(v => v != null && v > 30 && v < 230);
  const cads = points.map(p => p.cad).filter(v => v != null && v > 0 && v < 200);
  const pows = points.map(p => p.power).filter(v => v != null && v >= 0 && v < 2000);
  const times = points.map(p => p.time).filter(v => v != null);
  const speeds = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i-1], b = points[i];
    if (!a.time || !b.time) continue;
    const dt = (b.time - a.time) / 1000;
    if (dt < 1 || dt > 300) continue;
    const dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
    const dist = 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
    const v = (dist / dt) * 3.6;
    if (v > 0 && v < 100) speeds.push(v);
  }
  const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const max = arr => arr.length ? Math.max(...arr) : null;
  return {
    startTime: times.length ? new Date(times[0]) : null,
    avgHr: avg(hrs) != null ? Math.round(avg(hrs)) : null,
    maxHr: max(hrs) != null ? Math.round(max(hrs)) : null,
    avgCad: avg(cads) != null ? Math.round(avg(cads)) : null,
    avgPower: avg(pows) != null ? Math.round(avg(pows)) : null,
    maxPower: max(pows) != null ? Math.round(max(pows)) : null,
    avgSpeed: avg(speeds) != null ? Number(avg(speeds).toFixed(1)) : null,
    maxSpeed: max(speeds) != null ? Number(max(speeds).toFixed(1)) : null,
  };
}

// Lenyitott sor statjai – ugyanaz a stílus, mint a diagramfejléceké
// (nagy szám, kis mértékegység, alatta halvány felirat)
function libStat(label, value, unit = "") {
  return `<div class="cs-stat"><b>${value}${unit ? `<small>${unit}</small>` : ""}</b><span>${label}</span></div>`;
}
function libDuration(min) {
  if (min == null) return "–";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h}<small>ó</small> ${m}<small>p</small>` : `${m}<small>p</small>`;
}

function renderExtendedStats(s) {
  if (!s) return "";
  const rows = [];
  if (s.avgSpeed != null) rows.push(libStat("Átlagsebesség", num(s.avgSpeed, 1), "km/h"));
  if (s.maxSpeed != null) rows.push(libStat("Max. sebesség", num(s.maxSpeed, 1), "km/h"));
  if (s.avgHr != null)    rows.push(libStat("Átlagpulzus", int(s.avgHr), "bpm"));
  if (s.maxHr != null)    rows.push(libStat("Max. pulzus", int(s.maxHr), "bpm"));
  if (s.avgCad != null)   rows.push(libStat("Átl. kadencia", int(s.avgCad), "rpm"));
  if (s.avgPower != null) rows.push(libStat("Átl. teljesítmény (mért)", int(s.avgPower), "W"));
  if (s.startTime) rows.push(libStat("Indulás", s.startTime.toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" })));
  return rows.join("");
}

// ── Expand preview betöltés ───────────────────────────────────────────────────
export async function loadAndRenderExpandPreview(routeId) {
  const slot    = document.getElementById(`libExpPreview_${routeId}`);
  const statsEl = document.getElementById(`libExpStats_${routeId}`);
  if (!slot) return;

  const appendExtra = (html) => {
    if (!statsEl || !html || statsEl.dataset.extraDone) return;
    statsEl.insertAdjacentHTML("beforeend", html);
    statsEl.dataset.extraDone = "1";
  };

  const cached = _geomCache.get(routeId);
  if (cached) { slot.innerHTML = renderRouteSvg(cached.points); appendExtra(renderExtendedStats(cached.stats)); return; }
  slot.innerHTML = '<span style="color:var(--muted);font-size:11px">Töltés…</span>';
  try {
    const gpxText = await _api.loadRoute(routeId).catch(() => null)
                 ?? await _api.loadSample(routeId).catch(() => null);
    if (!gpxText) { slot.innerHTML = '<span style="color:var(--muted);font-size:11px">Nem elérhető</span>'; return; }
    const xml = new DOMParser().parseFromString(gpxText, "application/xml");
    const nodes = [...xml.getElementsByTagNameNS("*", "trkpt"), ...xml.getElementsByTagNameNS("*", "rtept")];
    const fullPts = nodes.map(n => {
      const hr  = n.getElementsByTagNameNS("*", "hr")[0];
      const cad = n.getElementsByTagNameNS("*", "cad")[0];
      const wat = n.getElementsByTagNameNS("*", "watts")[0] || n.getElementsByTagNameNS("*", "power")[0];
      const tm  = n.querySelector("time")?.textContent;
      return { lat: parseFloat(n.getAttribute("lat")), lng: parseFloat(n.getAttribute("lon")),
               hr: hr ? Number(hr.textContent) : null, cad: cad ? Number(cad.textContent) : null,
               power: wat ? Number(wat.textContent) : null, time: tm ? new Date(tm).getTime() : null };
    }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (fullPts.length < 2) { slot.innerHTML = '<span style="color:var(--muted);font-size:11px">—</span>'; return; }
    const stats = aggregateGpxStats(fullPts);
    const step = Math.max(1, Math.floor(fullPts.length / 200));
    const simplified = [];
    for (let i = 0; i < fullPts.length; i += step) simplified.push(fullPts[i]);
    if (simplified[simplified.length-1] !== fullPts[fullPts.length-1]) simplified.push(fullPts[fullPts.length-1]);
    _geomCache.set(routeId, { points: simplified, stats });
    setTimeout(() => _geomCache.delete(routeId), 5 * 60 * 1000);
    slot.innerHTML = renderRouteSvg(simplified);
    appendExtra(renderExtendedStats(stats));
  } catch { slot.innerHTML = '<span style="color:var(--muted);font-size:11px">Hiba</span>'; }
}

export async function loadCardPreview(routeId, isSample, slotEl = null) {
  // A kártya ilyenkor még nincs a DOM-ban → a hívó átadhatja a slot elemet
  const slot = slotEl || document.getElementById(`libCardPreview_${routeId}`);
  if (!slot) return;
  const cached = _geomCache.get(routeId);
  if (cached) { slot.innerHTML = renderRouteSvgMini(cached.points || cached); return; }
  try {
    const gpxText = isSample ? await _api.loadSample(routeId).catch(() => null)
                              : await _api.loadRoute(routeId).catch(() => null);
    if (!gpxText) return;
    const xml = new DOMParser().parseFromString(gpxText, "application/xml");
    const pts = [...xml.getElementsByTagNameNS("*", "trkpt"), ...xml.getElementsByTagNameNS("*", "rtept")]
      .map(n => ({ lat: parseFloat(n.getAttribute("lat")), lng: parseFloat(n.getAttribute("lon")) }))
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (pts.length < 2) return;
    const step = Math.max(1, Math.floor(pts.length / 100));
    const simp = [];
    for (let i = 0; i < pts.length; i += step) simp.push(pts[i]);
    if (simp[simp.length-1] !== pts[pts.length-1]) simp.push(pts[pts.length-1]);
    _geomCache.set(routeId, { points: simp, stats: null });
    setTimeout(() => _geomCache.delete(routeId), 5 * 60 * 1000);
    if (slot.isConnected) slot.innerHTML = renderRouteSvgMini(simp);
  } catch {}
}

// ── Szerkesztési modal ────────────────────────────────────────────────────────
export function openLibraryEditModal(route) {
  const overlay   = document.querySelector("#libraryEditOverlay");
  const nameInput = document.querySelector("#libraryEditName");
  const descInput = document.querySelector("#libraryEditDesc");
  const saveBtn   = document.querySelector("#libraryEditSave");
  if (!overlay) return;
  nameInput.value = route.name;
  descInput.value = route.description ?? "";
  const editTypeVal = (route.type === "cycling" ? "asphalt" : route.type) ?? "asphalt";
  const typeRadio = overlay.querySelector(`input[name="libraryEditType"][value="${editTypeVal}"]`);
  if (typeRadio) typeRadio.checked = true;
  overlay.hidden = false;
  window.lucide?.createIcons();
  setTimeout(() => nameInput.select(), 50);
  const newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.replaceWith(newSaveBtn);
  newSaveBtn.addEventListener("click", async () => {
    const newName = nameInput.value.trim() || route.name;
    const newType = overlay.querySelector("input[name=\"libraryEditType\"]:checked")?.value ?? route.type;
    const newDesc = descInput.value.trim();
    try {
      const updated = await _api.updateRoute(route.id, { name: newName, type: newType, description: newDesc });
      route.name = updated.name; route.type = updated.type; route.description = updated.description;
      const updateInList = list => {
        const idx = list.findIndex(r => r.id === updated.id);
        if (idx !== -1) { list[idx].name = updated.name; list[idx].type = updated.type; list[idx].description = updated.description; }
      };
      updateInList(_data.routes); updateInList(_data.workouts);
      overlay.hidden = true;
      renderLibraryGrid();
      _toast(`„${updated.name}" frissítve`);
    } catch (err) { _toast(err.message || "Nem sikerült menteni a módosítást."); }
  });
}

// ── Expand row toggle ─────────────────────────────────────────────────────────
export function toggleLibraryRowExpand(routeId) {
  if (_expandedId === routeId) {
    _expandedId = null;
    document.querySelectorAll(".library-list-expand-row").forEach(r => r.remove());
    document.querySelectorAll(".library-list-row").forEach(r => r.classList.remove("is-expanded"));
    return;
  }
  document.querySelectorAll(".library-list-expand-row").forEach(r => r.remove());
  document.querySelectorAll(".library-list-row").forEach(r => r.classList.remove("is-expanded"));
  _expandedId = routeId;
  const mainRow = document.querySelector(`.library-list-row[data-id="${routeId}"]`);
  if (!mainRow) return;
  mainRow.classList.add("is-expanded");

  // Megkeressük a route-ot az adatokban
  const allRoutes = [..._data.routes, ..._data.workouts, ..._data.samples];
  const route = allRoutes.find(r => r.id === routeId);
  if (!route) return;
  const isSample  = _data.samples.some(r => r.id === routeId);
  const category  = _data.workouts.some(r => r.id === routeId) ? "workout" : (isSample ? "sample" : "route");
  const expandRow = buildLibraryExpandRow(route, category, isSample);
  mainRow.insertAdjacentElement("afterend", expandRow);
  loadAndRenderExpandPreview(routeId);
  window.lucide?.createIcons({ nodes: [expandRow] });
}

// ── Expand row felépítés ──────────────────────────────────────────────────────
function buildLibraryExpandRow(route, category, isSample) {
  const tr = document.createElement("tr");
  tr.className = "library-list-expand-row";
  const td = document.createElement("td");
  td.colSpan = 10;
  const previewSlot = `<div class="library-expand-preview" id="libExpPreview_${route.id}">…</div>`;
  // Statok – a diagramfejlécekkel egyező stílusban
  const card = libStat;
  const stats = [];
  if (route.distance != null)  stats.push(card("Táv", num(route.distance, 1), "km"));
  if (route.duration != null)  stats.push(card("Idő", libDuration(route.duration)));
  if (route.elevation != null) stats.push(card("Emelkedés", int(route.elevation), "m"));
  if (route.calories != null)  stats.push(card("Kalória", int(route.calories), "kcal"));
  if (route.suffer_score != null) stats.push(card("Relatív terhelés", int(route.suffer_score)));
  if (route.weighted_avg_watts != null) stats.push(card("Súlyozott telj. (NP)", int(route.weighted_avg_watts), "W"));
  else if (route.avg_watts != null)     stats.push(card("Átl. teljesítmény", int(route.avg_watts), "W"));
  if (route.kilojoules != null) stats.push(card("Mechanikai munka", int(route.kilojoules), "kJ"));
  if (route.pr_count > 0)       stats.push(card("Személyes rekord", route.pr_count));

  // Fejléc-sor: sport + teljes dátum (+ hely) – a nyers „workout” helyett
  const sportLabel = libraryRouteSport(route);
  const kindLabel  = category === "workout" ? "Edzés" : category === "sample" ? "Közösségi útvonal" : "Útvonal";
  const dateSrc    = route.start_time || route.date;
  const dateLabel  = dateSrc ? new Date(dateSrc).toLocaleDateString("hu-HU", { year: "numeric", month: "long", day: "numeric" }) : "";
  const place      = route.location_city ? escapeHtml(route.location_city) + (route.location_country ? ", " + escapeHtml(route.location_country) : "") : "";
  const metaLine   = [kindLabel + (sportLabel ? " · " + escapeHtml(sportLabel) : ""), dateLabel, place].filter(Boolean).join(" · ");
  // Közösségi útvonal: nehézség, évszak, beküldő
  const DIFF = { easy: "Könnyű", medium: "Közepes", hard: "Nehéz" };
  const SEASON = { all: "Egész évben", "spring-autumn": "Tavasztól őszig", summer: "Nyáron", dry: "Száraz időben" };
  const loc = route.location || {};
  const locLine = category === "sample" && (loc.settlement || loc.region) ? [
    "📍 " + escapeHtml([...new Set([loc.settlement, loc.region, (loc.countries?.length > 1 ? loc.countries.join(", ") : loc.country)].filter(Boolean))].join(" · ")),
    loc.loop === true ? "körtúra" : loc.loop === false ? "A → B" : "",
  ].filter(Boolean).join(" · ") + (loc.places?.length > 1 ? `<br>Érinti: ${escapeHtml(loc.places.join(", "))}` : "") : "";
  const communityLine = category === "sample" ? [
    DIFF[route.difficulty] ? `Nehézség: ${DIFF[route.difficulty]}` : "",
    SEASON[route.season] ? `Ajánlott: ${SEASON[route.season]}` : "",
    route.author ? `Beküldte: ${escapeHtml(route.author)}` : "",
  ].filter(Boolean).join(" · ") : "";

  const isWorkout = category === "workout";
  td.innerHTML = `
    <div class="library-list-expand-inner">
      ${previewSlot}
      <div class="library-expand-body">
        <div class="library-expand-meta">${metaLine}</div>
        ${communityLine ? `<div class="library-expand-meta">${communityLine}</div>` : ""}
        ${locLine ? `<div class="library-expand-meta">${locLine}</div>` : ""}
        <div class="library-expand-cards" id="libExpStats_${route.id}">${stats.join("")}</div>
        ${route.description ? `<div class="library-expand-desc">${escapeHtml(route.description)}</div>` : ""}
      </div>
      <div class="library-expand-actions">
        <div class="library-expand-actions-main">
          <button class="library-card-btn library-card-btn--primary" data-action="load-${isWorkout ? "file" : "plan"}">
            ${isWorkout ? "Betöltés elemzéshez" : "Betöltés tervezésre"}
          </button>
          ${!isWorkout ? '' : '<button class="library-card-btn" data-action="load-plan">Betöltés tervezésre</button>'}
          <button class="library-card-btn" data-action="share-menu" title="Megosztó kép, PDF útvonallap, nyilvános link">Megosztás</button>
          <button class="library-card-btn" data-action="download-gpx">GPX</button>
          ${route.has_fit ? '<button class="library-card-btn" data-action="download-fit">FIT</button>' : ''}
          ${route.strava_id ? '<button class="library-card-btn" data-action="strava-refresh">Frissítés Stravából</button>' : ''}
          ${route.strava_id ? `<a class="library-card-btn" href="https://www.strava.com/activities/${route.strava_id}" target="_blank" rel="noopener">Megnyitás Stravában ↗</a>` : ''}
          ${(!isWorkout && !isSample) ? `<button class="library-card-btn${route.garmin_course_id ? ' garmin-uploaded' : ''}" data-action="garmin-course" title="Tervezett útvonal feltöltése Garmin Connect course-ként (navigációhoz)">${route.garmin_course_id ? '✓ Garmin – újraküldés' : 'Küldés Garminra'}</button>` : ''}
          ${(route.garmin_course_id) ? `<a class="library-card-btn garmin-course-link" href="https://connect.garmin.com/modern/course/${route.garmin_course_id}" target="_blank" rel="noopener" title="Course megnyitása a Garmin Connectben">Garmin course ↗</a>` : ''}
        </div>
        ${!isSample ? `<div class="library-expand-actions-end">
          <button class="library-card-btn library-stats-toggle${route.include_in_stats === false ? '' : ' is-on'}" data-action="toggle-stats">${route.include_in_stats === false ? '☐ Statisztikán kívül' : '☑ Statisztikában'}</button>
          <button class="library-card-btn" data-action="submit-community" title="Beküldés a közösségi útvonalak közé (admin jóváhagyással)">Beküldés a közösbe</button>
          <button class="library-card-btn" data-action="edit">Szerkesztés</button>
          <button class="library-card-btn library-card-btn--danger" data-action="delete">Törlés</button>
        </div>` : ''}
      </div>
    </div>`;

  const runAction = makeRouteActionRunner(route, isSample);

  td.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      runAction(btn.dataset.action, btn);
    });
  });
  tr.append(td);
  return tr;
}

// Egy elem műveletei – a lista lenyitott sora, a kártya „Egyéb” menüje és a
// Megosztás-ablak is ezt hívja
function makeRouteActionRunner(route, isSample) {
async function runAction(act, btn) {
    const origLabel = btn.textContent;
    try {
      if (act === "share-menu") {
        openShareModal({
          title: route.name || "Útvonal",
          url: isSample ? null : shareRouteUrl(route.id),
          onImage: () => runAction("share", btn),
          onPdf:   () => runAction("pdf", btn),
        });
      } else if (act === "load-file" || act === "load-plan") {
        await _loadRoute(route.id, isSample, route.name, act === "load-plan" ? "plan" : "file");
      } else if (act === "download-gpx") {
        const gpx = isSample ? await _api.loadSample(route.id) : await _api.loadRoute(route.id);
        _downloadGpx(`${route.name}.gpx`, gpx);
      } else if (act === "download-fit") {
        const blob = await _api.loadRouteFit(route.id);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = `${route.name}.fit`; a.click();
        URL.revokeObjectURL(url);
      } else if (act === "edit") {
        openLibraryEditModal(route);
      } else if (act === "submit-community") {
        openSubmitRouteModal(route);
      } else if (act === "toggle-stats") {
        const next = route.include_in_stats === false;
        btn.disabled = true;
        try {
          await _api.updateRoute(route.id, { include_in_stats: next });
          route.include_in_stats = next;
          for (const coll of [_data.routes, _data.workouts]) {
            const i = coll.findIndex(r => r.id === route.id);
            if (i >= 0) coll[i].include_in_stats = next;
          }
          btn.classList.toggle("is-on", next);
          btn.textContent = next ? "☑ Statisztikában" : "☐ Statisztikán kívül";
          _toast(next ? "Beleszámít a statisztikákba" : "Kihagyva a statisztikákból");
        } catch { _toast("Nem sikerült módosítani."); } finally { btn.disabled = false; }
      } else if (act === "strava-refresh") {
        _toast("Frissítés Stravából…");
        try {
          const res = await _api.strava.refreshActivity(route.id);
          const updated = res.entry;
          for (const coll of [_data.routes, _data.workouts]) {
            const i = coll.findIndex(r => r.id === route.id);
            if (i >= 0) coll[i] = { ...coll[i], ...updated };
          }
          renderLibraryGrid(); _toast("Frissítve ✓");
        } catch (err) {
          if (err.message?.includes("401")) { _toast("Strava kapcsolat lejárt – csatlakozz újra"); await _refreshStravaStatus?.(); }
          else _toast("Frissítés sikertelen: " + err.message);
        }
      } else if (act === "garmin-course") {
        const already = !!route.garmin_course_id;
        if (already && !confirm("Ezt az útvonalat korábban már feltöltötted Garminra.\n\nFeltöltöd újra? Új course jön létre a Garminon. (Ha a régit közben törölted a Garmin oldalon, ez pótolja; ha nem, akkor egy másolat lesz belőle.)")) return;
        btn.disabled = true;
        const labelSpan = btn.childNodes[btn.childNodes.length - 1];
        labelSpan.textContent = "Feltöltés Garminra…";
        try {
          const res = await _api.garmin.uploadCourse(route.id);
          // Megjegyezzük memóriában is, hogy a re-render is mutassa
          route.garmin_course_id = res.course_id;
          for (const coll of [_data.routes, _data.workouts]) {
            const i = coll.findIndex(r => r.id === route.id);
            if (i >= 0) coll[i].garmin_course_id = res.course_id;
          }
          btn.classList.add("garmin-uploaded");
          labelSpan.textContent = "✓ Feltöltve – újraküldés";
          // Course-link beszúrása (ha még nincs)
          if (res.course_id && !btn.parentElement.querySelector(".garmin-course-link")) {
            const a = document.createElement("a");
            a.className = "library-card-btn garmin-course-link";
            a.href = `https://connect.garmin.com/modern/course/${res.course_id}`;
            a.target = "_blank"; a.rel = "noopener";
            a.title = "Course megnyitása a Garmin Connectben";
            a.textContent = "↗ Garmin course";
            btn.after(a);
          }
          _toast(`✓ Garminra feltöltve: „${res.course_name}" (${res.distance_km} km, +${res.elevation_gain_m} m) – nézd meg a Garmin Connect appban`);
        } catch (err) {
          labelSpan.textContent = already ? "✓ Feltöltve – újraküldés" : "Küldés Garminra";
          if (err.message?.toLowerCase().includes("nincs garmin") || err.message?.includes("409"))
            _toast("Előbb csatlakozz Garminhoz: Beállítások → Garmin Connect");
          else _toast("Garmin feltöltés sikertelen: " + err.message);
        } finally { btn.disabled = false; }
      } else if (act === "share") {
        btn.disabled = true; btn.textContent = "Betöltés…";
        try {
          const gpxText = isSample ? await _api.loadSample(route.id) : await _api.loadRoute(route.id);
          // Teljes feldolgozás (sebesség, pulzus, kadencia, teljesítmény is – a grafikonokhoz);
          // hiba esetén egyszerű lat/lng/ele parsolás.
          let pts = null;
          try { pts = (await importGpx(new Blob([gpxText]))).geometry; } catch (_) {}
          if (!pts?.length) {
            const xml = new DOMParser().parseFromString(gpxText, "application/xml");
            pts = [...xml.getElementsByTagNameNS("*", "trkpt"), ...xml.getElementsByTagNameNS("*", "rtept")]
              .map(n => ({ lat: parseFloat(n.getAttribute("lat")), lng: parseFloat(n.getAttribute("lon")),
                           ele: parseFloat(n.getElementsByTagNameNS("*", "ele")[0]?.textContent) }));
          }
          pts = pts.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
          const simPts = shareCardPoints(pts);
          const distKm = route.distance ?? 0, durMin = route.duration ?? null;
          _openShareCardWith?.({
            title: route.name || "Bringaterv edzés", metaTitle: route.name || "",
            date: route.date ? new Date(route.date).toLocaleDateString("hu-HU", { year: "numeric", month: "long", day: "numeric" }) : "",
            distanceKm: distKm, durationText: durMin != null ? _fmtMin(durMin * 60 * 1000) : "",
            avgSpeedKmh: (durMin && distKm) ? Math.round(distKm / (durMin / 60) * 10) / 10 : 0,
            elevationM: route.elevation ?? 0, points: simPts,
            shareUrl: isSample ? null : shareRouteUrl(route.id),
          });
        } catch (err) { _toast("Nem sikerült betölteni a geometriát."); console.error(err); }
        finally { btn.disabled = false; btn.textContent = origLabel; }
      } else if (act === "pdf") {
        btn.disabled = true; btn.textContent = "Betöltés…";
        try {
          const gpxText = isSample ? await _api.loadSample(route.id) : await _api.loadRoute(route.id);
          const xml = new DOMParser().parseFromString(gpxText, "application/xml");
          const nodes = [...xml.getElementsByTagNameNS("*", "trkpt"), ...xml.getElementsByTagNameNS("*", "rtept")];
          // Teljes feldolgozás (idő → sebesség, pulzus, kadencia) az importGpx-szel;
          // hiba esetén egyszerű lat/lng/ele parsolás.
          let parsedGeo = null;
          try { parsedGeo = (await importGpx(new Blob([gpxText]))).geometry; } catch (_) {}
          const geometry = parsedGeo?.length ? parsedGeo : nodes.map(n => {
            const eleN = n.getElementsByTagNameNS("*", "ele")[0];
            return {
              lat: parseFloat(n.getAttribute("lat")),
              lng: parseFloat(n.getAttribute("lon")),
              ele: eleN ? parseFloat(eleN.textContent) : null,
            };
          }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
          // Nevesített pontok (wpt / rtept) – ha nincs legalább 2, a start/cél geometria
          const named = [...xml.getElementsByTagNameNS("*", "wpt"), ...xml.getElementsByTagNameNS("*", "rtept")]
            .map(n => ({
              lat: parseFloat(n.getAttribute("lat")),
              lng: parseFloat(n.getAttribute("lon")),
              name: n.getElementsByTagNameNS("*", "name")[0]?.textContent?.trim() || "",
            }))
            .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
          const waypoints = named.length >= 2 ? named
            : (geometry.length >= 2 ? [geometry[0], geometry[geometry.length - 1]] : []);
          const distKm = route.distance ?? 0, durMin = route.duration ?? null;
          const isWorkout = route.type === "workout";
          const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
          const fmt1 = (v) => v.toLocaleString("hu-HU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
          const extraStats = [];
          if (isWorkout) {
            if (num(route.max_speed_kmh))  extraStats.push([fmt1(route.max_speed_kmh), "KM/H MAX"]);
            if (num(route.avg_heartrate))  extraStats.push([`${Math.round(route.avg_heartrate)}`, "ÁTL. PULZUS"]);
            if (num(route.max_heartrate))  extraStats.push([`${Math.round(route.max_heartrate)}`, "MAX PULZUS"]);
            if (num(route.avg_cadence))    extraStats.push([`${Math.round(route.avg_cadence)}`, "KADENCIA"]);
            if (num(route.avg_watts))      extraStats.push([`${Math.round(route.avg_watts)} W`, "ÁTL. TELJ."]);
            if (num(route.calories))       extraStats.push([`${Math.round(route.calories)}`, "KCAL"]);
          }
          const dateSrc = route.start_time || route.date;
          openRoutePdfModal({
            title: route.name || "Útvonalterv",
            date: dateSrc ? new Date(dateSrc).toLocaleDateString("hu-HU", { year: "numeric", month: "long", day: "numeric" }) : "",
            distanceKm: distKm,
            ascentM: route.elevation ?? 0,
            descentM: null,
            durationText: durMin != null ? _fmtMin(durMin * 60 * 1000) : "",
            avgSpeedKmh: num(route.avg_speed_kmh)
              ?? ((durMin && distKm) ? Math.round(distKm / (durMin / 60) * 10) / 10 : 0),
            isWorkout, extraStats,
            points: geometry, geometry, waypoints,
            shareUrl: isSample ? resolveShareBase() : shareRouteUrl(route.id),
            filename: route.name || "utvonalterv",
          });
        } catch (err) { _toast("Nem sikerült betölteni a geometriát."); console.error(err); }
        finally { btn.disabled = false; btn.textContent = origLabel; }
      } else if (act === "delete") {
        if (!confirm(`Biztosan törlöd: „${route.name}"?`)) return;
        await _api.deleteRoute(route.id);
        _data.routes   = _data.routes.filter(r => r.id !== route.id);
        _data.workouts = _data.workouts.filter(r => r.id !== route.id);
        _expandedId = null;
        renderLibraryGrid();
        _toast(`„${route.name}" törölve`);
      }
    } catch (err) { console.error("Library action error:", err); _toast("Művelet sikertelen."); }
}
return runAction;
}

function _fmtMin(ms) {
  return durMs(ms);
}

// ── List nézet renderelés ────────────────────────────────────────────────────
function renderLibraryListView(items, container) {
  const sorted = _applyListSort(items);
  const SH = { key: _listSort.key, dir: _listSort.dir };
  const thIcon = k => k === SH.key ? (SH.dir === "asc" ? " ↑" : " ↓") : "";
  const makeThBtn = (key, label, cls = "") =>
    `<button class="lib-col-sort-btn${cls}" data-sort-key="${key}">${label}${thIcon(key)}</button>`;

  container.innerHTML = `<table class="library-list-table">
    <thead><tr>
      <th class="lib-col-sport"></th>
      <th class="lib-col-date">${makeThBtn("date","Dátum")}</th>
      <th class="lib-col-name">${makeThBtn("name","Név")}</th>
      <th class="lib-col-num lib-col-dur">${makeThBtn("duration","Idő")}</th>
      <th class="lib-col-num lib-col-dist">${makeThBtn("distance","Táv")}</th>
      <th class="lib-col-num lib-col-elev">Szint</th>
      <th class="lib-col-num lib-col-kcal">${makeThBtn("calories","kcal")}</th>
      <th class="lib-col-num lib-col-effort">${makeThBtn("effort","Terhelés")}</th>
      <th class="lib-col-source">Forrás</th>
      <th class="lib-col-chev"></th>
    </tr></thead>
    <tbody></tbody>
  </table>`;

  const tbody = container.querySelector("tbody");
  sorted.forEach(({ route, category, isSample }) => {
    const row = buildLibraryListRow({ route, category, isSample });
    tbody.append(row);
    if (route.id === _expandedId) {
      const expandRow = buildLibraryExpandRow(route, category, isSample);
      tbody.append(expandRow);
      row.classList.add("is-expanded");
      loadAndRenderExpandPreview(route.id);
    }
  });

  // Fejléc kattintás → rendezés
  container.querySelectorAll("[data-sort-key]").forEach(btn => {
    btn.addEventListener("click", () => setLibraryListSort(btn.dataset.sortKey));
  });
  window.lucide?.createIcons({ nodes: [container] });
}

// ── List nézet sor ────────────────────────────────────────────────────────────
export function buildLibraryListRow({ route, category, isSample }) {
  const SPORT_ICONS = { cycling: "bike", run: "footprints", hike: "mountain-snow", walk: "footprints", other: "activity" };
  const sportKey = libraryRouteSportKey(route);
  const sportIcon = SPORT_ICONS[sportKey] ?? "bike";
  const source = libraryRouteSource(route, category);
  const srcLbl = sourceLabel(source);
  const srcCls = { strava: "lib-badge--strava", garmin: "lib-badge--garmin", fit: "lib-badge--fit", manual: "lib-badge--saját", sample: "lib-badge--sablon" }[source] ?? "";
  const dateStr = smartDateTimeFormat(route);
  const effortVal = route.suffer_score != null ? Math.round(route.suffer_score) : (route.calories != null ? Math.round(route.calories / 10) : null);

  const tr = document.createElement("tr");
  tr.className = `library-list-row`;
  tr.dataset.id = route.id;
  tr.dataset.category = category;
  tr.innerHTML = `
    <td class="lib-col-sport"><i data-lucide="${sportIcon}" aria-hidden="true" title="${libraryRouteSport(route)}"></i></td>
    <td class="lib-col-date lib-date-cell">
      <span class="lib-date-main">${dateStr.split(' ')[0] ?? dateStr}</span>
      ${dateStr.includes(' ') ? `<span class="lib-date-time">${dateStr.split(' ').slice(1).join(' ')}</span>` : ''}
    </td>
    <td class="lib-col-name"><span class="lib-name-text">${escapeHtml(route.name ?? "")}</span><span class="lib-row-sub">${[
      route.distance != null ? num(route.distance, 1) + " km" : "",
      route.duration != null ? libraryFormatDuration(route.duration) : "",
      route.elevation ? int(route.elevation) + " m" : "",
    ].filter(Boolean).join(" · ")}</span></td>
    <td class="lib-col-num lib-col-dur">${route.duration != null ? libraryFormatDuration(route.duration) : "—"}</td>
    <td class="lib-col-num lib-col-dist">${route.distance != null ? num(route.distance, 1) + " km" : "—"}</td>
    <td class="lib-col-num lib-col-elev">${route.elevation != null ? route.elevation + " m" : "—"}</td>
    <td class="lib-col-num lib-col-kcal">${route.calories != null ? Math.round(route.calories) : "—"}</td>
    <td class="lib-col-num lib-col-effort">${effortVal != null ? `<span class="lib-effort-badge">${effortVal}</span>` : "—"}</td>
    <td class="lib-col-source"><span class="lib-badge ${srcCls}">${srcLbl}</span></td>
    <td class="lib-col-chev"><i data-lucide="chevron-down" aria-hidden="true" class="lib-chev"></i></td>
  `;
  tr.addEventListener("click", () => toggleLibraryRowExpand(route.id));
  return tr;
}

// ── Kártya nézet ─────────────────────────────────────────────────────────────
export function createLibraryCard(route, category, isSample) {
  const card = document.createElement("div");
  card.className = "library-card";
  card.dataset.id = route.id;
  const isWorkout = category === "workout";
  const sportKey = libraryRouteSportKey(route);
  const source = libraryRouteSource(route, category);
  const srcLbl = sourceLabel(source);
  const srcCls = { strava: "lib-badge--strava", garmin: "lib-badge--garmin", fit: "lib-badge--fit", manual: "lib-badge--saját", sample: "lib-badge--sablon" }[source] ?? "";

  card.innerHTML = `
    <div class="library-card-inner">
      <div class="library-card-top">
        <div class="library-card-meta">
          <span class="library-card-name">${escapeHtml(route.name ?? "")}</span>
          <span class="library-card-date">${category === "sample" && route.location?.settlement
            ? escapeHtml([...new Set([route.location.settlement, route.location.region].filter(Boolean))].join(" · "))
            : smartDateTimeFormat(route)}</span>
        </div>
        <div class="library-card-preview library-card-preview-slot" id="libCardPreview_${route.id}"></div>
      </div>
      <div class="library-card-stats">
        ${route.distance  != null ? `<span class="lib-chip">${num(route.distance, 1)} km</span>` : ""}
        ${route.duration  != null ? `<span class="lib-chip">${libraryFormatDuration(route.duration)}</span>` : ""}
        ${route.elevation != null ? `<span class="lib-chip">${route.elevation} m</span>` : ""}
      </div>
      <div class="library-card-footer">
        <span class="lib-badge ${srcCls}">${srcLbl}</span>
        <div class="library-card-actions">
          <button class="library-card-load-btn" data-action="load-${isWorkout ? "file" : "plan"}" title="${isWorkout ? "Betöltés elemzéshez" : "Betöltés tervezésre"}">
            <i data-lucide="${isWorkout ? "chart-line" : "map-pin-plus"}" aria-hidden="true"></i>
            <span>${isWorkout ? "Elemzés" : "Tervezés"}</span>
          </button>
          <button class="library-card-action-btn" data-action="more" title="További műveletek" aria-haspopup="menu">
            <i data-lucide="ellipsis" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </div>`;

  // Lazy preview
  loadCardPreview(route.id, isSample, card.querySelector(".library-card-preview-slot"));

  // Kártya kattintás → betöltés
  card.addEventListener("click", (e) => {
    if (e.target.closest("[data-action]")) return;
    _loadRoute(route.id, isSample, route.name, isWorkout ? "file" : "plan");
  });

  card.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const act = btn.dataset.action;
      if (act === "load-file" || act === "load-plan") {
        await _loadRoute(route.id, isSample, route.name, act === "load-plan" ? "plan" : "file");
      } else if (act === "more") {
        openRouteActionMenu(route, category, isSample, btn);
      }
    });
  });
  return card;
}

// ── „Egyéb” menü a kártyákhoz (ugyanazok a műveletek, mint a lista lenyitott sorában) ──
function routeActionItems(route, category, isSample) {
  const isWorkout = category === "workout";
  const items = [];
  if (isWorkout) items.push({ act: "load-plan", icon: "map-pin-plus", label: "Betöltés tervezésre" });
  else items.push({ act: "load-file", icon: "chart-line", label: "Megnyitás az Elemzésben" });
  items.push({ act: "share-menu", icon: "share-2", label: "Megosztás", hint: "kép, PDF, link" });
  items.push({ act: "download-gpx", icon: "download", label: "GPX letöltése" });
  if (route.has_fit) items.push({ act: "download-fit", icon: "file-down", label: "FIT letöltése" });
  if (route.strava_id) {
    items.push({ act: "strava-refresh", icon: "refresh-cw", label: "Frissítés Stravából" });
    items.push({ href: `https://www.strava.com/activities/${route.strava_id}`, icon: "external-link", label: "Megnyitás Stravában" });
  }
  if (!isWorkout && !isSample) {
    items.push({ act: "garmin-course", icon: "watch", label: route.garmin_course_id ? "Újraküldés Garminra" : "Küldés Garminra" });
  }
  if (route.garmin_course_id) {
    items.push({ href: `https://connect.garmin.com/modern/course/${route.garmin_course_id}`, icon: "external-link", label: "Garmin course megnyitása" });
  }
  if (!isSample) {
    items.push({ act: "submit-community", icon: "users", label: "Beküldés a közösségi útvonalak közé" });
    items.push({ sep: true });
    items.push({ act: "toggle-stats", icon: route.include_in_stats === false ? "square" : "square-check",
                 label: "Beleszámít a statisztikába" });
    items.push({ act: "edit", icon: "pencil", label: "Szerkesztés" });
    items.push({ sep: true });
    items.push({ act: "delete", icon: "trash-2", label: "Törlés", danger: true });
  }
  return items;
}

let _menuEl = null;
function closeRouteActionMenu() {
  _menuEl?.remove();
  _menuEl = null;
  document.removeEventListener("keydown", _menuKey);
}
function _menuKey(e) { if (e.key === "Escape") closeRouteActionMenu(); }

function openRouteActionMenu(route, category, isSample, anchor) {
  closeRouteActionMenu();
  const runAction = makeRouteActionRunner(route, isSample);
  const ov = document.createElement("div");
  ov.className = "lib-menu-overlay";
  ov.innerHTML = `
    <div class="lib-menu" role="menu" aria-label="Műveletek">
      <div class="lib-menu-head">
        <span class="lib-menu-title">${escapeHtml(route.name || "Útvonal")}</span>
        <button class="lib-menu-close" type="button" aria-label="Bezárás"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <div class="lib-menu-list">
        ${routeActionItems(route, category, isSample).map((it) => it.sep ? '<div class="lib-menu-sep"></div>'
          : it.href
            ? `<a class="lib-menu-item" role="menuitem" href="${it.href}" target="_blank" rel="noopener"><i data-lucide="${it.icon}" aria-hidden="true"></i><span>${it.label}</span></a>`
            : `<button class="lib-menu-item${it.danger ? " is-danger" : ""}" role="menuitem" type="button" data-act="${it.act}"><i data-lucide="${it.icon}" aria-hidden="true"></i><span>${it.label}</span>${it.hint ? `<small>${it.hint}</small>` : ""}</button>`
        ).join("")}
      </div>
    </div>`;
  document.body.appendChild(ov);
  _menuEl = ov;

  // Asztali nézetben a gomb mellé igazítva, mobilon alulról nyíló lap (CSS)
  const menu = ov.querySelector(".lib-menu");
  if (!matchMedia("(max-width: 600px)").matches && !anchor) {
    menu.style.width = "280px";
    menu.style.left = "50%"; menu.style.top = "50%"; menu.style.transform = "translate(-50%, -50%)";
  }
  if (!matchMedia("(max-width: 600px)").matches && anchor) {
    const r = anchor.getBoundingClientRect();
    const w = 260;
    menu.style.position = "fixed";
    menu.style.width = `${w}px`;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    requestAnimationFrame(() => {
      const h = menu.offsetHeight;
      const below = r.bottom + 6 + h <= window.innerHeight - 8;
      menu.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
    });
  }

  ov.addEventListener("click", (e) => {
    if (e.target === ov || e.target.closest(".lib-menu-close")) { closeRouteActionMenu(); return; }
    if (e.target.closest("a.lib-menu-item")) { closeRouteActionMenu(); return; }
    const item = e.target.closest("[data-act]");
    if (!item) return;
    closeRouteActionMenu();
    runAction(item.dataset.act, item);
  });
  document.addEventListener("keydown", _menuKey);
  window.lucide?.createIcons({ nodes: [ov] });
}

// ── Fő render ─────────────────────────────────────────────────────────────────
export function renderLibraryGrid() {
  updateLocationFilters();
  const grid    = document.querySelector("#libraryGrid");
  const list    = document.querySelector("#libraryList");
  const emptyEl = document.querySelector("#libraryGridEmpty");
  const countEl = document.querySelector("#libraryResultCount");
  const headerEl = document.querySelector("#libraryMainHeader");
  const statsEl  = document.querySelector("#libraryMainStats .library-main-stats-text");
  if (!grid || !list) return;

  const all = [
    ..._data.routes.map(r  => ({ route: r, category: "route",   isSample: false })),
    ..._data.workouts.map(r => ({ route: r, category: "workout", isSample: false })),
    ..._data.samples.map(r  => ({ route: r, category: "sample",  isSample: true  })),
  ];

  let filtered = _filter.type === "all" ? all : all.filter(({ category }) => category === _filter.type);

  if (_filter.source !== "all") {
    filtered = filtered.filter(({ route, category }) => {
      if (category === "sample") return false;
      return libraryRouteSource(route, category) === _filter.source;
    });
  }
  if (_filter.sport !== "all") filtered = filtered.filter(({ route }) => libraryRouteSportKey(route) === _filter.sport);

  const q = _filter.query.toLowerCase().trim();
  if (q) filtered = filtered.filter(({ route }) => {
    const loc = route.location || {};
    const hay = [route.name, route.description, loc.settlement, loc.region, loc.country,
                 ...(loc.places || []), ...(loc.countries || [])].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });

  // Helyszín-szűrők (közösségi útvonalaknál)
  if (_filter.type === "sample") {
    const inCountry = (loc) => !_filter.country || loc.country === _filter.country || (loc.countries || []).includes(_filter.country);
    if (_filter.country) filtered = filtered.filter(({ route }) => inCountry(route.location || {}));
    if (_filter.region)  filtered = filtered.filter(({ route }) => (route.location || {}).region === _filter.region);
    if (_filter.shape !== "all") filtered = filtered.filter(({ route }) => {
      const loc = route.location || {};
      if (loc.loop === undefined) return false;
      return _filter.shape === "loop" ? loc.loop : !loc.loop;
    });
  }

  if (_filter.distMin > 0 || _filter.distMax < _DIST_MAX) {
    filtered = filtered.filter(({ route }) => {
      const d = route.distance ?? null;
      return d == null ? _filter.distMin === 0 : d >= _filter.distMin && d <= _filter.distMax;
    });
  }
  if (_filter.durMin > 0 || _filter.durMax < _DUR_MAX) {
    filtered = filtered.filter(({ route }) => {
      const dur = route.duration ?? null;
      return dur == null ? _filter.durMin === 0 : dur >= _filter.durMin && dur <= _filter.durMax;
    });
  }

  const ts = r => r.start_time || r.date || "";
  filtered = [...filtered].sort((a, b) => {
    switch (_filter.sort) {
      case "oldest":   return ts(a.route) < ts(b.route) ? -1 : 1;
      case "name":     return (a.route.name ?? "").localeCompare(b.route.name ?? "");
      case "distance": return (b.route.distance ?? 0) - (a.route.distance ?? 0);
      case "duration": return (b.route.duration ?? 0) - (a.route.duration ?? 0);
      default:         return ts(a.route) < ts(b.route) ? 1 : -1;
    }
  });

  if (countEl) countEl.textContent = `${filtered.length} találat`;

  if (headerEl && statsEl) {
    headerEl.hidden = filtered.length === 0;
    const totalKm = filtered.reduce((s, x) => s + (x.route.distance || 0), 0);
    const totalDur = filtered.reduce((s, x) => s + (x.route.duration || 0), 0);
    const totalElev = filtered.reduce((s, x) => s + (x.route.elevation || 0), 0);
    const h = Math.floor(totalDur / 60), m = totalDur % 60;
    const byCat = { workout: 0, route: 0, sample: 0 };
    for (const x of filtered) byCat[x.category] = (byCat[x.category] || 0) + 1;
    const catLegend = _viewMode === "list"
      ? `<span class="lib-stat-sep">·</span>` +
        (byCat.workout ? `<span class="lib-cat-pill lib-cat-pill--workout">${byCat.workout} edzés</span>` : "") +
        (byCat.route   ? `<span class="lib-cat-pill lib-cat-pill--route">${byCat.route} terv</span>` : "") +
        (byCat.sample  ? `<span class="lib-cat-pill lib-cat-pill--sample">${byCat.sample} közösségi</span>` : "")
      : "";
    statsEl.innerHTML =
      `<strong>${filtered.length}</strong> elem` +
      `<span class="lib-stat-sep">·</span><strong>${int(totalKm)}</strong> km` +
      `<span class="lib-stat-sep">·</span><strong>${dur(h * 60 + m)}</strong>` +
      `<span class="lib-stat-sep">·</span><strong>${int(totalElev)}</strong> m szint${catLegend}`;
  }

  document.querySelectorAll(".library-view-btn").forEach(btn =>
    btn.classList.toggle("is-active", btn.dataset.view === _viewMode));

  grid.innerHTML = ""; list.innerHTML = "";
  const useList = _viewMode === "list", useMap = _viewMode === "map";
  grid.hidden = useList || useMap; list.hidden = !useList;
  const mapWrap = document.querySelector("#libraryMapWrap");
  if (mapWrap) mapWrap.hidden = !useMap;
  if (filtered.length === 0) { if (emptyEl) emptyEl.hidden = false; if (useMap) renderLibraryMap([]); return; }
  if (emptyEl) emptyEl.hidden = true;

  if (useMap) {
    renderLibraryMap(filtered);
  } else if (useList) {
    renderLibraryListView(filtered, list);
  } else {
    filtered.forEach(({ route, category, isSample }) => grid.append(createLibraryCard(route, category, isSample)));
    window.lucide?.createIcons({ nodes: [grid] });
  }
}

// ── Event listeners ────────────────────────────────────────────────────────────
function _registerListeners() {
  // Edit modal
  document.querySelector("#libraryEditClose")?.addEventListener("click", () => {
    document.querySelector("#libraryEditOverlay").hidden = true;
  });
  document.querySelector("#libraryEditOverlay")?.addEventListener("click", e => {
    if (e.target === document.querySelector("#libraryEditOverlay"))
      document.querySelector("#libraryEditOverlay").hidden = true;
  });

  // Refresh / retry
  document.querySelector("#libraryRefreshBtn")?.addEventListener("click", loadRouteLibrary);
  document.querySelector("#libraryRetryBtn")?.addEventListener("click", loadRouteLibrary);

  // View toggle
  document.querySelectorAll(".library-view-btn").forEach(btn =>
    btn.addEventListener("click", () => setLibraryViewMode(btn.dataset.view)));

  // Import dropdown
  const importBtn   = document.querySelector("#libraryImportBtn");
  const importMenu  = document.querySelector("#libraryImportMenu");
  const fileInput   = document.querySelector("#libraryImportFileInput");
  if (importBtn && importMenu) {
    importBtn.addEventListener("click", e => { e.stopPropagation(); importMenu.hidden = !importMenu.hidden; });
    document.addEventListener("click", e => { if (!importMenu.hidden && !importMenu.contains(e.target) && e.target !== importBtn) importMenu.hidden = true; });
    document.addEventListener("keydown", e => { if (e.key === "Escape") importMenu.hidden = true; });
    importMenu.querySelectorAll(".library-import-item").forEach(item => {
      item.addEventListener("click", () => {
        importMenu.hidden = true;
        const src = item.dataset.importSrc;
        if (src === "file") {
          fileInput?.click();
        } else if (src === "strava") {
          const status = _getStravaStatus?.();
          if (status?.connected) _openStravaImportModal?.();
          else if (status?.app_configured) _toast("Először csatlakozz Stravához: Beállítások → Strava kapcsolat");
          else _toast("Strava integráció nincs konfigurálva.");
        }
      });
    });
    fileInput?.addEventListener("change", async () => {
      const [file] = fileInput.files;
      if (!file) return;
      await _processImportedFile?.(file);
      fileInput.value = "";
    });
  }

  // Szűrők
  document.querySelector("#librarySearchInput")?.addEventListener("input", e => {
    _filter.query = e.target.value; renderLibraryGrid();
  });
  document.querySelectorAll("[data-lib-type]").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-lib-type]").forEach(c => c.classList.remove("is-active"));
      chip.classList.add("is-active"); _filter.type = chip.dataset.libType;
      updateLocationFilters();
      renderLibraryGrid();
    });
  });
  document.querySelector("#libraryCountrySelect")?.addEventListener("change", (e) => {
    _filter.country = e.target.value; _filter.region = "";
    updateLocationFilters(); renderLibraryGrid();
  });
  document.querySelector("#libraryRegionSelect")?.addEventListener("change", (e) => {
    _filter.region = e.target.value; renderLibraryGrid();
  });
  document.querySelectorAll("[data-lib-shape]").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-lib-shape]").forEach(c => c.classList.toggle("is-active", c === chip));
      _filter.shape = chip.dataset.libShape; renderLibraryGrid();
    });
  });
  document.querySelectorAll("[data-lib-source]").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-lib-source]").forEach(c => c.classList.remove("is-active"));
      chip.classList.add("is-active"); _filter.source = chip.dataset.libSource; renderLibraryGrid();
    });
  });
  document.querySelectorAll("[data-lib-sport]").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-lib-sport]").forEach(c => c.classList.remove("is-active"));
      chip.classList.add("is-active"); _filter.sport = chip.dataset.libSport; renderLibraryGrid();
    });
  });
  document.querySelectorAll("[data-lib-sort]").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-lib-sort]").forEach(c => c.classList.remove("is-active"));
      chip.classList.add("is-active"); _filter.sort = chip.dataset.libSort; renderLibraryGrid();
    });
  });

  // Dual range sliders
  _initRangeSlider({
    minId: "libraryDistMin", maxId: "libraryDistMax",
    fillId: "libraryDistFill", labelId: "libraryDistLabel", maxVal: _DIST_MAX,
    format: (lo, hi, max) => (lo === 0 && hi === max) ? "Bármely" : `${lo} – ${hi === max ? hi + "+" : hi} km`,
    onUpdate: (lo, hi) => { _filter.distMin = lo; _filter.distMax = hi; renderLibraryGrid(); },
  });
  _initRangeSlider({
    minId: "libraryDurMin", maxId: "libraryDurMax",
    fillId: "libraryDurFill", labelId: "libraryDurLabel", maxVal: _DUR_MAX,
    format: (lo, hi, max) => {
      if (lo === 0 && hi === max) return "Bármely";
      const fmt = m => dur(m);
      return `${fmt(lo)} – ${hi === max ? fmt(hi) + "+" : fmt(hi)}`;
    },
    onUpdate: (lo, hi) => { _filter.durMin = lo; _filter.durMax = hi; renderLibraryGrid(); },
  });
}

function _initRangeSlider({ minId, maxId, fillId, labelId, maxVal, format, onUpdate }) {
  const minEl = document.querySelector(`#${minId}`);
  const maxEl = document.querySelector(`#${maxId}`);
  const fillEl = document.querySelector(`#${fillId}`);
  const lblEl  = document.querySelector(`#${labelId}`);
  if (!minEl || !maxEl) return;
  const updateUI = () => {
    const lo = parseInt(minEl.value), hi = parseInt(maxEl.value);
    if (fillEl) { fillEl.style.left = (lo / maxVal * 100) + "%"; fillEl.style.width = ((hi - lo) / maxVal * 100) + "%"; }
    if (lblEl)  lblEl.textContent = format(lo, hi, maxVal);
  };
  minEl.addEventListener("input", () => { if (parseInt(minEl.value) > parseInt(maxEl.value)) minEl.value = maxEl.value; updateUI(); onUpdate(parseInt(minEl.value), parseInt(maxEl.value)); });
  maxEl.addEventListener("input", () => { if (parseInt(maxEl.value) < parseInt(minEl.value)) maxEl.value = minEl.value; updateUI(); onUpdate(parseInt(minEl.value), parseInt(maxEl.value)); });
  updateUI();
}


// ── Helyszín-szűrő (közösségi útvonalak): ország / régió listák a meglévő adatokból ──
function updateLocationFilters() {
  const group = document.querySelector("#libraryLocationGroup");
  if (!group) return;
  group.hidden = _filter.type !== "sample";
  if (group.hidden) return;
  const locs = (_data.samples || []).map((r) => r.location || {}).filter((l) => l.country || l.region);
  const countries = [...new Set(locs.flatMap((l) => l.countries?.length ? l.countries : [l.country]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "hu"));
  const cSel = document.querySelector("#libraryCountrySelect");
  const rSel = document.querySelector("#libraryRegionSelect");
  // Ország-választó csak akkor, ha több ország is van
  cSel.hidden = countries.length < 2;
  if (!countries.includes(_filter.country)) _filter.country = "";
  cSel.innerHTML = `<option value="">Minden ország</option>` +
    countries.map((c) => `<option value="${escapeHtml(c)}" ${c === _filter.country ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
  const regions = [...new Set(locs.filter((l) => !_filter.country || l.country === _filter.country)
    .map((l) => l.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, "hu"));
  if (!regions.includes(_filter.region)) _filter.region = "";
  rSel.innerHTML = `<option value="">${_filter.country || countries.length < 2 ? "Minden régió / megye" : "Minden régió"}</option>` +
    regions.map((r) => `<option value="${escapeHtml(r)}" ${r === _filter.region ? "selected" : ""}>${escapeHtml(r)}</option>`).join("");
  rSel.disabled = !regions.length;
}


// ── Térképes nézet ───────────────────────────────────────────────────────────
// A szűrt elemek nyomvonala egy térképen (a hőtérképhez hasonlóan): rámutatva
// kiemelődik, kattintásra felugró ablak (több közeli nyomvonalnál lista) a
// betöltéssel és a „⋯” menüvel.

const MAP_COLORS = { workout: "#fc4c02", route: "#2563eb", sample: "#7c3aed" };
let _libMap = null, _libMapLayer = null, _geoById = null, _geoLoading = null, _lastFitKey = "";

export function invalidateLibraryGeometry() { _geoById = null; _lastFitKey = ""; }

async function loadLibraryGeometry() {
  if (_geoById) return _geoById;
  if (_geoLoading) return _geoLoading;
  _geoLoading = (async () => {
    const map = new Map();
    const [own, samples] = await Promise.all([
      _api.geometryBulk().catch(() => ({ tracks: [] })),
      fetch("/api/samples/geometry-bulk").then((r) => r.ok ? r.json() : { tracks: [] }).catch(() => ({ tracks: [] })),
    ]);
    for (const t of own.tracks || []) map.set(`own:${t.id}`, t.points);
    for (const t of samples.tracks || []) map.set(`sample:${t.id}`, t.points);
    _geoById = map;
    return map;
  })();
  try { return await _geoLoading; } finally { _geoLoading = null; }
}

function ensureLibraryMap() {
  if (_libMap) return _libMap;
  const el = document.querySelector("#libraryMap");
  if (!el || !window.L) return null;
  _libMap = L.map(el, { zoomControl: true, attributionControl: true, preferCanvas: true }).setView([47.2, 19.4], 7);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 16, attribution: "Tiles © Esri — OpenStreetMap" }).addTo(_libMap);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 16 }).addTo(_libMap);
  _libMapLayer = L.layerGroup().addTo(_libMap);
  return _libMap;
}

function libItemInfo({ route, category }) {
  const kind = category === "workout" ? "Edzés" : category === "sample" ? "Közösségi" : "Útvonal";
  const loc = route.location || {};
  const where = category === "sample" && (loc.settlement || loc.region)
    ? [...new Set([loc.settlement, loc.region].filter(Boolean))].join(" · ")
    : smartDateTimeFormat(route);
  const stats = [route.distance != null ? `${num(route.distance, 1)} km` : "", route.elevation ? `${int(route.elevation)} m` : ""].filter(Boolean).join(" · ");
  return { kind, where, stats };
}

async function renderLibraryMap(items) {
  const map = ensureLibraryMap();
  if (!map) return;
  setTimeout(() => map.invalidateSize(), 50);
  const status = document.querySelector("#libraryMapStatus");
  if (!_geoById && status) { status.hidden = false; status.textContent = "Nyomvonalak betöltése…"; }
  const geo = await loadLibraryGeometry();
  if (status) status.hidden = true;
  _libMapLayer.clearLayers();

  const drawn = [];
  for (const it of items) {
    const key = it.category === "sample" ? `sample:${it.route.id}` : `own:${it.route.id}`;
    const pts = geo.get(key);
    if (!pts || pts.length < 2) continue;
    const color = MAP_COLORS[it.category] || "#fc4c02";
    const line = L.polyline(pts, { color, weight: 3, opacity: 0.75, lineCap: "round", lineJoin: "round", interactive: false }).addTo(_libMapLayer);
    // Széles, láthatatlan „találati” vonal – könnyebb rámutatni / koppintani
    const hit = L.polyline(pts, { color, weight: 16, opacity: 0, interactive: true }).addTo(_libMapLayer);
    const entry = { it, pts, line };
    drawn.push(entry);
    hit.on("mouseover", () => { line.setStyle({ weight: 6, opacity: 1 }); line.bringToFront();
      hit.bindTooltip(escapeHtml(it.route.name || "Névtelen"), { sticky: true, direction: "top", className: "lib-map-tip" }).openTooltip(); });
    hit.on("mouseout", () => { line.setStyle({ weight: 3, opacity: 0.75 }); hit.closeTooltip(); });
    hit.on("click", (e) => openLibraryMapPopup(e.latlng, drawn));
  }

  const status2 = document.querySelector("#libraryMapStatus");
  if (status2) { status2.hidden = !!drawn.length; if (!drawn.length) status2.textContent = "Ezekhez az elemekhez nincs megjeleníthető nyomvonal."; }

  // A nézetet csak akkor igazítjuk, ha a szűrés megváltozott (kézi nagyítás megmarad)
  const fitKey = drawn.map((d) => d.it.route.id).join(",");
  if (drawn.length && fitKey !== _lastFitKey) {
    _lastFitKey = fitKey;
    const all = drawn.flatMap((d) => d.pts);
    try { map.fitBounds(all, { padding: [24, 24], maxZoom: 13 }); } catch {}
  }
}

function openLibraryMapPopup(latlng, drawn) {
  // Közeli nyomvonalak: a koppintás ~18 px-es körzetében
  const p0 = _libMap.latLngToContainerPoint(latlng);
  const near = drawn.filter((d) => d.pts.some((pt) => _libMap.latLngToContainerPoint(pt).distanceTo(p0) < 18)).slice(0, 20);
  if (!near.length) return;
  const rows = near.map((d, i) => {
    const { kind, where, stats } = libItemInfo(d.it);
    const loadLbl = d.it.category === "workout" ? "Elemzés" : "Tervezés";
    return `<div class="lib-map-pop-row">
      <div class="lib-map-pop-main"><i style="background:${MAP_COLORS[d.it.category]}"></i>
        <div><b>${escapeHtml(d.it.route.name || "Névtelen")}</b><small>${escapeHtml([kind, where, stats].filter(Boolean).join(" · "))}</small></div></div>
      <div class="lib-map-pop-act">
        <button class="library-card-load-btn" data-i="${i}" data-a="load">${loadLbl}</button>
        <button class="library-card-action-btn" data-i="${i}" data-a="more" title="További műveletek">⋯</button>
      </div></div>`;
  }).join("");
  const popup = L.popup({ maxWidth: 340, minWidth: 260, maxHeight: 260, className: "lib-map-popup", autoPanPadding: [20, 20] })
    .setLatLng(latlng)
    .setContent(`<div class="lib-map-pop">${near.length > 1 ? `<div class="lib-map-pop-head">${near.length} elem itt</div>` : ""}${rows}</div>`)
    .openOn(_libMap);
  const el = popup.getElement();
  el?.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a]");
    if (!b) return;
    const d = near[+b.dataset.i];
    const { route, category, isSample } = d.it;
    _libMap.closePopup();
    if (b.dataset.a === "load") await _loadRoute(route.id, isSample, route.name, category === "workout" ? "file" : "plan");
    else openRouteActionMenu(route, category, isSample, null);
  });
}
