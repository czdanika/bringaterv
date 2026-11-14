/**
 * Bringaterv – „Üdvözlünk” ablak új felhasználóknak (az Újdonságok ablak stílusában).
 *   1. Add meg az adataidat (Beállítások → Kerékpáros profil, Pulzuszónák)
 *   2. Hozd be az edzéseidet: összeköthető fiókok logóval (összekötve: pipa), vagy GPX / FIT
 *   3. Mit tud az app – röviden
 *
 * Első belépéskor jelenik meg, ha a felhasználónak még nincs edzése és nem látta
 * (localStorage: bringaterv.welcomeSeen). A ☰ menü → „Első lépések” bármikor megnyitja.
 * Amikor megjelenik, az Újdonságok ablak nem ugrik fel mellé (a legutóbbi kiadás „látott” lesz).
 *
 *   initWelcome({ api, onGo, openSettings })  → Promise<boolean> (megjelent-e)
 *     onGo("plan" | "library" | "stats" | "loadFile" …), openSettings("strava" | "cyclistProfile" …)
 */
import { NEWS, syncNewsBadge } from "./whatsNew.js";

const KEY = "bringaterv.welcomeSeen";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// összeköthető fiókok (a sorrend: a leggyakoribbak elöl)
const CONNECT = [
  { key: "strava",   label: "Strava",    sub: "bármilyen óra, app",   img: "strava.svg" },
  { key: "garmin",   label: "Garmin",    sub: "Edge, Forerunner…",    img: "garmin.svg" },
  { key: "onelap",   label: "OnelapFit", sub: "Magene, GEOID",        img: "onelapfit.png" },
  { key: "igpsport", label: "iGPSport",  sub: "iGPSport komputerek",  img: "igpsport.png" },
  { key: "bryton",   label: "Bryton",    sub: "Bryton komputerek",    img: "bryton.png" },
  { key: "wahoo",    label: "Wahoo",     sub: "ELEMNT, KICKR",        img: "wahoo.png" },
  { key: "polar",    label: "Polar",     sub: "Polar órák",           img: "polar.png" },
];
const FEATURES = [
  { icon: "map-pin-plus", title: "Tervezés", text: "Útvonal kattintással vagy kész javaslat a kért távra, szél, burkolat, küldés a komputerre." },
  { icon: "chart-line", title: "Elemzés", text: "Pulzus, watt, emelkedők, csúcsértékek, szakasz kijelölése." },
  { icon: "bar-chart-3", title: "Statisztika", text: "Heti és havi összesítők, forma, rekordok, szokások." },
  { icon: "bike", title: "Felszerelés", text: "Bringák és alkatrészek kilométerei, szerviz-emlékeztető." },
];

const seen = () => { try { return !!localStorage.getItem(KEY); } catch { return true; } };
const markSeen = ({ news = false } = {}) => {
  try {
    localStorage.setItem(KEY, new Date().toISOString());
    // új felhasználónak az üdvözlő ablak mutatja be az appot – az Újdonságok ne ugorjon fel mellé
    if (news) localStorage.setItem("bringaterv.whatsNewSeen", NEWS[0].version);
  } catch { /* privát mód */ }
  syncNewsBadge();
};

let _deps = {}, _state = null;   // { connected: {key: bool}, disabled: Set }

async function loadState() {
  try {
    const r = await _deps.api.getIntegrations();
    _state = { connected: r.connected || {}, disabled: new Set(r.disabled || []) };
  } catch { _state = { connected: {}, disabled: new Set() }; }
  return _state;
}

function tile(c) {
  const on = !!_state?.connected?.[c.key];
  return `<button type="button" class="wc-tile${on ? " is-on" : ""}" data-wc-connect="${c.key}" title="${on ? `${c.label}: összekötve` : `${c.label} összekötése`}">
      <img src="./assets/brands/${c.img}" alt="" width="28" height="28" loading="lazy">
      <span><b>${esc(c.label)}</b><small>${on ? "Összekötve" : esc(c.sub)}</small></span>
      ${on ? `<i data-lucide="check" class="wc-ok" aria-hidden="true"></i>` : ""}
    </button>`;
}

export async function openWelcome() {
  document.getElementById("topnavDropdown")?.setAttribute("hidden", "");
  document.getElementById("welcomeOverlay")?.remove();
  if (!_state) await loadState();
  const tiles = CONNECT.filter((c) => !_state.disabled.has(c.key));
  const ov = document.createElement("div");
  ov.id = "welcomeOverlay";
  ov.className = "wn-overlay";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.setAttribute("aria-labelledby", "wcTitle");
  ov.innerHTML = `
    <div class="wn-card wc-card">
      <header class="wn-head">
        <button type="button" class="wn-close" aria-label="Bezárás">×</button>
        <span class="wn-badge"><i data-lucide="hand" aria-hidden="true"></i> Üdvözlünk</span>
        <h2 id="wcTitle">Indulhat a tekerés</h2>
        <div class="wn-ver">Három lépés, és minden a helyén van.</div>
      </header>
      <div class="wn-body">
        <section class="wc-step">
          <div class="wc-step-h"><span class="wc-num">1</span><b>Add meg az adataidat</b></div>
          <p class="wc-p">Testsúly, életkor, pulzus és – ha van wattmérőd – FTP. Ezekből számol a kalória, a pulzuszónák és az edzésterhelés.</p>
          <div class="wc-row">
            <button type="button" class="wc-chip" data-wc-settings="cyclistProfile"><i data-lucide="user" aria-hidden="true"></i>Kerékpáros profil</button>
            <button type="button" class="wc-chip" data-wc-settings="hrZones"><i data-lucide="heart-pulse" aria-hidden="true"></i>Pulzuszónák</button>
          </div>
        </section>
        <section class="wc-step">
          <div class="wc-step-h"><span class="wc-num">2</span><b>Hozd be az edzéseidet</b></div>
          <p class="wc-p">Kösd össze a fiókodat: az edzéseid maguktól megjelennek, és útvonalat is küldhetsz a komputerre.</p>
          <div class="wc-grid">${tiles.map(tile).join("")}</div>
          <button type="button" class="wn-link wc-file" data-wc-go="loadFile">Vagy tölts be egy GPX / FIT fájlt →</button>
        </section>
        <section class="wc-step">
          <div class="wc-step-h"><span class="wc-num">3</span><b>Fedezd fel</b></div>
          <ul class="wn-list">${FEATURES.map((f) => `<li class="wn-item"><span class="wn-ico"><i data-lucide="${f.icon}" aria-hidden="true"></i></span>
            <span class="wn-txt"><b>${esc(f.title)}</b><span>${esc(f.text)}</span></span></li>`).join("")}</ul>
        </section>
      </div>
      <footer class="wn-foot">
        <a class="wn-btn wn-btn--ghost wc-help" href="./help.html" target="_blank" rel="noopener">Súgó</a>
        <button type="button" class="wn-btn wn-btn--pri" data-close>Kezdjük!</button>
      </footer>
    </div>`;
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { markSeen(); ov.classList.add("is-leaving"); setTimeout(() => ov.remove(), 180); document.removeEventListener("keydown", onKey); };
  ov.addEventListener("click", (e) => {
    const c = e.target.closest("[data-wc-connect]");
    if (c) { close(); _deps.openSettings?.(c.dataset.wcConnect); return; }
    const s = e.target.closest("[data-wc-settings]");
    if (s) { close(); _deps.openSettings?.(s.dataset.wcSettings); return; }
    const g = e.target.closest("[data-wc-go]");
    if (g) { close(); _deps.onGo?.(g.dataset.wcGo); return; }
    if (e.target === ov || e.target.closest(".wn-close, [data-close]")) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(ov);
  window.lucide?.createIcons({ root: ov });
}

/** Belépés után: új felhasználónál (nincs edzése, nem látta) megjelenik. */
export async function initWelcome(deps = {}) {
  _deps = deps;
  document.getElementById("welcomeButton")?.addEventListener("click", () => { _state = null; openWelcome(); });
  if (deps.auto === false) return false;   // pl. amíg az e-mail-megerősítés hiányzik
  const q = new URLSearchParams(location.search);
  if (seen() || q.has("editSample") || q.has("navsim") || q.has("open") || q.has("settings")) return false;
  let items = [];
  try { items = await deps.api.listRoutes(); } catch { return false; }
  if ((items || []).some((r) => r.type === "workout")) { markSeen(); return false; }   // régi felhasználó: nem kell
  await loadState();
  markSeen({ news: true });
  openWelcome();
  return true;
}
