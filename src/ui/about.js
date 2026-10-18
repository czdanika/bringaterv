/**
 * Bringaterv – Névjegy
 * =====================
 * ☰ → Névjegy (és a menü alján a verziószám): embléma, verzió, frissítési
 * állapot (a GitHub legutóbbi kiadásához képest), telepítési mód, linkek.
 * Mobilon is elérhető – ott az oldalsáv alján lévő verziószám nem látszik.
 */

import { getUser } from "../auth.js";
import { isStandalone } from "./installPrompt.js";

let _isNewer = () => false;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function updateLine() {
  const cur = window.APP_VERSION || "";
  const latest = window.__bringatervLatest;
  if (!latest?.tag) return `<span class="about-badge">Frissítés-ellenőrzés nem elérhető</span>`;
  if (_isNewer(latest.tag, cur)) {
    return `<a class="about-badge about-badge--new" href="${esc(latest.url || "https://github.com/czdanika/bringaterv/releases")}" target="_blank" rel="noopener">Új verzió érhető el: ${esc(latest.tag)} ↗</a>
      <p class="about-hint">Frissítés: Portainer → Stacks → bringaterv → Pull and redeploy (vagy <code>docker compose pull && docker compose up -d</code>), utána az appot indítsd újra.</p>`;
  }
  return `<span class="about-badge about-badge--ok">✓ Naprakész</span>`;
}

function openAbout() {
  document.getElementById("topnavDropdown")?.setAttribute("hidden", "");
  document.getElementById("aboutOverlay")?.remove();
  const user = getUser?.() || {};
  const ov = document.createElement("div");
  ov.id = "aboutOverlay";
  ov.className = "install-guide-overlay";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.innerHTML = `
    <div class="install-guide about-card">
      <button type="button" class="install-guide-close about-close" aria-label="Bezárás">×</button>
      <img class="about-logo" src="./src/assets/icons/icon-192.png" alt="" width="96" height="96">
      <div class="about-name">Bringa<span>terv</span></div>
      <div class="about-slogan">Tervezz, tekerj, fedezd fel!</div>
      <div class="about-version">${esc(window.APP_VERSION || "")}</div>
      <div class="about-update">${updateLine()}</div>
      <dl class="about-meta">
        ${user.name || user.email ? `<dt>Bejelentkezve</dt><dd>${esc(user.name || user.email)}</dd>` : ""}
        <dt>Futtatás</dt><dd>${isStandalone() ? "Telepített app" : "Böngészőben"}</dd>
        <dt>Szerver</dt><dd>${esc(location.host)}</dd>
      </dl>
      <nav class="about-links">
        <a href="./help.html">📖 Súgó és kézikönyv</a>
        <a href="#" data-open-feedback>🐞 Hibajelentés, ötlet</a>
        <a href="https://github.com/czdanika/bringaterv/releases" target="_blank" rel="noopener">✨ Újdonságok</a>
        <a href="./privacy.html" target="_blank" rel="noopener">🛡️ Adatkezelés</a>
        <a href="https://github.com/czdanika/bringaterv" target="_blank" rel="noopener">💻 Forráskód (GitHub)</a>
      </nav>
      <p class="about-foot">© Czibolya Dániel 2026 · MIT licenc<br>Térkép: OpenStreetMap közreműködők · Útvonaltervezés: BRouter · Időjárás: Open-Meteo</p>
    </div>`;
  const close = () => ov.remove();
  ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest(".about-close")) close(); });
  document.addEventListener("keydown", function esc_(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc_); } });
  document.body.appendChild(ov);
}

export function initAbout({ isNewerVersion } = {}) {
  if (isNewerVersion) _isNewer = isNewerVersion;
  document.getElementById("aboutButton")?.addEventListener("click", openAbout);
  const v = document.getElementById("dropdownVersion");
  if (v) {
    v.textContent = `Bringaterv ${window.APP_VERSION || ""}`;
    v.addEventListener("click", openAbout);
  }
}
