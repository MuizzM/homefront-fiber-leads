import { adaptiveGridStep, type BboxLL } from "./bboxScan";
import { bboxGridSize } from "./mapbox-addresses";

export interface AreaAddressCandidate {
  address: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface ResolvedAreaAddress {
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number;
  lng: number;
}

export interface UnifiedAreaPlan {
  strategy: "unified";
  gridEnabled: boolean;
  gridPoints: number;
  gridStep: number;
  autoGridMaxPoints: number;
  harvestCap: number;
}

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Plan the invisible Mapbox augmentation for one field box.
 *
 * The 0.0012 degree ceiling keeps ordinary neighborhood boxes at roughly the
 * former Deep-scan density (~130m between samples, with five nearby addresses
 * returned per point). A box whose dense plan exceeds the automatic budget is
 * not silently coarsened into eligibility: mapped sources cover the larger area
 * and the paid grid is skipped.
 */
export function planUnifiedAreaScan(
  bbox: BboxLL,
  options: { hasMapboxToken: boolean; autoGridMaxPoints?: number; harvestCap?: number; ceilDeg?: number; minSamplesPerSide?: number },
): UnifiedAreaPlan {
  const harvestCap = positiveInt(options.harvestCap ?? 5000, 5000);
  const autoGridMaxPoints = Math.min(
    positiveInt(options.autoGridMaxPoints ?? 900, 900),
    harvestCap,
  );
  // Denser samples find more new-build rooftops OSM lacks. ceilDeg is the MAX
  // spacing (smaller = denser); an elected box passes a tighter ceiling.
  const ceilDeg = Number.isFinite(options.ceilDeg) && (options.ceilDeg as number) > 0 ? (options.ceilDeg as number) : 0.0012;
  const gridStep = adaptiveGridStep(bbox, {
    minSamplesPerSide: positiveInt(options.minSamplesPerSide ?? 6, 6),
    maxPoints: harvestCap,
    ceilDeg,
  });
  const gridPoints = bboxGridSize(bbox, gridStep);
  return {
    strategy: "unified",
    gridEnabled: options.hasMapboxToken && gridPoints <= autoGridMaxPoints,
    gridPoints,
    gridStep,
    autoGridMaxPoints,
    harvestCap,
  };
}

const SUFFIXES: Record<string, string> = {
  court: "ct", drive: "dr", street: "st", avenue: "ave",
  boulevard: "blvd", lane: "ln", road: "rd", place: "pl",
  circle: "cir", trail: "trl", way: "wy", terrace: "ter",
  parkway: "pkwy", highway: "hwy", loop: "lp",
};

export function normalizeAreaAddress(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[.,#]/g, "")
    .replace(/\s+/g, " ")
    .split(" ")
    .map(part => SUFFIXES[part] ?? part)
    .join(" ");
}

/**
 * Union source results deterministically. Earlier groups win coordinates while
 * later groups fill missing locality fields; suffix variants collapse to one
 * address before any provider qualification or database write.
 */
export function mergeAreaAddressSources(
  groups: readonly (readonly AreaAddressCandidate[])[],
  defaults: { city: string; state: string },
): ResolvedAreaAddress[] {
  const merged = new Map<string, ResolvedAreaAddress>();
  for (const group of groups) {
    for (const candidate of group) {
      const key = normalizeAreaAddress(candidate.address ?? "");
      if (!key || !Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lng)) continue;
      const current = merged.get(key);
      if (!current) {
        merged.set(key, {
          address: candidate.address,
          city: candidate.city || defaults.city,
          state: candidate.state || defaults.state,
          zip: candidate.zip || "",
          lat: candidate.lat as number,
          lng: candidate.lng as number,
        });
        continue;
      }
      merged.set(key, {
        address: current.address || candidate.address,
        city: current.city || candidate.city || defaults.city,
        state: current.state || candidate.state || defaults.state,
        zip: current.zip || candidate.zip || "",
        lat: current.lat,
        lng: current.lng,
      });
    }
  }
  return [...merged.values()];
}
