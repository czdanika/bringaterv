/**
 * Bringaterv – Publikus útvonal-nézőoldal (view.html)
 * ====================================================
 * Csak olvasható, a fő app elemző nézetének mintájára: fejléc, adatlap
 * (meta + stat-kártyák), térképstílus-váltás, ki-be kapcsolható, szinkronizált
 * grafikonok térképjelölővel. Betölti a /api/public/route/<id> adatot (auth
 * nélkül); az app auth-rétegét nem tölti be, ezért nincs login-kapu.
 */

import { importGpx, calcElevationFromGeometry } from "./gpx/gpx.js";
import { buildElevationData, buildHrData, buildCadData, buildPowerData, buildSpeedData, initElevationChart, CHART_SOLID_GRAY } from "./ui/elevationProfile.js";
import { getTileLayerDef } from "./map/mapAdapter.js";
import { libraryRouteSportKey } from "./ui/library.js";
import { locatorSvg } from "./map/locator.js";
import { computeRangeStats, trackDists, renderRangeBar } from "./ui/rangeStats.js";
import { initBestEfforts, clearBestHighlight } from "./ui/bestEfforts.js";
import { initClimbs, clearClimbHighlight } from "./ui/climbs.js";
import { initSplits, clearSplitsHighlight } from "./ui/splits.js";
import { initPedaling } from "./ui/pedaling.js";
import { initWorkoutWind, getWorkoutWind, clearWindHighlight } from "./ui/workoutWind.js";
import { WIND_COLORS, WIND_LABELS } from "./wind/windService.js";
import { durMs } from "./format.js";

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
  hiking: "Túra", walking: "Séta", running: "Futás", run: "Futás", ride: "Kerékpár",
};

/**
 * Hibaoldal: „gone” – törölték / kikapcsolták a megosztást; „offline” – a szerver most
 * nem érhető el (újrapróbálható); „badlink” – hiányos link (nincs benne azonosító).
 */
const ERRORS = {
  gone: ["Ez a megosztott útvonal vagy edzés már nem elérhető",
         "A tulajdonosa törölte, vagy kikapcsolta a megosztását. Ha tőle kaptad a linket vagy a QR-kódot, kérj tőle újat."],
  offline: ["A Bringaterv most nem érhető el",
            "Valószínűleg átmeneti hiba vagy karbantartás – az útvonal ettől még megvan. Próbáld újra pár perc múlva."],
  badlink: ["Hiányos link",
            "A linkből hiányzik az útvonal azonosítója. Ellenőrizd, hogy a teljes címet másoltad-e, vagy olvasd be újra a QR-kódot."],
};

initTheme();
init();

async function init() {
  const id = new URLSearchParams(location.search).get("route");
  const appHome = location.origin;
  $("v-homelink").href = appHome + "/";
  $("v-open").href = id ? `${appHome}/?route=${encodeURIComponent(id)}` : appHome + "/";
  window.lucide?.createIcons();

  if (!id) return showError("badlink");

  let resp;
  try {
    let headers = {};
    try { const t = localStorage.getItem("bringaterv_jwt"); if (t) headers = { Authorization: `Bearer ${t}` }; } catch (_) {}
    resp = await fetch(`/api/public/route/${encodeURIComponent(id)}`, { headers });
  } catch (err) {
    console.error("Publikus betöltés hiba:", err);
    return showError("offline");
  }
  if (resp.status === 404) return showError("gone");
  if (!resp.ok) return showError("offline");
  try {
    const data = await resp.json();
    if (!data.found || !data.gpx) return showError("gone");
    await render(data.meta || {}, data.gpx, id);
  } catch (err) {
    console.error("Publikus megjelenítés hiba:", err);
    showError("offline");
  }
}

function showError(kind = "gone") {
  const [title, text] = ERRORS[kind] || ERRORS.gone;
  $("v-err-title").textContent = title;
  $("v-err-text").textContent = text;
  $("v-err-retry").hidden = kind !== "offline";
  $("v-err-retry").onclick = () => location.reload();
  $("v-err-about").hidden = kind === "offline";
  document.title = `${title} – Bringaterv`;
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

async function render(meta, gpxText, id) {
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
  renderSummary(meta, geometry, parsed.meta || {});
  renderCharts(geometry);
  initAnalysis(meta, geometry, id);

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
  $("v-date").textContent = [typeLabel, start ? fmtDateTime(start, !!parsed.meta?.startTime) : ""].filter(Boolean).join(" · ");
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
  // tájoló: hol van az útvonal az országon belül (jobb alsó sarok)
  const loc = locatorSvg(_mapGeom, { w: 92, h: 58, dark: document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches) });
  if (loc) {
    const ctl = L.control({ position: "bottomright" });
    ctl.onAdd = () => { const d = L.DomUtil.create("div", "map-locator"); d.title = "Hol van? – az útvonal helye az országon belül"; d.innerHTML = loc; return d; };
    ctl.addTo(map);
  }

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

/** Összefoglaló – ugyanazokkal a képletekkel, mint az app Elemzés füle (fileTab.populateFileTab):
 *  táv a nyomvonalból, emelkedés 3 m-es küszöbbel, átlag = táv / mozgásidő, max a pontokból. */
const HINTS = {
  "Táv": "A rögzített nyomvonal hossza.",
  "Mozgásidő": "Csak az az idő, amíg haladt – a megállások nélkül.",
  "Időtartam": "A rögzítés teljes ideje az indulástól az érkezésig.",
  "Becsült idő": "A tervezett útvonal becsült menetideje.",
  "Átlagsebesség": "Táv osztva a mozgásidővel – a megállások nem rontják.",
  "Emelkedés": "Összesen ennyi méter felfelé – a rögzítő eszköz értéke, ha megadta; a ↓ érték az ereszkedés.",
  "Sebesség": "Átlag: táv / mozgásidő. Max: a legnagyobb mért pillanatnyi sebesség.",
  "Pulzus": "Átlagos és legmagasabb szívfrekvencia (ütés / perc).",
  "Kadencia": "Pedálfordulat percenként; az átlagban a gurulás (0) nem számít.",
  "Teljesítmény": "Wattmérővel mért teljesítmény: átlag és a legnagyobb pillanatnyi érték.",
  "Hőmérséklet": "Az eszköz hőmérője szerinti átlag; „≈” jellel az időjárásból.",
  "Kalória": "Az elégetett energia (az eszköz / Strava értéke vagy becslés).",
  "Munka": "Mechanikai munka a wattmérő szerint (kJ).",
  "Teljes idő": "A rögzítés teljes ideje a megállásokkal együtt.",
};
const hintAttr = (k) => HINTS[k] ? ` title="${escapeHtml(HINTS[k])}"` : "";

function renderSummary(meta, geometry, gmeta) {
  const isWorkout = meta.kind === "workout";
  // egy forrás mindenhol (mint az app): a szolgáltató tárolt táv / emelkedés értéke, ha van; különben a GPX-ből
  const distM = (meta.distanceM > 0 ? meta.distanceM : 0) || haversineKm(geometry) * 1000 || 0;
  let { ascentMeters, descentMeters } = calcElevationFromGeometry(geometry);
  if (meta.elevationM > 0) {
    ascentMeters = Math.round(meta.elevationM);
    const eles = geometry.map((p) => p.ele).filter((v) => Number.isFinite(v));
    if (eles.length > 1) descentMeters = Math.max(0, Math.round(meta.elevationM + eles[0] - eles[eles.length - 1]));
  }
  const totalMs = gmeta.totalDuration || null, movingMs = gmeta.movingDuration || null;
  // időtartam az app formájában („4 ó 3 p”), a mértékegység halványan
  const unitify = (t) => String(t || "").replace(/([\d,.]+)\s*([^\d\s,.]+)/g, "$1<small>$2</small>");
  const durS = (ms) => unitify(durMs(ms));
  // fő számok (mint az Elemzés tetején)
  const big = [[fmt(distM / 1000, 1), "km", "Táv"]];
  // mint az Elemzés: ha a mozgásidő kerekítve egyezik a teljes idővel, „Időtartam”
  if (isWorkout && movingMs && durMs(movingMs) !== durMs(totalMs || 0)) big.push([durS(movingMs), "", "Mozgásidő"]);
  else if (isWorkout && (totalMs || movingMs)) big.push([durS(totalMs || movingMs), "", "Időtartam"]);
  else if (meta.durationMin) big.push([unitify(fmtDuration(meta.durationMin)), "", "Becsült idő"]);
  const speeds = geometry.map((p) => p.speed).filter((v) => v != null && v > 0 && v < 120);
  const avgSpeed = movingMs > 0 && distM > 0 ? distM / (movingMs / 3600000) / 1000
    : speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null;
  if (isWorkout && avgSpeed) big.push([fmt(avgSpeed, 1), "km/h", "Átlagsebesség"]);
  if (ascentMeters > 0 || descentMeters > 0) big.push([String(Math.round(ascentMeters)), "m", "Emelkedés",
    descentMeters > 0 ? ` <em class="f-desc">· ${Math.round(descentMeters)} m ↓</em>` : ""]);
  $("v-sum").innerHTML = big.map(([v, u, l, extra = ""]) =>
    `<div class="cs-stat"><b>${v}${u ? `<small>${u}</small>` : ""}</b><span><span class="f-hint"${hintAttr(l)}>${l}</span>${extra}</span></div>`).join("");

  if (!isWorkout) { $("v-mini").innerHTML = ""; return; }
  // sáv (kalória, munka) és Átlag | Max táblázat
  const cell = (label, n, u, sub = "") => `<div class="f-mini-cell"><span class="f-mini-l"${hintAttr(label)}>${label}</span>`
    + `<span class="f-mini-v"><b>${n}</b>${u ? `<small>${u}</small>` : ""}</span>${sub ? `<span class="f-mini-s">${sub}</span>` : ""}</div>`;
  const band = (meta.calories ? cell("Kalória", String(Math.round(meta.calories)), "kcal") : "")
    + (meta.kilojoules ? cell("Munka", String(Math.round(meta.kilojoules)), "kJ") : "");
  const vals = (k, min = 0) => geometry.map((p) => p[k]).filter((v) => v != null && Number.isFinite(v) && v > min);
  const avgOf = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const v = (n, u) => `${n}<small>${u}</small>`;
  const rows = [];
  const row = (label, a, m) => rows.push(`<div class="f-tbl-row"><span><span class="f-hint"${hintAttr(label)}>${label}</span></span><span>${a || ""}</span><span>${m || ""}</span></div>`);
  if (avgSpeed) row("Sebesség", v(fmt(avgSpeed, 1), "km/h"), speeds.length ? v(fmt(Math.max(...speeds), 1), "km/h") : "");
  const hr = vals("hr");
  if (hr.length) row("Pulzus", v(Math.round(avgOf(hr)), "bpm"), v(Math.max(...hr), "bpm"));
  const cad = vals("cad");
  if (cad.length) row("Kadencia", v(Math.round(avgOf(cad)), "rpm"), v(Math.max(...cad), "rpm"));
  const pw = vals("power", -1);
  if (pw.length) row("Teljesítmény", v(Math.round(avgOf(pw)), "W"), v(Math.round(Math.max(...pw, Number(meta.maxPower) || 0)), "W"));
  const temps = geometry.map((p) => p.temp).filter((t) => t != null && Number.isFinite(t));
  if (temps.length >= 5) row("Hőmérséklet", v(fmt(avgOf(temps), 0), "°C"));
  else if (meta.avgTemp != null) row("Hőmérséklet", (meta.tempSource === "weather" ? "≈ " : "") + v(fmt(meta.avgTemp, 0), "°C"));
  if (movingMs && totalMs && Math.round(totalMs / 60000) > Math.round(movingMs / 60000)) row("Teljes idő", durS(totalMs));
  $("v-mini").innerHTML = (band ? `<div class="f-band">${band}</div>` : "")
    + (rows.length ? `<div class="f-tbl"><div class="f-tbl-row f-tbl-head"><span></span><span>Átlag</span><span>Max</span></div>${rows.join("")}</div>` : "");
}

// ── Elemzés-kártyák és szakasz-kijelölés (az app moduljaival) ─────────────────
let _range = null, _rangeLayer = null;

function distAtTime(t) {
  const g = _geometry;
  let lo = 0, hi = g.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if ((g[m].time ?? -Infinity) < t) lo = m + 1; else hi = m; }
  return _geoDists[lo];
}

function setRange(range, { fromChart = false, fit = false } = {}) {
  _range = range && range.d1 > range.d0 ? range : null;
  if (!fromChart) for (const c of _charts) c.inst?.setSelection(_range);
  const bar = $("v-range");
  if (_rangeLayer) { _rangeLayer.remove(); _rangeLayer = null; }
  if (!_range) {
    clearClimbHighlight(); clearBestHighlight(); clearWindHighlight(); clearSplitsHighlight();
    renderRangeBar(bar, null);
    return;
  }
  const st = computeRangeStats(_geometry, _range.d0, _range.d1, { dists: _geoDists });
  if (!st) { renderRangeBar(bar, null); return; }
  // a kijelöléshez a grafikonpanel is látsszon
  if (!_charts.some((c) => c.on) && _charts[0]) { _charts[0].on = true; _charts[0].el.hidden = false; updateChartsPanel(); redrawAll(); _charts[0].inst?.setSelection(_range); }
  const ll = _geometry.slice(st.i0, st.i1 + 1).filter((p) => Number.isFinite(p.lat)).map((p) => [p.lat, p.lng]);
  if (_map && ll.length > 1) {
    _rangeLayer = L.polyline(ll, { color: NAVY, weight: 8, opacity: 0.9, lineCap: "round", interactive: false }).addTo(_map);
    if (fit) _map.fitBounds(_rangeLayer.getBounds(), { padding: [40, 40], maxZoom: 16 });
  }
  renderRangeBar(bar, st, {
    onClose: () => setRange(null),
    onZoom: () => _rangeLayer && _map.fitBounds(_rangeLayer.getBounds(), { padding: [40, 40], maxZoom: 16 }),
  });
}

function initAnalysis(meta, geometry, id) {
  const hide = new Set(meta.hide || []);
  const isWorkout = meta.kind === "workout";
  // a modulok az app könyvtár-bejegyzését várják – a nyilvános adatokból egy „egyelemű könyvtár”
  const entry = { id, type: isWorkout ? "workout" : (meta.type || "cycling"), sport_type: meta.type || "cycling",
                  wind: meta.wind || null, has_fit: false, include_in_stats: true };
  const lib = { workouts: isWorkout ? [entry] : [], routes: isWorkout ? [] : [entry] };
  const api = {   // a nézőoldal nem ír és nem lát más edzést: üres rekordlista, mentés nincs
    getRecords: async () => ({ items: [], pending: 0 }),
    updateRoute: async () => ({}),
    loadRouteFit: async () => { throw new Error("nincs FIT"); },
  };
  const common = { api, publicView: true, getGeometry: () => geometry, getRouteId: () => id, getLibraryData: () => lib,
                   getRiderKg: () => null, onPick: (r) => setRange(r, { fit: true }) };
  if (!hide.has("cards")) {
    initClimbs(common);
    // pedálozás: kadencia–watt negyedek (az FTP helyett az átlagwattal osztva – a néző nem látja a tulajdonosét)
    if (isWorkout) { initBestEfforts(common); initSplits(common); initPedaling({ ...common, getFtp: () => null, parseFit: null }); }
  }
  if (isWorkout && !hide.has("wind")) {
    document.addEventListener("bringaterv:workoutWind", () => setTimeout(syncWindChart, 0));
    initWorkoutWind({ ...common, onPickTimes: (t0, t1) => setRange({ d0: distAtTime(t0), d1: distAtTime(t1) }, { fit: true }) });
  }
}

// Szél: grafikon („Szél hatása”, km/h a haladás irányában) és térképszínezés (hát- / oldal- / szembeszél)
function windRunAt(w) {
  let k = 0;
  return (p) => {
    if (p.time == null) return null;
    while (k < w.runs.length - 1 && p.time > w.runs[k].t1) k++;
    return w.runs[k];
  };
}
function syncWindChart() {
  const w = getWorkoutWind();
  if (!w?.runs?.length || _charts.some((c) => c.cfg.key === "ww")) return;
  const at = windRunAt(w);
  const data = _geometry.map((p, i) => { const r = at(p); return r ? { dist: _geoDists[i], value: Math.round(r.along * 10) / 10, mode: r.mode } : null; })
    .filter(Boolean);
  if (data.length < 2) return;
  addChart({ cfg: WIND_CHART, data, on: (loadChartPrefs() || new Set()).has("ww") });
  applyChartColors();
}

// ── Szintprofil ──────────────────────────────────────────────────────────────

// A színek az app grafikonjainak alapszínei – a nézőoldal ugyanúgy néz ki, mint az Elemzés fül
const CHARTS = [
  { key: "elev",  label: "Szintprofil",  unit: "m",    color: "#e8461e", build: buildElevationData, fromZero: false, dec: 0, def: true },
  { key: "speed", label: "Sebesség",     unit: "km/h", color: "#3B82F6", build: buildSpeedData,     fromZero: true,  dec: 1, def: true },
  { key: "hr",    label: "Pulzus",       unit: "bpm",  color: "#EF4444", build: buildHrData,        fromZero: false, dec: 0, def: true },
  { key: "cad",   label: "Kadencia",     unit: "rpm",  color: "#A855F7", build: buildCadData,       fromZero: true,  dec: 0, def: true },
  { key: "power", label: "Teljesítmény", unit: "W",    color: "#EAB308", build: buildPowerData,     fromZero: true,  dec: 0, def: true },
];

/** A grafikon fejlécének kulcsszámai (ugyanaz a stílus, mint az appban). */
function chartStatsHtml(cfg, data) {
  const vals = data.map((d) => d.value);
  const stat = (v, u, l) => `<div class="cs-stat"><b>${v}<small>${u}</small></b><span>${l}</span></div>`;
  if (cfg.key === "elev") return stat(Math.round(Math.max(...vals)), "m", "Legmagasabb") + stat(Math.round(Math.min(...vals)), "m", "Legalacsonyabb");
  if (cfg.key === "ww") {
    const st = getWorkoutWind()?.stats;
    return st ? stat(`${st.alongAvg >= 0 ? "+" : "−"}${fmt(Math.abs(st.alongAvg), 1)}`, "km/h", "Átlagos hatás")
      + stat(fmt(st.speedAvg, 0), "km/h", "Szélsebesség") : "";
  }
  const pos = cfg.key === "speed" ? vals.filter((v) => v > 1 && v < 120) : cfg.key === "cad" ? vals.filter((v) => v > 0) : vals;
  const a = pos.length ? pos.reduce((x, y) => x + y, 0) / pos.length : 0;
  return stat(fmt(a, cfg.dec), cfg.unit, "Átlag") + stat(fmt(Math.max(...pos, 0), cfg.dec), cfg.unit, "Maximum");
}
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

// Szél hatása: a haladás irányú szélösszetevő (km/h) – a „Szél az edzés alatt” adatából
const WIND_CHART = { key: "ww", label: "Szél", unit: "km/h", color: "#22C55E", fromZero: false, dec: 1, def: false };

// Grafikonok: ki-be kapcsolható, szinkronizált hover + térképjelölő (mint az elemzőben)
function renderCharts(geometry) {
  _geoDists = trackDists(geometry);
  _geometry = geometry;
  const prefs = loadChartPrefs();
  const list = CHARTS.map((cfg) => {
    const data = (cfg.build(geometry) || []).filter((d) => d.value != null && Number.isFinite(d.value));
    return { cfg, data, on: prefs ? prefs.has(cfg.key) : cfg.def };
  }).filter((c) => c.data.length >= 2);
  if (!list.length) return;
  // Ha az elmentett preferencia mindent elrejtene, mutassuk legalább az elsőt
  if (!list.some((c) => c.on)) list[0].on = true;
  $("v-toggle-wrap").hidden = false;
  for (const ch of list) addChart(ch);
  updateChartsPanel();

  applyChartColors();
  // onclick (nem addEventListener): a grafikonok újrarajzolásakor se duplázódjon
  $("v-charts").onclick = (e) => {
    if (!e.target.closest("[data-view-chart-mode]")) return;
    _chartZones = !_chartZones;
    try { localStorage.setItem(CHART_ZONES_KEY, _chartZones ? "1" : "0"); } catch (_) {}
    applyChartColors();
  };
  redrawAll();
  let t = null;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(redrawAll, 120); });
}

function addChart(ch) {
  _charts.push(ch);
  const toggles = $("v-chart-toggles"), host = $("v-charts");
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
    if (ch.on) requestAnimationFrame(() => { ch.inst?.resize(); if (_range) ch.inst?.setSelection(_range); });
  });
  row.querySelector("input[data-color-key]")?.addEventListener("change", (e) => {
    setColorMode(e.target.checked ? ch.cfg.key : null);
  });
  toggles.appendChild(row);

  const sec = document.createElement("div");
  sec.className = "v-chart";
  sec.hidden = !ch.on;
  sec.innerHTML = `<div class="chart-section-header v-chart-header"><span class="chart-section-title">${ch.cfg.label}</span>`
    + `<div class="chart-stats">${chartStatsHtml(ch.cfg, ch.data)}</div>`
    + `<div class="chart-head-actions">${ch.cfg.key === "ww" ? "" : `<button type="button" class="chart-mode-btn" data-view-chart-mode title="Váltás egyszínű és zóna szerinti színezés között"></button>`}</div></div>`
    + `<div class="v-chart-body"><canvas></canvas></div><div class="chart-legend" hidden></div>`;
  host.appendChild(sec);
  ch.el = sec;
  // Közös rajzoló (mint az appban): szinkronizált rámutatás, címke, A / B jelölő, kijelölés húzással
  ch.inst = initElevationChart(sec.querySelector("canvas"), {
    onHover: (pt, _o, src) => {
      for (const c of _charts) if (c.inst && c.inst !== src) c.inst.setHoverByDist(pt.dist);
      moveHoverMarker(pt.dist);
    },
    onLeave: () => {
      for (const c of _charts) c.inst?.clearHover();
      moveHoverMarker(null);
    },
    onSelect: (sel, src, done) => {
      for (const c of _charts) if (c.inst && c.inst !== src) c.inst.setSelection(sel);
      if (done || sel) setRange(sel, { fromChart: true });
    },
  });
}

// Egyszínű (szürke, alapértelmezés) vagy zóna szerinti színezés – a fejléc végén váltható.
// A néző nem látja a tulajdonos zónáit: a sávok az edzés saját eloszlásából
// (ötödök) jönnek, a szintprofil lejtés szerint színez – mint a térképszínezés.
const CHART_ZONES_KEY = "bringaterv-view-chart-zones";
let _chartZones = (() => { try { return localStorage.getItem(CHART_ZONES_KEY) === "1"; } catch (_) { return false; } })();

function chartZoneSpec(cfg, data) {
  if (cfg.key === "elev") {
    const labels = ["lejtő > 4%", "enyhe lejtő", "sík", "enyhe emelkedő", "emelkedő", "meredek > 8%"];
    return {
      colorFn: (_v, pt) => (pt?.grade == null ? "#9CA3AF" : GRADE_COLORS[bandIndex(pt.grade, GRADE_EDGES)]),
      legend: GRADE_COLORS.map((c, i) => [c, labels[i]]),
    };
  }
  const edges = quantileEdges(data.map((d) => (d.value > 0 ? d.value : null)));
  const r = (v) => fmt(v, cfg.dec);
  const labels = [`< ${r(edges[0])}`, ...edges.slice(0, 3).map((e, i) => `${r(e)}–${r(edges[i + 1])}`), `${r(edges[3])} +`];
  return {
    colorFn: (v) => BAND_COLORS[bandIndex(v, edges)],
    legend: BAND_COLORS.map((c, i) => [c, `${labels[i]}${i === 4 ? " " + cfg.unit : ""}`]),
  };
}

function applyChartColors() {
  for (const ch of _charts) {
    const { cfg, data } = ch;
    const spec = cfg.key === "ww"
      ? { colorFn: (_v, pt) => WIND_COLORS[pt?.mode] || "#9CA3AF", legend: ["tail", "cross", "head"].map((m) => [WIND_COLORS[m], WIND_LABELS[m]]) }
      : _chartZones ? chartZoneSpec(cfg, data) : null;
    ch.inst.setData(data, {
      color: CHART_SOLID_GRAY, colorFn: spec?.colorFn || null,
      unit: cfg.unit, zeroBase: cfg.fromZero, minRange: cfg.key === "elev" ? 20 : 0,
      formatTip: (pt) => [cfg.key === "ww"
        ? `${fmt(pt.dist / 1000, 1)} km · ${WIND_LABELS[pt.mode] || ""} ${pt.value >= 0 ? "+" : "−"}${fmt(Math.abs(pt.value), 1)} km/h`
        : `${fmt(pt.dist / 1000, 1)} km · ${fmt(pt.value, cfg.dec)} ${cfg.unit}`],
    });
    ch.inst.setMarkers([{ dist: 0, label: "A", color: "#16a34a" }, { dist: data[data.length - 1].dist, label: "B", color: "#1a1d23" }]);
    const btn = ch.el.querySelector("[data-view-chart-mode]");
    if (btn) btn.textContent = _chartZones ? "Zónaszín" : "Egyszínű";
    btn?.classList.toggle("is-zones", _chartZones);
    const lg = ch.el.querySelector(".chart-legend");
    lg.hidden = !spec;
    lg.innerHTML = spec ? spec.legend.map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join("") : "";
  }
}

let _hoverDist = null, _geometry = [], _geoDists = [];

// A grafikon-panel csak akkor látszik, ha van bekapcsolt grafikon; a térkép
// mérete ehhez igazodik.
function updateChartsPanel() {
  $("v-charts-wrap").hidden = !_charts.some((c) => c.on);
  $("v-resize").hidden = $("v-charts-wrap").hidden;
  if (_map) setTimeout(() => _map.invalidateSize(), 0);
}

function redrawAll() {
  for (const ch of _charts) if (ch.on) ch.inst?.resize();
}

/** A térképen mozgó pont a grafikonon rámutatott távolsághoz. */
function moveHoverMarker(dist) {
  _hoverDist = dist;
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
  if (key === "ww") return !!getWorkoutWind();
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
  if (key === "ww") return colorByWind();

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

/** Térkép: hátszél zöld, oldalszél sárga, szembeszél piros – a szél futamai szerint. */
function colorByWind() {
  const w = getWorkoutWind();
  if (!w?.runs?.length) return;
  const at = windRunAt(w);
  const g = _geometry.filter((p) => Number.isFinite(p.lat));
  _colorLayer = L.layerGroup().addTo(_map);
  let start = 0, mode = at(g[0])?.mode;
  for (let i = 1; i <= g.length; i++) {
    const m = i < g.length ? at(g[i])?.mode : null;
    if (i === g.length || m !== mode) {
      L.polyline(g.slice(Math.max(0, start - 1), i).map((p) => [p.lat, p.lng]),
        { color: WIND_COLORS[mode] || "#9CA3AF", weight: 5, opacity: 0.95, lineCap: "round", interactive: false }).addTo(_colorLayer);
      start = i; mode = m;
    }
  }
  _baseLine?.setStyle({ opacity: 0 });
  _colorLegend = L.control({ position: "bottomleft" });
  _colorLegend.onAdd = () => {
    const d = L.DomUtil.create("div", "map-legend");
    d.innerHTML = `<div class="map-legend-title">Szél</div>` + ["tail", "cross", "head"].map((m) =>
      `<div class="map-legend-row"><span style="background:${WIND_COLORS[m]}"></span>${WIND_LABELS[m]} ${Math.round(w.stats[m + "Pct"])}%</div>`).join("");
    return d;
  };
  _colorLegend.addTo(_map);
}

// ── Grafikonpanel átméretezése a térkép alatti fogantyúval (asztali nézet) ────
(function initChartsResize() {
  const grip = $("v-resize"), wrap = $("v-charts-wrap");
  if (!grip || !wrap) return;
  const KEY = "bringaterv-view-charts-h";
  const apply = (h) => {
    const main = wrap.parentElement.clientHeight || innerHeight;
    wrap.style.maxHeight = Math.max(120, Math.min(h, main - 220)) + "px";
    if (_map) _map.invalidateSize();
    redrawAll();
  };
  try { const saved = Number(localStorage.getItem(KEY)); if (saved) wrap.style.maxHeight = saved + "px"; } catch (_) {}
  let startY = 0, startH = 0;
  const move = (e) => apply(startH + (startY - e.clientY));
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.body.classList.remove("is-resizing");
    try { localStorage.setItem(KEY, String(parseInt(wrap.style.maxHeight, 10) || "")); } catch (_) {}
  };
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startY = e.clientY; startH = wrap.offsetHeight;
    document.body.classList.add("is-resizing");
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
  grip.addEventListener("dblclick", () => {
    wrap.style.maxHeight = "";
    try { localStorage.removeItem(KEY); } catch (_) {}
    if (_map) _map.invalidateSize();
    redrawAll();
  });
})();
