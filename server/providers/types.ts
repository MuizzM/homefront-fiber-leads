// ── Address-provider contracts ────────────────────────────────────────────────
// The keystone types for the multi-source address-coverage system. Its whole job
// is to make sure we NEVER miss a fresh new-fiber lead: no single source is
// complete (OpenStreetMap skips new construction, geocoders lag new streets,
// parcel files lag subdivisions still under review), so we enumerate several,
// MERGE them, and MEASURE the coverage so a gap is visible instead of silent.
//
// See docs/coverage-strategy.md for the "how we don't miss leads" rationale.

/** The common address shape every provider yields (matches AddressResult / OverpassAddress). */
export interface RawAddress {
  address: string;             // street line, e.g. "402 Nard Ln"
  city: string;
  state: string;
  zip: string;
  lat: number | null;
  lng: number | null;
}

export type ProviderName = "parcel" | "rooftop" | "mapbox" | "overpass";

/**
 * How a provider relates to ground truth:
 *  - "authoritative": county/rooftop records that define which addresses EXIST
 *    (the denominator for coverage). Parcels + rooftop points are the truth set.
 *  - "primary": the main working enumerator (Mapbox geocoding grid).
 *  - "fill": community data used only to fill remaining gaps (OpenStreetMap).
 */
export type CoverageClass = "authoritative" | "primary" | "fill";

/**
 * Coordinate/field precedence on a duplicate address — LOWER wins. Rooftop points
 * are the most precise, county parcels next (authoritative but centroid-ish),
 * then the Mapbox geocoder, then OSM. This is the "dedupe order" the test pins.
 */
export const PROVIDER_PRECISION: Record<ProviderName, number> = {
  rooftop: 0,
  parcel: 1,
  mapbox: 2,
  overpass: 3,
};

export interface BBox { south: number; north: number; west: number; east: number }

export interface ProviderResult {
  provider: ProviderName;
  coverageClass: CoverageClass;
  addresses: RawAddress[];
  /** true when the provider returned data but could not guarantee completeness
   *  (rate-limited, capped, timed out mid-scan). A partial full-coverage source
   *  must NOT be trusted as the denominator. */
  partial: boolean;
  /** set when the provider failed outright (no usable data). */
  error?: string;
  ms: number;
}

/** A provider enumerates every address it knows inside a bbox. Pure I/O boundary. */
export interface AddressProvider {
  name: ProviderName;
  coverageClass: CoverageClass;
  /** Whether this provider can run right now (token present, dataset loaded, …). */
  available(): boolean;
  enumerate(bbox: BBox, opts?: EnumerateOpts): Promise<ProviderResult>;
}

export interface EnumerateOpts {
  state?: string;
  city?: string;
  /** cost ceiling for paid providers (e.g. max Mapbox reverse-geocode calls). */
  maxCalls?: number;
  signal?: AbortSignal;
}

/** A merged address carries which providers contributed it + the winning source. */
export interface MergedAddress extends RawAddress {
  sources: ProviderName[];   // every provider that had this address
  primarySource: ProviderName; // the highest-precision provider (owns the coords)
  /** true when the Mapbox PRIMARY enumerator didn't have this address (only
   *  parcel/rooftop/overpass did) — i.e. a primary-only scan would skip it.
   *  Only meaningful when a primary provider actually ran (see report.primaryRan). */
  missedByPrimary: boolean;
}

// "unknown" = the primary enumerator didn't run (e.g. a free preview with Mapbox
// excluded), so primary coverage is unmeasured — NOT the same as 0%/"none".
export type CoverageClassification = "full" | "good" | "partial" | "sparse" | "none" | "unknown";

/** Thresholds for classifying coverageRatio. Exported so the test asserts them. */
export const COVERAGE_THRESHOLDS = {
  full: 0.95,   // ≥95% of known addresses captured
  good: 0.8,    // ≥80%
  partial: 0.5, // ≥50%
  // >0 but <0.5 → "sparse"; exactly 0 → "none"
} as const;

export function classifyCoverage(ratio: number): CoverageClassification {
  if (!(ratio > 0)) return "none";
  if (ratio >= COVERAGE_THRESHOLDS.full) return "full";
  if (ratio >= COVERAGE_THRESHOLDS.good) return "good";
  if (ratio >= COVERAGE_THRESHOLDS.partial) return "partial";
  return "sparse";
}

export interface CoverageReport {
  bbox: BBox;
  providers: Array<{ name: ProviderName; coverageClass: CoverageClass; count: number; ok: boolean; partial: boolean; ms: number; error?: string }>;
  merged: MergedAddress[];
  /** denominator: distinct addresses the authoritative sources say exist here.
   *  Falls back to the merged-union size when no authoritative source ran. */
  knownCount: number;
  /** how many of `knownCount` the PRIMARY enumerator (Mapbox) actually captured. */
  primaryCount: number;
  /** true when a primary provider actually ran and returned data. When false,
   *  coverageRatio is null and classification is "unknown" — we can't measure
   *  primary coverage, so we don't claim 0%. */
  primaryRan: boolean;
  /** primaryCount / knownCount, clamped 0..1 — or null when no primary ran. */
  coverageRatio: number | null;
  classification: CoverageClassification;
  /** addresses present in authoritative/fill sources but MISSED by the primary —
   *  the fresh new-builds the old OSM-only scan skipped. */
  newBuildCandidates: MergedAddress[];
  /** true when no authoritative source was available, so coverageRatio is an
   *  agreement estimate, not a true ratio (be honest about uncertainty). */
  estimated: boolean;
}
