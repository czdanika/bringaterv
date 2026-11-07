/**
 * Bringaterv – Felszerelés (főmenüpont)
 * ===================================
 * Bringák, alkatrészek (felszerelési időablakkal), karbantartási feladatok (km / üzemóra /
 * nap) és napló; a fájlokból / Stravából felismert bringák és eszközök; tömeges
 * hozzárendelés. Az adat a szerveren (/api/gear), a km-et és az állapotot is a szerver
 * számolja – lásd src/equipment.js (gyorsítótár) és routes-api/gear.py.
 */

import { routesApi } from "../api/routesApi.js";
import { BIKE_TYPES, getGear, getGearUsage, isCycling, loadGear, markTaskDone, resolveBike, saveGear } from "../equipment.js";
import { num } from "../format.js";

const KINDS = { chain: "Lánc", tire: "Gumi", brake: "Fékbetét", cassette: "Kazetta", chainring: "Lánctányér",
                wheel: "Kerék", cable: "Bowden / ház", battery: "Elem / akku", other: "Egyéb" };
const UNITS = { km: "km", hours: "üzemóra", days: "nap" };
const UNIT_SHORT = { km: "km", hours: "ó", days: "nap" };
// Javasolt feladatok – alkatrész-típus szerint (a felvételkor előre kitöltve)
const TASK_PRESETS = [
  { name: "Csere", unit: "km", interval: 3000, kind: "chain", label: "Lánc csere – 3000 km" },
  { name: "Láncolajozás", unit: "km", interval: 300, kind: "chain", label: "Láncolajozás – 300 km" },
  { name: "Csere", unit: "km", interval: 4000, kind: "tire", label: "Gumi csere – 4000 km" },
  { name: "Csere", unit: "km", interval: 2000, kind: "brake", label: "Fékbetét csere – 2000 km" },
  { name: "Csere", unit: "km", interval: 9000, kind: "cassette", label: "Kazetta csere – 9000 km" },
  { name: "Nagyszerviz", unit: "days", interval: 365, kind: null, label: "Nagyszerviz – évente" },
  { name: "Átvizsgálás", unit: "hours", interval: 50, kind: null, label: "Átvizsgálás – 50 üzemóra" },
  { name: "Elemcsere", unit: "days", interval: 365, kind: "battery", label: "Elemcsere – évente" },
];

let _container = null;
let _getWorkouts = () => [];
let _onAssigned = () => {};
let _showRetired = false;
let _toast = () => {};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const uid = (p) => p + Math.random().toString(36).slice(2, 9);
const fmtMin = (m) => { const h = Math.floor((m || 0) / 60); return h ? `${h} ó ${Math.round(m % 60)} p` : `${Math.round(m || 0)} p`; };
const clone = (o) => JSON.parse(JSON.stringify(o));

export function initGear({ getWorkouts, onAssigned, showToast } = {}) {
  _getWorkouts = getWorkouts || _getWorkouts;
  _onAssigned = onAssigned || _onAssigned;
  _toast = showToast || _toast;
  window.addEventListener("bringaterv:gearChanged", () => { if (_container && !_container.hidden) render(); });
}

/** A main.js switchTab("gear") hívja. */
export async function renderGearView(container) {
  _container = container;
  if (!container.dataset.bound) {
    container.dataset.bound = "1";
    container.addEventListener("click", onClick);
    container.addEventListener("change", onChange);
  }
  if (!getGearUsage()) {
    container.innerHTML = `<div class="gear-loading">Felszerelés betöltése…</div>`;
    await loadGear(true);
  }
  render();
}

// ── Fotók: átméretezés feltöltés előtt, betöltés bejelentkezve (blob) ─────────
const PHOTO_MAX_PX = 1280;
const _photoUrls = new Map();                     // fájlnév → objectURL (egyszer töltjük le)

/** Kép → JPEG blob, a hosszabb oldal legfeljebb PHOTO_MAX_PX; a telefonos (EXIF) elforgatást
 *  a böngésző kezeli. Ha még mindig nagy, erősebb tömörítés. */
async function resizeImage(file) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    src = await new Promise((ok, fail) => {
      const img = new Image(); img.onload = () => ok(img); img.onerror = fail; img.src = URL.createObjectURL(file);
    });
  }
  const w = src.width, h = src.height, sc = Math.min(1, PHOTO_MAX_PX / Math.max(w, h));
  const cv = document.createElement("canvas");
  cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
  cv.getContext("2d").drawImage(src, 0, 0, cv.width, cv.height);
  const enc = (q) => new Promise((ok) => cv.toBlob(ok, "image/jpeg", q));
  let blob = await enc(0.82);
  if (blob.size > 450_000) blob = await enc(0.7);
  return blob;
}

async function photoUrl(name) {
  if (!_photoUrls.has(name)) _photoUrls.set(name, routesApi.gear.photoBlob(name).then((b) => URL.createObjectURL(b)).catch(() => null));
  return _photoUrls.get(name);
}

function hydratePhotos() {
  _container?.querySelectorAll("[data-photo-name]").forEach(async (el) => {
    const url = el.dataset.photoName && await photoUrl(el.dataset.photoName);
    if (url && el.isConnected) { el.style.backgroundImage = `url("${url}")`; el.classList.add("has-photo"); }
  });
}

function photoBtn(type, item, small = false) {
  return `<button type="button" class="gear-photo${small ? " gear-photo--sm" : ""}" data-photo-pick="${type}|${esc(item.id)}"
    ${item.photo ? `data-photo-name="${esc(item.photo)}" title="Fotó megnyitása"` : `title="Fotó hozzáadása"`} aria-label="Fotó">
    ${item.photo ? "" : `<i data-lucide="camera" aria-hidden="true"></i>`}</button>`;
}

function pickAndUpload(type, id) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*";
  inp.onchange = async () => {
    const file = inp.files?.[0];
    if (!file) return;
    _toast("Kép feldolgozása…", 15000);
    try {
      const blob = await resizeImage(file);
      const res = await routesApi.gear.uploadPhoto(type, id, blob);
      _toast(`Fotó feltöltve (${Math.round(blob.size / 1024)} KB)`);
      await loadGear(true);
      return res;
    } catch (err) { _toast("A fotó feltöltése nem sikerült: " + err.message, 6000); }
  };
  inp.click();
}

async function openPhoto(type, id, name, title) {
  const url = await photoUrl(name);
  const ov = document.createElement("div");
  ov.className = "shortcut-overlay gear-modal-overlay";
  ov.innerHTML = `<div class="export-panel gear-modal gear-photo-view" role="dialog" aria-modal="true">
    <div class="export-header"><h3>${esc(title)}</h3><button type="button" class="shortcut-close" data-x aria-label="Bezárás">×</button></div>
    <div class="export-body">${url ? `<img src="${url}" alt="${esc(title)}">` : `<p class="gear-muted">A kép nem tölthető be.</p>`}</div>
    <div class="export-footer">
      <button type="button" class="export-confirm-btn export-confirm-btn--secondary" data-del>Fotó törlése</button>
      <button type="button" class="export-confirm-btn export-confirm-btn--primary" data-change>Csere</button>
    </div></div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", async (e) => {
    if (e.target === ov || e.target.closest("[data-x]")) return ov.remove();
    if (e.target.closest("[data-change]")) { ov.remove(); pickAndUpload(type, id); }
    if (e.target.closest("[data-del]")) {
      if (!confirm("Törlöd a fotót?")) return;
      try { await routesApi.gear.deletePhoto(type, id); ov.remove(); await loadGear(true); }
      catch (err) { _toast("Nem sikerült törölni: " + err.message); }
    }
  });
}

// ── Kirajzolás ────────────────────────────────────────────────────────────────
function progressBar(t) {
  const pct = Math.min(100, Math.round(t.pct * 100));
  return `<div class="gear-task gear-task--${t.status}">
    <div class="gear-task-head"><span>${esc(t.name)}</span>
      <b>${num(t.used, 0)} / ${num(t.interval, 0)} ${UNIT_SHORT[t.unit]}${t.status === "due" ? " · esedékes" : t.status === "soon" ? " · hamarosan" : ""}</b></div>
    <div class="gear-bar"><i style="width:${pct}%"></i></div>
    <div class="gear-task-foot"><small>${t.since && t.since !== "0000-00-00" ? `utoljára: ${esc(t.since)}` : "még nem volt"}</small>
      <button type="button" class="gear-link" data-done="${esc(t.target_type)}|${esc(t.target_id)}|${esc(t.task_id)}">Elvégezve</button>
      <button type="button" class="gear-link" data-task-edit="${esc(t.target_type)}|${esc(t.target_id)}|${esc(t.task_id)}">Szerkesztés</button></div>
  </div>`;
}

function render() {
  if (!_container) return;
  const gear = getGear(), u = getGearUsage() || { bikes: {}, components: {}, tasks: [], unknown_bikes: [], devices: [] };
  const tasksOf = (type, id) => u.tasks.filter((t) => t.target_type === type && t.target_id === id);
  const todo = u.tasks.filter((t) => t.status !== "ok" && !t.retired);
  const bikes = gear.bikes.filter((b) => _showRetired || !b.retired);
  const installedOn = (bid) => gear.components.filter((c) => u.components[c.id]?.bike_id === bid && (_showRetired || !c.retired));
  const stock = gear.components.filter((c) => !u.components[c.id]?.bike_id && (_showRetired || !c.retired));

  const bikeCards = bikes.map((b) => {
    const s = u.bikes[b.id] || {};
    const comps = installedOn(b.id).map((c) => {
      const cu = u.components[c.id] || {};
      return `<div class="gear-comp">
        <div class="gear-comp-head">${photoBtn("component", c, true)}<b>${esc(c.name)}</b><small>${esc([KINDS[c.kind], c.brand].filter(Boolean).join(" · "))}</small>
          <span>${num(cu.km || 0, 0)} km</span>
          <button type="button" class="gear-link" data-comp-edit="${esc(c.id)}">Szerkesztés</button></div>
        ${tasksOf("component", c.id).map(progressBar).join("")}
      </div>`;
    }).join("");
    return `<article class="gear-card${b.retired ? " is-retired" : ""}">
      <header class="gear-card-head">
        ${photoBtn("bike", b)}
        <div class="gear-card-title"><h3>${esc(b.name)}${b.is_default ? ` <span class="gear-pill">alapértelmezett</span>` : ""}${b.retired ? ` <span class="gear-pill">nyugdíjazva</span>` : ""}</h3>
          <small>${esc([b.brand, b.model, BIKE_TYPES[b.type], b.weight ? `${num(b.weight, 1)} kg` : ""].filter(Boolean).join(" · "))}</small></div>
        <button type="button" class="strava-conn-btn strava-conn-btn--ghost" data-bike-edit="${esc(b.id)}">Szerkesztés</button>
      </header>
      <div class="gear-stats">
        <div><b>${num(s.km || 0, 0)}</b><span>km${b.start_km ? ` (ebből ${num(b.start_km, 0)} kezdő)` : ""}</span></div>
        <div><b>${s.count || 0}</b><span>edzés</span></div>
        <div><b>${fmtMin(s.min)}</b><span>idő</span></div>
        <div><b>${num(s.year_km || 0, 0)}</b><span>km idén</span></div>
        ${s.elev ? `<div><b>${num(s.elev, 0)}</b><span>m szint</span></div>` : ""}
      </div>
      ${s.last ? `<p class="gear-muted">Utolsó edzés: ${esc(s.last)}${(b.aliases || []).length ? ` · más néven: ${esc(b.aliases.join(", "))}` : ""}</p>` : (b.aliases || []).length ? `<p class="gear-muted">Más néven: ${esc(b.aliases.join(", "))}</p>` : ""}
      ${tasksOf("bike", b.id).map(progressBar).join("")}
      ${comps ? `<div class="gear-comps"><p class="gear-sub">Alkatrészek</p>${comps}</div>` : ""}
      <div class="gear-actions">
        <button type="button" class="strava-conn-btn strava-conn-btn--ghost" data-comp-new="${esc(b.id)}">+ Alkatrész</button>
        <button type="button" class="strava-conn-btn strava-conn-btn--ghost" data-task-new="bike|${esc(b.id)}">+ Feladat</button>
        <button type="button" class="strava-conn-btn strava-conn-btn--ghost" data-assign="${esc(b.id)}">Edzések hozzárendelése…</button>
      </div>
    </article>`;
  }).join("");

  const stockHtml = stock.length ? `<section class="gear-section"><h2>Raktárban <small>(nincs bringára szerelve)</small></h2>
    ${stock.map((c) => `<div class="gear-comp gear-comp--stock"><div class="gear-comp-head">${photoBtn("component", c, true)}<b>${esc(c.name)}</b>
      <small>${esc([KINDS[c.kind], c.brand].filter(Boolean).join(" · "))}</small><span>${num(u.components[c.id]?.km || 0, 0)} km</span>
      <button type="button" class="gear-link" data-comp-edit="${esc(c.id)}">Szerkesztés</button></div>
      ${tasksOf("component", c.id).map(progressBar).join("")}</div>`).join("")}</section>` : "";

  const unknownHtml = u.unknown_bikes.length ? `<section class="gear-section"><h2>Felismert bringák <small>(a fájlokból / Stravából – még nincsenek a listádban)</small></h2>
    ${u.unknown_bikes.map((x) => `<div class="gear-row"><span><b>${esc(x.name)}</b> <small>${x.count} edzés · ${num(x.km, 0)} km</small></span>
      <button type="button" class="strava-conn-btn strava-conn-btn--ghost" data-adopt="${esc(x.name)}">Felvétel</button>
      ${gear.bikes.length ? `<select class="form-input" data-alias="${esc(x.name)}"><option value="">Ugyanaz, mint…</option>${gear.bikes.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("")}</select>` : ""}
    </div>`).join("")}</section>` : "";

  const devHtml = u.devices.length ? `<section class="gear-section"><h2>Eszközök <small>(rögzítők – a fájlokból / Stravából)</small></h2>
    ${u.devices.map((d) => `<div class="gear-row"><span><b>${esc(d.name)}</b> <small>${d.count} edzés · ${num(d.km, 0)} km · ${fmtMin(d.min)}${d.last ? ` · utoljára ${esc(d.last)}` : ""}</small></span></div>`).join("")}</section>` : "";

  const logs = [...gear.logs].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30);
  const nameOf = (lg) => lg.target_type === "bike" ? gear.bikes.find((b) => b.id === lg.target_id)?.name
    : gear.components.find((c) => c.id === lg.target_id)?.name;
  const logHtml = logs.length ? `<section class="gear-section"><details><summary><h2>Karbantartási napló <small>(${gear.logs.length})</small></h2></summary>
    ${logs.map((lg) => `<div class="gear-row"><span><b>${esc(lg.date)}</b> · ${esc(nameOf(lg) || "—")} – ${esc(lg.task_name || "")}${lg.cost ? ` · ${num(lg.cost, 0)} Ft` : ""}${lg.note ? ` <small>${esc(lg.note)}</small>` : ""}</span>
      <button type="button" class="gear-link" data-log-del="${esc(lg.id)}">Törlés</button></div>`).join("")}</details></section>` : "";

  _container.innerHTML = `
    <div class="gear-top">
      <button type="button" class="strava-conn-btn" data-bike-new>+ Bringa</button>
      <button type="button" class="strava-conn-btn strava-conn-btn--ghost" data-comp-new="">+ Alkatrész</button>
      <label class="gear-toggle"><input type="checkbox" data-retired-toggle${_showRetired ? " checked" : ""}> nyugdíjazottak is</label>
    </div>
    ${todo.length ? `<section class="gear-section gear-todo"><h2>Teendők</h2>
      ${todo.map((t) => `<div class="gear-todo-item"><p class="gear-sub">${esc(t.target_name)}${t.target_type === "component" && t.bike_name ? ` · ${esc(t.bike_name)}` : ""}</p>${progressBar(t)}</div>`).join("")}</section>` : ""}
    ${bikeCards || `<div class="gear-empty"><p>Még nincs bringa a listádban.</p><p class="gear-muted">Vedd fel a bringáidat – vagy lent a fájlokból / Stravából felismert neveket egy kattintással. Utána alkatrészeket (lánc, gumi, fékbetét…) és karbantartási emlékeztetőket adhatsz hozzá; a km magától számolódik az edzéseidből.</p></div>`}
    ${stockHtml}${unknownHtml}${devHtml}${logHtml}`;
  window.lucide?.createIcons({ nodes: [_container] });
  hydratePhotos();
}

// ── Mentés segédek ────────────────────────────────────────────────────────────
async function mutate(fn, okMsg) {
  const doc = clone(getGear());
  fn(doc);
  try {
    await saveGear(doc);
    if (okMsg) _toast(okMsg);
  } catch (err) { _toast("Nem sikerült menteni: " + err.message); }
}

function findTarget(doc, type, id) {
  return (type === "bike" ? doc.bikes : doc.components).find((x) => x.id === id);
}

// ── Űrlap-ablak ──────────────────────────────────────────────────────────────
function openForm({ title, fields, onSave, onDelete, deleteLabel = "Törlés", extra = "" }) {
  const ov = document.createElement("div");
  ov.className = "shortcut-overlay gear-modal-overlay";
  const field = (f) => {
    const v = f.value ?? "";
    if (f.type === "select") return `<label class="gear-field"><span>${f.label}</span><select class="form-input" name="${f.key}">
      ${f.options.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
    if (f.type === "checkbox") return `<label class="gear-check"><input type="checkbox" name="${f.key}"${v ? " checked" : ""}> ${f.label}</label>`;
    if (f.type === "textarea") return `<label class="gear-field"><span>${f.label}</span><textarea class="form-input" name="${f.key}" rows="2">${esc(v)}</textarea></label>`;
    return `<label class="gear-field"><span>${f.label}</span><input class="form-input" name="${f.key}" type="${f.type || "text"}"
      value="${esc(v)}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ""}${f.step ? ` step="${f.step}"` : ""}${f.min != null ? ` min="${f.min}"` : ""}></label>`;
  };
  ov.innerHTML = `<div class="export-panel gear-modal" role="dialog" aria-modal="true">
    <div class="export-header"><h3>${esc(title)}</h3><button type="button" class="shortcut-close" data-x aria-label="Bezárás">×</button></div>
    <div class="export-body">${extra}${fields.map(field).join("")}</div>
    <div class="export-footer">
      ${onDelete ? `<button type="button" class="export-confirm-btn export-confirm-btn--secondary" data-del>${esc(deleteLabel)}</button>` : ""}
      <button type="button" class="export-confirm-btn export-confirm-btn--primary" data-save>Mentés</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  const values = () => Object.fromEntries(fields.map((f) => {
    const el = ov.querySelector(`[name="${f.key}"]`);
    return [f.key, f.type === "checkbox" ? el.checked : el.value.trim()];
  }));
  ov.addEventListener("click", async (e) => {
    if (e.target === ov || e.target.closest("[data-x]")) return close();
    if (e.target.closest("[data-save]")) { if ((await onSave(values(), ov)) !== false) close(); }
    if (e.target.closest("[data-del]") && onDelete) { if ((await onDelete()) !== false) close(); }
  });
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  ov.querySelector("input,select,textarea")?.focus();
  return ov;
}

const bikeOptions = (withNone) => [...(withNone ? [["", "— raktárban (nincs felszerelve) —"]] : []),
  ...getGear().bikes.filter((b) => !b.retired).map((b) => [b.id, b.name])];

function bikeForm(b) {
  const isNew = !b;
  b = b || { name: "", type: "road", aliases: [] };
  openForm({
    title: isNew ? "Új bringa" : `Bringa: ${b.name}`,
    fields: [
      { key: "name", label: "Név", value: b.name, placeholder: "pl. Cube AIM EX" },
      { key: "brand", label: "Márka", value: b.brand }, { key: "model", label: "Modell", value: b.model },
      { key: "type", label: "Típus", type: "select", value: b.type, options: Object.entries(BIKE_TYPES) },
      { key: "weight", label: "Súly (kg)", type: "number", step: "0.1", value: b.weight },
      { key: "start_km", label: "Kezdő km (ami az első itteni edzés előtt már rajta volt)", type: "number", min: 0, value: b.start_km || "" },
      { key: "purchase_date", label: "Vásárlás dátuma", type: "date", value: b.purchase_date },
      { key: "price", label: "Ár (Ft)", type: "number", min: 0, value: b.price },
      { key: "aliases", label: "Más néven (vesszővel) – a komputer / Strava ezeken a neveken is küldheti", value: (b.aliases || []).join(", "), placeholder: "pl. Cube, Bike1" },
      { key: "is_default", label: "Alapértelmezett (a bringa nélküli kerékpáros edzések ide számítanak)", type: "checkbox", value: b.is_default },
      { key: "retired", label: "Nyugdíjazva (nem használom már)", type: "checkbox", value: b.retired },
      { key: "notes", label: "Megjegyzés", type: "textarea", value: b.notes },
    ],
    onDelete: isNew ? null : () => {
      if (!confirm(`Törlöd: „${b.name}”? Az edzések megmaradnak; a rajta lévő alkatrészek a raktárba kerülnek.`)) return false;
      return mutate((doc) => {
        doc.bikes = doc.bikes.filter((x) => x.id !== b.id);
        for (const c of doc.components) c.installs = (c.installs || []).filter((i) => i.bike_id !== b.id);
      }, "Bringa törölve");
    },
    onSave: (v) => {
      if (!v.name) { _toast("Adj nevet a bringának."); return false; }
      const data = { ...v, aliases: v.aliases.split(",").map((s) => s.trim()).filter(Boolean),
                     weight: Number(v.weight) || null, start_km: Number(v.start_km) || 0, price: Number(v.price) || null,
                     purchase_date: v.purchase_date || null };
      return mutate((doc) => {
        if (data.is_default) doc.bikes.forEach((x) => { x.is_default = false; });
        if (isNew) doc.bikes.push({ id: uid("b"), tasks: [], ...data });
        else Object.assign(doc.bikes.find((x) => x.id === b.id), data);
      }, isNew ? `„${data.name}” felvéve` : "Mentve");
    },
  });
}

function componentForm(c, presetBikeId) {
  const isNew = !c;
  const cur = c ? (getGearUsage()?.components[c.id]?.bike_id || "") : (presetBikeId || "");
  c = c || { name: "", kind: "chain" };
  openForm({
    title: isNew ? "Új alkatrész" : `Alkatrész: ${c.name}`,
    fields: [
      { key: "kind", label: "Típus", type: "select", value: c.kind, options: Object.entries(KINDS) },
      { key: "name", label: "Név", value: c.name, placeholder: "pl. Shimano lánc" },
      { key: "brand", label: "Márka / típus", value: c.brand },
      { key: "bike_id", label: "Melyik bringán van", type: "select", value: cur, options: bikeOptions(true) },
      { key: "from", label: isNew ? "Felszerelés napja" : "Áthelyezés / felszerelés napja (ha bringát váltasz)", type: "date", value: today() },
      { key: "price", label: "Ár (Ft)", type: "number", min: 0, value: c.price },
      ...(isNew ? [{ key: "preset", label: "Emlékeztető", type: "select", value: "auto",
        options: [["auto", "Javasolt a típushoz"], ["", "Most nem kérek"]] }] : []),
      { key: "retired", label: "Kiselejtezve", type: "checkbox", value: c.retired },
      { key: "notes", label: "Megjegyzés", type: "textarea", value: c.notes },
    ],
    onDelete: isNew ? null : () => {
      if (!confirm(`Törlöd: „${c.name}”? A karbantartási napló bejegyzései is törlődnek.`)) return false;
      return mutate((doc) => {
        doc.components = doc.components.filter((x) => x.id !== c.id);
        doc.logs = doc.logs.filter((l) => l.target_id !== c.id);
      }, "Alkatrész törölve");
    },
    onSave: (v) => {
      const name = v.name || KINDS[v.kind];
      const from = v.from || today();
      return mutate((doc) => {
        let comp = isNew ? null : doc.components.find((x) => x.id === c.id);
        if (isNew) {
          comp = { id: uid("c"), installs: [], tasks: [] };
          if (v.preset === "auto") {
            comp.tasks = TASK_PRESETS.filter((p) => p.kind === v.kind).slice(0, 2)
              .map((p) => ({ id: uid("t"), name: p.name, unit: p.unit, interval: p.interval, last_done: from }));
          }
          doc.components.push(comp);
        }
        Object.assign(comp, { name, kind: v.kind, brand: v.brand, price: Number(v.price) || null, notes: v.notes, retired: v.retired });
        // bringa-váltás: a mostani felszerelés lezárul, új kezdődik (a km így bringánként helyes)
        const open = (comp.installs || []).find((i) => !i.until);
        if ((open?.bike_id || "") !== v.bike_id) {
          if (open) open.until = from;
          if (v.bike_id) comp.installs.push({ bike_id: v.bike_id, from, until: null });
        }
      }, isNew ? `„${name}” felvéve` : "Mentve");
    },
  });
}

function taskForm(type, id, taskId) {
  const doc = getGear();
  const target = findTarget(doc, type, id);
  if (!target) return;
  const t = (target.tasks || []).find((x) => x.id === taskId);
  const isNew = !t;
  const presets = TASK_PRESETS.filter((p) => type === "bike" ? !p.kind : (p.kind === target.kind || !p.kind));
  const ov = openForm({
    title: isNew ? `Új feladat: ${target.name}` : `Feladat: ${t.name}`,
    extra: isNew ? `<label class="gear-field"><span>Javaslat</span><select class="form-input" data-preset>
      <option value="">— válassz, vagy töltsd ki lent —</option>${presets.map((p, i) => `<option value="${i}">${esc(p.label)}</option>`).join("")}</select></label>` : "",
    fields: [
      { key: "name", label: "Feladat", value: t?.name, placeholder: "pl. Lánc csere" },
      { key: "unit", label: "Gyakoriság alapja", type: "select", value: t?.unit || "km", options: Object.entries(UNITS) },
      { key: "interval", label: "Ennyi után esedékes", type: "number", min: 1, value: t?.interval },
      { key: "last_done", label: "Utoljára elvégezve (üresen: a felszerelés / vásárlás napjától számol)", type: "date", value: t?.last_done || (isNew ? today() : "") },
    ],
    onDelete: isNew ? null : () => mutate((d) => {
      const tg = findTarget(d, type, id); tg.tasks = tg.tasks.filter((x) => x.id !== taskId);
    }, "Feladat törölve"),
    onSave: (v) => {
      const interval = Number(v.interval);
      if (!v.name || !(interval > 0)) { _toast("Add meg a feladatot és a határt."); return false; }
      return mutate((d) => {
        const tg = findTarget(d, type, id);
        const data = { name: v.name, unit: v.unit, interval, last_done: v.last_done || null };
        if (isNew) (tg.tasks ||= []).push({ id: uid("t"), ...data });
        else Object.assign(tg.tasks.find((x) => x.id === taskId), data);
      }, "Mentve");
    },
  });
  ov.querySelector("[data-preset]")?.addEventListener("change", (e) => {
    const p = presets[Number(e.target.value)];
    if (!p) return;
    ov.querySelector('[name="name"]').value = p.name;
    ov.querySelector('[name="unit"]').value = p.unit;
    ov.querySelector('[name="interval"]').value = p.interval;
  });
}

function doneForm(type, id, taskId) {
  const target = findTarget(getGear(), type, id);
  const t = target?.tasks?.find((x) => x.id === taskId);
  if (!t) return;
  openForm({
    title: `Elvégezve: ${target.name} – ${t.name}`,
    fields: [
      { key: "date", label: "Mikor", type: "date", value: today() },
      { key: "cost", label: "Költség (Ft, nem kötelező)", type: "number", min: 0 },
      { key: "note", label: "Megjegyzés", value: "", placeholder: "pl. KMC X11 lánc" },
    ],
    onSave: async (v) => {
      try {
        await markTaskDone({ target_type: type, target_id: id, task_id: taskId, date: v.date, cost: Number(v.cost) || null, note: v.note });
        _toast("Rögzítve – a számláló újraindult");
      } catch (err) { _toast("Nem sikerült menteni: " + err.message); return false; }
    },
  });
}

// ── Tömeges hozzárendelés ─────────────────────────────────────────────────────
function assignDialog(bikeId) {
  const bike = getGear().bikes.find((b) => b.id === bikeId);
  // bringát csak kerékpáros edzéshez rendelünk (séta, futás, túra nem jelenik meg)
  const workouts = _getWorkouts().filter(isCycling)
    .sort((a, b) => ((a.start_time || a.date) < (b.start_time || b.date) ? 1 : -1));
  const devices = [...new Set(workouts.map((w) => w.device).filter(Boolean))];
  const ov = document.createElement("div");
  ov.className = "shortcut-overlay gear-modal-overlay";
  ov.innerHTML = `<div class="export-panel gear-modal gear-assign" role="dialog" aria-modal="true">
    <div class="export-header"><h3>Edzések → ${esc(bike.name)}</h3><button type="button" class="shortcut-close" data-x aria-label="Bezárás">×</button></div>
    <div class="export-body">
      <div class="gear-assign-filters">
        <label class="gear-check"><input type="checkbox" data-f-unassigned checked> csak bringa nélküliek / más bringájúak</label>
        ${devices.length ? `<select class="form-input" data-f-device><option value="">Minden eszköz</option>${devices.map((d) => `<option>${esc(d)}</option>`).join("")}</select>` : ""}
        <input class="form-input" data-f-from type="date" title="ettől">
        <input class="form-input" data-f-to type="date" title="eddig">
        <label class="gear-check"><input type="checkbox" data-all> mind kijelölése</label>
      </div>
      <div class="gear-assign-list" data-list></div>
    </div>
    <div class="export-footer">
      <button type="button" class="export-confirm-btn export-confirm-btn--secondary" data-auto title="A kijelöltek vissza automatikusra (fájl / Strava / alapértelmezett)">Automatikusra</button>
      <button type="button" class="export-confirm-btn export-confirm-btn--primary" data-save>Hozzárendelés</button>
    </div></div>`;
  document.body.appendChild(ov);
  const q = (s) => ov.querySelector(s);
  const draw = () => {
    const onlyOther = q("[data-f-unassigned]").checked, dev = q("[data-f-device]")?.value || "";
    const from = q("[data-f-from]").value, to = q("[data-f-to]").value;
    const rows = workouts.filter((w) => {
      const d = (w.start_time || w.date || "").slice(0, 10);
      const r = resolveBike(w);
      return (!onlyOther || r?.id !== bikeId) && (!dev || w.device === dev) && (!from || d >= from) && (!to || d <= to);
    });
    q("[data-list]").innerHTML = rows.length ? rows.map((w) => `<label class="gear-assign-row">
        <input type="checkbox" value="${esc(w.id)}">
        <span class="gear-assign-date">${esc((w.start_time || w.date || "").slice(0, 10))}</span>
        <span class="gear-assign-name">${esc(w.name || "Edzés")}</span>
        <span>${num(Number(w.distance) || 0, 1)} km</span>
        <small>${esc(resolveBike(w)?.name || "—")}${w.device ? " · " + esc(w.device) : ""}</small></label>`).join("")
      : `<p class="gear-muted">Nincs a szűrésnek megfelelő edzés.</p>`;
  };
  draw();
  ov.addEventListener("change", (e) => {
    if (e.target.matches("[data-all]")) ov.querySelectorAll("[data-list] input").forEach((c) => { c.checked = e.target.checked; });
    else if (e.target.closest(".gear-assign-filters")) draw();
  });
  const run = async (target) => {
    const ids = [...ov.querySelectorAll("[data-list] input:checked")].map((c) => c.value);
    if (!ids.length) { _toast("Jelölj ki legalább egy edzést."); return; }
    try {
      const r = await routesApi.gear.bulkBike(ids, target);
      _toast(`${r.updated} edzés ${target ? `→ ${bike.name}` : "→ automatikus"}`);
      ov.remove();
      await _onAssigned();
      await loadGear(true);
    } catch (err) { _toast("Nem sikerült: " + err.message); }
  };
  ov.addEventListener("click", (e) => {
    if (e.target === ov || e.target.closest("[data-x]")) ov.remove();
    else if (e.target.closest("[data-save]")) run(bikeId);
    else if (e.target.closest("[data-auto]")) run("");
  });
}

// ── Események ────────────────────────────────────────────────────────────────
function onClick(e) {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  const gear = getGear();
  if (d.photoPick) {
    const [type, id] = d.photoPick.split("|");
    const item = (type === "bike" ? gear.bikes : gear.components).find((x) => x.id === id);
    return item?.photo ? openPhoto(type, id, item.photo, item.name) : pickAndUpload(type, id);
  }
  if ("bikeNew" in d) return bikeForm(null);
  if (d.bikeEdit) return bikeForm(gear.bikes.find((b) => b.id === d.bikeEdit));
  if ("compNew" in d) return componentForm(null, d.compNew);
  if (d.compEdit) return componentForm(gear.components.find((c) => c.id === d.compEdit));
  if (d.taskNew) { const [type, id] = d.taskNew.split("|"); return taskForm(type, id, null); }
  if (d.taskEdit) { const [type, id, tid] = d.taskEdit.split("|"); return taskForm(type, id, tid); }
  if (d.done) { const [type, id, tid] = d.done.split("|"); return doneForm(type, id, tid); }
  if (d.assign) return assignDialog(d.assign);
  if (d.adopt) {
    return mutate((doc) => doc.bikes.push({ id: uid("b"), name: d.adopt, type: "road", aliases: [], tasks: [],
                                            is_default: !doc.bikes.length }), `„${d.adopt}” felvéve`);
  }
  if (d.logDel) {
    if (!confirm("Törlöd ezt a naplóbejegyzést? (A feladat számlálóját nem állítja vissza.)")) return;
    return mutate((doc) => { doc.logs = doc.logs.filter((l) => l.id !== d.logDel); });
  }
}

function onChange(e) {
  if (e.target.matches("[data-retired-toggle]")) { _showRetired = e.target.checked; render(); return; }
  const sel = e.target.closest("select[data-alias]");
  if (!sel || !sel.value) return;
  const alias = sel.dataset.alias;
  mutate((doc) => {
    const b = doc.bikes.find((x) => x.id === sel.value);
    if (b && !(b.aliases || []).some((a) => a.toLowerCase() === alias.toLowerCase())) (b.aliases ||= []).push(alias);
  }, `„${alias}” ezentúl ugyanaz a bringa`);
}
