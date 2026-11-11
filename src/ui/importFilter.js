/**
 * „Csak az újak” kapcsoló minden import-ablakban (Strava, Garmin, OnelapFit, iGPSport, Bryton,
 * Wahoo, Polar). A listák sorai közösek (.strava-import-row, jelölés: .strava-import-badge--new /
 * --imported / --deleted / --likely) – bekapcsolva csak az „Új” sorok látszanak, így egy többéves
 * fiók listájában sem kell görgetni. A választás megmarad (localStorage), alapból be.
 *
 * Magától kerül minden `.strava-import-controls` sávba (a később felépülő Wahoo / Polar ablakba is).
 *
 *   initImportFilter()
 */
const KEY = "bringaterv.importOnlyNew";
const onlyNew = () => { try { return localStorage.getItem(KEY) !== "0"; } catch { return true; } };

const isNew = (row) => !row.querySelector(".strava-import-badge") || !!row.querySelector(".strava-import-badge--new");

function listOf(controls) {
  // a vezérlősávot követő lista ugyanabban az ablakban
  const root = controls.closest(".shortcut-overlay, .strava-import-modal, [data-dev-modal]") || controls.parentElement;
  return root?.querySelector(".strava-import-list") || null;
}

function apply(list, label) {
  if (!list) return;
  const rows = [...list.querySelectorAll(".strava-import-row")];
  const on = onlyNew();
  let fresh = 0;
  for (const r of rows) {
    const n = isNew(r);
    if (n) fresh++;
    // a most importált sor („Importálva” lett) látszódjon tovább – csak újrarajzoláskor tűnik el
    r.hidden = on && !n && !r.dataset.keep;
  }
  if (label) label.textContent = rows.length ? `Csak az újak (${fresh} / ${rows.length})` : "Csak az újak";
  let empty = list.querySelector(".imp-only-empty");
  if (on && rows.length && !fresh) {
    if (!empty) { empty = Object.assign(document.createElement("div"), { className: "imp-only-empty" }); list.prepend(empty); }
    empty.textContent = "Ebben a listában nincs új edzés – mindet behoztad már.";
  } else empty?.remove();
}

function attach(controls) {
  if (controls.dataset.onlyNew) return;
  const list = listOf(controls);
  if (!list) return;
  controls.dataset.onlyNew = "1";
  const wrap = document.createElement("label");
  wrap.className = "imp-only-new";
  wrap.innerHTML = `<span class="toggle-switch"><input type="checkbox"${onlyNew() ? " checked" : ""}><span class="toggle-track"></span></span><span class="imp-only-txt">Csak az újak</span>`;
  controls.appendChild(wrap);
  const txt = wrap.querySelector(".imp-only-txt");
  wrap.querySelector("input").addEventListener("change", (e) => {
    try { localStorage.setItem(KEY, e.target.checked ? "1" : "0"); } catch { /* privát mód */ }
    document.querySelectorAll(".strava-import-list").forEach((l) => apply(l, l._onlyNewLabel));
    document.querySelectorAll(".imp-only-new input").forEach((i) => { i.checked = e.target.checked; });
  });
  list._onlyNewLabel = txt;
  // újrarajzoláskor (listázás) szűrünk; importálás közben (jelölés-csere) a sor marad
  new MutationObserver((muts) => {
    if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.matches?.(".strava-import-row") || n.querySelector?.(".strava-import-row"))))) apply(list, txt);
  }).observe(list, { childList: true, subtree: false });
  apply(list, txt);
}

export function initImportFilter() {
  const scan = () => document.querySelectorAll(".strava-import-controls").forEach(attach);
  scan();
  // a Wahoo / Polar ablak megnyitáskor épül fel (képkockánként legfeljebb egyszer nézzük)
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  }).observe(document.body, { childList: true });
}
