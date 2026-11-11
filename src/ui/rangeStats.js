/**
 * Szakasz-statisztika: egy nyomvonal-részlet (rajttól mért d0–d1 méter) számai –
 * a grafikonon kijelölt szakaszhoz és az emelkedő-listához.
 *
 *   computeRangeStats(geometry, d0, d1, { dists, riderKg }) → stats | null
 *   trackDists(geometry)                                    → [m] (a rajttól mért táv pontonként)
 *   renderRangeBar(el, stats, { onClose, onZoom })          → a grafikonok feletti sáv
 */
import { num, int } from "../format.js";

const R = 6371000;
function hav(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** A rajttól mért táv pontonként (ugyanúgy, mint a grafikonoknál). */
export function trackDists(geometry) {
  const out = new Array(geometry?.length || 0);
  let d = 0;
  for (let i = 0; i < out.length; i++) {
    if (i > 0) d += hav(geometry[i - 1], geometry[i]);
    out[i] = d;
  }
  return out;
}

/** Az első index, ahol dists[i] >= d (bináris keresés). */
export function idxAtDist(dists, d) {
  let lo = 0, hi = dists.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dists[mid] < d) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** „4:32” / „1:04:32” – másodpercből */
export function clock(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

const MOVING_KMH = 2;        // ennél lassabb mozgás = állás
const GAP_S = 30;            // ennél hosszabb kihagyás (jelvesztés / auto-pause) nem mozgásidő

/**
 * @returns {{ d0, d1, i0, i1, distM, elapsedS, movingS, speedKmh, ascM, descM, gradePct, maxGradePct,
 *            vam, hrAvg, hrMax, powerAvg, powerMax, wkg, cadAvg, tempAvg, hasTime } | null}
 */
export function computeRangeStats(geometry, d0, d1, { dists, riderKg } = {}) {
  if (!geometry || geometry.length < 2 || !(d1 > d0)) return null;
  dists = dists || trackDists(geometry);
  const i0 = Math.max(0, idxAtDist(dists, d0));
  const i1 = Math.min(geometry.length - 1, Math.max(i0 + 1, idxAtDist(dists, d1)));
  const pts = geometry.slice(i0, i1 + 1);
  const distM = dists[i1] - dists[i0];
  if (distM <= 0) return null;

  const hasTime = pts[0].time != null && pts[pts.length - 1].time != null;
  let elapsedS = null, movingS = null;
  if (hasTime) {
    elapsedS = (pts[pts.length - 1].time - pts[0].time) / 1000;
    movingS = 0;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].time == null || pts[i - 1].time == null) continue;
      const dt = (pts[i].time - pts[i - 1].time) / 1000;
      if (dt <= 0 || dt > GAP_S) continue;
      const v = (dists[i0 + i] - dists[i0 + i - 1]) / dt * 3.6;
      if (v >= MOVING_KMH) movingS += dt;
    }
    if (movingS <= 0) movingS = elapsedS;
  }

  // Emelkedés / ereszkedés – 3 m-es hiszterézissel (a domborzati zaj nélkül)
  let ascM = null, descM = null, gradePct = null, maxGradePct = null;
  const eles = pts.map((p) => p.ele);
  if (eles.some((v) => v != null)) {
    ascM = 0; descM = 0;
    let base = null;
    for (const v of eles) {
      if (v == null) continue;
      if (base == null) { base = v; continue; }
      if (v - base >= 3) { ascM += v - base; base = v; }
      else if (base - v >= 3) { descM += base - v; base = v; }
    }
    const first = eles.find((v) => v != null), last = [...eles].reverse().find((v) => v != null);
    gradePct = (last - first) / distM * 100;
    // legmeredekebb ~100 m-es rész (csúszó ablak)
    if (distM >= 150) {
      let j = 0;
      for (let i = 0; i < pts.length; i++) {
        if (eles[i] == null) continue;
        while (j < i && dists[i0 + i] - dists[i0 + j + 1] >= 100) j++;
        const dd = dists[i0 + i] - dists[i0 + j];
        if (dd >= 80 && eles[j] != null) {
          const g = (eles[i] - eles[j]) / dd * 100;
          if (maxGradePct == null || Math.abs(g) > Math.abs(maxGradePct)) maxGradePct = g;
        }
      }
    }
  }

  const avgOf = (key, { nonZero = false } = {}) => {
    let s = 0, n = 0, mx = null;
    for (const p of pts) {
      const v = p[key];
      if (v == null || (nonZero && v <= 0)) continue;
      s += v; n++;
      if (mx == null || v > mx) mx = v;
    }
    return n ? { avg: s / n, max: mx } : { avg: null, max: null };
  };
  const hr = avgOf("hr", { nonZero: true });
  const pw = avgOf("power");
  const cad = avgOf("cad", { nonZero: true });
  const tmp = avgOf("temp");

  const speedKmh = movingS ? distM / movingS * 3.6 : null;
  // VAM csak valódi mászásnál értelmes (emelkedő szakasz, legalább 30 m szint)
  const vam = movingS && ascM != null && ascM >= 30 && gradePct >= 2 ? ascM / (movingS / 3600) : null;
  const kg = Number(riderKg);
  return {
    d0: dists[i0], d1: dists[i1], i0, i1, distM, elapsedS, movingS, speedKmh, hasTime,
    ascM, descM, gradePct, maxGradePct, vam,
    hrAvg: hr.avg, hrMax: hr.max, powerAvg: pw.avg, powerMax: pw.max,
    wkg: pw.avg != null && kg > 20 ? pw.avg / kg : null,
    cadAvg: cad.avg, tempAvg: tmp.avg,
  };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** A kijelölt szakasz sávja a grafikonok fölött. */
export function renderRangeBar(el, st, { onClose, onZoom } = {}) {
  if (!el) return;
  if (!st) { el.hidden = true; el.innerHTML = ""; return; }
  const cell = (val, unit, label, title) =>
    `<div class="rs-cell"${title ? ` title="${esc(title)}"` : ""}><b>${val}${unit ? `<small>${unit}</small>` : ""}</b><span>${label}</span></div>`;
  const cells = [cell(num(st.distM / 1000, 2), "km", "Táv")];
  if (st.hasTime) {
    const paused = st.elapsedS - st.movingS > 30;
    cells.push(cell(clock(st.movingS), "", paused ? "Mozgásidő" : "Idő",
      paused ? `Teljes idő megállásokkal: ${clock(st.elapsedS)}` : ""));
    if (st.speedKmh != null) cells.push(cell(num(st.speedKmh, 1), "km/h", "Átl. sebesség"));
  }
  if (st.ascM != null) {
    cells.push(cell(`${int(st.ascM)}`, "m", `Emelkedés${st.descM >= 5 ? ` · ${int(st.descM)} m ↓` : ""}`));
    cells.push(cell(num(st.gradePct, 1), "%", "Átl. meredekség",
      st.maxGradePct != null ? `Legmeredekebb ~100 m: ${num(st.maxGradePct, 1)} %` : ""));
  }
  if (st.vam != null) cells.push(cell(int(st.vam), "m/ó", "VAM", "Függőleges mászási sebesség: emelkedés méter / óra"));
  if (st.hrAvg != null) cells.push(cell(int(st.hrAvg), "bpm", `Pulzus · max ${int(st.hrMax)}`));
  if (st.powerAvg != null) cells.push(cell(int(st.powerAvg), "W", st.wkg != null ? `Teljesítmény · ${num(st.wkg, 2)} W/kg` : `Teljesítmény · max ${int(st.powerMax)}`));
  if (st.cadAvg != null) cells.push(cell(int(st.cadAvg), "rpm", "Kadencia"));
  if (st.tempAvg != null) cells.push(cell(num(st.tempAvg, 1), "°C", "Hőmérséklet"));

  el.innerHTML = `
    <div class="rs-head">
      <span class="rs-title">Kijelölt szakasz <em>${num(st.d0 / 1000, 1)}–${num(st.d1 / 1000, 1)} km</em></span>
      <span class="rs-actions">
        <button type="button" class="rs-btn" data-rs="zoom" title="A szakasz a térképen">Térképen</button>
        <button type="button" class="rs-x" data-rs="close" title="Kijelölés törlése" aria-label="Kijelölés törlése">×</button>
      </span>
    </div>
    <div class="rs-cells">${cells.join("")}</div>`;
  el.hidden = false;
  el.querySelector('[data-rs="close"]').onclick = () => onClose?.();
  el.querySelector('[data-rs="zoom"]').onclick = () => onZoom?.();
}
