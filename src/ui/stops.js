/**
 * „Megállások” kártya az Elemzésben: hol és mennyi ideig álltál (legalább 1 perc –
 * piros lámpa, pihenő, defekt). A térképen kis jelölők a perccel; egy sorra kattintva
 * a térkép odaugrik.
 *
 *   initStops({ getGeometry, map: { setStopMarkers, focusStop } })
 */
import { num } from "../format.js";
import { trackDists, clock } from "./rangeStats.js";

const MIN_STOP_S = 60;       // ennél rövidebb állás nem számít
const MOVE_KMH = 2;
const SHOW = 4;
const LS_KEY = "bringaterv.showStops";

let _deps = null, _geomRef = null, _stops = [], _expanded = false, _active = -1;

const showOnMap = () => { try { return localStorage.getItem(LS_KEY) !== "0"; } catch { return true; } };

/** Állások: lassú (< 2 km/h) szakaszok és időhézagok (auto-pause), összevonva. */
export function detectStops(g) {
  const pts = g.filter((p) => p.time != null);
  if (pts.length < 10) return [];
  const d = trackDists(pts);
  const out = [];
  let cur = null;
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].time - pts[i - 1].time) / 1000;
    if (dt <= 0) continue;
    const v = (d[i] - d[i - 1]) / dt * 3.6;
    const still = v < MOVE_KMH || (dt > 30 && d[i] - d[i - 1] < 50);
    if (still) {
      if (!cur) cur = { i0: i - 1, i1: i, s: 0 };
      cur.i1 = i; cur.s += dt;
    } else if (cur) {
      if (cur.s >= MIN_STOP_S) out.push(cur);
      cur = null;
    }
  }
  if (cur && cur.s >= MIN_STOP_S && cur.i1 < pts.length - 1) out.push(cur);
  const t0 = pts[0].time;
  return out.map((s) => {
    const p = pts[s.i0];
    return { lat: p.lat, lng: p.lng, dur: s.s, km: d[s.i0] / 1000, at: new Date(p.time), from: (p.time - t0) / 1000 };
  });
}

function render() {
  const box = document.getElementById("fFileStops");
  if (!box) return;
  if (!_stops.length) { box.hidden = true; box.innerHTML = ""; _deps.map.setStopMarkers(null); return; }
  const total = _stops.reduce((a, s) => a + s.dur, 0);
  const longest = _stops.reduce((a, s) => Math.max(a, s.dur), 0);
  const list = _expanded ? _stops : [..._stops].sort((a, b) => b.dur - a.dur).slice(0, SHOW).sort((a, b) => a.km - b.km);
  const rows = list.map((s) => {
    const i = _stops.indexOf(s);
    return `<button type="button" class="stp-row${i === _active ? " is-active" : ""}" data-i="${i}">
      <span class="stp-dur${s.dur === longest ? " is-long" : ""}">${clock(s.dur)}</span>
      <span class="stp-main"><b>${num(s.km, 1)} km-nél</b><span>${s.at.toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" })} · ${clock(s.from)} után</span></span>
    </button>`;
  }).join("");
  const more = _stops.length > SHOW ? `<button type="button" class="clb-more" data-more>${_expanded ? "Csak a leghosszabbak" : `Mind a ${_stops.length} megállás`}</button>` : "";
  box.innerHTML = `<div class="be-head"><span>Megállások</span><em class="clb-n">${_stops.length}</em>
      <label class="stp-toggle" title="Jelölők a térképen"><input type="checkbox" data-map${showOnMap() ? " checked" : ""}> térképen</label>
      <span class="clb-hint" title="Ahol legalább 1 percig álltál (2 km/h alatt, vagy a komputer megállt – automatikus szünet). Összesen ${clock(total)}. Alapból a leghosszabbak; a térképen a jelölőkön a perc. Kattints egy sorra: a térkép odaugrik.">?</span></div>
    <div class="stp-sum">Összesen <b>${clock(total)}</b> állás</div>
    <div class="stp-list">${rows}</div>${more}`;
  box.hidden = false;
  box.querySelectorAll(".stp-row").forEach((b) => b.addEventListener("click", () => {
    _active = +b.dataset.i; render();
    const s = _stops[_active];
    _deps.map.focusStop(s.lat, s.lng);
  }));
  box.querySelector("[data-more]")?.addEventListener("click", () => { _expanded = !_expanded; render(); });
  box.querySelector("[data-map]")?.addEventListener("change", (e) => {
    try { localStorage.setItem(LS_KEY, e.target.checked ? "1" : "0"); } catch { /* privát mód */ }
    drawMarkers();
  });
  drawMarkers();
}

function drawMarkers() {
  if (!showOnMap() || !_stops.length) { _deps.map.setStopMarkers(null); return; }
  _deps.map.setStopMarkers(_stops.map((s) => ({
    lat: s.lat, lng: s.lng,
    label: s.dur >= 3600 ? `${Math.floor(s.dur / 3600)}ó${String(Math.round(s.dur % 3600 / 60)).padStart(2, "0")}` : `${Math.round(s.dur / 60)}p`,
    title: `Megállás ${clock(s.dur)} · ${num(s.km, 1)} km`,
  })), { onClick: (i) => { _active = i; _expanded = true; render(); } });
}

function refresh() {
  const g = _deps.getGeometry();
  if (g === _geomRef) return;
  _geomRef = g; _expanded = false; _active = -1;
  _stops = g && g.length >= 10 && _deps.isWorkoutTab() ? detectStops(g.full || g) : [];
  render();
}

export function initStops(deps) {
  _deps = deps;
  document.addEventListener("bringaterv:geometry", () => setTimeout(refresh, 0));
  refresh();
}
