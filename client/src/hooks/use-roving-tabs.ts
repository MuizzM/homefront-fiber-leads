import { useRef } from "react";
import type { KeyboardEvent } from "react";

/**
 * The keyboard half of the ARIA tabs/radiogroup contract, for the segmented
 * controls that hand-roll `role="tablist"` / `role="radiogroup"`.
 *
 * Declaring those roles PROMISES a specific keyboard behavior - screen
 * readers announce "1 of N, use arrow keys" - and six screens declared them
 * over plain tabbable buttons where arrows did nothing. Metrics.tsx and the
 * academy's SectionTabs implement the full pattern; this hook extracts the
 * mechanic so a one-line spread fixes the rest.
 *
 * Usage:
 *   const roving = useRovingTabs(items.length, activeIndex, (i) => select(i));
 *   <div role="tablist" onKeyDown={roving.onKeyDown}>
 *     {items.map((it, i) => (
 *       <button role="tab" aria-selected={i === activeIndex}
 *               tabIndex={i === activeIndex ? 0 : -1}
 *               ref={roving.itemRef(i)} ... />
 *     ))}
 *
 * Left/Up move backward, Right/Down forward (wrapping), Home/End jump; the
 * hook focuses AND selects (the recommended automatic-activation flavor).
 */
export function useRovingTabs(
  count: number,
  activeIndex: number,
  onSelect: (index: number) => void,
) {
  const itemsRef = useRef<Array<HTMLElement | null>>([]);

  const itemRef = (index: number) => (el: HTMLElement | null) => {
    itemsRef.current[index] = el;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (count <= 0) return;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        next = (activeIndex - 1 + count) % count;
        break;
      case "ArrowRight":
      case "ArrowDown":
        next = (activeIndex + 1) % count;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    onSelect(next);
    itemsRef.current[next]?.focus();
  };

  return { itemRef, onKeyDown };
}
