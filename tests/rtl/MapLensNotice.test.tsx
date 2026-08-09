// The map's source lens filters SILENTLY, and that is how an owner's
// assignment disappeared: a block of FCC-footprint doors was assigned to a rep,
// the rep's default "Latest fiber" lens dropped every one of them, and an
// empty street is indistinguishable from never having been assigned anything.
// These tests pin the affordance that makes the filtering visible.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MapLensNotice } from "../../client/src/components/map/MapLensNotice";

const props = {
  hiddenCount: 142,
  lensLabel: "Latest fiber",
  onShowAll: () => {},
  onDismiss: () => {},
};

describe("MapLensNotice", () => {
  it("names how many doors are hidden and which lens is hiding them", () => {
    render(<MapLensNotice {...props} />);
    const chip = screen.getByTestId("map-lens-notice");
    expect(chip).toHaveTextContent("142 doors hidden by Latest fiber");
  });

  it("renders NOTHING when the lens is hiding nothing", () => {
    // A chip that appears at zero would be noise on every clean map.
    render(<MapLensNotice {...props} hiddenCount={0} />);
    expect(screen.queryByTestId("map-lens-notice")).toBeNull();
    render(<MapLensNotice {...props} hiddenCount={-3} />);
    expect(screen.queryByTestId("map-lens-notice")).toBeNull();
  });

  it("says 'door' for exactly one", () => {
    render(<MapLensNotice {...props} hiddenCount={1} />);
    expect(screen.getByTestId("map-lens-notice")).toHaveTextContent("1 door hidden");
  });

  it("groups thousands so a big number is readable at a glance", () => {
    render(<MapLensNotice {...props} hiddenCount={12345} />);
    expect(screen.getByTestId("map-lens-notice")).toHaveTextContent("12,345 doors hidden");
  });

  it("Show all clears the lens in one tap - the whole point of the chip", () => {
    const onShowAll = vi.fn();
    render(<MapLensNotice {...props} onShowAll={onShowAll} />);
    fireEvent.click(screen.getByTestId("map-lens-notice-show-all"));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it("can be dismissed without changing the lens", () => {
    const onDismiss = vi.fn();
    const onShowAll = vi.fn();
    render(<MapLensNotice {...props} onDismiss={onDismiss} onShowAll={onShowAll} />);
    fireEvent.click(screen.getByTestId("map-lens-notice-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onShowAll).not.toHaveBeenCalled();
  });

  it("is announced to assistive tech as a status, not an alert", () => {
    render(<MapLensNotice {...props} />);
    expect(screen.getByTestId("map-lens-notice")).toHaveAttribute("role", "status");
  });
});
