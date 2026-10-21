/**
 * Bringaterv – Útvonal beküldése a közösségi útvonalak közé
 * ==========================================================
 * A könyvtár „⋯” menüjéből / a lista lenyitott sorából nyílik. Kötelező űrlap
 * (név, leírás, típus, nehézség, évszak); a beküldés admin jóváhagyásra vár,
 * az eredményről a felhasználó értesítést kap. A szerver a nyomvonalból csak a
 * koordinátákat és a magasságot tartja meg.
 */

import { authHeaders, getUser, handle401 } from "../auth.js";

const TYPES = [["asphalt", "Aszfalt"], ["gravel", "Gravel"], ["mtb", "MTB"], ["hiking", "Túra"]];
const DIFFS = [["easy", "Könnyű"], ["medium", "Közepes"], ["hard", "Nehéz"]];
const SEASONS = [["", "– nincs megadva –"], ["all", "Egész évben"], ["spring-autumn", "Tavasztól őszig"],
                 ["summer", "Nyáron"], ["dry", "Száraz időben"]];

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Alapértelmezett típus a könyvtári elemből (tervnél a tervezési mód, edzésnél a sport). */
function guessType(route) {
  const t = String(route.type || "").toLowerCase();
  if (TYPES.some(([k]) => k === t)) return t;
  const sp = String(route.sport_type || "").toLowerCase();
  if (sp.includes("hike") || sp.includes("walk")) return "hiking";
  if (sp.includes("mountain")) return "mtb";
  if (sp.includes("gravel")) return "gravel";
  return "asphalt";
}

function seg(name, items, value) {
  return `<div class="fb-cats sr-seg" role="radiogroup">${items.map(([v, l]) => `
    <label class="fb-cat"><input type="radio" name="${name}" value="${v}" ${v === value ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>`;
}

export function openSubmitRouteModal(route) {
  document.getElementById("submitRouteOverlay")?.remove();
  const myName = getUser()?.name || "";
  const ov = document.createElement("div");
  ov.id = "submitRouteOverlay";
  ov.className = "install-guide-overlay";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.innerHTML = `
    <form class="install-guide fb-card" novalidate>
      <div class="install-guide-head" style="padding:18px 18px 0">
        <div>
          <h3>Beküldés a közösségi útvonalak közé</h3>
          <p>Jóváhagyás után mindenki megtalálja a Könyvtár → Közösségi útvonalak között.</p>
        </div>
        <button type="button" class="install-guide-close" data-close aria-label="Bezárás">×</button>
      </div>
      <div class="fb-body">
        <label class="fb-label" for="srName">Név</label>
        <input id="srName" name="name" class="fb-input" maxlength="100" value="${esc(route.name || "")}" required>
        <label class="fb-label" for="srDesc">Leírás</label>
        <textarea id="srDesc" name="description" class="fb-input fb-textarea" rows="5" maxlength="4000" required
          placeholder="Milyen az út? Burkolat, forgalom, emelkedők, látnivalók, kávézók, vízvételi helyek, mire figyeljenek…">${esc(route.description || "")}</textarea>
        <div class="fb-label">Típus</div>
        ${seg("type", TYPES, guessType(route))}
        <div class="fb-label">Nehézség</div>
        ${seg("difficulty", DIFFS, "medium")}
        <label class="fb-label" for="srSeason">Mikor ajánlott?</label>
        <select id="srSeason" name="season" class="fb-input">${SEASONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        <div class="fb-label">Beküldőként megjelenő név</div>
        <div class="sr-author">
          <label class="sr-radio"><input type="radio" name="author_mode" value="anonymous"><span>Névtelenül</span></label>
          <label class="sr-radio"><input type="radio" name="author_mode" value="name" checked><span>A nevemmel${myName ? ` <small>(${esc(myName)})</small>` : ""}</span></label>
          <label class="sr-radio"><input type="radio" name="author_mode" value="alias"><span>Becenévvel</span></label>
          <input name="author_alias" class="fb-input sr-alias" maxlength="40" placeholder="pl. Gravel Gabi" hidden>
        </div>
        <p class="sr-note">Csak a nyomvonal és a szintadat kerül át – időpontok, pulzus, sebesség és egyéb személyes adat nem. Az admin a leírást jóváhagyás előtt pontosíthatja; az eredményről értesítést kapsz.</p>
        <p class="fb-error" role="alert" hidden></p>
      </div>
      <div class="fb-actions">
        <button type="button" class="fb-btn" data-close>Mégse</button>
        <button type="submit" class="fb-btn fb-btn--primary">Beküldés</button>
      </div>
    </form>`;
  document.body.appendChild(ov);

  const form = ov.querySelector("form"), err = ov.querySelector(".fb-error");
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest("[data-close]")) close(); });
  form.addEventListener("change", (e) => {
    if (e.target.name !== "author_mode") return;
    const alias = form.elements.author_alias;
    alias.hidden = e.target.value !== "alias";
    if (!alias.hidden) alias.focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const f = form.elements;
    const name = f.name.value.trim(), description = f.description.value.trim();
    const fail = (m, el) => { err.textContent = m; err.hidden = false; el?.focus(); };
    if (name.length < 3) return fail("Adj meg egy nevet az útvonalnak.", f.name);
    if (description.length < 20) return fail("Írj egy rövid leírást (legalább 1–2 mondat): milyen az út, mire figyeljenek.", f.description);
    const authorMode = f.author_mode.value;
    const authorAlias = f.author_alias.value.trim();
    if (authorMode === "alias" && authorAlias.length < 2) return fail("Add meg a becenevet.", f.author_alias);
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true; btn.textContent = "Beküldés…";
    try {
      const res = await fetch("/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          route_id: route.id, name, description,
          type: f.type.value, difficulty: f.difficulty.value, season: f.season.value,
          author_mode: authorMode, author_alias: authorAlias,
        }),
      });
      if (res.status === 401) { handle401(); return; }
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      form.innerHTML = `
        <div class="fb-done">
          <div class="fb-done-icon" aria-hidden="true">✓</div>
          <h3>Köszönjük, beküldve!</h3>
          <p>Az admin átnézi, és ha rendben van, bekerül a közösségi útvonalak közé. Az eredményről értesítést kapsz.</p>
          <button type="button" class="fb-btn fb-btn--primary" data-close>Bezárás</button>
        </div>`;
    } catch (ex) {
      fail(ex.message);
      btn.disabled = false; btn.textContent = "Beküldés";
    }
  });
}
