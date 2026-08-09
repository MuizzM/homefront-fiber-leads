import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store: typeof import("../../server/readyToCallStore");
let rawDb: import("better-sqlite3").Database;

const T1 = 7001, T2 = 7002;
let seq = 1;
function seedLead(over: Record<string, any> = {}): number {
  const id = rawDb.prepare(
    `INSERT INTO leads (address, city, state, zip, tenant_id, contact_name, contact_phone, assigned_rep_id, lead_status, do_not_call, last_call_outcome, last_call_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
  ).run(
    over.address ?? `${seq++} Call St`, over.city ?? "Greensboro", "NC", "27401",
    over.tenantId ?? T1, over.contactName ?? "Pat Prospect", ("contactPhone" in over ? over.contactPhone : "3365550142"),
    over.assignedRepId ?? null, over.leadStatus ?? "prospect", over.doNotCall ?? 0,
    over.lastCallOutcome ?? null, over.lastCallAt ?? null,
  ).lastInsertRowid;
  return Number(id);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-rtc-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  store = await import("../../server/readyToCallStore");
});
beforeEach(() => {
  rawDb.prepare("DELETE FROM leads").run();
  rawDb.prepare("DELETE FROM call_log").run();
  rawDb.prepare("DELETE FROM calling_lead_locks").run();
});

describe("getReadyToCallQueue", () => {
  it("includes only phone-bearing, non-DNC, non-terminal leads in this tenant", () => {
    const good = seedLead({ contactPhone: "3365550142" });
    seedLead({ contactPhone: null });                              // no phone → excluded
    seedLead({ contactPhone: "  " });                              // blank phone → excluded
    seedLead({ contactPhone: "3365550143", doNotCall: 1 });        // DNC → excluded
    seedLead({ contactPhone: "3365550144", lastCallOutcome: "sold" }); // terminal → excluded
    seedLead({ contactPhone: "3365550145", tenantId: T2 });        // other tenant → excluded
    const q = store.getReadyToCallQueue({ tenantId: T1, scope: undefined });
    expect(q.map(r => r.id)).toEqual([good]);
  });

  it("walls a scoped rep to their own assigned leads; empty scope sees nothing", () => {
    const mine = seedLead({ contactPhone: "3365550142", assignedRepId: 55 });
    seedLead({ contactPhone: "3365550143", assignedRepId: 66 });   // someone else's
    expect(store.getReadyToCallQueue({ tenantId: T1, scope: [55] }).map(r => r.id)).toEqual([mine]);
    expect(store.getReadyToCallQueue({ tenantId: T1, scope: [] })).toEqual([]);
  });

  it("orders never-called leads before called ones", () => {
    const called = seedLead({ contactPhone: "3365550142", lastCallOutcome: "no_answer", lastCallAt: "2026-01-01T00:00:00Z" });
    const fresh = seedLead({ contactPhone: "3365550143" });
    expect(store.getReadyToCallQueue({ tenantId: T1, scope: undefined }).map(r => r.id)).toEqual([fresh, called]);
  });
});

describe("claimLead - advisory soft-lock (CAS)", () => {
  it("first claimer wins; a second user is told who holds it", () => {
    const lead = seedLead();
    const a = store.claimLead({ tenantId: T1, leadId: lead, userId: 1, userName: "Alice" });
    expect(a.ok).toBe(true);
    const b = store.claimLead({ tenantId: T1, leadId: lead, userId: 2, userName: "Bob" });
    expect(b.ok).toBe(false);
    expect(b.holder?.userId).toBe(1);
    expect(b.holder?.name).toBe("Alice");
  });

  it("re-claiming your own live lock refreshes it (idempotent double-tap)", () => {
    const lead = seedLead();
    expect(store.claimLead({ tenantId: T1, leadId: lead, userId: 1 }).ok).toBe(true);
    expect(store.claimLead({ tenantId: T1, leadId: lead, userId: 1 }).ok).toBe(true);
  });

  it("an expired lease is reclaimable by anyone", () => {
    const lead = seedLead();
    store.claimLead({ tenantId: T1, leadId: lead, userId: 1, userName: "Alice" });
    // Force expiry.
    rawDb.prepare("UPDATE calling_lead_locks SET expires_at = ? WHERE lead_id = ?").run("2000-01-01T00:00:00Z", lead);
    const b = store.claimLead({ tenantId: T1, leadId: lead, userId: 2, userName: "Bob" });
    expect(b.ok).toBe(true);
    expect(store.reapExpiredLeadLocks()).toBe(0); // Bob's lock is fresh, not reaped
  });

  it("release frees the lead for others; heartbeat only extends your own", () => {
    const lead = seedLead();
    store.claimLead({ tenantId: T1, leadId: lead, userId: 1 });
    expect(store.refreshLeadClaim({ tenantId: T1, leadId: lead, userId: 2 })).toBe(false); // not mine
    expect(store.refreshLeadClaim({ tenantId: T1, leadId: lead, userId: 1 })).toBe(true);
    store.releaseLeadClaim({ tenantId: T1, leadId: lead, userId: 1 });
    expect(store.claimLead({ tenantId: T1, leadId: lead, userId: 2 }).ok).toBe(true);
  });
});

describe("recordCallOutcome", () => {
  it("advances lead_status and stamps last_call_*", () => {
    const lead = seedLead();
    const r = store.recordCallOutcome({ tenantId: T1, leadId: lead, repId: 5, userId: 9, outcome: "interested" });
    expect(r.saved).toBe(true);
    const row = rawDb.prepare("SELECT lead_status, last_call_outcome FROM leads WHERE id = ?").get(lead) as any;
    expect(row.lead_status).toBe("interested");
    expect(row.last_call_outcome).toBe("interested");
  });

  it("is idempotent on client_id - a replay writes no second row", () => {
    const lead = seedLead();
    const first = store.recordCallOutcome({ tenantId: T1, leadId: lead, repId: 5, userId: 9, outcome: "no_answer", clientId: "cid-1" });
    const replay = store.recordCallOutcome({ tenantId: T1, leadId: lead, repId: 5, userId: 9, outcome: "no_answer", clientId: "cid-1" });
    expect(first.saved).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(rawDb.prepare("SELECT COUNT(*) c FROM call_log WHERE lead_id = ?").get(lead)).toMatchObject({ c: 1 });
  });

  it("Do Not Call flips the flag and drops the lead from the queue", () => {
    const lead = seedLead();
    store.recordCallOutcome({ tenantId: T1, leadId: lead, repId: null, userId: 9, outcome: "do_not_call" });
    expect(rawDb.prepare("SELECT do_not_call FROM leads WHERE id = ?").get(lead)).toMatchObject({ do_not_call: 1 });
    expect(store.getReadyToCallQueue({ tenantId: T1, scope: undefined })).toEqual([]);
  });

  it("Wrong Number nulls the phone so it can't be redialed", () => {
    const lead = seedLead();
    store.recordCallOutcome({ tenantId: T1, leadId: lead, repId: null, userId: 9, outcome: "wrong_number" });
    expect(rawDb.prepare("SELECT contact_phone FROM leads WHERE id = ?").get(lead)).toMatchObject({ contact_phone: null });
    expect(store.getReadyToCallQueue({ tenantId: T1, scope: undefined })).toEqual([]);
  });

  it("Callback requires a date+time", () => {
    const lead = seedLead();
    expect(() => store.recordCallOutcome({ tenantId: T1, leadId: lead, repId: null, userId: 9, outcome: "callback" })).toThrow("CALLBACK_REQUIRED");
    const ok = store.recordCallOutcome({ tenantId: T1, leadId: lead, repId: null, userId: 9, outcome: "callback", callbackDate: "2026-08-01", callbackTime: "10:00" });
    expect(ok.saved).toBe(true);
  });

  it("rejects an unknown outcome", () => {
    const lead = seedLead();
    expect(() => store.recordCallOutcome({ tenantId: T1, leadId: lead, repId: null, userId: 9, outcome: "banana" })).toThrow("UNKNOWN_OUTCOME");
  });
});
