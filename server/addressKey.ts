// Canonical address key — the ONE normalization used everywhere a lead or scan
// target needs a collision-safe identity (dedup, the leads UNIQUE index, the
// projector's attach-not-duplicate). Kept in its own dependency-free module so
// storage.ts (loaded first, at migration time) can use it without pulling in the
// heavy scanner module graph. scanner.ts re-exports these for existing callers.

// NORMALIZATION_VERSION — bump whenever the aliases below (or canonicalAddressPart)
// change in a way that alters existing keys. The leads migration re-keys and
// re-merges when the stored version is older, so "123 Oak Circle" and
// "123 Oak Cir" collapse to one pin the first boot after an alias expansion.
export const NORMALIZATION_VERSION = 2;

// SUFFIX-DOMINANT street-type folding only. Every variant maps to one canonical
// token so "N Main Street", "North Main St", "123 Oak Circle" and "123 Oak Cir"
// yield the same key. DELIBERATELY LIMITED to types that are almost exclusively
// used in the SUFFIX position: canonicalAddressPart maps tokens positionlessly,
// so folding a word that commonly appears MID-NAME (Ridge, Glen, Grove, Creek,
// Hollow, Hill, View, Valley…) would mangle "Oak Ridge Ct" → "Oak Rdg Ct". Those
// are intentionally excluded — the false-merge / surprise risk outweighs the
// rare dedup gain. Both the full word and the abbreviation fold to the abbrev.
const SUFFIXES: Array<[string, string[]]> = [
  ["ST", ["STREET", "STR"]], ["RD", ["ROAD"]], ["AVE", ["AVENUE", "AV"]],
  ["DR", ["DRIVE", "DRV"]], ["CT", ["COURT"]], ["LN", ["LANE"]],
  ["BLVD", ["BOULEVARD"]], ["HWY", ["HIGHWAY"]], ["PL", ["PLACE"]],
  ["TER", ["TERRACE", "TERR"]], ["CIR", ["CIRCLE", "CIRC"]], ["PKWY", ["PARKWAY", "PKY"]],
  ["WAY", ["WY"]], ["TRL", ["TRAIL"]], ["LOOP", []], ["PLZ", ["PLAZA"]],
  ["SQ", ["SQUARE"]], ["XING", ["CROSSING"]],
];
const DIRECTIONALS: Array<[string, string[]]> = [
  ["N", ["NORTH"]], ["S", ["SOUTH"]], ["E", ["EAST"]], ["W", ["WEST"]],
  ["NE", ["NORTHEAST"]], ["NW", ["NORTHWEST"]], ["SE", ["SOUTHEAST"]], ["SW", ["SOUTHWEST"]],
];
const UNITS: Array<[string, string[]]> = [
  ["APT", ["APARTMENT"]], ["STE", ["SUITE"]], ["BLDG", ["BUILDING"]],
  ["FL", ["FLOOR"]], ["RM", ["ROOM"]], ["DEPT", ["DEPARTMENT"]], ["UNIT", []],
];

const addressTokenAliases: Record<string, string> = {};
for (const [canon, variants] of [...SUFFIXES, ...DIRECTIONALS, ...UNITS]) {
  addressTokenAliases[canon] = canon;            // abbrev folds to itself
  for (const v of variants) addressTokenAliases[v] = canon;
}

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
