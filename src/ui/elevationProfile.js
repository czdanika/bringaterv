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

function niceRange(min, max) {
  const range = max - min || 10;
  const step = Math.pow(10, Math.floor(Math.log10(range / 4)));
  return {
    niceMin: Math.floor(min / step) * step,
    niceMax: Math.ceil(max / step) * step,
    step,
  };
}

/**
 * Általános canvas vonaldiagram.
 * @param {HTMLCanvasElement} canvas
 * @param {{ onHover, onLeave }} callbacks
 * @returns {{ setData(data, opts), resize() }}
 *   opts: { color, unit, fillColor }
 */
export function initElevationChart(canvas, { onHover, onLeave } = {}) {
  let _data = [];
  let _opts = { color: "#fc4c02", unit: "m", fillColor: null };
  let _hoverIdx = -1;
  const PAD = { top: 16, right: 16, bottom: 28, left: 52 };

  function cssColor(variable, fallback) {
    const v = getCssVar(variable);
    return v || fallback;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!_data.length) return;

    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const maxDist = _data[_data.length - 1].dist;
    const validVals = _data.map((p) => p.value).filter((v) => v != null);
    if (!validVals.length) return;

    const rawMin = Math.min(...validVals);
    const rawMax = Math.max(...validVals);
    const { niceMin, niceMax } = niceRange(rawMin, rawMax);
    const valRange = niceMax - niceMin || 1;

    const xOf = (dist) => PAD.left + (dist / maxDist) * innerW;
    const yOf = (val) => PAD.top + innerH - ((val - niceMin) / valRange) * innerH;

    const mutedColor = cssColor("--text-muted", "#888");
    const lineColor = cssColor("--line", "rgba(0,0,0,0.1)");
    const color = _opts.color;

    // Grid + Y labels (5 vonal)
    for (let i = 0; i <= 4; i++) {
      const val = niceMin + (i / 4) * (niceMax - niceMin);
      const y = yOf(val);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + innerW, y);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = mutedColor;
      ctx.font = "11px Inter, sans-serif";
      ctx.textAlign = "right";
      const label = _opts.unit === "km/h"
        ? Math.round(val) + ""
        : Math.round(val) + " " + _opts.unit;
      ctx.fillText(label, PAD.left - 5, y + 4);
    }

    // X labels
    const distKm = maxDist / 1000;
    const kmStep = distKm > 50 ? 10 : distKm > 20 ? 5 : distKm > 10 ? 2 : distKm > 4 ? 1 : 0.5;
    const kmStepM = kmStep * 1000;
    for (let d = 0; d <= maxDist + 1; d += kmStepM) {
      if (d > maxDist + 1) break;
      const x = xOf(Math.min(d, maxDist));
      ctx.fillStyle = mutedColor;
      ctx.font = "11px Inter, sans-serif";
      ctx.textAlign = "center";
      const lbl = d >= 1000 ? (d / 1000).toFixed(d % 1000 === 0 ? 0 : 1) + " km" : d + " m";
      ctx.fillText(lbl, x, PAD.top + innerH + 18);
    }

    // Kitöltés
    const fillTop = _opts.fillColor ?? color.replace(")", ", 0.45)").replace("rgb(", "rgba(").replace("#", "");
    const [r, g, b] = hexToRgb(color);
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + innerH);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.40)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0.04)`);

    ctx.beginPath();
    let firstValid = true;
    _data.forEach((pt) => {
      if (pt.value == null) return;
      const x = xOf(pt.dist), y = yOf(pt.value);
      firstValid ? (ctx.moveTo(x, y), firstValid = false) : ctx.lineTo(x, y);
    });
    const lastPt = [..._data].reverse().find((p) => p.value != null);
    const firstPt = _data.find((p) => p.value != null);
    if (lastPt && firstPt) {
      ctx.lineTo(xOf(lastPt.dist), PAD.top + innerH);
      ctx.lineTo(xOf(firstPt.dist), PAD.top + innerH);
    }
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Vonal – ha van colorFn, szegmensenként rajzol különböző színekkel
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    const colorFn = _opts.colorFn;
    if (typeof colorFn === "function") {
      // Szegmensenkénti rajzolás: minden szakasz színe a kezdőpont értéke alapján.
      // A colorFn két argumentumot kap: (value, point) – elevationhez a point.grade is használható.
      let prev = null;
      _data.forEach((pt) => {
        if (pt.value == null) { prev = null; return; }
        const x = xOf(pt.dist), y = yOf(pt.value);
        if (prev) {
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(x, y);
          ctx.strokeStyle = colorFn(prev.v, prev.pt) ?? color;
          ctx.stroke();
        }
        prev = { x, y, v: pt.value, pt };
      });
    } else {
      ctx.beginPath();
      firstValid = true;
      _data.forEach((pt) => {
        if (pt.value == null) return;
        const x = xOf(pt.dist), y = yOf(pt.value);
        firstValid ? (ctx.moveTo(x, y), firstValid = false) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    // Hover
    if (_hoverIdx >= 0 && _hoverIdx < _data.length) {
      const pt = _data[_hoverIdx];
      if (pt.value != null) {
        const x = xOf(pt.dist), y = yOf(pt.value);
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, PAD.top + innerH);
        ctx.strokeStyle = "rgba(0,0,0,0.25)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [252, 76, 2];
  }

  function getIdxAtX(canvasX) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr;
    const innerW = W - PAD.left - PAD.right;
    const x = canvasX - PAD.left;
    if (x < 0 || x > innerW || !_data.length) return -1;
    const targetDist = (x / innerW) * _data[_data.length - 1].dist;
    let closest = 0, minDiff = Infinity;
    _data.forEach((pt, i) => {
      if (pt.value == null) return;
      const diff = Math.abs(pt.dist - targetDist);
      if (diff < minDiff) { minDiff = diff; closest = i; }
    });
    return closest;
  }

  function getIdxByDist(dist) {
    if (!_data.length) return -1;
    let closest = 0, minDiff = Infinity;
    _data.forEach((pt, i) => {
      if (pt.value == null) return;
      const diff = Math.abs(pt.dist - dist);
      if (diff < minDiff) { minDiff = diff; closest = i; }
    });
    return closest;
  }

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const scaleX = (canvas.width / dpr) / rect.width;
    const idx = getIdxAtX((e.clientX - rect.left) * scaleX);
    if (idx < 0) return;
    _hoverIdx = idx;
    draw();
    onHover?.(_data[idx], _opts);
  });

  canvas.addEventListener("mouseleave", () => {
    _hoverIdx = -1;
    draw();
    onLeave?.();
  });

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    draw();
  }

  return {
    setData(data, opts = {}) {
      _data = data;
      _opts = { color: "#fc4c02", unit: "m", ...opts };
      _hoverIdx = -1;
      resize();
    },
    resize,
    /** Külső hover szinkronizáláshoz: pozíció beállítása távolság alapján */
    setHoverByDist(dist) {
      const idx = getIdxByDist(dist);
      if (idx < 0) return;
      _hoverIdx = idx;
      draw();
    },
    /** Külső hover törlése */
    clearHover() {
      _hoverIdx = -1;
      draw();
    },
  };
}
