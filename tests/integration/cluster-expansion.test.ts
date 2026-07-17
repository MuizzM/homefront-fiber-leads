import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Lead-triggered CRITICAL cluster expansion: on a confirmed green FRESH_LEAD, fan
// out nearest-first ring checks, dedup everything, record the origin→cluster chain,
// and stop after N consecutive empty rings. Enqueue + OSM are mocked so the test is
// hermetic; the priority path itself is covered by the coordinator tests.
const startTargetRun = vi.fn((opts: any) => ({ runId: `run_${opts.targetIds.join("-")}`, queued: opts.targetIds.length, budget: opts.targetIds.length, estimate: {}, city: opts.city, state: opts.state }));
vi.mock("../../server/scanService", () => ({ startTargetRun }));
vi.mock("../../server/overpass", () => ({ pullAddressesFromOverpass: vi.fn(async () => []) }));

let rawDb: any;
let exp: typeof import("../../server/clusterExpansion");

// ~meters north of an origin (lng fixed) → lat delta.
const ORIGIN = { lat: 35.30, lng: -80.50 };
const northMeters = (m: number) => ORIGIN.lat + m / 111_320;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-exp-"));
  process.env.EXPANSION_ENABLED = "on";
  process.env.EXPANSION_OSM = "off";        // inventory-only in the test
  process.env.EXPANSION_RING_M = "800";
  process.env.EXPANSION_MAX_RINGS = "3";
  process.env.EXPANSION_MAX_EMPTY_RINGS = "2";
  process.env.EXPANSION_RING_BUDGET = "50";
  process.env.EXPANSION_RECHECK_MS = "3600000"; // 1h
  ({ rawDb } = await import("../../server/db"));
  rawDb.exec(`CREATE TABLE IF NOT EXISTS scan_targets (id INTEGER PRIMARY KEY, address TEXT, city TEXT, state TEXT, zip TEXT, lat REAL, lng REAL, last_scanned_at TEXT, last_fiber_status TEXT, last_billing_status TEXT, converted_to_lead_id INTEGER)`);
  rawDb.exec(`CREATE TABLE IF NOT EXISTS scan_runs (id TEXT PRIMARY KEY, status TEXT, verified INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, budget INTEGER DEFAULT 0)`);
  exp = await import("../../server/clusterExpansion");
  exp.getExpansions(); // triggers ensureSchema so beforeEach can DELETE the tables
});

let nextId = 1;
function target(address: string, meters: number, opts: { lastScanned?: string; green?: boolean } = {}): number {
  const id = nextId++;
  rawDb.prepare(`INSERT INTO scan_targets (id,address,city,state,zip,lat,lng,last_scanned_at,last_fiber_status,last_billing_status,converted_to_lead_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, address, "Marshville", "NC", "28103", northMeters(meters), ORIGIN.lng, opts.lastScanned ?? null,
      opts.green ? "new_fiber" : null, opts.green ? "N" : null, opts.green ? 900 + id : null);
  return id;
}

beforeEach(() => {
  rawDb.exec(`DELETE FROM lead_expansions; DELETE FROM expansion_members; DELETE FROM scan_targets; DELETE FROM scan_runs;`);
  startTargetRun.mockClear();
  nextId = 1;
});

describe("Lead cluster expansion", () => {
  it("on a green lead, enqueues the NEAREST ring-0 addresses as CRITICAL (lead_expansion)", async () => {
    const origin = target("1 Origin St", 0, { green: true });
    const a1 = target("2 Near Ave", 222);   // ring 0 (<800m)
    const a2 = target("3 Mid Rd", 557);      // ring 0
    target("4 Far Ln", 1113);                // ring 1 (>=800m) — excluded from ring 0
    const r = exp.onFreshLead(1, { targetId: origin, leadId: 900, address: "1 Origin St", city: "Marshville", state: "NC", zip: "28103", lat: ORIGIN.lat, lng: ORIGIN.lng });
    await Promise.resolve();
    expect(r.action).toBe("started");
    expect(startTargetRun).toHaveBeenCalledTimes(1);
    const call = startTargetRun.mock.calls[0][0];
    expect(call.runKind).toBe("lead_expansion");
    expect(call.targetIds).toEqual([a1, a2]); // nearest first, far excluded
  });

  it("deduplicates: the same origin never spawns a second expansion", async () => {
    const origin = target("1 Origin St", 0, { green: true });
    target("2 Near Ave", 222);
    const seed = { targetId: origin, leadId: 900, address: "1 Origin St", city: "Marshville", state: "NC" as const, zip: "28103", lat: ORIGIN.lat, lng: ORIGIN.lng };
    exp.onFreshLead(1, seed); await Promise.resolve();
    const again = exp.onFreshLead(1, seed);
    expect(again.action).toBe("origin_exists");
    expect(rawDb.prepare(`SELECT COUNT(*) c FROM lead_expansions`).get().c).toBe(1);
  });

  it("excludes recently-checked addresses (no wasted re-checks)", async () => {
    const origin = target("1 Origin St", 0, { green: true });
    const a1 = target("2 Fresh Ave", 222);                               // never checked → included
    target("3 Recent Rd", 400, { lastScanned: new Date().toISOString() }); // checked now → excluded
    exp.onFreshLead(1, { targetId: origin, leadId: 900, address: "1 Origin St", city: "Marshville", state: "NC", zip: "28103", lat: ORIGIN.lat, lng: ORIGIN.lng });
    await Promise.resolve();
    expect(startTargetRun.mock.calls[0][0].targetIds).toEqual([a1]);
  });

  it("expands outward ring-by-ring and STOPS after consecutive empty rings", async () => {
    const origin = target("1 Origin St", 0, { green: true });
    target("2 R0 Ave", 300);   // ring 0
    target("3 R1 Rd", 1000);   // ring 1
    exp.onFreshLead(1, { targetId: origin, leadId: 900, address: "1 Origin St", city: "Marshville", state: "NC", zip: "28103", lat: ORIGIN.lat, lng: ORIGIN.lng });
    await Promise.resolve();
    expect(startTargetRun).toHaveBeenCalledTimes(1); // ring 0
    // Ring 0 drained with NO new leads → empty_streak 1 → advance to ring 1.
    await exp.expansionTick();
    expect(startTargetRun).toHaveBeenCalledTimes(2); // ring 1 enqueued
    // Ring 1 drained with NO new leads → empty_streak 2 == max → exhausted.
    await exp.expansionTick();
    const e = rawDb.prepare(`SELECT status, empty_streak FROM lead_expansions LIMIT 1`).get();
    expect(e.status).toBe("exhausted");
    expect(e.empty_streak).toBe(2);
  });

  it("a nearby green lead ATTACHES to the cluster, resets the empty streak, and is recorded in the chain", async () => {
    const origin = target("1 Origin St", 0, { green: true });
    const a1 = target("2 Cluster Ave", 300, { green: true }); // in ring 0
    exp.onFreshLead(1, { targetId: origin, leadId: 900, address: "1 Origin St", city: "Marshville", state: "NC", zip: "28103", lat: ORIGIN.lat, lng: ORIGIN.lng });
    await Promise.resolve();
    // a1 came back green → onFreshLead(a1): it's a member of origin's expansion.
    const res = exp.onFreshLead(1, { targetId: a1, leadId: 901, address: "2 Cluster Ave", city: "Marshville", state: "NC", zip: "28103", lat: northMeters(300), lng: ORIGIN.lng });
    expect(["started", "at_active_cap"]).toContain(res.action); // attached + (optionally) seeded its own outward growth
    const originExp = rawDb.prepare(`SELECT id, empty_streak, fresh_found FROM lead_expansions WHERE origin_target_id=?`).get(origin);
    const member = rawDb.prepare(`SELECT became_lead, lead_id FROM expansion_members WHERE expansion_id=? AND target_id=?`).get(originExp.id, a1);
    expect(member.became_lead).toBe(1);   // recorded which green lead the cluster discovered
    expect(member.lead_id).toBe(901);
    expect(originExp.empty_streak).toBe(0); // density found → keep expanding
    expect(originExp.fresh_found).toBe(1);
  });
});
