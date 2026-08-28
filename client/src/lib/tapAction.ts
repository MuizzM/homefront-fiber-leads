// ── tapAction — a button that survives a thumb ───────────────────────────────
//
// A browser only synthesizes a `click` from a touch when the finger stays
// inside its own tap slop (about 8px in Chromium). Move further and the gesture
// is reclassified as a pan: on an ordinary page that at least scrolls, so the
// person sees SOMETHING happen and taps again. Inside a region that sets
// `touch-action: none` - every draggable sheet in this app - there is nothing
// to pan, so the tap evaporates. No click, no scroll, no feedback.
//
// That is the second half of "the address will not copy on my phone". The first
// half was the sheet's drag region eating the click (see the guards in
// LeadKnockSheet); this half is the click never existing. Measured with
// verify-copy-phone.mjs against the running app at 390x844: a touch that drifts
// 16px delivers `pointerdown touchstart pointerup touchend` to the Copy disc
// and no click at all, the clipboard keeps its previous contents, and the sheet
// says neither "Address copied" nor "Could not copy".
//
// So the controls that live inside those regions act on `pointerup` instead,
// with the slop a walking rep actually needs, and swallow the click afterwards
// if one does turn up. Mouse and keyboard keep using `click` untouched, which
// is what keeps Enter and Space working.

import { useCallback, useRef } from "react";

/**
 * How far a finger may travel and still count as a tap.
 *
 * Deliberately far larger than a browser's own slop: this is a 44px disc that
 * only ever does one thing, pressed by someone standing on a porch, and the
 * cost of a false positive (an action they nearly asked for) is far below the
 * cost of a false negative (nothing happens and they do not know why). It stays
 * under the distance that reads as a deliberate swipe.
 */
export const TAP_DRIFT_PX = 24;

type Press = { pointerId: number; x: number; y: number };

/**
 * Props for a control that must fire even when the tap drifts.
 *
 * Spread onto the element INSTEAD of `onClick`. `run` is called inside the
 * pointerup handler, which still carries user activation - so a `copyText` in
 * there reaches the Clipboard API with its gesture intact.
 */
export function useTapAction(run: () => void) {
  const press = useRef<Press | null>(null);
  const firedFromPointer = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    firedFromPointer.current = false;
    press.current = null;
    // Primary button / first finger only, and only for the pointer types whose
    // clicks the browser may withhold. A mouse click is never dropped, so a
    // mouse keeps the plain click path and its press-and-drag-away-to-cancel.
    if (e.button !== 0 || !e.isPrimary) return;
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    press.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const started = press.current;
    press.current = null;
    if (!started || e.pointerId !== started.pointerId) return;
    const drift = Math.hypot(e.clientX - started.x, e.clientY - started.y);
    if (drift > TAP_DRIFT_PX) return; // a swipe, not a tap
    firedFromPointer.current = true;
    run();
  }, [run]);

  const onPointerCancel = useCallback(() => { press.current = null; }, []);

  const onClick = useCallback(() => {
    // The compatibility click that follows a successful touch, or a real mouse
    // or keyboard click. Only the latter should run the action again.
    if (firedFromPointer.current) { firedFromPointer.current = false; return; }
    run();
  }, [run]);

  return { onPointerDown, onPointerUp, onPointerCancel, onClick };
}
