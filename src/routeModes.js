// ── Tervezési módok és tevékenységek ─────────────────────────────────────────
// Kerékpár: Aszfalt / Gravel / MTB; Gyalog: Séta / Túra. Egy útvonalon belül a szakaszok
// módja csak a saját tevékenységén belül változhat (bringás úton nincs gyalogos szakasz).
// A „walking” kulcs v1.29.0 előtt a felületen „Túra” volt – a régi adatot a main.js alakítja át.

export const ACTIVITY_MODES = { bike: ["asphalt", "gravel", "mtb"], foot: ["walking", "hiking"] };
export const ACTIVITY_LABELS = { bike: "Kerékpár", foot: "Gyalog" };
export const MODE_NAMES = { asphalt: "Aszfalt", gravel: "Gravel", mtb: "MTB", walking: "Séta", hiking: "Túra" };

export const activityOf = (mode) => (mode === "walking" || mode === "hiking" ? "foot" : "bike");
/** Az adott mód tevékenységének módjai (szakaszmód-választóhoz). */
export const modesFor = (mode) => ACTIVITY_MODES[activityOf(mode)];

/** Burkolat-osztály (aszfalt / gravel / földút / ösvény) → szakaszmód a tevékenységen belül. */
export function segmentModeForSurface(surf, mode) {
  if (activityOf(mode) === "foot") return surf === "mtb" || surf === "hiking" ? "hiking" : "walking";
  return surf === "hiking" ? "mtb" : surf;
}

/** A pontok szakaszmódja a tevékenység módjai közül (régi / idegen adatnál átalakítva). */
export function fitSegmentModes(waypoints, mode) {
  const own = modesFor(mode);
  return waypoints.map((w) => (w.segmentMode == null || own.includes(w.segmentMode)
    ? w : { ...w, segmentMode: segmentModeForSurface(w.segmentMode === "walking" ? "asphalt" : w.segmentMode, mode) }));
}

/** Túrabakancs ikon (a Lucide-ban nincs ilyen) – a Séta a „footprints” ikont használja. */
export const hikingBootSvg = (size = 14) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}" aria-hidden="true"><path d="M6 3h5v5.5l4.6 1.9C18.5 11.6 20 13 20 15v2H4V5a2 2 0 0 1 2-2z"/><path d="M3 17h18v1.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5z"/><path d="M8.5 6H11"/><path d="M8.5 8.5H11"/></svg>`;
