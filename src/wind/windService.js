/**
 * Szélelemzés modul – Open-Meteo API alapján kiszámolja az útvonal mentén
 * a szembeszél / oldalszél / hátszél komponenseket és időjárás adatokat.
 *
 * Független implementáció: a wind-ahead (AGPL) projekttel azonos célt
 * szolgál, de saját algoritmussal és kóddal, az Open-Meteo nyilvános
 * dokumentációja alapján.
 *
 * Bemenet: GPX geometry, indulási idő, átlagsebesség
 * Kimenet: szegmensenkénti komponensek + összesített statisztika
 */

const OPEN_METEO_URL  = "https://api.open-meteo.com/v1/forecast";
const SAMPLE_INTERVAL = 10000;   // m – ~10 km (preferált hosszabb route-on)
const MIN_SEGMENTS    = 4;       // legalább ennyi szegmens (rövid route-ra is)
const MAX_SAMPLES     = 30;      // max párhuzamos API hívás
const TZ              = "Europe/Budapest";

export const WIND_MODES  = { TAIL: "tail", CROSS: "cross", HEAD: "head" };
export const WIND_COLORS = { tail: "#22C55E", cross: "#EAB308", head: "#EF4444" };
export const WIND_LABELS = { tail: "Hátszél", cross: "Oldalszél", head: "Szembeszél" };


/**
 * Haversine távolság két pont között (m).
 */
function haversineMeters(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}


/**
 * Iránymátrix-érték (bearing) két pont között, fokban (0 = É, 90 = K, 180 = D, 270 = Ny).
 * Ez az az irány, amerre haladva A pontból B pont felé megyünk.
 */
function calcBearing(a, b) {
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}


/**
 * Mintavételezi a geometriát ~SAMPLE_INTERVAL méterenként.
 * Visszaad: [{ point, geomIdx, cumDistM }] – első és utolsó pont mindig benne.
 * MAX_SAMPLES korlát betartásával az interval szükség szerint nő (hosszabb route).
 */
function sampleGeometry(geometry) {
  if (geometry.length < 2) return [];

  // Teljes hossz
  let totalDist = 0;
  const cumDists = [0];
  for (let i = 1; i < geometry.length; i++) {
    totalDist += haversineMeters(geometry[i - 1], geometry[i]);
    cumDists.push(totalDist);
  }

  // Mintavételi intervallum:
  //  - rövid route-on: totalDist / MIN_SEGMENTS (legalább 4 szegmens)
  //  - közepes route-on: SAMPLE_INTERVAL (10 km)
  //  - hosszú route-on: totalDist / MAX_SAMPLES (max 30 hívás)
  const interval = Math.max(
    totalDist / MAX_SAMPLES,
    Math.min(SAMPLE_INTERVAL, totalDist / MIN_SEGMENTS),
  );

  const samples = [{ point: geometry[0], geomIdx: 0, cumDistM: 0 }];
  let nextThreshold = interval;
  for (let i = 1; i < geometry.length - 1; i++) {
    if (cumDists[i] >= nextThreshold) {
      samples.push({ point: geometry[i], geomIdx: i, cumDistM: cumDists[i] });
      nextThreshold += interval;
    }
  }
  samples.push({
    point:    geometry[geometry.length - 1],
    geomIdx:  geometry.length - 1,
    cumDistM: totalDist,
  });

  return samples;
}


/**
 * Open-Meteo lekérdezés egyetlen koordinátára, 7 napos hourly bontásban.
 */
async function fetchForecast(lat, lng) {
  const params = new URLSearchParams({
    latitude:  lat.toFixed(5),
    longitude: lng.toFixed(5),
    hourly:    "wind_speed_10m,wind_direction_10m,temperature_2m,precipitation_probability,cloudcover",
    timezone:  TZ,
    forecast_days: "7",
    wind_speed_unit: "kmh",
  });
  const url = `${OPEN_METEO_URL}?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return res.json();
}


/**
 * Egy adott időponthoz tartozó hourly index megkeresése (a legközelebbi órára kerekít).
 * @param {Array<string>} timeArray – ISO local time, pl. "2026-05-22T13:00"
 * @param {Date} targetDate
 * @returns {number} index vagy -1 ha nincs lefedés
 */
function findHourIndex(timeArray, targetDate) {
  const targetMs = targetDate.getTime();
  let bestIdx = -1, bestDiff = Infinity;
  for (let i = 0; i < timeArray.length; i++) {
    const t = new Date(timeArray[i]);
    const diff = Math.abs(t.getTime() - targetMs);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }
  // Csak akkor adunk vissza, ha 90 percen belül van (különben "out of range")
  return bestDiff <= 90 * 60 * 1000 ? bestIdx : -1;
}


/**
 * Egyetlen szegmens szél-dekompozíciója.
 * @param {number} routeBearing – fok, az útvonal iránya (0 = É)
 * @param {number} windSpeed    – km/h
 * @param {number} windDir      – fok, ahonnan a szél fúj (0 = É felől)
 * @returns {{ along: number, across: number, mode: string, angle: number }}
 *   along:  pozitív = hátszél, negatív = szembeszél (km/h)
 *   across: abszolút értékű oldalszél (km/h)
 *   mode:   "tail" | "cross" | "head"
 *   angle:  szög a szél "felé fúj" iránya és a route iránya között (0-180°)
 */
function decomposeWind(routeBearing, windSpeed, windDir) {
  // wind_direction = honnan fúj. "Felé fúj" = windDir + 180.
  // Szög a "felé fúj" irány és a route irány között:
  let delta = ((windDir + 180 - routeBearing) % 360 + 360) % 360;
  if (delta > 180) delta = 360 - delta; // 0-180-ra normalizálva

  const rad   = delta * Math.PI / 180;
  const along = windSpeed * Math.cos(rad);    // 0° = teljes hátszél, 180° = teljes szembeszél
  const across = windSpeed * Math.abs(Math.sin(rad));

  // Cyclist convention: 0-60° tail, 60-120° cross, 120-180° head
  let mode;
  if (delta < 60)       mode = WIND_MODES.TAIL;
  else if (delta < 120) mode = WIND_MODES.CROSS;
  else                  mode = WIND_MODES.HEAD;

  return { along, across, mode, angle: delta };
}


/**
 * Az indulási időhöz hozzáadja a route-on már megtett távolságot időben.
 * @param {Date}   departureTime
 * @param {number} cumDistM – m
 * @param {number} avgSpeedKmh
 * @returns {Date} érkezési idő ehhez a sample ponthoz
 */
function arrivalTime(departureTime, cumDistM, avgSpeedKmh) {
  const hours = (cumDistM / 1000) / avgSpeedKmh;
  return new Date(departureTime.getTime() + hours * 3600 * 1000);
}


/**
 * Teljes szélelemzés egy GPX route-on.
 *
 * @param {Array}  geometry        – [{lat, lng}, ...] track pontok
 * @param {Date}   departureTime   – indulás
 * @param {number} avgSpeedKmh     – átlagsebesség (km/h)
 * @returns {Promise<{
 *   segments: Array<{
 *     fromIdx: number, toIdx: number,
 *     fromKm: number, toKm: number, distanceKm: number,
 *     bearing: number,
 *     arrivalTime: Date,
 *     wind: { speed: number, direction: number, along: number, across: number, mode: string, angle: number },
 *     weather: { temperature: number|null, precipitation: number|null, cloudcover: number|null },
 *   }>,
 *   stats: {
 *     totalDistKm: number,
 *     tailKm: number, crossKm: number, headKm: number,
 *     tailPct: number, crossPct: number, headPct: number,
 *     avgWindSpeed: number, avgTemperature: number|null,
 *     maxPrecipitation: number|null, avgCloudcover: number|null,
 *   },
 *   coverage: { from: Date, to: Date, withinForecast: boolean },
 * }>}
 */
export async function analyzeWind(geometry, departureTime, avgSpeedKmh) {
  if (geometry.length < 2)      throw new Error("Nincs elegendő trackpont a szélelemzéshez.");
  if (avgSpeedKmh <= 0)         throw new Error("Érvénytelen átlagsebesség.");
  if (!(departureTime instanceof Date) || Number.isNaN(departureTime.getTime()))
    throw new Error("Érvénytelen indulási idő.");

  const samples = sampleGeometry(geometry);
  if (samples.length < 2) throw new Error("Túl rövid útvonal a szélelemzéshez.");

  // Párhuzamos API hívások – egy sample = egy forecast
  const forecasts = await Promise.all(samples.map(s => fetchForecast(s.point.lat, s.point.lng)));

  let withinForecast = true;
  const segments = [];

  // Szegmensek: sample[i] és sample[i+1] között
  for (let i = 0; i < samples.length - 1; i++) {
    const s0 = samples[i];
    const s1 = samples[i + 1];

    const bearing  = calcBearing(s0.point, s1.point);
    const midDistM = (s0.cumDistM + s1.cumDistM) / 2;
    const arrival  = arrivalTime(departureTime, midDistM, avgSpeedKmh);

    // A szegmens szelét az s0 mintapont forecastjából vesszük (kezdő pont)
    const fc  = forecasts[i];
    const idx = findHourIndex(fc.hourly.time, arrival);
    if (idx < 0) withinForecast = false;

    const windSpeed = idx >= 0 ? fc.hourly.wind_speed_10m[idx]     : 0;
    const windDir   = idx >= 0 ? fc.hourly.wind_direction_10m[idx] : 0;
    const temp      = idx >= 0 ? fc.hourly.temperature_2m[idx]     : null;
    const precip    = idx >= 0 ? fc.hourly.precipitation_probability[idx] : null;
    const cloud     = idx >= 0 ? fc.hourly.cloudcover[idx]         : null;

    const wind = decomposeWind(bearing, windSpeed, windDir);
    wind.speed     = windSpeed;
    wind.direction = windDir;

    segments.push({
      fromIdx: s0.geomIdx,
      toIdx:   s1.geomIdx,
      fromKm:  s0.cumDistM / 1000,
      toKm:    s1.cumDistM / 1000,
      distanceKm: (s1.cumDistM - s0.cumDistM) / 1000,
      bearing,
      arrivalTime: arrival,
      wind,
      weather: { temperature: temp, precipitation: precip, cloudcover: cloud },
    });
  }

  // Aggregált statisztika
  const totalDistKm = segments.reduce((s, x) => s + x.distanceKm, 0);
  let tailKm = 0, crossKm = 0, headKm = 0;
  let speedSum = 0, tempVals = [], precipVals = [], cloudVals = [];
  for (const seg of segments) {
    if (seg.wind.mode === WIND_MODES.TAIL)  tailKm  += seg.distanceKm;
    if (seg.wind.mode === WIND_MODES.CROSS) crossKm += seg.distanceKm;
    if (seg.wind.mode === WIND_MODES.HEAD)  headKm  += seg.distanceKm;
    speedSum += seg.wind.speed;
    if (seg.weather.temperature   != null) tempVals.push(seg.weather.temperature);
    if (seg.weather.precipitation != null) precipVals.push(seg.weather.precipitation);
    if (seg.weather.cloudcover    != null) cloudVals.push(seg.weather.cloudcover);
  }
  const avg = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
  const max = (arr) => arr.length ? Math.max(...arr) : null;

  const stats = {
    totalDistKm,
    tailKm, crossKm, headKm,
    tailPct:  totalDistKm > 0 ? (tailKm  / totalDistKm) * 100 : 0,
    crossPct: totalDistKm > 0 ? (crossKm / totalDistKm) * 100 : 0,
    headPct:  totalDistKm > 0 ? (headKm  / totalDistKm) * 100 : 0,
    avgWindSpeed:    segments.length ? speedSum / segments.length : 0,
    avgTemperature:  avg(tempVals),
    maxPrecipitation: max(precipVals),
    avgCloudcover:   avg(cloudVals),
  };

  return {
    segments,
    stats,
    coverage: {
      from: arrivalTime(departureTime, 0, avgSpeedKmh),
      to:   arrivalTime(departureTime, samples[samples.length - 1].cumDistM, avgSpeedKmh),
      withinForecast,
    },
  };
}


/**
 * Default átlagsebesség az aktuális tervezési mód alapján.
 */
export function defaultAvgSpeed(mode) {
  const map = { asphalt: 22, cycling: 22, gravel: 18, mtb: 12, hiking: 5, walking: 5 };
  return map[mode] ?? 18;
}


/**
 * Pozíció → CdA (légellenállási együttható × homlokfelület, m²).
 */
export const CDA_BY_POSITION = {
  upright:   0.65,  // felső kormány / városi
  touring:   0.50,  // bricsesz / túrakerékpár
  road:      0.40,  // országúti (alap)
  aero:      0.32,  // versenypozíció / aero
};

/**
 * Gördülési ellenállás (Crr) tervezési mód szerint.
 */
export const CRR_BY_MODE = {
  asphalt: 0.005,
  cycling: 0.005,
  gravel:  0.010,
  mtb:     0.018,
  hiking:  0.030,   // gyalog ez nem releváns, de kell egy érték
  walking: 0.030,
};

const RHO        = 1.225;   // levegő sűrűsége tengerszinten (kg/m³)
const G          = 9.81;    // m/s²
const MIN_KMH    = 2.0;     // minimum reális haladási sebesség wind ellen

/**
 * Adott v_terv sebességhez (szélmentes esetben) szükséges teljesítmény.
 * @param {number} vMs   – m/s
 * @param {number} m     – össztömeg (rider + bike), kg
 * @param {number} CdA   – m²
 * @param {number} Crr
 * @returns {number} W
 */
function inferPower(vMs, m, CdA, Crr) {
  const fRoll = Crr * m * G;
  const fAero = 0.5 * RHO * CdA * vMs * vMs;
  return (fRoll + fAero) * vMs;
}

/**
 * Adott teljesítményhez és szembeszélhez megoldja a sebességet (m/s)
 * Newton-Raphson iterációval. Sík terepre.
 *
 * Egyenlet: P = (Crr·m·g + 0.5·ρ·CdA·(v + w)²) × v
 * Ahol w = headwind komponens m/s-ban (negatív = hátszél)
 *
 * @param {number} P    – W
 * @param {number} w    – m/s (pozitív = szembeszél, negatív = hátszél)
 * @param {number} m    – kg
 * @param {number} CdA  – m²
 * @param {number} Crr
 * @param {number} v0   – kezdeti tipp (m/s)
 * @returns {number} m/s
 */
function solveSpeed(P, w, m, CdA, Crr, v0) {
  const a = Crr * m * G;
  const b = 0.5 * RHO * CdA;
  let v = Math.max(0.5, v0);
  for (let i = 0; i < 12; i++) {
    const vr  = v + w;
    const f   = (a + b * vr * vr) * v - P;
    // f'(v) = a + b·vr² + 2·b·vr·v = a + b·vr·(vr + 2v) = a + b·vr·(3v + w)
    const fp  = a + b * vr * (3 * v + w);
    if (Math.abs(fp) < 1e-9) break;
    const dv = f / fp;
    v -= dv;
    if (v < 0.3) v = 0.3;          // ne menjen le 0 alá
    if (Math.abs(dv) < 1e-4) break;
  }
  return v;
}

/**
 * Szélhatás miatti idő-szorzó (fizikai modellel).
 *
 * @param {Array}  segments     – analyzeWind().segments
 * @param {number} plannedKmh   – tervezett sebesség szélmentes esetben (km/h)
 * @param {object} profile      – kerékpáros profil:
 *   { riderKg, bikeKg, position: "upright"|"touring"|"road"|"aero", routeMode }
 * @returns {number} szorzó: actual_time / nowind_time
 */
export function windTimeMultiplier(segments, plannedKmh, profile = {}) {
  if (!segments || segments.length === 0 || plannedKmh <= 0) return 1;
  const m   = (profile.riderKg ?? 75) + (profile.bikeKg ?? 10);
  const CdA = CDA_BY_POSITION[profile.position] ?? CDA_BY_POSITION.road;
  const Crr = CRR_BY_MODE[profile.routeMode] ?? CRR_BY_MODE.asphalt;

  const vTerv = plannedKmh / 3.6;
  const P     = inferPower(vTerv, m, CdA, Crr);   // referencia teljesítmény

  let timeWithWind = 0;
  let timeNoWind   = 0;
  for (const seg of segments) {
    // along: +km/h = hátszél, –km/h = szembeszél
    const headMs = -((seg.wind?.along ?? 0) / 3.6); // m/s, + = szembe
    const vMs = solveSpeed(P, headMs, m, CdA, Crr, vTerv);
    const vKmh = Math.max(MIN_KMH, vMs * 3.6);
    timeWithWind += seg.distanceKm / vKmh;
    timeNoWind   += seg.distanceKm / plannedKmh;
  }
  return timeNoWind > 0 ? timeWithWind / timeNoWind : 1;
}

/**
 * A referencia teljesítményt is visszaadja (Watt) – kalóriaszámításhoz hasznos.
 * @param {number} plannedKmh
 * @param {object} profile
 * @returns {number} W
 */
export function referencePower(plannedKmh, profile = {}) {
  const m   = (profile.riderKg ?? 75) + (profile.bikeKg ?? 10);
  const CdA = CDA_BY_POSITION[profile.position] ?? CDA_BY_POSITION.road;
  const Crr = CRR_BY_MODE[profile.routeMode] ?? CRR_BY_MODE.asphalt;
  return inferPower(plannedKmh / 3.6, m, CdA, Crr);
}
