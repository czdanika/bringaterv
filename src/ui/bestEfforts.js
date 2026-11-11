/**
 * „Csúcsértékek” kártya az Elemzésben: az edzés leggyorsabb ideje szabványos távokra
 * (5, 10, 20 … km) és a csúcsteljesítmény 5 mp – 60 perc között – érmekkel, ha a korábbi
 * edzéseid között (ugyanabban a sportban) a legjobb 3 közé kerül. A legmagasabb átlagpulzus
 * érem nélkül (a magasabb pulzus nem „jobb”), csak a viszonyítás: eddigi legmagasabb.
 *
 * A számítás itt, a böngészőben megy (nem mentett fájlnál is), ugyanazzal a módszerrel,
 * mint a szerveren a Rekordok (routes-api/records.py); a többi edzés értékei a
 * /api/records-ból jönnek. Egy értékre kattintva a szakasz kijelölődik a grafikonon.
 *
 *   initBestEfforts({ api, getGeometry, getRouteId, getLibraryData, onPick })
 */
import { num, int } from "../format.js";
import { trackDists, clock } from "./rangeStats.js";

const SPORTS = {
  cycling: { distances: [5000, 10000, 20000, 30000, 40000, 50000, 80000, 100000, 150000, 200000], pace: false },
  run:     { distances: [400, 1000, 5000, 10000, 21097, 42195], pace: true },
  foot:    { distances: [1000, 5000, 10000, 20000, 21097, 30000, 42195], pace: true },
};
const WINDOWS = [5, 30, 60, 300, 1200, 3600];                     // a csempéken
// a teljesítmény-görbe pontjai (a szerver records.py PEAK_WINDOWS_S-ével egyezően)
const CURVE_WINDOWS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 300, 600, 1200, 1800, 3600, 5400, 7200];
const WIN_LABEL = { 5: "5 mp", 30: "30 mp", 60: "1 perc", 300: "5 perc", 1200: "20 perc", 3600: "60 perc" };
const DIST_LABEL = { 21097: "Félmaraton", 42195: "Maraton" };
const MAX_GAP_S = 10;
const MEDALS = ["gold", "silver", "bronze"];

function sportOf(r) {
  const t = (r?.sport_type || "").toLowerCase();
  if (t.includes("run")) return "run";
  if (t.includes("walk") || t.includes("hik")) return "foot";
  if (!t || t.includes("cycl") || t.includes("ride") || t.includes("bike") || ["gravel", "mtb", "asphalt"].includes(t)) return "cycling";
  return "other";
}
const fmtDist = (m) => DIST_LABEL[m] || (m < 1000 ? `${m} m` : `${num(m / 1000, m % 1000 ? 1 : 0)} km`);
function fmtRate(distM, sec, pace) {
  if (pace) {
    const p = sec / (distM / 1000);
    return `${Math.floor(p / 60)}:${String(Math.round(p % 60)).padStart(2, "0")} /km`;
  }
  return `${num(distM / 1000 / (sec / 3600), 1)} km/h`;
}

/** Leggyorsabb idő távokra (csúszóablak a kumulált távon) + hol volt: { [dist]: { sec, i0, i1 } } (pontindex) */
export function bestEfforts(geometry, dists, distances) {
  const idx = [];
  for (let i = 0; i < geometry.length; i++) if (geometry[i].time != null) idx.push(i);
  if (idx.length < 2) return {};
  const T = (k) => geometry[idx[k]].time / 1000, D = (k) => dists[idx[k]];
  const total = D(idx.length - 1) - D(0);
  const out = {};
  for (const dist of distances) {
    if (total < dist) break;
    let best = null, s = 0;
    for (let e = 0; e < idx.length; e++) {
      while (s < e && D(e) - D(s + 1) >= dist) s++;
      const covered = D(e) - D(s);
      if (covered >= dist) {
        const dt = T(e) - T(s);
        const t = covered > 0 ? dt * dist / covered : dt;
        if (t > 0 && (!best || t < best.sec)) best = { sec: t, i0: idx[s], i1: idx[e] };
      }
    }
    if (best) out[dist] = best;
  }
  return out;
}

/** Csúcsérték időablakokra (1 Hz, adatszünet nélkül) + hol volt: { [w]: { val, i0, i1 } } (pontindex) */
export function bestPeaks(geometry, key, windows = WINDOWS) {
  const samples = [];
  for (let i = 0; i < geometry.length; i++) {
    const p = geometry[i];
    if (p.time != null && p[key] != null) samples.push(i);
  }
  if (samples.length < 2) return {};
  const t0 = geometry[samples[0]].time / 1000;
  const len = Math.floor(geometry[samples[samples.length - 1]].time / 1000 - t0) + 1;
  if (len > 24 * 3600 || len < 2) return {};
  const arr = new Array(len).fill(null), src = new Array(len).fill(-1);
  for (let k = 0; k < samples.length - 1; k++) {
    const ia = samples[k], ib = samples[k + 1];
    const a = Math.floor(geometry[ia].time / 1000 - t0), b = Math.floor(geometry[ib].time / 1000 - t0);
    if (b - a > MAX_GAP_S) { arr[a] = geometry[ia][key]; src[a] = ia; continue; }
    for (let q = a; q < Math.max(a + 1, b); q++) { arr[q] = geometry[ia][key]; src[q] = ia; }
  }
  const last = samples[samples.length - 1];
  arr[len - 1] = geometry[last][key]; src[len - 1] = last;
  const pre = new Float64Array(len + 1), gaps = new Int32Array(len + 1);
  for (let i = 0; i < len; i++) { pre[i + 1] = pre[i] + (arr[i] || 0); gaps[i + 1] = gaps[i] + (arr[i] == null ? 1 : 0); }
  const out = {};
  for (const w of windows) {
    if (w > len) break;
    let best = null, at = -1;
    for (let i = 0; i + w <= len; i++) {
      if (gaps[i + w] - gaps[i]) continue;
      const avg = (pre[i + w] - pre[i]) / w;
      if (best == null || avg > best) { best = avg; at = i; }
    }
    if (best != null && best > 0) out[w] = { val: best, i0: src[at], i1: Math.min(geometry.length - 1, src[at + w - 1] + 1) };
  }
  return out;
}

// ── Állapot ──────────────────────────────────────────────────────────────────
let _deps = null, _geomRef = null, _calc = null;
let _records = null, _recordsAt = 0, _recordsReq = null;

async function loadRecords() {
  if (_records && Date.now() - _recordsAt < 60_000) return _records;
  if (_recordsReq) return _recordsReq;
  _recordsReq = (async () => {
    try {
      // a szerver részletekben számol (pending > 0) – addig kérjük, amíg kész nem lesz
      for (let round = 0; round < 30; round++) {
        const res = await _deps.api.getRecords();
        _records = new Map((res.items || []).map((x) => [x.id, x]));
        _recordsAt = Date.now();
        document.dispatchEvent(new CustomEvent("bringaterv:recordsLoaded"));
        if (!res.pending) break;
      }
    } catch (err) {
      console.warn("Rekordok betöltése (Csúcsértékek):", err);
      _records = _records || null;
    } finally { _recordsReq = null; }
    return _records;
  })();
  return _recordsReq;
}

/** A többi edzésed (ugyanaz a sport, statisztikába számít) értékei egy mutatóra. */
function othersFor(sport, valueOf) {
  if (!_records) return null;
  const lib = _deps.getLibraryData?.() || {};
  const cur = _deps.getRouteId?.();
  const out = [];
  for (const r of [...(lib.workouts || []), ...(lib.routes || [])]) {
    if (r.id === cur || r.type !== "workout" || r.include_in_stats === false || sportOf(r) !== sport) continue;
    const v = valueOf(_records.get(r.id));
    if (Number.isFinite(v) && v > 0) out.push({ v, r });
  }
  return out;
}

/** Helyezés (1 = egyéni csúcs) és az eddigi legjobb, ha ez nem az. */
function rankOf(value, others, lowerIsBetter) {
  if (!others) return null;
  const better = others.filter((o) => (lowerIsBetter ? o.v < value - 0.05 : o.v > value + 0.05));
  const best = others.reduce((b, o) => (!b || (lowerIsBetter ? o.v < b.v : o.v > b.v) ? o : b), null);
  return { rank: better.length + 1, best, n: others.length + 1 };
}

function medal(rk, fmtBest) {
  if (!rk || rk.n < 2 || rk.rank > 3) return { html: "", title: rk?.best ? `Eddigi legjobb: ${fmtBest(rk.best.v)}` : "" };
  const title = rk.rank === 1 ? "Egyéni csúcs!" : `${rk.rank}. legjobb eredményed` + (rk.best ? ` · csúcs: ${fmtBest(rk.best.v)}` : "");
  return { html: `<span class="be-medal be-medal--${MEDALS[rk.rank - 1]}" aria-label="${title}">${rk.rank}</span>`, title };
}

/** Pulzus: nincs érem, csak semleges viszonyítás (a magasabb pulzus nem eredmény). */
function hrNote(rk, fmtBest) {
  if (!rk || rk.n < 2) return { html: "", title: "" };
  const title = rk.rank === 1 ? `Eddigi legmagasabb (${rk.n} edzésből)` : rk.best ? `Eddigi legmagasabb: ${fmtBest(rk.best.v)}` : "";
  return { html: "", title };
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function render() {
  const box = document.getElementById("fFileBest");
  if (!box) return;
  const c = _calc;
  if (!c || (!Object.keys(c.efforts).length && !Object.keys(c.power).length && !Object.keys(c.hr).length)) {
    box.hidden = true; box.innerHTML = ""; return;
  }
  const cfg = SPORTS[c.sport] || SPORTS.cycling;
  const items = [];   // a kattintható értékek (index → tartomány)
  const chip = (label, val, sub, rk, fmtBest, range, noMedal = false) => {
    const m = noMedal ? hrNote(rk, fmtBest) : medal(rk, fmtBest);
    items.push(range);
    return `<button type="button" class="be-chip${m.html ? " has-medal" : ""}" data-i="${items.length - 1}"${m.title ? ` title="${esc(m.title)}"` : ""}>
      <span class="be-lbl">${label}${m.html}</span><b>${val}</b>${sub ? `<span class="be-sub">${sub}</span>` : ""}</button>`;
  };

  const effHtml = Object.entries(c.efforts).map(([d, e]) => {
    const dist = +d;
    const rk = rankOf(e.sec, othersFor(c.sport, (rec) => rec?.efforts?.[d]), true);
    return chip(fmtDist(dist), clock(e.sec), fmtRate(dist, e.sec, cfg.pace), rk, clock, e);
  }).join("");
  const peakHtml = (key, unit) => Object.entries(c[key]).map(([w, p]) => {
    const rk = rankOf(p.val, othersFor(c.sport, (rec) => rec?.peaks?.[key]?.[w]), false);
    return chip(WIN_LABEL[w], `${int(p.val)}<small>${unit}</small>`, key === "power" && c.kg ? `${num(p.val / c.kg, 2)} W/kg` : "", rk, (v) => `${int(v)} ${unit}`, p, key === "hr");
  }).join("");

  const sec = (title, html) => html ? `<div class="be-sec"><div class="be-sec-t">${title}</div><div class="be-grid">${html}</div></div>` : "";
  box.innerHTML = `<div class="be-head"><span>Csúcsértékek</span>
      ${_records || _deps.publicView ? "" : `<em class="be-loading">helyezések betöltése…</em>`}
      <span class="clb-hint" title="${_deps.publicView
        ? "Az edzés leggyorsabb ideje az egyes távokra (akkor is, ha egy hosszabb kör közepén volt), a legnagyobb átlagteljesítmény és a legmagasabb átlagpulzus, amit adott ideig tartott. Kattints egy értékre: a grafikonon és a térképen kijelölődik, hol volt."
        : "Az edzés leggyorsabb ideje az egyes távokra (akkor is, ha egy hosszabb kör közepén volt), a legnagyobb átlagteljesítmény és a legmagasabb átlagpulzus, amit adott ideig tartottál. Érem (időknél és wattnál): a korábbi (statisztikába számító, azonos sportú) edzéseid között a legjobb 3. A pulzus nem kap érmet – a magasabb pulzus nem eredmény –, fölé állva látod az eddigi legmagasabbat. Kattints egy értékre: a grafikonon és a térképen kijelölődik, hol volt."}">?</span></div>
    ${sec("Legjobb idők", effHtml)}${sec("Teljesítmény", peakHtml("power", "W"))}${curveHtml(c)}${sec("Legmagasabb átlagpulzus", peakHtml("hr", "bpm"))}`;
  box.hidden = false;
  bindCurve(box, c);
  box.querySelectorAll(".be-chip").forEach((b) => b.addEventListener("click", () => {
    const r = items[+b.dataset.i];
    box.querySelectorAll(".be-chip.is-active").forEach((x) => x.classList.remove("is-active"));
    b.classList.add("is-active");
    _deps.onPick?.({ d0: r.d0, d1: r.d1 });
  }));
}

// ── Teljesítmény-görbe: ez az edzés vs. az eddigi legjobb (log időtengely) ─────────
const CW = 260, CH = 120, CP = { l: 30, r: 6, t: 8, b: 18 };
const winLabel = (w) => w < 60 ? `${w} mp` : w < 3600 ? `${w / 60} perc` : `${num(w / 3600, w % 3600 ? 1 : 0)} óra`;

function curveBest(c) {
  // az eddigi legjobb ablakonként: a többi edzés és ez az edzés közül
  const map = {};
  for (const { w, val } of c.curve) {
    const others = othersFor(c.sport, (rec) => rec?.peaks?.power?.[String(w)]) || [];
    const top = others.reduce((b, o) => (!b || o.v > b.v ? o : b), null);
    map[w] = top && top.v > val ? { v: top.v, r: top.r } : { v: val, r: null };
  }
  return map;
}

function curveHtml(c) {
  if (!c.curve || c.curve.length < 4) return "";
  // nyilvános nézőoldalon nincs „eddigi legjobb” (nem látszik a néző többi edzése)
  const best = _records && !_deps.publicView ? curveBest(c) : null;
  c._best = best;
  const ws = c.curve.map((p) => p.w);
  const lx0 = Math.log(ws[0]), lx1 = Math.log(ws[ws.length - 1]);
  const vals = c.curve.map((p) => p.val).concat(best ? Object.values(best).map((b) => b.v) : []);
  const vmax = Math.max(...vals) * 1.05, vmin = 0;
  const X = (w) => CP.l + (Math.log(w) - lx0) / (lx1 - lx0 || 1) * (CW - CP.l - CP.r);
  const Y = (v) => CP.t + (1 - (v - vmin) / (vmax - vmin || 1)) * (CH - CP.t - CP.b);
  c._X = X; c._Y = Y;
  const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.w).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  const mine = c.curve.map((p) => ({ w: p.w, v: p.val }));
  const area = path(mine) + `L${X(mine[mine.length - 1].w).toFixed(1)},${Y(0)}L${X(mine[0].w).toFixed(1)},${Y(0)}Z`;
  const bestPts = best ? ws.map((w) => ({ w, v: best[w].v })) : null;
  const step = vmax > 600 ? 200 : vmax > 300 ? 100 : 50;
  let grid = "";
  for (let v = step; v < vmax; v += step) grid += `<line x1="${CP.l}" x2="${CW - CP.r}" y1="${Y(v)}" y2="${Y(v)}" class="pc-grid"/><text x="${CP.l - 4}" y="${Y(v) + 3}" class="pc-yl">${v}</text>`;
  const ticks = [[5, "5 mp"], [60, "1 p"], [300, "5 p"], [1200, "20 p"], [3600, "1 ó"]].filter(([w]) => w >= ws[0] && w <= ws[ws.length - 1])
    .map(([w, l]) => `<line x1="${X(w)}" x2="${X(w)}" y1="${CP.t}" y2="${CH - CP.b}" class="pc-grid"/><text x="${X(w)}" y="${CH - 5}" class="pc-xl">${l}</text>`).join("");
  return `<div class="be-sec be-curve"><div class="be-sec-t">Teljesítmény-görbe
      <span class="pc-leg"><i class="pc-k-me"></i>ez az edzés${best ? `<i class="pc-k-best"></i>eddigi legjobb` : ""}</span></div>
    <div class="pc-wrap">
      <svg class="pc-svg" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Teljesítmény-görbe">
        ${grid}${ticks}
        <path d="${area}" class="pc-area"/>
        ${bestPts ? `<path d="${path(bestPts)}" class="pc-best"/>` : ""}
        <path d="${path(mine)}" class="pc-me"/>
        <line class="pc-cur" x1="0" x2="0" y1="${CP.t}" y2="${CH - CP.b}" visibility="hidden"/>
        <circle class="pc-dot" r="3" visibility="hidden"/>
      </svg>
      <div class="pc-tip" hidden></div>
    </div></div>`;
}

function bindCurve(box, c) {
  const svg = box.querySelector(".pc-svg");
  if (!svg) return;
  const tip = box.querySelector(".pc-tip"), cur = svg.querySelector(".pc-cur"), dot = svg.querySelector(".pc-dot");
  const hide = () => { tip.hidden = true; cur.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
  const show = (clientX) => {
    const r = svg.getBoundingClientRect();
    const x = (clientX - r.left) / r.width * CW;
    let p = c.curve[0];
    for (const q of c.curve) if (Math.abs(c._X(q.w) - x) < Math.abs(c._X(p.w) - x)) p = q;
    const px = c._X(p.w), py = c._Y(p.val);
    cur.setAttribute("x1", px); cur.setAttribute("x2", px); cur.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.setAttribute("visibility", "visible");
    const b = c._best?.[p.w];
    const wkg = c.kg ? ` · ${num(p.val / c.kg, 2)} W/kg` : "";
    const bestTxt = b && b.r ? `<span>Eddigi legjobb: ${int(b.v)} W (${int(p.val / b.v * 100)}%)</span>` : b ? `<span>Egyéni csúcs!</span>` : "";
    tip.innerHTML = `<b>${winLabel(p.w)}: ${int(p.val)} W</b>${wkg}${bestTxt}`;
    tip.hidden = false;
    const left = Math.max(0, Math.min(r.width - tip.offsetWidth, px / CW * r.width - tip.offsetWidth / 2));
    tip.style.left = `${left}px`;
  };
  svg.addEventListener("pointermove", (e) => show(e.clientX));
  svg.addEventListener("pointerdown", (e) => show(e.clientX));
  svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
}

function refresh() {
  const g = _deps.getGeometry();
  if (g === _geomRef) return;
  _geomRef = g;
  if (!g || g.length < 10 || !g.some((p) => p.time != null)) { _calc = null; render(); return; }
  const lib = _deps.getLibraryData?.() || {};
  const id = _deps.getRouteId?.();
  const entry = id ? [...(lib.workouts || []), ...(lib.routes || [])].find((r) => r.id === id) : null;
  const sport = sportOf(entry);
  if (sport === "other") { _calc = null; render(); return; }
  // a számítás a teljes (ritkítás előtti) pontsoron; a hely a grafikon (ritkított) távjára időpont szerint
  const full = Array.isArray(g.full) && g.full.length > g.length ? g.full : g;
  const kg = Number(_deps.getRiderKg?.());
  const raw = {
    efforts: bestEfforts(full, trackDists(full), (SPORTS[sport] || SPORTS.cycling).distances),
    power: sport === "cycling" ? bestPeaks(full, "power", CURVE_WINDOWS) : {},
    hr: bestPeaks(full, "hr"),
  };
  const gd = trackDists(g);
  const distAtTime = (t) => {
    let lo = 0, hi = g.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if ((g[m].time ?? -Infinity) < t) lo = m + 1; else hi = m; }
    return gd[lo];
  };
  const place = (o) => {
    for (const v of Object.values(o)) {
      let d0 = distAtTime(full[v.i0].time), d1 = distAtTime(full[v.i1].time);
      // nagyon rövid szakasz (5 mp) is látsszon a grafikonon: legalább ~40 m
      if (d1 - d0 < 40) { const mid = (d0 + d1) / 2; d0 = Math.max(0, mid - 20); d1 = mid + 20; }
      v.d0 = d0; v.d1 = d1;
    }
    return o;
  };
  const curve = Object.entries(raw.power).map(([w, p]) => ({ w: +w, val: p.val }));
  const chipsOf = (o) => Object.fromEntries(Object.entries(o).filter(([w]) => WINDOWS.includes(+w)));
  _calc = { sport, kg: kg > 20 ? kg : null, efforts: place(raw.efforts), power: place(chipsOf(raw.power)), hr: place(raw.hr), curve };
  render();
  loadRecords();
}

/**
 * Az eddigi legnagyobb átlagteljesítmény egy időablakra (W) az összes statisztikába számító
 * kerékpáros edzésből – az FTP-becsléshez (20 perc × 0,95). Ha a rekordok még nincsenek
 * betöltve, elindítja a betöltést és null-t ad (utána „bringaterv:recordsLoaded” esemény jön).
 */
export function bestPowerEver(windowS = 1200) {
  if (!_records) { if (_deps?.api) loadRecords(); return null; }
  const lib = _deps.getLibraryData?.() || {};
  let best = null;
  for (const r of [...(lib.workouts || []), ...(lib.routes || [])]) {
    if (r.type !== "workout" || r.include_in_stats === false || sportOf(r) !== "cycling") continue;
    const v = _records.get(r.id)?.peaks?.power?.[String(windowS)];
    if (Number.isFinite(v) && (best == null || v > best)) best = v;
  }
  return best;
}

/** A kijelölés törlésekor az aktív érték jelölése is törlődik. */
export function clearBestHighlight() {
  document.querySelectorAll("#fFileBest .be-chip.is-active").forEach((x) => x.classList.remove("is-active"));
}

export function initBestEfforts(deps) {
  _deps = deps;
  document.addEventListener("bringaterv:geometry", () => setTimeout(refresh, 0));
  document.addEventListener("bringaterv:recordsLoaded", () => { if (_calc) render(); });
  refresh();
}
