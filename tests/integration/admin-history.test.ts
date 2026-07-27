// Central Admin history — the record must exist, be complete, be readable only
// by the right people, and be impossible to rewrite.
//
// These are the regressions behind the three reported symptoms:
//   • history "missing"        → nothing was recording before/after, and there
//                                was no endpoint or UI to read it back;
//   • changes "revert"         → identity/state was derived client-side rather
//                                than hydrated from the server;
//   • history lost on redeploy → the table is created through the normal
//                                migration path and re-opened with rows intact.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let audit: typeof import("../../server/adminAudit");

const OWNER_EMAIL = "owner@history.example.test";
let superSession = "";
let tenantAdminSession = "";
let repSession = "";
let otherTenantId = 0;

function req(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, "x-csrf-token": sessionId, ...(init.headers ?? {}) },
  });
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-admin-history-"));
  process.env.NODE_ENV = "test";
  process.env.SUPER_ADMIN_EMAILS = OWNER_EMAIL;

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  audit = await import("../../server/adminAudit");

  // Platform owner (is_super_admin stamped by runMigrations from the env list).
  const owner = storage.createUser({ name: "Platform Owner", email: OWNER_EMAIL, role: "admin", active: true, tenantId: 1 } as any);
  rawDb.prepare("UPDATE users SET is_super_admin = 1 WHERE id = ?").run(owner.id);
  superSession = storage.createSession(owner.id).id;

  // An ordinary tenant admin, plus a rep who must never read history at all.
  const admin = storage.createUser({ name: "Tenant Admin", email: "admin@history.example.test", role: "admin", active: true, tenantId: 1 } as any);
  tenantAdminSession = storage.createSession(admin.id).id;
  const rep = storage.createUser({ name: "Field Rep", email: "rep@history.example.test", role: "rep", active: true, tenantId: 1 } as any);
  repSession = storage.createSession(rep.id).id;

  // A second organization whose history tenant 1 must never see.
  const other = storage.createTenant({
    slug: "other-org", companyName: "Other Org", ownerName: "O", ownerEmail: "o@other.example.test",
    brandName: "Other", brandColor: "#111", plan: "trial", status: "active",
  } as any);
  otherTenantId = other.id;
  audit.recordAdminAudit({
    actor: { id: 999, name: "Other Admin", role: "admin", tenantId: otherTenantId },
    action: "tenant.updated", targetType: "tenant", targetId: otherTenantId,
    before: { plan: "trial" }, after: { plan: "pro" }, tenantId: otherTenantId,
  });

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use((r, _res, next) => { (r as any).id = "req-test-fixed"; next(); });
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("history is recorded with full context", () => {
  it("a tenant update records actor, target, real before/after, request id and outcome", async () => {
    const created = await (await req("/api/sa/tenants", superSession, {
      method: "POST",
      body: JSON.stringify({
        slug: "audit-co", companyName: "Audit Co", ownerName: "A Owner",
        ownerEmail: "a@auditco.example.test", brandName: "AuditCo", plan: "trial", monthlyFee: 0,
      }),
    })).json() as any;
    const tenantId = created.tenant.id;

    const res = await req(`/api/sa/tenants/${tenantId}`, superSession, {
      method: "PATCH",
      body: JSON.stringify({ plan: "pro", monthlyFee: 249, mapboxToken: "pk.super-secret-value" }),
    });
    expect(res.status).toBe(200);

    const feed = await (await req(`/api/admin/history?action=tenant.updated&limit=5`, superSession)).json() as any;
    const entry = feed.rows.find((r: any) => String(r.targetId) === String(tenantId));
    expect(entry).toBeTruthy();

    // WHO / WHAT / WHICH / WHEN / WHERE / OUTCOME — the full record.
    expect(entry.actorName).toBe("Platform Owner");
    expect(entry.actorRole).toBe("admin");
    expect(entry.action).toBe("tenant.updated");
    expect(entry.targetType).toBe("tenant");
    expect(entry.outcome).toBe("success");
    expect(entry.requestId).toBe("req-test-fixed");
    expect(Date.parse(entry.at)).toBeGreaterThan(0);
    expect(entry.tenantId).toBe(tenantId); // filed under the org that CHANGED

    // Real values, not just field names.
    expect(entry.before).toMatchObject({ plan: "trial", monthlyFee: 0 });
    expect(entry.after).toMatchObject({ plan: "pro", monthlyFee: 249 });

    // Secrets are recorded as changed, never as their value.
    expect(JSON.stringify(entry)).not.toContain("pk.super-secret-value");
    expect(entry.after.mapboxToken).toBe("[redacted]");
  });

  it("records unchanged fields as no change at all", async () => {
    const created = await (await req("/api/sa/tenants", superSession, {
      method: "POST",
      body: JSON.stringify({
        slug: "noop-co", companyName: "Noop Co", ownerName: "N", ownerEmail: "n@noop.example.test",
        brandName: "NoopCo", plan: "trial",
      }),
    })).json() as any;
    // Re-submitting the SAME value is not a change and must not fake one.
    await req(`/api/sa/tenants/${created.tenant.id}`, superSession, {
      method: "PATCH", body: JSON.stringify({ plan: "trial" }),
    });
    const feed = await (await req(`/api/admin/history?q=NoopCo&limit=5`, superSession)).json() as any;
    const update = feed.rows.find((r: any) => r.action === "tenant.updated");
    expect(update.before).toEqual({});
    expect(update.after).toEqual({});
  });

  it("records FAILED admin attempts, not just successful ones", async () => {
    const res = await req(`/api/sa/tenants/99999`, superSession, {
      method: "PATCH", body: JSON.stringify({ plan: "pro" }),
    });
    expect(res.status).toBe(404);
    const feed = await (await req(`/api/admin/history?outcome=failure&limit=10`, superSession)).json() as any;
    const failure = feed.rows.find((r: any) => String(r.targetId) === "99999");
    expect(failure).toBeTruthy();
    expect(failure.outcome).toBe("failure");
    expect(failure.reason).toMatch(/not found/i);
  });
});

describe("the record cannot be rewritten (append-only, enforced by the DB)", () => {
  it("refuses UPDATE and DELETE on admin_audit", () => {
    const row = rawDb.prepare("SELECT id FROM admin_audit ORDER BY id LIMIT 1").get() as any;
    expect(row).toBeTruthy();
    expect(() => rawDb.prepare("UPDATE admin_audit SET action = 'tampered' WHERE id = ?").run(row.id))
      .toThrow(/append-only/);
    expect(() => rawDb.prepare("DELETE FROM admin_audit WHERE id = ?").run(row.id))
      .toThrow(/append-only/);
    // The row is untouched.
    const after = rawDb.prepare("SELECT action FROM admin_audit WHERE id = ?").get(row.id) as any;
    expect(after.action).not.toBe("tampered");
  });

  it("survives a re-run of migrations — history is not wiped by a redeploy", async () => {
    const before = (rawDb.prepare("SELECT COUNT(*) c FROM admin_audit").get() as any).c;
    expect(before).toBeGreaterThan(0);
    // A redeploy re-runs migrations against the same volume-backed file.
    (await import("../../server/storage")).runMigrations();
    const after = (rawDb.prepare("SELECT COUNT(*) c FROM admin_audit").get() as any).c;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe("RBAC and tenant isolation", () => {
  it("a rep cannot read history at all", async () => {
    expect((await req("/api/admin/history", repSession)).status).toBe(403);
    expect((await req("/api/admin/history/facets", repSession)).status).toBe(403);
  });

  it("a tenant admin sees ONLY their own organization's history", async () => {
    // A change made INSIDE tenant 1, by the tenant's own admin.
    const geo = await req("/api/settings/geo", tenantAdminSession, {
      method: "PATCH", body: JSON.stringify({ maxDistanceM: 120 }),
    });
    expect(geo.status).toBe(200);

    const feed = await (await req("/api/admin/history?limit=200", tenantAdminSession)).json() as any;
    expect(feed.rows.length).toBeGreaterThan(0);
    // Their own change is there, with real before/after.
    const own = feed.rows.find((r: any) => r.action === "settings.geo.update");
    expect(own).toBeTruthy();
    expect(own.after).toMatchObject({ maxDistanceM: 120 });
    for (const row of feed.rows) expect(row.tenantId).toBe(1);
    expect(feed.rows.some((r: any) => r.tenantId === otherTenantId)).toBe(false);
    expect(feed.scope).toBe("tenant:1");
  });

  it("a tenant admin cannot widen scope by asking for another tenant", async () => {
    const feed = await (await req(`/api/admin/history?tenantId=${otherTenantId}&limit=200`, tenantAdminSession)).json() as any;
    // The parameter is ignored — the wall is applied in SQL, not from the query.
    expect(feed.scope).toBe("tenant:1");
    for (const row of feed.rows) expect(row.tenantId).toBe(1);
  });

  it("the platform owner sees across tenants, and can narrow to one", async () => {
    const all = await (await req("/api/admin/history?limit=200", superSession)).json() as any;
    expect(all.scope).toBe("platform");
    expect(all.rows.some((r: any) => r.tenantId === otherTenantId)).toBe(true);

    const narrowed = await (await req(`/api/admin/history?tenantId=${otherTenantId}&limit=200`, superSession)).json() as any;
    expect(narrowed.scope).toBe(`tenant:${otherTenantId}`);
    for (const row of narrowed.rows) expect(row.tenantId).toBe(otherTenantId);
  });
});

describe("the console can actually work the feed", () => {
  it("paginates with an honest total and stable newest-first order", async () => {
    const p1 = await (await req("/api/admin/history?limit=2&offset=0", superSession)).json() as any;
    const p2 = await (await req("/api/admin/history?limit=2&offset=2", superSession)).json() as any;
    expect(p1.total).toBe(p2.total);
    expect(p1.total).toBeGreaterThan(2);
    expect(p1.rows).toHaveLength(2);
    // Newest first, and no row appears on both pages.
    expect(Date.parse(p1.rows[0].at)).toBeGreaterThanOrEqual(Date.parse(p1.rows[1].at));
    const ids = new Set(p1.rows.map((r: any) => r.id));
    expect(p2.rows.some((r: any) => ids.has(r.id))).toBe(false);
  });

  it("filters by action and outcome, and searches free text", async () => {
    const byAction = await (await req("/api/admin/history?action=tenant.created&limit=50", superSession)).json() as any;
    expect(byAction.rows.length).toBeGreaterThan(0);
    for (const row of byAction.rows) expect(row.action).toBe("tenant.created");

    const search = await (await req("/api/admin/history?q=AuditCo&limit=50", superSession)).json() as any;
    expect(search.rows.length).toBeGreaterThan(0);
    expect(search.rows.every((r: any) =>
      JSON.stringify(r).includes("AuditCo") || JSON.stringify(r).includes("audit-co"))).toBe(true);
  });

  it("caps page size so one request cannot pull the whole table", async () => {
    const huge = await (await req("/api/admin/history?limit=100000", superSession)).json() as any;
    expect(huge.limit).toBeLessThanOrEqual(200);
  });

  it("offers filter facets scoped the same way as the feed", async () => {
    const facets = await (await req("/api/admin/history/facets", superSession)).json() as any;
    expect(facets.actions).toContain("tenant.updated");
    expect(facets.canSeeAllTenants).toBe(true);
    const tenantFacets = await (await req("/api/admin/history/facets", tenantAdminSession)).json() as any;
    expect(tenantFacets.canSeeAllTenants).toBe(false);
  });
});

describe("super-admin identity is hydrated, not inferred client-side", () => {
  it("/api/auth/status reports isSuperAdmin so the console survives a refresh", async () => {
    const owner = await (await fetch(`${baseUrl}/api/auth/status`, {
      headers: { "x-session-id": superSession },
    })).json() as any;
    expect(owner.currentUser.isSuperAdmin).toBe(true);

    const plain = await (await fetch(`${baseUrl}/api/auth/status`, {
      headers: { "x-session-id": tenantAdminSession },
    })).json() as any;
    expect(plain.currentUser.isSuperAdmin).toBe(false);
  });

  it("an audit write failure never breaks the request it describes", () => {
    // A malformed payload (circular) must be swallowed by the writer.
    const circular: any = { name: "loop" };
    circular.self = circular;
    expect(() => audit.recordAdminAudit({
      actor: { id: 1, name: "X", role: "admin", tenantId: 1 },
      action: "test.circular", after: circular,
    })).not.toThrow();
    const row = rawDb.prepare("SELECT after_json FROM admin_audit WHERE action = 'test.circular'").get() as any;
    expect(row).toBeTruthy();
    expect(row.after_json).toBeNull(); // recorded the event, dropped the payload
  });
});
