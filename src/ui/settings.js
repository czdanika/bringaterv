import { calculateZones, calculateZonesMaxHR, calculateZonesLTHR, calculateZonesCustom, calculateTRIMP, ZONE_DEFS_FRIEL } from '../karvonen.js';
import { routesApi } from '../api/routesApi.js';
import { getImportedHrGeometry, getImportedColoredGeometry, getImportedCadGeometry, getImportedPowerGeometry } from './fileTab.js';
import { getWindResult } from './wind.js';

// ── Module-level injected dependencies ───────────────────────────────────────
let _mapAdapter, _store, _showToast, _getActiveGeometry, _updateElevationButton, _renderSidebar, _syncStartViewDisplay;

// ── HR Zones localStorage key ────────────────────────────────────────────────
const HR_ZONES_KEY = 'bringaterv.hrZones';

// ── Public init ───────────────────────────────────────────────────────────────
export function initSettings({ mapAdapter, store, showToast, getActiveGeometry, updateElevationButton, renderSidebar, syncStartViewDisplay }) {
  _mapAdapter             = mapAdapter;
  _store                  = store;
  _showToast              = showToast;
  _getActiveGeometry      = getActiveGeometry;
  _updateElevationButton  = updateElevationButton;
  _renderSidebar          = renderSidebar;
  _syncStartViewDisplay   = syncStartViewDisplay;

  const settingsOverlay = document.querySelector("#settingsOverlay");
  const settingsClose   = document.querySelector("#settingsClose");

  // Register all sub-inits
  _initHrZoneSettings();
  _initZoneMultiSliders();
  _initChartColorSettings();
  _initDirectionArrowsToggle();
  _initCyclistProfileSettings();
  _initBackupRestore();

  // openSettings listener
  document.querySelector("#settingsButton")?.addEventListener("click", openSettings);
  settingsClose?.addEventListener("click", () => { settingsOverlay.hidden = true; });
  settingsOverlay?.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) settingsOverlay.hidden = true;
  });

  // hrZonesChanged listener
  window.addEventListener('hrZonesChanged', () => {
    const geom = getImportedHrGeometry();
    if (geom) {
      renderHrZoneAnalysis(geom);
      _mapAdapter.recolorHrRoute(geom, buildHrZoneColorFn());
    }
  });

  function openSettings() {
    const topnavDropdown = document.querySelector("#topnavDropdown");
    if (topnavDropdown) topnavDropdown.hidden = true;
    _syncStartViewDisplay?.();
    settingsOverlay.hidden = false;
    window.lucide?.createIcons();
  }
}

// ── HR Zone Analysis helpers (reconstructed) ─────────────────────────────────

/**
 * Computes HR zone duration stats from geometry points.
 * Returns { zones: [...zone, durationMs, pct], totalDurMs }
 */
export function calcHrZoneStats(geometry) {
  const { restHR, maxHR, method, zoneModel, lthr, customBoundaries } = getHrZoneSettings();
  const zones = resolveZones(restHR, maxHR, method, zoneModel, lthr, customBoundaries);

  const zoneDurMs = new Array(zones.length).fill(0);
  let totalDurMs = 0;
  let lastKnownHr = null; // carry-forward: ha nincs HR adat, az utolsó ismert értéket használjuk

  for (let i = 1; i < geometry.length; i++) {
    const prev = geometry[i - 1];
    const curr = geometry[i];
    // Ha van timestamp → azt használjuk; ha nincs → 1 mp proxy (pontszám-alapú becslés)
    const dt = (prev.time != null && curr.time != null)
      ? Math.min(curr.time - prev.time, 60000)
      : 1000;
    if (dt <= 0) continue;

    // Frissítjük a carry-forward értéket ha van adat
    if (prev.hr != null) lastKnownHr = prev.hr;
    if (curr.hr != null) lastKnownHr = curr.hr;

    const hr = curr.hr ?? prev.hr ?? lastKnownHr;
    if (hr == null) continue; // csak akkor ugrik, ha egyáltalán nincs HR az edzésen

    totalDurMs += dt;

    let zoneIdx = zones.length - 1;
    for (let z = 0; z < zones.length; z++) {
      if (hr >= zones[z].low && hr <= zones[z].high) { zoneIdx = z; break; }
    }
    if (hr < zones[0].low)                 zoneIdx = 0;
    if (hr > zones[zones.length - 1].high) zoneIdx = zones.length - 1;

    zoneDurMs[zoneIdx] += dt;
  }

  const zonesWithStats = zones.map((z, i) => ({
    ...z,
    durationMs: zoneDurMs[i],
    pct: totalDurMs > 0 ? Math.round(zoneDurMs[i] / totalDurMs * 100) : 0,
  }));

  return { zones: zonesWithStats, totalDurMs };
}

/**
 * Formats duration in milliseconds to "H:MM:SS" or "M:SS".
 */
export function fmtDurMs(ms) {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Edwards training load score (zone weights 1–5).
 */
export function calcEdwards(zones) {
  const weights = [1, 2, 3, 4, 5];
  return Math.round(zones.reduce((sum, z, i) => sum + (z.durationMs / 60000) * weights[i], 0));
}

/**
 * Renders HR zone rows and TRIMP/Edwards scores into DOM elements
 * #hrZoneRows and #hrZoneScores.
 */
export function renderHrZoneAnalysis(geometry) {
  const rowsEl   = document.getElementById('hrZoneRows');
  const scoresEl = document.getElementById('hrZoneScores');
  if (!rowsEl && !scoresEl) return;

  const { zones, totalDurMs } = calcHrZoneStats(geometry);

  if (rowsEl) {
    rowsEl.innerHTML = zones.map(z => {
      const highLabel = z.high === 999 ? '∞' : z.high;
      return `
        <div class="hr-zone-row hint-target" data-hint="${z.hint ?? ''}">
          <div class="hr-zone-row-label">
            <span class="hr-zone-row-name" style="color:${z.color}">${z.name}</span>
            <span class="hr-zone-row-bpm">${z.low === 0 ? '0' : z.low}–${highLabel} bpm</span>
          </div>
          <div class="hr-zone-row-bar-wrap">
            <div class="hr-zone-row-bar" style="width:${z.pct}%;background:${z.color}"></div>
          </div>
          <span class="hr-zone-row-time">${fmtDurMs(z.durationMs)}</span>
          <span class="hr-zone-row-pct" style="color:${z.color}">${z.pct}%</span>
        </div>`;
    }).join('');
  }

  if (scoresEl) {
    if (totalDurMs > 0) {
      const { restHR, maxHR, sex } = getHrZoneSettings();

      // Compute average HR from geometry for TRIMP
      let hrSum = 0, hrCount = 0;
      for (const pt of geometry) {
        if (pt.hr != null) { hrSum += pt.hr; hrCount++; }
      }
      const avgHR = hrCount > 0 ? hrSum / hrCount : (restHR + maxHR) / 2;
      const durationMin = totalDurMs / 60000;
      const trimp = calculateTRIMP(durationMin, avgHR, restHR, maxHR, sex);
      const edwards = calcEdwards(zones);

      scoresEl.innerHTML = `
        <div class="hr-score-item">
          <span class="hr-score-label">TRIMP</span>
          <span class="hr-score-value">${trimp}</span>
        </div>
        <div class="hr-score-item">
          <span class="hr-score-label">Edwards</span>
          <span class="hr-score-value">${edwards}</span>
        </div>`;
    } else {
      scoresEl.innerHTML = '';
    }
  }
}

// ── HR Zone Settings ──────────────────────────────────────────────────────────

export function getHrZoneSettings() {
  const CURRENT_YEAR = new Date().getFullYear();
  try {
    const s = JSON.parse(localStorage.getItem(HR_ZONES_KEY) || '{}');
    // Visszafelé kompatibilitás: ha csak `age` van mentve, abból számolunk birthYear-t
    const birthYear = s.birthYear ?? (s.age ? CURRENT_YEAR - s.age : 1985);
    const age = Math.max(10, Math.min(100, CURRENT_YEAR - birthYear));
    return {
      sex:       s.sex ?? 'male',
      birthYear,
      age,
      restHR:    s.rest ?? 60,
      maxHR:     s.max  ?? 190,
      maxMethod: s.maxMethod ?? 'tanaka',                // tanaka | classic | custom (max HR meghatározása)
      method:    s.method    ?? 'karvonen',              // karvonen | maxhr | lthr | custom (zónaszámítás)
      zoneModel: s.zoneModel ?? 'friel',                 // friel | equal
      lthr:      s.lthr      ?? 160,
      customBoundaries: s.customBoundaries ?? [105, 139, 156, 173],
    };
  } catch {
    return {
      sex: 'male', birthYear: 1985, age: CURRENT_YEAR - 1985,
      restHR: 60, maxHR: 190, maxMethod: 'tanaka', zoneModel: 'friel',
      method: 'karvonen', lthr: 160, customBoundaries: [105, 139, 156, 173],
    };
  }
}

/** Max HR kiszámítása életkor+nem alapján a választott módszer szerint. */
export function computeMaxHr(method, age, sex) {
  if (method === 'classic') return Math.round(220 - age);
  if (method === 'tanaka') {
    return sex === 'female'
      ? Math.round(216 - 1.09 * age)   // Miller – nőkre pontosabb
      : Math.round(208 - 0.7  * age);  // Tanaka – ajánlott aktív felnőtteknek
  }
  return null; // custom: nem számítunk, a user adja meg
}

/** Zone-alapú HR szín-függvény a térképhez */
export function buildHrZoneColorFn() {
  const { restHR, maxHR, method, zoneModel, lthr, customBoundaries } = getHrZoneSettings();
  const zones = resolveZones(restHR, maxHR, method, zoneModel, lthr, customBoundaries);
  return (hr) => {
    if (hr == null) return null;
    for (const z of zones) {
      if (hr >= z.low && hr <= z.high) return z.color;
    }
    return hr < zones[0].low ? zones[0].color : zones[zones.length - 1].color;
  };
}

/** Zónák kiszámolása a beállított módszer és zónamodell szerint */
export function resolveZones(restHR, maxHR, method, zoneModel = 'friel', lthr = 160, customBoundaries = [105, 139, 156, 173]) {
  if (method === 'lthr')   return calculateZonesLTHR(lthr);
  if (method === 'custom') return calculateZonesCustom(customBoundaries);
  const defs = zoneModel === 'friel' ? ZONE_DEFS_FRIEL : undefined;
  return method === 'maxhr' ? calculateZonesMaxHR(maxHR, defs) : calculateZones(restHR, maxHR, defs);
}

function renderKarvonenZonesList(restHR, maxHR, method = 'karvonen', zoneModel = 'friel', lthr = 160, customBoundaries = [105, 139, 156, 173]) {
  const list = document.getElementById('karvonenZonesList');
  if (!list) return;
  const zones = resolveZones(restHR, maxHR, method, zoneModel, lthr, customBoundaries);
  const refLabel = method === 'maxhr' ? 'HRmax' : method === 'lthr' ? 'LTHR' : method === 'custom' ? '' : 'HRR';
  list.innerHTML = zones.map(z => `
    <div class="karvonen-zone-row" style="--zone-color:${z.color}">
      <div class="karvonen-zone-name">
        <div class="karvonen-zone-title">${z.name}</div>
        <div class="karvonen-zone-subtitle">${z.sub}</div>
      </div>
      <div class="karvonen-zone-pct-hrr">${z.pctLow != null ? `${z.pctLow}–${z.pctHigh}% ${refLabel}` : 'egyedi'}</div>
      <div class="karvonen-zone-range">${z.low === 0 ? '0' : z.low}–${z.high === 999 ? '∞' : z.high}</div>
    </div>`).join('');
}

function _initHrZoneSettings() {
  const sexRadios       = document.querySelectorAll('input[name="hrSex"]');
  const maxMethodRadios = document.querySelectorAll('input[name="hrMaxMethod"]');
  const methodRadios    = document.querySelectorAll('input[name="hrMethod"]');
  const zoneModelRadios = document.querySelectorAll('input[name="hrZoneModel"]');
  const birthYearInput  = document.getElementById('hrBirthYearInput');
  const ageDisplay      = document.getElementById('hrAgeDisplay');
  const rangeSlider     = document.getElementById('hrRangeSlider');
  const restHandle      = document.getElementById('hrRangeRestHandle');
  const maxHandle       = document.getElementById('hrRangeMaxHandle');
  const activeTrack     = document.getElementById('hrRangeActive');
  const restDisplay     = document.getElementById('hrRestDisplay');
  const maxDisplay      = document.getElementById('hrMaxDisplay');
  const maxSourceHint   = document.getElementById('hrMaxSourceHint');
  const tanakaName      = document.getElementById('hrMaxMethodTanakaName');
  const tanakaEq        = document.getElementById('hrMaxMethodTanakaEq');
  const tanakaHint      = document.getElementById('hrMaxMethodTanakaHint');
  const lthrSlider      = document.getElementById('hrLthrSlider');
  const lthrOut         = document.getElementById('hrLthrOut');
  const lthrRow         = document.getElementById('hrLthrSliderRow');
  const zoneModelRow    = document.getElementById('hrZoneModelRow');
  const customRow       = document.getElementById('hrCustomBoundariesRow');
  const customInputs    = [
    document.getElementById('hrCustomB1'),
    document.getElementById('hrCustomB2'),
    document.getElementById('hrCustomB3'),
    document.getElementById('hrCustomB4'),
  ];
  if (!birthYearInput || !rangeSlider) return;

  // Pulzus tartomány állapot (a slider source-of-truth)
  const RANGE_MIN = 35;
  const RANGE_MAX = 220;
  const MIN_GAP   = 30;  // max ≥ rest + 30
  let restValue = 60;
  let maxValue  = 190;

  const init = getHrZoneSettings();
  sexRadios.forEach(r => { r.checked = r.value === init.sex; });
  maxMethodRadios.forEach(r => { r.checked = r.value === init.maxMethod; });
  methodRadios.forEach(r => { r.checked = r.value === init.method; });
  zoneModelRadios.forEach(r => { r.checked = r.value === init.zoneModel; });
  birthYearInput.value = init.birthYear;
  restValue = init.restHR;
  maxValue  = init.maxHR;
  if (lthrSlider) lthrSlider.value = init.lthr;
  if (lthrOut)    lthrOut.textContent = init.lthr;
  customInputs.forEach((inp, i) => { if (inp) inp.value = init.customBoundaries[i]; });

  function currentSex()       { return [...sexRadios].find(r => r.checked)?.value ?? 'male'; }
  function currentMaxMethod() { return [...maxMethodRadios].find(r => r.checked)?.value ?? 'tanaka'; }
  function currentMethod()    { return [...methodRadios].find(r => r.checked)?.value ?? 'karvonen'; }
  function currentZoneModel() { return [...zoneModelRadios].find(r => r.checked)?.value ?? 'friel'; }
  function currentLthr()      { return parseInt(lthrSlider?.value ?? 160, 10); }
  function currentCustomBoundaries() {
    return customInputs.map(inp => parseInt(inp?.value ?? 0, 10));
  }
  function currentAge() {
    const year = parseInt(birthYearInput.value, 10);
    if (!year || isNaN(year)) return 40;
    return Math.max(10, Math.min(100, new Date().getFullYear() - year));
  }

  function updateTanakaLabel() {
    const female = currentSex() === 'female';
    if (tanakaName) tanakaName.textContent = female ? 'Miller' : 'Tanaka';
    if (tanakaEq)   tanakaEq.textContent   = female ? '216 − 1.09 × kor' : '208 − 0.7 × kor';
    if (tanakaHint) tanakaHint.dataset.hint = female
      ? 'Miller (1993): 216 − 1.09 × kor. Nőkre optimalizált, pontosabb mint a Tanaka nőknél.'
      : 'Tanaka (2001): 208 − 0.7 × kor. Meta-analízis alapú, pontosabb aktív felnőtteknél.';
  }

  function updateAgeDisplay() {
    if (ageDisplay) ageDisplay.textContent = `${currentAge()} éves`;
  }

  function rangeValToPct(v) { return (v - RANGE_MIN) / (RANGE_MAX - RANGE_MIN) * 100; }
  function rangePctToVal(p) { return Math.round(RANGE_MIN + p / 100 * (RANGE_MAX - RANGE_MIN)); }

  function renderRangeSlider() {
    if (restValue < RANGE_MIN) restValue = RANGE_MIN;
    if (maxValue  > RANGE_MAX) maxValue  = RANGE_MAX;
    if (maxValue  < restValue + MIN_GAP) maxValue = restValue + MIN_GAP;
    const restPct = rangeValToPct(restValue);
    const maxPct  = rangeValToPct(maxValue);
    if (restHandle)  restHandle.style.left  = restPct + '%';
    if (maxHandle)   maxHandle.style.left   = maxPct  + '%';
    if (activeTrack) { activeTrack.style.left = restPct + '%'; activeTrack.style.width = (maxPct - restPct) + '%'; }
    if (restDisplay) restDisplay.textContent = restValue;
    if (maxDisplay)  maxDisplay.textContent  = maxValue;
  }

  function updateMaxFromMethod() {
    const method = currentMaxMethod();
    if (method === 'custom') {
      maxHandle?.classList.remove('is-disabled');
      if (maxSourceHint) maxSourceHint.textContent = '(egyedi)';
      return;
    }
    // Auto-számítás: max handle nem mozgatható
    maxHandle?.classList.add('is-disabled');
    const val = computeMaxHr(method, currentAge(), currentSex());
    if (val != null) {
      maxValue = Math.max(restValue + MIN_GAP, Math.min(RANGE_MAX, val));
      renderRangeSlider();
      if (maxSourceHint) maxSourceHint.textContent = method === 'tanaka'
        ? (currentSex() === 'female' ? 'Miller' : 'Tanaka')
        : '220 − év';
    }
  }

  /** Zónaszámítási módszer alapján mutatjuk/rejtjük a kapcsolódó vezérlőket. */
  function updateMethodVisibility() {
    const method = currentMethod();
    if (lthrRow)      lthrRow.hidden      = method !== 'lthr';
    if (customRow)    customRow.hidden    = method !== 'custom';
    if (zoneModelRow) zoneModelRow.hidden = method === 'lthr' || method === 'custom';
  }

  function saveAndDispatch() {
    const sex       = currentSex();
    const birthYear = parseInt(birthYearInput.value, 10) || 1985;
    const age       = currentAge();
    const maxMethod = currentMaxMethod();
    const method    = currentMethod();
    const zoneModel = currentZoneModel();
    const lthr      = currentLthr();
    const customBoundaries = currentCustomBoundaries();
    const payload = {
      sex, birthYear, age,
      rest: restValue, max: maxValue, maxMethod,
      method, zoneModel, lthr, customBoundaries,
    };
    localStorage.setItem(HR_ZONES_KEY, JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent('hrZonesChanged', { detail: payload }));
    renderKarvonenZonesList(restValue, maxValue, method, zoneModel, lthr, customBoundaries);
  }

  // Dual-handle slider drag logika
  function attachRangeHandle(handle, isMax) {
    if (!handle) return;
    handle.addEventListener('pointerdown', e => {
      // Auto-mód esetén a max handle nem mozgatható
      if (isMax && currentMaxMethod() !== 'custom') return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      function onMove(ev) {
        const rect = rangeSlider.getBoundingClientRect();
        let pct = (ev.clientX - rect.left) / rect.width * 100;
        pct = Math.max(0, Math.min(100, pct));
        let val = rangePctToVal(pct);
        if (isMax) {
          val = Math.max(restValue + MIN_GAP, Math.min(RANGE_MAX, val));
          maxValue = val;
        } else {
          val = Math.max(RANGE_MIN, Math.min(maxValue - MIN_GAP, val));
          restValue = val;
          // Ha auto-mód aktív, a max-ot újraszámoljuk (rest nem befolyásolja, csak a clamp miatt frissítjük)
        }
        renderRangeSlider();
        // Live update: zónalista is azonnal mutatja
        renderKarvonenZonesList(restValue, maxValue, currentMethod(), currentZoneModel(), currentLthr(), currentCustomBoundaries());
      }
      function onUp() {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        saveAndDispatch();
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }
  attachRangeHandle(restHandle, false);
  attachRangeHandle(maxHandle,  true);

  // ── Multi-slider az egyedi zónahatárokhoz ────────────────────────────────
  const SLIDER_MIN = 40, SLIDER_MAX = 220;
  const HR_ZONE_COLORS = ['#888780', '#1D9E75', '#378ADD', '#EF9F27', '#E24B4A'];
  const sliderEl = document.getElementById('hrMultiSlider');
  const sliderHandles = [];
  const sliderSegments = [];

  function valToPct(v) { return (v - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN) * 100; }
  function pctToVal(p) { return Math.round(SLIDER_MIN + p / 100 * (SLIDER_MAX - SLIDER_MIN)); }

  function updateMultiSlider() {
    if (!sliderEl || sliderSegments.length === 0) return;
    const cb = currentCustomBoundaries();
    const pcts = [0, ...cb.map(valToPct), 100];
    sliderSegments.forEach((seg, i) => {
      seg.style.left  = pcts[i] + '%';
      seg.style.width = (pcts[i + 1] - pcts[i]) + '%';
    });
    sliderHandles.forEach((h, i) => {
      h.style.left = valToPct(cb[i]) + '%';
    });
  }

  function updateZoneDisplay() {
    const el = document.getElementById('hrCustomZoneDisplay');
    if (!el) return;
    const cb = currentCustomBoundaries();
    const ranges = [`0–${cb[0]}`, `${cb[0]}–${cb[1]}`, `${cb[1]}–${cb[2]}`, `${cb[2]}–${cb[3]}`, `${cb[3]}+`];
    el.innerHTML = HR_ZONE_COLORS.map((c, i) =>
      `<span class="hr-czd-item">
        <span class="hr-czd-dot" style="background:${c}"></span>
        <span class="hr-czd-name" style="color:${c}">Z${i + 1}</span>
        <span class="hr-czd-val">${ranges[i]}</span>
      </span>`
    ).join('');
  }

  if (sliderEl) {
    const track = sliderEl.querySelector('.hr-multi-slider-track');
    for (let i = 0; i < 5; i++) {
      const seg = document.createElement('div');
      seg.className = 'hr-multi-slider-segment';
      seg.style.background = HR_ZONE_COLORS[i];
      track.appendChild(seg);
      sliderSegments.push(seg);
    }
    for (let i = 0; i < 4; i++) {
      const h = document.createElement('div');
      h.className = 'hr-multi-slider-handle';
      h.style.borderColor = HR_ZONE_COLORS[i + 1];
      sliderEl.appendChild(h);
      sliderHandles.push(h);
      h.addEventListener('pointerdown', e => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        function onMove(ev) {
          const rect = sliderEl.getBoundingClientRect();
          let pct = (ev.clientX - rect.left) / rect.width * 100;
          pct = Math.max(0, Math.min(100, pct));
          let val = pctToVal(pct);
          const cb = currentCustomBoundaries();
          const minV = i > 0 ? cb[i - 1] + 2 : SLIDER_MIN + 2;
          const maxV = i < 3 ? cb[i + 1] - 2 : SLIDER_MAX - 2;
          val = Math.max(minV, Math.min(maxV, val));
          if (customInputs[i]) customInputs[i].value = val;
          updateMultiSlider();
          updateZoneDisplay();
        }
        function onUp() {
          h.removeEventListener('pointermove', onMove);
          h.removeEventListener('pointerup', onUp);
          saveAndDispatch();
        }
        h.addEventListener('pointermove', onMove);
        h.addEventListener('pointerup', onUp);
      });
    }
    updateMultiSlider();
    updateZoneDisplay();
  }

  /**
   * Form újratöltése a localStorage aktuális tartalmából.
   * Akkor hívódik, amikor a szerver sync friss adatokkal felülírja a localStorage-t
   * (pl. új user bejelentkezés után, miután az IIFE már lefutott a defaults-szal).
   */
  function applySettingsFromStorage() {
    const fresh = getHrZoneSettings();
    sexRadios.forEach(r => { r.checked = r.value === fresh.sex; });
    maxMethodRadios.forEach(r => { r.checked = r.value === fresh.maxMethod; });
    methodRadios.forEach(r => { r.checked = r.value === fresh.method; });
    zoneModelRadios.forEach(r => { r.checked = r.value === fresh.zoneModel; });
    birthYearInput.value = fresh.birthYear;
    restValue = fresh.restHR;
    maxValue  = fresh.maxHR;
    if (lthrSlider) lthrSlider.value = fresh.lthr;
    if (lthrOut)    lthrOut.textContent = fresh.lthr;
    customInputs.forEach((inp, i) => { if (inp) inp.value = fresh.customBoundaries[i]; });
    updateTanakaLabel();
    updateAgeDisplay();
    updateMaxFromMethod();
    renderRangeSlider();
    updateMethodVisibility();
    if (sliderEl) { updateMultiSlider(); updateZoneDisplay(); }
    renderKarvonenZonesList(restValue, maxValue, fresh.method, fresh.zoneModel, fresh.lthr, fresh.customBoundaries);
  }
  window.addEventListener('bringaterv:settingsHydrated', applySettingsFromStorage);

  // Kezdeti renderelés
  updateTanakaLabel();
  updateAgeDisplay();
  updateMaxFromMethod();   // ez állítja be a max handle-t és visibility-t
  renderRangeSlider();
  updateMethodVisibility();
  renderKarvonenZonesList(restValue, maxValue, init.method, init.zoneModel, init.lthr, init.customBoundaries);

  // Eseménykötések
  sexRadios.forEach(r => r.addEventListener('change', () => {
    updateTanakaLabel();
    updateMaxFromMethod();
    saveAndDispatch();
  }));
  birthYearInput.addEventListener('input', () => {
    updateAgeDisplay();
    updateMaxFromMethod();
    saveAndDispatch();
  });
  maxMethodRadios.forEach(r => r.addEventListener('change', () => {
    updateMaxFromMethod();
    saveAndDispatch();
  }));
  methodRadios.forEach(r => r.addEventListener('change', () => {
    updateMethodVisibility();
    saveAndDispatch();
  }));
  zoneModelRadios.forEach(r => r.addEventListener('change', saveAndDispatch));
  lthrSlider?.addEventListener('input', () => {
    if (lthrOut) lthrOut.textContent = currentLthr();
    saveAndDispatch();
  });
  customInputs.forEach(inp => inp?.addEventListener('change', () => {
    updateMultiSlider();
    updateZoneDisplay();
    saveAndDispatch();
  }));
}

// ── Speed / Cadence / Power zone multi-sliders ────────────────────────────────
// 8 sávok, 7 fogópont. Színátmenet: szürke → kék → cián → zöld → lime → sárga → narancs → piros
export const ZONE_COLORS = ['#9CA3AF', '#3B82F6', '#06B6D4', '#22C55E', '#84CC16', '#EAB308', '#F97316', '#EF4444'];
export const ZONE_HANDLE_COUNT = 7;   // = ZONE_COLORS.length - 1

export const ZONE_CONFIGS = {
  speed: {
    storageKey: 'bringaterv.speedZones',
    defaults: [5, 12, 18, 22, 26, 30, 35],
    unit: 'km/h',
    sliderId: 'speedZoneSlider',
    displayId: 'speedZoneDisplay',
    inputIds: ['speedZoneB1', 'speedZoneB2', 'speedZoneB3', 'speedZoneB4', 'speedZoneB5', 'speedZoneB6', 'speedZoneB7'],
    legendId: 'speedLegend',
  },
  cad: {
    storageKey: 'bringaterv.cadZones',
    defaults: [55, 70, 80, 88, 94, 100, 108],
    unit: 'rpm',
    sliderId: 'cadZoneSlider',
    displayId: 'cadZoneDisplay',
    inputIds: ['cadZoneB1', 'cadZoneB2', 'cadZoneB3', 'cadZoneB4', 'cadZoneB5', 'cadZoneB6', 'cadZoneB7'],
    legendId: 'cadLegend',
  },
  power: {
    storageKey: 'bringaterv.powerZones',
    defaults: [75, 130, 180, 220, 260, 310, 380],
    unit: 'W',
    sliderId: 'powerZoneSlider',
    displayId: 'powerZoneDisplay',
    inputIds: ['powerZoneB1', 'powerZoneB2', 'powerZoneB3', 'powerZoneB4', 'powerZoneB5', 'powerZoneB6', 'powerZoneB7'],
    legendId: 'powerLegend',
  },
};

/** localStorage-ból olvassa a zónahatárokat, defaultokra esik vissza ha hibás/üres. */
export function getZoneBoundaries(kind) {
  const cfg = ZONE_CONFIGS[kind];
  if (!cfg) return [];
  try {
    const s = JSON.parse(localStorage.getItem(cfg.storageKey) || 'null');
    if (s?.boundaries?.length === ZONE_HANDLE_COUNT && s.boundaries.every(n => Number.isFinite(n))) {
      return s.boundaries;
    }
  } catch {}
  return [...cfg.defaults];
}

/** Egy érték (sebesség / kadencia / power) színe a felhasználói zónahatárok alapján. */
export function getZoneColor(kind, value) {
  if (value == null) return null;
  const b = getZoneBoundaries(kind);
  for (let i = 0; i < b.length; i++) {
    if (value < b[i]) return ZONE_COLORS[i];
  }
  return ZONE_COLORS[b.length];
}

/** Jelmagyarázat (térkép alatti színes legend) újrarajzolása az aktuális határok alapján. */
export function rebuildZoneLegend(kind) {
  const cfg = ZONE_CONFIGS[kind];
  if (!cfg) return;
  const legend = document.querySelector(`#${cfg.legendId} .speed-legend-items`);
  if (!legend) return;
  const b = getZoneBoundaries(kind);
  const ranges = [];
  for (let i = 0; i <= ZONE_HANDLE_COUNT; i++) {
    if (i === 0)                          ranges.push(`&lt; ${b[0]} ${cfg.unit}`);
    else if (i === ZONE_HANDLE_COUNT)     ranges.push(`${b[i - 1]}+ ${cfg.unit}`);
    else                                  ranges.push(`${b[i - 1]}–${b[i]} ${cfg.unit}`);
  }
  legend.innerHTML = ZONE_COLORS.map((c, i) =>
    `<div class="speed-legend-item"><span class="speed-dot" style="background:${c}"></span>${ranges[i]}</div>`
  ).join('');
}

/** Generikus multi-slider init: 7 fogópont + 8 színes szegmens + zónacímkék. */
export function initZoneMultiSlider(kind) {
  const cfg = ZONE_CONFIGS[kind];
  const sliderEl = document.getElementById(cfg.sliderId);
  const displayEl = document.getElementById(cfg.displayId);
  const inputs = cfg.inputIds.map(id => document.getElementById(id));
  if (!sliderEl || inputs.some(i => !i)) return;

  const SLIDER_MIN = parseInt(sliderEl.dataset.zoneMin, 10);
  const SLIDER_MAX = parseInt(sliderEl.dataset.zoneMax, 10);
  const N = ZONE_HANDLE_COUNT; // 7 fogópont, 8 szegmens

  // Kezdeti értékek betöltése localStorage-ból
  const initial = getZoneBoundaries(kind);
  inputs.forEach((inp, i) => { inp.value = initial[i]; });

  function currentBoundaries() {
    return inputs.map(inp => parseInt(inp.value, 10));
  }
  function valToPct(v) { return (v - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN) * 100; }
  function pctToVal(p) { return Math.round(SLIDER_MIN + p / 100 * (SLIDER_MAX - SLIDER_MIN)); }

  const handles = [];
  const segments = [];
  const track = sliderEl.querySelector('.hr-multi-slider-track');
  for (let i = 0; i <= N; i++) {
    const seg = document.createElement('div');
    seg.className = 'hr-multi-slider-segment';
    seg.style.background = ZONE_COLORS[i];
    track.appendChild(seg);
    segments.push(seg);
  }
  for (let i = 0; i < N; i++) {
    const h = document.createElement('div');
    h.className = 'hr-multi-slider-handle';
    h.style.borderColor = ZONE_COLORS[i + 1];
    sliderEl.appendChild(h);
    handles.push(h);
    h.addEventListener('pointerdown', e => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      function onMove(ev) {
        const rect = sliderEl.getBoundingClientRect();
        let pct = (ev.clientX - rect.left) / rect.width * 100;
        pct = Math.max(0, Math.min(100, pct));
        let val = pctToVal(pct);
        const cb = currentBoundaries();
        const minV = i > 0      ? cb[i - 1] + 1 : SLIDER_MIN;
        const maxV = i < N - 1  ? cb[i + 1] - 1 : SLIDER_MAX;
        val = Math.max(minV, Math.min(maxV, val));
        inputs[i].value = val;
        renderSlider();
        renderZoneDisplay();
        rebuildZoneLegend(kind);
        // Élő újraszínezés a térképen (ha be van töltve a megfelelő geometry)
        if (kind === 'speed' && getImportedColoredGeometry()) _mapAdapter.renderColoredRoute(getImportedColoredGeometry());
        if (kind === 'cad'   && getImportedCadGeometry())     _mapAdapter.renderCadRoute(getImportedCadGeometry());
        if (kind === 'power' && getImportedPowerGeometry())   _mapAdapter.renderPowerRoute(getImportedPowerGeometry());
      }
      function onUp() {
        h.removeEventListener('pointermove', onMove);
        h.removeEventListener('pointerup', onUp);
        saveZones();
      }
      h.addEventListener('pointermove', onMove);
      h.addEventListener('pointerup', onUp);
    });
  }

  function renderSlider() {
    const cb = currentBoundaries();
    const pcts = [0, ...cb.map(valToPct), 100];
    segments.forEach((seg, i) => {
      seg.style.left = pcts[i] + '%';
      seg.style.width = (pcts[i + 1] - pcts[i]) + '%';
    });
    handles.forEach((h, i) => { h.style.left = valToPct(cb[i]) + '%'; });
  }

  function renderZoneDisplay() {
    if (!displayEl) return;
    const cb = currentBoundaries();
    const ranges = [];
    for (let i = 0; i <= N; i++) {
      if (i === 0)      ranges.push(`< ${cb[0]}`);
      else if (i === N) ranges.push(`${cb[i - 1]}+`);
      else              ranges.push(`${cb[i - 1]}–${cb[i]}`);
    }
    // Egység már a szekció címben szerepel (pl. "Sebesség zónák (km/h)") –
    // nem ismételjük zónánként, hogy elférjen 2 oszlopos rácsban
    displayEl.innerHTML = ZONE_COLORS.map((c, i) =>
      `<span class="hr-czd-item">
        <span class="hr-czd-dot" style="background:${c}"></span>
        <span class="hr-czd-name" style="color:${c}">Z${i + 1}</span>
        <span class="hr-czd-val">${ranges[i]}</span>
      </span>`
    ).join('');
  }

  function saveZones() {
    const boundaries = currentBoundaries();
    localStorage.setItem(cfg.storageKey, JSON.stringify({ boundaries }));
    window.dispatchEvent(new CustomEvent('bringaterv:settingChanged', { detail: { kind } }));
  }

  renderSlider();
  renderZoneDisplay();
  rebuildZoneLegend(kind);

  // Egyenlő felosztás gomb: a teljes [SLIDER_MIN, SLIDER_MAX] tartományt
  // 8 egyenlő szegmensre osztja, és a 7 határértéket beállítja
  const resetBtn = document.querySelector(`[data-zone-reset="${kind}"]`);
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      const span = SLIDER_MAX - SLIDER_MIN;
      const step = span / (N + 1);
      for (let i = 0; i < N; i++) {
        inputs[i].value = Math.round(SLIDER_MIN + step * (i + 1));
      }
      renderSlider();
      renderZoneDisplay();
      rebuildZoneLegend(kind);
      saveZones();
      // Élő újraszínezés a térképen
      if (kind === 'speed' && getImportedColoredGeometry()) _mapAdapter.renderColoredRoute(getImportedColoredGeometry());
      if (kind === 'cad'   && getImportedCadGeometry())     _mapAdapter.renderCadRoute(getImportedCadGeometry());
      if (kind === 'power' && getImportedPowerGeometry())   _mapAdapter.renderPowerRoute(getImportedPowerGeometry());
    });
  }

  // Hydration after server sync
  window.addEventListener('bringaterv:settingsHydrated', () => {
    const fresh = getZoneBoundaries(kind);
    inputs.forEach((inp, i) => { inp.value = fresh[i]; });
    renderSlider();
    renderZoneDisplay();
    rebuildZoneLegend(kind);
    if (kind === 'speed' && getImportedColoredGeometry()) _mapAdapter.renderColoredRoute(getImportedColoredGeometry());
    if (kind === 'cad'   && getImportedCadGeometry())     _mapAdapter.renderCadRoute(getImportedCadGeometry());
    if (kind === 'power' && getImportedPowerGeometry())   _mapAdapter.renderPowerRoute(getImportedPowerGeometry());
  });
}

function _initZoneMultiSliders() {
  initZoneMultiSlider('speed');
  initZoneMultiSlider('cad');
  initZoneMultiSlider('power');
}

// ── Chart colors (solid / zone color mode + 4 color pickers) ─────────────────
export const CHART_COLOR_DEFAULTS = {
  mode:  'solid',
  ele:   '#fc4c02',
  speed: '#3B82F6',
  hr:    '#EF4444',
  cad:   '#A855F7',
  power: '#EAB308',
};

/** Lejtés (%) alapú szín – a térképes grade legend színeivel egyezik. */
export function gradeColorForGrade(grade) {
  if (grade == null)  return '#9CA3AF';
  if (grade > 8)      return '#7F1D1D';
  if (grade > 4)      return '#DC2626';
  if (grade > 2)      return '#EF4444';
  if (grade > 0.5)    return '#FCA5A5';
  if (grade > -0.5)   return '#9CA3AF';
  if (grade > -2)     return '#86EFAC';
  if (grade > -4)     return '#22C55E';
  if (grade > -8)     return '#15803D';
  return '#14532D';
}

export function getChartColors() {
  try {
    const s = JSON.parse(localStorage.getItem('bringaterv.chartColors') || 'null');
    if (s && typeof s === 'object') return { ...CHART_COLOR_DEFAULTS, ...s };
  } catch {}
  return { ...CHART_COLOR_DEFAULTS };
}

function _initChartColorSettings() {
  const modeRadios = document.querySelectorAll('input[name="chartColorMode"]');
  const solidRow   = document.getElementById('chartColorSolidRow');
  const inputs = {
    ele:   document.getElementById('chartColorEle'),
    speed: document.getElementById('chartColorSpeed'),
    hr:    document.getElementById('chartColorHr'),
    cad:   document.getElementById('chartColorCad'),
    power: document.getElementById('chartColorPower'),
  };
  if (!modeRadios.length) return;

  function applyToUI() {
    const cc = getChartColors();
    modeRadios.forEach(r => { r.checked = r.value === cc.mode; });
    for (const k in inputs) if (inputs[k]) inputs[k].value = cc[k];
    if (solidRow) solidRow.style.display = (cc.mode === 'zones') ? 'none' : '';
  }

  function save() {
    const mode = [...modeRadios].find(r => r.checked)?.value ?? 'solid';
    const payload = { mode };
    for (const k in inputs) if (inputs[k]) payload[k] = inputs[k].value;
    localStorage.setItem('bringaterv.chartColors', JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent('bringaterv:settingChanged', { detail: { kind: 'chartColors' } }));
    if (solidRow) solidRow.style.display = (mode === 'zones') ? 'none' : '';
    // Diagramok újrarajzolása az aktuális geometriából
    const activeGeometry = _getActiveGeometry?.();
    if (activeGeometry?.length) {
      _updateElevationButton?.(activeGeometry);
    }
  }

  applyToUI();
  modeRadios.forEach(r => r.addEventListener('change', save));
  for (const k in inputs) inputs[k]?.addEventListener('input', save);

  // Hydration after server sync
  window.addEventListener('bringaterv:settingsHydrated', () => {
    applyToUI();
    const activeGeometry = _getActiveGeometry?.();
    if (activeGeometry?.length) {
      _updateElevationButton?.(activeGeometry);
    }
  });
}

// ── Direction arrows toggle ───────────────────────────────────────────────────
function _initDirectionArrowsToggle() {
  const toggle = document.getElementById("directionArrowsToggle");
  if (!toggle) return;
  // Hidratálás localStorage-ból
  toggle.checked = localStorage.getItem("bringaterv.directionArrows") === "true";
  toggle.addEventListener("change", () => {
    localStorage.setItem("bringaterv.directionArrows", String(toggle.checked));
    if (toggle.checked) {
      const activeGeometry = _getActiveGeometry?.();
      if (activeGeometry?.length >= 2 && _mapAdapter.renderDirectionArrows) {
        _mapAdapter.renderDirectionArrows(activeGeometry, 1.5);
      }
    } else {
      _mapAdapter.clearDirectionArrows?.();
    }
  });
}

// ── Cyclist profile (physical parameters for wind effect / calories) ──────────
export const CYCLIST_PROFILE_DEFAULTS = { riderKg: 75, bikeKg: 10, position: "road" };

export function getCyclistProfile() {
  try {
    const s = JSON.parse(localStorage.getItem("bringaterv.cyclistProfile") || "null");
    if (s && typeof s === "object") return { ...CYCLIST_PROFILE_DEFAULTS, ...s };
  } catch {}
  return { ...CYCLIST_PROFILE_DEFAULTS };
}

function _initCyclistProfileSettings() {
  const riderEl = document.getElementById("profileRiderKg");
  const bikeEl  = document.getElementById("profileBikeKg");
  const posEl   = document.getElementById("profilePosition");
  if (!riderEl || !bikeEl || !posEl) return;

  function applyToUI() {
    const p = getCyclistProfile();
    riderEl.value = p.riderKg;
    bikeEl.value  = p.bikeKg;
    posEl.value   = p.position;
  }
  function save() {
    const payload = {
      riderKg:  parseFloat(riderEl.value) || CYCLIST_PROFILE_DEFAULTS.riderKg,
      bikeKg:   parseFloat(bikeEl.value)  || CYCLIST_PROFILE_DEFAULTS.bikeKg,
      position: posEl.value || CYCLIST_PROFILE_DEFAULTS.position,
    };
    localStorage.setItem("bringaterv.cyclistProfile", JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent("bringaterv:settingChanged", { detail: { kind: "cyclistProfile" } }));
    if (getWindResult()) _renderSidebar?.(_store.getState());
  }

  applyToUI();
  [riderEl, bikeEl, posEl].forEach(el => el.addEventListener("change", save));
  window.addEventListener("bringaterv:settingsHydrated", applyToUI);
}

// ── Backup / Restore ──────────────────────────────────────────────────────────
function _initBackupRestore() {
  const downloadBtn = document.querySelector("#settingsBackupDownloadBtn");
  const fileInput   = document.querySelector("#settingsRestoreFile");
  const restoreBtn  = document.querySelector("#settingsRestoreBtn");
  const statusEl    = document.querySelector("#settingsRestoreStatus");
  if (!downloadBtn || !fileInput || !restoreBtn) return;

  downloadBtn.addEventListener("click", async () => {
    downloadBtn.disabled = true;
    const oldHtml = downloadBtn.innerHTML;
    downloadBtn.innerHTML = `<span class="spinner-inline"></span> Backup készítése…`;
    try {
      const { blob, filename } = await routesApi.downloadBackup();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Backup hiba: " + err.message);
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = oldHtml;
    }
  });

  fileInput.addEventListener("change", () => {
    restoreBtn.disabled = !fileInput.files[0];
    statusEl.textContent = "";
  });

  restoreBtn.addEventListener("click", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const mode = document.querySelector('input[name="settingsRestoreMode"]:checked')?.value || "merge";
    const confirmMsg = mode === "replace"
      ? "Biztosan teljesen felülírod a jelenlegi profilodat?\n\nA jelenlegi beállításaid, útvonalaid és edzéseid TÖRLŐDNEK, és a backupbeli adatok kerülnek a helyükre.\n\nEz a művelet visszafordíthatatlan!"
      : "Backup hozzáadása a meglévő tartalom mellé?\n\nAz útvonalak új ID-kkel kerülnek be, a beállításaid változatlanok maradnak.";
    if (!confirm(confirmMsg)) return;

    restoreBtn.disabled = true;
    statusEl.textContent = "Visszaállítás folyamatban…";
    try {
      const result = await routesApi.restoreBackup(file, mode);
      statusEl.textContent = `Kész: ${result.routes_added} útvonal, ${result.workouts_added} edzés${result.settings_restored ? ", beállítások visszaállítva" : ""}.`;
      fileInput.value = "";
      // Settings reload mert a szerver oldali változások a localStorage-ot is érintik
      if (mode === "replace") {
        setTimeout(() => location.reload(), 1500);
      }
    } catch (err) {
      statusEl.textContent = "Hiba: " + err.message;
      restoreBtn.disabled = false;
    }
  });
}
