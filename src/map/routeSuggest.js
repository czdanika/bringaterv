// ── Útvonal-javaslat: kör vagy A → B generálása adott távra ──────────────────
// A pontokat mi helyezzük el (kör: a rajton átmenő sokszög, A → B: kitérő pontok a
// cél felé), az utat mindig a BRouter rajzolja. A tényleges hosszra a sugarat /
// kitérést egy lépésben igazítjuk, majd pontozzuk: táv-eltérés, kért burkolat,
// szint, visszafordulás / önátfedés. A legjobb 3 javaslatot adjuk vissza.

const R = 6371000;
const toRad = (d) => d * Math.PI / 180;
const toDeg = (r) => r * 180 / Math.PI;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function destination(p, bearingDeg, distM) {
  const d = distM / R, b = toRad(bearingDeg), la = toRad(p.lat), lo = toRad(p.lng);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: toDeg(la2), lng: toDeg(lo2) };
}

function bearing(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// burkolat-választás → BRouter-profil (a tervező tervezési módjai)
export const SURFACE_MODE = { asphalt: "asphalt", gravel: "gravel", mixed: "gravel" };
const ROAD_FACTOR = 1.3;   // a valós út ennyivel hosszabb a légvonalnál (kezdő becslés)

// Kör: a rajt egy körön van, a kör középpontja a rajttól `b` irányban R-re; a további
// 3 pont a körön 90°-onként → nagyjából négyzetes, a rajtból kiinduló kör
function loopPoints(start, b, radius) {
  const center = destination(start, b, radius);
  const back = (b + 180) % 360;
  return [1, 2, 3].map((k) => destination(center, (back + 90 * k) % 360, radius));
}

// A → B: kitérő pont(ok) a szakasz felezőmerőlegesén `side` irányba, h távolságra
function abVia(start, end, h, side, two) {
  const brg = bearing(start, end);
  const perp = (brg + (side > 0 ? 90 : 270)) % 360;
  if (!two) return [destination(destination(start, brg, haversine(start, end) / 2), perp, h)];
  const d = haversine(start, end);
  return [destination(destination(start, brg, d / 3), perp, h), destination(destination(start, brg, 2 * d / 3), perp, h)];
}

// Visszafordulás / önátfedés aránya: a pontok hány %-a esik olyan ~30 m-es cellába,
// ahol az útvonal már legalább 400 m-rel korábban járt
function overlapRatio(geometry) {
  const cell = 0.0003, seen = new Map();
  let dist = 0, over = 0, n = 0;
  for (let i = 0; i < geometry.length; i++) {
    if (i) dist += haversine(geometry[i - 1], geometry[i]);
    const key = `${Math.round(geometry[i].lat / cell)},${Math.round(geometry[i].lng / cell)}`;
    const first = seen.get(key);
    if (first == null) seen.set(key, dist);
    else if (dist - first > 120) over++;
    n++;
  }
  return n ? over / n : 0;
}

// Tüske (oda-vissza szakasz) egy segédpontnál: a pont előtt és után ugyanazon az úton
// halad az útvonal. Visszaadja a tüske tövét (ide érdemes áttenni a pontot), vagy null-t.
function cumulative(geometry) {
  const cum = [0];
  for (let i = 1; i < geometry.length; i++) cum.push(cum[i - 1] + haversine(geometry[i - 1], geometry[i]));
  return cum;
}
function pointAt(geometry, cum, s) {
  if (s <= 0) return geometry[0];
  if (s >= cum[cum.length - 1]) return geometry[geometry.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const t = (s - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
  return { lat: geometry[lo].lat + (geometry[hi].lat - geometry[lo].lat) * t, lng: geometry[lo].lng + (geometry[hi].lng - geometry[lo].lng) * t };
}
function findSpur(geometry, cum, via) {
  let a = 0, bd = Infinity;
  for (let i = 0; i < geometry.length; i++) { const d = haversine(via, geometry[i]); if (d < bd) { bd = d; a = i; } }
  const sA = cum[a];
  let good = 0;
  for (let d = 15; d <= 4000; d += 15) {
    if (haversine(pointAt(geometry, cum, sA - d), pointAt(geometry, cum, sA + d)) > 35) break;
    good = d;
  }
  return good >= 40 ? { base: pointAt(geometry, cum, sA - good), len: good } : null;
}
function spurLength(geometry, via) {
  const cum = cumulative(geometry);
  return via.reduce((sum, v) => sum + (findSpur(geometry, cum, v)?.len || 0), 0);
}

function surfaceMix(geometry) {
  const mix = {};
  let tot = 0;
  for (let i = 1; i < geometry.length; i++) {
    const d = haversine(geometry[i - 1], geometry[i]);
    const m = geometry[i].surf || "asphalt";
    mix[m] = (mix[m] || 0) + d; tot += d;
  }
  for (const k in mix) mix[k] = tot ? mix[k] / tot : 0;
  return mix;
}

function score(r, opts, via = []) {
  const km = r.distanceMeters / 1000;
  const mix = surfaceMix(r.geometry);
  const asc = r.ascentMeters / Math.max(1, km);              // m / km
  let p = 3 * Math.abs(km - opts.km) / opts.km;
  if (opts.surface === "asphalt") p += 1.2 * (1 - (mix.asphalt || 0));
  if (opts.surface === "gravel") p += 1.2 * (1 - (mix.gravel || 0) - 0.5 * (mix.mtb || 0));
  if (opts.surface === "mixed") p += 0.6 * Math.abs(0.5 - (mix.asphalt || 0));
  if (opts.hills === "flat") p += Math.min(1, asc / 15);
  if (opts.hills === "hilly") p += Math.max(0, 1 - asc / 12);
  p += 2.5 * overlapRatio(r.geometry);
  p += 4 * spurLength(r.geometry, via) / Math.max(1, r.distanceMeters);   // oda-vissza a segédpontoknál
  return { penalty: p, mix };
}

// Párhuzamos kérések korlátozása (a nyilvános BRouter-szervert kíméljük)
async function pool(tasks, limit, onDone) {
  const out = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try { out[i] = await tasks[i](); } catch { out[i] = null; }
      onDone?.();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

/**
 * @param {object} opts  { start, end?, km, loop, surface: asphalt|gravel|mixed, hills: flat|hilly|any }
 * @param {(waypoints, mode) => Promise} route  BRouter-hívás (mapAdapter.routeStrict)
 * @param {(done, total) => void} onProgress
 * @returns {Promise<Array>} legfeljebb 3 javaslat, a legjobb elöl
 */
export async function generateSuggestions(opts, route, onProgress) {
  const mode = SURFACE_MODE[opts.surface] || "asphalt";
  const target = opts.km * 1000;
  const shapes = [];

  // Közeli cél (a kért táv < 30%-a légvonalban): a kitérős A → B oda-vissza útvonalat adna,
  // ezért körszerűen tervezünk, ami a célnál ér véget
  const nearEnd = !opts.loop && haversine(opts.start, opts.end) < target * 0.3;
  if (opts.loop || nearEnd) {
    const r0 = target / (2 * Math.PI * ROAD_FACTOR);
    for (let b = 0; b < 360; b += 60) shapes.push({ bearing: b, make: (k) => loopPoints(opts.start, b, r0 * k) });
  } else {
    const d = haversine(opts.start, opts.end);
    // a kért táv legalább a légvonal ~1,15-szöröse legyen; különben csak kis kitérők
    const need = Math.max(target / ROAD_FACTOR, d * 1.15);
    const h0 = Math.sqrt(Math.max((need / 2) ** 2 - (d / 2) ** 2, (d * 0.12) ** 2));
    for (const side of [1, -1]) {
      shapes.push({ bearing: side, make: (k) => abVia(opts.start, opts.end, h0 * k, side, false) });
      shapes.push({ bearing: side * 2, make: (k) => abVia(opts.start, opts.end, h0 * k * 0.8, side, true) });
    }
    if (target <= d * ROAD_FACTOR * 1.2) shapes.push({ bearing: 0, make: () => [] });   // egyenesen
  }

  const total = shapes.length * 2;
  let done = 0;
  const tick = () => onProgress?.(++done, total);
  const ends = (via) => opts.loop ? [opts.start, ...via, opts.start] : [opts.start, ...via, opts.end];

  // 1. kör: becsült mérettel; 2. kör: a tényleges hossz alapján arányosan igazítva
  const first = await pool(shapes.map((sh) => () => route(ends(sh.make(1)), mode)), 3, tick);
  const second = await pool(shapes.map((sh, i) => async () => {
    const r1 = first[i];
    if (!r1) return null;
    const ratio = target / r1.distanceMeters;
    if (Math.abs(1 - ratio) < 0.06 || sh.bearing === 0) return null;   // elég pontos már
    const k = opts.loop ? ratio : Math.max(0.2, Math.min(2.5, ratio ** 1.6));
    return { k, res: await route(ends(sh.make(k)), mode) };
  }), 3, tick);

  const cands = [];
  shapes.forEach((sh, i) => {
    const opt = [];
    if (first[i]) opt.push({ k: 1, res: first[i] });
    if (second[i]?.res) opt.push(second[i]);
    for (const o of opt) {
      const via = sh.make(o.k);
      const s = score(o.res, opts, via);
      cands.push({ ...o.res, via, shape: sh.bearing, penalty: s.penalty, mix: s.mix, mode });
    }
  });
  // alakonként a legjobb, majd a legjobb 4 különböző alak
  const best = new Map();
  for (const c of cands) if (!best.has(c.shape) || best.get(c.shape).penalty > c.penalty) best.set(c.shape, c);
  let top = [...best.values()].sort((a, b) => a.penalty - b.penalty).slice(0, 4);

  // Tüskék (zsákutca, út nélküli segédpont): a pontot a tüske tövébe tesszük és újratervezünk
  const fixed = await pool(top.map((c) => async () => {
    const cum = cumulative(c.geometry);
    let changed = false;
    const via = c.via.map((v) => { const sp = findSpur(c.geometry, cum, v); if (sp) { changed = true; return sp.base; } return v; });
    if (!changed) return null;
    const res = await route(ends(via), mode);
    const s = score(res, opts, via);
    return { ...res, via, shape: c.shape, penalty: s.penalty, mix: s.mix, mode };
  }), 3);
  top = top.map((c, i) => (fixed[i] && fixed[i].penalty <= c.penalty + 0.05 ? fixed[i] : c));
  return top.sort((a, b) => a.penalty - b.penalty).slice(0, 3).map((c) => ({
    nearEnd,
    ...c,
    waypoints: ends(c.via).map((p, i, arr) => ({ lat: p.lat, lng: p.lng, segmentMode: i < arr.length - 1 ? mode : null })),
    farthest: farthestPoint(c.geometry, opts.start),
    mid: c.geometry[Math.floor(c.geometry.length / 2)],
  }));
}

function farthestPoint(geometry, from) {
  let best = geometry[0], bd = -1;
  for (const p of geometry) { const d = haversine(from, p); if (d > bd) { bd = d; best = p; } }
  return best;
}
