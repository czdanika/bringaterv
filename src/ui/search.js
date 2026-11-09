/** Település neve egy ponthoz (útvonal-javaslat elnevezéséhez); small: inkább kerület / településrész */
export async function reverseTown(lat, lng, small = false) {
  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("zoom", "13");
    const response = await fetch(url);
    if (!response.ok) return null;
    const a = (await response.json()).address || {};
    return small
      ? a.suburb || a.quarter || a.neighbourhood || a.city_district || a.village || a.hamlet || null
      : a.city || a.town || a.village || a.municipality || a.suburb || a.hamlet || null;
  } catch {
    return null;
  }
}

import { getToken } from "../auth.js";

// ── Útpont-nevek a szerveren (gyorsítótárral, a Nominatim 1 kérés/mp szabálya szerint) ──
// A böngészőből közvetlenül, sok ponttal a Nominatim letilt – a szerver sorban kérdez és megjegyzi.
const authHdr = () => { const t = getToken(); return t ? { Authorization: `Bearer ${t}` } : {}; };
let _serverGeoOk = true;

/** A szerveren már tárolt nevek egyszerre: [név | "" (nincs neve) | null (még nem ismert)] */
export async function cachedPlaceNames(points) {
  if (!_serverGeoOk || !getToken() || !points.length) return points.map(() => null);
  try {
    const res = await fetch("/api/geo/place-names", { method: "POST", headers: { "Content-Type": "application/json", ...authHdr() },
      body: JSON.stringify({ points: points.map((p) => [p.lat, p.lng]) }) });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()).names || points.map(() => null);
  } catch { return points.map(() => null); }
}

export async function reverseGeocode(lat, lng) {
  // 1. a szerver (tárolt név, vagy sorban lekérdezve)
  if (_serverGeoOk && getToken()) {
    try {
      const res = await fetch(`/api/geo/place-name?lat=${lat}&lng=${lng}`, { headers: authHdr() });
      if (res.ok) return (await res.json()).name || null;
      if (res.status === 404) _serverGeoOk = false;           // régi szerver – közvetlen lekérdezés
    } catch { /* hálózati hiba – próbáljuk közvetlenül */ }
  }
  // 2. közvetlenül a Nominatimtól (pl. régi szerver, nincs belépés)
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
