import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Default-tenant bootstrap (server/storage.ts bootstrapDefaultTenant): on a DB
 * with a REAL tenants schema, it must create "Home Front Solutions" once,
 * adopt every unowned (tenant_id NULL) row into it, never touch rows owned by
 * another tenant, and stay idempotent across re-runs.
 */

let rawDb: import("better-sqlite3").Database;
let storageMod: typeof import("../../server/storage");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-tenant-boot-"));
  ({ rawDb } = await import("../../server/db"));
  storageMod = await import("../../server/storage");

  // Real production-shaped tenants table (drizzle-kit push creates this in prod).
  rawDb.exec(`CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    company_name TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    owner_email TEXT NOT NULL UNIQUE,
    brand_name TEXT NOT NULL,
    tagline TEXT,
    plan TEXT NOT NULL DEFAULT 'trial',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT, updated_at TEXT
  )`);
  storageMod.runMigrations(); // creates the rest + runs the bootstrap

  // Seed: two unowned users + one row already owned by another tenant.
  rawDb.prepare(`INSERT INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (77,'other-org','Other Org','O','o@x.com','Other')`).run();
  rawDb.prepare(`INSERT INTO team_members (name, role, active, tenant_id, created_at) VALUES ('Owned Rep','rep',1,77,datetime('now'))`).run();
  rawDb.prepare(`INSERT INTO team_members (name, role, active, tenant_id, created_at) VALUES ('Orphan Rep','rep',1,NULL,datetime('now'))`).run();
  rawDb.prepare(`INSERT INTO users (name, email, role, active, tenant_id, created_at) VALUES ('Orphan Admin','orphan@x.com','admin',1,NULL,datetime('now'))`).run();
  storageMod.bootstrapDefaultTenant(rawDb); // second run: adopt the seeds
});

describe("bootstrapDefaultTenant", () => {
  it("creates the Home Front Solutions tenant exactly once (idempotent)", () => {
    storageMod.bootstrapDefaultTenant(rawDb);
    storageMod.bootstrapDefaultTenant(rawDb);
    const rows = rawDb.prepare(`SELECT * FROM tenants WHERE slug = 'home-front-solutions'`).all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].company_name).toBe("Home Front Solutions");
    expect(rows[0].owner_email).toBe("muizzm21@gmail.com");
    expect(rows[0].status).toBe("active");
  });

  it("adopts unowned rows into the default tenant", () => {
    const hfs = rawDb.prepare(`SELECT id FROM tenants WHERE slug = 'home-front-solutions'`).get() as any;
    const orphanRep = rawDb.prepare(`SELECT tenant_id FROM team_members WHERE name = 'Orphan Rep'`).get() as any;
    const orphanAdmin = rawDb.prepare(`SELECT tenant_id FROM users WHERE email = 'orphan@x.com'`).get() as any;
    expect(orphanRep.tenant_id).toBe(hfs.id);
    expect(orphanAdmin.tenant_id).toBe(hfs.id);
  });

  it("never touches rows owned by another tenant", () => {
    const owned = rawDb.prepare(`SELECT tenant_id FROM team_members WHERE name = 'Owned Rep'`).get() as any;
    expect(owned.tenant_id).toBe(77);
  });

  it("getDefaultTenantId resolves the bootstrapped tenant", () => {
    const hfs = rawDb.prepare(`SELECT id FROM tenants WHERE slug = 'home-front-solutions'`).get() as any;
    expect(storageMod.getDefaultTenantId()).toBe(hfs.id);
  });

  it("new leads and team-derived records inherit tenancy", () => {
    const hfs = rawDb.prepare(`SELECT id FROM tenants WHERE slug = 'home-front-solutions'`).get() as any;
    // createLead with no tenant → default org (the scanner path)
    const lead = storageMod.storage.createLead({ address: "1 Boot St", city: "Rockwell", state: "NC", zip: "28138" } as any);
    expect((lead as any).tenantId).toBe(hfs.id);
    // a knock on that lead inherits the lead's tenant
    const rep = rawDb.prepare(`SELECT id FROM team_members WHERE name = 'Orphan Rep'`).get() as any;
    const knock = storageMod.storage.createKnock({ leadId: lead.id, repId: rep.id, outcome: "not_home", wasHome: false } as any);
    expect((knock as any).tenantId).toBe(hfs.id);
    // a commission for that rep inherits the rep's tenant
    const comm = storageMod.storage.createCommission({ repId: rep.id, amount: 150, saleDate: "2026-07-09", status: "pending" } as any);
    expect((comm as any).tenantId).toBe(hfs.id);
    // a clock session inherits the rep's tenant
    const session = storageMod.storage.clockIn(rep.id, 1);
    expect((session as any).tenantId).toBe(hfs.id);
  });
});

describe("bootstrapDefaultTenant adoption watermark", () => {
  it("records the highest rowid it swept per table and only rescans rows written since", () => {
    const hfs = rawDb.prepare(`SELECT id FROM tenants WHERE slug = 'home-front-solutions'`).get() as any;
    storageMod.bootstrapDefaultTenant(rawDb);
    const mark = rawDb.prepare(`SELECT value FROM app_settings WHERE tenant_id = 0 AND key = 'tenant_adopt_watermark:team_members'`).get() as any;
    const max = rawDb.prepare(`SELECT MAX(rowid) m FROM team_members`).get() as any;
    expect(Number(mark.value)).toBe(max.m);
    // A row written after the sweep is still adopted on the next boot...
    rawDb.prepare(`INSERT INTO team_members (name, role, active, tenant_id, created_at) VALUES ('Late Orphan','rep',1,NULL,datetime('now'))`).run();
    storageMod.bootstrapDefaultTenant(rawDb);
    const late = rawDb.prepare(`SELECT tenant_id FROM team_members WHERE name = 'Late Orphan'`).get() as any;
    expect(late.tenant_id).toBe(hfs.id);
    // ...and the watermark moves up to it.
    const mark2 = rawDb.prepare(`SELECT value FROM app_settings WHERE tenant_id = 0 AND key = 'tenant_adopt_watermark:team_members'`).get() as any;
    expect(Number(mark2.value)).toBe((rawDb.prepare(`SELECT MAX(rowid) m FROM team_members`).get() as any).m);
    // Rows owned by another tenant stay untouched throughout.
    expect((rawDb.prepare(`SELECT tenant_id FROM team_members WHERE name = 'Owned Rep'`).get() as any).tenant_id).toBe(77);
  });
});
