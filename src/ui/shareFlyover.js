/**
 * Bringaterv – 3D berepülés a megosztó videóhoz
 * =============================================
 * MapLibre GL (első használatkor töltődik be) domborzattal (AWS Terrain Tiles, nyílt adat) és
 * műhold- vagy terepi térképpel. A kamera madártávlatból követi a nyomvonalat: az elején
 * felülről látszik az egész útvonal, aztán „lerepül” a rajthoz, végigköveti a haladást (a
 * haladási irányba fordulva), a végén visszaemelkedik a teljes útvonalra.
 *
 * Képkockánként rajzolható (setFrame(t, { wait: true }) – megvárja a csempéket), így a felvétel
 * a gép sebességétől függetlenül sima (WebCodecs – shareVideo.encodeScene).
 *
 *   createFlyover({ points, W, H, duration, map, line, color }) → Promise<flyover>
 *     flyover.setFrame(t, { wait }) → Promise   kamera + a megtett szakasz a t. másodpercben
 *     flyover.canvas                            a WebGL vászon (preserveDrawingBuffer)
 *     flyover.project(i)                        a nyomvonal i. pontja / a fej képernyő-helye
 *     flyover.headAt(t) → { x, y } | null
 *     flyover.destroy()
 */

const ML_VER = "4.7.1";
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const DEM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

export const FLY_MAPS = [
  { id: "satellite", label: "Műhold", tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
    ref: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`], maxzoom: 18 },
  { id: "topo", label: "Terep", tiles: [`${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`], maxzoom: 17 },
];

let _mlLoading = null;
function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = href;
  document.head.appendChild(l);
}
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error("A 3D térkép nem tölthető be (nincs internet?)."));
    document.head.appendChild(s);
  });
}
export function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  _mlLoading ??= (loadCss(`https://unpkg.com/maplibre-gl@${ML_VER}/dist/maplibre-gl.css`),
    loadScript(`https://unpkg.com/maplibre-gl@${ML_VER}/dist/maplibre-gl.js`).then(() => window.maplibregl));
  return _mlLoading;
}

/** Tud-e a böngésző WebGL-t (a 3D-hez kell). */
export function flyoverSupported() {
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); }
  catch { return false; }
}

/** A még meg nem tett szakasz: a vonal színe halványan (a műholdkép fehér határvonalaitól elváljon). */
function ghostColor(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  return Number.isFinite(n) ? `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},0.42)` : "rgba(255,106,61,0.42)";
}

// ── geometria ────────────────────────────────────────────────────────────────
const R = 6371000, toR = Math.PI / 180;
function hav(a, b) {
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearingDeg(a, b) {
  const y = Math.sin((b.lng - a.lng) * toR) * Math.cos(b.lat * toR);
  const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lng - a.lng) * toR);
  return (Math.atan2(y, x) / toR + 360) % 360;
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const lerp = (a, b, k) => a + (b - a) * k;
const lerpAngle = (a, b, k) => { let d = ((b - a + 540) % 360) - 180; return a + d * k; };

function waitIdle(map, ms = 6000) {
  return new Promise((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    map.once("idle", fin);
    setTimeout(fin, ms);
    map.triggerRepaint();
  });
}

export async function createFlyover({
  points, W, H, duration = 12, map: mapId = "satellite", line = "normal", color = "#ff6a3d",
  intro = 1.6, outro = 2.8,          // mp: felülnézetből lerepülés / a végén visszaemelkedés
  exaggeration = 1.5,                // a domborzat nagyítása (látványosabb)
  padTop = 0, padBottom = 0,          // a fejléc / alsó panel alatti rész (px) – a fej ne kerüljön alájuk
}) {
  const ml = await loadMapLibre();
  const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (pts.length < 2) throw new Error("Ehhez az edzéshez nincs nyomvonal.");
  const n = pts.length;
  const d = new Float64Array(n);
  for (let i = 1; i < n; i++) d[i] = d[i - 1] + hav(pts[i - 1], pts[i]);
  const D = d[n - 1] || 1;
  const def = FLY_MAPS.find((m) => m.id === mapId) || FLY_MAPS[0];
  const LWk = { thin: 0.55, normal: 1, bold: 1.6 }[line] || 1;

  // rejtett tároló a WebGL-térképnek (a kép mérete pontosan W × H, pixelRatio 1)
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:-${W + 4000}px;top:0;width:${W}px;height:${H}px;pointer-events:none;`;
  document.body.appendChild(box);

  const coords = pts.map((p) => [p.lng, p.lat]);
  const style = {
    version: 8,
    sources: {
      base: { type: "raster", tiles: def.tiles, tileSize: 256, maxzoom: def.maxzoom },
      ...(def.ref ? { ref: { type: "raster", tiles: def.ref, tileSize: 256, maxzoom: 17 } } : {}),
      dem: { type: "raster-dem", tiles: [DEM], encoding: "terrarium", tileSize: 256, maxzoom: 13 },
      demShade: { type: "raster-dem", tiles: [DEM], encoding: "terrarium", tileSize: 256, maxzoom: 13 },
      route: { type: "geojson", lineMetrics: true, data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } },
    },
    layers: [
      { id: "base", type: "raster", source: "base", paint: def.id === "topo" ? { "raster-saturation": 0.25 } : { "raster-saturation": -0.05, "raster-contrast": 0.08 } },
      { id: "shade", type: "hillshade", source: "demShade", paint: { "hillshade-exaggeration": 0.25, "hillshade-shadow-color": "rgba(0,0,0,0.35)" } },
      ...(def.ref ? [{ id: "ref", type: "raster", source: "ref", paint: { "raster-opacity": 0.9 } }] : []),
      { id: "ghost", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ghostColor(color), "line-width": 2.6 * LWk } },
      ...(line === "thin" ? [] : [{ id: "casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-width": 4.6 * LWk + 2.5, "line-gradient": ["step", ["line-progress"], "rgba(255,255,255,0.95)", 0.0001, "rgba(0,0,0,0)"] } }]),
      { id: "done", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-width": 4.6 * LWk, "line-gradient": ["step", ["line-progress"], color, 0.0001, "rgba(0,0,0,0)"] } },
    ],
    terrain: { source: "dem", exaggeration },
    sky: { "sky-color": "#a9cbe8", "horizon-color": "#e6eef5", "fog-color": "#e6eef5", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.75, "atmosphere-blend": 0.6 },
  };

  const map = new ml.Map({
    container: box, style, interactive: false, attributionControl: false, fadeDuration: 0,
    preserveDrawingBuffer: true, pixelRatio: 1, maxPitch: 75, antialias: true,
  });
  // egy-egy csempe hibája (pl. tenger, hiányzó domborzat) nem végzetes – csak naplózzuk
  map.on("error", (e) => console.warn("3D térkép:", e?.error?.message || e, e?.sourceId || "", e?.tile?.tileID?.canonical || ""));
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("A 3D térkép nem indult el (lassú vagy nincs internet).")), 30000);
    map.once("load", () => { clearTimeout(to); res(); });
  });

  // ── kamera-terv ──
  const bounds = coords.reduce((b, c) => b.extend(c), new ml.LngLatBounds(coords[0], coords[0]));
  const pad = { top: padTop + 40, bottom: padBottom + 40, left: 60, right: 60 };
  const over = map.cameraForBounds(bounds, { padding: pad, bearing: 0, pitch: 0 }) || { center: bounds.getCenter(), zoom: 10 };
  const overView = { lng: over.center.lng, lat: over.center.lat, zoom: over.zoom - 0.15, pitch: 30, bearing: 0 };
  const t0 = intro, t1 = Math.max(intro + 2, duration - outro);
  // haladás: egyenletes tempó rövid fel- és lelassulással (a csúcs csak ~1,14× az átlag –
  // az easeInOut középen 1,5×-ös volt, ott száguldott a kép)
  const RAMP = 0.12, VMAX = 1 / (1 - RAMP);
  const trap = (u) => (u < RAMP ? VMAX * u * u / (2 * RAMP)
    : u > 1 - RAMP ? 1 - VMAX * (1 - u) * (1 - u) / (2 * RAMP) : VMAX * (u - RAMP / 2));
  const progAt = (t) => trap(clamp01((t - t0) / (t1 - t0)));
  // követés magassága a tempóhoz: a föld képkockánként legfeljebb a képszélesség ~2%-át
  // haladja (30 fps) – rövid útnál közelebb, hosszúnál magasabbról
  const vPeak = (D / (t1 - t0)) * VMAX;                 // m / s
  const span = Math.max(1500, vPeak / (30 * 0.02));     // ennyi méter látszik szélességben
  const latC = (bounds.getNorth() + bounds.getSouth()) / 2;
  const followZoom = Math.min(over.zoom + 2.2, Math.log2((156543.03 * Math.cos(latC * toR) * W) / span));
  const look = Math.max(400, span * 0.5, D * 0.12);   // az irány ennyivel előre / hátra nézve (m)
  const pointAt = (dist) => {
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (d[m] <= dist) lo = m; else hi = m - 1; }
    if (lo >= n - 1) return { lng: pts[n - 1].lng, lat: pts[n - 1].lat };
    const r = clamp01((dist - d[lo]) / Math.max(1e-6, d[lo + 1] - d[lo]));
    return { lng: lerp(pts[lo].lng, pts[lo + 1].lng, r), lat: lerp(pts[lo].lat, pts[lo + 1].lat, r) };
  };
  // irány a haladás mentén, erősen simítva (ne forogjon idegesen)
  const NB = 240, bear = new Float64Array(NB + 1);
  for (let q = 0; q <= NB; q++) {
    const dist = (q / NB) * D;
    // a kamera a bringás mögött: a megtett út alulról fut be a képbe
    bear[q] = bearingDeg(pointAt(Math.max(0, dist - look)), pointAt(Math.min(D, dist + look * 0.6)));
  }
  for (let q = 1; q <= NB; q++) { let x = bear[q]; while (x - bear[q - 1] > 180) x -= 360; while (x - bear[q - 1] < -180) x += 360; bear[q] = x; }
  const smooth = (a, w) => a.map((_, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - w); k <= Math.min(a.length - 1, i + w); k++) { s += a[k]; c++; } return s / c; });
  let bs = smooth(Array.from(bear), 10); bs = smooth(bs, 10);   // ±4% táv: kis kanyarokra nem fordul
  const bearingAt = (p) => { const f = p * NB, i = Math.floor(f), k = f - i; return lerp(bs[Math.min(NB, i)], bs[Math.min(NB, i + 1)], k); };

  // a felülnézet az induló / érkező irányban áll (nem északra) – így nincs nagy fordulás az átmenetben
  const overAt = (bearing) => {
    const c = map.cameraForBounds(bounds, { padding: pad, bearing, pitch: 0 });
    return c ? { lng: c.center.lng, lat: c.center.lat, zoom: c.zoom - 0.15, pitch: 30, bearing }
             : { ...overView, bearing };
  };
  const introView = overAt(bs[0]), outroView = overAt(bs[NB]);
  const followCam = (p) => {
    const c = pointAt(p * D);
    return { lng: c.lng, lat: c.lat, zoom: followZoom, pitch: 62, bearing: bearingAt(p) };
  };
  function cameraAt(t) {
    const p = progAt(t);
    if (t < t0) {             // felülnézetből le a rajthoz
      const k = easeInOut(clamp01(t / t0));
      const a = introView, b = followCam(0);
      return { lng: lerp(a.lng, b.lng, k), lat: lerp(a.lat, b.lat, k), zoom: lerp(a.zoom, b.zoom, k), pitch: lerp(a.pitch, b.pitch, k), bearing: lerpAngle(a.bearing, b.bearing, k) };
    }
    if (t > t1) {             // vissza a teljes útvonalra
      const k = easeInOut(clamp01((t - t1) / Math.max(0.5, outro - 0.6)));
      const a = followCam(1), b = outroView;
      return { lng: lerp(a.lng, b.lng, k), lat: lerp(a.lat, b.lat, k), zoom: lerp(a.zoom, b.zoom, k), pitch: lerp(a.pitch, b.pitch, k), bearing: lerpAngle(a.bearing, b.bearing, k) };
    }
    return followCam(p);
  }

  // ── a teljes kamerapálya előre, időben simítva (ne rángasson: kanyar, átmenetek) ──
  const SR = 60, NS = Math.max(2, Math.ceil(duration * SR));
  const raw = Array.from({ length: NS + 1 }, (_, q) => cameraAt(q / SR));
  for (let q = 1; q <= NS; q++) {   // az irány folytonos legyen (ne ugorjon 359° → 0°)
    let b = raw[q].bearing;
    while (b - raw[q - 1].bearing > 180) b -= 360;
    while (b - raw[q - 1].bearing < -180) b += 360;
    raw[q].bearing = b;
  }
  // a fordulás sebessége korlátozva (~1,2° / képkocka 30 fps-nél) – a döntött nézetben a gyors
  // forgás söpri végig a horizontot; a folytonos (kibontott) irányon, így a lemaradás nem fordul át
  {
    const MAXD = 36 / SR;
    let prev = raw[0].bearing;
    for (let q = 1; q <= NS; q++) { prev += Math.max(-MAXD, Math.min(MAXD, raw[q].bearing - prev)); raw[q].bearing = prev; }
  }
  const smoothKey = (key, sec) => {
    let a = raw.map((c) => c[key]);
    const w = Math.max(1, Math.round(sec * SR));
    for (let pass = 0; pass < 3; pass++) {   // háromszoros mozgóátlag ≈ Gauss-simítás
      const pre = new Float64Array(a.length + 1);
      for (let i = 0; i < a.length; i++) pre[i + 1] = pre[i] + a[i];
      a = a.map((_, i) => { const lo = Math.max(0, i - w), hi = Math.min(a.length - 1, i + w); return (pre[hi + 1] - pre[lo]) / (hi - lo + 1); });
    }
    return a;
  };
  const camS = { lng: smoothKey("lng", 0.25), lat: smoothKey("lat", 0.25), zoom: smoothKey("zoom", 0.3),
                 pitch: smoothKey("pitch", 0.3), bearing: smoothKey("bearing", 0.9) };
  function cameraSmooth(t) {
    const f = Math.max(0, Math.min(NS, t * SR)), i = Math.floor(f), j = Math.min(NS, i + 1), k = f - i;
    const g = (key) => lerp(camS[key][i], camS[key][j], k);
    return { lng: g("lng"), lat: g("lat"), zoom: g("zoom"), pitch: g("pitch"), bearing: g("bearing") };
  }

  const padding = { top: padTop, bottom: padBottom, left: 0, right: 0 };
  let lastP = -1;
  function apply(t) {
    const cam = cameraSmooth(t);
    map.jumpTo({ center: [cam.lng, cam.lat], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, padding });
    const p = t >= t1 ? 1 : progAt(t);
    if (Math.abs(p - lastP) > 1e-5) {
      lastP = p;
      const cut = Math.max(0.0001, Math.min(0.9999, p));
      const grad = (c) => (p >= 0.9999 ? ["step", ["line-progress"], c, 1.1, c] : ["step", ["line-progress"], c, cut, "rgba(0,0,0,0)"]);
      map.setPaintProperty("done", "line-gradient", p <= 0 ? ["step", ["line-progress"], "rgba(0,0,0,0)", 0.5, "rgba(0,0,0,0)"] : grad(color));
      if (map.getLayer("casing")) map.setPaintProperty("casing", "line-gradient", p <= 0 ? ["step", ["line-progress"], "rgba(0,0,0,0)", 0.5, "rgba(0,0,0,0)"] : grad("rgba(255,255,255,0.95)"));
    }
    return p;
  }

  return {
    canvas: map.getCanvas(),
    intro: t0, drawEnd: t1,
    progressAt: (t) => (t >= t1 ? 1 : progAt(t)),
    async setFrame(t, { wait = false } = {}) {
      apply(t);
      if (wait) await waitIdle(map); else map.triggerRepaint();
    },
    /** A fej (a megtett szakasz vége) képernyő-helye a vásznon. */
    headAt(t) {
      const p = t >= t1 ? 1 : progAt(t);
      const c = pointAt(p * D);
      const el = map.queryTerrainElevation ? map.queryTerrainElevation([c.lng, c.lat]) : 0;
      const q = map.project([c.lng, c.lat], el || 0);
      return Number.isFinite(q?.x) ? { x: q.x, y: q.y } : null;
    },
    startAt() { const q = map.project(coords[0], map.queryTerrainElevation?.(coords[0]) || 0); return { x: q.x, y: q.y }; },
    /** Előtöltés: a kamerapálya mentén minden csempe (hogy a felvétel ne várjon sokat). */
    async preload(steps = 16) {
      for (let q = 0; q <= steps; q++) { apply((q / steps) * duration); await waitIdle(map, 8000); }
      lastP = -1;
    },
    /** Hibakereséshez: a nyers és a simított kamera a t. másodpercben. */
    debugCamera: (t) => ({ raw: cameraAt(t), smooth: cameraSmooth(t) }),
    destroy() { try { map.remove(); } catch { /* már nincs */ } box.remove(); },
  };
}
