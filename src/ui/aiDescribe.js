/**
 * Bringaterv – „AI-leírás” gomb az útvonal leírás-mezője mellé
 * =============================================================
 * A tervező mentés-ablakában (#exportDesc) és a könyvtár szerkesztőjében (#libraryEditDesc).
 * A szerver a nyomvonalból kiszámolja a helyadatot (megye, rajt, érintett települések),
 * és a burkolat-arányokból, domborzatból rövid leírást ír (POST /api/ai/route-description).
 * A gomb csak akkor látszik, ha a felhasználónak elérhető az AI (beállítva, engedélyezve, nincs kikapcsolva).
 */

import { routesApi } from "../api/routesApi.js";
import { createToast } from "./dom.js";

const toast = (msg) => (createToast(document.querySelector("#toast")))(msg);

let _status;            // undefined: még nem kérdeztük; null: nem elérhető
let _loading = null;

function loadStatus() {
  if (_status !== undefined) return Promise.resolve(_status);
  _loading ??= routesApi.aiStatus().then((s) => { _status = s; }).catch(() => { _status = null; });
  return _loading.then(() => _status);
}

const usable = (s) => !!(s && s.configured && s.allowed && !s.user_off);

/**
 * A leírás-mező címkéjébe tesz egy „AI-leírás” gombot.
 * @param {HTMLTextAreaElement} textarea
 * @param {() => object|null} getPayload  a kérés törzse ({ route_id } vagy { points, surface, … }); null → nincs mit leírni
 */
export function attachAiDescribe(textarea, getPayload) {
  if (!textarea || textarea.dataset.aiDescribe) return;
  textarea.dataset.aiDescribe = "1";
  const label = document.querySelector(`label[for="${textarea.id}"]`);
  if (!label) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ai-desc-btn";
  btn.hidden = true;
  btn.innerHTML = '<i data-lucide="sparkles" aria-hidden="true"></i><span>AI-leírás</span>';
  label.classList.add("has-ai-desc");
  label.appendChild(btn);
  window.lucide?.createIcons({ root: label });

  const refresh = () => loadStatus().then((s) => {
    btn.hidden = !usable(s);
    if (usable(s)) btn.title = `Leírás a nyomvonal alapján: megye, érintett települések, burkolat, terep – a napi AI-keretből (ma még ${s.remaining})`;
    btn.disabled = usable(s) && s.remaining <= 0;
  });
  // a modal megnyitásakor (a mező kiürül / betöltődik) frissítünk
  new MutationObserver(refresh).observe(textarea.closest("[hidden], .shortcut-overlay") || textarea, { attributes: true, attributeFilter: ["hidden"] });
  refresh();

  btn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    const payload = getPayload();
    if (!payload) { toast("Előbb tervezz egy útvonalat."); return; }
    const current = textarea.value.trim();
    if (current && !window.confirm("A jelenlegi leírást az AI átírja (a benne lévő tényeket megtartja). Folytatod?")) return;
    const span = btn.querySelector("span");
    btn.disabled = true; btn.classList.add("is-busy"); span.textContent = "Írás…";
    textarea.classList.add("is-ai-busy");
    try {
      const r = await routesApi.aiRouteDescription({ ...payload, current });
      if (r?.description) {
        textarea.value = r.description;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (r?.status) _status = r.status;
    } catch (err) {
      toast(err.message || "Nem sikerült leírást kérni.");
    } finally {
      btn.classList.remove("is-busy"); span.textContent = "AI-leírás";
      textarea.classList.remove("is-ai-busy");
      refresh();
    }
  });
}
