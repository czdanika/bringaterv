/**
 * Bringaterv – Planning / Sidebar Module
 * =======================================
 * Waypoint list rendering, route mode switching, segment picker,
 * speed sliders, navigation toggle, and related utilities.
 *
 * Init:
 *   import { initPlanning } from './ui/planning.js';
 *   initPlanning({ store, mapAdapter, elements, i18n, showToast,
 *                  getCyclistProfile, calcEstimatedTimeMixed, getSpeedSettings,
 *                  getElevationTimeEnabled, applyRouteLayer,
 *                  SEGMENT_LABELS, ROUTE_MODE_META, GRAVEL_PICKER_SVG });
 */

import { SEGMENT_COLORS } from '../map/mapAdapter.js';
import { getWindResult, clearWindResult, scheduleWindRunIfActive, initWindPlanInputsIfNeeded } from './wind.js';
import { defaultAvgSpeed, windTimeMultiplier } from '../wind/windService.js';
import { formatDistance } from './dom.js';

// ── Injected deps ─────────────────────────────────────────────────────────────
let _store, _mapAdapter, _elements, _i18n, _showToast;
let _getCyclistProfile, _calcEstimatedTimeMixed, _getSpeedSettings;
let _elevationTimeEnabled, _applyRouteLayer;
let _SEGMENT_LABELS, _ROUTE_MODE_META, _GRAVEL_PICKER_SVG;

export function initPlanning({ store, mapAdapter, elements, i18n, showToast,
    getCyclistProfile, calcEstimatedTimeMixed, getSpeedSettings,
    getElevationTimeEnabled, applyRouteLayer,
    SEGMENT_LABELS, ROUTE_MODE_META, GRAVEL_PICKER_SVG }) {
  _store = store;
  _mapAdapter = mapAdapter;
  _elements = elements;
  _i18n = i18n;
  _showToast = showToast;
  _getCyclistProfile = getCyclistProfile;
  _calcEstimatedTimeMixed = calcEstimatedTimeMixed;
  _getSpeedSettings = getSpeedSettings;
  _elevationTimeEnabled = getElevationTimeEnabled;
  _applyRouteLayer = applyRouteLayer;
  _SEGMENT_LABELS = SEGMENT_LABELS;
  _ROUTE_MODE_META = ROUTE_MODE_META;
  _GRAVEL_PICKER_SVG = GRAVEL_PICKER_SVG;

  setupNavigation();
  initSpeedSliders();

  // segment picker auto-close
  document.addEventListener("click", (e) => {
    if (!_segmentPickerEl || _segmentPickerEl.hidden) return;
    if (!_segmentPickerEl.contains(e.target)) closeSegmentPicker();
  });
}

// ── Module state ──────────────────────────────────────────────────────────────
let selectedWaypointId = null;
let activeSegmentPickerId = null;
let _segmentPickerEl = null;

export function getSelectedWaypointId() { return selectedWaypointId; }
export function setSelectedWaypointId(id) { selectedWaypointId = id; }

// ── Waypoint közbeszúrás: geometria-index alapján meghatározza a helyes pozíciót ──
export function findWaypointInsertIndex(waypoints, geometry, clickGeomIdx) {
  if (!geometry || geometry.length === 0) return waypoints.length;

  const N = geometry.length;
  const numWp = waypoints.length;
  if (numWp < 2) return numWp;

  // Forward-search: minden waypointot az előző után keresünk a geometriában.
  // Ez loop-útvonalaknál is helyes indexet ad (Start≈End esetén End → geometry vége).
  const wpGeomIndices = [];
  let searchFrom = 0;

  for (let i = 0; i < numWp; i++) {
    const wp = waypoints[i];
    const isLast = i === numWp - 1;

    // Loop detektálás: ha az utolsó waypoint nagyon közel van az elsőhöz,
    // a geometria végéhez rendeljük (ne az elejéhez)
    if (isLast && wpGeomIndices.length > 0) {
      const dToFirst = Math.hypot(wp.lat - waypoints[0].lat, wp.lng - waypoints[0].lng);
      if (dToFirst < 0.002) { // ~200m – loop esetén Start≈End
        wpGeomIndices.push(N - 1);
        continue;
      }
    }

    let minD = Infinity;
    let idx = searchFrom;
    for (let j = searchFrom; j < N; j++) {
      const d = Math.hypot(geometry[j].lat - wp.lat, geometry[j].lng - wp.lng);
      if (d < minD) { minD = d; idx = j; }
    }
    wpGeomIndices.push(idx);
    searchFrom = Math.min(idx + 1, N - 1);
  }

  // Az utolsó waypoint amelynek geom-indexe <= clickGeomIdx után szúrjuk be
  let insertAfter = 0;
  for (let i = 0; i < wpGeomIndices.length; i++) {
    if (wpGeomIndices[i] <= clickGeomIdx) insertAfter = i;
  }
  return insertAfter + 1;
}

// ── Navigation toggle ─────────────────────────────────────────────────────────
export function setupNavigation() {
  const shouldCollapse = localStorage.getItem("route4meNavCollapsed") === "true";
  _elements.appShell.classList.toggle("is-nav-collapsed", shouldCollapse);
  updateNavToggle();

  const toggleNav = () => {
    const nextCollapsed = !_elements.appShell.classList.contains("is-nav-collapsed");
    _elements.appShell.classList.toggle("is-nav-collapsed", nextCollapsed);
    localStorage.setItem("route4meNavCollapsed", String(nextCollapsed));
    updateNavToggle();
    setTimeout(() => _mapAdapter.invalidateSize(), 210);
  };

  _elements.navToggle.addEventListener("click", toggleNav);
  document.getElementById("railNavToggle")?.addEventListener("click", toggleNav);
}

export function updateNavToggle() {
  const isCollapsed = _elements.appShell.classList.contains("is-nav-collapsed");
  const label = _i18n.t(isCollapsed ? "nav.expand" : "nav.collapse");
  const icon  = isCollapsed ? "panel-left-open" : "panel-left-close";
  const railBtn = document.getElementById("railNavToggle");
  for (const btn of [_elements.navToggle, railBtn]) {
    if (!btn) continue;
    btn.title = label;
    btn.ariaLabel = label;
    btn.setAttribute("aria-expanded", String(!isCollapsed));
    btn.innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i>`;
  }
  window.lucide?.createIcons();
}

// ── Route mode ────────────────────────────────────────────────────────────────
export function setRouteMode(mode, { persistDefault }) {
  syncRouteModeButtons(mode);
  _store.setState({ mode });
  if (persistDefault) {
    localStorage.setItem("route4meDefaultRouteMode", mode);
  }
}

export function syncRouteModeButtons(mode) {
  // popup elemek active állapota
  _elements.routeModeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.routeMode === mode);
  });
  // picker gomb ikon + felirat frissítése
  const meta = _ROUTE_MODE_META[mode] ?? _ROUTE_MODE_META.asphalt;
  const iconHtml = meta.lucide
    ? `<i data-lucide="${meta.lucide}" aria-hidden="true"></i>`
    : _GRAVEL_PICKER_SVG;
  if (_elements.routeModePicker) {
    _elements.routeModePicker.innerHTML =
      `${iconHtml}<span>${meta.label}</span><i data-lucide="chevron-down" class="sidebar-style-chevron" aria-hidden="true"></i>`;
    window.lucide?.createIcons({ nodes: [_elements.routeModePicker] });
  }
  // toolbar gomb: ikon + title frissítés
  if (_elements.mapRouteModePicker) {
    const toolbarIcon = meta.lucide
      ? `<i data-lucide="${meta.lucide}" aria-hidden="true"></i>`
      : _GRAVEL_PICKER_SVG;
    _elements.mapRouteModePicker.innerHTML = toolbarIcon;
    _elements.mapRouteModePicker.title = `Tervezési mód: ${meta.label}`;
    window.lucide?.createIcons({ nodes: [_elements.mapRouteModePicker] });
  }
}

// ── Szegmens-profil picker ─────────────────────────────────────────────────────
export function getSegmentPicker() {
  if (!_segmentPickerEl) {
    _segmentPickerEl = document.createElement("div");
    _segmentPickerEl.className = "segment-picker";
    _segmentPickerEl.hidden = true;
    document.body.appendChild(_segmentPickerEl);
  }
  return _segmentPickerEl;
}

export function openSegmentPicker(waypointId, currentMode, anchorEl) {
  const picker = getSegmentPicker();
  activeSegmentPickerId = waypointId;

  picker.innerHTML = Object.keys(SEGMENT_COLORS)
    .map((m) => {
      const isActive = m === currentMode;
      return `<button class="seg-picker-btn${isActive ? " is-active" : ""}" data-mode="${m}" data-id="${waypointId}">
        <span class="seg-dot" style="background:${SEGMENT_COLORS[m]}"></span>
        <span>${_SEGMENT_LABELS[m] ?? m}</span>
      </button>`;
    })
    .join("");

  picker.querySelectorAll(".seg-picker-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const newMode = btn.dataset.mode;
      const id = btn.dataset.id;
      _store.updateWaypoint(id, { segmentMode: newMode });
      closeSegmentPicker();
    });
  });

  // Pozícionálás az anchor elem alá
  const rect = anchorEl.getBoundingClientRect();
  picker.hidden = false;
  picker.style.top  = `${rect.bottom + 4}px`;
  picker.style.left = `${rect.left}px`;
}

export function closeSegmentPicker() {
  if (_segmentPickerEl) _segmentPickerEl.hidden = true;
  activeSegmentPickerId = null;
}

/**
 * Szakaszonkénti távolságot számol minden szomszédos waypoint pár között,
 * a tényleges route geometria alapján (haversine összegezve).
 * Visszaad: tömb, hossza = waypoints.length - 1.
 */
export function computeWaypointSegmentDistances(state) {
  const wps  = state.waypoints || [];
  const geom = state.routeGeometry || [];
  const N    = wps.length;
  if (N < 2) return [];

  // Ha van per-segment routing eredmény (mixed mode), abból olvassuk
  if (state.routeSegments?.length === N - 1 && state.routeSegments[0]?.distanceMeters != null) {
    return state.routeSegments.map(s => s.distanceMeters);
  }

  // Egyébként: minden waypointhoz megkeressük a legközelebbi geometria-indexet (monoton),
  // és a köztük lévő haversine távolságot összegezzük.
  if (geom.length < 2) {
    // Nincs geometria → légvonal becsült távolság
    return wps.slice(1).map((b, i) => haversineMeters(wps[i], b));
  }

  // Kumulatív távolság a geometrián
  const cumDist = new Array(geom.length).fill(0);
  for (let i = 1; i < geom.length; i++) {
    cumDist[i] = cumDist[i - 1] + haversineMeters(geom[i - 1], geom[i]);
  }

  // Minden waypointhoz a legközelebbi geometria-index (kereső pointerrel, monoton)
  const wpIdx = new Array(N);
  let searchFrom = 0;
  for (let w = 0; w < N; w++) {
    const wp = wps[w];
    let bestI = searchFrom, bestD = Infinity;
    for (let i = searchFrom; i < geom.length; i++) {
      const d = haversineMeters(wp, geom[i]);
      if (d < bestD) { bestD = d; bestI = i; }
      // Optimalizáció: ha már messzebb vagyunk és a távolság elkezd nőni, megállhatunk.
      // Egyelőre lineáris végigjárás – elég gyors (geom max ~2000 pont).
    }
    wpIdx[w] = bestI;
    searchFrom = bestI;  // monoton: a következő waypoint nem lehet előbb
  }

  const result = [];
  for (let w = 1; w < N; w++) {
    result.push(Math.max(0, cumDist[wpIdx[w]] - cumDist[wpIdx[w - 1]]));
  }
  return result;
}

export function haversineMeters(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// ── Sidebar rendering ─────────────────────────────────────────────────────────
export function renderSidebar(state) {
  _elements.waypointList.innerHTML = "";
  _elements.emptyState.hidden = state.waypoints.length > 0;

  const hasDistance = state.distanceMeters > 0;

  _elements.distanceValue.textContent = state.distanceMeters > 0 ? formatDisplayDistance(state.distanceMeters) : "—";
  if (_elements.pointCount) _elements.pointCount.textContent = String(state.waypoints.length);
  const hasElevation = state.ascentMeters > 0 || state.descentMeters > 0;
  _elements.ascentRow.hidden = !hasElevation;
  _elements.descentRow.hidden = !hasElevation;
  if (hasElevation) {
    _elements.ascentValue.textContent = `${state.ascentMeters} m`;
    _elements.descentValue.textContent = `${state.descentMeters} m`;
  }

  // Becsült idő – csak ha van távolság
  if (_elements.estimatedTimeRow) {
    _elements.estimatedTimeRow.hidden = !hasDistance;
    if (hasDistance) {
      const distKm = Math.round(state.distanceMeters / 100) / 10;
      const ascM   = _elevationTimeEnabled() ? (state.ascentMeters  > 0 ? state.ascentMeters  : 0) : 0;
      const descM  = _elevationTimeEnabled() ? (state.descentMeters > 0 ? state.descentMeters : 0) : 0;
      let mins     = _calcEstimatedTimeMixed(
        state.routeSegments, state.mode ?? 'asphalt',
        distKm, ascM, descM, _elevationTimeEnabled()
      );
      // Szélhatás: ha be van kapcsolva és van eredmény, alkalmazzuk a szorzót
      const windToggle = document.querySelector('#planWindTimeToggle');
      if (windToggle?.checked && getWindResult()) {
        const planned = parseFloat(_elements.windAvgSpeedPlan?.value) || defaultAvgSpeed(state.mode);
        const profile = { ..._getCyclistProfile(), routeMode: state.mode ?? "asphalt" };
        const mul = windTimeMultiplier(getWindResult().segments, planned, profile);
        mins = Math.round(mins * mul);
      }
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      _elements.estimatedTimeValue.textContent = h > 0
        ? `${h} ó ${m > 0 ? m + ' p' : ''}`
        : `${m} p`;
    }
  }


  // Szakasz-távolságok kiszámítása: vagy per-segment (mixed mode) vagy a geometriából
  const wpSegDistances = computeWaypointSegmentDistances(state);

  let dragSrcIndex = null;

  state.waypoints.forEach((point, index) => {
    // Szakaszhossz az előző waypointtól (a 0. előtt nincs)
    if (index > 0 && wpSegDistances[index - 1] > 0) {
      const segDist = wpSegDistances[index - 1];
      const distLabel = document.createElement("li");
      distLabel.className = "waypoint-segment-label";
      distLabel.innerHTML = `<span class="waypoint-segment-arrow">↓</span><span class="waypoint-segment-dist">${formatDisplayDistance(segDist)}</span>`;
      _elements.waypointList.append(distLabel);
    }

    const isSelected = point.id === selectedWaypointId;
    const item = document.createElement("li");
    item.className = "waypoint" + (isSelected ? " is-selected" : "");
    item.draggable = true;
    item.dataset.index = String(index);

    item.addEventListener("dragstart", (e) => {
      dragSrcIndex = index;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
      setTimeout(() => item.classList.add("is-dragging"), 0);
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("is-dragging");
      dragSrcIndex = null;
    });
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      item.classList.add("drag-over");
    });
    item.addEventListener("dragleave", (e) => {
      if (!item.contains(e.relatedTarget)) item.classList.remove("drag-over");
    });
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove("drag-over");
      const from = Number(e.dataTransfer.getData("text/plain"));
      if (!Number.isNaN(from) && from !== index) {
        _store.reorderWaypoints(from, index);
      }
      dragSrcIndex = null;
    });

    const handle = document.createElement("span");
    handle.className = "waypoint-handle";
    handle.innerHTML = `<i data-lucide="grip-vertical" aria-hidden="true"></i>`;
    handle.title = "Húzd a sorrend módosításához";

    const badge = document.createElement("span");
    badge.className = "waypoint-index";
    badge.textContent = String(index + 1);

    const label = document.createElement("span");
    label.className = "waypoint-label";
    label.textContent = point.name || _i18n.t("route.point", { number: index + 1 });
    label.addEventListener("click", () => {
      selectedWaypointId = isSelected ? null : point.id;
      renderSidebar(_store.getState());
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini-button";
    remove.innerHTML = `<i data-lucide="x" aria-hidden="true"></i>`;
    remove.title = _i18n.t("actions.remove");
    remove.ariaLabel = _i18n.t("actions.remove");
    remove.addEventListener("click", () => {
      if (selectedWaypointId === point.id) selectedWaypointId = null;
      _store.removeWaypoint(point.id);
    });

    const labelWrap = document.createElement("div");
    labelWrap.className = "waypoint-label-wrap";
    labelWrap.append(label);
    if (point.note) {
      const note = document.createElement("span");
      note.className = "waypoint-note";
      note.textContent = point.note;
      labelWrap.append(note);
    }

    // Szegmens-profil badge – csak az utolsó kivételével minden waypointnál
    const isLastWaypoint = index === state.waypoints.length - 1;
    if (!isLastWaypoint && state.waypoints.length >= 2) {
      const isExplicit = point.segmentMode != null;
      const segMode = point.segmentMode ?? state.mode ?? "asphalt";

      // Wrapper: badge gomb + opcionális × gomb
      const segWrap = document.createElement("span");
      segWrap.className = "segment-badge-wrap";

      const segBadge = document.createElement("button");
      segBadge.type = "button";
      segBadge.className = `segment-mode-badge${isExplicit ? " is-explicit" : " is-inherited"}`;
      segBadge.title = `Szakasz módja: ${_SEGMENT_LABELS[segMode] ?? segMode} – kattints a módosításhoz`;
      segBadge.innerHTML = `<span class="seg-dot" style="background:${SEGMENT_COLORS[segMode] ?? "#1976d2"}"></span>`;
      segBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        if (activeSegmentPickerId === point.id) {
          closeSegmentPicker();
        } else {
          openSegmentPicker(point.id, segMode, segBadge);
        }
      });
      segWrap.append(segBadge);

      if (isExplicit) {
        const resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.className = "seg-reset-btn";
        resetBtn.title = "Visszaállítás alapértelmezésre";
        resetBtn.innerHTML = `<i data-lucide="x" aria-hidden="true"></i>`;
        resetBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          _store.updateWaypoint(point.id, { segmentMode: null });
        });
        segWrap.append(resetBtn);
      }

      item.classList.add("has-seg-badge");
      item.append(handle, badge, labelWrap, segWrap, remove);
    } else {
      item.append(handle, badge, labelWrap, remove);
    }

    if (isSelected) {
      const options = document.createElement("div");
      options.className = "waypoint-options";

      const setDest = document.createElement("button");
      setDest.type = "button";
      setDest.className = "waypoint-option-btn";
      setDest.textContent = _i18n.t("waypoint.setDestination");
      setDest.addEventListener("click", () => {
        const s = _store.getState();
        if (s.waypoints.length > 1 && index !== s.waypoints.length - 1) {
          _store.reorderWaypoints(index, s.waypoints.length - 1);
        }
        selectedWaypointId = null;
      });

      const focus = document.createElement("button");
      focus.type = "button";
      focus.className = "waypoint-option-btn";
      focus.textContent = _i18n.t("waypoint.focusMap");
      focus.addEventListener("click", () => {
        _mapAdapter.focusWaypoint(point.lat, point.lng);
        selectedWaypointId = null;
        renderSidebar(_store.getState());
      });

      options.append(setDest, focus);
      item.append(options);
    }

    _elements.waypointList.append(item);
  });

  window.lucide?.createIcons();
}

// ── Distance formatting ───────────────────────────────────────────────────────
export function formatDisplayDistance(meters) {
  const units = localStorage.getItem("route4meUnits") || "metric";
  if (units === "imperial") {
    const miles = meters / 1609.344;
    if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
    return `${miles.toFixed(1)} mi`;
  }
  return formatDistance(meters);
}

export function calculateImportedDistance(geometry) {
  return geometry.slice(1).reduce((total, point, index) => {
    const previous = geometry[index];
    const earthRadius = 6371000;
    const dLat = ((point.lat - previous.lat) * Math.PI) / 180;
    const dLng = ((point.lng - previous.lng) * Math.PI) / 180;
    const lat1 = (previous.lat * Math.PI) / 180;
    const lat2 = (point.lat * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return total + earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }, 0);
}

// ── Speed sliders (settings panel) ───────────────────────────────────────────
export function initSpeedSliders() {
  const speeds = _getSpeedSettings();
  const LS_SPEED_PREFIX = 'bringaterv-speed-';
  const DEFAULT_SPEEDS = { asphalt: 22, gravel: 18, mtb: 12, hiking: 5 };
  const sliderMap = {
    asphalt: { sliderId: 'speedAsphalt', valId: 'speedAsphaltVal' },
    gravel:  { sliderId: 'speedGravel',  valId: 'speedGravelVal'  },
    mtb:     { sliderId: 'speedMtb',     valId: 'speedMtbVal'     },
    hiking:  { sliderId: 'speedHiking',  valId: 'speedHikingVal'  },
  };
  for (const [mode, { sliderId, valId }] of Object.entries(sliderMap)) {
    const slider = document.querySelector(`#${sliderId}`);
    const valEl  = document.querySelector(`#${valId}`);
    if (!slider) continue;
    slider.value = speeds[mode];
    if (valEl) valEl.textContent = speeds[mode];
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      if (valEl) valEl.textContent = v;
      localStorage.setItem(LS_SPEED_PREFIX + mode, String(v));
      renderSidebar(_store.getState());
    });
  }

  document.querySelector('#resetSpeedDefaults')?.addEventListener('click', () => {
    for (const [mode, def] of Object.entries(DEFAULT_SPEEDS)) {
      localStorage.removeItem(LS_SPEED_PREFIX + mode);
      const { sliderId, valId } = sliderMap[mode];
      const slider = document.querySelector(`#${sliderId}`);
      const valEl  = document.querySelector(`#${valId}`);
      if (slider) slider.value = def;
      if (valEl)  valEl.textContent = def;
    }
    renderSidebar(_store.getState());
  });

  // Settings toggle = elmentett alapértelmezett; plan tab toggle = munkamenet (elevationTimeEnabled)
  const elevationTimeDefault = () => localStorage.getItem('bringaterv-elevation-default') !== 'false';
  const settingsToggle = document.querySelector('#elevationTimeToggle');
  const planToggle     = document.querySelector('#planElevTimeToggle');
  if (settingsToggle) settingsToggle.checked = elevationTimeDefault();
  if (planToggle)     planToggle.checked     = _elevationTimeEnabled();
}
