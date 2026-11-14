/**
 * Bringaterv – „Újdonságok” ablak
 * ===============================
 * Belépés után egyszer felugrik, ha van újabb verzió, mint amit a felhasználó utoljára
 * látott (localStorage: bringaterv.whatsNewSeen). Első alkalommal (nincs még jelölés)
 * csak a legutóbbi verzió újdonságait mutatja, nem a teljes múltat.
 * A ☰ menü → „Újdonságok” bármikor újra megnyitja (a korábbiak lenyithatók).
 *
 * Új kiadásnál: a NEWS tömb ELEJÉRE egy új bejegyzés – felhasználói nyelven, röviden
 * (nem a CHANGELOG másolata). Ikonok: lucide.dev nevek.
 *
 *   initWhatsNew({ onGo })   onGo("library" | "settings" | "plan" | …)
 *
 * Amíg van nem látott kiadás, a bal alsó verziószám (#appVersion) pulzál (telefonon a ☰ gombon pötty);
 * a verziószámra kattintva bármikor megnyílik az ablak.
 */

const KEY = "bringaterv.whatsNewSeen";

export const NEWS = [
  {
    version: "1.48.1", date: "2026. november",
    title: "Nyugodtabb 3D berepülés",
    lead: "Egyenletesebb repülés, a végén az egész útvonal.",
    items: [
      { icon: "mountain", title: "Simább 3D videó", text: "A kamera a tempóhoz igazítja a magasságot, és nyugodtan fordul a kanyarokban." },
      { icon: "smartphone", title: "Sztori-margó", text: "Sztori méretnél kapcsolható, hogy a logó és a számok beljebb kerüljenek." },
    ],
  },
  {
    version: "1.48.0", date: "2026. november",
    title: "3D berepülés",
    lead: "Madártávlatból repülsz végig a tekerésed útvonalán.",
    items: [
      { icon: "mountain", title: "3D videó", text: "Domborzattal, műhold- vagy terepi térképen – a bringás mögül követi az útvonalat." },
      { icon: "pen-line", title: "Vonalvastagság", text: "Vékony, normál vagy vastag nyomvonal a képen és a videón." },
      { icon: "smartphone", title: "Sztorira szabva", text: "A logót és a számokat nem takarják el az Instagram gombjai." },
      { icon: "bell", title: "Újdonságok jelzése", text: "Ha van újdonság, a verziószám pulzál – rákattintva megnyílik." },
    ],
  },
  {
    version: "1.47.0", date: "2026. november",
    title: "Megosztó videó",
    lead: "A tekerésed kirajzolódik a térképen – sztoriba vagy bejegyzésbe.",
    items: [
      { icon: "clapperboard", title: "Videó a megosztásnál", text: "Kirajzolódó útvonal pörgő számokkal, automatikus zoommal. Térkép, saját fotó vagy videó a háttérben." },
      { icon: "palette", title: "Színes grafikon és vonal", text: "Lejtés, pulzus vagy watt szerint színezve, mint az Elemzésben." },
      { icon: "bike", title: "Görgős FIT betöltése", text: "A GPS nélküli FIT-fájl is bekerül a Könyvtárba, és rögtön megnyílik." },
      { icon: "sparkles", title: "AI-név", text: "Az útvonal nevét is kérheted az AI-tól a mentésnél." },
    ],
  },
  {
    version: "1.46.0", date: "2026. november",
    title: "Régi edzések behozása",
    items: [
      { icon: "history", title: "Akár évekre visszamenőleg", text: "Minden importnál választható 2 év, 5 év vagy az összes edzés – a Stravánál, a Garminnál és a komputereknél is." },
      { icon: "filter", title: "Csak az újak", text: "Egy kapcsoló az import-ablakban elrejti, ami már megvan – nem kell görgetni." },
    ],
  },
  {
    version: "1.45.0", date: "2026. november",
    title: "Pontos idők, tisztább kártyák",
    items: [
      { icon: "clock", title: "Helyes edzésidő", text: "A Garminról importált edzések a valódi kezdési időt kapják – a korábban rosszul jelzettek is." },
      { icon: "layout-grid", title: "Kiférnek a nevek", text: "A Könyvtár kártyáin a név felül teljes szélességben, a térképek alatta." },
      { icon: "list", title: "Több Garmin-edzés egyszerre", text: "Az importnál 500, 1000 vagy az összes edzés is választható." },
      { icon: "compass", title: "Első lépések", text: "Rövid bevezető a ☰ menüben: adatok, összeköthető fiókok, mit tud az app." },
    ],
  },
  {
    version: "1.44.0", date: "2026. november",
    title: "Beltéri edzések",
    lead: "A görgős és a Zwift-edzéseid is bekerülnek – a statisztikába, a formába és a bringa óráiba is.",
    go: { to: "library", label: "Megnézem a Könyvtárban" },
    items: [
      { icon: "bike", title: "Görgő, Zwift, MyWhoosh", text: "A GPS nélküli edzések is jönnek a Stravából, a Garminról és a komputerekről – kézzel és automatikusan is." },
      { icon: "chart-line", title: "Elemzés térkép nélkül", text: "Pulzus, watt, kadencia grafikonon, részidők, csúcsteljesítmény és TSS." },
      { icon: "trophy", title: "Wattcsúcsok a Rekordokban", text: "Egy görgős FTP-teszt is számít. A táv- és sebességrekordok kinti tekerésből maradnak." },
    ],
  },
  {
    version: "1.43.0", date: "2026. november",
    title: "Szokások, új megosztó képek",
    lead: "Új nézet a statisztikában, négy új stílus a megosztó képhez, és pontosabb számok mindenhol.",
    go: { to: "stats", label: "Megnézem a Statisztikát" },
    items: [
      { icon: "calendar-days", title: "Szokások", text: "Melyik napon és napszakban edzel, milyen távokat, melyik bringával – a Statisztika új nézetében. A Kezdőlapon is." },
      { icon: "image", title: "Négy új megosztó kép", text: "Poszter, Szintprofil, Eredmények és átlátszó Matrica a saját fotódra. Új méret: 4:5." },
      { icon: "sliders-horizontal", title: "Áttekinthetőbb kép és PDF", text: "Beállítások csoportokban, a PDF előnézete magától frissül, és minden választást megjegyez." },
      { icon: "activity", title: "Forma a Kezdőlapon", text: "A fittség és a fáradtság az elmúlt 12 hétben, egy pillantásra." },
      { icon: "check-check", title: "Egyező számok", text: "A táv és az emelkedés mindenhol ugyanaz: a rögzítő eszköz vagy a Strava értéke." },
      { icon: "list-checks", title: "Tervek nem kerülnek a rekordok közé", text: "A tervezett útvonalak nem számítanak a statisztikába és a Rekordokba." },
    ],
  },
  {
    version: "1.42.0", date: "2026. november",
    title: "Sokkal több az edzéseidről",
    lead: "Az Elemzés kapta a legnagyobb bővítést eddig: nyiss meg egy edzést, és görgess lejjebb az összefoglaló alatt.",
    go: { to: "library", label: "Megnézem egy edzésen" },
    items: [
      { icon: "scan-line", title: "Szakasz kijelölése", text: "Húzd végig az egeret a grafikonon (telefonon nyomd hosszan, majd húzd) – megkapod a rész idejét, tempóját, szintjét, pulzusát, wattját." },
      { icon: "mountain", title: "Emelkedők és részidők", text: "A mászásaid magától felismerve, kategóriával és VAM-mal; mellette 5 km-es részidők vagy a komputered körei." },
      { icon: "medal", title: "Csúcsértékek, érmekkel", text: "Leggyorsabb 5, 10, 20… km-ed és csúcsteljesítményed, éremmel jelölve, ha a korábbi edzéseid közül a legjobb 3 közé került. Teljesítmény-görbe is." },
      { icon: "git-compare", title: "Ugyanezen az útvonalon", text: "Ha már tekerted ezt a kört, látod a korábbi időidet, és km-re pontosan, hol nyertél vagy vesztettél időt." },
      { icon: "wind", title: "Szél az edzés alatt", text: "Mennyi volt hátszél, oldalszél, szembeszél – és átlagosan hány km/h-t segített vagy fékezett. A térképet is színezheted vele." },
      { icon: "gauge", title: "Terhelés: TSS, IF, Pw:HR", text: "Wattos edzésterhelés és aerob szétcsúszás. Add meg az FTP-det a Beállítások → Kerékpáros profil alatt (üresen becsüljük).", go: { to: "settings", label: "FTP megadása" } },
      { icon: "circle-pause", title: "Megállások és pedálozás", text: "Hol és mennyit álltál (jelölők a térképen); kadencia–watt pontdiagram, kétoldali wattmérőnél bal / jobb láb." },
      { icon: "share-2", title: "Szebb megosztott oldal", text: "A megosztott link ugyanúgy néz ki, mint az Elemzés – szél, csúcsértékek, emelkedők is. Te döntöd el, mi látszik rajta (pl. pulzus nélkül), és látod, hányan nyitották meg." },
      { icon: "smile", title: "Érzés és jegyzet", text: "Egy koppintás: mennyire volt nehéz (1–10), és pár sor jegyzet. Az AI-elemzés is figyelembe veszi." },
      { icon: "smartphone", title: "Telefonon is minden", text: "Teljes összefoglaló a mobilon is; a magyarázatok egy koppintásra. A grafikonok tengelye km helyett időre is váltható." },
      { icon: "bike", title: "GEOID komputerek", text: "A GEOID is az OnelapFit appal szinkronizál – az OnelapFit-kapcsolattal az edzések és az útvonal-küldés is működik." },
    ],
  },
  {
    version: "1.41.0", date: "2026. november",
    title: "Bryton és pontosabb tervek",
    items: [
      { icon: "send", title: "Bryton", text: "Edzés-import és útvonal küldése a Bryton komputerre, kanyarjelzésekkel." },
      { icon: "map-pin", title: "Útpontnevek", text: "A tervek pontjai település- és utcanevet kapnak – a közösségi útvonalakon is." },
      { icon: "route", title: "Sok pontos tervek", text: "A hosszú, sok pontos útvonalaknál sem marad el az idő és a szintprofil." },
    ],
  },
  {
    version: "1.40.0", date: "2026. november",
    title: "iGPSport, tisztább térkép",
    items: [
      { icon: "send", title: "iGPSport", text: "Edzés-import (automatikusan is) és útvonal küldése a komputerre." },
      { icon: "eye-off", title: "Köztes pontok elrejtése", text: "Egy gombbal eltüntetheted a sok útvonalpontot, hogy lásd a térképet és a színezést." },
    ],
  },
  {
    version: "1.39.0", date: "2026. november",
    title: "Ismétlődő edzések",
    items: [
      { icon: "copy", title: "Ismétlődések kezelése", text: "Ha ugyanaz az edzés két helyről is bejött (pl. Strava és Magene), kilistázzuk – te választod, melyik maradjon." },
    ],
  },
  {
    version: "1.38.0", date: "2026. november",
    title: "Tájoló térkép",
    items: [
      { icon: "map", title: "Hol van ez az útvonal?", text: "Kis Magyarország-térkép a könyvtárban, a megosztott oldalon és a PDF-en – egy pillantásra látod, merre jársz." },
    ],
  },
  {
    version: "1.37.0", date: "2026. november",
    title: "AI-leírás, rendezett összefoglaló",
    items: [
      { icon: "sparkles", title: "AI-leírás az útvonalakhoz", text: "Egy gomb a Mentés ablakban: rövid leírás a megyéről, településekről, burkolatról, terepről." },
      { icon: "layout-list", title: "Áttekinthetőbb Elemzés", text: "Strava-szerű összefoglaló, magyarázattal minden mutatóhoz (TRIMP, Edwards…)." },
    ],
  },
];

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const parse = (v) => String(v || "").replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
function cmp(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}
const seen = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
const markSeen = () => { try { localStorage.setItem(KEY, NEWS[0].version); } catch { /* privát mód */ } };

let _deps = {};

/** A még nem látott kiadások (első alkalommal csak a legutóbbi). */
const unseen = () => { const s = seen(); return s ? NEWS.filter((r) => cmp(r.version, s) > 0) : [NEWS[0]]; };

/** Verziószám-pulzálás és a ☰ menü pöttye a nem látott újdonságok szerint. */
export function syncNewsBadge() {
  const fresh = unseen().length > 0;
  document.getElementById("appVersion")?.classList.toggle("is-new", fresh);
  document.getElementById("topnavMenuBtn")?.classList.toggle("has-news", fresh);
  document.getElementById("whatsNewButton")?.classList.toggle("has-news", fresh);
}

function itemHtml(it) {
  return `<li class="wn-item">
    <span class="wn-ico"><i data-lucide="${esc(it.icon)}" aria-hidden="true"></i></span>
    <span class="wn-txt"><b>${esc(it.title)}</b><span>${esc(it.text)}</span>
      ${it.go ? `<button type="button" class="wn-link" data-go="${esc(it.go.to)}">${esc(it.go.label)} →</button>` : ""}</span>
  </li>`;
}

function releaseHtml(r, { first = false } = {}) {
  return `<section class="wn-rel${first ? " is-first" : ""}">
    ${first ? "" : `<h3 class="wn-rel-h"><span>${esc(r.title)}</span><em>v${esc(r.version)} · ${esc(r.date)}</em></h3>`}
    ${first && r.lead ? `<p class="wn-lead">${esc(r.lead)}</p>` : ""}
    <ul class="wn-list">${r.items.map(itemHtml).join("")}</ul>
  </section>`;
}

/** @param {{ only?: object[] }} opts – only: a kiemelendő (új) kiadások; üresen a legutóbbi */
export function openWhatsNew({ only } = {}) {
  document.getElementById("topnavDropdown")?.setAttribute("hidden", "");
  document.getElementById("whatsNewOverlay")?.remove();
  const fresh = only?.length ? only : [NEWS[0]];
  const older = NEWS.filter((r) => !fresh.includes(r));
  const top = fresh[0];
  const ov = document.createElement("div");
  ov.id = "whatsNewOverlay";
  ov.className = "wn-overlay";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.setAttribute("aria-labelledby", "wnTitle");
  ov.innerHTML = `
    <div class="wn-card">
      <header class="wn-head">
        <button type="button" class="wn-close" aria-label="Bezárás">×</button>
        <span class="wn-badge"><i data-lucide="sparkles" aria-hidden="true"></i> Újdonságok</span>
        <h2 id="wnTitle">${esc(top.title)}</h2>
        <div class="wn-ver">v${esc(top.version)} · ${esc(top.date)}${fresh.length > 1 ? ` · és még ${fresh.length - 1} korábbi frissítés` : ""}</div>
      </header>
      <div class="wn-body">
        ${releaseHtml(top, { first: true })}
        ${fresh.slice(1).map((r) => releaseHtml(r)).join("")}
        ${older.length ? `<details class="wn-older"><summary>Korábbi újdonságok</summary>${older.map((r) => releaseHtml(r)).join("")}</details>` : ""}
      </div>
      <label class="wn-again"><input type="checkbox" data-again> Következő belépéskor is mutasd</label>
      <footer class="wn-foot">
        ${top.go ? `<button type="button" class="wn-btn wn-btn--ghost" data-go="${esc(top.go.to)}">${esc(top.go.label)}</button>` : "<span></span>"}
        <button type="button" class="wn-btn wn-btn--pri" data-close>Szuper, köszi!</button>
      </footer>
    </div>`;
  // pipa: a következő belépéskor is jöjjön (a legutóbbi kiadás „nem látottnak” marad)
  const close = () => {
    if (ov.querySelector("[data-again]")?.checked) {
      try { localStorage.setItem(KEY, NEWS[1]?.version || "0.0.0"); } catch { /* privát mód */ }
    } else markSeen(); syncNewsBadge(); ov.classList.add("is-leaving"); setTimeout(() => ov.remove(), 180); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  ov.addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go) { close(); _deps.onGo?.(go.dataset.go); return; }
    if (e.target === ov || e.target.closest(".wn-close, [data-close]")) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(ov);
  window.lucide?.createIcons({ root: ov });
}

/** Belépés után: ha van még nem látott kiadás, megmutatja (egyszer). */
export function maybeShowWhatsNew() {
  const fresh = unseen();
  if (!fresh.length) return;
  // ne zavarjon mélylinkes megnyitásnál (pl. admin nyomvonal-szerkesztés, navigáció-próba)
  const q = new URLSearchParams(location.search);
  if (q.has("editSample") || q.has("navsim")) return;
  openWhatsNew({ only: fresh });
}

export function initWhatsNew(deps = {}) {
  _deps = deps;
  document.getElementById("whatsNewButton")?.addEventListener("click", () => openWhatsNew({ only: unseen() }));
  // bal alul a verziószám: kattintásra az Újdonságok (pulzál, ha van nem látott)
  const ver = document.getElementById("appVersion");
  if (ver) {
    ver.setAttribute("role", "button");
    ver.tabIndex = 0;
    ver.title = "Újdonságok";
    const open = () => openWhatsNew({ only: unseen() });
    ver.addEventListener("click", open);
    ver.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  }
  syncNewsBadge();
  // kicsit később, hogy az app már betöltött legyen (auto: false → a hívó indítja, pl. az üdvözlő ablak után)
  if (deps.auto !== false) setTimeout(maybeShowWhatsNew, 1200);
}
