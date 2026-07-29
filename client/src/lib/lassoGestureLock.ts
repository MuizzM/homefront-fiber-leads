// Holding the browser still while a finger draws on the map.
//
// The bug: on mobile web, finishing a freshly drawn lasso scrolled the page down
// and — at scroll top — reloaded it outright.
//
// The cause is the arming step itself. Mapbox GL decides the canvas's
// `touch-action` from CLASSES it puts on the canvas container, and it only lands
// on `touch-action: none` while BOTH drag-pan and touch-zoom-rotate are enabled:
//
//     .mapboxgl-canvas-container.mapboxgl-touch-zoom-rotate.mapboxgl-touch-drag-pan,
//     … .mapboxgl-canvas { touch-action: none; }
//
// The lasso arms by calling dragPan.disable() + touchZoomRotate.disable() so the
// map holds still under the stroke. Mapbox removes those classes, the rule stops
// matching, and the canvas falls back to `touch-action: auto` — i.e. disabling
// map panning is precisely what hands the gesture back to the browser. The
// finger then scrolls the page, and a downward stroke starting at scroll top is
// the pull-to-refresh gesture, which reloads.
//
// So the map's gestures and the browser's gestures have to be suppressed
// together, and this module owns the second half.
//
// Two mechanisms, deliberately both:
//
//   1. INLINE `touch-action: none` — inline styles outrank Mapbox's stylesheet
//      whatever its rules happen to be, and unlike a CSS class it cannot be
//      undone by Mapbox re-computing its own classes mid-draw.
//   2. A NON-PASSIVE `touchmove` listener that calls preventDefault(). Belt and
//      braces for iOS Safari, where `touch-action` does not govern rubber-band
//      overscroll, and for installed PWA mode. A listener registered without
//      `{ passive: false }` is silently forbidden from calling preventDefault on
//      touchmove in every modern browser, so the flag is the entire point.
//
// Everything is restored exactly — including properties that were never set,
// which restore to "" rather than to a hardcoded default that would clobber a
// value the stylesheet was providing.

/** The inline properties we take over for the duration of a stroke. */
const LOCKED_STYLES = {
  touchAction: "none",
  overscrollBehavior: "none",
  userSelect: "none",
  webkitUserSelect: "none",
  webkitTouchCallout: "none",
} as const;

type LockedProp = keyof typeof LOCKED_STYLES;

/**
 * Suspend browser scrolling, pull-to-refresh, text selection and the iOS
 * touch-callout on `element` and its canvas descendants.
 *
 * Returns a restore function. Calling it more than once is safe and does nothing
 * after the first call — teardown can arrive from React unmount, from disarming
 * the tool, and from an error path, and the second one must not stamp stale
 * values back over a lock a later draw has since taken.
 */
export function lockGesturesForDrawing(element: HTMLElement | null | undefined): () => void {
  if (!element) return () => {};

  // The canvas itself carries Mapbox's touch-action rule too, so locking only
  // the container leaves the element actually under the finger unlocked.
  const targets: HTMLElement[] = [element];
  for (const canvas of Array.from(element.querySelectorAll("canvas"))) {
    targets.push(canvas as HTMLElement);
  }

  const saved = targets.map((el) => {
    const previous = {} as Record<LockedProp, string>;
    for (const prop of Object.keys(LOCKED_STYLES) as LockedProp[]) {
      // "" when unset — restoring "" removes the inline value and lets the
      // stylesheet win again, which is the correct undo.
      previous[prop] = (el.style as any)[prop] ?? "";
      (el.style as any)[prop] = LOCKED_STYLES[prop];
    }
    return { el, previous };
  });

  // cancelable is false for a scroll the browser has already committed to;
  // calling preventDefault then is a no-op that logs an "Ignored attempt to
  // cancel" warning on Chrome for every frame of the stroke.
  const swallow = (event: Event) => {
    if (event.cancelable) event.preventDefault();
  };

  // touchmove is the one that scrolls and pull-to-refreshes. touchstart is
  // included because iOS decides whether a gesture may scroll at touch start.
  element.addEventListener("touchmove", swallow, { passive: false });
  element.addEventListener("touchstart", swallow, { passive: false });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    element.removeEventListener("touchmove", swallow);
    element.removeEventListener("touchstart", swallow);
    for (const { el, previous } of saved) {
      for (const prop of Object.keys(LOCKED_STYLES) as LockedProp[]) {
        (el.style as any)[prop] = previous[prop];
      }
    }
  };
}

/**
 * Kill pull-to-refresh at the document root for the duration of a stroke.
 *
 * `body { overscroll-behavior-y: none }` is already set app-wide, and per spec
 * that propagates to the viewport — but only while the root element's own value
 * computes to `auto`. That is one stylesheet edit away from silently ceasing to
 * be true, and the failure is invisible until someone reports the page
 * reloading. Setting it on the root directly during a draw does not depend on
 * the propagation rule holding.
 *
 * This is the Chrome/Android belt to the canvas lock's braces. It is NOT the
 * mechanism that fixes iOS: WebKit does not honour overscroll-behavior for the
 * rubber-band / pull-to-refresh gesture, which is why the canvas lock relies on
 * touch-action plus a cancelled touchmove instead.
 */
export function lockDocumentPullToRefresh(doc: Document | null | undefined): () => void {
  const root = doc?.documentElement;
  if (!root) return () => {};

  const previous = {
    overscrollBehaviorY: (root.style as any).overscrollBehaviorY ?? "",
    overscrollBehaviorX: (root.style as any).overscrollBehaviorX ?? "",
  };
  (root.style as any).overscrollBehaviorY = "none";
  (root.style as any).overscrollBehaviorX = "none";

  let released = false;
  return () => {
    if (released) return;
    released = true;
    (root.style as any).overscrollBehaviorY = previous.overscrollBehaviorY;
    (root.style as any).overscrollBehaviorX = previous.overscrollBehaviorX;
  };
}

/**
 * The element Mapbox actually attaches its touch handling to.
 *
 * `map.getCanvasContainer()` is the documented accessor and is what carries the
 * touch-action classes; `getCanvas()` is the fallback for a map mid-teardown or
 * a test double. Never throws — arming the lasso must not be able to take the
 * map down with it.
 */
export function mapGestureTarget(map: any): HTMLElement | null {
  try {
    const container = map?.getCanvasContainer?.();
    if (container) return container as HTMLElement;
  } catch {
    /* map mid-teardown */
  }
  try {
    const canvas = map?.getCanvas?.();
    return (canvas as HTMLElement) ?? null;
  } catch {
    return null;
  }
}
