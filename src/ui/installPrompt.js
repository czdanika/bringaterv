/**
 * Bringaterv – „Telepítés appként” (PWA)
 * ========================================
 * – iPhone / iPad: az iOS nem enged programból telepítést, ezért egy rövid
 *   útmutatót mutatunk (Megosztás → Főképernyőhöz adás → Hozzáadás);
 * – Android / asztali Chrome / Edge: a böngésző `beforeinstallprompt`
 *   eseményével valódi telepítő ablakot nyitunk;
 * – ha az app már telepítve fut (standalone), sem a menüpont, sem a sáv nem látszik.
 * A tipp-sáv egyszer jelenik meg telefonon/tableten; „Később” után 30 napig nem.
 */

const DISMISS_KEY = "bringaterv_install_dismissed";
const DISMISS_DAYS = 30;

let _deferred = null;            // beforeinstallprompt esemény (Android / asztal)

export function isStandalone() {
  return matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

/** iPhone, iPod, iPad – az iPadOS asztali Safarinak (Macintosh) adja ki magát */
export function isIOS() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

const isIPad = () => /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isTouch = () => matchMedia("(pointer: coarse)").matches;

function dismissedRecently() {
  try {
    const t = Number(localStorage.getItem(DISMISS_KEY));
    return t && Date.now() - t < DISMISS_DAYS * 86400000;
  } catch { return false; }
}
function rememberDismiss() {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* privát mód */ }
}

/** Service worker regisztráció – csak biztonságos kapcsolaton (HTTPS / localhost) */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  const reg = () => navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Service worker:", err));
  if (document.readyState === "complete") reg();
  else window.addEventListener("load", reg, { once: true });
}

/**
 * @param {{ menuItem?: HTMLElement|null }} opts  a menüpont (rejtve, ha nem releváns)
 */
export function initInstallPrompt({ menuItem = null } = {}) {
  const refreshMenu = () => {
    if (!menuItem) return;
    menuItem.hidden = isStandalone() || !(isIOS() || _deferred || isTouch());
  };

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    _deferred = e;
    refreshMenu();
    maybeShowBanner();
  });
  window.addEventListener("appinstalled", () => {
    _deferred = null;
    refreshMenu();
    document.getElementById("installBanner")?.remove();
  });

  menuItem?.addEventListener("click", () => {
    document.getElementById("topnavDropdown")?.setAttribute("hidden", "");
    startInstall();
  });
  refreshMenu();
  // iOS-en nincs esemény → késleltetve, hogy ne a betöltéssel egy időben ugorjon fel
  if (isIOS()) setTimeout(maybeShowBanner, 2500);
}

function maybeShowBanner() {
  if (isStandalone() || dismissedRecently() || document.getElementById("installBanner")) return;
  if (!isTouch()) return;                         // asztalon csak a menüpont
  if (!isIOS() && !_deferred) return;

  const bar = document.createElement("div");
  bar.id = "installBanner";
  bar.className = "install-banner";
  bar.setAttribute("role", "dialog");
  bar.setAttribute("aria-label", "Telepítés appként");
  bar.innerHTML = `
    <img class="install-banner-icon" src="./src/assets/icons/apple-touch-icon.png" alt="" width="44" height="44">
    <div class="install-banner-text">
      <strong>Telepítsd appként</strong>
      <span>Ikonról, teljes képernyőn indul – mint egy app.</span>
    </div>
    <button type="button" class="install-banner-btn" data-act="install">Telepítés</button>
    <button type="button" class="install-banner-close" data-act="later" aria-label="Később">×</button>`;
  bar.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    bar.remove();
    if (act === "install") startInstall();
    else rememberDismiss();
  });
  document.body.appendChild(bar);
}

async function startInstall() {
  if (_deferred) {
    const ev = _deferred;
    _deferred = null;
    ev.prompt();
    try {
      const { outcome } = await ev.userChoice;
      if (outcome !== "accepted") rememberDismiss();
    } catch { /* régi böngésző */ }
    return;
  }
  openGuide();
}

/** Lépésenkénti útmutató (iOS, vagy ahol nincs telepítő esemény) */
function openGuide() {
  document.getElementById("installGuide")?.remove();
  const ios = isIOS();
  const ipad = isIPad();
  const shareIcon = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>`;
  const plusIcon = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>`;

  const steps = ios ? [
    `Koppints a <b>Megosztás</b> gombra ${shareIcon} – ${ipad ? "a címsor jobb oldalán, fent" : "Safariban alul középen (ha nem látod, görgess picit felfelé)"}.`,
    `Görgess le, és válaszd a <b>Főképernyőhöz adás</b> ${plusIcon} menüpontot.`,
    `Koppints a <b>Hozzáadás</b> gombra. A Bringaterv ikon megjelenik a főképernyőn – onnan indítsd.`,
  ] : [
    `Nyisd meg a böngésző menüjét (<b>⋮</b> vagy <b>⋯</b>).`,
    `Válaszd az <b>Alkalmazás telepítése</b> / <b>Hozzáadás a kezdőképernyőhöz</b> pontot.`,
    `Erősítsd meg – a Bringaterv ikonról, teljes képernyőn indul.`,
  ];
  const note = ios
    ? `Tipp: iOS-en Safariban működik a legjobban (Chrome-ban is: Megosztás → Főképernyőhöz adás). Az első indításkor egyszer újra be kell jelentkezni – az app a Safaritól külön tárolja az adatait.`
    : `Ha nem látod a menüpontot, a böngésző nem támogatja a telepítést – próbáld Chrome-ban vagy Edge-ben.`;

  const ov = document.createElement("div");
  ov.id = "installGuide";
  ov.className = "install-guide-overlay";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.innerHTML = `
    <div class="install-guide">
      <div class="install-guide-head">
        <img src="./src/assets/icons/apple-touch-icon.png" alt="" width="48" height="48">
        <div>
          <h3>Bringaterv telepítése</h3>
          <p>${ios ? (ipad ? "iPadre" : "iPhone-ra") : "a készülékre"} – App Store nélkül, ingyen</p>
        </div>
        <button type="button" class="install-guide-close" aria-label="Bezárás">×</button>
      </div>
      <ol class="install-guide-steps">${steps.map((s) => `<li>${s}</li>`).join("")}</ol>
      <p class="install-guide-note">${note}</p>
      <button type="button" class="install-guide-ok">Rendben</button>
    </div>`;
  const close = () => ov.remove();
  ov.addEventListener("click", (e) => {
    if (e.target === ov || e.target.closest(".install-guide-close, .install-guide-ok")) close();
  });
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });
  document.body.appendChild(ov);
}
