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
  renderStats, renderMonthlyTable, renderRecordsFull,
  renderEddington, renderTrainingLoad,
} from './statsPanel.js';

// ── Injektált függőségek ──────────────────────────────────────────────────────
let _api           = null;
let _getLibraryData = null;  // () => { routes, workouts }
let _onLoadRoute   = null;  // (id, isSample, name, target) => Promise

export function initStats({ api, getLibraryData, onLoadRoute }) {
  _api            = api;
  _getLibraryData = getLibraryData;
  _onLoadRoute    = onLoadRoute;
  _registerListeners();
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
  ["overview","monthly","records","eddington","training","heatmap"].forEach(v => {
    const el = document.getElementById("statsView" + v.charAt(0).toUpperCase() + v.slice(1));
    if (el) el.hidden = v !== view;
  });
  const periodSection = document.getElementById("statsFilterPeriodSection");
  if (periodSection) periodSection.hidden = view !== "overview";
  const sportSection  = document.getElementById("statsFilterSportSection");
  if (sportSection)  sportSection.hidden  = ["eddington","training","heatmap"].includes(view);

  const all = _allStatsRoutes();
  if (view === "overview")  renderStats(all, { period: _statsPeriod, sport: _statsSport });
  if (view === "monthly")   renderMonthlyTable(all, { sport: _statsSport });
  if (view === "records")   renderRecordsFull(all);
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
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19, subdomains: "abcd", attribution: "© OpenStreetMap, © CARTO",
  }).addTo(_hmMap);
  _hmLayer = L.layerGroup().addTo(_hmMap);
  // Hőtérkép sport szűrő
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
  const filtered = _hmTracks.filter(t => _hmSport === "all" || _hmSportKey(t) === _hmSport);

  const firsts = filtered.map(t => t.points?.[0]).filter(Boolean);
  const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
  const medLat = firsts.length ? median(firsts.map(p => p[0])) : 0;
  const medLng = firsts.length ? median(firsts.map(p => p[1])) : 0;

  const boundsPts = [];
  for (const t of filtered) {
    if (!t.points || t.points.length < 2) continue;
    L.polyline(t.points, { color: "#fc4c02", weight: 6, opacity: 0.10, lineCap: "round", lineJoin: "round", interactive: false }).addTo(_hmLayer);
    L.polyline(t.points, { color: "#fc4c02", weight: 2, opacity: 0.45, lineCap: "round", lineJoin: "round", interactive: false }).addTo(_hmLayer);
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
      <div class="hm-popup-meta"><span>${fmtD(t.date)}</span>${t.distance != null ? `<span class="hm-popup-dist">${t.distance} km</span>` : ""}</div>
    </div>`).join("");
    L.popup({ maxWidth: 280, className: "hm-leaflet-popup" })
      .setLatLng(e.latlng)
      .setContent(`<div class="hm-popup"><div class="hm-popup-header">${nearby.length} közeli edzés</div>${rows}</div>`)
      .openOn(_hmMap);
  });

  const countEl = document.getElementById("heatmapCount");
  if (countEl) countEl.textContent = `${filtered.length} edzés`;
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
