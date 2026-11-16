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
import { _cardKit, SHARE_SIZES, DEFAULT_STATS, SHARE_CHARTS, BADGE, LINE_WEIGHTS } from "./shareCard.js";
import { buildHrZoneColorFn, getZoneColor, gradeColorForGrade, getChartColors } from "./settings.js";
import { createFlyover, flyoverSupported, FLY_MAPS } from "./shareFlyover.js";
import { detectClimbs, category as climbCategory } from "./climbs.js";

export { FLY_MAPS, flyoverSupported };

// a 3D térkép újraépítése drága (WebGL + csempék) – amíg a nyomvonal / méret / térkép ugyanaz, megtartjuk
let _fly = null;   // { key, inst }
async function getFlyover(key, opts) {
  if (_fly?.key === key) return _fly.inst;
  _fly?.inst?.destroy();
  _fly = null;
  const inst = await createFlyover(opts);
  _fly = { key, inst };
  return inst;
}
/** A 3D térkép felszabadítása (a megosztó ablak bezárásakor). */
export function releaseFlyover() { _fly?.inst?.destroy(); _fly = null; }

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
/** A videó stílusai: a panel és a keret (a térkép, a vonal és a kamera közös). */
export const VIDEO_STYLES = [
  { id: "classic", label: "Klasszikus" },
  { id: "big",     label: "Nagy számok" },
  { id: "minimal", label: "Minimál" },
  { id: "cinema",  label: "Mozi" },
];

// ── fotók az útvonalon: a kép helye az EXIF GPS-ből vagy a készítés idejéből ──
function readExif(view) {
  const out = {};
  if (view.byteLength < 12 || view.getUint16(0) !== 0xffd8) return out;
  let off = 2, base = -1;
  while (off + 10 < view.byteLength) {
    const marker = view.getUint16(off), size = view.getUint16(off + 2);
    if ((marker & 0xff00) !== 0xff00) break;
    if (marker === 0xffe1 && view.getUint32(off + 4) === 0x45786966) { base = off + 10; break; }
    off += 2 + size;
  }
  if (base < 0) return out;
  const le = view.getUint16(base) === 0x4949;
  const u16 = (o) => view.getUint16(o, le), u32 = (o) => view.getUint32(o, le);
  const ifd = (o, fn) => { const c = u16(o); for (let k = 0; k < c; k++) { const e = o + 2 + k * 12; fn(u16(e), u32(e + 4), e + 8); } };
  const str = (o, len) => { let t = ""; for (let k = 0; k < len - 1; k++) t += String.fromCharCode(view.getUint8(o + k)); return t; };
  const rat = (o) => u32(o) / (u32(o + 4) || 1);
  let exifOff = 0, gpsOff = 0;
  ifd(base + u32(base + 4), (tag, count, val) => {
    if (tag === 0x8769) exifOff = u32(val);
    if (tag === 0x8825) gpsOff = u32(val);
    if (tag === 0x0132) out.time = str(base + u32(val), count);
  });
  if (exifOff) ifd(base + exifOff, (tag, count, val) => { if (tag === 0x9003) out.time = str(base + u32(val), count); });
  if (gpsOff) {
    const g = {};
    ifd(base + gpsOff, (tag, count, val) => {
      if (tag === 1) g.latRef = String.fromCharCode(view.getUint8(val));
      if (tag === 3) g.lngRef = String.fromCharCode(view.getUint8(val));
      if (tag === 2 || tag === 4) { const o = base + u32(val); g[tag === 2 ? "lat" : "lng"] = rat(o) + rat(o + 8) / 60 + rat(o + 16) / 3600; }
    });
    if (g.lat != null && g.lng != null && (g.lat || g.lng)) { out.lat = g.latRef === "S" ? -g.lat : g.lat; out.lng = g.lngRef === "W" ? -g.lng : g.lng; }
  }
  return out;
}

/**
 * Fotók a videóhoz (legfeljebb 8): → [{ img, frac }] a nyomvonal mentén rendezve.
 * A hely: EXIF GPS (a legközelebbi pont, 1 km-en belül) → a készítés ideje az edzés idejéhez mérve →
 * egyenletesen elosztva a kiválasztás sorrendjében.
 */
export async function loadVideoPhotos(files, points) {
  const { hav } = _cardKit;
  const pts = (points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (pts.length < 2) return [];
  const d = [0];
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + hav(pts[i - 1], pts[i]));
  const D = d[d.length - 1] || 1;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const out = [];
  for (const file of [...files].filter((f) => f.type.startsWith("image/")).slice(0, 8)) {
    let img = null;
    try { img = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch {
      try {
        img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); });
      } catch { continue; }
    }
    // kicsinyítés: a videóban legfeljebb ~900 px széles
    const k = Math.min(1, 1000 / Math.max(img.width, img.height));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(img.width * k)); cv.height = Math.max(1, Math.round(img.height * k));
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    img.close?.();
    let ex = {};
    try { ex = readExif(new DataView(await file.slice(0, 262144).arrayBuffer())); } catch { ex = {}; }
    let frac = null;
    if (Number.isFinite(ex.lat) && Number.isFinite(ex.lng)) {
      let best = -1, bd = Infinity;
      for (let i = 0; i < pts.length; i++) { const x = hav(pts[i], ex); if (x < bd) { bd = x; best = i; } }
      if (bd < 1000) frac = d[best] / D;
    }
    if (frac == null && ex.time && t0 != null && t1 > t0) {
      const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(ex.time);
      const ts = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : NaN;
      if (ts >= t0 - 60000 && ts <= t1 + 60000) {
        let i = 0; while (i < pts.length - 1 && (pts[i + 1].t ?? Infinity) <= ts) i++;
        frac = d[i] / D;
      }
    }
    out.push({ img: cv, frac });
  }
  const loose = out.filter((p) => p.frac == null);
  loose.forEach((p, k) => { p.frac = (k + 1) / (loose.length + 1); });
  out.forEach((p) => { p.frac = Math.max(0.04, Math.min(0.96, p.frac)); });
  return out.sort((a, b) => a.frac - b.frac);
}

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
  safe: safeZone = true,       // sztorin hely a kezelőszerveknek (safeInsets)
  preview = false,             // előnézet: nem várja meg az összes csempét, rögtön indul
  milestones = true,           // kerek kilométerek és a legmagasabb pont felvillanó címkével (felülnézet)
  endCard = true,              // a végén nagy szám: a megtett táv
  style = "classic",           // VIDEO_STYLES id: a panel és a keret
  photos = [],                 // [{ img, frac }] – fotók az útvonalon (loadVideoPhotos)
  highlights = [],             // érmes eredmények (bestEfforts.getShareHighlights) – az első a záró kártyán
  line = "normal",             // a nyomvonal vastagsága (mint a képen): thin | normal | bold
  view = "2d",                 // "2d" | "3d" (berepülés domborzattal – shareFlyover.js)
  flyMap = "satellite",        // 3D: FLY_MAPS id
}) {
  const is3d = view === "3d";
  if (is3d) { bg = "map"; autoZoom = false; }
  const LW = LINE_WEIGHTS[line] || LINE_WEIGHTS.normal;
  const RW = 3.4 * LW.k;        // a vonal szélessége (360-as alapban)
  const mapDef = VIDEO_MAPS.find((m) => m.id === map) || VIDEO_MAPS[0];
  if (zoneColors == null) { try { zoneColors = getChartColors().mode === "zones"; } catch { zoneColors = true; } }
  const { palette, fitProjection, drawTiles, loadLogo, roundRectPath, drawDot, fitOneLine, drawWordmark, drawBadge, hav,
          FONT, NUM_FONT } = _cardKit;
  const [W, H] = SHARE_SIZES[size === "square" ? "portrait" : size] || SHARE_SIZES.story;
  const wide = size === "wide";
  if (!VIDEO_STYLES.some((x) => x.id === style)) style = "classic";
  const cinema = style === "cinema";
  const s = W / (wide ? 640 : 360);   // fekvő képen ugyanakkora elemek, több hely a térképnek
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
  // sztorin (9:16) a logó, a dátum és a panel az Instagram-kezelőkön belül marad (safeInsets)
  const safe = _cardKit.safeInsets(size, safeZone);
  const head = { x: BADGE.x * s, y: (BADGE.y + safe.t) * s, w: W - 2 * BADGE.x * s, h: BADGE.h * s };
  const titleH = 26 * s;   // a cím sora az alsó panel tetején
  const profH = hasEle && style === "classic" ? (size === "portrait" || wide ? 30 : 38) * s : 0;
  const panelH = style === "big" ? 14 * s + titleH + 84 * s
    : style === "minimal" ? 44 * s
    : 14 * s + titleH + (profH ? profH + 12 * s : 0) + 46 * s + 12 * s;
  // Mozi: fekete sáv fent (benne a jelvények) és lent (benne a cím és a számok)
  const barT = cinema ? Math.round(head.y + head.h + BADGE.y * s) : 0;
  const barB = cinema ? Math.round((safe.b + 62) * s) : 0;
  const gap = (size === "portrait" || wide ? 12 : 18) * s;
  const panel = cinema ? { x: 0, y: H - barB, w: W, h: barB }
    : { x: M, y: H - M - safe.b * s - panelH, w: wide ? Math.min(250 * s, W - 2 * M) : W - 2 * M, h: panelH };
  const routeBox = cinema ? { x: M + 10 * s, y: barT + gap, w: W - 2 * M - 20 * s, h: H - barB - barT - 2 * gap }
    : wide ? { x: panel.x + panel.w + 2 * gap, y: head.y + head.h + gap, w: W - M - 10 * s - (panel.x + panel.w + 2 * gap), h: H - M - (head.y + head.h) - 2 * gap }
    : { x: M + 10 * s, y: head.y + head.h + gap, w: W - 2 * M - 20 * s, h: panel.y - (head.y + head.h) - 2 * gap };
  const proj = fitProjection(pts, routeBox);
  const xy = pts.map(proj.toPx);

  // ── színek ──
  const isLightMap = bg === "map" && mapDef.light && !is3d;
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
    if (LW.casing) { ctx.strokeStyle = ui.casing; ctx.lineWidth = (RW + 2.6) * s; path(); }
    else { ctx.shadowColor = isLightMap ? "rgba(0,0,0,0.28)" : "rgba(0,0,0,0.55)"; ctx.shadowBlur = 2 * s; }
    if (routeSeg) {
      // színezett nyomvonal: szakaszonként a zóna színével
      ctx.lineWidth = RW * s;
      for (let j = 0; j <= i && j < n - 1; j++) {
        const q = xyS[j + 1], to = j === i ? { x: hx, y: hy } : q;
        ctx.strokeStyle = routeSeg[j];
        ctx.beginPath(); ctx.moveTo(xyS[j].x, xyS[j].y); ctx.lineTo(to.x, to.y); ctx.stroke();
      }
    } else {
      ctx.strokeStyle = ui.route; ctx.lineWidth = RW * s; path();
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
  const badgeC = cinema ? { badgeBg: "rgba(255,255,255,0.10)", badgeText: "#ffffff" }
    : isLightMap ? { badgeBg: "rgba(255,255,255,0.92)", badgeText: "#1a1d23" }
    : bg === "green" ? { badgeBg: "#101418", badgeText: "#ffffff" }
    : { badgeBg: "rgba(20,24,28,0.82)", badgeText: "#ffffff" };

  function drawHeader(ctx, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(0, (1 - alpha) * -8 * s);
    drawBadge(ctx, badgeC, s, logo, safe.t);            // ugyanaz a jelvény, mint a megosztó képen
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

  /** A panel a választott stílus szerint. */
  function drawPanel(ctx, alpha, i, f, end, pop) {
    if (style === "big") return drawPanelBig(ctx, alpha, i, f, end, pop);
    if (style === "minimal") return drawPanelMinimal(ctx, alpha, i, f, end);
    if (cinema) return drawPanelCinema(ctx, alpha, i, f, end);
    return drawPanelClassic(ctx, alpha, i, f, end, pop);
  }
  const statText = (it) => `${it.value}${it.unit ? ` ${it.unit}` : ""}`;
  /** Nagy számok: egyetlen óriási szám (a táv), alatta a többi egy sorban. */
  function drawPanelBig(ctx, alpha, i, f, end, pop) {
    const dy = (1 - alpha) * 16 * s;
    drawCard(ctx, panel, alpha, dy);
    ctx.save();
    ctx.globalAlpha = alpha; ctx.translate(0, dy);
    drawTitle(ctx);
    const first = keys.find((k) => STATS[k](f, i, end)) || "dist";
    const it = STATS.dist(f, i, end) || STATS[first](f, i, end);
    const top = panel.y + 14 * s + titleH, pad = 14 * s, center = titleAlign === "center";
    if (it) {
      const sz = 54 * (1 + 0.05 * pop);
      ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
      ctx.font = `600 ${sz * s}px ${NUM_FONT}`; const vw = ctx.measureText(it.value).width;
      ctx.font = `600 ${18 * s}px ${FONT}`; const uw = it.unit ? ctx.measureText(it.unit).width + 5 * s : 0;
      const x0 = center ? panel.x + (panel.w - vw - uw) / 2 : panel.x + pad, base = top + 46 * s;
      ctx.fillStyle = ui.text; ctx.font = `600 ${sz * s}px ${NUM_FONT}`; ctx.fillText(it.value, x0, base);
      ctx.fillStyle = ui.muted; ctx.font = `600 ${18 * s}px ${FONT}`; ctx.fillText(it.unit || "", x0 + vw + 5 * s, base);
    }
    const rest = keys.map((k) => STATS[k](f, i, end)).filter((x) => x && x !== it && x.label !== (it?.label)).map(statText).join("   ·   ");
    ctx.fillStyle = ui.muted; ctx.font = `600 ${11.5 * s}px ${FONT}`; ctx.textBaseline = "alphabetic";
    ctx.textAlign = center ? "center" : "left";
    fitOneLine(ctx, rest, center ? panel.x + panel.w / 2 : panel.x + pad, top + 66 * s, panel.w - 2 * pad);
    ctx.restore();
  }
  /** Minimál: egy sor – a cím és a táv. */
  function drawPanelMinimal(ctx, alpha, i, f, end) {
    const dy = (1 - alpha) * 16 * s;
    drawCard(ctx, panel, alpha, dy);
    ctx.save();
    ctx.globalAlpha = alpha; ctx.translate(0, dy);
    const it = STATS.dist(f, i, end), pad = 16 * s, cy = panel.y + panel.h / 2 + 0.5 * s;
    ctx.textBaseline = "middle";
    let tw = 0;
    if (it) {
      ctx.font = `600 ${19 * s}px ${NUM_FONT}`; const vw = ctx.measureText(it.value).width;
      ctx.font = `600 ${10 * s}px ${FONT}`; const uw = ctx.measureText(it.unit).width + 4 * s;
      tw = vw + uw + 12 * s;
      ctx.textAlign = "left";
      ctx.fillStyle = ui.text; ctx.font = `600 ${19 * s}px ${NUM_FONT}`; ctx.fillText(it.value, panel.x + panel.w - pad - vw - uw, cy);
      ctx.fillStyle = ui.muted; ctx.font = `600 ${10 * s}px ${FONT}`; ctx.fillText(it.unit, panel.x + panel.w - pad - uw + 4 * s, cy + 2 * s);
    }
    ctx.textAlign = "left"; ctx.fillStyle = ui.text; ctx.font = `800 ${14 * s}px ${FONT}`;
    fitOneLine(ctx, title || "Bringaterv", panel.x + pad, cy, panel.w - 2 * pad - tw);
    ctx.restore();
  }
  /** Mozi: az alsó fekete sávban a cím és a számok egy-egy sorban, középen. */
  function drawPanelCinema(ctx, alpha, i, f, end) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const cx = W / 2, y0 = panel.y + 16 * s, maxW = W - 2 * M - 8 * s;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillStyle = "#ffffff"; ctx.font = `800 ${15 * s}px ${FONT}`;
    fitOneLine(ctx, title || "Bringaterv", cx, y0, maxW);
    const row = keys.map((k) => STATS[k](f, i, end)).filter(Boolean).map(statText).join("   ·   ");
    ctx.fillStyle = "rgba(255,255,255,0.72)"; ctx.font = `600 ${12 * s}px ${NUM_FONT}`;
    fitOneLine(ctx, row, cx, y0 + 22 * s, maxW);
    ctx.restore();
  }
  function drawPanelClassic(ctx, alpha, i, f, end, pop) {
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

  // ── mérföldkövek: kerek kilométerek és a legmagasabb pont, felvillanó címkével ──
  const marks = [];
  if (milestones) {
    const km = distanceKm > 0 ? distanceKm : D / 1000;
    const step = km >= 120 ? 25 : km >= 50 ? 10 : km >= 20 ? 5 : km >= 8 ? 2 : 1;
    for (let m = step; m < km - step * 0.35; m += step) marks.push({ dist: (m / km) * D, label: `${m} km` });
    let top = -1;
    for (let j = 0; j < n; j++) if (Number.isFinite(pts[j].ele) && (top < 0 || pts[j].ele > pts[top].ele)) top = j;
    if (top > n * 0.05 && top < n * 0.95 && elevationM >= 80) {
      // a csúcs mellé eső kilométer-jelző kimarad (a két címke egymásra kerülne)
      for (let q = marks.length - 1; q >= 0; q--) if (Math.abs(marks[q].dist - d[top]) < D * 0.05) marks.splice(q, 1);
      marks.push({ dist: d[top], label: `Csúcs · ${Math.round(pts[top].ele)} m`, peak: true });
    }
  }
  // ── csúcspont-kártya: a legnagyobb emelkedő, amikor odaér a rajzolás ──
  const cards = [];
  if (milestones) {
    try {
      const eleAt = (dist) => { const e = pts[indexAt(dist)]?.ele; return Number.isFinite(e) ? e : null; };
      const best = detectClimbs(pts, Array.from(d)).map((c) => {
        const len = c.d1 - c.d0, a = eleAt(c.d0), b = eleAt(c.d1), gainM = a != null && b != null ? b - a : 0;
        return { d0: c.d0, len, gainM, grade: len > 0 ? (gainM / len) * 100 : 0 };
      }).filter((c) => c.gainM >= 40 && c.len >= 500).sort((a, b) => b.len * b.grade - a.len * a.grade)[0];
      if (best) {
        const cat = climbCategory(best.len, best.grade);
        cards.push({ dist: best.d0, kicker: "LEGNAGYOBB EMELKEDŐ", text: `${num(best.len / 1000, 1)} km · ${num(best.grade, 1)}%${cat?.label ? ` · ${cat.label}` : ""}` });
      }
    } catch { /* emelkedő-felismerés nélkül is megy */ }
  }
  function drawCards(ctx, t) {
    for (const c of cards) {
      const age = t - c.t;
      if (age < 0 || age > 3) continue;
      const al = age < 0.25 ? age / 0.25 : age > 2.6 ? Math.max(0, 1 - (age - 2.6) / 0.4) : 1;
      ctx.save();
      ctx.globalAlpha *= al;
      ctx.font = `800 ${13 * s}px ${FONT}`; const tw = ctx.measureText(c.text).width;
      ctx.font = `700 ${6.5 * s}px ${FONT}`; ctx.letterSpacing = `${1 * s}px`; const kw = ctx.measureText(c.kicker).width; ctx.letterSpacing = "0px";
      const w = Math.max(tw, kw) + 30 * s, h = 44 * s;
      const x = routeBox.x + (routeBox.w - w) / 2, y = routeBox.y + 2 * s - (1 - easeOut(Math.min(1, age / 0.25))) * 10 * s;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.22)"; ctx.shadowBlur = 12 * s; ctx.shadowOffsetY = 2 * s;
      ctx.fillStyle = ui.card; roundRectPath(ctx, x, y, w, h, 14 * s); ctx.fill();
      ctx.restore();
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillStyle = ui.route; ctx.font = `700 ${6.5 * s}px ${FONT}`; ctx.letterSpacing = `${1 * s}px`;
      ctx.fillText(c.kicker, x + w / 2 + 0.5 * s, y + 9 * s); ctx.letterSpacing = "0px";
      ctx.fillStyle = ui.text; ctx.font = `800 ${13 * s}px ${FONT}`;
      ctx.fillText(c.text, x + w / 2, y + 21 * s);
      ctx.restore();
    }
  }

  // ── fotók az útvonalon: a helyükön felvillannak, a jelük a vonalon marad ──
  const shots = (photos || []).filter((p) => p?.img && Number.isFinite(p.frac)).map((p, q) => ({ img: p.img, dist: p.frac * D, tilt: (q % 2 ? 1 : -1) * 0.045 }));
  function drawShots(ctx, t) {
    for (const ph of shots) {
      const age = t - ph.t;
      if (age < 0) continue;
      const at = screenAt(ph.dist);
      if (at) {   // kis fehér négyzet a vonalon: itt készült a kép
        ctx.save();
        ctx.fillStyle = "#ffffff"; ctx.strokeStyle = ui.route; ctx.lineWidth = 1.4 * s;
        roundRectPath(ctx, at.x - 3.4 * s, at.y - 3.4 * s, 6.8 * s, 6.8 * s, 1.6 * s); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      const HOLD = 1.9;
      if (age > HOLD) continue;
      const al = age > HOLD - 0.35 ? Math.max(0, (HOLD - age) / 0.35) : Math.min(1, age / 0.15);
      const k = age < 0.3 ? 0.7 + 0.3 * (1 + 0.6 * Math.sin((age / 0.3) * Math.PI)) * easeOut(age / 0.3) : 1;   // kis túllendülés
      const box = Math.min(routeBox.w * 0.66, routeBox.h * 0.56);
      const r = Math.min(box / ph.img.width, box / ph.img.height), iw = ph.img.width * r, ih = ph.img.height * r, b = 5 * s;
      const cx = routeBox.x + routeBox.w / 2, cy = routeBox.y + routeBox.h / 2;
      ctx.save();
      ctx.globalAlpha *= al;
      ctx.translate(cx, cy); ctx.rotate(ph.tilt); ctx.scale(k, k);
      ctx.shadowColor = "rgba(0,0,0,0.38)"; ctx.shadowBlur = 22 * s; ctx.shadowOffsetY = 6 * s;
      ctx.fillStyle = "#ffffff"; roundRectPath(ctx, -iw / 2 - b, -ih / 2 - b, iw + 2 * b, ih + 2 * b, 9 * s); ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.save(); roundRectPath(ctx, -iw / 2, -ih / 2, iw, ih, 5 * s); ctx.clip();
      ctx.drawImage(ph.img, -iw / 2, -ih / 2, iw, ih);
      ctx.restore();
      ctx.restore();
    }
  }

  /** Mikor ér oda a rajzolás az egyes jelölőkhöz (a haladás monoton – felezéssel). 3D-ben a berepülés üteme szerint. */
  function timeMarks(list) {
    const prog = (t) => (fly ? fly.progressAt(t) : routeProgress(t));
    const from = fly ? fly.intro : drawStart, to = fly ? fly.drawEnd : drawEnd;
    for (const mk of list) {
      let lo = from, hi = to;
      for (let q = 0; q < 22; q++) { const mid = (lo + hi) / 2; if (prog(mid) * D < mk.dist) lo = mid; else hi = mid; }
      mk.t = hi;
    }
  }
  /** Egy távolság (m) képernyő-helye: felülnézetben a kivetített vonalon, 3D-ben a térképről. */
  function screenAt(dist) {
    if (fly) {
      const q = fly.pointAtDist((dist / D) * fly.length);
      return q && q.x > -40 && q.x < W + 40 && q.y > 0 && q.y < H ? q : null;
    }
    const j = indexAt(dist), seg = j < n - 1 ? d[j + 1] - d[j] : 0, fr = seg > 0 ? clamp01((dist - d[j]) / seg) : 0;
    const a = xyS[j], b = xyS[Math.min(n - 1, j + 1)];
    return { x: a.x + (b.x - a.x) * fr, y: a.y + (b.y - a.y) * fr };
  }
  function drawMarks(ctx, t) {
    const used = [];   // a már kirajzolt címkék helye – egymásra nem kerülhetnek (a csúcsé az elsőbbség)
    for (const mk of [...marks].sort((a, b) => (b.peak ? 1 : 0) - (a.peak ? 1 : 0))) {
      const age = t - mk.t;
      if (age < 0) continue;
      const at = screenAt(mk.dist);
      if (!at) continue;
      const { x, y } = at;
      drawDot(ctx, x, y, 2.8 * s, "#ffffff", mk.peak ? "#16191d" : ui.route, 1.3 * s);
      const hold = mk.peak ? 2.2 : 1.4;
      const al = age < 0.18 ? age / 0.18 : age < hold ? 1 : Math.max(0, 1 - (age - hold) / 0.4);
      if (al <= 0) continue;
      const k = age < 0.22 ? 0.6 + 0.4 * easeOut(age / 0.22) : 1;
      ctx.save();
      ctx.globalAlpha *= al;
      ctx.font = `700 ${9 * s}px ${FONT}`;
      const w = ctx.measureText(mk.label).width + 14 * s, h = 18 * s;
      const bx = Math.max(M, Math.min(W - M - w, x - w / 2));
      let by = y - h - 9 * s;
      if (by < head.y + head.h + 4 * s) by = y + 9 * s;
      if (used.some((u) => bx < u.x + u.w + 4 * s && bx + w + 4 * s > u.x && by < u.y + u.h + 4 * s && by + h + 4 * s > u.y)) { ctx.restore(); continue; }
      used.push({ x: bx, y: by, w, h });
      ctx.translate(bx + w / 2, by + h / 2); ctx.scale(k, k); ctx.translate(-(bx + w / 2), -(by + h / 2));
      ctx.shadowColor = "rgba(0,0,0,0.28)"; ctx.shadowBlur = 5 * s; ctx.shadowOffsetY = 1 * s;
      ctx.fillStyle = mk.peak ? "#16191d" : "#ffffff";
      roundRectPath(ctx, bx, by, w, h, h / 2); ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.fillStyle = mk.peak ? "#ffffff" : "#16191d";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(mk.label, bx + w / 2, by + h / 2 + 0.5 * s);
      ctx.restore();
    }
  }
  /** Záró szám: a megtett táv nagyban, a kép felső részén. */
  function drawHero(ctx, k) {
    const it = STATS.dist({ p: 1, t: 1 }, n - 1, true);
    if (!it) return;
    ctx.save();
    ctx.globalAlpha *= k;
    const hx = routeBox.x + routeBox.w / 2;          // fekvő képen a térképes rész közepe
    const hl = highlights?.[0];
    const hlTxt = hl ? `${hl.rank === 1 ? "Egyéni csúcs" : `${hl.rank}. legjobb`} · ${hl.label} · ${hl.value}` : "";
    const cy = routeBox.y + (hlTxt ? 38 : 30) * s, sc = 0.86 + 0.14 * k;
    ctx.translate(hx - W / 2, 0);
    ctx.translate(W / 2, cy); ctx.scale(sc, sc); ctx.translate(-W / 2, -cy);
    ctx.textBaseline = "alphabetic";
    ctx.font = `600 ${56 * s}px ${NUM_FONT}`;
    const vw = ctx.measureText(it.value).width;
    ctx.font = `600 ${20 * s}px ${FONT}`;
    const uw = ctx.measureText(it.unit).width + 6 * s;
    const x0 = (W - vw - uw) / 2, base = cy + (hlTxt ? 10 : 20) * s;
    // a panellel azonos kártya a szám mögött – az útvonal fölött is olvasható
    ctx.font = `700 ${9.5 * s}px ${FONT}`;
    const hw = hlTxt ? ctx.measureText(hlTxt).width : 0;
    const bw = Math.max(vw + uw, hw) + 44 * s, bh = (hlTxt ? 94 : 76) * s;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.22)"; ctx.shadowBlur = 16 * s; ctx.shadowOffsetY = 3 * s;
    ctx.fillStyle = ui.card;
    roundRectPath(ctx, (W - bw) / 2, cy - bh / 2, bw, bh, 20 * s); ctx.fill();
    ctx.restore();
    ctx.fillStyle = ui.text;
    ctx.textAlign = "left";
    ctx.font = `600 ${56 * s}px ${NUM_FONT}`; ctx.fillText(it.value, x0, base);
    ctx.fillStyle = ui.muted;
    ctx.font = `600 ${20 * s}px ${FONT}`; ctx.fillText(it.unit, x0 + vw + 6 * s, base);
    if (hlTxt) { ctx.fillStyle = ui.route; ctx.font = `700 ${9.5 * s}px ${FONT}`; ctx.textAlign = "center"; ctx.fillText(hlTxt, W / 2, base + 20 * s); }
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
    if (fly) {
      if (!prepared) fly.setFrame(t);   // előnézet: a kamera azonnal, a kép a következő rajzolással frissül
      ctx.fillStyle = "#1d2a1f"; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(fly.canvas, 0, 0, W, H);
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "rgba(0,0,0,0.30)"); g.addColorStop(0.22, "rgba(0,0,0,0)");
      g.addColorStop(0.72, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.38)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    } else if (bg === "map") {
      drawMap(ctx, cam);
      // olvashatóság: fent / lent halvány sáv a jelvények és a panel mögött
      const g = ctx.createLinearGradient(0, 0, 0, H);
      const sh = isLightMap ? "255,255,255" : "0,0,0";
      g.addColorStop(0, `rgba(${sh},0.28)`); g.addColorStop(0.25, `rgba(${sh},0)`);
      g.addColorStop(0.7, `rgba(${sh},0)`); g.addColorStop(1, `rgba(${sh},0.35)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    } else if (!liveVideo) ctx.drawImage(bgCanvas, 0, 0);

    // a teljes útvonal halványan, aztán a megtett rész (3D-nél a térkép rajzolja, itt csak a fej)
    const ghostA = fly ? 0 : clamp01(t / INTRO);
    ctx.save();
    ctx.globalAlpha = ghostA;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = ui.ghost; ctx.lineWidth = RW * s;
    ctx.beginPath(); xyS.forEach((q, j) => (j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke();
    ctx.restore();

    const p = routeProgress(t);
    const target = p * D;
    const i = indexAt(target);
    const segLen = i < n - 1 ? d[i + 1] - d[i] : 0;
    const frac = segLen > 0 ? clamp01((target - d[i]) / segLen) : 0;
    let headPt;
    if (fly) { headPt = fly.headAt(t) || { x: -99, y: -99 }; drawMarks(ctx, t); }
    else {
      headPt = p > 0 ? drawRoutePart(ctx, i, frac) : xyS[0];
      drawDot(ctx, xyS[0].x, xyS[0].y, 4.6 * s, ui.start, "#ffffff", 1.6 * s);
      drawMarks(ctx, t);
    }

    const end = fly ? t >= fly.drawEnd : t >= drawEnd;
    if (!end) {
      // fej: pulzáló fénykör + pötty
      const r = (9 + 3 * Math.sin(t * 6)) * s;
      const g = ctx.createRadialGradient(headPt.x, headPt.y, 0, headPt.x, headPt.y, r * 1.6);
      g.addColorStop(0, "rgba(255,106,61,0.55)"); g.addColorStop(1, "rgba(255,106,61,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(headPt.x, headPt.y, r * 1.6, 0, Math.PI * 2); ctx.fill();
      drawDot(ctx, headPt.x, headPt.y, 5 * s, routeSeg ? routeSeg[Math.min(i, n - 2)] : ui.route, "#ffffff", 2 * s);
    } else {
      // cél: egyszer kifutó gyűrű
      const e = fly ? headPt : xyS[n - 1], k = clamp01((t - (fly ? fly.drawEnd : drawEnd)) / 0.9);
      if (k < 1) {
        ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - k)})`; ctx.lineWidth = 2.4 * s;
        ctx.beginPath(); ctx.arc(e.x, e.y, (6 + 26 * easeOut(k)) * s, 0, Math.PI * 2); ctx.stroke();
      }
      drawDot(ctx, e.x, e.y, 5.4 * s, ui.text === "#ffffff" ? "#ffffff" : "#16191d", "#ffffff", 1.6 * s);
      drawDot(ctx, e.x, e.y, 2.2 * s, ui.route, null, 0);
    }
    ctx.restore();

    if (cinema) {   // fekete sávok a kép fölött / alatt
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, W, barT); ctx.fillRect(0, H - barB, W, barB);
    }
    drawShots(ctx, t);
    drawCards(ctx, t);

    // feliratok
    const inA = easeOut(clamp01(t / INTRO));
    const tf = (i < n - 1 ? tFrac(i) + (tFrac(i + 1) - tFrac(i)) * frac : 1);
    const f = { p, t: end ? 1 : tf };
    const pop = end ? Math.max(0, 1 - Math.abs((t - drawEnd) / 0.35 - 1)) : 0;
    drawHeader(ctx, inA);
    drawPanel(ctx, inA, i, f, end, pop);
    if (endCard && end && style !== "big") {   // a Nagy számok panelén már ott a nagy szám
      const k = easeOut(clamp01((t - (fly ? fly.drawEnd : drawEnd) - 0.3) / 0.6));
      if (k > 0) drawHero(ctx, k);
    }
    ctx.restore();
  }

  if (autoZoom) buildCamera();
  let fly = null, prepared = false;
  if (is3d) {
    const padTop = Math.round(head.y + head.h + 8 * s), padBottom = Math.round(wide && !cinema ? M : H - panel.y + 8 * s);
    const padLeft = Math.round(wide && !cinema ? panel.x + panel.w : 0);
    const key = JSON.stringify([n, pts[0].lat, pts[0].lng, pts[n - 1].lat, pts[n - 1].lng, Math.round(D), W, H, duration, flyMap, line, padTop, padBottom, padLeft,
                                routeSeg ? `${chart}:${zoneColors}` : ""]);
    fly = await getFlyover(key, { points: pts, W, H, duration, map: flyMap, line, color: ui.route, padTop, padBottom, padLeft, colors: routeSeg });
    await fly.setFrame(0, { wait: true });
  } else if (bg === "map") {
    // lassú hálózaton (telefon) a több száz csempe sokáig tart, egy-egy el is akadhat: az előnézet az
    // első kép csempéi után indul (a többi menet közben jön), a felvétel legfeljebb 25 mp-et vár
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (preview) {
      const first = new Set();
      neededTiles(autoZoom ? camAt(0) : { k: 1, x: C.x, y: C.y }, first);
      await Promise.race([Promise.all([...first].map((u) => tile(u).p)), wait(5000)]);
      preloadTiles();
    } else await Promise.race([preloadTiles(), wait(25000)]);
  }

  timeMarks(marks); timeMarks(cards); timeMarks(shots);

  return {
    W, H, duration,
    offline: !!fly,                        // képkockánként kell felvenni (encodeScene)
    async prepareFrame(t) { if (fly) { await fly.setFrame(t, { wait: true }); prepared = true; } },
    draw(ctx, t) { draw(ctx, t); prepared = false; },
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


// ── Képkockánkénti kódolás (WebCodecs + MP4): a gép sebességétől függetlenül sima ─────────────
let _muxLoading = null;
function loadMuxer() {
  if (window.Mp4Muxer) return Promise.resolve(window.Mp4Muxer);
  _muxLoading ??= new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = "https://unpkg.com/mp4-muxer@5.1.3/build/mp4-muxer.js";
    sc.onload = () => res(window.Mp4Muxer);
    sc.onerror = () => { _muxLoading = null; rej(new Error("A videókódoló nem tölthető be (nincs internet?).")); };
    document.head.appendChild(sc);
  });
  return _muxLoading;
}
/** Tud-e a böngésző képkockánként MP4-et kódolni (WebCodecs). */
export const canEncode = () => typeof window.VideoEncoder === "function" && typeof window.VideoFrame === "function";

async function pickCodec(W, H, fps) {
  for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42e028", "avc1.640033"]) {
    const cfg = { codec, width: W, height: H, bitrate: 10_000_000, framerate: fps };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* következő */ }
  }
  throw new Error("Ez a böngésző nem tud MP4-et kódolni.");
}

/** Képkockánkénti felvétel WebCodecs nélkül (pl. http-oldalon): 1. minden képkocka előre
 *  kiszámolva, JPEG-ként eltárolva (a lassú 3D-rajzolás itt nem számít); 2. a kész képek pontos
 *  ütemben, valós időben lejátszva a MediaRecordernek – így a videó egyenletes. */
async function encodeSceneMR(canvas, scene, { onProgress, fps = 30 } = {}) {
  const mime = pickMime();
  if (!mime || !canvas.captureStream) throw new Error("Ez a böngésző nem tud videót készíteni.");
  canvas.width = scene.W; canvas.height = scene.H;
  const ctx = canvas.getContext("2d");
  const frames = Math.round(scene.duration * fps) + Math.round(fps * 0.3);
  const shots = [];
  scene.restart();
  // 1. előre: képkockák JPEG-ként (a folyamat ~85%-a)
  for (let i = 0; i < frames; i++) {
    const t = Math.min(scene.duration, i / fps);
    await scene.prepareFrame?.(t);
    scene.draw(ctx, t);
    shots.push(await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92)));
    onProgress?.(((i + 1) / frames) * 0.85);
  }
  scene.stop();
  // 2. lejátszás pontos ütemben a felvevőnek (előre dekódolva néhány képkockát)
  const bitmaps = new Map();
  let next = 0;
  const fill = () => { while (next < frames && bitmaps.size < 12) { const k = next++; bitmaps.set(k, createImageBitmap(shots[k])); } };
  fill();
  const first = await bitmaps.get(0);
  ctx.drawImage(first, 0, 0);
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  rec.start(250);
  await new Promise((resolve) => {
    const t0 = performance.now();
    let shown = 0;
    const tick = async () => {
      const k = Math.min(frames - 1, Math.floor(((performance.now() - t0) / 1000) * fps));
      if (k > shown || k === 0) {
        const bp = bitmaps.get(k);
        if (bp) {
          const bm = await bp;
          ctx.drawImage(bm, 0, 0);
          // a már elhagyott képkockák felszabadítása
          for (const key of [...bitmaps.keys()]) if (key <= k) { bitmaps.get(key).then((b) => b.close?.()); bitmaps.delete(key); }
          shown = k;
        }
        fill();
      }
      onProgress?.(0.85 + 0.15 * (k / (frames - 1)));
      if (k >= frames - 1 && performance.now() - t0 > (frames / fps) * 1000 + 150) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  rec.stop();
  await stopped;
  stream.getTracks().forEach((tr) => tr.stop());
  const type = mime.split(";")[0];
  return { blob: new Blob(chunks, { type }), ext: type.includes("mp4") ? "mp4" : "webm", mime: type };
}

/** Felvétel képkockánként: minden képkockánál megvárja a jelenetet (3D: csempék), MP4-et ad.
 *  WebCodecs nélkül (http-oldal, régebbi böngésző) a szüneteltetett MediaRecorder az út. */
export async function encodeScene(canvas, scene, opts = {}) {
  if (!canEncode()) return encodeSceneMR(canvas, scene, opts);
  const { onProgress, fps = 30 } = opts;
  const Mux = await loadMuxer();
  const W = scene.W, H = scene.H;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const cfg = await pickCodec(W, H, fps);
  const muxer = new Mux.Muxer({ target: new Mux.ArrayBufferTarget(), video: { codec: "avc", width: W, height: H, frameRate: fps }, fastStart: "in-memory" });
  let encErr = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
  enc.configure(cfg);
  scene.restart();
  const frames = Math.round(scene.duration * fps) + Math.round(fps * 0.3);   // a végén egy kis kitartás
  try {
    for (let i = 0; i < frames; i++) {
      if (encErr) throw encErr;
      const t = Math.min(scene.duration, i / fps);
      await scene.prepareFrame?.(t);
      scene.draw(ctx, t);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 5));
      onProgress?.((i + 1) / frames);
    }
    await enc.flush();
  } finally {
    try { enc.close(); } catch { /* már zárva */ }
    scene.stop();
  }
  if (encErr) throw encErr;
  muxer.finalize();
  return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), ext: "mp4", mime: "video/mp4" };
}
