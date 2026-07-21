import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Coming Soon PROGRAM is a metadata/promotion surface: its sweep must
// bridge legacy watches into the canonical coming_soon_watchlist (the sole
// scheduling engine) and must NOT dispatch provider rechecks itself.
const startTargetRun = vi.fn((opts: any) => ({ runId: "run_test", queued: opts.targetIds?.length ?? 0, budget: 0 }));
vi.mock("../../server/scanService", () => ({ startTargetRun }));

let rawDb: import("better-sqlite3").Database;
let program: typeof import("../../server/comingSoonProgram");

const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-cs-program-"));
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  s.runMigrations();
  // Materialize the canonical watchlist schema the same way production does:
  // one conclusive coming-soon result through the choke point.
  const { recordAvailabilitySnapshot } = await import("../../server/availabilitySnapshot");
  rawDb.prepare(`INSERT INTO scan_targets (address,city,state,zip,tenant_id) VALUES ('1 Seed St','Concord','NC','28025',?)`).run(TENANT);
  const seed = Number((rawDb.prepare(`SELECT id FROM scan_targets WHERE address='1 Seed St'`).get() as any).id);
  recordAvailabilitySnapshot({
    tenantId: TENANT, scanTargetId: seed, conclusive: true, fiberAvailable: false,
    fiberStatus: "unknown", householdSegmentType: "COMING SOON",
    transitionStatus: "unavailable", apiSource: "kinetic_live",
    evidenceHash: "ev-seed", checkedAt: Date.now(),
  } as any);
  program = await import("../../server/comingSoonProgram");
});

describe("coming soon program sweep", () => {
  it("bridges a legacy watch into the canonical watchlist, immediately due, and never dispatches scans", async () => {
    program.watchComingSoon(TENANT, {
      address: "77 Legacy Ln", city: "Concord", state: "NC", zip: "28025",
      lat: 35.4, lng: -80.58, source: "kinetic-search",
    });
    const result = await program.runComingSoonSweep(TENANT);
    expect(result.bridged).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(startTargetRun).not.toHaveBeenCalled();

    const row = rawDb.prepare(
      `SELECT w.* FROM coming_soon_watchlist w JOIN scan_targets t ON t.id=w.scan_target_id
        WHERE t.address='77 Legacy Ln'`,
    ).get() as any;
    expect(row).toMatchObject({ tenant_id: TENANT, status: "active", last_checked_at: null });
    expect(row.address_key).toContain("77 LEGACY LN|CONCORD|NC|28025");
  });

  it("is idempotent: a second sweep bridges nothing and keeps one watchlist row", async () => {
    const again = await program.runComingSoonSweep(TENANT);
    expect(again.bridged).toBe(0);
    expect(startTargetRun).not.toHaveBeenCalled();
    const n = rawDb.prepare(
      `SELECT COUNT(*) n FROM coming_soon_watchlist w JOIN scan_targets t ON t.id=w.scan_target_id
        WHERE t.address='77 Legacy Ln'`,
    ).get() as any;
    expect(n.n).toBe(1);
  });

  it("rescores due legacy rows onto their next rescore time (board stays ordered)", async () => {
    rawDb.prepare(`UPDATE coming_soon_watch SET next_check_at=datetime('now','-1 hour') WHERE address='77 Legacy Ln'`).run();
    const before = rawDb.prepare(`SELECT next_check_at FROM coming_soon_watch WHERE address='77 Legacy Ln'`).get() as any;
    const swept = await program.runComingSoonSweep(TENANT);
    expect(swept.due).toBe(1);
    const after = rawDb.prepare(`SELECT next_check_at, opportunity_score FROM coming_soon_watch WHERE address='77 Legacy Ln'`).get() as any;
    expect(after.next_check_at > before.next_check_at).toBe(true);   // pushed into the future
    expect(after.opportunity_score).toBeGreaterThanOrEqual(50);
    expect(startTargetRun).not.toHaveBeenCalled();
  });
});
