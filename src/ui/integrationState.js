/**
 * Lekapcsolt integrációk jelzése a felületen (admin → Integrációk).
 * Ha az admin egy szolgáltatót ideiglenesen lekapcsol, a Beállítások megfelelő
 * szakaszában figyelmeztetés jelenik meg (a gombok letiltva), a Könyvtár import-listájában
 * és a „Küldés eszközre” gomboknál az elem nem választható.
 *
 *   initIntegrationState({ api })
 */
let _off = new Set(), _msgs = {};

export function isIntegrationOff(key) { return _off.has(key); }

const EXPORT_BTN = { onelap: "#exportOnelap", garmin: "#exportGarmin", igpsport: "#exportIgpsport", bryton: "#exportBryton" };

function apply() {
  for (const key of _off) {
    const msg = _msgs[key] || "Ideiglenesen nem érhető el.";
    const sec = document.querySelector(`[data-settings-section="${key}"] .settings-section-body`);
    if (sec && !sec.querySelector(".int-off-note")) {
      const n = document.createElement("div");
      n.className = "int-off-note";
      n.textContent = msg;
      sec.prepend(n);
      sec.querySelectorAll("button, input, select").forEach((el) => { el.disabled = true; });
    }
    const imp = document.querySelector(`.library-import-item[data-import-src="${key}"]`);
    if (imp) { imp.disabled = true; imp.title = msg; imp.classList.add("is-int-off"); }
    const ex = EXPORT_BTN[key] && document.querySelector(EXPORT_BTN[key]);
    if (ex) ex.hidden = true;
  }
}

export async function initIntegrationState({ api }) {
  try {
    const r = await api.getIntegrations();
    _off = new Set(r.disabled || []);
    _msgs = r.messages || {};
  } catch { return; }
  if (!_off.size) return;
  apply();
  // a modulok később is átállíthatják a gombokat (kapcsolat-állapot betöltése) – utána újra
  setTimeout(apply, 2500);
  document.addEventListener("click", (e) => {
    if (e.target.closest("#settingsButton, .library-import-btn, [data-import-src]")) setTimeout(apply, 50);
  }, true);
}
