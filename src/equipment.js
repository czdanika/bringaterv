/**
 * Bringaterv – felszerelés: rögzítő eszköz, bringa, szenzorok + a Felszerelés-tár
 * ===================================================================================
 * Az edzés felszerelését a szerver tölti az indexbe (FIT: file_id / bike_profile /
 * device_info; Strava: device_name + a választott bringa): device, bike_name, sensors,
 * power_meter, és a felhasználó kézi hozzárendelése: bike_id.
 *
 * Felszerelés-tár (szerver: /api/gear, Felszerelés főmenüpont): bringák, alkatrészek,
 * karbantartási feladatok és napló; a km-et és a feladatok állapotát a szerver számolja.
 * Egy edzés bringája: kézi bike_id → a bike_name egyezik egy bringa nevével / „más néven”
 * listájával → kerékpáros edzésnél az alapértelmezett bringa; különben a nyers bike_name.
 */

import { routesApi } from "./api/routesApi.js";


export const SENSOR_LABELS = {
  heart_rate: "Pulzus", power: "Wattmérő", cadence: "Kadencia", speed: "Sebesség",
  speed_cadence: "Seb./kadencia", radar: "Radar", light: "Lámpa", trainer: "Görgő",
  footpod: "Lépésszenzor", remote: "Távirányító", muscle_oxygen: "Izom-O₂", aero: "Aero",
};

export const BIKE_TYPES = { road: "Országúti", gravel: "Gravel", mtb: "MTB", trekking: "Túra / városi", tt: "Időfutam", indoor: "Görgő", other: "Egyéb" };

const norm = (s) => String(s ?? "").trim().toLowerCase();

// ── Felszerelés-tár (szerver: /api/gear – Felszerelés főmenüpont) ─────────────
// A felszerelés a szerveren él (gear.json), a km-et és a feladatok állapotát is a szerver
// számolja; itt csak gyorsítótár. A régi „Bringáim” (settings) első betöltéskor átköltözik.
let _gear = { bikes: [], components: [], logs: [] };
let _usage = null;
let _loading = null;

export function getGear() { return _gear; }
export function getGearUsage() { return _usage; }
export function getBikes() { return _gear?.bikes || []; }

function _apply(res) {
  if (!res?.gear) return;
  _gear = res.gear; _usage = res.usage || null;
  window.dispatchEvent(new CustomEvent("bringaterv:gearChanged"));
}

/** Betöltés (egyszer; force: újra). */
export function loadGear(force = false) {
  if (_loading && !force) return _loading;
  _loading = routesApi.gear.get().then(_apply).catch(() => { /* offline / régi szerver */ });
  return _loading;
}

/** A teljes dokumentum mentése; a szerver a friss km-et is visszaadja. */
export async function saveGear(doc) {
  _apply(await routesApi.gear.save(doc));
}

export async function markTaskDone(body) {
  _apply(await routesApi.gear.taskDone(body));
}

export function newBikeId() {
  return "b" + Math.random().toString(36).slice(2, 9);
}

/** Kerékpáros edzés-e (sport_type nélkül: igen – a kézi FIT / GPX jellemzően bringás).
 *  Ugyanaz, mint a szerveren (gear._is_cycling). */
export const isCycling = (e) => /cycl|ride|bike/.test(String(e?.sport_type || "cycling").toLowerCase());

/** Az edzés bringája: { id, name, bike } – bike a felszerelés-bejegyzés (vagy null).
 *  Sorrend (mint a szerveren, gear.resolve_bike): kézi bike_id → név / „más néven” →
 *  kerékpáros edzésnél (név nélkül) az alapértelmezett bringa. */
export function resolveBike(entry, bikes = getBikes()) {
  if (!entry) return null;
  if (entry.bike_id) {
    const b = bikes.find((x) => x.id === entry.bike_id);
    if (b) return { id: b.id, name: b.name, bike: b };
  }
  const n = norm(entry.bike_name);
  if (n) {
    const b = bikes.find((x) => norm(x.name) === n || (x.aliases || []).some((a) => norm(a) === n));
    return b ? { id: b.id, name: b.name, bike: b } : { id: null, name: entry.bike_name.trim(), bike: null };
  }
  const def = bikes.find((x) => x.is_default && !x.retired);
  return def && isCycling(entry) ? { id: def.id, name: def.name, bike: def } : null;
}

/** Rövid felirat: „Cube AIM EX · Apple Watch Series 7” (ami van). */
export function equipmentLine(entry, bikes) {
  const bike = resolveBike(entry, bikes)?.name;
  return [bike, entry?.device].filter(Boolean).join(" · ");
}

export function sensorLabels(entry) {
  return (entry?.sensors || []).map((k) => SENSOR_LABELS[k] || k);
}

/** Esedékes / közeli karbantartások (a szerver számolja) – a Kezdőlap jelzi. */
export function dueTasks() {
  return (_usage?.tasks || []).filter((t) => t.status !== "ok" && !t.retired);
}
