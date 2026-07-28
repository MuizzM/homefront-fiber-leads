import { beforeEach, describe, expect, it } from "vitest";
import {
  CHROME_AUTO_HIDE_IDLE,
  CHROME_RESHOW_DELAY_MS,
  DIMMED_PIN_OPACITY,
  FILTER_STATUS_LS_KEY,
  PIN_DS_OPACITY,
  UNCLUSTERED_PAINT,
  chromeAutoHideNext,
  filterControlNext,
  formatFilterCount,
  isPinDimmed,
  persistFilterStatus,
  readPersistedFilterStatus,
  unclusteredOpacityExpr,
  type ChromeAutoHideState,
  type FilterControlState,
} from "../../client/src/lib/mapPins";

// Lane E2 — field-map chrome cleanup (MAP FIRST). Pure-logic coverage for the
// three extracted machines: the compact status-filter control, the
// secondary-chrome auto-hide timing, and the selected-pin dimming predicate —
// plus the tightened pin paint contract.

describe("filter control state machine (collapsed/open/select/reset)", () => {
  const closed: FilterControlState = { open: false, status: "all" };

  it("toggles open and closed from the pill", () => {
    const opened = filterControlNext(closed, { type: "toggle" });
    expect(opened).toEqual({ open: true, status: "all" });
    expect(filterControlNext(opened, { type: "toggle" })).toEqual(closed);
  });

  it("selecting a status applies it and collapses back to the pill", () => {
    const opened = filterControlNext(closed, { type: "toggle" });
    expect(filterControlNext(opened, { type: "select", status: "not_home" }))
      .toEqual({ open: false, status: "not_home" });
  });

  it("one-tap reset returns to All from any selection", () => {
    const filtered: FilterControlState = { open: true, status: "sold" };
    expect(filterControlNext(filtered, { type: "reset" }))
      .toEqual({ open: false, status: "all" });
  });

  it("close is idempotent and never changes the selection", () => {
    const filtered: FilterControlState = { open: true, status: "interested" };
    expect(filterControlNext(filtered, { type: "close" }))
      .toEqual({ open: false, status: "interested" });
    expect(filterControlNext({ open: false, status: "interested" }, { type: "close" }))
      .toEqual({ open: false, status: "interested" });
  });
});

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

  it("survives storage being blocked (throws) without crashing", () => {
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

describe("secondary-chrome auto-hide timing", () => {
  const T0 = 1_000_000;

  it("hides immediately on gesture start", () => {
    expect(chromeAutoHideNext(CHROME_AUTO_HIDE_IDLE, { type: "interact-start", now: T0 }))
      .toEqual({ hidden: true, reshowAt: null });
  });

  it("arms the reshow for ~800ms after the gesture ends", () => {
    const hidden = chromeAutoHideNext(CHROME_AUTO_HIDE_IDLE, { type: "interact-start", now: T0 });
    const armed = chromeAutoHideNext(hidden, { type: "interact-end", now: T0 + 120 });
    expect(armed).toEqual({ hidden: true, reshowAt: T0 + 120 + CHROME_RESHOW_DELAY_MS });
    expect(CHROME_RESHOW_DELAY_MS).toBe(800);
  });

  it("stays hidden until the reshow instant, then reappears", () => {
    const armed: ChromeAutoHideState = { hidden: true, reshowAt: T0 + 800 };
    expect(chromeAutoHideNext(armed, { type: "idle-timer", now: T0 + 799 })).toEqual(armed);
    expect(chromeAutoHideNext(armed, { type: "idle-timer", now: T0 + 800 }))
      .toEqual(CHROME_AUTO_HIDE_IDLE);
  });

  it("a new gesture inside the wait window cancels the pending reshow (debounce)", () => {
    const armed: ChromeAutoHideState = { hidden: true, reshowAt: T0 + 800 };
    const regrabbed = chromeAutoHideNext(armed, { type: "interact-start", now: T0 + 500 });
    expect(regrabbed).toEqual({ hidden: true, reshowAt: null });
    // …and the stale timer firing later must NOT reveal chrome mid-gesture.
    expect(chromeAutoHideNext(regrabbed, { type: "idle-timer", now: T0 + 900 }))
      .toEqual(regrabbed);
  });

  it("re-ending a gesture re-arms from the LATEST end time", () => {
    const a = chromeAutoHideNext(CHROME_AUTO_HIDE_IDLE, { type: "interact-end", now: T0 });
    const b = chromeAutoHideNext(a, { type: "interact-end", now: T0 + 300 });
    expect(b.reshowAt).toBe(T0 + 300 + CHROME_RESHOW_DELAY_MS);
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
    expect(DIMMED_PIN_OPACITY).toBe(0.45);
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
