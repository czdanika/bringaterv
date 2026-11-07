// Karvonen pulzuszóna számítás
// Tisztán logika, semmilyen DOM függőség – bárhol használható

/** Egyenlő 10%-os sávok (egyszerű, szimmetrikus) */
export const ZONE_DEFS = [
  { id: 'Z1', name: 'Z1 Recovery',  sub: 'Regeneráció',    low: 0.50, high: 0.60, color: '#888780',
    hint: 'Regeneráció – nagyon alacsony intenzitás. Aktív pihenés, könnyű pörgetés. Könnyen el lehet beszélgetni.' },
  { id: 'Z2', name: 'Z2 Endurance', sub: 'Alapozó tempó',  low: 0.60, high: 0.70, color: '#1D9E75',
    hint: 'Alapozó tempó – kényelmes, hosszan fenntartható iram. Aerob alap és zsírégetés fejlesztése. A legtöbb hosszú edzés zónája.' },
  { id: 'Z3', name: 'Z3 Tempo',     sub: 'Közepes-kemény', low: 0.70, high: 0.80, color: '#378ADD',
    hint: 'Tempo – az erőfeszítés már érezhető, de tartható. Rövid mondatokban még lehet beszélni. Állóképességet és tempót fejleszt.' },
  { id: 'Z4', name: 'Z4 Threshold', sub: 'Anaerob küszöb', low: 0.80, high: 0.90, color: '#EF9F27',
    hint: 'Anaerob küszöb – kemény, csak 20–60 percig tartható. Versenyiram, laktátküszöb fejlesztése. Beszélgetni már nem lehet.' },
  { id: 'Z5', name: 'Z5 VO2max',    sub: 'Maximális erő',  low: 0.90, high: 1.00, color: '#E24B4A',
    hint: 'VO2max – teljes gáz, csak néhány percig tartható. Maximális oxigénfelvétel és csúcsteljesítmény fejlesztése.' },
];

/**
 * Friel-féle kerékpáros zónamodell (aszimmetrikus, fiziológiailag pontos).
 * Garmin, Strava, TrainingPeaks is ezt alkalmazza.
 * Határok: 65 / 80 / 89 / 97 %
 */
export const ZONE_DEFS_FRIEL = [
  { id: 'Z1', name: 'Z1 Recovery',  sub: 'Regeneráció',    low: 0.50, high: 0.65, color: '#888780',
    hint: 'Regeneráció – nagyon alacsony intenzitás. Aktív pihenés, könnyű pörgetés. Könnyen el lehet beszélgetni.' },
  { id: 'Z2', name: 'Z2 Endurance', sub: 'Alapozó tempó',  low: 0.65, high: 0.80, color: '#1D9E75',
    hint: 'Alapozó tempó – kényelmes, hosszan fenntartható iram. Az aerob alap és zsírégetés fejlesztésének fő zónája.' },
  { id: 'Z3', name: 'Z3 Tempo',     sub: 'Közepes-kemény', low: 0.80, high: 0.89, color: '#378ADD',
    hint: 'Tempo – az erőfeszítés érezhető, de tartható. Az aerob és anaerob rendszer határán. Rövid mondatokban még lehet beszélni.' },
  { id: 'Z4', name: 'Z4 Threshold', sub: 'Anaerob küszöb', low: 0.89, high: 0.97, color: '#EF9F27',
    hint: 'Laktátküszöb – kemény, csak 20–60 percig tartható. Versenyiram, küszöbteljesítmény fejlesztése. Beszélgetni már nem lehet.' },
  { id: 'Z5', name: 'Z5 VO2max',    sub: 'Maximális erő',  low: 0.97, high: 1.00, color: '#E24B4A',
    hint: 'VO2max – teljes gáz, csak néhány percig tartható. Maximális oxigénfelvétel és csúcsteljesítmény fejlesztése.' },
];

/**
 * Joe Friel LTHR-alapú zónamodell (Magene/WKO kompatibilis).
 * Referencia: laktátküszöb pulzus (LTHR) – az a pulzus, amelynél a laktát
 * halmozódni kezd. Határok: 82 / 89 / 94 / 100 % of LTHR.
 */
export const ZONE_DEFS_LTHR = [
  { id: 'Z1', name: 'Z1 Recovery',  sub: 'Regeneráció',    low: 0.50, high: 0.82, color: '#888780',
    hint: 'Regeneráció – a laktátküszöb 82%-a alatt. Aktív pihenés, könnyű pörgetés. Laktát nem halmozódik, a szervezet regenerálódik.' },
  { id: 'Z2', name: 'Z2 Aerobic',   sub: 'Aerob alap',     low: 0.82, high: 0.89, color: '#1D9E75',
    hint: 'Aerob alap – 82–89% of LTHR. Kényelmes, hosszan tartható tempó. Zsíranyagcsere és aerob alap fejlesztése.' },
  { id: 'Z3', name: 'Z3 Tempo',     sub: 'Küszöb alatt',   low: 0.89, high: 0.94, color: '#378ADD',
    hint: 'Tempo – 89–94% of LTHR. Érezhető erőfeszítés, a laktátküszöb közelében. Küszöbközeli teljesítmény fejlesztése.' },
  { id: 'Z4', name: 'Z4 Threshold', sub: 'Laktátküszöb',   low: 0.94, high: 1.00, color: '#EF9F27',
    hint: 'Laktátküszöb – 94–100% of LTHR. Ez az az intenzitás, amelynél a laktát halmozódni kezd. Versenyiram, 20–60 percig tartható.' },
  { id: 'Z5', name: 'Z5 VO2max',    sub: 'Küszöb felett',  low: 1.00, high: 1.06, color: '#E24B4A',
    hint: 'VO2max – 100% of LTHR felett. Laktát gyorsan halmozódik, csak néhány percig tartható. Maximális oxigénfelvétel fejlesztése.' },
];

/**
 * Joe Friel 7 zónás LTHR-modellje (kerékpár): a Z5 három részre bontva – így a
 * küszöb feletti intervallumok (Z5a), a VO2max (Z5b) és az anaerob (Z5c) szétválik.
 * Az OnelapFit / Magene is 7 pulzuszónát mutat. Határok: 81 / 90 / 94 / 100 / 103 / 106 % of LTHR.
 */
export const ZONE_DEFS_LTHR7 = [
  { id: 'Z1',  name: 'Z1 Recovery',   sub: 'Regeneráció',      low: 0.50, high: 0.81, color: '#888780',
    hint: 'Regeneráció – a laktátküszöb 81%-a alatt. Aktív pihenés, könnyű pörgetés.' },
  { id: 'Z2',  name: 'Z2 Aerobic',    sub: 'Aerob alap',       low: 0.81, high: 0.90, color: '#1D9E75',
    hint: 'Aerob alap – 81–89% of LTHR. Kényelmes, hosszan tartható tempó, az alapozás fő zónája.' },
  { id: 'Z3',  name: 'Z3 Tempo',      sub: 'Tempó',            low: 0.90, high: 0.94, color: '#378ADD',
    hint: 'Tempó – 90–93% of LTHR. Érezhető, de tartható erőfeszítés.' },
  { id: 'Z4',  name: 'Z4 Threshold',  sub: 'Küszöb alatt',     low: 0.94, high: 1.00, color: '#EF9F27',
    hint: 'Küszöb alatt – 94–99% of LTHR. Versenyiram, 20–60 percig tartható.' },
  { id: 'Z5a', name: 'Z5a Threshold+', sub: 'Küszöb felett',   low: 1.00, high: 1.03, color: '#E8703A',
    hint: 'Küszöb felett – 100–102% of LTHR. Hosszabb (5–20 perces) kemény intervallumok zónája.' },
  { id: 'Z5b', name: 'Z5b VO2max',    sub: 'Aerob kapacitás',  low: 1.03, high: 1.06, color: '#E24B4A',
    hint: 'Aerob kapacitás (VO2max) – 103–106% of LTHR. 3–8 perces intervallumok, nagyon kemény.' },
  { id: 'Z5c', name: 'Z5c Anaerobic', sub: 'Anaerob',          low: 1.06, high: 1.15, color: '#9B1C4B',
    hint: 'Anaerob – 106% of LTHR felett. Rövid, maximális erőkifejtés; a pulzus itt késve követi a terhelést, ezt a zónát a teljesítmény jobban méri.' },
];

/**
 * LTHR (laktátküszöb pulzus) alapján számolja a pulzuszónákat.
 * Joe Friel / WKO / Magene kompatibilis módszer.
 * @param {number} lthr  - laktátküszöb pulzus
 * @param {number} count - 5 (alap) vagy 7 (Friel: Z5a / Z5b / Z5c)
 */
export function calculateZonesLTHR(lthr, count = 5) {
  return (count === 7 ? ZONE_DEFS_LTHR7 : ZONE_DEFS_LTHR).map(z => ({
    ...z,
    low:     Math.round(lthr * z.low),
    high:    Math.round(lthr * z.high),
    pctLow:  Math.round(z.low  * 100),
    pctHigh: Math.round(z.high * 100),
  }));
}

/**
 * Karvonen (HRR%) alapján számolja az 5 pulzuszónát.
 * @param {number} restHR - nyugalmi pulzus
 * @param {number} maxHR - max pulzus
 * @param {Array} zoneDefs - zónadefiníciók (ZONE_DEFS vagy ZONE_DEFS_FRIEL)
 */
export function calculateZones(restHR, maxHR, zoneDefs = ZONE_DEFS) {
  const hrr = maxHR - restHR;
  return zoneDefs.map(z => ({
    ...z,
    low:     Math.round(restHR + hrr * z.low),
    high:    Math.round(restHR + hrr * z.high),
    pctLow:  Math.round(z.low  * 100),
    pctHigh: Math.round(z.high * 100),
  }));
}

/**
 * Max HR % alapján számolja az 5 pulzuszónát.
 * @param {number} maxHR - max pulzus
 * @param {Array} zoneDefs - zónadefiníciók (ZONE_DEFS vagy ZONE_DEFS_FRIEL)
 */
export function calculateZonesMaxHR(maxHR, zoneDefs = ZONE_DEFS) {
  return zoneDefs.map(z => ({
    ...z,
    low:     Math.round(maxHR * z.low),
    high:    Math.round(maxHR * z.high),
    pctLow:  Math.round(z.low  * 100),
    pctHigh: Math.round(z.high * 100),
  }));
}

/**
 * Egy átlagpulzushoz hozzárendeli, melyik zónába esik.
 */
export function getZoneForHR(avgHR, restHR, maxHR) {
  const zones = calculateZones(restHR, maxHR);
  if (avgHR < zones[0].low) return null;
  for (const z of zones) {
    if (avgHR >= z.low && avgHR <= z.high) return z;
  }
  return zones[zones.length - 1];
}

/**
 * Banister TRIMP számítás.
 * @param {'male'|'female'} sex - nem (súlyozó faktor különböző)
 */
export function calculateTRIMP(durationMin, avgHR, restHR, maxHR, sex = 'male') {
  const ratio = (avgHR - restHR) / (maxHR - restHR);
  const k = sex === 'female' ? 1.67 : 1.92;
  const a = sex === 'female' ? 0.86 : 0.64;
  const weight = a * Math.exp(k * ratio);
  return Math.round(durationMin * ratio * weight);
}

/** Pulzustartalék (HRR) */
export function getHRR(restHR, maxHR) {
  return maxHR - restHR;
}

/**
 * Egyedi BPM határok alapján számolja az 5 zónát.
 * @param {number[]} boundaries - 4 BPM határ: [b1, b2, b3, b4]
 *   Z1: 0..b1, Z2: b1..b2, Z3: b2..b3, Z4: b3..b4, Z5: b4..999
 */
export function calculateZonesCustom(boundaries) {
  const [b1, b2, b3, b4] = boundaries;
  const templates = ZONE_DEFS_FRIEL;
  return templates.map((z, i) => ({
    ...z,
    low:     i === 0 ? 0        : boundaries[i - 1],
    high:    i < 4  ? boundaries[i] : 999,
    pctLow:  null,
    pctHigh: null,
  }));
}
