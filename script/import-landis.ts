// ── Landis, NC: put the real door inventory in, with addresses Kinetic matches ─
//
// WHY THIS EXISTS
// Landis carried THREE mapped doors. Rowan County's E911 file lists 2,193.
// The subdivision the field reported as newly lit (Sawtooth Oak Dr, English Oak
// Ln, Georgia Oak Ln, Landis Oak Way, Sawtooth Ct, Overcup/Pin Oak/Sandhill Oak
// Ct — "the Oaks") held 53 of its 206 doors, and every one of those 53 was
// filed under the WRONG POSTAL CITY. Nothing was broken in the scanner; we
// simply did not have the town.
//
// Two defects made the doors we DID have unaskable, and both read in the logs
// as "no fiber" rather than as our own bug (measured live 2026-08-27, same
// door, same minute):
//
//   "520 Sawtooth Oak Drive, Landis, NC 28088"  -> AddressSuggestions, no match
//   "520 Sawtooth Oak Dr,    Landis, NC 28088"  -> AddressFound, exactMatch,
//                                                  QUAL UP TO 1 GIG VIA FIBER,
//                                                  techType FIBER, billing N
//   "855 Georgia Oak Lane, China Grove, NC"     -> echoedIdentity mismatch
//   "855 Georgia Oak Lane, Landis, NC"          -> AddressFound, exactMatch
//
//   1. SUFFIX. E911 ships "SAWTOOTH OAK DRIVE"; Kinetic matches the USPS
//      abbreviation. Writing E911's text through verbatim produced 61 of 106
//      non-answers on one subdivision.
//   2. POSTAL CITY. scanner.ts's address-identity gate compares the identity we
//      SENT with the one Kinetic ECHOED, and city is part of that key. Doors we
//      hold as "China Grove" that Kinetic echoes as "LANDIS" fail the gate, so
//      a successful AddressFound + exactMatch answer carrying real
//      qualification is DISCARDED as inconclusive. The gate is correct and is
//      not touched here — E911's post_comm is authoritative and agrees with
//      Kinetic's own echo, so the LABEL is what gets fixed.
//
// Repairing both locally took the Oaks from 0 answers to 206/206, every one
// fiber-qualified.
//
// WHAT THIS SCRIPT DOES — and deliberately does NOT do
//   --phase=bridge   E911 address points -> scan_targets, then repair the city
//                    label and the street suffix. FREE: no provider call.
//   --phase=mint     turn already-scanned, fiber-qualified, unbilled doors into
//                    leads. FREE: reads verdicts that already exist.
//
// It never scans. Buying answers is a separate, separately-gated decision, and
// this script must be safe to run without spending anything.
//
// WHY storage.upsertScanTargets AND NOT RAW SQL
// It owns the two dedup guards that make this safe to re-run: the canonical
// twin (same premise, different spelling) and the CITY-ALIAS twin (same premise
// under another postal city, matched on street_key + state + house number +
// coordinates within ~25 m). That second one is the whole ballgame here — 290
// of Landis's 2,193 E911 points are doors we already hold as "China Grove", and
// without it this import would mint 290 duplicate doors. Re-implementing that
// logic in a one-off script is exactly how a second, drifting copy of a rule
// gets born.
//
// USAGE — dry run is the default. Nothing is written without --apply.
//
//   tsx script/import-landis.ts --tenant 1 --phase bridge
//   tsx script/import-landis.ts --tenant 1 --phase bridge --apply
//
// In PRODUCTION nobody has a shell — run it through
// .github/workflows/import-landis.yml, which executes the bundled build
// (`node dist/import-landis.cjs`) in a one-off container on the live /data
// volume, the reset-areas.yml / import-fcc-pins.yml pattern.

import { storage, runMigrations } from "../server/storage";
import { rawDb } from "../server/db";
import { canonicalAddressPart, streetKeyOf, normalizeKineticAddressKey } from "@shared/addressKey";
import { ensureAddressPointSchema } from "../server/addressPointStore";
import { importCountyAddressPoints } from "../server/addressPointImport";

const COUNTY = "ROWAN";
const CITY = "Landis";
const ZIP = "28088";
const STATE = "NC";

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : null;
}
const APPLY = process.argv.includes("--apply");
// The projector refuses to publish a door where a non-Kinetic FIBER competitor
// is present, and that default stands here. The operator overrode it for Landis
// on 2026-08-27, having been shown the count and the competitor first ("add all
// leads wherver kineitc fiber is in landis dosent matter the competion as long
// its sellable"), so the override exists — as an explicit flag that has to be
// typed, never as a quiet default. Doors it lets through are stamped with the
// competitor's name/tech and in_competitor_area so a rep sees it at the door.
const INCLUDE_RIVAL_FIBER = process.argv.includes("--include-competitor-fiber");
const TENANT = Number(flag("tenant") ?? 0);
const PHASE = (flag("phase") ?? "bridge").toLowerCase();
const line = (s = "") => console.log(s);

// E911 ships SCREAMING CASE with full suffix words. Reps read this string on the
// lead card and Kinetic matches the abbreviation, so both want the same thing.
// Casing cannot create a duplicate: the unique index is on lower(trim(address))
// and the canonical key uppercases.
const KEEP_UPPER = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW", "US", "NC", "SR"]);
const SUFFIX: Record<string, string> = {
  STREET: "St", ROAD: "Rd", AVENUE: "Ave", DRIVE: "Dr", COURT: "Ct", LANE: "Ln",
  BOULEVARD: "Blvd", HIGHWAY: "Hwy", PLACE: "Pl", TERRACE: "Ter", CIRCLE: "Cir",
  PARKWAY: "Pkwy", TRAIL: "Trl", PLAZA: "Plz", SQUARE: "Sq", CROSSING: "Xing",
};
function titleCase(s: string): string {
  return s.trim().split(/\s+/).map((w) => {
    const u = w.toUpperCase();
    if (KEEP_UPPER.has(u)) return u;
    if (/^\d+(ST|ND|RD|TH)$/.test(u)) return u.toLowerCase();
    return u.charAt(0) + u.slice(1).toLowerCase();
  }).join(" ");
}
/** USPS-abbreviate the trailing street type only. Mid-name words are never
 *  touched — folding those would mangle "Oak Ridge Ct" the way the canonical
 *  key's own SUFFIXES table warns about. */
function abbreviate(addr: string): string {
  const parts = addr.trim().split(/\s+/);
  if (parts.length < 2) return addr;
  const last = parts[parts.length - 1].toUpperCase();
  if (!SUFFIX[last]) return addr;
  parts[parts.length - 1] = SUFFIX[last];
  return parts.join(" ");
}
const normalize = (raw: string) => abbreviate(titleCase(raw));

// ── phase: bridge ──────────────────────────────────────────────────────────
async function bridge() {
  ensureAddressPointSchema();
  let points = rawDb.prepare(
    `SELECT street, zip, lat, lng FROM address_points
      WHERE county=? AND upper(city)=upper(?) AND lat IS NOT NULL AND lng IS NOT NULL`,
  ).all(COUNTY, CITY) as Array<{ street: string; zip: string | null; lat: number; lng: number }>;

  if (!points.length) {
    line(`no ${COUNTY} address points for ${CITY} — importing from NC OneMap (public, free, no key)`);
    if (!APPLY) { line("  (dry run: skipping the import; re-run with --apply)"); return; }
    const r = await importCountyAddressPoints(COUNTY);
    line(`  imported ${r.fetched} points (${r.inserted} new, ${r.updated} updated), truncated=${r.truncated}`);
    if (r.truncated) throw new Error("county import hit its page guard — inventory would be incomplete");
    points = rawDb.prepare(
      `SELECT street, zip, lat, lng FROM address_points
        WHERE county=? AND upper(city)=upper(?) AND lat IS NOT NULL AND lng IS NOT NULL`,
    ).all(COUNTY, CITY) as typeof points;
  }
  line(`E911 points for ${CITY}: ${points.length}`);

  const before = countTargets();
  if (APPLY) {
    const rows = points.map((p) => ({
      address: normalize(p.street), city: CITY, state: STATE, zip: p.zip ?? ZIP,
      lat: p.lat, lng: p.lng, source: "e911-nc-onemap", tenantId: TENANT,
    }));
    let added = 0;
    for (let i = 0; i < rows.length; i += 500) added += storage.upsertScanTargets(rows.slice(i, i + 500));
    fillStreetKeys();
    line(`upsertScanTargets: ${added} new doors (the rest attached to doors already held)`);
  } else {
    line(`would upsert ${points.length} doors (dedup decides how many are new)`);
  }

  repair();
  const after = countTargets();
  line("");
  line(`${CITY} scan_targets: ${before} -> ${after}`);
}

// street_key is not set by the insert; yieldRollups' janitor normally fills it a
// tick or two later. Do it here with the SAME shared streetKeyOf the janitor
// uses — importing yieldRollups would drag in scanIntelStore, which prepares
// statements at module load and so cannot be imported before migrations exist.
function fillStreetKeys(): void {
  const rows = rawDb.prepare(
    `SELECT id, address FROM scan_targets WHERE street_key IS NULL AND tenant_id=?`,
  ).all(TENANT) as Array<{ id: number; address: string | null }>;
  if (!rows.length) return;
  const upd = rawDb.prepare(`UPDATE scan_targets SET street_key=? WHERE id=?`);
  rawDb.transaction((batch: typeof rows) => {
    for (const r of batch) upd.run(streetKeyOf(r.address ?? ""), r.id);
  }).immediate(rows);
  line(`  filled street_key on ${rows.length} rows`);
}

function countTargets(): number {
  return (rawDb.prepare(
    `SELECT COUNT(*) n FROM scan_targets WHERE tenant_id=? AND lower(city)=lower(?) AND state=?`,
  ).get(TENANT, CITY, STATE) as any).n;
}

/** Re-derive any canonical_key left behind by an earlier relabel. */
function repairStaleKeys(): void {
  const fixes = staleKeyRows();
  if (!fixes.length) return;
  const k = rawDb.prepare(`UPDATE scan_targets SET canonical_key=? WHERE id=?`);
  rawDb.transaction((batch: typeof fixes) => {
    for (const r of batch) k.run(normalizeKineticAddressKey(r.address, r.city, STATE, ZIP), r.id);
  }).immediate(fixes);
  line(`  re-derived ${fixes.length} stale canonical_key(s) left by an earlier relabel`);
}

/** ZIP-28088 rows whose stored canonical_key no longer matches address|city|state. */
function staleKeyRows(): Array<{ id: number; address: string; city: string }> {
  const rows = rawDb.prepare(
    `SELECT id, address, city, canonical_key AS key FROM scan_targets
      WHERE tenant_id=? AND zip=? AND state=? AND canonical_key IS NOT NULL`,
  ).all(TENANT, ZIP, STATE) as Array<{ id: number; address: string; city: string; key: string }>;
  return rows.filter((r) => r.key !== normalizeKineticAddressKey(r.address, r.city, STATE, ZIP));
}

/** Fix the postal city and the street suffix on every ZIP-28088 door. */
function repair() {
  const rows = rawDb.prepare(
    `SELECT id, address, city FROM scan_targets WHERE tenant_id=? AND zip=? AND state=?`,
  ).all(TENANT, ZIP, STATE) as Array<{ id: number; address: string; city: string }>;

  // Claim map seeded with every row's CURRENT identity, so a rewrite collides
  // both against rows we are not touching AND against another row in this same
  // batch (two labels of one door collapsing onto each other) — the second kind
  // is invisible to a "does it exist now" pre-check and aborts the transaction
  // mid-way when the unique index sees it.
  const idOf = (a: string, c: string) => `${a.trim().toLowerCase()}|${c.trim().toLowerCase()}`;
  const claimed = new Map<string, number>();
  for (const r of rows) claimed.set(idOf(r.address, r.city), r.id);

  // WHICH CITY a door belongs to is E911's answer, not a blanket ZIP rule.
  // ZIP 28088 is mostly Landis but NOT only Landis — the county file puts 6
  // Kannapolis and 4 China Grove addresses in it, and relabelling those
  // "Landis" because they share the ZIP is just a new wrong label replacing the
  // old one. Two doors on N Chapel St were mislabelled exactly that way before
  // this was keyed on the address instead. A door E911 does not know keeps
  // whatever city it already has — guessing is what got us here.
  const truth = new Map<string, string>();
  for (const p of rawDb.prepare(
    `SELECT street, city FROM address_points WHERE zip=? AND city IS NOT NULL`,
  ).all(ZIP) as Array<{ street: string; city: string }>) {
    truth.set(canonicalAddressPart(p.street), titleCase(p.city));
  }

  const plan: Array<{ id: number; address: string; city: string }> = [];
  const dupes: Array<{ id: number; from: string; onto: string }> = [];
  let keyMoved = 0;
  let unknown = 0;
  for (const r of rows) {
    const e911City = truth.get(canonicalAddressPart(r.address));
    if (!e911City) unknown++;
    const newCity = e911City ?? r.city;
    const newAddr = abbreviate(r.address);
    if (newCity === r.city && newAddr === r.address) continue;
    // The canonical identity must NOT move — that is what makes this safe.
    // canonicalAddressPart already folds DRIVE->DR, so only the raw string
    // changes and no lead, target or dedup identity is disturbed.
    if (canonicalAddressPart(newAddr) !== canonicalAddressPart(r.address)) { keyMoved++; continue; }
    const want = idOf(newAddr, newCity);
    const holder = claimed.get(want);
    if (holder !== undefined && holder !== r.id) {
      // The same door held twice. Leave BOTH alone and report: merging rows is
      // a destructive operation and is not this script's decision to make.
      dupes.push({ id: r.id, from: `${r.address}, ${r.city}`, onto: `${newAddr}, ${newCity}` });
      continue;
    }
    claimed.delete(idOf(r.address, r.city));
    claimed.set(want, r.id);
    plan.push({ id: r.id, address: newAddr, city: newCity });
  }

  // Computed in JS, never in SQL: the canonical key folds street suffixes,
  // directionals and unit designators, so a SQL string concat would flag most
  // healthy rows as stale.
  const staleKeys = staleKeyRows().length;
  line(`address repair: ${plan.length} rows to rewrite (city label and/or street suffix)`);
  if (unknown) line(`  ${unknown} row(s) have no E911 counterpart in ZIP ${ZIP} — city left exactly as found`);
  {
    const toOther = plan.filter((p) => p.city.toLowerCase() !== CITY.toLowerCase());
    if (toOther.length) {
      line(`  ${toOther.length} row(s) go to a city OTHER than ${CITY}, because E911 says so:`);
      for (const p of toOther.slice(0, 8)) line(`     #${p.id} "${p.address}" -> ${p.city}`);
    }
  }
  if (staleKeys) line(`  ${staleKeys} row(s) carry a canonical_key that no longer matches their address/city — re-derived on apply`);
  if (keyMoved) line(`  ${keyMoved} skipped — the canonical key would have moved`);
  if (dupes.length) {
    line(`  ${dupes.length} duplicate door(s) left untouched (merging is a separate decision):`);
    for (const d of dupes.slice(0, 10)) line(`     #${d.id} "${d.from}"  ==  "${d.onto}"`);
  }
  if (!APPLY) return;
  // NOTE the guard is on APPLY alone. Gating the whole block on `plan.length`
  // too — as a first draft did — silently skips the stale-key repair below
  // whenever the addresses are already correct, which is exactly the state a
  // re-run is in.
  if (!plan.length) { repairStaleKeys(); return; }

  // canonical_key MUST move with the city. It is `addr|city|state`, and it is
  // what upsertScanTargets' canonical-twin guard and the projector's lead
  // matching both key on. Leaving it saying CHINA GROVE on a row now labelled
  // Landis leaves the twin guard relying on its coordinate fallback, and a row
  // with no coordinates would then duplicate.
  const upd = rawDb.prepare(`UPDATE scan_targets SET address=?, city=?, canonical_key=? WHERE id=?`);
  rawDb.transaction((batch: typeof plan) => {
    for (const p of batch) upd.run(p.address, p.city, normalizeKineticAddressKey(p.address, p.city, STATE, ZIP), p.id);
  }).immediate(plan);
  line(`  rewrote ${plan.length} (address, city and canonical_key together)`);

  repairStaleKeys();
}

// ── phase: mint ────────────────────────────────────────────────────────────
// Turns verdicts that ALREADY EXIST into leads. Buys nothing.
//
// Why this is needed at all: freshFiberProjector only considers a door with
// `first_seen_fiber_at` set or a NEW FIBER segment, and first_seen_fiber_at is
// stamped only on an observed FLIP (needs a prior negative) or on NEW FIBER. A
// town discovered ALREADY LIT has neither, so it mints nothing however sellable
// it is. Landis: 1,311 of 1,351 answered doors had fiber and 39 had the stamp.
//
// The door still has to be genuinely sellable, and that is evidenced WITHOUT
// the household segment — which means "nobody is paying", never "fiber is
// live", and has been misread as the latter three times in this codebase:
//   fiber live  -> last_fiber_available=1, from maxQual + techType FIBER
//   nobody pays -> billing N
// Every projector protection is kept: competitive eligibility, the
// address-review quarantine, carrier, and a CONCLUSIVE latest snapshot.
function mint() {
  const rows = rawDb.prepare(`
    SELECT s.id, s.address, s.city, s.state, s.zip, s.lat, s.lng,
           s.last_fiber_status AS fiberStatus, s.last_billing_status AS billing,
           s.last_max_qual AS maxQual, s.df_address_id AS dfAddressId,
           s.access_id AS accessId, s.exchange_id AS exchangeId, s.first_seen_fiber_at AS flipStamp,
           a.max_download_mbps AS maxDown, a.household_segment_type AS seg,
           a.competitive_decision AS decision, a.competitor_name AS competitorName,
           a.competitor_tech AS competitorTech, s.competitor_speed_mbps AS competitorSpeed,
           replace(substr(a.checked_at,1,19),'T',' ') AS confirmedAt
      FROM scan_targets s
      JOIN availability_snapshots a ON a.id=(
        SELECT x.id FROM availability_snapshots x
         WHERE x.scan_target_id=s.id AND x.tenant_id=? AND x.conclusive=1
         ORDER BY x.checked_at_epoch DESC, x.id DESC LIMIT 1)
     WHERE s.tenant_id=? AND lower(s.city)=lower(?) AND s.state=?
       AND s.converted_to_lead_id IS NULL
       AND s.last_fiber_available=1
       AND s.last_billing_status='N'
       AND COALESCE(s.carrier,'kinetic')='kinetic'
       AND s.address_review_reason IS NULL
       AND a.fiber_available=1
     ORDER BY s.street_key, CAST(s.address AS INTEGER)`).all(TENANT, TENANT, CITY, STATE) as any[];

  const isBlocked = (r: any) => r.decision === "excluded_fiber_competitor" || r.decision === "competitor_review";
  const blocked = rows.filter(isBlocked);
  const clear = INCLUDE_RIVAL_FIBER ? rows : rows.filter((r) => !isBlocked(r));
  line(`sellable ${CITY} doors with no lead : ${rows.length}`);
  line(`  competitively clear               : ${rows.length - blocked.length}`);
  line(`  a FIBER rival is present          : ${blocked.length}`
    + (INCLUDE_RIVAL_FIBER
      ? "  <- INCLUDED by --include-competitor-fiber"
      : "  (held back — the projector would never publish these)"));
  if (INCLUDE_RIVAL_FIBER && blocked.length) {
    const byRival = blocked.reduce((a: Record<string, number>, r) => {
      const k = `${r.competitorName ?? "?"} / ${r.competitorTech ?? "?"}`; a[k] = (a[k] ?? 0) + 1; return a; }, {});
    for (const [k, n] of Object.entries(byRival)) line(`     ${String(k).padEnd(34)} ${n}`);
    const exposed = blocked.filter((r) => r.flipStamp != null).length;
    if (exposed) {
      line(`     NOTE: ${exposed} of these carry a first_seen_fiber_at stamp, so they are visible to`);
      line(`     freshFiberProjector and IT WILL RETRACT them to 'competitor_suppressed' on its`);
      line(`     next pass. Nothing here changes that gate.`);
    }
  }
  line(`  to mint now                       : ${clear.length}`);
  if (!APPLY) { line("\n(dry run — nothing written)"); return; }

  const link = rawDb.prepare(`UPDATE scan_targets SET converted_to_lead_id=? WHERE id=? AND tenant_id=?`);
  let event: import("better-sqlite3").Statement | null = null;
  try {
    event = rawDb.prepare(`INSERT INTO lead_events (lead_id,type,actor,detail,at)
      VALUES (?,'created','Landis Qualification Import',?,datetime('now'))`);
  } catch { /* lead_events absent on bare replay DBs */ }

  let created = 0, attached = 0, failed = 0;
  for (const r of clear) {
    const isNewFiber = String(r.seg ?? "").toUpperCase() === "NEW FIBER" && String(r.billing ?? "").toUpperCase() === "N";
    try {
      const lead = storage.createLead({
        address: r.address, city: r.city, state: r.state, zip: r.zip, lat: r.lat, lng: r.lng,
        // A lead marked new_fiber must satisfy trg_leads_fresh_insert_guard, which
        // wants the whole confirmation package. Supply it from the evidence we
        // have rather than weakening the trigger; otherwise file it as found.
        fiberStatus: isNewFiber ? "new_fiber" : (r.fiberStatus ?? "tenured_fiber"),
        ...(isNewFiber ? {
          isNewFiber: 1, freshConfirmedAt: r.confirmedAt, leadTag: "fresh_fiber_confirmed",
          freshConfidence: "provider_new_fiber", freshSources: JSON.stringify(["kinetic"]),
        } : {}),
        householdSegmentType: r.seg ?? null, billingStatus: r.billing,
        maxQual: r.maxQual ?? null, techType: "FIBER", maxDownloadMbps: r.maxDown ?? null,
        competitorName: r.competitorName ?? null, competitorTech: r.competitorTech ?? null,
        competitorSpeedMbps: r.competitorSpeed ?? null,
        inCompetitorArea: isBlocked(r) ? 1 : 0,
        dfAddressId: r.dfAddressId ?? null, accessId: r.accessId ?? null, exchangeId: r.exchangeId ?? null,
        leadStatus: "prospect", sourceScanTargetId: r.id, tenantId: TENANT, carrier: "kinetic",
      } as any);
      const fresh = !rawDb.prepare(`SELECT 1 FROM scan_targets WHERE converted_to_lead_id=? AND id<>?`).get(lead.id, r.id);
      link.run(lead.id, r.id, TENANT);
      if (fresh) created++; else attached++;
      if (event) {
        try {
          event.run(lead.id, `Minted from Kinetic qualification checked ${r.confirmedAt}: `
            + `maxQual="${r.maxQual ?? "?"}" techType=FIBER billing=N segment=${r.seg ?? "?"}.`
            + (isBlocked(r) ? ` COMPETITOR PRESENT: ${r.competitorName ?? "?"} ${r.competitorTech ?? "?"} (${r.decision}) - included by operator direction.` : ""));
        } catch { /* non-fatal */ }
      }
    } catch (e: any) {
      failed++;
      if (failed <= 5) line(`   [fail] #${r.id} ${r.address}: ${String(e?.message ?? e).slice(0, 140)}`);
    }
  }
  line("");
  line(`created=${created} attached_to_existing=${attached} failed=${failed}`);
}

async function main() {
  if (!Number.isInteger(TENANT) || TENANT <= 0) {
    line("--tenant <id> is required (production org is 1)");
    process.exit(1);
  }
  if (!["bridge", "mint"].includes(PHASE)) {
    line(`--phase must be "bridge" or "mint" (got "${PHASE}")`);
    process.exit(1);
  }
  runMigrations();
  line("=".repeat(72));
  line(`${CITY}, ${STATE} — phase ${PHASE} — tenant ${TENANT} — ${APPLY ? "APPLY" : "DRY RUN"}`);
  line("=".repeat(72));

  if (PHASE === "bridge") await bridge();
  else mint();

  const t = rawDb.prepare(`
    SELECT COUNT(*) doors, SUM(last_scanned_at IS NOT NULL) answered,
           SUM(last_fiber_available=1) fiber,
           SUM(last_fiber_available=1 AND last_billing_status='N') sellable,
           SUM(converted_to_lead_id IS NOT NULL) leads
      FROM scan_targets WHERE tenant_id=? AND lower(city)=lower(?) AND state=?`)
    .get(TENANT, CITY, STATE) as any;
  line("");
  line(`${CITY.toUpperCase()} NOW: ${t.doors} doors | ${t.answered} answered | ${t.fiber} fiber | ${t.sellable} sellable | ${t.leads} leads`);
  if (!APPLY) line("\nDRY RUN — nothing was written. Re-run with --apply.");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`[import-landis] FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
