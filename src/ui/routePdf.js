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
 *   mapStyle:    "standard" | "light" | "topo" | "satellite"
 *   orientation: "portrait" | "landscape"
 *   includeQr / includeElevation / includeSurface / includeWaypoints : boolean
 *   note:        szabad szöveg (megjegyzés)
 *   waypoints:   [{ name?, lat, lng }]
 *   preview:     true → datauri-t ad vissza (nem tölt le)
 */

import { analyzeSurface, MODE_LABELS } from "../map/surfaceAnalysis.js";
import { SEGMENT_COLORS } from "../map/mapAdapter.js";
import { buildElevationData } from "./elevationProfile.js";

const NAVY = "#2d4a5a";
const ACCENT = "#e8461e";
const INK = "#1f2a30";
const MUTED = "#7a8891";
const TILE = 256;

const TILE_STYLES = {
  standard: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c"], maxZoom: 18, veil: 0.12,
  },
  light: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    overlay: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    subdomains: [], maxZoom: 16, veil: 0,
  },
  topo: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c"], maxZoom: 16, veil: 0.08,
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    overlay: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    subdomains: [], maxZoom: 18, veil: 0,
  },
};

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

async function ensureQR() {
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
  const def = TILE_STYLES[style] || TILE_STYLES.standard;
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

  const drawTiles = async (tmpl) => {
    const jobs = [];
    for (let tx = x0; tx <= x1; tx++)
      for (let ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= nTiles) continue;
        const dx = tx * TILE - originX, dy = ty * TILE - originY;
        jobs.push(loadImage(tileUrl(tmpl, tx, ty)).then((img) => { if (img) ctx.drawImage(img, dx, dy, TILE, TILE); }));
      }
    await Promise.all(jobs);
  };

  await drawTiles(def.url);
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

function buildElevationCanvas(elevData, { width = 1600, height = 300 } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  const data = (elevData || []).filter((d) => d.value != null);
  if (data.length < 2) return null;

  const padL = 56, padR = 16, padT = 16, padB = 34;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const dists = data.map((d) => d.dist), vals = data.map((d) => d.value);
  const dMin = Math.min(...dists), dMax = Math.max(...dists);
  let vMin = Math.min(...vals), vMax = Math.max(...vals);
  if (vMax - vMin < 10) { vMax += 5; vMin -= 5; }
  const p = (vMax - vMin) * 0.12; vMin -= p; vMax += p;
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
  grad.addColorStop(0, "rgba(232,70,30,0.30)");
  grad.addColorStop(1, "rgba(232,70,30,0.02)");
  ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath();
  data.forEach((d, i) => (i === 0 ? ctx.moveTo(sx(d.dist), sy(d.value)) : ctx.lineTo(sx(d.dist), sy(d.value))));
  ctx.strokeStyle = ACCENT; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.stroke();

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

function buildQrCanvas(text, qrcode, { size = 320 } = {}) {
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

function drawStats(pdf, x, y, w, o) {
  const cells = [
    [fmt(o.distanceKm, 1), "KM · TÁV"],
    [`${Math.round(o.ascentM || 0)} m`, "EMELKEDÉS"],
    [o.durationText || "—", "BECSÜLT IDŐ"],
    [o.avgSpeedKmh ? fmt(o.avgSpeedKmh, 1) : (o.descentM != null ? `${Math.round(o.descentM)} m` : "—"),
      o.avgSpeedKmh ? "KM/H ÁTLAG" : "SÜLLYEDÉS"],
  ];
  const twoRow = w < 150;
  const cols = twoRow ? 2 : 4;
  const cw = w / cols, rh = 20;
  cells.forEach(([val, label], i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const cx = x + cw * col + cw / 2, cy = y + rh * row;
    pdf.setFont(FONT, "bold").setFontSize(twoRow ? 15 : 17).setTextColor(...hexToRgb(NAVY));
    pdf.text(String(val), cx, cy + 7, { align: "center" });
    pdf.setFont(FONT, "normal").setFontSize(7.5).setTextColor(...hexToRgb(MUTED));
    pdf.text(label, cx, cy + 12.5, { align: "center" });
  });
  return twoRow ? rh * 2 : rh;
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
  let mapBox, rightX, rightW, colY;
  if (landscape) {
    rightW = 92; const gap = 6;
    mapBox = { x: M, y: bodyTop, w: CW - rightW - gap, h: footerTopY - bodyTop - 2 };
    rightX = M + mapBox.w + gap; rightW = CW - mapBox.w - gap; colY = bodyTop;
  } else {
    // álló: a térkép magassága csökken, ha sok extra blokk van
    const extras = (incElev ? 1 : 0) + (incSurface ? 1 : 0) + (incWp ? 1 : 0) + (note ? 1 : 0);
    const mapH = Math.max(80, 118 - extras * 9);
    mapBox = { x: M, y: bodyTop, w: CW, h: mapH };
  }

  onProgress("Térkép összeállítása…");
  const mapCanvas = await buildMapCanvas(points, mapStyle, {
    width: mapBox.w * 8, height: mapBox.h * 8, routeColor: ACCENT,
  });

  const elevData = incElev ? buildElevationData(geometry) : [];
  const elevCanvas = elevData.length ? buildElevationCanvas(elevData) : null;

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
  const placeBlocks = (bx, by, bw2, isCol) => {
    let yy = by;
    yy += drawStats(pdf, bx, yy, bw2, o) + (isCol ? 5 : 6);
    if (elevCanvas) {
      yy += drawTitleRow(pdf, bx, yy, bw2, "Szintprofil");
      const eh = Math.min((bw2 * elevCanvas.height) / elevCanvas.width, isCol ? 26 : 30);
      try { pdf.addImage(elevCanvas.toDataURL("image/png"), "PNG", bx, yy, bw2, eh); } catch (_) {}
      yy += eh + 6;
    }
    if (surface && surface.length) yy += drawSurface(pdf, bx, yy, bw2, surface) + 3;
    if (incWp) yy += drawWaypoints(pdf, bx, yy, bw2, o.waypoints, isCol ? 8 : 12) + 3;
    if (note) yy += drawNote(pdf, bx, yy, bw2, note) + 3;
    return yy;
  };

  if (landscape) {
    placeBlocks(rightX, colY, rightW, true);
  } else {
    placeBlocks(M, mapBox.y + mapBox.h + 6, CW, false);
  }

  // ── QR + lábléc ──
  if (qrCanvas) {
    const qs = 24, qx = PW - M - qs, qy = footerTopY - qs - 3;
    try { pdf.addImage(qrCanvas.toDataURL("image/png"), "PNG", qx, qy, qs, qs); } catch (_) {}
    pdf.setFont(FONT, "normal").setFontSize(7).setTextColor(...hexToRgb(MUTED));
    pdf.text("Olvasd be\ntelefonnal", qx - 2, qy + qs / 2 - 2, { align: "right" });
  }
  pdf.setDrawColor(228, 232, 234); pdf.setLineWidth(0.3);
  pdf.line(M, footerTopY, PW - M, footerTopY);
  pdf.setFont(FONT, "bold").setFontSize(9).setTextColor(...hexToRgb(NAVY));
  pdf.text("bringaterv.hu", M, footerTopY + 5);
  pdf.setFont(FONT, "normal").setFontSize(7.5).setTextColor(...hexToRgb(MUTED));
  pdf.text(`Készült: ${new Date().toLocaleDateString("hu-HU", { year: "numeric", month: "long", day: "numeric" })}`,
    M, footerTopY + 9.5);

  const fname = (o.filename || o.title || "utvonalterv").replace(/[^\wÀ-ɏ\- ]+/g, "").trim() || "utvonalterv";
  if (o.preview) return pdf.output("datauristring");
  pdf.save(`${fname}.pdf`);
}
