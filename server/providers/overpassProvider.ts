// ── Overpass provider (FILL-IN) ───────────────────────────────────────────────
// Free OpenStreetMap addresses inside the bbox. Great where OSM is mapped, but it
// SKIPS new construction (the whole reason this system exists) — so it only ever
// fills gaps the primary/authoritative sources leave, never defines coverage.
import { pullAddressesFromOverpass } from "../overpass";
import type { AddressProvider, BBox, EnumerateOpts, ProviderResult } from "./types";

export const overpassProvider: AddressProvider = {
  name: "overpass",
  coverageClass: "fill",
  available: () => true, // public Overpass — no key
  async enumerate(bbox: BBox, opts: EnumerateOpts = {}): Promise<ProviderResult> {
    const t0 = Date.now();
    const base = { provider: "overpass" as const, coverageClass: "fill" as const };
    try {
      const addresses = await pullAddressesFromOverpass(
        { south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east },
        opts.city ?? "", opts.state ?? "NC",
      );
      return { ...base, addresses, partial: false, ms: Date.now() - t0 };
    } catch (e: any) {
      // Public Overpass is flaky (429/timeout). Failing here is fine — it's fill.
      return { ...base, addresses: [], partial: true, error: e?.message ?? "overpass failed", ms: Date.now() - t0 };
    }
  },
};
