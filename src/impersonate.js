// ── Admin: belépés a felhasználó nevében ──────────────────────────────────────
// Ebben a lapban a localStorage helyett egy sessionStorage-ra épülő, elszigetelt tároló
// fut (a felhasználó tokenje, beállításai) – az admin saját munkamenete a többi lapon
// érintetlen marad. Minden oldal <head>-jében, a modulok előtt kell betölteni.
(function () {
  let info = null;
  try { info = JSON.parse(sessionStorage.getItem("bt_imp") || "null"); } catch { info = null; }
  if (!info) return;
  const ss = sessionStorage, P = "imp:";
  const keys = () => {
    const out = [];
    for (let i = 0; i < ss.length; i++) { const k = ss.key(i); if (k && k.startsWith(P)) out.push(k.slice(P.length)); }
    return out;
  };
  const store = {
    getItem: (k) => ss.getItem(P + k),
    setItem: (k, v) => ss.setItem(P + k, String(v)),
    removeItem: (k) => ss.removeItem(P + k),
    clear: () => keys().forEach((k) => ss.removeItem(P + k)),
    key: (i) => keys()[i] ?? null,
    get length() { return keys().length; },
  };
  try { Object.defineProperty(window, "localStorage", { value: store, configurable: true }); } catch { /* lent kezeljük */ }
  if (window.localStorage !== store) {
    // ha a böngésző nem engedi, inkább ne fusson, mint hogy az admin munkamenetét írja felül
    ss.removeItem("bt_imp");
    keys().forEach((k) => ss.removeItem(P + k));
    alert("Ez a böngésző nem támogatja a felhasználó nézetét.");
    window.close();
    return;
  }
  const leave = () => {
    keys().forEach((k) => ss.removeItem(P + k));
    ss.removeItem("bt_imp");
    window.close();
    setTimeout(() => location.replace("./admin"), 300);   // ha a lapot nem lehet bezárni
  };
  const until = new Date(info.until).toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
  const show = () => {
    const bar = document.createElement("div");
    bar.setAttribute("role", "status");
    bar.style.cssText = "position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:100000;display:flex;" +
      "align-items:center;gap:10px;max-width:calc(100% - 24px);padding:7px 8px 7px 14px;border-radius:999px;" +
      "background:#92400e;color:#fff;font:600 13px/1.3 system-ui,-apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)";
    const txt = document.createElement("span");
    txt.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    txt.textContent = `Felhasználó nézete: ${info.user?.name || info.user?.email || ""} · lejár ${until}`;
    txt.title = `${info.user?.email || ""} – admin: ${info.admin?.email || ""}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Kilépés";
    btn.style.cssText = "flex:none;border:0;border-radius:999px;padding:5px 12px;background:#fff;color:#92400e;font:inherit;cursor:pointer";
    btn.addEventListener("click", leave);
    bar.append(txt, btn);
    document.body.appendChild(bar);
    document.title = `[${info.user?.name || "felhasználó"}] ${document.title}`;
  };
  if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
})();
