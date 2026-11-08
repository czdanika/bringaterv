// ── Útvonal-javaslat panel (Tervezés) ────────────────────────────────────────
// Rajt (és A → B-nél cél) a térképre bökve vagy a saját helyről, táv vagy idő, kör / A → B,
// burkolat, szint, további beállítások (irány, forgalom, leghosszabb emelkedő), illetve szabad
// szöveges kérés AI-val → javaslatok a térképen és kártyákon (3, „Több javaslat”-tal 6);
// a kiválasztott szerkeszthető tervként töltődik be. A logika a map/routeSuggest.js-ben van.

import { generateSuggestions, haversine, FOOT_SURFACES } from "../map/routeSuggest.js";
import { activityOf } from "../routeModes.js";
import { escapeHtml } from "./library.js";
import { num } from "../format.js";
import { searchPlaces } from "./search.js";
import { routesApi } from "../api/routesApi.js";
import { probeLocalBrouter, localBrouterOk } from "../map/mapAdapter.js";

const COLORS = ["#e8461e", "#2563eb", "#7c3aed", "#0d9488", "#db2777", "#ca8a04"];
const DIRS = [["", "Bármi"], ["0", "É"], ["90", "K"], ["180", "D"], ["270", "Ny"]];
const CLIMBS = [["", "Mindegy"], ["30", "≤ 30 m"], ["60", "≤ 60 m"], ["100", "≤ 100 m"]];
const SURF_COLORS = { asphalt: "#2b6cb0", gravel: "#b7791f", mtb: "#7b5a3a", hiking: "#a855f7" };
const SURF_LABEL = { asphalt: "aszfalt", gravel: "gravel", mtb: "földút", hiking: "ösvény" };

let _d = null;   // { mapAdapter, onApply(result, opts), showToast, reverseTown, hasRoute, getSpeed(mode), getMode() }
const st = { active: false, start: null, end: null, startName: "", endName: "", picking: "start",
             km: 50, by: "km", hours: 2, loop: true, activity: "bike", surface: "asphalt", hills: "any",
             dir: null, traffic: "any", maxClimb: null, more: false,
             results: [], selected: 0, shown: 3, busy: false, pending: false,
             ai: null, aiBusy: false, aiNote: null };
const $ = (id) => document.getElementById(id);

export function initRouteSuggest(deps) {
  _d = deps;
  const panel = $("suggestPanel");
  if (!panel) return;
  panel.addEventListener("click", onClick);
  $("sgKm").addEventListener("input", (e) => {
    if (st.by === "time") { st.hours = Number(e.target.value); st.km = kmFromHours(); }
    else st.km = Number(e.target.value);
    renderForm(); drawStart(); markStale();
  });
  $("sgKm").addEventListener("change", () => optionsChanged());
  document.querySelectorAll("[data-open-suggest]").forEach((b) => b.addEventListener("click", open));
}

export const isSuggestActive = () => st.active;

// Idő → táv a Beállításokban megadott tervezési sebességgel (vegyesnél a gravel / túra tempóval)
const isFoot = () => st.activity === "foot";
const speedFor = () => isFoot()
  ? _d.getSpeed?.(st.surface === "walk" ? "walking" : "hiking") || 5
  : _d.getSpeed?.(st.surface === "asphalt" ? "asphalt" : "gravel") || (st.surface === "asphalt" ? 25 : 18);
const kmFromHours = () => Math.max(isFoot() ? 1 : 5, Math.round(st.hours * speedFor()));
// táv-csúszka: gyalog 2–40 km, kerékpárral 10–200 km
const KM_RANGE = () => (isFoot() ? { min: 2, max: 40, step: 1 } : { min: 10, max: 200, step: 5 });
const clampKm = (km) => { const r = KM_RANGE(); return Math.max(r.min, Math.min(r.max, Math.round(km / r.step) * r.step)); };

// Kerékpár ↔ gyalog: a burkolat-választás és a táv a tevékenységhez igazodik
function setActivity(a) {
  if (a === st.activity) return;
  st.activity = a;
  st.surface = a === "foot" ? "hike" : "asphalt";
  st.km = a === "foot" ? 10 : 50;
  st.traffic = "any";
  if (st.by === "time") st.km = kmFromHours();
}
const fmtHours = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)} óra${m % 60 ? ` ${m % 60} perc` : ""}`; };

export function open() {
  // a tervező tevékenységével indul (Séta / Túra módból gyalogos javaslat)
  if (!st.results.length) setActivity(activityOf(_d.getMode?.()));
  st.active = true;
  $("tabPlan")?.classList.add("is-suggesting");
  document.body.classList.add("is-suggesting");
  $("suggestPanel").hidden = false;
  renderForm(); renderResults(); drawStart();
  window.lucide?.createIcons({ root: $("suggestPanel") });
  probeLocalBrouter();   // saját BRouter elérhető-e (akkor több változatot próbálunk ki)
  // AI-kérés mező: csak ha a felhasználónak elérhető az AI
  if (st.ai == null) routesApi.aiStatus().then((a) => { st.ai = a; renderAi(); }).catch(() => { st.ai = { configured: false }; });
  else renderAi();
}

export function close() {
  st.active = false;
  $("tabPlan")?.classList.remove("is-suggesting");
  document.body.classList.remove("is-suggesting");
  $("suggestPanel").hidden = true;
  _d.mapAdapter.clearSuggestions();
}

/** Térképre bökés, amíg a panel nyitva van: rajt vagy cél beállítása */
export async function handleMapClick(point) {
  if (st.busy) return;
  const which = st.loop ? "start" : st.picking;
  st[which] = { lat: point.lat, lng: point.lng };
  st[which + "Name"] = "…";
  if (!st.loop && which === "start" && !st.end) st.picking = "end";
  renderForm(); drawStart();
  optionsChanged();   // ha már volt javaslat: az új ponttal újratervez
  const name = await _d.reverseTown(point.lat, point.lng);
  if (st[which] && st[which].lat === point.lat) { st[which + "Name"] = name || "kijelölt pont"; renderForm(); }
}

function drawStart() {
  if (!st.active) return;
  // a körzet: kb. ekkora sugárban marad egy kör (táv / 2π / közúti szorzó)
  const radius = st.loop && st.start ? st.km * 1000 / (2 * Math.PI * 1.3) * 2 : 0;
  _d.mapAdapter.showSuggestStart(st.start, radius, st.loop ? null : st.end);
}

function seg(name, options, cur) {
  return `<div class="seg2" role="radiogroup">${options.map(([v, l]) =>
    `<button type="button" class="${v === cur ? "on" : ""}" data-sg-${name}="${v}" role="radio" aria-checked="${v === cur}">${l}</button>`).join("")}</div>`;
}

function renderForm() {
  const form = $("sgForm");
  const pointRow = (which, label, color, empty) => {
    const p = st[which], active = !st.loop && st.picking === which;
    return `<button type="button" class="sg-pt${active ? " is-active" : ""}" data-sg-pick="${which}">
      <span class="sg-dot" style="background:${color}"></span>
      <span class="sg-pt-name">${p ? escapeHtml(st[which + "Name"] || "kijelölt pont") : `<em>${empty}</em>`}</span>
      <span class="sg-pt-lbl">${label}</span></button>`;
  };
  form.innerHTML = `
    ${pointRow("start", "Rajt", "#2f855a", "Bökj a térképre a rajthoz")}
    <button type="button" class="sg-locate" data-sg-act="locate"><i data-lucide="crosshair" aria-hidden="true"></i>Saját helyem</button>
    ${seg("loop", [["1", '<i data-lucide="repeat" aria-hidden="true"></i>Kör'], ["0", '<i data-lucide="move-right" aria-hidden="true"></i>A → B']], st.loop ? "1" : "0")}
    ${st.loop ? "" : pointRow("end", "Cél", "#e8461e", "Bökj a térképre a célhoz")}
    <div class="sg-km-row">
      <div class="sg-by" role="radiogroup" aria-label="Táv vagy idő">${[["km", "Táv"], ["time", "Idő"]].map(([v, l]) =>
        `<button type="button" class="${st.by === v ? "on" : ""}" data-sg-by="${v}" role="radio" aria-checked="${st.by === v}">${l}</button>`).join("")}</div>
      ${st.by === "time"
        ? `<b class="sg-km">${fmtHours(st.hours)}<small>≈ ${st.km} km</small></b>`
        : `<b class="sg-km">${st.km}<small>km</small></b>`}</div>`;
  const range = $("sgKm");
  if (st.by === "time") { range.min = "0.5"; range.max = "8"; range.step = "0.25"; range.value = st.hours; range.setAttribute("aria-label", "Idő (óra)"); }
  else { const r = KM_RANGE(); range.min = r.min; range.max = r.max; range.step = r.step; range.value = st.km; range.setAttribute("aria-label", "Táv (km)"); }
  const extra = [st.loop && st.dir != null, st.traffic !== "any", st.maxClimb].filter(Boolean).length;
  $("sgOpts").innerHTML = `
    <div><div class="sg-lbl">Tevékenység</div>${seg("activity", [["bike", "Kerékpár"], ["foot", "Gyalog"]], st.activity)}</div>
    ${isFoot()
      ? `<div><div class="sg-lbl">Terep</div>${seg("surface", [["walk", "Séta"], ["hike", "Túra"], ["footmix", "Vegyes"]], st.surface)}</div>`
      : `<div><div class="sg-lbl">Burkolat</div>${seg("surface", [["asphalt", "Aszfalt"], ["gravel", "Gravel"], ["mixed", "Vegyes"]], st.surface)}</div>`}
    <div><div class="sg-lbl">Szint</div>${seg("hills", [["flat", "Sík"], ["hilly", "Dombos"], ["any", "Bármi"]], st.hills)}</div>
    <button type="button" class="sg-more-toggle" data-sg-act="more" aria-expanded="${st.more}">
      <i data-lucide="sliders-horizontal" aria-hidden="true"></i>További beállítások${extra ? ` <span class="sg-badge">${extra}</span>` : ""}
      <i data-lucide="chevron-down" class="sg-chev" aria-hidden="true"></i></button>
    ${st.more ? `<div class="sg-more">
      ${st.loop ? `<div><div class="sg-lbl">Irány</div>${seg("dir", DIRS, st.dir == null ? "" : String(st.dir))}</div>` : ""}
      ${isFoot() ? "" : `<div><div class="sg-lbl">Forgalom</div>${seg("traffic", [["any", "Mindegy"], ["quiet", "Főutak kerülése"], ["cycle", "Kerékpárút előnyben"]], st.traffic)}</div>`}
      <div><div class="sg-lbl">Leghosszabb emelkedő</div>${seg("climb", CLIMBS, st.maxClimb ? String(st.maxClimb) : "")}</div>
    </div>` : ""}`;
  window.lucide?.createIcons({ root: $("sgOpts") });
  const ready = st.start && (st.loop || st.end);
  $("sgGo").disabled = !ready || st.busy;
  $("sgHint").textContent = !st.start ? "Bökj a térképre a rajthoz, vagy használd a saját helyed."
    : !st.loop && !st.end ? "Most bökj a térképre a célhoz." : "";
  window.lucide?.createIcons({ root: form });
}

function renderResults() {
  const box = $("sgResults");
  if (!st.results.length) { box.innerHTML = st.aiNote ? `<div class="sg-ai-note">${escapeHtml(st.aiNote)}</div>` : ""; return; }
  const r = st.results.slice(0, st.shown);
  box.innerHTML = (st.aiNote ? `<div class="sg-ai-note">${escapeHtml(st.aiNote)}</div>` : "") +
    `<div class="sg-res-h"><b>${r.length} javaslat</b><span>${st.km} km körül · ${st.loop ? "kör" : "A → B"}</span></div>` +
    (r[0]?.nearEnd ? `<p class="sg-note">A cél közel van a rajthoz, ezért körszerű útvonalak – a célnál érnek véget.</p>` : "") +
    (r.every((c) => c.warn?.length) ? `<p class="sg-note">A rajt környékén nem találtam teljesen ${[st.hills === "flat" ? "sík" : "", st.surface === "asphalt" ? "aszfaltos" : ""].filter(Boolean).join(" és ")} ${st.loop ? "kört" : "útvonalat"} – ezek állnak hozzá a legközelebb. Más rajtpont vagy táv segíthet.</p>` : "") +
    r.map((c, i) => {
      const mix = Object.entries(c.mix).filter(([, v]) => v > 0.01).sort((a, b) => b[1] - a[1]);
      return `<div class="sg-card${i === st.selected ? " is-sel" : ""}" data-sg-sel="${i}">
        <div class="sg-ct"><span class="sg-sw" style="background:${COLORS[i]}"></span><b>${escapeHtml(c.name || `${i + 1}. javaslat`)}</b>${i === 0 ? '<em>Legjobb</em>' : ""}</div>
        <div class="sg-nums"><span><b>${num(c.distanceMeters / 1000, 1)}</b> km</span><span><b>${Math.round(c.ascentMeters)}</b> m szint</span>
          ${FOOT_SURFACES.includes(st.surface)
            ? `<span><b>${Math.round((c.marked || 0) * 100)}%</b> jelzett turistaúton</span><span><b>${Math.round((c.mix.asphalt || 0) * 100)}%</b> aszfalt</span>`
            : `<span><b>${Math.round((c.mix.asphalt || 0) * 100)}%</b> aszfalt</span>
          ${1 - (c.mix.asphalt || 0) > 0.05 ? `<span><b>${Math.round((1 - (c.mix.asphalt || 0)) * 100)}%</b> burkolatlan</span>` : ""}`}</div>
        ${c.warn?.length ? `<div class="sg-warn">Nem egészen a kérés szerinti: ${c.warn.map(escapeHtml).join(", ")}</div>` : ""}
        <div class="sg-mix">${mix.map(([m, v]) => `<span style="flex:${v};background:${SURF_COLORS[m] || "#999"}" title="${SURF_LABEL[m] || m} ${Math.round(v * 100)}%"></span>`).join("")}</div>
        ${i === st.selected ? `<button type="button" class="sg-use" data-sg-act="use"><i data-lucide="check" aria-hidden="true"></i>Ezt választom</button>
        <div class="sg-similar"><span>Hasonló, de…</span>${similarChips(c).map(([k, l]) => `<button type="button" data-sg-similar="${k}">${l}</button>`).join("")}</div>` : ""}
      </div>`;
    }).join("") +
    (st.results.length > st.shown ? `<button type="button" class="sg-more-res" data-sg-act="showmore"><i data-lucide="plus" aria-hidden="true"></i>Több javaslat (+${st.results.length - st.shown})</button>` : "");
  window.lucide?.createIcons({ root: box });
}

// „Hasonló, de…”: a kiválasztott javaslatból kiinduló gyors módosítások
function similarChips(c) {
  const out = [["shorter", "rövidebb"], ["longer", "hosszabb"]];
  if (st.hills !== "flat" || !st.maxClimb || st.maxClimb > 30) out.push(["flatter", "kevesebb szint"]);
  if (st.loop) out.push(["otherdir", "másik irány"]);
  if (isFoot()) {
    if (st.surface !== "hike" || (c.marked || 0) < 0.9) out.push(["marked", "több jelzett út"]);
    return out;
  }
  if ((c.mix.asphalt || 0) < 0.97) out.push(["asphalt", "több aszfalt"]);
  if (st.traffic === "any") out.push(["quiet", "kisebb forgalom"]);
  return out;
}
function applySimilar(kind) {
  const c = st.results[st.selected];
  if (!c) return;
  const scale = (f) => {
    if (st.by === "time") { st.hours = Math.max(0.5, Math.round(st.hours * f * 4) / 4); st.km = kmFromHours(); }
    else st.km = clampKm(st.km * f);
  };
  if (kind === "shorter") scale(0.8);
  else if (kind === "longer") scale(1.25);
  else if (kind === "flatter") { if (st.hills !== "flat") st.hills = "flat"; else st.maxClimb = st.maxClimb > 60 ? 60 : 30; }
  else if (kind === "otherdir") {
    // a mostani kör iránya (rajt → legtávolabbi pont) ellenkezője, a legközelebbi égtájra kerekítve
    const deg = bearingDeg(st.start, c.farthest);
    st.dir = Math.round(((deg + 180) % 360) / 90) % 4 * 90;
    st.more = true;
  } else if (kind === "asphalt") st.surface = "asphalt";
  else if (kind === "marked") st.surface = "hike";
  else if (kind === "quiet") { st.traffic = "quiet"; st.more = true; }
  renderForm(); drawStart(); run();
}

function drawResults(fit) {
  _d.mapAdapter.showSuggestions(st.results.slice(0, st.shown).map((c, i) => ({ geometry: c.geometry, color: COLORS[i], onSelect: () => select(i) })), st.selected, { fit });
}

function bearingDeg(a, b) {
  const y = Math.sin((b.lng - a.lng) * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180);
  const x = Math.cos(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180)
          - Math.sin(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.cos((b.lng - a.lng) * Math.PI / 180);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// Égtáj a rajtból a legtávolabbi pont felé („Északi kör”)
function compass(a, b) {
  return ["Északi", "Északkeleti", "Keleti", "Délkeleti", "Déli", "Délnyugati", "Nyugati", "Északnyugati"][Math.round(bearingDeg(a, b) / 45) % 8];
}

// Beállítás-változás: ha már volt eredmény (vagy éppen számol), automatikusan újratervez
let _rerunTimer = null;
function markStale() {
  if (st.results.length) $("sgResults").classList.add("is-stale");
}
function optionsChanged() {
  if (!st.results.length && !st.busy) return;
  markStale();
  if (st.busy) { st.pending = true; return; }
  if (!st.start || (!st.loop && !st.end)) { st.results = []; renderResults(); _d.mapAdapter.clearSuggestions(); drawStart(); return; }
  clearTimeout(_rerunTimer);
  _rerunTimer = setTimeout(run, 500);
}

function select(i) {
  st.selected = i;
  renderResults(); drawResults(false);
}

async function run() {
  if (st.busy || !st.start || (!st.loop && !st.end)) return;
  if (!st.loop && haversine(st.start, st.end) < 300) { _d.showToast("A rajt és a cél túl közel van egymáshoz."); return; }
  st.busy = true; renderForm();
  $("sgResults").classList.add("is-stale");
  _d.mapAdapter.clearSuggestions(); drawStart();
  const status = $("sgStatus");
  status.hidden = false;
  status.innerHTML = `<span class="spinner-inline"></span> Útvonalak számolása…`;
  try {
    const res = await generateSuggestions(
      { start: st.start, end: st.end, km: st.km, loop: st.loop, surface: st.surface, hills: st.hills,
        dir: st.loop ? st.dir : null, avoidTraffic: st.traffic !== "any", cycleways: st.traffic === "cycle",
        maxClimb: st.maxClimb, count: 6, dense: localBrouterOk() },
      (wps, mode, profile) => _d.mapAdapter.routeStrict(wps, mode, profile),
      (done, total) => { status.innerHTML = `<span class="spinner-inline"></span> Útvonalak számolása… ${done}/${total}`; });
    if (!res.length) throw new Error("Nem sikerült útvonalat tervezni – próbáld másik rajttal vagy távval.");
    st.results = res; st.selected = 0; st.shown = Math.min(3, res.length);
    status.hidden = true;
    $("sgResults").classList.remove("is-stale");
    renderResults(); drawResults(true);
    $("sgResults").scrollIntoView({ behavior: "smooth", block: "nearest" });
    // nevek: a legtávolabbi pont települése („Kör Neszmély felé”)
    // körnél a legtávolabbi pont, A → B-nél az útvonal fele adja a nevet
    const known = [st.startName, st.endName];
    for (const c of res) {
      const p = st.loop ? c.farthest : c.mid;
      let town = await _d.reverseTown(p.lat, p.lng);
      if (known.includes(town)) town = await _d.reverseTown(p.lat, p.lng, true);
      if (st.results !== res) return;
      const dir = st.loop ? `${compass(st.start, p)} kör` : `${compass(st.start, p)} ív`;
      let name = town && !known.includes(town) ? (st.loop ? `Kör ${town} felé` : `${town} érintésével`) : dir;
      // két egyforma név helyett a második az égtájat kapja
      if (res.some((o) => o !== c && o.name === name)) name = name === dir ? `${dir} (${res.indexOf(c) + 1}.)` : dir;
      c.name = name;
      renderResults();
    }
  } catch (err) {
    status.innerHTML = escapeHtml(err.message || "Hiba történt.");
    st.results = []; renderResults(); $("sgResults").classList.remove("is-stale");
  } finally {
    st.busy = false; renderForm();
    // számolás közben változott a beállítás → most újratervezünk
    if (st.pending) { st.pending = false; optionsChanged(); }
  }
}

function onClick(e) {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  if (b.dataset.sgLoop != null) {
    const loop = b.dataset.sgLoop === "1";
    if (loop === st.loop) return;
    st.loop = loop; st.picking = st.loop ? "start" : (st.start && !st.end ? "end" : "start");
    renderForm(); drawStart(); optionsChanged(); return;
  }
  if (b.dataset.sgActivity) {
    if (b.dataset.sgActivity !== st.activity) { setActivity(b.dataset.sgActivity); renderForm(); drawStart(); optionsChanged(); }
    return;
  }
  if (b.dataset.sgSurface) {
    if (st.surface !== b.dataset.sgSurface) { st.surface = b.dataset.sgSurface; if (st.by === "time") st.km = kmFromHours(); renderForm(); drawStart(); optionsChanged(); }
    return;
  }
  if (b.dataset.sgHills) { if (st.hills !== b.dataset.sgHills) { st.hills = b.dataset.sgHills; renderForm(); optionsChanged(); } return; }
  if (b.dataset.sgBy) {
    if (st.by === b.dataset.sgBy) return;
    st.by = b.dataset.sgBy;
    if (st.by === "time") { st.hours = Math.max(0.5, Math.min(8, Math.round(st.km / speedFor() * 4) / 4)); st.km = kmFromHours(); }
    renderForm(); drawStart(); optionsChanged(); return;
  }
  if (b.dataset.sgDir != null) { const v = b.dataset.sgDir === "" ? null : Number(b.dataset.sgDir); if (v !== st.dir) { st.dir = v; renderForm(); optionsChanged(); } return; }
  if (b.dataset.sgTraffic) { if (b.dataset.sgTraffic !== st.traffic) { st.traffic = b.dataset.sgTraffic; renderForm(); optionsChanged(); } return; }
  if (b.dataset.sgClimb != null) { const v = b.dataset.sgClimb ? Number(b.dataset.sgClimb) : null; if (v !== st.maxClimb) { st.maxClimb = v; renderForm(); optionsChanged(); } return; }
  if (b.dataset.sgSimilar) { applySimilar(b.dataset.sgSimilar); return; }
  if (b.dataset.sgPick) { st.picking = b.dataset.sgPick; renderForm(); if (st[st.picking]) _d.mapAdapter.panTo(st[st.picking]); return; }
  if (b.closest("[data-sg-sel]") && !b.dataset.sgAct && !b.dataset.sgSimilar) return;
  const act = b.dataset.sgAct;
  if (act === "close") close();
  else if (act === "go") run();
  else if (act === "use") apply();
  else if (act === "locate") locate(b);
  else if (act === "more") { st.more = !st.more; renderForm(); }
  else if (act === "showmore") { st.shown = st.results.length; renderResults(); drawResults(true); }
  else if (act === "ai") runAi();
}

document.addEventListener("click", (e) => {
  const card = e.target.closest?.("[data-sg-sel]");
  if (card && !e.target.closest("button")) select(Number(card.dataset.sgSel));
});

function locate(btn) {
  if (!navigator.geolocation) { _d.showToast("A böngésző nem támogatja a helymeghatározást."); return; }
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition((pos) => {
    btn.disabled = false;
    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    st.picking = "start";
    _d.mapAdapter.panTo(p, 12);
    handleMapClick(p);
  }, () => { btn.disabled = false; _d.showToast("Nem sikerült meghatározni a helyed."); },
  { enableHighAccuracy: true, maximumAge: 60000, timeout: 10000 });
}

function apply() {
  const c = st.results[st.selected];
  if (!c) return;
  if (_d.hasRoute() && !confirm("A jelenlegi útvonal helyére tölti be a javaslatot. Folytatod?")) return;
  close();
  _d.onApply(c);
}

// ── Szabad szöveges kérés AI-val ──────────────────────────────────────────────
// A Claude a leírásból kitölti a beállításokat (rajt / cél helyneve, táv vagy idő, burkolat,
// szint, irány, forgalom, emelkedő); a helyneveket a címkereső találja meg, utána a megszokott
// generátor tervez. Amit (még) nem tudunk figyelembe venni, azt a válasz külön jelzi.
function renderAi() {
  const box = $("sgAi");
  if (!box) return;
  const a = st.ai;
  const usable = a?.configured && a.allowed && !a.user_off;
  box.hidden = !usable;
  if (!usable) return;
  if (!box.dataset.ready) {
    box.dataset.ready = "1";
    box.innerHTML = `
      <label class="sg-lbl" for="sgAiText">Mondd el, milyen túrát szeretnél</label>
      <textarea id="sgAiText" rows="2" maxlength="500" placeholder="pl. 2 órás gravel kör Szentendréről, kevés forgalommal, nagy emelkedő nélkül"></textarea>
      <div class="sg-ai-row"><button type="button" class="sg-ai-go" data-sg-act="ai"><i data-lucide="sparkles" aria-hidden="true"></i><span>Kitöltés AI-val</span></button>
        <small id="sgAiLeft"></small></div>`;
    window.lucide?.createIcons({ root: box });
    $("sgAiText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runAi(); });
  }
  $("sgAiLeft").textContent = a.remaining != null ? `ma még ${a.remaining} AI-kérés` : "";
  const btn = box.querySelector(".sg-ai-go");
  btn.disabled = st.aiBusy || a.remaining === 0;
  btn.querySelector("span").textContent = st.aiBusy ? "Értelmezés…" : "Kitöltés AI-val";
}

async function placeFor(name) {
  try {
    const hits = await searchPlaces(/magyarorsz|hungary/i.test(name) ? name : `${name}, Magyarország`, "hu");
    return hits[0] || null;
  } catch { return null; }
}

async function runAi() {
  const text = $("sgAiText")?.value.trim();
  if (!text || st.aiBusy) return;
  st.aiBusy = true; renderAi();
  try {
    const r = await routesApi.aiRouteRequest({ text, start_name: st.start ? st.startName : "", loop: st.loop });
    const p = r.params || {};
    if (r.status) st.ai = r.status;
    if (p.loop != null) st.loop = !!p.loop;
    if (p.start_place) {
      const hit = await placeFor(p.start_place);
      if (hit) { st.start = { lat: hit.lat, lng: hit.lng }; st.startName = p.start_place; _d.mapAdapter.panTo(st.start, 11); }
      else _d.showToast(`Nem találtam a helyet: ${p.start_place}`);
    }
    if (!st.loop && p.end_place) {
      const hit = await placeFor(p.end_place);
      if (hit) { st.end = { lat: hit.lat, lng: hit.lng }; st.endName = p.end_place; }
    }
    // gyalogos kérés (séta / túra / a kettő vegyesen) → gyalog tevékenység
    const footSurf = { walk: "walk", hike: "hike", walk_hike: "footmix" }[p.surface];
    if (footSurf) { setActivity("foot"); st.surface = footSurf; }
    else if (["asphalt", "gravel", "mixed"].includes(p.surface)) { setActivity("bike"); st.surface = p.surface; }
    if (["flat", "hilly", "any"].includes(p.hills)) st.hills = p.hills;
    if (p.hours > 0) { st.by = "time"; st.hours = Math.max(0.5, Math.min(8, Math.round(p.hours * 4) / 4)); st.km = kmFromHours(); }
    else if (p.km > 0) { st.by = "km"; st.km = clampKm(p.km); }
    const dirs = { N: 0, E: 90, S: 180, W: 270 };
    st.dir = dirs[p.direction] ?? null;
    st.traffic = isFoot() ? "any" : p.prefer_cycleways ? "cycle" : p.avoid_traffic ? "quiet" : "any";
    st.maxClimb = p.max_climb > 0 ? [30, 60, 100].find((v) => p.max_climb <= v) || 100 : null;
    if (st.dir != null || st.traffic !== "any" || st.maxClimb) st.more = true;
    st.aiNote = [r.summary, r.unsupported?.length ? `Ezt még nem tudom figyelembe venni: ${r.unsupported.join(", ")}.` : ""].filter(Boolean).join(" ");
    renderForm(); drawStart();
    if (st.start && (st.loop || st.end)) await run();
    else { renderResults(); _d.showToast(!st.start ? "Bökj a térképre a rajthoz, és indulhat a tervezés." : "Bökj a térképre a célhoz."); }
  } catch (err) {
    _d.showToast(err.message || "Az AI most nem érhető el.");
  } finally {
    st.aiBusy = false; renderAi();
  }
}
