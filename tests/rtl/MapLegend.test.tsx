// The rep pin-colors key, pinned.
//
// The key must (1) render one row per item with the shared STATE_LABELS
// vocabulary, the exact STATE_COLORS hue on the dot, and the caller's count,
// (2) prefer the real map glyph over a color dot when one is provided, (3)
// close from its X, and (4) render nothing when closed. It is a read-only
// region (no row is interactive) — reps learn the palette here, they don't
// filter from it (the Filters sheet owns that).
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MapLegend } from "../../client/src/components/map/MapLegend";
import { STATE_COLORS, STATE_LABELS } from "../../shared/knock";

const ITEMS = [
  { key: "unworked", label: STATE_LABELS.unworked, color: STATE_COLORS.unworked, count: 41 },
  { key: "not_home", label: STATE_LABELS.not_home, color: STATE_COLORS.not_home, count: 7 },
  { key: "sold", label: STATE_LABELS.sold, color: STATE_COLORS.sold, count: 0 },
];

function renderKey(over: Partial<React.ComponentProps<typeof MapLegend>> = {}) {
  const onClose = vi.fn();
  const utils = render(<MapLegend open onClose={onClose} items={ITEMS} {...over} />);
  return { ...utils, onClose };
}

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe("map pin-colors key contract", () => {
  it("renders one row per item with the shared label, exact pin color, and count", () => {
    renderKey();
    for (const it of ITEMS) {
      const row = screen.getByTestId(`map-legend-row-${it.key}`);
      expect(row.textContent).toContain(it.label);
      expect(row.textContent).toContain(String(it.count));
      const dot = row.querySelector("span[aria-hidden]") as HTMLElement;
      expect(dot).not.toBeNull();
      expect(dot.style.backgroundColor).toBe(hexToRgb(it.color));
    }
  });

  it("draws the real map glyph instead of a dot when one is provided", () => {
    renderKey({
      items: [{ ...ITEMS[0], glyph: "data:image/png;base64,AAAA" }],
    });
    const row = screen.getByTestId("map-legend-row-unworked");
    const img = row.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("is a labelled read-only region - rows expose no buttons", () => {
    renderKey();
    const region = screen.getByTestId("map-legend");
    expect(region).toHaveAttribute("role", "region");
    expect(region).toHaveAttribute("aria-label", "Pin colors");
    // The ONLY interactive element is the close control.
    expect(region.querySelectorAll("button")).toHaveLength(1);
  });

  it("closes from its X", () => {
    const { onClose } = renderKey();
    fireEvent.click(screen.getByTestId("map-legend-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing at all when closed", () => {
    renderKey({ open: false });
    expect(screen.queryByTestId("map-legend")).toBeNull();
  });
});
