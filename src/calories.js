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

// ── Pulzus alapú kalória (Keytel 2005) és teljesítményből számolt kalória ─────
//
// Keytel et al. (2005), J Sports Sci 23(3): VO2max nélküli képlet, kJ/perc → kcal/perc:
//   férfi: (−55,0969 + 0,6309·HR + 0,1988·kg + 0,2017·életkor) / 4,184
//   nő:    (−20,4022 + 0,4472·HR − 0,1263·kg + 0,074·életkor) / 4,184
// A pulzusban lineáris, ezért az időre súlyozott átlagpulzus × idő ugyanazt adja, mint a
// pontonkénti összeg. Általános képlet: edzett embernél gyakran 10–30%-kal eltér.
//
// Teljesítményből: a pedálon leadott munka (kJ) ≈ elégetett kcal – a ~24%-os hatásfok és a
// 4,184-es átváltás szinte kioltja egymást (kJ / (4,184 · 0,24) ≈ 1,0 · kJ). Wattmérővel ez a
// legpontosabb becslés, ezért ebből kalibráljuk a pulzus alapút (személyes szorzó).

export function keytelKcal({ avgHr, minutes, kg, age, sex }) {
  if (!(avgHr > 50) || !(minutes > 0) || !(kg > 30) || !(age > 10)) return null;
  const perMin = sex === "female"
    ? (-20.4022 + 0.4472 * avgHr - 0.1263 * kg + 0.074 * age) / 4.184
    : (-55.0969 + 0.6309 * avgHr + 0.1988 * kg + 0.2017 * age) / 4.184;
  return perMin > 0 ? Math.round(perMin * minutes) : null;
}

export const powerKcal = (kj) => (kj > 0 ? Math.round(kj / (4.184 * 0.24)) : null);

/** Időre súlyozott átlagpulzus és a pulzussal mért idő (perc) a geometriából
 *  (a 10 mp-nél hosszabb kihagyás – megállás, jelvesztés – 10 mp-nek számít). */
export function hrTimeStats(geometry) {
  let sum = 0, sec = 0, prev = null;
  for (const p of geometry || []) {
    if (p.hr == null || p.time == null) { prev = null; continue; }
    if (prev) {
      const dt = Math.min((p.time - prev.time) / 1000, 10);
      if (dt > 0) { sum += p.hr * dt; sec += dt; }
    }
    prev = p;
  }
  return sec > 60 ? { avgHr: sum / sec, minutes: sec / 60 } : null;
}

// Kalibráció: a wattmérős (pulzussal is mért) edzéseidből a teljesítmény / Keytel arány mediánja
let _getWorkouts = () => [];
export function setCalorieWorkouts(fn) { _getWorkouts = fn || _getWorkouts; }

export function keytelCalibration(person) {
  const ratios = [];
  for (const w of _getWorkouts() || []) {
    if (w.device_watts === false) continue;          // a Strava wattmérő nélkül becsült teljesítménye – nem mérés
    const min = Number(w.duration);
    const kj = Number(w.kilojoules) || (Number(w.avg_watts) > 0 && min > 0 ? w.avg_watts * min * 60 / 1000 : 0);
    if (!(kj > 0) || !(w.avg_heartrate > 0) || !(min > 10)) continue;
    const k = keytelKcal({ ...person, avgHr: Number(w.avg_heartrate), minutes: min });
    const p = powerKcal(kj);
    if (k && p) ratios.push(p / k);
  }
  if (ratios.length < 3) return { factor: 1, n: ratios.length, calibrated: false };
  ratios.sort((a, b) => a - b);
  const med = ratios[Math.floor(ratios.length / 2)];
  return { factor: Math.min(1.4, Math.max(0.6, med)), n: ratios.length, calibrated: true };
}

/** Az életkor, nem, testsúly a beállításokból (a hívó adja át, hogy ne legyen körkörös import). */
export function personFrom(hrSettings, profile) {
  return { kg: Number(profile?.riderKg) || 75, age: hrSettings?.age, sex: hrSettings?.sex };
}

const isCyclingEntry = (e) => /cycl|ride|bike/.test(String(e?.sport_type || "cycling").toLowerCase());

/**
 * Egy könyvtári edzés kalóriája – ugyanabban a sorrendben, mint az Elemzés kártyája:
 * az eszköz / szolgáltatás értéke → mért teljesítmény (kJ) → pulzus (Keytel, kalibrálva) →
 * becslés (csak kerékpárra: sebesség, szint, testsúly). { kcal, src } vagy null.
 */
export function workoutKcal(e, person, calib = keytelCalibration(person), profile = null) {
  if (!e) return null;
  if (Number(e.calories) > 0) return { kcal: Number(e.calories), src: "device" };
  const min = Number(e.duration) || 0;
  if (e.device_watts !== false) {
    const kj = Number(e.kilojoules) || (Number(e.avg_watts) > 0 && min > 0 ? e.avg_watts * min * 60 / 1000 : 0);
    if (kj > 0) return { kcal: powerKcal(kj), src: "power" };
  }
  if (Number(e.avg_heartrate) > 0 && min > 0) {
    const k = keytelKcal({ ...person, avgHr: Number(e.avg_heartrate), minutes: min });
    if (k) return { kcal: Math.round(k * (calib?.factor || 1)), src: "hr" };
  }
  if (isCyclingEntry(e) && Number(e.distance) > 0 && min > 0) {
    const k = estimateKcal(Number(e.distance), min / 60, Number(e.elevation) || 0, profile || { riderKg: person.kg }).kcal;
    if (k > 0) return { kcal: k, src: "met" };
  }
  return null;
}

/** Összeg + forrásonkénti darabszám edzések listájára. */
export function sumKcal(entries, person, profile) {
  const calib = keytelCalibration(person);
  const by = { device: 0, power: 0, hr: 0, met: 0 };
  let kcal = 0;
  for (const e of entries || []) {
    const r = workoutKcal(e, person, calib, profile);
    if (r) { kcal += r.kcal; by[r.src]++; }
  }
  return { kcal, by };
}
