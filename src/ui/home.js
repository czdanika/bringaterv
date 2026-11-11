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

import { isWorkout, countsInStats } from "../workoutKind.js";
import { dueTasks } from "../equipment.js";
import { num } from "../format.js";
import { calcEddington, calcTrainingLoad } from "./statsPanel.js";
import { renderRouteMapPreview, loadCardPreview, renderIndoorPreview } from "./library.js";

let _api, _getUser, _actions;
let _main = null, _hint = null;
let _items = null, _loading = null, _samples = null;
const _gpxCache = new Map();   // id → { points } (előnézet + időjárás helye)
let _state = { tab: "plan", hasRoute: false };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// edzés / terv és „statisztikába számít” – a közös szabály (workoutKind.js)
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
  window.addEventListener("bringaterv:gearChanged", () => { if (_state.tab === "home") render(); });

  _main?.addEventListener("click", (e) => {
    const el = e.target.closest("[data-home]");
    if (!el) return;
    const act = el.dataset.home;
    if (act === "open") _actions.openItem?.(el.dataset.id, el.dataset.name || "", el.dataset.target);
    else if (act === "statsView") _actions.statsView?.(el.dataset.view);
    else if (act === "editGoals") openGoalsModal();
    else if (act === "openGear") _actions.openGear?.();
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
  hydrate();
}

// A kirajzolás után: térképes előnézetek és az időjárás (hálózati adatok)
async function hydrate() {
  const byId = (id) => (_items || []).find((r) => r.id === id);
  _main.querySelectorAll("[data-pv]").forEach((slot) => loadCardPreview(slot.dataset.pv, false, slot, byId(slot.dataset.pv)));
  const last = lastWorkout();
  const slot = _main.querySelector("#homeLastPv");
  if (!last || !slot) return;
  if (last.indoor) renderIndoorPreview(slot);
  // az időjárás helye: a legutóbbi KINTI edzés rajtja (beltérinek nincs helye)
  const outdoor = last.indoor ? (_items || []).filter((r) => isWorkout(r) && !r.indoor).sort((a, b) => (when(a) < when(b) ? 1 : -1))[0] : last;
  if (!outdoor) return;
  const pts = await workoutPoints(outdoor.id);
  if (!pts) { if (!last.indoor) slot.classList.add("is-empty"); return; }
  if (!last.indoor && slot.isConnected) renderRouteMapPreview(slot, pts);
  loadWeather(pts[0]);
}

async function workoutPoints(id) {
  if (_gpxCache.has(id)) return _gpxCache.get(id);
  try {
    const gpx = await _api.loadRoute(id);
    const xml = new DOMParser().parseFromString(gpx, "application/xml");
    const all = [...xml.getElementsByTagNameNS("*", "trkpt"), ...xml.getElementsByTagNameNS("*", "rtept")]
      .map((n) => ({ lat: parseFloat(n.getAttribute("lat")), lng: parseFloat(n.getAttribute("lon")) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (all.length < 2) return null;
    const step = Math.max(1, Math.floor(all.length / 200));
    const pts = all.filter((_, i) => i % step === 0 || i === all.length - 1);
    _gpxCache.set(id, pts);
    return pts;
  } catch { return null; }
}

// A kártyák ⓘ súgói (a közös .hint-btn kezelő jeleníti meg – main.js)
const HINTS = {
  form: "Az elmúlt hetek edzésterheléséből számolt állapotod, mellette az Eddington-szám és hány hete edzel megszakítás nélkül. A fittség a hosszú távú (6 hetes) edzettséged, a fáradtság az utolsó hét terhelése, a forma a kettő különbsége. Pozitív forma: kipihent vagy, jó nap egy nagyobb túrára; erősen negatív: érdemes pihenni. A terhelést az edzések időtartamából számoljuk.",
  streak: "Hány egymást követő napon, héten, illetve hónapban volt legalább egy edzésed. A mai nap, a mostani hét és hónap még nem töri meg a sorozatot, ha még nem tekertél.",
  eddington: "A legnagyobb E szám, amelyre igaz, hogy legalább E napon tekertél legalább E km-t. Pl. a 40-es Eddington azt jelenti, hogy 40 napon mentél legalább 40 km-t. Minél nagyobb, annál nehezebb növelni; a kártya azt is mutatja, hány nap kell még a következőhöz.",
  goals: "Felül a heti, havi és éves összesítő. Alatta: hol tartasz a céljaidhoz képest: a csík 0-tól a célig mér, mellette a mostani és a cél érték. A célokat a „Beállítás” gombbal adhatod meg (heti táv, éves táv, éves szint); ami nincs megadva, ahhoz automatikus cél jár – a következő kerek szám. Saját éves célnál a csíkon egy kis jel mutatja az időarányos állást.",
  calendar: "Minden négyzet egy nap, oszloponként egy hét (hétfőtől vasárnapig). Minél sötétebb a szín, annál többet tekertél aznap. Rámutatva látod a dátumot és a km-t.",
};
const FEW_WORKOUTS = 5;   // ennél kevesebb edzésnél a forma / Eddington még nem mond sokat

async function loadItems() {
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const [list, samples] = await Promise.all([_api.listRoutes(), _api.listSamples?.().catch(() => null)]);
      _items = Array.isArray(list) ? list : [];
      if (Array.isArray(samples)) _samples = samples;
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

function lastWorkout() {
  return (_items || []).filter(isWorkout).sort((a, b) => (when(a) < when(b) ? 1 : -1))[0] || null;
}

function template() {
  const name = firstName();
  const workouts = (_items || []).filter(countsInStats);
  const hasData = workouts.length > 0;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(today); week.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const end = new Date(today); end.setDate(today.getDate() + 1);
  const wkKm = hasData ? sumRange(workouts, week, end).km : 0;
  const dateTxt = now.toLocaleDateString("hu-HU", { weekday: "long", month: "long", day: "numeric" }).replace(/^./, (c) => c.toUpperCase());
  const libCount = (_items || []).length;
  return `
    <div class="home-wrap">
      <header class="home-head">
        <h1>${name ? `Szia, ${esc(name)}!` : "Szia!"}</h1>
        <p>${esc(dateTxt)}${wkKm ? ` · ezen a héten ${num(wkKm, 0)} km` : ""}</p>
      </header>
      ${dueTasks().slice(0, 3).map((t) => `
      <div class="home-bike-due${t.status === "due" ? " is-due" : ""}" role="status">
        <span><b>${esc(t.target_name)}</b>${t.target_type === "component" && t.bike_name ? ` (${esc(t.bike_name)})` : ""}: ${esc(t.name)} – ${num(t.used, 0)} / ${num(t.interval, 0)} ${({ km: "km", hours: "óra", days: "nap" })[t.unit]}${t.status === "due" ? " · esedékes" : " · hamarosan"}</span>
        <button type="button" class="strava-conn-btn strava-conn-btn--ghost" data-home="openGear">Felszerelés</button>
      </div>`).join("")}

      <div class="home-qa">
        ${qa("plan", "plus", "Új útvonal", "", true)}
        ${qa("loadFile", "upload", "GPX / FIT betöltése")}
        ${qa("library", "bookmark", "Könyvtár", libCount || "")}
        ${qa("community", "users", "Közösségi utak", _samples?.length || "")}
        ${qa("stats", "bar-chart-3", "Statisztikák")}
      </div>

      ${!_items ? `<div class="home-note">Betöltés…</div>` : `
        <div class="home-row2">
          ${lastWorkoutCard()}
          ${hasData ? `<section class="home-c home-weather" id="homeWeather"><div class="home-c-head"><h2>Időjárás</h2></div><div class="home-sub">Időjárás betöltése…</div></section>` : ""}
        </div>
        ${plansCard()}
        ${!hasData ? `
        <div class="home-note">Még nincs edzésed. Tölts be egyet a <b>GPX / FIT betöltése</b> gombbal, vagy kösd be a Stravát
        a Beállításokban – utána itt látod az összesítőidet, a formádat és a céljaidat.</div>` : `
        <div class="home-row2 home-row2--b">
          ${summaryCard(workouts)}
          ${formCard(workouts)}
        </div>
        <div class="home-row2 home-row2--c">
          ${memoryCard()}
          ${habitsCard(workouts)}
        </div>
        ${calendarCard(workouts)}`}`}
      <div class="home-foot">Új vagy itt? <a href="./help.html" target="_blank" rel="noopener">Súgó és kézikönyv →</a></div>
    </div>`;
}

function qa(act, icon, label, count = "", primary = false) {
  return `<button type="button" class="home-qa-btn${primary ? " is-primary" : ""}" data-home="${act}">
      <i data-lucide="${icon}" aria-hidden="true"></i><span>${label}</span>${count !== "" ? `<em>${count}</em>` : ""}</button>`;
}

// ── Legutóbbi edzés: térképes előnézet, fő számok, Elemzés ───────────────────
function lastWorkoutCard() {
  const r = lastWorkout();
  if (!r) return "";
  const t = new Date(when(r));
  const ago = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 864e5);
  const day = ago === 0 ? "ma" : ago === 1 ? "tegnap" : t.toLocaleDateString("hu-HU", { month: "long", day: "numeric" });
  const time = r.start_time ? t.toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" }) : "";
  const avg = r.avg_speed_kmh ?? (r.duration && r.distance ? r.distance / (r.duration / 60) : null);
  const stat = (v, unit, label) => `<div class="cs-stat"><b>${v}<small>${unit}</small></b><span>${label}</span></div>`;
  const dur = r.duration ? (r.duration >= 60 ? `${Math.floor(r.duration / 60)}<small>ó</small> ${Math.round(r.duration % 60)}` : `${Math.round(r.duration)}`) : "";
  const mini = [
    r.avg_heartrate ? `<span>Pulzus <b>${Math.round(r.avg_heartrate)}</b>${r.max_heartrate ? ` / ${Math.round(r.max_heartrate)}` : ""}</span>` : "",
    r.avg_watts ? `<span>Teljesítmény <b>${Math.round(r.avg_watts)} W</b></span>` : "",
    r.suffer_score ? `<span>Terhelés <b>${Math.round(r.suffer_score)}</b></span>` : "",
    r.calories ? `<span>Kalória <b>${Math.round(r.calories)}</b> kcal</span>` : "",
  ].join("");
  return `<section class="home-c home-last">
      <div class="home-c-head"><h2>Legutóbbi edzés</h2><button type="button" data-home="libraryWorkouts">Összes edzés →</button></div>
      <div class="home-last-in">
        <div class="home-pv" id="homeLastPv"></div>
        <div class="home-last-body">
          <div class="home-last-name">${esc(r.name || "Edzés")}</div>
          <div class="home-sub">${[day + (time ? ` ${time}` : ""), r.location_city].filter(Boolean).map(esc).join(" · ")}</div>
          <div class="home-last-stats">
            ${r.distance ? stat(num(r.distance, 1), "km", "Táv") : ""}
            ${dur ? stat(dur, "p", "Idő") : ""}
            ${r.elevation ? stat(num(r.elevation, 0), "m", "Emelkedés") : ""}
            ${avg ? stat(num(avg, 1), "km/h", "Átlag") : ""}
          </div>
          ${mini ? `<div class="home-last-mini">${mini}</div>` : ""}
          <div class="home-last-acts">
            <button type="button" class="lib-x-btn is-primary" data-home="open" data-id="${esc(r.id)}" data-name="${esc(r.name || "")}" data-target="file"><i data-lucide="chart-line" aria-hidden="true"></i><span>Elemzés</span></button>
            ${r.indoor ? "" : `<button type="button" class="lib-x-btn" data-home="open" data-id="${esc(r.id)}" data-name="${esc(r.name || "")}" data-target="plan"><i data-lucide="map-pin-plus" aria-hidden="true"></i><span>Tervezés</span></button>`}
          </div>
        </div>
      </div>
    </section>`;
}

// ── Mentett tervek: a 3 legutóbbi, kis térképpel ─────────────────────────────
function plansCard() {
  const plans = (_items || []).filter((r) => !isWorkout(r)).sort((a, b) => (when(a) < when(b) ? 1 : -1)).slice(0, 3);
  if (!plans.length) return "";
  return `<section class="home-c home-plans">
      <div class="home-c-head"><h2>Mentett terveid</h2><button type="button" data-home="libraryRoutes">Mind a Könyvtárban →</button></div>
      <div class="home-plan-grid">${plans.map((r) => `
        <button type="button" class="home-plan" data-home="open" data-id="${esc(r.id)}" data-name="${esc(r.name || "")}" data-target="plan">
          <span class="home-pv home-pv--sm" data-pv="${esc(r.id)}"></span>
          <b>${esc(r.name || "Névtelen terv")}</b>
          <span class="home-sub">${[r.distance ? `${num(r.distance, 1)} km` : "", r.elevation ? `${num(r.elevation, 0)} m` : ""].filter(Boolean).join(" · ")}</span>
        </button>`).join("")}</div>
    </section>`;
}

// ── Egy éve ezen a napon (±3 nap) ────────────────────────────────────────────
function memoryCard() {
  const now = new Date();
  const target = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const cands = (_items || []).filter(isWorkout).map((r) => ({ r, d: Math.abs((new Date(when(r)) - target) / 864e5) }))
    .filter((x) => x.d <= 3).sort((a, b) => a.d - b.d || (b.r.distance || 0) - (a.r.distance || 0));
  const m = cands[0];
  if (!m) return "";
  const r = m.r, t = new Date(when(r));
  const title = Math.round(m.d) === 0 ? "Egy éve ezen a napon" : "Egy éve ilyenkor";
  return `<section class="home-c home-memory">
      <div class="home-c-head"><h2>${title}</h2></div>
      <div class="home-mem-in">
        <span class="home-pv home-pv--mem" data-pv="${esc(r.id)}"></span>
        <div>
          <b>${esc(r.name || "Edzés")}</b>
          <div class="home-sub">${[t.toLocaleDateString("hu-HU", { year: "numeric", month: "long", day: "numeric" }),
            r.distance ? `${num(r.distance, 1)} km` : "", r.elevation ? `${num(r.elevation, 0)} m` : ""].filter(Boolean).join(" · ")}</div>
          <button type="button" class="lib-x-btn" data-home="open" data-id="${esc(r.id)}" data-name="${esc(r.name || "")}" data-target="file"><span>Megnyitás</span></button>
        </div>
      </div>
    </section>`;
}

// ── Időjárás a legutóbbi edzés kezdőpontján (Open-Meteo) ─────────────────────
const DIRS = ["É", "ÉK", "K", "DK", "D", "DNy", "Ny", "ÉNy"];
const dirName = (deg) => DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
let _wx = null;   // { key, data }
async function loadWeather(p) {
  const box = _main?.querySelector("#homeWeather");
  if (!box || !p) return;
  const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
  try {
    if (_wx?.key !== key || Date.now() - _wx.at > 30 * 60e3) {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat.toFixed(3)}&longitude=${p.lng.toFixed(3)}`
        + "&hourly=temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m&forecast_days=2&timezone=auto";
      const resp = await fetch(url);
      if (!resp.ok) throw new Error();
      _wx = { key, at: Date.now(), data: await resp.json() };
      const rev = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=${p.lat}&lon=${p.lng}`, { headers: { "Accept-Language": "hu" } })
        .then((r) => r.json()).catch(() => null);
      _wx.place = rev?.address?.city || rev?.address?.town || rev?.address?.village || "";
    }
    if (box.isConnected) box.innerHTML = weatherHtml(_wx);
  } catch {
    if (box.isConnected) box.innerHTML = `<div class="home-c-head"><h2>Időjárás</h2></div><div class="home-sub">Most nem érhető el az előrejelzés.</div>`;
  }
}

function weatherHtml(wx) {
  const h = wx.data.hourly;
  const now = new Date();
  const tomorrow = now.getHours() >= 15;           // délután már a holnapi napot mutatjuk
  const day = new Date(now); if (tomorrow) day.setDate(now.getDate() + 1);
  const dk = dayKey(day);
  const idx = h.time.map((t, i) => [t, i]).filter(([t]) => t.startsWith(dk)).map(([, i]) => i);
  const slots = [8, 10, 12, 14, 16, 18].map((hr) => idx.find((i) => new Date(h.time[i]).getHours() === hr)).filter((i) => i != null)
    .filter((i) => tomorrow || new Date(h.time[i]).getHours() >= now.getHours() - 1);
  if (!slots.length) return `<div class="home-c-head"><h2>Időjárás</h2></div><div class="home-sub">Nincs adat.</div>`;
  const good = (i) => h.temperature_2m[i] >= 8 && h.precipitation[i] < 0.2 && h.wind_speed_10m[i] < 25;
  const mid = slots[Math.floor(slots.length / 2)];
  const tMax = Math.max(...slots.map((i) => h.temperature_2m[i]));
  const wind = Math.round(h.wind_speed_10m[mid]), gust = Math.round(h.wind_gusts_10m[mid]), wdir = h.wind_direction_10m[mid];
  const rain = slots.reduce((a, i) => a + h.precipitation[i], 0);
  const rainAt = slots.find((i) => h.precipitation[i] >= 0.2);
  let tip;
  if (rainAt != null) tip = `Eső várható ${new Date(h.time[rainAt]).getHours()} óra körül – érdemes előtte indulni, vagy rövidebb kört tervezni.`;
  else if (wind >= 10) tip = `Indulj szél ellen (${dirName(wdir)} felé), hazafelé hátszeled lesz.`;
  else tip = "Gyenge szél – bármerre jó irány.";
  return `<div class="home-c-head"><h2>${tomorrow ? "Holnapi" : "Mai"} tekerés${wx.place ? ` · ${esc(wx.place)}` : ""}</h2></div>
      <div class="home-wx-top">
        <span class="home-wx-t">${Math.round(tMax)}°</span>
        <span class="home-wx-arrow" title="Szélirány: ${dirName(wdir)}"><svg viewBox="0 0 24 24" width="18" height="18" style="transform:rotate(${Math.round(wdir + 180)}deg)"><path d="M12 3v18M5 10l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <div class="home-sub"><b>${dirName(wdir)} szél ${wind} km/h</b><br>lökések ${gust} km/h · ${num(rain, 1)} mm eső</div>
      </div>
      <div class="home-wx-hours">${slots.map((i) => `<div class="${good(i) ? "is-good" : ""}">${new Date(h.time[i]).getHours()}h<b>${Math.round(h.temperature_2m[i])}°</b></div>`).join("")}</div>
      <div class="home-wx-tip${rainAt != null ? " is-warn" : ""}">${tip}</div>
      <div class="home-wx-src">A legutóbbi edzésed rajtjánál · Open-Meteo</div>`;
}

function card(title, body, { wide = false, full = false, link = null, hint = null, extra = "" } = {}) {
  const help = hint ? `<button class="hint-btn" type="button" data-hint-title="${esc(title)}" data-hint="${esc(HINTS[hint])}"
      aria-label="Segítség"><i data-lucide="info" aria-hidden="true"></i></button>` : "";
  return `<section class="home-c${wide ? " home-c--wide" : ""}${full ? " home-c--full" : ""}">
      <div class="home-c-head"><h2>${title}${help}</h2><span class="home-c-acts">${extra}${link ? `<button type="button" data-home="statsView" data-view="${link}">Részletek →</button>` : ""}</span></div>
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
  return card("Összesítő és célok", `<div class="home-sum">${cols.map(([label, s]) => `
      <div class="home-sum-col">
        <div class="home-lbl">${esc(label)}</div>
        <div class="home-big">${num(s.km, 0)}<small>km</small></div>
        <div class="home-sub home-sum-sub"><span>${s.n} edzés</span><span>${num(s.up, 0)} m szint</span>${s.min ? `<span>${hours(s.min)}</span>` : ""}</div>
      </div>`).join("")}</div>
      <div class="home-sum-goals">${goalRows(workouts)}</div>`, { link: "monthly", extra: `<button type="button" data-home="editGoals">Célok</button>`, hint: "goals" });
}

function formCard(workouts) {
  const early = workouts.length < FEW_WORKOUTS;
  const routes = (_items || []).filter(countsInStats).map((r) => ({ ...r, date: r.date || r.start_time }));
  const series = calcTrainingLoad(routes);
  const last = series[series.length - 1];
  const e = calcEddington(routes);
  const st = streaks(workouts);
  const sign = (v) => (v > 0 ? "+" : "") + Math.round(v);
  const f = !last ? null : last.tsb > 10 ? ["Friss", "fresh", "Kipihent, csúcsra kész."]
    : last.tsb > -10 ? ["Edzés zóna", "training", "Optimális fejlődési állapot."]
    : last.tsb > -30 ? ["Fáradt", "tired", "Érdemes lassítani egy kicsit."]
    : ["Túlterhelt", "overload", "Pihenő szükséges."];
  const item = (v, label, hint) => `<div class="cs-stat"${hint ? ` title="${esc(hint)}"` : ""}><b>${v}</b><span>${label}</span></div>`;
  return card("Forma", `
      ${f ? `<div class="home-form"><span class="home-badge home-badge--${f[1]}">${f[0]}</span><span class="home-sub">${f[2]}</span></div>` : ""}
      <div class="home-form-row">
        ${last ? item(Math.round(last.ctl), "Fittség") + item(Math.round(last.atl), "Fáradtság") + item(sign(last.tsb), "Forma") : ""}
        ${e.totalDays ? item(e.E, "Eddington", `${e.E} napon legalább ${e.E} km · a ${e.next}-hez még ${e.daysNeeded} nap kell`) : ""}
        ${item(st.nWeeks, "Hét sorozat", "Egymást követő hetek edzéssel")}
      </div>
      ${formChart(series)}
      ${e.totalDays ? `<div class="home-sub home-form-note">Eddington: a <b>${e.next}</b>-hez még <b>${e.daysNeeded}</b> nap kell legalább ${e.next} km-rel.</div>` : ""}
      ${early ? `<div class="home-sub home-early">Néhány edzés után lesz pontos.</div>` : ""}`, { link: "training", hint: "form" });
}

/** Az elmúlt 12 hét: fittség (folytonos) és fáradtság (halvány) – a kártya szélességéhez nyúlik. */
function formChart(series) {
  const pts = series.slice(-84);
  if (pts.length < 14) return "";
  const W = 300, H = 90;
  const hi = Math.max(...pts.map((p) => Math.max(p.ctl, p.atl)), 1), lo = Math.min(...pts.map((p) => Math.min(p.ctl, p.atl)));
  const pad = Math.max(2, (hi - lo) * 0.12), top = hi + pad, bot = Math.max(0, lo - pad);
  const x = (i) => (i / (pts.length - 1)) * W, y = (v) => H - ((v - bot) / (top - bot || 1)) * H;
  const line = (k) => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
  const area = `${line("ctl")}L${W},${H}L0,${H}Z`;
  const weeks = [];
  for (let i = pts.length - 1; i >= 0; i -= 7) weeks.push(i);
  const tip = (p) => `${new Date(p.date).toLocaleDateString("hu-HU", { month: "short", day: "numeric" })} · fittség ${Math.round(p.ctl)} · fáradtság ${Math.round(p.atl)}`;
  return `<div class="home-fc">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="home-fc-svg" role="img" aria-label="Fittség és fáradtság az elmúlt 12 hétben">
        <path d="${area}" class="home-fc-area"/>
        <path d="${line("atl")}" class="home-fc-atl" vector-effect="non-scaling-stroke"/>
        <path d="${line("ctl")}" class="home-fc-ctl" vector-effect="non-scaling-stroke"/>
        ${pts.map((p, i) => `<rect x="${(x(i) - W / pts.length / 2).toFixed(1)}" y="0" width="${(W / pts.length).toFixed(2)}" height="${H}" fill="transparent"><title>${tip(p)}</title></rect>`).join("")}
      </svg>
      <div class="home-fc-leg"><span><i class="home-fc-k home-fc-k--ctl"></i>Fittség</span><span><i class="home-fc-k home-fc-k--atl"></i>Fáradtság</span><em>12 hét</em></div>
    </div>`;
}

// ── Szokások (a Statisztika → Szokások kivonata) ─────────────────────────────
const TODS = [["morning", "Reggel", 6, 12], ["noon", "Délután", 12, 17], ["evening", "Este", 17, 23], ["night", "Éjjel", 23, 30]];
function habitsCard(workouts) {
  const ws = workouts.filter((r) => when(r));
  if (ws.length < 5) return "";
  const days = [0, 0, 0, 0, 0, 0, 0];
  ws.forEach((r) => { days[(new Date(when(r)).getDay() + 6) % 7]++; });
  const max = Math.max(...days, 1), fav = days.indexOf(max);
  const timed = ws.filter((r) => r.start_time);
  const tod = TODS.map(([k, l, a, b]) => [k, l, timed.filter((r) => { const h = new Date(r.start_time).getHours(); return (h >= a && h < b) || (h + 24 >= a && h + 24 < b); }).length]);
  const tot = timed.length || 1;
  const favTod = tod.reduce((m, t) => (t[2] > m[2] ? t : m), tod[0]);
  const LBL = ["H", "K", "Sze", "Cs", "P", "Szo", "V"], DAYN = ["hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat", "vasárnap"];
  return card("Szokásaid", `
      <div class="home-hb">
        <div class="home-hb-days">${days.map((n, i) => `<div class="home-hb-d${i === fav ? " is-fav" : ""}" title="${DAYN[i]}: ${n} edzés"><i style="height:${Math.max(4, (n / max) * 100)}%"></i><span>${LBL[i]}</span></div>`).join("")}</div>
        <div class="home-hb-side">
          <div class="cs-stat"><b>${DAYN[fav].replace(/^./, (c) => c.toUpperCase())}</b><span>kedvenc nap</span></div>
          ${timed.length ? `<div class="cs-stat"><b>${favTod[1]}</b><span>leggyakoribb napszak</span></div>` : ""}
        </div>
      </div>
      ${timed.length ? `<div class="home-hb-tod">${tod.filter((t) => t[2]).map(([k, l, n]) => `<i class="hb-tod--${k}" style="flex:${n}" title="${l}: ${Math.round(n / tot * 100)}%"></i>`).join("")}</div>
      <div class="home-hb-leg">${tod.filter((t) => t[2]).map(([k, l, n]) => `<span><i class="hb-sw hb-tod--${k}"></i>${l} ${Math.round(n / tot * 100)}%</span>`).join("")}</div>` : ""}`,
    { link: "habits" });
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

function goalRows(workouts) {
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
  return rows.join("");
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
