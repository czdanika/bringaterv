/**
 * Beállítások → Megosztás → „Megosztott linkjeim”: a nyilvánosan megosztott útvonalak és edzések
 * egy helyen – hányszor nyitották meg, mi látszik rajtuk (kapcsolók), link másolása, megnyitás,
 * a link kikapcsolása (a megosztás „törlése”) és a számláló nullázása.
 *
 *   initSharedLinks({ api, shareUrl })   shareUrl(id) → a nézőoldal linkje
 */
import { viewsText } from "./shareModal.js";
import { forgetLinkPublic } from "./routePdfModal.js";

const ITEMS = [
  ["hr", "Pulzus"], ["power", "Teljesítmény"], ["cad", "Kadencia"], ["temp", "Hőmérséklet"],
  ["wind", "Szél"], ["desc", "Leírás"], ["cards", "Elemzés-kártyák"],
];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let _deps = null, _items = [], _open = null;

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(String(iso).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("hu-HU", { year: "numeric", month: "short", day: "numeric" });
}

function render() {
  const box = document.getElementById("sharedLinksList");
  if (!box) return;
  if (!_items.length) {
    box.innerHTML = `<div class="shl-empty">Most nincs nyilvánosan megosztott útvonalad vagy edzésed. A Könyvtárban vagy az Elemzésben a Megosztás ablakban kapcsolhatod be.</div>`;
    return;
  }
  const total = _items.reduce((a, x) => a + (x.views || 0), 0);
  box.innerHTML = `<div class="shl-sum">${_items.length} megosztott link · összesen ${total} megnyitás</div>`
    + _items.map((it) => {
      const hide = new Set(it.share?.hide || []);
      const open = _open === it.id;
      return `<div class="shl-row${open ? " is-open" : ""}" data-id="${esc(it.id)}">
        <button type="button" class="shl-main" data-act="toggle" aria-expanded="${open}">
          <span class="shl-ico"><i data-lucide="${it.type === "workout" ? "activity" : "route"}" aria-hidden="true"></i></span>
          <span class="shl-txt"><b>${esc(it.name || "Névtelen")}</b>
            <small>${[it.distance ? `${Number(it.distance).toLocaleString("hu-HU", { maximumFractionDigits: 1 })} km` : "", it.shared_at ? `megosztva ${fmtDate(it.shared_at)}` : ""].filter(Boolean).join(" · ")}</small></span>
          <span class="shl-views" title="Megnyitások (a saját megnyitásaid nem számítanak)"><i data-lucide="eye" aria-hidden="true"></i>${it.views || 0}</span>
          <i data-lucide="chevron-down" class="shl-chev" aria-hidden="true"></i>
        </button>
        ${open ? `<div class="shl-body">
          <div class="shl-stat">${viewsText(it.views, it.last_view_at)}</div>
          <div class="shl-what-t">Mi látszik a linken?</div>
          <div class="share-what-grid">${ITEMS.map(([k, l]) => `<label class="share-what-item"><span>${l}</span><span class="toggle-switch"><input type="checkbox" data-what="${k}"${hide.has(k) ? "" : " checked"}><span class="toggle-track"></span></span></label>`).join("")}</div>
          <div class="shl-acts">
            <button type="button" class="shl-btn" data-act="copy"><i data-lucide="copy" aria-hidden="true"></i><span>Link másolása</span></button>
            <a class="shl-btn" href="${esc(_deps.shareUrl(it.id))}" target="_blank" rel="noopener"><i data-lucide="external-link" aria-hidden="true"></i><span>Megnyitás</span></a>
            ${it.views ? `<button type="button" class="shl-btn" data-act="reset"><i data-lucide="rotate-ccw" aria-hidden="true"></i><span>Számláló nullázása</span></button>` : ""}
            <button type="button" class="shl-btn shl-btn--danger" data-act="off"><i data-lucide="link-2-off" aria-hidden="true"></i><span>Megosztás kikapcsolása</span></button>
          </div>
        </div>` : ""}
      </div>`;
    }).join("");
  window.lucide?.createIcons({ root: box });
}

async function load() {
  const box = document.getElementById("sharedLinksList");
  if (!box) return;
  if (!_items.length) box.innerHTML = `<div class="shl-empty">Betöltés…</div>`;
  try {
    _items = (await _deps.api.getSharedRoutes()).items || [];
  } catch (err) {
    console.warn("Megosztott linkek:", err);
    box.innerHTML = `<div class="shl-empty">A listát most nem sikerült betölteni.</div>`;
    return;
  }
  render();
}

async function onClick(e) {
  const row = e.target.closest(".shl-row");
  const btn = e.target.closest("[data-act]");
  if (!row || !btn) return;
  const id = row.dataset.id;
  const it = _items.find((x) => x.id === id);
  if (!it) return;
  const act = btn.dataset.act;
  if (act === "toggle") { _open = _open === id ? null : id; render(); return; }
  if (act === "copy") {
    const url = _deps.shareUrl(id);
    try { await navigator.clipboard.writeText(url); } catch { prompt("Link:", url); return; }
    const sp = btn.querySelector("span"); sp.textContent = "Másolva"; setTimeout(() => { sp.textContent = "Link másolása"; }, 1500);
    return;
  }
  if (act === "reset") {
    if (!confirm(`Nullázod a(z) „${it.name}” megnyitás-számlálóját?`)) return;
    try { await _deps.api.resetShareViews(id); it.views = 0; it.last_view_at = null; render(); } catch { alert("Nem sikerült nullázni."); }
    return;
  }
  if (act === "off") {
    if (!confirm(`Kikapcsolod a(z) „${it.name}” nyilvános linkjét? A link és a QR-kód ezután nem működik (később újra bekapcsolhatod, ugyanazzal a címmel).`)) return;
    btn.disabled = true;
    try {
      await _deps.api.setRoutePublic(id, false);
      forgetLinkPublic(id);
      _items = _items.filter((x) => x.id !== id);
      render();
    } catch { btn.disabled = false; alert("Nem sikerült kikapcsolni."); }
  }
}

async function onChange(e) {
  const cb = e.target.closest("[data-what]");
  const row = e.target.closest(".shl-row");
  if (!cb || !row) return;
  const it = _items.find((x) => x.id === row.dataset.id);
  if (!it) return;
  const hide = new Set(it.share?.hide || []);
  if (cb.checked) hide.delete(cb.dataset.what); else hide.add(cb.dataset.what);
  cb.disabled = true;
  try {
    await _deps.api.setRouteShare(it.id, { hide: [...hide] });
    it.share = { hide: [...hide] };
  } catch { cb.checked = !cb.checked; }
  finally { cb.disabled = false; }
}

export function initSharedLinks(deps) {
  _deps = deps;
  const box = document.getElementById("sharedLinksList");
  if (!box) return;
  box.addEventListener("click", onClick);
  box.addEventListener("change", onChange);
  // a szakasz kinyitásakor (és a Beállítások megnyitásakor) frissül
  const section = box.closest("[data-settings-section]");
  section?.querySelector(".settings-section-title")?.addEventListener("click", () => setTimeout(() => {
    if (!section.classList.contains("is-collapsed")) load();
  }, 0));
  document.addEventListener("bringaterv:settingsOpened", load);
  box.querySelector("[data-reload]")?.addEventListener("click", load);
  load();
}
