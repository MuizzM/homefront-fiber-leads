import { describe, expect, it } from "vitest";
import { sameTenant, sameTenantRead, sameTenantWrite } from "../../server/tenantGuard";

describe("sameTenant tenant-visibility rule", () => {
  it("matches a row to its own tenant", () => {
    expect(sameTenant({ tenantId: 1 }, 1)).toBe(true);
    expect(sameTenant({ tenantId: 2 }, 1)).toBe(false);
  });

  it("super_admin / internal (tid null) sees every tenant", () => {
    expect(sameTenant({ tenantId: 1 }, null)).toBe(true);
    expect(sameTenant({ tenantId: 2 }, undefined)).toBe(true);
    expect(sameTenant({ tenantId: null }, null)).toBe(true);
  });

  it("a NULL-tenant (legacy/adopted) row is visible to any tenant", () => {
    expect(sameTenant({ tenantId: null }, 1)).toBe(true);
    expect(sameTenant({ tenantId: undefined }, 5)).toBe(true);
  });

  it("a missing row is never visible", () => {
    expect(sameTenant(null, 1)).toBe(false);
    expect(sameTenant(undefined, null)).toBe(false);
  });
});

// SEC-A fix 5 — NULL-tenant WRITE walls. Reads keep the idiom above; writes to
// a NULL-tenant (adopted) row are default-org-admin only.
describe("sameTenantWrite NULL-tenant write rule", () => {
  const DEFAULT = 1;

  it("rows carrying a tenant follow strict tenant equality", () => {
    expect(sameTenantWrite({ tenantId: 2 }, { tenantId: 2, role: "rep" }, DEFAULT)).toBe(true);
    expect(sameTenantWrite({ tenantId: 2 }, { tenantId: 1, role: "admin" }, DEFAULT)).toBe(false);
  });

  it("super_admin writes anything", () => {
    expect(sameTenantWrite({ tenantId: 2 }, { tenantId: 1, role: "super_admin" }, DEFAULT)).toBe(true);
    expect(sameTenantWrite({ tenantId: null }, { tenantId: null, role: "super_admin" }, DEFAULT)).toBe(true);
  });

  it("a NULL-tenant row is writable ONLY by an admin of the DEFAULT tenant", () => {
    expect(sameTenantWrite({ tenantId: null }, { tenantId: 1, role: "admin" }, DEFAULT)).toBe(true);
    // Non-admin roles of the default tenant are excluded…
    expect(sameTenantWrite({ tenantId: null }, { tenantId: 1, role: "manager" }, DEFAULT)).toBe(false);
    expect(sameTenantWrite({ tenantId: null }, { tenantId: 1, role: "rep" }, DEFAULT)).toBe(false);
    // …and so is an ADMIN of any other tenant.
    expect(sameTenantWrite({ tenantId: null }, { tenantId: 2, role: "admin" }, DEFAULT)).toBe(false);
  });

  it("a caller with no org context (and no apex role) writes nothing", () => {
    expect(sameTenantWrite({ tenantId: 1 }, { tenantId: null, role: "manager" }, DEFAULT)).toBe(false);
    expect(sameTenantWrite({ tenantId: null }, { tenantId: null, role: "admin" }, DEFAULT)).toBe(false);
  });

  it("a missing row is never writable", () => {
    expect(sameTenantWrite(null, { tenantId: 1, role: "admin" }, DEFAULT)).toBe(false);
  });
});

describe("sameTenantRead adopted-row visibility", () => {
  const DEFAULT = 1;
  it("a NULL-tenant row reads as owned by the DEFAULT tenant", () => {
    expect(sameTenantRead({ tenantId: null }, 1, DEFAULT)).toBe(true);
    expect(sameTenantRead({ tenantId: null }, 2, DEFAULT)).toBe(false);
  });
  it("super_admin / internal (tid null) reads everything", () => {
    expect(sameTenantRead({ tenantId: null }, null, DEFAULT)).toBe(true);
    expect(sameTenantRead({ tenantId: 2 }, null, DEFAULT)).toBe(true);
  });
  it("rows carrying a tenant follow strict tenant equality", () => {
    expect(sameTenantRead({ tenantId: 2 }, 2, DEFAULT)).toBe(true);
    expect(sameTenantRead({ tenantId: 2 }, 1, DEFAULT)).toBe(false);
  });
});
