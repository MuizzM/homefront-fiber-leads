// ── Provider registry + coverage orchestration ────────────────────────────────
// One entry point: give it a bbox, it runs every AVAILABLE provider (in parallel),
// merges them, and hands back a CoverageReport that says how complete we are and
// exactly which addresses the primary enumerator would have missed.
import type { AddressProvider, BBox, EnumerateOpts, ProviderName, ProviderResult, CoverageReport } from "./types";
import { buildCoverageReport } from "./coverage";
import { parcelProvider } from "./parcelProvider";
import { rooftopProvider } from "./rooftopProvider";
import { mapboxProvider } from "./mapboxProvider";
import { overpassProvider } from "./overpassProvider";

export * from "./types";
export { mergeAddresses, normalizeAddressKey, addressKeySet } from "./mergeAddresses";
export { buildCoverageReport } from "./coverage";
export { parcelProvider, rooftopProvider, mapboxProvider, overpassProvider };

// Registry in PRECISION order (best coords first). mergeAddresses re-sorts anyway,
// but keeping the list ordered makes the intent obvious.
export const PROVIDERS: AddressProvider[] = [rooftopProvider, parcelProvider, mapboxProvider, overpassProvider];

export interface GatherOpts extends EnumerateOpts {
  /** Restrict to these providers (e.g. omit "mapbox" for a free, no-cost preview). */
  include?: ProviderName[];
}

/**
 * Enumerate a bbox across all available providers and build the coverage report.
 * Providers run concurrently; a provider that throws is recorded as errored
 * rather than sinking the whole gather (we always return the best we got).
 */
export async function gatherCoverage(bbox: BBox, opts: GatherOpts = {}): Promise<CoverageReport> {
  const chosen = PROVIDERS.filter((p) => {
    if (opts.include && !opts.include.includes(p.name)) return false;
    return p.available();
  });

  const settled = await Promise.allSettled(chosen.map((p) => p.enumerate(bbox, opts)));
  const results: ProviderResult[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    const p = chosen[i];
    return { provider: p.name, coverageClass: p.coverageClass, addresses: [], partial: true, error: String((s as PromiseRejectedResult).reason?.message ?? s.reason), ms: 0 };
  });

  return buildCoverageReport(bbox, results);
}

/** Which providers can run right now (for UI / diagnostics). */
export function providerStatus(): Array<{ name: ProviderName; coverageClass: string; available: boolean }> {
  return PROVIDERS.map((p) => ({ name: p.name, coverageClass: p.coverageClass, available: p.available() }));
}
