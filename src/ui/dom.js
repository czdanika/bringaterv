import { num } from "../format.js";
export function createToast(element) {
  let timeoutId;
  return function showToast(message, duration = 3200) {
    clearTimeout(timeoutId);
    element.textContent = message;
    element.classList.add("is-visible");
    timeoutId = setTimeout(() => element.classList.remove("is-visible"), duration);
  };
}

export function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${num(meters / 1000, 1)} km`;
}

/**
 * Eredmény-ablak (pl. „Elküldve az OnelapFitre”) – jól látható visszajelzés egy
 * hosszabb művelet végén, OK-val / Escape-pel / a háttérre kattintva zárható.
 * @param {{ ok?: boolean, title: string, lines?: string[], icon?: string }} opts
 *   lines: sima szöveg (escape-elve), icon: kép útvonala (pl. márka-ikon)
 * @returns {Promise<void>} bezáráskor teljesül
 */
export function showResultDialog({ ok = true, title, lines = [], icon = null }) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ov = document.createElement("div");
  ov.className = "shortcut-overlay result-dialog-overlay";
  ov.innerHTML = `
    <div class="export-panel result-dialog" role="alertdialog" aria-modal="true" aria-labelledby="resultDialogTitle">
      <div class="result-dialog-body">
        <div class="result-dialog-badge ${ok ? "is-ok" : "is-error"}">
          ${icon ? `<img class="brand-icon" src="${esc(icon)}" width="44" height="44" alt="">` : ""}
          <span class="result-dialog-mark" aria-hidden="true">${ok ? "✓" : "!"}</span>
        </div>
        <h3 id="resultDialogTitle">${esc(title)}</h3>
        ${lines.map((l) => `<p>${esc(l)}</p>`).join("")}
      </div>
      <div class="export-footer">
        <button class="export-confirm-btn export-confirm-btn--primary result-dialog-ok" type="button">OK</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const okBtn = ov.querySelector(".result-dialog-ok");
  okBtn.focus();
  return new Promise((resolve) => {
    const close = () => {
      document.removeEventListener("keydown", onKey);
      ov.remove();
      resolve();
    };
    const onKey = (e) => { if (e.key === "Escape" || e.key === "Enter") close(); };
    document.addEventListener("keydown", onKey);
    okBtn.addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  });
}
