import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// What counts as focusable inside a modal panel. Kept deliberately simple -
// the app's hand-rolled overlays contain links, buttons, and form controls,
// not exotic widgets.
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The one modal-behavior contract for hand-rolled overlays (the Radix
 * Dialog/Sheet primitives already do all of this themselves).
 *
 * Six surfaces declared `aria-modal="true"` - which tells assistive tech to
 * hide everything OUTSIDE the dialog - while keyboard focus stayed outside it,
 * stranding screen-reader users in a perceivable dead zone. Each had also
 * reimplemented some subset of Escape/scroll-lock/autofocus, and none
 * restored focus to the control that opened it.
 *
 * While `active`:
 * - moves focus into the panel (`initialFocus` selector, else the first
 *   focusable, else the panel itself);
 * - contains Tab / Shift+Tab inside the panel;
 * - closes on Escape, in the CAPTURE phase so a global hatch underneath (the
 *   map's tool-exit handler) cannot act on the same keypress;
 * - locks body scroll (opt out with `lockScroll: false` for non-blocking
 *   drawers that intentionally leave the page scrollable);
 * - on deactivation, restores focus to the element that was focused when the
 *   panel opened.
 */
export function useModalA11y(
  panelRef: RefObject<HTMLElement | null>,
  {
    active,
    onClose,
    initialFocus,
    lockScroll = true,
  }: {
    active: boolean;
    onClose: () => void;
    /** CSS selector, resolved inside the panel, for the element to focus on open. */
    initialFocus?: string;
    lockScroll?: boolean;
  },
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const panel = panelRef.current;
    if (!panel) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const previousOverflow = lockScroll ? document.body.style.overflow : "";
    if (lockScroll) document.body.style.overflow = "hidden";

    const target =
      (initialFocus ? panel.querySelector<HTMLElement>(initialFocus) : null) ??
      panel.querySelector<HTMLElement>(FOCUSABLE) ??
      panel;
    if (target === panel && !panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
    requestAnimationFrame(() => {
      // Never steal focus the user already placed inside the panel - a fast
      // tap into a field before this frame fires must win over the default.
      const current = document.activeElement;
      if (current instanceof Node && current !== panel && panel.contains(current)) return;
      target.focus();
    });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        // offsetParent filters display:none descendants (collapsed sections).
        el => el.offsetParent !== null || el === document.activeElement,
      );
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const head = focusable[0];
      const tail = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === head || current === panel)) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && current === tail) {
        event.preventDefault();
        head.focus();
      } else if (current instanceof Node && !panel.contains(current)) {
        event.preventDefault();
        head.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);

    return () => {
      if (lockScroll) document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey, true);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [active, panelRef, initialFocus, lockScroll]);
}
