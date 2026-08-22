// The strip's own contract: distance-ordered cards, "At door" under 60 m, an
// honest count, a tap that opens the door, and an X that hides the strip.
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NearestDoorsStrip } from "../../client/src/components/map/NearestDoorsStrip";

const pin = (id: number, address: string, over: Record<string, unknown> = {}) => ({
  id, address, lat: 35.67, lng: -80.47, leadStatus: "prospect", ...over,
});

describe("<NearestDoorsStrip />", () => {
  it("renders one card per door with the distance, lights At door, and counts honestly", () => {
    render(<NearestDoorsStrip
      doors={[
        { pin: pin(1, "1842 Oak Ridge Dr"), meters: 17, atDoor: true },
        { pin: pin(2, "1846 Oak Ridge Dr"), meters: 48, atDoor: false },
        { pin: pin(3, "1838 Oak Ridge Dr", { visited: true, lastOutcome: "not_home", lastKnockedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }), meters: 55, atDoor: false },
      ]}
      nearbyTotal={12}
      onOpen={vi.fn()}
      onHide={vi.fn()}
    />);
    expect(screen.getByTestId("nearest-doors-count")).toHaveTextContent("3 of 12 nearby");
    expect(screen.getByTestId("nearest-door-1")).toHaveTextContent("At door");
    expect(screen.getByTestId("nearest-door-2")).toHaveTextContent("48m");
    expect(screen.getByTestId("nearest-door-1")).toHaveTextContent("Never knocked");
    expect(screen.getByTestId("nearest-door-3")).toHaveTextContent("Not Home");
    expect(screen.getByTestId("nearest-door-3")).toHaveTextContent("Last 2d ago");
    expect(screen.getByTestId("nearest-door-2").getAttribute("data-dist-m")).toBe("48");
  });

  it("a tap opens that door; the X hides the strip", () => {
    const onOpen = vi.fn(), onHide = vi.fn();
    render(<NearestDoorsStrip doors={[{ pin: pin(7, "1 Elm St"), meters: 30, atDoor: true }]} nearbyTotal={1} onOpen={onOpen} onHide={onHide} />);
    fireEvent.click(screen.getByTestId("nearest-door-7"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
    fireEvent.click(screen.getByTestId("nearest-doors-hide"));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("renders nothing at all with no doors", () => {
    const { container } = render(<NearestDoorsStrip doors={[]} nearbyTotal={0} onOpen={vi.fn()} onHide={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
