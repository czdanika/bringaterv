/**
 * Bringaterv – Útvonal PDF export
 * ================================
 * Nyomtatható útvonallap (A4 álló vagy fekvő): fejléc, valódi térkép a route-tal,
 * stat-sor, szintprofil, burkolat-bontás, waypont-lista, megjegyzés és QR-kód.
 *
 * A térképet magunk rakjuk össze Web-Mercator vetítéssel (mint a Leaflet), hogy
 * pontos és éles legyen nyomtatva is. A csempeszolgáltatók (OSM, Esri) CORS-barátak.
 *
 * Beállítások (exportRoutePdf opts):
 *   mapStyle:    "standard" | "light" | "topo" | "terrain" | "satellite"
 *   orientation: "portrait" | "landscape"
 *   includeQr / includeElevation / includeSurface / includeWaypoints : boolean
 *   note:        szabad szöveg (megjegyzés)
 *   waypoints:   [{ name?, lat, lng }]
 *   preview:     true → datauri-t ad vissza (nem tölt le)
 */

import { analyzeSurface, MODE_LABELS } from "../map/surfaceAnalysis.js";
import { SEGMENT_COLORS, getTileLayerDef } from "../map/mapAdapter.js";
import { buildElevationData, buildSpeedData, buildHrData, buildCadData, buildPowerData } from "./elevationProfile.js";

const NAVY = "#2d4a5a";
const ACCENT = "#e8461e";
const INK = "#1f2a30";
const MUTED = "#7a8891";
const TILE = 256;

// Térképstílusok: ugyanazok a csempe-definíciók, mint az appban (mapAdapter).
// A „veil" enyhe fehér fátyol a részletgazdag rétegeken, hogy a route kiemelkedjen.
const VEIL = { standard: 0.12, cycling: 0.1, topo: 0.08 };
function tileDefFor(style) {
  const d = getTileLayerDef(style);
  const opts = d.options || {};
  return {
    url: d.url,
    subdomains: d.url.includes("{s}") ? (opts.subdomains ? [...opts.subdomains] : ["a", "b", "c"]) : [],
    maxZoom: Math.min(opts.maxNativeZoom || opts.maxZoom || 18, 18),
    overlay: d.overlay?.url || null,
    veil: VEIL[style] || 0,
    filter: d.filter || null,
  };
}

// ── CDN lazy-load ──────────────────────────────────────────────────────────

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src === src)) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Nem sikerült betölteni: ${src}`));
    document.head.appendChild(el);
  });
}

async function ensureJsPDF() {
  if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
  await loadScriptOnce("https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js");
  if (!window.jspdf?.jsPDF) throw new Error("jsPDF nem elérhető.");
  return window.jspdf.jsPDF;
}

export async function ensureQR() {
  if (window.qrcode) return window.qrcode;
  await loadScriptOnce("https://unpkg.com/qrcode-generator@1.4.4/qrcode.js");
  if (!window.qrcode) throw new Error("QR könyvtár nem elérhető.");
  return window.qrcode;
}

// ── Beágyazott Unicode betűtípus (magyar ő/ű miatt) ──────────────────────────
// A jsPDF beépített Helvetica csak WinAnsi-t tud (nincs ő/ű), ezért Robotót
// ágyazunk be. A base64-et egyszer töltjük/konvertáljuk, és minden PDF-be
// újraregisztráljuk (a font a jsPDF dokumentumhoz kötött).
const FONT = "Roboto";
let _fontCache = null;

function bufToBase64(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function loadFonts() {
  if (_fontCache) return _fontCache;
  const [reg, bold] = await Promise.all([
    fetch("/src/assets/fonts/Roboto-Regular.ttf").then((r) => r.arrayBuffer()),
    fetch("/src/assets/fonts/Roboto-Bold.ttf").then((r) => r.arrayBuffer()),
  ]);
  _fontCache = { regular: bufToBase64(reg), bold: bufToBase64(bold) };
  return _fontCache;
}

function registerFonts(pdf, fonts) {
  pdf.addFileToVFS("Roboto-Regular.ttf", fonts.regular);
  pdf.addFont("Roboto-Regular.ttf", FONT, "normal");
  pdf.addFileToVFS("Roboto-Bold.ttf", fonts.bold);
  pdf.addFont("Roboto-Bold.ttf", FONT, "bold");
}

// ── Mercator vetítés / segédek ───────────────────────────────────────────────

function project(lat, lng, z) {
  const sin = Math.sin((lat * Math.PI) / 180);
  const scale = TILE * Math.pow(2, z);
  return {
    x: scale * (0.5 + lng / 360),
    y: scale * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)),
  };
}

function loadImage(src, { crossOrigin = "anonymous" } = {}) {
  return new Promise((resolve) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function haversine(a, b) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

// ── Térkép-canvas összerakása csempékből ───────────────────────────────────

async function buildMapCanvas(points, style, { width, height, pad = 44, routeColor = ACCENT, includeKm = true } = {}) {
  const def = tileDefFor(style);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#e8eef0";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const valid = (points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (valid.length === 0) return canvas;

  const lats = valid.map((p) => p.lat), lngs = valid.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);

  let z = def.maxZoom;
  for (; z > 1; z--) {
    const a = project(maxLat, minLng, z), b = project(minLat, maxLng, z);
    if (Math.abs(b.x - a.x) <= canvas.width - 2 * pad && Math.abs(b.y - a.y) <= canvas.height - 2 * pad) break;
  }

  const center = project((minLat + maxLat) / 2, (minLng + maxLng) / 2, z);
  const originX = center.x - canvas.width / 2;
  const originY = center.y - canvas.height / 2;
  const nTiles = Math.pow(2, z);
  const x0 = Math.floor(originX / TILE), x1 = Math.floor((originX + canvas.width) / TILE);
  const y0 = Math.floor(originY / TILE), y1 = Math.floor((originY + canvas.height) / TILE);

  const tileUrl = (tmpl, tx, ty) => {
    const wx = ((tx % nTiles) + nTiles) % nTiles;
    const sub = def.subdomains.length ? def.subdomains[Math.abs(tx + ty) % def.subdomains.length] : "";
    return tmpl.replace("{s}", sub).replace("{z}", z).replace("{x}", wx).replace("{y}", ty);
  };

  const drawTiles = async (tmpl, filter = null) => {
    const jobs = [];
    for (let tx = x0; tx <= x1; tx++)
      for (let ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= nTiles) continue;
        const dx = tx * TILE - originX, dy = ty * TILE - originY;
        jobs.push(loadImage(tileUrl(tmpl, tx, ty)).then((img) => {
          if (!img) return;
          ctx.filter = filter || "none";
          ctx.drawImage(img, dx, dy, TILE, TILE);
          ctx.filter = "none";
        }));
      }
    await Promise.all(jobs);
  };

  await drawTiles(def.url, def.filter);
  if (def.overlay) await drawTiles(def.overlay);

  if (def.veil > 0) {
    ctx.fillStyle = `rgba(255,255,255,${def.veil})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const pts = valid.map((p) => {
    const w = project(p.lat, p.lng, z);
    return { x: w.x - originX, y: w.y - originY };
  });

  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 11;
  tracePath(ctx, pts); ctx.stroke();
  ctx.strokeStyle = routeColor; ctx.lineWidth = 6;
  tracePath(ctx, pts); ctx.stroke();

  if (includeKm) drawKmMarkers(ctx, valid, pts);

  dot(ctx, pts[0].x, pts[0].y, 11, "#16a34a", "#ffffff", 4);
  dot(ctx, pts[pts.length - 1].x, pts[pts.length - 1].y, 11, "#dc2626", "#ffffff", 4);
  return canvas;
}

function tracePath(ctx, pts) {
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
}

function dot(ctx, x, y, r, fill, border, bw) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
  if (border) { ctx.lineWidth = bw; ctx.strokeStyle = border; ctx.stroke(); }
}

function drawKmMarkers(ctx, geo, pts) {
  let acc = 0, nextKm = 5;
  for (let i = 1; i < geo.length; i++) {
    acc += haversine(geo[i - 1], geo[i]);
    while (acc / 1000 >= nextKm) {
      const p = pts[i];
      ctx.font = "700 15px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      dot(ctx, p.x, p.y, 13, "#ffffff", NAVY, 2.5);
      ctx.fillStyle = NAVY; ctx.fillText(String(nextKm), p.x, p.y + 1);
      nextKm += 5;
    }
  }
}

// ── Szintprofil canvas ───────────────────────────────────────────────────────

function buildElevationCanvas(elevData, opts = {}) {
  return buildProfileCanvas(elevData, { rgb: [5, 150, 105], ...opts });
}

// Sebesség: 0-tól induló tengely, kék szín
function buildSpeedCanvas(speedData, opts = {}) {
  return buildProfileCanvas(speedData, { rgb: [25, 118, 210], fromZero: true, ...opts });
}

// Általános távolság-alapú profil-grafikon (szint, sebesség, …)
function buildProfileCanvas(rawData, { width = 1600, height = 300, rgb = [232, 70, 30], fromZero = false } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  const data = (rawData || []).filter((d) => d.value != null && Number.isFinite(d.value));
  if (data.length < 2) return null;
  const [r, g, b] = rgb;
  // Fehér háttér → JPEG-ként ágyazható (a színátmenetes PNG nagyon nagy lenne)
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height);

  const padL = 56, padR = 16, padT = 16, padB = 34;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const dists = data.map((d) => d.dist), vals = data.map((d) => d.value);
  const dMin = Math.min(...dists), dMax = Math.max(...dists);
  let vMin = Math.min(...vals), vMax = Math.max(...vals);
  if (fromZero) {
    vMin = 0; vMax = vMax * 1.1 || 1;
  } else {
    if (vMax - vMin < 10) { vMax += 5; vMin -= 5; }
    const p = (vMax - vMin) * 0.12; vMin -= p; vMax += p;
  }
  const sx = (d) => padL + ((d - dMin) / (dMax - dMin || 1)) * plotW;
  const sy = (v) => padT + plotH - ((v - vMin) / (vMax - vMin || 1)) * plotH;

  ctx.strokeStyle = "rgba(0,0,0,0.08)"; ctx.lineWidth = 1;
  ctx.fillStyle = MUTED; ctx.font = "400 18px Inter, system-ui, sans-serif";
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let i = 0; i <= 3; i++) {
    const v = vMin + ((vMax - vMin) * i) / 3, y = sy(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(width - padR, y); ctx.stroke();
    ctx.fillText(`${Math.round(v)}`, padL - 10, y);
  }

  ctx.beginPath();
  ctx.moveTo(sx(data[0].dist), sy(data[0].value));
  for (const d of data) ctx.lineTo(sx(d.dist), sy(d.value));
  ctx.lineTo(sx(data[data.length - 1].dist), padT + plotH);
  ctx.lineTo(sx(data[0].dist), padT + plotH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.30)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0.02)`);
  ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath();
  data.forEach((d, i) => (i === 0 ? ctx.moveTo(sx(d.dist), sy(d.value)) : ctx.lineTo(sx(d.dist), sy(d.value))));
  ctx.strokeStyle = `rgb(${r},${g},${b})`; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.stroke();

  ctx.fillStyle = MUTED; ctx.textAlign = "center"; ctx.textBaseline = "top";
  const totalKm = dMax / 1000;
  const stepKm = totalKm > 60 ? 20 : totalKm > 20 ? 10 : totalKm > 8 ? 5 : 2;
  for (let km = 0; km <= totalKm + 0.001; km += stepKm) ctx.fillText(`${km}`, sx(km * 1000), padT + plotH + 8);
  ctx.textAlign = "left"; ctx.fillText("km", width - padR - 24, padT + plotH + 8);
  return canvas;
}

// ── Burkolat / QR ────────────────────────────────────────────────────────────

function surfaceBreakdown(segments) {
  const by = {}; let total = 0;
  for (const s of segments || []) { by[s.mode] = (by[s.mode] || 0) + (s.distanceKm || 0); total += s.distanceKm || 0; }
  if (total <= 0) return null;
  return ["asphalt", "gravel", "mtb", "hiking"]
    .filter((m) => by[m] > 0)
    .map((m) => ({ mode: m, km: by[m], pct: (by[m] / total) * 100 }));
}

export function buildQrCanvas(text, qrcode, { size = 320 } = {}) {
  const qr = qrcode(0, "M"); qr.addData(text); qr.make();
  const n = qr.getModuleCount();
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, size, size);
  const cell = size / n;
  ctx.fillStyle = NAVY;
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) ctx.fillRect(Math.floor(c * cell), Math.floor(r * cell), Math.ceil(cell), Math.ceil(cell));
  return canvas;
}

// ── PDF-blokkok (pdf, rect) → rajzol, visszaadja a felhasznált magasságot ────

function fmt(v, d = 1) {
  return Number(v || 0).toLocaleString("hu-HU", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function drawCells(pdf, x, y, w, cells, { cols, valSize, rh = 20 }) {
  const cw = w / cols;
  cells.forEach(([val, label], i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const cx = x + cw * col + cw / 2, cy = y + rh * row;
    pdf.setFont(FONT, "bold").setFontSize(valSize).setTextColor(...hexToRgb(NAVY));
    pdf.text(String(val), cx, cy + 7, { align: "center" });
    pdf.setFont(FONT, "normal").setFontSize(7.5).setTextColor(...hexToRgb(MUTED));
    pdf.text(label, cx, cy + 12.5, { align: "center" });
  });
  return rh * Math.ceil(cells.length / cols);
}

function drawStats(pdf, x, y, w, o) {
  const cells = [
    [fmt(o.distanceKm, 1), "KM · TÁV"],
    [`${Math.round(o.ascentM || 0)} m`, "EMELKEDÉS"],
    [o.durationText || "—", o.isWorkout ? "IDŐ" : "BECSÜLT IDŐ"],
    [o.avgSpeedKmh ? fmt(o.avgSpeedKmh, 1) : (o.descentM != null ? `${Math.round(o.descentM)} m` : "—"),
      o.avgSpeedKmh ? "KM/H ÁTLAG" : "SÜLLYEDÉS"],
  ];
  const narrow = w < 150;
  return drawCells(pdf, x, y, w, cells, { cols: narrow ? 2 : 4, valSize: narrow ? 15 : 17 });
}

// Edzés-adatok második sora (max seb., pulzus, kadencia, teljesítmény, kcal)
function drawExtraStats(pdf, x, y, w, extra) {
  const narrow = w < 150;
  const cols = narrow ? 3 : Math.min(extra.length, 6);
  pdf.setDrawColor(228, 232, 234); pdf.setLineWidth(0.3);
  pdf.line(x, y - 2, x + w, y - 2);
  return drawCells(pdf, x, y, w, extra, { cols, valSize: narrow ? 12 : 14, rh: 18 });
}

function drawTitleRow(pdf, x, y, w, label) {
  pdf.setFont(FONT, "bold").setFontSize(9).setTextColor(...hexToRgb(INK));
  pdf.text(label, x, y);
  return 2.5;
}

function drawSurface(pdf, x, y, w, surface) {
  let used = drawTitleRow(pdf, x, y, w, "Burkolat");
  let yy = y + used + 0.5;
  const barH = 6; let bx = x;
  surface.forEach((seg) => {
    const sw = (seg.pct / 100) * w;
    pdf.setFillColor(...hexToRgb(SEGMENT_COLORS[seg.mode] || "#888888"));
    pdf.rect(bx, yy, sw, barH, "F"); bx += sw;
  });
  yy += barH + 4;
  pdf.setFontSize(8);
  let lx = x;
  surface.forEach((seg) => {
    pdf.setFillColor(...hexToRgb(SEGMENT_COLORS[seg.mode] || "#888888"));
    pdf.rect(lx, yy - 2.6, 3, 3, "F");
    const t = `${MODE_LABELS[seg.mode] || seg.mode} ${Math.round(seg.pct)}% · ${fmt(seg.km, 1)} km`;
    pdf.setFont(FONT, "normal").setTextColor(...hexToRgb(INK));
    pdf.text(t, lx + 4.5, yy);
    lx += pdf.getTextWidth(t) + 9;
    if (lx > x + w - 20) { lx = x; yy += 5; }
  });
  return yy + 4 - y;
}

function drawWaypoints(pdf, x, y, w, waypoints, maxRows = 12) {
  let used = drawTitleRow(pdf, x, y, w, "Pontok");
  let yy = y + used + 2;
  const list = waypoints.slice(0, maxRows);
  pdf.setFontSize(8.5);
  list.forEach((wp, i) => {
    const isFirst = i === 0, isLast = i === waypoints.length - 1 && list.length === waypoints.length;
    const col = isFirst ? "#16a34a" : isLast ? "#dc2626" : NAVY;
    pdf.setFillColor(...hexToRgb(col));
    pdf.circle(x + 1.3, yy, 1.3, "F");
    const name = wp.name || (isFirst ? "Start" : isLast ? "Cél" : `Pont ${i + 1}`);
    pdf.setFont(FONT, "normal").setFontSize(8.5).setTextColor(...hexToRgb(INK));
    pdf.text(pdf.splitTextToSize(name, w - 8)[0], x + 5, yy, { baseline: "middle" });
    yy += 5;
  });
  if (waypoints.length > maxRows) {
    pdf.setFont(FONT, "normal").setTextColor(...hexToRgb(MUTED));
    pdf.text(`+${waypoints.length - maxRows} tovabbi pont`, x + 7, yy, { baseline: "middle" });
    yy += 5;
  }
  return yy - y;
}

function drawNote(pdf, x, y, w, note) {
  let used = drawTitleRow(pdf, x, y, w, "Megjegyzés");
  let yy = y + used + 2;
  pdf.setFont(FONT, "normal").setFontSize(9).setTextColor(...hexToRgb(INK));
  const lines = pdf.splitTextToSize(note, w - 2);
  const shown = lines.slice(0, 8);
  pdf.text(shown, x, yy, { baseline: "top", lineHeightFactor: 1.35 });
  yy += shown.length * 9 * 0.35 + 3;
  return yy - y;
}

// ── Fő export ────────────────────────────────────────────────────────────────

export async function exportRoutePdf(o) {
  const onProgress = o.onProgress || (() => {});
  const geometry = o.geometry?.length ? o.geometry : o.points || [];
  const points = o.points?.length ? o.points : geometry;
  const landscape = o.orientation === "landscape";
  const mapStyle = o.mapStyle || "standard";
  const incQr = o.includeQr !== false;
  const incElev = o.includeElevation !== false;
  const incSpeed = o.includeSpeed !== false;
  const incHr = o.includeHr !== false;
  const incCad = o.includeCadence !== false;
  const incPower = o.includePower === true;
  const hasData = (arr) => arr.some((d) => d.value != null);
  const incSurface = o.includeSurface !== false;
  const incWp = o.includeWaypoints === true && Array.isArray(o.waypoints) && o.waypoints.length >= 2;
  const note = (o.note || "").trim();

  onProgress("Könyvtárak betöltése…");
  const [jsPDF, qrcode, fonts] = await Promise.all([
    ensureJsPDF(),
    incQr ? ensureQR().catch(() => null) : Promise.resolve(null),
    loadFonts().catch(() => null),
  ]);

  // ── Oldalméret + fő rects ──
  const PW = landscape ? 297 : 210, PH = landscape ? 210 : 297, M = 12;
  const CW = PW - 2 * M;
  const headerH = 20;
  const footerTopY = PH - 14;
  const bodyTop = M + headerH + 5;

  // Térkép doboz méret (mm) – ehhez igazítjuk a canvas aspect-et
  // Hány grafikon lesz? (a térkép méretezéséhez kell előre)
  const nCharts = [
    incElev && hasData(buildElevationData(geometry)), incSpeed && hasData(buildSpeedData(geometry)),
    incHr && hasData(buildHrData(geometry)), incCad && hasData(buildCadData(geometry)),
    incPower && hasData(buildPowerData(geometry)),
  ].filter(Boolean).length;
  const CHART_GAP = 6;
  const chartGeom = (w, cols, maxH) => {
    const cw = (w - CHART_GAP * (cols - 1)) / cols;
    const eh = Math.min(cw * 300 / 1600, maxH);
    return { cw, eh, rowH: 2.5 + eh + 5, rows: Math.ceil(nCharts / cols) };
  };

  let mapBox, rightX, rightW, colY, landCharts = null;
  if (landscape) {
    rightW = 92; const gap = 6;
    const leftW = CW - rightW - gap;
    const fullH = footerTopY - bodyTop - 2;
    // Fekvő: a grafikonok a térkép alá kerülnek (2 oszlop), a jobb oszlop a statoké
    if (nCharts) {
      const g = chartGeom(leftW, nCharts >= 2 ? 2 : 1, 22);
      landCharts = { cols: nCharts >= 2 ? 2 : 1, h: g.rows * g.rowH };
    }
    mapBox = { x: M, y: bodyTop, w: leftW, h: fullH - (landCharts ? landCharts.h + 3 : 0) };
    rightX = M + mapBox.w + gap; rightW = CW - mapBox.w - gap; colY = bodyTop;
  } else {
    // álló: a térkép magassága csökken, ha sok extra blokk van
    const chartRows = nCharts >= 3 ? Math.ceil(nCharts / 2) : nCharts;
    const extras = chartRows + (incSurface ? 1 : 0) + (incWp ? 1 : 0) + (note ? 1 : 0)
      + (o.extraStats?.length ? 2 : 0);
    const mapH = Math.max(80, 118 - extras * 9);
    mapBox = { x: M, y: bodyTop, w: CW, h: mapH };
  }

  onProgress("Térkép összeállítása…");
  const mapCanvas = await buildMapCanvas(points, mapStyle, {
    width: mapBox.w * 8, height: mapBox.h * 8, routeColor: ACCENT,
  });

  const elevData = incElev ? buildElevationData(geometry) : [];
  const elevCanvas = elevData.length ? buildElevationCanvas(elevData) : null;
  const speedData = incSpeed ? buildSpeedData(geometry) : [];
  const speedCanvas = speedData.length ? buildSpeedCanvas(speedData) : null;
  const hrData = incHr ? buildHrData(geometry) : [];
  const hrCanvas = hasData(hrData) ? buildProfileCanvas(hrData, { rgb: [220, 38, 38] }) : null;
  const cadData = incCad ? buildCadData(geometry) : [];
  const cadCanvas = hasData(cadData) ? buildProfileCanvas(cadData, { rgb: [147, 51, 234], fromZero: true }) : null;
  const powData = incPower ? buildPowerData(geometry) : [];
  const powCanvas = hasData(powData) ? buildProfileCanvas(powData, { rgb: [217, 119, 6], fromZero: true }) : null;

  let surface = null;
  if (incSurface && geometry.length >= 2) {
    onProgress("Burkolat elemzése…");
    try { const { segments } = await withTimeout(analyzeSurface(geometry), 12000); surface = surfaceBreakdown(segments); }
    catch (_) { /* best-effort */ }
  }

  const qrCanvas = (qrcode && o.shareUrl) ? buildQrCanvas(o.shareUrl, qrcode) : null;
  const logo = await loadImage("/src/assets/logo.png", { crossOrigin: null });

  onProgress("PDF generálása…");
  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: landscape ? "landscape" : "portrait" });
  if (fonts) { try { registerFonts(pdf, fonts); } catch (_) {} }

  // ── Fejléc ──
  const logoR = 7, hy = M;
  if (logo) {
    pdf.setFillColor(...hexToRgb(NAVY));
    pdf.circle(M + logoR, hy + logoR, logoR, "F");
    try { pdf.addImage(logo, "PNG", M + 0.6, hy + 0.6, logoR * 2 - 1.2, logoR * 2 - 1.2); } catch (_) {}
  }
  const tx = M + logoR * 2 + 4;
  pdf.setFont(FONT, "bold").setFontSize(20).setTextColor(...hexToRgb(NAVY));
  pdf.text("Bringa", tx, hy + 6);
  const bw = pdf.getTextWidth("Bringa");
  pdf.setTextColor(...hexToRgb(ACCENT)); pdf.text("terv", tx + bw, hy + 6);
  pdf.setFont(FONT, "normal").setFontSize(8.5).setTextColor(...hexToRgb(MUTED));
  pdf.text("Tervezz · Tekerj · Fedezd fel!", tx, hy + 11);

  pdf.setFont(FONT, "bold").setFontSize(13).setTextColor(...hexToRgb(INK));
  const name = pdf.splitTextToSize(o.title || "Útvonalterv", CW - (tx - M) - 2)[0];
  pdf.text(name, PW - M, hy + 5, { align: "right" });
  if (o.date) {
    pdf.setFont(FONT, "normal").setFontSize(9).setTextColor(...hexToRgb(MUTED));
    pdf.text(o.date, PW - M, hy + 10.5, { align: "right" });
  }
  pdf.setDrawColor(...hexToRgb(NAVY)); pdf.setLineWidth(0.6);
  pdf.line(M, M + headerH, PW - M, M + headerH);

  // ── Térkép ──
  pdf.setFillColor(230, 234, 236);
  pdf.roundedRect(mapBox.x, mapBox.y, mapBox.w, mapBox.h, 2, 2, "F");
  try { pdf.addImage(mapCanvas.toDataURL("image/jpeg", 0.85), "JPEG", mapBox.x, mapBox.y, mapBox.w, mapBox.h); } catch (_) {}
  pdf.setDrawColor(210, 216, 220); pdf.setLineWidth(0.3);
  pdf.roundedRect(mapBox.x, mapBox.y, mapBox.w, mapBox.h, 2, 2, "S");

  // ── Blokkok ──
  const charts = [[elevCanvas, "Szintprofil (m)"], [speedCanvas, "Sebesség (km/h)"], [hrCanvas, "Pulzus (bpm)"],
    [cadCanvas, "Kadencia (rpm)"], [powCanvas, "Teljesítmény (W)"]].filter(([c]) => c);

  // Grafikonok rácsban: cols oszlop, soronként cím + kép
  const drawChartsGrid = (x, y, w, cols, maxH) => {
    const cw = (w - CHART_GAP * (cols - 1)) / cols;
    let yy = y;
    for (let i = 0; i < charts.length; i += cols) {
      let rowH = 0;
      charts.slice(i, i + cols).forEach(([cv, label], j) => {
        const cx = x + j * (cw + CHART_GAP);
        drawTitleRow(pdf, cx, yy, cw, label);
        const eh = Math.min((cw * cv.height) / cv.width, maxH);
        try { pdf.addImage(cv.toDataURL("image/jpeg", 0.88), "JPEG", cx, yy + 2.5, cw, eh); } catch (_) {}
        rowH = Math.max(rowH, 2.5 + eh);
      });
      yy += rowH + 5;
    }
    return yy - y;
  };

  const placeBlocks = (bx, by, bw2, isCol) => {
    let yy = by;
    yy += drawStats(pdf, bx, yy, bw2, o) + (isCol ? 5 : 6);
    if (Array.isArray(o.extraStats) && o.extraStats.length) {
      yy += drawExtraStats(pdf, bx, yy, bw2, o.extraStats) + (isCol ? 4 : 5);
    }
    // Álló lapon a grafikonok itt jönnek (3+ esetén 2 oszlopban); fekvőn a térkép alatt
    if (!isCol && charts.length) {
      const cols = charts.length >= 3 ? 2 : 1;
      yy += drawChartsGrid(bx, yy, bw2, cols, cols === 2 ? 22 : (charts.length === 2 ? 24 : 30)) + 1;
    }
    if (surface && surface.length) yy += drawSurface(pdf, bx, yy, bw2, surface) + 3;
    if (incWp) yy += drawWaypoints(pdf, bx, yy, bw2, o.waypoints, isCol ? 8 : 12) + 3;
    if (note) yy += drawNote(pdf, bx, yy, bw2, note) + 3;
    return yy;
  };

  if (landscape) {
    placeBlocks(rightX, colY, rightW, true);
    if (landCharts) drawChartsGrid(M, mapBox.y + mapBox.h + 5, mapBox.w, landCharts.cols, 22);
  } else {
    placeBlocks(M, mapBox.y + mapBox.h + 6, CW, false);
  }

  // ── QR + lábléc ──
  if (qrCanvas) {
    const qs = 24, qx = PW - M - qs, qy = footerTopY - qs - 8;
    try { pdf.addImage(qrCanvas.toDataURL("image/png"), "PNG", qx, qy, qs, qs); } catch (_) {}
    // A QR-kép is kattintható (PDF-nézőben)
    try { pdf.link(qx, qy, qs, qs, { url: o.shareUrl }); } catch (_) {}
    pdf.setFont(FONT, "normal").setFontSize(7).setTextColor(...hexToRgb(MUTED));
    pdf.text("Olvasd be\ntelefonnal", qx - 2, qy + qs / 2 - 2, { align: "right" });

    // Link a QR alatt – jobbra igazítva, kattintható
    const shown = o.shareUrl.replace(/^https?:\/\//, "");
    let fs = 7;
    pdf.setFont(FONT, "normal").setFontSize(fs);
    while (pdf.getTextWidth(shown) > CW * 0.6 && fs > 5) pdf.setFontSize(--fs);
    const lw = pdf.getTextWidth(shown);
    pdf.setTextColor(...hexToRgb(ACCENT));
    pdf.textWithLink(shown, PW - M - lw, qy + qs + 3.5, { url: o.shareUrl });
  }
  pdf.setDrawColor(228, 232, 234); pdf.setLineWidth(0.3);
  pdf.line(M, footerTopY, PW - M, footerTopY);
  pdf.setFont(FONT, "bold").setFontSize(9).setTextColor(...hexToRgb(NAVY));
  pdf.text("Bringaterv", M, footerTopY + 5);
  pdf.setFont(FONT, "normal").setFontSize(7.5).setTextColor(...hexToRgb(MUTED));
  pdf.text(`Készült: ${new Date().toLocaleDateString("hu-HU", { year: "numeric", month: "long", day: "numeric" })}`,
    M, footerTopY + 9.5);

  const fname = (o.filename || o.title || "utvonalterv").replace(/[^\wÀ-ɏ\- ]+/g, "").trim() || "utvonalterv";
  if (o.preview) return pdf.output("datauristring");
  pdf.save(`${fname}.pdf`);
}
