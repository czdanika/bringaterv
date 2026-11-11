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
import { num } from "../format.js";
import { buildTrackDistances } from "./elevationProfile.js";

// ── Injektált függőségek ──────────────────────────────────────────────────────
let _mapAdapter, _onRenderSidebar, _getActiveGeometry, _getStore;
let _el, _visibleSections, _applyRouteLayer, _syncElevationBtnState;
let _windChart = null, _chartMarkers = null;
// Szélelemzés a Tervezésben – importált (edzésből / GPX-ből lett) útvonalnál is; az Elemzés fülön nem
let _isPlanContext = () => true;

export function initWind({ mapAdapter, store, onRenderSidebar, getActiveGeometry,
                           elements, visibleSections, applyRouteLayer, syncElevationBtnState,
                           windChart = null, chartMarkers = null, isPlanContext = null }) {
  if (isPlanContext) _isPlanContext = isPlanContext;
  _windChart = windChart;
  _chartMarkers = chartMarkers;
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
        if (_isPlanContext() && (st?.waypoints?.length ?? 0) >= 2) {
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
  const km = (n) => `${num(n, 1)} km`;
  const pct = (n) => `${num(n, 0)}%`;

  // Fejléc: a közös grafikon-fejléc stílusában (nagy szám, kis mértékegység, felirat)
  const stat = (v, u, label, dot) =>
    `<div class="cs-stat"><b>${v}<small>${u}</small></b><span>${dot ? `<i style="background:${dot}"></i>` : ""}${label}</span></div>`;
  const statsEl = document.querySelector("#statsWind");
  if (statsEl) statsEl.innerHTML =
    stat(num(stats.tailPct, 0), "%", "Hátszél", WIND_COLORS.tail) +
    stat(num(stats.crossPct, 0), "%", "Oldalszél", WIND_COLORS.cross) +
    stat(num(stats.headPct, 0), "%", "Szembeszél", WIND_COLORS.head) +
    stat(num(stats.avgWindSpeed, 0), "km/h", "Átlag szél");

  // Időjárás-kiegészítők kis címkékként
  _el.windStats.hidden = false;
  const chip = (t) => `<span class="wind-chip">${t}</span>`;
  _el.windStats.innerHTML =
    chip(`${fmtTime(coverage.from)} → ${fmtTime(coverage.to)}${coverage.withinForecast ? "" : " (részben az előrejelzésen kívül)"}`) +
    (stats.avgTemperature != null ? chip(`${num(stats.avgTemperature, 1)} °C`) : "") +
    (stats.maxPrecipitation != null ? chip(`csapadék max ${num(stats.maxPrecipitation, 0)}%`) : "") +
    (stats.avgCloudcover != null ? chip(`felhőzet ${num(stats.avgCloudcover, 0)}%`) : "");

  // Grafikon: a szél ereje a táv mentén, a szakasz típusa szerint színezve (a többi grafikonnal közös rajzoló)
  renderWindChart(segments);
  _el.windBar.hidden = true;

  const segDetails = document.querySelector("#windSegDetails");
  renderWindSegments(segments);
  if (segDetails) segDetails.hidden = !segments?.length;
  _el.windHeaderInfo.textContent = "";

  applyWindMapColoring(segments);

  if (_el.windQuickStats) {
    _el.windQuickStats.hidden = false;
    _el.windQuickStats.innerHTML = `
      <span class="wind-quick-stat"><span class="wind-quick-stat-dot" style="background:#22C55E"></span><span class="wind-quick-stat-val">${num(stats.tailPct, 0)}%</span></span>
      <span class="wind-quick-stat"><span class="wind-quick-stat-dot" style="background:#EAB308"></span><span class="wind-quick-stat-val">${num(stats.crossPct, 0)}%</span></span>
      <span class="wind-quick-stat"><span class="wind-quick-stat-dot" style="background:#EF4444"></span><span class="wind-quick-stat-val">${num(stats.headPct, 0)}%</span></span>
      <span class="wind-quick-stat" title="átlag szélerősség"><span class="wind-quick-stat-val">${num(stats.avgWindSpeed, 0)} km/h</span></span>
    `;
  }
  const windTimeRow = document.querySelector('#planWindTimeRow');
  if (windTimeRow) windTimeRow.hidden = false;
  _onRenderSidebar?.();
}

/** „Szakaszok részletesen”: az egymás utáni azonos típusú (hát- / oldal- / szembeszeles) szakaszok
 *  összevonva – km, hossz, érkezés, szélerő és -irány, a haladást segítő / fékező összetevő, hőmérséklet. */
const COMPASS = ["É", "ÉÉK", "ÉK", "KÉK", "K", "KDK", "DK", "DDK", "D", "DDNy", "DNy", "NyDNy", "Ny", "NyÉNy", "ÉNy", "ÉÉNy"];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
function renderWindSegments(segments) {
  const box = _el.windSegments;
  if (!box) return;
  if (!segments?.length) { box.hidden = true; box.innerHTML = ""; return; }
  const runs = [];
  for (const sg of segments) {
    const last = runs.at(-1);
    if (last && last.mode === sg.wind.mode) {
      last.toKm = sg.toKm; last.dist += sg.distanceKm; last.to = sg.arrivalTime;
      last.speed += sg.wind.speed * sg.distanceKm; last.along += sg.wind.along * sg.distanceKm;
      last.dirs.push([sg.wind.direction, sg.distanceKm]);
      if (sg.weather?.temperature != null) last.temps.push(sg.weather.temperature);
    } else {
      runs.push({ mode: sg.wind.mode, fromKm: sg.fromKm, toKm: sg.toKm, dist: sg.distanceKm, from: sg.arrivalTime, to: sg.arrivalTime,
                  speed: sg.wind.speed * sg.distanceKm, along: sg.wind.along * sg.distanceKm,
                  dirs: [[sg.wind.direction, sg.distanceKm]], temps: sg.weather?.temperature != null ? [sg.weather.temperature] : [] });
    }
  }
  const avgDir = (dirs) => {        // táv szerint súlyozott irány-átlag (vektorosan)
    let x = 0, y = 0;
    for (const [d, w] of dirs) { x += Math.cos(d * Math.PI / 180) * w; y += Math.sin(d * Math.PI / 180) * w; }
    return Math.atan2(y, x) * 180 / Math.PI;
  };
  const hhmm = (t) => (t instanceof Date ? t : new Date(t)).toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
  box.innerHTML = `<div class="wseg-row wseg-head"><span>Szakasz</span><span>Táv</span><span>Időpont</span><span>Szél</span><span>Hatás</span></div>` +
    runs.map((r) => {
      const sp = r.dist ? r.speed / r.dist : 0, al = r.dist ? r.along / r.dist : 0;
      const eff = Math.abs(al) < 1 ? "–" : `${al > 0 ? "+" : "−"}${num(Math.abs(al), 0)} km/h ${al > 0 ? "hátszél" : "szembeszél"}`;
      const t = r.temps.length ? ` · ${num(r.temps.reduce((a, b) => a + b, 0) / r.temps.length, 0)} °C` : "";
      return `<div class="wseg-row">
        <span class="wseg-type"><i style="background:${WIND_COLORS[r.mode] || "#888"}"></i>${WIND_LABELS[r.mode] || r.mode}</span>
        <span>${num(r.fromKm, 1)}–${num(r.toKm, 1)} km<small>${num(r.dist, 1)} km</small></span>
        <span>${hhmm(r.from)}${hhmm(r.to) !== hhmm(r.from) ? `–${hhmm(r.to)}` : ""}<small>${t.slice(3)}</small></span>
        <span>${num(sp, 0)} km/h<small>${compass(avgDir(r.dirs))} felől</small></span>
        <span class="wseg-eff ${al > 1 ? "is-tail" : al < -1 ? "is-head" : ""}">${eff}</span>
      </div>`;
    }).join("");
  box.hidden = false;
}

/** A szélgrafikon adatai: a nyomvonal minden pontjához az őt tartalmazó szakasz szele. */
function renderWindChart(segments) {
  if (!_windChart) return;
  const track = buildTrackDistances(_getActiveGeometry?.() || []);
  if (!track.length || !segments?.length) { _windChart.setData([]); return; }
  let si = 0;
  const data = track.map((p) => {
    const km = p.dist / 1000;
    while (si < segments.length - 1 && km > segments[si].toKm) si++;
    const w = segments[si].wind;
    return { ...p, value: w.speed, mode: w.mode };
  });
  _windChart.setData(data, {
    color: WIND_COLORS.cross, unit: "km/h", zeroBase: true,
    colorFn: (_v, pt) => WIND_COLORS[pt?.mode] || "#888",
    formatTip: (pt) => [`${num(pt.dist / 1000, 1)} km · ${num(pt.value, 0)} km/h szél`, WIND_LABELS[pt.mode] || ""],
  });
  _windChart.setMarkers(_chartMarkers ? _chartMarkers(data) : []);
  const legend = document.querySelector("#legendWind");
  if (legend) {
    legend.innerHTML = ["tail", "cross", "head"]
      .map((m) => `<span><i style="background:${WIND_COLORS[m]}"></i>${WIND_LABELS[m]}</span>`).join("");
    legend.hidden = false;
  }
}

export function clearWindResult() {
  _windResult = null;
  if (!_el) return;
  _windChart?.setData([]);
  const statsEl = document.querySelector("#statsWind");
  if (statsEl) statsEl.innerHTML = "";
  const legend = document.querySelector("#legendWind");
  if (legend) legend.hidden = true;
  const segDetails = document.querySelector("#windSegDetails");
  if (segDetails) segDetails.hidden = true;
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
  requestAnimationFrame(() => _windChart?.resize());
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
  if (!_isPlanContext()) return;
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
