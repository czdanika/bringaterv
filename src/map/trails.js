// ── Jelzett turistautak (Waymarked Trails API) ───────────────────────────────
// Egy pont körül futó jelzések listája, egy jelzés teljes nyomvonala, és egy jelzés
// szakasza két pont között (ezen vezet a „Jelzés követése” szakasz). Az API az
// OpenStreetMap túraútvonal-relációiból dolgozik, a magyar jelzésekkel (jel_REG_p = piros sáv).
// Koordinátái EPSG:3857-ben vannak – itt alakítjuk át.

const API = "https://hiking.waymarkedtrails.org/api/v1";
const R = 6378137;
/** Ennyire lehet a pont a jelzéstől, hogy „rajta” legyen (m). */
export const ON_TRAIL_M = 150;

const toLatLng = ([x, y]) => ({ lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI, lng: x / R * 180 / Math.PI });
const toMerc = (p) => [p.lng * Math.PI / 180 * R, Math.log(Math.tan((90 + p.lat) * Math.PI / 360)) * R];

export function haversine(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** A jelzés képe (SVG) – a térképi rétegen is ez látszik. */
export const trailSymbolUrl = (sym) => `${API}/symbols/id/${encodeURIComponent(sym)}.svg`;
/** Rövid felirat: a jel (P, K▲, OKT) vagy a név. */
export const trailLabel = (t) => t?.ref || t?.name || "jelzés";
/** A waypointon tárolt forma (a GPX-be és a piszkozatba is ez kerül). */
export const trailRef = (t) => ({ id: t.id, ref: t.ref || "", name: t.name || "", sym: t.sym || t.symbol_id || "" });

const _near = new Map();
/** Jelzések a pont körül (`radius` m-en belül) – [{ id, ref, name, sym, group }] */
export async function trailsNear(p, radius = 60) {
  const key = `${p.lat.toFixed(4)},${p.lng.toFixed(4)},${radius}`;
  if (_near.has(key)) return _near.get(key);
  const [x, y] = toMerc(p);
  // a Mercator-méter a szélességgel nyúlik – a sugár ehhez igazítva
  const d = radius / Math.cos(p.lat * Math.PI / 180);
  const job = fetch(`${API}/list/by_area?bbox=${x - d},${y - d},${x + d},${y + d}&limit=20`)
    .then((r) => (r.ok ? r.json() : { results: [] }))
    .then((j) => (j.results || []).map((t) => ({ id: t.id, ref: t.ref || "", name: t.name || "", sym: t.symbol_id || "", group: t.group || "" })))
    .catch(() => { _near.delete(key); return []; });
  _near.set(key, job);
  return job;
}

// A reláció fája (route → linear / split → base útszakaszok) → összefüggő vonalak
function flatten(node, out) {
  if (!node) return;
  if (node.route_type === "base") { out.push(node.geometry.coordinates.map(toLatLng)); return; }
  if (node.route_type === "split") { (node.forward || []).forEach((n) => flatten(n, out)); return; }
  for (const k of ["main", "ways"]) (node[k] || []).forEach((n) => flatten(n, out));
}
function joinWays(ways) {
  const lines = [];
  let cur = null;
  for (const w of ways) {
    if (!cur) { cur = [...w]; continue; }
    const end = cur[cur.length - 1];
    if (haversine(end, w[0]) < 5) cur.push(...w.slice(1));
    else if (haversine(end, w[w.length - 1]) < 5) cur.push(...w.slice(0, -1).reverse());
    else if (lines.length === 0 && cur.length && haversine(cur[0], w[0]) < 5) { cur.reverse(); cur.push(...w.slice(1)); }
    else if (lines.length === 0 && cur.length && haversine(cur[0], w[w.length - 1]) < 5) { cur.reverse(); cur.push(...w.slice(0, -1).reverse()); }
    else { lines.push(cur); cur = [...w]; }   // szakadás a relációban: új darab
  }
  if (cur) lines.push(cur);
  return lines;
}

const _paths = new Map();
/** Egy jelzés adatai és nyomvonala: { id, ref, name, sym, length, lines: [[{lat,lng}]] } */
export function trailPath(id) {
  if (_paths.has(id)) return _paths.get(id);
  const job = fetch(`${API}/details/relation/${id}`)
    .then((r) => { if (!r.ok) throw new Error(`Jelzés-adat hiba (${r.status})`); return r.json(); })
    .then((d) => {
      const ways = [];
      flatten(d.route, ways);
      return { id: d.id, ref: d.ref || "", name: d.name || "", sym: d.symbol_id || "", length: d.route?.length || 0, lines: joinWays(ways) };
    })
    .catch((err) => { _paths.delete(id); throw err; });
  _paths.set(id, job);
  return job;
}

function nearestIdx(line, p) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < line.length; i++) { const d = haversine(line[i], p); if (d < bd) { bd = d; bi = i; } }
  return { i: bi, d: bd };
}

/**
 * A jelzés szakasza `from` és `to` között (mindkettőnek ON_TRAIL_M-en belül kell lennie
 * ugyanarra a darabra), a haladási iránynak megfelelő sorrendben – vagy null.
 */
export async function trailSection(id, from, to) {
  const t = await trailPath(id);
  let best = null;
  for (const line of t.lines) {
    const a = nearestIdx(line, from), b = nearestIdx(line, to);
    if (a.d > ON_TRAIL_M || b.d > ON_TRAIL_M || a.i === b.i) continue;
    if (!best || a.d + b.d < best.score) best = { score: a.d + b.d, pts: a.i < b.i ? line.slice(a.i, b.i + 1) : line.slice(b.i, a.i + 1).reverse() };
  }
  return best?.pts ?? null;
}

/** Útvonal-segédpontok a szakasz mentén (BRouter-kéréshez): kb. `step` m-enként, legfeljebb `max` db. */
export function sampleVias(pts, { step = 300, max = 80 } = {}) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += haversine(pts[i - 1], pts[i]);
  const gap = Math.max(step, len / max);
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += haversine(pts[i - 1], pts[i]);
    if (acc >= gap && i < pts.length - 1) { out.push(pts[i]); acc = 0; }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Egy pont vetülete a jelzésre (a legközelebbi töréspont) – „pont ide a jelzésen”. */
export async function snapToTrail(id, p) {
  const t = await trailPath(id);
  let best = null;
  for (const line of t.lines) { const n = nearestIdx(line, p); if (!best || n.d < best.d) best = { ...line[n.i], d: n.d }; }
  return best && best.d <= ON_TRAIL_M * 2 ? { lat: best.lat, lng: best.lng } : null;
}
