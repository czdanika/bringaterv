// ── Mozgás és hangulat: közös, a modulokat nem érintő réteg ───────────────────
// • szintvonalas háttér a tartalmi oldalak mögött (Kezdő, Könyvtár, Statok, Felszerelés)
// • csúszó jelölő a menüben (gépen függőleges sáv, telefonon alsó sáv)
// • felpörgő számok, kirajzolódó grafikonok, egymás után megjelenő kártyák
// Minden „rejtett kiinduló állapot” csak a html.motion-on alatt él a CSS-ben – ha ez a
// modul nem fut le, vagy a rendszer kevesebb mozgást kér, az oldal ugyanúgy használható.

import { dueTasks } from "../equipment.js";

const MAINS = ["#homeMain", "#libraryMain", "#statsMain", "#gearMain"];
const COUNT_SEL = ".st-kpi b, .cs-stat b";
const NUM_RE = /^(\s*)(\d[\d\s  ]*)(?:([,.])(\d+))?(\s*)$/;

/** Szintvonalak (ugyanaz a rajz, mint a belépő oldalon) – háttérképnek, világos és sötét változatban. */
function topoUrl(stroke, route) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const hills = [[330, 300, 250], [1250, 640, 300], [820, 820, 200], [1380, 140, 190], [760, 120, 170], [120, 620, 180]];
  let d = "";
  for (const [cx, cy, R] of hills) {
    const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
    for (let r = R; r > 30; r -= 34) {
      for (let k = 0; k <= 40; k++) {
        const a = (k / 40) * Math.PI * 2;
        const rr = r * (1 + 0.16 * Math.sin(2 * a + ph[0]) + 0.09 * Math.sin(3 * a + ph[1]) + 0.05 * Math.sin(5 * a + ph[2]));
        d += (k ? "L" : "M") + Math.round(cx + rr * Math.cos(a)) + " " + Math.round(cy + rr * 0.8 * Math.sin(a));
      }
      d += "Z";
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">`
    + `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.3"/>`
    + `<path d="M110 800C260 900 420 760 600 840S900 940 1080 840S1330 760 1400 620S1500 420 1420 300S1300 150 1180 130" fill="none" stroke="${route}" stroke-width="4" stroke-linecap="round"/>`
    + `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function topoBackground() {
  const st = document.documentElement.style;
  st.setProperty("--topo-light", topoUrl("rgba(40,60,50,0.07)", "rgba(232,70,30,0.10)"));
  st.setProperty("--topo-dark", topoUrl("rgba(255,255,255,0.055)", "rgba(255,106,61,0.14)"));
}

/** A menü aktív pontja alatt csúszó jelölő (a .rail-tab.is-active helyére mozog). */
function railIndicator() {
  const rail = document.querySelector(".app-rail");
  if (!rail) return;
  const ind = document.createElement("span");
  ind.className = "rail-ind";
  ind.setAttribute("aria-hidden", "true");
  rail.prepend(ind);
  let first = true;
  const place = () => {
    const act = rail.querySelector(".rail-tab.is-active");
    if (!act || !act.offsetWidth) { ind.style.opacity = "0"; return; }
    if (first) ind.style.transition = "none";
    ind.style.opacity = "1";
    const a = act.getBoundingClientRect(), r = rail.getBoundingClientRect();
    ind.style.width = `${a.width}px`;
    ind.style.height = `${a.height}px`;
    ind.style.transform = `translate(${a.left - r.left - rail.clientLeft}px, ${a.top - r.top - rail.clientTop}px)`;
    if (first) { void ind.offsetWidth; ind.style.transition = ""; first = false; }
  };
  let raf = 0;
  const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
  new MutationObserver(later).observe(rail, { attributes: true, attributeFilter: ["class", "hidden"], subtree: true });
  const shell = document.querySelector(".app-shell");
  if (shell) new MutationObserver(later).observe(shell, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("resize", later);
  document.fonts?.ready?.then(later);
  later();
}

/** Egy szám felpörgetése a végső értékére (a szöveg formátuma – szóköz, tizedesvessző – megmarad). */
function countUp(el) {
  const node = el.firstChild;
  if (!node || node.nodeType !== 3) return;
  const orig = node.nodeValue;
  const m = NUM_RE.exec(orig);
  if (!m) return;
  const [, pre, intTxt, decCh, decTxt, post] = m;
  const sep = /[\s  ]/.exec(intTxt.trim())?.[0] || "";
  const decimals = decTxt ? decTxt.length : 0;
  const target = Number(intTxt.replace(/[\s  ]/g, "") + (decTxt ? "." + decTxt : ""));
  if (!Number.isFinite(target) || target === 0) return;
  const fmt = (v) => {
    const [i, f] = v.toFixed(decimals).split(".");
    const grouped = sep ? i.replace(/\B(?=(\d{3})+(?!\d))/g, sep) : i;
    return pre + grouped + (f ? decCh + f : "") + post;
  };
  const t0 = performance.now(), dur = 750;
  const step = (now) => {
    if (!node.isConnected) return;
    const k = Math.min(1, (now - t0) / dur);
    node.nodeValue = k >= 1 ? orig : fmt(target * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  node.nodeValue = fmt(0);
  requestAnimationFrame(step);
}

/** Egy grafikon megjelenése: az oszlopok felnőnek (CSS), a vonalak balról jobbra megrajzolódnak. */
function revealChart(svg) {
  const rects = svg.querySelectorAll("rect");
  const spread = Math.min(18, 420 / Math.max(1, rects.length));
  rects.forEach((r, i) => { r.style.animationDelay = `${Math.round(i * spread)}ms`; });
  svg.classList.add("in-view");
  svg.querySelectorAll("path").forEach((p) => {
    const cs = getComputedStyle(p);
    if (cs.fill !== "none" || (cs.strokeDasharray && cs.strokeDasharray !== "none")) return;   // kitöltött / szaggatott: csak beúszik
    let len = 0;
    try { len = p.getTotalLength(); } catch { return; }
    if (!len || !p.animate) return;
    p.style.strokeDasharray = `${len}`;
    const a = p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 1000, easing: "cubic-bezier(.4,0,.2,1)", fill: "backwards" });
    a.onfinish = a.oncancel = () => { p.style.strokeDasharray = ""; };
  });
}

function observeContent() {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      if (e.target.matches(".st-svg")) revealChart(e.target); else countUp(e.target);
    }
  }, { threshold: 0.15 });
  const scan = (root) => {
    root.querySelectorAll(`.st-svg:not([data-mo]), ${COUNT_SEL.split(",").map((s) => `${s.trim()}:not([data-mo])`).join(", ")}`).forEach((el) => {
      el.dataset.mo = "1";
      io.observe(el);
    });
  };
  for (const sel of MAINS) {
    const root = document.querySelector(sel);
    if (!root) continue;
    let raf = 0;
    new MutationObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => scan(root)); })
      .observe(root, { childList: true, subtree: true });
    scan(root);
  }
}

/** Fülváltáskor az új oldal finoman beúszik, a kártyái egymás után jelennek meg. */
function tabEnter() {
  const byTab = { home: "#homeMain", library: "#libraryMain", stats: "#statsMain", gear: "#gearMain" };
  const timers = new Map();
  const enter = (name) => {
    const el = byTab[name] ? document.querySelector(byTab[name]) : null;   // a Tervezés / Elemzés fülnek nincs külön oldala
    if (!el) return;
    el.classList.remove("motion-enter");
    void el.offsetWidth;
    el.classList.add("motion-enter");
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => el.classList.remove("motion-enter"), 900));
  };
  window.addEventListener("bringaterv:tab", (e) => requestAnimationFrame(() => enter(e.detail)));
  const shell = document.querySelector(".app-shell");
  const cur = Object.keys(byTab).find((k) => shell?.classList.contains(`is-${k}-mode`));
  if (cur) enter(cur);
}

/** Jelzőpötty a Felszerelés menüponton, ha szerviz esedékes (piros) vagy hamarosan az lesz (sárga). */
function railBadges() {
  const tab = document.querySelector('.rail-tab[data-tab="gear"]');
  if (!tab) return;
  const dot = document.createElement("span");
  dot.className = "rail-dot";
  dot.hidden = true;
  tab.appendChild(dot);
  const sync = () => {
    let tasks = [];
    try { tasks = dueTasks(); } catch { /* még nincs adat */ }
    dot.hidden = !tasks.length;
    dot.classList.toggle("is-due", tasks.some((t) => t.status === "due"));
    const n = tasks.length;
    tab.title = n ? `Felszerelés – ${n} karbantartás vár` : "Felszerelés – bringák, alkatrészek, karbantartás";
  };
  window.addEventListener("bringaterv:tab", () => setTimeout(sync, 300));
  [1500, 5000, 15000].forEach((ms) => setTimeout(sync, ms));
}

/** Telefonon lebegő „+” gomb a Kezdőn és a Könyvtárban: új útvonal / fájl betöltése. */
function mobileFab() {
  const shell = document.querySelector(".app-shell");
  if (!shell || document.querySelector(".mo-fab")) return;
  const wrap = document.createElement("div");
  wrap.className = "mo-fab";
  wrap.innerHTML = `
    <div class="mo-fab-menu" hidden>
      <button type="button" data-fab="plan"><i data-lucide="map-pin-plus" aria-hidden="true"></i> Új útvonal</button>
      <button type="button" data-fab="file"><i data-lucide="upload" aria-hidden="true"></i> GPX / FIT betöltése</button>
    </div>
    <button type="button" class="mo-fab-btn" aria-label="Új" aria-expanded="false"><i data-lucide="plus" aria-hidden="true"></i></button>`;
  shell.appendChild(wrap);
  window.lucide?.createIcons();
  const menu = wrap.querySelector(".mo-fab-menu"), btn = wrap.querySelector(".mo-fab-btn");
  const set = (open) => { menu.hidden = !open; wrap.classList.toggle("is-open", open); btn.setAttribute("aria-expanded", String(open)); };
  btn.addEventListener("click", (e) => { e.stopPropagation(); set(menu.hidden); });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) set(false); });
  window.addEventListener("bringaterv:tab", () => set(false));
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-fab]");
    if (!b) return;
    set(false);
    document.querySelector(`.rail-tab[data-tab="${b.dataset.fab}"]`)?.click();
    if (b.dataset.fab === "file") document.querySelector("#gpxInput")?.click();
  });
}

export function initMotion() {
  try { topoBackground(); } catch { /* háttér nélkül is megy */ }
  try { railBadges(); } catch (e) { console.warn("motion: jelző", e); }
  try { mobileFab(); } catch (e) { console.warn("motion: gomb", e); }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  document.documentElement.classList.add("motion-on");
  try { railIndicator(); } catch (e) { console.warn("motion: menü", e); }
  try { observeContent(); } catch (e) { console.warn("motion: tartalom", e); }
  try { tabEnter(); } catch (e) { console.warn("motion: fülváltás", e); }
}
