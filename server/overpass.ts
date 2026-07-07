/**
 * Overpass API + Mapbox Geocoding — City-wide Address Puller
 *
 * Flow:
 *   1. Mapbox geocoding: "Rockwell, NC" → bounding box (south, west, north, east)
 *   2. Overpass API: all addr:housenumber + addr:street nodes in bbox
 *   3. Returns structured address list ready for Kinetic scanning
 *
 * This is how FiberFocus pulls city-wide address lists — we use the same
 * approach but also include Census block data from the API where available.
 */

export interface OverpassAddress {
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number;
  lng: number;
}

interface MapboxFeature {
  bbox?: number[]; // [west, south, east, north]
  center: number[];
  place_name: string;
  context?: { id: string; text: string }[];
}

/**
 * Geocode a city name via Mapbox → returns bounding box
 */
export async function geocodeCity(city: string, state: string): Promise<{
  bbox: { south: number; west: number; north: number; east: number };
  center: [number, number];
  name: string;
} | null> {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error("MAPBOX_TOKEN not configured");

  const query = encodeURIComponent(`${city}, ${state}`);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${token}&types=place,locality,neighborhood&country=us&limit=1`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Mapbox geocoding failed: ${res.status}`);

  const data = await res.json();
  if (!data.features || data.features.length === 0) return null;

  const feature: MapboxFeature = data.features[0];

  // bbox from feature or compute from center with ~5 mile buffer
  let bbox: { south: number; west: number; north: number; east: number };
  if (feature.bbox && feature.bbox.length === 4) {
    // Mapbox bbox is [west, south, east, north]
    bbox = {
      west:  feature.bbox[0],
      south: feature.bbox[1],
      east:  feature.bbox[2],
      north: feature.bbox[3],
    };
    // Expand bbox by 10% to catch edge addresses
    const latPad = (bbox.north - bbox.south) * 0.1;
    const lngPad = (bbox.east - bbox.west) * 0.1;
    bbox.south -= latPad;
    bbox.north += latPad;
    bbox.west  -= lngPad;
    bbox.east  += lngPad;
  } else {
    // No bbox — use ~3 mile buffer around center point
    const [lng, lat] = feature.center;
    const latDelta = 0.05; // ~3.5 miles
    const lngDelta = 0.06;
    bbox = { south: lat - latDelta, north: lat + latDelta, west: lng - lngDelta, east: lng + lngDelta };
  }

  return {
    bbox,
    center: [feature.center[0], feature.center[1]],
    name: feature.place_name,
  };
}

/**
 * Pull all residential addresses in a bounding box via Overpass API
 * Returns deduplicated list of OverpassAddress objects
 */
export async function pullAddressesFromOverpass(
  bbox: { south: number; west: number; north: number; east: number },
  cityName: string,
  stateName: string
): Promise<OverpassAddress[]> {
  const { south, west, north, east } = bbox;

  // Overpass QL — fetch all nodes and ways with house number + street
  const overpassQuery = `
[out:json][timeout:90];
(
  node["addr:housenumber"]["addr:street"](${south},${west},${north},${east});
  way["addr:housenumber"]["addr:street"](${south},${west},${north},${east});
);
out center;
`.trim();

  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(overpassQuery)}`,
    signal: AbortSignal.timeout(120000), // 2 min timeout for large cities
  });

  if (!res.ok) throw new Error(`Overpass API failed: ${res.status}`);

  const data = await res.json();
  const elements: any[] = data.elements ?? [];

  const seen = new Set<string>();
  const addresses: OverpassAddress[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    const houseNum = tags["addr:housenumber"] ?? "";
    const street   = tags["addr:street"] ?? "";
    if (!houseNum || !street) continue;

    const fullAddress = `${houseNum} ${street}`;
    const key = fullAddress.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // lat/lng: direct for nodes, center for ways
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!lat || !lng) continue;

    const city = tags["addr:city"] || cityName;
    const state = tags["addr:state"] || stateName;
    const zip   = tags["addr:postcode"] || "";

    addresses.push({ address: fullAddress, city, state, zip, lat, lng });
  }

  return addresses;
}

/**
 * Main entry: city + state → list of addresses ready for scanning
 */
export async function getCityAddresses(city: string, state: string): Promise<{
  addresses: OverpassAddress[];
  cityName: string;
  bbox: { south: number; west: number; north: number; east: number };
  center: [number, number];
}> {
  const geo = await geocodeCity(city, state);
  if (!geo) throw new Error(`City not found: "${city}, ${state}". Try a more specific name.`);

  const addresses = await pullAddressesFromOverpass(geo.bbox, city, state);

  return {
    addresses,
    cityName: geo.name,
    bbox: geo.bbox,
    center: geo.center,
  };
}
