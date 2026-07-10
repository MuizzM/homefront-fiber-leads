import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The nightly recheck orchestration (runComingSoonCheck) — the moat's promote loop.
 * Verified with INJECTED probes (no network): a non-answer never demotes a watched
 * address, a sustained block aborts instead of hammering, only a NEW-FIBER+billing-N
 * hit for the SAME address promotes (exactly once), and a re-key to another address
 * is refused.
 */
let storage: typeof import("../../server/storage").storage;
let rawDb: import("better-sqlite3").Database;
let cron: typeof import("../../server/cron-scanner");
type CnsProbe = import("../../server/cns-scanner").CnsProbe;

const hit = (over: any = {}): CnsProbe => ({ kind: "hit", result: { env: "8000000000000", cns: 1, dfAddressId: "x", address: "1 Watch St", city: "Concord", state: "NC", zip: "28025", householdSegmentType: "NEW FIBER", isNewFiber: true, techType: null, speedTier: null, maxDownloadMbps: null, billingStatus: "N", addressCatalogDate: null, competitorName: null, discoveredAt: "", ...over } });

function watch(df: string, over: any = {}) {
  return storage.upsertComingSoonByDfAddressId({ address: over.address ?? `${df} St`, city: "Concord", state: "NC", zip: "28025", tenantId: null, reason: "no_service", dfAddressId: df, householdSegmentType: "PROSPECT", ...over } as any);
}
const leadCount = () => (rawDb.prepare("SELECT COUNT(*) c FROM leads WHERE is_new_fiber=1").get() as any).c;
const openWatch = () => storage.getComingSoonWithDfId().length;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-recheck-"));
  ({ storage } = await import("../../server/storage"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  cron = await import("../../server/cron-scanner");
});
beforeEach(() => { rawDb.exec("DELETE FROM coming_soon_addresses; DELETE FROM leads;"); });

describe("runComingSoonCheck — nightly recheck orchestration", () => {
  it("promotes a NEW-FIBER + billing-N flip to a lead exactly once, and retires the watch row", async () => {
    watch("8000000000000000000001", { address: "1 Watch St", zip: "28025" });
    await cron.runComingSoonCheck({ getToken: async () => "tok", paceMs: 0, blockPaceMs: 0, probe: async () => hit() });
    expect(leadCount()).toBe(1);
    expect(openWatch()).toBe(0);          // promoted → out of the work-list
    // Second night: already a lead → no duplicate, no re-alert (nothing to promote).
    await cron.runComingSoonCheck({ getToken: async () => "tok", paceMs: 0, blockPaceMs: 0, probe: async () => hit() });
    expect(leadCount()).toBe(1);
  });

  it("a NON-ANSWER (fail) never demotes or promotes — the row stays watched", async () => {
    watch("8000000000000000000002");
    await cron.runComingSoonCheck({ getToken: async () => "tok", paceMs: 0, blockPaceMs: 0, probe: async () => ({ kind: "fail", reason: "timeout" as any } as CnsProbe), perNightBudget: 5 });
    expect(leadCount()).toBe(0);
    expect(openWatch()).toBe(1);          // still on the watch-list for next night
  });

  it("a still-non-New hit does NOT promote (only NEW FIBER + billing N does)", async () => {
    watch("8000000000000000000003");
    await cron.runComingSoonCheck({ getToken: async () => "tok", paceMs: 0, blockPaceMs: 0, probe: async () => hit({ householdSegmentType: "EXISTING COPPER", isNewFiber: false }) });
    expect(leadCount()).toBe(0);
    // billing Y (already a subscriber) also must not promote.
    watch("8000000000000000000004");
    await cron.runComingSoonCheck({ getToken: async () => "tok", paceMs: 0, blockPaceMs: 0, probe: async () => hit({ billingStatus: "Y" }) });
    expect(leadCount()).toBe(0);
  });

  it("refuses to promote when the answer is for a DIFFERENT address (re-keyed df id)", async () => {
    watch("8000000000000000000005", { address: "5 Real St", zip: "28025" });
    // Kinetic returns NEW FIBER but for a different address/zip → must NOT create a lead.
    await cron.runComingSoonCheck({ getToken: async () => "tok", paceMs: 0, blockPaceMs: 0, probe: async () => hit({ address: "999 Other Rd", zip: "28777" }) });
    expect(leadCount()).toBe(0);
  });

  it("aborts on a sustained proxy block instead of hammering the whole watchlist", async () => {
    for (let i = 0; i < 200; i++) watch(`80000000000000001${String(i).padStart(5, "0")}`, { address: `${i} Blocked St` });
    let probes = 0;
    await cron.runComingSoonCheck({ getToken: async () => "tok", paceMs: 0, blockPaceMs: 0, probe: async () => { probes++; return { kind: "fail", reason: "blocked" } as CnsProbe; } });
    expect(probes).toBeLessThanOrEqual(25);   // stopped after ~MAX_FAIL, did NOT probe all 200
    expect(leadCount()).toBe(0);
  });
});
