// ── Fringe expansion — completeness for address-first discovery ───────────────
// OSM (our free address source) lags brand-new construction: a subdivision built
// last month may have only a handful of its homes in OSM, or none. But Kinetic
// numbers houses sequentially on a street, and builds a block at once — so when we
// hit NEW FIBER at "160 Bald Eagle Dr", the rest of that build is "1xx Bald Eagle
// Dr" too. This module GENERATES the neighbor addresses to probe (via the verified
// street-address API), so one seed hit flood-fills the whole block and no fringe
// house slips through. Pure + deterministic → fully unit-testable.

export interface StreetAddress { number: number; street: string }

// Parse a street line into a leading house number + the rest. Returns null when
// there is no leading integer (PO boxes, rural routes, unparseable) — those can't
// be house-number-interpolated, so they're simply not expanded.
export function parseStreetAddress(line: string): StreetAddress | null {
  const m = /^\s*(\d{1,6})\s+(\S.*\S|\S)\s*$/.exec(String(line ?? ""));
  if (!m) return null;
  const number = parseInt(m[1], 10);
  const street = m[2].trim().replace(/\s+/g, " ");
  if (!Number.isFinite(number) || number <= 0 || !street) return null;
  return { number, street };
}

export const normAddr = (s: string): string => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// Neighbor house numbers around a hit, nearest-first, both sides of the street
// (covers both parities), staying positive. radius = how many house numbers out.
export function neighborNumbers(center: number, radius: number): number[] {
  const out: number[] = [];
  for (let d = 1; d <= radius; d++) {
    if (center + d > 0) out.push(center + d);
    if (center - d > 0) out.push(center - d);
  }
  return out;
}

export interface FringeCandidate { address: string; number: number; street: string }

// Given a hit's street line, produce the neighbor addresses to probe. `exclude`
// (normalized addresses already seen/queued) is filtered out so we never re-probe.
// Deterministic order: nearest house numbers first (a build radiates from the seed).
export function fringeCandidates(hitLine: string, radius: number, exclude?: Set<string>): FringeCandidate[] {
  const parsed = parseStreetAddress(hitLine);
  if (!parsed) return [];
  const out: FringeCandidate[] = [];
  for (const n of neighborNumbers(parsed.number, radius)) {
    const address = `${n} ${parsed.street}`;
    if (exclude?.has(normAddr(address))) continue;
    out.push({ address, number: n, street: parsed.street });
  }
  return out;
}
