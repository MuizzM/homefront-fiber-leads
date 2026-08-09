// @vitest-environment jsdom
//
// The lasso on a phone: finishing a freshly drawn loop scrolled the page down
// and, from scroll top, reloaded it.
//
// The cause is the arming step. Mapbox GL sets the canvas's touch-action from
// classes it applies only while drag-pan AND touch-zoom-rotate are enabled. The
// lasso disables both so the map holds still under the stroke — which drops the
// canvas to `touch-action: auto` and hands the gesture straight back to the
// browser. Pulling down from scroll top is the pull-to-refresh gesture. The
// reload was the browser doing exactly what it was asked.
//
// These specs pin the second half of arming: the browser's gestures have to go
// down with the map's, and come back with them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  lockDocumentPullToRefresh,
  lockGesturesForDrawing,
  mapGestureTarget,
} from "../../client/src/lib/lassoGestureLock";

function container(withCanvas = true): HTMLElement {
  const el = document.createElement("div");
  if (withCanvas) el.appendChild(document.createElement("canvas"));
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
  // documentElement survives between tests in a file, so a spec that locks the
  // root without releasing would otherwise become the "previous value" the next
  // one saves and restores.
  document.documentElement.removeAttribute("style");
});

describe("the browser stops scrolling while a finger draws", () => {
  it("takes touch-action away from the element under the finger", () => {
    const el = container();
    lockGesturesForDrawing(el);
    expect(el.style.touchAction).toBe("none");
  });

  it("locks the canvas too, not just its container", () => {
    // Mapbox's touch-action rule targets BOTH the canvas container and the
    // canvas. Locking only the container leaves the element actually under the
    // finger free to scroll the page.
    const el = container();
    lockGesturesForDrawing(el);
    expect((el.querySelector("canvas") as HTMLElement).style.touchAction).toBe("none");
  });

  it("kills the pull-to-refresh overscroll that did the reloading", () => {
    const el = container();
    lockGesturesForDrawing(el);
    expect(el.style.overscrollBehavior).toBe("none");
  });

  it("stops the stroke from selecting text or raising the iOS callout", () => {
    const el = container();
    lockGesturesForDrawing(el);
    expect(el.style.userSelect).toBe("none");
    expect((el.style as any).webkitTouchCallout).toBe("none");
  });
});

describe("the touchmove listener is registered so it can actually cancel", () => {
  it("passes { passive: false } - without it preventDefault is forbidden", () => {
    // THE assertion in this file. A touchmove listener registered without this
    // flag is passive by default in every modern browser, and a passive listener
    // calling preventDefault is ignored with a console warning. Registering the
    // listener at all is worthless unless this option is set.
    const el = container();
    const spy = vi.spyOn(el, "addEventListener");
    lockGesturesForDrawing(el);

    const touchmove = spy.mock.calls.find((c) => c[0] === "touchmove");
    expect(touchmove, "no touchmove listener was registered").toBeDefined();
    expect(touchmove![2]).toEqual({ passive: false });
  });

  it("also claims touchstart, where iOS decides if a gesture may scroll", () => {
    const el = container();
    const spy = vi.spyOn(el, "addEventListener");
    lockGesturesForDrawing(el);

    const touchstart = spy.mock.calls.find((c) => c[0] === "touchstart");
    expect(touchstart).toBeDefined();
    expect(touchstart![2]).toEqual({ passive: false });
  });

  it("cancels a cancelable touchmove", () => {
    const el = container();
    lockGesturesForDrawing(el);

    const event = new Event("touchmove", { cancelable: true, bubbles: true });
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a non-cancelable move alone instead of warning every frame", () => {
    // Once the browser has committed to a scroll the event is not cancelable;
    // calling preventDefault then does nothing except log "Ignored attempt to
    // cancel a touchmove" on every frame of the stroke.
    const el = container();
    lockGesturesForDrawing(el);

    const event = new Event("touchmove", { cancelable: false, bubbles: true });
    expect(() => el.dispatchEvent(event)).not.toThrow();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("the page gets its gestures back", () => {
  it("restores every property to exactly what it was", () => {
    const el = container();
    el.style.touchAction = "pan-y";
    el.style.userSelect = "text";

    lockGesturesForDrawing(el)();

    expect(el.style.touchAction).toBe("pan-y");
    expect(el.style.userSelect).toBe("text");
  });

  it("clears properties that had no inline value, rather than inventing one", () => {
    // Restoring to a hardcoded "auto" would stamp an inline value over whatever
    // the stylesheet was providing — Mapbox's own touch-action rules included,
    // which are what re-enable map panning after the tool disarms.
    //
    // Asserted as "empty", not `=== ""`: a real browser reports "" for an unset
    // property, jsdom reports undefined for one it does not implement. Both mean
    // "no inline declaration", which is the property that matters.
    const el = container();

    lockGesturesForDrawing(el)();

    for (const prop of ["touchAction", "overscrollBehavior", "userSelect"] as const) {
      expect((el.style as any)[prop] ?? "", `${prop} was left set`).toBe("");
    }
  });

  it("stops cancelling touchmove, so the map scrolls normally again", () => {
    const el = container();
    lockGesturesForDrawing(el)();

    const event = new Event("touchmove", { cancelable: true, bubbles: true });
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("unlocks the canvas as well as the container", () => {
    const el = container();
    lockGesturesForDrawing(el)();
    expect((el.querySelector("canvas") as HTMLElement).style.touchAction).toBe("");
  });

  it("ignores a second release instead of clobbering a later lock", () => {
    // Teardown can arrive from React unmount, from disarming the tool, and from
    // an error path. A second release must not stamp its stale saved values over
    // a lock that a NEW draw has since taken — that would silently re-enable
    // page scrolling mid-stroke.
    const el = container();
    const release = lockGesturesForDrawing(el);
    release();
    release();

    const relock = lockGesturesForDrawing(el);
    release();                                   // the stale one, fired late
    expect(el.style.touchAction).toBe("none");   // the new lock still holds
    relock();
  });
});

describe("arming the tool can never take the map down", () => {
  it("returns a usable no-op for a missing element", () => {
    expect(() => lockGesturesForDrawing(null)()).not.toThrow();
    expect(() => lockGesturesForDrawing(undefined)()).not.toThrow();
  });

  it("handles a container with no canvas yet", () => {
    const el = container(false);
    expect(() => lockGesturesForDrawing(el)()).not.toThrow();
  });
});

describe("pull-to-refresh is also killed at the document root", () => {
  // body already carries `overscroll-behavior-y: none` app-wide, and per spec
  // that propagates to the viewport while the root's own value is `auto`. This
  // does not depend on that rule still holding after some future stylesheet edit.
  //
  // Chrome/Android belt to the canvas lock's braces — NOT the iOS mechanism.
  // WebKit ignores overscroll-behavior for the rubber-band gesture, which is why
  // the canvas lock uses touch-action plus a cancelled touchmove instead.
  it("sets it on the root element for the duration of the draw", () => {
    lockDocumentPullToRefresh(document);
    expect((document.documentElement.style as any).overscrollBehaviorY).toBe("none");
    expect((document.documentElement.style as any).overscrollBehaviorX).toBe("none");
  });

  it("puts the root back exactly as it found it", () => {
    const root = document.documentElement;
    (root.style as any).overscrollBehaviorY = "contain";

    lockDocumentPullToRefresh(document)();

    expect((root.style as any).overscrollBehaviorY).toBe("contain");
    expect((root.style as any).overscrollBehaviorX ?? "").toBe("");
    (root.style as any).overscrollBehaviorY = "";
  });

  it("is idempotent, like the canvas lock", () => {
    const release = lockDocumentPullToRefresh(document);
    release();
    const relock = lockDocumentPullToRefresh(document);
    release();
    expect((document.documentElement.style as any).overscrollBehaviorY).toBe("none");
    relock();
  });

  it("no-ops without a document instead of throwing during SSR or teardown", () => {
    expect(() => lockDocumentPullToRefresh(null)()).not.toThrow();
    expect(() => lockDocumentPullToRefresh(undefined)()).not.toThrow();
  });
});

describe("finding the element Mapbox attaches touch handling to", () => {
  it("prefers the canvas container, which carries the touch-action classes", () => {
    const wrapper = document.createElement("div");
    const canvas = document.createElement("canvas");
    expect(mapGestureTarget({ getCanvasContainer: () => wrapper, getCanvas: () => canvas })).toBe(wrapper);
  });

  it("falls back to the canvas when the container is unavailable", () => {
    const canvas = document.createElement("canvas");
    expect(mapGestureTarget({ getCanvas: () => canvas })).toBe(canvas);
  });

  it("returns null for a map mid-teardown rather than throwing", () => {
    const dead = {
      getCanvasContainer: () => { throw new Error("map removed"); },
      getCanvas: () => { throw new Error("map removed"); },
    };
    expect(mapGestureTarget(dead)).toBeNull();
    expect(mapGestureTarget(null)).toBeNull();
    expect(mapGestureTarget(undefined)).toBeNull();
  });
});
