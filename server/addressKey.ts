// Canonical address key — the ONE normalization used everywhere a lead or scan
// target needs a collision-safe identity (dedup, the leads UNIQUE index, the
// projector's attach-not-duplicate). Kept in its own dependency-free module so
// storage.ts (loaded first, at migration time) can use it without pulling in the
// heavy scanner module graph. scanner.ts re-exports these for existing callers.

const addressTokenAliases: Record<string, string> = {
  STREET: "ST", ST: "ST", ROAD: "RD", RD: "RD", AVENUE: "AVE", AVE: "AVE",
  DRIVE: "DR", DR: "DR", COURT: "CT", CT: "CT", LANE: "LN", LN: "LN",
  BOULEVARD: "BLVD", BLVD: "BLVD", HIGHWAY: "HWY", HWY: "HWY",
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W",
};

// Combining diacritical marks U+0300–U+036F (built from escapes so the source
// bytes are unambiguous across editors).
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");
export function canonicalAddressPart(value: string): string {
  return value.normalize("NFKD").replace(COMBINING_MARKS, "")
    .toUpperCase().replace(/[^A-Z0-9#]+/g, " ").trim().split(/\s+/)
    .filter(Boolean).map(token => addressTokenAliases[token] ?? token).join(" ");
}

export function normalizeKineticAddressKey(address: string, city: string, state: string, zip: string): string {
  return [canonicalAddressPart(address), canonicalAddressPart(city), canonicalAddressPart(state), String(zip).match(/\d{5}/)?.[0] ?? ""]
    .join("|");
}
