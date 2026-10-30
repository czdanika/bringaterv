// ── Útvonal-javaslat panel (Tervezés) ────────────────────────────────────────
// Rajt (és A → B-nél cél) a térképre bökve vagy a saját helyről, táv, kör / A → B,
// burkolat, szint → 3 javaslat a térképen és kártyákon; a kiválasztott szerkeszthető
// tervként töltődik be. A logika a map/routeSuggest.js-ben van.

import { generateSuggestions, haversine } from "../map/routeSuggest.js";
import { escapeHtml } from "./library.js";
import { num } from "../format.js";

const COLORS = ["#e8461e", "#2563eb", "#7c3aed"];
const SURF_COLORS = { asphalt: "#2b6cb0", gravel: "#b7791f", mtb: "#7b5a3a", hiking: "#a855f7" };
const SURF_LABEL = { asphalt: "aszfalt", gravel: "gravel", mtb: "földút", hiking: "ösvény" };

let _d = null;   // { mapAdapter, onApply(result, opts), showToast, reverseTown, hasRoute }
const st = { active: false, start: null, end: null, startName: "", endName: "", picking: "start",
             km: 50, loop: true, surface: "asphalt", hills: "any", results: [], selected: 0, busy: false, pending: false };
const $ = (id) => document.getElementById(id);

export function initRouteSuggest(deps) {
  _d = deps;
  const panel = $("suggestPanel");
  if (!panel) return;
  panel.addEventListener("click", onClick);
  $("sgKm").addEventListener("input", (e) => { st.km = Number(e.target.value); renderForm(); drawStart(); markStale(); });
  $("sgKm").addEventListener("change", () => optionsChanged());
  document.querySelectorAll("[data-open-suggest]").forEach((b) => b.addEventListener("click", open));
}

export const isSuggestActive = () => st.active;

export function open() {
  st.active = true;
  $("tabPlan")?.classList.add("is-suggesting");
  document.body.classList.add("is-suggesting");
  $("suggestPanel").hidden = false;
  renderForm(); renderResults(); drawStart();
  window.lucide?.createIcons({ nodes: [$("suggestPanel")] });
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
    <div class="sg-km-row"><span class="sg-lbl">Táv</span><b class="sg-km">${st.km}<small>km</small></b></div>`;
  $("sgKm").value = st.km;
  $("sgOpts").innerHTML = `
    <div><div class="sg-lbl">Burkolat</div>${seg("surface", [["asphalt", "Aszfalt"], ["gravel", "Gravel"], ["mixed", "Vegyes"]], st.surface)}</div>
    <div><div class="sg-lbl">Szint</div>${seg("hills", [["flat", "Sík"], ["hilly", "Dombos"], ["any", "Bármi"]], st.hills)}</div>`;
  const ready = st.start && (st.loop || st.end);
  $("sgGo").disabled = !ready || st.busy;
  $("sgHint").textContent = !st.start ? "Bökj a térképre a rajthoz, vagy használd a saját helyed."
    : !st.loop && !st.end ? "Most bökj a térképre a célhoz." : "";
  window.lucide?.createIcons({ nodes: [form] });
}

function renderResults() {
  const box = $("sgResults");
  if (!st.results.length) { box.innerHTML = ""; return; }
  const r = st.results;
  box.innerHTML = `<div class="sg-res-h"><b>${r.length} javaslat</b><span>${st.km} km körül · ${st.loop ? "kör" : "A → B"}</span></div>` +
    (r[0]?.nearEnd ? `<p class="sg-note">A cél közel van a rajthoz, ezért körszerű útvonalak – a célnál érnek véget.</p>` : "") +
    (r.every((c) => c.warn?.length) ? `<p class="sg-note">A rajt környékén nem találtam teljesen ${[st.hills === "flat" ? "sík" : "", st.surface === "asphalt" ? "aszfaltos" : ""].filter(Boolean).join(" és ")} ${st.loop ? "kört" : "útvonalat"} – ezek állnak hozzá a legközelebb. Más rajtpont vagy táv segíthet.</p>` : "") +
    r.map((c, i) => {
      const mix = Object.entries(c.mix).filter(([, v]) => v > 0.01).sort((a, b) => b[1] - a[1]);
      return `<div class="sg-card${i === st.selected ? " is-sel" : ""}" data-sg-sel="${i}">
        <div class="sg-ct"><span class="sg-sw" style="background:${COLORS[i]}"></span><b>${escapeHtml(c.name || `${i + 1}. javaslat`)}</b>${i === 0 ? '<em>Legjobb</em>' : ""}</div>
        <div class="sg-nums"><span><b>${num(c.distanceMeters / 1000, 1)}</b> km</span><span><b>${Math.round(c.ascentMeters)}</b> m szint</span>
          <span><b>${Math.round((c.mix.asphalt || 0) * 100)}%</b> aszfalt</span>
          ${1 - (c.mix.asphalt || 0) > 0.05 ? `<span><b>${Math.round((1 - (c.mix.asphalt || 0)) * 100)}%</b> burkolatlan</span>` : ""}</div>
        ${c.warn?.length ? `<div class="sg-warn">Nem egészen a kérés szerinti: ${c.warn.map(escapeHtml).join(", ")}</div>` : ""}
        <div class="sg-mix">${mix.map(([m, v]) => `<span style="flex:${v};background:${SURF_COLORS[m] || "#999"}" title="${SURF_LABEL[m] || m} ${Math.round(v * 100)}%"></span>`).join("")}</div>
        ${i === st.selected ? `<button type="button" class="sg-use" data-sg-act="use"><i data-lucide="check" aria-hidden="true"></i>Ezt választom</button>` : ""}
      </div>`;
    }).join("");
  window.lucide?.createIcons({ nodes: [box] });
}

function drawResults(fit) {
  _d.mapAdapter.showSuggestions(st.results.map((c, i) => ({ geometry: c.geometry, color: COLORS[i], onSelect: () => select(i) })), st.selected, { fit });
}

// Égtáj a rajtból a legtávolabbi pont felé („Északi kör”)
function compass(a, b) {
  const y = Math.sin((b.lng - a.lng) * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180);
  const x = Math.cos(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180)
          - Math.sin(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.cos((b.lng - a.lng) * Math.PI / 180);
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return ["Északi", "Északkeleti", "Keleti", "Délkeleti", "Déli", "Délnyugati", "Nyugati", "Északnyugati"][Math.round(deg / 45) % 8];
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
      { start: st.start, end: st.end, km: st.km, loop: st.loop, surface: st.surface, hills: st.hills },
      (wps, mode) => _d.mapAdapter.routeStrict(wps, mode),
      (done, total) => { status.innerHTML = `<span class="spinner-inline"></span> Útvonalak számolása… ${done}/${total}`; });
    if (!res.length) throw new Error("Nem sikerült útvonalat tervezni – próbáld másik rajttal vagy távval.");
    st.results = res; st.selected = 0;
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
  if (b.dataset.sgSurface) { if (st.surface !== b.dataset.sgSurface) { st.surface = b.dataset.sgSurface; renderForm(); optionsChanged(); } return; }
  if (b.dataset.sgHills) { if (st.hills !== b.dataset.sgHills) { st.hills = b.dataset.sgHills; renderForm(); optionsChanged(); } return; }
  if (b.dataset.sgPick) { st.picking = b.dataset.sgPick; renderForm(); if (st[st.picking]) _d.mapAdapter.panTo(st[st.picking]); return; }
  if (b.closest("[data-sg-sel]") && !b.dataset.sgAct) return;
  const act = b.dataset.sgAct;
  if (act === "close") close();
  else if (act === "go") run();
  else if (act === "use") apply();
  else if (act === "locate") locate(b);
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
