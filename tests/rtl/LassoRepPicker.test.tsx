// The lasso's rep picker: readable rows instead of a native select, each
// rep's load beside their name, one radio mark, and a preview of what the
// chosen rep will hold after the assignment.
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LassoRepPicker, initialsOf } from "../../client/src/components/map/LassoRepPicker";

const reps = [
  { id: 1, name: "Jordan Price", doors: 1034, knockedToday: 38 },
  { id: 2, name: "Maya Reyes", doors: 612, knockedToday: 21 },
  { id: 3, name: "Devon Kim", doors: 0, knockedToday: null },
];

describe("<LassoRepPicker />", () => {
  it("lists every rep with initials and load; the chosen one is checked and previewed", () => {
    render(<LassoRepPicker reps={reps} value="1" onChange={vi.fn()} selectionCount={18} />);
    expect(screen.getByTestId("lasso-rep-1")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("lasso-rep-2")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("lasso-rep-1")).toHaveTextContent("1,034 doors · 38 knocked today");
    expect(screen.getByTestId("lasso-rep-3")).toHaveTextContent("0 doors");
    expect(screen.getByTestId("lasso-rep-3")).not.toHaveTextContent("knocked today");
    expect(screen.getByTestId("lasso-assign-preview")).toHaveTextContent("Jordan will have 1,052 doors after this");
  });

  it("a tap chooses a rep; no preview until one is chosen", () => {
    const onChange = vi.fn();
    render(<LassoRepPicker reps={reps} value="" onChange={onChange} selectionCount={18} />);
    expect(screen.queryByTestId("lasso-assign-preview")).toBeNull();
    fireEvent.click(screen.getByTestId("lasso-rep-2"));
    expect(onChange).toHaveBeenCalledWith("2");
  });

  it("says so when the team has no active reps", () => {
    render(<LassoRepPicker reps={[]} value="" onChange={vi.fn()} selectionCount={3} />);
    expect(screen.getByTestId("lasso-rep-picker")).toHaveTextContent("No active reps on your team yet.");
  });

  it("initials come from the first letters of each name part", () => {
    expect(initialsOf("Jordan Price")).toBe("JP");
    expect(initialsOf("Cher")).toBe("C");
    expect(initialsOf("  ")).toBe("?");
  });
});
