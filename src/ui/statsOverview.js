/**
 * Bringaterv – Statok: Áttekintés, Napló-naptár, Évösszefoglaló
 * ==============================================================
 * A könyvtár edzéseiből (index adatok, GPX nélkül) számol:
 *   renderOverview(routes, { period, sport })  – számok változással, évek összehasonlítása,
 *        hét napjai / napszak, heti km (52 hét), táv-eloszlás, sportágak, mérföldkövek
 *   renderJournal(routes, { sport })            – hónapnaptár km-rel, lapozható
 *   renderYearReview(routes, { year })          – az év egy oldalon + megosztó kép (Dreeve „Rewind”)
 * A diagramok SVG-k (a téma színeit CSS-változókból veszik).
 */

import { num } from "../format.js";

const BRAND = "#e8461e";
const MONTHS = ["jan", "febr", "márc", "ápr", "máj", "jún", "júl", "aug", "szept", "okt", "nov", "dec"];
const MONTHS_LONG = ["január", "február", "március", "április", "május", "június", "július", "augusztus", "szeptember", "október", "november", "december"];
const DAYS = ["H", "K", "Sze", "Cs", "P", "Szo", "V"];
const DAYS_LONG = ["hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat", "vasárnap"];
const SPORT_LABELS = { cycling: "Kerékpár", run: "Futás", hike: "Túra", walk: "Séta", other: "Egyéb" };
const SPORT_COLORS = { cycling: "#3B82F6", run: "#22C55E", hike: "#A855F7", walk: "#F59E0B", other: "#6B7280" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const when = (r) => new Date(r.start_time || r.date);
const km0 = (v) => Math.round(v).toLocaleString("hu-HU");

export function sportKey(r) {
  const t = (r.sport_type || r.type || "").toLowerCase();
  if (!t || t === "route" || t === "workout") return "cycling";
  if (t.includes("cycl") || t.includes("ride") || t.includes("bike") || t === "asphalt" || t === "gravel" || t === "mtb") return "cycling";
  if (t.includes("hik")) return "hike";
  if (t.includes("walk")) return "walk";
  if (t.includes("run")) return "run";
  return "other";
}

function valid(routes, sport) {
  return routes.filter((r) => (r.start_time || r.date) && !isNaN(when(r)) && (sport === "all" || sportKey(r) === sport));
}

function sums(rs) {
  return {
    n: rs.length,
    km: rs.reduce((a, r) => a + (Number(r.distance) || 0), 0),
    up: rs.reduce((a, r) => a + (Number(r.elevation) || 0), 0),
    min: rs.reduce((a, r) => a + (Number(r.duration) || 0), 0),
  };
}

/** Időszak határai + az összehasonlítás alapja (tavaly ugyanekkor / előző 12 hónap / előző év). */
export function periodRange(period, now = new Date()) {
  const y = now.getFullYear();
  const end = new Date(y, now.getMonth(), now.getDate() + 1);
  if (period === "year") {
    const from = new Date(y, 0, 1);
    return { from, to: end, prev: [new Date(y - 1, 0, 1), new Date(y - 1, now.getMonth(), now.getDate() + 1)], prevLabel: "tavaly ilyenkor" };
  }
  if (period === "12m") {
    const from = new Date(y, now.getMonth() - 11, 1);
    return { from, to: end, prev: [new Date(y - 1, now.getMonth() - 11, 1), from], prevLabel: "előző 12 hónap" };
  }
  const m = /^y(\d{4})$/.exec(period || "");
  if (m) {
    const yy = Number(m[1]);
    return { from: new Date(yy, 0, 1), to: new Date(yy + 1, 0, 1), prev: [new Date(yy - 1, 0, 1), new Date(yy, 0, 1)], prevLabel: `${yy - 1}-ben` };
  }
  return { from: null, to: null, prev: null, prevLabel: "" };
}

const inRange = (r, from, to) => { const t = when(r); return (!from || t >= from) && (!to || t < to); };

// ── SVG segédek ──────────────────────────────────────────────────────────────
const svgOpen = (W, H) => `<svg class="st-svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img">`;
const gridLine = (x1, x2, y) => `<line x1="${x1}" x2="${x2}" y1="${y}" y2="${y}" class="st-grid"/>`;
const axisTxt = (x, y, t, anchor = "end") => `<text x="${x}" y="${y}" class="st-axis" text-anchor="${anchor}">${t}</text>`;
const niceMax = (v) => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; };

/** Évek egymásra: halmozott km az év napjai szerint */
function yearCompareSvg(routes, years, today, W = 760) {
  const H = W < 500 ? 210 : 250, L = 46, R = 92, T = 12, B = 24, iw = W - L - R, ih = H - T - B;
  const series = years.map((y) => {
    const rs = routes.filter((r) => when(r).getFullYear() === y).sort((a, b) => when(a) - when(b));
    let acc = 0;
    const start = new Date(y, 0, 1), len = (new Date(y + 1, 0, 1) - start) / 864e5;
    const pts = [[0, 0]];
    rs.forEach((r) => { const f = (when(r) - start) / 864e5 / len; pts.push([f, acc]); acc += Number(r.distance) || 0; pts.push([f, acc]); });
    const endF = y === today.getFullYear() ? Math.min(1, (today - start) / 864e5 / len) : 1;
    pts.push([endF, acc]);
    return { y, pts, total: acc, endF };
  });
  const max = niceMax(Math.max(...series.map((s) => s.total), 1));
  const xOf = (f) => L + f * iw, yOf = (v) => T + ih - (v / max) * ih;
  let svg = svgOpen(W, H);
  for (let k = 0; k <= 4; k++) { const v = (max / 4) * k; svg += gridLine(L, L + iw, yOf(v)) + axisTxt(L - 6, yOf(v) + 4, km0(v)); }
  const mStep = iw < 360 ? 3 : 1;
  MONTHS.forEach((m, i) => { if (i % mStep === 0) svg += axisTxt(xOf((i + 0.5) / 12), H - 6, m, "middle"); });
  const shades = ["var(--st-old2)", "var(--st-old1)", BRAND];
  series.forEach((s, i) => {
    const col = i === series.length - 1 ? BRAND : shades[Math.max(0, i - (series.length - 3))] || "var(--st-old2)";
    const cur = i === series.length - 1;
    const d = s.pts.map((p, k) => (k ? "L" : "M") + xOf(p[0]).toFixed(1) + " " + yOf(p[1]).toFixed(1)).join("");
    svg += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${cur ? 2.8 : 2}" stroke-linejoin="round"/>`;
    const ex = xOf(s.endF), ey = yOf(s.total);
    svg += `<circle cx="${ex}" cy="${ey}" r="${cur ? 4.5 : 3}" fill="${col}" stroke="var(--panel-bg)" stroke-width="2"/>`;
    svg += `<text x="${ex + 8}" y="${ey + 4}" class="st-lbl${cur ? " is-cur" : ""}">${s.y} · ${km0(s.total)}</text>`;
  });
  if (series.some((s) => s.y === today.getFullYear())) {
    const s = series.find((x) => x.y === today.getFullYear());
    svg += `<line x1="${xOf(s.endF)}" x2="${xOf(s.endF)}" y1="${T}" y2="${T + ih}" class="st-today"/>`;
  }
  return svg + "</svg>";
}

/** Oszlopdiagram (hét napjai / napszak) – értékcímkékkel */
function barsSvg(vals, labels, { H = 190, hi = 2, fmt = (v) => km0(v), W = 420 } = {}) {
  const B = 22, T = 18, n = vals.length, bw = (W - 10) / n, max = Math.max(...vals, 1);
  const top = [...vals].sort((a, b) => b - a).slice(0, hi).filter((v) => v > 0);
  let svg = svgOpen(W, H);
  vals.forEach((v, i) => {
    const h = (v / max) * (H - B - T), x = 5 + i * bw + 6, y = H - B - h;
    svg += `<rect x="${x}" y="${y}" width="${bw - 12}" height="${Math.max(h, v > 0 ? 2 : 0)}" rx="4" fill="${top.includes(v) ? BRAND : "var(--st-bar)"}"/>`;
    svg += axisTxt(x + (bw - 12) / 2, H - 6, labels[i], "middle");
    if (v > 0) svg += `<text x="${x + (bw - 12) / 2}" y="${y - 5}" class="st-val" text-anchor="middle">${fmt(v)}</text>`;
  });
  return svg + "</svg>";
}

/** Heti km az utolsó 52 hétben + 4 hetes átlag */
function weeklySvg(routes, today, W = 1200) {
  const H = W < 500 ? 160 : 200, L = 40, R = 8, T = 10, B = 22, iw = W - L - R, ih = H - T - B, N = 52;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  const start = new Date(monday); start.setDate(monday.getDate() - (N - 1) * 7);
  const vals = new Array(N).fill(0);
  routes.forEach((r) => { const i = Math.floor((when(r) - start) / (7 * 864e5)); if (i >= 0 && i < N) vals[i] += Number(r.distance) || 0; });
  const max = niceMax(Math.max(...vals, 10)), bw = iw / N, yOf = (v) => T + ih - (v / max) * ih;
  let svg = svgOpen(W, H);
  for (let k = 0; k <= 3; k++) { const v = (max / 3) * k; svg += gridLine(L, L + iw, yOf(v)) + axisTxt(L - 6, yOf(v) + 4, km0(v)); }
  vals.forEach((v, i) => { const h = ih - (yOf(v) - T); svg += `<rect x="${L + i * bw + 1}" y="${yOf(v)}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2" fill="${i === N - 1 ? BRAND : "var(--st-bar)"}"><title>${num(v, 0)} km</title></rect>`; });
  const ma = vals.map((_, i) => { const s = vals.slice(Math.max(0, i - 3), i + 1); return s.reduce((a, b) => a + b, 0) / s.length; });
  svg += `<path d="${ma.map((v, i) => (i ? "L" : "M") + (L + (i + 0.5) * bw).toFixed(1) + " " + yOf(v).toFixed(1)).join("")}" fill="none" class="st-trend"/>`;
  let lastM = -1, lastX = -99;
  for (let i = 0; i < N; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i * 7);
    if (d.getMonth() !== lastM && i < N - 2) {
      lastM = d.getMonth();
      const x = L + i * bw;
      if (x - lastX >= 40) { svg += axisTxt(x, H - 6, MONTHS[lastM], "start"); lastX = x; }   // ne csússzanak egymásra
    }
  }
  return svg + "</svg>";
}

// ── Mérföldkövek ─────────────────────────────────────────────────────────────
function milestones(routes, today) {
  const rs = [...routes].sort((a, b) => when(a) - when(b));
  const out = [];
  let total = 0;
  const yearAcc = {}, yearUp = {};
  let longest = 0;
  const totSteps = [1000, 2500, 5000, 7500, 10000, 15000, 20000, 25000, 30000, 40000, 50000];
  rs.forEach((r) => {
    const d = when(r), y = d.getFullYear(), km = Number(r.distance) || 0, up = Number(r.elevation) || 0;
    const before = total; total += km;
    totSteps.forEach((s) => { if (before < s && total >= s) out.push({ d, t: `${km0(s)} km összesen`, r }); });
    const yb = yearAcc[y] || 0; yearAcc[y] = yb + km;
    for (let s = 500; s <= 20000; s += 500) if (yb < s && yearAcc[y] >= s) out.push({ d, t: `${km0(s)} km ${y}-ben`, r });
    const ub = yearUp[y] || 0; yearUp[y] = ub + up;
    for (let s = 5000; s <= 200000; s += 5000) if (ub < s && yearUp[y] >= s) out.push({ d, t: `${km0(s)} m szint ${y}-ben`, r });
    [50, 100, 150, 200, 300].forEach((s) => { if (longest < s && km >= s) out.push({ d, t: `Első ${s} km feletti edzés`, r }); });
    longest = Math.max(longest, km);
  });
  const y = today.getFullYear(), cur = yearAcc[y] || 0;
  const next = Math.ceil((cur + 1) / 500) * 500;
  return { list: out.reverse().slice(0, 4), next: { t: `${km0(next)} km ${y}-ben`, left: next - cur } };
}

// ── Áttekintés ───────────────────────────────────────────────────────────────
export function renderOverview(allRoutes, { period = "year", sport = "all" } = {}) {
  const box = document.getElementById("statsViewOverview");
  if (!box) return;
  const today = new Date();
  const base = valid(allRoutes, sport);
  const pr = periodRange(period, today);
  const rs = base.filter((r) => inRange(r, pr.from, pr.to));
  const s = sums(rs);
  const p = pr.prev ? sums(base.filter((r) => inRange(r, pr.prev[0], pr.prev[1]))) : null;
  const delta = (cur, prev, unit = "") => {
    if (!p || !prev) return "";
    const d = cur - prev, pct = Math.round((d / prev) * 100);
    const cls = d >= 0 ? "st-up" : "st-dn";
    // nagyon kis bázisnál a százalék félrevezető – csak az előző érték
    if (Math.abs(pct) > 300) return `${pr.prevLabel} ${km0(prev)}${unit}`;
    return `<span class="${cls}">${d >= 0 ? "▲" : "▼"} ${Math.abs(pct)}%</span> ${pr.prevLabel} ${km0(prev)}${unit}`;
  };
  const hours = s.min / 60;
  const avg = s.min > 0 ? s.km / hours : 0;
  if (!base.length) { box.innerHTML = `<div class="st-empty">Még nincs edzésed – tölts be egyet, vagy kösd be a Stravát.</div>`; return; }

  // évek összehasonlítása: az utolsó 3 év, amiben van adat (idei mindig)
  const ys = [...new Set(base.map((r) => when(r).getFullYear()))].sort();
  const curY = /^y(\d{4})$/.test(period) ? Number(period.slice(1)) : today.getFullYear();
  const years = ys.filter((y) => y <= curY).slice(-3);
  if (!years.includes(curY)) years.push(curY);
  const ahead = (() => {
    if (years.length < 2 || curY !== today.getFullYear()) return "";
    const a = sums(base.filter((r) => inRange(r, new Date(curY, 0, 1), new Date(curY, today.getMonth(), today.getDate() + 1)))).km;
    const b = sums(base.filter((r) => inRange(r, new Date(curY - 1, 0, 1), new Date(curY - 1, today.getMonth(), today.getDate() + 1)))).km;
    if (!b) return "";
    const doy = (today - new Date(curY, 0, 1)) / 864e5 + 1, proj = a / doy * 365;
    const diff = a - b;
    return `Idén <b class="${diff >= 0 ? "st-up" : "st-dn"}">${km0(Math.abs(diff))} km-rel ${diff >= 0 ? "előrébb" : "lemaradva"}</b> jársz, mint tavaly ugyanekkor. Ha így folytatod, év végére ~${km0(Math.round(proj / 50) * 50)} km.`;
  })();

  // hét napjai + napszak
  const wd = new Array(7).fill(0), cnt = new Array(7).fill(0);
  const tod = [0, 0, 0, 0, 0];   // reggel, délelőtt, délután, este, éjjel
  rs.forEach((r) => {
    const d = when(r), i = (d.getDay() + 6) % 7; wd[i] += Number(r.distance) || 0; cnt[i]++;
    if (r.start_time) { const h = d.getHours(); tod[h >= 5 && h < 10 ? 0 : h >= 10 && h < 12 ? 1 : h >= 12 && h < 17 ? 2 : h >= 17 && h < 21 ? 3 : 4] += 1; }
  });
  const favDay = wd.indexOf(Math.max(...wd));
  const TOD = ["Reggel", "Délelőtt", "Délután", "Este", "Éjjel"];
  const favTod = tod.some((v) => v > 0) ? TOD[tod.indexOf(Math.max(...tod))] : "—";
  const favDayPct = s.n ? Math.round((cnt[favDay] / s.n) * 100) : 0;

  // táv-eloszlás
  const buckets = [[0, 25], [25, 50], [50, 75], [75, 100], [100, Infinity]];
  const bc = buckets.map(([a, b]) => rs.filter((r) => (r.distance || 0) >= a && (r.distance || 0) < b).length);
  const bmax = Math.max(...bc, 1);
  // sportágak
  const bySport = {};
  rs.forEach((r) => { const k = sportKey(r); bySport[k] = (bySport[k] || 0) + (Number(r.distance) || 0); });
  const sportRows = Object.entries(bySport).sort((a, b) => b[1] - a[1]);
  const sportTot = sportRows.reduce((a, [, v]) => a + v, 0) || 1;
  const ms = milestones(base, today);

  box.innerHTML = `
    <div class="st-kpis">
      <div class="st-kpi"><b>${km0(s.km)}<small>km</small></b><div>${delta(s.km, p?.km, " km") || "&nbsp;"}</div></div>
      <div class="st-kpi"><b>${s.n}<small>edzés</small></b><div>${p && p.n ? `<span class="${s.n >= p.n ? "st-up" : "st-dn"}">${s.n >= p.n ? "▲" : "▼"} ${Math.abs(s.n - p.n)}</span> ${pr.prevLabel}` : "&nbsp;"}</div></div>
      <div class="st-kpi"><b>${km0(s.up)}<small>m</small></b><div>${s.up >= 8849 ? `${num(s.up / 8849, 1)}× Mount Everest` : delta(s.up, p?.up, " m") || "&nbsp;"}</div></div>
      <div class="st-kpi"><b>${hours >= 10 ? km0(hours) : num(hours, 1)}<small>óra</small></b><div>${avg ? `átlag ${num(avg, 1)} km/h` : "&nbsp;"}</div></div>
    </div>
    <div class="st-grid2">
      <section class="st-card">
        <div class="st-head"><h3>Évek összehasonlítása · halmozott km</h3></div>
        <div data-chart="year"></div>
        ${ahead ? `<p class="st-note">${ahead}</p>` : ""}
      </section>
      <section class="st-card">
        <div class="st-head"><h3>Melyik napon tekersz?</h3><span>km a hét napjain</span></div>
        <div data-chart="days"></div>
        <div class="st-mini"><div class="cs-stat"><b>${DAYS_LONG[favDay].replace(/^./, (c) => c.toUpperCase())}</b><span>kedvenc nap · az edzések ${favDayPct}%-a</span></div>
          <div class="cs-stat"><b>${favTod}</b><span>leggyakoribb napszak</span></div></div>
      </section>
    </div>
    <section class="st-card">
      <div class="st-head"><h3>Heti km · utolsó 52 hét</h3><span>a vonal a 4 hetes átlag</span></div>
      <div data-chart="weekly"></div>
    </section>
    <div class="st-grid3">
      <section class="st-card">
        <div class="st-head"><h3>Táv-eloszlás</h3><span>edzések száma</span></div>
        ${buckets.map(([a, b], i) => `<div class="st-dd"><span>${b === Infinity ? `${a}+ km` : `${a}–${b} km`}</span><i style="width:${(bc[i] / bmax) * 100}%"></i><b>${bc[i]}</b></div>`).join("")}
      </section>
      <section class="st-card">
        <div class="st-head"><h3>Sportágak</h3><span>km</span></div>
        ${sportRows.map(([k, v]) => `<div class="st-dd"><span>${SPORT_LABELS[k] || k}</span><i style="width:${(v / sportTot) * 100}%;background:${SPORT_COLORS[k]}"></i><b>${km0(v)}</b></div>`).join("") || `<div class="st-note">Nincs adat</div>`}
      </section>
      <section class="st-card">
        <div class="st-head"><h3>Mérföldkövek</h3></div>
        <div class="st-ms">${ms.list.map((m) => `<button type="button" class="st-ms-item" data-record-route-id="${esc(m.r.id)}" data-record-route-name="${esc(m.r.name || "")}"><b>${esc(m.t)}</b><span>${m.d.toLocaleDateString("hu-HU", { month: "short", day: "numeric", year: m.d.getFullYear() !== today.getFullYear() ? "numeric" : undefined })} · ${esc(m.r.name || "")}</span></button>`).join("") || `<div class="st-note">Még nincs mérföldkő.</div>`}
          <div class="st-ms-next">Következő: <b>${esc(ms.next.t)}</b> – még ${km0(ms.next.left)} km</div></div>
      </section>
    </div>`;
  const draw = {
    year: (w) => yearCompareSvg(base, years, today, w),
    days: (w) => barsSvg(wd, DAYS, { W: w }),
    weekly: (w) => weeklySvg(base, today, w),
  };
  const paint = () => box.querySelectorAll("[data-chart]").forEach((el) => {
    const w = Math.round(el.clientWidth);
    if (w > 0 && Number(el.dataset.w) !== w) { el.dataset.w = w; el.innerHTML = draw[el.dataset.chart](w); }
  });
  paint();
  _ro?.disconnect();
  _ro = new ResizeObserver(() => paint());
  box.querySelectorAll("[data-chart]").forEach((el) => _ro.observe(el));
}
let _ro = null;

// ── Napló: hónapnaptár ───────────────────────────────────────────────────────
let _jMonth = null;   // [év, hónap]
export function renderJournal(allRoutes, { sport = "all" } = {}) {
  const box = document.getElementById("statsJournal");
  if (!box) return;
  const today = new Date();
  if (!_jMonth) _jMonth = [today.getFullYear(), today.getMonth()];
  const [Y, M] = _jMonth;
  const base = valid(allRoutes, sport);
  const inMonth = (r, y, m) => { const d = when(r); return d.getFullYear() === y && d.getMonth() === m; };
  const rs = base.filter((r) => inMonth(r, Y, M));
  const prevM = M === 0 ? [Y - 1, 11] : [Y, M - 1];
  const s = sums(rs), ps = sums(base.filter((r) => inMonth(r, prevM[0], prevM[1])));
  const byDay = {};
  rs.forEach((r) => { const d = when(r).getDate(); (byDay[d] = byDay[d] || []).push(r); });
  const first = new Date(Y, M, 1), lead = (first.getDay() + 6) % 7, days = new Date(Y, M + 1, 0).getDate();
  const isToday = (d) => Y === today.getFullYear() && M === today.getMonth() && d === today.getDate();
  const dayKm = (d) => (byDay[d] || []).reduce((a, r) => a + (Number(r.distance) || 0), 0);
  const maxKm = Math.max(1, ...Object.keys(byDay).map(Number).map(dayKm));
  let cells = DAYS.map((d) => `<div class="st-cal-dh">${d}</div>`).join("") + '<div class="st-cal-d is-pad"></div>'.repeat(lead);
  for (let d = 1; d <= days; d++) {
    const list = byDay[d] || [];
    const km = dayKm(d);
    const r0 = list[0];
    // a kör mérete a nap km-jével arányos (terület szerint), mint a Strava edzésnaptárában
    const size = Math.round(12 + 20 * Math.sqrt(km / maxKm));
    cells += list.length
      ? `<button type="button" class="st-cal-d has${isToday(d) ? " is-today" : ""}" data-record-route-id="${esc(r0.id)}" data-record-route-name="${esc(r0.name || "")}" title="${esc(list.map((r) => `${r.name} · ${num(r.distance || 0, 1)} km`).join("\n"))}">
          <span class="st-cal-n">${d}</span><i class="st-cal-dot" style="width:${size}px;height:${size}px"></i><b>${num(km, 0)} km</b></button>`
      : `<div class="st-cal-d${isToday(d) ? " is-today" : ""}"><span class="st-cal-n">${d}</span></div>`;
  }
  const chg = ps.km ? Math.round(((s.km - ps.km) / ps.km) * 100) : null;
  box.innerHTML = `
    <div class="st-j-head">
      <h3>${Y}. ${MONTHS_LONG[M]}</h3>
      <div class="st-j-nav"><button type="button" data-j="-1" aria-label="Előző hónap">‹</button><button type="button" data-j="1" aria-label="Következő hónap" ${Y === today.getFullYear() && M === today.getMonth() ? "disabled" : ""}>›</button></div>
    </div>
    <div class="st-j-sum">
      <div class="cs-stat"><b>${km0(s.km)}<small>km</small></b><span>${s.n} edzés</span></div>
      <div class="cs-stat"><b>${km0(s.up)}<small>m</small></b><span>szint</span></div>
      <div class="cs-stat"><b>${num(s.min / 60, 1)}<small>ó</small></b><span>idő</span></div>
      ${chg != null ? `<div class="cs-stat"><b class="${chg >= 0 ? "st-up" : "st-dn"}">${chg >= 0 ? "+" : ""}${chg}%</b><span>${MONTHS_LONG[prevM[1]]}hoz képest</span></div>` : ""}
    </div>
    <div class="st-cal">${cells}</div>`;
  box.querySelectorAll("[data-j]").forEach((b) => b.addEventListener("click", () => {
    const k = Number(b.dataset.j); let m = M + k, y = Y;
    if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
    _jMonth = [y, m];
    renderJournal(allRoutes, { sport });
  }));
}

// ── Évösszefoglaló ───────────────────────────────────────────────────────────
let _yrYear = null;
const ANALOG = [[240, "Budapest → Bécs"], [530, "Budapest → Zágráb és vissza"], [1010, "Budapest → Berlin"], [1500, "Budapest → Párizs"],
  [2450, "Budapest → Lisszabon"], [4000, "Budapest → Moszkva és vissza"], [6400, "a Föld sugara"], [10000, "Budapest → Peking"], [40075, "a Föld kerülete"]];
function analogy(km) {
  let best = null;
  for (const [d, t] of ANALOG) if (km >= d * 0.9) best = [d, t];
  return best ? `≈ ${best[1]}${km > best[0] * 1.5 ? ` (${num(km / best[0], 1)}×)` : ""}` : "";
}

function yearData(base, Y, today) {
  const rs = base.filter((r) => when(r).getFullYear() === Y);
  const s = sums(rs);
  const months = new Array(12).fill(0); const mCnt = new Array(12).fill(0);
  rs.forEach((r) => { const m = when(r).getMonth(); months[m] += Number(r.distance) || 0; mCnt[m]++; });
  const bestM = months.indexOf(Math.max(...months));
  const longest = rs.reduce((a, r) => (!a || (r.distance || 0) > (a.distance || 0) ? r : a), null);
  const mostUp = rs.reduce((a, r) => (!a || (r.elevation || 0) > (a.elevation || 0) ? r : a), null);
  const wd = new Array(7).fill(0); rs.forEach((r) => wd[(when(r).getDay() + 6) % 7]++);
  const fav = wd.indexOf(Math.max(...wd));
  const places = {}; rs.forEach((r) => { if (r.location_city) places[r.location_city] = (places[r.location_city] || 0) + 1; });
  const topPlace = Object.entries(places).sort((a, b) => b[1] - a[1])[0];
  const days = new Set(rs.map((r) => when(r).toDateString())).size;
  const end = Y === today.getFullYear() ? today : new Date(Y, 11, 31);
  return { rs, s, months, mCnt, bestM, longest, mostUp, fav, favPct: rs.length ? Math.round((wd[fav] / rs.length) * 100) : 0, topPlace, days, end };
}

export function renderYearReview(allRoutes, { userName = "" } = {}) {
  const box = document.getElementById("statsViewYear");
  if (!box) return;
  const today = new Date();
  const base = valid(allRoutes, "all");
  const years = [...new Set(base.map((r) => when(r).getFullYear()))].sort((a, b) => b - a);
  if (!years.length) { box.innerHTML = `<div class="st-empty">Még nincs edzésed ehhez az összefoglalóhoz.</div>`; return; }
  if (!_yrYear || !years.includes(_yrYear)) _yrYear = years[0];
  const Y = _yrYear, d = yearData(base, Y, today);
  const mmax = Math.max(...d.months, 1);
  const who = userName ? `${esc(userName)} ` : "";
  const range = Y === today.getFullYear() ? `jan. 1. – ${today.toLocaleDateString("hu-HU", { month: "short", day: "numeric" })}` : "teljes év";
  box.innerHTML = `
    <div class="st-yr-years">${years.map((y) => `<button type="button" class="stats-chip${y === Y ? " stats-chip--active" : ""}" data-yr="${y}">${y}</button>`).join("")}</div>
    <div class="st-yr">
      <h2>${Y} – ${who ? `${who}éve` : "az éved"}</h2>
      <div class="st-yr-sub">${range} · ${d.s.n} edzés · ${d.days} aktív nap</div>
      <div class="st-yr-big">
        <div><b>${km0(d.s.km)} km</b><span>${analogy(d.s.km)}</span></div>
        <div><b>${km0(d.s.up)} m</b><span>${d.s.up >= 8849 ? `${num(d.s.up / 8849, 1)}× Mount Everest` : `${Math.round(d.s.up / 8849 * 100)}% Mount Everest`}</span></div>
        <div><b>${km0(d.s.min / 60)} ó</b><span>~${num(d.s.min / 60 / 24, 1)} teljes nap a nyeregben</span></div>
      </div>
      <div class="st-yr-bars">${d.months.map((v, i) => `<i style="height:${Math.max(2, (v / mmax) * 100)}%" class="${i === d.bestM ? "is-best" : ""}" title="${MONTHS_LONG[i]}: ${km0(v)} km"></i>`).join("")}</div>
      <div class="st-yr-ml">${MONTHS.map((m) => `<span>${m}</span>`).join("")}</div>
      <div class="st-yr-cards">
        <div><small>Legaktívabb hónap</small><b>${MONTHS_LONG[d.bestM].replace(/^./, (c) => c.toUpperCase())}</b><span>${km0(d.months[d.bestM])} km · ${d.mCnt[d.bestM]} edzés</span></div>
        ${d.longest ? `<button type="button" data-record-route-id="${esc(d.longest.id)}" data-record-route-name="${esc(d.longest.name || "")}"><small>Leghosszabb túra</small><b>${esc(d.longest.name || "Edzés")}</b><span>${num(d.longest.distance || 0, 1)} km · ${when(d.longest).toLocaleDateString("hu-HU", { month: "short", day: "numeric" })}</span></button>` : ""}
        ${d.mostUp && d.mostUp.elevation ? `<button type="button" data-record-route-id="${esc(d.mostUp.id)}" data-record-route-name="${esc(d.mostUp.name || "")}"><small>Legtöbb szint</small><b>${esc(d.mostUp.name || "Edzés")}</b><span>${km0(d.mostUp.elevation)} m</span></button>` : ""}
        <div><small>Kedvenc nap</small><b>${DAYS_LONG[d.fav].replace(/^./, (c) => c.toUpperCase())}</b><span>az edzések ${d.favPct}%-a</span></div>
        ${d.topPlace ? `<div><small>Legtöbbet járt hely</small><b>${esc(d.topPlace[0])}</b><span>${d.topPlace[1]} edzés</span></div>` : ""}
      </div>
      <div class="st-yr-acts"><button type="button" class="st-yr-share" id="statsYearShare"><i data-lucide="share-2" aria-hidden="true"></i>Megosztó kép</button></div>
    </div>`;
  box.querySelectorAll("[data-yr]").forEach((b) => b.addEventListener("click", () => { _yrYear = Number(b.dataset.yr); renderYearReview(allRoutes, { userName }); }));
  box.querySelector("#statsYearShare")?.addEventListener("click", () => shareYearImage(Y, d, userName));
  window.lucide?.createIcons({ nodes: [box] });
}

/** Sztori-méretű (1080×1920) megosztó kép az évről. */
async function shareYearImage(Y, d, userName) {
  const c = document.createElement("canvas"); c.width = 1080; c.height = 1920;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 1080, 1920); g.addColorStop(0, "#1a1d23"); g.addColorStop(1, "#2b2f38");
  x.fillStyle = g; x.fillRect(0, 0, 1080, 1920);
  const F = (w, s) => `${w} ${s}px Inter, system-ui, -apple-system, sans-serif`;
  x.fillStyle = BRAND; x.font = F(800, 46); x.fillText("Bringaterv", 90, 150);
  x.fillStyle = "#fff"; x.font = F(800, 110); x.fillText(String(Y), 90, 320);
  x.fillStyle = "#aab0bb"; x.font = F(500, 40); x.fillText(userName ? `${userName} éve` : "az éved", 90, 385);
  const big = [[`${km0(d.s.km)} km`, analogy(d.s.km)], [`${km0(d.s.up)} m`, d.s.up >= 8849 ? `${num(d.s.up / 8849, 1)}× Mount Everest` : "szintemelkedés"],
    [`${d.s.n} edzés`, `${km0(d.s.min / 60)} óra a nyeregben`]];
  big.forEach(([a, b], i) => {
    const y = 560 + i * 200;
    x.fillStyle = "#fff"; x.font = F(800, 96); x.fillText(a, 90, y);
    x.fillStyle = "#aab0bb"; x.font = F(500, 36); x.fillText(b, 94, y + 56);
  });
  const mmax = Math.max(...d.months, 1), bw = 900 / 12;
  d.months.forEach((v, i) => {
    const h = Math.max(6, (v / mmax) * 260);
    x.fillStyle = i === d.bestM ? BRAND : "rgba(232,70,30,.55)";
    x.fillRect(90 + i * bw + 8, 1430 - h, bw - 16, h);
    x.fillStyle = "#8a909a"; x.font = F(600, 24); x.textAlign = "center"; x.fillText(MONTHS[i], 90 + i * bw + bw / 2, 1470); x.textAlign = "left";
  });
  const lines = [`Legaktívabb hónap: ${MONTHS_LONG[d.bestM]}`, d.longest ? `Leghosszabb túra: ${num(d.longest.distance || 0, 1)} km` : "", `Kedvenc nap: ${DAYS_LONG[d.fav]}`].filter(Boolean);
  x.fillStyle = "#cfd3da"; x.font = F(600, 36);
  lines.forEach((l, i) => x.fillText(l, 90, 1580 + i * 58));
  x.fillStyle = "#8a909a"; x.font = F(500, 28); x.fillText("bringaterv.hu", 90, 1840);
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  const file = new File([blob], `bringaterv-${Y}.png`, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: `Bringaterv ${Y}` }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
