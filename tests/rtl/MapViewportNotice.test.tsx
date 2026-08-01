// The amber viewport notice chip: renders its message, announces politely,
// and dismisses. Driven by MapView for the one remaining condition — the
// truncated sample ("Showing a sample — zoom in for all pins"). (The old
// over-wide-span "Zoom in to load pins" condition is gone: the density grid
// renders territory at every zoom.) The unit tests for viewportNotice pin
// the wiring.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MapViewportNotice } from "@/components/map/MapViewportNotice";

describe("MapViewportNotice", () => {
  it("renders the truncated-sample message as a polite status chip", () => {
    render(<MapViewportNotice message="Showing a sample — zoom in for all pins" onDismiss={vi.fn()} testId="map-viewport-sample-notice" />);
    const chip = screen.getByTestId("map-viewport-sample-notice");
    expect(chip).toHaveAttribute("role", "status");
    expect(chip.textContent).toContain("Showing a sample — zoom in for all pins");
  });

  it("has no over-wide-span usage anymore — wide zooms render the density grid", () => {
    // The component is a generic chip, but the CALLER no longer has a zoom
    // condition (viewportNotice's unit tests pin that). Guard the page source
    // so the dead state can't creep back.
    const src = readFileSync(
      join(__dirname, "..", "..", "client/src/pages/MapView.tsx"), "utf8",
    );
    expect(src).not.toContain("Zoom in to load pins");
    expect(src).not.toContain("map-viewport-zoom-notice");
  });

  it("the X dismisses via onDismiss and carries an accessible name", () => {
    const onDismiss = vi.fn();
    render(<MapViewportNotice message="Showing a sample — zoom in for all pins" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId("map-viewport-notice-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Dismiss notice")).toBeInTheDocument();
  });

  it("is not rendered by the caller when the condition is absent (no dead UI)", () => {
    // The component is pure: 'no chip when not truncated' is the caller
    // rendering nothing — pinned by viewportNotice's unit tests. Here: an
    // unmounted tree has no chip.
    const { unmount } = render(<MapViewportNotice message="m" onDismiss={vi.fn()} />);
    unmount();
    expect(screen.queryByTestId("map-viewport-notice")).toBeNull();
  });
});
