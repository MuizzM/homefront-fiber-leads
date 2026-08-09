import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BottomTabs, __resetBarEntranceForTests } from "../../client/src/components/BottomTabs";

const css = readFileSync(resolve(__dirname, "../../client/src/index.css"), "utf8");

/** Navigate the hash router the way a tab tap does, inside act so wouter's
 *  hashchange subscription and the bar's layout effects flush synchronously. */
function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

/** jsdom reports zero rects — give the bar and each tab's icon capsule real
 *  geometry so the measured pill positioning is asserted against real math. */
function mockGeometry(nav: HTMLElement) {
  const bar = nav.firstElementChild as HTMLElement;
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(rect(12, 700, 366, 62));
  const anchors = [...nav.querySelectorAll<HTMLElement>("[data-pill-anchor]")];
  // Five equal 73.2px slots; each 44x28 capsule centered in its slot at y 716.
  anchors.forEach((anchor, i) => {
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect(12 + i * 73.2 + (73.2 - 44) / 2, 716, 44, 28));
  });
  return anchors;
}

describe("BottomTabs mobile More action", () => {
  it("opens the app-native More sheet without dispatching the legacy drawer event", () => {
    const onMore = vi.fn();
    const legacy = vi.fn();
    window.addEventListener("hfs:open-menu", legacy);
    render(<BottomTabs onMore={onMore} moreOpen />);

    const button = screen.getByTestId("tab-more");
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(button);
    expect(onMore).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    window.removeEventListener("hfs:open-menu", legacy);
  });
});

describe("the liquid floating bar", () => {
  // The bar is DETACHED glass (TIDE/Moonly pattern) — content scrolls behind
  // it. These pins are behavioral, not cosmetic: an edge-attached bar under
  // pages that reserve 88px of runway leaves a dead gap, and a bar without
  // the shared liquid class silently loses its reduced-transparency and
  // no-backdrop-filter legibility fallbacks.
  it("floats detached from the screen edges as shared liquid chrome", () => {
    render(<BottomTabs role="rep" />);
    const nav = screen.getByTestId("bottom-tabs");
    expect(nav.className).toContain("liquid-bar");     // fallbacks live here
    expect(nav.className).toContain("inset-x-3");      // detached, not flush
    expect(nav.className).not.toContain("border-t ");  // no edge-bar seam
  });

  it("keeps every destination and its testids intact", () => {
    render(<BottomTabs role="rep" />);
    for (const id of ["tab-today", "tab-leads", "tab-map", "tab-pay", "tab-more"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it("shows a notification dot on More only when moreDot is set", () => {
    const { rerender } = render(<BottomTabs role="rep" />);
    expect(screen.queryByTestId("tab-more-dot")).toBeNull();
    rerender(<BottomTabs role="rep" moreDot />);
    expect(screen.getByTestId("tab-more-dot")).toBeInTheDocument();
  });

  it("marks the active destination with a pill inside the glass, not a rim underline", () => {
    window.location.hash = "#/today";
    render(<BottomTabs role="rep" />);
    const active = screen.getByTestId("tab-today");
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active.querySelector(".rounded-full")).not.toBeNull();
    // The active marker itself is the sliding pill INSIDE the bar's glass.
    expect(screen.getByTestId("bottom-tabs").contains(screen.getByTestId("tab-active-pill"))).toBe(true);
  });
});

describe("liquid motion: the sliding active pill", () => {
  it("is ONE element, moved by GPU transform - not five pills toggling", () => {
    window.location.hash = "#/today";
    render(<BottomTabs role="rep" />);
    const pills = screen.getAllByTestId("tab-active-pill");
    expect(pills).toHaveLength(1);
    const pill = pills[0];
    expect(pill.className).toContain("liquid-active-pill");
    expect(pill.style.transform).toMatch(/^translate3d\(/);
    expect(pill).toHaveAttribute("aria-hidden", "true");
    // No tab carries its own toggling active-tint pill anymore — the tint
    // lives on the single sliding element.
    const anchors = [...screen.getByTestId("bottom-tabs").querySelectorAll("[data-pill-anchor]")];
    expect(anchors.some(el => el.className.includes("bg-primary/[0.16]"))).toBe(false);
  });

  it("snaps instantly on first mount, then GLIDES on tab change, landing exactly on the active anchor", () => {
    window.location.hash = "#/today";
    Object.defineProperty(navigator, "vibrate", { value: vi.fn(), configurable: true, writable: true });
    render(<BottomTabs role="rep" />);
    const nav = screen.getByTestId("bottom-tabs");
    const pill = screen.getByTestId("tab-active-pill");

    // First mount: positioned with the transition zeroed — no entrance glide.
    expect(pill.style.transitionDuration).toBe("0s");

    const anchors = mockGeometry(nav);
    go("#/leads");

    // Tab change: transition restored (CSS spring takes over) and the pill's
    // translate CENTERS the 56x40 lozenge on the MEASURED 44x28 leads capsule
    // relative to the bar — capsule left offset 73.2+14.6, minus the (56-44)/2
    // and (40-28)/2 the larger lozenge overhangs → x 81.8, y 10.
    expect(pill.style.transitionDuration).toBe("");
    const [x, y] = pill.style.transform.match(/-?[\d.]+/g)!.map(Number).slice(1);
    expect(x).toBeCloseTo(73.2 + (73.2 - 44) / 2 - (56 - 44) / 2, 5);
    expect(y).toBe(16 + (28 - 40) / 2);
    expect(navigator.vibrate).toHaveBeenCalledWith(8);
    expect(anchors[1].className).toContain("tab-icon-pop"); // incoming icon pops
    expect(anchors[0].className).not.toContain("tab-icon-pop"); // outgoing fades via transition-colors
  });

  it("hides the pill when no bar destination is active", () => {
    window.location.hash = "#/today";
    render(<BottomTabs role="rep" />);
    const pill = screen.getByTestId("tab-active-pill");
    go("#/leaderboard");
    expect(pill.style.opacity).toBe("0");
  });

  it("uses the spring overshoot curve and keeps a reduced-motion guard (source pins)", () => {
    // The glide is the iOS pop: 380ms with a back-out bezier that overshoots.
    expect(css).toMatch(/\.liquid-active-pill\s*\{[^}]*transform 380ms cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/);
    // Explicit reduced-motion guard collapses pill glide, icon pop, entrance.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.liquid-active-pill \{ transition: none; \}\s*\.tab-icon-pop, \.liquid-bar-enter \{ animation: none; \}/);
    // Icon pop keyframes: 1 → 1.15 → 1.
    expect(css).toMatch(/@keyframes tab-icon-pop[\s\S]*?scale\(1\.15\)/);
    // Entrance: rise ~12px + fade.
    expect(css).toMatch(/@keyframes liquid-bar-rise[\s\S]*?translateY\(12px\)/);
  });
});

describe("liquid motion: press state and entrance", () => {
  it("keeps the subtle press state on every destination", () => {
    render(<BottomTabs role="rep" />);
    for (const id of ["tab-today", "tab-leads", "tab-map", "tab-pay", "tab-more"]) {
      expect(screen.getByTestId(id).className).toContain("active:scale-[.94]");
    }
  });

  it("plays the rise+fade entrance once per session - never again on remount", () => {
    __resetBarEntranceForTests();
    window.location.hash = "#/today";
    const first = render(<BottomTabs role="rep" />);
    expect(screen.getByTestId("bottom-tabs").className).toContain("liquid-bar-enter");
    first.unmount();
    // Route trips through the full-bleed map unmount/remount the bar — the
    // entrance must not replay.
    render(<BottomTabs role="rep" />);
    expect(screen.getByTestId("bottom-tabs").className).not.toContain("liquid-bar-enter");
  });
});
