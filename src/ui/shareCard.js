import { num } from "../format.js";
import { ensureQR, buildQrCanvas } from "./routePdf.js";
import { CHART_SOLID_GRAY, isSolidChartMode } from "./elevationProfile.js";
/**
 * Bringaterv – Workout Share Card Generator
 * ==========================================
 * Canvas-alapú megosztó kép – letisztult, „térkép + adatpanel” dizájn.
 * Az elrendezés 360px-es alapra van tervezve, és scale = width/360 faktorral
 * skálázódik (1080 px széles kép → s = 3).
 *
 *   square : 1080×1080 (1:1)
 *   story  : 1080×1920 (9:16)
 *
 * Rétegek:
 *   1. háttér: valódi térkép (világos / sötét Esri csempék), vagy saját fotó
 *   2. nyomvonal: fehér körvonal + narancs vonal, rajt- és célpont
 *   3. bal felső sarok: kis logó-jelvény („Bringaterv”)
 *   4. alsó adatpanel: cím, dátum, szintprofil-csík, 2–4 adat nagy számokkal,
 *      és ha van nyilvános link, egy kis QR-kód a jobb felső sarkában
 *
 * Két független választás:
 *   theme  – a háttér: világos / sötét / terep (zöld, domborzatos) térkép, vagy fotó
 *   layout – a stílus (elrendezés), lásd SHARE_LAYOUTS:
 *            „panel”   – alul fehér/sötét adatpanel (a fenti rétegek)
 *            „overlay” – az adatok fehér betűkkel, alul sötét átmeneten,
 *                        közvetlenül a háttérre kerülnek (panel nélkül)
 * Új stílus: egy új elem a SHARE_LAYOUTS-ba + egy rajzoló ág a fő függvényben.
 *
 * Ha a térképcsempék nem tölthetők be (offline), sima háttérszín marad.
 */

const BASE = 360;
const FONT = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";
const BRAND_FONT = "Montserrat, Inter, system-ui, sans-serif";
// Számok: keskeny, sportos számbetű – karcsúbb, mint a vastag Inter
const NUM_FONT = "'Barlow Semi Condensed', Inter, system-ui, sans-serif";
const TILE = 256;
const MAX_ZOOM = 16;
const TILES = {
  light: {
    base: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    ref:  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
  },
  dark: {
    base: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    ref:  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
  },
  // Terep: domborzatos, zöld erdős topográfiai térkép (a feliratok benne vannak)
  topo: {
    base: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    filter: "saturate(1.45) contrast(1.06)",   // élénkebb zöld erdők, kék víz
  },
};

/** A választható stílusok (a megosztó kép ablak ebből építi a választót). */
export const SHARE_LAYOUTS = [
  { id: "panel",   label: "Adatpanel", hint: "Térkép felül, adatok alul egy panelen" },
  { id: "overlay", label: "Térképen",  hint: "Az adatok közvetlenül a térképen" },
];

/**
 * Választható grafikonok az adatok fölött (egymás alatt, a megadott sorrendben).
 * A pont-mezők: ele (m), speed (km/h), hr (bpm), cad (rpm), power (W).
 */
export const SHARE_CHARTS = [
  { id: "ele",   label: "Szintprofil",  caps: "SZINTPROFIL",  unit: "m",    color: "#e8461e", minRange: 20 },
  { id: "speed", label: "Sebesség",     caps: "SEBESSÉG",     unit: "km/h", color: "#3B82F6", minRange: 5,  avg: true, smooth: 3 },
  { id: "hr",    label: "Pulzus",       caps: "PULZUS",       unit: "bpm",  color: "#EF4444", minRange: 10, avg: true, smooth: 2 },
  { id: "cad",   label: "Kadencia",     caps: "KADENCIA",     unit: "rpm",  color: "#A855F7", minRange: 10, avg: true, smooth: 3 },
  { id: "power", label: "Teljesítmény", caps: "TELJESÍTMÉNY", unit: "W",    color: "#EAB308", minRange: 30, avg: true, smooth: 4 },
];

/** Mely grafikonokhoz van elég adat a pontokban. */
export function availableShareCharts(points = []) {
  return SHARE_CHARTS.filter((ch) =>
    points.filter((p) => Number.isFinite(p[ch.id]) && (ch.id === "ele" || p[ch.id] > 0)).length > 10).map((ch) => ch.id);
}

/**
 * A megosztó képhez ~400 pontra ritkított nyomvonal. A szenzoradatok
 * (sebesség, pulzus, kadencia, teljesítmény) a kihagyott pontokkal együtt
 * átlagolva kerülnek át, így a grafikon-csíkok nem ugrálnak.
 */
export function shareCardPoints(geometry) {
  const step = Math.max(1, Math.floor(geometry.length / 400));
  const out = [];
  for (let i = 0; i < geometry.length; i += step) {
    const g = geometry[i];
    const p = { lat: g.lat, lng: g.lng, ele: g.ele };
    for (const k of ["speed", "hr", "cad", "power"]) {
      let sum = 0, n = 0;
      for (let j = i; j < Math.min(geometry.length, i + step); j++) {
        const v = geometry[j][k];
        if (v != null && Number.isFinite(v)) { sum += v; n++; }
      }
      if (n) p[k] = sum / n;
    }
    out.push(p);
  }
  const last = geometry[geometry.length - 1];
  if (out.length && last && (out[out.length - 1].lat !== last.lat || out[out.length - 1].lng !== last.lng)) {
    out.push({ lat: last.lat, lng: last.lng, ele: last.ele });
  }
  return out;
}

// ── Betöltések (cache-elve) ──────────────────────────────────────────────────

const _imgCache = new Map();
function loadImage(src, cors = false) {
  if (_imgCache.has(src)) return _imgCache.get(src);
  const p = new Promise((resolve) => {
    const img = new Image();
    if (cors) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => { _imgCache.delete(src); resolve(null); };
    img.src = src;
  });
  _imgCache.set(src, p);
  return p;
}
const loadLogo = () => loadImage("/src/assets/icons/icon-192.png");

/** „Térképen” stílus: fehér szöveg, vékony vonal, áttetsző jelvény – bármelyik háttéren. */
function overlayPalette(c) {
  return {
    ...c, overlay: true, shade: c.shade || "12,14,18",
    panelText: "#ffffff", panelMuted: "rgba(255,255,255,0.78)", panelLine: "rgba(255,255,255,0.22)",
    elevFill: "rgba(255,255,255,0.12)", elevLine: "rgba(255,255,255,0.9)",
    // sötét térképen a fehér szegély rózsaszínre mosná a narancsot
    casing: c.tiles === TILES.dark ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.7)", end: "#1a1d23", endCore: "#ffffff",
    badgeBg: "rgba(20,24,20,0.55)", badgeText: "#ffffff", attrib: "rgba(255,255,255,0.55)",
  };
}

function palette(theme) {
  if (theme === "photo") {
    return {
      photo: true, cardBg: "#11161a",
      panel: "rgba(12,16,20,0.62)", panelText: "#ffffff", panelMuted: "rgba(255,255,255,0.72)",
      panelLine: "rgba(255,255,255,0.16)", elevFill: "rgba(255,106,61,0.30)", elevLine: "rgba(255,106,61,0.9)",
      route: "#ff6a3d", casing: "rgba(0,0,0,0.45)", start: "#22c55e", end: "#ffffff", endCore: "#ff6a3d",
      badgeBg: "rgba(12,16,20,0.55)", badgeText: "#ffffff", attrib: "rgba(255,255,255,0.6)",
    };
  }
  if (theme === "topo") {
    return {
      tiles: TILES.topo, mapBg: "#dfe8d4", cardBg: "#ffffff", shade: "16,32,18",
      panel: "#ffffff", panelText: "#1a1d23", panelMuted: "#6b7280",
      panelLine: "#ececec", elevFill: "rgba(252,76,2,0.13)", elevLine: "#fc4c02",
      route: "#fc4c02", casing: "#ffffff", start: "#16a34a", end: "#1a1d23", endCore: "#ffffff",
      badgeBg: "rgba(255,255,255,0.92)", badgeText: "#1a1d23", attrib: "rgba(0,0,0,0.5)",
    };
  }
  if (theme === "dark") {
    return {
      tiles: TILES.dark, mapBg: "#1e2328", cardBg: "#14181c",
      panel: "#14181c", panelText: "#ffffff", panelMuted: "#8b95a1",
      panelLine: "rgba(255,255,255,0.10)", elevFill: "rgba(252,76,2,0.22)", elevLine: "#fc4c02",
      route: "#ff6a3d", casing: "rgba(0,0,0,0.55)", start: "#22c55e", end: "#ffffff", endCore: "#14181c",
      badgeBg: "rgba(20,24,28,0.82)", badgeText: "#ffffff", attrib: "rgba(255,255,255,0.45)",
    };
  }
  return {
    tiles: TILES.light, mapBg: "#eceae6", cardBg: "#ffffff",
    panel: "#ffffff", panelText: "#1a1d23", panelMuted: "#6b7280",
    panelLine: "#ececec", elevFill: "rgba(252,76,2,0.13)", elevLine: "#fc4c02",
    route: "#fc4c02", casing: "#ffffff", start: "#16a34a", end: "#1a1d23", endCore: "#ffffff",
    badgeBg: "rgba(255,255,255,0.92)", badgeText: "#1a1d23", attrib: "rgba(0,0,0,0.45)",
  };
}

// ── Fő függvény ──────────────────────────────────────────────────────────────

/** Async – Promise<HTMLCanvasElement> */
export async function createWorkoutShareCard({
  title = "Bringaterv edzés",
  date = "",
  distanceKm = 0,
  durationText = "",
  avgSpeedKmh = 0,
  elevationM = 0,
  points = [],
  theme = "light",            // "light" | "dark" | "topo" | "photo"
  layout = "panel",           // "panel" | "overlay" – lásd SHARE_LAYOUTS
  charts = ["ele"],           // grafikonok egymás alatt – lásd SHARE_CHARTS
  size = "square",            // "square" | "story"
  photo = null,               // { img, scale, offsetX, offsetY, blur, headerBg, routeColor, routeOffsetX/Y, routeScale }
  qrUrl = null,               // nyilvános nézőoldal linkje → kis QR-kód a panelen
}) {
  const dim = size === "story" ? { width: 1080, height: 1920 } : { width: 1080, height: 1080 };
  const s = dim.width / BASE;
  const c = layout === "overlay" ? overlayPalette(palette(theme)) : palette(theme);
  const W = dim.width, H = dim.height;

  // A canvas csak betöltött betűtípussal rajzol szépen – várjunk rá (ha elérhető)
  try {
    await Promise.all([document.fonts?.load(`800 20px Montserrat`), document.fonts?.load(`700 20px Inter`),
                       document.fonts?.load(`600 20px 'Barlow Semi Condensed'`)]);
  } catch {}

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  const stats = statItems({ distanceKm, durationText, avgSpeedKmh, elevationM });
  const avail = availableShareCharts(points);
  const chartIds = charts.filter((id) => avail.includes(id));
  const panelBg = theme === "photo" ? (photo?.headerBg || "translucent") : "solid";

  if (c.overlay) {
    return drawOverlayCard({ canvas, ctx, c, s, W, H, size, title, date, stats, points, chartIds, qrUrl, photo });
  }

  // Panel-magasság: cím + dátum + (szintprofil) + adatsor
  const head = Math.max(date ? 56 : 44, qrUrl ? 62 : 0);
  const chartH = chartIds.length > 1 ? 15 : 20;   // több grafikonnál laposabb csíkok
  const panelH = head + (chartIds.length ? 6 + chartIds.length * (11 + chartH + 4) : 6) + 62;
  const panel = { x: 0, y: H - panelH * s, w: W, h: panelH * s };
  // A térkép a teljes kép; a nyomvonal a panel fölötti részbe kerül
  const routeArea = { x: 18 * s, y: 50 * s, w: W - 36 * s, h: panel.y - 50 * s - 18 * s };

  ctx.save();
  roundRectPath(ctx, 0, 0, W, H, 18 * s);
  ctx.clip();
  ctx.fillStyle = c.cardBg;
  ctx.fillRect(0, 0, W, H);

  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  let proj = null;

  if (c.photo) {
    drawPhotoLayer(ctx, s, photo, W, H);
    if (valid.length > 1) proj = fitProjection(valid, routeArea);
  } else {
    ctx.fillStyle = c.mapBg;
    ctx.fillRect(0, 0, W, H);
    if (valid.length > 1) {
      proj = fitProjection(valid, routeArea);
      await drawTiles(ctx, c.tiles, proj, W, H, s);
    }
  }

  if (proj) {
    drawRoute(ctx, c, s, valid.map(proj.toPx), c.photo ? {
      color: photo?.routeColor, offsetX: photo?.routeOffsetX, offsetY: photo?.routeOffsetY, scale: photo?.routeScale,
      box: routeArea,
    } : null);
  } else {
    ctx.fillStyle = c.panelMuted;
    ctx.font = `600 ${13 * s}px ${FONT}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(c.photo && !photo?.img ? "Tölts fel egy képet" : "Nincs útvonaladat", W / 2, routeArea.y + routeArea.h / 2);
  }

  if (!c.photo && proj) {
    // Térkép-forrás (kötelező feltüntetni) – a panel fölött, jobbra
    ctx.fillStyle = c.attrib;
    ctx.font = `400 ${6.5 * s}px ${FONT}`;
    ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    ctx.fillText("© Esri, OpenStreetMap", W - 8 * s, panel.y - 5 * s);
  }

  drawBadge(ctx, c, s, await loadLogo());
  let qr = null;
  if (qrUrl) {
    try { qr = buildQrCanvas(qrUrl, await ensureQR(), { size: 300 }); } catch { qr = null; }
  }
  drawPanel(ctx, c, s, panel, { title, date, stats, points: valid, chartIds, chartH, panelBg, qr });

  ctx.restore();
  return canvas;
}

export function downloadShareCard(canvas, filename = "bringaterv-share.png") {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}

// ── Adatok ───────────────────────────────────────────────────────────────────

/** „1 ó 5 p” → „1:05”, „45 p” → „0:45” – a képen egy egységként olvasható. */
function compactDuration(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (/^\d+:\d{2}(:\d{2})?$/.test(t)) return t;
  const h = +(t.match(/(\d+)\s*ó/)?.[1] || 0);
  const m = +(t.match(/(\d+)\s*p/)?.[1] || 0);
  if (!h && !m) return t;
  return `${h}:${String(m).padStart(2, "0")}`;
}

function statItems({ distanceKm, durationText, avgSpeedKmh, elevationM }) {
  const items = [];
  if (distanceKm > 0) items.push({ value: num(distanceKm, 1), unit: "km", label: "TÁV" });
  const d = compactDuration(durationText);
  if (d) items.push({ value: d, unit: "", label: "IDŐ" });
  if (avgSpeedKmh > 0) items.push({ value: num(avgSpeedKmh, 1), unit: "km/h", label: "ÁTLAG" });
  if (elevationM > 0) items.push({ value: String(Math.round(elevationM)), unit: "m", label: "SZINT" });
  return items;
}

// ── Vetület és térképcsempék (Web Mercator) ──────────────────────────────────

const mercX = (lng) => (lng + 180) / 360;
const mercY = (lat) => {
  const r = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + r) / (1 - r)) / (4 * Math.PI);
};

/**
 * A nyomvonalat a megadott téglalapba illeszti. Visszaad egy vetületet:
 * px = (merc - origin) * worldPx, ahol worldPx a kép pixelében mért világméret.
 */
function fitProjection(points, box) {
  const xs = points.map((p) => mercX(p.lng)), ys = points.map((p) => mercY(p.lat));
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const dx = Math.max(maxX - minX, 1e-7), dy = Math.max(maxY - minY, 1e-7);
  const worldPx = Math.min(box.w / dx, box.h / dy);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const ox = cx - (box.x + box.w / 2) / worldPx;
  const oy = cy - (box.y + box.h / 2) / worldPx;
  return {
    worldPx, ox, oy,
    toPx: (p) => ({ x: (mercX(p.lng) - ox) * worldPx, y: (mercY(p.lat) - oy) * worldPx }),
  };
}

async function drawTiles(ctx, tiles, proj, W, H, s) {
  // A kép „logikai” mérete 360 px (s-szeres felbontás) – a zoomot ehhez mérjük,
  // így a térkép részletessége olyan, mint egy telefonon nézett térképé.
  const zLogical = Math.log2(proj.worldPx / s / TILE);
  const layers = [
    { url: tiles.base, z: Math.min(MAX_ZOOM, Math.max(1, Math.floor(zLogical) + (tiles.ref ? 2 : 1))) },  // éles alap
    tiles.ref && { url: tiles.ref, z: Math.min(MAX_ZOOM, Math.max(1, Math.floor(zLogical) + 1)), alpha: 0.95 },  // feliratok, olvasható méretben
  ].filter(Boolean);
  for (const layer of layers) {
    const n = 2 ** layer.z;
    const tilePx = proj.worldPx / n;                     // egy csempe mérete a képen
    const x0 = Math.floor(proj.ox * n), y0 = Math.floor(proj.oy * n);
    const x1 = Math.floor((proj.ox + W / proj.worldPx) * n), y1 = Math.floor((proj.oy + H / proj.worldPx) * n);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 160) continue;   // védőkorlát
    const jobs = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        const src = layer.url.replace("{z}", layer.z).replace("{x}", wx).replace("{y}", ty);
        jobs.push(loadImage(src, true).then((img) => ({ img, tx, ty })));
      }
    }
    const loaded = await Promise.all(jobs);
    ctx.save();
    ctx.globalAlpha = layer.alpha ?? 1;
    if (tiles.filter && layer.url === tiles.base) ctx.filter = tiles.filter;
    ctx.imageSmoothingQuality = "high";
    for (const { img, tx, ty } of loaded) {
      if (!img) continue;
      const x = (tx / n - proj.ox) * proj.worldPx;
      const y = (ty / n - proj.oy) * proj.worldPx;
      ctx.drawImage(img, Math.floor(x), Math.floor(y), Math.ceil(tilePx) + 1, Math.ceil(tilePx) + 1);
    }
    ctx.restore();
  }
}

// ── Fotó háttér-réteg ────────────────────────────────────────────────────────

function drawPhotoLayer(ctx, s, photo, W, H) {
  const img = photo?.img;
  const scale = Math.max(0.2, photo?.scale ?? 1);
  const offX = (photo?.offsetX ?? 0) * s;
  const offY = (photo?.offsetY ?? 0) * s;
  const blurPx = Math.max(0, photo?.blur ?? 0) * s;
  if (img) {
    const ir = img.width / img.height, cr = W / H;
    let dw, dh;
    if (ir > cr) { dh = H; dw = H * ir; } else { dw = W; dh = W / ir; }
    dw *= scale; dh *= scale;
    ctx.save();
    if (blurPx > 0) ctx.filter = `blur(${blurPx}px)`;
    ctx.drawImage(img, (W - dw) / 2 + offX, (H - dh) / 2 + offY, dw, dh);
    ctx.filter = "none";
    ctx.restore();
  }
  // Olvashatóság: enyhe sötétítés + felül egy halvány átmenet a jelvény mögé
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.fillRect(0, 0, W, H);
  const gT = ctx.createLinearGradient(0, 0, 0, H * 0.22);
  gT.addColorStop(0, "rgba(0,0,0,0.40)"); gT.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gT; ctx.fillRect(0, 0, W, H * 0.22);
}

// ── Nyomvonal ────────────────────────────────────────────────────────────────

function drawRoute(ctx, c, s, pts, opts) {
  if (opts) {
    // Fotó téma: mozgatható / méretezhető nyomvonal
    pts = photoRouteTransform(pts, s, { routeOffsetX: opts.offsetX, routeOffsetY: opts.offsetY, routeScale: opts.scale }, opts.box);
  }
  const color = opts?.color || c.route;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  // Körvonal (világos térképen fehér, sötéten / fotón árnyék)
  ctx.strokeStyle = c.casing;
  ctx.lineWidth = 4 * s;
  if (c.photo) { ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 6 * s; }
  drawPath(ctx, pts);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2 * s;
  drawPath(ctx, pts);
  ctx.restore();

  const a = pts[0], b = pts[pts.length - 1];
  const loop = Math.hypot(a.x - b.x, a.y - b.y) < 8 * s;   // körtúra: rajt = cél
  drawDot(ctx, a.x, a.y, 4.5 * s, c.start, "#ffffff", 1.6 * s);
  if (!loop) {
    drawDot(ctx, b.x, b.y, 5 * s, c.end, "#ffffff", 1.6 * s);
    drawDot(ctx, b.x, b.y, 2 * s, c.endCore, null, 0);
  }
}

/** Fotó háttéren a nyomvonal a felhasználó által húzott / méretezett helyre kerül. */
function photoRouteTransform(pts, s, photo, box) {
  const ox = (photo?.routeOffsetX || 0) * s, oy = (photo?.routeOffsetY || 0) * s;
  const sc = Math.max(0.2, photo?.routeScale || 1);
  const bcx = box.x + box.w / 2, bcy = box.y + box.h / 2;
  return pts.map((p) => ({ x: bcx + (p.x - bcx) * sc + ox, y: bcy + (p.y - bcy) * sc + oy }));
}

// ── Logó-jelvény ─────────────────────────────────────────────────────────────

function drawBadge(ctx, c, s, logo) {
  const x = 12 * s, y = 12 * s, h = 30 * s;
  ctx.font = `800 ${13.2 * s}px ${BRAND_FONT}`;
  const wB = ctx.measureText("Bringa").width, wT = ctx.measureText("terv").width;
  const w = h + 6 * s + wB + wT + 10 * s;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.12)"; ctx.shadowBlur = 6 * s; ctx.shadowOffsetY = 1 * s;
  ctx.fillStyle = c.badgeBg;
  roundRectPath(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.restore();
  const r = (h - 6 * s) / 2, lcx = x + 3 * s + r, lcy = y + h / 2;
  if (logo) {
    ctx.save();
    ctx.beginPath(); ctx.arc(lcx, lcy, r, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(logo, lcx - r, lcy - r, r * 2, r * 2);
    ctx.restore();
  }
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const tx = x + h + 3 * s;
  ctx.fillStyle = c.badgeText; ctx.fillText("Bringa", tx, lcy + 0.5 * s);
  ctx.fillStyle = "#fc4c02";    ctx.fillText("terv", tx + wB, lcy + 0.5 * s);
}

// ── Adatpanel ────────────────────────────────────────────────────────────────

function drawPanel(ctx, c, s, rect, { title, date, stats, points, chartIds, chartH, panelBg, qr }) {
  const padX = 18 * s;
  const qrBox = 44 * s, qrPad = 3 * s;
  if (panelBg !== "none") {
    ctx.save();
    ctx.fillStyle = panelBg === "solid" && c.photo ? "#14181c" : c.panel;
    if (!c.photo) { ctx.shadowColor = "rgba(0,0,0,0.10)"; ctx.shadowBlur = 14 * s; ctx.shadowOffsetY = -2 * s; }
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  } else {
    const g = ctx.createLinearGradient(0, rect.y - 30 * s, 0, rect.y + rect.h);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(0.35, "rgba(0,0,0,0.45)"); g.addColorStop(1, "rgba(0,0,0,0.7)");
    ctx.fillStyle = g; ctx.fillRect(rect.x, rect.y - 30 * s, rect.w, rect.h + 30 * s);
  }

  let y = rect.y + 16 * s;
  // QR-kód a jobb felső sarokban (fehér, lekerekített keretben – sötét témán is olvasható)
  const textW = rect.w - padX * 2 - (qr ? qrBox + 10 * s : 0);
  if (qr) {
    const qx = rect.w - padX - qrBox, qy = rect.y + 12 * s;
    ctx.save();
    ctx.fillStyle = "#ffffff";
    if (c.panel === "#ffffff") { ctx.strokeStyle = c.panelLine; ctx.lineWidth = Math.max(1, 0.6 * s); }
    roundRectPath(ctx, qx, qy, qrBox, qrBox, 6 * s);
    ctx.fill();
    if (c.panel === "#ffffff") ctx.stroke();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(qr, qx + qrPad, qy + qrPad, qrBox - qrPad * 2, qrBox - qrPad * 2);
    ctx.restore();
  }
  // Cím
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillStyle = c.panelText;
  ctx.font = `700 ${16.5 * s}px ${FONT}`;
  ctx.letterSpacing = `${-0.2 * s}px`;
  fitOneLine(ctx, title || "Bringaterv", padX, y, textW);
  ctx.letterSpacing = "0px";
  y += 23 * s;
  if (date) {
    ctx.fillStyle = c.panelMuted;
    ctx.letterSpacing = "0px";
    ctx.font = `500 ${10 * s}px ${FONT}`;
    fitOneLine(ctx, date, padX, y, textW);
    y += 14 * s;
  }

  // Grafikon-csíkok egymás alatt (a QR alá nem lógnak)
  if (chartIds.length) {
    y += 6 * s;
    const minY = qr ? rect.y + 12 * s + qrBox + 6 * s : 0;
    if (y < minY) y = minY;
    for (const id of chartIds) {
      drawChart(ctx, c, s, points, id, { x: padX, y, w: rect.w - padX * 2, h: chartH * s });
      y += (11 + chartH + 4) * s;
    }
  } else {
    y += 4 * s;
  }

  // Elválasztó
  ctx.strokeStyle = c.panelLine;
  ctx.lineWidth = Math.max(1, 0.6 * s);
  ctx.beginPath(); ctx.moveTo(padX, y); ctx.lineTo(rect.w - padX, y); ctx.stroke();
  y += 12 * s;

  // Adatok – egyenlő oszlopok, nagy szám + kis mértékegység, alatta címke
  const n = Math.max(1, stats.length);
  const colW = (rect.w - padX * 2) / n;
  stats.forEach((it, i) => {
    const x = padX + colW * i;
    if (i > 0) {
      ctx.strokeStyle = c.panelLine;
      ctx.beginPath(); ctx.moveTo(x - 0.5 * s, y + 2 * s); ctx.lineTo(x - 0.5 * s, y + 34 * s); ctx.stroke();
    }
    const tx = x + (i > 0 ? 10 * s : 0);
    let size = 25;
    const maxW = colW - (i > 0 ? 14 : 4) * s;
    let vw, uw;
    do {
      ctx.font = `600 ${size * s}px ${NUM_FONT}`;
      vw = ctx.measureText(it.value).width;
      ctx.font = `500 ${size * 0.46 * s}px ${FONT}`;
      uw = it.unit ? ctx.measureText(it.unit).width + 3 * s : 0;
      size -= 1;
    } while (vw + uw > maxW && size > 14);
    size += 1;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = c.panelText;
    ctx.font = `600 ${size * s}px ${NUM_FONT}`;
    ctx.fillText(it.value, tx, y + 22 * s);
    if (it.unit) {
      ctx.fillStyle = c.panelMuted;
      ctx.font = `500 ${size * 0.46 * s}px ${FONT}`;
      ctx.fillText(it.unit, tx + vw + 3 * s, y + 22 * s);
    }
    ctx.fillStyle = c.panelMuted;
    ctx.font = `500 ${7 * s}px ${FONT}`;
    ctx.letterSpacing = `${0.9 * s}px`;
    ctx.fillText(it.label, tx, y + 34 * s);
    ctx.letterSpacing = "0px";
  });
}

// ── „Terep” téma: adatok közvetlenül a térképen ────────────────────────────

async function drawOverlayCard({ canvas, ctx, c, s, W, H, size, title, date, stats, points, chartIds, qrUrl, photo }) {
  const story = size === "story";
  const padX = 20 * s;
  // Adatrács: álló képen 2 oszlop (nagy számok), négyzetesen egy sor
  const cols = story ? 2 : Math.max(1, stats.length);
  const rows = Math.ceil(stats.length / cols);
  const rowH = (story ? 58 : 42) * s;
  const n = chartIds.length;
  const elevH = story ? (n > 1 ? 16 : 20) : (n > 1 ? 11 : 14);
  const blockH = (story ? 34 : 28) * s + (date ? 14 * s : 0) + 10 * s + rows * rowH + n * (elevH + 18) * s + 16 * s;

  ctx.save();
  roundRectPath(ctx, 0, 0, W, H, 18 * s);
  ctx.clip();
  ctx.fillStyle = c.photo ? c.cardBg : c.mapBg;
  ctx.fillRect(0, 0, W, H);

  // A nyomvonal szinte az egész képet kitölti; alul kissé belelóghat az adatokba
  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const routeArea = { x: 24 * s, y: 56 * s, w: W - 48 * s, h: H - 56 * s - blockH * (story ? 0.75 : 1) - (story ? 0 : 14 * s) };
  let proj = null;
  if (valid.length > 1) {
    proj = fitProjection(valid, routeArea);
    if (!c.photo) await drawTiles(ctx, c.tiles, proj, W, H, s);
  }
  if (c.photo) drawPhotoLayer(ctx, s, photo, W, H);

  // Olvashatóság: felül halvány, alul erősebb sötét átmenet (terepen zöldes)
  const sh = c.shade;
  const gT = ctx.createLinearGradient(0, 0, 0, 70 * s);
  gT.addColorStop(0, `rgba(${sh},0.35)`); gT.addColorStop(1, `rgba(${sh},0)`);
  ctx.fillStyle = gT; ctx.fillRect(0, 0, W, 70 * s);
  const gy = H - blockH - 70 * s;
  const gB = ctx.createLinearGradient(0, gy, 0, H);
  gB.addColorStop(0, `rgba(${sh},0)`);
  gB.addColorStop(0.35, `rgba(${sh},0.55)`);
  gB.addColorStop(1, `rgba(${sh},0.9)`);
  ctx.fillStyle = gB; ctx.fillRect(0, gy, W, H - gy);

  if (proj) {
    let pts = valid.map(proj.toPx);
    if (c.photo) pts = photoRouteTransform(pts, s, photo, routeArea);
    const routeColor = (c.photo && photo?.routeColor) || c.route;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // Vékony, elegáns vonal: halvány fehér szegély + 1,6 px-es narancs
    ctx.shadowColor = "rgba(0,0,0,0.25)"; ctx.shadowBlur = 2 * s;
    ctx.strokeStyle = c.casing; ctx.lineWidth = 2.8 * s;
    drawPath(ctx, pts);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = routeColor; ctx.lineWidth = 1.6 * s;
    drawPath(ctx, pts);
    ctx.restore();
    const a = pts[0], b = pts[pts.length - 1];
    drawDot(ctx, a.x, a.y, 4 * s, c.start, "#ffffff", 1.5 * s);
    if (Math.hypot(a.x - b.x, a.y - b.y) >= 8 * s) {
      drawDot(ctx, b.x, b.y, 4.5 * s, c.end, "#ffffff", 1.5 * s);
      drawDot(ctx, b.x, b.y, 1.8 * s, c.endCore, null, 0);
    }
  }

  drawBadge(ctx, c, s, await loadLogo());

  // Szöveg – fehér, enyhe árnyékkal, hogy világos térképrészen is olvasható legyen
  ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 4 * s;
  let y = H - blockH;
  let qr = null;
  if (qrUrl) {
    try { qr = buildQrCanvas(qrUrl, await ensureQR(), { size: 300 }); } catch { qr = null; }
  }
  const qrBox = 46 * s;
  const textW = W - padX * 2 - (qr ? qrBox + 10 * s : 0);
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillStyle = c.panelText;
  ctx.font = `700 ${(story ? 24 : 19) * s}px ${FONT}`;
  ctx.letterSpacing = `${-0.3 * s}px`;
  fitOneLine(ctx, title || "Bringaterv", padX, y, textW);
  ctx.letterSpacing = "0px";
  y += (story ? 32 : 26) * s;
  if (date) {
    ctx.fillStyle = c.panelMuted;
    ctx.font = `500 ${10 * s}px ${FONT}`;
    fitOneLine(ctx, date, padX, y, textW);
    y += 14 * s;
  }
  y += 10 * s;

  const colW = (W - padX * 2) / cols;
  const valSize = story ? 34 : 26;
  stats.forEach((it, i) => {
    const x = padX + colW * (i % cols);
    const ry = y + Math.floor(i / cols) * rowH;
    ctx.textBaseline = "top";
    ctx.fillStyle = c.panelMuted;
    ctx.font = `500 ${8 * s}px ${FONT}`;
    ctx.letterSpacing = `${0.9 * s}px`;
    ctx.fillText(it.label, x, ry);
    ctx.letterSpacing = "0px";
    let size = valSize, vw, uw;
    const maxW = colW - 8 * s;
    do {
      ctx.font = `600 ${size * s}px ${NUM_FONT}`;
      vw = ctx.measureText(it.value).width;
      ctx.font = `500 ${size * 0.42 * s}px ${FONT}`;
      uw = it.unit ? ctx.measureText(it.unit).width + 3 * s : 0;
      size -= 1;
    } while (vw + uw > maxW && size > 14);
    size += 1;
    ctx.textBaseline = "alphabetic";
    const base = ry + 11 * s + size * 0.8 * s;
    ctx.fillStyle = c.panelText;
    ctx.font = `600 ${size * s}px ${NUM_FONT}`;
    ctx.fillText(it.value, x, base);
    if (it.unit) {
      ctx.fillStyle = c.panelMuted;
      ctx.font = `500 ${size * 0.42 * s}px ${FONT}`;
      ctx.fillText(it.unit, x + vw + 3 * s, base);
    }
  });
  y += rows * rowH;
  ctx.shadowBlur = 0;

  for (const id of chartIds) {
    drawChart(ctx, c, s, valid, id, { x: padX, y, w: textW, h: elevH * s });
    y += (elevH + 18) * s;
  }

  if (qr) {
    const qx = W - padX - qrBox, qy = H - 18 * s - qrBox;
    ctx.save();
    ctx.fillStyle = "#ffffff";
    roundRectPath(ctx, qx, qy, qrBox, qrBox, 6 * s);
    ctx.fill();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(qr, qx + 3 * s, qy + 3 * s, qrBox - 6 * s, qrBox - 6 * s);
    ctx.restore();
  }

  if (proj && !c.photo) {
    ctx.fillStyle = c.attrib;
    ctx.font = `400 ${6 * s}px ${FONT}`;
    ctx.textAlign = "right"; ctx.textBaseline = "top";
    ctx.fillText("© Esri, OpenStreetMap", W - 10 * s, 10 * s);
  }
  ctx.restore();
  return canvas;
}

/**
 * Egy grafikon-csík felirattal: balra a neve, jobbra az összegzés
 * (szintnél max/min, a többinél átlag/max). box.y a felirat teteje;
 * a csík alatta 11 egységgel kezdődik, box.h magas.
 */
function drawChart(ctx, c, s, points, id, box) {
  const ch = SHARE_CHARTS.find((x) => x.id === id);
  if (!ch) return;
  // Táv szerinti x-tengely (haversine) – minden ponton, a hiányzó érték kimarad
  let d = 0;
  const xs = [0];
  for (let i = 1; i < points.length; i++) { d += hav(points[i - 1], points[i]); xs.push(d); }
  const ok = (v) => Number.isFinite(v) && (id === "ele" || v > 0);
  let vals = points.map((p) => (ok(p[id]) ? p[id] : null));
  if (ch.smooth) {
    // A szenzoradat zajos: kis mozgóátlag, hogy a csík olvasható legyen
    const k = ch.smooth;
    vals = vals.map((v, i) => {
      if (v == null) return null;
      let sum = 0, n = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(vals.length - 1, i + k); j++) if (vals[j] != null) { sum += vals[j]; n++; }
      return sum / n;
    });
  }
  const series = vals.map((v, i) => (v == null ? null : { x: xs[i], v })).filter(Boolean);
  if (d <= 0 || series.length < 2) return;
  const raw = points.map((p) => p[id]).filter(ok);
  const sorted = [...raw].sort((a, b) => a - b);
  const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * (sorted.length - 1)))];

  // Felirat
  const overlay = !!c.overlay;
  const solid = isSolidChartMode();
  const lineColor = solid ? CHART_SOLID_GRAY : ch.color;   // Egyszínű mód: egységes szürke
  const color = overlay ? c.elevLine : lineColor;
  ctx.save();
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = c.panelMuted;
  ctx.font = `600 ${6.5 * s}px ${FONT}`;
  ctx.letterSpacing = `${0.9 * s}px`;
  if (!overlay && !solid && id !== "ele") {
    // színes pötty a név előtt, hogy a csík színe azonosítható legyen
    ctx.fillStyle = ch.color;
    ctx.beginPath(); ctx.arc(box.x + 2.2 * s, box.y + 3.3 * s, 2.2 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c.panelMuted;
    ctx.fillText(ch.caps, box.x + 7 * s, box.y);
  } else {
    ctx.fillText(ch.caps, box.x, box.y);
  }
  ctx.letterSpacing = "0px";
  // Összegzés jobbra – mint az alkalmazás diagramfejléce: félkövér szám,
  // kisebb mértékegység, halvány címke
  const r0 = (v) => Math.round(v);
  const items = ch.avg
    ? [[r0(raw.reduce((a, b) => a + b, 0) / raw.length), ch.unit, "átl."], [r0(q(0.99)), ch.unit, "max"]]
    : [[r0(sorted[sorted.length - 1]), "m", "max"], [r0(sorted[0]), "m", "min"]];
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const base = box.y + 6.6 * s;
  const fVal = `700 ${8.4 * s}px ${FONT}`, fUnit = `500 ${6.4 * s}px ${FONT}`, fLab = `500 ${6.4 * s}px ${FONT}`;
  let xr = box.x + box.w;
  for (let k = items.length - 1; k >= 0; k--) {
    const [val, unit, lab] = items[k];
    const parts = [[String(val), fVal, c.panelText || color], [unit, fUnit, c.panelMuted], [lab, fLab, c.panelMuted]];
    const gaps = [0, 1.2 * s, 2.6 * s];
    const widths = parts.map(([t, f]) => { ctx.font = f; return ctx.measureText(t).width; });
    const total = widths.reduce((a, b) => a + b, 0) + gaps[1] + gaps[2];
    let x = xr - total;
    parts.forEach(([t, f, col], i) => { x += gaps[i]; ctx.font = f; ctx.fillStyle = col; ctx.fillText(t, x, base); x += widths[i]; });
    xr -= total + 9 * s;
  }
  ctx.restore();

  // Csík: a skála a (kilógó csúcsok nélküli) tartományra illeszkedik
  const top = box.y + 11 * s;
  let min = ch.avg ? q(0.02) : sorted[0];
  let max = ch.avg ? q(0.99) : sorted[sorted.length - 1];
  const range = Math.max(max - min, ch.minRange);
  const mid = (min + max) / 2;
  const lo = mid - range / 2;
  const toY = (v) => top + box.h - Math.max(0, Math.min(1, (v - lo) / range)) * box.h;
  const toX = (x) => box.x + (x / d) * box.w;
  const dark = c.panel === "#14181c" || c.photo || overlay;
  ctx.save();
  // Szaggatott rácsvonalak (alsó, közép, felső)
  ctx.strokeStyle = dark ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.09)";
  ctx.lineWidth = 0.5 * s;
  ctx.setLineDash([2 * s, 2 * s]);
  [0, 0.5, 1].forEach((f) => {
    const y = Math.round(top + box.h * f) + 0.5;
    ctx.beginPath(); ctx.moveTo(box.x, y); ctx.lineTo(box.x + box.w, y); ctx.stroke();
  });
  ctx.setLineDash([]);
  // Halvány, lefelé elhalványuló kitöltés
  ctx.beginPath();
  ctx.moveTo(toX(series[0].x), top + box.h);
  series.forEach((p) => ctx.lineTo(toX(p.x), toY(p.v)));
  ctx.lineTo(toX(series[series.length - 1].x), top + box.h);
  ctx.closePath();
  if (overlay) ctx.fillStyle = c.elevFill;
  else {
    const g = ctx.createLinearGradient(0, top, 0, top + box.h);
    g.addColorStop(0, hexA(lineColor, dark ? 0.32 : 0.22));
    g.addColorStop(1, hexA(lineColor, 0.02));
    ctx.fillStyle = g;
  }
  ctx.fill();
  ctx.beginPath();
  series.forEach((p, i) => (i ? ctx.lineTo(toX(p.x), toY(p.v)) : ctx.moveTo(toX(p.x), toY(p.v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4 * s;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// ── Segédek ──────────────────────────────────────────────────────────────────

function hav(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function drawPath(ctx, pts) {
  ctx.beginPath();
  pts.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
  ctx.stroke();
}

function drawDot(ctx, x, y, r, fill, border, borderW) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (border) { ctx.strokeStyle = border; ctx.lineWidth = borderW; ctx.stroke(); }
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitOneLine(ctx, text, x, y, maxWidth) {
  let t = String(text);
  if (ctx.measureText(t).width <= maxWidth) { ctx.fillText(t, x, y); return; }
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  ctx.fillText(t + "…", x, y);
}
