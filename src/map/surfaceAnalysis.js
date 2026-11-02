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
  hiking:  "Ösvény",
};

/** BRouter „WayTags” szövegből („highway=track surface=gravel …”) a burkolat-osztály. */
export function modeFromWayTags(tagStr) {
  const tags = {};
  String(tagStr || "").split(/\s+/).forEach((kv) => { const i = kv.indexOf("="); if (i > 0) tags[kv.slice(0, i)] = kv.slice(i + 1); });
  return wayMode(tags) ?? "asphalt";
}

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

// Rácsos térbeli index az OSM-út szakaszaihoz: a legközelebbi út keresése így csak a
// pont környező celláit nézi, nem az összes letöltött utat (nagy területen ez percekig tartott)
const GRID = 0.0005; // ~50 m
const THRESHOLD_SQ = 0.00045 * 0.00045; // ~50 m

function buildWayIndex(ways) {
  const cells = new Map();
  const add = (key, seg) => { let a = cells.get(key); if (!a) cells.set(key, a = []); a.push(seg); };
  for (const way of ways) {
    const nodes = way.geometry;
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i], b = nodes[i + 1];
      const seg = [a.lat, a.lon, b.lat, b.lon, way.mode];
      // a szakasz mentén félcellánként – minden érintett cellába bekerül (egyszer)
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.lat - a.lat), Math.abs(b.lon - a.lon)) / (GRID / 2)));
      let last = "";
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const key = `${Math.floor((a.lat + (b.lat - a.lat) * t) / GRID)},${Math.floor((a.lon + (b.lon - a.lon) * t) / GRID)}`;
        if (key !== last) { add(key, seg); last = key; }
      }
    }
  }
  return cells;
}

function nearestWayMode(point, index) {
  const ci = Math.floor(point.lat / GRID), cj = Math.floor(point.lng / GRID);
  let minDistSq = Infinity;
  let bestMode = null;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const segs = index.get(`${ci + di},${cj + dj}`);
      if (!segs) continue;
      for (const [alat, alon, blat, blon, mode] of segs) {
        const d = pointToSegDistSq(point.lat, point.lng, alat, alon, blat, blon);
        if (d < minDistSq) { minDistSq = d; bestMode = mode; }
      }
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
// A fő Overpass-szerver gyakran túlterhelt (502/504) – időkorláttal, tartalék szerverrel
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
async function overpassQuery(query) {
  let lastErr = null;
  // Túlterheltségnél (502/504/429) rövid szünet után még egy kör a szervereken
  for (let round = 0; round < 2; round++) {
    if (round) await new Promise((r) => setTimeout(r, 5000));
    for (const url of OVERPASS_ENDPOINTS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 35000);
      try {
        const resp = await fetch(url, {
          method: "POST",
          body: `data=${encodeURIComponent(query)}`,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          signal: ctrl.signal,
        });
        if (!resp.ok) { lastErr = new Error(`a térképadat-szerver (OpenStreetMap) hibát jelzett (${resp.status}) – próbáld újra kicsit később.`); continue; }
        const json = await resp.json();
        // Túlterhelt szerver „sikeres”, de üres választ is adhat, a hibát a remark mezőben jelzi
        if (json.remark && /error|timed out|out of memory|runtime/i.test(json.remark)) {
          lastErr = new Error("a térképadat-szerver (OpenStreetMap) túlterhelt – próbáld újra kicsit később.");
          continue;
        }
        return json;
      } catch (err) {
        lastErr = err.name === "AbortError" ? new Error("a térképadat-szerver (OpenStreetMap) nem válaszolt időben – próbáld újra kicsit később.") : err;
      } finally { clearTimeout(timer); }
    }
  }
  throw lastErr ?? new Error("a térképadat-szerver (OpenStreetMap) most nem érhető el – próbáld újra kicsit később.");
}

export async function analyzeSurface(geometry, { onProgress } = {}) {
  if (geometry.length < 2) {
    throw new Error("Nincs elegendő trackpont az elemzéshez.");
  }

  // 1. Mintavételezés ~150 méterenként
  const samples = sampleGeometryWithDist(geometry, 150);
  const totalDistKm = samples[samples.length - 1].distM / 1000;

  // 2–3. Pontonkénti burkolat: először a saját (szerveren tárolt, magyar OSM-kivonatból épített) adatbázis – ha nincs,
  // vagy az útvonal nagy része nem Magyarországon van, az Overpass-lekérdezés jön
  let rawModes = await localModes(samples, onProgress);
  if (!rawModes) rawModes = await overpassModes(samples, onProgress);

  // 4. Simítás (7 pontos ablak ~1 km)
  const smoothed = smoothModes(rawModes, 7);

  // 5. Összefoglaló szegmensek (egymás utáni azonos módok csoportja)
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

  // 6. Rövid szegmensek összevonása (< 2 km)
  const MIN_SEG_KM = 2.0;
  const segments = mergeShortSegments(rawSegs, MIN_SEG_KM);

  return { segments, totalDistKm };
}

// Overpass: csak a nyomvonal ~30 m-es sávjában lévő utak (nem a teljes befoglaló téglalap –
// az egy nagy körnél több tízezer utat jelentett). A sáv vonala a ~150 m-es mintapontokból áll;
// hosszú útvonalnál ~45 km-es darabokban kérdezünk (egyben a szerver időtúllépéssel válaszolt),
// a darabok egy ponttal átfednek.
async function overpassModes(samples, onProgress) {
  const CHUNK = 300;
  const ways = [];
  const seen = new Set();
  const parts = Math.max(1, Math.ceil((samples.length - 1) / CHUNK));
  for (let start = 0; start < samples.length - 1; start += CHUNK) {
    onProgress?.(start / CHUNK + 1, parts);
    const part = samples.slice(start, Math.min(samples.length, start + CHUNK + 1));
    const line = part.map((s) => `${s.point.lat.toFixed(5)},${s.point.lng.toFixed(5)}`).join(",");
    const query = `[out:json][timeout:45];
way["highway"](around:30,${line});
out tags geom qt;`;
    // Egy nyomvonal 30 m-es sávjában mindig van út – az üres válasz túlterhelt szervert jelent
    let data = await overpassQuery(query);
    if (!data.elements?.length) {
      await new Promise((r) => setTimeout(r, 4000));
      data = await overpassQuery(query);
      if (!data.elements?.length) throw new Error("a térképadat-szerver (OpenStreetMap) most nem adott választ – próbáld újra kicsit később.");
    }
    for (const el of data.elements) {
      if (el.type !== "way" || seen.has(el.id) || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
      seen.add(el.id);
      ways.push({ mode: wayMode(el.tags) ?? "asphalt", geometry: el.geometry });
    }
  }

  if (ways.length === 0) throw new Error("ezen a területen a térképen nincs útadat.");

  // 3. Minden mintaponthoz: legközelebbi OSM út módja (rácsos indexszel)
  const index = buildWayIndex(ways);
  return samples.map(s => nearestWayMode(s.point, index) ?? "asphalt");
}

/** Saját burkolat-adatbázis (routes-api /api/surface/lookup); null, ha nincs vagy nem használható. */
async function localModes(samples, onProgress) {
  const token = (() => { try { return localStorage.getItem("bringaterv_jwt"); } catch { return null; } })();
  if (!token) return null;
  const pts = samples.map((s) => [Math.round(s.point.lat * 1e6) / 1e6, Math.round(s.point.lng * 1e6) / 1e6]);
  const out = [];
  const STEP = 5000;
  try {
    for (let i = 0; i < pts.length; i += STEP) {
      onProgress?.(i / STEP + 1, Math.ceil(pts.length / STEP));
      const resp = await fetch("/api/surface/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ points: pts.slice(i, i + STEP) }),
      });
      if (!resp.ok) return null;
      out.push(...((await resp.json()).modes || []));
    }
  } catch {
    return null;
  }
  // külföldi (a kivonaton kívüli) útvonal: inkább Overpass
  const known = out.filter(Boolean).length;
  if (out.length !== pts.length || known < pts.length * 0.6) return null;
  return out.map((m) => m ?? "asphalt");
}
