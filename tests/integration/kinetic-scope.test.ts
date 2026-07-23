import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Kinetic-only NC/SC delivery scope: frontier-carrier leads and out-of-state
// fresh leads are SUPPRESSED (status flip + lead_events audit, reversible,
// never deleted) and leave the rep map; sold/now_active are never touched;
// frontier scan targets are never selected by the yield engine.

let rawDb: import("better-sqlite3").Database;
let storage: typeof import("../../server/storage").storage;
let runMigrations: typeof import("../../server/storage").runMigrations;
let yieldEngine: typeof import("../../server/yieldEngine");
const TENANT = 1;

function seedLead(opts: { address: string; state?: string; carrier?: string; status?: string; tag?: string }): number {
  return Number(rawDb.prepare(
    `INSERT INTO leads (address, city, state, zip, lat, lng, tenant_id, carrier, lead_tag, lead_status, created_at, updated_at)
     VALUES (?, 'Testville', ?, '00000', 35.1, -80.1, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(opts.address, opts.state ?? "NC", TENANT, opts.carrier ?? "kinetic",
        opts.tag ?? "fresh_fiber_confirmed", opts.status ?? "prospect").lastInsertRowid);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-kinetic-scope-"));
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  runMigrations = s.runMigrations;
  storage = s.storage;
  runMigrations(); // BEFORE yieldEngine: its import chain prepares against scan-run tables
  yieldEngine = await import("../../server/yieldEngine");
});

describe("scope suppression backfill", () => {
  it("suppresses frontier + out-of-state fresh leads, preserves records + audit, never touches sold", () => {
    const frontier = seedLead({ address: "1 Frontier Way", carrier: "frontier" });
    const ga = seedLead({ address: "2 Georgia Dr", state: "GA" });
    const soldFrontier = seedLead({ address: "3 Sold Frontier Ct", carrier: "frontier", status: "sold" });
    const kineticNc = seedLead({ address: "4 Kinetic NC St" });
    const manualGa = seedLead({ address: "5 Manual GA Ave", state: "GA", tag: "manual" });
    runMigrations(); // re-run: backfill is idempotent, suppresses the new rows

    const st = (id: number) => (rawDb.prepare(`SELECT lead_status s FROM leads WHERE id=?`).get(id) as any).s;
    expect(st(frontier)).toBe("scope_suppressed");
    expect(st(ga)).toBe("scope_suppressed");
    expect(st(soldFrontier)).toBe("sold");            // never touch closed business
    expect(st(kineticNc)).toBe("prospect");           // in-scope untouched
    expect(st(manualGa)).toBe("manual" === "manual" ? "prospect" : "prospect"); // rep-created non-pipeline lead untouched

    // Records preserved + audit trail written (reversal data).
    const evt = rawDb.prepare(`SELECT detail FROM lead_events WHERE lead_id=? ORDER BY id DESC LIMIT 1`).get(frontier) as any;
    expect(evt.detail).toContain("frontier carrier");
    // Off the rep map; kinetic NC pin still there.
    const pins = storage.getLeadsForMap(TENANT).map((p: any) => String(p.address));
    expect(pins.join("|")).not.toContain("1 Frontier Way");
    expect(pins.join("|")).not.toContain("2 Georgia Dr");
    expect(pins.join("|")).toContain("4 Kinetic NC St");
  });

  it("is idempotent — a second run suppresses nothing new", () => {
    const before = (rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE lead_status='scope_suppressed'`).get() as any).n;
    runMigrations();
    const after = (rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE lead_status='scope_suppressed'`).get() as any).n;
    expect(after).toBe(before);
  });
});

describe("yield selection is kinetic-only", () => {
  it("a due frontier-carrier target is never selected; its kinetic twin is", () => {
    const mkTarget = (address: string, carrier: string) => Number(rawDb.prepare(
      `INSERT INTO scan_targets (address, city, state, zip, lat, lng, tenant_id, source, carrier, created_at)
       VALUES (?, 'Concord', 'NC', '28025', 35.41, -80.58, ?, 'osm', ?, datetime('now','-30 days'))`,
    ).run(address, TENANT, carrier).lastInsertRowid);
    const frontierTarget = mkTarget("10 Frontier Scan Rd", "frontier");
    const kineticTarget = mkTarget("12 Kinetic Scan Rd", "kinetic");
    const ids = yieldEngine.scoreDueTargets(TENANT, 100).map((r) => r.id);
    expect(ids).toContain(kineticTarget);
    expect(ids).not.toContain(frontierTarget);
  });
});
