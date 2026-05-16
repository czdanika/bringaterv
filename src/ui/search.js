export async function reverseGeocode(lat, lng) {
  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("zoom", "18");
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return buildPlaceName(data.address);
  } catch {
    return null;
  }
}

function buildPlaceName(addr) {
  if (!addr) return null;
  const poi =
    addr.amenity ||
    addr.tourism ||
    addr.leisure ||
    addr.shop ||
    addr.historic ||
    addr.office ||
    addr.public_transport;
  const road = addr.road || addr.pedestrian || addr.path || addr.footway || addr.cycleway;
  const houseNumber = addr.house_number;

  if (poi && road) return `${poi} (${road})`;
  if (poi) return poi;
  if (road && houseNumber) return `${road} ${houseNumber}`;
  if (road) return road;
  return addr.suburb || addr.quarter || addr.neighbourhood || addr.village || addr.town || addr.city || null;
}

export async function searchPlaces(query, language) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("q", query);
  url.searchParams.set("accept-language", language);

  const response = await fetch(url);
  if (!response.ok) throw new Error("Search failed");
  const results = await response.json();

  return results.map((item) => ({
    name: item.display_name,
    lat: Number(item.lat),
    lng: Number(item.lon),
  }));
}
