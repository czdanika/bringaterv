/**
 * Bringaterv – Megosztás ablak (könyvtár)
 * =======================================
 * Egy helyen: megosztó kép, PDF útvonallap, nyilvános link (másolás, QR,
 * natív megosztás és a szokásos csatornák: Facebook, Messenger, WhatsApp,
 * Telegram, X, e-mail, SMS).
 *
 *   openShareModal({ title, url, onImage, onPdf })
 *     url: a publikus nézőoldal linkje, vagy null (pl. minta-útvonalnál)
 */

import { ensureQR, buildQrCanvas } from "./routePdf.js";

let _el = null;

// Egyszerűsített márka-ikonok (Simple Icons, CC0)
const BRAND = {
  facebook: "M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z",
  messenger: "M.001 11.639C.001 4.949 5.241 0 12.001 0S24 4.95 24 11.639c0 6.689-5.24 11.638-12 11.638-1.21 0-2.38-.16-3.47-.46a.96.96 0 00-.64.05l-2.39 1.05a.96.96 0 01-1.35-.85l-.07-2.14a.97.97 0 00-.32-.68A11.39 11.389 0 01.002 11.64zm8.32-2.19l-3.52 5.6c-.35.53.32 1.139.82.75l3.79-2.87c.26-.2.6-.2.87 0l2.8 2.1c.84.63 2.04.4 2.6-.48l3.52-5.6c.35-.53-.32-1.13-.82-.75l-3.79 2.87c-.25.2-.6.2-.86 0l-2.8-2.1a1.8 1.8 0 00-2.61.48z",
  whatsapp: "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z",
  telegram: "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
  x: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
};

const svg = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
const isTouch = () => matchMedia("(pointer: coarse)").matches;

// Helyi hálózati cím? (telefonról mobilneten nem nyílik meg)
function isPrivateHost(url) {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h.endsWith(".local") || /^127\./.test(h) || /^10\./.test(h)
      || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch (_) { return false; }
}

function build() {
  const ov = document.createElement("div");
  ov.className = "shortcut-overlay";
  ov.id = "shareOverlay";
  ov.hidden = true;
  ov.innerHTML = `
    <div class="export-panel share-panel" role="dialog" aria-modal="true" aria-labelledby="shareTitle">
      <div class="export-header">
        <h3 id="shareTitle">Megosztás</h3>
        <button class="shortcut-close" type="button" data-share="close" title="Bezárás"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <div class="share-body">
        <div class="share-route-name" data-share="name"></div>
        <div class="share-options">
          <button class="share-option" type="button" data-share="image">
            <span class="share-option-icon"><i data-lucide="image" aria-hidden="true"></i></span>
            <span class="share-option-text"><strong>Megosztó kép</strong><small>Kártya térképpel és statokkal – Instagram, Strava, chat</small></span>
            <i data-lucide="chevron-right" class="share-option-chev" aria-hidden="true"></i>
          </button>
          <button class="share-option" type="button" data-share="pdf">
            <span class="share-option-icon"><i data-lucide="file-text" aria-hidden="true"></i></span>
            <span class="share-option-text"><strong>PDF útvonallap</strong><small>Nyomtatható lap térképpel, grafikonokkal, QR-kóddal</small></span>
            <i data-lucide="chevron-right" class="share-option-chev" aria-hidden="true"></i>
          </button>
        </div>

        <div class="share-link-block" data-share="link-block">
          <div class="share-section-title">Nyilvános link</div>
          <div class="share-link-row">
            <div class="share-qr" data-share="qr"></div>
            <div class="share-link-main">
              <div class="share-link-input-row">
                <input class="export-input share-link-input" data-share="url" type="text" readonly>
                <button class="share-copy-btn" type="button" data-share="copy"><i data-lucide="copy" aria-hidden="true"></i><span>Másolás</span></button>
              </div>
              <div class="share-warn" data-share="warn" hidden>
                <i data-lucide="triangle-alert" aria-hidden="true"></i>
                <span>A link helyi hálózati címre mutat, mobilnetről nem nyílik meg. Állítsd be a publikus címet: <strong>Beállítások → Megosztás</strong>.</span>
              </div>
              <div class="share-hint">Bárki megnézheti bejelentkezés nélkül, de szerkeszteni nem tudja.</div>
            </div>
          </div>
          <div class="share-targets" data-share="targets"></div>
        </div>
        <div class="share-no-link" data-share="no-link" hidden>
          <span data-share="no-link-text"></span>
          <button class="share-copy-btn share-save-link-btn" type="button" data-share="save-link" hidden>
            <i data-lucide="link" aria-hidden="true"></i><span>Mentés és link</span>
          </button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const q = (k) => ov.querySelector(`[data-share="${k}"]`);
  const close = () => { ov.hidden = true; };
  q("close").addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !ov.hidden) close(); });
  q("copy").addEventListener("click", async () => {
    const input = q("url");
    try { await navigator.clipboard.writeText(input.value); }
    catch (_) { input.select(); document.execCommand("copy"); }
    const label = q("copy").querySelector("span");
    label.textContent = "Másolva ✓";
    setTimeout(() => { label.textContent = "Másolás"; }, 1600);
  });
  q("url").addEventListener("focus", (e) => e.target.select());
  return { ov, q, close };
}

function targetsHtml(url, title) {
  const text = `${title} – Bringaterv`;
  const u = encodeURIComponent(url), t = encodeURIComponent(text);
  const items = [];
  if (navigator.share) items.push({ key: "native", label: "Megosztás", icon: '<i data-lucide="share-2" aria-hidden="true"></i>', cls: "is-native" });
  items.push({ label: "Facebook", icon: svg(BRAND.facebook), color: "#1877F2", href: `https://www.facebook.com/sharer/sharer.php?u=${u}` });
  if (isTouch()) items.push({ label: "Messenger", icon: svg(BRAND.messenger), color: "#0084FF", href: `fb-messenger://share/?link=${u}` });
  items.push({ label: "WhatsApp", icon: svg(BRAND.whatsapp), color: "#25D366", href: `https://wa.me/?text=${t}%20${u}` });
  items.push({ label: "Telegram", icon: svg(BRAND.telegram), color: "#26A5E4", href: `https://t.me/share/url?url=${u}&text=${t}` });
  items.push({ label: "X", icon: svg(BRAND.x), color: "currentColor", href: `https://twitter.com/intent/tweet?url=${u}&text=${t}` });
  items.push({ label: "E-mail", icon: '<i data-lucide="mail" aria-hidden="true"></i>', href: `mailto:?subject=${t}&body=${t}%0A%0A${u}` });
  if (isTouch()) items.push({ label: "SMS", icon: '<i data-lucide="message-square" aria-hidden="true"></i>', href: `sms:?&body=${t}%20${u}` });
  items.push({ label: "Megnyitás", icon: '<i data-lucide="external-link" aria-hidden="true"></i>', href: url });

  return items.map((it) => {
    // Egyszínű ikonok – a márkaszínek helyett az app saját színei (egységes megjelenés)
    const inner = `<span class="share-target-icon">${it.icon}</span><span>${it.label}</span>`;
    if (it.key === "native") return `<button type="button" class="share-target ${it.cls}" data-share="native">${inner}</button>`;
    const ext = it.href.startsWith("http") ? ' target="_blank" rel="noopener"' : "";
    return `<a class="share-target" href="${it.href}"${ext}>${inner}</a>`;
  }).join("");
}

export function openShareModal({ title = "Útvonal", url = null, onImage, onPdf, onSaveForLink,
                                 noLinkText = "Közösségi útvonalhoz nincs külön nyilvános link." } = {}) {
  if (!_el) _el = build();
  const { ov, q, close } = _el;

  q("name").textContent = title;
  q("image").onclick = () => { close(); onImage?.(); };
  q("pdf").onclick = () => { close(); onPdf?.(); };

  q("no-link-text").textContent = noLinkText;
  const saveBtn = q("save-link");
  saveBtn.hidden = !onSaveForLink;
  saveBtn.disabled = false;
  saveBtn.querySelector("span").textContent = "Mentés és link";
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    saveBtn.querySelector("span").textContent = "Mentés…";
    try {
      const newUrl = await onSaveForLink();
      if (newUrl) renderLink(newUrl);
    } catch (err) {
      console.error("Mentés hiba:", err);
      saveBtn.disabled = false;
      saveBtn.querySelector("span").textContent = "Újrapróbálás";
    }
  };
  renderLink(url);

  ov.hidden = false;
  window.lucide?.createIcons();

  function renderLink(url) {
    q("link-block").hidden = !url;
    q("no-link").hidden = !!url;
    if (!url) return;
    q("url").value = url;
    q("warn").hidden = !isPrivateHost(url);
    q("targets").innerHTML = targetsHtml(url, title);
    q("native")?.addEventListener("click", () => {
      navigator.share({ title: `${title} – Bringaterv`, text: `${title} – Bringaterv`, url }).catch(() => {});
    });
    const qrBox = q("qr");
    qrBox.innerHTML = "";
    qrBox.hidden = false;
    ensureQR().then((qrcode) => {
      const c = buildQrCanvas(url, qrcode, { size: 240 });
      c.className = "share-qr-canvas";
      qrBox.appendChild(c);
    }).catch(() => { qrBox.hidden = true; });
    window.lucide?.createIcons();
  }
}
