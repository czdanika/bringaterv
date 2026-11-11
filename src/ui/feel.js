/**
 * „Érzés és jegyzet” kártya az Elemzésben (mentett edzésnél): RPE 1–10 (Borg CR10) és
 * szabad jegyzet – azonnal mentődik (PATCH /api/routes/<id>: rpe, notes). Az RPE-ből
 * szubjektív terhelés (sRPE = RPE × mozgásperc, Foster); az AI-elemzés mindkettőt figyelembe veszi.
 *
 *   initFeel({ api, getGeometry, getRouteId, getLibraryData })
 */
import { int } from "../format.js";

const LABELS = ["", "nagyon könnyű", "könnyű", "mérsékelt", "kissé megerőltető", "megerőltető", "megerőltető",
  "nagyon megerőltető", "nagyon megerőltető", "rendkívül megerőltető", "maximális"];
const COLORS = ["", "#22C55E", "#4ADE80", "#A3E635", "#FACC15", "#FBBF24", "#F59E0B", "#F97316", "#EF4444", "#DC2626", "#991B1B"];

let _deps = null, _geomRef = null, _entry = null, _saveT = null;

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function movingMin() {
  const d = Number(_entry?.duration);
  return d > 0 ? d : null;
}

function render(status = "") {
  const box = document.getElementById("fFileFeel");
  if (!box) return;
  if (!_entry) { box.hidden = true; box.innerHTML = ""; return; }
  const rpe = _entry.rpe || null;
  const mm = movingMin();
  const btns = Array.from({ length: 10 }, (_, i) => i + 1).map((v) =>
    `<button type="button" class="feel-b${v === rpe ? " is-on" : ""}" data-v="${v}" style="--c:${COLORS[v]}" title="${v} – ${LABELS[v]}" aria-pressed="${v === rpe}">${v}</button>`).join("");
  box.innerHTML = `<div class="be-head"><span>Érzés és jegyzet</span>
      <span class="clb-hint" title="Mennyire volt megerőltető (RPE, 1 nagyon könnyű … 10 maximális – Borg-skála)? Ebből szubjektív edzésterhelés is számolódik (sRPE = RPE × mozgásperc, Foster-módszer) – pulzus- és wattmérő nélkül is jól követhető. A jegyzet csak neked szól; az AI-elemzés mindkettőt figyelembe veszi. Azonnal mentődik.">?</span></div>
    <div class="feel-scale" role="group" aria-label="Érzés 1–10">${btns}</div>
    <div class="feel-lbl">${rpe ? `<b style="color:${COLORS[rpe]}">${rpe}/10</b> · ${LABELS[rpe]}${mm ? ` · terhelés (sRPE): <b>${int(rpe * mm)}</b>` : ""}` : "Koppints, mennyire volt nehéz"}</div>
    <textarea class="feel-notes" rows="2" maxlength="2000" placeholder="Jegyzet – pl. hogy érezted magad, időjárás, mi történt…">${esc(_entry.notes || "")}</textarea>
    <div class="feel-status" aria-live="polite">${status}</div>`;
  box.hidden = false;
  box.querySelectorAll(".feel-b").forEach((b) => b.addEventListener("click", () => {
    const v = +b.dataset.v;
    save({ rpe: v === _entry.rpe ? null : v });
  }));
  const ta = box.querySelector(".feel-notes");
  ta.addEventListener("input", () => {
    clearTimeout(_saveT);
    box.querySelector(".feel-status").textContent = "…";
    _saveT = setTimeout(() => save({ notes: ta.value }, { keepFocus: true }), 800);
  });
}

async function save(fields, { keepFocus = false } = {}) {
  const id = _entry?.id;
  if (!id) return;
  const box = document.getElementById("fFileFeel");
  try {
    const upd = await _deps.api.updateRoute(id, fields);
    if (_entry?.id !== id) return;
    // a könyvtár memóriabeli adata is frissüljön (újranyitáskor ugyanez látsszon)
    for (const k of ["rpe", "notes"]) { if (k in upd) _entry[k] = upd[k]; else delete _entry[k]; }
    if (keepFocus) { const st = box?.querySelector(".feel-status"); if (st) st.textContent = "Mentve"; }
    else render("Mentve");
  } catch (err) {
    console.warn("Érzés / jegyzet mentése:", err);
    const st = box?.querySelector(".feel-status"); if (st) st.textContent = "Nem sikerült menteni – próbáld újra.";
  }
}

function refresh() {
  const g = _deps.getGeometry();
  if (g === _geomRef) return;
  _geomRef = g;
  const id = _deps.getRouteId?.();
  const lib = _deps.getLibraryData?.() || {};
  const entry = id ? [...(lib.workouts || []), ...(lib.routes || [])].find((r) => r.id === id) : null;
  _entry = entry && entry.type === "workout" && g?.some?.((p) => p.time != null) ? entry : null;
  render();
}

export function initFeel(deps) {
  _deps = deps;
  document.addEventListener("bringaterv:geometry", () => setTimeout(refresh, 0));
  refresh();
}
