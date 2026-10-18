/**
 * Bringaterv – Visszajelzés (hibajelentés, ötlet, kérdés)
 * ========================================================
 * ☰ → Hibajelentés, ötlet (és a Névjegyből). Típus, terület, cím, leírás,
 * opcionális képernyőkép és technikai adatok. A szerver elmenti, és ha be van
 * állítva, e-mailben is továbbítja az adminnak (POST /api/feedback).
 */

import { authHeaders, handle401 } from "../auth.js";
import { isStandalone } from "./installPrompt.js";

// Egyszínű vonalikonok (lucide), hogy illeszkedjenek az app stílusához
const CATEGORIES = [
  ["bug", '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>', "Hiba"],
  ["idea", '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>', "Ötlet"],
  ["question", '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>', "Kérdés"],
  ["other", '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>', "Egyéb"],
];
const AREAS = [
  ["planning", "Tervezés"], ["analysis", "Elemzés"], ["library", "Könyvtár"],
  ["stats", "Statisztikák, rekordok"], ["sync", "Strava / Garmin"], ["share", "Megosztás"],
  ["mobile", "Mobil, telepített app"], ["settings", "Beállítások, fiók"], ["other", "Egyéb"],
];
const TAB_AREA = { plan: "planning", file: "analysis", library: "library", stats: "stats" };
const TAB_LABEL = { plan: "Tervezés", file: "Elemzés", library: "Könyvtár", stats: "Statisztikák" };
const PLACEHOLDER = {
  bug: "Mit csináltál, mit vártál, és mi történt helyette? Ha meg tudod ismételni, írd le a lépéseket.",
  idea: "Mit szeretnél, és miben segítene?",
  question: "Miben bizonytalan vagy?",
  other: "Írd le nyugodtan…",
};

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function techInfo() {
  const tab = document.querySelector(".sidebar-tab.is-active")?.dataset.tab;
  return {
    "Verzió": window.APP_VERSION || "",
    "Nézet": TAB_LABEL[tab] || tab || "",
    "Futtatás": isStandalone() ? "Telepített app" : "Böngésző",
    "Képernyő": `${screen.width}×${screen.height} @${window.devicePixelRatio || 1}x`,
    "Ablak": `${innerWidth}×${innerHeight}`,
    "Érintőképernyő": matchMedia("(pointer: coarse)").matches ? "igen" : "nem",
    "Téma": document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "sötét" : "világos"),
    "Nyelv": navigator.language || "",
    "Oldal": location.pathname + location.hash,
  };
}

export function openFeedback() {
  document.getElementById("topnavDropdown")?.setAttribute("hidden", "");
  document.getElementById("aboutOverlay")?.remove();
  document.getElementById("feedbackOverlay")?.remove();

  const tab = document.querySelector(".sidebar-tab.is-active")?.dataset.tab;
  const defArea = TAB_AREA[tab] || "other";
  const tech = techInfo();

  const ov = document.createElement("div");
  ov.id = "feedbackOverlay";
  ov.className = "install-guide-overlay";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.setAttribute("aria-labelledby", "fbTitleHead");
  ov.innerHTML = `
    <form class="install-guide fb-card" novalidate>
      <div class="install-guide-head">
        <div>
          <h3 id="fbTitleHead">Hibajelentés, ötlet</h3>
          <p>Köszönöm, hogy segítesz jobbá tenni a Bringatervet!</p>
        </div>
        <button type="button" class="install-guide-close" data-fb-close aria-label="Bezárás">×</button>
      </div>
      <div class="fb-body">
        <div class="fb-label">Típus</div>
        <div class="fb-cats" role="radiogroup" aria-label="Típus">
          ${CATEGORIES.map(([v, ic, l], i) => `
            <label class="fb-cat"><input type="radio" name="category" value="${v}" ${i === 0 ? "checked" : ""}>
              <span>${ic}${l}</span></label>`).join("")}
        </div>
        <label class="fb-label" for="fbArea">Melyik részt érinti?</label>
        <select id="fbArea" name="area" class="fb-input">
          ${AREAS.map(([v, l]) => `<option value="${v}" ${v === defArea ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <label class="fb-label" for="fbTitle">Rövid cím</label>
        <input id="fbTitle" name="title" class="fb-input" maxlength="140" autocomplete="off"
               placeholder="pl. Mobilon nem látszik a Mentés gomb" required>
        <label class="fb-label" for="fbDesc">Leírás</label>
        <textarea id="fbDesc" name="description" class="fb-input fb-textarea" maxlength="8000" rows="5"
                  placeholder="${esc(PLACEHOLDER.bug)}" required></textarea>
        <label class="fb-label" for="fbImage">Képernyőkép <span class="fb-opt">(nem kötelező)</span></label>
        <input id="fbImage" name="image" type="file" accept="image/*" class="fb-input fb-file">
        <label class="fb-check">
          <input type="checkbox" name="withTech" checked>
          <span>Technikai adatok csatolása <button type="button" class="fb-link" data-fb-tech>(mi ez?)</button></span>
        </label>
        <dl class="fb-tech" hidden>
          ${Object.entries(tech).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
          <dt>Böngésző</dt><dd>${esc(navigator.userAgent)}</dd>
        </dl>
        <p class="fb-error" role="alert" hidden></p>
      </div>
      <div class="fb-actions">
        <button type="button" class="fb-btn" data-fb-close>Mégse</button>
        <button type="submit" class="fb-btn fb-btn--primary">Küldés</button>
      </div>
    </form>`;

  const form = ov.querySelector("form");
  const errEl = ov.querySelector(".fb-error");
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", (e) => {
    if (e.target === ov || e.target.closest("[data-fb-close]")) close();
    if (e.target.closest("[data-fb-tech]")) { const t = ov.querySelector(".fb-tech"); t.hidden = !t.hidden; }
  });
  form.addEventListener("change", (e) => {
    if (e.target.name === "category") ov.querySelector("#fbDesc").placeholder = PLACEHOLDER[e.target.value];
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const fd = new FormData();
    const v = (n) => form.elements[n].value.trim();
    if (v("title").length < 3) return showErr("Adj meg egy rövid címet.", "title");
    if (v("description").length < 5) return showErr("Írd le röviden, mi történt.", "description");
    const img = form.elements.image.files[0];
    if (img && img.size > 8 * 1024 * 1024) return showErr("A kép legfeljebb 8 MB lehet.", "image");
    fd.append("category", form.elements.category.value);
    fd.append("area", form.elements.area.value);
    fd.append("title", v("title"));
    fd.append("description", v("description"));
    if (form.elements.withTech.checked) fd.append("tech", JSON.stringify(tech));
    if (img) fd.append("image", img);

    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    btn.textContent = "Küldés…";
    try {
      const res = await fetch("/api/feedback", { method: "POST", headers: authHeaders(), body: fd });
      if (res.status === 401) { handle401(); return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      form.innerHTML = `
        <div class="fb-done">
          <div class="fb-done-icon" aria-hidden="true">✓</div>
          <h3>Megkaptam, köszönöm!</h3>
          <p>A visszajelzésed eljutott a fejlesztőhöz.</p>
          <button type="button" class="fb-btn fb-btn--primary" data-fb-close>Bezárás</button>
        </div>`;
    } catch (err) {
      showErr(err.message === "Failed to fetch" ? "Nincs kapcsolat a szerverrel – próbáld újra." : err.message);
      btn.disabled = false;
      btn.textContent = "Küldés";
    }
  });

  function showErr(msg, field) {
    errEl.textContent = msg;
    errEl.hidden = false;
    if (field) form.elements[field]?.focus();
  }

  document.body.appendChild(ov);
  // Mobilon ne ugorjon fel azonnal a billentyűzet
  if (!matchMedia("(pointer: coarse)").matches) ov.querySelector("#fbTitle").focus();
}

export function initFeedback() {
  document.getElementById("feedbackButton")?.addEventListener("click", openFeedback);
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-open-feedback]")) { e.preventDefault(); openFeedback(); }
  });
}
