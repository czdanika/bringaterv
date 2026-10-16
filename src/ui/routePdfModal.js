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
  el.waypoints.closest(".pdf-toggle")?.classList.toggle("is-disabled", !hasWp);

  resetPreview();
  el.overlay.hidden = false;
  window.lucide?.createIcons?.();
}

function normalizeStyle(s) {
  return ["standard", "light", "topo", "satellite"].includes(s) ? s : "standard";
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
    includeQr: el.qr.checked,
    includeElevation: el.elev.checked,
    includeSurface: el.surface.checked,
    includeWaypoints: el.waypoints.checked && !el.waypoints.disabled,
    preview,
    onProgress: (s) => { if (el.status) el.status.textContent = s; },
  };
}

async function run(preview) {
  if (!_ctx) return;
  const btn = preview ? el.previewBtn : el.download;
  const others = preview ? el.download : el.previewBtn;
  btn.disabled = true; if (others) others.disabled = true;
  if (el.empty) el.empty.hidden = true;
  if (el.loading) { el.loading.hidden = false; el.status.textContent = "Előnézet készítése…"; }
  try {
    const result = await exportRoutePdf(gatherOpts(preview));
    if (preview && result) {
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
    btn.disabled = false; if (others) others.disabled = false;
  }
}
