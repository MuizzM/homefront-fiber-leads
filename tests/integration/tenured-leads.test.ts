import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * TENURED DOORS THAT NOBODY PAYS FOR.
 *
 * The claim: TENURED + billing N is a sellable door, not a customer. The
 * provider's own signals back it - across 2,994 such NC doors it said "no
 * active account" 600 times and "active" zero times.
 *
 * The tests that matter most are the ones about what must NOT be published: a
 * door with an active account, and anything that would sneak past the
 * fresh-fiber trigger by claiming to be new fiber.
 */
let rawDb: import("better-sqlite3").Database;
let mod: typeof import("../../server/tenuredLeadProjector");
const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-tenlead-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  mod = await import("../../server/tenuredLeadProjector");
});
beforeEach(() => {
  rawDb.prepare("DELETE FROM leads").run();
  rawDb.prepare("DELETE FROM scan_targets").run();
});

let seq = 0;
function door(o: {
  status?: string; billing?: string | null; segment?: string;
  coords?: boolean; scanned?: boolean; city?: string;
} = {}): number {
  const id = ++seq + 600_000;
  rawDb.prepare(
    `INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,source,street_key,
       last_customer_segment,last_scanned_at,last_fiber_status,last_is_new_fiber,
       last_billing_status,last_fiber_available)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, TENANT, `${id} Tenured Rd`, o.city ?? "Rockwell", "NC", "28138",
    o.coords === false ? null : 35.55 + seq * 0.0001,
    o.coords === false ? null : -80.42,
    "test", "TENURED RD", o.segment ?? "unknown",
    o.scanned === false ? null : "2026-08-20T00:00:00.000Z",
    o.status ?? "tenured_fiber",
    o.status === "new_fiber" ? 1 : 0,
    o.billing === undefined ? "N" : o.billing, 1);
  return id;
}
const leadFor = (id: number) =>
  rawDb.prepare("SELECT * FROM leads WHERE source_scan_target_id=?").get(id) as any;

describe("tenured lead projector", () => {
  it("runs at all, against the real schema", () => {
    door();
    expect(() => mod.projectTenuredOpenLeads(TENANT)).not.toThrow();
  });

  it("publishes a TENURED door with billing N", () => {
    const id = door({ billing: "N" });
    const r = mod.projectTenuredOpenLeads(TENANT);
    expect(r.created).toBe(1);
    const l = leadFor(id);
    expect(l.lead_tag).toBe(mod.TENURED_LEAD_TAG);
    expect(l.fiber_status).toBe("tenured_fiber");
    expect(l.lead_status).toBe("prospect");
  });

  it("NEVER publishes a door with an active account", () => {
    door({ billing: "A" });
    expect(mod.projectTenuredOpenLeads(TENANT).created).toBe(0);
  });

  it("never publishes an explicit existing_customer", () => {
    door({ billing: "N", segment: "existing_customer" });
    expect(mod.projectTenuredOpenLeads(TENANT).created).toBe(0);
  });

  it("requires billing N specifically - a NULL billing is not evidence", () => {
    // The provider never once contradicted 'N'. Silence is not the same thing.
    door({ billing: null });
    expect(mod.projectTenuredOpenLeads(TENANT).created).toBe(0);
  });

  it("does not touch new fiber - that is the other projector's job", () => {
    door({ status: "new_fiber", billing: "N" });
    expect(mod.projectTenuredOpenLeads(TENANT).created).toBe(0);
  });

  it("does not claim to be new fiber, so the fresh-fiber trigger cannot fire", () => {
    // The guard refuses is_new_fiber=1 without fresh-fiber proof. If this lead
    // ever set that flag the insert would abort - and loosening the trigger to
    // let it through would weaken the moat for every lead.
    const id = door({ billing: "N" });
    mod.projectTenuredOpenLeads(TENANT);
    const l = leadFor(id);
    expect(l.is_new_fiber).toBe(0);
    expect(l.is_tenured).toBe(1);
  });

  it("is idempotent - a second pass creates nothing", () => {
    door({ billing: "N" }); door({ billing: "N" });
    expect(mod.projectTenuredOpenLeads(TENANT).created).toBe(2);
    const again = mod.projectTenuredOpenLeads(TENANT);
    expect(again.created).toBe(0);
    expect((rawDb.prepare("SELECT COUNT(*) c FROM leads").get() as any).c).toBe(2);
  });

  it("skips a door with no coordinates - an unmappable pin is not a lead", () => {
    door({ billing: "N", coords: false });
    const r = mod.projectTenuredOpenLeads(TENANT);
    expect(r.created).toBe(0);
    expect(r.skippedNoCoords).toBe(1);
  });

  it("skips a door we have never scanned", () => {
    door({ billing: "N", scanned: false });
    expect(mod.projectTenuredOpenLeads(TENANT).created).toBe(0);
  });

  it("scores below fresh fiber, so a new build still outranks it", () => {
    const id = door({ billing: "N" });
    mod.projectTenuredOpenLeads(TENANT);
    expect(leadFor(id).lead_score).toBe(mod.TENURED_LEAD_SCORE);
    expect(mod.TENURED_LEAD_SCORE).toBeLessThan(100);
  });

  it("honours the limit so a first run cannot mint everything unasked", () => {
    for (let i = 0; i < 6; i++) door({ billing: "N" });
    expect(mod.projectTenuredOpenLeads(TENANT, { limit: 2 }).created).toBe(2);
  });

  it("dry run reports without writing", () => {
    door({ billing: "N" });
    const r = mod.projectTenuredOpenLeads(TENANT, { dryRun: true });
    expect(r.created).toBe(1);
    expect((rawDb.prepare("SELECT COUNT(*) c FROM leads").get() as any).c).toBe(0);
  });

  it("counts candidates without writing", () => {
    door({ billing: "N" }); door({ billing: "A" });
    expect(mod.countTenuredOpenCandidates(TENANT)).toBe(1);
  });

  it("links the door to its lead so it is not reconsidered", () => {
    const id = door({ billing: "N" });
    mod.projectTenuredOpenLeads(TENANT);
    const t = rawDb.prepare("SELECT converted_to_lead_id FROM scan_targets WHERE id=?").get(id) as any;
    expect(t.converted_to_lead_id).toBe(leadFor(id).id);
  });

  it("relinks a door whose lead exists but whose link was lost, so a loop terminates", () => {
    // The exact shape of the bug: the candidate query offers any door with
    // converted_to_lead_id NULL. If a lead for that address already exists, the
    // projector counted it as alreadyLead and moved on WITHOUT linking, so the
    // door was offered again on the next pass, forever. Measured before the
    // fix: 200 passes returned the same rows 84,901 times and the loop ended
    // only on its own pass cap.
    const id = door({ billing: "N" });
    expect(mod.projectTenuredOpenLeads(TENANT).created).toBe(1);
    // simulate the link being lost while the lead survives
    rawDb.prepare("UPDATE scan_targets SET converted_to_lead_id=NULL WHERE id=?").run(id);
    expect(mod.countTenuredOpenCandidates(TENANT)).toBe(1);

    const r = mod.projectTenuredOpenLeads(TENANT);
    expect(r.created).toBe(0);
    expect(r.alreadyLead).toBe(1);
    const after = rawDb.prepare("SELECT converted_to_lead_id FROM scan_targets WHERE id=?").get(id) as any;
    expect(after.converted_to_lead_id).not.toBeNull();
    // gone from the candidate set: a caller that loops until empty now ends
    expect(mod.countTenuredOpenCandidates(TENANT)).toBe(0);
    expect(mod.projectTenuredOpenLeads(TENANT).considered).toBe(0);
  });

  it("does not duplicate a lead that carries no canonical key", () => {
    // A lead written by an older path may have canonical_key NULL, which the
    // key-based check cannot see. The scan_target link is the second guard.
    const id = door({ billing: "N" });
    mod.projectTenuredOpenLeads(TENANT);
    rawDb.prepare("UPDATE leads SET canonical_key=NULL").run();
    rawDb.prepare("UPDATE scan_targets SET converted_to_lead_id=NULL WHERE id=?").run(id);
    const r = mod.projectTenuredOpenLeads(TENANT);
    expect(r.created).toBe(0);           // matched via source_scan_target_id
    expect((rawDb.prepare("SELECT COUNT(*) c FROM leads").get() as any).c).toBe(1);
  });
});

describe("a scan publishes tenured pins by itself", () => {
  it("persistKineticObservation creates the tenured lead for the door it answered", async () => {
    // Before this hook the projector had no production caller: a scan could
    // answer thousands of doors and produce zero tenured pins.
    const { persistKineticObservation } = await import("../../server/kineticObservation");
    const r = persistKineticObservation({
      tenantId: TENANT, source: "test",
      observation: {
        address: "77 Hooked Rd", city: "Rockwell", state: "NC", zip: "28138",
        lat: 35.551, lng: -80.42,
        fiberStatus: "tenured_fiber", fiberAvailable: true, isNewFiber: false,
        billingStatus: "N", householdSegmentType: "TENURED",
        // A body that genuinely qualifies. Availability is derived from the
        // provider's words, not from the caller's fiberAvailable flag - a guard
        // added after an ad-hoc ingest of mine reported 49 Landis doors as
        // available when their only stored body said "NO QUAL".
        rawResponse: {
          maxQual: "QUAL UP TO 2 GIG RANGE VIA FIBER", validationResult: "AddressFound",
          techType: "FIBER",
          broadbandService: { technologyType: "FIBER", qualSpeed: "2000000" },
          address: { householdSegmentType: "TENURED", billingStatus: "N" },
        },
      } as any,
    } as any);
    expect(r.tenured.created).toBe(1);
    const lead = rawDb.prepare("SELECT * FROM leads WHERE address='77 Hooked Rd'").get() as any;
    expect(lead.lead_tag).toBe(mod.TENURED_LEAD_TAG);
  });

  it("still refuses a door the qualification does not support", async () => {
    // TENURED + billing N, but NO QUAL: the Landis case. Must not become a pin.
    const { persistKineticObservation } = await import("../../server/kineticObservation");
    const r = persistKineticObservation({
      tenantId: TENANT, source: "test",
      observation: {
        address: "88 Georgia Oak Ln", city: "Landis", state: "NC", zip: "28088",
        lat: 35.5516, lng: -80.5962,
        fiberStatus: "coming_soon", fiberAvailable: false, isNewFiber: false,
        billingStatus: "N", householdSegmentType: "TENURED",
        rawResponse: {
          maxQual: "NO QUAL", validationResult: "AddressUnserviceableInTerritory",
          broadbandService: { technologyType: "FUTURE_QUAL_EXTENDED", estimatedCompletionDt: "JAN-2027" },
        },
      } as any,
    } as any);
    expect(r.tenured.created).toBe(0);
    expect(rawDb.prepare("SELECT COUNT(*) c FROM leads WHERE address='88 Georgia Oak Ln'").get() as any).toEqual({ c: 0 });
  });
});
