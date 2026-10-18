/**
 * Bringaterv – Fiók (Beállítások → Fiók) és kötelező e-mail-megerősítés
 * ======================================================================
 * • Beállítások → Fiók: belépési név, e-mail-cím (megerősítő levéllel), jelszócsere.
 * • Ha a szerveren kötelező a megerősítés (van e-mail küldés) és a felhasználó
 *   címe még nincs megerősítve, egy záróablak jelenik meg, amíg meg nem erősíti.
 * • Megerősítés a levélben kapott 6 számjegyű kóddal (az ablakban marad), vagy a
 *   levélben lévő linkkel.
 */

import { authHeaders, getToken, handle401, logout } from "../auth.js";

const JWT_KEY = "bringaterv_jwt";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let _state = null;

async function api(path, method = "GET", body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { handle401(); throw new Error("Lejárt munkamenet"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Beállítások → Fiók ────────────────────────────────────────────────────────

function renderSection() {
  const s = _state;
  if (!s) return;
  $("accountSection").hidden = false;
  $("accountLogin").textContent = s.login;
  if (document.activeElement !== $("accountEmail")) $("accountEmail").value = s.email || "";
  const badge = $("accountEmailBadge");
  badge.className = "account-badge " + (s.email ? (s.email_verified ? "is-ok" : "is-pending") : "is-missing");
  badge.textContent = s.email ? (s.email_verified ? "✓ megerősítve" : "megerősítésre vár") : "nincs megadva";
  $("accountEmailHint").textContent = !s.mail_configured
    ? "A szerveren nincs beállítva e-mail küldés, ezért most nem lehet megerősítő levelet küldeni."
    : s.email && !s.email_verified
      ? "Küldtünk egy levelet egy 6 számjegyű kóddal (és egy linkkel) – írd be a kódot lent. Nézd meg a spam mappát is."
      : "Ide küldjük az elfelejtett jelszó linket.";
  const pending = !!(s.email && !s.email_verified && s.mail_configured);
  $("accountResend").hidden = !pending;
  $("accountCodeRow").hidden = !pending;
  $("accountDeleteBox").hidden = !s.can_delete;
}

// ── Saját fiók törlése ────────────────────────────────────────────────────────

const DELETE_REASONS = [
  ["not_using", "Nem használom"],
  ["missing_feature", "Hiányzik egy funkció"],
  ["hard_to_use", "Nehéz használni"],
  ["bugs", "Hibák miatt"],
  ["privacy", "Adatvédelmi okok"],
  ["other_app", "Másik appot használok"],
  ["other", "Egyéb"],
];

async function downloadBackup(btn) {
  btn.disabled = true;
  try {
    const res = await fetch("/api/user/backup", { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const name = (res.headers.get("Content-Disposition") || "").match(/filename="?([^";]+)"?/)?.[1] || "bringaterv-mentes.zip";
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    btn.textContent = "✓ Mentés letöltve";
  } catch (e) {
    alert("A mentés nem sikerült: " + e.message);
    btn.disabled = false;
  }
}

function openDeleteDialog() {
  document.getElementById("settingsOverlay")?.setAttribute("hidden", "");
  const ov = document.createElement("div");
  ov.id = "accountDeleteDialog";
  ov.className = "install-guide-overlay";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.innerHTML = `
    <form class="install-guide fb-card" novalidate>
      <div class="install-guide-head" style="padding:18px 18px 0">
        <div>
          <h3>Fiók törlése</h3>
          <p>Sajnáljuk, hogy mész! Egy rövid visszajelzés sokat segít.</p>
        </div>
        <button type="button" class="install-guide-close" data-close aria-label="Bezárás">×</button>
      </div>
      <div class="fb-body">
        <div class="fb-label">Miért törlöd a fiókod?</div>
        <div class="del-reasons">
          ${DELETE_REASONS.map(([v, l]) => `<label class="del-reason"><input type="radio" name="reason" value="${v}"><span>${l}</span></label>`).join("")}
        </div>
        <label class="fb-label" for="delComment">Megjegyzés <span class="fb-opt">(nem kötelező)</span></label>
        <textarea id="delComment" class="fb-input fb-textarea" rows="3" maxlength="4000"
                  placeholder="Mi hiányzott, mi zavart? Mit csinálhatnánk jobban?"></textarea>
        <div class="del-backup">
          <span>Előtte letöltheted az adataidat (útvonalak, edzések, beállítások) egy ZIP-fájlban.</span>
          <button type="button" class="fb-btn" data-backup>Mentés letöltése</button>
        </div>
        <label class="fb-label" for="delPassword">A megerősítéshez írd be a jelszavad</label>
        <input id="delPassword" class="fb-input" type="password" autocomplete="current-password">
        <p class="fb-error" role="alert" hidden></p>
      </div>
      <div class="fb-actions">
        <button type="button" class="fb-btn" data-close>Mégse</button>
        <button type="submit" class="fb-btn del-confirm">Fiók végleges törlése</button>
      </div>
    </form>`;
  document.body.appendChild(ov);
  const form = ov.querySelector("form"), err = ov.querySelector(".fb-error");
  const close = () => ov.remove();
  ov.addEventListener("click", (e) => {
    if (e.target === ov || e.target.closest("[data-close]")) close();
    const b = e.target.closest("[data-backup]");
    if (b) downloadBackup(b);
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const reason = form.elements.reason.value;
    const password = form.elements.delPassword?.value || $("delPassword").value;
    if (!reason) { err.textContent = "Válassz egy okot."; err.hidden = false; return; }
    if (!password) { err.textContent = "Add meg a jelszavad."; err.hidden = false; $("delPassword").focus(); return; }
    if (!confirm("Biztosan véglegesen törlöd a fiókodat és minden adatodat?")) return;
    const btn = form.querySelector(".del-confirm");
    btn.disabled = true; btn.textContent = "Törlés…";
    try {
      await api("/account", "DELETE", { reason, comment: $("delComment").value, password });
      form.innerHTML = `
        <div class="fb-done">
          <div class="fb-done-icon" aria-hidden="true">✓</div>
          <h3>A fiókodat töröltük</h3>
          <p>Köszönjük, hogy kipróbáltad a Bringatervet!</p>
          <button type="button" class="fb-btn fb-btn--primary" data-bye>Rendben</button>
        </div>`;
      form.querySelector("[data-bye]").addEventListener("click", () => logout());
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      btn.disabled = false; btn.textContent = "Fiók végleges törlése";
    }
  });
}

async function submitCode(input, btn, msgEl) {
  const code = input.value.replace(/\D/g, "");
  if (code.length !== 6) { msgEl.textContent = "Írd be a levélben kapott 6 számjegyű kódot."; input.focus(); return false; }
  btn.disabled = true;
  try {
    _state = await api("/account/verify-code", "POST", { code });
    renderSection();
    return true;
  } catch (e) {
    msgEl.textContent = e.message;
    input.select();
    return false;
  } finally {
    btn.disabled = false;
  }
}

/** A kódmező: csak számjegyek, 6 jegynél (pl. beillesztés / iOS-felajánlás) magától beküldi. */
function wireCodeInput(input, submit) {
  input.addEventListener("input", () => {
    const v = input.value.replace(/\D/g, "").slice(0, 6);
    if (v !== input.value) input.value = v;
    if (v.length === 6) submit();
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
}

async function saveEmail(input, btn, msgEl) {
  const email = input.value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) { msgEl.textContent = "Adj meg egy érvényes e-mail-címet."; return false; }
  btn.disabled = true;
  try {
    _state = await api("/account/email", "PUT", { email });
    msgEl.textContent = _state.sent ? `Kódot küldtünk ide: ${email} – írd be lent.` : "Mentve.";
    renderSection();
    return true;
  } catch (e) {
    msgEl.textContent = e.message;
    return false;
  } finally {
    btn.disabled = false;
  }
}

async function resend(btn, msgEl) {
  btn.disabled = true;
  try {
    _state = await api("/account/email/resend", "POST");
    msgEl.textContent = `Új kódot küldtünk ide: ${_state.email}`;
  } catch (e) {
    msgEl.textContent = e.message;
  } finally {
    setTimeout(() => { btn.disabled = false; }, 20000);   // ne lehessen gyorsan sokszor
  }
}

async function changePassword() {
  const msg = $("accountPwMsg");
  const cur = $("accountPwCurrent").value, pw = $("accountPwNew").value;
  msg.textContent = "";
  if (!cur) { msg.textContent = "Add meg a jelenlegi jelszót."; return; }
  if (pw.length < 8) { msg.textContent = "Az új jelszó legalább 8 karakter legyen."; return; }
  if (pw !== $("accountPwNew2").value) { msg.textContent = "A két új jelszó nem egyezik."; return; }
  const btn = $("accountPwSave");
  btn.disabled = true;
  try {
    const d = await api("/account/password", "PUT", { current: cur, password: pw });
    localStorage.setItem(JWT_KEY, d.token);   // ezen az eszközön bent maradunk
    ["accountPwCurrent", "accountPwNew", "accountPwNew2"].forEach((id) => { $(id).value = ""; });
    msg.textContent = "✓ Jelszó módosítva. A többi eszközön újra be kell lépni.";
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

// ── Záróablak: kötelező e-mail-megerősítés ───────────────────────────────────

function showGate() {
  if ($("emailGate")) return;
  const s = _state;
  const ov = document.createElement("div");
  ov.id = "emailGate";
  ov.className = "install-guide-overlay email-gate";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.innerHTML = `
    <div class="install-guide fb-card">
      <div class="install-guide-head" style="padding:18px 18px 0">
        <div>
          <h3>Erősítsd meg az e-mail-címed</h3>
          <p>A folytatáshoz kell egy megerősített e-mail-cím – erre küldjük például az elfelejtett jelszó linket.</p>
        </div>
      </div>
      <div class="fb-body">
        <label class="fb-label" for="gateEmail">E-mail-cím</label>
        <input id="gateEmail" class="fb-input" type="email" autocomplete="email" autocapitalize="none" spellcheck="false"
               placeholder="nev@pelda.hu" value="${esc(s.email || "")}">
        <div class="gate-code" id="gateCodeBox" ${s.email ? "" : "hidden"}>
          <label class="fb-label" for="gateCode">Megerősítő kód</label>
          <input id="gateCode" class="fb-input gate-code-input" type="text" inputmode="numeric" pattern="[0-9]*"
                 autocomplete="one-time-code" maxlength="6" placeholder="••••••" aria-describedby="gateMsg">
        </div>
        <p class="gate-msg" id="gateMsg">${s.email ? `Küldtünk egy 6 számjegyű kódot ide: <b>${esc(s.email)}</b>. Írd be fent – vagy kattints a levélben lévő linkre.` : "Add meg az e-mail-címed, és küldünk rá egy megerősítő kódot."}</p>
      </div>
      <div class="fb-actions gate-actions">
        <button type="button" class="fb-btn" id="gateLogout">Kilépés</button>
        <button type="button" class="fb-btn" id="gateSend">${s.email ? "Új kód kérése" : "Kód küldése"}</button>
        <button type="button" class="fb-btn fb-btn--primary" id="gateDone">Megerősítés</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const msg = ov.querySelector("#gateMsg");
  const input = ov.querySelector("#gateEmail");
  const codeBox = ov.querySelector("#gateCodeBox");
  const codeInput = ov.querySelector("#gateCode");
  const done = () => { ov.remove(); location.reload(); };   // a megerősítés előtt elutasított adatok betöltése
  const tryCode = async () => {
    if (await submitCode(codeInput, ov.querySelector("#gateDone"), msg) && _state?.email_verified) done();
  };
  wireCodeInput(codeInput, tryCode);
  ov.querySelector("#gateLogout").addEventListener("click", () => logout());
  ov.querySelector("#gateSend").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const email = input.value.trim().toLowerCase();
    if (email && email === (_state.email || "") ) return resend(btn, msg);
    if (await saveEmail(input, btn, msg)) {
      msg.innerHTML = `Küldtünk egy 6 számjegyű kódot ide: <b>${esc(email)}</b>. Írd be fent – vagy kattints a levélben lévő linkre. Nézd meg a spam mappát is.`;
      btn.textContent = "Új kód kérése";
      codeBox.hidden = false;
      codeInput.value = "";
      codeInput.focus();
    }
  });
  ov.querySelector("#gateDone").addEventListener("click", async () => {
    // Beírt kód → ellenőrzés; üres mező → talán a linkkel erősítette meg
    if (codeInput.value.trim()) return tryCode();
    await refresh();
    if (_state?.email_verified) done();
    else msg.innerHTML = "Írd be a levélben kapott 6 számjegyű kódot (ha nem találod, nézd meg a spam mappát, vagy kérj újat).";
  });
}

async function refresh() {
  try {
    _state = await api("/account");
    renderSection();
  } catch { /* offline / nincs fiók-végpont: a Fiók rész rejtve marad */ }
  return _state;
}

export async function initAccount() {
  if (!getToken()) return;
  $("accountEmailSave")?.addEventListener("click", () =>
    saveEmail($("accountEmail"), $("accountEmailSave"), $("accountEmailHint")));
  $("accountResend")?.addEventListener("click", () => resend($("accountResend"), $("accountEmailHint")));
  const codeSubmit = () => submitCode($("accountCode"), $("accountCodeBtn"), $("accountEmailHint"));
  $("accountCodeBtn")?.addEventListener("click", codeSubmit);
  if ($("accountCode")) wireCodeInput($("accountCode"), codeSubmit);
  $("accountPwSave")?.addEventListener("click", changePassword);
  $("accountDeleteBtn")?.addEventListener("click", openDeleteDialog);

  const s = await refresh();
  if (s?.verification_required && !s.email_verified) showGate();

  // Ha a megerősítés egy másik lapon történt, visszatéréskor frissüljön
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !$("emailGate")) return;
    await refresh();
    if (_state?.email_verified) { $("emailGate").remove(); location.reload(); }
  });
}
