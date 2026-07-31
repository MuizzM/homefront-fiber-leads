import { beforeEach, describe, expect, it } from "vitest";
import {
  DIMMED_PIN_OPACITY,
  FILTER_STATUS_LS_KEY,
  HOUSE_NUMBERS_LS_KEY,
  PIN_DS_OPACITY,
  UNCLUSTERED_PAINT,
  formatFilterCount,
  isPinDimmed,
  persistFilterStatus,
  persistHouseNumbers,
  readPersistedFilterStatus,
  readPersistedHouseNumbers,
  unclusteredOpacityExpr,
} from "../../client/src/lib/mapPins";

// Lane E2 — field-map chrome cleanup (MAP FIRST). Pure-logic coverage for the
// persisted prefs (status filter, house numbers), the count formatter, the
// selected-pin dimming predicate, and the tightened pin paint contract.
// (The compact filter-pill machine and the secondary-chrome auto-hide machine
// were deleted with the chrome they drove — the rail no longer auto-hides and
// the Filters sheet is the one filter surface.)

describe("filter persistence (localStorage)", () => {
  const VALID = ["unworked", "not_home", "interested", "follow_up", "sold", "not_interested"];

  beforeEach(() => localStorage.clear());

  it("round-trips a valid selection", () => {
    persistFilterStatus("follow_up");
    expect(localStorage.getItem(FILTER_STATUS_LS_KEY)).toBe("follow_up");
    expect(readPersistedFilterStatus(VALID)).toBe("follow_up");
  });

  it("persists the reset to All", () => {
    persistFilterStatus("sold");
    persistFilterStatus("all");
    expect(readPersistedFilterStatus(VALID)).toBe("all");
  });

  it("falls back to All for missing or stale (no-longer-valid) values", () => {
    expect(readPersistedFilterStatus(VALID)).toBe("all");
    localStorage.setItem(FILTER_STATUS_LS_KEY, "deleted_status");
    expect(readPersistedFilterStatus(VALID)).toBe("all");
  });

  it("survives blocked storage without crashing (defaults ON)", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readPersistedFilterStatus(VALID)).toBe("all");
    get.mockRestore();
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => persistFilterStatus("sold")).not.toThrow();
    set.mockRestore();
  });
});

describe("house-numbers preference (localStorage)", () => {
  beforeEach(() => localStorage.clear());

  it("is ON by default (owner expects house numbers)", () => {
    expect(readPersistedHouseNumbers()).toBe(true); // default ON — owner expects numbers
  });

  it("round-trips an opt-in and an opt-out", () => {
    persistHouseNumbers(true);
    expect(localStorage.getItem(HOUSE_NUMBERS_LS_KEY)).toBe("1");
    expect(readPersistedHouseNumbers()).toBe(true);
    persistHouseNumbers(false);
    expect(readPersistedHouseNumbers()).toBe(false);
  });

  it("treats junk storage values as the default (ON)", () => {
    localStorage.setItem(HOUSE_NUMBERS_LS_KEY, "yes");
    expect(readPersistedHouseNumbers()).toBe(true);
  });

  it("survives blocked storage without crashing (defaults ON)", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readPersistedHouseNumbers()).toBe(true);
    get.mockRestore();
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => persistHouseNumbers(true)).not.toThrow();
    set.mockRestore();
  });
});

describe("formatFilterCount — counts never dominate", () => {
  it("keeps four-digit-and-under counts raw", () => {
    expect(formatFilterCount(0)).toBe("0");
    expect(formatFilterCount(7)).toBe("7");
    expect(formatFilterCount(9999)).toBe("9999");
  });

  it("compacts five-digit labels", () => {
    expect(formatFilterCount(10_000)).toBe("10k");
    expect(formatFilterCount(12_340)).toBe("12.3k");
    expect(formatFilterCount(234_567)).toBe("235k");
  });

  it("is defensive about junk input", () => {
    expect(formatFilterCount(Number.NaN)).toBe("0");
    expect(formatFilterCount(-3)).toBe("0");
  });
});

describe("selected-pin dimming", () => {
  it("dims every pin except the selected one", () => {
    expect(isPinDimmed(null, 5)).toBe(false);
    expect(isPinDimmed(5, 5)).toBe(false);
    expect(isPinDimmed(5, 6)).toBe(true);
  });

  it("is the identity paint when nothing is selected (restore on deselect)", () => {
    expect(unclusteredOpacityExpr(null)).toBe(PIN_DS_OPACITY);
  });

  it("builds a case expression keeping the selected pin at full ds-opacity", () => {
    const expr = unclusteredOpacityExpr(42);
    expect(expr[0]).toBe("case");
    expect(expr[1]).toEqual(["==", ["get", "id"], 42]);
    expect(expr[2]).toBe(PIN_DS_OPACITY);
    expect(expr[3]).toBe(DIMMED_PIN_OPACITY);
    // Fully lit before, during and after selection — no wash on tap.
    expect(DIMMED_PIN_OPACITY).toBe(1);
  });
});

describe("tightened unclustered paint (pin density)", () => {
  it("shrinks every zoom stop ~15-20% from the old 4.5/6.5/8/11 ramp", () => {
    expect(UNCLUSTERED_PAINT["circle-radius"]).toEqual(
      ["interpolate", ["linear"], ["zoom"], 12, 3.75, 15, 5.25, 17, 6.5, 20, 9],
    );
  });

  it("thins the outline 2 → 1.5 (visited stays bolder at 2.5)", () => {
    expect(UNCLUSTERED_PAINT["circle-stroke-width"]).toEqual(
      ["case", ["==", ["get", "visited"], 1], 2.5, 1.5],
    );
  });

  it("keeps status color and ds-opacity untouched", () => {
    expect(UNCLUSTERED_PAINT["circle-opacity"]).toBe(PIN_DS_OPACITY);
    expect(UNCLUSTERED_PAINT["circle-color"][0]).toBe("match");
  });
});
