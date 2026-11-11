/**
 * Beltéri (GPS nélküli) edzés a kliensen: a szerver oszlopos adatsorából (`/api/routes/<id>/streams`,
 * routes-api/indoor.py) ugyanolyan „geometria” készül, mint a GPX-ből – csak koordináta nélkül
 * (lat / lng: null), és minden pont hordozza a saját távját (`dist`, méter). A távolságszámítók
 * (elevationProfile.buildDistances, rangeStats.trackDists) ezt használják, így a grafikonok, a
 * kijelölés, a részidők és a csúcsértékek beltéri edzésnél is működnek; a térkép helyén jelzés van.
 *
 *   indoorImport(data, entry) → { geometry, waypoints: [], sourcePointCount, meta }
 */

export const isIndoor = (r) => !!r?.indoor;
const MAX_POINTS = 3000;   // mint a GPX-nél: a grafikonokhoz ritkítva, a teljes sor a .full-ban

export function indoorImport(data, entry = {}) {
  const t = data?.t || [];
  const start = Date.parse(data?.start || entry.start_time || "") || Date.now();
  const col = (k) => data?.[k] || [];
  const d = col("d"), v = col("v_kmh"), hr = col("hr"), cad = col("cad"), p = col("p"), temp = col("temp");
  // táv: ha nincs távérzékelő, a sebességből összegezve; ha az sincs, 0 marad (csak időtengely)
  let cum = 0;
  const full = t.map((sec, i) => {
    if (d[i] != null) cum = d[i];
    else if (i > 0 && v[i] != null) cum += (v[i] / 3.6) * Math.max(0, sec - t[i - 1]);
    return {
      lat: null, lng: null, ele: null, indoor: true,
      time: start + sec * 1000, dist: cum,
      speed: v[i] ?? null, hr: hr[i] ?? null, cad: cad[i] ?? null, power: p[i] ?? null, temp: temp[i] ?? null,
    };
  });
  let geometry = full;
  if (full.length > MAX_POINTS) {
    const step = full.length / MAX_POINTS;
    geometry = Array.from({ length: MAX_POINTS }, (_, i) => full[Math.floor(i * step)]);
    geometry[geometry.length - 1] = full[full.length - 1];
    Object.defineProperty(geometry, "full", { value: full });
  }
  const totalMs = full.length ? full[full.length - 1].time - full[0].time : 0;
  const maxPower = p.reduce((m, x) => (x != null && x > m ? x : m), 0) || null;
  return {
    geometry,
    sourcePointCount: full.length,
    waypoints: [],
    meta: {
      name: entry.name || "Beltéri tekerés",
      type: (entry.sport_type || "cycling") === "running" ? "Beltéri futás" : "Beltéri kerékpározás",
      startTime: new Date(start).toISOString(),
      totalDuration: totalMs || null,
      movingDuration: entry.duration ? entry.duration * 60000 : totalMs || null,
      maxPower,
      indoor: true,
    },
  };
}
