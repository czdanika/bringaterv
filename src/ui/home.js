/**
 * Bringaterv – Kezdőlap fül
 * =========================
 * Indításkor ez nyílik, a térkép helyén, teljes szélességben (mobilon teljes
 * képernyőn): köszönés, gyors indítás, és szellős kártyák az edzésadatokból –
 * összesítő (hét / hónap / év), forma, sorozatok, Eddington-szám, következő
 * célok, aktivitás-naptár és a legutóbbi elemek. A Tervezés fülön, amíg nincs
 * pont, a térkép közepén halvány felirat jelzi, hogy kattintással lehet kezdeni.
 *
 *   initHome({ api, getUser, actions })
 *   updateHome({ tab, hasRoute })   – fülváltáskor / a store változásakor
 */

import { num } from "../format.js";
import { calcEddington, calcTrainingLoad } from "./statsPanel.js";

let _api, _getUser, _actions;
let _main = null, _hint = null;
let _items = null, _loading = null;
let _state = { tab: "plan", hasRoute: false };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const isWorkout = (r) => r.type === "workout" || !!r.strava_id || !!r.start_time;
const when = (r) => r.start_time || r.date || "";
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function firstName() {
  const u = _getUser?.() || {};
  if (u.first_name) return String(u.first_name).trim();
  const name = String(u.name || "").trim();
  return name ? name.split(/\s+/).pop() : "";
}

export function initHome({ api, getUser, actions }) {
  _api = api; _getUser = getUser; _actions = actions;
  _main = document.querySelector("#homeMain");

  const map = document.querySelector("#map");
  if (map) {
    _hint = document.createElement("div");
    _hint.className = "map-start-hint";
    _hint.hidden = true;
    _hint.innerHTML = `<span class="map-start-hint-dot"></span><span class="map-start-hint-text"></span>`;
    map.parentElement.appendChild(_hint);
  }

  window.addEventListener("bringaterv:settingsHydrated", () => { if (_state.tab === "home") render(); });

  _main?.addEventListener("click", (e) => {
    const el = e.target.closest("[data-home]");
    if (!el) return;
    const act = el.dataset.home;
    if (act === "open") _actions.openItem?.(el.dataset.id, el.dataset.name || "", el.dataset.target);
    else if (act === "statsView") _actions.statsView?.(el.dataset.view);
    else if (act === "editGoals") openGoalsModal();
    else _actions[act]?.();
  });
}

export function updateHome(next = {}) {
  const prevTab = _state.tab;
  Object.assign(_state, next);
  if (_hint) {
    _hint.hidden = !(_state.tab === "plan" && !_state.hasRoute);
    _hint.querySelector(".map-start-hint-text").textContent = matchMedia("(pointer: coarse)").matches
      ? "Koppints a térképre a rajtponthoz" : "Kattints a térképre a rajtponthoz";
  }
  if (_main && _state.tab === "home" && prevTab !== "home") {
    render();
    loadItems();   // gyors lista-hívás – mindig friss, ha visszajössz (pl. mentés után)
  }
}

function render() {
  if (!_main) return;
  _main.innerHTML = template();
  window.lucide?.createIcons();
}

// A kártyák ⓘ súgói (a közös .hint-btn kezelő jeleníti meg – main.js)
const HINTS = {
  form: "Az elmúlt hetek edzésterheléséből számolt állapotod. A fittség a hosszú távú (6 hetes) edzettséged, a fáradtság az utolsó hét terhelése, a forma a kettő különbsége. Pozitív forma: kipihent vagy, jó nap egy nagyobb túrára; erősen negatív: érdemes pihenni. A terhelést az edzések időtartamából számoljuk.",
  streak: "Hány egymást követő napon, héten, illetve hónapban volt legalább egy edzésed. A mai nap, a mostani hét és hónap még nem töri meg a sorozatot, ha még nem tekertél.",
  eddington: "A legnagyobb E szám, amelyre igaz, hogy legalább E napon tekertél legalább E km-t. Pl. a 40-es Eddington azt jelenti, hogy 40 napon mentél legalább 40 km-t. Minél nagyobb, annál nehezebb növelni; a kártya azt is mutatja, hány nap kell még a következőhöz.",
  goals: "Hol tartasz a céljaidhoz képest: a csík 0-tól a célig mér, mellette a mostani és a cél érték. A célokat a „Beállítás” gombbal adhatod meg (heti táv, éves táv, éves szint); ami nincs megadva, ahhoz automatikus cél jár – a következő kerek szám. Saját éves célnál a csíkon egy kis jel mutatja az időarányos állást.",
  calendar: "Minden négyzet egy nap, oszloponként egy hét (hétfőtől vasárnapig). Minél sötétebb a szín, annál többet tekertél aznap. Rámutatva látod a dátumot és a km-t.",
};
const FEW_WORKOUTS = 5;   // ennél kevesebb edzésnél a forma / Eddington még nem mond sokat

async function loadItems() {
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const list = await _api.listRoutes();
      _items = Array.isArray(list) ? list : [];
    } catch {
      if (!_items) _items = [];
    } finally {
      _loading = null;
    }
    if (_state.tab === "home") render();
  })();
  return _loading;
}

// ── Váz ──────────────────────────────────────────────────────────────────────

function template() {
  const name = firstName();
  const workouts = (_items || []).filter((r) => isWorkout(r) && r.include_in_stats !== false);
  const hasData = workouts.length > 0;
  return `
    <div class="home-wrap">
      <header class="home-head">
        <h1>${name ? `Szia, ${esc(name)}!` : "Szia!"}</h1>
        <p>Mit csinálnál ma?</p>
      </header>

      <div class="home-tiles">
        ${tile("plan", "Útvonal tervezése", "Kattints a térképre, vagy keress egy helyet", true)}
        ${tile("loadFile", "Edzés elemzése", "GPX vagy FIT fájl betöltése")}
        ${tile("community", "Közösségi utak", "Kipróbált túrák mások ajánlásával")}
        ${tile("stats", "Statisztikáim", "Havi számok, rekordok, hőtérkép")}
      </div>

      ${!_items ? `<div class="home-note">Betöltés…</div>` : !hasData ? `
        <div class="home-note">Még nincs edzésed. Tölts be egyet az <b>Edzés elemzése</b> gombbal, vagy kösd be a Stravát
        a Beállításokban – utána itt látod az összesítőidet, a formádat és a céljaidat.</div>` : `
        <div class="home-grid">
          ${summaryCard(workouts)}
          ${formCard(workouts.length < FEW_WORKOUTS)}
          ${streakCard(workouts)}
          ${eddingtonCard(workouts.length < FEW_WORKOUTS)}
          ${goalsCard(workouts)}
          ${calendarCard(workouts)}
        </div>`}

      ${recentCard()}
      <div class="home-foot">Új vagy itt? <a href="./help.html" target="_blank" rel="noopener">Súgó és kézikönyv →</a></div>
    </div>`;
}

function tile(act, title, text, primary = false) {
  return `<button type="button" class="home-tile${primary ? " home-tile--primary" : ""}" data-home="${act}">
      <b>${title}</b><span>${text}</span>
    </button>`;
}

function card(title, body, { wide = false, full = false, link = null, hint = null } = {}) {
  const help = hint ? `<button class="hint-btn" type="button" data-hint-title="${esc(title)}" data-hint="${esc(HINTS[hint])}"
      aria-label="Segítség"><i data-lucide="info" aria-hidden="true"></i></button>` : "";
  return `<section class="home-c${wide ? " home-c--wide" : ""}${full ? " home-c--full" : ""}">
      <div class="home-c-head"><h2>${title}${help}</h2>${link ? `<button type="button" data-home="statsView" data-view="${link}">Részletek →</button>` : ""}</div>
      ${body}
    </section>`;
}

// ── Kártyák ──────────────────────────────────────────────────────────────────

function sumRange(workouts, from, to) {
  const ws = workouts.filter((r) => { const t = new Date(when(r)); return t >= from && t < to; });
  return {
    n: ws.length,
    km: ws.reduce((a, r) => a + (Number(r.distance) || 0), 0),
    up: ws.reduce((a, r) => a + (Number(r.elevation) || 0), 0),
    min: ws.reduce((a, r) => a + (Number(r.duration) || 0), 0),
  };
}

function summaryCard(workouts) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(today); week.setDate(today.getDate() - ((today.getDay() + 6) % 7));   // hétfő
  const end = new Date(today); end.setDate(today.getDate() + 1);
  const cols = [
    ["E héten", sumRange(workouts, week, end)],
    [now.toLocaleDateString("hu-HU", { month: "long" }).replace(/^./, (c) => c.toUpperCase()), sumRange(workouts, new Date(now.getFullYear(), now.getMonth(), 1), end)],
    [`${now.getFullYear()}`, sumRange(workouts, new Date(now.getFullYear(), 0, 1), end)],
  ];
  const hours = (m) => (m >= 600 ? `${Math.round(m / 60)} óra` : m >= 60 ? `${Math.floor(m / 60)} ó ${Math.round(m % 60)} p` : `${Math.round(m)} p`);
  return card("Összesítő", `<div class="home-sum">${cols.map(([label, s]) => `
      <div class="home-sum-col">
        <div class="home-lbl">${esc(label)}</div>
        <div class="home-big">${num(s.km, 0)}<small>km</small></div>
        <div class="home-sub home-sum-sub"><span>${s.n} edzés</span><span>${num(s.up, 0)} m szint</span>${s.min ? `<span>${hours(s.min)}</span>` : ""}</div>
      </div>`).join("")}</div>`, { wide: true });
}

function formCard(early) {
  const routes = (_items || []).filter((r) => r.include_in_stats !== false);   // mint a Statok fülön
  const series = calcTrainingLoad(routes.map((r) => ({ ...r, date: r.date || r.start_time })));
  if (!series.length) return "";
  const last = series[series.length - 1];
  const f = last.tsb > 10 ? ["Friss", "fresh", "Kipihent, csúcsra kész."]
    : last.tsb > -10 ? ["Edzés zóna", "training", "Optimális fejlődési állapot."]
    : last.tsb > -30 ? ["Fáradt", "tired", "Érdemes lassítani egy kicsit."]
    : ["Túlterhelt", "overload", "Pihenő szükséges."];
  const sign = (v) => (v > 0 ? "+" : "") + Math.round(v);
  return card("Forma", `
      <div class="home-form"><span class="home-badge home-badge--${f[1]}">${f[0]}</span><span class="home-sub">${f[2]}</span></div>
      <div class="home-trio">
        <div><div class="home-mid">${Math.round(last.ctl)}</div><div class="home-lbl">Fittség</div></div>
        <div><div class="home-mid">${Math.round(last.atl)}</div><div class="home-lbl">Fáradtság</div></div>
        <div><div class="home-mid">${sign(last.tsb)}</div><div class="home-lbl">Forma</div></div>
      </div>${early ? `<div class="home-sub home-early">Néhány edzés után lesz pontos.</div>` : ""}`, { link: "training", hint: "form" });
}

/** Egymást követő napok / hetek / hónapok edzéssel (a mostanival vagy az előzővel végződve). */
function streaks(workouts) {
  const days = new Set(workouts.map((r) => when(r).slice(0, 10)).filter(Boolean));
  const run = (start, step, has) => {
    const d = new Date(start);
    if (!has(d)) step(d, -1);       // a mai / e heti / e havi még jöhet – az előzőtől számolunk
    let n = 0;
    while (has(d) && n < 1000) { n++; step(d, -1); }
    return n;
  };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const nDays = run(today, (d, k) => d.setDate(d.getDate() + k), (d) => days.has(dayKey(d)));

  const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const weekHas = (d) => {
    for (let i = 0; i < 7; i++) { const x = new Date(d); x.setDate(d.getDate() + i); if (days.has(dayKey(x))) return true; }
    return false;
  };
  const nWeeks = run(monday, (d, k) => d.setDate(d.getDate() + 7 * k), weekHas);

  const months = new Set([...days].map((k) => k.slice(0, 7)));
  const m0 = new Date(today.getFullYear(), today.getMonth(), 1);
  const nMonths = run(m0, (d, k) => d.setMonth(d.getMonth() + k), (d) => months.has(dayKey(d).slice(0, 7)));
  return { nDays, nWeeks, nMonths };
}

function streakCard(workouts) {
  const s = streaks(workouts);
  const latest = [...workouts].sort((a, b) => (when(a) < when(b) ? 1 : -1))[0];
  const last = latest ? new Date(when(latest)).toLocaleDateString("hu-HU", { month: "long", day: "numeric" }) : "";
  return card("Sorozatok", `
      <div class="home-trio">
        <div><div class="home-mid">${s.nDays}</div><div class="home-lbl">nap</div></div>
        <div><div class="home-mid">${s.nWeeks}</div><div class="home-lbl">hét</div></div>
        <div><div class="home-mid">${s.nMonths}</div><div class="home-lbl">hónap</div></div>
      </div>
      <div class="home-sub home-sub--c">egymás után edzéssel${last ? ` · utolsó: ${last}` : ""}</div>`, { hint: "streak" });
}

function eddingtonCard(early) {
  const routes = (_items || []).filter((r) => r.include_in_stats !== false)
    .map((r) => ({ ...r, date: r.date || r.start_time }));
  const e = calcEddington(routes);
  if (!e.totalDays) return "";
  return card("Eddington-szám", `
      <div class="home-edd"><div class="home-big">${e.E}</div>
        <div class="home-sub">${e.E} napon tekertél legalább ${e.E} km-t.<br>
        A <b>${e.next}</b>-hez még <b>${e.daysNeeded}</b> nap kell legalább ${e.next} km-rel.</div></div>
      ${early ? `<div class="home-sub home-early">Néhány edzés után lesz beszédesebb.</div>` : ""}`, { link: "eddington", hint: "eddington" });
}

// ── Célok ────────────────────────────────────────────────────────────────────
// Saját célok: localStorage „bringaterv.goals” = { weekKm, yearKm, yearUp } (a szerverrel
// szinkronizálva, mint a többi beállítás). Ami nincs megadva, ahhoz automatikus cél jár:
// a következő kerek szám.
const GOALS_KEY = "bringaterv.goals";

function getGoals() {
  try { return JSON.parse(localStorage.getItem(GOALS_KEY) || "{}") || {}; } catch { return {}; }
}

function saveGoals(g) {
  const clean = Object.fromEntries(Object.entries(g).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Math.round(Number(v))]));
  try { localStorage.setItem(GOALS_KEY, JSON.stringify(clean)); } catch {}
  window.dispatchEvent(new CustomEvent("bringaterv:settingChanged"));
}

function goalsCard(workouts) {
  const g = getGoals();
  const now = new Date();
  const year = String(now.getFullYear());
  const yws = workouts.filter((r) => when(r).startsWith(year));
  const ykm = yws.reduce((a, r) => a + (Number(r.distance) || 0), 0);
  const yup = yws.reduce((a, r) => a + (Number(r.elevation) || 0), 0);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const end = new Date(today); end.setDate(today.getDate() + 1);
  const wkm = sumRange(workouts, monday, end).km;
  const auto = (v, step) => (Math.floor(v / step) + 1) * step;
  // az év eltelt része (időarányos haladáshoz)
  const yStart = new Date(now.getFullYear(), 0, 1), yEnd = new Date(now.getFullYear() + 1, 0, 1);
  const yearFrac = (now - yStart) / (yEnd - yStart);

  const row = (label, v, target, unit, own, pace) => {
    const pct = target > 0 ? Math.min(100, (v / target) * 100) : 0;
    const done = v >= target;
    let paceTxt = "";
    if (pace && !done) {
      const diff = v - target * yearFrac;
      paceTxt = ` · időarányosan ${diff >= 0 ? "+" : "−"}${num(Math.abs(diff), 0)} ${unit}`;
    }
    return `<div class="home-goal${done ? " home-goal--done" : ""}">
        <div class="home-goal-top">
          <span>${label}</span>
          <span><b>${num(v, 0)}</b> / ${num(target, 0)} ${unit} · ${done ? "✓ megvan" : `${Math.floor(pct)}%`}</span>
        </div>
        <div class="home-bar"><i style="width:${Math.max(pct, 1.5).toFixed(1)}%"></i>${pace ? `<em style="left:${(yearFrac * 100).toFixed(1)}%" title="Időarányos állás"></em>` : ""}</div>
        <div class="home-sub">${own ? "saját cél" : "automatikus cél – a következő kerek szám"}${done ? "" : ` · még ${num(target - v, 0)} ${unit}`}${paceTxt}</div>
      </div>`;
  };

  const rows = [];
  if (g.weekKm) rows.push(row("E heti táv", wkm, g.weekKm, "km", true, false));
  rows.push(row(`${year} – táv`, ykm, g.yearKm || auto(ykm, ykm < 1000 ? 250 : 500), "km", !!g.yearKm, !!g.yearKm));
  rows.push(row(`${year} – szint`, yup, g.yearUp || auto(yup, yup < 20000 ? 2500 : 10000), "m", !!g.yearUp, !!g.yearUp));
  return `<section class="home-c">
      <div class="home-c-head"><h2>Céljaim<button class="hint-btn" type="button" data-hint-title="Céljaim" data-hint="${esc(HINTS.goals)}"
        aria-label="Segítség"><i data-lucide="info" aria-hidden="true"></i></button></h2>
        <button type="button" data-home="editGoals">Beállítás</button></div>
      ${rows.join("")}
    </section>`;
}

function openGoalsModal() {
  document.getElementById("homeGoalsOverlay")?.remove();
  const g = getGoals();
  const ov = document.createElement("div");
  ov.id = "homeGoalsOverlay";
  ov.className = "install-guide-overlay";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  const field = (key, label, unit, ph) => `
    <label class="fb-label" for="goal_${key}">${label}</label>
    <div class="home-goal-input"><input id="goal_${key}" name="${key}" class="fb-input" type="number" min="0" step="1" inputmode="numeric"
      value="${g[key] || ""}" placeholder="${ph}"><span>${unit}</span></div>`;
  ov.innerHTML = `
    <form class="install-guide fb-card" novalidate>
      <div class="install-guide-head" style="padding:18px 18px 0">
        <div><h3>Céljaim</h3><p>Üresen hagyva automatikus cél: mindig a következő kerek szám.</p></div>
        <button type="button" class="install-guide-close" data-close aria-label="Bezárás">×</button>
      </div>
      <div class="fb-body">
        ${field("weekKm", "Heti táv", "km", "pl. 100")}
        ${field("yearKm", "Éves táv", "km", "pl. 5000")}
        ${field("yearUp", "Éves szint", "m", "pl. 50000")}
        <p class="sr-note">Az éves céloknál egy kis jel a csíkon mutatja az időarányos állást, alatta pedig, hogy mennyivel jársz előtte vagy mögötte.</p>
      </div>
      <div class="fb-actions">
        <button type="button" class="fb-btn" data-close>Mégse</button>
        <button type="submit" class="fb-btn fb-btn--primary">Mentés</button>
      </div>
    </form>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest("[data-close]")) close(); });
  ov.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target.elements;
    saveGoals({ weekKm: f.weekKm.value, yearKm: f.yearKm.value, yearUp: f.yearUp.value });
    close();
    render();
  });
  ov.querySelector("input")?.focus();
}

function calendarCard(workouts) {
  // Gépen egy teljes év (mint a GitHub / Dreeve naptára), mobilon az utolsó ~4 hónap
  const WEEKS = matchMedia("(max-width: 760px)").matches ? 18 : 53;
  const byDay = {};
  workouts.forEach((r) => { const k = when(r).slice(0, 10); if (k) byDay[k] = (byDay[k] || 0) + (Number(r.distance) || 0); });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(today.getDate() - ((today.getDay() + 6) % 7) - (WEEKS - 1) * 7);
  const lvl = (km) => (km <= 0 ? 0 : km < 20 ? 1 : km < 50 ? 2 : km < 100 ? 3 : 4);
  let cells = "", active = 0, lastMonth = -1;
  const labels = [];                // hónapfeliratok: [oszlop, név]
  for (let w = 0; w < WEEKS; w++) {
    const wk = new Date(start); wk.setDate(start.getDate() + w * 7);
    if (wk.getMonth() !== lastMonth) {
      lastMonth = wk.getMonth();
      labels.push([w, wk.toLocaleDateString("hu-HU", { month: "short" }).replace(".", "")]);
    }
    for (let d = 0; d < 7; d++) {
      const x = new Date(start); x.setDate(start.getDate() + w * 7 + d);
      const km = byDay[dayKey(x)] || 0;
      if (km > 0) active++;
      cells += `<i class="home-cal-${x > today ? "x" : lvl(km)}" style="grid-column:${w + 1};grid-row:${d + 1}"
        title="${x.toLocaleDateString("hu-HU", { month: "short", day: "numeric" })}${km ? ` · ${num(km, 1)} km` : ""}"></i>`;
    }
  }
  // ha két felirat túl közel esne (pl. a naptár eleje egy hónap végére esik), a korábbi kimarad
  const months = labels.filter(([w], i) => w < WEEKS - 2 && (!labels[i + 1] || labels[i + 1][0] - w >= 3))
    .map(([w, name]) => `<span style="grid-column:${w + 1} / span 3">${name}</span>`).join("");
  return card(WEEKS > 40 ? "Aktivitás – az elmúlt év" : `Aktivitás – utolsó ${WEEKS} hét`, `
      <div class="home-cal-months" style="grid-template-columns:repeat(${WEEKS}, minmax(0, 1fr))">${months}</div>
      <div class="home-cal" style="grid-template-columns:repeat(${WEEKS}, minmax(0, 1fr))">${cells}</div>
      <div class="home-cal-legend"><span class="home-sub">${active} aktív nap</span>
        <span class="home-cal-scale">kevesebb <i class="home-cal-0"></i><i class="home-cal-1"></i><i class="home-cal-2"></i><i class="home-cal-3"></i><i class="home-cal-4"></i> több</span></div>`,
    { full: true, hint: "calendar" });
}

function recentCard() {
  if (!_items?.length) return "";
  const recent = [..._items].sort((a, b) => (when(a) < when(b) ? 1 : -1)).slice(0, 6);
  const fmtDate = (r) => {
    const t = new Date(when(r));
    return isNaN(t) ? "" : t.toLocaleDateString("hu-HU", { month: "short", day: "numeric" });
  };
  return `<section class="home-c home-c--recent">
      <div class="home-c-head"><h2>Legutóbbiak</h2><button type="button" data-home="library">Könyvtár →</button></div>
      <div class="home-recent">${recent.map((r) => {
        const w = isWorkout(r);
        const meta = [fmtDate(r), r.distance ? `${num(r.distance, 1)} km` : "", r.elevation ? `${num(r.elevation, 0)} m` : "",
                      w ? "edzés" : "útvonal"].filter(Boolean).join(" · ");
        return `<button type="button" class="home-row" data-home="open" data-id="${esc(r.id)}" data-name="${esc(r.name || "")}"
            data-target="${w ? "file" : "plan"}">
            <span class="home-row-dot home-row-dot--${w ? "workout" : "route"}"></span>
            <span class="home-row-t"><b>${esc(r.name || "Névtelen")}</b><span>${esc(meta)}</span></span>
            <span class="home-row-go">${w ? "Elemzés" : "Tervezés"}</span>
          </button>`;
      }).join("")}</div>
    </section>`;
}
