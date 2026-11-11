/**
 * „Ugyanezen az útvonalon” kártya az Elemzésben: a korábbi edzések ugyanazon a nyomvonalon
 * (szerver: POST /api/routes/similar), időkülönbséggel; egyre kattintva a km szerinti
 * időkülönbség-görbe (hol nyertél / vesztettél időt) – a megállások nem számítanak.
 *
 *   initCompare({ api, importGpx, getGeometry, getRouteId, getLibraryData, onPick })
 */
import { num } from "../format.js";
import { trackDists, clock } from "./rangeStats.js";

const MOVING_KMH = 2, GAP_S = 30, STEP_M = 200;

/** Halmozott mozgásidő (mp) pontonként – a megállások és a kihagyások nélkül. */
function movingCum(g, dists) {
  const out = new Array(g.length).fill(0);
  for (let i = 1; i < g.length; i++) {
    out[i] = out[i - 1];
    if (g[i].time == null || g[i - 1].time == null) continue;
    const dt = (g[i].time - g[i - 1].time) / 1000;
    if (dt <= 0 || dt > GAP_S) continue;
    if ((dists[i] - dists[i - 1]) / dt * 3.6 >= MOVING_KMH) out[i] += dt;
  }
  return out;
}

const fmtDelta = (s) => Math.abs(s) < 1 ? "0:00" : `${s < 0 ? "−" : "+"}${clock(Math.abs(s))}`;
const fmtDate = (r) => {
  const t = new Date(r.start_time || r.date);
  return Number.isFinite(t.getTime()) ? `${t.getFullYear()}.${String(t.getMonth() + 1).padStart(2, "0")}.${String(t.getDate()).padStart(2, "0")}.` : "";
};

/**
 * Időkülönbség a táv mentén: a mostani edzés minden ~200 m-es pontjához a másik edzés
 * legközelebbi pontja (előre haladva keresve) → [{ d, delta }] (delta > 0: most lassabb).
 */
export function gapCurve(cur, other) {
  const cd = trackDists(cur), od = trackDists(other);
  const cc = movingCum(cur, cd), oc = movingCum(other, od);
  const lat0 = cur[0].lat, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const d2 = (a, b) => ((a.lng - b.lng) * kx) ** 2 + ((a.lat - b.lat) * ky) ** 2;
  const out = [];
  let j = 0, next = 0;
  for (let i = 0; i < cur.length; i++) {
    if (cd[i] < next) continue;
    next = cd[i] + STEP_M;
    // keresés a másik edzésben: az előző találattól előre, kb. 2 km-es ablakban
    let best = -1, bd = Infinity;
    for (let k = j; k < other.length && od[k] - od[j] < 2000; k++) {
      const v = d2(cur[i], other[k]);
      if (v < bd) { bd = v; best = k; }
    }
    if (best < 0 || bd > 150 * 150) continue;        // itt eltér a két nyomvonal
    j = best;
    out.push({ d: cd[i], delta: cc[i] - oc[best], lat: cur[i].lat, lng: cur[i].lng });
  }
  return out;
}

// ── Állapot ──────────────────────────────────────────────────────────────────
let _deps = null, _geomRef = null, _items = [], _curTime = null, _sel = null, _curve = null, _busy = false, _seq = 0;

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

const CW = 260, CH = 110, CP = { l: 34, r: 6, t: 8, b: 16 };

function curveSvg(curve) {
  if (!curve || curve.length < 3) return `<div class="cmp-note">A két nyomvonal túl sok helyen eltér – nincs összevethető rész.</div>`;
  const maxD = curve[curve.length - 1].d || 1;
  const vals = curve.map((p) => p.delta);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  if (hi - lo < 60) { const m = (hi + lo) / 2; lo = m - 30; hi = m + 30; }
  const X = (d) => CP.l + d / maxD * (CW - CP.l - CP.r);
  const Y = (v) => CP.t + (hi - v) / (hi - lo) * (CH - CP.t - CP.b);
  const line = curve.map((p, i) => `${i ? "L" : "M"}${X(p.d).toFixed(1)},${Y(p.delta).toFixed(1)}`).join("");
  const y0 = Y(0);
  const area = `${line}L${X(maxD).toFixed(1)},${y0}L${X(0).toFixed(1)},${y0}Z`;
  const ystep = [30, 60, 120, 300, 600, 900, 1800].find((s) => (hi - lo) / s <= 4) || 3600;
  let grid = "";
  for (let v = Math.ceil(lo / ystep) * ystep; v <= hi; v += ystep) {
    grid += `<line x1="${CP.l}" x2="${CW - CP.r}" y1="${Y(v)}" y2="${Y(v)}" class="${v === 0 ? "cmp-zero" : "pc-grid"}"/>`
      + `<text x="${CP.l - 4}" y="${Y(v) + 3}" class="pc-yl">${v === 0 ? "0" : fmtDelta(v)}</text>`;
  }
  const kmStep = [1, 2, 5, 10, 20, 25, 50].find((s) => maxD / 1000 / s <= 5) || 100;
  for (let k = kmStep; k * 1000 < maxD; k += kmStep) grid += `<text x="${X(k * 1000)}" y="${CH - 3}" class="pc-xl">${k} km</text>`;
  return `<div class="pc-wrap">
    <svg class="pc-svg cmp-svg" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Időkülönbség a táv mentén">
      <defs><clipPath id="cmpUp"><rect x="0" y="0" width="${CW}" height="${y0}"/></clipPath>
            <clipPath id="cmpDn"><rect x="0" y="${y0}" width="${CW}" height="${CH - y0}"/></clipPath></defs>
      ${grid}
      <path d="${area}" class="cmp-area-slow" clip-path="url(#cmpUp)"/>
      <path d="${area}" class="cmp-area-fast" clip-path="url(#cmpDn)"/>
      <path d="${line}" class="cmp-line"/>
      <line class="pc-cur" x1="0" x2="0" y1="${CP.t}" y2="${CH - CP.b}" visibility="hidden"/>
      <circle class="pc-dot cmp-dot" r="3" visibility="hidden"/>
    </svg><div class="pc-tip" hidden></div></div>`;
}

function render() {
  const box = document.getElementById("fFileCompare");
  if (!box) return;
  if (!_items.length) { box.hidden = true; box.innerHTML = ""; return; }
  const rows = _items.map((r, i) => {
    const t = r.duration ? r.duration * 60 : null;
    const diff = t && _curTime ? _curTime - t : null;
    const spd = t && r.distance ? `${num(r.distance / (t / 3600), 1)} km/h` : "";
    return `<button type="button" class="cmp-row${_sel === i ? " is-active" : ""}" data-i="${i}">
      <span class="cmp-main"><b>${esc(fmtDate(r))}</b><span>${esc(r.name)}</span></span>
      <span class="cmp-num"><b>${t ? clock(t) : "—"}</b><span>${spd}</span></span>
      ${diff != null ? `<span class="cmp-diff ${diff <= 0 ? "is-fast" : "is-slow"}" title="${diff <= 0 ? "Most ennyivel gyorsabb voltál" : "Most ennyivel lassabb voltál"} (mozgásidő)">${fmtDelta(diff)}</span>` : ""}
    </button>`;
  }).join("");
  let detail = "";
  if (_sel != null) {
    const r = _items[_sel];
    const last = _curve?.[_curve.length - 1];
    detail = `<div class="cmp-detail">
      <div class="cmp-detail-h">Időkülönbség a táv mentén <small>vs. ${esc(fmtDate(r))}</small></div>
      ${_busy ? `<div class="cmp-note">Betöltés…</div>` : curveSvg(_curve)}
      ${!_busy && last ? `<div class="cmp-note">Különbség a végén: <b class="${last.delta <= 0 ? "is-fast" : "is-slow"}">${fmtDelta(last.delta)}</b> (${last.delta <= 0 ? "most gyorsabb" : "most lassabb"}, mozgásidő). A vonal lent: előnyben vagy, fent: lemaradásban.</div>` : ""}
    </div>`;
  }
  box.innerHTML = `<div class="be-head"><span>Ugyanezen az útvonalon</span><em class="clb-n">${_items.length}</em>
      <span class="clb-hint" title="A korábbi edzéseid ugyanazon a nyomvonalon, ugyanabba az irányba (táv ±12%, a vonal ≥ 85%-ban fedi). A különbség a mozgásidőből (megállások nélkül). Kattints egyre: km szerint látod, hol nyertél vagy vesztettél időt.">?</span></div>
    <div class="cmp-list">${rows}</div>${detail}`;
  box.hidden = false;
  box.querySelectorAll(".cmp-row").forEach((b) => b.addEventListener("click", () => pick(+b.dataset.i)));
  bindCurve(box);
}

function bindCurve(box) {
  const svg = box.querySelector(".cmp-svg");
  if (!svg || !_curve?.length) return;
  const tip = box.querySelector(".pc-tip"), cur = svg.querySelector(".pc-cur"), dot = svg.querySelector(".pc-dot");
  const maxD = _curve[_curve.length - 1].d || 1;
  const vals = _curve.map((p) => p.delta);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  if (hi - lo < 60) { const m = (hi + lo) / 2; lo = m - 30; hi = m + 30; }
  const X = (d) => CP.l + d / maxD * (CW - CP.l - CP.r);
  const Y = (v) => CP.t + (hi - v) / (hi - lo) * (CH - CP.t - CP.b);
  const show = (clientX) => {
    const r = svg.getBoundingClientRect();
    const x = (clientX - r.left) / r.width * CW;
    let p = _curve[0];
    for (const q of _curve) if (Math.abs(X(q.d) - x) < Math.abs(X(p.d) - x)) p = q;
    cur.setAttribute("x1", X(p.d)); cur.setAttribute("x2", X(p.d)); cur.setAttribute("visibility", "visible");
    dot.setAttribute("cx", X(p.d)); dot.setAttribute("cy", Y(p.delta)); dot.setAttribute("visibility", "visible");
    tip.innerHTML = `<b>${num(p.d / 1000, 1)} km</b><span>${Math.abs(p.delta) < 1 ? "fej-fej mellett" : p.delta < 0 ? `előny: ${clock(-p.delta)}` : `lemaradás: ${clock(p.delta)}`}</span>`;
    tip.hidden = false;
    tip.style.left = `${Math.max(0, Math.min(r.width - tip.offsetWidth, X(p.d) / CW * r.width - tip.offsetWidth / 2))}px`;
    _deps.onHoverPoint?.(p);
  };
  svg.addEventListener("pointermove", (e) => show(e.clientX));
  svg.addEventListener("pointerdown", (e) => show(e.clientX));
  svg.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    tip.hidden = true; cur.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden");
    _deps.onHoverPoint?.(null);
  });
}

async function pick(i) {
  if (_sel === i) { _sel = null; _curve = null; render(); return; }
  _sel = i; _curve = null; _busy = true; render();
  const mySeq = ++_seq, g = _geomRef;
  try {
    const gpx = await _deps.api.loadRoute(_items[i].id);
    const parsed = await _deps.importGpx(new Blob([gpx], { type: "application/gpx+xml" }), { sampleWaypoints: false });
    const other = parsed.geometry.full || parsed.geometry;
    if (mySeq !== _seq || g !== _geomRef) return;
    _curve = gapCurve(g.full || g, other);
  } catch (err) {
    console.warn("Összevetés betöltése:", err);
    _curve = null;
  }
  if (mySeq !== _seq) return;
  _busy = false;
  render();
}

async function refresh() {
  const g = _deps.getGeometry();
  if (g === _geomRef) return;
  _geomRef = g; _items = []; _sel = null; _curve = null; _seq++;
  render();
  if (!g || g.length < 20 || g[0]?.indoor || !g.some((p) => p.time != null)) return;   // beltérinek nincs útvonala
  const full = g.full || g;
  const d = trackDists(full);
  const totalKm = d[d.length - 1] / 1000;
  if (totalKm < 2) return;
  const cum = movingCum(full, d);
  _curTime = cum[cum.length - 1] || null;
  const id = _deps.getRouteId?.();
  const lib = _deps.getLibraryData?.() || {};
  const entry = id ? [...(lib.workouts || []), ...(lib.routes || [])].find((r) => r.id === id) : null;
  // a tárolt mozgásidő (a forrás szerint) – a listában ugyanígy számolt értékekkel vetjük össze
  if (entry?.duration) _curTime = entry.duration * 60;
  const step = Math.max(1, Math.floor(g.length / 300));
  const points = g.filter((_, i) => i % step === 0).map((p) => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5]);
  const mySeq = _seq;
  try {
    const res = await _deps.api.similarRoutes({ points, distance_km: totalKm, exclude_id: id || "", sport: entry?.sport_type || "cycling" });
    if (mySeq !== _seq) return;
    // ugyanaz az edzés más forrásból (indulás ±15 percen belül) nem összevetés
    const t0 = full.find((p) => p.time != null)?.time;
    _items = (res.items || []).filter((r) => {
      const t = Date.parse(r.start_time || "");
      return !(Number.isFinite(t) && t0 && Math.abs(t - t0) < 15 * 60 * 1000);
    });
  } catch (err) {
    console.warn("Hasonló edzések:", err);
    _items = [];
  }
  render();
}

export function initCompare(deps) {
  _deps = deps;
  // a betöltött edzés azonosítója a geometria után áll be – egy pillanattal később nézzük
  document.addEventListener("bringaterv:geometry", () => { setTimeout(refresh, 0); });
  refresh();
}
