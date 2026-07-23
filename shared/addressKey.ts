// Canonical address key — the ONE normalization used everywhere a lead or scan
// target needs a collision-safe identity (dedup, the leads UNIQUE index, the
// projector's attach-not-duplicate). Kept in its own dependency-free module so
// storage.ts (loaded first, at migration time) can use it without pulling in the
// heavy scanner module graph. scanner.ts re-exports these for existing callers.

// NORMALIZATION_VERSION — bump whenever the aliases below (or canonicalAddressPart)
// change in a way that alters existing keys. The leads migration re-keys and
// re-merges when the stored version is older, so "123 Oak Circle" and
// "123 Oak Cir" collapse to one pin the first boot after an alias expansion.
//
// v3 (2026-07): (a) "TR" now folds to TRL — forensics found confirmed duplicate
// fresh-lead pairs ("106 Poplar Tr" vs "106 Poplar Trl") whose keys differed
// only by this; (b) ZIP REMOVED from the key — a house's identity is
// addr|city|state. ZIP in the key split 62 real houses into two identities
// (53 of them a blank-zip OSM row vs a zip-full Kinetic row), each minting its
// own green pin and its own paid re-scans. Same street text + city + state with
// GENUINELY different zips is vanishingly rare (postal street names are unique
// within a city), and that failure mode is a merged pin (recoverable) versus
// today's duplicate pins + double spend (observed).
export const NORMALIZATION_VERSION = 3;

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
  ["WAY", ["WY"]], ["TRL", ["TRAIL", "TR"]], ["LOOP", []], ["PLZ", ["PLAZA"]],
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

// NOTE: `zip` is accepted for API compatibility but NO LONGER part of the key
// (v3) — see the version note above. One house = one key regardless of which
// pipeline (zip-less OSM harvest vs zip-full Kinetic echo) spelled it.
export function normalizeKineticAddressKey(address: string, city: string, state: string, _zip: string): string {
  return [canonicalAddressPart(address), canonicalAddressPart(city), canonicalAddressPart(state)]
    .join("|");
}

/**
 * The dedup key for a LEAD's UNIQUE(tenant_id, canonical_key) index — but NULL
 * when there is no reliable street address to key on.
 *
 * The plain key above joins address|city|state|zip, so a blank/garbage address
 * collapses to "|CHARLOTTE|NC|28202". Two DIFFERENT addresses that both lack a
 * usable street part would then share that key and the leads UNIQUE index would
 * MERGE them — silently destroying a real, distinct fresh lead. Under high-volume
 * pumping from noisy discovery sources, degenerate addresses are common enough
 * that this matters. Returning NULL for a keyless address disables dedup for it
 * (the partial index is `WHERE canonical_key IS NOT NULL`), so at worst we get a
 * duplicate pin — recoverable — instead of a lost lead — not.
 */
export function kineticLeadKeyOrNull(address: string, city: string, state: string, zip: string): string | null {
  if (canonicalAddressPart(address) === "") return null; // no street identity → do not dedup
  return normalizeKineticAddressKey(address, city, state, zip);
}
