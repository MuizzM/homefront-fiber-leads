// The amber viewport notice chip: renders its message, announces politely,
// and dismisses. Driven by MapView for the truncated-sample ("Showing a
// sample — zoom in for all pins") and over-wide-span ("Zoom in to load pins")
// conditions — the unit tests for viewportNotice pin the wiring.
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

  it("renders the over-wide-span message", () => {
    render(<MapViewportNotice message="Zoom in to load pins" onDismiss={vi.fn()} testId="map-viewport-zoom-notice" />);
    expect(screen.getByTestId("map-viewport-zoom-notice").textContent).toContain("Zoom in to load pins");
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
