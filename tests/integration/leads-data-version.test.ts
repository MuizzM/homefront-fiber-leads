// The trigger-maintained lead data version - the O(1) replacement for the
// COUNT/MAX/MAX walk that made the map ETag's 304 fast path itself O(total
// leads) once per second per tenant. What this pins:
//   - the version MOVES on insert, update and delete, INCLUDING raw-SQL
//     writes that never pass through storage (imports, scripts, another
//     process) - the exact writers the in-process epoch can never see
//   - tenant isolation: another org's write moves the global version (the
//     unscoped super-admin view) but never a foreign tenant's
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-leadver-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));
});

function seed(tenantId: number): number {
  return storage.createLead({
    address: `${Date.now() % 100000} Version Way`, city: "Lexington", state: "NC", zip: "27292",
    lat: 35.8, lng: -80.2, tenantId, leadStatus: "prospect",
  } as any).id;
}

describe("leads_version triggers", () => {
  it("moves on insert, raw update, and raw delete", () => {
    const v0 = storage.getLeadsDataVersion(1);
    const id = seed(1);
    const v1 = storage.getLeadsDataVersion(1);
    expect(v1).not.toBe(v0);

    // RAW SQL - no storage call, no JS epoch. The old aggregate caught this
    // via MAX(updated_at); the triggers must too, or a cross-process import
    // serves stale 304s to every rep until something else happens to write.
    rawDb.prepare("UPDATE leads SET lead_status = 'interested' WHERE id = ?").run(id);
    const v2 = storage.getLeadsDataVersion(1);
    expect(v2).not.toBe(v1);

    rawDb.prepare("DELETE FROM leads WHERE id = ?").run(id);
    const v3 = storage.getLeadsDataVersion(1);
    expect(v3).not.toBe(v2);
  });

  it("scopes per tenant and always moves the global version", () => {
    const t1a = storage.getLeadsDataVersion(1);
    const t2a = storage.getLeadsDataVersion(2);
    const ga = storage.getLeadsDataVersion(undefined);

    seed(2);

    expect(storage.getLeadsDataVersion(1)).toBe(t1a);      // foreign write - unmoved
    expect(storage.getLeadsDataVersion(2)).not.toBe(t2a);  // own write - moved
    expect(storage.getLeadsDataVersion(undefined)).not.toBe(ga); // global view - moved
  });
});
