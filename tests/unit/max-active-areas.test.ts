import { describe, it, expect } from "vitest";
import {
  MAX_ACTIVE_AREAS_PER_REP,
  canRepTakeAnotherArea,
} from "@shared/territory";

/**
 * CONTRACT (LOGIC agent, shared/territory.ts):
 *   MAX_ACTIVE_AREAS_PER_REP: number         — default cap (e.g. 5)
 *   canRepTakeAnotherArea(currentActiveCount, max?): boolean
 *     true  when currentActiveCount < max  (rep has headroom)
 *     false when currentActiveCount >= max (at/over the cap)
 * "active" counts only territories in an active-like status (active/shared),
 * NOT draft/completed/reclaimed/archived/unassigned — the caller passes the
 * already-filtered count.
 */

describe("max-active-areas-per-rep rule", () => {
  it("exposes a sane default cap", () => {
    expect(MAX_ACTIVE_AREAS_PER_REP).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_ACTIVE_AREAS_PER_REP)).toBe(true);
  });

  it("allows assignment while the rep is under the cap", () => {
    expect(canRepTakeAnotherArea(0)).toBe(true);
    expect(canRepTakeAnotherArea(MAX_ACTIVE_AREAS_PER_REP - 1)).toBe(true);
  });

  it("blocks assignment once the rep is at the cap", () => {
    expect(canRepTakeAnotherArea(MAX_ACTIVE_AREAS_PER_REP)).toBe(false);
  });

  it("blocks assignment when somehow already over the cap", () => {
    expect(canRepTakeAnotherArea(MAX_ACTIVE_AREAS_PER_REP + 3)).toBe(false);
  });

  it("honors a per-call override of the cap", () => {
    expect(canRepTakeAnotherArea(2, 3)).toBe(true);
    expect(canRepTakeAnotherArea(3, 3)).toBe(false);
  });
});
