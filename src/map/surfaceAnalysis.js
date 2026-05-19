/**
 * OSM felületelemzés – Overpass API alapján meghatározza az útvonal
 * burkolattípusát, felület-átmeneteket keres, és szegmenseket ad vissza.
 *
 * A szegmensek nem waypontokon alapulnak – a teljes track mentén fut,
 * így 2 waypontos (Start/Finish) fájloknál is értelmes eredményt ad.
 */

const SURFACE_TO_MODE = {
  asphalt:             "asphalt",
  paved:               "asphalt",
  concrete:            "asphalt",
  "concrete:plates":   "asphalt",
  "concrete:lanes":    "asphalt",
  metal:               "asphalt",
  cobblestone:         "gravel",
  sett:                "gravel",
  paving_stones:       "gravel",
  gravel:              "gravel",
  fine_gravel:         "gravel",
  compacted:           "gravel",
  pebblestone:         "gravel",
  unpaved:             "gravel",
  "gravel;grass":      "gravel",
  dirt:                "mtb",
  ground:              "mtb",
  grass:               "mtb",
  earth:               "mtb",
  mud:                 "mtb",
  sand:                "mtb",
  woodchips:           "mtb",
  rock:                "mtb",
};

const HIGHWAY_TO_MODE = {
  motorway:      "asphalt",
  trunk:         "asphalt",
  primary:       "asphalt",
  secondary:     "asphalt",
  tertiary:      "asphalt",
  residential:   "asphalt",
  service:       "asphalt",
  living_street: "asphalt",
  unclassified:  "asphalt",
  cycleway:      "asphalt",
  road:          "asphalt",
  track:         "mtb",
  path:          "hiking",
  footway:       "hiking",
  bridleway:     "hiking",
};

export const MODE_LABELS = {
  asphalt: "Aszfalt",
  gravel:  "Gravel",
  mtb:     "MTB",
  hiking:  "Túra",
};

function wayMode(tags) {
  if (!tags) return null;
  const surface = tags.surface;
  const highway = tags.highway;
  if (surface && SURFACE_TO_MODE[surface]) return SURFACE_TO_MODE[surface];
  if (highway === "track") {
    const tt = tags.tracktype;
    if (tt === "grade1" || tt === "grade2") return "gravel";
    return "mtb";
  }
  if (highway && HIGHWAY_TO_MODE[highway]) return HIGHWAY_TO_MODE[highway];
  return null;
}

function pointToSegDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
}

function haversineDist(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const aa = sinDLat ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sinDLng ** 2;
  return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

/** Geometry mintavételezése intervallumonként (méter). Visszaadja a mintapontokat
 *  és az egyes minták kumulatív távolságát (méterben) a track elejétől. */
function sampleGeometryWithDist(geometry, intervalMeters) {
  if (geometry.length === 0) return [];
  const result = [{ point: geometry[0], distM: 0, geomIdx: 0 }];
  let acc = 0;
  let cumDist = 0;
  for (let i = 1; i < geometry.length; i++) {
    const d = haversineDist(geometry[i - 1], geometry[i]);
    acc += d;
    cumDist += d;
    if (acc >= intervalMeters) {
      result.push({ point: geometry[i], distM: cumDist, geomIdx: i });
      acc = 0;
    }
  }
  const last = geometry[geometry.length - 1];
  const lastResult = result[result.length - 1];
  if (lastResult.geomIdx !== geometry.length - 1) {
    result.push({ point: last, distM: cumDist, geomIdx: geometry.length - 1 });
  }
  return result;
}

function nearestWayMode(point, ways) {
  const THRESHOLD_SQ = 0.00045 * 0.00045; // ~50m
  let minDistSq = Infinity;
  let bestMode = null;
  for (const way of ways) {
    const nodes = way.geometry;
    if (!nodes || nodes.length < 2) continue;
    for (let i = 0; i < nodes.length - 1; i++) {
      const d = pointToSegDistSq(
        point.lat, point.lng,
        nodes[i].lat,   nodes[i].lon,
        nodes[i + 1].lat, nodes[i + 1].lon,
      );
      if (d < minDistSq) { minDistSq = d; bestMode = way.mode; }
    }
  }
  return minDistSq < THRESHOLD_SQ ? bestMode : null;
}

/** Simítás: csúszóablakos többségi szavazat */
function smoothModes(modes, halfWindow) {
  return modes.map((_, i) => {
    const votes = {};
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(modes.length - 1, i + halfWindow); j++) {
      votes[modes[j]] = (votes[modes[j]] ?? 0) + 1;
    }
    return Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  });
}

/** Rövid szegmensek összevonása a szomszédjukkal (min. MIN_KM alatt) */
function mergeShortSegments(segs, minKm) {
  if (segs.length <= 1) return segs;
  let result = [...segs];
  let changed = true;
  while (changed && result.length > 1) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      if (result[i].distanceKm < minKm) {
        const mergeWith = i === 0 ? 1 : i - 1;
        const [a, b] = mergeWith > i ? [i, mergeWith] : [mergeWith, i];
        // A hosszabb szegmens módja marad
        const dominantMode = result[a].distanceKm >= result[b].distanceKm
          ? result[a].mode : result[b].mode;
        result.splice(a, 2, {
          mode:        dominantMode,
          fromKm:      result[a].fromKm,
          toKm:        result[b].toKm,
          distanceKm:  result[a].distanceKm + result[b].distanceKm,
          geomPoint:   result[a].geomPoint,
          geomIdx:     result[a].geomIdx,
        });
        changed = true;
        break;
      }
    }
  }
  return result;
}

/**
 * OSM Overpass alapján meghatározza a track felületi szegmenseit.
 * Track-alapú (nem waypoint-alapú) – 2 waypontos fájloknál is pontos.
 *
 * @param {Array}  geometry   – GPX trackpontok [{lat, lng, ...}]
 * @returns {Promise<object>} – { segments, totalDistKm }
 *   segments: [{ mode, fromKm, toKm, distanceKm, geomPoint, geomIdx }]
 */
export async function analyzeSurface(geometry) {
  if (geometry.length < 2) {
    throw new Error("Nincs elegendő trackpont az elemzéshez.");
  }

  // 1. Bounding box + buffer
  const lats = geometry.map(p => p.lat);
  const lngs = geometry.map(p => p.lng);
  const south = (Math.min(...lats) - 0.01).toFixed(6);
  const north = (Math.max(...lats) + 0.01).toFixed(6);
  const west  = (Math.min(...lngs) - 0.01).toFixed(6);
  const east  = (Math.max(...lngs) + 0.01).toFixed(6);

  // 2. Overpass lekérdezés
  const query = `[out:json][timeout:30];
(
  way["surface"](${south},${west},${north},${east});
  way["highway"~"^(track|path|cycleway|footway|bridleway)$"](${south},${west},${north},${east});
);
out tags geom qt;`;

  const resp = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: `data=${encodeURIComponent(query)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!resp.ok) throw new Error(`Overpass API hiba (${resp.status}).`);
  const data = await resp.json();

  const ways = data.elements
    .filter(el => el.type === "way" && Array.isArray(el.geometry) && el.geometry.length >= 2)
    .map(el => ({ mode: wayMode(el.tags) ?? "asphalt", geometry: el.geometry }));

  if (ways.length === 0) throw new Error("Az OSM nem adott vissza útadatot erre a területre.");

  // 3. Mintavételezés ~150 méterenként
  const samples = sampleGeometryWithDist(geometry, 150);
  const totalDistKm = samples[samples.length - 1].distM / 1000;

  // 4. Minden mintaponthoz: legközelebbi OSM út módja
  const rawModes = samples.map(s => nearestWayMode(s.point, ways) ?? "asphalt");

  // 5. Simítás (7 pontos ablak ~1 km)
  const smoothed = smoothModes(rawModes, 7);

  // 6. Összefoglaló szegmensek (egymás utáni azonos módok csoportja)
  const rawSegs = [];
  let segStart = 0;
  for (let i = 1; i <= smoothed.length; i++) {
    if (i === smoothed.length || smoothed[i] !== smoothed[segStart]) {
      const fromKm = samples[segStart].distM / 1000;
      const toKm   = samples[Math.min(i, samples.length - 1)].distM / 1000;
      rawSegs.push({
        mode:        smoothed[segStart],
        fromKm,
        toKm,
        distanceKm:  toKm - fromKm,
        geomPoint:   samples[segStart].point,
        geomIdx:     samples[segStart].geomIdx,
      });
      segStart = i;
    }
  }

  // 7. Rövid szegmensek összevonása (< 2 km)
  const MIN_SEG_KM = 2.0;
  const segments = mergeShortSegments(rawSegs, MIN_SEG_KM);

  return { segments, totalDistKm };
}
