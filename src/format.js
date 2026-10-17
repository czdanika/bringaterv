/**
 * Bringaterv – közös szám- és időformázás
 * ========================================
 * Egy helyen: magyar tizedesvessző, magyar ezres tagolás (5 jegytől, a
 * helyesírás szerint), és egységes időtartam-formátum: „2 ó 20 p”, „46 p”.
 * Minden felhasználónak megjelenő értéket ezen keresztül formázunk.
 */

/** Szám magyar formában, fix tizedesjeggyel. num(48.73, 1) → "48,7" */
export function num(v, dec = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("hu-HU", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/** Egész szám magyar tagolással. int(12345) → "12 345" */
export function int(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("hu-HU");
}

/** Időtartam percből: 140 → "2 ó 20 p", 46 → "46 p", 0.5 → "30 mp" */
export function dur(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return "—";
  if (m < 1) return `${Math.round(m * 60)} mp`;
  const total = Math.round(m);
  const h = Math.floor(total / 60), r = total % 60;
  if (h === 0) return `${r} p`;
  return r ? `${h} ó ${r} p` : `${h} ó`;
}

/** Időtartam ezredmásodpercből (ld. dur). */
export function durMs(ms) {
  const v = Number(ms);
  return Number.isFinite(v) && v > 0 ? dur(v / 60000) : "—";
}
