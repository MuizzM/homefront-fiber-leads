import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Explicit address lifecycle + Coming-Soon watchlist.
// The lifecycle is written ONLY by the one conclusive-result choke point
// (recordAvailabilitySnapshot); the watchlist engine (comingSoonWatchlist.ts)
// only schedules rechecks and serves the list. scanService is mocked so the
// tick's enqueues are observable and hermetic (no run worker, no proxy).
const startTargetRun = vi.fn((opts: any) => ({
  runId: `run_${opts.targetIds.join("-")}`, queued: opts.targetIds.length,
  budget: opts.targetIds.length, estimate: {}, city: opts.city, state: opts.state,
}));
vi.mock("../../server/scanService", () => ({ startTargetRun }));

let rawDb: import("better-sqlite3").Database;
let record: typeof import("../../server/availabilitySnapshot").recordAvailabilitySnapshot;
let watch: typeof import("../../server/comingSoonWatchlist");

const TENANT = 1;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.now();

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-coming-soon-"));
  delete process.env.COMING_SOON_WATCHLIST; // default = enabled
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  s.runMigrations();
  record = (await import("../../server/availabilitySnapshot")).recordAvailabilitySnapshot;
  watch = await import("../../server/comingSoonWatchlist");
});

let nextId = 0;
function target(opts: { source?: string } = {}): number {
  const id = ++nextId;
  rawDb.prepare(
    `INSERT INTO scan_targets (address,city,state,zip,lat,lng,tenant_id,source)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(`${id} Watch St`, "Concord", "NC", "28025", 35.4, -80.58, TENANT, opts.source ?? "osm");
  return id;
}

let evidenceSeq = 0;
function snap(targetId: number, over: Partial<Parameters<typeof record>[0]> = {}): void {
  record({
    tenantId: TENANT, scanTargetId: targetId, conclusive: true,
    fiberAvailable: false, fiberStatus: "no_service",
    transitionStatus: "unavailable", apiSource: "kinetic_live",
    evidenceHash: `ev-${++evidenceSeq}`, checkedAt: NOW,
    ...over,
  });
}

const lifecycle = (id: number) =>
  rawDb.prepare(`SELECT lifecycle_state AS s, lifecycle_changed_at AS at FROM scan_targets WHERE id=?`).get(id) as { s: string | null; at: number | null };
const watchRow = (id: number) =>
  rawDb.prepare(`SELECT * FROM coming_soon_watchlist WHERE scan_target_id=?`).get(id) as any;

beforeEach(() => {
  rawDb.exec(`DELETE FROM coming_soon_watchlist; DELETE FROM availability_snapshots;
    DELETE FROM scan_run_targets; DELETE FROM scan_runs; DELETE FROM scan_targets;`);
  startTargetRun.mockClear();
  delete process.env.COMING_SOON_WATCHLIST;
});

// ── Lifecycle state machine (written only from conclusive results) ────────────
describe("address lifecycle transitions", () => {
  it("conclusive not-serviceable → UNAVAILABLE", () => {
    const t = target();
    snap(t, { fiberAvailable: false, fiberStatus: "no_service" });
    expect(lifecycle(t)).toMatchObject({ s: "UNAVAILABLE", at: NOW });
  });

  it("coming-soon → COMING_SOON (pre-launch segment AND the NEW FIBER + billing Y rule)", () => {
    const seg = target();
    snap(seg, { fiberAvailable: false, fiberStatus: "unknown", householdSegmentType: "COMING SOON" });
    expect(lifecycle(seg).s).toBe("COMING_SOON");

    const inferred = target();
    snap(inferred, { fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "Y", transitionStatus: "baseline_available" });
    expect(lifecycle(inferred).s).toBe("COMING_SOON");
  });

  it("unavailable/coming-soon → available (not lead-qualifying) → NEWLY_LIT", () => {
    const t = target();
    snap(t, { checkedAt: NOW - HOUR });
    snap(t, { fiberAvailable: true, fiberStatus: "existing_fiber", householdSegmentType: "EXISTING", billingStatus: "Y", transitionStatus: "freshly_available", fresh: true });
    expect(lifecycle(t).s).toBe("NEWLY_LIT");

    // Targets predating lifecycle_state: the transition classifier's proven flip
    // (freshly_available) is enough — no durable prev state required.
    const legacy = target();
    snap(legacy, { fiberAvailable: true, fiberStatus: "existing_fiber", householdSegmentType: "EXISTING", billingStatus: "Y", transitionStatus: "freshly_available", fresh: true });
    expect(lifecycle(legacy).s).toBe("NEWLY_LIT");

    // A plain baseline available answer makes no lifecycle claim.
    const baseline = target();
    snap(baseline, { fiberAvailable: true, fiberStatus: "existing_fiber", householdSegmentType: "EXISTING", billingStatus: "Y", transitionStatus: "baseline_available" });
    expect(lifecycle(baseline).s).toBeNull();
  });

  it("NEW FIBER + billing N → FRESH_LEAD, re-confirmed → STILL_FRESH (changed_at re-affirmed)", () => {
    const t = target();
    snap(t, { checkedAt: NOW - 2 * HOUR, householdSegmentType: "COMING SOON", fiberStatus: "unknown" });
    expect(lifecycle(t).s).toBe("COMING_SOON");

    snap(t, { checkedAt: NOW - HOUR, fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "freshly_available", fresh: true });
    expect(lifecycle(t)).toMatchObject({ s: "FRESH_LEAD", at: NOW - HOUR });

    snap(t, { checkedAt: NOW, fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "still_available" });
    expect(lifecycle(t)).toMatchObject({ s: "STILL_FRESH", at: NOW });
  });

  it("NEVER advances from a transport failure / inconclusive check", () => {
    const t = target();
    snap(t, { checkedAt: NOW - HOUR }); // conclusive unavailable baseline
    const before = lifecycle(t);

    // A LATER failed/blocked attempt: history grows, lifecycle untouched.
    record({
      tenantId: TENANT, scanTargetId: t, conclusive: false, fiberAvailable: null,
      transitionStatus: "check_failed", apiSource: "failed", blocked: true,
      error: "403 throttle", evidenceHash: `ev-${++evidenceSeq}`, checkedAt: NOW,
    });
    expect(lifecycle(t)).toEqual(before);

    // A brand-new target whose only history is failures has NO lifecycle at all.
    const fresh = target();
    record({
      tenantId: TENANT, scanTargetId: fresh, conclusive: false,
      transitionStatus: "check_failed", apiSource: "failed", blocked: true,
      evidenceHash: `ev-${++evidenceSeq}`, checkedAt: NOW,
    });
    expect(lifecycle(fresh)).toMatchObject({ s: null, at: null });
  });

  it("out-of-order older evidence never regresses the state", () => {
    const t = target();
    snap(t, { checkedAt: NOW, fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "freshly_available", fresh: true });
    expect(lifecycle(t).s).toBe("FRESH_LEAD");
    // A backfilled historical unavailable (older checkedAt) arrives later.
    snap(t, { checkedAt: NOW - 30 * DAY, fiberAvailable: false, fiberStatus: "no_service" });
    expect(lifecycle(t)).toMatchObject({ s: "FRESH_LEAD", at: NOW });
  });

  it("FRESH/STILL_FRESH ages to AGED after LIFECYCLE_AGED_DAYS without re-affirmation, and a fresh re-confirmation revives it", () => {
    const t = target();
    snap(t, { checkedAt: NOW - 31 * DAY, fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "freshly_available", fresh: true });
    expect(lifecycle(t).s).toBe("FRESH_LEAD");

    expect(watch.applyAgedTransition(NOW)).toBe(1);
    expect(lifecycle(t).s).toBe("AGED");

    // Re-confirmed fresh on a later check → STILL_FRESH again.
    snap(t, { checkedAt: NOW, fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "still_available" });
    expect(lifecycle(t).s).toBe("STILL_FRESH");
  });
});

// ── Watchlist upsert + promote (written from the same choke point) ────────────
describe("coming-soon watchlist rows", () => {
  it("upserts ONE active row per target on a conclusive COMING_SOON, bumping last_checked_at on re-affirmation", () => {
    const t = target({ source: "new_build" });
    snap(t, { checkedAt: NOW - HOUR, fiberStatus: "unknown", householdSegmentType: "COMING SOON" });
    let row = watchRow(t);
    expect(row).toMatchObject({
      tenant_id: TENANT, status: "active", source: "new_build", confidence: "high",
      first_seen_at: NOW - HOUR, last_checked_at: NOW - HOUR, estimated_completion: null,
    });
    expect(row.address_key).toContain("WATCH ST|CONCORD|NC|28025");

    snap(t, { checkedAt: NOW, fiberStatus: "unknown", householdSegmentType: "COMING SOON" });
    row = watchRow(t);
    expect(rawDb.prepare(`SELECT COUNT(*) n FROM coming_soon_watchlist`).get()).toMatchObject({ n: 1 });
    expect(row).toMatchObject({ first_seen_at: NOW - HOUR, last_checked_at: NOW });
  });

  it("the inferred rule (NEW FIBER + billing Y) watches at medium confidence", () => {
    const t = target();
    snap(t, { fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "Y", transitionStatus: "baseline_available" });
    expect(watchRow(t)).toMatchObject({ status: "active", confidence: "medium" });
  });

  it("promotes on a later conclusive flip to available/new-fiber (lead creation stays with the projector)", () => {
    const t = target();
    snap(t, { checkedAt: NOW - DAY, fiberStatus: "unknown", householdSegmentType: "COMING SOON" });
    expect(watchRow(t).status).toBe("active");

    // A conclusive still-unavailable recheck refreshes the clock but never promotes.
    snap(t, { checkedAt: NOW - HOUR, fiberAvailable: false, fiberStatus: "no_service" });
    expect(watchRow(t)).toMatchObject({ status: "active", last_checked_at: NOW - HOUR });

    snap(t, { checkedAt: NOW, fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "freshly_available", fresh: true });
    expect(watchRow(t).status).toBe("promoted");
    expect(lifecycle(t).s).toBe("FRESH_LEAD");
  });

  it("an inconclusive attempt touches nothing on the watch row", () => {
    const t = target();
    snap(t, { checkedAt: NOW - HOUR, fiberStatus: "unknown", householdSegmentType: "COMING SOON" });
    record({
      tenantId: TENANT, scanTargetId: t, conclusive: false, transitionStatus: "check_failed",
      apiSource: "failed", blocked: true, evidenceHash: `ev-${++evidenceSeq}`, checkedAt: NOW,
    });
    expect(watchRow(t)).toMatchObject({ status: "active", last_checked_at: NOW - HOUR });
  });
});

// ── Due selection by urgency + bounded enqueue through startTargetRun ─────────
describe("watchlist tick", () => {
  // First observed 20 days ago — OUTSIDE the 2–14d flip window, so these rows
  // exercise the base hot/soon/watch cadences (flip-window escalation has its
  // own tests below).
  function watched(opts: { source?: string; eta?: string | null; lastChecked?: number; firstSeen?: number } = {}): number {
    const t = target({ source: opts.source });
    snap(t, { checkedAt: opts.firstSeen ?? NOW - 20 * DAY, fiberStatus: "unknown", householdSegmentType: "COMING SOON" });
    rawDb.prepare(`UPDATE coming_soon_watchlist SET estimated_completion=?, last_checked_at=?, updated_at=? WHERE scan_target_id=?`)
      .run(opts.eta ?? null, opts.lastChecked ?? NOW, NOW, t);
    return t;
  }
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  it("rechecks hot (near/past ETA) at 6h, construction sources at 12h, undated at 24h - hot first", () => {
    const hotDue = watched({ eta: iso(NOW + 5 * DAY), lastChecked: NOW - 7 * HOUR });
    const hotNotDue = watched({ eta: iso(NOW + 5 * DAY), lastChecked: NOW - 5 * HOUR });
    const soonDue = watched({ source: "new_build", lastChecked: NOW - 13 * HOUR });
    const soonNotDue = watched({ source: "new_build", lastChecked: NOW - 11 * HOUR });
    const watchDue = watched({ lastChecked: NOW - 25 * HOUR });
    const watchNotDue = watched({ lastChecked: NOW - 13 * HOUR });

    const result = watch.runComingSoonTick(NOW);
    expect(result.due).toBe(3);
    expect(result.enqueued).toBe(3);
    expect(startTargetRun).toHaveBeenCalledTimes(1); // one (tenant,city,state) bucket
    const call = startTargetRun.mock.calls[0][0];
    expect(call).toMatchObject({ tenantId: TENANT, city: "Concord", state: "NC", runKind: "coming_soon_watch" });
    expect(call.targetIds).toEqual([hotDue, soonDue, watchDue]); // hot-first ordering
    expect(call.targetIds).not.toContain(hotNotDue);
    expect(call.targetIds).not.toContain(soonNotDue);
    expect(call.targetIds).not.toContain(watchNotDue);
  });

  it("never double-enqueues a target already pending in a running coming_soon_watch run", () => {
    const t = watched({ lastChecked: NOW - 30 * HOUR });
    rawDb.prepare(`INSERT INTO scan_runs (id,tenant_id,kind,label,city,state,budget,status) VALUES (?,?,?,?,?,?,?,?)`)
      .run("run_pending", TENANT, "coming_soon_watch", "watch", "Concord", "NC", 1, "running");
    rawDb.prepare(`INSERT INTO scan_run_targets (run_id,target_id,seq,state) VALUES (?,?,?,?)`)
      .run("run_pending", t, 0, "queued");

    expect(watch.runComingSoonTick(NOW).due).toBe(0);
    expect(startTargetRun).not.toHaveBeenCalled();
  });

  it("expires an active watch never re-affirmed coming-soon for COMING_SOON_EXPIRE_DAYS", () => {
    const t = watched({ lastChecked: NOW });
    rawDb.prepare(`UPDATE coming_soon_watchlist SET updated_at=? WHERE scan_target_id=?`).run(NOW - 91 * DAY, t);
    const result = watch.runComingSoonTick(NOW);
    expect(result.expired).toBe(1);
    expect(watchRow(t).status).toBe("expired");
    expect(startTargetRun).not.toHaveBeenCalled(); // expired rows are not scheduled
  });

  it("kill switch COMING_SOON_WATCHLIST=off disables the tick and the interval", () => {
    watched({ lastChecked: NOW - 30 * HOUR });
    process.env.COMING_SOON_WATCHLIST = "off";
    expect(watch.runComingSoonTick(NOW)).toMatchObject({ disabled: true, enqueued: 0 });
    expect(watch.startComingSoonWatchlist()).toBeNull();
    expect(startTargetRun).not.toHaveBeenCalled();
  });
});

// ── Route shape: hot-first items with address + urgency ───────────────────────
describe("GET /api/coming-soon/watchlist", () => {
  it("returns tenant-scoped items ordered active-first then hot-first", () => {
    const hot = target();
    snap(hot, { checkedAt: NOW - HOUR, fiberStatus: "unknown", householdSegmentType: "COMING SOON" });
    rawDb.prepare(`UPDATE coming_soon_watchlist SET estimated_completion=? WHERE scan_target_id=?`)
      .run(new Date(NOW + 3 * DAY).toISOString().slice(0, 10), hot);
    const plain = target();
    snap(plain, { checkedAt: NOW - HOUR, fiberStatus: "unknown", householdSegmentType: "COMING SOON" });
    const other = target(); // another tenant's row must not leak
    snap(other, { checkedAt: NOW - HOUR, fiberStatus: "unknown", householdSegmentType: "COMING SOON" });
    rawDb.prepare(`UPDATE coming_soon_watchlist SET tenant_id=99 WHERE scan_target_id=?`).run(other);

    let handler: any;
    const app = { get: (_path: string, _mw: any, h: any) => { handler = h; } } as any;
    watch.registerComingSoonRoutes(app, { requireAuth: (_q, _s, n) => n(), requireManager: (_q, _s, n) => n() });
    let payload: any;
    handler(
      { query: {}, user: { tenantId: TENANT } },
      { json: (body: any) => { payload = body; }, status: () => ({ json: () => undefined }) },
    );

    expect(payload.items).toHaveLength(2);
    expect(payload.items[0]).toMatchObject({ address: `${hot} Watch St`, city: "Concord", state: "NC", urgency: "hot", status: "active" });
    expect(payload.items[1]).toMatchObject({ address: `${plain} Watch St`, urgency: "watch" });
    expect(payload.items[0]).toHaveProperty("estimatedCompletion");
    expect(payload.items[0]).toHaveProperty("firstSeenAt");
    expect(payload.items[0]).toHaveProperty("lastCheckedAt");
  });
});

// ── Flip-window cadence escalation (days 2–14 after first observation) ────────
describe("flip-window escalation", () => {
  it("urgencyOf escalates one band inside the window and relaxes outside it", () => {
    const base = { estimated_completion: null, source: "scanner" };
    expect(watch.urgencyOf({ ...base, first_seen_at: NOW - 1 * DAY }, NOW)).toBe("watch");  // too young
    expect(watch.urgencyOf({ ...base, first_seen_at: NOW - 5 * DAY }, NOW)).toBe("soon");   // in window: watch→soon
    expect(watch.urgencyOf({ ...base, source: "new_build", first_seen_at: NOW - 5 * DAY }, NOW)).toBe("hot"); // soon→hot
    expect(watch.urgencyOf({ ...base, first_seen_at: NOW - 20 * DAY }, NOW)).toBe("watch"); // past window
    // An ETA-hot row is already at the tightest band — unchanged.
    expect(watch.urgencyOf({ estimated_completion: new Date(NOW + 3 * DAY).toISOString().slice(0, 10), source: "scanner", first_seen_at: NOW - 5 * DAY }, NOW)).toBe("hot");
  });

  it("the tick rechecks an in-window generic watch at the soon cadence", () => {
    const t = target();
    snap(t, { checkedAt: NOW - 5 * DAY, fiberStatus: "unknown", householdSegmentType: "COMING SOON" });
    // 13h stale: base watch cadence (24h) would skip it; escalated soon (12h) is due.
    rawDb.prepare(`UPDATE coming_soon_watchlist SET last_checked_at=?, updated_at=? WHERE scan_target_id=?`)
      .run(NOW - 13 * HOUR, NOW, t);
    const result = watch.runComingSoonTick(NOW);
    expect(result.due).toBe(1);
    expect(startTargetRun.mock.calls[0][0].targetIds).toContain(t);
  });
});

// ── Bandwidth-governor pacing of the tick ─────────────────────────────────────
describe("governor pacing", () => {
  it("governedBatch scales the cap with a 25% floor and never exceeds the cap", () => {
    expect(watch.governedBatch(200, 1)).toBe(200);
    expect(watch.governedBatch(200, 1.5)).toBe(200);  // surplus never grows the cap
    expect(watch.governedBatch(200, 0.5)).toBe(100);
    expect(watch.governedBatch(200, 0.1)).toBe(50);   // floor: top-yield work never starves
    expect(watch.governedBatch(1, 0.1)).toBe(1);
  });

  it("suspends dispatch (but not housekeeping) while the proxy circuit is open", async () => {
    const gov = await import("../../server/bandwidthGovernor");
    gov._resetGovernorForTests();
    try {
      const due = target();
      snap(due, { checkedAt: NOW - 20 * DAY, fiberStatus: "unknown", householdSegmentType: "COMING SOON" });
      rawDb.prepare(`UPDATE coming_soon_watchlist SET last_checked_at=?, updated_at=? WHERE scan_target_id=?`)
        .run(NOW - 30 * HOUR, NOW, due);
      const stale = target();
      snap(stale, { checkedAt: NOW - 20 * DAY, fiberStatus: "unknown", householdSegmentType: "COMING SOON" });
      rawDb.prepare(`UPDATE coming_soon_watchlist SET updated_at=? WHERE scan_target_id=?`)
        .run(NOW - 91 * DAY, stale);

      for (let i = 0; i < 8; i++) gov.noteProxyAuthFailure();
      const result = watch.runComingSoonTick(NOW);
      expect(result.circuitOpen).toBe(true);
      expect(result.enqueued).toBe(0);
      expect(startTargetRun).not.toHaveBeenCalled();
      expect(result.expired).toBe(1);               // DB-only housekeeping still ran
    } finally {
      gov._resetGovernorForTests();
    }
  });
});

describe("funded-expansion hot cities", () => {
  it("hotCitySet parses the spec with NC default and urgencyOf boosts matching cities to hot", async () => {
    const { hotCitySet, urgencyOf } = await import("../../server/comingSoonWatchlist");
    const hot = hotCitySet({ COMING_SOON_HOT_CITIES: "bear creek:nc, Goldston , inman:sc" } as any);
    expect(hot).toEqual(new Set(["bear creek:nc", "goldston:nc", "inman:sc"]));
    // No ETA, no construction source — normally "watch", but the city is funded-hot.
    expect(urgencyOf({ estimated_completion: null, source: "scanner", city: "Bear Creek", state: "NC" }, Date.now(), hot)).toBe("hot");
    expect(urgencyOf({ estimated_completion: null, source: "scanner", city: "Inman", state: "SC" }, Date.now(), hot)).toBe("hot");
    // Non-listed city keeps its ordinary urgency.
    expect(urgencyOf({ estimated_completion: null, source: "scanner", city: "Concord", state: "NC" }, Date.now(), hot)).toBe("watch");
    // Without the set, behavior is unchanged.
    expect(urgencyOf({ estimated_completion: null, source: "scanner", city: "Bear Creek", state: "NC" })).toBe("watch");
  });
});
