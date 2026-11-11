/**
 * Bringaterv – PDF útvonallap beállító + előnézet modal vezérlő
 * =============================================================
 * A könyvtári „PDF" és a tervező „PDF letöltés" egyaránt ezt nyitja.
 *
 *   initRoutePdfModal({ getDefaultMapStyle });   // egyszer, induláskor
 *   openRoutePdfModal(context);                  // megnyitás adott útvonalra
 *
 * context: { title, filename, date, points, geometry, waypoints,
 *            distanceKm, ascentM, descentM, durationText, avgSpeedKmh, shareUrl }
 */

import { exportRoutePdf } from "./routePdf.js";
import { config } from "../config.js";
import { routesApi } from "../api/routesApi.js";

/**
 * Publikus megosztási alap-URL feloldása.
 * Sorrend: Beállítások mező (localStorage) → config.shareBaseUrl (env) → origin.
 */
export function resolveShareBase() {
  let base = "";
  try { base = (localStorage.getItem("bringaterv-share-base") || "").trim(); } catch (_) {}
  if (!base) base = (config && config.shareBaseUrl) || "";
  if (!base) base = location.origin;
  return base.replace(/\/+$/, "");
}

/** Publikus nézőoldal URL-je egy mentett útvonal/edzés id-jéhez. */
export function shareRouteUrl(id) {
  return `${resolveShareBase()}/view.html?route=${encodeURIComponent(id)}`;
}

/** A link útvonal-azonosítója (view.html?route=<id>), vagy null. */
export function routeIdFromShareUrl(url) {
  try { return new URL(url).searchParams.get("route"); } catch { return null; }
}

/** QR-kódos kimenet előtt: a link bekapcsolása, különben a QR „nem található” oldalra vinne. */
const _madePublic = new Set();
export async function ensureLinkPublic(url) {
  const id = url && routeIdFromShareUrl(url);
  if (!id || _madePublic.has(id)) return;
  try { await routesApi.setRoutePublic(id, true); _madePublic.add(id); }
  catch (err) { console.warn("Nyilvános link bekapcsolása sikertelen:", err); }
}
export function forgetLinkPublic(id) { _madePublic.delete(id); }

let _ctx = null;
let _getDefaultMapStyle = () => "standard";
let _initialized = false;
let _lastPreviewUrl = null;
const el = {};

export function initRoutePdfModal({ getDefaultMapStyle } = {}) {
  if (_initialized) return;
  if (getDefaultMapStyle) _getDefaultMapStyle = getDefaultMapStyle;

  el.overlay   = document.querySelector("#pdfOverlay");
  if (!el.overlay) return;
  el.close     = document.querySelector("#pdfClose");
  el.title     = document.querySelector("#pdfTitle");
  el.mapStyle  = document.querySelector("#pdfMapStyle");
  el.note      = document.querySelector("#pdfNote");
  el.filename  = document.querySelector("#pdfFilename");
  el.qr        = document.querySelector("#pdfQr");
  el.elev      = document.querySelector("#pdfElev");
  el.speed     = document.querySelector("#pdfSpeed");
  el.hr        = document.querySelector("#pdfHr");
  el.cad       = document.querySelector("#pdfCad");
  el.power     = document.querySelector("#pdfPower");
  el.surface   = document.querySelector("#pdfSurface");
  el.waypoints = document.querySelector("#pdfWaypoints");
  el.frame     = document.querySelector("#pdfPreviewFrame");
  el.empty     = document.querySelector("#pdfPreviewEmpty");
  el.loading   = document.querySelector("#pdfPreviewLoading");
  el.status    = document.querySelector("#pdfPreviewStatus");
  el.previewBtn= document.querySelector("#pdfPreviewBtn");
  el.download  = document.querySelector("#pdfDownload");

  el.close?.addEventListener("click", closeModal);
  el.overlay.addEventListener("click", (e) => { if (e.target === el.overlay) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.overlay.hidden) closeModal();
  });
  el.previewBtn?.addEventListener("click", () => run(true));
  el.download?.addEventListener("click", () => run(false));
  // minden változás után magától frissül az előnézet (gépelésnél kis késleltetéssel); a választás megmarad
  const body = el.overlay.querySelector(".pdf-options");
  body?.addEventListener("change", (e) => { savePrefs(); syncSummary(); if (e.target.id !== "pdfFilename") schedulePreview(300); });
  body?.addEventListener("input", (e) => { if (e.target.matches("#pdfTitle, #pdfNote")) { syncSummary(); schedulePreview(900); } });

  _initialized = true;
}

export function openRoutePdfModal(context) {
  if (!_initialized) initRoutePdfModal();
  if (!el.overlay) return;
  _ctx = context || {};

  el.title.value = _ctx.title || "";
  el.filename.value = (_ctx.filename || _ctx.title || "utvonalterv").replace(/\.pdf$/i, "");
  el.note.value = "";
  el.mapStyle.value = normalizeStyle(_getDefaultMapStyle());
  // Pontok listája csak akkor engedélyezve, ha van legalább 2 waypont
  const hasWp = Array.isArray(_ctx.waypoints) && _ctx.waypoints.length >= 2;
  el.waypoints.checked = false;
  el.waypoints.disabled = !hasWp;
  el.waypoints.closest(".pdf-row")?.classList.toggle("is-disabled", !hasWp);
  // Mért adatok (letekert edzés): csak akkor aktív a kapcsoló, ha van adat
  const geo = _ctx.geometry || [];
  const setToggle = (input, field, defaultOn) => {
    if (!input) return;
    const has = geo.some((p) => p[field] != null);
    input.checked = has && defaultOn;
    input.disabled = !has;
    input.closest(".pdf-row")?.classList.toggle("is-disabled", !has);
  };
  setToggle(el.speed, "speed", true);
  setToggle(el.hr, "hr", true);
  setToggle(el.cad, "cad", true);
  setToggle(el.power, "power", true);   // minden mért adat alapból bekerül, ami van
  // QR csak valódi (mentett) linkhez
  const hasUrl = !!_ctx.shareUrl;
  el.qr.checked = hasUrl;
  el.qr.disabled = !hasUrl;
  el.qr.closest(".pdf-row")?.classList.toggle("is-disabled", !hasUrl);

  // a legutóbbi választás (tájolás, grafikonok, kiegészítők) – ami ennél az útvonalnál nem érhető el, kimarad
  const pr = loadPrefs();
  if (pr.orientation) { const r = document.querySelector(`input[name="pdfOrient"][value="${pr.orientation}"]`); if (r) r.checked = true; }
  if (pr.mapStyle) el.mapStyle.value = normalizeStyle(pr.mapStyle);
  for (const k of ["elev", "speed", "hr", "cad", "power", "surface", "waypoints", "qr"]) {
    const inp = el[k];
    if (inp && !inp.disabled && typeof pr[k] === "boolean") inp.checked = pr[k];
  }

  resetPreview();
  syncSummary();
  el.overlay.hidden = false;
  window.lucide?.createIcons?.();
  schedulePreview(50);
}

const PREF_KEY = "bt.pdfOpts";
function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {}; } catch { return {}; } }
function savePrefs() {
  const pr = { orientation: document.querySelector('input[name="pdfOrient"]:checked')?.value, mapStyle: el.mapStyle.value };
  for (const k of ["elev", "speed", "hr", "cad", "power", "surface", "waypoints", "qr"]) if (el[k] && !el[k].disabled) pr[k] = el[k].checked;
  try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...loadPrefs(), ...pr })); } catch { /* privát mód */ }
}
/** A csoportfejlécek összefoglalója (mi van bekapcsolva). */
function syncSummary() {
  const on = (list) => list.filter(([k]) => el[k] && el[k].checked && !el[k].disabled).map(([, l]) => l);
  const set = (k, t) => { const e = el.overlay.querySelector(`[data-pdf-sum="${k}"]`); if (e) e.textContent = t; };
  const ch = on([["elev", "szint"], ["speed", "sebesség"], ["hr", "pulzus"], ["cad", "kadencia"], ["power", "telj."]]);
  set("charts", ch.length ? ch.join(", ") : "nincs");
  const ex = on([["surface", "burkolat"], ["waypoints", "pontok"], ["qr", "QR"]]);
  set("extras", ex.length ? ex.join(", ") : "nincs");
  set("text", el.note.value.trim() ? "van megjegyzés" : "");
}

let _pvTimer = null, _pvSeq = 0, _pvBusy = false, _pvAgain = false;
function schedulePreview(ms = 400) {
  clearTimeout(_pvTimer);
  _pvTimer = setTimeout(() => run(true), ms);
}

function normalizeStyle(s) {
  return ["standard", "cycling", "topo", "terrain", "satellite", "hybrid", "light", "dark"].includes(s) ? s : "standard";
}

function closeModal() {
  if (!el.overlay) return;
  el.overlay.hidden = true;
  resetPreview();
}

function resetPreview() {
  if (_lastPreviewUrl) { try { URL.revokeObjectURL(_lastPreviewUrl); } catch (_) {} _lastPreviewUrl = null; }
  if (el.frame) { el.frame.hidden = true; el.frame.removeAttribute("src"); }
  if (el.empty) el.empty.hidden = false;
  if (el.loading) el.loading.hidden = true;
}

function gatherOpts(preview) {
  const orient = document.querySelector('input[name="pdfOrient"]:checked')?.value || "portrait";
  return {
    ...(_ctx || {}),
    title: el.title.value.trim() || "Útvonalterv",
    filename: el.filename.value.trim() || "utvonalterv",
    note: el.note.value,
    mapStyle: el.mapStyle.value,
    orientation: orient,
    includeQr: el.qr.checked && !el.qr.disabled,
    includeElevation: el.elev.checked,
    includeSpeed: !!el.speed?.checked && !el.speed.disabled,
    includeHr: !!el.hr?.checked && !el.hr.disabled,
    includeCadence: !!el.cad?.checked && !el.cad.disabled,
    includePower: !!el.power?.checked && !el.power.disabled,
    includeSurface: el.surface.checked,
    includeWaypoints: el.waypoints.checked && !el.waypoints.disabled,
    preview,
    onProgress: (s) => { if (el.status) el.status.textContent = s; },
  };
}

async function run(preview) {
  if (!_ctx) return;
  if (preview) {
    if (_pvBusy) { _pvAgain = true; return; }
    _pvBusy = true;
  }
  const mySeq = preview ? ++_pvSeq : 0;
  const btn = preview ? el.previewBtn : el.download;
  btn.disabled = true;
  if (el.empty) el.empty.hidden = true;
  if (el.loading) { el.loading.hidden = false; el.status.textContent = preview ? "Előnézet készítése…" : "PDF készítése…"; }
  try {
    const opts = gatherOpts(preview);
    if (opts.includeQr && opts.shareUrl && !preview) await ensureLinkPublic(opts.shareUrl);
    const result = await exportRoutePdf(opts);
    if (preview && result && mySeq === _pvSeq && !el.overlay.hidden) {
      const blob = await (await fetch(result)).blob();
      if (_lastPreviewUrl) { try { URL.revokeObjectURL(_lastPreviewUrl); } catch (_) {} }
      _lastPreviewUrl = URL.createObjectURL(blob);
      el.frame.src = _lastPreviewUrl;
      el.frame.hidden = false;
    }
  } catch (err) {
    console.error("PDF hiba:", err);
    if (el.empty) { el.empty.hidden = false; el.empty.querySelector("p").textContent = "Nem sikerült a PDF készítése. Próbáld újra."; }
  } finally {
    if (el.loading) el.loading.hidden = true;
    btn.disabled = false;
    if (preview) {
      _pvBusy = false;
      if (_pvAgain && !el.overlay.hidden) { _pvAgain = false; run(true); }
    }
  }
}
