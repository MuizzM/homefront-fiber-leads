// ── Rowan County, NC: bridge the whole county's E911 inventory ──────────────
//
// WHY THIS EXISTS
// Rowan County's E911 file holds 75,349 addressable doors. On 2026-08-27 the
// database held 11,072 of them, and eight towns were effectively absent:
//
//     city             E911     scan_targets
//     SALISBURY      39,789          526
//     KANNAPOLIS      8,349        5,463
//     CHINA GROVE     7,541        3,910
//     CLEVELAND       2,243          932
//     SPENCER         1,775            0
//     GRANITE QUARRY  1,657            1
//     WOODLEAF        1,322            5
//     MOUNT ULLA      1,239          194
//     GOLD HILL       1,136           21
//     EAST SPENCER      990            0
//     RICHFIELD         515           20
//     FAITH             439            0
//
// A door that is not in scan_targets cannot be scanned, assigned, or knocked.
// Kinetic filed 17,673 FTTP locations in this county with the FCC (D25 vintage,
// fcc_block_footprint), so this is not an empty market - it is an empty table.
// This is the Landis failure mode (3 mapped doors against 2,193 in E911) at
// county scale, and script/import-landis.ts plus the verified one-town
// rockwell-bridge.ts are what this is modelled on.
//
// BRIDGING IS FREE. Nothing here calls a provider except --phase probe, which
// needs its own explicit authorization flag on top of --apply.
//
// ── FOUR THINGS THIS GETS RIGHT, EACH OF WHICH WAS PAID FOR ────────────────
//
//  1. canonical_key IS BACKFILLED BEFORE THE UPSERT. The canonical-twin dedup
//     guard in storage.upsertScanTargets is `WHERE canonical_key = ?` and
//     cannot fire on a NULL. When this was written, 292,999 of tenant 1's
//     924,104 rows carried NULL, so without this every E911 door whose spelling
//     differs from the row we already hold inserts a second copy. The key is
//     DERIVED from (address, city, state), so stamping it invents nothing.
//
//     The step is scoped to the cities being written - the key is
//     `addr|city|state`, so only a row under a target city label can collide
//     with a door we are about to write. The tenant-wide backfill is separate
//     work (script/backfill-scan-target-canonical-keys.ts) and it landed on the
//     local database on 2026-08-27, which makes this step report "0 NULL in
//     scope" and do nothing. That is the intended outcome, not a skipped check:
//     both predicates are `canonical_key IS NULL`, so whichever runs first wins
//     and the second is a no-op.
//
//  2. EVERY DOOR GOES THROUGH storage.upsertScanTargets, never raw SQL. It owns
//     the two guards that make this safe to re-run: the canonical twin (same
//     premise, different spelling) and the postal-city alias twin (same premise
//     under another postal city, matched on street_key + state + house number +
//     coordinates within ~25 m). Re-implementing either here is how a second,
//     drifting copy of a rule gets born.
//
//  3. STREET SPELLING IS NORMALIZED, AND THE UNPROVEN PARTS SAY SO. E911 ships
//     SCREAMING CASE with full suffix words and spelled-out route names, and a
//     spelling Kinetic will not match comes home as inconclusive - which reads
//     in every report as "no fiber" rather than as our own bug. Measured live
//     on Rockwell, same house, same minute:
//
//       "12300 United States Highway 52 Highway" -> FAILED
//       "12300 US Highway 52"                    -> FIBER
//       "6735 East North Carolina 152 Highway"   -> FAILED
//       "6735 E Nc 152 Hwy"                      -> FIBER
//
//     Rowan carries ELEVEN route street-names and Rockwell measured two of
//     them. The rest are folded by analogy and reported as UNPROVEN with a door
//     count, so nothing rides on an untested spelling silently. --phase probe
//     turns unproven into measured.
//
//     ROUND 1 OF THAT MEASUREMENT, 2026-08-27, 17 live calls, one house per
//     spelling, no cache hits (every call 1.2-2.6 s on the wire):
//
//       2325 US Hwy 29,     China Grove -> FIBER, billing N
//       2325 S US Hwy 29,   China Grove -> FAILED      <- same house, same minute
//       2325 South United States Highway 29 Highway    -> FAILED
//       880 Nc 153 Hwy,     China Grove -> FIBER, billing N
//       880 North Carolina 153 Highway                 -> FAILED
//       1625 N US Hwy 29 / raw / 1625 US Hwy 29, Salisbury      -> all FAILED
//       7285 Nc 801 Hwy / raw, Salisbury                        -> both FAILED
//       100 Old US Hwy 70 / raw, Salisbury                      -> both FAILED
//       4265 W Nc 152 Hwy / raw / 4265 Nc 152 Hwy, China Grove  -> all FAILED
//       2625 Old US Hwy 80 / raw, Gold Hill                     -> both FAILED
//
//     What that DOES establish: Rockwell's folds do not generalize. On US 29 the
//     directional has to be DROPPED - "US Hwy 29" answered where "S US Hwy 29"
//     failed on the same house in the same minute - and the bare "Nc <n> Hwy"
//     fold is right at least on NC 153.
//
//     What it does NOT establish: everything else. A lone FAILED on one house
//     cannot tell a bad spelling from a house Kinetic does not serve, and the
//     rows where BOTH candidates failed are exactly that shape. They need a
//     second house before any fold changes. The folds below are therefore left
//     as they were, and the door counts stay flagged unproven, until that is
//     bought - a fold changed on one ambiguous reading is the same guess this
//     whole file exists to avoid.
//
//  4. THE CITY COMES FROM E911, NOT FROM A ZIP RULE (commit 6f58b5e).
//     address_points.city IS the NC OneMap `post_comm` field - the postal
//     community a rep would actually say, and the one Kinetic echoes back. The
//     scanner's address-identity gate compares the identity we SENT with the
//     one Kinetic ECHOED, and city is part of that key, so a wrong city label
//     discards a real qualification as inconclusive.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
//
//   * It does not import unit addresses by default. See UNIT ADDRESSES below.
//   * It does not merge duplicate rows. Backfilling canonical_key REVEALS
//     duplicates that were always there; merging them is destructive and is a
//     separate decision.
//   * It does not relabel held rows whose city disagrees with E911. That moves
//     canonical_key on existing rows, some of which carry leads. It is counted
//     and reported instead.
//   * It does not scan. Buying answers is a separate, separately-authorized
//     decision and this script must be safe to run without spending anything.
//
// ── UNIT ADDRESSES ─────────────────────────────────────────────────────────
//
// 6,793 of the 75,349 E911 points carry a ", UNIT x" / ", BUILDING y" clause,
// and they sit on only 1,342 premises - one Salisbury complex has 240 units at
// 2715 Statesville Boulevard. streetKeyOf CUTS the address at the first unit
// token rather than retaining it, so every unit at a premise shares a
// street_key AND a house number; the alias-twin guard then matches on
// coordinates within ~25 m and absorbs one unit into another. Reproduced on a
// pristine DATA_DIR on 2026-08-27:
//
//     "2715 Statesville Blvd Unit 101" (35.6700,  -80.5200)  -> 1 new row
//     "2715 Statesville Blvd Unit 102" (35.6700,  -80.5200)  -> 0 new rows
//     "2715 Statesville Blvd Unit 240" (35.67015, -80.52015) -> 0 new rows
//     "2717 Statesville Blvd"          (35.6700,  -80.5200)  -> 1 new row
//
// storage.upsertScanTargets says of that guard "distinct units differ in
// street_key's retained unit token and never merge". They do not. Importing
// units through it yields a partial, coordinate-ordered, order-dependent
// inventory that READS as complete, which is worse than not importing them, so
// they are excluded and counted. --include-units opts in once the guard is
// fixed.
//
// ── USAGE - dry run is the default, nothing is written without --apply ──────
//
//   npx tsx script/import-rowan.ts --phase plan
//   npx tsx script/import-rowan.ts --phase bridge --city Spencer
//   npx tsx script/import-rowan.ts --phase bridge --city Spencer --apply
//   npx tsx script/import-rowan.ts --phase probe  --city "Granite Quarry"
//
// Options:
//   --tenant <id>                default 1
//   --city <name>                repeatable; default every Rowan postal community
//   --phase plan|probe|bridge    default plan
//   --apply                      write (bridge) / dial the provider (probe)
//   --authorize-provider-calls   second gate the probe needs before it spends
//   --include-units              import ", UNIT x" doors (see above)
//   --batch <n>                  rows per write transaction (default 500)
//   --pause <ms>                 idle gap between write batches (default 25)
//   --max-probes <n>             provider calls per town in probe (default 12)
//   --routes-only                probe unproven route folds only, one town per
//                                spelling - skips the plain-suffix sanity check
//
// This is a LOCAL tool. --apply refuses to run against a production database.

import "dotenv/config";
import { storage, runMigrations } from "../server/storage";
import { rawDb, dbPath } from "../server/db";
import { canonicalAddressPart, streetKeyOf, normalizeKineticAddressKey } from "@shared/addressKey";
import { ensureAddressPointSchema } from "../server/addressPointStore";

const COUNTY = "ROWAN";
const STATE = "NC";

const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : null;
}
/** Every occurrence of a repeatable flag, in order. */
function flags(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith("--")) out.push(argv[i + 1]);
    else if (argv[i].startsWith(`--${name}=`)) out.push(argv[i].slice(name.length + 3));
  }
  return out;
}

const TENANT = Number(flag("tenant") ?? 1);
const PHASE = (flag("phase") ?? "plan").toLowerCase();
const APPLY = argv.includes("--apply");
const INCLUDE_UNITS = argv.includes("--include-units");
const AUTHORIZE_CALLS = argv.includes("--authorize-provider-calls");
const ROUTES_ONLY = argv.includes("--routes-only");
const BATCH = Math.max(50, Number(flag("batch") ?? 500) || 500);
const PAUSE_MS = Math.max(0, Number(flag("pause") ?? 25) || 0);
const MAX_PROBES = Math.max(1, Number(flag("max-probes") ?? 12) || 12);
const CITY_ARGS = flags("city");

const line = (s = "") => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n = (v: number) => v.toLocaleString();

// ── Street normalization ─────────────────────────────────────────────────────
// Reps read this string on the lead card and Kinetic matches the abbreviation,
// so both want the same thing. Casing cannot create a duplicate: the unique
// index is on lower(trim(address)) and the canonical key uppercases.
const KEEP_UPPER = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW", "US", "NC", "SR"]);
// Exactly the full words that shared/addressKey.ts's SUFFIXES table folds.
// Adding a word this list does not share with that table (TRACE, POINT, GROVE)
// would MOVE the canonical key and mint a duplicate of every door we hold.
const SUFFIX: Record<string, string> = {
  STREET: "St", ROAD: "Rd", AVENUE: "Ave", DRIVE: "Dr", COURT: "Ct", LANE: "Ln",
  BOULEVARD: "Blvd", HIGHWAY: "Hwy", PLACE: "Pl", TERRACE: "Ter", CIRCLE: "Cir",
  PARKWAY: "Pkwy", TRAIL: "Trl", PLAZA: "Plz", SQUARE: "Sq", CROSSING: "Xing",
};

export function titleCase(s: string): string {
  return s.trim().split(/\s+/).map((w) => {
    const u = w.toUpperCase();
    if (KEEP_UPPER.has(u)) return u;
    if (/^\d+(ST|ND|RD|TH)$/.test(u)) return u.toLowerCase();
    return u.charAt(0) + u.slice(1).toLowerCase();
  }).join(" ");
}

/** USPS-abbreviate the trailing street type only. Mid-name words are never
 *  touched - folding those would mangle "Oak Ridge Ct" the way the canonical
 *  key's own SUFFIXES table warns about. */
export function abbreviate(addr: string): string {
  const parts = addr.trim().split(/\s+/);
  if (parts.length < 2) return addr;
  const last = parts[parts.length - 1].toUpperCase();
  if (!SUFFIX[last]) return addr;
  parts[parts.length - 1] = SUFFIX[last];
  return parts.join(" ");
}

const DIR: Record<string, string> = { NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W", N: "N", S: "S", E: "E", W: "W" };

/**
 * The route forms E911 spells out and Kinetic refuses.
 *
 * `proven` is not decoration. Rockwell measured exactly two output spellings
 * against the live provider; the other nine Rowan route street-names are folded
 * BY ANALOGY, and a fold that has never been asked is a guess with a door count
 * attached. Every report prints how many doors ride on an unproven one.
 */
type RouteFold = {
  id: string;
  re: RegExp;
  to: (m: RegExpMatchArray) => string;
  proven: (m: RegExpMatchArray) => boolean;
};
const ROUTE_FOLDS: RouteFold[] = [
  {
    // "6735 EAST NORTH CAROLINA 152 HIGHWAY" -> "6735 E Nc 152 Hwy"
    // E measured FIBER 2026-08-27; 151 of 151 held "E NC <n> HWY" rows answered
    // conclusively. W / N / S / bare are the same shape, unmeasured.
    id: "nc-route",
    re: /^(\d+[A-Z]?)\s+(?:(NORTH|SOUTH|EAST|WEST|N|S|E|W)\s+)?(?:NORTH CAROLINA|NC)\s+(\d+[A-Z]?)\s+(?:HIGHWAY|HWY)$/,
    to: (m) => `${m[1]} ${m[2] ? `${DIR[m[2]]} ` : ""}Nc ${m[3]} Hwy`,
    proven: (m) => m[2] != null && DIR[m[2]] === "E",
  },
  {
    // "12300 UNITED STATES HIGHWAY 52 HIGHWAY" -> "12300 US Hwy 52"
    // Plain form measured FIBER 2026-08-27; 22 of 22 held "US HWY <n>" rows
    // answered conclusively. OLD / directional variants are unmeasured, and the
    // directional is load-bearing: E911 carries BOTH "1965 NORTH UNITED STATES
    // HIGHWAY 29 HIGHWAY" and "1965 SOUTH ...", two premises we hold as one row.
    id: "us-route",
    re: /^(\d+[A-Z]?)\s+(?:(OLD)\s+)?(?:(NORTH|SOUTH|EAST|WEST|N|S|E|W)\s+)?(?:UNITED STATES|US)\s+(?:HIGHWAY|HWY)\s+(\d+[A-Z]?)\s+(?:HIGHWAY|HWY)$/,
    to: (m) => `${m[1]} ${m[2] ? "Old " : ""}${m[3] ? `${DIR[m[3]]} ` : ""}US Hwy ${m[4]}`,
    proven: (m) => m[2] == null && m[3] == null,
  },
];

export function foldRoute(base: string): { text: string; fold: RouteFold; proven: boolean } | null {
  const u = base.toUpperCase().replace(/\s+/g, " ").trim();
  for (const f of ROUTE_FOLDS) {
    const m = u.match(f.re);
    if (m) return { text: f.to(m), fold: f, proven: f.proven(m) };
  }
  return null;
}

/** E911 puts the unit clause after the first comma:
 *  "2114 ENGLEWOOD STREET, UNIT A, BUILDING A". Splitting it off first is what
 *  lets the suffix and route folds see a bare street - Rockwell's version had
 *  to special-case one route with a trailing clause because it did not. */
export function splitUnitClause(raw: string): { base: string; clause: string | null } {
  const i = raw.indexOf(",");
  if (i === -1) return { base: raw.trim(), clause: null };
  return { base: raw.slice(0, i).trim(), clause: raw.slice(i + 1).trim() || null };
}

export type Normalized = { address: string; clause: string | null; routeFold: string | null; proven: boolean };
export function normalize(rawStreet: string): Normalized {
  const { base, clause } = splitUnitClause(rawStreet);
  const routed = foldRoute(base);
  const street = routed ? routed.text : abbreviate(titleCase(base));
  const tidyClause = clause
    ? clause.split(",").map((p) => titleCase(p)).filter(Boolean).join(", ")
    : null;
  return {
    address: tidyClause ? `${street}, ${tidyClause}` : street,
    clause: tidyClause,
    routeFold: routed ? routed.fold.id : null,
    proven: routed ? routed.proven : true,
  };
}

// ── Scope ────────────────────────────────────────────────────────────────────
type E911Point = { street: string; city: string; zip: string | null; lat: number; lng: number };

/** Every postal community the county file names, biggest first. */
function countyCities(): Array<{ city: string; points: number }> {
  return (rawDb.prepare(
    `SELECT city, COUNT(*) AS points FROM address_points
      WHERE county=? AND city IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL
      GROUP BY city ORDER BY points DESC`,
  ).all(COUNTY) as Array<{ city: string; points: number }>);
}

function resolveCities(): string[] {
  const all = countyCities();
  if (!CITY_ARGS.length) return all.map((c) => titleCase(c.city));
  const byCanon = new Map(all.map((c) => [canonicalAddressPart(c.city), titleCase(c.city)]));
  const picked: string[] = [];
  for (const arg of CITY_ARGS) {
    const hit = byCanon.get(canonicalAddressPart(arg));
    if (!hit) {
      line(`--city "${arg}" is not a postal community in the ${COUNTY} E911 file.`);
      line(`  known: ${all.map((c) => titleCase(c.city)).join(", ")}`);
      process.exit(1);
    }
    picked.push(hit);
  }
  return picked;
}

function pointsFor(city: string): E911Point[] {
  return (rawDb.prepare(
    `SELECT street, city, zip, lat, lng FROM address_points
      WHERE county=? AND upper(city)=upper(?) AND lat IS NOT NULL AND lng IS NOT NULL`,
  ).all(COUNTY, city) as E911Point[]);
}

/** Doors as upsertScanTargets wants them, with the units held back unless the
 *  operator opted in. The city is E911's post_comm, never a ZIP rule. */
function doorsFor(city: string): { doors: Array<{ address: string; city: string; state: string; zip: string; lat: number; lng: number; source: string; tenantId: number }>; skippedUnits: number; unproven: number } {
  const doors: ReturnType<typeof doorsFor>["doors"] = [];
  let skippedUnits = 0, unproven = 0;
  for (const p of pointsFor(city)) {
    const norm = normalize(p.street);
    if (norm.clause && !INCLUDE_UNITS) { skippedUnits++; continue; }
    if (!norm.proven) unproven++;
    doors.push({
      address: norm.address, city, state: STATE, zip: p.zip ?? "",
      lat: p.lat, lng: p.lng, source: "e911-nc-onemap", tenantId: TENANT,
    });
  }
  return { doors, skippedUnits, unproven };
}

// ── Held rows ────────────────────────────────────────────────────────────────
type HeldRow = { id: number; address: string; city: string; zip: string | null; canonicalKey: string | null };

/** The rows already in scan_targets under one of the target city labels.
 *  Loaded once - the table is 924k rows in a 3.4 GB file and every phase wants
 *  the same slice of it. */
let heldCache: { key: string; rows: HeldRow[] } | null = null;
function heldRows(cities: string[]): HeldRow[] {
  const cacheKey = cities.join("|");
  if (heldCache?.key === cacheKey) return heldCache.rows;
  const marks = cities.map(() => "?").join(",");
  const rows = rawDb.prepare(
    `SELECT id, address, city, zip, canonical_key AS canonicalKey FROM scan_targets
      WHERE tenant_id=? AND upper(trim(state))=? AND upper(trim(city)) IN (${marks})`,
  ).all(TENANT, STATE, ...cities.map((c) => c.toUpperCase())) as HeldRow[];
  heldCache = { key: cacheKey, rows };
  return rows;
}

/** E911's opinion of which city a premise belongs to, keyed by the canonical
 *  address. A premise whose canonical address exists in TWO towns is ambiguous
 *  (two "123 Main St" in one county) and is deliberately left out - guessing is
 *  what put doors under the wrong postal city in the first place. */
function e911CityByAddress(): Map<string, string | null> {
  const truth = new Map<string, string | null>();
  const rows = rawDb.prepare(
    `SELECT street, city FROM address_points WHERE county=? AND city IS NOT NULL`,
  ).all(COUNTY) as Array<{ street: string; city: string }>;
  for (const r of rows) {
    const key = canonicalAddressPart(normalize(r.street).address);
    if (!key) continue;
    const city = titleCase(r.city);
    if (!truth.has(key)) truth.set(key, city);
    else if (truth.get(key) !== city) truth.set(key, null); // ambiguous
  }
  return truth;
}

// ── Step 1: canonical_key backfill, scoped to the cities being written ──────
// The canonical-twin guard keys on `addr|city|state`, so only a row in a target
// city can collide with a door we are about to write. A tenant-wide backfill is
// separate work (script/backfill-scan-target-canonical-keys.ts); running it
// first makes this a no-op, because the predicate is `canonical_key IS NULL`
// either way.
async function backfillKeys(held: HeldRow[]): Promise<Array<{ id: number; key: string }>> {
  const nulls = held.filter((r) => r.canonicalKey == null);
  const keyless = nulls.filter((r) => canonicalAddressPart(r.address ?? "") === "").length;

  // Seed the claim map with every key already stored for this tenant, so a
  // backfilled key collides against rows we are not touching AND against
  // another row in this same batch.
  const claimed = new Map<string, number>();
  for (const r of rawDb.prepare(
    `SELECT id, canonical_key AS k FROM scan_targets WHERE tenant_id=? AND canonical_key IS NOT NULL`,
  ).all(TENANT) as Array<{ id: number; k: string }>) claimed.set(r.k, r.id);

  const plan: Array<{ id: number; key: string }> = [];
  const collide: Array<{ id: number; addr: string; onto: number }> = [];
  for (const r of nulls) {
    if (canonicalAddressPart(r.address ?? "") === "") continue;
    const key = normalizeKineticAddressKey(r.address, r.city, STATE, r.zip ?? "");
    const holder = claimed.get(key);
    if (holder !== undefined && holder !== r.id) { collide.push({ id: r.id, addr: r.address, onto: holder }); continue; }
    claimed.set(key, r.id);
    plan.push({ id: r.id, key });
  }

  line(`canonical_key: ${n(nulls.length)} NULL in scope`);
  line(`  ${n(plan.length)} row(s) get a key   ${n(collide.length)} already-duplicate row(s) left alone   ${n(keyless)} with no usable street text`);
  for (const c of collide.slice(0, 8)) line(`     #${c.id} "${c.addr}" is the same premise as #${c.onto}`);
  if (collide.length > 8) line(`     ... and ${n(collide.length - 8)} more (merging is a separate, destructive decision)`);

  if (!APPLY || !plan.length) return plan;
  const upd = rawDb.prepare(`UPDATE scan_targets SET canonical_key=? WHERE id=? AND canonical_key IS NULL`);
  const tx = rawDb.transaction((b: typeof plan) => { for (const p of b) upd.run(p.key, p.id); });
  for (let i = 0; i < plan.length; i += BATCH) {
    tx.immediate(plan.slice(i, i + BATCH));
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }
  line(`  stamped ${n(plan.length)} canonical key(s)`);
  return plan;
}

/** street_key is not set by the insert; the yieldRollups janitor normally fills
 *  it a tick later. Do it here with the SAME shared streetKeyOf it uses, and
 *  only for rows this run created - a bare `street_key IS NULL` predicate scans
 *  all 924k rows of a 3.4 GB table. */
/** The alias-twin guard matches on `street_key = ?`, so a HELD row that still
 *  carries NULL is invisible to it and the door we are about to write inserts a
 *  second copy of a premise we already own under another postal city. Tenant 1
 *  has none locally, but a replayed or freshly restored database does, and this
 *  is the same NULL -> non-NULL write with the same shared function. */
async function fillHeldStreetKeys(held: HeldRow[]): Promise<number> {
  const missing = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM scan_targets
      WHERE tenant_id=? AND street_key IS NULL AND id IN (SELECT value FROM json_each(?))`,
  );
  const ids = held.map((r) => r.id);
  let gaps = 0;
  for (let i = 0; i < ids.length; i += 500) {
    gaps += (missing.get(TENANT, JSON.stringify(ids.slice(i, i + 500))) as { n: number }).n;
  }
  if (!gaps) return 0;
  line(`street_key: ${n(gaps)} held row(s) carry NULL - the alias-twin guard cannot see them`);
  if (!APPLY) return gaps;
  const upd = rawDb.prepare(`UPDATE scan_targets SET street_key=? WHERE id=? AND street_key IS NULL`);
  const tx = rawDb.transaction((b: HeldRow[]) => { for (const r of b) upd.run(streetKeyOf(r.address ?? ""), r.id); });
  for (let i = 0; i < held.length; i += BATCH) {
    tx.immediate(held.slice(i, i + BATCH));
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }
  line(`  filled street_key on ${n(gaps)} held row(s)`);
  return gaps;
}

let streetKeyCursor = 0;
async function fillStreetKeys(): Promise<number> {
  const sel = rawDb.prepare(
    `SELECT id, address FROM scan_targets
      WHERE street_key IS NULL AND tenant_id=? AND id>? ORDER BY id LIMIT ?`,
  );
  const upd = rawDb.prepare(`UPDATE scan_targets SET street_key=? WHERE id=?`);
  const tx = rawDb.transaction((b: Array<{ id: number; address: string | null }>) => {
    for (const r of b) upd.run(streetKeyOf(r.address ?? ""), r.id);
  });
  let done = 0;
  for (;;) {
    const rows = sel.all(TENANT, streetKeyCursor, BATCH) as Array<{ id: number; address: string | null }>;
    if (!rows.length) break;
    // The watermark only ever advances: rows are appended, and every row we
    // visit leaves with a street_key. Restarting the scan at the run's opening
    // id on each of ~140 batches would re-walk everything already filled.
    streetKeyCursor = rows[rows.length - 1].id;
    tx.immediate(rows);
    done += rows.length;
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }
  return done;
}

// ── phase: plan ──────────────────────────────────────────────────────────────
function plan(cities: string[]): void {
  const held = heldRows(cities);
  const heldByCity = new Map<string, HeldRow[]>();
  for (const r of held) {
    const k = canonicalAddressPart(r.city ?? "");
    if (!heldByCity.has(k)) heldByCity.set(k, []);
    heldByCity.get(k)!.push(r);
  }
  const truth = e911CityByAddress();

  line("city              E911   units   route   unproven      held   nullKey   wrongCity");
  line("-".repeat(84));
  let tE = 0, tU = 0, tR = 0, tP = 0, tH = 0, tN = 0, tW = 0;
  const unprovenSpellings = new Map<string, number>();
  for (const city of cities) {
    const pts = pointsFor(city);
    let units = 0, route = 0, unproven = 0;
    for (const p of pts) {
      const norm = normalize(p.street);
      // Every column after `units` describes the doors this run would IMPORT,
      // so a held-back unit door must not inflate the route or unproven counts.
      if (norm.clause) { units++; if (!INCLUDE_UNITS) continue; }
      if (norm.routeFold) route++;
      if (!norm.proven) {
        unproven++;
        const shape = norm.address.replace(/^\d+[A-Z]?\s+/, "");
        unprovenSpellings.set(shape, (unprovenSpellings.get(shape) ?? 0) + 1);
      }
    }
    const rows = heldByCity.get(canonicalAddressPart(city)) ?? [];
    const nullKey = rows.filter((r) => r.canonicalKey == null).length;
    const wrongCity = rows.filter((r) => {
      const says = truth.get(canonicalAddressPart(r.address ?? ""));
      return says != null && canonicalAddressPart(says) !== canonicalAddressPart(r.city ?? "");
    }).length;
    tE += pts.length; tU += units; tR += route; tP += unproven; tH += rows.length; tN += nullKey; tW += wrongCity;
    line(`${city.padEnd(16)} ${String(pts.length).padStart(5)} ${String(units).padStart(7)} ${String(route).padStart(7)} ${String(unproven).padStart(10)} ${String(rows.length).padStart(9)} ${String(nullKey).padStart(9)} ${String(wrongCity).padStart(11)}`);
  }
  line("-".repeat(84));
  line(`${"TOTAL".padEnd(16)} ${String(tE).padStart(5)} ${String(tU).padStart(7)} ${String(tR).padStart(7)} ${String(tP).padStart(10)} ${String(tH).padStart(9)} ${String(tN).padStart(9)} ${String(tW).padStart(11)}`);
  line("");
  line(`E911      addressable doors the county says exist`);
  line(`units     of those, ", Unit x" doors - ${INCLUDE_UNITS ? "INCLUDED by --include-units" : "held back; the alias-twin guard merges them (see header)"}`);
  line(`route     importable doors whose spelled-out route name is folded`);
  line(`unproven  of those, folded to a spelling no provider call has ever confirmed`);
  line(`held      rows already in scan_targets under this city label`);
  line(`nullKey   of those, canonical_key IS NULL - the twin guard is blind on them`);
  line(`wrongCity held rows E911 unambiguously places in a DIFFERENT town - reported, never relabelled`);

  if (unprovenSpellings.size) {
    line("");
    line(`unproven spellings (--phase probe measures these before you import them):`);
    const ranked = [...unprovenSpellings].sort((a, b) => b[1] - a[1]);
    for (const [s, c] of ranked.slice(0, 12)) line(`   ${String(c).padStart(5)}  "<house> ${s}"`);
    if (ranked.length > 12) {
      const rest = ranked.slice(12);
      line(`   ${String(rest.reduce((t, r) => t + r[1], 0)).padStart(5)}  across ${rest.length} more spelling(s)`);
    }
  }
}

// ── phase: probe ─────────────────────────────────────────────────────────────
// Which spelling does Kinetic actually match in THIS town? Rockwell's folds are
// measured for Rockwell's two roads; assuming they generalize is how 61 of 106
// Landis doors came home as non-answers. This buys a handful of answers per
// town to decide the spelling for all of them.
type ProbeCase = { label: string; house: string; city: string; zip: string; spellings: string[] };

function probeCases(city: string): ProbeCase[] {
  const pts = pointsFor(city);
  const cases: ProbeCase[] = [];
  const seenShape = new Set<string>();

  // 1. Every unproven route fold in this town, on a real house number so a miss
  //    is a spelling miss and not a house that does not exist.
  for (const p of pts) {
    const norm = normalize(p.street);
    if (norm.proven || norm.clause) continue;
    const shape = norm.address.replace(/^\d+[A-Z]?\s+/, "");
    if (seenShape.has(shape)) continue;
    seenShape.add(shape);
    const house = p.street.trim().split(/\s+/)[0];
    const raw = titleCase(splitUnitClause(p.street).base);
    cases.push({
      label: `route ${shape}`, house, city, zip: p.zip ?? "",
      // The fold, the raw E911 text, and the same road with the directional
      // dropped - the third is the form the database already answers on US 29,
      // and knowing whether it beats the fold is the whole question.
      spellings: [...new Set([
        norm.address,
        raw,
        norm.address.replace(/^(\d+[A-Z]?)\s+(?:N|S|E|W)\s+/, "$1 "),
      ])],
    });
  }

  // 2. One plain suffix fold, because that is the fold every door in the town
  //    rides on and it has only ever been measured in Landis and Rockwell.
  const plain = pts.find((p) => {
    const norm = normalize(p.street);
    return !norm.clause && !norm.routeFold && abbreviate(titleCase(splitUnitClause(p.street).base)) !== titleCase(splitUnitClause(p.street).base);
  });
  if (plain) {
    const base = titleCase(splitUnitClause(plain.street).base);
    cases.push({
      label: "plain suffix", house: plain.street.trim().split(/\s+/)[0], city, zip: plain.zip ?? "",
      spellings: [abbreviate(base), base],
    });
  }
  return cases;
}

function verdict(r: any): string {
  if (r.blocked) return "BLOCKED";
  if (r.apiSource === "failed") return "FAILED";
  return [
    r.fiberAvailable ? "FIBER" : (r.fiberStatus ?? "?"),
    r.billingStatus ? `billing ${r.billingStatus}` : "",
    r.validationResult ? String(r.validationResult) : "",
    r.exactMatch === true ? "exactMatch" : (r.exactMatch === false ? "notExact" : ""),
    r.addressReviewReason ? `review:${r.addressReviewReason}` : "",
  ].filter(Boolean).join(" / ");
}

async function probe(cities: string[]): Promise<void> {
  const byCity = cities.map((c) => ({ city: c, cases: probeCases(c) }));
  if (ROUTES_ONLY) {
    // One town per distinct unproven spelling. The same fold repeated in six
    // towns asks the same question six times; the postal city is part of the
    // identity Kinetic echoes, but the SPELLING is what is unproven.
    const seen = new Set<string>();
    for (const g of byCity) {
      g.cases = g.cases.filter((c) => {
        if (!c.label.startsWith("route ")) return false;
        if (seen.has(c.label)) return false;
        seen.add(c.label);
        return true;
      });
    }
  }
  let calls = 0;
  for (const g of byCity) {
    line(`--- ${g.city} ---`);
    if (!g.cases.length) { line("   nothing unproven to measure"); continue; }
    let spent = 0;
    for (const c of g.cases) {
      const take = c.spellings.slice(0, Math.max(0, MAX_PROBES - spent));
      if (!take.length) { line(`   [capped at --max-probes ${MAX_PROBES}] ${c.label} not measured`); continue; }
      spent += take.length;
      line(`   ${c.label}  (house ${c.house})`);
      for (const s of take) line(`      ${s}`);
    }
    calls += spent;
  }
  line("");
  // The cap is the (token, search-IP) PAIR at about 20 checks, not the token
  // and not the IP alone, so the spend is measured in pairs consumed.
  const perPair = Math.max(1, Number(process.env.DECODO_CHECKS_PER_IP ?? 20) || 20);
  line(`${n(calls)} provider call(s) planned = about ${Math.ceil(calls / perPair)} residential IP + token pair(s)`);
  line(`at ${perPair} checks each. Narrow it with --city, or --max-probes <n> per town.`);

  if (!AUTHORIZE_CALLS || !APPLY) {
    line("");
    line("NOT DIALLED. This phase spends money, so it needs BOTH flags:");
    line("   --apply --authorize-provider-calls");
    return;
  }

  // Guards that verify-rockwell.ts and rockwell-probe-spellings.ts already pay
  // for: dotenv is imported first (top of file), the scanner is authorized, a
  // proxy actually resolved, and the egress IP is not this machine's. A
  // standalone script with no proxy egresses DIRECT while the log still says
  // "decodo".
  if (process.env.KFS_AUTOMATION_AUTHORIZED !== "true") {
    line("[ABORT] KFS_AUTOMATION_AUTHORIZED is not 'true' - the scanner fails closed, zero answers");
    process.exit(1);
  }
  process.env.DECODO_LANES = process.env.DECODO_LANES || "1";
  process.env.DECODO_CHECKS_PER_IP = process.env.DECODO_CHECKS_PER_IP || "20";
  process.env.KFS_TOKEN_MAX_CHECKS = process.env.DECODO_CHECKS_PER_IP;
  process.env.KFS_TOKEN_MAX_LEASES_PER_SLOT = process.env.DECODO_CHECKS_PER_IP;
  const pf = await import("../server/proxy-fetch");
  const { scanAddress } = await import("../server/scanner");

  if (!pf.proxyUrlFromEnv(process.env)) { line("[ABORT] no proxy resolved - this would egress from this machine"); process.exit(1); }
  const direct = await fetch("https://api.ipify.org").then((r) => r.text()).catch(() => "unknown");
  await pf.refreshEgressIp();
  const egress = pf.getEgressIp();
  line(`direct IP: ${direct}    egress IP: ${egress.ip ?? "(none)"} (port ${egress.forPort ?? "?"})`);
  if (!egress.ip) { line("[ABORT] proxy egress IP unknown - refusing to scan blind"); process.exit(1); }
  if (egress.ip === direct) { line("[ABORT] egress IP == this machine's IP - the proxy is not in the path"); process.exit(1); }
  line("proxy path confirmed.");
  line("");

  for (const g of byCity) {
    line(`--- ${g.city} ---`);
    let spent = 0;
    for (const c of g.cases) {
      const take = c.spellings.slice(0, Math.max(0, MAX_PROBES - spent));
      if (!take.length) break;
      spent += take.length;
      line(`   ${c.label}`);
      for (const s of take) {
        try {
          const r: any = await scanAddress(s, c.city, STATE, c.zip);
          line(`      ${s.padEnd(46)} -> ${verdict(r)}`);
        } catch (e: any) {
          line(`      ${s.padEnd(46)} -> ERROR ${String(e?.message ?? e).slice(0, 90)}`);
        }
        await sleep(400);
      }
    }
  }
  line("");
  line("lane spend:");
  for (const l of pf.getLaneState()) line(`   lane ${l.id}: port ${l.port}, ${l.checks} checks`);
}

// ── phase: bridge ────────────────────────────────────────────────────────────
function countTargets(cities: string[]): number {
  const marks = cities.map(() => "?").join(",");
  return (rawDb.prepare(
    `SELECT COUNT(*) AS n FROM scan_targets
      WHERE tenant_id=? AND upper(trim(state))=? AND upper(trim(city)) IN (${marks})`,
  ).get(TENANT, STATE, ...cities.map((c) => c.toUpperCase())) as { n: number }).n;
}

async function bridge(cities: string[]): Promise<void> {
  // The canonical index must still be non-unique when keys are stamped.
  // yieldRollups promotes it to UNIQUE once scanTargetCanonicalMerge reports
  // zero duplicate groups, and that manifest filters `canonical_key IS NOT
  // NULL` - so it can read all-clear while duplicates hide behind NULL. Stamp
  // keys after the promotion and every hidden collision becomes a write error.
  const canonIdx = rawDb.prepare(
    `SELECT "unique" AS uniq FROM pragma_index_list('scan_targets') WHERE name='idx_scan_targets_canonical'`,
  ).get() as { uniq: number } | undefined;
  if (Number(canonIdx?.uniq ?? 0) === 1 && APPLY) {
    line("REFUSING TO APPLY - idx_scan_targets_canonical is already UNIQUE.");
    line("Backfilling canonical_key now would turn hidden duplicate groups into write");
    line("errors. Size the groups first, decide the merge, then come back.");
    process.exit(2);
  }

  const before = countTargets(cities);
  const held = heldRows(cities);
  line("");
  const stamped = await backfillKeys(held);
  await fillHeldStreetKeys(held);
  line("");

  // What the keys we are about to write already match. Read-only, and far more
  // useful than "would upsert N": the canonical twin is the guard that decides
  // most of it, and it can be evaluated without writing. Only rows under a
  // TARGET city label can collide - city is part of the key - so this is the
  // post-backfill key universe, dry run and apply alike.
  const keysHeld = new Set<string>();
  for (const r of held) if (r.canonicalKey) keysHeld.add(r.canonicalKey);
  for (const s of stamped) keysHeld.add(s.key);

  let totalDoors = 0, totalUnits = 0, totalUnproven = 0, totalTwins = 0;
  const all: ReturnType<typeof doorsFor>["doors"] = [];
  for (const city of cities) {
    const { doors, skippedUnits, unproven } = doorsFor(city);
    const twins = doors.filter((d) => keysHeld.has(normalizeKineticAddressKey(d.address, d.city, STATE, d.zip))).length;
    totalDoors += doors.length; totalUnits += skippedUnits; totalUnproven += unproven; totalTwins += twins;
    line(`${city.padEnd(16)} ${String(doors.length).padStart(6)} doors  ${String(twins).padStart(6)} already held by key  ${String(doors.length - twins).padStart(6)} unmatched`
      + (skippedUnits ? `  (${skippedUnits} unit door(s) held back)` : "")
      + (unproven ? `  [${unproven} on an unproven spelling]` : ""));
    all.push(...doors);
  }
  line("-".repeat(84));
  line(`${n(totalDoors)} doors to upsert   ${n(totalTwins)} already held by canonical key   ${n(totalDoors - totalTwins)} unmatched`);
  if (totalUnits) line(`${n(totalUnits)} unit door(s) held back - see the UNIT ADDRESSES note in this file's header`);
  if (totalUnproven) {
    line(`${n(totalUnproven)} door(s) carry a route spelling no provider call has confirmed.`);
    line(`   Measure them first:  npx tsx script/import-rowan.ts --phase probe ${cities.map((c) => `--city "${c}"`).join(" ")}`);
  }

  if (!APPLY) {
    line("");
    line(`The "unmatched" column is an upper bound on new rows: the postal-city alias`);
    line(`twin (street_key + house number + coordinates within ~25 m) runs only on a`);
    line(`write and will attach some of them to doors we already hold under another`);
    line(`city label. Re-run with --apply for the real count.`);
    line("");
    line(`scan_targets in scope now: ${n(before)}`);
    return;
  }

  const startMaxId = (rawDb.prepare(`SELECT COALESCE(MAX(id),0) AS id FROM scan_targets`).get() as { id: number }).id;
  streetKeyCursor = startMaxId;
  let added = 0;
  for (let i = 0; i < all.length; i += BATCH) {
    added += storage.upsertScanTargets(all.slice(i, i + BATCH));
    // Fill street_key as we go: the alias-twin guard READS street_key, so a
    // batch whose rows still carry NULL is invisible to the next batch's guard.
    await fillStreetKeys();
    if (PAUSE_MS) await sleep(PAUSE_MS);
    if (((i / BATCH) | 0) % 20 === 0) process.stdout.write(`\r  upserted ${n(Math.min(i + BATCH, all.length))}/${n(all.length)}`);
  }
  process.stdout.write("\r".padEnd(48) + "\r");

  const after = countTargets(cities);
  line(`upsertScanTargets: ${n(added)} new door(s); the rest attached to doors already held`);
  line(`scan_targets in scope: ${n(before)} -> ${n(after)}`);
  const unscanned = (rawDb.prepare(
    `SELECT COUNT(*) AS n FROM scan_targets WHERE tenant_id=? AND last_scanned_at IS NULL AND id>?`,
  ).get(TENANT, startMaxId) as { n: number }).n;
  line(`never-scanned doors this run added: ${n(unscanned)}`);
  line("");
  line("Bridging is free. SCANNING these doors is a separate, separately-authorized");
  line("decision - size the spend first (about 20 checks per residential IP + token pair).");
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!Number.isInteger(TENANT) || TENANT <= 0) { line("--tenant <id> must be a positive integer (production org is 1)"); process.exit(1); }
  if (!["plan", "probe", "bridge"].includes(PHASE)) { line(`--phase must be plan, probe or bridge (got "${PHASE}")`); process.exit(1); }
  // Local tool. The production database lives on the /data volume and is reached
  // through a workflow that runs the bundled build in a one-off container, never
  // through a developer shell.
  //
  // The test is the resolved DATABASE PATH, not NODE_ENV. This box's own .env
  // sets NODE_ENV=production, so keying on it refused a --phase probe run that
  // writes nothing to the database at all, and would have kept refusing every
  // legitimate local apply the moment that .env was loaded. A guard that fires
  // on the wrong signal gets switched off, which is worse than not having it.
  //
  // Scoped to the writing phase: probe spends money but touches no row, and it
  // has its own two-flag gate.
  if (APPLY && PHASE === "bridge" && dbPath.startsWith("/data/")) {
    line(`REFUSING TO APPLY against ${dbPath} - that is the production volume.`);
    line("This script writes to a local DATA_DIR only.");
    process.exit(1);
  }

  // Migrations only when they are actually needed: on a fresh or replayed
  // database, and before any write. A dry run against a live local database
  // should not take the write lock at all - another session's scan run may be
  // holding it, and a read-only phase has no business competing for it.
  const hasTable = (t: string) => rawDb.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(t) != null;
  if (APPLY || !hasTable("scan_targets")) runMigrations();
  if (APPLY || !hasTable("address_points")) ensureAddressPointSchema();

  const have = (rawDb.prepare(`SELECT COUNT(*) AS n FROM address_points WHERE county=?`).get(COUNTY) as { n: number }).n;
  if (!have) {
    line(`No ${COUNTY} address points. Import them first (free, public, no key):`);
    line(`   importCountyAddressPoints("${COUNTY}")  - server/addressPointImport.ts`);
    process.exit(1);
  }

  const cities = resolveCities();
  line("=".repeat(84));
  line(`${COUNTY} County, ${STATE} - phase ${PHASE} - tenant ${TENANT} - ${APPLY ? "APPLY" : "DRY RUN"}`);
  line(`DB ${dbPath}`);
  line(`${n(have)} E911 points in the county; ${cities.length} town(s) in scope`);
  line("=".repeat(84));
  line("");

  if (PHASE === "plan") plan(cities);
  else if (PHASE === "probe") await probe(cities);
  else await bridge(cities);

  if (!APPLY) { line(""); line("DRY RUN - nothing was written."); }
}

// Run only when this file IS the command. Importing it (the regression tests
// do) must not start a county import as a side effect, and the normalization
// above is the part worth testing.
if (/(^|[\\/])import-rowan\.ts$/.test(process.argv[1] ?? "")) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(`[import-rowan] FAILED: ${e?.stack ?? e}`);
    process.exit(1);
  });
}
