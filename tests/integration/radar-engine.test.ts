import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Market Birth Radar — transition-truth engine, verified against a REAL SQLite
 * DB with a deterministic FixtureProvider (zero network, zero proxy). These are
 * the acceptance tests for the hard semantics from the build spec §16: baseline
 * vs candidate, OLD→NEW→OLD→NEW = 2 episodes, 100-worker concurrency → one
 * episode/one candidate alert, failures never change state, unknown → drift,
 * N-of-M confirmation, out-of-order rejection, outbox exactly-once, and the
 * live-Kinetic gate (no accidental spend).
 */

let rawDb: import("better-sqlite3").Database;
let engine: typeof import("../../server/radarEngine");
let PA: typeof import("../../server/providerAdapter");

const TEN = 1;
let nextTargetId = 1;

// Insert a monitor target + its authorized source; returns the AuthorizedTarget.
function seedTarget(key: string): import("../../server/providerAdapter").AuthorizedTarget {
  const id = nextTargetId++;
  rawDb.prepare(`INSERT INTO authorized_sources (id, tenant_id, source_type, provenance) VALUES (?,?,?,?)`)
    .run(id, TEN, "kfs_integration", "test authorized feed");
  rawDb.prepare(`INSERT INTO monitor_targets (id, tenant_id, authorized_source_id, provider, provider_target_key, city, state, zip)
                 VALUES (?,?,?,?,?,?,?,?)`).run(id, TEN, id, "kinetic", key, "Testburg", "NC", "28100");
  return { id, tenantId: TEN, provider: "kinetic", providerTargetKey: key, address: `${id} Test St`, city: "Testburg", state: "NC", zip: "28100" };
}
const NEW = (billing = "N", at?: number) => ({ segment: "NEW FIBER", billingStatus: billing, ...(at != null ? { observedAtMs: at } : {}) });
const COPPER = (at?: number) => ({ segment: "COPPER", billingStatus: "Y", ...(at != null ? { observedAtMs: at } : {}) });
const alertsFor = (tid: number, kind?: string) => (rawDb.prepare(`SELECT COUNT(*) c FROM notification_outbox WHERE target_id=?${kind ? " AND kind=?" : ""}`).get(...(kind ? [tid, kind] : [tid])) as any).c;
const episodesFor = (tid: number) => (rawDb.prepare(`SELECT COUNT(*) c FROM transition_episodes WHERE target_id=?`).get(tid) as any).c;
const stateOf = (tid: number) => rawDb.prepare(`SELECT * FROM target_state WHERE target_id=?`).get(tid) as any;
const obsCount = (tid: number) => (rawDb.prepare(`SELECT COUNT(*) c FROM target_observations WHERE target_id=?`).get(tid) as any).c;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-radar-"));
  ({ rawDb } = await import("../../server/db"));
  const storageMod = await import("../../server/storage");
  storageMod.runMigrations();
  engine = await import("../../server/radarEngine");
  PA = await import("../../server/providerAdapter");
});
beforeEach(() => { nextTargetId += 1000; }); // isolate ids between tests

// Ingest a scripted sequence through the fixture provider, one step per check.
async function play(target: any, steps: any[], rule?: any) {
  const provider = new PA.FixtureProvider({ [target.providerTargetKey]: steps }, () => Date.now());
  const results = [];
  for (let i = 0; i < steps.length; i++) results.push(await engine.checkAndIngest(provider, target, rule));
  return results;
}

describe("Radar transition engine (fixtures — zero proxy)", () => {
  it("#1 first-ever observation is NEW → baseline only, NO transition episode/alert", async () => {
    const t = seedTarget("k1");
    await play(t, [NEW()]);
    expect(stateOf(t.id).discovery_state).toBe("BASELINE_NEW");
    expect(episodesFor(t.id)).toBe(0);
    expect(alertsFor(t.id)).toBe(0);
  });

  it("#2 non-New → NEW → exactly ONE candidate episode + ONE candidate alert", async () => {
    const t = seedTarget("k2");
    await play(t, [COPPER(1000), NEW("N", 5000)]);
    expect(episodesFor(t.id)).toBe(1);
    expect(alertsFor(t.id, "primary_candidate_new")).toBe(1);
    const ep = rawDb.prepare(`SELECT * FROM transition_episodes WHERE target_id=?`).get(t.id) as any;
    expect(ep.status).toBe("candidate");
    expect(ep.detection_from).not.toBeNull(); // interval-censored window recorded
  });

  it("#4 repeated NEW after baseline → NO duplicate episodes/alerts", async () => {
    const t = seedTarget("k4");
    await play(t, [NEW(), NEW(), NEW()]);
    expect(episodesFor(t.id)).toBe(0); // all baseline, no flip
    expect(alertsFor(t.id)).toBe(0);
  });

  it("#5 OLD → NEW → OLD → NEW produces exactly TWO episodes", async () => {
    const t = seedTarget("k5");
    // verify each NEW with N-of-M=1? No — need distinct episodes across a regression.
    await play(t, [COPPER(1000), NEW("N", 2000), NEW("N", 2500), COPPER(3000), NEW("N", 4000), NEW("N", 4500)], { n: 2, m: 3 });
    expect(episodesFor(t.id)).toBe(2);
    const eps = rawDb.prepare(`SELECT episode_sequence, status FROM transition_episodes WHERE target_id=? ORDER BY episode_sequence`).all(t.id) as any[];
    expect(eps.map(e => e.episode_sequence)).toEqual([1, 2]);
    expect(eps[0].status).toBe("regressed"); // first episode closed by the regression
  });

  it("#7 a failed/timeout/401/429/challenge/malformed check NEVER changes fiber state", async () => {
    const t = seedTarget("k7");
    await play(t, [NEW("N", 1000)]);                       // baseline New
    const before = stateOf(t.id);
    await play(t, [{ fail: "timeout" }, { fail: "auth" }, { fail: "rate_limited" }, { fail: "challenge" }, { fail: "malformed" }, { fail: "server" }]);
    const after = stateOf(t.id);
    expect(after.canonical_state).toBe(before.canonical_state);   // unchanged
    expect(after.state_version).toBe(before.state_version);       // no CAS bump
    expect(obsCount(t.id)).toBe(7);                               // but every attempt is audited
    expect(alertsFor(t.id)).toBe(0);
  });

  it("#8 unknown provider segment → recorded UNKNOWN + schema-drift, never promoted to New", async () => {
    const t = seedTarget("k8");
    const r = await play(t, [{ segment: "NEW FIBRE" }]); // misspelling
    expect(r[0].schemaDrift).toBe(true);
    expect(stateOf(t.id).canonical_state).toBe("UNKNOWN");
    expect(episodesFor(t.id)).toBe(0);
    const o = rawDb.prepare(`SELECT schema_drift FROM target_observations WHERE target_id=?`).get(t.id) as any;
    expect(o.schema_drift).toBe(1);
  });

  it("#9 candidate that never gets its N confirmations stays CANDIDATE, never silently verified", async () => {
    const t = seedTarget("k9");
    await play(t, [COPPER(1000), NEW("N", 2000)], { n: 3, m: 5 }); // only 1 New → candidate, needs 3
    const ep = rawDb.prepare(`SELECT status FROM transition_episodes WHERE target_id=?`).get(t.id) as any;
    expect(ep.status).toBe("candidate");
    expect(alertsFor(t.id, "primary_reconfirmed_new")).toBe(0);
  });

  it("#6 an out-of-order (older) observation cannot overwrite newer truth", async () => {
    const t = seedTarget("k6");
    await play(t, [COPPER(1000), NEW("N", 5000)]); // now known NEW as of t=5000
    const before = stateOf(t.id);
    // A stale COPPER observed at t=2000 arrives late — must NOT flip us back.
    const provider = new PA.FixtureProvider({ [t.providerTargetKey]: [COPPER(2000)] }, () => Date.now());
    const r = await engine.checkAndIngest(provider, t);
    expect(r.applied).toBe(false);
    expect(r.action).toBe("STALE_LATE");
    expect(stateOf(t.id).canonical_state).toBe(before.canonical_state); // still NEW_FIBER
    expect(obsCount(t.id)).toBe(3); // recorded, just not applied
  });

  it("#3 100 concurrent identical NEW observations → exactly ONE episode + ONE candidate alert", async () => {
    const t = seedTarget("k3");
    await play(t, [COPPER(1000)]); // prior non-New
    // 100 distinct checks all seeing NEW (each its own attemptKey) fired together.
    const provider = new PA.FixtureProvider({ [t.providerTargetKey]: Array.from({ length: 100 }, (_, i) => NEW("N", 2000 + i)) }, () => Date.now());
    await Promise.all(Array.from({ length: 100 }, () => engine.checkAndIngest(provider, t)));
    expect(episodesFor(t.id)).toBe(1);                 // ONE episode, not 100
    expect(alertsFor(t.id, "primary_candidate_new")).toBe(1);  // the candidate alert exactly once
    expect(alertsFor(t.id, "primary_candidate_new") + alertsFor(t.id, "primary_reconfirmed_new")).toBeLessThanOrEqual(2); // no alert storm
    expect(obsCount(t.id)).toBe(101);                  // every observation still audited
  });

  it("idempotent replay: the SAME attemptKey twice records one observation, no second episode", async () => {
    const t = seedTarget("kR");
    const provider = new PA.FixtureProvider({ [t.providerTargetKey]: [COPPER(1000)] });
    await engine.checkAndIngest(provider, t);
    const obs = { provider: "kinetic", providerTargetKey: t.providerTargetKey, providerObservedAtMs: 2000, ingestedAtMs: 2000, rawSegment: "NEW FIBER", canonical: "NEW_FIBER" as const, recognized: true, billingStatus: "N", conclusive: true, failureKind: null, schemaVersion: 1, evidenceHash: "hashX", isFixture: true, latencyMs: 0 };
    const first = engine.ingestObservation(t, obs, "fixed-key-1");
    const second = engine.ingestObservation(t, obs, "fixed-key-1"); // replay
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.action).toBe("REPLAY");
    expect(episodesFor(t.id)).toBe(1);
  });

  it("#10 outbox is exactly-once and durable — drain marks sent, re-drain is a no-op", async () => {
    const t = seedTarget("k10");
    await play(t, [COPPER(1000), NEW("N", 2000)]); // one candidate alert enqueued
    const delivered: any[] = [];
    const n1 = await engine.drainOutbox(100, row => delivered.push(row));
    const n2 = await engine.drainOutbox(100, row => delivered.push(row)); // nothing left
    expect(n1).toBeGreaterThanOrEqual(1);
    expect(n2).toBe(0);
    expect(delivered.filter(r => r.target_id === t.id && r.kind === "primary_candidate_new").length).toBe(1);
  });

  it("LIVE GATE: KineticProvider.check throws when RADAR_LIVE=off (explicit kill switch)", async () => {
    const prev = process.env.RADAR_LIVE;
    process.env.RADAR_LIVE = "off"; // live is the default; only explicit =off blocks spend
    const kp = new PA.KineticProvider(async () => { throw new Error("SHOULD NOT BE CALLED"); });
    await expect(kp.check(seedTarget("live"))).rejects.toThrow(/RADAR_LIVE_DISABLED/);
    if (prev) process.env.RADAR_LIVE = prev; else delete process.env.RADAR_LIVE;
  });

  it("a heuristic (knowledge_base) result is INCONCLUSIVE — never a fabricated New", async () => {
    process.env.RADAR_LIVE = "true";
    const kp = new PA.KineticProvider(async () => ({ apiSource: "knowledge_base", householdSegmentType: "NEW FIBER", billingStatus: "N", rawResponse: {} }));
    const o = await kp.check(seedTarget("kb"));
    expect(o.conclusive).toBe(false);
    expect(o.failureKind).toBe("heuristic");
    delete process.env.RADAR_LIVE;
  });

  // ── Regression tests for the adversarial-review findings ────────────────────

  it("#F1 schema drift NEVER overwrites a known New — a label rename fabricates NO episode", async () => {
    const t = seedTarget("kF1");
    // Baseline New, then the provider RENAMES the segment (drift), then real New again.
    await play(t, [NEW("N", 1000), { segment: "FIBER - NEW", observedAtMs: 2000 }, NEW("N", 3000)]);
    expect(stateOf(t.id).canonical_state).toBe("NEW_FIBER"); // drift did NOT erase the known state
    expect(episodesFor(t.id)).toBe(0);                       // no phantom "went live" episode
    expect(alertsFor(t.id)).toBe(0);                         // no fabricated alert
    expect(obsCount(t.id)).toBe(3);                          // all three attempts audited
    const drift = rawDb.prepare(`SELECT schema_drift FROM target_observations WHERE target_id=? ORDER BY id`).all(t.id) as any[];
    expect(drift[1].schema_drift).toBe(1);                   // the rename is flagged as drift
  });

  it("#F2 a late conclusive obs after a steady-state repeat cannot regress verified truth", async () => {
    const t = seedTarget("kF2");
    // COPPER → NEW → NEW (verify n=2) → a routine repeat NEW much later (steady state).
    await play(t, [COPPER(1000), NEW("N", 2000), NEW("N", 2500), NEW("N", 5000)], { n: 2 });
    expect(episodesFor(t.id)).toBe(1);
    expect((rawDb.prepare(`SELECT status FROM transition_episodes WHERE target_id=?`).get(t.id) as any).status).toBe("verified");
    // A stale COPPER observed at t=3000 arrives late. The watermark advanced to
    // 5000 on the repeat, so it is correctly rejected — verified truth survives.
    const provider = new PA.FixtureProvider({ [t.providerTargetKey]: [COPPER(3000)] }, () => Date.now());
    const r = await engine.checkAndIngest(provider, t, { n: 2 });
    expect(r.action).toBe("STALE_LATE");
    expect(stateOf(t.id).canonical_state).toBe("NEW_FIBER");
    expect(episodesFor(t.id)).toBe(1); // NOT split into a phantom 2nd episode
  });

  it("#F3 verification does NOT widen the detection window — detection_to stays the FIRST New", async () => {
    const t = seedTarget("kF3");
    const firstNew = 2000, muchLater = 600_000_000;
    await play(t, [COPPER(1000), NEW("N", firstNew), NEW("N", muchLater)], { n: 2 });
    const ep = rawDb.prepare(`SELECT status, detection_to FROM transition_episodes WHERE target_id=?`).get(t.id) as any;
    expect(ep.status).toBe("verified");
    expect(ep.detection_to).toBe(new Date(firstNew).toISOString()); // NOT the confirming read's time
  });

  it("#F4 fixture and live evidence can NEVER mix on the same target", async () => {
    const t = seedTarget("kF4");
    await play(t, [NEW("N", 1000)]); // fixture observation establishes the target as fixture-class
    // A live-flagged observation on the same target must be refused, recording nothing.
    const liveObs = { provider: "kinetic", providerTargetKey: t.providerTargetKey, providerObservedAtMs: 2000, ingestedAtMs: 2000, rawSegment: "NEW FIBER", canonical: "NEW_FIBER" as const, recognized: true, billingStatus: "N", conclusive: true, failureKind: null, schemaVersion: 1, evidenceHash: "liveHash", isFixture: false, latencyMs: 0 };
    const r = engine.ingestObservation(t, liveObs, "live-1", { n: 2 });
    expect(r.applied).toBe(false);
    expect(r.action).toBe("FIXTURE_MIXING_BLOCKED");
    expect(obsCount(t.id)).toBe(1); // the live obs was NOT recorded onto the fixture target
  });

  it("#F5 a single-sighting rule (n=1) verifies on the opening flip + emits a verified alert only", async () => {
    const t = seedTarget("kF5");
    await play(t, [COPPER(1000), NEW("N", 2000)], { n: 1 });
    const ep = rawDb.prepare(`SELECT status FROM transition_episodes WHERE target_id=?`).get(t.id) as any;
    expect(ep.status).toBe("verified");
    expect(alertsFor(t.id, "primary_reconfirmed_new")).toBe(1);
    expect(alertsFor(t.id, "primary_candidate_new")).toBe(0);
  });

  it("#F6 KineticProvider: a soft `success:false` / empty segment is INCONCLUSIVE, never a conclusive 'no'", async () => {
    process.env.RADAR_LIVE = "true";
    // Soft failure — success:false with no explicit AddressNotFound, empty segment.
    const soft = new PA.KineticProvider(async () => ({ apiSource: "kinetic_live", householdSegmentType: null, billingStatus: null, rawResponse: { success: false, validationResult: "ServiceError" } }));
    const o1 = await soft.check(seedTarget("kF6a"));
    expect(o1.conclusive).toBe(false);
    expect(o1.failureKind).toBe("malformed");
    // An explicit AddressNotFound IS a genuine conclusive NO_SERVICE (the non-New prior state).
    const notFound = new PA.KineticProvider(async () => ({ apiSource: "kinetic_live", householdSegmentType: null, billingStatus: null, rawResponse: { success: false, validationResult: "AddressNotFound" } }));
    const o2 = await notFound.check(seedTarget("kF6b"));
    expect(o2.conclusive).toBe(true);
    expect(o2.canonical).toBe("NO_SERVICE");
    // A recognized segment IS conclusive.
    const live = new PA.KineticProvider(async () => ({ apiSource: "kinetic_live", householdSegmentType: "NEW FIBER", billingStatus: "N", rawResponse: { success: true, validationResult: "Valid" } }));
    const o3 = await live.check(seedTarget("kF6c"));
    expect(o3.conclusive).toBe(true);
    expect(o3.canonical).toBe("NEW_FIBER");
    delete process.env.RADAR_LIVE;
  });
});
