import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BottomTabs } from "../../client/src/components/BottomTabs";

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

  it("marks the active destination with a pill inside the glass, not a rim underline", () => {
    window.location.hash = "#/today";
    render(<BottomTabs role="rep" />);
    const active = screen.getByTestId("tab-today");
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active.querySelector(".rounded-full")).not.toBeNull();
  });
});
