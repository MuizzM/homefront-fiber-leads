/**
 * mapbox-addresses.ts
 * Harvest every residential address in Rockwell, NC using Mapbox Geocoding API.
 *
 * Strategy: dense grid across the TRUE Rockwell bbox (from Mapbox official boundaries)
 * → reverse geocode each point → deduplicate → return addresses with real coords.
 *
 * ROOT CAUSE FIX: Previous bbox (35.515–35.582 lat, -80.455 to -80.360 lng) was
 * cutting off significant portions of Rockwell including Bell Ridge Ct, Old Beatty
 * Ford Rd, Carter Hill Rd, and the entire south/west quadrant of the city.
 *
 * Mapbox official Rockwell bbox: [-80.551848, 35.457372, -80.363426, 35.578276]
 * We add a buffer on all sides to catch edge addresses.
 */

import { adaptiveGridStep } from "./bboxScan";

interface AddressResult {
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number;
  lng: number;
}

// TRUE Rockwell, NC bounding box — uses Mapbox official city boundary + buffer
// Confirmed edge: beyond these edges addresses switch to other zip codes (28083, 28025, 28071, 28023)
const ROCKWELL_BBOX = {
  minLng: -80.56, // Mapbox west edge -80.5518 + buffer (beyond = Kannapolis 28083)
  maxLng: -80.31, // Mapbox east edge -80.3634 + buffer (beyond = Gold Hill 28071)
  minLat: 35.45, // Mapbox south edge 35.4574 + buffer (beyond = Concord 28025)
  maxLat: 35.615, // Mapbox north edge 35.5783 + buffer (beyond = Salisbury 28146)
};

// Grid spacing: 0.0018° ≈ 200m apart (down from 0.0025°/250m)
// Denser grid catches rural houses on long roads between the old 250m points.
// Rural Rockwell roads (Stokes Ferry, Carter Hill, Old Beatty Ford) average
// one house every 80–150m — 200m grid hits each one at least once.
// Coverage: 0.250 lng / 0.0018 = 139 cols × 0.165 lat / 0.0018 = 92 rows = ~12,800 pts
// At 16 concurrent + 80ms delay = ~64 seconds for full harvest
const GRID_STEP = 0.0018;

// Mapbox geocoding: 600 req/min on public tokens → 10/sec comfortable
const MAPBOX_DELAY_MS = 80; // ~12/sec
const BATCH_SIZE = 16; // concurrent per batch

// Accept addresses from these zip codes (Rockwell + surrounding rural Rowan County)
// 28147 = Salisbury rural (some addresses on north edge use this zip)
const ROCKWELL_ZIPS = new Set(["28138", "28147", "28081", "28083", "28072"]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase().trim().replace(/[.,#]/g, "").replace(/\s+/g, " ");
}

export async function harvestRockwellAddresses(
  mapboxToken: string,
  onProgress?: (done: number, total: number, found: number) => void,
): Promise<AddressResult[]> {
  const { minLng, maxLng, minLat, maxLat } = ROCKWELL_BBOX;

  // Build full grid
  const gridPoints: [number, number][] = [];
  for (let lat = minLat; lat <= maxLat; lat += GRID_STEP) {
    for (let lng = minLng; lng <= maxLng; lng += GRID_STEP) {
      gridPoints.push([+lng.toFixed(5), +lat.toFixed(5)]);
    }
  }

  const seen = new Map<string, AddressResult>();
  let done = 0;

  // Process in batches
  for (let i = 0; i < gridPoints.length; i += BATCH_SIZE) {
    const batch = gridPoints.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async ([lng, lat]) => {
        const url =
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
          `?access_token=${mapboxToken}&types=address&limit=5&country=US`;
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) return;
          const data = await res.json();

          for (const feature of data.features ?? []) {
            const placeName: string = feature.place_name ?? "";
            const parts = placeName.split(",").map((s: string) => s.trim());
            const streetAddress = parts[0] ?? "";

            // Must be a real street address (starts with house number)
            if (!/^\d+/.test(streetAddress)) continue;

            // Extract zip from place_name
            const zipMatch = placeName.match(/\b(\d{5})\b/);
            const zip = zipMatch ? zipMatch[1] : "";

            // Must be a Rockwell-area zip OR mention Rockwell/NC in name
            const isRockwellArea =
              ROCKWELL_ZIPS.has(zip) ||
              placeName.toLowerCase().includes("rockwell") ||
              (placeName.toLowerCase().includes("north carolina") &&
                zip.startsWith("281"));

            if (!isRockwellArea) continue;

            // Deduplicate by normalized street address
            const normalized = normalizeAddress(streetAddress);
            if (!normalized || seen.has(normalized)) continue;

            // Parse city
            const cityPart = parts[1] ?? "Rockwell";
            const city = cityPart.replace(/\s+North Carolina.*/, "").trim();

            seen.set(normalized, {
              address: streetAddress,
              city: city || "Rockwell",
              state: "NC",
              zip: zip || "28138",
              lat: feature.center[1],
              lng: feature.center[0],
            });
          }
        } catch {
          // timeout or network error — skip this point
        }
        done++;
      }),
    );

    onProgress?.(done, gridPoints.length, seen.size);
    await sleep(MAPBOX_DELAY_MS);
  }

  return Array.from(seen.values());
}

export function getRockwellGridSize(): number {
  const { minLng, maxLng, minLat, maxLat } = ROCKWELL_BBOX;
  let count = 0;
  for (let lat = minLat; lat <= maxLat; lat += GRID_STEP) {
    for (let lng = minLng; lng <= maxLng; lng += GRID_STEP) {
      count++;
    }
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic city harvester — works for ANY city across the USA
// Uses Mapbox Geocoding to get bbox, then dense reverse-geocoding grid
// ─────────────────────────────────────────────────────────────────────────────

export interface CityScanMeta {
  addresses: AddressResult[];
  cityName: string;
  center: [number, number];
  bbox: { south: number; west: number; north: number; east: number };
  gridPoints: number;
}

/**
 * Harvest every residential address in any US city via Mapbox reverse-geocoding grid.
 *
 * For large cities (>5000 km²), grid step is coarser (0.006°) to keep runtime reasonable.
 * For small cities (<100 km²), grid step is 0.0015° (fine-grained like Rockwell).
 * For medium cities, grid step is 0.003°.
 *
 * At 100 concurrent + 30ms batch delay → ~3,333 checks/sec.
 */
export async function harvestCityAddresses(
  city: string,
  state: string,
  mapboxToken: string,
  onProgress?: (done: number, total: number, found: number) => void,
): Promise<CityScanMeta> {
  // Step 1: Geocode city → bbox
  const geoUrl =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(`${city}, ${state}`)}.json` +
    `?access_token=${mapboxToken}&types=place,locality,neighborhood&country=us&limit=1`;

  const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(12000) });
  if (!geoRes.ok) throw new Error(`Mapbox geocoding failed: ${geoRes.status}`);
  const geoData = await geoRes.json();
  if (!geoData.features?.length)
    throw new Error(`City not found: "${city}, ${state}"`);

  const feature = geoData.features[0];
  const center: [number, number] = [feature.center[0], feature.center[1]];

  let bbox: { south: number; west: number; north: number; east: number };
  if (feature.bbox && feature.bbox.length === 4) {
    const [west, south, east, north] = feature.bbox;
    const latPad = (north - south) * 0.12;
    const lngPad = (east - west) * 0.12;
    bbox = {
      south: south - latPad,
      north: north + latPad,
      west: west - lngPad,
      east: east + lngPad,
    };
  } else {
    // No bbox — use ~4 mile buffer
    const [lng, lat] = feature.center;
    bbox = {
      south: lat - 0.065,
      north: lat + 0.065,
      west: lng - 0.075,
      east: lng + 0.075,
    };
  }

  // Step 2: Choose grid density based on city size
  const latSpan = bbox.north - bbox.south;
  const lngSpan = bbox.east - bbox.west;
  const approxKm2 = latSpan * lngSpan * 111 * 111; // very rough

  let gridStep: number;
  if (approxKm2 > 5000) {
    gridStep = 0.006; // large metro — coarser grid, still catches major neighborhoods
  } else if (approxKm2 > 500) {
    gridStep = 0.0025; // medium city
  } else {
    gridStep = 0.0015; // small city / suburb — dense like Rockwell
  }

  // Step 3: Build grid
  const gridPoints: [number, number][] = [];
  for (let lat = bbox.south; lat <= bbox.north; lat += gridStep) {
    for (let lng = bbox.west; lng <= bbox.east; lng += gridStep) {
      gridPoints.push([+lng.toFixed(5), +lat.toFixed(5)]);
    }
  }

  // ── HARD COST CAP ────────────────────────────────────────────────────────────
  // Every grid point is one billable Mapbox geocoding request. Refuse runaway
  // harvests outright — a single uncapped metro grid can be 50k–500k requests.
  // (Raise via MAPBOX_HARVEST_CAP env if a bigger one-time harvest is truly wanted.)
  const HARVEST_CAP = Number(process.env.MAPBOX_HARVEST_CAP ?? 5000);
  if (gridPoints.length > HARVEST_CAP) {
    throw new Error(
      `Harvest for "${city}, ${state}" would cost ${gridPoints.length.toLocaleString()} Mapbox geocoding requests ` +
        `(cap: ${HARVEST_CAP.toLocaleString()}). Use the free Overpass/pool sources, scan a smaller drawn area, ` +
        `or raise MAPBOX_HARVEST_CAP if you accept the cost.`,
    );
  }
  console.log(
    `[mapbox-harvest] ${city}, ${state}: ${gridPoints.length} geocoding requests (cap ${HARVEST_CAP})`,
  );

  // Step 4: Reverse-geocode grid in batches of 30 (faster than Rockwell's 16)
  const BATCH = 30;
  const DELAY = 50; // 50ms — ~600 grid points/sec
  const seen = new Map<string, AddressResult>();
  let done = 0;

  for (let i = 0; i < gridPoints.length; i += BATCH) {
    const batch = gridPoints.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async ([lng, lat]) => {
        const url =
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
          `?access_token=${mapboxToken}&types=address&limit=5&country=US`;
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) return;
          const data = await res.json();
          for (const feat of data.features ?? []) {
            const placeName: string = feat.place_name ?? "";
            const parts = placeName.split(",").map((s: string) => s.trim());
            const streetAddress = parts[0] ?? "";
            if (!/^\d+/.test(streetAddress)) continue;
            const zipMatch = placeName.match(/\b(\d{5})\b/);
            const zip = zipMatch ? zipMatch[1] : "";
            const normalized = streetAddress
              .toLowerCase()
              .trim()
              .replace(/[.,#]/g, "")
              .replace(/\s+/g, " ");
            if (!normalized || seen.has(normalized)) continue;
            const cityPart = parts[1] ?? city;
            const parsedCity = cityPart
              .replace(/\s+North Carolina.*/i, "")
              .replace(/\s+[A-Z]{2}$/i, "")
              .trim();
            seen.set(normalized, {
              address: streetAddress,
              city: parsedCity || city,
              state,
              zip: zip || "",
              lat: feat.center[1],
              lng: feat.center[0],
            });
          }
        } catch {}
        done++;
      }),
    );
    onProgress?.(done, gridPoints.length, seen.size);
    await sleep(DELAY);
  }

  return {
    addresses: Array.from(seen.values()),
    cityName: feature.place_name.split(",")[0] || city,
    center,
    bbox,
    gridPoints: gridPoints.length,
  };
}

// ── Count grid points for an arbitrary bbox (cost preview, no API calls) ──────
// Every grid point is one billable reverse-geocode. Lets the UI show the exact
// cost before an admin commits to a deep harvest.
export function bboxGridSize(
  bbox: { south: number; north: number; west: number; east: number },
  step = 0.0012,
): number {
  let n = 0;
  for (let lat = bbox.south; lat <= bbox.north; lat += step)
    for (let lng = bbox.west; lng <= bbox.east; lng += step) n++;
  return n;
}

// ── Deep-harvest EVERY address inside a drawn box via the Mapbox grid ─────────
// This is the "full coverage / precise hits" path: it finds real addresses that
// free OpenStreetMap doesn't have. The caller draws a TIGHT box over the homes,
// so the grid stays small (a 2.5km box ≈ 450 points) and cheap — reverse-geocode
// with limit=5 means each point returns its ~5 nearest houses, so 130m spacing
// catches essentially every home. Capped like the city harvest.
export async function harvestBboxAddresses(
  bbox: { south: number; north: number; west: number; east: number },
  state: string,
  mapboxToken: string,
  onProgress?: (done: number, total: number, found: number) => void,
  step?: number, // omit → adaptive (dense for a tight box, capped for a big one)
  signal?: AbortSignal,
): Promise<AddressResult[]> {
  const HARVEST_CAP = Number(process.env.MAPBOX_HARVEST_CAP ?? 5000);

  // Adaptive spacing: a tight box drawn over one new street used to sample only
  // 1–2 points at the old fixed 0.0012° step, and the geocoder's nearest hits
  // landed just outside the box and were filtered out → zero results. Sample the
  // short side densely; the cap keeps a big box from exploding the call count.
  const gridStep =
    step ??
    adaptiveGridStep(bbox, { minSamplesPerSide: 6, maxPoints: HARVEST_CAP });

  const gridPoints: [number, number][] = [];
  for (let lat = bbox.south; lat <= bbox.north; lat += gridStep)
    for (let lng = bbox.west; lng <= bbox.east; lng += gridStep)
      gridPoints.push([+lng.toFixed(5), +lat.toFixed(5)]);

  if (gridPoints.length > HARVEST_CAP) {
    throw new Error(
      `That box needs ${gridPoints.length.toLocaleString()} Mapbox reverse-geocode calls ` +
        `(cap: ${HARVEST_CAP.toLocaleString()}). Draw a smaller box.`,
    );
  }
  // A reverse-geocode returns the nearest house to a grid point, which can sit
  // just outside a tight box; keep addresses within one grid-step buffer so
  // edge houses (the whole point of a small subdivision box) aren't dropped.
  const pad = gridStep;
  console.log(
    `[deep-harvest] box grid: ${gridPoints.length} reverse-geocode requests (step ${gridStep.toFixed(5)}°, pad ${pad.toFixed(5)}°)`,
  );

  const BATCH = Math.max(
    1,
    Math.min(12, Number(process.env.MAPBOX_REVERSE_CONCURRENCY) || 6),
  );
  const DELAY = Math.max(
    50,
    Number(process.env.MAPBOX_REVERSE_BATCH_DELAY_MS) || 150,
  );
  const seen = new Map<string, AddressResult>();
  let done = 0;
  for (let i = 0; i < gridPoints.length; i += BATCH) {
    if (signal?.aborted)
      throw signal.reason ?? new Error("Mapbox address harvest cancelled");
    const batch = gridPoints.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async ([lng, lat]) => {
        const url =
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
          `?access_token=${mapboxToken}&types=address&limit=5&country=US`;
        try {
          const timeout = AbortSignal.timeout(8_000);
          const requestSignal =
            signal && typeof AbortSignal.any === "function"
              ? AbortSignal.any([signal, timeout])
              : timeout;
          const res = await fetch(url, { signal: requestSignal });
          if (res.status === 401 || res.status === 403) {
            throw new Error(
              `MAPBOX_ACCESS_DENIED: address enumeration stopped (${res.status})`,
            );
          }
          if (res.status === 429) {
            throw new Error(
              "MAPBOX_RATE_LIMITED: address enumeration stopped and may be retried later",
            );
          }
          if (!res.ok)
            throw new Error(
              `MAPBOX_HTTP_${res.status}: reverse geocode failed`,
            );
          const data = await res.json();
          for (const feat of data.features ?? []) {
            const placeName: string = feat.place_name ?? "";
            const parts = placeName.split(",").map((s: string) => s.trim());
            const streetAddress = parts[0] ?? "";
            if (!/^\d+/.test(streetAddress)) continue;
            const zipMatch = placeName.match(/\b(\d{5})\b/);
            const zip = zipMatch ? zipMatch[1] : "";
            const key = normalizeAddress(streetAddress);
            if (!key || seen.has(key)) continue;
            const cityPart = (parts[1] ?? "")
              .replace(/\s+North Carolina.*/i, "")
              .replace(/\s+[A-Z]{2}$/i, "")
              .trim();
            // keep addresses inside the drawn box + a one-step buffer, so a house
            // the geocoder pins just past a tight box edge still counts.
            if (
              feat.center[1] < bbox.south - pad ||
              feat.center[1] > bbox.north + pad ||
              feat.center[0] < bbox.west - pad ||
              feat.center[0] > bbox.east + pad
            )
              continue;
            seen.set(key, {
              address: streetAddress,
              city: cityPart || "",
              state,
              zip,
              lat: feat.center[1],
              lng: feat.center[0],
            });
          }
        } catch (error: any) {
          if (
            signal?.aborted ||
            /^MAPBOX_(ACCESS_DENIED|RATE_LIMITED|HTTP_)/.test(
              String(error?.message),
            )
          )
            throw error;
        }
        done++;
      }),
    );
    onProgress?.(done, gridPoints.length, seen.size);
    await sleep(DELAY);
  }
  return Array.from(seen.values());
}
