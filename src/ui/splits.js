/**
 * „Részidők” kártya az Elemzésben: a FIT-fájl körei (köregomb / automatikus kör), vagy
 * automatikus szakaszok (kerékpár 5 km, futás / gyalog 1 km) – táv, idő, sebesség / tempó,
 * pulzus, watt, emelkedés; a sebesség szerinti sáv mutatja a gyorsabb / lassabb részeket.
 * Egy sorra kattintva a szakasz kijelölődik a grafikonon és a térképen.
 *
 *   initSplits({ api, parseFit, getGeometry, getRouteId, getLibraryData, getRiderKg, onPick })
 */
import { num, int } from "../format.js";
import { computeRangeStats, trackDists, clock } from "./rangeStats.js";

let _deps = null, _geomRef = null, _laps = null, _mode = "auto", _rows = [], _seq = 0, _active = -1, _sport = "cycling";

function sportOf(r) {
  const t = (r?.sport_type || "").toLowerCase();
  if (t.includes("run")) return "run";
  if (t.includes("walk") || t.includes("hik")) return "foot";
  return "cycling";
}
const pace = (sec, m) => { const p = sec / (m / 1000); return `${Math.floor(p / 60)}:${String(Math.round(p % 60)).padStart(2, "0")}`; };

function build(g, dists) {
  const kg = _deps.getRiderKg?.();
  const total = dists[dists.length - 1];
  const ranges = [];
  if (_mode === "laps" && _laps?.length) {
    const at = (t) => {
      let lo = 0, hi = g.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if ((g[m].time ?? -Infinity) < t) lo = m + 1; else hi = m; }
      return dists[lo];
    };
    for (const l of _laps) { const d0 = at(l.start), d1 = at(l.end); if (d1 - d0 > 20) ranges.push({ d0, d1, lap: l }); }
  } else {
    const step = _sport === "cycling" ? (total > 120000 ? 10000 : 5000) : 1000;
    for (let d = 0; d < total - 50; d += step) ranges.push({ d0: d, d1: Math.min(total, d + step) });
  }
  return ranges.map((r) => ({ ...r, st: computeRangeStats(g, r.d0, r.d1, { dists, riderKg: kg }) })).filter((r) => r.st);
}

function render() {
  const box = document.getElementById("fFileSplits");
  if (!box) return;
  if (!_rows.length || _rows.length < 2) { box.hidden = true; box.innerHTML = ""; return; }
  const paceMode = _sport !== "cycling";
  const hasHr = _rows.some((r) => r.st.hrAvg != null), hasPw = _rows.some((r) => r.st.powerAvg != null);
  const speeds = _rows.map((r) => r.st.speedKmh || 0);
  const vmin = Math.min(...speeds), vmax = Math.max(...speeds);
  const fastest = speeds.indexOf(vmax);
  const head = `<div class="spl-row spl-h"><span>#</span><span>Táv</span><span>Idő</span><span>${paceMode ? "Tempó" : "Seb."}</span>${hasHr ? "<span>♥</span>" : ""}${hasPw ? "<span>W</span>" : ""}<span title="Emelkedés (m)">↑</span></div>`;
  const rows = _rows.map((r, i) => {
    const st = r.st;
    const w = vmax > vmin ? 25 + 75 * ((st.speedKmh || 0) - vmin) / (vmax - vmin) : 100;
    return `<button type="button" class="spl-row${i === _active ? " is-active" : ""}${i === fastest ? " is-best" : ""}" data-i="${i}"
        title="${num(st.d0 / 1000, 1)}–${num(st.d1 / 1000, 1)} km${st.hasTime && st.elapsedS - st.movingS > 30 ? ` · teljes idő ${clock(st.elapsedS)}` : ""}">
      <span>${i + 1}</span>
      <span>${num(st.distM / 1000, st.distM < 9950 ? 2 : 1)}</span>
      <span>${clock(st.movingS)}</span>
      <span class="spl-spd"><i style="width:${w.toFixed(0)}%"></i><b>${st.speedKmh == null ? "—" : paceMode ? pace(st.movingS, st.distM) : num(st.speedKmh, 1)}</b></span>
      ${hasHr ? `<span>${st.hrAvg != null ? int(st.hrAvg) : "—"}</span>` : ""}
      ${hasPw ? `<span>${st.powerAvg != null ? int(st.powerAvg) : "—"}</span>` : ""}
      <span>${st.ascM != null ? int(st.ascM) : "—"}</span>
    </button>`;
  }).join("");
  const autoLbl = _sport === "cycling" ? `${_rows.length && _mode === "auto" ? num((_rows[0].st.distM) / 1000, 0) : 5} km` : "1 km";
  const tabs = _laps?.length > 1
    ? `<span class="spl-tabs"><button type="button" data-mode="laps" class="${_mode === "laps" ? "is-on" : ""}">Körök (${_laps.length})</button><button type="button" data-mode="auto" class="${_mode === "auto" ? "is-on" : ""}">${autoLbl}</button></span>` : "";
  box.innerHTML = `<div class="be-head"><span>Részidők</span>${tabs}
      <span class="clb-hint" title="${_laps?.length > 1 ? "Körök: a komputer köregombjával vagy automatikus körökkel rögzített szakaszok (az eredeti FIT-fájlból). " : ""}Automatikus szakaszok: kerékpárnál 5 km (120 km fölött 10 km), futásnál és gyaloglásnál 1 km. Az idő mozgásidő (a megállások nélkül, a teljes idő a sor fölé állva). A sáv a sebességet mutatja, a leggyorsabb kiemelve. Kattints egy sorra: kijelölődik a grafikonon és a térképen.">?</span></div>
    <div class="spl-tbl${hasHr ? " has-hr" : ""}${hasPw ? " has-pw" : ""}">${head}${rows}</div>`;
  box.hidden = false;
  box.querySelectorAll(".spl-row[data-i]").forEach((b) => b.addEventListener("click", () => {
    _active = +b.dataset.i; render();
    const r = _rows[_active];
    _deps.onPick?.({ d0: r.st.d0, d1: r.st.d1 });
  }));
  box.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    if (_mode === b.dataset.mode) return;
    _mode = b.dataset.mode; _active = -1; recompute(); render();
  }));
}

function recompute() {
  const g = _geomRef;
  if (!g || g.length < 10 || !g.some((p) => p.time != null)) { _rows = []; return; }
  _rows = build(g, trackDists(g));
}

async function refresh() {
  const g = _deps.getGeometry();
  if (g === _geomRef) return;
  _geomRef = g; _laps = null; _mode = "auto"; _active = -1;
  const mySeq = ++_seq;
  const id = _deps.getRouteId?.();
  const lib = _deps.getLibraryData?.() || {};
  const entry = id ? [...(lib.workouts || []), ...(lib.routes || [])].find((r) => r.id === id) : null;
  _sport = sportOf(entry);
  recompute(); render();
  // a körök az eredeti FIT-ből (ha van)
  if (!entry?.has_fit || !g?.some?.((p) => p.time != null)) return;
  try {
    const blob = await _deps.api.loadRouteFit(id);
    const fit = _deps.parseFit(await blob.arrayBuffer());
    if (mySeq !== _seq) return;
    // csak ha valódi tagolás: legalább 2 kör, és nem egyetlen, az egészet lefedő kör
    const laps = (fit.laps || []).filter((l) => l.end - l.start >= 10_000);
    if (laps.length >= 2) { _laps = laps; _mode = "laps"; recompute(); render(); }
  } catch (err) {
    console.warn("FIT körök:", err);
  }
}

export function clearSplitsHighlight() {
  if (_active < 0) return;
  _active = -1; render();
}

export function initSplits(deps) {
  _deps = deps;
  document.addEventListener("bringaterv:geometry", () => setTimeout(refresh, 0));
  refresh();
}
