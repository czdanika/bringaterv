/**
 * Bringaterv – Workout Share Card Generator
 * ==========================================
 * Canvas-alapú megosztó kép létrehozása edzésekhez.
 * 1080×1080 (négyzet) vagy 1080×1920 (sztori) formátum.
 */

// Logo képobjektum – egyszer töltjük be, cache-eljük
let _logoCache = null;
function loadLogo() {
  if (_logoCache) return _logoCache;
  _logoCache = new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);  // ha nem tölthető, fallback a "BT" szövegre
    img.src = "/src/assets/logo.png";
  });
  return _logoCache;
}

/** Async – Promise<HTMLCanvasElement> */
export async function createWorkoutShareCard({
  title = "Bringaterv edzés",
  date = "",
  distanceKm = 0,
  durationText = "",
  avgSpeedKmh = 0,
  elevationM = 0,
  points = [],
  theme = "dark",   // "dark" | "light"
  size = "square",  // "square" | "story"
}) {
  const dimensions = size === "story"
    ? { width: 1080, height: 1920 }
    : { width: 1080, height: 1080 };

  const colors = theme === "dark"
    ? {
        bg:     "#111713",
        panel:  "#18211c",
        text:   "#ffffff",
        muted:  "#aab5ae",
        accent: "#fc4c02",
        route:  "#ffffff",
      }
    : {
        bg:     "#f7f7f4",
        panel:  "#ffffff",
        text:   "#111713",
        muted:  "#606a64",
        accent: "#fc4c02",
        route:  "#111713",
      };

  const [canvas, logoImg] = await Promise.all([
    Promise.resolve(document.createElement("canvas")),
    loadLogo(),
  ]);
  canvas.width  = dimensions.width;
  canvas.height = dimensions.height;

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawHeader(ctx, canvas, colors, title, date, logoImg);
  drawRoute(ctx, canvas, colors, points, size);
  drawStats(ctx, canvas, colors, {
    distanceKm,
    durationText,
    avgSpeedKmh,
    elevationM,
  });
  drawBrand(ctx, canvas, colors);

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

// ── Belső rajzoló függvények ──────────────────────────────────────────────────

function drawHeader(ctx, canvas, colors, title, date, logoImg) {
  const LOGO_SIZE = 120;
  const LOGO_X    = 60;
  const LOGO_Y    = 50;

  if (logoImg) {
    // Valódi logo – négyzetes clip + lekerekített sarok
    ctx.save();
    roundRect(ctx, LOGO_X, LOGO_Y, LOGO_SIZE, LOGO_SIZE, 22);
    ctx.clip();
    ctx.drawImage(logoImg, LOGO_X, LOGO_Y, LOGO_SIZE, LOGO_SIZE);
    ctx.restore();
  } else {
    // Fallback: narancs "BT" négyzet
    ctx.fillStyle = colors.accent;
    roundRect(ctx, LOGO_X, LOGO_Y, LOGO_SIZE, LOGO_SIZE, 22);
    ctx.fill();
    ctx.fillStyle    = "#fff";
    ctx.font         = "800 40px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("BT", LOGO_X + LOGO_SIZE / 2, LOGO_Y + LOGO_SIZE / 2);
  }

  const textX = LOGO_X + LOGO_SIZE + 24;

  // Cím – vertikálisan középre a logóhoz képest
  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle    = colors.text;
  ctx.font         = "800 54px system-ui, -apple-system, Segoe UI, sans-serif";
  wrapText(ctx, title, textX, LOGO_Y + 50, canvas.width - textX - 60, 62, 2);

  // Dátum
  ctx.fillStyle = colors.muted;
  ctx.font      = "600 28px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText(date, textX, LOGO_Y + LOGO_SIZE - 4);
}

function drawRoute(ctx, canvas, colors, points, size) {
  const box = size === "story"
    ? { x: 90, y: 320, w: canvas.width - 180, h: 760 }
    : { x: 90, y: 260, w: canvas.width - 180, h: 440 };

  ctx.fillStyle = colors.panel;
  roundRect(ctx, box.x, box.y, box.w, box.h, 28);
  ctx.fill();

  if (!points || points.length < 2) {
    ctx.fillStyle    = colors.muted;
    ctx.font         = "700 32px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Nincs útvonaladat", canvas.width / 2, box.y + box.h / 2);
    return;
  }

  const projected = projectPoints(points, box);

  // Glow árnyék
  ctx.strokeStyle = "rgba(252, 76, 2, 0.18)";
  ctx.lineWidth   = 26;
  ctx.lineCap     = "round";
  ctx.lineJoin    = "round";
  drawPath(ctx, projected);

  // Fő vonal
  ctx.strokeStyle = colors.route;
  ctx.lineWidth   = 12;
  drawPath(ctx, projected);

  const start = projected[0];
  const end   = projected[projected.length - 1];

  drawPoint(ctx, start.x, start.y, "#19a974");   // zöld start
  drawPoint(ctx, end.x,   end.y,   colors.accent); // narancs cél
}

function drawStats(ctx, canvas, colors, stats) {
  const y = canvas.height > 1200 ? 1160 : 760;
  const x = 64;
  const w = canvas.width - 128;
  const h = 210;

  ctx.fillStyle = colors.panel;
  roundRect(ctx, x, y, w, h, 28);
  ctx.fill();

  const items = [
    ["TÁV",    `${formatNumber(stats.distanceKm, 1)} km`],
    ["IDŐ",    stats.durationText || "-"],
    ["ÁTLAG",  `${formatNumber(stats.avgSpeedKmh, 1)} km/h`],
    ["SZINT",  `${Math.round(stats.elevationM || 0)} m`],
  ];

  const colW = w / items.length;

  items.forEach(([label, value], index) => {
    const cx = x + colW * index + 28;

    ctx.fillStyle    = colors.muted;
    ctx.font         = "800 24px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign    = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(label, cx, y + 72);

    ctx.fillStyle = colors.text;
    ctx.font      = "900 38px system-ui, -apple-system, Segoe UI, sans-serif";
    fitText(ctx, value, cx, y + 128, colW - 46, 38);
  });
}

function drawBrand(ctx, canvas, colors) {
  ctx.fillStyle    = colors.muted;
  ctx.font         = "700 26px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("Made with Bringaterv", canvas.width / 2, canvas.height - 56);
}

// ── Segéd-geometria ───────────────────────────────────────────────────────────

function projectPoints(points, box) {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);

  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const latRange = Math.max(maxLat - minLat, 0.000001);
  const lngRange = Math.max(maxLng - minLng, 0.000001);

  const padding = 56;
  const usableW = box.w - padding * 2;
  const usableH = box.h - padding * 2;
  const scale   = Math.min(usableW / lngRange, usableH / latRange);

  const routeW  = lngRange * scale;
  const routeH  = latRange * scale;
  const offsetX = box.x + (box.w - routeW) / 2;
  const offsetY = box.y + (box.h - routeH) / 2;

  return points.map((p) => ({
    x: offsetX + (p.lng - minLng) * scale,
    y: offsetY + (maxLat - p.lat) * scale,
  }));
}

function drawPath(ctx, points) {
  ctx.beginPath();
  points.forEach((pt, i) => {
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else         ctx.lineTo(pt.x, pt.y);
  });
  ctx.stroke();
}

function drawPoint(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 15, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#fff";
  ctx.lineWidth   = 6;
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = String(text).split(" ");
  let line  = "";
  let lines = [];

  words.forEach((word) => {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = testLine;
    }
  });

  if (line) lines.push(line);
  lines = lines.slice(0, maxLines);
  lines.forEach((item, index) => ctx.fillText(item, x, y + index * lineHeight));
}

function fitText(ctx, text, x, y, maxWidth, baseSize) {
  let size = baseSize;
  do {
    ctx.font = `900 ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  } while (size > 22);
  ctx.fillText(text, x, y);
}

function formatNumber(value, decimals = 1) {
  return Number(value || 0).toFixed(decimals);
}
