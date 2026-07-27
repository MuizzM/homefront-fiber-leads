import { describe, expect, it } from "vitest";
import {
  planLegacyCommissionTransition,
  type LegacyCommissionSnapshot,
  type LegacyCommissionTransitionCommand,
} from "../../shared/legacyCommissionLifecycle";

const ACTOR_ID = 42;

function current(overrides: Partial<LegacyCommissionSnapshot> = {}): LegacyCommissionSnapshot {
  return {
    status: "pending",
    paidDate: null,
    notes: null,
    approvedBy: null,
    ...overrides,
  };
}

function command(
  overrides: Partial<LegacyCommissionTransitionCommand> = {},
): LegacyCommissionTransitionCommand {
  return {
    expectedStatus: "pending",
    status: "approved",
    ...overrides,
  };
}

describe("legacy commission lifecycle", () => {
  it.each([
    ["pending", "approved"],
    ["pending", "disputed"],
    ["approved", "disputed"],
    ["disputed", "pending"],
    ["disputed", "approved"],
  ] as const)("allows %s -> %s", (from, to) => {
    const plan = planLegacyCommissionTransition(
      current({
        status: from,
        approvedBy: from === "approved" ? 7 : null,
      }),
      command({ expectedStatus: from, status: to }),
      ACTOR_ID,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.next.status).toBe(to);
    expect(plan.next.paidDate).toBeNull();
    expect(plan.next.approvedBy).toBe(to === "approved" ? ACTOR_ID : null);
  });

  it("allows approved -> paid with a strict date and preserves the original approver", () => {
    const plan = planLegacyCommissionTransition(
      current({ status: "approved", approvedBy: 7 }),
      command({
        expectedStatus: "approved",
        status: "paid",
        paidDate: "2026-07-27",
      }),
      ACTOR_ID,
    );
    expect(plan).toMatchObject({
      ok: true,
      changed: true,
      next: {
        status: "paid",
        paidDate: "2026-07-27",
        approvedBy: 7,
      },
    });
  });

  it.each([
    ["pending", "paid"],
    ["approved", "pending"],
    ["paid", "approved"],
    ["paid", "disputed"],
  ] as const)("rejects illegal %s -> %s", (from, to) => {
    const plan = planLegacyCommissionTransition(
      current({
        status: from,
        paidDate: from === "paid" ? "2026-07-27" : null,
        approvedBy: from === "approved" || from === "paid" ? 7 : null,
      }),
      command({
        expectedStatus: from,
        status: to,
        paidDate: to === "paid" ? "2026-07-27" : undefined,
      }),
      ACTOR_ID,
    );
    expect(plan).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });

  it("rejects a stale expected status before planning a mutation", () => {
    expect(planLegacyCommissionTransition(
      current({ status: "approved", approvedBy: 7 }),
      command({ expectedStatus: "pending", status: "disputed" }),
      ACTOR_ID,
    )).toMatchObject({ ok: false, code: "STALE_VERSION" });
  });

  it("requires a real YYYY-MM-DD paid date and forbids it on non-paid states", () => {
    expect(planLegacyCommissionTransition(
      current({ status: "approved", approvedBy: 7 }),
      command({ expectedStatus: "approved", status: "paid" }),
      ACTOR_ID,
    )).toMatchObject({ ok: false, code: "PAID_DATE_REQUIRED" });
    expect(planLegacyCommissionTransition(
      current({ status: "approved", approvedBy: 7 }),
      command({
        expectedStatus: "approved",
        status: "paid",
        paidDate: "2026-02-30",
      }),
      ACTOR_ID,
    )).toMatchObject({ ok: false, code: "INVALID_PAID_DATE" });
    expect(planLegacyCommissionTransition(
      current(),
      command({
        expectedStatus: "pending",
        status: "approved",
        paidDate: "2026-07-27",
      }),
      ACTOR_ID,
    )).toMatchObject({ ok: false, code: "PAID_DATE_FORBIDDEN" });
  });

  it("makes an unchanged non-paid command idempotent", () => {
    expect(planLegacyCommissionTransition(
      current({ status: "approved", notes: "reviewed", approvedBy: 7 }),
      command({ expectedStatus: "approved", status: "approved", notes: "reviewed" }),
      ACTOR_ID,
    )).toMatchObject({
      ok: true,
      changed: false,
      next: { status: "approved", notes: "reviewed", approvedBy: 7 },
      changedFields: [],
    });
  });

  it("allows only an exact paid retry and never rewrites terminal fields", () => {
    const snapshot = current({
      status: "paid",
      paidDate: "2026-07-27",
      notes: "settled",
      approvedBy: 7,
    });
    expect(planLegacyCommissionTransition(
      snapshot,
      command({
        expectedStatus: "paid",
        status: "paid",
        paidDate: "2026-07-27",
        notes: "settled",
      }),
      ACTOR_ID,
    )).toMatchObject({ ok: true, changed: false, next: snapshot });
    expect(planLegacyCommissionTransition(
      snapshot,
      command({
        expectedStatus: "paid",
        status: "paid",
        paidDate: "2026-07-28",
        notes: "settled",
      }),
      ACTOR_ID,
    )).toMatchObject({ ok: false, code: "PAID_TERMINAL" });
    expect(planLegacyCommissionTransition(
      snapshot,
      command({
        expectedStatus: "paid",
        status: "paid",
        paidDate: "2026-07-27",
        notes: "rewritten",
      }),
      ACTOR_ID,
    )).toMatchObject({ ok: false, code: "PAID_TERMINAL" });
  });

  it("clears server-owned approval fields when a commission becomes disputed", () => {
    expect(planLegacyCommissionTransition(
      current({ status: "approved", approvedBy: 7 }),
      command({ expectedStatus: "approved", status: "disputed" }),
      ACTOR_ID,
    )).toMatchObject({
      ok: true,
      next: { status: "disputed", paidDate: null, approvedBy: null },
    });
  });

  it("fails closed when persisted status is outside the canonical lifecycle", () => {
    expect(planLegacyCommissionTransition(
      current({ status: "legacy_unknown" }),
      command(),
      ACTOR_ID,
    )).toMatchObject({ ok: false, code: "INVALID_CURRENT_STATUS" });
  });
});
