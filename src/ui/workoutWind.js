/**
 * „Szél az edzés alatt” kártya az Elemzésben: a rögzítés idejére és helyére az Open-Meteo
 * óránkénti szele (modelladat, nem mérés) – mennyi volt hát- / oldal- / szembeszél, és
 * átlagosan mennyit segített vagy fékezett. A sávra kattintva a szakasz kijelölődik.
 *
 *   initWorkoutWind({ getGeometry, onPickTimes })
 */
import { num, int } from "../format.js";
import { analyzeWorkoutWind, WIND_COLORS, WIND_LABELS } from "../wind/windService.js";

const COMPASS = ["É", "ÉÉK", "ÉK", "KÉK", "K", "KDK", "DK", "DDK", "D", "DDNy", "DNy", "NyDNy", "Ny", "NyÉNy", "ÉNy", "ÉÉNy"];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

let _deps = null, _geomRef = null, _res = null, _state = "idle", _seq = 0;   // _res: { stats, runs }

/** Az egymás utáni azonos típusú részek összevonása (a sávhoz). */
function runs(parts) {
  const out = [];
  const minRun = Math.min(1500, ((parts[parts.length - 1]?.d1 || 0) - (parts[0]?.d0 || 0)) * 0.03);
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.mode === p.mode) { last.d1 = p.d1; last.t1 = p.t1; last.along += p.along * (p.d1 - p.d0); }
    else out.push({ mode: p.mode, d0: p.d0, d1: p.d1, t0: p.t0, t1: p.t1, along: p.along * (p.d1 - p.d0) });
  }
  // a rövid (a táv 3%-ánál, legfeljebb 1,5 km-nél rövidebb) darabok a hosszabb szomszédba olvadnak (a sáv így áttekinthető)
  for (let changed = true; changed && out.length > 1;) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const r = out[i];
      if (r.d1 - r.d0 >= minRun) continue;
      const prev = out[i - 1], next = out[i + 1];
      const into = !prev ? next : !next ? prev : (prev.d1 - prev.d0 >= next.d1 - next.d0 ? prev : next);
      into.along += r.along;
      into.d0 = Math.min(into.d0, r.d0); into.d1 = Math.max(into.d1, r.d1);
      into.t0 = Math.min(into.t0, r.t0); into.t1 = Math.max(into.t1, r.t1);
      out.splice(i, 1);
      // az egybeolvadt azonos típusú szomszédok összevonása
      for (let k = out.length - 1; k > 0; k--) if (out[k].mode === out[k - 1].mode) {
        out[k - 1].along += out[k].along; out[k - 1].d1 = out[k].d1; out[k - 1].t1 = out[k].t1; out.splice(k, 1);
      }
      changed = true;
      break;
    }
  }
  out.forEach((r) => { r.along /= Math.max(1, r.d1 - r.d0); });
  return out;
}

/** Az aktuális edzés szele (az Elemzés Szél paneljéhez, térképszínezéshez, grafikonhoz). */
export function getWorkoutWind() { return _state === "ok" ? _res : null; }

function render() {
  document.dispatchEvent(new CustomEvent("bringaterv:workoutWind"));
  const box = document.getElementById("fFileWind");
  if (!box) return;
  if (_state === "idle" || _state === "none") { box.hidden = true; box.innerHTML = ""; return; }
  const head = `<div class="be-head"><span>Szél az edzés alatt</span>
    <span class="clb-hint" title="Az edzés idejére és helyére az Open-Meteo óránkénti szele (időjárási modell, ~10 km-es rácson – nem a te mérésed). Minden ~500 m-es részre a haladási irányodhoz viszonyítva: hátszél (0–60°), oldalszél (60–120°), szembeszél (120–180°). Az átlagos hatás a haladás irányába eső összetevő az idő szerint súlyozva: + segített, − fékezett. Kattints a sávra: a szakasz kijelölődik.">?</span></div>`;
  if (_state === "loading") { box.innerHTML = head + `<div class="cmp-note">Időjárás betöltése…</div>`; box.hidden = false; return; }
  if (_state === "error") { box.innerHTML = head + `<div class="cmp-note">Az időjárás-archívum most nem érhető el.</div>`; box.hidden = false; return; }
  const st = _res.stats, rr = _res.runs;
  const total = rr[rr.length - 1].d1 - rr[0].d0 || 1, base = rr[0].d0;
  const eff = st.alongAvg;
  const effTxt = Math.abs(eff) < 1 ? "nagyjából semleges" : eff > 0 ? "inkább segített (hátszél)" : "inkább fékezett (szembeszél)";
  const bar = ["tail", "cross", "head"].map((m) => {
    const pct = st[m + "Pct"];
    return pct >= 0.5 ? `<span style="flex:${pct};background:${WIND_COLORS[m]}" title="${WIND_LABELS[m]}: ${int(pct)}% (táv)"></span>` : "";
  }).join("");
  const strip = rr.map((r, i) => `<button type="button" class="ww-run" data-i="${i}" style="flex:${(r.d1 - r.d0) / total};background:${WIND_COLORS[r.mode]}"
      title="${num((r.d0 - base) / 1000, 1)}–${num((r.d1 - base) / 1000, 1)} km · ${WIND_LABELS[r.mode]} (${r.along >= 0 ? "+" : "−"}${num(Math.abs(r.along), 0)} km/h)"></button>`).join("");
  box.innerHTML = head + `
    <div class="ww-top">
      <div class="ww-main"><b>${num(st.speedAvg, 0)}<small>km/h</small></b><span>${compass(st.dirAvg)} felől${st.tempAvg != null ? ` · ${num(st.tempAvg, 0)} °C` : ""}</span></div>
      <div class="ww-main ww-eff ${eff >= 1 ? "is-fast" : eff <= -1 ? "is-slow" : ""}"><b>${eff >= 0 ? "+" : "−"}${num(Math.abs(eff), 1)}<small>km/h</small></b><span>${effTxt}</span></div>
    </div>
    <div class="ww-bar">${bar}</div>
    <div class="ww-legend">${["tail", "cross", "head"].map((m) => `<span><i style="background:${WIND_COLORS[m]}"></i>${WIND_LABELS[m]} ${int(st[m + "Pct"])}%</span>`).join("")}</div>
    <div class="ww-strip-t">A táv mentén</div>
    <div class="ww-strip">${strip}</div>`;
  box.hidden = false;
  box.querySelectorAll(".ww-run").forEach((b) => b.addEventListener("click", () => {
    const r = rr[+b.dataset.i];
    box.querySelectorAll(".ww-run.is-active").forEach((x) => x.classList.remove("is-active"));
    b.classList.add("is-active");
    _deps.onPickTimes?.(r.t0, r.t1);
  }));
}

// ── Tárolás az edzés mellett ────────────────────────────────────────────────
// A múltbeli szél nem változik: mentett edzésnél az első számítás az index-bejegyzésbe
// kerül (PATCH wind), utána onnan jön – nincs újabb Open-Meteo-kérés.
// Tömör formátum: { v, at, stats, runs: [[d0, d1, t0, t1, "t"|"c"|"h", along], …] }
const WIND_V = 1;
const MODE_CH = { tail: "t", cross: "c", head: "h" }, CH_MODE = { t: "tail", c: "cross", h: "head" };
const r1 = (x) => Math.round(x * 10) / 10;

function pack(res) {
  const st = res.stats;
  return {
    v: WIND_V, at: new Date().toISOString(),
    stats: { tailPct: r1(st.tailPct), crossPct: r1(st.crossPct), headPct: r1(st.headPct), alongAvg: r1(st.alongAvg),
             speedAvg: r1(st.speedAvg), dirAvg: Math.round(st.dirAvg), tempAvg: st.tempAvg == null ? null : r1(st.tempAvg), source: st.source },
    runs: res.runs.map((r) => [Math.round(r.d0), Math.round(r.d1), r.t0, r.t1, MODE_CH[r.mode], r1(r.along)]),
  };
}
function unpack(w) {
  if (!w || w.v !== WIND_V || !Array.isArray(w.runs) || !w.runs.length || !w.stats) return null;
  return { stats: w.stats, runs: w.runs.map(([d0, d1, t0, t1, m, along]) => ({ d0, d1, t0, t1, mode: CH_MODE[m] || "cross", along })) };
}
function savedEntry() {
  const id = _deps.getRouteId?.();
  const lib = _deps.getLibraryData?.() || {};
  return id ? [...(lib.workouts || []), ...(lib.routes || [])].find((r) => r.id === id) || null : null;
}

async function refresh() {
  const g = _deps.getGeometry();
  if (g === _geomRef) return;
  _geomRef = g; _res = null;
  const mySeq = ++_seq;
  if (!g || g.length < 20 || !g.some((p) => p.time != null)) { _state = "none"; render(); return; }
  const entry = savedEntry();
  const stored = unpack(entry?.wind);
  if (stored) { _res = stored; _state = "ok"; render(); return; }
  _state = "loading"; render();
  try {
    const res = await analyzeWorkoutWind(g.full || g);
    if (mySeq !== _seq) return;
    _res = res ? { stats: res.stats, runs: runs(res.parts) } : null;
    _state = _res ? "ok" : "none";
    // mentett edzésnél eltároljuk (csak ha teljes az eredmény)
    if (_res && entry?.id && entry.type === "workout") {
      const packed = pack(_res);
      _deps.api.updateRoute(entry.id, { wind: packed })
        .then(() => { entry.wind = packed; })
        .catch((err) => console.warn("Szél mentése:", err));
    }
  } catch (err) {
    if (mySeq !== _seq) return;
    console.warn("Szél az edzés alatt:", err);
    _state = "error";
  }
  render();
}

export function clearWindHighlight() {
  document.querySelectorAll("#fFileWind .ww-run.is-active").forEach((x) => x.classList.remove("is-active"));
}

export function initWorkoutWind(deps) {
  _deps = deps;
  document.addEventListener("bringaterv:geometry", () => setTimeout(refresh, 0));
  refresh();
}
