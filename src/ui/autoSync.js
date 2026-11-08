/**
 * Bringaterv – automatikus import panel (OnelapFit, Garmin)
 * =========================================================
 * Az import ablak tetején lévő „Automatikus import” blokk: kapcsoló, időköz,
 * állapot, „Ellenőrzés most”. A szerver maga importál időközönként; a kliens csak
 * figyeli az állapotot, és ha új edzés jött, frissíti a könyvtárat + szól.
 *
 * Elemek (prefix = "onelap" | "garmin"):
 *   #<prefix>AutoToggle, #<prefix>AutoInterval, #<prefix>AutoOpts,
 *   #<prefix>AutoStatus, #<prefix>AutoRunBtn
 * api: { get(), save({ enabled, interval_min }), runNow() }
 *
 * Ugyanez a Beállítások szakaszában is (#<prefix>SetAuto doboz, #<prefix>SetAutoToggle,
 * #<prefix>SetAutoInterval, #<prefix>SetAutoStatus): ha a jelölés megvan, ugyanarról az
 * állapotról vezéreljük – a két hely mindig egyformán áll. A doboz csak kapcsolatnál látszik.
 */

function fmtAgo(iso) {
  if (!iso) return "még nem volt ellenőrzés";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "most ellenőrizve";
  if (min < 60) return `${min} perce ellenőrizve`;
  return `${new Date(iso).toLocaleString("hu-HU", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}-kor ellenőrizve`;
}

export function createAutoSyncPanel({ prefix, api, label, showToast, onNewWorkouts }) {
  const $ = (id) => document.querySelector(`#${prefix}${id}`);
  const SETS = [prefix, `${prefix}Set`];                 // import ablak + Beállítások
  const $s = (set, id) => document.querySelector(`#${set}${id}`);
  let state = null;
  let seenTotal = null;
  let timer = null;

  function render() {
    if (!state) return;
    let txt = fmtAgo(state.last_check);
    if (state.last_error) txt += ` · ⚠️ ${state.last_error}`;
    else if (state.last_check) txt += state.last_imported ? ` · ${state.last_imported} új edzés importálva` : " · nincs új edzés";
    for (const set of SETS) {
      const toggle = $s(set, "AutoToggle");
      if (toggle) toggle.checked = !!state.enabled;
      const opts = $s(set, "AutoOpts");
      if (opts) opts.hidden = !state.enabled;
      const sel = $s(set, "AutoInterval");
      if (sel) { sel.value = String(state.interval_min || 15); if (set !== prefix) sel.disabled = !state.enabled; }
      const st = $s(set, "AutoStatus");
      if (st) {
        st.textContent = state.enabled || set === prefix ? txt : "";
        st.classList.toggle("is-error", !!state.last_error);
      }
    }
  }

  async function load() {
    try {
      state = await api.get();
      if (seenTotal === null) seenTotal = state.total_imported || 0;
      render();
    } catch { /* régi szerver / nincs kapcsolat */ }
  }

  /** Ha a szerver új edzést importált azóta, hogy utoljára néztük: könyvtár frissítés + toast */
  async function checkNews() {
    const total = state?.total_imported || 0;
    if (seenTotal !== null && total > seenTotal) {
      const n = total - seenTotal;
      const names = (state.last_names || []).slice(-n).join(", ");
      showToast(`${n} új ${label}-edzés a könyvtárban${names ? ": " + names : ""}`, 8000);
      try { await onNewWorkouts?.(); } catch { /* a könyvtár frissítése nem kritikus */ }
    }
    seenTotal = total;
  }

  async function save(set = prefix) {
    const enabled = !!$s(set, "AutoToggle")?.checked;
    const interval_min = Number($s(set, "AutoInterval")?.value || $("AutoInterval")?.value || 15);
    try {
      state = await api.save({ enabled, interval_min });
      render();
      start();
      showToast(enabled ? `Automatikus ${label} import: ${interval_min < 60 ? interval_min + " percenként" : "óránként"}`
                        : `Automatikus ${label} import kikapcsolva`);
    } catch (err) {
      showToast("Nem sikerült menteni: " + err.message);
    }
  }

  async function runNow() {
    const btn = $("AutoRunBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Ellenőrzés…"; }
    try {
      state = await api.runNow();
      render();
      await checkNews();
    } catch (err) {
      showToast("Ellenőrzés sikertelen: " + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Ellenőrzés most"; }
    }
  }

  function showSettingsBox(on) {
    const box = document.querySelector(`#${prefix}SetAuto`);
    if (box) box.hidden = !on;
  }

  function start() {
    showSettingsBox(true);                               // csak kapcsolatnál
    clearInterval(timer);
    load().then(() => {
      if (!state?.enabled) return;
      // 2 percenként ránéz az állapotra (csak a saját szerver, nem a gyártó API-ja)
      timer = setInterval(async () => {
        if (document.hidden) return;
        await load();
        await checkNews();
      }, 120000);
    });
  }

  function stop() { clearInterval(timer); showSettingsBox(false); }

  for (const set of SETS) {
    $s(set, "AutoToggle")?.addEventListener("change", () => save(set));
    $s(set, "AutoInterval")?.addEventListener("change", () => save(set));
  }
  $("AutoRunBtn")?.addEventListener("click", runNow);

  return { start, stop };
}
