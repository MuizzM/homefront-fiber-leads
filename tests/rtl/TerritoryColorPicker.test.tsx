// Picking the area's colour before drawing it.
//
// The colour describes the GROUND, not the person. Before this control existed
// the save endpoint stamped colorForRep(repId), so an area inherited whichever
// rep was listed first and changed hue the moment it was handed to someone else
// — which is exactly what "my green area shows up blue" meant.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TerritoryColorPicker, TERRITORY_SWATCHES } from "../../client/src/components/territory/TerritoryColorPicker";

const GREEN = TERRITORY_SWATCHES[2];
const BLUE = TERRITORY_SWATCHES[0];

/** The control is controlled, so a vi.fn() alone would freeze `value` and hide
 *  every selection bug. */
function Harness({ initial = BLUE, onPick }: { initial?: string; onPick?: (c: string) => void }) {
  const [color, setColor] = useState(initial);
  return (
    <TerritoryColorPicker
      value={color}
      onChange={(c) => { setColor(c); onPick?.(c); }}
    />
  );
}

describe("<TerritoryColorPicker />", () => {
  it("stays a single swatch until asked — the bar is already full", async () => {
    render(<Harness />);
    expect(screen.queryByTestId("territory-color-grid")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("territory-color-trigger"));
    expect(screen.getByTestId("territory-color-grid")).toBeInTheDocument();
  });

  it("reports the colour that was picked", async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await userEvent.click(screen.getByTestId("territory-color-trigger"));
    await userEvent.click(screen.getByTestId(`territory-color-${GREEN.replace("#", "").toLowerCase()}`));
    expect(onPick).toHaveBeenCalledWith(GREEN);
  });

  it("shows the chosen colour on the trigger afterwards", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId("territory-color-trigger"));
    await userEvent.click(screen.getByTestId(`territory-color-${GREEN.replace("#", "").toLowerCase()}`));
    expect(screen.getByTestId("territory-color-trigger")).toHaveStyle({ backgroundColor: GREEN });
  });

  it("closes once a colour is chosen, so the next stroke lands on the map", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId("territory-color-trigger"));
    await userEvent.click(screen.getByTestId(`territory-color-${GREEN.replace("#", "").toLowerCase()}`));
    expect(screen.queryByTestId("territory-color-grid")).not.toBeInTheDocument();
  });

  it("marks the current colour so you can see what you already have", async () => {
    render(<Harness initial={GREEN} />);
    await userEvent.click(screen.getByTestId("territory-color-trigger"));
    const chosen = screen.getByTestId(`territory-color-${GREEN.replace("#", "").toLowerCase()}`);
    expect(chosen).toHaveAttribute("aria-selected", "true");
    const other = screen.getByTestId(`territory-color-${BLUE.replace("#", "").toLowerCase()}`);
    expect(other).toHaveAttribute("aria-selected", "false");
  });

  it("closes on Escape without changing anything", async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await userEvent.click(screen.getByTestId("territory-color-trigger"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("territory-color-grid")).not.toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("offers every swatch, and only real colours", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId("territory-color-trigger"));
    expect(screen.getAllByRole("option")).toHaveLength(TERRITORY_SWATCHES.length);
    for (const c of TERRITORY_SWATCHES) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("uses only the bright band — dark hues read as grey at fill opacity", () => {
    // The palette's deep second half exists for pin halos, where the colour is a
    // solid ring. An area fill is translucent, so those hues would all collapse
    // toward the same murky grey and stop distinguishing anything.
    expect(TERRITORY_SWATCHES).toHaveLength(12);
  });

  it("falls back to a real swatch rather than painting nothing", () => {
    // A malformed stored colour must not leave the trigger transparent — the
    // control would look broken and there would be nothing to click.
    render(<TerritoryColorPicker value="not-a-colour" onChange={vi.fn()} />);
    expect(screen.getByTestId("territory-color-trigger")).toHaveStyle({ backgroundColor: TERRITORY_SWATCHES[0] });
  });

  it("cannot be opened while the save is in flight", async () => {
    render(<TerritoryColorPicker value={BLUE} onChange={vi.fn()} disabled />);
    const trigger = screen.getByTestId("territory-color-trigger");
    expect(trigger).toBeDisabled();
    await userEvent.click(trigger);
    expect(screen.queryByTestId("territory-color-grid")).not.toBeInTheDocument();
  });

  it("is a labelled listbox", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId("territory-color-trigger"));
    expect(screen.getByRole("listbox", { name: "Area colour" })).toBeInTheDocument();
  });

  // ── Territory-UI audit: which way the grid opens ──────────────────────────
  // The default upward popover suits the lasso bottom bar. The territory detail
  // panel sits at the TOP of the viewport inside an overflow-y-auto container,
  // where an upward grid lands in clipped negative overflow — on screen it was
  // simply invisible. That surface must be able to ask for downward.
  it("opens upward by default — the lasso bar's geometry", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId("territory-color-trigger"));
    expect(screen.getByTestId("territory-color-grid").className).toContain("bottom-[calc(100%+8px)]");
  });

  it("opens downward when the surface sits at the top of a scroll container", async () => {
    render(<TerritoryColorPicker value={BLUE} onChange={vi.fn()} direction="down" />);
    await userEvent.click(screen.getByTestId("territory-color-trigger"));
    const grid = screen.getByTestId("territory-color-grid");
    expect(grid.className).toContain("top-[calc(100%+8px)]");
    expect(grid.className).not.toContain("bottom-[calc(100%+8px)]");
  });
});
