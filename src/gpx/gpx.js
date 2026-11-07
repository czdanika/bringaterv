const sportTypeMap = {
  cycling: "cycling",
  asphalt: "cycling",
  gravel:  "cycling",
  mtb:     "cycling",
  walking: "walking",
  hiking:  "hiking",
};

export function exportGpx({ waypoints, geometry, name = "Route4Me", desc = "", mode = "cycling" }) {
  const trackPoints = (geometry.length ? geometry : waypoints)
    .map((point) => {
      const ele = point.ele != null ? `\n        <ele>${point.ele.toFixed(1)}</ele>` : "";
      return `      <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lng.toFixed(7)}">${ele}\n      </trkpt>`;
    })
    .join("\n");

  const waypointNodes = waypoints
    .map((point, index) => {
      const label = escapeXml(point.name || `${index + 1}. pont`);
      const wptDesc = point.note ? `\n    <desc>${escapeXml(point.note)}</desc>` : "";
      // szakaszmód és követett turistajelzés (a következő pontig) – a saját tervek visszatöltéséhez
      const ext = (point.segmentMode ? `<bringaterv:segmentMode>${escapeXml(point.segmentMode)}</bringaterv:segmentMode>` : "")
        + (point.trail?.id ? `<bringaterv:trail>${escapeXml(JSON.stringify(point.trail))}</bringaterv:trail>` : "");
      const segExt  = ext ? `\n    <extensions>${ext}</extensions>` : "";
      return `  <wpt lat="${point.lat.toFixed(7)}" lon="${point.lng.toFixed(7)}">\n    <name>${label}</name>${wptDesc}${segExt}\n  </wpt>`;
    })
    .join("\n");

  const sport = sportTypeMap[mode] ?? "cycling";
  const metaDesc = desc ? `\n    <desc>${escapeXml(desc)}</desc>` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bringaterv" xmlns="http://www.topografix.com/GPX/1/1" xmlns:bringaterv="https://bringaterv.app/gpx/1">
  <metadata>
    <name>${escapeXml(name)}</name>${metaDesc}
  </metadata>
${waypointNodes}
  <trk>
    <name>${escapeXml(name)}</name>
    <type>${sport}</type>
    <trkseg>
${trackPoints}
    </trkseg>
  </trk>
</gpx>`;
}

// Régebbi (és más appokból jövő) angol pontnevek magyarul
const NAME_HU = { start: "Rajt", finish: "Cél", end: "Cél", destination: "Cél" };
function localizeName(n) {
  const t = (n || "").trim();
  return NAME_HU[t.toLowerCase()] ?? t;
}

export function downloadGpx(filename, content) {
  const blob = new Blob([content], { type: "application/gpx+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function importGpx(file, { sampleWaypoints = false } = {}) {
  const xml = await file.text();
  const documentXml = new DOMParser().parseFromString(xml, "application/xml");
  const parserError = documentXml.querySelector("parsererror");
  if (parserError) throw new Error("Invalid GPX");

  const routePoints = [...documentXml.getElementsByTagNameNS("*", "rtept")];
  const trackPoints = [...documentXml.getElementsByTagNameNS("*", "trkpt")];
  const waypointNodes = [...documentXml.getElementsByTagNameNS("*", "wpt")];
  const routeGeometry = nodesToPoints(routePoints);
  const trackGeometry = nodesToPoints(trackPoints);
  const geometry = routeGeometry.length ? routeGeometry : trackGeometry;
  const namedWaypoints = nodesToPoints(waypointNodes);
  const waypoints = namedWaypoints.length
    ? namedWaypoints
    : summarizeGeometryAsWaypoints(geometry, sampleWaypoints ? 12 : 0);

  const geometryWithSpeed = calcSpeedForGeometry(geometry);
  const simplifiedGeometry = simplifyGeometry(geometryWithSpeed);

  // Metadata
  const metaName = documentXml.querySelector("metadata > name")?.textContent?.trim() || null;
  const metaDesc = documentXml.querySelector("metadata > desc")?.textContent?.trim() || null;
  const trkName  = documentXml.getElementsByTagNameNS("*", "trk")[0]
                    ?.querySelector("name")?.textContent?.trim() || null;
  const trkType  = documentXml.getElementsByTagNameNS("*", "trk")[0]
                    ?.querySelector("type")?.textContent?.trim() || null;
  const activityName = metaName || trkName || null;
  const activityType = trkType || null;
  const activityDesc = metaDesc || null;

  // Felszerelés (eszköz, bringa, szenzorok) – a saját FIT → GPX-ünk a metaadatba írja
  let equipment = null;
  try {
    const eqNode = documentXml.getElementsByTagNameNS("*", "equipment")[0];
    if (eqNode) equipment = JSON.parse(eqNode.textContent);
  } catch { /* sérült – nem baj */ }

  // Timing from raw geometry (before simplification)
  const timing = calcTiming(geometryWithSpeed);
  // Csúcsteljesítmény a ritkítás ELŐTT – a rövid (1–2 mp-es) tüske a ritkított geometriából kieshet
  let maxPower = null;
  for (const p of geometry) if (p.power != null && (maxPower == null || p.power > maxPower)) maxPower = p.power;

  return {
    geometry: simplifiedGeometry,
    sourcePointCount: geometry.length,
    waypoints,
    meta: {
      name: activityName,
      desc: activityDesc,
      type: activityType,
      startTime: timing.startTime,
      totalDuration: timing.totalDuration,
      movingDuration: timing.movingDuration,
      maxPower,
      equipment,
    },
  };
}

export function calcTiming(geometry) {
  const withTime = geometry.filter(p => p.time != null);
  if (withTime.length < 2) return { startTime: null, totalDuration: null, movingDuration: null };

  const startTime = withTime[0].time;
  const totalDuration = withTime[withTime.length - 1].time - startTime; // ms

  // Moving time: sum segments where speed > 0.5 km/h
  let movingMs = 0;
  for (let i = 1; i < withTime.length; i++) {
    const dt = withTime[i].time - withTime[i - 1].time;
    const speed = withTime[i].speed ?? withTime[i - 1].speed ?? null;
    if (dt > 0 && (speed == null || speed > 0.5)) movingMs += dt;
  }

  return { startTime, totalDuration, movingDuration: movingMs };
}

function nodesToPoints(nodes) {
  return nodes.map((node, index) => {
    const eleText = node.querySelector("ele")?.textContent;
    const ele = Number(eleText);
    const timeText = node.querySelector("time")?.textContent;
    // HR: Garmin uses <gpxtpx:hr>, namespace-agnostic query
    const hrNode = node.getElementsByTagNameNS("*", "hr")[0];
    const hr = hrNode ? Number(hrNode.textContent) : null;
    const cadNode = node.getElementsByTagNameNS("*", "cad")[0];
    const cad = cadNode ? Number(cadNode.textContent) : null;
    // Power: Garmin PowerExtension <gpxpx:PowerInWatts> (a saját FIT → GPX-ünk is ezt írja),
    // Garmin TrackPointExtension <ns3:watts> / <gpxtpx:watts>, más eszközök <power>
    const wattsNode = node.getElementsByTagNameNS("*", "PowerInWatts")[0]
                   || node.getElementsByTagNameNS("*", "watts")[0]
                   || node.getElementsByTagNameNS("*", "power")[0];
    const power = wattsNode ? Number(wattsNode.textContent) : null;
    const segModeNode = node.getElementsByTagNameNS("*", "segmentMode")[0];
    const segmentMode = segModeNode?.textContent?.trim() || null;
    let trail = null;
    try { trail = JSON.parse(node.getElementsByTagNameNS("*", "trail")[0]?.textContent || "null"); } catch { /* sérült – nem baj */ }
    return {
      lat: Number(node.getAttribute("lat")),
      lng: Number(node.getAttribute("lon")),
      ele: Number.isFinite(ele) && eleText != null ? ele : null,
      time: timeText ? new Date(timeText).getTime() : null,
      hr: hr != null && Number.isFinite(hr) && hr > 0 ? hr : null,
      cad: cad != null && Number.isFinite(cad) && cad >= 0 ? cad : null,
      power: power != null && Number.isFinite(power) && power >= 0 ? power : null,
      name: localizeName(node.querySelector("name")?.textContent) || `${index + 1}. pont`,
      note: node.querySelector("desc")?.textContent || "",
      segmentMode,
      ...(trail?.id ? { trail } : {}),
    };
  }).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function calcSpeedForGeometry(geometry) {
  // 1. Nyers sebesség kiszámítása minden pontra
  const raw = geometry.map((pt, i) => {
    if (i === 0 || !pt.time || !geometry[i - 1].time) return { ...pt, speed: null };
    const dt = (pt.time - geometry[i - 1].time) / 1000;
    if (dt < 1) return { ...pt, speed: null };
    const prev = geometry[i - 1];
    const dLat = (pt.lat - prev.lat) * Math.PI / 180;
    const dLng = (pt.lng - prev.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(prev.lat * Math.PI / 180) * Math.cos(pt.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    const d = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return { ...pt, speed: Math.round((d / dt) * 3.6 * 10) / 10 };
  });

  // 2. Mozgó átlag simítás (7 pontos ablak) — kiszűri a GPS tüskéket, közelíti a Strava értékeket
  const WINDOW = 7;
  const half = Math.floor(WINDOW / 2);
  return raw.map((pt, i) => {
    if (pt.speed == null) return pt;
    const neighbors = raw.slice(Math.max(0, i - half), Math.min(raw.length, i + half + 1))
      .map(p => p.speed).filter(s => s != null);
    const smoothed = Math.round(neighbors.reduce((s, v) => s + v, 0) / neighbors.length * 10) / 10;
    return { ...pt, speed: smoothed };
  });
}

// 3 m-es hiszterézissel (mint a grafikon összesítője): a magassági adat apró zaja nem
// számít emelkedésnek – a nyers összeg zajos nyomvonalon a valósnál jóval több
export function calcElevationFromGeometry(geometry) {
  let ascent = 0, descent = 0, base = null;
  for (const p of geometry) {
    const v = p.ele;
    if (v == null) continue;
    if (base == null) { base = v; continue; }
    if (v - base >= 3) { ascent += v - base; base = v; }
    else if (base - v >= 3) { descent += base - v; base = v; }
  }
  return { ascentMeters: Math.round(ascent), descentMeters: Math.round(descent) };
}

function summarizeGeometryAsWaypoints(geometry, sampleCount = 0) {
  if (!geometry.length) return [];
  if (geometry.length === 1) return [{ ...geometry[0], name: "Rajt" }];
  if (sampleCount > 2) {
    const count = Math.min(sampleCount, geometry.length);
    const step = (geometry.length - 1) / (count - 1);
    return Array.from({ length: count }, (_, i) => {
      const pt = geometry[Math.round(i * step)];
      return { ...pt, name: `${i + 1}. pont` };
    });
  }
  return [
    { ...geometry[0], name: "Rajt" },
    { ...geometry[geometry.length - 1], name: "Cél" },
  ];
}

function simplifyGeometry(geometry, maxPoints = 3000) {
  if (geometry.length <= maxPoints) return geometry;
  const lastIndex = geometry.length - 1;
  const step = lastIndex / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => geometry[Math.round(index * step)]);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
