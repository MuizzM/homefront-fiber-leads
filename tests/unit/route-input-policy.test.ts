import { describe, expect, it } from "vitest";
import {
  rescanPoolPlan, filterInChunks, clampActivityLogLimit,
  validateTerritoryRequestMessage, validateLeadPatch,
  RESCAN_POOL_MAX_TARGETS, LEAD_STATUS_ALLOWLIST, TERRITORY_MESSAGE_MAX, LEAD_NOTES_MAX,
} from "../../server/routeInputPolicy";

describe("rescan-pool plan (SEC-B DoS cap)", () => {
  it("caps targets per call with a named error", () => {
    const over = rescanPoolPlan(RESCAN_POOL_MAX_TARGETS + 1);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.status).toBe(400);
      expect(over.code).toBe("RESCAN_POOL_CAP");
      expect(over.max).toBe(RESCAN_POOL_MAX_TARGETS);
    }
    expect(rescanPoolPlan(50_000).ok).toBe(false);
    expect(rescanPoolPlan(100_000).ok).toBe(false);
  });

  it("defaults to the cap when no limit is given (was 50k)", () => {
    expect(rescanPoolPlan(undefined)).toEqual({ ok: true, limit: RESCAN_POOL_MAX_TARGETS });
    expect(rescanPoolPlan(null)).toEqual({ ok: true, limit: RESCAN_POOL_MAX_TARGETS });
  });

  it("honors a valid smaller limit", () => {
    expect(rescanPoolPlan(500)).toEqual({ ok: true, limit: 500 });
    expect(rescanPoolPlan(RESCAN_POOL_MAX_TARGETS)).toEqual({ ok: true, limit: RESCAN_POOL_MAX_TARGETS });
  });
});

describe("filterInChunks", () => {
  it("processes every item across chunk boundaries", async () => {
    const items = Array.from({ length: 12_345 }, (_, i) => i);
    const out = await filterInChunks(items, 5_000, (n) => (n % 2 === 0 ? n * 10 : null));
    expect(out.length).toBe(6_173); // evens 0..12344 inclusive
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(20);
  });
});

describe("activity-log limit clamp (matches sibling audit endpoint)", () => {
  it("clamps into 1..500 with fallback 100", () => {
    expect(clampActivityLogLimit(undefined)).toBe(100);
    expect(clampActivityLogLimit("abc")).toBe(100);
    expect(clampActivityLogLimit(-5)).toBe(100);
    expect(clampActivityLogLimit(0)).toBe(100);
    expect(clampActivityLogLimit(250)).toBe(250);
    expect(clampActivityLogLimit(999_999_999)).toBe(500);
    expect(clampActivityLogLimit(500)).toBe(500);
  });
});

describe("territory-request message policy", () => {
  it("accepts absent and normal messages", () => {
    expect(validateTerritoryRequestMessage(undefined)).toEqual({ ok: true, message: null });
    expect(validateTerritoryRequestMessage("")).toEqual({ ok: true, message: null });
    expect(validateTerritoryRequestMessage("  done here  ")).toEqual({ ok: true, message: "done here" });
  });

  it("rejects non-strings and messages over the cap", () => {
    expect(validateTerritoryRequestMessage(42).ok).toBe(false);
    const long = validateTerritoryRequestMessage("x".repeat(TERRITORY_MESSAGE_MAX + 1));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.status).toBe(400);
    expect(validateTerritoryRequestMessage("x".repeat(TERRITORY_MESSAGE_MAX)).ok).toBe(true);
  });
});

describe("leads PATCH value validation", () => {
  it("accepts the canonical status allowlist", () => {
    for (const s of LEAD_STATUS_ALLOWLIST) {
      expect(validateLeadPatch({ leadStatus: s }).ok, s).toBe(true);
    }
    expect(LEAD_STATUS_ALLOWLIST).toEqual(["prospect", "contacted", "interested", "sold", "not_interested", "follow_up"]);
  });

  it("rejects unknown leadStatus with 400 + named code", () => {
    const bad = validateLeadPatch({ leadStatus: "won_it_all" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.status).toBe(400);
      expect(bad.code).toBe("INVALID_LEAD_STATUS");
    }
    expect(validateLeadPatch({ leadStatus: 42 }).ok).toBe(false);
  });

  it("requires assignedRepId to be a positive integer or null", () => {
    expect(validateLeadPatch({ assignedRepId: null }).ok).toBe(true);
    expect(validateLeadPatch({ assignedRepId: 3 }).ok).toBe(true);
    for (const v of [0, -2, 1.5, "3", NaN]) {
      const out = validateLeadPatch({ assignedRepId: v });
      expect(out.ok, String(v)).toBe(false);
      if (!out.ok) expect(out.code).toBe("INVALID_ASSIGNED_REP");
    }
  });

  it("caps notes length", () => {
    expect(validateLeadPatch({ notes: "hello" }).ok).toBe(true);
    expect(validateLeadPatch({ notes: null }).ok).toBe(true);
    const long = validateLeadPatch({ notes: "n".repeat(LEAD_NOTES_MAX + 1) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.code).toBe("INVALID_NOTES");
  });

  it("leaves unrelated allowlisted fields alone", () => {
    expect(validateLeadPatch({ ownerName: "Sam", homeValue: 250000 }).ok).toBe(true);
    expect(validateLeadPatch({}).ok).toBe(true);
  });
});
