// ── mergeAddresses — union several providers into one deduped address set ──────
// Pure, deterministic, no I/O. Given each provider's raw list, produce one merged
// list where every real address appears once, carrying the coordinates of the
// highest-precision provider that had it and the full list of contributing
// sources. This is the "dedupe order" the coverage test pins.

import {
  type RawAddress, type MergedAddress, type ProviderResult,
  PROVIDER_PRECISION,
} from "./types";

// Street-suffix synonyms so "Bell Ridge Court" (parcel) dedupes against
// "Bell Ridge Ct" (geocoder). Kept small + common; unknown suffixes pass through.
const SUFFIX: Record<string, string> = {
  street: "st", st: "st",
  avenue: "ave", ave: "ave", av: "ave",
  drive: "dr", dr: "dr",
  road: "rd", rd: "rd",
  lane: "ln", ln: "ln",
  court: "ct", ct: "ct",
  circle: "cir", cir: "cir",
  boulevard: "blvd", blvd: "blvd",
  place: "pl", pl: "pl",
  terrace: "ter", ter: "ter",
  trail: "trl", trl: "trl",
  parkway: "pkwy", pkwy: "pkwy",
  highway: "hwy", hwy: "hwy",
  way: "way",
  north: "n", south: "s", east: "e", west: "w",
};

/** Canonical dedupe key: lowercase, strip punctuation, collapse spaces, fold
 *  common street-type + direction words to a single form. Exported for tests. */
export function normalizeAddressKey(address: string): string {
  const base = (address || "")
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return "";
  return base
    .split(" ")
    .map((w) => SUFFIX[w] ?? w)
    .join(" ");
}

/**
 * Merge provider results into a deduped, precedence-ordered address set.
 *
 * Precedence (PROVIDER_PRECISION, lower wins): rooftop → parcel → mapbox →
 * overpass. When two providers report the same address, the higher-precision
 * one owns the coordinates; every contributor is recorded in `sources`.
 * `missedByPrimary` marks an address no primary/authoritative source had — the
 * fresh/new-build addresses the main enumerator would skip.
 */
export function mergeAddresses(results: ProviderResult[]): MergedAddress[] {
  const byKey = new Map<string, MergedAddress>();
  // Deterministic processing order: best precision first, so the first write of
  // a key already holds the winning coords and later ones only add sources.
  const ordered = [...results].sort(
    (a, b) => PROVIDER_PRECISION[a.provider] - PROVIDER_PRECISION[b.provider],
  );

  for (const res of ordered) {
    for (const a of res.addresses) {
      const key = normalizeAddressKey(a.address);
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          ...a,
          sources: [res.provider],
          primarySource: res.provider,
          missedByPrimary: false, // recomputed below
        });
      } else {
        if (!existing.sources.includes(res.provider)) existing.sources.push(res.provider);
        // Fill missing coords from a later (lower-precision) source if the winner
        // lacked them — a real point beats no point.
        if ((existing.lat == null || existing.lng == null) && a.lat != null && a.lng != null) {
          existing.lat = a.lat; existing.lng = a.lng;
        }
        // Backfill empty city/zip from any source that has them.
        if (!existing.zip && a.zip) existing.zip = a.zip;
        if (!existing.city && a.city) existing.city = a.city;
      }
    }
  }

  // An address is "missed by primary" if the Mapbox primary enumerator never had
  // it (only parcel/rooftop/overpass did) — i.e. a plain primary scan would skip
  // it. That's the new-build signal.
  const merged = [...byKey.values()];
  for (const m of merged) m.missedByPrimary = !m.sources.includes("mapbox");
  return merged;
}

/** Distinct normalized-address set for a raw list — used by coverage math. */
export function addressKeySet(addrs: RawAddress[]): Set<string> {
  const s = new Set<string>();
  for (const a of addrs) {
    const k = normalizeAddressKey(a.address);
    if (k) s.add(k);
  }
  return s;
}
