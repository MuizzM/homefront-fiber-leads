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
// v4 (2026-07): UNIT UNIFICATION — every unit designator (APT/UNIT/STE/#/
// APARTMENT/SUITE/BLDG/FL/RM/DEPT/LOT/TRLR) folds to the ONE token "UNIT", and
// "#4"/"# 4" tokenize as "UNIT 4". "123 Main St Apt 4", "123 Main St Unit 4",
// and "123 Main St #4" are the SAME premise-unit (one lead, one pin);
// "123 Main St" (no unit) and "…Unit 5" remain DISTINCT records. ZIP stays out
// of the key (v3); ZIP+4 folding is display-side (normalizeZip5). Directional
// ORDER is deliberately preserved ("N Main St" ≠ "Main St N" — reordering
// false-merges real corner-lot pairs).
export const NORMALIZATION_VERSION = 4;

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
// v4: ALL unit designators fold to the single canonical token "UNIT" — the
// designator word never distinguishes premises ("Apt 4" ≡ "Unit 4" ≡ "Ste 4"
// at a residential address), only the unit VALUE does. The value token stays
// in the key, so units remain distinct records.
const UNITS: Array<[string, string[]]> = [
  ["UNIT", ["APT", "APARTMENT", "STE", "SUITE", "BLDG", "BUILDING", "FL", "FLOOR",
            "RM", "ROOM", "DEPT", "DEPARTMENT", "LOT", "TRLR"]],
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
    .toUpperCase()
    // "#4" / "# 4" are unit shorthand — fold to the canonical UNIT token
    // BEFORE tokenizing so they key identically to "Apt 4"/"Unit 4".
    .replace(/#\s*/g, " UNIT ")
    .replace(/[^A-Z0-9]+/g, " ").trim().split(/\s+/)
    .filter(Boolean).map(token => addressTokenAliases[token] ?? token)
    // Collapse a run of UNIT tokens to one. "Apt #4" folds APT→UNIT AND #→UNIT,
    // producing "UNIT UNIT 4"; without this it keys differently from "Apt 4"
    // ("UNIT 4"), so the same premise-unit becomes two leads / two pins / two
    // paid re-scans. Collapsing the run makes every unit spelling key identically.
    .filter((token, i, arr) => !(token === "UNIT" && arr[i - 1] === "UNIT"))
    .join(" ");
}

/** First 5 digits of a ZIP/ZIP+4, or "" when absent/invalid — display + storage
 *  normalization only (ZIP is not part of the canonical key since v3). */
export function normalizeZip5(zip: string | null | undefined): string {
  const m = String(zip ?? "").match(/\d{5}/);
  return m ? m[0] : "";
}

/** Decompose a display address into house number, street, and unit for card
 *  rendering + validation. Purely presentational — never used for identity. */
export function splitDisplayAddress(address: string | null | undefined): {
  houseNumber: string; street: string; unit: string;
} {
  const raw = String(address ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return { houseNumber: "", street: "", unit: "" };
  const tokens = raw.split(" ");
  const houseNumber = /^\d+[A-Za-z]?$/.test(tokens[0] ?? "") ? tokens[0] : "";
  const rest = houseNumber ? tokens.slice(1) : tokens;
  // The unit clause starts at the first unit designator or "#" token.
  const unitIdx = rest.findIndex((t) =>
    t.startsWith('#') || addressTokenAliases[t.toUpperCase().replace(/[^A-Z0-9]/g, "")] === "UNIT");
  if (unitIdx >= 0) {
    return {
      houseNumber,
      street: rest.slice(0, unitIdx).join(" "),
      unit: rest.slice(unitIdx).join(" "),
    };
  }
  return { houseNumber, street: rest.join(" "), unit: "" };
}

/** The premise key with any unit clause removed — building-level identity for
 *  clustering apartment/unit records. NOT used for lead uniqueness (units are
 *  distinct records); exported for grouping and analytics. */
export function premiseBaseKey(address: string, city: string, state: string): string {
  const canon = canonicalAddressPart(address);
  const cut = canon.indexOf(" UNIT ");
  const base = cut >= 0 ? canon.slice(0, cut) : canon;
  return [base, canonicalAddressPart(city), canonicalAddressPart(state)].join("|");
}

/** Shared address-quality validation for the ADDRESS_REVIEW quarantine: the
 *  reasons a record is not rep-ready. Empty array = publishable. Used by the
 *  projector gate, the review backfill, tests, and the client review banner. */
export function addressIdentityIssues(input: {
  address?: string | null; city?: string | null; state?: string | null;
  lat?: number | null; lng?: number | null;
}): string[] {
  const issues: string[] = [];
  const addr = String(input.address ?? "").trim();
  const houseNumber = addr.split(/\s+/)[0] ?? "";
  if (!addr || canonicalAddressPart(addr) === "") issues.push("missing street address");
  else if (!/^\d+[A-Za-z]?$/.test(houseNumber)) issues.push("missing house number");
  if (!String(input.city ?? "").trim()) issues.push("missing city");
  if (!String(input.state ?? "").trim()) issues.push("missing state");
  const lat = input.lat, lng = input.lng;
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    issues.push("missing coordinates");
  } else if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
    issues.push("invalid coordinates");
  }
  return issues;
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
  // Guard on STREET identity, not merely a non-empty canonical form. A street-
  // less input like "#" or "Apt 5" now canonicalizes to "UNIT"/"UNIT 5" (the
  // #→UNIT and APT→UNIT folds), so the old `=== ""` check let it through and
  // every such placeholder collapsed to one key (e.g. "UNIT|CHARLOTTE|NC"),
  // MERGING distinct fresh leads — the exact data loss this function prevents.
  // streetKeyOf strips the house number + unit tokens; empty ⇒ no street ⇒ do
  // not dedup (a duplicate pin is recoverable; a merged-away lead is not).
  if (streetKeyOf(address) === "") return null;
  return normalizeKineticAddressKey(address, city, state, zip);
}

// ── Street identity (moved from server/freshHarvest — pure, dependency-free) ──
const STREET_DIRECTIONALS = new Set(["N", "S", "E", "W"]);
const STREET_UNIT_TOKENS = new Set(["APT", "UNIT", "STE", "SUITE", "LOT", "TRLR", "BLDG", "FL", "RM", "BSMT", "DEPT", "OFC"]);
/** An address split at the two boundaries streetKeyOf cuts on. The three
 *  parts concatenate back to canonicalAddressPart(address) token for token,
 *  so comparing all three is exactly "the same premise-unit", while comparing
 *  `street` alone is "somewhere on this street". */
export interface AddressIdentity {
  /** Leading house-number tokens, including the unit letter of "123-A Main St"
   *  ("123 A") and both halves of a range or fraction ("123 125", "123 1 2"). */
  house: string;
  /** Street name with house and unit removed — the value scan_targets.street_key
   *  stores. Empty when no street name survives. */
  street: string;
  /** Unit clause in canonical form ("UNIT 101"); "" when the address names no
   *  unit. Every designator already folded to the one UNIT token upstream, so
   *  "Apt 4", "Unit 4" and "#4" all yield "UNIT 4". */
  unit: string;
}

/**
 * Decompose an address into house / street / unit in canonical token form.
 *
 * streetKeyOf CUTS the unit clause off rather than retaining it, so a street
 * key alone cannot tell two doors of one building apart. Anything deciding
 * whether two records are the SAME DOOR must compare `unit` (and `house` —
 * "313-A" and "313-B" share a street key too) and not only `street`. Both
 * scan-target twin guards learned that the hard way: see
 * server/storage.ts (upsertScanTargets) and server/scanTargetCanonicalMerge.ts.
 */
export function addressIdentityOf(address: string | null | undefined): AddressIdentity {
  if (!address) return { house: "", street: "", unit: "" };
  const tokens = canonicalAddressPart(String(address)).split(" ").filter(Boolean);
  let start = 0;
  // House number: "123", "123A", and split forms like "123 125" (ranges) or
  // "123 1 2" (fractions — "/" folds to a space in canonical form).
  while (start < tokens.length && /^\d+[A-Z]?$/.test(tokens[start])) start++;
  // "123-A Main St" canonicalizes to "123 A MAIN ST" — the orphaned unit
  // letter belongs to the HOUSE, not the street, but never a directional
  // ("101 N Main St" keeps its N on the street side).
  if (start > 0 && start < tokens.length - 1
      && tokens[start].length === 1 && !STREET_DIRECTIONALS.has(tokens[start])) start++;
  let end = tokens.length;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].startsWith("#") || STREET_UNIT_TOKENS.has(tokens[i])) { end = i; break; }
  }
  return {
    house: tokens.slice(0, start).join(" "),
    street: tokens.slice(start, end).join(" "),
    unit: tokens.slice(end).join(" "),
  };
}

/**
 * Canonical street key: house number and unit stripped, suffix/directional
 * synonyms folded (via canonicalAddressPart), so "22 Fiber Street Apt 4",
 * "17 Fiber St" and "Fiber Street" all key to "FIBER ST". Addresses with no
 * leading house number (brand-new streets a geocoder hasn't numbered yet)
 * keep their full name instead of losing their first word. Empty string when
 * no street name survives.
 *
 * STREET identity only. Two doors of one building share it — use
 * addressIdentityOf when the question is whether two records are one door.
 */
export function streetKeyOf(address: string | null | undefined): string {
  return addressIdentityOf(address).street;
}
