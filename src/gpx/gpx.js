const sportTypeMap = {
  cycling: "cycling",
  walking: "hiking",
};

export function exportGpx({ waypoints, geometry, name = "Route4Me", mode = "cycling" }) {
  const trackPoints = (geometry.length ? geometry : waypoints)
    .map((point) => `      <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lng.toFixed(7)}"></trkpt>`)
    .join("\n");

  const waypointNodes = waypoints
    .map((point, index) => {
      const label = escapeXml(point.name || `Point ${index + 1}`);
      const desc = point.note ? `\n    <desc>${escapeXml(point.note)}</desc>` : "";
      return `  <wpt lat="${point.lat.toFixed(7)}" lon="${point.lng.toFixed(7)}">\n    <name>${label}</name>${desc}\n  </wpt>`;
    })
    .join("\n");

  const sport = sportTypeMap[mode] ?? "cycling";

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Route4Me" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escapeXml(name)}</name>
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

export function downloadGpx(filename, content) {
  const blob = new Blob([content], { type: "application/gpx+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function importGpx(file) {
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
    : summarizeGeometryAsWaypoints(geometry);

  return {
    geometry: simplifyGeometry(geometry),
    sourcePointCount: geometry.length,
    waypoints,
  };
}

function nodesToPoints(nodes) {
  return nodes.map((node, index) => ({
    lat: Number(node.getAttribute("lat")),
    lng: Number(node.getAttribute("lon")),
    name: node.querySelector("name")?.textContent || `Point ${index + 1}`,
    note: node.querySelector("desc")?.textContent || "",
  })).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function summarizeGeometryAsWaypoints(geometry) {
  if (!geometry.length) return [];
  if (geometry.length === 1) return [{ ...geometry[0], name: "Start" }];
  return [
    { ...geometry[0], name: "Start" },
    { ...geometry[geometry.length - 1], name: "Finish" },
  ];
}

function simplifyGeometry(geometry, maxPoints = 1200) {
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
