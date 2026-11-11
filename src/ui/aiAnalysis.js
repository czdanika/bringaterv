// ── AI-edzéselemzés (Claude API, a szerveren keresztül) ──────────────────────
// Az Elemzés oldalon egy kártya (csak elvégzett edzésnél, útvonaltervnél nem): ha
// még nincs elemezve, „Edzés elemzése” gomb (opcionális megjegyzéssel és a napi
// keretből hátralévő számmal); utána a rövid elemzés, és külön kérésre egy részletes
// változat felugró ablakban. Az összesítőt itt számoljuk a nyomvonalból – a szerver
// és a modell nem a nyers GPX-et kapja. Az API-kulcs csak a szerveren van.

import { routesApi } from "../api/routesApi.js";
import { calcHrZoneStats } from "./settings.js";
import { escapeHtml } from "./library.js";

let _deps = null;          // { getGeometry, getLoadedId, isSample, findEntry, listWorkouts, ensureLibrary, showToast }
let _status = null;        // /api/ai/status
let _statusLoading = null;
let _busy = false;         // false | "short" | "extended"
let _libRequested = "";    // ennél az azonosítónál már kértük a könyvtár betöltését
let _editing = false;
let _expanded = false;     // a pontok teljes szövege lenyitva
let _lastKey = "";

export function initAiAnalysis(deps) {
  _deps = deps;
  const box = document.getElementById("fFileAi");
  if (!box) return;
  box.addEventListener("click", onClick);
  // mentés után a könyvtár újratöltődik – ekkor jelenik meg a bejegyzés (és a gomb)
  window.addEventListener("bringaterv:libraryLoaded", () => refreshAiCard());
  loadStatus().then(() => { _lastKey = ""; refreshAiCard(); syncSettingsToggle(); });
  const toggle = document.getElementById("aiUserToggle");
  toggle?.addEventListener("change", async () => {
    try {
      _status = await routesApi.aiSetEnabled(toggle.checked);
      _lastKey = ""; refreshAiCard();
    } catch (err) {
      toggle.checked = !toggle.checked;
      _deps.showToast(err.message || "Nem sikerült menteni.");
    }
  });
}

async function loadStatus() {
  if (_statusLoading) return _statusLoading;
  _statusLoading = routesApi.aiStatus().then((s) => { _status = s; }).catch(() => { _status = null; })
    .finally(() => { _statusLoading = null; });
  return _statusLoading;
}

function syncSettingsToggle() {
  const sec = document.getElementById("aiSettingsSection");
  const toggle = document.getElementById("aiUserToggle");
  if (!sec || !toggle) return;
  sec.hidden = !(_status?.configured && _status?.allowed);
  toggle.checked = !_status?.user_off;
}

const available = () => !!(_status?.configured && _status?.allowed && !_status?.user_off);

// Az edzés „ujjlenyomata” – ha később megváltozik (pl. levágás), az elemzés elavult
function dataSig(g) {
  if (!g?.length) return "";
  const dist = Number(document.getElementById("fileDistance")?.textContent?.replace(",", ".").replace(/[^\d.]/g, "")) || 0;
  return `${g.length}|${dist.toFixed(1)}`;
}

/** Az Elemzés oldal frissítésekor hívódik – csak akkor rajzol újra, ha változott valami. */
export function refreshAiCard() {
  const box = document.getElementById("fFileAi");
  if (!box || !_deps) return;
  const id = _deps.getLoadedId();
  const entry = id && !_deps.isSample() ? _deps.findEntry(id) : null;
  const a = entry?.ai_analysis;
  const key = [available(), id, !!entry, _deps.isSample(), a?.created_at, a?.edited, entry?.ai_analysis_ext?.created_at, _status?.remaining, _busy, _editing, _expanded,
               dataSig(_deps.getGeometry())].join("|");
  if (key === _lastKey) return;
  _lastKey = key;

  const g = _deps.getGeometry();
  const hasTime = !!g?.some((p) => p.time);
  // Elmentett azonosító, de a könyvtár még nincs betöltve (pl. a Kezdőlapról nyitva) → betöltjük
  if (id && !entry && _libRequested !== id && available()) { _libRequested = id; _deps.ensureLibrary(); }
  // Csak elvégzett edzésre: útvonaltervnél, mintánál és időadat nélküli fájlnál nincs kártya
  if (!available() || _deps.isSample() || !hasTime || (id && !entry)) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  const head = (right) => `<div class="f-ai-h"><span class="f-ai-ico"><i data-lucide="sparkles" aria-hidden="true"></i></span>AI-elemzés<small>${right}</small></div>`;

  if (!entry) {
    box.innerHTML = head("") + `<p class="f-ai-intro">Mentsd el az edzést a könyvtárba, és rövid AI-értékelést kérhetsz róla.</p>`;
  } else if (_busy) {
    box.innerHTML = head("") + `<div class="f-ai-busy"><span class="spinner-inline"></span> ${_busy === "extended"
      ? "Részletes elemzés készül… (fél–egy perc)" : "Elemzés készül… (10–30 mp)"}</div>`;
  } else if (!a && _status.unavailable) {
    box.innerHTML = head("") + `<div class="ai-off-note"><i data-lucide="cloud-off" aria-hidden="true"></i><span>${escapeHtml(_status.message || "Az AI most átmenetileg nem érhető el. Próbáld újra később.")}</span></div>`;
  } else if (!a) {
    const left = _status.remaining;
    box.innerHTML = head(`ma még ${left}`) +
      `<p class="f-ai-intro">Rövid értékelés az edzésről: tempó, pulzus, szint, összevetés a korábbi hasonló edzéseiddel.</p>
       <input class="f-ai-ctx" id="fAiCtx" type="text" maxlength="300" placeholder="Pár szó az edzésről (nem kötelező) – pl. „regeneráló kör”">
       <button type="button" class="f-ai-go" data-ai="run" ${left > 0 ? "" : "disabled"}>
         <i data-lucide="sparkles" aria-hidden="true"></i>${left > 0 ? "Edzés elemzése" : "Mára elfogyott az AI-keret"}</button>
       ${left > 0 ? `<button type="button" class="f-ai-more f-ai-alt" data-ai="ext">vagy rögtön részletes elemzés</button>` : ""}`;
  } else if (_editing) {
    box.innerHTML = head("szerkesztés") +
      `<label class="f-ai-lbl">Összefoglaló<textarea id="fAiLead" rows="3">${escapeHtml(a.lead || "")}</textarea></label>
       <label class="f-ai-lbl">Pontok (soronként egy)<textarea id="fAiPoints" rows="5">${escapeHtml((a.points || []).map((p) => p.text).join("\n"))}</textarea></label>
       <div class="f-ai-foot"><button type="button" class="f-ai-link is-strong" data-ai="save">Mentés</button><button type="button" class="f-ai-link" data-ai="cancel">Mégse</button>
       <button type="button" class="f-ai-link is-danger" data-ai="delete">Elemzés törlése</button></div>
       <button type="button" class="f-ai-more f-ai-alt" data-ai="rerun" ${_status.remaining > 0 ? "" : "disabled"}>Új elemzés kérése (ma még ${_status.remaining})</button>`;
  } else {
    if (_status.unavailable) _status = { ..._status, remaining: 0 };   // szünet alatt nincs új kérés
    const date = a.created_at ? new Date(a.created_at).toLocaleDateString("hu-HU", { month: "short", day: "numeric" }) : "";
    const stale = a.data_sig && a.data_sig !== dataSig(_deps.getGeometry());
    box.innerHTML = head(escapeHtml(date)) +
      (a.context ? `<div class="f-ai-ctxchip">„${escapeHtml(a.context)}”</div>` : "") +
      `<div class="f-ai-lead">${escapeHtml(a.lead || "")}</div>
       <ul class="f-ai-points${_expanded ? "" : " is-collapsed"}">${(a.points || []).map((p) => `<li class="is-${escapeHtml(p.tone)}"><i></i><span>${escapeHtml(p.text)}</span></li>`).join("")}</ul>
       ${(a.points || []).length ? `<button type="button" class="f-ai-more" data-ai="toggle" aria-expanded="${_expanded}">${_expanded ? "Kevesebb" : "Részletek"}<i data-lucide="chevron-${_expanded ? "up" : "down"}" aria-hidden="true"></i></button>` : ""}
       <div class="f-ai-foot">
         <button type="button" class="f-ai-link" data-ai="ext" ${entry.ai_analysis_ext || _status.remaining > 0 ? "" : "disabled"}
           title="${entry.ai_analysis_ext ? "A részletes elemzés megnyitása" : `Hosszabb elemzés fejezetekkel és javaslatokkal – a napi keretből számít (ma még ${_status.remaining})`}"><i data-lucide="file-text" aria-hidden="true"></i>Részletes</button>
         <button type="button" class="f-ai-link" data-ai="edit"><i data-lucide="pencil" aria-hidden="true"></i>Szerkesztés</button>
         <span class="f-ai-tag">${a.edited ? "AI-generált, szerkesztve" : "AI-generált"}</span>
       </div>` +
      (stale ? `<div class="f-ai-stale"><i data-lucide="info" aria-hidden="true"></i><span>Az edzés azóta módosult – az elemzés a korábbi adatokon készült.
         <button type="button" class="f-ai-link is-strong" data-ai="rerun" ${_status.remaining > 0 ? "" : "disabled"}>Újragenerálás</button></span></div>` : "");
  }
  window.lucide?.createIcons({ root: box });
}

async function onClick(e) {
  const b = e.target.closest("[data-ai]");
  if (!b || b.disabled) return;
  const id = _deps.getLoadedId();
  const entry = id ? _deps.findEntry(id) : null;
  if (!entry) return;
  const act = b.dataset.ai;
  if (act === "rerun" && !confirmRerun("elemzést")) return;
  if (act === "run" || act === "rerun") {
    _editing = false;
    const ctx = act === "run" ? (document.getElementById("fAiCtx")?.value || "").trim() : (entry.ai_analysis?.context || "");
    await run(id, entry, ctx);
  } else if (act === "ext") {
    if (entry.ai_analysis_ext) openExtended(id, entry);
    else if (await run(id, entry, (document.getElementById("fAiCtx")?.value || "").trim() || entry.ai_analysis?.context || "", "extended")) openExtended(id, entry);
  } else if (act === "toggle") { _expanded = !_expanded; refreshAiCard(); }
  else if (act === "edit") { _editing = true; refreshAiCard(); }
  else if (act === "cancel") { _editing = false; refreshAiCard(); }
  else if (act === "save") {
    const lead = document.getElementById("fAiLead")?.value || "";
    const lines = (document.getElementById("fAiPoints")?.value || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const old = entry.ai_analysis?.points || [];
    const points = lines.slice(0, 4).map((text, i) => ({ tone: old[i]?.tone || "info", text }));
    try {
      const r = await routesApi.aiEditWorkout(id, { lead, points });
      entry.ai_analysis = r.analysis; _editing = false; refreshAiCard();
    } catch (err) { _deps.showToast(err.message || "Nem sikerült menteni."); }
  } else if (act === "delete") {
    if (!confirm("Törlöd az AI-elemzést erről az edzésről?")) return;
    try {
      await routesApi.aiDeleteWorkout(id);
      delete entry.ai_analysis; _editing = false; refreshAiCard();
    } catch (err) { _deps.showToast(err.message || "Nem sikerült törölni."); }
  }
}

async function run(id, entry, context, mode = "short") {
  const g = _deps.getGeometry();
  if (!g?.length) return false;
  _busy = mode; refreshAiCard();
  try {
    const r = await routesApi.aiAnalyzeWorkout(id, {
      mode, summary: buildSummary(g, entry), history: buildHistory(entry), context, data_sig: dataSig(g),
    });
    if (mode === "extended") entry.ai_analysis_ext = r.analysis; else entry.ai_analysis = r.analysis;
    _status = r.status;
    return true;
  } catch (err) {
    _deps.showToast(err.message || "Nem sikerült az elemzés.", 6000);
    _statusLoading = null; await loadStatus();
    return false;
  } finally {
    _busy = false; _lastKey = ""; refreshAiCard();
  }
}

function confirmRerun(what) {
  return confirm(`Új ${what} kérsz? A mostani felülíródik, és a napi AI-keretből számít (ma még ${_status?.remaining ?? 0}).`);
}

// ── Részletes elemzés: felugró ablak (hosszabb szöveg, görgethető) ──────────
function openExtended(id, entry) {
  const x = entry.ai_analysis_ext;
  if (!x) return;
  document.getElementById("aiExtOverlay")?.remove();
  const date = x.created_at ? new Date(x.created_at).toLocaleDateString("hu-HU", { year: "numeric", month: "short", day: "numeric" }) : "";
  const stale = x.data_sig && x.data_sig !== dataSig(_deps.getGeometry());
  const ov = document.createElement("div");
  ov.id = "aiExtOverlay";
  ov.className = "ai-ext-overlay";
  ov.innerHTML = `<div class="ai-ext" role="dialog" aria-modal="true" aria-labelledby="aiExtTitle">
    <div class="ai-ext-head">
      <span class="f-ai-ico"><i data-lucide="sparkles" aria-hidden="true"></i></span>
      <div><div class="ai-ext-title" id="aiExtTitle">Részletes AI-elemzés</div><div class="ai-ext-sub">${escapeHtml([entry.name, date].filter(Boolean).join(" · "))}</div></div>
      <button type="button" class="ai-ext-x" data-x="close" aria-label="Bezárás"><i data-lucide="x" aria-hidden="true"></i></button>
    </div>
    <div class="ai-ext-body">
      ${x.context ? `<div class="f-ai-ctxchip">„${escapeHtml(x.context)}”</div>` : ""}
      ${stale ? `<div class="f-ai-stale"><i data-lucide="info" aria-hidden="true"></i><span>Az edzés azóta módosult – az elemzés a korábbi adatokon készült.</span></div>` : ""}
      ${(x.sections || []).map((s) => `<section><h4>${escapeHtml(s.title)}</h4><p>${escapeHtml(s.text)}</p></section>`).join("")}
      ${(x.tips || []).length ? `<section class="ai-ext-tips"><h4>Következő edzésekre</h4><ul>${x.tips.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul></section>` : ""}
    </div>
    <div class="ai-ext-foot">
      <button type="button" class="f-ai-link" data-x="rerun" ${_status?.remaining > 0 ? "" : "disabled"} title="Új részletes elemzés – a napi keretből számít (ma még ${_status?.remaining ?? 0})"><i data-lucide="refresh-cw" aria-hidden="true"></i>Újragenerálás</button>
      <span class="f-ai-tag">AI-generált</span>
      <button type="button" class="ai-ext-close" data-x="close">Bezárás</button>
    </div>
  </div>`;
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", async (e) => {
    if (e.target === ov || e.target.closest('[data-x="close"]')) return close();
    const rb = e.target.closest('[data-x="rerun"]');
    if (rb && !rb.disabled) {
      if (!confirmRerun("részletes elemzést")) return;
      close();
      if (await run(id, entry, x.context || "", "extended")) openExtended(id, entry);
    }
  });
  document.body.append(ov);
  window.lucide?.createIcons({ root: ov });
  ov.querySelector(".ai-ext-x")?.focus();
}

// ── Összesítő a modellnek ────────────────────────────────────────────────────

const R = 6371000;
function hav(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const r1 = (v) => Math.round(v * 10) / 10;
const avg = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
const txt = (id) => {
  const el = document.getElementById(id);
  const row = document.getElementById(id + "Row");
  if (!el || (row && row.hidden)) return undefined;
  const t = el.textContent.trim();
  return t && t !== "—" ? t : undefined;
};

function buildSummary(g, entry) {
  // Szakaszok: 5 km-enként (hosszú túránál 10 km-enként), legfeljebb ~16 szakasz
  let total = 0;
  for (let i = 1; i < g.length; i++) total += hav(g[i - 1], g[i]);
  const step = total > 80000 ? 10000 : 5000;
  const splits = [];
  let cur = null, acc = 0;
  const flush = () => {
    if (!cur || cur.dist < 300) return;
    // a tempó a mozgásidőből (a megállások nélkül); a megállás külön szerepel
    const elapsed = cur.t1 && cur.t0 ? (cur.t1 - cur.t0) / 1000 : null;
    const stop = elapsed ? Math.max(0, elapsed - cur.move) : 0;
    splits.push({
      km: `${r1(cur.from / 1000)}–${r1((cur.from + cur.dist) / 1000)}`,
      mozgasido_perc: cur.move ? Math.round(cur.move / 60) : undefined,
      atlagseb_kmh: cur.move ? r1(cur.dist / 1000 / (cur.move / 3600)) : undefined,
      megallas_perc: stop >= 60 ? Math.round(stop / 60) : undefined,
      pulzus: cur.hr.length ? Math.round(avg(cur.hr)) : undefined,
      teljesitmeny_w: cur.pw.length ? Math.round(avg(cur.pw)) : undefined,
      emelkedes_m: Math.round(cur.gain),
    });
  };
  for (let i = 0; i < g.length; i++) {
    const p = g[i];
    if (!cur) cur = { from: acc, dist: 0, t0: p.time, t1: p.time, move: 0, hr: [], pw: [], gain: 0 };
    if (i) {
      const d = hav(g[i - 1], p);
      acc += d; cur.dist += d;
      // mozgásnak számít, ha a két pont között legalább ~2 km/h volt a sebesség
      const dt = p.time && g[i - 1].time ? (p.time - g[i - 1].time) / 1000 : 0;
      if (dt > 0 && d / dt * 3.6 >= 2) cur.move += dt;
      if (p.ele != null && g[i - 1].ele != null && p.ele > g[i - 1].ele) cur.gain += p.ele - g[i - 1].ele;
    }
    if (p.time) cur.t1 = p.time;
    if (p.hr) cur.hr.push(p.hr);
    if (p.power != null) cur.pw.push(p.power);
    if (cur.dist >= step) { flush(); cur = null; }
  }
  flush();

  const zones = (calcHrZoneStats(g).zones || []).filter((z) => z.pct >= 1).map((z) => `${z.name}: ${Math.round(z.pct)}%`);
  const start = g.find((p) => p.time)?.time;
  return {
    nev: entry?.name,
    sport: entry?.sport_type || txt("fileMetaType"),
    kezdes: start ? new Date(start).toLocaleString("hu-HU", { dateStyle: "medium", timeStyle: "short" }) : undefined,
    tav: txt("fileDistance"), mozgasido: txt("fileMovingDur"), teljes_ido: txt("fileTotalDur"),
    atlagsebesseg: txt("fileAvgSpeed"), max_sebesseg: txt("fileMaxSpeed"),
    emelkedes: txt("fileAscent"), lejtes: txt("fileDescent"),
    pulzus_atlag: txt("fileAvgHr"), pulzus_max: txt("fileMaxHr"),
    kadencia_atlag: txt("fileAvgCad"), teljesitmeny_atlag: txt("fileAvgPower"), teljesitmeny_max: txt("fileMaxPower"),
    kaloria: txt("fileKcal"),
    pulzuszonak: zones.length ? zones : undefined,
    szakaszok: splits,
  };
}

// Korábbi hasonló edzések (azonos sport, ±30% táv) – összehasonlításhoz
function buildHistory(entry) {
  const dist = Number(entry?.distance) || 0;
  const sport = entry?.sport_type;
  return (_deps.listWorkouts() || [])
    .filter((w) => w.id !== entry?.id && (!sport || w.sport_type === sport) && dist && w.distance
      && Math.abs(w.distance - dist) / dist <= 0.3)
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, 8)
    .map((w) => ({ datum: w.date, tav_km: w.distance, ido_perc: w.duration, emelkedes_m: w.elevation,
                   atlagseb_kmh: w.avg_speed_kmh, pulzus_atlag: w.avg_heartrate }));
}
