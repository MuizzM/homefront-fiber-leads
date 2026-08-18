import { describe, expect, it } from "vitest";
import { canReadScanJob } from "../../server/scanJobScope";

describe("scanner-state tenant scope", () => {
  const tenantOneJob = { tenantId: 1 };

  it("allows leadership to read a running job from its own organization", () => {
    expect(canReadScanJob({ role: "manager", tenantId: 1 }, tenantOneJob)).toBe(true);
    expect(canReadScanJob({ role: "admin", tenantId: 1 }, tenantOneJob)).toBe(true);
  });

  it("blocks another organization's job metadata", () => {
    expect(canReadScanJob({ role: "manager", tenantId: 2 }, tenantOneJob)).toBe(false);
    expect(canReadScanJob({ role: "admin", tenantId: 2 }, tenantOneJob)).toBe(false);
  });

  it("fails closed when an ordinary leadership identity has no tenant", () => {
    expect(canReadScanJob({ role: "manager", tenantId: null }, tenantOneJob)).toBe(false);
    expect(canReadScanJob({ role: "admin" }, tenantOneJob)).toBe(false);
    expect(canReadScanJob({ role: "admin", tenantId: 1 }, { tenantId: null })).toBe(false);
  });

  it("preserves only immutable platform-owner access", () => {
    expect(canReadScanJob({ role: "super_admin", tenantId: null, isSuperAdmin: 0 }, tenantOneJob)).toBe(false);
    expect(canReadScanJob({ role: "admin", tenantId: 2, isSuperAdmin: true }, tenantOneJob)).toBe(true);
    expect(canReadScanJob({ role: "admin", tenantId: null, isSuperAdmin: 1 }, tenantOneJob)).toBe(true);
  });
});
