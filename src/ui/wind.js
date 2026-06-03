/**
 * Bringaterv – Wind UI Module
 * ============================
 * Szélelemzés UI: időpont-picker, eredmény renderelés, térkép-színezés.
 * A számítási logika a windService.js-ben van.
 *
 * Init:
 *   import { initWind } from './ui/wind.js';
 *   initWind({ mapAdapter, store, onRenderSidebar, getActiveGeometry,
 *              elements, visibleSections, applyRouteLayer, syncElevationBtnState });
 */

import { analyzeWind, defaultAvgSpeed, WIND_COLORS, WIND_LABELS } from '../wind/windService.js';

// ── Injektált függőségek ──────────────────────────────────────────────────────
let _mapAdapter, _onRenderSidebar, _getActiveGeometry, _getStore;
let _el, _visibleSections, _applyRouteLayer, _syncElevationBtnState;

export function initWind({ mapAdapter, store, onRenderSidebar, getActiveGeometry,
                           elements, visibleSections, applyRouteLayer, syncElevationBtnState }) {
  _mapAdapter = mapAdapter;
  _onRenderSidebar = onRenderSidebar;
  _getActiveGeometry = getActiveGeometry;
  _getStore = () => store;
  _el = elements;
  _visibleSections = visibleSections;
  _applyRouteLayer = applyRouteLayer;
  _syncElevationBtnState = syncElevationBtnState;

  // Event listener regisztráció
  document.querySelector("#windBtn")?.addEventListener("click", () => {
    if (_visibleSections.has("wind")) closeWindSection();
    else openWindSection();
  });
  _el.windChartBtnPlan?.addEventListener("click", () => {
    if (_visibleSections.has("wind")) closeWindSection();
    else openWindSection();
  });
  document.querySelector("#closeChartWind")?.addEventListener("click", closeWindSection);

  document.querySelector("#windDeparturePlan")?.addEventListener("change", () => scheduleWindRunIfActive("departure"));
  document.querySelector("#windAvgSpeedPlan")?.addEventListener("change", () => scheduleWindRunIfActive("speed"));

  _el.windMapTogglePlan?.addEventListener("change", () => {
    if (_el.windMapTogglePlan.checked) {
      if (_el.gradeMapTogglePlan?.checked) {
        _el.gradeMapTogglePlan.checked = false;
        _applyRouteLayer(null);
      }
      if (_el.gradeMapToggle?.checked) {
        _el.gradeMapToggle.checked = false;
        _applyRouteLayer(null);
      }
      if (_windResult) {
        _mapAdapter.renderWindRoute?.(_getActiveGeometry(), _windResult.segments);
      } else {
        const st = _getStore()?.getState?.();
        if (!st?.importedRoute && (st?.waypoints?.length ?? 0) >= 2) {
          runWindAnalysis();
        }
      }
    } else {
      _mapAdapter.clearWindRoute?.();
    }
  });

  syncWindBtnEnabled();
  setTimeout(syncWindBtnEnabled, 500);
}

window.addEventListener("route4me:geometry-cleared", () => clearWindResult());

// ── State ─────────────────────────────────────────────────────────────────────
let _windResult = null;
let _windRunInflight = false;
let _windRunDebounce = null;

export function getWindResult() { return _windResult; }

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTime(d) {
  return d.toLocaleString("hu-HU", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
}
function fmtHour(d) {
  return d.toLocaleTimeString("hu-HU", { hour:"2-digit", minute:"2-digit" });
}
function roundUpToHour(d) {
  const r = new Date(d);
  r.setMinutes(0, 0, 0);
  if (r <= d) r.setHours(r.getHours() + 1);
  return r;
}
function toLocalInputValue(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function windArrow(deg) {
  const arrows = ["↓","↙","←","↖","↑","↗","→","↘"];
  return arrows[Math.round(((deg + 180) % 360) / 45) % 8];
}
function setBothStatus(text) {
  if (_el.windStatus)     _el.windStatus.textContent     = text;
  if (_el.windStatusPlan) _el.windStatusPlan.textContent = text;
}

// ── Szél eredmény megjelenítése ───────────────────────────────────────────────
export function renderWindResult(result) {
  const { stats, segments, coverage } = result;
  const km = (n) => `${n.toFixed(1)} km`;
  const pct = (n) => `${n.toFixed(0)}%`;

  _el.windStats.hidden = false;
  _el.windStats.innerHTML = `
    <div class="wind-stat wind-stat--tail">
      <span class="wind-stat-label">Hátszél</span>
      <span class="wind-stat-value">${pct(stats.tailPct)} <small>${km(stats.tailKm)}</small></span>
    </div>
    <div class="wind-stat wind-stat--cross">
      <span class="wind-stat-label">Oldalszél</span>
      <span class="wind-stat-value">${pct(stats.crossPct)} <small>${km(stats.crossKm)}</small></span>
    </div>
    <div class="wind-stat wind-stat--head">
      <span class="wind-stat-label">Szembeszél</span>
      <span class="wind-stat-value">${pct(stats.headPct)} <small>${km(stats.headKm)}</small></span>
    </div>
    <div class="wind-stat">
      <span class="wind-stat-label">Átlag szél</span>
      <span class="wind-stat-value">${stats.avgWindSpeed.toFixed(1)} <small>km/h</small></span>
    </div>
    <div class="wind-stat">
      <span class="wind-stat-label">Hőmérséklet</span>
      <span class="wind-stat-value">${stats.avgTemperature != null ? stats.avgTemperature.toFixed(1) : "—"} <small>°C</small></span>
    </div>
    <div class="wind-stat">
      <span class="wind-stat-label">Csapadék (max)</span>
      <span class="wind-stat-value">${stats.maxPrecipitation != null ? stats.maxPrecipitation.toFixed(0) : "—"} <small>%</small></span>
    </div>
    <div class="wind-stat">
      <span class="wind-stat-label">Felhőzet</span>
      <span class="wind-stat-value">${stats.avgCloudcover != null ? stats.avgCloudcover.toFixed(0) : "—"} <small>%</small></span>
    </div>`;

  _el.windBar.hidden = false;
  const totalKm = stats.totalDistKm || 1;
  _el.windBar.innerHTML = segments.map(seg => {
    const w = (seg.distanceKm / totalKm) * 100;
    const color = WIND_COLORS[seg.wind.mode] ?? "#888";
    return `<div class="wind-bar-seg" style="width:${w.toFixed(2)}%;background:${color}"
      title="${WIND_LABELS[seg.wind.mode]} – ${seg.fromKm.toFixed(1)}–${seg.toKm.toFixed(1)} km, ${seg.wind.speed.toFixed(1)} km/h"></div>`;
  }).join("");

  _el.windSegments.hidden = false;
  _el.windSegments.innerHTML = segments.map(seg => {
    const color = WIND_COLORS[seg.wind.mode] ?? "#888";
    return `<div class="wind-segment-row">
      <div class="wind-segment-dot" style="background:${color}"></div>
      <div>${seg.fromKm.toFixed(1)}–${seg.toKm.toFixed(1)} km <span style="color:var(--muted)">· ${WIND_LABELS[seg.wind.mode]}</span></div>
      <span class="wind-segment-arrow" title="szél felé fúj">${windArrow(seg.wind.direction)}</span>
      <span class="wind-segment-speed">${seg.wind.speed.toFixed(1)} km/h</span>
      <span class="wind-segment-time">${fmtHour(seg.arrivalTime)}</span>
    </div>`;
  }).join("");

  _el.windHeaderInfo.textContent =
    `${fmtTime(coverage.from)} → ${fmtTime(coverage.to)}${coverage.withinForecast ? "" : " (részben az előrejelzésen kívül)"}`;

  applyWindMapColoring(segments);

  if (_el.windQuickStats) {
    _el.windQuickStats.hidden = false;
    _el.windQuickStats.innerHTML = `
      <span class="wind-quick-stat"><span class="wind-quick-stat-dot" style="background:#22C55E"></span><span class="wind-quick-stat-val">${stats.tailPct.toFixed(0)}%</span></span>
      <span class="wind-quick-stat"><span class="wind-quick-stat-dot" style="background:#EAB308"></span><span class="wind-quick-stat-val">${stats.crossPct.toFixed(0)}%</span></span>
      <span class="wind-quick-stat"><span class="wind-quick-stat-dot" style="background:#EF4444"></span><span class="wind-quick-stat-val">${stats.headPct.toFixed(0)}%</span></span>
      <span class="wind-quick-stat" title="átlag szélerősség"><span class="wind-quick-stat-val">${stats.avgWindSpeed.toFixed(0)} km/h</span></span>
    `;
  }
  const windTimeRow = document.querySelector('#planWindTimeRow');
  if (windTimeRow) windTimeRow.hidden = false;
  _onRenderSidebar?.();
}

export function clearWindResult() {
  _windResult = null;
  if (!_el) return;
  _el.windStats.hidden = true;
  _el.windBar.hidden = true;
  _el.windSegments.hidden = true;
  _el.windHeaderInfo.textContent = "";
  _el.windStatus.textContent = "";
  if (_el.windQuickStats) { _el.windQuickStats.hidden = true; _el.windQuickStats.innerHTML = ""; }
  const windTimeRow    = document.querySelector('#planWindTimeRow');
  const windTimeToggle = document.querySelector('#planWindTimeToggle');
  if (windTimeRow)    windTimeRow.hidden    = true;
  if (windTimeToggle) windTimeToggle.checked = false;
  if (_el.windMapTogglePlan) _el.windMapTogglePlan.checked = false;
  _mapAdapter?.clearWindRoute?.();
  _onRenderSidebar?.();
}

export function applyWindMapColoring(segments) {
  const geometry = _getActiveGeometry?.();
  if (!_mapAdapter?.renderWindRoute || !geometry?.length) return;
  const wantColor = _el.windMapTogglePlan?.checked ?? true;
  if (wantColor) {
    if (_el.gradeMapTogglePlan?.checked) {
      _el.gradeMapTogglePlan.checked = false;
      _applyRouteLayer(null);
    }
    if (_el.gradeMapToggle?.checked) {
      _el.gradeMapToggle.checked = false;
    }
    _mapAdapter.renderWindRoute(geometry, segments);
  } else {
    _mapAdapter.clearWindRoute?.();
  }
}

export async function runWindAnalysis() {
  if (_windRunInflight) return;
  const geometry = _getActiveGeometry?.();
  if (!geometry || geometry.length < 2) {
    setBothStatus("Nincs betöltött útvonal.");
    return;
  }
  const depRaw = document.querySelector("#windDeparturePlan")?.value;
  const speed  = parseFloat(document.querySelector("#windAvgSpeedPlan")?.value);
  if (!depRaw || !speed || speed <= 0) {
    setBothStatus("Add meg az indulási időt és az átlagsebességet.");
    return;
  }
  const departureTime = new Date(depRaw);

  _windRunInflight = true;
  setBothStatus("Open-Meteo lekérdezés folyamatban…");
  try {
    const result = await analyzeWind(geometry, departureTime, speed);
    _windResult = result;
    if (_el.windMapTogglePlan && !_el.windMapTogglePlan.checked) {
      _el.windMapTogglePlan.checked = true;
    }
    renderWindResult(result);
    if (!result.coverage.withinForecast) {
      setBothStatus("Figyelem: az érkezési idő egy része a 7 napos előrejelzésen kívül esik.");
    } else {
      setBothStatus(`${result.segments.length} szegmens elemezve.`);
    }
  } catch (err) {
    setBothStatus("Hiba: " + err.message);
  } finally {
    _windRunInflight = false;
  }
}

export function openWindSection() {
  const chartWind = document.querySelector("#chartWind");
  if (!chartWind || !_el.elevationPanel) return;
  _el.elevationPanel.hidden = false;
  chartWind.hidden = false;
  _visibleSections.add("wind");
  document.querySelector("#windBtn")?.classList.add("is-active");
  _syncElevationBtnState();
  if (!_windResult && _getActiveGeometry?.()?.length >= 2) {
    runWindAnalysis();
  }
}

export function closeWindSection() {
  const chartWind = document.querySelector("#chartWind");
  if (chartWind) chartWind.hidden = true;
  _visibleSections.delete("wind");
  document.querySelector("#windBtn")?.classList.remove("is-active");
  if (_visibleSections.size === 0 && _el.elevationPanel) _el.elevationPanel.hidden = true;
  _mapAdapter?.clearWindRoute?.();
  _syncElevationBtnState();
}

export function scheduleWindRunIfActive(reason = "input") {
  if (!_windResult) return;
  const geometry = _getActiveGeometry?.();
  if (!geometry || geometry.length < 2) return;
  const st = _getStore?.()?.getState?.();
  if (st?.importedRoute) return;
  if ((st?.waypoints?.length ?? 0) < 2) return;
  if (_windRunDebounce) clearTimeout(_windRunDebounce);
  const delay = reason === "geometry" ? 800 : 400;
  _windRunDebounce = setTimeout(() => runWindAnalysis(), delay);
}

export function initWindPlanInputsIfNeeded() {
  const depEl = document.querySelector("#windDeparturePlan");
  const spdEl = document.querySelector("#windAvgSpeedPlan");
  if (depEl && !depEl.value) {
    depEl.value = toLocalInputValue(roundUpToHour(new Date()));
  }
  if (spdEl && !spdEl.value) {
    spdEl.value = defaultAvgSpeed(_getStore?.()?.getState?.()?.mode ?? "asphalt");
  }
  if (depEl) {
    const max = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    depEl.max = toLocalInputValue(max);
    depEl.min = toLocalInputValue(new Date(Date.now() - 60 * 60 * 1000));
  }
}

export function syncWindBtnEnabled() {
  const btn = document.querySelector("#windBtn");
  if (!btn) return;
  const geometry = _getActiveGeometry?.();
  btn.disabled = !geometry || geometry.length < 2;
}
