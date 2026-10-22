/**
 * Bringaterv – Stats Dashboard Manager
 * ======================================
 * A statisztikai panel state-jét és event listener-eit kezeli.
 * A renderelési logika a statsPanel.js-ben van.
 *
 * Init:
 *   import { initStats, loadAndRenderStats, switchStatsView } from './ui/statsManager.js';
 *   initStats({ api: routesApi, getLibraryData, onLoadRoute: loadRouteFromLibrary });
 */

import {
  renderStats, renderMonthlyTable,
  renderEddington, renderTrainingLoad,
} from './statsPanel.js';
import { renderRecordsView } from './recordsView.js';
import { mobileMQ } from '../layout.js';

// ── Injektált függőségek ──────────────────────────────────────────────────────
let _api           = null;
let _getLibraryData = null;  // () => { routes, workouts }
let _onLoadRoute   = null;  // (id, isSample, name, target) => Promise

export function initStats({ api, getLibraryData, onLoadRoute }) {
  _api            = api;
  _getLibraryData = getLibraryData;
  _onLoadRoute    = onLoadRoute;
  _registerListeners();
  _placeControls();
  mobileMQ.addEventListener?.("change", _placeControls);
}

/**
 * Mobilon a nézetválasztó és a szűrők a Statok tetejére kerülnek (vízszintesen
 * görgethető fülsor + szűrősor, görgetéskor is látható) – a felcsúszó alsó lap
 * helyett, ahol nehezen vehetők észre. Gépen maradnak a bal oldali sávban.
 * Az elemeket mozgatjuk (nem másoljuk), így az eseménykezelők megmaradnak.
 */
/** A mobil fülsoron a kiválasztott fül görgetődjön középre (függőlegesen nem mozdít). */
function _centerActiveTab() {
  const nav = document.querySelector("#statsMobileBar .stats-nav");
  const btn = nav?.querySelector(".stats-nav-item--active");
  if (!btn) return;
  const left = btn.offsetLeft - (nav.clientWidth - btn.offsetWidth) / 2;
  nav.scrollLeft = Math.max(0, left);
}

function _placeControls() {
  const side = document.getElementById("tabStats");
  const main = document.getElementById("statsMain");
  if (!side || !main) return;
  const nav = side.querySelector(".stats-nav") || main.querySelector(".stats-nav");
  const filters = ["statsFilterPeriodSection", "statsFilterSportSection"].map((id) => document.getElementById(id)).filter(Boolean);
  let bar = document.getElementById("statsMobileBar");
  if (mobileMQ.matches) {
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "statsMobileBar";
      bar.className = "stats-mobile-bar";
      main.prepend(bar);
    }
    if (nav) bar.appendChild(nav);
    const row = bar.querySelector(".stats-mobile-filters") || bar.appendChild(Object.assign(document.createElement("div"), { className: "stats-mobile-filters" }));
    filters.forEach((f) => row.appendChild(f));
    bar.hidden = false;
    _centerActiveTab();
  } else {
    if (nav) side.prepend(nav);
    filters.forEach((f) => side.appendChild(f));
    if (bar) bar.hidden = true;
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let _statsPeriod   = "year";
let _statsSport    = "all";
let _statsView     = "overview";
let _trainingRange = 6;

// ── Belső segéd ───────────────────────────────────────────────────────────────
function _allStatsRoutes() {
  const { routes = [], workouts = [] } = _getLibraryData?.() ?? {};
  return [...routes, ...workouts].filter(r => r.include_in_stats !== false);
}

// ── Nézet váltás ─────────────────────────────────────────────────────────────
export function switchStatsView(view) {
  _statsView = view;
  document.querySelectorAll("[data-stats-view]").forEach(b =>
    b.classList.toggle("stats-nav-item--active", b.dataset.statsView === view));
  // mobilon a kiválasztott fül görgetődjön a fülsor közepére
  if (mobileMQ.matches) _centerActiveTab();
  ["overview","monthly","records","eddington","training","heatmap"].forEach(v => {
    const el = document.getElementById("statsView" + v.charAt(0).toUpperCase() + v.slice(1));
    if (el) el.hidden = v !== view;
  });
  const periodSection = document.getElementById("statsFilterPeriodSection");
  if (periodSection) periodSection.hidden = view !== "overview";
  const sportSection  = document.getElementById("statsFilterSportSection");
  if (sportSection)  sportSection.hidden  = ["records","eddington","training","heatmap"].includes(view);

  const all = _allStatsRoutes();
  if (view === "overview")  renderStats(all, { period: _statsPeriod, sport: _statsSport });
  if (view === "monthly")   renderMonthlyTable(all, { sport: _statsSport });
  if (view === "records")   renderRecordsView(all, { api: _api, sport: _statsSport });
  if (view === "eddington") renderEddington(all);
  if (view === "training")  renderTrainingLoad(all, { months: _trainingRange });
  if (view === "heatmap")   showHeatmap();
}

// ── Betöltés + render ─────────────────────────────────────────────────────────
export async function loadAndRenderStats() {
  const all = _allStatsRoutes();
  if (!all.length && _api) {
    try {
      const userRoutes = await _api.listRoutes();
      const isWorkout = r => r.type === "workout" || !!r.strava_id || !!r.start_time;
      const data = _getLibraryData();
      data.routes   = userRoutes.filter(r => !isWorkout(r));
      data.workouts = userRoutes.filter(isWorkout);
    } catch {}
  }
  switchStatsView(_statsView);
}

// ── Event listener-ek ─────────────────────────────────────────────────────────
function _registerListeners() {
  // Alnavigáció
  document.querySelectorAll("[data-stats-view]").forEach(btn =>
    btn.addEventListener("click", () => switchStatsView(btn.dataset.statsView)));

  // Edzésterhelés kártyák: a fix leírás mobilon ⓘ mögé kerül (a CSS rejti a szöveget)
  document.querySelectorAll("#statsViewTraining .training-kpi-card").forEach(card => {
    const desc = card.querySelector(".training-kpi-desc:not([id])");
    const head = card.querySelector(".training-kpi-header");
    if (!desc || !head || head.querySelector(".hint-btn")) return;
    desc.classList.add("training-kpi-desc--static");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hint-btn";
    btn.setAttribute("aria-label", "Segítség");
    btn.dataset.hintTitle = card.querySelector(".training-kpi-name")?.textContent.trim() || "";
    btn.dataset.hint = desc.textContent.replace(/\s+/g, " ").trim();
    btn.innerHTML = '<i data-lucide="info" aria-hidden="true"></i>';
    head.appendChild(btn);
  });
  window.lucide?.createIcons();

  // Edzésterhelés időszak
  document.querySelectorAll("[data-training-range]").forEach(btn => {
    btn.addEventListener("click", () => {
      _trainingRange = Number(btn.dataset.trainingRange);
      document.querySelectorAll("[data-training-range]").forEach(b =>
        b.classList.toggle("stats-chip--active", b.dataset.trainingRange === btn.dataset.trainingRange));
      renderTrainingLoad(_allStatsRoutes(), { months: _trainingRange });
    });
  });

  // Időszak szűrő
  document.querySelectorAll("[data-stats-period]").forEach(btn => {
    btn.addEventListener("click", () => {
      _statsPeriod = btn.dataset.statsPeriod;
      document.querySelectorAll("[data-stats-period]").forEach(b =>
        b.classList.toggle("stats-chip--active", b.dataset.statsPeriod === _statsPeriod));
      if (_statsView === "overview")
        renderStats(_allStatsRoutes(), { period: _statsPeriod, sport: _statsSport });
    });
  });

  // Sport szűrő
  document.querySelectorAll("[data-stats-sport]").forEach(btn => {
    btn.addEventListener("click", () => {
      _statsSport = btn.dataset.statsSport;
      document.querySelectorAll("[data-stats-sport]").forEach(b =>
        b.classList.toggle("stats-chip--active", b.dataset.statsSport === _statsSport));
      const all = _allStatsRoutes();
      if (_statsView === "overview") renderStats(all, { period: _statsPeriod, sport: _statsSport });
      if (_statsView === "monthly")  renderMonthlyTable(all, { sport: _statsSport });
    });
  });

  // Rekord kártya kattintás → Elemzés fül
  document.querySelector("#statsMain")?.addEventListener("click", async (e) => {
    const card = e.target.closest("[data-record-route-id]");
    if (!card || !_onLoadRoute) return;
    await _onLoadRoute(card.dataset.recordRouteId, false, card.dataset.recordRouteName || "", "file");
  });
}

// ── Hőtérkép (Leaflet) ────────────────────────────────────────────────────────
let _hmMap    = null;
let _hmLayer  = null;
let _hmTracks = null;
let _hmSport  = "all";
let _hmShowRoutes = false;   // alapból csak a rögzített edzések – a tervezett útvonalak kapcsolóval
let _hmLoading = false;

function _hmSportKey(t) {
  const s = (t.sport || "").toLowerCase();
  if (!s || s === "route" || s === "workout") return "cycling";
  if (s.includes("cycl") || s.includes("ride") || s.includes("bike")
      || s === "asphalt" || s === "gravel" || s === "mtb") return "cycling";
  if (s.includes("hik")) return "hike";
  if (s.includes("walk")) return "walk";
  if (s.includes("run")) return "run";
  return "other";
}

function _ensureHeatmapMap() {
  if (_hmMap) return _hmMap;
  _hmMap = L.map("heatmapMap", { zoomControl: true }).setView([47.5, 19.05], 7);
  // Esri Dark Gray Canvas (kulcs nélkül; a CARTO 2026-tól API-kulcsot kér)
  const _esriAttr = 'Tiles &copy; <a href="https://www.esri.com">Esri</a>';
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, maxNativeZoom: 16, attribution: _esriAttr,
  }).addTo(_hmMap);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, maxNativeZoom: 16, attribution: "",
  }).addTo(_hmMap);
  _hmLayer = L.layerGroup().addTo(_hmMap);
  // Elemzés gomb – event delegation a térkép containerén (popup tartalomra)
  _hmMap.getContainer().addEventListener("click", (e) => {
    const btn = e.target.closest(".hm-popup-load-btn");
    if (!btn || !_onLoadRoute) return;
    L.DomEvent.stopPropagation(e);
    e.stopPropagation();
    _hmMap.closePopup();
    _onLoadRoute(btn.dataset.id, false, btn.dataset.name, "file");
  });
  // Hőtérkép sport szűrő
  document.getElementById("heatmapShowRoutes")?.addEventListener("change", (e) => {
    _hmShowRoutes = e.target.checked;
    _drawHeatmapTracks();
  });
  document.querySelectorAll("[data-heatmap-sport]").forEach(btn => {
    btn.addEventListener("click", () => {
      _hmSport = btn.dataset.heatmapSport;
      document.querySelectorAll("[data-heatmap-sport]").forEach(b =>
        b.classList.toggle("stats-chip--active", b.dataset.heatmapSport === _hmSport));
      _drawHeatmapTracks();
    });
  });
  return _hmMap;
}

function _drawHeatmapTracks() {
  if (!_hmLayer || !_hmTracks) return;
  _hmLayer.clearLayers();
  const filtered = _hmTracks.filter(t =>
    (_hmShowRoutes || (t.kind || "workout") === "workout") &&
    (_hmSport === "all" || _hmSportKey(t) === _hmSport));

  const firsts = filtered.map(t => t.points?.[0]).filter(Boolean);
  const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
  const medLat = firsts.length ? median(firsts.map(p => p[0])) : 0;
  const medLng = firsts.length ? median(firsts.map(p => p[1])) : 0;

  const boundsPts = [];
  for (const t of filtered) {
    if (!t.points || t.points.length < 2) continue;
    L.polyline(t.points, { color: "#e8461e", weight: 6, opacity: 0.10, lineCap: "round", lineJoin: "round", interactive: false }).addTo(_hmLayer);
    L.polyline(t.points, { color: "#e8461e", weight: 2, opacity: 0.45, lineCap: "round", lineJoin: "round", interactive: false }).addTo(_hmLayer);
    const [lat0, lng0] = t.points[0];
    if (Math.abs(lat0 - medLat) <= 5 && Math.abs(lng0 - medLng) <= 5)
      for (const p of t.points) boundsPts.push(p);
  }

  // Kattintásra popup
  _hmMap.off("click");
  _hmMap.on("click", (e) => {
    const { lat, lng } = e.latlng;
    const mpp   = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, _hmMap.getZoom());
    const thresh = Math.max(50, mpp * 18);
    function dist(a1, o1, a2, o2) {
      const R = 6371000, φ1 = a1*Math.PI/180, φ2 = a2*Math.PI/180;
      const Δφ = (a2-a1)*Math.PI/180, Δλ = (o2-o1)*Math.PI/180;
      return R * 2 * Math.atan2(Math.sqrt(Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2),
                                 Math.sqrt(1 - Math.sin(Δφ/2)**2 - Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2));
    }
    const nearby = filtered.filter(t => {
      if (!t.points) return false;
      const step = Math.max(1, Math.floor(t.points.length / 60));
      for (let i = 0; i < t.points.length; i += step)
        if (dist(lat, lng, t.points[i][0], t.points[i][1]) <= thresh) return true;
      return false;
    });
    if (!nearby.length) return;
    const fmtD = d => { try { return d ? new Date(d).toLocaleDateString("hu-HU") : ""; } catch { return d||""; } };
    const rows = nearby.map(t => `<div class="hm-popup-row">
      <div class="hm-popup-name">${t.name || "Névtelen"}</div>
      <div class="hm-popup-meta">
        <span>${fmtD(t.date)}</span>
        ${t.distance != null ? `<span class="hm-popup-dist">${t.distance} km</span>` : ""}
      </div>
      ${_onLoadRoute ? `<button class="hm-popup-load-btn" data-id="${t.id}" data-name="${(t.name || 'Névtelen').replace(/"/g, '&quot;')}">Elemzés</button>` : ""}
    </div>`).join("");
    L.popup({ maxWidth: 300, className: "hm-leaflet-popup" })
      .setLatLng(e.latlng)
      .setContent(`<div class="hm-popup"><div class="hm-popup-header">${nearby.length} közeli edzés</div>${rows}</div>`)
      .openOn(_hmMap);
  });

  const countEl = document.getElementById("heatmapCount");
  if (countEl) {
    const nW = filtered.filter(t => (t.kind || "workout") === "workout").length;
    const nR = filtered.length - nW;
    countEl.textContent = `${nW} edzés` + (nR ? ` · ${nR} útvonal` : "");
  }
  if (boundsPts.length) try { _hmMap.fitBounds(boundsPts, { padding: [30, 30], maxZoom: 14 }); } catch {}
}

export async function showHeatmap() {
  _ensureHeatmapMap();
  setTimeout(() => _hmMap.invalidateSize(), 60);
  if (_hmTracks) { _drawHeatmapTracks(); return; }
  if (_hmLoading) return;
  _hmLoading = true;
  const overlay  = document.getElementById("heatmapOverlay");
  const statusEl = document.getElementById("heatmapStatusText");
  if (overlay)  overlay.hidden = false;
  if (statusEl) statusEl.textContent = "Hőtérkép betöltése…";
  try {
    const res = await _api.geometryBulk();
    _hmTracks = res.tracks || [];
    if (overlay) overlay.hidden = true;
    setTimeout(() => { _hmMap.invalidateSize(); _drawHeatmapTracks(); }, 80);
  } catch (err) {
    if (statusEl) statusEl.textContent = "Nem sikerült betölteni a hőtérképet.";
    console.error("Hőtérkép hiba:", err);
  } finally {
    _hmLoading = false;
  }
}
