/**
 * Bringaterv – zónaeloszlás az Elemzés lenyíló paneljeiben
 * =========================================================
 * Sebesség, kadencia, teljesítmény, hőmérséklet (idő szerint) és lejtés (táv szerint):
 * a pulzus zónatáblázatának mintájára soronként szín, tartomány, sáv, idő / táv, százalék.
 * A sorok data-legend-* attribútumaiból a térkép sarkában lévő jelmagyarázat is dolgozik
 * (mapLegend.js), így a kettő mindig ugyanazt mutatja.
 */

import { getZoneBoundaries, ZONE_COLORS } from "./settings.js";
import { TEMP_BANDS, buildElevationData } from "./elevationProfile.js";
import { num } from "../format.js";

const UNITS = { speed: "km/h", cad: "rpm", power: "W" };
const PANELS = { speed: "speedLegend", cad: "cadLegend", power: "powerLegend", temp: "tempLegend", grade: "gradeLegend" };

// a térképi lejtés-színezés sávjai (mapAdapter.gradeColor)
const GRADE_BANDS = [
  [8, null, "#7F1D1D", "↑ 8% felett"], [4, 8, "#DC2626", "↑ 4–8%"], [2, 4, "#EF4444", "↑ 2–4%"],
  [0.5, 2, "#FCA5A5", "↑ 0,5–2%"], [-0.5, 0.5, "#9CA3AF", "sík (±0,5%)"], [-2, -0.5, "#86EFAC", "↓ 0,5–2%"],
  [-4, -2, "#22C55E", "↓ 2–4%"], [-8, -4, "#15803D", "↓ 4–8%"], [null, -8, "#14532D", "↓ 8% felett"],
];

function bandsFor(kind) {
  if (kind === "temp") {
    return TEMP_BANDS.map(([lo, hi, color]) => ({ lo, hi, color,
      label: lo == null ? `${hi} °C alatt` : hi == null ? `${lo} °C felett` : `${lo}–${hi} °C` }));
  }
  if (kind === "grade") return GRADE_BANDS.map(([lo, hi, color, label]) => ({ lo, hi, color, label }));
  const b = getZoneBoundaries(kind), u = UNITS[kind];
  return ZONE_COLORS.map((color, i) => ({
    lo: i === 0 ? null : b[i - 1], hi: i === b.length ? null : b[i], color,
    label: i === 0 ? `${b[0]} ${u} alatt` : i === b.length ? `${b[b.length - 1]}+ ${u}` : `${b[i - 1]}–${b[i]} ${u}`,
  }));
}

const inBand = (v, b) => (b.lo == null || v >= b.lo) && (b.hi == null || v < b.hi);

/** Mint a pulzus-táblázatban: p:mm, egy óra felett ó:pp:mm */
function fmtDur(sec) {
  const t = Math.round(sec), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** [{color, label, amount, pct}] – amount: másodperc (lejtésnél méter) */
export function zoneDistribution(kind, geometry) {
  const bands = bandsFor(kind);
  const sums = bands.map(() => 0);
  if (kind === "grade") {
    // ~100 m-es szakaszok (a pontról pontra számolt lejtés a magassági zaj miatt szélsőséges)
    const d = buildElevationData(geometry || []).filter((p) => p.value != null);
    let start = 0;
    for (let i = 1; i < d.length; i++) {
      const w = d[i].dist - d[start].dist;
      if (w < 100 && i < d.length - 1) continue;
      if (w > 0) {
        const g = (d[i].value - d[start].value) / w * 100;
        const k = bands.findIndex((b) => inBand(g, b));
        if (k >= 0) sums[k] += w;
      }
      start = i;
    }
  } else {
    const g = geometry || [];
    for (let i = 1; i < g.length; i++) {
      const v = g[i][kind];
      if (v == null || !Number.isFinite(v)) continue;
      const t0 = g[i - 1].time, t1 = g[i].time;
      const w = t0 && t1 ? Math.min(Math.max((t1 - t0) / 1000, 0), 60) : 1;
      const k = bands.findIndex((b) => inBand(v, b));
      if (k >= 0) sums[k] += w;
    }
  }
  const total = sums.reduce((a, x) => a + x, 0);
  if (!total) return [];
  return bands.map((b, i) => ({ color: b.color, label: b.label, amount: sums[i], pct: sums[i] / total * 100 }));
}

function rowsHtml(kind, dist) {
  return dist.map((z) => {
    const amount = kind === "grade" ? `${num(z.amount / 1000, 1)} km` : fmtDur(z.amount);
    const pct = Math.round(z.pct);
    return `<div class="hr-zone-row zone-dist-row" data-legend-color="${z.color}" data-legend-label="${z.label}">
        <div class="hr-zone-row-label"><span class="hr-zone-row-name" style="color:${z.color}">${z.label}</span></div>
        <div class="hr-zone-row-bar-wrap"><div class="hr-zone-row-bar" style="width:${z.pct}%;background:${z.color}"></div></div>
        <span class="hr-zone-row-time">${amount}</span>
        <span class="hr-zone-row-pct" style="color:${z.color}">${pct}%</span>
      </div>`;
  }).join("");
}

let _lastGeometry = null;

/** Az összes panel eloszlás-táblázata (a panel .speed-legend-items helyén). */
export function renderZoneDists(geometry = _lastGeometry) {
  _lastGeometry = geometry;
  for (const [kind, id] of Object.entries(PANELS)) {
    const box = document.querySelector(`#${id} .speed-legend-items`);
    if (!box) continue;
    const dist = geometry ? zoneDistribution(kind, geometry) : [];
    if (!dist.length) continue;                 // nincs adat: marad a statikus színskála
    box.classList.add("zone-dist");
    box.innerHTML = rowsHtml(kind, dist);
  }
}

// zónahatár-módosítás után (a Beállítások újrarajzolja a statikus skálát) – utána mi
window.addEventListener("bringaterv:settingChanged", () => setTimeout(() => renderZoneDists(), 0));
