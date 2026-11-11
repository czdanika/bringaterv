/**
 * Emelkedők az Elemzésben: a nyomvonalból magától megkeresi a mászásokat, és kártyán
 * listázza őket (hossz, átlagos / legnagyobb meredekség, szint, idő, VAM, pulzus, watt,
 * kategória). Egy sorra kattintva a szakasz kijelölődik a grafikonon és a térképen.
 *
 *   detectClimbs(geometry, dists) → [{ d0, d1 }]   (méter, a rajttól)
 *   initClimbs({ getGeometry, getRiderKg, onPick }) – a „bringaterv:geometry” eseményre frissít
 */
import { num, int } from "../format.js";
import { computeRangeStats, trackDists, clock } from "./rangeStats.js";

const STEP_M = 25;           // újramintavétel
const SMOOTH_N = 3;          // ±3 minta (≈ ±75 m) mozgóátlag
const MIN_GAIN = 25;         // m
const MIN_LEN = 250;         // m
const MIN_GRADE = 2.5;       // %

/** Egyenletes (STEP_M) távolságonként a magasság, simítva → { d: [], e: [] } */
function resample(geometry, dists) {
  const total = dists[dists.length - 1];
  const d = [], e = [];
  let j = 0;
  for (let x = 0; x <= total; x += STEP_M) {
    while (j < dists.length - 2 && dists[j + 1] < x) j++;
    let a = j, b = j + 1;
    // érték nélküli pontok átugrása
    while (a > 0 && geometry[a].ele == null) a--;
    while (b < geometry.length - 1 && geometry[b].ele == null) b++;
    const ea = geometry[a].ele, eb = geometry[b].ele;
    if (ea == null && eb == null) { d.push(x); e.push(null); continue; }
    if (ea == null || eb == null || dists[b] === dists[a]) { d.push(x); e.push(ea ?? eb); continue; }
    const t = Math.max(0, Math.min(1, (x - dists[a]) / (dists[b] - dists[a])));
    d.push(x); e.push(ea + (eb - ea) * t);
  }
  // hézagok kitöltése az előző értékkel
  let last = e.find((v) => v != null) ?? null;
  for (let i = 0; i < e.length; i++) { if (e[i] == null) e[i] = last; else last = e[i]; }
  const s = e.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - SMOOTH_N); k <= Math.min(e.length - 1, i + SMOOTH_N); k++) { if (e[k] != null) { sum += e[k]; n++; } }
    return n ? sum / n : null;
  });
  return { d, e: s };
}

/** A mászások helye: völgytől csúcsig, a kisebb visszaeséseket (≤ 25%, ≤ 15 m) átívelve. */
export function detectClimbs(geometry, dists) {
  if (!geometry || geometry.length < 10 || !geometry.some((p) => p.ele != null)) return [];
  dists = dists || trackDists(geometry);
  const { d, e } = resample(geometry, dists);
  if (d.length < 5 || e[0] == null) return [];
  const out = [];
  let start = 0, peak = -1;

  const finish = (s, p) => {
    // a lapos ráfutás és a lapos tető levágása (a völgytől / csúcstól 3 m-en belüli rész)
    let a = s, b = p;
    for (let k = s; k <= p; k++) if (e[k] - e[s] < 3) a = k;
    for (let k = p; k >= a; k--) if (e[p] - e[k] < 3) b = k;
    // ahol a következő ~200 m alig emelkedik (< 1,5 %), az még ráfutás / már lapos tető
    const W = Math.round(200 / STEP_M);
    while (b - a > W * 2 && (e[a + W] - e[a]) / (d[a + W] - d[a]) * 100 < 1.5) a++;
    while (b - a > W * 2 && (e[b] - e[b - W]) / (d[b] - d[b - W]) * 100 < 1.5) b--;
    const gain = e[b] - e[a], len = d[b] - d[a];
    if (gain >= MIN_GAIN && len >= MIN_LEN && gain / len * 100 >= MIN_GRADE) out.push({ d0: d[a], d1: d[b] });
  };

  for (let k = 1; k < d.length; k++) {
    if (peak < 0) {
      if (e[k] < e[start]) start = k;
      else if (e[k] - e[start] >= 10) peak = k;
    } else if (e[k] >= e[peak]) {
      peak = k;
    } else {
      const gained = e[peak] - e[start];
      const drop = e[peak] - e[k];
      const flatFor = d[k] - d[peak];
      if (drop > Math.max(15, gained * 0.25) || flatFor > Math.max(600, (d[peak] - d[start]) * 0.4)) {
        finish(start, peak);
        // a következő mászás a csúcs utáni legmélyebb ponttól indulhat
        start = k; peak = -1;
        for (let q = k; q > 0 && d[k] - d[q] < flatFor; q--) if (e[q] < e[start]) start = q;
      }
    }
  }
  if (peak >= 0) finish(start, peak);
  return out;
}

/** Strava-szerű kategória: hossz (m) × átlagos meredekség (%) */
export function category(distM, gradePct) {
  const sc = distM * gradePct;
  if (sc >= 80000) return { label: "HC", cls: "hc" };
  if (sc >= 64000) return { label: "1. kat.", cls: "c1" };
  if (sc >= 32000) return { label: "2. kat.", cls: "c2" };
  if (sc >= 16000) return { label: "3. kat.", cls: "c3" };
  if (sc >= 8000) return { label: "4. kat.", cls: "c4" };
  return null;
}

const SHOW = 4;
let _deps = null, _list = [], _expanded = false, _active = -1, _geomRef = null;

function render() {
  const box = document.getElementById("fFileClimbs");
  if (!box) return;
  if (!_list.length) { box.hidden = true; box.innerHTML = ""; return; }
  const rows = (_expanded ? _list : _list.slice(0, SHOW)).map((c, i) => {
    const st = c.st;
    const cat = category(st.distM, st.gradePct);
    const meta = [
      `${num(st.d0 / 1000, 1)} km-nél`,
      st.hasTime ? clock(st.movingS) : null,
      st.vam != null ? `VAM ${int(st.vam)}` : null,
      st.hrAvg != null ? `${int(st.hrAvg)} bpm` : null,
      st.powerAvg != null ? `${int(st.powerAvg)} W` + (st.wkg != null ? ` · ${num(st.wkg, 1)} W/kg` : "") : null,
    ].filter(Boolean).join(" · ");
    return `<button type="button" class="clb-row${i === _active ? " is-active" : ""}" data-i="${i}">
      <span class="clb-no ${cat ? "clb-" + cat.cls : ""}" title="${cat ? "Kategória: hossz × meredekség (Strava-szerű)" : "Kategória alatti emelkedő"}">${cat ? cat.label : i + 1}</span>
      <span class="clb-main">
        <b>${num(st.distM / 1000, st.distM < 10000 ? 2 : 1)} km · ${num(st.gradePct, 1)} %<small> · +${int(st.ascM)} m</small></b>
        <span>${st.maxGradePct != null && st.maxGradePct > st.gradePct + 1 ? `max ${num(st.maxGradePct, 0)} % · ` : ""}${meta}</span>
      </span>
    </button>`;
  }).join("");
  const more = _list.length > SHOW
    ? `<button type="button" class="clb-more" data-more>${_expanded ? "Kevesebb" : `Mind a ${_list.length} emelkedő`}</button>` : "";
  box.innerHTML = `<div class="clb-head"><span>Emelkedők</span><em>${_list.length}</em>
      <span class="clb-hint" title="A nyomvonalból felismert mászások (legalább ${MIN_GAIN} m szint és ${MIN_GRADE} % átlag). Kattints egyre: a grafikonon és a térképen kijelölődik, fölötte a részletes számok.">?</span></div>
    <div class="clb-list">${rows}</div>${more}`;
  box.hidden = false;
  box.querySelectorAll(".clb-row").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.i;
    _active = i;
    render();
    _deps.onPick?.({ d0: _list[i].st.d0, d1: _list[i].st.d1 });
  }));
  box.querySelector("[data-more]")?.addEventListener("click", () => { _expanded = !_expanded; render(); });
}

function refresh() {
  const g = _deps.getGeometry();
  if (g === _geomRef) return;
  _geomRef = g;
  _expanded = false; _active = -1;
  if (!g || g.length < 10) { _list = []; render(); return; }
  const dists = trackDists(g);
  const kg = _deps.getRiderKg?.();
  _list = detectClimbs(g, dists)
    .map((r) => ({ st: computeRangeStats(g, r.d0, r.d1, { dists, riderKg: kg }) }))
    .filter((c) => c.st && c.st.ascM != null);
  render();
}

/** A kijelölés törlésekor az aktív sor jelölése is törlődik. */
export function clearClimbHighlight() {
  if (_active < 0) return;
  _active = -1;
  render();
}

export function initClimbs(deps) {
  _deps = deps;
  document.addEventListener("bringaterv:geometry", refresh);
  refresh();
}
