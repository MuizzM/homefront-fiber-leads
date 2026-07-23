import { describe, expect, it } from "vitest";
import { sameTenant } from "../../server/tenantGuard";

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
