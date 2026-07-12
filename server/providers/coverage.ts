// ── coverage — measure how complete our address enumeration is ────────────────
// Pure, deterministic. Turns the raw provider results into a CoverageReport: the
// merged address set + the headline coverageRatio + a classification + the list
// of addresses the PRIMARY enumerator would have missed (the fresh new-builds).
// If a gap is real, this makes it VISIBLE instead of silently shipping a scan
// that skipped a subdivision.

import {
  type BBox, type ProviderResult, type CoverageReport, type MergedAddress,
  classifyCoverage,
} from "./types";
import { mergeAddresses, addressKeySet, normalizeAddressKey } from "./mergeAddresses";

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Build a coverage report from every provider's result for one bbox.
 *
 * Denominator ("known to exist"): the union of USABLE authoritative sources
 * (parcel/rooftop that returned ok and NOT partial). If none is usable, we fall
 * back to the merged union and mark the ratio `estimated` — honest about the
 * uncertainty rather than pretending a partial geocode is ground truth.
 *
 * coverageRatio = (known addresses the PRIMARY captured) / (known addresses).
 * newBuildCandidates = merged addresses the primary missed — the leads a plain
 * primary-only scan would skip.
 */
export function buildCoverageReport(bbox: BBox, results: ProviderResult[]): CoverageReport {
  const merged = mergeAddresses(results);

  const authoritative = results.filter(
    (r) => r.coverageClass === "authoritative" && !r.error && !r.partial && r.addresses.length > 0,
  );
  const primary = results.find((r) => r.coverageClass === "primary" && !r.error);
  // A primary must actually have RUN and returned data to measure its coverage. A
  // Mapbox timeout/cap (error, 0 addresses) or an excluded-Mapbox free preview
  // means primary coverage is UNKNOWN — not 0% and not "all new builds".
  const primaryRan = !!primary && !primary.error && primary.addresses.length > 0;

  const primarySet = primary ? addressKeySet(primary.addresses) : new Set<string>();

  // Denominator.
  let knownSet: Set<string>;
  let estimated: boolean;
  if (authoritative.length > 0) {
    knownSet = new Set<string>();
    for (const r of authoritative) for (const k of addressKeySet(r.addresses)) knownSet.add(k);
    estimated = false;
  } else {
    // No trustworthy full-coverage source — use the merged union as the best
    // available estimate of "what exists", and say so.
    knownSet = new Set(merged.map((m) => normalizeAddressKey(m.address)));
    estimated = true;
  }

  const knownCount = knownSet.size;
  // How many known addresses the primary enumerator actually captured.
  let primaryCount = 0;
  for (const k of knownSet) if (primarySet.has(k)) primaryCount++;

  // Ratio + classification measure PRIMARY coverage. If no primary ran, they are
  // unmeasured — report null/"unknown" instead of a confident, wrong "0% / none".
  const coverageRatio = !primaryRan ? null : (knownCount === 0 ? 0 : clamp01(primaryCount / knownCount));
  const classification: ReturnType<typeof classifyCoverage> | "unknown" = coverageRatio == null ? "unknown" : classifyCoverage(coverageRatio);

  // The actionable payload: addresses the primary would have skipped, freshest
  // first (not-in-any-authoritative = newest builds). Only meaningful when a
  // primary actually ran — otherwise "missed by primary" is vacuously everything.
  const authAll = new Set<string>();
  for (const r of authoritative) for (const k of addressKeySet(r.addresses)) authAll.add(k);
  const newBuildCandidates: MergedAddress[] = !primaryRan ? [] : merged
    .filter((m) => m.missedByPrimary)
    .sort((a, b) => Number(authAll.has(normalizeAddressKey(a.address))) - Number(authAll.has(normalizeAddressKey(b.address))));

  return {
    bbox,
    providers: results.map((r) => ({
      name: r.provider, coverageClass: r.coverageClass, count: r.addresses.length,
      ok: !r.error, partial: r.partial, ms: r.ms, error: r.error,
    })),
    merged,
    knownCount,
    primaryCount,
    primaryRan,
    coverageRatio,
    classification,
    newBuildCandidates,
    // Unknown primary coverage is also an "estimated"/uncertain state.
    estimated: estimated || !primaryRan,
  };
}
