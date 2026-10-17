/**
 * Bringaterv – Személyes rekordok nézet
 * =======================================
 * Három blokk, sportonként (Kerékpár / Futás / Gyalog) és időszakonként szűrve:
 *   1. Kiemelt rekordok – az edzések összesített adataiból (táv, szint, idő, …),
 *      mindegyiknél az előző rekord és a fejlődés mini grafikonja;
 *   2. Legjobb idők távokra – a GPX-ből számolt leggyorsabb 5 / 10 / 20 … km
 *      (akkor is, ha egy hosszabb edzés közepén volt);
 *   3. Csúcsértékek – legmagasabb átlagpulzus / teljesítmény időablakokra.
 * A 2–3. blokk adatai a szerverről jönnek (/api/records, cache-elve).
 */

import { num, int, dur } from "../format.js";
import { sparkStep } from "./sparkline.js";

// ── Beállítások ──────────────────────────────────────────────────────────────
const SPORTS = {
  cycling: { label: "Kerékpár", distances: [5000, 10000, 20000, 30000, 40000, 50000, 80000, 100000, 150000, 200000], pace: false },
  run:     { label: "Futás",    distances: [400, 1000, 5000, 10000, 21097, 42195], pace: true },
  foot:    { label: "Gyalog",   distances: [1000, 5000, 10000, 20000, 21097, 30000, 42195], pace: true },
};
const PERIODS = [
  { key: "all", label: "Összes" },
  { key: "y1",  label: "1 év",    days: 365 },
  { key: "m6",  label: "6 hónap", days: 182 },
  { key: "w12", label: "12 hét",  days: 84 },
  { key: "w4",  label: "4 hét",   days: 28 },
];
const WINDOW_LABELS = { 5: "5 mp", 30: "30 mp", 60: "1 perc", 300: "5 perc", 1200: "20 perc", 3600: "60 perc" };
const DIST_LABELS = { 21097: "Félmaraton", 42195: "Maraton" };

// ── Állapot ──────────────────────────────────────────────────────────────────
let _period = "all";
let _sport = "cycling";
let _records = null;          // { items: Map(id → rec), distances, windows }
let _fetching = null;
let _last = { routes: [], api: null };

// ── Segédek ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function sportOf(r) {
  const t = (r.sport_type || "").toLowerCase();
  if (t.includes("run")) return "run";
  if (t.includes("walk") || t.includes("hik")) return "foot";
  if (!t || t.includes("cycl") || t.includes("ride") || t.includes("bike") || ["gravel", "mtb", "asphalt"].includes(t)) return "cycling";
  return "other";
}
const isWorkout = (r) => r.type === "workout" || !!r.strava_id || !!r.start_time;
const tsOf = (r) => new Date(r.start_time || r.date).getTime();
const fmtDate = (t) => new Date(t).toLocaleDateString("hu-HU", { year: "numeric", month: "short", day: "numeric" });

/** Másodperc → „1:24:31” / „23:29” */
function fmtSec(s) {
  const v = Math.round(s);
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), sec = v % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? h + ":" : ""}${mm}:${String(sec).padStart(2, "0")}`;
}
function fmtDist(m) {
  if (DIST_LABELS[m]) return DIST_LABELS[m];
  return m < 1000 ? `${m} m` : `${num(m / 1000, m % 1000 ? 1 : 0)} km`;
}
/** Átlag a távhoz: km/h, vagy futásnál/gyalog tempó (perc/km) */
function fmtRate(distM, sec, pace) {
  if (pace) {
    const p = sec / (distM / 1000);
    return `${Math.floor(p / 60)}:${String(Math.round(p % 60)).padStart(2, "0")} /km`;
  }
  return `${num((distM / 1000) / (sec / 3600), 1)} km/h`;
}

/**
 * Rekord-fejlődés: időrendben végigmegy, és minden javulást feljegyez.
 * @returns {{route, value, t}[]}  az utolsó elem a jelenlegi rekord
 */
function progression(rows, valueOf, lowerIsBetter = false) {
  const sorted = rows
    .map((r) => ({ route: r, value: valueOf(r), t: tsOf(r) }))
    .filter((x) => Number.isFinite(x.value) && x.value > 0 && Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (const x of sorted) {
    const best = out[out.length - 1];
    if (!best || (lowerIsBetter ? x.value < best.value : x.value > best.value)) out.push(x);
  }
  return out;
}

function routeAttrs(route) {
  return route?.id ? ` data-record-route-id="${esc(route.id)}" data-record-route-name="${esc(route.name || "")}"` : "";
}

// ── Adatbetöltés ─────────────────────────────────────────────────────────────
async function fetchRecords(api) {
  if (_fetching) return _fetching;
  _fetching = (async () => {
    try {
      for (let round = 0; round < 30; round++) {
        const res = await api.getRecords();
        _records = {
          items: new Map((res.items || []).map((x) => [x.id, x])),
          pending: res.pending || 0,
        };
        rerender();
        if (!res.pending) break;
      }
    } catch (err) {
      console.warn("Rekordok betöltése sikertelen:", err);
      _records = _records || { items: new Map(), pending: 0, error: true };
      rerender();
    } finally {
      _fetching = null;
    }
  })();
  return _fetching;
}

function rerender() {
  const el = document.getElementById("statsRecordsFull");
  if (el && !el.closest("[hidden]")) draw(el, _last.routes);
}

// ── Belépési pont ────────────────────────────────────────────────────────────
/**
 * @param {object[]} allRoutes  a statisztikába számító útvonalak/edzések
 * @param {{ api: object, sport?: string }} opts  sport: a bal oldali sportszűrő értéke
 */
export function renderRecordsView(allRoutes, { api, sport } = {}) {
  _last = { routes: allRoutes, api };
  if (sport === "run") _sport = "run";
  else if (sport === "hike") _sport = "foot";
  else if (sport === "cycling") _sport = "cycling";
  const el = document.getElementById("statsRecordsFull");
  if (!el) return;
  if (!el.dataset.bound) {
    el.dataset.bound = "1";
    el.addEventListener("click", (e) => {
      const p = e.target.closest("[data-rec-period]");
      if (p) { _period = p.dataset.recPeriod; draw(el, _last.routes); return; }
      const s = e.target.closest("[data-rec-sport]");
      if (s) { _sport = s.dataset.recSport; draw(el, _last.routes); }
    });
  }
  draw(el, allRoutes);
  if (api) fetchRecords(api);
}

// ── Rajzolás ─────────────────────────────────────────────────────────────────
function draw(el, allRoutes) {
  const workouts = allRoutes.filter((r) => isWorkout(r) && Number.isFinite(tsOf(r)));
  const sportsPresent = Object.keys(SPORTS).filter((k) => workouts.some((r) => sportOf(r) === k));
  if (sportsPresent.length && !sportsPresent.includes(_sport)) _sport = sportsPresent[0];
  const cfg = SPORTS[_sport];

  const per = PERIODS.find((p) => p.key === _period) || PERIODS[0];
  const from = per.days ? Date.now() - per.days * 86400000 : -Infinity;
  const rows = workouts.filter((r) => sportOf(r) === _sport && tsOf(r) >= from);

  const head = `
    <div class="rec-head">
      <div class="rec-tabs" role="tablist">
        ${sportsPresent.map((k) => `<button type="button" role="tab" class="rec-tab${k === _sport ? " is-active" : ""}" data-rec-sport="${k}">${SPORTS[k].label}</button>`).join("")}
      </div>
      <div class="stats-chip-group rec-periods">
        ${PERIODS.map((p) => `<button type="button" class="stats-chip${p.key === per.key ? " stats-chip--active" : ""}" data-rec-period="${p.key}">${p.label}</button>`).join("")}
      </div>
    </div>`;

  if (!workouts.length) {
    el.innerHTML = head + `<div class="rec-empty">Még nincs edzés a könyvtárban – importálj egyet, és itt megjelennek a rekordjaid.</div>`;
    return;
  }
  if (!rows.length) {
    el.innerHTML = head + `<div class="rec-empty">Ebben az időszakban nincs ${cfg.label.toLowerCase()} edzés.</div>`;
    return;
  }

  el.innerHTML = head + highlightSection(rows, cfg) + effortsSection(rows, cfg) + peaksSection(rows);
  window.lucide?.createIcons({ nodes: [el] });
}

/** Kártya egy rekordhoz: érték, név, dátum, előző rekord + mini fejlődésgörbe. */
function recordCard(label, prog, fmt, { lowerIsBetter = false, extra = "" } = {}) {
  const cur = prog[prog.length - 1];
  if (!cur) {
    return `<div class="rec-card is-empty"><div class="rec-card-label">${label}</div><div class="rec-card-val">—</div></div>`;
  }
  const prev = prog[prog.length - 2];
  const prevHtml = prev
    ? `<div class="rec-card-prev">Előző: <strong>${fmt(prev.value)}</strong> · ${fmtDate(prev.t)}</div>`
    : `<div class="rec-card-prev">Első rekord ebben az időszakban</div>`;
  return `
    <div class="rec-card stats-record-clickable"${routeAttrs(cur.route)}>
      <div class="rec-card-top">
        <div class="rec-card-label">${label}</div>
        ${prog.length > 1 ? sparkStep(prog.map((p) => ({ x: p.t, y: p.value })), { lowerIsBetter, width: 60, height: 22 }) : ""}
      </div>
      <div class="rec-card-val">${fmt(cur.value)}</div>
      ${extra}
      <div class="rec-card-name" title="${esc(cur.route.name)}">${esc(cur.route.name || "Névtelen")}</div>
      <div class="rec-card-date">${fmtDate(cur.t)}</div>
      ${prevHtml}
    </div>`;
}

function highlightSection(rows, cfg) {
  const recs = _records?.items;
  const avgSpeed = (r) => {
    if (!(r.distance > 0) || !(r.duration >= 20)) return NaN;        // ≥ 20 perc
    const v = r.distance / (r.duration / 60);
    return v <= (cfg.pace ? 25 : 70) ? v : NaN;
  };
  const cards = [
    recordCard("Leghosszabb táv", progression(rows, (r) => r.distance), (v) => `${num(v, 1)} km`),
    recordCard("Legtöbb szintemelkedés", progression(rows, (r) => r.elevation), (v) => `${int(v)} m`),
    recordCard("Leghosszabb edzés", progression(rows, (r) => r.duration), (v) => dur(v)),
    cfg.pace
      ? recordCard("Legjobb átlagtempó", progression(rows, (r) => { const s = avgSpeed(r); return s ? 60 / s : NaN; }, true),
          (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")} /km`, { lowerIsBetter: true })
      : recordCard("Legjobb átlagsebesség", progression(rows, avgSpeed), (v) => `${num(v, 1)} km/h`),
    recordCard("Legnagyobb sebesség", progression(rows, (r) => (r.max_speed_kmh > 0 && r.max_speed_kmh < 110 ? r.max_speed_kmh : NaN)), (v) => `${num(v, 1)} km/h`),
    recs ? recordCard("Leghosszabb mászás", progression(rows, (r) => recs.get(r.id)?.climb?.gain_m), (v) => `${int(v)} m`) : "",
    recordCard("Legtöbb kalória", progression(rows, (r) => r.calories), (v) => `${int(v)} kcal`),
  ].filter(Boolean);
  return `
    <section class="rec-section">
      <h3 class="rec-section-title">Kiemelt rekordok</h3>
      <div class="rec-cards">${cards.join("")}</div>
    </section>`;
}

function pendingNote() {
  if (!_records) return `<div class="rec-note">Rekordok számítása…</div>`;
  if (_records.error) return `<div class="rec-note rec-note--err">A részletes rekordokat most nem sikerült betölteni.</div>`;
  if (_records.pending) return `<div class="rec-note">Számítás folyamatban – még ${_records.pending} edzés van hátra…</div>`;
  return "";
}

function effortsSection(rows, cfg) {
  const recs = _records?.items;
  // Az el nem ért távokból csak az elsőt mutatjuk („következő cél”)
  let dists = cfg.distances;
  if (recs) {
    const reached = (d) => rows.some((r) => recs.get(r.id)?.efforts?.[String(d)]);
    const last = dists.reduce((acc, d, i) => (reached(d) ? i : acc), -1);
    dists = dists.slice(0, Math.max(last + 2, 1));
  }
  const body = dists.map((d) => {
    const prog = recs ? progression(rows, (r) => recs.get(r.id)?.efforts?.[String(d)], true) : [];
    const cur = prog[prog.length - 1];
    if (!cur) {
      return `<tr class="rec-row is-empty"><th scope="row">${fmtDist(d)}</th><td class="rec-time">—</td><td></td><td></td><td class="rec-hide-sm"></td><td class="rec-hide-sm"></td></tr>`;
    }
    const prev = prog[prog.length - 2];
    const delta = prev ? `<span class="rec-delta">−${fmtSec(prev.value - cur.value)}</span>` : "";
    return `
      <tr class="rec-row stats-record-clickable"${routeAttrs(cur.route)}>
        <th scope="row">${fmtDist(d)}</th>
        <td class="rec-time">${fmtSec(cur.value)}</td>
        <td class="rec-rate">${fmtRate(d, cur.value, cfg.pace)}</td>
        <td class="rec-act"><span class="rec-act-name">${esc(cur.route.name || "Névtelen")}</span><span class="rec-act-date">${fmtDate(cur.t)}</span></td>
        <td class="rec-prev rec-hide-sm">${prev ? `${fmtSec(prev.value)} ${delta}<span class="rec-act-date">${fmtDate(prev.t)}</span>` : `<span class="rec-muted">—</span>`}</td>
        <td class="rec-spark rec-hide-sm">${prog.length > 1 ? sparkStep(prog.map((p) => ({ x: p.t, y: p.value })), { lowerIsBetter: true, width: 110 }) : ""}</td>
      </tr>`;
  }).join("");
  return `
    <section class="rec-section">
      <h3 class="rec-section-title">Legjobb idők távokra
        <button class="hint-btn" type="button" data-hint-title="Legjobb idők távokra" data-hint="Minden edzés GPS-adatából kiszámoljuk, mennyi idő alatt tetted meg leggyorsabban az adott távot – akkor is, ha az egy hosszabb kör közepén volt. Az idő a teljes eltelt idő (a megállásokkal együtt). Az „Előző” oszlop a megdöntött rekordot, a görbe a rekord javulását mutatja." aria-label="Segítség"><i data-lucide="info" aria-hidden="true"></i></button>
      </h3>
      ${pendingNote()}
      <div class="rec-table-wrap">
        <table class="rec-table">
          <thead><tr><th>Táv</th><th>Idő</th><th>${cfg.pace ? "Tempó" : "Átlag"}</th><th>Edzés</th><th class="rec-hide-sm">Előző rekord</th><th class="rec-hide-sm">Fejlődés</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>`;
}

function peaksSection(rows) {
  const recs = _records?.items;
  if (!recs) return "";
  const windows = [5, 30, 60, 300, 1200, 3600];
  const metric = (key, unit, title) => {
    const cells = windows.map((w) => {
      const prog = progression(rows, (r) => recs.get(r.id)?.peaks?.[key]?.[String(w)]);
      const cur = prog[prog.length - 1];
      if (!cur) return `<div class="rec-peak is-empty"><div class="rec-peak-win">${WINDOW_LABELS[w]}</div><div class="rec-peak-val">—</div></div>`;
      return `
        <div class="rec-peak stats-record-clickable"${routeAttrs(cur.route)} title="${esc(cur.route.name || "")}">
          <div class="rec-peak-win">${WINDOW_LABELS[w]}</div>
          <div class="rec-peak-val">${int(cur.value)}<small>${unit}</small></div>
          <div class="rec-peak-date">${fmtDate(cur.t)}</div>
        </div>`;
    });
    if (cells.every((c) => c.includes("is-empty"))) return "";
    return `<div class="rec-peak-group"><div class="rec-peak-title">${title}</div><div class="rec-peaks">${cells.join("")}</div></div>`;
  };
  const html = metric("hr", " bpm", "Legmagasabb átlagpulzus") + metric("power", " W", "Legnagyobb átlagteljesítmény");
  if (!html) return "";
  return `
    <section class="rec-section">
      <h3 class="rec-section-title">Csúcsértékek
        <button class="hint-btn" type="button" data-hint-title="Csúcsértékek" data-hint="A legmagasabb átlagos pulzus és teljesítmény, amit adott ideig (5 mp – 60 perc) folyamatosan tartani tudtál. Az adatszünetet tartalmazó szakaszokat kihagyjuk. A teljesítmény csak wattmérős (vagy Strava által becsült wattos) edzéseknél jelenik meg." aria-label="Segítség"><i data-lucide="info" aria-hidden="true"></i></button>
      </h3>
      ${html}
    </section>`;
}
