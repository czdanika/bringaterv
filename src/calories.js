/**
 * Kalóriaszámítás kerékpározásra.
 *
 * Két komponensből áll a teljes kcal:
 *   1) Sík ellenállás (MET-alapú): MET(sebesség) × testsúly × idő
 *      A MET-érték empirikus táblázatból jön (Compendium of Physical
 *      Activities), és átlagsebességtől függ. A bike súlyát NEM tartalmazza
 *      külön – a MET-tábla már egy "tipikus" kerékpáros összes work-ját
 *      reprezentálja (gyorsítások, megállók, döccenések, pozíciók).
 *
 *   2) Emelkedéses pluszmunka: m_total × g × Δh / (η × 4184)
 *      Az emelkedéssel végzett gravitációs munka külön energiát igényel.
 *      Itt a bike súlya IS számít, és 25% biológiai hatékonyságot
 *      veszünk fel (η).
 *
 * A Strava és más mainstream app is ezzel kompatibilis becslést ad. Pl.
 * 11.3 km / 1h05 / 42m em. / 18 km/h: 584 kcal (Strava: 561 kcal).
 */

const G        = 9.81;
const KCAL_PER_J     = 1 / 4184;
const EFFICIENCY     = 0.25;     // ~25% biológiai hatékonyság kerékpározásnál

/**
 * MET-tábla átlagsebesség szerint (km/h).
 * Forrás: Compendium of Physical Activities (Ainsworth et al.).
 */
const MET_TABLE = [
  { maxKmh: 16.1,     met: 4.0 },   // < 10 mph (lazán)
  { maxKmh: 19.2,     met: 5.8 },   // 10-12 mph (normál, könnyű erőfeszítés)
  { maxKmh: 22.4,     met: 6.8 },   // 12-14 mph (közepes erőfeszítés)
  { maxKmh: 25.6,     met: 8.0 },   // 14-16 mph (sporttempó, energikus)
  { maxKmh: 32.2,     met: 10.0 },  // 16-20 mph (gyors / verseny)
  { maxKmh: 40.2,     met: 12.0 },  // 20-25 mph (lassú verseny)
  { maxKmh: Infinity, met: 15.8 },  // > 25 mph (gyors verseny)
];

/**
 * MET-érték az átlagsebességhez.
 */
export function metForSpeed(avgKmh) {
  return MET_TABLE.find(r => avgKmh < r.maxKmh)?.met ?? 4.0;
}

/**
 * Kalória becslés.
 *
 * @param {number}      distanceKm
 * @param {number}      durationHours   – ezzel szorozzuk a MET értéket (Strava is így csinálja: teljes idő, akkor is ha vannak megállók)
 * @param {number}      ascentM         – m, csak az emelkedő (pozitív)
 * @param {object}      profile         – { riderKg, bikeKg }
 * @param {number|null} avgKmhOverride  – ha meg van adva, ezt használjuk MET kiválasztásra (pl. analízis fülön a mozgási avg sebesség). Ha null, az alap dist/dur.
 * @returns {{ kcal: number, met: number, flatKcal: number, climbKcal: number }}
 */
export function estimateKcal(distanceKm, durationHours, ascentM, profile = {}, avgKmhOverride = null) {
  const riderKg = profile.riderKg ?? 75;
  const bikeKg  = profile.bikeKg  ?? 10;
  if (durationHours <= 0 || distanceKm <= 0) {
    return { kcal: 0, met: 0, flatKcal: 0, climbKcal: 0 };
  }
  const avgKmh   = avgKmhOverride ?? (distanceKm / durationHours);
  const met      = metForSpeed(avgKmh);
  const flatKcal = met * riderKg * durationHours;
  // Emelkedéses munka: m·g·Δh joule → kcal, osztva η-val a biológiai veszteség miatt
  const climbKcal = Math.max(0, ascentM) > 0
    ? ((riderKg + bikeKg) * G * Math.max(0, ascentM)) * KCAL_PER_J / EFFICIENCY
    : 0;
  return {
    kcal:      Math.round(flatKcal + climbKcal),
    met,
    flatKcal:  Math.round(flatKcal),
    climbKcal: Math.round(climbKcal),
  };
}

/**
 * MET-zóna emberi szöveg (hint tooltiphez).
 */
export function metZoneLabel(met) {
  if (met <= 4)    return "lazán (< 16 km/h)";
  if (met <= 5.8)  return "normál tempó (16-19 km/h)";
  if (met <= 6.8)  return "közepes erőfeszítés (19-22 km/h)";
  if (met <= 8)    return "sporttempó (22-25 km/h)";
  if (met <= 10)   return "gyors (25-32 km/h)";
  if (met <= 12)   return "lassú verseny (32-40 km/h)";
  return "gyors verseny (> 40 km/h)";
}
