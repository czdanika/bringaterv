/**
 * Bringaterv – jelmagyarázat a térképen (színezett útvonalhoz)
 * ==============================================================
 * Ha az útvonal színezve van (sebesség / pulzus / kadencia / teljesítmény /
 * lejtés / szél), a térkép sarkában kis dobozban mutatjuk a színsávokat –
 * ugyanúgy, mint a nyilvános nézőoldalon. Az adatokat a meglévő oldalsávi
 * jelmagyarázatokból vesszük, így a felhasználó zónabeállításait tükrözik.
 * Koppintásra összecsukható (csak a cím marad).
 */

const SOURCES = [
  { toggle: "speedMapToggle",     legend: "speedLegend",     title: "Sebesség" },
  { toggle: "hrMapToggle",        legend: "hrLegend",        title: "Pulzus" },
  { toggle: "cadMapToggle",       legend: "cadLegend",       title: "Kadencia" },
  { toggle: "powerMapToggle",     legend: "powerLegend",     title: "Teljesítmény" },
  { toggle: "gradeMapToggle",     legend: "gradeLegend",     title: "Lejtés" },
  { toggle: "gradeMapTogglePlan", legend: "gradeLegendPlan", title: "Lejtés" },
  { toggle: "windMapTogglePlan",  legend: "windLegendPlan",  title: "Szél" },
];

let _box = null;
let _collapsed = false;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Az aktív forrás: bekapcsolt kapcsoló, látható jelmagyarázat, látható fülön */
function activeSource() {
  return SOURCES.find(({ toggle, legend }) => {
    const t = document.getElementById(toggle);
    const l = document.getElementById(legend);
    return t?.checked && l && !l.hidden && l.closest(".tab-panel:not([hidden])");
  });
}

/** Sávok: [szín, felirat] – a .speed-legend-item vagy a pulzuszóna-sorokból */
function itemsOf(legendEl) {
  const hrRows = [...legendEl.querySelectorAll(".hr-zone-row")];
  if (hrRows.length) {
    return hrRows.map((r) => {
      const name = r.querySelector(".hr-zone-row-name");
      return [name?.style.color || "#999", `${name?.textContent || ""} · ${r.querySelector(".hr-zone-row-bpm")?.textContent || ""}`];
    });
  }
  return [...legendEl.querySelectorAll(".speed-legend-item")].map((it) => [
    it.querySelector(".speed-dot")?.style.background || "#999",
    it.textContent.trim(),
  ]);
}

export function refreshMapLegend() {
  const host = document.querySelector(".map-wrap");
  if (!host) return;
  const src = activeSource();
  const items = src ? itemsOf(document.getElementById(src.legend)) : [];
  if (!src || !items.length) { _box?.remove(); _box = null; return; }
  if (!_box) {
    _box = document.createElement("div");
    _box.className = "map-legend map-legend--app";
    _box.setAttribute("role", "button");
    _box.title = "Jelmagyarázat – koppints az összecsukáshoz";
    _box.addEventListener("click", () => { _collapsed = !_collapsed; _box.classList.toggle("is-collapsed", _collapsed); });
    host.appendChild(_box);
  }
  _box.classList.toggle("is-collapsed", _collapsed);
  _box.innerHTML = `<div class="map-legend-title">${esc(src.title)}</div>`
    + items.map(([c, t]) => `<div class="map-legend-row"><span style="background:${esc(c)}"></span>${esc(t)}</div>`).join("");
}

export function initMapLegend() {
  // Kapcsolók és fülváltás után frissítünk (a színezés logikája máshol fut le előbb)
  const later = () => setTimeout(refreshMapLegend, 0);
  SOURCES.forEach(({ toggle }) => document.getElementById(toggle)?.addEventListener("change", later));
  document.querySelectorAll(".sidebar-tab, .rail-tab").forEach((b) => b.addEventListener("click", later));
  // A zónabeállítás vagy a pulzuselemzés újrarajzolja a jelmagyarázatot
  const mo = new MutationObserver(later);
  SOURCES.forEach(({ legend }) => {
    const el = document.getElementById(legend);
    if (el) mo.observe(el, { attributes: true, attributeFilter: ["hidden"], childList: true, subtree: true });
  });
}
