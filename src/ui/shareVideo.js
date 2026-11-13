/**
 * Bringaterv – animált megosztás (videó)
 * ======================================
 * A nyomvonal kirajzolódik, a számok pörögnek, alul halad a szintprofil, a végén az
 * összegzés áll meg. A böngészőben készül (canvas → MediaRecorder), szerver nélkül:
 * MP4, ahol a böngésző tudja (Safari, újabb Chrome), különben WebM.
 *
 * Háttér: térkép (világos / sötét / terep), egyszínű, saját fotó vagy videó, zöld
 * (videószerkesztőben kivágható – a CapCut / InShot „chroma key”).
 *
 *   VIDEO_BGS, VIDEO_DURATIONS
 *   videoSupported()                         → bool
 *   createVideoScene(opts)                   → Promise<scene>   { W, H, duration, draw(ctx, t), restart() }
 *   playScene(canvas, scene)                 → stop()           előnézet, végtelenítve
 *   recordScene(canvas, scene, {onProgress}) → Promise<{ blob, ext, mime }>
 *   loadVideoMedia(file)                     → Promise<{ kind: "image"|"video", el }>
 */
import { num } from "../format.js";
import { _cardKit, SHARE_SIZES, DEFAULT_STATS, SHARE_CHARTS, BADGE } from "./shareCard.js";
import { buildHrZoneColorFn, getZoneColor, gradeColorForGrade, getChartColors } from "./settings.js";

// (a shareCard.js körkörösen töltődik be – a segédeket csak használatkor vesszük ki)

export const VIDEO_BGS = [
  { id: "map",   label: "Térkép" },
  { id: "solid", label: "Egyszínű" },
  { id: "media", label: "Saját fotó / videó" },
  { id: "green", label: "Zöld háttér" },
];
export const VIDEO_DURATIONS = [8, 12, 15];

// Térképtípusok (az app térképstílusai közül, amelyek CORS-szal vászonra rajzolhatók).
// light: világos kártyák (sötét szöveg) illenek hozzá; a többinél sötét, áttetsző kártyák.
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
export const VIDEO_MAPS = [
  { id: "light",     label: "Világos",  light: true,  tiles: { base: `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, ref: `${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}` }, bg: "#eceae6" },
  { id: "standard",  label: "Standard", light: true,  tiles: { base: "https://tile.openstreetmap.org/{z}/{x}/{y}.png" }, bg: "#f2efe9" },
  { id: "topo",      label: "Terep",    light: false, tiles: { base: `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`, filter: "saturate(1.45) contrast(1.06)" }, bg: "#dfe8d4" },
  { id: "satellite", label: "Műhold",   light: false, tiles: { base: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, ref: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}` }, bg: "#1d2a1f" },
  { id: "dark",      label: "Sötét",    light: false, tiles: { base: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, ref: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}` }, bg: "#1e2328" },
];

const GREEN = "#00b140";

// ── Térképcsempék a videóhoz: képkockánként rajzolva a kamera szerint (éles közelről is) ──
const _tiles = new Map();   // url → { img, p }
function tile(url) {
  let e = _tiles.get(url);
  if (!e) {
    if (_tiles.size > 2500) _tiles.clear();
    e = { img: null, p: null };
    e.p = new Promise((res) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => { e.img = im; res(); };
      im.onerror = () => { _tiles.delete(url); res(); };
      im.src = url;
    });
    _tiles.set(url, e);
  }
  return e;
}
const TILE_PX = 256, MAX_TILE_Z = 16;
const XF0 = 0.42, XF_W = 0.16;   // szintváltás: a zoomszint tört részének ennyinél kezdődik, ennyi ideig tart
const INTRO = 0.8;     // mp: a feliratok beúsznak
const OUTRO = 2.6;     // mp: a végén álló összegzés
const LOOP_GAP = 0.6;  // az előnézet ismétlése előtti szünet

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x) => 1 - (1 - x) ** 3;

function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  const list = ["video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1", "video/mp4",
                "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return list.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || null;
}

export function videoSupported() {
  return !!pickMime() && typeof HTMLCanvasElement !== "undefined" && !!HTMLCanvasElement.prototype.captureStream;
}
/** „mp4” vagy „webm” – amit ez a böngésző rögzíteni tud. */
export const videoFormat = () => (pickMime() || "").includes("mp4") ? "mp4" : "webm";

/** Saját háttér: kép vagy rövid videó (némítva, ismétlődve). */
export function loadVideoMedia(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    if (/^video\//.test(file.type)) {
      const v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = "auto";
      v.onloadeddata = () => resolve({ kind: "video", el: v });
      v.onerror = () => reject(new Error("A videó nem játszható le ebben a böngészőben."));
      v.src = url;
      v.load();
    } else {
      const img = new Image();
      img.onload = () => resolve({ kind: "image", el: img });
      img.onerror = () => reject(new Error("A kép nem olvasható."));
      img.src = url;
    }
  });
}

/** „1 ó 5 p” / „1:05” → másodperc */
function parseDuration(text) {
  const t = String(text || "").trim();
  const hm = t.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (hm) return (+hm[1]) * 3600 + (+hm[2]) * 60 + (+(hm[3] || 0));
  const h = +(t.match(/(\d+)\s*ó/)?.[1] || 0), m = +(t.match(/(\d+)\s*p/)?.[1] || 0);
  return h * 3600 + m * 60;
}
const clock = (sec) => {
  const s = Math.max(0, Math.round(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
};

function drawCover(ctx, el, W, H) {
  const iw = el.videoWidth || el.naturalWidth || el.width, ih = el.videoHeight || el.naturalHeight || el.height;
  if (!iw || !ih) return;
  const r = Math.max(W / iw, H / ih), dw = iw * r, dh = ih * r;
  ctx.drawImage(el, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

/**
 * A jelenet felépítése (térkép-csempék betöltése egyszer, utána képkockánként csak rajzolás).
 * opts: a megosztó kép adatai (title, date, distanceKm, durationText, avgSpeedKmh, elevationM,
 * points, extra) + { bg, media, size, duration, stats, showDate }
 */
export async function createVideoScene({
  title = "Bringaterv", date = "", distanceKm = 0, durationText = "", avgSpeedKmh = 0, elevationM = 0,
  points = [], extra = {}, bg = "dark", media = null, size = "story", duration = 12,
  stats: statKeys = DEFAULT_STATS, showDate = true,
  chart = "ele",               // a panel grafikonja: SHARE_CHARTS id vagy "none"
  zoneColors = null,           // zónaszínek (null → a Beállítások diagram-színmódja szerint)
  routeColors = false,         // a térképi nyomvonal is a grafikon zónaszíneivel
  map = "light",               // bg === "map": VIDEO_MAPS id
  titleAlign = "left",         // a cím (az alsó panel tetején): "left" | "center"
  autoZoom = true,             // a kamera közelről indul, és a nyomvonallal együtt távolodik
}) {
  const mapDef = VIDEO_MAPS.find((m) => m.id === map) || VIDEO_MAPS[0];
  if (zoneColors == null) { try { zoneColors = getChartColors().mode === "zones"; } catch { zoneColors = true; } }
  const { palette, fitProjection, drawTiles, loadLogo, roundRectPath, drawDot, fitOneLine, drawWordmark, drawBadge, hav,
          FONT, NUM_FONT } = _cardKit;
  const [W, H] = SHARE_SIZES[size === "square" ? "portrait" : size] || SHARE_SIZES.story;
  const s = W / 360;
  const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (pts.length < 2) throw new Error("Ehhez az edzéshez nincs nyomvonal.");
  try {
    await Promise.all([document.fonts?.load(`800 20px Montserrat`), document.fonts?.load(`700 20px Inter`),
                       document.fonts?.load(`600 20px 'Barlow Semi Condensed'`)]);
  } catch { /* betűtípus nélkül is rajzol */ }

  // ── adatsorok a nyomvonal mentén: táv, szint, idő (a végük = a kártya értéke) ──
  const n = pts.length;
  const d = new Float64Array(n), gain = new Float64Array(n);
  let eleS = pts[0].ele;
  for (let i = 1; i < n; i++) {
    d[i] = d[i - 1] + hav(pts[i - 1], pts[i]);
    let up = 0;
    if (Number.isFinite(pts[i].ele)) {
      const e = Number.isFinite(eleS) ? eleS * 0.7 + pts[i].ele * 0.3 : pts[i].ele;   // simítás
      if (Number.isFinite(eleS) && e > eleS) up = e - eleS;
      eleS = e;
    }
    gain[i] = gain[i - 1] + up;
  }
  const D = d[n - 1] || 1, G = gain[n - 1] || 1;
  const hasT = pts[0].t != null && pts[n - 1].t != null && pts[n - 1].t > pts[0].t;
  const tFrac = (i) => (hasT && pts[i].t != null ? (pts[i].t - pts[0].t) / (pts[n - 1].t - pts[0].t) : d[i] / D);
  const totalSec = parseDuration(durationText);
  const chDef = SHARE_CHARTS.find((c) => c.id === chart);
  const chOk = (v) => Number.isFinite(v) && (chart === "ele" || v > 0);
  const hasEle = !!chDef && pts.filter((p) => chOk(p[chart])).length > 10;   // van-e grafikon

  // ── elrendezés (360-as alapegységben × s) ──
  const M = 12 * s;   // mint a jelvények széle
  // felül a megosztó képpel azonos jelvény (bal: logó, jobb: dátum) – 12 / 30 egység, mint a drawBadge
  const head = { x: BADGE.x * s, y: BADGE.y * s, w: W - 2 * BADGE.x * s, h: BADGE.h * s };
  const titleH = 26 * s;   // a cím sora az alsó panel tetején
  const profH = hasEle ? (size === "portrait" ? 30 : 38) * s : 0;
  const panelH = 14 * s + titleH + (profH ? profH + 12 * s : 0) + 46 * s + 12 * s;
  const panel = { x: M, y: H - M - panelH, w: W - 2 * M, h: panelH };
  const gap = (size === "portrait" ? 12 : 18) * s;
  const routeBox = { x: M + 10 * s, y: head.y + head.h + gap, w: W - 2 * M - 20 * s, h: panel.y - (head.y + head.h) - 2 * gap };
  const proj = fitProjection(pts, routeBox);
  const xy = pts.map(proj.toPx);

  // ── színek ──
  const isLightMap = bg === "map" && mapDef.light;
  const ui = isLightMap
    ? { card: "rgba(255,255,255,0.94)", text: "#16191d", muted: "#6b7280", line: "rgba(0,0,0,0.08)",
        route: "#fc4c02", casing: "#ffffff", ghost: "rgba(252,76,2,0.22)", start: "#16a34a" }
    : bg === "green"
      ? { card: "#101418", text: "#ffffff", muted: "#a7b0ba", line: "rgba(255,255,255,0.12)",
          route: "#ff6a3d", casing: "#101418", ghost: "rgba(16,20,24,0.35)", start: "#ffffff" }
      : { card: "rgba(12,16,20,0.66)", text: "#ffffff", muted: "rgba(255,255,255,0.68)", line: "rgba(255,255,255,0.14)",
          route: "#ff6a3d", casing: "rgba(0,0,0,0.55)", ghost: "rgba(255,255,255,0.22)", start: "#22c55e" };

  // ── háttér előre megrajzolva (a saját videó kivételével, az képkockánként kerül alá) ──
  const bgCanvas = document.createElement("canvas");
  bgCanvas.width = W; bgCanvas.height = H;
  const b = bgCanvas.getContext("2d");
  if (bg === "map") {
    // a térkép képkockánként rajzolódik (drawMap) – itt nincs mit előre megrajzolni
  } else if (bg === "green") {
    b.fillStyle = GREEN; b.fillRect(0, 0, W, H);
  } else if (bg === "media" && media?.kind === "image") {
    b.fillStyle = "#11161a"; b.fillRect(0, 0, W, H);
    drawCover(b, media.el, W, H);
    b.fillStyle = "rgba(0,0,0,0.28)"; b.fillRect(0, 0, W, H);
  } else if (bg !== "media" || !media) {
    const g = b.createRadialGradient(W * 0.3, H * 0.2, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.85);
    g.addColorStop(0, "#1b2128"); g.addColorStop(1, "#0b0e11");
    b.fillStyle = g; b.fillRect(0, 0, W, H);
  }
  const liveVideo = bg === "media" && media?.kind === "video" ? media.el : null;
  const logo = await loadLogo();

  // ── profil (a panel felső sávja) ──
  const prof = { x: panel.x + 14 * s, y: panel.y + 14 * s + titleH, w: panel.w - 28 * s, h: profH };
  let profPts = null;
  let segColors = null;   // szakaszonkénti zónaszín (null → egyszínű)
  // a grafikon színe: szint – a márka narancsa, a többi a megszokott színe (mint a képen)
  const chColor = chart === "ele" ? ui.route : chDef?.color || ui.route;
  if (hasEle) {
    // simított sor (a pillanatnyi értékek ugrálnak), a hiányzó pontokon az előző érték
    const raw = pts.map((p) => (chOk(p[chart]) ? p[chart] : null));
    const k = chart === "ele" ? 0 : (chDef.smooth || 2) + 1;
    const sm = raw.map((v, i) => {
      if (!k) return v;
      let sum = 0, c = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) if (raw[j] != null) { sum += raw[j]; c++; }
      return c ? sum / c : null;
    });
    const vals = sm.filter((v) => v != null);
    const lo = chart === "ele" ? Math.min(...vals) : Math.min(...vals) * 0.85, hi = Math.max(...vals);
    const rng = Math.max(hi - lo, chDef.minRange || 10);
    let last = vals[0];
    // zónaszín, mint a webes grafikonon (Beállítások → Diagram színek: zónaszín mód)
    if (zoneColors || routeColors) {
      let fn = null;
      if (chart === "hr") fn = buildHrZoneColorFn();
      else if (chart === "speed" || chart === "cad" || chart === "power") fn = (v) => getZoneColor(chart, v);
      if (chart === "ele") {
        // lejtés a szakaszon (kis simítással), a térképes lejtés-jelmagyarázat színeivel
        const gr = sm.map((v, j) => (j < n - 1 && v != null && sm[j + 1] != null && d[j + 1] > d[j] ? ((sm[j + 1] - v) / (d[j + 1] - d[j])) * 100 : 0));
        segColors = gr.map((_, j) => {
          let sum = 0, c = 0;
          for (let q = Math.max(0, j - 4); q <= Math.min(n - 2, j + 4); q++) { sum += gr[q]; c++; }
          return gradeColorForGrade(c ? sum / c : 0);
        });
      } else if (fn) {
        segColors = sm.map((v) => (v != null ? fn(v) || chColor : chColor));
      }
    }
    profPts = pts.map((p, i) => {
      if (sm[i] != null) last = sm[i];
      return { x: prof.x + (d[i] / D) * prof.w, y: prof.y + prof.h - ((last - lo) / rng) * prof.h * 0.9 };
    });
  }

  const routeSeg = routeColors && segColors ? segColors : null;

  // ── a megjelenő adatok: pörgő (táv, idő, szint, kalória) és pillanatnyi → átlag ──
  const live = (k, i) => {
    let sum = 0, c = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) if (Number.isFinite(pts[j][k]) && pts[j][k] > 0) { sum += pts[j][k]; c++; }
    return c ? sum / c : null;
  };
  const STATS = {
    dist:  (f, i, end) => distanceKm > 0 && { label: "TÁV", unit: "km", value: num(end ? distanceKm : distanceKm * f.p, 1) },
    time:  (f, i, end) => totalSec > 0 && { label: "IDŐ", unit: "", value: clock(end ? totalSec : totalSec * f.t) },
    elev:  (f, i, end) => elevationM > 0 && { label: "SZINT", unit: "m", value: String(Math.round(end ? elevationM : elevationM * (gain[i] / G))) },
    kcal:  (f, i, end) => extra.kcal > 0 && { label: "KALÓRIA", unit: "kcal", value: String(Math.round(end ? extra.kcal : extra.kcal * f.t)) },
    speed: (f, i, end) => avgSpeedKmh > 0 && (end || live("speed", i) == null
      ? { label: "ÁTLAG", unit: "km/h", value: num(avgSpeedKmh, 1) }
      : { label: "SEBESSÉG", unit: "km/h", value: num(live("speed", i), 1) }),
    hr:    (f, i, end) => extra.hrAvg > 0 && { label: "PULZUS", unit: "bpm", value: String(Math.round(end || live("hr", i) == null ? extra.hrAvg : live("hr", i))) },
    power: (f, i, end) => extra.powerAvg > 0 && { label: "TELJ.", unit: "W", value: String(Math.round(end || live("power", i) == null ? extra.powerAvg : live("power", i))) },
    maxSpeed: (f, i, end) => extra.maxSpeed > 0 && { label: "MAX", unit: "km/h", value: num(extra.maxSpeed, 1) },
  };
  let keys = (statKeys?.length ? statKeys : DEFAULT_STATS).filter((k) => STATS[k] && STATS[k]({ t: 1, p: 1 }, n - 1, true)).slice(0, 4);
  if (!keys.length) keys = DEFAULT_STATS.filter((k) => STATS[k]({ t: 1, p: 1 }, n - 1, true));

  const drawStart = INTRO, drawEnd = Math.max(INTRO + 2, duration - OUTRO);

  // ── kamera: közelről indul, a megtett szakasszal együtt távolodik, a célnál a teljes útvonal ──
  const C = { x: routeBox.x + routeBox.w / 2, y: routeBox.y + routeBox.h / 2 };
  // legnagyobb ráközelítés: kb. 4×, de a csempék zoomszintje legfeljebb MAX_TILE_Z
  const zlFit = Math.log2(proj.worldPx / s / TILE_PX);
  const ZMAX = Math.max(1, Math.min(4, 2 ** (MAX_TILE_Z - 1 - zlFit)));
  const CAM_N = 160;
  let camK = null, camX = null, camY = null;
  function buildCamera() {
    const k = new Float64Array(CAM_N + 1), cx = new Float64Array(CAM_N + 1), cy = new Float64Array(CAM_N + 1);
    let minX = xy[0].x, maxX = xy[0].x, minY = xy[0].y, maxY = xy[0].y, j = 0;
    for (let q = 0; q <= CAM_N; q++) {
      const t = (q / CAM_N) * duration;
      const target = routeProgress(t) * D;
      while (j < n - 1 && d[j + 1] <= target) { j++; const pt = xy[j]; minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x); minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y); }
      if (j < n - 1) {   // a fej (a szakasz közepe is jó közelítés)
        const pt = xy[j + 1]; const r = clamp01((target - d[j]) / Math.max(1e-6, d[j + 1] - d[j]));
        const hx = xy[j].x + (pt.x - xy[j].x) * r, hy = xy[j].y + (pt.y - xy[j].y) * r;
        minX = Math.min(minX, hx); maxX = Math.max(maxX, hx); minY = Math.min(minY, hy); maxY = Math.max(maxY, hy);
      }
      const padX = Math.max(40 * s, (maxX - minX) * 0.25), padY = Math.max(40 * s, (maxY - minY) * 0.25);
      const bw = maxX - minX + 2 * padX, bh = maxY - minY + 2 * padY;
      k[q] = Math.max(1, Math.min(ZMAX, routeBox.w / bw, routeBox.h / bh));
      cx[q] = (minX + maxX) / 2; cy[q] = (minY + maxY) / 2;
      if (t >= drawEnd) { k[q] = 1; cx[q] = C.x; cy[q] = C.y; }
    }
    // simítás (előre-hátra, késés nélkül): a zoom log-skálán
    const smooth = (a, w) => a.map((_, i) => { let sum = 0, c = 0; for (let q = Math.max(0, i - w); q <= Math.min(CAM_N, i + w); q++) { sum += a[q]; c++; } return sum / c; });
    let lk = smooth(Array.from(k, Math.log), 10).map(Math.exp);
    let sx = smooth(Array.from(cx), 10), sy = smooth(Array.from(cy), 10);
    lk = smooth(lk, 6); sx = smooth(sx, 6); sy = smooth(sy, 6);
    // (a térkép csempékből rajzolódik, így a rajt a kép szélén is középre kerülhet – nincs szélkorlát)
    camK = lk; camX = sx; camY = sy;
  }
  function camAt(t) {
    if (!camK) return { k: 1, x: C.x, y: C.y };
    const f = clamp01(t / duration) * CAM_N, i0 = Math.floor(f), i1 = Math.min(CAM_N, i0 + 1), r = f - i0;
    return { k: camK[i0] + (camK[i1] - camK[i0]) * r, x: camX[i0] + (camX[i1] - camX[i0]) * r, y: camY[i0] + (camY[i1] - camY[i0]) * r };
  }
  let xyS = xy;   // a kamera szerinti képernyő-pontok (képkockánként)

  // a térkép rétegei: alap (+ feliratok); a zoomszint folytonos, két szint közt átúsztatva
  const mapLayers = bg === "map" ? [
    { url: mapDef.tiles.base, filter: mapDef.tiles.filter, dz: 1 },
    mapDef.tiles.ref && { url: mapDef.tiles.ref, dz: 1, alpha: 0.95, snap: true },   // feliratok: mindig egy szint (nincs szellemkép)
  ].filter(Boolean) : [];
  const zfOf = (k, layer) => Math.max(1, Math.min(MAX_TILE_Z, Math.log2(proj.worldPx * k / s / TILE_PX) + layer.dz));
  function tilesInView(cam, z) {
    const n2 = 2 ** z, wp = proj.worldPx;
    const u0 = proj.ox + (cam.x - C.x / cam.k) / wp, u1 = proj.ox + (cam.x + (W - C.x) / cam.k) / wp;
    const v0 = proj.oy + (cam.y - C.y / cam.k) / wp, v1 = proj.oy + (cam.y + (H - C.y) / cam.k) / wp;
    return { n2, x0: Math.floor(u0 * n2), x1: Math.floor(u1 * n2), y0: Math.max(0, Math.floor(v0 * n2)), y1: Math.min(n2 - 1, Math.floor(v1 * n2)) };
  }
  const tileUrl = (layer, z, tx, ty, n2) => layer.url.replace("{z}", z).replace("{x}", ((tx % n2) + n2) % n2).replace("{y}", ty);
  /** Az adott kamerához kellő csempék (két szomszédos zoomszint, egy csempe ráhagyással). */
  function neededTiles(cam, out) {
    for (const layer of mapLayers) {
      const zf = zfOf(cam.k, layer), z0 = Math.floor(zf);
      if (layer.snap) {
        const z = Math.floor(zf), r = tilesInView(cam, z);
        for (let ty = Math.max(0, r.y0 - 1); ty <= Math.min(r.n2 - 1, r.y1 + 1); ty++)
          for (let tx = r.x0 - 1; tx <= r.x1 + 1; tx++) out.add(tileUrl(layer, z, tx, ty, r.n2));
        continue;
      }
      for (const z of zf - z0 > XF0 - 0.04 && z0 < MAX_TILE_Z ? [z0, z0 + 1] : [z0]) {
        const r = tilesInView(cam, z);
        for (let ty = Math.max(0, r.y0 - 1); ty <= Math.min(r.n2 - 1, r.y1 + 1); ty++)
          for (let tx = r.x0 - 1; tx <= r.x1 + 1; tx++) out.add(tileUrl(layer, z, tx, ty, r.n2));
      }
    }
  }
  async function preloadTiles() {
    const urls = new Set();
    const steps = Math.max(20, Math.round(duration * 5));
    for (let q = 0; q <= steps; q++) neededTiles(autoZoom ? camAt((q / steps) * duration) : { k: 1, x: C.x, y: C.y }, urls);
    if (!autoZoom) neededTiles({ k: 1.05, x: C.x, y: C.y }, urls);
    await Promise.all([...urls].map((u) => tile(u).p));
  }
  function drawLevel(ctx, layer, cam, z, alpha) {
    const r = tilesInView(cam, z), wp = proj.worldPx * cam.k, size = wp / r.n2;
    ctx.save();
    ctx.globalAlpha = alpha * (layer.alpha ?? 1);
    if (layer.filter) ctx.filter = layer.filter;
    for (let ty = r.y0; ty <= r.y1; ty++) {
      for (let tx = r.x0; tx <= r.x1; tx++) {
        const e = _tiles.get(tileUrl(layer, z, tx, ty, r.n2));
        if (!e?.img) continue;
        const x = C.x + ((tx / r.n2 - proj.ox) * proj.worldPx - cam.x) * cam.k;
        const y = C.y + ((ty / r.n2 - proj.oy) * proj.worldPx - cam.y) * cam.k;
        ctx.drawImage(e.img, Math.floor(x), Math.floor(y), Math.ceil(size) + 1, Math.ceil(size) + 1);
      }
    }
    ctx.restore();
  }
  function drawMap(ctx, cam) {
    ctx.fillStyle = mapDef.bg; ctx.fillRect(0, 0, W, H);
    for (const layer of mapLayers) {
      const zf = zfOf(cam.k, layer), z0 = Math.floor(zf), f = zf - z0;
      if (layer.snap) { drawLevel(ctx, layer, cam, z0, 1); continue; }   // mint a megosztó képen (feliratréteg: alsó szint)
      drawLevel(ctx, layer, cam, z0, 1);
      // a következő szint rövid átúsztatással veszi át (hosszú átmenetnél a feliratok duplán látszanának)
      if (f > XF0 && z0 < MAX_TILE_Z) { const a = clamp01((f - XF0) / XF_W); drawLevel(ctx, layer, cam, z0 + 1, a * a * (3 - 2 * a)); }
    }
  }

  function routeProgress(t) {
    return easeInOut(clamp01((t - drawStart) / (drawEnd - drawStart)));
  }
  function indexAt(target) {
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (d[mid] <= target) lo = mid; else hi = mid - 1; }
    return lo;
  }

  function drawRoutePart(ctx, i, frac) {
    const a = xyS[i], bb = xyS[Math.min(n - 1, i + 1)];
    const hx = a.x + (bb.x - a.x) * frac, hy = a.y + (bb.y - a.y) * frac;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const path = () => { ctx.beginPath(); ctx.moveTo(xyS[0].x, xyS[0].y); for (let j = 1; j <= i; j++) ctx.lineTo(xyS[j].x, xyS[j].y); ctx.lineTo(hx, hy); ctx.stroke(); };
    ctx.strokeStyle = ui.casing; ctx.lineWidth = 6 * s; path();
    if (routeSeg) {
      // színezett nyomvonal: szakaszonként a zóna színével
      ctx.lineWidth = 3.4 * s;
      for (let j = 0; j <= i && j < n - 1; j++) {
        const q = xyS[j + 1], to = j === i ? { x: hx, y: hy } : q;
        ctx.strokeStyle = routeSeg[j];
        ctx.beginPath(); ctx.moveTo(xyS[j].x, xyS[j].y); ctx.lineTo(to.x, to.y); ctx.stroke();
      }
    } else {
      ctx.strokeStyle = ui.route; ctx.lineWidth = 3.4 * s; path();
    }
    ctx.restore();
    return { x: hx, y: hy };
  }

  function drawCard(ctx, r, alpha, dy = 0) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(0, dy);
    if (bg !== "green") { ctx.shadowColor = "rgba(0,0,0,0.18)"; ctx.shadowBlur = 10 * s; ctx.shadowOffsetY = 2 * s; }
    ctx.fillStyle = ui.card;
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 14 * s);
    ctx.fill();
    ctx.restore();
  }

  // a jelvények színei (mint a megosztó képen: világos térképen fehér, máshol sötét áttetsző)
  const badgeC = isLightMap ? { badgeBg: "rgba(255,255,255,0.92)", badgeText: "#1a1d23" }
    : bg === "green" ? { badgeBg: "#101418", badgeText: "#ffffff" }
    : { badgeBg: "rgba(20,24,28,0.82)", badgeText: "#ffffff" };

  function drawHeader(ctx, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(0, (1 - alpha) * -8 * s);
    drawBadge(ctx, badgeC, s, logo);            // ugyanaz a jelvény, mint a megosztó képen
    if (showDate && date) {
      const txt = date.toUpperCase();
      ctx.font = `700 ${8.5 * s}px ${FONT}`;
      ctx.letterSpacing = `${1 * s}px`;
      const w = ctx.measureText(txt).width + 24 * s, h = head.h, x = head.x + head.w - w, y = head.y;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.12)"; ctx.shadowBlur = 6 * s; ctx.shadowOffsetY = 1 * s;
      ctx.fillStyle = badgeC.badgeBg;
      roundRectPath(ctx, x, y, w, h, h / 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = badgeC.badgeText; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(txt, x + w / 2 + 0.5 * s, y + h / 2 + 0.5 * s);
      ctx.letterSpacing = "0px";
    }
    ctx.restore();
  }

  /** A cím az alsó panel tetején: balra vagy középre. */
  function drawTitle(ctx) {
    const pad = 14 * s, y = panel.y + 12 * s, maxW = panel.w - 2 * pad;
    ctx.fillStyle = ui.text; ctx.font = `800 ${17 * s}px ${FONT}`;
    ctx.letterSpacing = `${-0.3 * s}px`; ctx.textBaseline = "top";
    let t = title || "Bringaterv";
    if (ctx.measureText(t).width > maxW) { while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1); t += "…"; }
    if (titleAlign === "center") { ctx.textAlign = "center"; ctx.fillText(t, panel.x + panel.w / 2, y); }
    else { ctx.textAlign = "left"; ctx.fillText(t, panel.x + pad, y); }
    ctx.letterSpacing = "0px";
  }

  function drawPanel(ctx, alpha, i, f, end, pop) {
    const dy = (1 - alpha) * 16 * s;
    drawCard(ctx, panel, alpha, dy);
    ctx.save();
    ctx.globalAlpha = alpha; ctx.translate(0, dy);
    drawTitle(ctx);
    if (profPts) {
      const px = profPts[0].x + f.p * prof.w;
      const area = (upTo) => {
        ctx.beginPath(); ctx.moveTo(profPts[0].x, prof.y + prof.h);
        for (const q of profPts) { if (q.x > upTo) break; ctx.lineTo(q.x, q.y); }
        const k = Math.min(n - 1, profPts.findIndex((q) => q.x > upTo));
        if (k > 0) { const a = profPts[k - 1], c = profPts[k]; const r = (upTo - a.x) / Math.max(1e-6, c.x - a.x); ctx.lineTo(upTo, a.y + (c.y - a.y) * r); }
        ctx.lineTo(Math.min(upTo, prof.x + prof.w), prof.y + prof.h); ctx.closePath();
      };
      ctx.fillStyle = ui.line; area(prof.x + prof.w); ctx.fill();
      if (segColors && zoneColors) {
        // zónaszín: a megtett rész szakaszonként a saját színével (kitöltés + vonal)
        const baseY = prof.y + prof.h;
        ctx.lineWidth = 1.8 * s; ctx.lineCap = "round";
        for (let j = 0; j < n - 1; j++) {
          const a = profPts[j]; let b = profPts[j + 1];
          if (a.x >= px) break;
          if (b.x > px) { const r = (px - a.x) / Math.max(1e-6, b.x - a.x); b = { x: px, y: a.y + (b.y - a.y) * r }; }
          const col = segColors[j];
          ctx.save(); ctx.globalAlpha *= isLightMap ? 0.35 : 0.5; ctx.fillStyle = col;
          const bx = b.x + (b.x < px ? 0.75 : 0);   // kis átfedés: ne látszódjon hajszálcsík a szakaszok közt
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bx, b.y); ctx.lineTo(bx, baseY); ctx.lineTo(a.x, baseY); ctx.closePath(); ctx.fill();
          ctx.restore();
          ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      } else {
        ctx.save(); ctx.globalAlpha *= isLightMap ? 0.32 : 0.48; ctx.fillStyle = chColor; area(px); ctx.fill(); ctx.restore();
        // vonal a kész részen
        ctx.strokeStyle = chColor; ctx.lineWidth = 1.6 * s; ctx.lineJoin = "round";
        ctx.beginPath();
        profPts.forEach((q, j) => { if (q.x <= px) (j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); });
        ctx.stroke();
      }
      // felirat a bal felső sarokban (pl. PULZUS)
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillStyle = ui.muted; ctx.font = `600 ${6.5 * s}px ${FONT}`;
      ctx.letterSpacing = `${1 * s}px`; ctx.fillText(chDef.caps, prof.x, prof.y - 2 * s); ctx.letterSpacing = "0px";
      if (!end) {
        const qy = profPts[i]?.y ?? prof.y + prof.h;
        drawDot(ctx, px, qy, 3.2 * s, segColors && zoneColors ? segColors[Math.min(i, n - 2)] : chColor, "#ffffff", 1.4 * s);
      }
    }
    // adatok
    const top = panel.y + 14 * s + titleH + (profH ? profH + 12 * s : 0);
    const colW = (panel.w - 28 * s) / keys.length;
    keys.forEach((k, j) => {
      const it = STATS[k](f, i, end);
      if (!it) return;
      const cx = panel.x + 14 * s + j * colW;
      if (j) { ctx.strokeStyle = ui.line; ctx.lineWidth = Math.max(1, 0.6 * s); ctx.beginPath(); ctx.moveTo(cx - 6 * s, top + 2 * s); ctx.lineTo(cx - 6 * s, top + 36 * s); ctx.stroke(); }
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillStyle = ui.muted; ctx.font = `600 ${7.5 * s}px ${FONT}`;
      ctx.letterSpacing = `${1 * s}px`; ctx.fillText(it.label, cx, top); ctx.letterSpacing = "0px";
      let sz = (keys.length > 3 ? 24 : 28) * (1 + 0.08 * pop), vw, uw;
      do {
        ctx.font = `600 ${sz * s}px ${NUM_FONT}`; vw = ctx.measureText(it.value).width;
        ctx.font = `500 ${sz * 0.42 * s}px ${FONT}`; uw = it.unit ? ctx.measureText(it.unit).width + 3 * s : 0;
        sz -= 1;
      } while (vw + uw > colW - 10 * s && sz > 12);
      sz += 1;
      ctx.textBaseline = "alphabetic";
      const base = top + 12 * s + sz * 0.82 * s;
      ctx.fillStyle = ui.text; ctx.font = `600 ${sz * s}px ${NUM_FONT}`; ctx.fillText(it.value, cx, base);
      if (it.unit) { ctx.fillStyle = ui.muted; ctx.font = `500 ${sz * 0.42 * s}px ${FONT}`; ctx.fillText(it.unit, cx + vw + 3 * s, base); }
    });
    ctx.restore();
  }

  function draw(ctx, t) {
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    // kamera: automatikus zoom, vagy (kikapcsolva) enyhe ráközelítés
    const cam = autoZoom ? camAt(t) : { k: 1.05 - 0.05 * easeOut(clamp01(t / duration)), x: C.x, y: C.y };
    xyS = xy.map((q) => ({ x: C.x + (q.x - cam.x) * cam.k, y: C.y + (q.y - cam.y) * cam.k }));
    if (liveVideo) {
      ctx.fillStyle = "#11161a"; ctx.fillRect(0, 0, W, H);
      drawCover(ctx, liveVideo, W, H);
      ctx.fillStyle = "rgba(0,0,0,0.28)"; ctx.fillRect(0, 0, W, H);
    }
    ctx.save();
    if (bg === "map") {
      drawMap(ctx, cam);
      // olvashatóság: fent / lent halvány sáv a jelvények és a panel mögött
      const g = ctx.createLinearGradient(0, 0, 0, H);
      const sh = isLightMap ? "255,255,255" : "0,0,0";
      g.addColorStop(0, `rgba(${sh},0.28)`); g.addColorStop(0.25, `rgba(${sh},0)`);
      g.addColorStop(0.7, `rgba(${sh},0)`); g.addColorStop(1, `rgba(${sh},0.35)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    } else if (!liveVideo) ctx.drawImage(bgCanvas, 0, 0);

    // a teljes útvonal halványan, aztán a megtett rész
    const ghostA = clamp01(t / INTRO);
    ctx.save();
    ctx.globalAlpha = ghostA;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = ui.ghost; ctx.lineWidth = 3.4 * s;
    ctx.beginPath(); xyS.forEach((q, j) => (j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke();
    ctx.restore();

    const p = routeProgress(t);
    const target = p * D;
    const i = indexAt(target);
    const segLen = i < n - 1 ? d[i + 1] - d[i] : 0;
    const frac = segLen > 0 ? clamp01((target - d[i]) / segLen) : 0;
    const headPt = p > 0 ? drawRoutePart(ctx, i, frac) : xyS[0];
    drawDot(ctx, xyS[0].x, xyS[0].y, 4.6 * s, ui.start, "#ffffff", 1.6 * s);

    const end = t >= drawEnd;
    if (!end) {
      // fej: pulzáló fénykör + pötty
      const r = (9 + 3 * Math.sin(t * 6)) * s;
      const g = ctx.createRadialGradient(headPt.x, headPt.y, 0, headPt.x, headPt.y, r * 1.6);
      g.addColorStop(0, "rgba(255,106,61,0.55)"); g.addColorStop(1, "rgba(255,106,61,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(headPt.x, headPt.y, r * 1.6, 0, Math.PI * 2); ctx.fill();
      drawDot(ctx, headPt.x, headPt.y, 5 * s, routeSeg ? routeSeg[Math.min(i, n - 2)] : ui.route, "#ffffff", 2 * s);
    } else {
      // cél: egyszer kifutó gyűrű
      const e = xyS[n - 1], k = clamp01((t - drawEnd) / 0.9);
      if (k < 1) {
        ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - k)})`; ctx.lineWidth = 2.4 * s;
        ctx.beginPath(); ctx.arc(e.x, e.y, (6 + 26 * easeOut(k)) * s, 0, Math.PI * 2); ctx.stroke();
      }
      drawDot(ctx, e.x, e.y, 5.4 * s, ui.text === "#ffffff" ? "#ffffff" : "#16191d", "#ffffff", 1.6 * s);
      drawDot(ctx, e.x, e.y, 2.2 * s, ui.route, null, 0);
    }
    ctx.restore();

    // feliratok
    const inA = easeOut(clamp01(t / INTRO));
    const tf = (i < n - 1 ? tFrac(i) + (tFrac(i + 1) - tFrac(i)) * frac : 1);
    const f = { p, t: end ? 1 : tf };
    const pop = end ? Math.max(0, 1 - Math.abs((t - drawEnd) / 0.35 - 1)) : 0;
    drawHeader(ctx, inA);
    drawPanel(ctx, inA, i, f, end, pop);
    ctx.restore();
  }

  if (autoZoom) buildCamera();
  if (bg === "map") await preloadTiles();

  return {
    W, H, duration,
    draw,
    restart() {
      if (liveVideo) { try { liveVideo.currentTime = 0; liveVideo.play().catch(() => {}); } catch { /* nincs lejátszás */ } }
    },
    stop() { if (liveVideo) liveVideo.pause(); },
  };
}

/** Előnézet a megadott vásznon, végtelenítve. Visszaad egy leállító függvényt. */
export function playScene(canvas, scene) {
  canvas.width = scene.W; canvas.height = scene.H;
  const ctx = canvas.getContext("2d");
  let raf = 0, t0 = performance.now(), stopped = false;
  scene.restart();
  const tick = (now) => {
    if (stopped) return;
    let t = (now - t0) / 1000;
    if (t > scene.duration + LOOP_GAP) { t0 = now; t = 0; scene.restart(); }
    scene.draw(ctx, Math.min(t, scene.duration));
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => { stopped = true; cancelAnimationFrame(raf); scene.stop(); };
}

/** Felvétel valós időben (a vásznon közben látszik). */
export async function recordScene(canvas, scene, { onProgress, fps = 30 } = {}) {
  const mime = pickMime();
  if (!mime || !canvas.captureStream) throw new Error("Ez a böngésző nem tud videót készíteni.");
  canvas.width = scene.W; canvas.height = scene.H;
  const ctx = canvas.getContext("2d");
  scene.draw(ctx, 0);
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  scene.restart();
  rec.start(250);
  await new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (now) => {
      const t = (now - t0) / 1000;
      scene.draw(ctx, Math.min(t, scene.duration));
      onProgress?.(clamp01(t / scene.duration));
      if (t >= scene.duration + 0.2) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  rec.stop();
  await stopped;
  stream.getTracks().forEach((tr) => tr.stop());
  scene.stop();
  const type = mime.split(";")[0];
  return { blob: new Blob(chunks, { type }), ext: type.includes("mp4") ? "mp4" : "webm", mime: type };
}
