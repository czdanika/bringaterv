// ── Turistajelzések a térkép egy pontján ─────────────────────────────────────
// Jobb gomb (asztalon) / hosszú érintés (telefonon) a térképen: ablak a ponton futó
// jelzésekkel (jelzéskép, jel, név). Egy jelzést kiválasztva kiemelődik a térképen, és
// - „Pont ide ezen a jelzésen”: a jelzésre illesztett új pont; az előző ponttól a jelzésen vezet,
// - „Egész jelzés tervként”: a jelzés elejétől a végéig (rövidebb jelzéseknél).
// Az adatok: map/trails.js (Waymarked Trails); a tervezés: mapAdapter „Jelzés követése” szakasz.

import { trailsNear, trailPath, trailSection, snapToTrail, trailSymbolUrl, trailLabel, trailRef, haversine } from "../map/trails.js";
import { activityOf } from "../routeModes.js";
import { escapeHtml } from "./library.js";
import { num } from "../format.js";

const WHOLE_MAX_KM = 120;   // ennél hosszabb jelzést (pl. Kéktúra) nem töltünk be egyben

let _d = null;   // { mapAdapter, store, showToast, setRouteMode, isSuggestActive, isClosedLoop, addPoint, nameNameless, goPlan }

export function initTrailInfo(deps) {
  _d = deps;
  _d.mapAdapter.onContextMenu?.((p) => { if (!_d.isSuggestActive?.()) open(p); });
}

const lineKm = (l) => l.reduce((s, p, i) => (i ? s + haversine(l[i - 1], p) : 0), 0) / 1000;

function open(p) {
  const el = document.createElement("div");
  el.className = "marker-popup wp-pop trail-pop";
  el.innerHTML = `<div class="wp-kicker">Turistajelzések itt</div>
    <div class="trail-list"><span class="wp-trails-note">Jelzések keresése…</span></div>
    <div class="trail-acts" hidden></div>`;
  const close = _d.mapAdapter.openInfoPopup(p, el, () => _d.mapAdapter.clearTrailHighlight?.());
  const list = el.querySelector(".trail-list"), acts = el.querySelector(".trail-acts");

  trailsNear(p, 80).then((trails) => {
    if (!trails.length) {
      list.innerHTML = `<span class="wp-trails-note">Itt nincs jelzett turistaút. Kapcsold be a térképstílus-választóban a <b>Turistajelzések</b> réteget, és kattints egy jelzett útra.</span>`;
      return;
    }
    list.innerHTML = trails.map((t) => `<button type="button" class="trail-row" data-id="${t.id}">
        ${t.sym ? `<img src="${trailSymbolUrl(t.sym)}" alt="" width="22" height="22">` : '<span class="trail-row-nosym"></span>'}
        <b>${escapeHtml(trailLabel(t))}</b><span>${escapeHtml(t.name && t.name !== t.ref ? t.name : "")}</span></button>`).join("");
    list.querySelectorAll(".trail-row").forEach((b) => b.addEventListener("click", () => {
      list.querySelectorAll(".trail-row").forEach((x) => x.classList.toggle("is-active", x === b));
      select(trails.find((t) => t.id === Number(b.dataset.id)), p, acts, close);
    }));
  });
}

async function select(t, p, acts, close) {
  acts.hidden = false;
  acts.innerHTML = `<span class="wp-trails-note">Jelzés betöltése…</span>`;
  let path;
  try { path = await trailPath(t.id); } catch { acts.innerHTML = `<span class="wp-trails-note">A jelzés adatai most nem érhetők el.</span>`; return; }
  _d.mapAdapter.showTrailHighlight(path.lines);
  const longest = path.lines.reduce((a, l) => (lineKm(l) > lineKm(a) ? l : a), path.lines[0] || []);
  const km = lineKm(longest);
  const whole = km > 0.2 && km <= WHOLE_MAX_KM;
  acts.innerHTML = `
    <button type="button" class="wp-btn wp-btn--brand" data-a="here">Pont ide, ezen a jelzésen</button>
    ${whole ? `<button type="button" class="wp-btn wp-btn--soft" data-a="whole">Egész jelzés tervként (${num(km, 1)} km)</button>` : ""}
    <button type="button" class="wp-btn wp-btn--soft" data-a="show">Mutasd egészben</button>
    ${!whole && km > WHOLE_MAX_KM ? `<span class="wp-trails-note">${num(km, 0)} km – egyben túl hosszú, tegyél rá pontokat.</span>` : ""}`;
  acts.querySelector('[data-a="here"]').addEventListener("click", () => { close(); pointHere(t, p); });
  acts.querySelector('[data-a="whole"]')?.addEventListener("click", () => { close(); wholeTrail(t, longest); });
  acts.querySelector('[data-a="show"]').addEventListener("click", () => _d.mapAdapter.showTrailHighlight(path.lines, { fit: true }));
}

// Kerékpáros módban a jelzés követése nem értelmezett → Túra mód
function ensureFoot() {
  if (activityOf(_d.store.getState().mode) !== "foot") {
    _d.setRouteMode("hiking", { persistDefault: false });
    _d.showToast("Túra módra váltottam – a jelzés követése gyalogos módban működik");
  }
}

async function pointHere(t, p) {
  _d.goPlan?.();
  ensureFoot();
  const ref = trailRef(t);
  const at = (await snapToTrail(t.id, p).catch(() => null)) || p;
  const wps = _d.store.getState().waypoints;
  const prev = _d.isClosedLoop?.(wps) ? wps[wps.length - 2] : wps[wps.length - 1];
  if (prev) {
    const sec = await trailSection(t.id, prev, at).catch(() => null);
    if (sec) _d.store.updateWaypoint(prev.id, { trail: ref });
    else _d.showToast(`Az előző pont nincs a(z) ${trailLabel(t)} jelzésen – odáig a tervezési mód szerint vezet`);
  }
  // az új pont is ezt a jelzést viszi tovább (a következő pont felé), amíg át nem állítod
  await _d.addPoint({ lat: at.lat, lng: at.lng, trail: ref });
}

function wholeTrail(t, line) {
  if (_d.store.getState().waypoints.length && !confirm("A jelenlegi útvonal helyére tölti be a jelzést. Folytatod?")) return;
  _d.goPlan?.();
  ensureFoot();
  const a = line[0], b = line[line.length - 1];
  _d.store.replaceWaypoints([{ lat: a.lat, lng: a.lng, trail: trailRef(t) }, { lat: b.lat, lng: b.lng }]);
  _d.nameNameless?.();
  _d.mapAdapter.showTrailHighlight([line], { fit: true });
  setTimeout(() => _d.mapAdapter.clearTrailHighlight(), 4000);
  _d.showToast(`${trailLabel(t)} betöltve – a pontokat szabadon módosíthatod`);
}
