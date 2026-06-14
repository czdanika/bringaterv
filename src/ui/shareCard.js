/**
 * Bringaterv – Workout Share Card Generator
 * ==========================================
 * Canvas-alapú megosztó kép – „Tiszta / minimalista" dizájn.
 * A teljes elrendezés 360px-es alapra van tervezve, és scale = width/360
 * faktorral skálázódik bármilyen méretre.
 *
 *   square : 1080×1080 (1:1)
 *   story  : 1080×1920 (9:16)   – a térkép-terület tölti ki a magasságot
 *
 * A header (96) és a stat-sáv (80) magassága fix (skálázva), a térkép a
 * kettő közti teret tölti ki.
 */

const BASE = 360;
const HEADER_H = 96;   // base px
const STATBAR_H = 80;  // base px
const SLOGAN = "Tervezz · Tekerj · Fedezd fel!";

// Logo képobjektum – egyszer töltjük be, cache-eljük
let _logoCache = null;
function loadLogo() {
  if (_logoCache) return _logoCache;
  _logoCache = new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = "/src/assets/logo.png";
  });
  return _logoCache;
}

function palette(theme) {
  if (theme === "dark") {
    return {
      cardBg:    "#1a2228",
      header:    "#e8461e",
      mapTop:    "#232d34",
      mapBottom: "#1c2429",
      statBar:   "#232d34",
      statNum:   "#ffffff",
      statLabel: "#8a97a0",
      route:     "#ff6a3d",
      startDot:  "#ff6a3d",
      endDot:    "#ffffff",
      endCore:   "#1a2228",
      dotBorder: "#1a2228",
      grid:      "rgba(255,255,255,0.07)",
      topBorder: "rgba(255,255,255,0.10)",
      sep:       "rgba(255,255,255,0.08)",
      watermark: "rgba(255,255,255,0.28)",
    };
  }
  return {
    cardBg:    "#f5f2eb",
    header:    "#e8461e",
    mapTop:    "#f0ede6",
    mapBottom: "#e8e4db",
    statBar:   "#ffffff",
    statNum:   "#2d4a5a",
    statLabel: "#aaaaaa",
    route:     "#e8461e",
    startDot:  "#e8461e",
    endDot:    "#2d4a5a",
    endCore:   "#ffffff",
    dotBorder: "#f5f2eb",
    grid:      "rgba(0,0,0,0.06)",
    topBorder: "rgba(0,0,0,0.08)",
    sep:       "rgba(0,0,0,0.07)",
    watermark: "rgba(0,0,0,0.2)",
  };
}

const FONT = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Async – Promise<HTMLCanvasElement> */
export async function createWorkoutShareCard({
  title = "Bringaterv edzés",
  date = "",
  distanceKm = 0,
  durationText = "",
  avgSpeedKmh = 0,
  elevationM = 0,
  points = [],
  theme = "light",            // "light" | "dark"
  size = "square",            // "square" | "story"
  backgroundImage = null,     // opcionális HTMLImageElement a térkép-területre
}) {
  const dim = size === "story"
    ? { width: 1080, height: 1920 }
    : { width: 1080, height: 1080 };

  const s = dim.width / BASE;
  const c = palette(theme);

  const [canvas, logoImg] = await Promise.all([
    Promise.resolve(document.createElement("canvas")),
    loadLogo(),
  ]);
  canvas.width  = dim.width;
  canvas.height = dim.height;
  const ctx = canvas.getContext("2d");

  const W = canvas.width, H = canvas.height;
  const headerH  = HEADER_H * s;
  const statBarH = STATBAR_H * s;
  const statBarY = H - statBarH;
  const mapY = headerH;
  const mapH = statBarY - headerH;

  // Lekerekített kártya-klip (a header/stat-sáv sarkai is követik)
  ctx.save();
  roundRectPath(ctx, 0, 0, W, H, 16 * s);
  ctx.clip();

  // 1. Alap háttér
  ctx.fillStyle = c.cardBg;
  ctx.fillRect(0, 0, W, H);

  // 5–6. Térkép terület + rácsozat (a route alá)
  drawMapArea(ctx, c, s, { x: 0, y: mapY, w: W, h: mapH }, backgroundImage);

  // 7. Útvonal
  drawRoute(ctx, c, s, points, { x: 0, y: mapY, w: W, h: mapH });

  // 2. Header sáv
  ctx.fillStyle = c.header;
  ctx.fillRect(0, 0, W, headerH);

  // 3–4. Logó + brand szöveg
  drawHeaderContent(ctx, s, logoImg, title, date);

  // 8–11. Stat sáv
  drawStatBar(ctx, c, s, { y: statBarY, w: W, h: statBarH }, {
    distanceKm, durationText, avgSpeedKmh, elevationM,
  });

  ctx.restore();
  return canvas;
}

export function downloadShareCard(canvas, filename = "bringaterv-share.png") {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url  = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href     = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

// ── Header ───────────────────────────────────────────────────────────────────

function drawHeaderContent(ctx, s, logoImg, title, date) {
  // Logó kör
  const cx = 44 * s, cy = 50 * s, r = 26 * s;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.15)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  if (logoImg) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(logoImg, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${20 * s}px ${FONT}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("BT", cx, cy + 1 * s);
  }
  ctx.restore();

  const tx = 78 * s;

  // Brand „Bringa" + „terv"
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.font = `700 ${22 * s}px ${FONT}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText("Bringa", tx, 44 * s);
  const bringaW = ctx.measureText("Bringa").width;
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fillText("terv", tx + bringaW, 44 * s);

  // Szlogen
  ctx.font = `400 ${11 * s}px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.fillText(SLOGAN, tx, 62 * s);

  // Edzés neve + dátum
  const nameLine = [title, date].filter(Boolean).join("  ·  ");
  ctx.font = `600 ${13 * s}px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  fitOneLine(ctx, nameLine, tx, 84 * s, (360 - 78 - 14) * s);
}

// ── Térkép terület ───────────────────────────────────────────────────────────

function drawMapArea(ctx, c, s, rect, bgImage) {
  const grad = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
  grad.addColorStop(0, c.mapTop);
  grad.addColorStop(1, c.mapBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  // Opcionális háttérkép (cover) + sötét overlay a kontrasztért
  if (bgImage) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    drawCoverImage(ctx, bgImage, rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
    return; // rácsozat fotó fölött nem kell
  }

  // Rácsozat – 4 vízszintes, 3 függőleges, arányosan
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = Math.max(1, 0.5 * s);
  ctx.beginPath();
  for (let i = 1; i <= 4; i++) {
    const y = rect.y + (rect.h * i) / 5;
    ctx.moveTo(rect.x, y); ctx.lineTo(rect.x + rect.w, y);
  }
  for (let j = 1; j <= 3; j++) {
    const x = rect.x + (rect.w * j) / 4;
    ctx.moveTo(x, rect.y); ctx.lineTo(x, rect.y + rect.h);
  }
  ctx.stroke();
}

// ── Útvonal ──────────────────────────────────────────────────────────────────

function drawRoute(ctx, c, s, points, mapRect) {
  if (!points || points.length < 2) {
    ctx.fillStyle = c.statLabel;
    ctx.font = `600 ${13 * s}px ${FONT}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("Nincs útvonaladat", mapRect.x + mapRect.w / 2, mapRect.y + mapRect.h / 2);
    return;
  }

  const box = {
    x: mapRect.x + 14 * s,
    y: mapRect.y + 14 * s,
    w: mapRect.w - 28 * s,
    h: mapRect.h - 28 * s,
  };
  const pts = projectPoints(points, box);

  // Árnyék-vonal
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.12)";
  ctx.shadowBlur  = 6 * s;
  ctx.strokeStyle = "rgba(0,0,0,0.10)";
  ctx.lineWidth   = 6 * s;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  drawPath(ctx, pts);
  ctx.restore();

  // Fő vonal
  ctx.strokeStyle = c.route;
  ctx.lineWidth   = 3 * s;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  drawPath(ctx, pts);

  const start = pts[0], end = pts[pts.length - 1];
  // Start pont (narancs teli)
  drawDot(ctx, start.x, start.y, 6 * s, c.startDot, c.dotBorder, 2 * s);
  // Vég pont (sötét, belül világos mag)
  drawDot(ctx, end.x, end.y, 7 * s, c.endDot, c.dotBorder, 2 * s);
  ctx.fillStyle = c.endCore;
  ctx.beginPath();
  ctx.arc(end.x, end.y, 3 * s, 0, Math.PI * 2);
  ctx.fill();
}

// ── Stat sáv ─────────────────────────────────────────────────────────────────

function drawStatBar(ctx, c, s, rect, stats) {
  ctx.fillStyle = c.statBar;
  ctx.fillRect(0, rect.y, rect.w, rect.h);

  // Felső szegély
  ctx.strokeStyle = c.topBorder;
  ctx.lineWidth = Math.max(1, 0.5 * s);
  ctx.beginPath();
  ctx.moveTo(0, rect.y); ctx.lineTo(rect.w, rect.y);
  ctx.stroke();

  // Elválasztók
  ctx.strokeStyle = c.sep;
  ctx.beginPath();
  for (let j = 1; j <= 3; j++) {
    const x = (rect.w * j) / 4;
    ctx.moveTo(x, rect.y + 12 * s); ctx.lineTo(x, rect.y + 68 * s);
  }
  ctx.stroke();

  const items = [
    [`${formatNumber(stats.distanceKm, 1)}`, "KM · TÁV"],
    [stats.durationText || "–",              "IDŐ"],
    [`${formatNumber(stats.avgSpeedKmh, 1)}`, "KM/H ÁTLAG"],
    [`${Math.round(stats.elevationM || 0)} m`, "SZINT"],
  ];

  const numY   = rect.y + 35 * s;
  const labelY = rect.y + 50 * s;

  items.forEach(([value, label], i) => {
    const cx = rect.w * ((i * 2 + 1) / 8);   // 0.125, 0.375, 0.625, 0.875

    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = c.statNum;
    fitCentered(ctx, value, cx, numY, rect.w / 4 - 10 * s, 22 * s);

    ctx.fillStyle = c.statLabel;
    ctx.font = `400 ${9 * s}px ${FONT}`;
    ctx.letterSpacing = `${0.06 * 9 * s}px`;
    ctx.fillText(label, cx, labelY);
    ctx.letterSpacing = "0px";
  });

  // Domain watermark
  ctx.fillStyle = c.watermark;
  ctx.font = `400 ${9 * s}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.letterSpacing = `${0.05 * 9 * s}px`;
  ctx.fillText("bringaterv.hu", rect.w / 2, rect.y + rect.h - 8 * s);
  ctx.letterSpacing = "0px";
}

// ── Segéd-geometria / rajz ───────────────────────────────────────────────────

function projectPoints(points, box) {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const latRange = Math.max(maxLat - minLat, 1e-6);
  const lngRange = Math.max(maxLng - minLng, 1e-6);
  const scale = Math.min(box.w / lngRange, box.h / latRange);
  const routeW = lngRange * scale, routeH = latRange * scale;
  const offX = box.x + (box.w - routeW) / 2;
  const offY = box.y + (box.h - routeH) / 2;
  return points.map((p) => ({
    x: offX + (p.lng - minLng) * scale,
    y: offY + (maxLat - p.lat) * scale,
  }));
}

function drawPath(ctx, pts) {
  ctx.beginPath();
  pts.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
  ctx.stroke();
}

function drawDot(ctx, x, y, r, fill, border, borderW) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = borderW;
    ctx.stroke();
  }
}

function drawCoverImage(ctx, img, x, y, w, h) {
  const ir = img.width / img.height, br = w / h;
  let dw, dh, dx, dy;
  if (ir > br) { dh = h; dw = h * ir; dx = x - (dw - w) / 2; dy = y; }
  else         { dw = w; dh = w / ir; dx = x; dy = y - (dh - h) / 2; }
  ctx.drawImage(img, dx, dy, dw, dh);
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

function fitOneLine(ctx, text, x, y, maxWidth) {
  let t = String(text);
  if (ctx.measureText(t).width <= maxWidth) { ctx.fillText(t, x, y); return; }
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  ctx.fillText(t + "…", x, y);
}

function fitCentered(ctx, text, x, y, maxWidth, baseSize) {
  let size = baseSize;
  do {
    ctx.font = `700 ${size}px ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 1 * (baseSize / 22);
  } while (size > baseSize * 0.6);
  ctx.fillText(text, x, y);
}

function formatNumber(value, decimals = 1) {
  return Number(value || 0).toFixed(decimals);
}
