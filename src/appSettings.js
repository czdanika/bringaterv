// ── Persistent app settings ───────────────────────────────
// Stored in localStorage. Extend defaults to add new settings.

const SETTINGS_KEY = "bringaterv_settings";

export const defaults = {
  mapStyle: "standard",
  startView: null, // { lat, lng, zoom, label }
  snapToRoads: true,
  showStageInfo: true,
  gpxSampleWaypoints: false,
};

export function getSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    return saved ? { ...defaults, ...JSON.parse(saved) } : { ...defaults };
  } catch {
    return { ...defaults };
  }
}

export function saveSetting(key, value) {
  const current = getSettings();
  current[key] = value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(current));
}

export function resetSettings() {
  localStorage.removeItem(SETTINGS_KEY);
}
