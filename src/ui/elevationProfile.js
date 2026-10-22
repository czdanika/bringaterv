import { num } from "../format.js";

/** Egyszínű diagrammód közös színe – app, megosztó kép, PDF, megosztott oldal. */
export const CHART_SOLID_GRAY = "#8B929C";
/** Igaz, ha a beállítás „Egyszínű” (alapértelmezés); „Zónaszín” módban hamis. */
export function isSolidChartMode() {
  try { return JSON.parse(localStorage.getItem("bringaterv.chartColors") || "null")?.mode !== "zones"; }
  catch { return true; }
}
/**
 * Általános vonaldiagram – szintprofil / sebesség / pulzus
 * Adatformátum: [{ dist, value, lat, lng }]
 */

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

function buildDistances(geometry) {
  let dist = 0;
  return geometry.map((pt, i) => {
    if (i > 0) dist += haversineMeters(geometry[i - 1], pt);
    return dist;
  });
}

/** A nyomvonal pontjai a rajttól mért távolsággal: [{ dist, lat, lng }] (pl. a szélgrafikonhoz) */
export function buildTrackDistances(geometry) {
  if (!geometry || geometry.length < 2) return [];
  const dists = buildDistances(geometry);
  return geometry.map((pt, i) => ({ dist: dists[i], lat: pt.lat, lng: pt.lng }));
}

/** Magassági adat: { dist, value: ele, grade %, lat, lng } */
export function buildElevationData(geometry) {
  if (!geometry || geometry.length < 2) return [];
  if (!geometry.some((p) => p.ele != null)) return [];
  const dists = buildDistances(geometry);
  return geometry.map((pt, i) => {
    let grade = null;
    if (pt.ele != null && i > 0 && geometry[i - 1].ele != null) {
      const dEle = pt.ele - geometry[i - 1].ele;
      const dDist = dists[i] - dists[i - 1];
      if (dDist > 0) grade = (dEle / dDist) * 100;
    }
    return {
      dist: dists[i], value: pt.ele ?? null, grade,
      lat: pt.lat, lng: pt.lng,
    };
  });
}

/** Sebesség adat: { dist, value: speed km/h, lat, lng } */
export function buildSpeedData(geometry) {
  if (!geometry || geometry.length < 2) return [];
  if (!geometry.some((p) => p.speed != null)) return [];
  const dists = buildDistances(geometry);
  return geometry
    .map((pt, i) => ({ dist: dists[i], value: pt.speed ?? null, lat: pt.lat, lng: pt.lng }))
    .filter((_, i) => geometry[i].speed != null || i === 0); // ne szűrjük ki a nullakat teljesen
}

/** Kadencia adat: { dist, value: cad rpm, lat, lng } */
export function buildCadData(geometry) {
  if (!geometry || geometry.length < 2) return [];
  if (!geometry.some((p) => p.cad != null)) return [];
  const dists = buildDistances(geometry);
  return geometry.map((pt, i) => ({
    dist: dists[i], value: pt.cad ?? null, lat: pt.lat, lng: pt.lng,
  }));
}

/** Power adat: { dist, value: watts, lat, lng } */
export function buildPowerData(geometry) {
  if (!geometry || geometry.length < 2) return [];
  if (!geometry.some((p) => p.power != null)) return [];
  const dists = buildDistances(geometry);
  return geometry.map((pt, i) => ({
    dist: dists[i], value: pt.power ?? null, lat: pt.lat, lng: pt.lng,
  }));
}

/** Pulzus adat: { dist, value: hr bpm, lat, lng } */
export function buildHrData(geometry) {
  if (!geometry || geometry.length < 2) return [];
  if (!geometry.some((p) => p.hr != null)) return [];
  const dists = buildDistances(geometry);
  return geometry.map((pt, i) => ({
    dist: dists[i], value: pt.hr ?? null, lat: pt.lat, lng: pt.lng,
  }));
}

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** „Szép” tengelyhatárok: kerek lépésköz, a min/max a lépésköz többszörösére kerekítve. */
function niceRange(min, max) {
  const range = max - min || 10;
  const raw = range / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || pow * 10;
  return {
    niceMin: Math.floor(min / step) * step,
    niceMax: Math.ceil(max / step) * step,
    step,
  };
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ""));
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [232, 70, 30];
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Közös canvas vonaldiagram – mind a hat grafikon (szint, sebesség, pulzus,
 * kadencia, teljesítmény, szél) ezt használja, ezért egységes a kinézetük:
 * halvány szaggatott rács, apró tengelyfeliratok, színezett vonal halvány
 * kitöltéssel, A / B / útvonalpont-jelölők, és felugró címke rámutatáskor.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ onHover, onLeave }} callbacks
 * @returns {{ setData(data, opts), resize(), setHoverByDist(dist), clearHover(), setMarkers(markers) }}
 *   opts: {
 *     color,          – egyszínű mód színe (#rrggbb)
 *     unit,           – mértékegység a tengelyen
 *     colorFn(v, pt), – zónaszín: szakaszonkénti szín (null → egyszínű)
 *     formatTip(pt),  – a felugró címke sorai: [első, második?]
 *     minRange,       – legalább ekkora függőleges tartomány (pl. szintnél 20 m)
 *     zeroBase,       – a függőleges tengely 0-tól induljon (pl. szélerősség)
 *   }
 *   markers: [{ dist, label, color, line }] – felül kis kör felirattal; line → szaggatott függőleges
 */
export function initElevationChart(canvas, { onHover, onLeave } = {}) {
  let _data = [];
  let _opts = { color: "#e8461e", unit: "m" };
  let _markers = [];
  let _hoverIdx = -1;
  let _hoverLocal = false;     // ezen a grafikonon van-e az egér (csak itt jelenik meg a címke)

  const pad = () => ({ top: _markers.length ? 22 : 10, right: _markers.length ? 16 : 10, bottom: 20, left: 44 });

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!_data.length) return;
    const PAD = pad();

    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const maxDist = _data[_data.length - 1].dist || 1;
    const validVals = _data.map((p) => p.value).filter((v) => v != null);
    if (!validVals.length || innerW <= 0 || innerH <= 0) return;

    let rawMin = Math.min(...validVals);
    let rawMax = Math.max(...validVals);
    if (_opts.minRange && rawMax - rawMin < _opts.minRange) {
      const mid = (rawMin + rawMax) / 2;
      rawMin = mid - _opts.minRange / 2; rawMax = mid + _opts.minRange / 2;
    }
    if (_opts.zeroBase) rawMin = Math.min(0, rawMin);
    const { niceMin, niceMax, step } = niceRange(rawMin, rawMax);
    const valRange = niceMax - niceMin || 1;

    const xOf = (dist) => PAD.left + (dist / maxDist) * innerW;
    const yOf = (val) => PAD.top + innerH - ((val - niceMin) / valRange) * innerH;

    const muted = getCssVar("--text-muted") || getCssVar("--muted") || "#9ca3af";
    const gridColor = getCssVar("--line") || "rgba(0,0,0,0.08)";
    const textColor = getCssVar("--text") || "#1a1d23";
    const color = _opts.color || "#e8461e";
    const colorFn = typeof _opts.colorFn === "function" ? _opts.colorFn : null;
    ctx.font = "10.5px Inter, system-ui, sans-serif";

    // Vízszintes rács + értékfeliratok (szaggatott, halvány)
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    for (let v = niceMin; v <= niceMax + step / 2; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = gridColor;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + innerW, y); ctx.stroke();
      ctx.fillStyle = muted;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const label = Math.round(v) + (_opts.unit === "m" ? " m" : "");
      ctx.fillText(label, PAD.left - 6, y);
    }

    // Függőleges km-rács + feliratok
    const distKm = maxDist / 1000;
    // A lépésköz a szélességhez igazodik: két felirat között legalább ~52 px legyen
    const kmStep = [0.5, 1, 2, 5, 10, 20, 50, 100, 200].find((st) => innerW * st / Math.max(distKm, 0.1) >= 52) || 500;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (let d = 0; d <= maxDist + 1; d += kmStep * 1000) {
      const x = Math.round(xOf(d)) + 0.5;
      if (d > 0) {
        ctx.strokeStyle = gridColor;
        ctx.globalAlpha = 0.6;
        ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + innerH); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = muted;
      const lbl = d === 0 ? "0 km" : num(d / 1000, d % 1000 === 0 ? 0 : 1) + " km";
      ctx.fillText(lbl, Math.min(Math.max(x, PAD.left + 12), PAD.left + innerW - 14), H - 5);
    }
    ctx.setLineDash([]);

    // Kitöltés: zónaszínnél szakaszonként a szakasz színével, egyszínűnél színátmenettel
    const baseY = PAD.top + innerH;
    if (colorFn) {
      let prev = null;
      _data.forEach((pt) => {
        if (pt.value == null) { prev = null; return; }
        const x = xOf(pt.dist), y = yOf(pt.value);
        if (prev) {
          const c = colorFn(prev.v, prev.pt) || color;
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, y); ctx.lineTo(x, baseY); ctx.lineTo(prev.x, baseY);
          ctx.closePath();
          const [r, g, b] = hexToRgb(c);
          ctx.fillStyle = `rgba(${r},${g},${b},0.15)`;
          ctx.fill();
        }
        prev = { x, y, v: pt.value, pt };
      });
    } else {
      const [r, g, b] = hexToRgb(color);
      const grad = ctx.createLinearGradient(0, PAD.top, 0, baseY);
      grad.addColorStop(0, `rgba(${r},${g},${b},0.24)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0.03)`);
      ctx.beginPath();
      let first = null, last = null;
      _data.forEach((pt) => {
        if (pt.value == null) return;
        const x = xOf(pt.dist), y = yOf(pt.value);
        if (!first) { ctx.moveTo(x, y); first = x; } else ctx.lineTo(x, y);
        last = x;
      });
      if (first != null) {
        ctx.lineTo(last, baseY); ctx.lineTo(first, baseY); ctx.closePath();
        ctx.fillStyle = grad; ctx.fill();
      }
    }

    // Vonal
    ctx.lineWidth = 2.2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (colorFn) {
      let prev = null;
      _data.forEach((pt) => {
        if (pt.value == null) { prev = null; return; }
        const x = xOf(pt.dist), y = yOf(pt.value);
        if (prev) {
          ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, y);
          ctx.strokeStyle = colorFn(prev.v, prev.pt) || color;
          ctx.stroke();
        }
        prev = { x, y, v: pt.value, pt };
      });
    } else {
      ctx.beginPath();
      let started = false;
      _data.forEach((pt) => {
        if (pt.value == null) { started = false; return; }
        const x = xOf(pt.dist), y = yOf(pt.value);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    // Jelölők: A / B / útvonalpontok – felül kis kör, közbülsőknél szaggatott vonal
    _markers.forEach((m) => {
      if (m.dist == null) return;
      const x = xOf(Math.max(0, Math.min(maxDist, m.dist)));
      if (m.line) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = m.color || "#2563eb";
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, baseY); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }
      const cy = PAD.top - 11;
      ctx.beginPath(); ctx.arc(x, cy, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = m.color || "#2563eb"; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = "#fff"; ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "700 9.5px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(m.label ?? ""), x, cy + 0.5);
    });

    // Rámutatás: függőleges vonal + pont; a címke csak azon a grafikonon, amelyik fölött az egér van
    if (_hoverIdx >= 0 && _hoverIdx < _data.length) {
      const pt = _data[_hoverIdx];
      if (pt.value != null) {
        const x = xOf(pt.dist), y = yOf(pt.value);
        ctx.strokeStyle = textColor;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, PAD.top); ctx.lineTo(Math.round(x) + 0.5, baseY); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff"; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = (colorFn && colorFn(pt.value, pt)) || color; ctx.stroke();

        if (_hoverLocal) {
          const lines = (_opts.formatTip?.(pt) || [`${num(pt.dist / 1000, 2)} km · ${Math.round(pt.value)} ${_opts.unit || ""}`])
            .filter(Boolean);
          ctx.font = "700 12px Inter, system-ui, sans-serif";
          const w1 = ctx.measureText(lines[0]).width;
          ctx.font = "11.5px Inter, system-ui, sans-serif";
          const w2 = lines[1] ? ctx.measureText(lines[1]).width : 0;
          const bw = Math.max(w1, w2) + 20, bh = lines[1] ? 38 : 24;
          let bx = x + 10;
          if (bx + bw > W - 4) bx = x - 10 - bw;
          let by = y - bh - 8;
          if (by < 2) by = y + 10;
          if (by + bh > H - 2) by = H - bh - 2;
          roundRect(ctx, bx, by, bw, bh, 7);
          ctx.fillStyle = "rgba(26,29,35,0.94)"; ctx.fill();
          ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
          ctx.fillStyle = "#fff";
          ctx.font = "700 12px Inter, system-ui, sans-serif";
          ctx.fillText(lines[0], bx + 10, by + (lines[1] ? 16 : 16));
          if (lines[1]) {
            ctx.fillStyle = "#d1d5db";
            ctx.font = "11.5px Inter, system-ui, sans-serif";
            ctx.fillText(lines[1], bx + 10, by + 31);
          }
        }
      }
    }
  }

  function getIdxAtX(canvasX) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr;
    const PAD = pad();
    const innerW = W - PAD.left - PAD.right;
    const x = canvasX - PAD.left;
    if (x < 0 || x > innerW || !_data.length) return -1;
    return getIdxByDist((x / innerW) * _data[_data.length - 1].dist);
  }

  function getIdxByDist(dist) {
    if (!_data.length) return -1;
    // bináris keresés (a dist növekvő) – hosszú edzésnél is gyors
    let lo = 0, hi = _data.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (_data[mid].dist < dist) lo = mid; else hi = mid;
    }
    let idx = Math.abs(_data[lo].dist - dist) <= Math.abs(_data[hi].dist - dist) ? lo : hi;
    // ha ott nincs érték, a legközelebbi értékes pont
    for (let k = 0; k < 50 && _data[idx]?.value == null; k++) {
      if (_data[idx + k]?.value != null) { idx += k; break; }
      if (_data[idx - k]?.value != null) { idx -= k; break; }
    }
    return idx;
  }

  // Egér ÉS ujj: pointer események. Érintésnél a vízszintes húzás „szkennel”
  // (a térképen mutatja a pontot), a függőleges továbbra is görgeti az oldalt.
  canvas.style.touchAction = "pan-y";
  function hoverAt(clientX) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const scaleX = (canvas.width / dpr) / rect.width;
    const idx = getIdxAtX((clientX - rect.left) * scaleX);
    if (idx < 0) return;
    _hoverIdx = idx;
    _hoverLocal = true;
    draw();
    onHover?.(_data[idx], _opts, api);
  }
  canvas.addEventListener("pointermove", (e) => hoverAt(e.clientX));
  canvas.addEventListener("pointerdown", (e) => hoverAt(e.clientX));

  function clearHover() {
    _hoverIdx = -1;
    _hoverLocal = false;
    draw();
    onLeave?.();
  }
  // Egérnél az elhagyáskor tűnik el; ujjnál a felemeléskor is megmarad a pont,
  // amíg máshová nem koppintasz (így a térképen megnézhető)
  canvas.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") clearHover(); });
  canvas.addEventListener("pointercancel", (e) => { if (e.pointerType !== "mouse") clearHover(); });

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    draw();
  }

  const api = {
    setData(data, opts = {}) {
      _data = data;
      _opts = { color: "#e8461e", unit: "m", ...opts };
      _hoverIdx = -1;
      _hoverLocal = false;
      resize();
    },
    resize,
    /** Jelölők (A / B / útvonalpontok) – távolság méterben */
    setMarkers(markers) {
      _markers = Array.isArray(markers) ? markers : [];
      draw();
    },
    /** Külső hover szinkronizáláshoz: pozíció beállítása távolság alapján (címke nélkül) */
    setHoverByDist(dist) {
      const idx = getIdxByDist(dist);
      if (idx < 0) return;
      _hoverIdx = idx;
      _hoverLocal = false;
      draw();
    },
    /** Külső hover törlése */
    clearHover() {
      _hoverIdx = -1;
      _hoverLocal = false;
      draw();
    },
    /** A jelenleg rámutatott pont (a szinkronhoz) */
    get hoverIdx() { return _hoverIdx; },
  };
  return api;
}
