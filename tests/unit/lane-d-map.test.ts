import { describe, expect, it, vi } from "vitest";
import {
  createRafCoalescedFlush,
  decideAddModeTap,
} from "../../client/src/lib/mapPins";

// Lane D — field-map residual fixes. Pure-logic coverage for the two helpers
// extracted from MapView: the add-mode pin-first tap decision (D1) and the
// rAF-coalesced cluster repaint (D3).

describe("decideAddModeTap (D1: pins win over add mode)", () => {
  it("opens the existing lead when the tap hit a pin", () => {
    expect(decideAddModeTap(42)).toEqual({ action: "open-lead", leadId: 42 });
  });

  it("opens the lead even for a near-miss hit id of 0 (only null/undefined miss)", () => {
    expect(decideAddModeTap(0)).toEqual({ action: "open-lead", leadId: 0 });
  });

  it("adds a lead only on a true empty-map tap", () => {
    expect(decideAddModeTap(null)).toEqual({ action: "add-lead" });
    expect(decideAddModeTap(undefined)).toEqual({ action: "add-lead" });
  });
});

describe("createRafCoalescedFlush (D3: one setData per frame max)", () => {
  /** Manual rAF: returns a schedule fn + a fire() that runs one frame. */
  function manualRaf() {
    let queue: Array<() => void> = [];
    const raf = (cb: () => void) => {
      queue.push(cb);
      return queue.length;
    };
    const fireFrame = () => {
      const cbs = queue;
      queue = [];
      cbs.forEach((cb) => cb());
    };
    return { raf, fireFrame, pendingFrames: () => queue.length };
  }

  it("collapses many same-frame schedules into a single flush", () => {
    const { raf, fireFrame } = manualRaf();
    const flush = vi.fn();
    const schedule = createRafCoalescedFlush(flush, raf);

    schedule();
    schedule();
    schedule();
    expect(flush).not.toHaveBeenCalled();

    fireFrame();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("paints the LATEST data at frame time, not a stale snapshot", () => {
    const { raf, fireFrame } = manualRaf();
    const dataRef = { current: ["a"] };
    const flush = vi.fn(() => dataRef.current);
    const schedule = createRafCoalescedFlush(flush, raf);

    schedule(); // scheduled while data is ["a"]
    dataRef.current = ["a", "b"]; // a second tap mutates before the frame
    schedule(); // coalesced onto the same pending frame
    fireFrame();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.results[0].value).toEqual(["a", "b"]);
  });

  it("allows a new flush on the next frame after the pending one fires", () => {
    const { raf, fireFrame } = manualRaf();
    const flush = vi.fn();
    const schedule = createRafCoalescedFlush(flush, raf);

    schedule();
    fireFrame();
    schedule();
    fireFrame();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("does not wedge the pending flag if flush throws", () => {
    const { raf, fireFrame } = manualRaf();
    let shouldThrow = true;
    const flush = vi.fn(() => {
      if (shouldThrow) throw new Error("source gone mid style-switch");
    });
    const schedule = createRafCoalescedFlush(flush, raf);

    schedule();
    expect(() => fireFrame()).toThrow("source gone mid style-switch");
    expect(flush).toHaveBeenCalledTimes(1);

    // The flag cleared BEFORE flush ran, so the next schedule still paints.
    shouldThrow = false;
    schedule();
    fireFrame();
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
