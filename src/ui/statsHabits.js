/**
 * Statisztika → „Szokások”: mikor és mennyit edzel.
 *   1. A hét napjai – oszlopdiagram (edzés / km / óra), alatta táblázat napokra
 *   2. Napszakok – az indulás órája szerinti oszlopdiagram, napszakonként színezve
 *      (Reggel 6–12, Délután 12–17, Este 17–23, Éjjel 23–6), alatta táblázat
 *   3. Táv-sávok – sportáganként (kerékpár 10 km-es sávok, futás 5 / 10 / félmaraton…), átlagsebességgel
 *   4. Felszerelés – órák és km bringánként (Felszerelés → resolveBike)
 *
 * Az időszak- és sportszűrő a Statisztika közös szűrője (mint az Áttekintésnél).
 * A napszak-színek a dataviz-ellenőrzőn átmentek (színvakság, kontraszt) világos és sötét módban;
 * minden diagram mellett felirat és táblázat van, a szín sosem egyedüli jelzés.
 *
 *   renderHabits(allRoutes, { period, sport })
 */
import { num, int, dur } from "../format.js";
import { sportKey, periodRange } from "./statsOverview.js";
import { resolveBike, getBikes } from "../equipment.js";

const BRAND = "#e8461e";
const DAYS = ["Hétfő", "Kedd", "Szerda", "Csütörtök", "Péntek", "Szombat", "Vasárnap"];
const DAYS_SHORT = ["H", "K", "Sze", "Cs", "P", "Szo", "V"];
const DAYS_MID = ["Hétf.", "Kedd", "Szer.", "Csüt.", "Pént.", "Szo.", "Vas."];
// napszakok – a szín a CSS-ben (--tod-*), világos / sötét módban külön árnyalattal
const TOD = [
  { key: "morning", label: "Reggel",  range: "6–12",  from: 6,  to: 12 },
  { key: "noon",    label: "Délután", range: "12–17", from: 12, to: 17 },
  { key: "evening", label: "Este",    range: "17–23", from: 17, to: 23 },
  { key: "night",   label: "Éjjel",   range: "23–6",  from: 23, to: 30 },
];
const todOf = (h) => TOD.find((t) => (h >= t.from && h < t.to) || (h + 24 >= t.from && h + 24 < t.to)) || TOD[3];
const BUCKETS = {
  cycling: [0, 10, 20, 30, 40, 50, 60, 80, 100, 150, Infinity],
  run:     [0, 5, 10, 15, 21.1, 30, 42.2, Infinity],
  foot:    [0, 5, 10, 15, 20, 30, Infinity],
};
const SPORT_TABS = [["cycling", "Kerékpár"], ["run", "Futás"], ["foot", "Gyalog"]];
const footOf = (r) => { const k = sportKey(r); return k === "hike" || k === "walk" ? "foot" : k; };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const when = (r) => new Date(r.start_time || r.date);
const km = (r) => Number(r.distance) || 0;
const mins = (r) => Number(r.duration) || 0;
const up = (r) => Number(r.elevation) || 0;
const kmTxt = (v) => (v >= 100 ? int(v) : num(v, v >= 10 ? 0 : 1));

let _metric = "count", _bucketSport = null, _ro = null, _state = null;

function sums(rs) {
  const n = rs.length, d = rs.reduce((a, r) => a + km(r), 0), t = rs.reduce((a, r) => a + mins(r), 0);
  return { n, km: d, min: t, up: rs.reduce((a, r) => a + up(r), 0), avg: n ? d / n : 0, speed: t > 0 ? d / (t / 60) : null };
}

/** Táblázat-sor: edzések · táv (átl / össz) · szint · mozgásidő [· sebesség] */
// Táblázat: Edzés · Táv · Átlag · Szint · Idő [· Seb.] – üres sorban csak a 0
function row(label, sub, s, { speed = false, swatch = "", avg = true } = {}) {
  const c = (v) => `<td>${s.n ? v : ""}</td>`;
  return `<tr${s.n ? "" : ` class="is-empty"`}>
    <th scope="row"><span class="hb-lbl">${swatch}<span>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</span></span></th>
    <td>${s.n}</td>
    ${c(`${kmTxt(s.km)}<small> km</small>`)}
    ${avg ? c(`${kmTxt(s.avg)}<small> km</small>`) : ""}
    ${c(`${int(s.up)}<small> m</small>`)}
    ${c(s.min ? dur(s.min) : "")}
    ${speed ? c(s.speed ? `${num(s.speed, 1)}<small> km/h</small>` : "") : ""}
  </tr>`;
}
const thead = (first, speed, avg = true) => `<thead><tr><th scope="col">${first}</th><th scope="col">Edzés</th><th scope="col">Táv</th>${avg ? `<th scope="col">Átlag</th>` : ""}<th scope="col">Szint</th><th scope="col">Idő</th>${speed ? `<th scope="col">Seb.</th>` : ""}</tr></thead>`;

// ── Diagramok (SVG, szélességhez igazítva) ───────────────────────────────────
/** Kerek lépésköz (1 / 2 / 2,5 / 5 × 10^n), hogy a 4 rácsvonal kerek számokra essen. */
function niceStep(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }

/** Oszlopok: bars = [{ v, label, fill, tip }]; a legnagyobb értékű oszlop fölött felirat. */
function barsSvg(bars, W, { H = 200, fmt = (v) => int(v), labelEvery = 1, showTop = 3 } = {}) {
  const L = 34, B = 24, T = 18, n = bars.length;
  const vmax = Math.max(...bars.map((b) => b.v), 0);
  const step = Math.max(niceStep(vmax / 4), Number.isInteger(vmax) && vmax < 8 ? 1 : 0);
  const max = step * Math.max(1, Math.ceil(vmax / step));
  const ticks = Math.round(max / step);
  const bw = (W - L - 4) / n, gap = Math.min(8, Math.max(2, bw * 0.22));
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const top = [...bars].map((b) => b.v).sort((a, b) => b - a).slice(0, showTop).filter((v) => v > 0);
  let s = `<svg class="st-svg hb-svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">`;
  for (let k = 0; k <= ticks; k++) {
    const v = step * k, yy = Math.round(y(v)) + 0.5;
    s += `<line x1="${L}" x2="${W}" y1="${yy}" y2="${yy}" class="${k ? "st-grid" : "hb-base"}"/>`;
    s += `<text x="${L - 6}" y="${yy + 3.5}" class="st-axis" text-anchor="end">${fmt(v)}</text>`;
  }
  bars.forEach((b, i) => {
    const x = L + 2 + i * bw + gap / 2, w = Math.max(1, bw - gap), yy = y(b.v), h = H - B - yy;
    // a felső vége lekerekített, az alja az alapvonalon
    if (b.v > 0) {
      const r = Math.min(4, w / 2, h);
      s += `<path d="M${x},${H - B} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + w - r} Q${x + w},${yy} ${x + w},${yy + r} V${H - B} Z" fill="${b.fill}" class="hb-bar"/>`;
    }
    // nagyobb, átlátszó találati terület a buboréknak
    s += `<rect x="${L + 2 + i * bw}" y="${T}" width="${bw}" height="${H - T - B}" fill="transparent" class="hb-hit" data-tip="${esc(b.tip)}"/>`;
    if (i % labelEvery === 0) s += `<text x="${x + w / 2}" y="${H - 7}" class="st-axis" text-anchor="middle">${esc(b.label)}</text>`;
    if (top.includes(b.v) && b.v > 0) s += `<text x="${x + w / 2}" y="${yy - 5}" class="st-val" text-anchor="middle">${fmt(b.v)}</text>`;
  });
  return s + "</svg>";
}

/** Vízszintes sávok (felszerelés): név · sáv · érték */
function hbarsHtml(items, fmt) {
  const max = Math.max(...items.map((x) => x.v), 1);
  return items.map((x) => `<div class="hb-hbar" title="${esc(x.tip)}"><span>${esc(x.label)}</span><i style="width:${(x.v / max) * 100}%"></i><b>${fmt(x.v)}</b></div>`).join("");
}

// ── Fő render ────────────────────────────────────────────────────────────────
export function renderHabits(allRoutes, { period = "year", sport = "all" } = {}) {
  const box = document.getElementById("statsViewHabits");
  if (!box) return;
  const { from, to } = periodRange(period);
  const rs = allRoutes.filter((r) => (r.start_time || r.date) && !isNaN(when(r))
    && (!from || when(r) >= from) && (!to || when(r) < to) && (sport === "all" || sportKey(r) === sport));
  _state = { allRoutes, period, sport };
  if (!rs.length) { box.innerHTML = `<div class="st-empty">Nincs edzés ebben az időszakban.</div>`; return; }

  // 1. a hét napjai (hétfővel kezdve)
  const byDay = DAYS.map(() => []);
  rs.forEach((r) => byDay[(when(r).getDay() + 6) % 7].push(r));
  const daySums = byDay.map(sums);
  const fav = daySums.reduce((b, s, i) => (s.n > daySums[b].n ? i : b), 0);

  // 2. napszak – csak ahol ismert az indulás ideje (a csak dátumos edzés kimarad)
  const timed = rs.filter((r) => r.start_time);
  const byHour = Array.from({ length: 24 }, () => []);
  timed.forEach((r) => byHour[new Date(r.start_time).getHours()].push(r));
  const todSums = TOD.map((t) => sums(timed.filter((r) => todOf(new Date(r.start_time).getHours()) === t)));
  const todTotal = timed.length || 1;
  const hourOrder = Array.from({ length: 24 }, (_, i) => (i + 4) % 24);   // 4:00-tól, hogy az éjjel egyben legyen

  // 3. táv-sávok – a választott sportban (ha a szűrő egy sportra szűkít, az)
  const present = SPORT_TABS.filter(([k]) => rs.some((r) => footOf(r) === k));
  if (sport !== "all") _bucketSport = footOf({ sport_type: sport === "hike" ? "hiking" : sport === "walk" ? "walking" : sport === "run" ? "running" : "cycling" });
  if (!present.some(([k]) => k === _bucketSport)) _bucketSport = present[0]?.[0] || "cycling";
  const edges = BUCKETS[_bucketSport] || BUCKETS.cycling;
  const sportRs = rs.filter((r) => footOf(r) === _bucketSport);
  const bucketRows = edges.slice(0, -1).map((a, i) => {
    const b = edges[i + 1];
    const s = sums(sportRs.filter((r) => km(r) >= a && km(r) < b));
    return { label: b === Infinity ? `${num(a, a % 1 ? 1 : 0)}+ km` : `${num(a, a % 1 ? 1 : 0)}–${num(b, b % 1 ? 1 : 0)} km`, s };
  }).filter((x, i, arr) => x.s.n || arr.slice(i).some((y) => y.s.n));   // a végéről az üres sávok elmaradnak

  // 4. felszerelés (bringák) – kerékpáros edzések óra szerint
  const bikes = getBikes();
  const byBike = new Map();
  rs.filter((r) => sportKey(r) === "cycling").forEach((r) => {
    const b = resolveBike(r, bikes);
    const name = b?.name || "Nincs megadva";
    if (!byBike.has(name)) byBike.set(name, []);
    byBike.get(name).push(r);
  });
  const bikeRows = [...byBike.entries()].map(([name, list]) => ({ name, s: sums(list) })).sort((a, b) => b.s.min - a.s.min);

  const metricBtn = (k, l) => `<button type="button" class="stats-chip${_metric === k ? " stats-chip--active" : ""}" data-hb-metric="${k}">${l}</button>`;
  const swatch = (t) => `<i class="hb-sw hb-tod--${t.key}" aria-hidden="true"></i>`;
  const favTod = TOD[todSums.reduce((b, s, i) => (s.n > todSums[b].n ? i : b), 0)];

  box.innerHTML = `
    <div class="st-kpis hb-kpis">
      <div class="st-kpi"><b>${DAYS[fav]}</b><div>kedvenc nap</div></div>
      ${timed.length ? `<div class="st-kpi"><b>${favTod.label}</b><div>leggyakoribb napszak</div></div>` : ""}
      <div class="st-kpi"><b>${kmTxt(sums(rs).avg)}<small>km</small></b><div>átlagos táv</div></div>
    </div>
    <div class="hb-grid">
      <section class="st-card">
        <div class="st-head"><h3>A hét napjai</h3><span class="hb-chips">${metricBtn("count", "Edzés")}${metricBtn("km", "km")}${metricBtn("min", "Óra")}</span></div>
        <div data-hb-chart="days"></div>
        <div class="hb-tbl-wrap"><table class="hb-tbl">${thead("Nap")}<tbody>${daySums.map((s, i) => row(DAYS[i], "", s)).join("")}</tbody></table></div>
      </section>
      <section class="st-card">
        <div class="st-head"><h3>Napszakok</h3></div>
        ${timed.length ? `
        <div class="hb-legend">${TOD.map((t, i) => `<span>${swatch(t)}${t.label} <b>${Math.round(todSums[i].n / todTotal * 100)}%</b></span>`).join("")}</div>
        <div data-hb-chart="hours"></div>
        <div class="hb-tbl-wrap"><table class="hb-tbl">${thead("Napszak")}<tbody>${TOD.map((t, i) => row(t.label, t.range, todSums[i], { swatch: swatch(t) })).join("")}</tbody></table></div>`
        : `<div class="st-note">Nincs indulási időpont.</div>`}
      </section>
      <section class="st-card">
        <div class="st-head"><h3>Táv-sávok</h3>${present.length > 1 ? `<span class="hb-chips">${present.map(([k, l]) => `<button type="button" class="stats-chip${k === _bucketSport ? " stats-chip--active" : ""}" data-hb-sport="${k}">${l}</button>`).join("")}</span>` : ""}</div>
        <div class="hb-tbl-wrap"><table class="hb-tbl hb-tbl--bars">${thead("Táv", true)}<tbody>${bucketRows.map((b) => row(b.label, "", b.s, { speed: true })).join("")}</tbody></table></div>
      </section>
      <section class="st-card">
        <div class="st-head"><h3>Felszerelés</h3></div>
        ${bikeRows.length ? `<div class="hb-hbars">${hbarsHtml(bikeRows.map((b) => ({ label: b.name, v: b.s.min, tip: `${b.name} · ${dur(b.s.min)}` })), (v) => dur(v))}</div>
        <div class="hb-tbl-wrap"><table class="hb-tbl">${thead("Bringa", true, false)}<tbody>${bikeRows.map((b) => row(b.name, "", b.s, { speed: true, avg: false })).join("")}</tbody></table></div>`
        : `<div class="st-note">Nincs kerékpáros edzés.</div>`}
      </section>
    </div>`;

  const dayVal = (s) => (_metric === "km" ? s.km : _metric === "min" ? s.min / 60 : s.n);
  const dayFmt = _metric === "km" ? (v) => kmTxt(v) : _metric === "min" ? (v) => num(v, v >= 10 ? 0 : 1) : (v) => int(v);
  const draw = {
    days: (w) => barsSvg(daySums.map((s, i) => ({
      v: dayVal(s), label: w < 420 ? DAYS_SHORT[i] : DAYS_MID[i], fill: i === fav ? BRAND : "var(--st-bar)",
      tip: `${DAYS[i]} · ${s.n} edzés · ${kmTxt(s.km)} km`,
    })), w, { fmt: dayFmt, showTop: 1 }),
    hours: (w) => barsSvg(hourOrder.map((h) => {
      const s = sums(byHour[h]);
      return { v: s.n, label: `${h}h`, fill: `var(--tod-${todOf(h).key})`,
               tip: `${h}:00 · ${s.n} edzés` };
    }), w, { labelEvery: w < 520 ? 6 : 3, showTop: 0 }),
  };
  const paint = () => box.querySelectorAll("[data-hb-chart]").forEach((el) => {
    const w = Math.round(el.clientWidth);
    if (w > 0 && Number(el.dataset.w) !== w) { el.dataset.w = w; el.innerHTML = draw[el.dataset.hbChart](w); }
  });
  paint();
  _ro?.disconnect();
  _ro = new ResizeObserver(paint);
  box.querySelectorAll("[data-hb-chart]").forEach((el) => _ro.observe(el));

  if (!box.dataset.bound) {
    box.dataset.bound = "1";
    box.addEventListener("click", (e) => {
      const m = e.target.closest("[data-hb-metric]");
      if (m) { _metric = m.dataset.hbMetric; renderHabits(_state.allRoutes, _state); return; }
      const sp = e.target.closest("[data-hb-sport]");
      if (sp) { _bucketSport = sp.dataset.hbSport; renderHabits(_state.allRoutes, _state); }
    });
    // buborék az oszlopok fölött (egér és koppintás)
    let tip = null;
    const show = (el, x, y) => {
      tip ??= Object.assign(document.createElement("div"), { className: "hb-tip", role: "tooltip" });
      if (!tip.isConnected) document.body.appendChild(tip);
      tip.textContent = el.dataset.tip; tip.hidden = false;
      tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, x + 12)) + "px";
      tip.style.top = Math.max(8, y - tip.offsetHeight - 10) + "px";
    };
    box.addEventListener("pointermove", (e) => {
      const el = e.target.closest(".hb-hit");
      if (el) show(el, e.clientX, e.clientY); else if (tip) tip.hidden = true;
    });
    box.addEventListener("pointerleave", () => { if (tip) tip.hidden = true; });
  }
}
