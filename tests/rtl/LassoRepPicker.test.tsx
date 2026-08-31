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
    // Only server-authoritative numbers in the projection: the gain (and any
    // doors already theirs), never a total built on viewport-sampled holdings.
    expect(screen.getByTestId("lasso-assign-preview")).toHaveTextContent("Jordan gains 18 doors. You can undo for 10 minutes after.");
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

describe("avatarColors", () => {
  it("clears 4.5:1 for every colour a team can pick, keeping the colour when dark ink already reads", async () => {
    const { avatarColors } = await import("../../client/src/components/map/LassoRepPicker");
    const lum = (c: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const hex = (h: string) => [0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16));
    const swatches = ["#2563EB", "#db2777", "#8b5cf6", "#38bdf8", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#22d3ee", "#a3e635", "#e879f9", "#14b8a6", "#f97316", "#22c55e", "#ef4444", "#eab308", "#64748b", "#10b981", "#6366f1", "#d946ef", "#ffffff", "#000000"];
    for (const s of swatches) {
      const { background, color } = avatarColors(s);
      expect(ratio(hex(background), hex(color)), `${s} -> ${background}/${color}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(avatarColors("#fbbf24")).toEqual({ background: "#fbbf24", color: "#07111B" }); // amber keeps its colour
    expect(avatarColors("#8b5cf6").color).toBe("#FFFFFF");                               // violet settles toward ink
    expect(avatarColors("not a colour")).toEqual({ background: "not a colour", color: "#FFFFFF" });
  });
});
