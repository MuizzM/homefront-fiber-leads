// Choosing who gets an area.
//
// This replaced a plain <select>, which worked for six reps and collapsed at
// forty. The tests concentrate on the two things that make it worth the swap:
// you can find a rep by typing, and you can see who is already loaded up before
// you hand them another area.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RepPicker } from "../../client/src/components/territory/RepPicker";

const many = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1, name: `Rep ${String.fromCharCode(65 + i)}ndrews`, areaCount: 0,
}));

describe("RepPicker", () => {
  it("lists reps and returns the one picked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RepPicker reps={[{ id: 7, name: "Ann Rivera" }, { id: 9, name: "Bo Chen" }]} onChange={onChange} />);
    await user.click(screen.getByTestId("rep-option-9"));
    expect(onChange).toHaveBeenCalledWith(9);
  });

  it("finds a rep by first OR last name", async () => {
    const user = userEvent.setup();
    render(<RepPicker reps={many.concat({ id: 99, name: "Ann Rivera", areaCount: 0 })} onChange={vi.fn()} />);
    const box = screen.getByLabelText("Search reps");

    await user.type(box, "riv");           // surname
    expect(screen.getByTestId("rep-option-99")).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "ann");           // first name
    expect(screen.getByTestId("rep-option-99")).toBeInTheDocument();
  });

  it("hides the search box for a small team — it would just be noise", () => {
    render(<RepPicker reps={[{ id: 1, name: "Ann" }, { id: 2, name: "Bo" }]} onChange={vi.fn()} />);
    expect(screen.queryByLabelText("Search reps")).not.toBeInTheDocument();
  });

  it("shows it once the list is long enough to need it", () => {
    render(<RepPicker reps={many} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Search reps")).toBeInTheDocument();
  });

  it("says so when nothing matches, instead of showing an empty box", async () => {
    const user = userEvent.setup();
    render(<RepPicker reps={many} onChange={vi.fn()} />);
    await user.type(screen.getByLabelText("Search reps"), "zzzz");
    expect(screen.getByRole("status")).toHaveTextContent(/no rep matches/i);
  });

  // ── The load hint: the reason this control exists ──────────────────────────
  it("shows how many areas each rep already holds", () => {
    render(<RepPicker reps={[{ id: 1, name: "Ann Rivera", areaCount: 3 }]} onChange={vi.fn()} />);
    expect(screen.getByTestId("rep-option-1")).toHaveTextContent("3 areas");
  });

  it("uses the singular for one area", () => {
    render(<RepPicker reps={[{ id: 1, name: "Ann", areaCount: 1 }]} onChange={vi.fn()} />);
    expect(screen.getByTestId("rep-option-1")).toHaveTextContent("1 area");
  });

  it("shows a capped rep but refuses to select them", async () => {
    // Visible-but-disabled, not hidden: a manager searching for someone who's
    // full needs to learn WHY they can't have the area, not that they vanished.
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RepPicker reps={[{ id: 1, name: "Ann Rivera", areaCount: 5, atCap: true }]} onChange={onChange} />);
    const row = screen.getByTestId("rep-option-1");
    expect(row).toHaveTextContent(/at area limit/i);
    expect(row).toBeDisabled();
    await user.click(row);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("sorts reps with room ahead of reps at the cap", () => {
    render(<RepPicker onChange={vi.fn()} reps={[
      { id: 1, name: "Aaa Full", atCap: true },
      { id: 2, name: "Zzz Free", atCap: false },
    ]} />);
    const rows = screen.getAllByRole("option");
    expect(rows[0]).toHaveTextContent("Zzz Free"); // pickable first, despite Z
  });

  it("marks the current selection", () => {
    render(<RepPicker reps={[{ id: 4, name: "Ann" }]} value={4} onChange={vi.fn()} />);
    expect(screen.getByTestId("rep-option-4")).toHaveAttribute("aria-selected", "true");
  });

  it("never silently truncates the list", async () => {
    // A manager who can't find someone must know the list is cut, not conclude
    // the rep doesn't exist.
    const user = userEvent.setup();
    render(<RepPicker reps={many} onChange={vi.fn()} maxRows={5} />);
    expect(screen.getByText(/15 more reps/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search reps"), "Andrews");
    expect(screen.queryByText(/more reps/i)).not.toBeInTheDocument();
  });

  it("clears the search box", async () => {
    const user = userEvent.setup();
    render(<RepPicker reps={many} onChange={vi.fn()} />);
    const box = screen.getByLabelText("Search reps") as HTMLInputElement;
    await user.type(box, "zzz");
    await user.click(screen.getByLabelText("Clear search"));
    expect(box.value).toBe("");
  });

  it("is a labelled listbox", () => {
    render(<RepPicker reps={[{ id: 1, name: "Ann" }]} label="Assign this area to…" onChange={vi.fn()} />);
    expect(screen.getByRole("listbox", { name: "Assign this area to…" })).toBeInTheDocument();
  });
});

// ── Multi-select: several reps can work one area ─────────────────────────────
describe("RepPicker in multiple mode", () => {
  it("toggles a rep on, reporting the FULL holder set", async () => {
    // /share takes the complete set, not a delta — so the callback hands back
    // everyone who should be on the area after the change.
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<RepPicker multiple selected={[7]} onToggle={onToggle} onChange={vi.fn()}
      reps={[{ id: 7, name: "Ann Rivera" }, { id: 9, name: "Bo Chen" }]} />);
    await user.click(screen.getByTestId("rep-option-9"));
    expect(onToggle).toHaveBeenCalledWith(9, [7, 9]);
  });

  it("toggles a rep off", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<RepPicker multiple selected={[7, 9]} onToggle={onToggle} onChange={vi.fn()}
      reps={[{ id: 7, name: "Ann Rivera" }, { id: 9, name: "Bo Chen" }]} />);
    await user.click(screen.getByTestId("rep-option-7"));
    expect(onToggle).toHaveBeenCalledWith(7, [9]);
  });

  it("marks every selected rep, not just one", () => {
    render(<RepPicker multiple selected={[7, 9]} onToggle={vi.fn()} onChange={vi.fn()}
      reps={[{ id: 7, name: "Ann" }, { id: 9, name: "Bo" }, { id: 11, name: "Cam" }]} />);
    expect(screen.getByTestId("rep-option-7")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("rep-option-9")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("rep-option-11")).toHaveAttribute("aria-selected", "false");
  });

  it("lets a rep at the cap be REMOVED even though they can't be added", async () => {
    // Otherwise a full rep could never be taken off anything — the cap would
    // trap them on every area they already hold.
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<RepPicker multiple selected={[7]} onToggle={onToggle} onChange={vi.fn()}
      reps={[{ id: 7, name: "Ann", areaCount: 5, atCap: true }]} />);
    const row = screen.getByTestId("rep-option-7");
    expect(row).toBeEnabled();
    await user.click(row);
    expect(onToggle).toHaveBeenCalledWith(7, []);
  });

  it("still blocks adding a capped rep who is NOT on the area", () => {
    render(<RepPicker multiple selected={[]} onToggle={vi.fn()} onChange={vi.fn()}
      reps={[{ id: 7, name: "Ann", areaCount: 5, atCap: true }]} />);
    expect(screen.getByTestId("rep-option-7")).toBeDisabled();
  });

  it("does not call the single-select handler in multiple mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RepPicker multiple selected={[]} onToggle={vi.fn()} onChange={onChange}
      reps={[{ id: 7, name: "Ann" }]} />);
    await user.click(screen.getByTestId("rep-option-7"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
