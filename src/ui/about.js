/**
 * Bringaterv – Névjegy
 * =====================
 * ☰ → Névjegy (és a menü alján a verziószám): embléma, verzió, linkek
 * (súgó, hibajelentés, adatkezelés), a fejlesztő.
 * A frissítési állapot csak adminnak látszik (a felhasználó úgysem tud frissíteni).
 * Mobilon is elérhető – ott az oldalsáv alján lévő verziószám nem látszik.
 */

import { getUser } from "../auth.js";
import { config } from "../config.js";

let _isNewer = () => false;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function updateLine() {
  const cur = window.APP_VERSION || "";
  const latest = window.__bringatervLatest;
  if (!latest?.tag) return "";
  if (_isNewer(latest.tag, cur)) {
    return `<span class="about-badge about-badge--new">Új verzió érhető el: ${esc(latest.tag)}</span>
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
      ${user.role === "admin" ? `<div class="about-update">${updateLine()}</div>` : ""}
      <nav class="about-links">
        <a href="./help.html">Súgó</a>
        <a href="#" data-open-feedback>Hibajelentés, ötlet</a>
        <a href="./privacy.html" target="_blank" rel="noopener">Adatkezelés</a>
        ${config.contactEmail ? `<a href="mailto:${esc(config.contactEmail)}">Kapcsolat: ${esc(config.contactEmail)}</a>` : ""}
      </nav>
      <div class="about-dev">
        <img src="./src/assets/fejleszto.jpg" alt="" width="44" height="44">
        <div><small>Fejlesztő</small><b>Czibolya Dániel</b></div>
      </div>
      <p class="about-foot">© 2026 Bringaterv<br>Térkép: OpenStreetMap közreműködők · Útvonaltervezés: BRouter · Időjárás: Open-Meteo</p>
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
