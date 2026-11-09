/**
 * Bringaterv – ismétlődő edzések (ugyanaz az edzés több forrásból: Strava + Magene, Garmin + Strava …)
 * =====================================================================================================
 * Szabály, mint az importnál (utils.find_cross_source_duplicate): indulás ±15 perc ÉS táv ±5%.
 *  - askOnStatsInclude(entry): a „Beleszámít a statisztikába” bekapcsolásakor – ha van már számító
 *    párja, felugró ablak: csak ez számítson / mindkettő / mégse.
 *  - openDuplicateFinder(): a Könyvtárból – az összes ismétlődés-csoport, csoportonként kiválasztod,
 *    melyiket tartod meg; a többi törölhető vagy kihagyható a statisztikából.
 */

import { num, dur } from "../format.js";

const START_TOL_S = 15 * 60;
const DIST_TOL = 0.05;

let _d = null;   // { api, getData, onChanged, toast }

export function initDuplicates(deps) { _d = deps; }

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ts = (e) => { const t = Date.parse(e?.start_time || ""); return Number.isFinite(t) ? t / 1000 : null; };
const inStats = (e) => e.include_in_stats !== false;

const SRC = { strava: "Strava", garmin: "Garmin", onelap: "OnelapFit", wahoo: "Wahoo", polar: "Polar", fit: "FIT-fájl", manual: "Saját" };
function sourceOf(e) {
  if (e.strava_id) return "strava";
  if (e.garmin_id || e.garmin_activity_id) return "garmin";
  if (e.onelap_id) return "onelap";
  if (e.wahoo_id) return "wahoo";
  if (e.polar_id) return "polar";
  if (e.has_fit) return "fit";
  return "manual";
}

function isDup(a, b) {
  if (a.id === b.id) return false;
  const ta = ts(a), tb = ts(b);
  if (ta == null || tb == null || Math.abs(ta - tb) > START_TOL_S) return false;
  const da = Number(a.distance), db = Number(b.distance);
  if (!(da > 0) || !(db > 0)) return false;
  return Math.abs(da - db) / Math.max(da, db) <= DIST_TOL;
}

const workouts = () => (_d?.getData()?.workouts || []).filter((e) => e.type === "workout" || e.start_time);

/** Az edzés valószínű párjai (önmaga nélkül). */
export function similarWorkouts(entry, list = workouts()) {
  return list.filter((e) => isDup(entry, e));
}

/** Ismétlődés-csoportok (összefüggő párok), indulás szerint csökkenő sorrendben. */
export function duplicateGroups(list = workouts()) {
  const sorted = list.filter((e) => ts(e) != null && Number(e.distance) > 0).sort((a, b) => ts(a) - ts(b));
  const parent = new Map(sorted.map((e) => [e.id, e.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && ts(sorted[j]) - ts(sorted[i]) <= START_TOL_S; j++) {
      if (isDup(sorted[i], sorted[j])) parent.set(find(sorted[j].id), find(sorted[i].id));
    }
  }
  const groups = new Map();
  for (const e of sorted) { const r = find(e.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(e); }
  return [...groups.values()].filter((g) => g.length > 1).sort((a, b) => ts(b[0]) - ts(a[0]));
}

/** Melyiket érdemes megtartani: több mért adat, eredeti FIT, eszköz-forrás a Strava előtt. */
function score(e) {
  let s = 0;
  if (e.has_fit) s += 3;
  if (e.avg_watts != null || e.weighted_avg_watts != null) s += e.device_watts === false ? 0 : 2;
  if (e.avg_heartrate != null) s += 1;
  if (e.avg_cadence != null) s += 1;
  if (e.avg_temp != null && e.temp_source !== "weather") s += 0.5;
  if (sourceOf(e) !== "strava" && sourceOf(e) !== "manual") s += 0.5;
  return s;
}
const recommended = (group) => [...group].sort((a, b) => score(b) - score(a))[0];

function fmtStart(e) {
  const d = new Date(e.start_time);
  if (isNaN(d)) return e.date || "";
  return d.toLocaleDateString("hu-HU", { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
}
function dataBadges(e) {
  const b = [];
  if (e.avg_heartrate != null) b.push("pulzus");
  if ((e.avg_watts != null || e.weighted_avg_watts != null) && e.device_watts !== false) b.push("watt");
  if (e.avg_cadence != null) b.push("kadencia");
  if (e.has_fit) b.push("eredeti FIT");
  return b;
}
function rowInfo(e) {
  return `<span class="dup-src dup-src--${sourceOf(e)}">${SRC[sourceOf(e)]}</span>
    <span class="dup-name">${esc(e.name || "Edzés")}</span>
    <span class="dup-meta">${esc(fmtStart(e))} · ${num(e.distance, 1)} km${e.duration != null ? ` · ${dur(e.duration)}` : ""}${e.elevation != null ? ` · ${Math.round(e.elevation)} m` : ""}</span>
    <span class="dup-data">${dataBadges(e).map((x) => `<em>${x}</em>`).join("") || "<em class='is-none'>csak nyomvonal</em>"}${inStats(e) ? "" : "<em class='is-out'>statisztikán kívül</em>"}</span>`;
}

// ── kis modal-keret ───────────────────────────────────────────────────────────
function modal(title, bodyHtml, footHtml) {
  const ov = document.createElement("div");
  ov.className = "shortcut-overlay dup-overlay";
  ov.innerHTML = `<div class="export-panel dup-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="export-header"><h3>${esc(title)}</h3>
        <button class="shortcut-close" type="button" data-dup="close" title="Bezárás"><i data-lucide="x" aria-hidden="true"></i></button></div>
      <div class="export-body dup-body">${bodyHtml}</div>
      ${footHtml ? `<div class="export-footer dup-foot">${footHtml}</div>` : ""}
    </div>`;
  document.body.appendChild(ov);
  window.lucide?.createIcons({ root: ov });
  return ov;
}

async function setInStats(e, val) {
  await _d.api.updateRoute(e.id, { include_in_stats: val });
  e.include_in_stats = val;
}

/**
 * A „Beleszámít a statisztikába” bekapcsolása előtt.
 * @returns {Promise<boolean>} true: mehet a bekapcsolás; false: a felhasználó megszakította
 */
export function askOnStatsInclude(entry) {
  const dups = similarWorkouts(entry).filter(inStats);
  if (!dups.length) return Promise.resolve(true);
  return new Promise((resolve) => {
    const ov = modal("Ez az edzés valószínűleg már megvan",
      `<p class="dup-lead">Ugyanekkor indult, nagyjából ugyanakkora távval – és már beleszámít a statisztikába:</p>
       <div class="dup-list">${dups.map((d) => `<div class="dup-row is-static">${rowInfo(d)}</div>`).join("")}</div>
       <p class="dup-lead">Amit most bekapcsolnál:</p>
       <div class="dup-list"><div class="dup-row is-static is-this">${rowInfo(entry)}</div></div>
       <p class="dup-note">Ha mindkettő számít, a km, az idő és a terhelés duplán kerül a statisztikába.</p>`,
      `<button type="button" class="export-confirm-btn export-confirm-btn--primary" data-dup="only">Csak ez számítson</button>
       <button type="button" class="export-confirm-btn" data-dup="both">Mindkettő számítson</button>
       <button type="button" class="export-confirm-btn" data-dup="close">Mégse</button>`);
    ov.addEventListener("click", async (ev) => {
      const act = ev.target.closest("[data-dup]")?.dataset.dup;
      if (!act && ev.target !== ov) return;
      if (!act || act === "close") { ov.remove(); resolve(false); return; }
      if (act === "only") {
        try { for (const d of dups) await setInStats(d, false); _d.onChanged?.(); }
        catch { _d.toast?.("Nem sikerült a másikat kihagyni."); }
        _d.toast?.(dups.length > 1 ? `${dups.length} másik edzés kihagyva a statisztikából` : `„${dups[0].name}” kihagyva a statisztikából`);
      }
      ov.remove(); resolve(true);
    });
  });
}

/** Könyvtár → Ismétlődések: csoportonként melyiket tartod meg. */
export function openDuplicateFinder() {
  const groups = duplicateGroups();
  const open = groups.filter((g) => g.filter(inStats).length > 1);
  const settled = groups.length - open.length;
  if (!groups.length) { _d.toast?.("Nincs ismétlődő edzés – minden edzés csak egyszer szerepel."); return; }
  const groupHtml = (g, gi) => {
    const rec = recommended(g);
    const keep = g.filter(inStats).length === 1 ? g.find(inStats) : rec;
    return `<section class="dup-group" data-g="${gi}">
      <div class="dup-group-head">${esc(fmtStart(g[0]))} · ${num(g[0].distance, 1)} km · ${g.length} példány${g.filter(inStats).length <= 1 ? ' <span class="dup-ok">rendezve</span>' : ""}</div>
      ${g.map((e) => `<label class="dup-row">
          <input type="radio" name="dupKeep${gi}" value="${esc(e.id)}" ${e === keep ? "checked" : ""}>
          <span class="dup-row-main">${rowInfo(e)}</span>
          ${e === rec ? '<span class="dup-rec" title="A legtöbb mért adat (eredeti FIT, watt, pulzus, kadencia)">javasolt</span>' : ""}
        </label>`).join("")}
      <div class="dup-group-acts">
        <button type="button" class="dup-act" data-dup="exclude" data-g="${gi}">A többi ne számítson</button>
        <button type="button" class="dup-act is-danger" data-dup="delete" data-g="${gi}">A többi törlése</button>
      </div>
    </section>`;
  };
  const list = [...open, ...groups.filter((g) => !open.includes(g))];
  const ov = modal("Ismétlődő edzések",
    `<p class="dup-lead">Ugyanaz az edzés több forrásból (pl. Strava és Magene / Garmin): indulás ±15 percen belül, táv ±5%-on belül.
       Válaszd ki, melyiket tartod meg – a többit kihagyhatod a statisztikából, vagy törölheted.
       ${open.length ? `<b>${open.length} csoport</b> számít most duplán.` : "Most egyik sem számít duplán."}${settled ? ` ${settled} csoport már rendezve (csak egy példány számít).` : ""}</p>
     ${list.map((g) => groupHtml(g, groups.indexOf(g))).join("")}`,
    "");
  ov.addEventListener("click", async (ev) => {
    if (ev.target === ov || ev.target.closest('[data-dup="close"]')) { ov.remove(); return; }
    const btn = ev.target.closest("[data-dup='exclude'], [data-dup='delete']");
    if (!btn) return;
    const gi = Number(btn.dataset.g), g = groups[gi];
    const keepId = ov.querySelector(`input[name="dupKeep${gi}"]:checked`)?.value;
    const keep = g.find((e) => e.id === keepId);
    const others = g.filter((e) => e.id !== keepId);
    if (!keep) return;
    const sec = btn.closest(".dup-group");
    sec.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      if (btn.dataset.dup === "delete") {
        if (!confirm(`Törlöd ${others.length > 1 ? `ezt a ${others.length} edzést` : "ezt az edzést"}: ${others.map((o) => `„${o.name}” (${SRC[sourceOf(o)]})`).join(", ")}? A megtartott: „${keep.name}” (${SRC[sourceOf(keep)]}).`)) {
          sec.querySelectorAll("button").forEach((b) => { b.disabled = false; }); return;
        }
        for (const o of others) await _d.api.deleteRoute(o.id);
        const data = _d.getData();
        const gone = new Set(others.map((o) => o.id));
        data.workouts = data.workouts.filter((e) => !gone.has(e.id));
        data.routes = data.routes.filter((e) => !gone.has(e.id));
        if (!inStats(keep)) await setInStats(keep, true);
        sec.innerHTML = `<div class="dup-done">✓ Megtartva: „${esc(keep.name)}” (${SRC[sourceOf(keep)]}) – ${others.length} törölve</div>`;
      } else {
        if (!inStats(keep)) await setInStats(keep, true);
        for (const o of others) if (inStats(o)) await setInStats(o, false);
        sec.innerHTML = `<div class="dup-done">✓ Csak „${esc(keep.name)}” (${SRC[sourceOf(keep)]}) számít a statisztikába</div>`;
      }
      _d.onChanged?.();
    } catch (err) {
      _d.toast?.(err.message || "Nem sikerült végrehajtani.");
      sec.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    }
  });
}
