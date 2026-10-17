/**
 * Bringaterv – Publikus útvonal-nézőoldal (view.html)
 * ====================================================
 * Csak olvasható, a fő app elemző nézetének mintájára: fejléc, adatlap
 * (meta + stat-kártyák), térképstílus-váltás, ki-be kapcsolható, szinkronizált
 * grafikonok térképjelölővel. Betölti a /api/public/route/<id> adatot (auth
 * nélkül); az app auth-rétegét nem tölti be, ezért nincs login-kapu.
 */

import { importGpx, calcElevationFromGeometry } from "./gpx/gpx.js";
import { buildElevationData, buildHrData, buildCadData, buildPowerData, buildSpeedData } from "./ui/elevationProfile.js";
import { getTileLayerDef } from "./map/mapAdapter.js";
import { libraryRouteSportKey } from "./ui/library.js";

// Ugyanazok az ikonok, mint a könyvtár nézetben
const SPORT_ICONS = { cycling: "bike", run: "footprints", hike: "mountain-snow", walk: "footprints", other: "activity" };

const $ = (id) => document.getElementById(id);
let _map = null, _hoverMarker = null, _baseLayer = null, _overlayLayer = null;
const NAVY = "#2d4a5a", ACCENT = "#e8461e";
const MAP_STYLE_KEY = "route4meMapStyle";   // ugyanaz, mint a fő appban
const STYLE_LABELS = {
  standard: "Standard", cycling: "Kerékpár", topo: "Domborzat", satellite: "Műhold",
  hybrid: "Hybrid", light: "Világos", dark: "Sötét",
};

const TYPE_LABELS = {
  cycling: "Kerékpár", asphalt: "Országúti", gravel: "Gravel", mtb: "MTB",
  hiking: "Túra", walking: "Túra", running: "Futás", run: "Futás", ride: "Kerékpár",
};

initTheme();
init();

async function init() {
  const id = new URLSearchParams(location.search).get("route");
  const appHome = location.origin;
  $("v-homelink").href = appHome + "/";
  $("v-open").href = id ? `${appHome}/?route=${encodeURIComponent(id)}` : appHome + "/";
  window.lucide?.createIcons();

  if (!id) return showError();

  try {
    const resp = await fetch(`/api/public/route/${encodeURIComponent(id)}`);
    if (!resp.ok) return showError();
    const data = await resp.json();
    if (!data.found || !data.gpx) return showError();
    await render(data.meta || {}, data.gpx);
  } catch (err) {
    console.error("Publikus betöltés hiba:", err);
    showError();
  }
}

function showError() {
  $("v-loading").hidden = true;
  $("v-error").hidden = false;
}

// ── Téma (sötét/világos) – a fő app kulcsával ─────────────────────────────────

function initTheme() {
  const btn = $("themeToggle");
  const paint = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    btn.innerHTML = `<i data-lucide="${dark ? "moon" : "sun"}" aria-hidden="true"></i>`;
    btn.title = dark ? "Váltás világos módra" : "Váltás sötét módra";
    window.lucide?.createIcons();
  };
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("route4meTheme", next); } catch (_) {}
    paint();
    redrawAll();   // grafikonok színei (muted) igazodjanak
  });
  paint();
}

async function render(meta, gpxText) {
  const parsed = await importGpx(new Blob([gpxText]));
  const geometry = parsed.geometry || [];

  const name = meta.name || parsed.meta?.name || "Útvonal";
  $("v-name").textContent = name;
  $("v-name").title = name;
  document.title = `${name} – Bringaterv`;

  renderMeta(meta, parsed);

  $("v-loading").hidden = true;
  $("v-content").hidden = false;

  renderMap(geometry);
  initStylePicker();
  renderStats(meta, geometry, parsed.meta || {});
  renderCharts(geometry);

  if (meta.description) {
    $("v-desc").textContent = meta.description;
    $("v-desc-wrap").hidden = false;
  }
  window.lucide?.createIcons();
}

// ── Meta-sorok (mint az elemzőben) ────────────────────────────────────────────

function renderMeta(meta, parsed) {
  const typeKey = (meta.type || parsed.meta?.type || "").toLowerCase();
  const typeLabel = TYPE_LABELS[typeKey] || meta.type || parsed.meta?.type || "";
  // A típust a cím melletti ikon jelzi (címke a tooltipben); alatta a dátum
  const sportIcon = SPORT_ICONS[libraryRouteSportKey({ sport_type: meta.type || parsed.meta?.type || "" })] || "bike";
  $("v-sport-icon").innerHTML = `<i data-lucide="${sportIcon}" aria-hidden="true"></i>`;
  $("v-sport-icon").title = typeLabel;
  const start = parsed.meta?.startTime || meta.date;
  $("v-date").textContent = start ? fmtDateTime(start, !!parsed.meta?.startTime) : "";
}

// ── Térkép + stílusváltás ─────────────────────────────────────────────────────

function currentStyle() {
  let s = "standard";
  try { s = localStorage.getItem(MAP_STYLE_KEY) || "standard"; } catch (_) {}
  return STYLE_LABELS[s] ? s : "standard";
}

function applyMapStyle(style) {
  if (!_map) return;
  const def = getTileLayerDef(style);
  if (_baseLayer) _map.removeLayer(_baseLayer);
  if (_overlayLayer) { _map.removeLayer(_overlayLayer); _overlayLayer = null; }
  _baseLayer = L.tileLayer(def.url, def.options).addTo(_map);
  if (def.overlay) _overlayLayer = L.tileLayer(def.overlay.url, def.overlay.options).addTo(_map);
  $("vStyleLabel").textContent = STYLE_LABELS[style] || "Standard";
  document.querySelectorAll("#vStylePicker [data-map-style]").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.mapStyle === style));
}

function initStylePicker() {
  $("vFitBtn")?.addEventListener("click", () => _fitRoute());
  const btn = $("vStyleBtn"), pop = $("vStylePicker");
  btn.addEventListener("click", (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
  document.addEventListener("click", (e) => { if (!pop.contains(e.target)) pop.hidden = true; });
  pop.querySelectorAll("[data-map-style]").forEach((b) => b.addEventListener("click", () => {
    const style = b.dataset.mapStyle;
    try { localStorage.setItem(MAP_STYLE_KEY, style); } catch (_) {}
    applyMapStyle(style);
    pop.hidden = true;
  }));
}

function renderMap(geometry) {
  const latlngs = geometry
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) => [p.lat, p.lng]);
  const map = L.map("v-map", { zoomControl: true });
  _map = map;
  applyMapStyle(currentStyle());

  if (latlngs.length < 2) { map.setView([47.5, 19.05], 7); return; }

  const line = L.polyline(latlngs, { color: ACCENT, weight: 5, opacity: 0.9 }).addTo(map);
  _baseLine = line;
  _mapGeom = geometry.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  L.circleMarker(latlngs[0], { radius: 7, color: "#fff", weight: 2, fillColor: "#16a34a", fillOpacity: 1 }).addTo(map);
  L.circleMarker(latlngs[latlngs.length - 1], { radius: 7, color: "#fff", weight: 2, fillColor: "#dc2626", fillOpacity: 1 }).addTo(map);

  // Fit csak akkor helyes, ha a konténer már megkapta a méretét – ezért
  // invalidateSize után fitelünk, maxZoom-mal a túlzott ránagyítás ellen,
  // és ismételjük, miután a layout beállt.
  _fitRoute = () => { map.invalidateSize(); map.fitBounds(line.getBounds(), { padding: [24, 24], maxZoom: 16 }); };
  _fitRoute();
  requestAnimationFrame(_fitRoute);
  setTimeout(_fitRoute, 300);
}
let _fitRoute = () => {};

// ── Stat-kártyák (a fő app elemző nézetének mintájára) ────────────────────────

function avg(data) {
  const vals = (data || []).map((d) => d.value).filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function maxOf(data) {
  const vals = (data || []).map((d) => d.value).filter((v) => v != null && Number.isFinite(v));
  return vals.length ? Math.max(...vals) : null;
}

function renderStats(meta, geometry, gmeta) {
  const cards = [];
  const isWorkout = meta.kind === "workout";
  const distKm = meta.distanceM ? meta.distanceM / 1000 : haversineKm(geometry);

  // Időtartam = teljes eltelt idő; mozgási idő = a kisebbik ismert érték
  // (a Strava „duration"-ja mozgási idő, a GPX-ből számolt pedig ettől eltérhet).
  const gpxTotal = gmeta.totalDuration ? gmeta.totalDuration / 60000 : null;
  const gpxMoving = gmeta.movingDuration ? gmeta.movingDuration / 60000 : null;
  const totalMin = Math.max(meta.durationMin || 0, gpxTotal || 0) || null;
  const movingCands = [meta.durationMin, gpxMoving].filter((v) => v > 0);
  const movingMin = isWorkout && movingCands.length ? Math.min(...movingCands) : null;
  if (totalMin) cards.push([isWorkout ? "Időtartam" : "Becsült idő", fmtDuration(totalMin)]);
  if (movingMin && Math.round(movingMin) < Math.round(totalMin)) cards.push(["Mozgási idő", fmtDuration(movingMin)]);
  if (distKm > 0) cards.push(["Távolság", `${fmt(distKm, 1)} km`]);

  const { ascentMeters, descentMeters } = calcElevationFromGeometry(geometry);
  const asc = meta.elevationM ?? (ascentMeters || null);
  if (asc != null) cards.push(["↑ Emelkedő", `${Math.round(asc)} m`]);
  if (descentMeters) cards.push(["↓ Ereszkedő", `${Math.round(descentMeters)} m`]);

  const speed = buildSpeedData(geometry);
  const avgSpeed = meta.avgSpeed || ((movingMin || totalMin) && distKm ? distKm / ((movingMin || totalMin) / 60) : null) || avg(speed);
  if (avgSpeed) cards.push(["⌀ Átlag sebesség", `${fmt(avgSpeed, 1)} km/h`]);
  const maxSpeed = meta.maxSpeed || (isWorkout ? maxOf(speed) : null);
  if (maxSpeed) cards.push(["Max sebesség", `${fmt(maxSpeed, 1)} km/h`]);

  const hr = buildHrData(geometry);
  const hrAvg = meta.avgHr || avg(hr), hrMax = meta.maxHr || maxOf(hr);
  if (hrAvg) cards.push(["⌀ Átlag pulzus", `${Math.round(hrAvg)} bpm`]);
  if (hrMax) cards.push(["Max pulzus", `${Math.round(hrMax)} bpm`]);

  const cad = buildCadData(geometry);
  const cadAvg = meta.avgCadence || avg(cad), cadMax = maxOf(cad);
  if (cadAvg) cards.push(["⌀ Átlag kadencia", `${Math.round(cadAvg)} rpm`]);
  if (cadMax) cards.push(["Max kadencia", `${Math.round(cadMax)} rpm`]);

  const pow = buildPowerData(geometry);
  const powAvg = meta.avgPower || avg(pow), powMax = meta.maxPower || maxOf(pow);
  if (powAvg) cards.push(["⌀ Átlag teljesítmény", `${Math.round(powAvg)} W`]);
  if (powMax) cards.push(["Max teljesítmény", `${Math.round(powMax)} W`]);

  if (meta.kilojoules) cards.push(["Mechanikai munka", `${Math.round(meta.kilojoules)} kJ`]);
  if (meta.calories) cards.push(["Kalória", `${Math.round(meta.calories)} kcal`]);

  // Páratlan számú kártyánál az utolsó kitölti a sort (mint az Elemzés fülön)
  $("v-stats").innerHTML = cards.map(([label, value], i) =>
    `<div class="stat-card${cards.length % 2 && i === cards.length - 1 ? " stat-card--wide" : ""}"><span>${label}</span><strong>${value}</strong></div>`).join("");
}

// ── Szintprofil ──────────────────────────────────────────────────────────────

const CHARTS = [
  { key: "elev",  label: "Szintprofil",  unit: "m",    rgb: [5, 150, 105],  build: buildElevationData, fromZero: false, dec: 0, def: true },
  { key: "speed", label: "Sebesség",     unit: "km/h", rgb: [25, 118, 210], build: buildSpeedData,     fromZero: true,  dec: 1, def: true },
  { key: "hr",    label: "Pulzus",       unit: "bpm",  rgb: [220, 38, 38],  build: buildHrData,        fromZero: false, dec: 0, def: true },
  { key: "cad",   label: "Kadencia",     unit: "rpm",  rgb: [147, 51, 234], build: buildCadData,       fromZero: true,  dec: 0, def: true },
  { key: "power", label: "Teljesítmény", unit: "W",    rgb: [217, 119, 6],  build: buildPowerData,     fromZero: true,  dec: 0, def: true },
];
// v2: a kadencia és a teljesítmény is alapból látszik (régi mentett választás érvénytelen)
const CHART_PREF_KEY = "bringaterv-view-charts-v2";
let _charts = [];

function loadChartPrefs() {
  try { const v = JSON.parse(localStorage.getItem(CHART_PREF_KEY) || "null"); return Array.isArray(v) ? new Set(v) : null; }
  catch (_) { return null; }
}
function saveChartPrefs() {
  try { localStorage.setItem(CHART_PREF_KEY, JSON.stringify(_charts.filter((c) => c.on).map((c) => c.cfg.key))); } catch (_) {}
}

// Grafikonok: ki-be kapcsolható, szinkronizált hover + térképjelölő (mint az elemzőben)
function renderCharts(geometry) {
  const prefs = loadChartPrefs();
  _charts = CHARTS.map((cfg) => {
    const data = (cfg.build(geometry) || []).filter((d) => d.value != null && Number.isFinite(d.value));
    return { cfg, data, on: prefs ? prefs.has(cfg.key) : cfg.def };
  }).filter((c) => c.data.length >= 2);
  if (!_charts.length) return;
  // Ha az elmentett preferencia mindent elrejtene, mutassuk legalább az elsőt
  if (!_charts.some((c) => c.on)) _charts[0].on = true;

  $("v-toggle-wrap").hidden = false;
  updateChartsPanel();
  const toggles = $("v-chart-toggles"), host = $("v-charts");

  for (const ch of _charts) {
    // Ugyanaz a sor, mint az Elemzés fülön: cím · diagram gomb · térkép-kapcsoló.
    // A diagram gomb a grafikont mutatja/rejti, a kapcsoló a térképen színez
    // (egyszerre egy színezés lehet aktív – mint a fő appban).
    const colorable = canColor(ch.cfg.key);
    const row = document.createElement("div");
    row.className = "speed-legend v-legend-row";
    row.innerHTML = `<div class="speed-legend-header">`
      + `<span class="speed-legend-title">${ch.cfg.label}</span>`
      + `<button type="button" class="grade-chart-btn${ch.on ? " is-active" : ""}" title="${ch.cfg.label} grafikon mutatása / elrejtése" aria-pressed="${ch.on}">${CHART_SVG}</button>`
      + (colorable
        ? `<label class="toggle-switch" title="${ch.cfg.label}: útvonal színezése a térképen"><input type="checkbox" data-color-key="${ch.cfg.key}" aria-label="${ch.cfg.label} színezés a térképen"><span class="toggle-track"></span></label>`
        : `<span class="v-legend-spacer" aria-hidden="true"></span>`)
      + `</div>`;
    const chartBtn = row.querySelector(".grade-chart-btn");
    chartBtn.addEventListener("click", () => {
      ch.on = !ch.on;
      chartBtn.classList.toggle("is-active", ch.on);
      chartBtn.setAttribute("aria-pressed", String(ch.on));
      ch.el.hidden = !ch.on;
      saveChartPrefs();
      updateChartsPanel();
      if (ch.on) drawChart(ch, _hoverDist);
    });
    row.querySelector("input[data-color-key]")?.addEventListener("change", (e) => {
      setColorMode(e.target.checked ? ch.cfg.key : null);
    });
    toggles.appendChild(row);

    const sec = document.createElement("div");
    sec.className = "v-chart";
    sec.hidden = !ch.on;
    sec.innerHTML = `<div class="v-chart-head"><h2>${ch.cfg.label} (${ch.cfg.unit})</h2><span class="v-readout"></span></div><canvas></canvas>`;
    host.appendChild(sec);
    ch.el = sec;
    ch.canvas = sec.querySelector("canvas");
    ch.readout = sec.querySelector(".v-readout");

    const onMove = (e) => {
      const rect = ch.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (!ch.scale) return;
      setHover(ch.scale.invX(x));
    };
    ch.canvas.addEventListener("pointermove", onMove);
    ch.canvas.addEventListener("pointerdown", onMove);
    ch.canvas.addEventListener("pointerleave", () => setHover(null));
  }

  _geoDists = cumulativeDists(geometry);
  _geometry = geometry;
  redrawAll();
  let t = null;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(redrawAll, 120); });
}

let _hoverDist = null, _geometry = [], _geoDists = [];

// A grafikon-panel csak akkor látszik, ha van bekapcsolt grafikon; a térkép
// mérete ehhez igazodik.
function updateChartsPanel() {
  $("v-charts-wrap").hidden = !_charts.some((c) => c.on);
  if (_map) setTimeout(() => _map.invalidateSize(), 0);
}

function redrawAll() {
  for (const ch of _charts) if (ch.on) drawChart(ch, _hoverDist);
}

function setHover(dist) {
  _hoverDist = dist;
  redrawAll();
  if (!_map) return;
  if (dist == null) {
    if (_hoverMarker) { _map.removeLayer(_hoverMarker); _hoverMarker = null; }
    return;
  }
  const i = nearestIndex(_geoDists, dist);
  const p = _geometry[i];
  if (!p || !Number.isFinite(p.lat)) return;
  if (!_hoverMarker) {
    _hoverMarker = L.circleMarker([p.lat, p.lng], {
      radius: 8, color: "#fff", weight: 3, fillColor: NAVY, fillOpacity: 1,
    }).addTo(_map);
  } else {
    _hoverMarker.setLatLng([p.lat, p.lng]);
  }
}

function drawChart(ch, hoverDist) {
  const { data, cfg } = ch;
  const [r, g, b] = cfg.rgb;
  const canvas = ch.canvas;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800, cssH = 120;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const padL = 40, padR = 8, padT = 8, padB = 20;
  const plotW = cssW - padL - padR, plotH = cssH - padT - padB;
  const dMin = data[0].dist, dMax = data[data.length - 1].dist;
  let vMin = Infinity, vMax = -Infinity;
  for (const d of data) { if (d.value < vMin) vMin = d.value; if (d.value > vMax) vMax = d.value; }
  if (cfg.fromZero) { vMin = 0; vMax = vMax * 1.1 || 1; }
  else { if (vMax - vMin < 10) { vMax += 5; vMin -= 5; } const pd = (vMax - vMin) * 0.12; vMin -= pd; vMax += pd; }
  const sx = (d) => padL + ((d - dMin) / (dMax - dMin || 1)) * plotW;
  const sy = (v) => padT + plotH - ((v - vMin) / (vMax - vMin || 1)) * plotH;
  ch.scale = { invX: (x) => dMin + Math.min(1, Math.max(0, (x - padL) / plotW)) * (dMax - dMin) };

  const muted = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#7a8891";
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.strokeStyle = "rgba(127,127,127,0.18)"; ctx.lineWidth = 1;
  ctx.fillStyle = muted; ctx.font = "10px Inter, sans-serif";
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let i = 0; i <= 3; i++) {
    const v = vMin + ((vMax - vMin) * i) / 3, y = sy(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
    ctx.fillText(`${Math.round(v)}`, padL - 6, y);
  }

  ctx.beginPath();
  ctx.moveTo(sx(data[0].dist), sy(data[0].value));
  for (const d of data) ctx.lineTo(sx(d.dist), sy(d.value));
  ctx.lineTo(sx(dMax), padT + plotH); ctx.lineTo(sx(dMin), padT + plotH); ctx.closePath();
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.28)`); grad.addColorStop(1, `rgba(${r},${g},${b},0.02)`);
  ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath();
  data.forEach((d, i) => (i === 0 ? ctx.moveTo(sx(d.dist), sy(d.value)) : ctx.lineTo(sx(d.dist), sy(d.value))));
  ctx.strokeStyle = `rgb(${r},${g},${b})`; ctx.lineWidth = 1.6; ctx.lineJoin = "round"; ctx.stroke();

  ctx.fillStyle = muted; ctx.textAlign = "center"; ctx.textBaseline = "top";
  const totalKm = dMax / 1000;
  const step = totalKm > 60 ? 20 : totalKm > 20 ? 10 : totalKm > 8 ? 5 : 2;
  for (let km = 0; km <= totalKm + 0.001; km += step) ctx.fillText(`${km}`, sx(km * 1000), padT + plotH + 6);

  // Hover: függőleges vonal + pont + kiírt érték
  if (hoverDist != null) {
    const d = data[nearestIndex(data.map((p) => p.dist), hoverDist)];
    const x = sx(d.dist), y = sy(d.value);
    ctx.strokeStyle = "rgba(100,110,118,0.6)"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
    ch.readout.textContent = `${fmt(d.dist / 1000, 1)} km · ${fmt(d.value, cfg.dec)} ${cfg.unit}`;
  } else {
    ch.readout.textContent = "";
  }
}

function cumulativeDists(geometry) {
  const out = [0];
  for (let i = 1; i < geometry.length; i++) out.push(out[i - 1] + haversineKm([geometry[i - 1], geometry[i]]) * 1000);
  return out;
}

function nearestIndex(sorted, v) {
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(sorted[lo - 1] - v) < Math.abs(sorted[lo] - v)) lo--;
  return lo;
}

// ── Segédek ──────────────────────────────────────────────────────────────────

function haversineKm(geometry) {
  let m = 0;
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1], b = geometry[i];
    if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) continue;
    const R = 6371000, toRad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
    m += R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  return m / 1000;
}

function fmt(v, d = 1) {
  return Number(v || 0).toLocaleString("hu-HU", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtDuration(min) {
  const m = Math.round(min), h = Math.floor(m / 60), r = m % 60;
  return h > 0 ? `${h} ó ${r} p` : `${r} p`;
}

function fmtDateTime(d, withTime) {
  try {
    const opts = { year: "numeric", month: "long", day: "numeric" };
    if (withTime) { opts.hour = "2-digit"; opts.minute = "2-digit"; }
    return new Date(d).toLocaleString("hu-HU", opts);
  } catch (_) { return String(d); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDate(d) {
  try { return new Date(d).toLocaleDateString("hu-HU", { year: "numeric", month: "long", day: "numeric" }); }
  catch (_) { return d; }
}


// ── Útvonal színezése a térképen (mint az Elemzés „térkép” kapcsolói) ─────────
// A néző nem látja a tulajdonos zónabeállításait, ezért a sávhatárok az adott
// edzés saját eloszlásából jönnek (ötödök); a szintprofil lejtés szerint színez.
const CHART_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';
const PAINT_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17c3-6 6-9 9-9s3 4 6 4 3-3 3-3"/><circle cx="3" cy="17" r="1.5"/><circle cx="21" cy="9" r="1.5"/></svg>';
const BAND_COLORS = ["#3B82F6", "#22C55E", "#EAB308", "#F97316", "#EF4444"];
const GRADE_COLORS = ["#15803D", "#4ADE80", "#94A3B8", "#EAB308", "#F97316", "#DC2626"];
const GRADE_EDGES = [-4, -1, 1, 4, 8];
const COLOR_FIELDS = { speed: "speed", hr: "hr", cad: "cad", power: "power", elev: null };
const COLOR_UNITS = { speed: "km/h", hr: "bpm", cad: "rpm", power: "W", elev: "%" };

let _colorKey = null, _colorLayer = null, _colorLegend = null, _baseLine = null, _mapGeom = [];

function canColor(key) {
  if (!(key in COLOR_FIELDS)) return false;
  const geo = _mapGeom.length ? _mapGeom : [];
  if (key === "elev") return geo.filter((p) => Number.isFinite(p.ele)).length > 10;
  const f = COLOR_FIELDS[key];
  return geo.filter((p) => Number.isFinite(p[f]) && p[f] > 0).length > 10;
}

function distM(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Pontonkénti érték (simítva), lejtésnél ~100 m-es ablakkal */
function pointValues(key) {
  const g = _mapGeom;
  if (key === "elev") {
    const cum = [0];
    for (let i = 1; i < g.length; i++) cum.push(cum[i - 1] + distM(g[i - 1], g[i]));
    return g.map((p, i) => {
      let j = i;
      while (j > 0 && cum[i] - cum[j] < 100) j--;
      const d = cum[i] - cum[j];
      return d > 20 && Number.isFinite(p.ele) && Number.isFinite(g[j].ele) ? ((p.ele - g[j].ele) / d) * 100 : null;
    });
  }
  const f = COLOR_FIELDS[key];
  const raw = g.map((p) => (Number.isFinite(p[f]) && p[f] > 0 ? p[f] : null));
  return raw.map((_, i) => {                       // 7 pontos mozgóátlag a villódzás ellen
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - 3); k <= Math.min(raw.length - 1, i + 3); k++) if (raw[k] != null) { sum += raw[k]; n++; }
    return n ? sum / n : null;
  });
}

function quantileEdges(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  return [0.2, 0.4, 0.6, 0.8].map((q) => v[Math.min(v.length - 1, Math.floor(q * v.length))]);
}

function bandIndex(val, edges) {
  let i = 0;
  while (i < edges.length && val >= edges[i]) i++;
  return i;
}

function setColorMode(key) {
  _colorKey = key;
  document.querySelectorAll("input[data-color-key]").forEach((cb) => { cb.checked = cb.dataset.colorKey === key; });
  if (_colorLayer) { _colorLayer.remove(); _colorLayer = null; }
  if (_colorLegend) { _colorLegend.remove(); _colorLegend = null; }
  if (!key || !_map) { _baseLine?.setStyle({ opacity: 0.9 }); return; }

  const vals = pointValues(key);
  const isGrade = key === "elev";
  const edges = isGrade ? GRADE_EDGES : quantileEdges(vals);
  const colors = isGrade ? GRADE_COLORS : BAND_COLORS;
  const idx = vals.map((v) => (v == null ? -1 : bandIndex(v, edges)));
  // rövid színfoltok simítása (mint a fő appban), hogy ne szakadozzon
  for (let i = 1, start = 0; i <= idx.length; i++) {
    if (i === idx.length || idx[i] !== idx[start]) {
      if (i - start < 6 && start > 0) for (let k = start; k < i; k++) idx[k] = idx[start - 1];
      start = i;
    }
  }
  _colorLayer = L.layerGroup().addTo(_map);
  const ll = _mapGeom.map((p) => [p.lat, p.lng]);
  for (let i = 1, start = 0; i <= ll.length; i++) {
    if (i === ll.length || idx[i] !== idx[start]) {
      const c = idx[start] >= 0 ? colors[idx[start]] : "#9CA3AF";
      L.polyline(ll.slice(Math.max(0, start - 1), i), { color: c, weight: 5, opacity: 0.95, lineCap: "round", lineJoin: "round", interactive: false }).addTo(_colorLayer);
      start = i;
    }
  }
  _baseLine?.setStyle({ opacity: 0 });
  _hoverMarker?.bringToFront?.();

  // jelmagyarázat a térkép bal alsó sarkában
  const unit = COLOR_UNITS[key];
  const dec = key === "speed" ? 1 : 0;
  const f = (x) => (isGrade ? String(Math.round(x)) : x.toFixed(dec).replace(".", ",")).replace("-", "−");
  const labels = colors.map((_, i) => {
    if (i === 0) return `< ${f(edges[0])}`;
    if (i === colors.length - 1) return `${f(edges[i - 1])} felett`;
    return `${f(edges[i - 1])} – ${f(edges[i])}`;
  });
  const label = (_charts.find((c) => c.cfg.key === key)?.cfg.label) || "";
  _colorLegend = L.control({ position: "bottomleft" });
  _colorLegend.onAdd = () => {
    const d = L.DomUtil.create("div", "map-legend");
    d.innerHTML = `<div class="map-legend-title">${isGrade ? "Lejtés" : label} (${unit})</div>`
      + colors.map((c, i) => `<div class="map-legend-row"><span style="background:${c}"></span>${labels[i]}</div>`).join("");
    return d;
  };
  _colorLegend.addTo(_map);
}
