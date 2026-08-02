// Focused unit coverage for storage.adoptFccLead (FCC adopt-on-tap, #61). The
// adoptable guard REUSES the purge's fccPurgeWhere "removable" predicate — fcc-
// family tag ("fcc" or "fcc_<suffix>", underscore LIKE-escaped) AND completely
// unworked — plus a tenant wall and a "not another rep's lead" guard, all in one
// transaction. A non-adoptable row must change NOTHING and return undefined so
// the route falls through to honest-exists. These tests drive the storage method
// directly (no HTTP) to pin the predicate edges the integration test can't cheaply
// enumerate: the literal-underscore lookalike, coord COALESCE, tenant isolation,
// the different-rep guard, worked-door protection, and idempotency.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

const TENANT_A = 1;
const TENANT_B = 2;
const REP = 501;      // the adopting rep's team_member id
const OTHER_REP = 502;

let addrSeq = 1000;
function seed(over: Record<string, unknown> = {}, tenantId = TENANT_A) {
  return storage.createLead({
    address: `${addrSeq++} Unit Ln`, city: "Kannapolis", state: "NC", zip: "28081",
    fiberStatus: "unknown", leadStatus: "prospect", leadTag: "fcc_fresh_block",
    tenantId, lat: 35.49, lng: -80.61,
    ...over,
  } as any);
}
const row = (id: number) => rawDb.prepare("SELECT * FROM leads WHERE id = ?").get(id) as any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-fcc-adopt-unit-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));
  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (?, 'fcc-adopt-unit-b', 'B', 'O', 'b@u.test', 'B')`,
  ).run(TENANT_B);
});

afterEach(() => {
  // No commission/statement side effect may ever appear — adoption is not a sale.
  expect((rawDb.prepare("SELECT COUNT(*) c FROM commissions").get() as any).c).toBe(0);
  expect((rawDb.prepare("SELECT COUNT(*) c FROM commission_sales").get() as any).c).toBe(0);
});

describe("storage.adoptFccLead", () => {
  it("adopts an unworked fcc ghost: retags off fcc, moves to the tapped coords, assigns the rep", () => {
    const g = seed();
    const out = storage.adoptFccLead(g.id, TENANT_A, { repId: REP, lat: 35.51, lng: -80.52 });
    expect(out?.id).toBe(g.id);
    expect(out?.leadTag).toBeNull();
    expect(out?.assignedRepId).toBe(REP);
    expect(out?.lat).toBeCloseTo(35.51, 5);
    expect(out?.lng).toBeCloseTo(-80.52, 5);
  });

  it("matches every fcc-family tag ('fcc' and 'fcc_<suffix>')", () => {
    for (const tag of ["fcc", "fcc_fiber_d25", "fcc_fresh_block"]) {
      const g = seed({ leadTag: tag });
      expect(storage.adoptFccLead(g.id, TENANT_A, { repId: REP, lat: 35.51, lng: -80.52 })).toBeDefined();
      expect(row(g.id).lead_tag).toBeNull();
    }
  });

  it("the literal-underscore lookalike 'fccx1' is NOT fcc-family → not adoptable", () => {
    const g = seed({ leadTag: "fccx1" });
    expect(storage.adoptFccLead(g.id, TENANT_A, { repId: REP, lat: 35.51, lng: -80.52 })).toBeUndefined();
    expect(row(g.id).lead_tag).toBe("fccx1"); // untouched
  });

  it("a non-fcc tag is not adoptable", () => {
    const g = seed({ leadTag: "hot_lead" });
    expect(storage.adoptFccLead(g.id, TENANT_A, { repId: REP, lat: 35.51, lng: -80.52 })).toBeUndefined();
    expect(row(g.id).lead_tag).toBe("hot_lead");
  });

  it("a WORKED fcc door (a knock) is protected — same 'removable' notion as the purge", () => {
    const g = seed();
    storage.createKnock({ leadId: g.id, repId: REP, wasHome: false, outcome: "not_home" } as any);
    expect(storage.adoptFccLead(g.id, TENANT_A, { repId: REP, lat: 35.51, lng: -80.52 })).toBeUndefined();
    expect(row(g.id).lead_tag).toBe("fcc_fresh_block");
    expect(row(g.id).assigned_rep_id).toBeNull();
  });

  it("a sold / dispositioned fcc door is protected", () => {
    const sold = seed({ leadStatus: "sold" });
    const outcome = seed({ lastOutcome: "not_home", lastOutcomeAt: new Date().toISOString() });
    expect(storage.adoptFccLead(sold.id, TENANT_A, { repId: REP, lat: 35.51, lng: -80.52 })).toBeUndefined();
    expect(storage.adoptFccLead(outcome.id, TENANT_A, { repId: REP, lat: 35.51, lng: -80.52 })).toBeUndefined();
  });

  it("tenant-isolated: a tenant-B ghost can never be adopted through tenant A", () => {
    const g = seed({}, TENANT_B);
    expect(storage.adoptFccLead(g.id, TENANT_A, { repId: REP, lat: 35.51, lng: -80.52 })).toBeUndefined();
    expect(row(g.id).lead_tag).toBe("fcc_fresh_block");
    expect(row(g.id).tenant_id).toBe(TENANT_B);
  });

  it("never steals another rep's lead (assigned to a DIFFERENT rep → not adoptable)", () => {
    const g = seed({ assignedRepId: OTHER_REP });
    expect(storage.adoptFccLead(g.id, TENANT_A, { repId: REP, lat: 35.51, lng: -80.52 })).toBeUndefined();
    expect(row(g.id).assigned_rep_id).toBe(OTHER_REP);
  });

  it("keeps the ghost's existing coords when the tap carries none (COALESCE)", () => {
    const g = seed({ lat: 35.49, lng: -80.61 });
    const out = storage.adoptFccLead(g.id, TENANT_A, { repId: REP });
    expect(out?.lat).toBeCloseTo(35.49, 5);
    expect(out?.lng).toBeCloseTo(-80.61, 5);
    expect(out?.leadTag).toBeNull();
  });

  it("is idempotent: a second adopt of the now-untagged lead matches nothing", () => {
    const g = seed();
    expect(storage.adoptFccLead(g.id, TENANT_A, { repId: REP, lat: 35.51, lng: -80.52 })).toBeDefined();
    const afterFirst = row(g.id);
    expect(storage.adoptFccLead(g.id, TENANT_A, { repId: OTHER_REP, lat: 36.0, lng: -81.0 })).toBeUndefined();
    // Not re-assigned, not re-moved.
    expect(row(g.id).assigned_rep_id).toBe(afterFirst.assigned_rep_id);
    expect(row(g.id).lat).toBeCloseTo(afterFirst.lat, 5);
  });
});
