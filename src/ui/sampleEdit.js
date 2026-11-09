/**
 * Bringaterv – közösségi útvonal nyomvonalának szerkesztése a Tervezőben (admin)
 * ==============================================================================
 * Az admin felület „Térkép szerkesztése” gombja ide nyit: /?editSample=<id>.
 * A közösségi útvonal betöltődik a Tervezőbe (pontok húzása, beszúrása, szakaszmód, BRouter –
 * minden tervezőeszköz), a fül tetején sáv: „Mentés a közösségi útvonalba” / „Mégse”.
 * Mentés: PUT /api/admin/samples/<id>/gpx – a szerver az előző nyomvonalat megtartja (visszaállítható).
 */

import { routesApi } from "../api/routesApi.js";
import { isAdmin } from "../auth.js";

let _d = null;
let _sample = null;       // { id, name, description, type }
let _bar = null;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** @returns {boolean} szerkesztő módban vagyunk-e */
export function isEditingSample() { return !!_sample; }

/**
 * @param {object} deps
 * @param {(id, isSample, name, target) => Promise} deps.loadRouteFromLibrary
 * @param {(sample) => {gpx:string, distanceKm:number|null, ascentMeters:number, durationMin:number|null}|null} deps.buildPayload
 * @param {(msg:string, ms?:number) => void} deps.showToast
 */
export async function initSampleEdit(deps) {
  const id = new URLSearchParams(location.search).get("editSample");
  if (!id) return;
  _d = deps;
  if (!isAdmin()) { deps.showToast("Közösségi útvonalat csak admin szerkeszthet.", 5000); return; }
  let list = [];
  try { list = await routesApi.listSamples(); } catch { /* lent kezeljük */ }
  const s = (list || []).find((x) => x.id === id);
  if (!s) { deps.showToast("Ez a közösségi útvonal nem található.", 5000); return; }
  _sample = { id: s.id, name: s.name, description: (s.description || "").trim(), type: s.type };
  // a címsorból kivesszük, hogy frissítéskor ne nyissa újra mentetlenül
  history.replaceState(null, "", location.pathname);
  await deps.loadRouteFromLibrary(s.id, true, s.name, "plan");
  showBar();
}

function showBar() {
  const host = document.querySelector("#tabPlan");
  if (!host) return;
  _bar?.remove();
  _bar = document.createElement("div");
  _bar.className = "sample-edit-bar";
  _bar.innerHTML = `
    <div class="sample-edit-txt"><b>Közösségi útvonal szerkesztése</b><span>${esc(_sample.name)}</span>
      <small>Húzd a pontokat, szúrj be újat az útvonalra kattintva, válts szakaszmódot – a mentés lecseréli a közösségi útvonal nyomvonalát (az előző visszaállítható az admin felületen).</small></div>
    <div class="sample-edit-acts">
      <button type="button" class="sample-edit-save" data-se="save"><i data-lucide="check" aria-hidden="true"></i>Mentés a közösségi útvonalba</button>
      <button type="button" class="sample-edit-cancel" data-se="cancel">Mégse</button>
    </div>`;
  host.prepend(_bar);
  window.lucide?.createIcons({ root: _bar });
  _bar.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-se]")?.dataset.se;
    if (act === "cancel") {
      if (!confirm("Kilépsz a szerkesztésből? A módosítások nem mentődnek a közösségi útvonalba.")) return;
      endEdit();
    } else if (act === "save") {
      await save(e.target.closest("button"));
    }
  });
}

async function save(btn) {
  const payload = _d.buildPayload(_sample);
  if (!payload?.gpx) { _d.showToast("Nincs menthető útvonal – legalább két pont kell."); return; }
  if (!confirm(`Lecseréled a(z) „${_sample.name}” közösségi útvonal nyomvonalát? (Táv: ${payload.distanceKm ?? "?"} km, emelkedés: ${Math.round(payload.ascentMeters || 0)} m)`)) return;
  btn.disabled = true;
  const label = btn.innerHTML;
  btn.textContent = "Mentés…";
  try {
    await routesApi.admin.replaceSampleGpx(_sample.id, {
      gpx: payload.gpx, distance: payload.distanceKm, elevation: Math.round(payload.ascentMeters || 0) || null, duration: payload.durationMin,
    });
    _d.showToast(`„${_sample.name}” nyomvonala frissítve – a helyadat a háttérben újraszámolódik.`, 6000);
    endEdit();
  } catch (err) {
    _d.showToast(err.message || "Nem sikerült menteni.", 6000);
    btn.disabled = false; btn.innerHTML = label;
  }
}

function endEdit() {
  _sample = null;
  _bar?.remove(); _bar = null;
}
