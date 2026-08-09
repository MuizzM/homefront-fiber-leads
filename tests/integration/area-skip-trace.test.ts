// Area skip trace against a real SQLite database.
//
// The properties worth a real DB rather than a mock:
//   - the door selection excludes already-customer doors, which are NOT
//     identified by lead_status;
//   - storage keeps a scrub TIME, not a dnc boolean, so a number re-blocks
//     itself when the scrub ages out with nothing written;
//   - a re-run whose scrub failed cannot erase a good earlier scrub;
//   - a run stranded by a restart does not lock its area out forever.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRUB_TTL_DAYS, verdictForPhone } from "../../shared/tracerfy";

const dataDir = mkdtempSync(join(tmpdir(), "hf-area-skiptrace-"));
const DAY = 86_400_000;
const TERRITORY_ID = 4242;

let rawDb: import("better-sqlite3").Database;
let tenantId: number;
let area: typeof import("../../server/areaSkipTrace");

function seedLead(input: {
  id: number;
  status?: string;
  lastOutcome?: string | null;
  lastCallOutcome?: string | null;
  doNotKnock?: number;
  territoryId?: number;
}): number {
  rawDb.prepare(`INSERT INTO leads (id,tenant_id,address,city,state,zip,lead_status,last_outcome,
      last_call_outcome,do_not_knock,assigned_territory_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`).run(
      input.id, tenantId, `${input.id} Test St`, "Cary", "NC", "27511",
      input.status ?? "prospect", input.lastOutcome ?? null, input.lastCallOutcome ?? null,
      input.doNotKnock ?? 0, input.territoryId ?? TERRITORY_ID);
  return input.id;
}

beforeAll(async () => {
  process.env.DATA_DIR = dataDir;
  const storage = await import("../../server/storage");
  ({ rawDb } = await import("../../server/db"));
  storage.runMigrations();
  tenantId = storage.getDefaultTenantId()!;
  area = await import("../../server/areaSkipTrace");
});

afterAll(() => {
  try { rawDb.close(); } catch { /* already closed */ }
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  rawDb.exec(`DELETE FROM lead_traced_phones;
    DELETE FROM area_skip_trace_runs;
    DELETE FROM leads WHERE assigned_territory_id IN (${TERRITORY_ID}, ${TERRITORY_ID + 1});`);
});

describe("door selection", () => {
  it("excludes sold and already-customer doors, keeps a plain not_interested door", () => {
    seedLead({ id: 9001, status: "prospect" });
    seedLead({ id: 9002, status: "sold" });
    // The trap: this is what "AlreadyCustomer" actually looks like on disk.
    seedLead({ id: 9003, status: "not_interested", lastOutcome: "already_customer" });
    seedLead({ id: 9004, status: "not_interested" });
    seedLead({ id: 9005, status: "prospect", lastCallOutcome: "already_has_service" });
    seedLead({ id: 9006, status: "prospect", doNotKnock: 1 });

    const ids = area.selectAreaLeads(tenantId, TERRITORY_ID, 100).map(r => r.id).sort();
    expect(ids).toEqual([9001, 9004]);
    expect(area.countAreaLeads(tenantId, TERRITORY_ID)).toBe(2);
  });

  it("does not reach into another area or another tenant", () => {
    seedLead({ id: 9010 });
    seedLead({ id: 9011, territoryId: TERRITORY_ID + 1 });
    expect(area.countAreaLeads(tenantId, TERRITORY_ID)).toBe(1);
    expect(area.countAreaLeads(tenantId + 999, TERRITORY_ID)).toBe(0);
  });
});

describe("storing traced phones", () => {
  it("stores the traced owner name WITHOUT touching leads.owner_name", () => {
    const leadId = seedLead({ id: 9100 });
    rawDb.prepare("UPDATE leads SET owner_name='Parcel Owner' WHERE id=?").run(leadId);
    area.storeTracedPhones({
      tenantId, leadId, ownerName: "Dana Reyes",
      phones: [{ number: "+19195550101", confidence: 0.9, dnc: true, scrubbedAtMs: null }],
    });
    const row = rawDb.prepare("SELECT owner_name AS ownerName,traced_owner_name AS tracedOwnerName FROM leads WHERE id=?")
      .get(leadId) as any;
    // The GIS/parcel column is untouched — a phone vendor must not rewrite it.
    expect(row.ownerName).toBe("Parcel Owner");
    expect(row.tracedOwnerName).toBe("Dana Reyes");
  });

  it("is idempotent per number - a re-run refreshes rather than duplicating", () => {
    const leadId = seedLead({ id: 9101 });
    const phone = { number: "+19195550102", confidence: 0.9, dnc: true, scrubbedAtMs: null };
    area.storeTracedPhones({ tenantId, leadId, ownerName: null, phones: [phone] });
    area.storeTracedPhones({ tenantId, leadId, ownerName: null, phones: [phone] });
    expect(area.tracedPhonesForLead(tenantId, leadId)).toHaveLength(1);
  });

  // A scrub that fails on a later run must not send a cleared number back to
  // "never scrubbed" — that would be a silent regression to blocked, and worse,
  // it would look identical to a number we simply never checked.
  it("keeps the newer scrub time when a later run has none", () => {
    const leadId = seedLead({ id: 9102 });
    const scrubbedAt = Date.now() - DAY;
    area.storeTracedPhones({
      tenantId, leadId, ownerName: null,
      phones: [{ number: "+19195550103", confidence: 0.9, dnc: false, dncFlags: {}, scrubbedAtMs: scrubbedAt }],
    });
    area.storeTracedPhones({
      tenantId, leadId, ownerName: null,
      phones: [{ number: "+19195550103", confidence: 0.9, dnc: true, scrubbedAtMs: null }],
    });
    expect(area.tracedPhonesForLead(tenantId, leadId)[0].scrubbedAtMs).toBe(scrubbedAt);
  });

  it("never stores a dnc boolean - only flags and a scrub time", () => {
    const columns = (rawDb.prepare("PRAGMA table_info('lead_traced_phones')").all() as Array<{ name: string }>)
      .map(c => c.name);
    expect(columns).toContain("scrubbed_at_ms");
    expect(columns).toContain("dnc_flags");
    expect(columns).not.toContain("dnc");
  });
});

describe("dialing list - the verdict is derived on every read", () => {
  function seedScrubbed(leadId: number, scrubbedAtMs: number | null, flags: Record<string, boolean> = {}) {
    seedLead({ id: leadId });
    area.storeTracedPhones({
      tenantId, leadId, ownerName: "Dana Reyes",
      phones: [{ number: `+1919555${String(leadId).slice(-4)}`, confidence: 0.9, dnc: true, dncFlags: flags, scrubbedAtMs }],
    });
  }

  it("counts a freshly scrubbed clean number as dialable", () => {
    seedScrubbed(9200, Date.now() - DAY);
    const list = area.buildAreaDialingList({ tenantId, territoryId: TERRITORY_ID });
    expect(list.totalPhones).toBe(1);
    expect(list.dialablePhones).toBe(1);
    expect(list.advisory).toBe(true);
    expect(list.authorizationRequired).toBe(true);
  });

  it("blocks a NEVER-scrubbed number", () => {
    seedScrubbed(9201, null);
    expect(area.buildAreaDialingList({ tenantId, territoryId: TERRITORY_ID }).dialablePhones).toBe(0);
  });

  it("blocks a federal DNC hit even when freshly scrubbed", () => {
    seedScrubbed(9202, Date.now() - DAY, { federalDnc: true });
    expect(area.buildAreaDialingList({ tenantId, territoryId: TERRITORY_ID }).dialablePhones).toBe(0);
  });

  // The anti-frozen-boolean pin: the SAME stored row flips to blocked purely
  // because time passed, with nothing written in between.
  it("re-blocks a number when its scrub ages out, with NO write", () => {
    const leadId = 9203;
    seedScrubbed(leadId, Date.now() - DAY);
    expect(area.buildAreaDialingList({ tenantId, territoryId: TERRITORY_ID }).dialablePhones).toBe(1);

    const stored = area.tracedPhonesForLead(tenantId, leadId)[0];
    const later = Date.now() + (SCRUB_TTL_DAYS + 1) * DAY;
    expect(verdictForPhone(stored, later).dnc).toBe(true);
    expect(verdictForPhone(stored, later).reasons).toContain("scrub_expired");
  });

  it("keeps blocked numbers ON the list by default - the rule is don't dial, not don't know", () => {
    seedScrubbed(9204, null);
    const all = area.buildAreaDialingList({ tenantId, territoryId: TERRITORY_ID });
    expect(all.entries[0].phones).toHaveLength(1);
    const only = area.buildAreaDialingList({ tenantId, territoryId: TERRITORY_ID, dialableOnly: true });
    expect(only.entries).toHaveLength(0);
  });

  it("does not leak another tenant's numbers", () => {
    seedScrubbed(9205, Date.now() - DAY);
    expect(area.buildAreaDialingList({ tenantId: tenantId + 999, territoryId: TERRITORY_ID }).entries).toEqual([]);
  });
});

describe("run lifecycle", () => {
  it("allows only one active run per area, and frees it when finished", () => {
    const insert = (id: string, status: string) => rawDb.prepare(`INSERT INTO area_skip_trace_runs
      (id,tenant_id,territory_id,status) VALUES (?,?,?,?)`).run(id, tenantId, TERRITORY_ID, status);
    insert("run-a", "running");
    expect(() => insert("run-b", "queued")).toThrow(/UNIQUE/i);
    rawDb.prepare("UPDATE area_skip_trace_runs SET status='completed' WHERE id='run-a'").run();
    expect(() => insert("run-c", "queued")).not.toThrow();
  });

  // The driver is an un-awaited in-process promise. A deploy mid-run would
  // otherwise leave the row active and the unique index would block the area
  // forever, with nothing on the box able to clear it.
  it("reaps a run stranded by a restart", () => {
    rawDb.prepare(`INSERT INTO area_skip_trace_runs
      (id,tenant_id,territory_id,status,started_at,heartbeat_at)
      VALUES ('stranded',?,?,'running',datetime('now','-3 hours'),datetime('now','-3 hours'))`)
      .run(tenantId, TERRITORY_ID);
    expect(area.reconcileStrandedRuns(tenantId, TERRITORY_ID)).toBe(1);
    const row = rawDb.prepare("SELECT status,error_code AS errorCode FROM area_skip_trace_runs WHERE id='stranded'").get() as any;
    expect(row).toMatchObject({ status: "failed", errorCode: "RUN_INTERRUPTED" });
  });

  it("does NOT reap a slow run that is still heartbeating", () => {
    rawDb.prepare(`INSERT INTO area_skip_trace_runs
      (id,tenant_id,territory_id,status,started_at,heartbeat_at)
      VALUES ('slow',?,?,'running',datetime('now','-6 hours'),datetime('now','-1 minutes'))`)
      .run(tenantId, TERRITORY_ID);
    expect(area.reconcileStrandedRuns(tenantId, TERRITORY_ID)).toBe(0);
  });

  it("scopes a run lookup by territory, not just tenant", () => {
    rawDb.prepare(`INSERT INTO area_skip_trace_runs
      (id,tenant_id,territory_id,status) VALUES ('other-area',?,?,'completed')`)
      .run(tenantId, TERRITORY_ID + 1);
    expect(area.getAreaSkipTraceRun(tenantId, "other-area", TERRITORY_ID)).toBeNull();
    expect(area.getAreaSkipTraceRun(tenantId, "other-area", TERRITORY_ID + 1)).not.toBeNull();
  });

  it("refuses to start when Tracerfy is not configured", () => {
    const previous = process.env.AREA_SKIP_TRACE_ENABLED;
    process.env.AREA_SKIP_TRACE_ENABLED = "true";
    delete process.env.TRACERFY_API_KEY;
    seedLead({ id: 9300 });
    try {
      expect(() => area.startAreaSkipTraceRun({ tenantId, territoryId: TERRITORY_ID, actorUserId: 1 }))
        .toThrow(/not configured/i);
    } finally {
      if (previous === undefined) delete process.env.AREA_SKIP_TRACE_ENABLED;
      else process.env.AREA_SKIP_TRACE_ENABLED = previous;
    }
  });

  it("is inert unless explicitly enabled", () => {
    const previous = process.env.AREA_SKIP_TRACE_ENABLED;
    delete process.env.AREA_SKIP_TRACE_ENABLED;
    seedLead({ id: 9301 });
    try {
      expect(() => area.startAreaSkipTraceRun({ tenantId, territoryId: TERRITORY_ID, actorUserId: 1 }))
        .toThrow(/not enabled/i);
    } finally {
      if (previous !== undefined) process.env.AREA_SKIP_TRACE_ENABLED = previous;
    }
  });
});
