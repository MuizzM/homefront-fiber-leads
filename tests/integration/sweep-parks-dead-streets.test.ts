// A CITY SWEEP STOPS CHECKING A STREET THAT HAS NO FIBER.
//
// Measured live 2026-08-24: a blind city run checked 250 Charlotte doors and got
// 250 unmatched - Kinetic does not know those addresses at all, because the
// inventory there is an OSM address grid over a city it barely serves. The same
// shape appears in reverse in Statesville: every door recognised, every one
// "no service". Both are the same waste, and both are visible after ONE answer
// on the street.
//
// So the sweep probes a street, and parks the rest of it unless something
// answered. Streets are lit together - that is the whole premise of the
// neighbourhood sweep's 22.5% vs 0.9% measurement - so the first answers on a
// street are strong evidence about the rest of it.
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let parkDeadStreets: typeof import("../../server/sweepService").parkDeadStreets;
const TENANT = 1;
const JOB = "sweep_test_1";

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-sweep-park-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  parkDeadStreets = (await import("../../server/sweepService")).parkDeadStreets;
  rawDb.prepare(`INSERT INTO sweep_jobs (id,tenant_id,kind,query,city,state,max_checks,phase,status)
    VALUES (?,?,'city','Testville, NC','Testville','NC',1000,'checking','running')`).run(JOB, TENANT);
});

/**
 * A door on a street, optionally already ANSWERED by the provider.
 *
 * An answered door gets an availability_snapshots row, because that is what
 * proves the provider was actually asked. Marking a target 'done' does not:
 * a run that enqueues nothing still finishes and the sweep marks its batch done
 * regardless, which is exactly how 106 Broadway doors were "checked" live with
 * no provider call behind any of them.
 */
function door(street: string, houseNumber: number, answer: { status?: string; available?: 0 | 1 } | null): number {
  const address = `${houseNumber} ${street}`;
  const id = Number(rawDb.prepare(
    `INSERT INTO scan_targets (address,city,state,zip,lat,lng,tenant_id,source,street_key,last_fiber_status,last_fiber_available,last_scanned_at)
     VALUES (?,?,?,?,?,?,?,'osm',?,?,?,?)`).run(
    address, "Testville", "NC", "27000", 35.1, -80.1, TENANT, street.toLowerCase(),
    answer?.status ?? null, answer?.available ?? null, answer ? "2026-08-24 12:00:00" : null,
  ).lastInsertRowid);
  if (answer) {
    rawDb.prepare(`INSERT INTO availability_snapshots (tenant_id,scan_target_id,checked_at_epoch,conclusive,transition_status,evidence_hash)
      VALUES (?,?,?,1,'baseline_unavailable',?)`).run(TENANT, id, Date.now(), `h-${id}`);
  }
  rawDb.prepare(`INSERT INTO sweep_job_targets (sweep_job_id,target_id,seq,state) VALUES (?,?,?,?)`)
    .run(JOB, id, id, answer ? "done" : "queued");
  return id;
}

/** A door the sweep marked done WITHOUT the provider ever answering it. */
function unaskedDoor(street: string, houseNumber: number): number {
  const address = `${houseNumber} ${street}`;
  const id = Number(rawDb.prepare(
    `INSERT INTO scan_targets (address,city,state,zip,tenant_id,source,street_key)
     VALUES (?,?,?,?,?,'osm',?)`).run(address, "Testville", "NC", "27000", TENANT, street.toLowerCase()).lastInsertRowid);
  rawDb.prepare(`INSERT INTO sweep_job_targets (sweep_job_id,target_id,seq,state) VALUES (?,?,?,'done')`)
    .run(JOB, id, id);
  return id;
}

describe("a city sweep parks streets with no fiber", () => {
  it("parks the rest of a dead street, keeps a street that answered, and never touches an unprobed one", () => {
    // DEAD: two answered doors, neither serviceable. 3 doors still queued.
    door("dead st", 100, { status: "no_service", available: 0 });
    door("dead st", 200, { status: "no_service", available: 0 });
    const deadQueued = [door("dead st", 300, null), door("dead st", 400, null), door("dead st", 500, null)];
    // UNMATCHED is the other failure shape: the provider ANSWERED, with
    // "we do not know this address", so there is a snapshot and no verdict.
    door("ghost ln", 10, { status: null, available: null });
    door("ghost ln", 20, { status: null, available: null });
    const ghostQueued = [door("ghost ln", 30, null)];
    // NEVER ASKED: marked done by a run that enqueued nothing. No snapshot, so
    // no evidence, so this street must survive.
    unaskedDoor("phantom ct", 10); unaskedDoor("phantom ct", 20);
    const phantomQueued = [door("phantom ct", 30, null)];
    // ALIVE: one probe found fiber, so the street is worth flooding.
    door("live ave", 100, { status: "new_fiber", available: 1 });
    door("live ave", 200, { status: "no_service", available: 0 });
    const liveQueued = [door("live ave", 300, null), door("live ave", 400, null)];
    // COMING SOON counts as alive - a dated build is worth knowing about.
    door("soon rd", 100, { status: "coming_soon", available: 0 });
    door("soon rd", 200, { status: "no_service", available: 0 });
    const soonQueued = [door("soon rd", 300, null)];
    // UNPROBED: nothing answered yet, so nothing may be parked.
    const unprobed = [door("quiet way", 100, null), door("quiet way", 200, null)];

    parkDeadStreets(JOB);
    const stateOf = (id: number) => (rawDb.prepare(`SELECT state FROM sweep_job_targets WHERE sweep_job_id=? AND target_id=?`).get(JOB, id) as any).state;

    for (const id of deadQueued) expect(stateOf(id), "no fiber on the street: parked").toBe("skipped");
    for (const id of ghostQueued) expect(stateOf(id), "provider does not know the street: parked").toBe("skipped");
    for (const id of liveQueued) expect(stateOf(id), "a street that answered is still checked").toBe("queued");
    for (const id of soonQueued) expect(stateOf(id), "coming soon is an answer worth having").toBe("queued");
    for (const id of unprobed) expect(stateOf(id), "a street nothing has asked about is never parked").toBe("queued");
    for (const id of phantomQueued) expect(stateOf(id), "done without an answer is not evidence of no fiber").toBe("queued");

    const job = rawDb.prepare(`SELECT streets_parked AS streets, doors_skipped AS doors FROM sweep_jobs WHERE id=?`).get(JOB) as any;
    expect(job.streets, "dead st and ghost ln").toBe(2);
    expect(job.doors).toBe(deadQueued.length + ghostQueued.length);
  });

  it("is idempotent - a second pass parks nothing new and does not double-count", () => {
    const before = rawDb.prepare(`SELECT streets_parked AS s, doors_skipped AS d FROM sweep_jobs WHERE id=?`).get(JOB) as any;
    parkDeadStreets(JOB);
    const after = rawDb.prepare(`SELECT streets_parked AS s, doors_skipped AS d FROM sweep_jobs WHERE id=?`).get(JOB) as any;
    expect(after).toEqual(before);
  });

  it("the probe batch runs alone, so there is something answered to prune against", async () => {
    // The gap this closes was found by running a real city from the UI, not by a
    // test: a 300-door Broadway sweep put every door in ONE batch, so the prune
    // ran before anything had answered and parked nothing. 300 checks across 53
    // streets, all 300 unmatched - 106 probes would have condemned every street.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/sweepService.ts"), "utf8");
    // Probes are the leading seq range and are selected on their own...
    expect(src).toContain("AND state='queued' AND seq < ? ORDER BY seq LIMIT 5000");
    // ...and the flood only runs once no probe row is left queued.
    expect(src).toContain("const batch = probeBatch.length");
    // The count has to be persisted, or a resumed job floods on its first tick.
    expect(src).toContain("probe_count: probeCount");
  });

  it("updateJob refuses an unknown column instead of dropping it silently", async () => {
    // This is how the probe batch shipped broken: probe_count was written and
    // silently discarded by a whitelist, so the gate read 0 and the flood ran
    // immediately. Two live Broadway runs, 600 provider calls, no error.
    const svc = await import("../../server/sweepService");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/sweepService.ts"), "utf8");
    expect(src, "probe_count must be writable").toContain('"probe_count"');
    expect(src, "and an unknown column must be loud").toContain("unknown sweep_jobs column(s)");
    expect(typeof svc.parkDeadStreets).toBe("function");
  });

  it("a street already proven dead is never queued at all", async () => {
    // Parking mid-run still costs one probe per street. A street this tenant has
    // already answered - repeatedly, with no fiber - should not cost even that.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/sweepService.ts"), "utf8");
    expect(src, "the queue excludes known-dead streets").toContain("SWEEP_DEAD_STREET_EVIDENCE");
    const queueBlock = src.slice(src.indexOf("DO NOT PAY TO RE-LEARN A DEAD STREET"), src.indexOf("const candidates ="));
    // Same evidence rule as the mid-run prune: only an ANSWERED door counts.
    expect(queueBlock, "an unasked door is evidence of nothing, here too")
      .toContain("EXISTS (SELECT 1 FROM availability_snapshots a WHERE a.scan_target_id=m.id)");
    expect(src, "and it must be reversible without a deploy").toContain("SWEEP_SKIP_KNOWN_DEAD");
    // RESOLVED ONCE. Correlating this aggregation to the outer row re-runs a
    // ~3.6s GROUP BY per candidate: a Lexington sweep sat 14 minutes at 98% CPU
    // and queued nothing. The set is fetched with explicit parameters and
    // applied in memory, so the outer query stays a plain indexed scan.
    expect(queueBlock, "parameterised, not correlated to the outer row")
      .toContain(".all(job.tenant_id, job.state, deadEvidence)");
    // The SQL itself must bind tenant and state, which a correlated subquery
    // cannot do. (Asserted on the query text, not the file: the comment above
    // it names the old correlated form on purpose.)
    expect(queueBlock, "tenant and state are bound, not correlated")
      .toContain("WHERE m.tenant_id=? AND m.state=?");
  });

  it("the egress diagnostic never spends the IP check budget", async () => {
    // Resolving which residential IP we are on is a diagnostic, not a check. If
    // it counted, watching the panel would burn the pair budget it reports.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/proxy-fetch.ts"), "utf8");
    expect(src).toContain("function isDiagnosticUrl(");
    expect(src, "excluded from the per-IP budget").toContain('!isMintUrl(url) && !isDiagnosticUrl(url)');
  });

  it("counts a sellable door as fiber with nobody on it, not as a flip", async () => {
    // The tile promises "fiber, nobody on it". It counted doors whose
    // first_seen_fiber_at landed inside this sweep, so a tenured door with fiber
    // for months never qualified: Lexington reported SELLABLE 0 while 101 of its
    // doors answered tenured fiber with billing N.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/sweepService.ts"), "utf8");
    const progress = src.slice(src.indexOf("function updateProgress("));
    expect(progress, "sellable is billing N plus fiber present").toContain("s.last_billing_status='N'");
    expect(progress).toContain("s.last_fiber_status IN ('new_fiber','tenured_fiber')");
    // ...and the flip count stays a separate question.
    expect(progress, "fresh is still the flip").toContain("s.first_seen_fiber_at>=?");
  });

  it("does not publish tenured leads a second time", async () => {
    // persistKineticObservation publishes each tenured door as it is answered
    // (server/kineticObservation.ts). A per-city pass at sweep completion would
    // re-query every door in the city to find nothing left to do.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/sweepService.ts"), "utf8");
    expect(src, "the sweep leaves tenured publication to the per-door caller")
      .not.toContain("projectTenuredOpenLeads");
  });

  it("SWEEP_PARK_DEAD_STREETS=off checks every door", () => {
    const prev = process.env.SWEEP_PARK_DEAD_STREETS;
    process.env.SWEEP_PARK_DEAD_STREETS = "off";
    try {
      const id = door("later dead st", 100, { status: "no_service", available: 0 });
      door("later dead st", 200, { status: "no_service", available: 0 });
      const queued = door("later dead st", 300, null);
      parkDeadStreets(JOB);
      expect((rawDb.prepare(`SELECT state FROM sweep_job_targets WHERE sweep_job_id=? AND target_id=?`).get(JOB, queued) as any).state).toBe("queued");
      expect(id).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.SWEEP_PARK_DEAD_STREETS; else process.env.SWEEP_PARK_DEAD_STREETS = prev;
    }
  });
});
