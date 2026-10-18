import { num } from "../format.js";
import { ensureQR, buildQrCanvas } from "./routePdf.js";
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
 * Ha a térképcsempék nem tölthetők be (offline), sima háttérszín marad.
 */

const BASE = 360;
const FONT = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";
const BRAND_FONT = "Montserrat, Inter, system-ui, sans-serif";
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
};

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
  theme = "light",            // "light" | "dark" | "photo"
  size = "square",            // "square" | "story"
  photo = null,               // { img, scale, offsetX, offsetY, blur, headerBg, routeColor, routeOffsetX/Y, routeScale }
  qrUrl = null,               // nyilvános nézőoldal linkje → kis QR-kód a panelen
}) {
  const dim = size === "story" ? { width: 1080, height: 1920 } : { width: 1080, height: 1080 };
  const s = dim.width / BASE;
  const c = palette(theme);
  const W = dim.width, H = dim.height;

  // A canvas csak betöltött betűtípussal rajzol szépen – várjunk rá (ha elérhető)
  try { await Promise.all([document.fonts?.load(`800 20px Montserrat`), document.fonts?.load(`800 20px Inter`)]); } catch {}

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  const stats = statItems({ distanceKm, durationText, avgSpeedKmh, elevationM });
  const hasElev = points.filter((p) => Number.isFinite(p.ele)).length > 10;
  const panelBg = theme === "photo" ? (photo?.headerBg || "translucent") : "solid";

  // Panel-magasság: cím + dátum + (szintprofil) + adatsor
  const head = Math.max(date ? 56 : 44, qrUrl ? 62 : 0);
  const panelH = head + (hasElev ? 30 : 6) + 62;
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
  drawPanel(ctx, c, s, panel, { title, date, stats, points: hasElev ? valid : null, panelBg, qr });

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
    { url: tiles.base, z: Math.min(MAX_ZOOM, Math.max(1, Math.floor(zLogical) + 2)) },  // éles alap
    { url: tiles.ref,  z: Math.min(MAX_ZOOM, Math.max(1, Math.floor(zLogical) + 1)), alpha: 0.95 },  // feliratok, olvasható méretben
  ];
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
    const ox = (opts.offsetX || 0) * s, oy = (opts.offsetY || 0) * s;
    const sc = Math.max(0.2, opts.scale || 1);
    const bcx = opts.box.x + opts.box.w / 2, bcy = opts.box.y + opts.box.h / 2;
    pts = pts.map((p) => ({ x: bcx + (p.x - bcx) * sc + ox, y: bcy + (p.y - bcy) * sc + oy }));
  }
  const color = opts?.color || c.route;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  // Körvonal (világos térképen fehér, sötéten / fotón árnyék)
  ctx.strokeStyle = c.casing;
  ctx.lineWidth = 6.5 * s;
  if (c.photo) { ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 6 * s; }
  drawPath(ctx, pts);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.6 * s;
  drawPath(ctx, pts);
  ctx.restore();

  const a = pts[0], b = pts[pts.length - 1];
  const loop = Math.hypot(a.x - b.x, a.y - b.y) < 8 * s;   // körtúra: rajt = cél
  drawDot(ctx, a.x, a.y, 5.5 * s, c.start, "#ffffff", 2 * s);
  if (!loop) {
    drawDot(ctx, b.x, b.y, 6 * s, c.end, "#ffffff", 2 * s);
    drawDot(ctx, b.x, b.y, 2.4 * s, c.endCore, null, 0);
  }
}

// ── Logó-jelvény ─────────────────────────────────────────────────────────────

function drawBadge(ctx, c, s, logo) {
  const x = 12 * s, y = 12 * s, h = 26 * s;
  ctx.font = `800 ${11.5 * s}px ${BRAND_FONT}`;
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

function drawPanel(ctx, c, s, rect, { title, date, stats, points, panelBg, qr }) {
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
  ctx.font = `800 ${17 * s}px ${BRAND_FONT}`;
  fitOneLine(ctx, title || "Bringaterv", padX, y, textW);
  y += 23 * s;
  if (date) {
    ctx.fillStyle = c.panelMuted;
    ctx.font = `500 ${10.5 * s}px ${FONT}`;
    fitOneLine(ctx, date, padX, y, textW);
    y += 14 * s;
  }

  // Szintprofil-csík (a QR mellett végig – a QR alá nem lóg)
  if (points) {
    y += 6 * s;
    const minY = qr ? rect.y + 12 * s + qrBox + 6 * s : 0;
    if (y < minY) y = minY;
    drawElevation(ctx, c, s, points, { x: padX, y, w: rect.w - padX * 2, h: 20 * s });
    y += 24 * s;
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
    let size = 21;
    const maxW = colW - (i > 0 ? 14 : 4) * s;
    let vw, uw;
    do {
      ctx.font = `800 ${size * s}px ${FONT}`;
      vw = ctx.measureText(it.value).width;
      ctx.font = `600 ${size * 0.5 * s}px ${FONT}`;
      uw = it.unit ? ctx.measureText(it.unit).width + 3 * s : 0;
      size -= 1;
    } while (vw + uw > maxW && size > 12);
    size += 1;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = c.panelText;
    ctx.font = `800 ${size * s}px ${FONT}`;
    ctx.fillText(it.value, tx, y + 21 * s);
    if (it.unit) {
      ctx.fillStyle = c.panelMuted;
      ctx.font = `600 ${size * 0.5 * s}px ${FONT}`;
      ctx.fillText(it.unit, tx + vw + 3 * s, y + 21 * s);
    }
    ctx.fillStyle = c.panelMuted;
    ctx.font = `600 ${7.5 * s}px ${FONT}`;
    ctx.letterSpacing = `${0.8 * s}px`;
    ctx.fillText(it.label, tx, y + 34 * s);
    ctx.letterSpacing = "0px";
  });
}

function drawElevation(ctx, c, s, points, box) {
  // Táv szerinti x-tengely (haversine), magasság szerinti y
  const pts = points.filter((p) => Number.isFinite(p.ele));
  let d = 0;
  const xs = [0];
  for (let i = 1; i < pts.length; i++) { d += hav(pts[i - 1], pts[i]); xs.push(d); }
  if (d <= 0) return;
  const eles = pts.map((p) => p.ele);
  const min = Math.min(...eles), max = Math.max(...eles);
  const range = Math.max(max - min, 20);   // lapos útnál se legyen „fűrészfog”
  const mid = (min + max) / 2;
  const toY = (e) => box.y + box.h - ((e - (mid - range / 2)) / range) * box.h;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(box.x, box.y + box.h);
  pts.forEach((p, i) => ctx.lineTo(box.x + (xs[i] / d) * box.w, toY(p.ele)));
  ctx.lineTo(box.x + box.w, box.y + box.h);
  ctx.closePath();
  ctx.fillStyle = c.elevFill;
  ctx.fill();
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = box.x + (xs[i] / d) * box.w, y = toY(p.ele);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = c.elevLine;
  ctx.lineWidth = 1.2 * s;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();
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
