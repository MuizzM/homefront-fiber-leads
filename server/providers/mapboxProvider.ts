// ── Mapbox provider (PRIMARY) ─────────────────────────────────────────────────
// The main working enumerator: a dense reverse-geocode grid over the bbox. It's
// the best single source for real houses INCLUDING new construction the parcel
// file and OpenStreetMap lag on (proven on Inman's new builds). Paid + capped,
// so it's the primary but never the only source.
import { harvestBboxAddresses } from "../mapbox-addresses";
import type { AddressProvider, BBox, EnumerateOpts, ProviderResult } from "./types";

function token(): string {
  return process.env.MAPBOX_TOKEN ?? process.env.MAPBOX_PUBLIC_TOKEN ?? "";
}

export const mapboxProvider: AddressProvider = {
  name: "mapbox",
  coverageClass: "primary",
  available: () => !!token(),
  async enumerate(bbox: BBox, opts: EnumerateOpts = {}): Promise<ProviderResult> {
    const t0 = Date.now();
    const base = { provider: "mapbox" as const, coverageClass: "primary" as const };
    const tk = token();
    if (!tk) return { ...base, addresses: [], partial: true, error: "MAPBOX_TOKEN not set", ms: 0 };
    try {
      const addresses = await harvestBboxAddresses(bbox, opts.state ?? "NC", tk);
      return { ...base, addresses, partial: false, ms: Date.now() - t0 };
    } catch (e: any) {
      // Over the harvest cap / timeout → we have no complete set for this bbox.
      return { ...base, addresses: [], partial: true, error: e?.message ?? "mapbox harvest failed", ms: Date.now() - t0 };
    }
  },
};
