import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let storage: typeof import("../../server/storage").storage;

const TENANT_A = 1;
const TENANT_B = 2;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-fresh-lead-tenant-isolation-"));
  process.env.NODE_ENV = "test";

  ({ rawDb } = await import("../../server/db"));
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants
      (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES
      (?, 'fresh-lead-tenant-b', 'Fresh Lead Tenant B', 'Owner B',
       'fresh-lead-owner-b@example.com', 'Fresh Lead Tenant B')`,
  ).run(TENANT_B);
});

function upsert(tenantId: number, address: string, lat: number, lng: number) {
  return storage.upsertLeadByAddress({
    tenantId,
    address,
    city: "Concord",
    state: "NC",
    zip: "28025",
    lat,
    lng,
    leadStatus: "prospect",
    fiberStatus: "unknown",
  } as any);
}

function expectTenantOwnsOnlyItsPin(tenantId: number, ownId: number, foreignId: number) {
  const pins = storage.getLeadsForMap(tenantId);
  expect(pins.map((pin) => pin.id)).toContain(ownId);
  expect(pins.map((pin) => pin.id)).not.toContain(foreignId);
}

describe("Fresh Lead tenant isolation", () => {
  it("creates separate leads for the same exact address without returning or suppressing another tenant's lead", () => {
    const tenantA = upsert(TENANT_A, "140 Exact Isolation St", 35.4081, -80.5794);
    const tenantB = upsert(TENANT_B, "140 Exact Isolation St", 35.4081, -80.5794);

    expect(tenantA.created).toBe(true);
    expect(tenantB.created).toBe(true);
    expect(tenantB.lead.id).not.toBe(tenantA.lead.id);
    expect((tenantA.lead as any).tenant_id).toBe(TENANT_A);
    expect((tenantB.lead as any).tenant_id).toBe(TENANT_B);

    const rows = rawDb.prepare(
      "SELECT id, tenant_id FROM leads WHERE address = ? ORDER BY tenant_id",
    ).all("140 Exact Isolation St") as Array<{ id: number; tenant_id: number }>;
    expect(rows).toEqual([
      { id: tenantA.lead.id, tenant_id: TENANT_A },
      { id: tenantB.lead.id, tenant_id: TENANT_B },
    ]);

    expectTenantOwnsOnlyItsPin(TENANT_A, tenantA.lead.id, tenantB.lead.id);
    expectTenantOwnsOnlyItsPin(TENANT_B, tenantB.lead.id, tenantA.lead.id);
  });

  it("keeps suffix-normalized address variants isolated between tenants", () => {
    const tenantA = upsert(TENANT_A, "220 Variant Isolation Road", 35.4091, -80.5804);
    const tenantB = upsert(TENANT_B, "220 VARIANT ISOLATION RD", 35.4091, -80.5804);

    expect(tenantA.created).toBe(true);
    expect(tenantB.created).toBe(true);
    expect(tenantB.lead.id).not.toBe(tenantA.lead.id);
    expect((tenantA.lead as any).tenant_id).toBe(TENANT_A);
    expect((tenantB.lead as any).tenant_id).toBe(TENANT_B);

    expect(storage.findLeadByAddress(
      TENANT_A,
      "220 Variant Isolation Road",
      "Concord",
      "NC",
      "28025",
    )?.id).toBe(tenantA.lead.id);
    expect(storage.findLeadByAddress(
      TENANT_B,
      "220 VARIANT ISOLATION RD",
      "Concord",
      "NC",
      "28025",
    )?.id).toBe(tenantB.lead.id);

    expectTenantOwnsOnlyItsPin(TENANT_A, tenantA.lead.id, tenantB.lead.id);
    expectTenantOwnsOnlyItsPin(TENANT_B, tenantB.lead.id, tenantA.lead.id);
  });
});
