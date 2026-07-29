import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerritoryDetailPanel } from "@/components/TerritoryDetailPanel";
import { colorForRep } from "@shared/repColors";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACT (UI agent, client/src/components/TerritoryDetailPanel.tsx).
 * Props:
 *   territory: { id, name, status, repIds: number[], color, leadCount }
 *   currentUser: { role }
 *   onReclaim(): void
 * Requirements exercised here (role-aware visibility is high-risk):
 *   - renders the name and a status badge   [data-testid="territory-status"]
 *   - one rep chip per repId                 [data-testid="rep-chip"]
 *   - lead count                             [data-testid="lead-count"]
 *   - Reclaim button gated by can(role,"reclaim_territory")
 *                                            [data-testid="reclaim-btn"]
 *   - an unassigned territory renders a gray swatch
 *                                            [data-testid="territory-color"] w/ color #94a3b8
 * ────────────────────────────────────────────────────────────────────────────
 */

const activeTerritory = {
  id: 42,
  name: "Rockwell North",
  status: "active" as const,
  repIds: [7, 9],
  color: "#F97316",
  leadCount: 128,
};

const unassignedTerritory = {
  id: 43,
  name: "China Grove East",
  status: "unassigned" as const,
  repIds: [],
  color: "#94a3b8",
  leadCount: 40,
};

describe("<TerritoryDetailPanel />", () => {
  it("renders name, status, multi-rep chips and lead count", () => {
    render(
      <TerritoryDetailPanel
        territory={activeTerritory}
        currentUser={{ role: "manager" }}
        onReclaim={() => {}}
      />
    );

    expect(screen.getByText("Rockwell North")).toBeInTheDocument();
    expect(screen.getByTestId("territory-status")).toHaveTextContent(/active/i);
    expect(screen.getAllByTestId("rep-chip")).toHaveLength(2); // multi-rep
    expect(screen.getByTestId("lead-count")).toHaveTextContent("128");
  });

  it("shows the Reclaim button for a manager and fires onReclaim", async () => {
    const onReclaim = vi.fn();
    render(
      <TerritoryDetailPanel
        territory={activeTerritory}
        currentUser={{ role: "manager" }}
        onReclaim={onReclaim}
      />
    );

    const btn = screen.getByTestId("reclaim-btn");
    await userEvent.click(btn);
    expect(onReclaim).toHaveBeenCalledOnce();
  });

  it("HIDES the Reclaim button from a rep (role-aware visibility)", () => {
    render(
      <TerritoryDetailPanel
        territory={activeTerritory}
        currentUser={{ role: "rep" }}
        onReclaim={() => {}}
      />
    );
    expect(screen.queryByTestId("reclaim-btn")).not.toBeInTheDocument();
  });

  it("shows the rename pencil ONLY when onRename is provided, and saves a trimmed new name", async () => {
    const onRename = vi.fn();
    const { rerender } = render(
      <TerritoryDetailPanel
        territory={activeTerritory}
        currentUser={{ role: "manager" }}
        onRename={onRename}
      />
    );

    await userEvent.click(screen.getByTestId("territory-rename-btn"));
    const input = screen.getByTestId("territory-name-input");
    expect(input).toHaveValue("Rockwell North"); // starts from the current name
    await userEvent.clear(input);
    await userEvent.type(input, "  Maple Ridge Loop  ");
    await userEvent.click(screen.getByTestId("territory-name-save"));
    expect(onRename).toHaveBeenCalledExactlyOnceWith("Maple Ridge Loop");
    // Edit mode exits back to the heading
    expect(screen.queryByTestId("territory-name-input")).not.toBeInTheDocument();

    // Without onRename (e.g. a viewer without the capability) there is no pencil
    rerender(
      <TerritoryDetailPanel territory={activeTerritory} currentUser={{ role: "rep" }} />
    );
    expect(screen.queryByTestId("territory-rename-btn")).not.toBeInTheDocument();
  });

  it("does NOT fire onRename for an unchanged or blank name, and Escape cancels", async () => {
    const onRename = vi.fn();
    render(
      <TerritoryDetailPanel
        territory={activeTerritory}
        currentUser={{ role: "manager" }}
        onRename={onRename}
      />
    );

    // Unchanged name → save is a no-op
    await userEvent.click(screen.getByTestId("territory-rename-btn"));
    await userEvent.click(screen.getByTestId("territory-name-save"));
    expect(onRename).not.toHaveBeenCalled();

    // Blank name → no-op
    await userEvent.click(screen.getByTestId("territory-rename-btn"));
    await userEvent.clear(screen.getByTestId("territory-name-input"));
    await userEvent.click(screen.getByTestId("territory-name-save"));
    expect(onRename).not.toHaveBeenCalled();

    // Escape closes the editor without saving
    await userEvent.click(screen.getByTestId("territory-rename-btn"));
    await userEvent.type(screen.getByTestId("territory-name-input"), " Extra");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("territory-name-input")).not.toBeInTheDocument();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("renders an unassigned territory with the gray swatch", () => {
    render(
      <TerritoryDetailPanel
        territory={unassignedTerritory}
        currentUser={{ role: "manager" }}
        onReclaim={() => {}}
      />
    );
    expect(screen.getByTestId("territory-status")).toHaveTextContent(/unassigned/i);
    expect(screen.queryAllByTestId("rep-chip")).toHaveLength(0);
    const swatch = screen.getByTestId("territory-color");
    // Gray = the unassigned color from shared/repColors.ts colorForRep(null).
    expect(swatch).toHaveStyle({ backgroundColor: "#94a3b8" });
  });

  it("paints the swatch the AREA's colour, matching the polygon on the map", () => {
    // This assertion was the other way round one revision ago, and its stated
    // reason — "the map paints the region from colorForRep too" — stopped being
    // true in the same change that introduced it: the map now prefers
    // territories.color, the colour the admin picked while drawing.
    //
    // So the rule is: the header swatch describes the GROUND and follows the
    // area's own colour, exactly like the polygon beside it. The rep chips below
    // keep following colorForRep, because those dots identify a PERSON and a
    // person's hue is not a property of the ground. The fixture keeps the two
    // deliberately different so this cannot pass by coincidence.
    expect(activeTerritory.color).not.toBe(colorForRep(activeTerritory.repIds[0]));
    render(
      <TerritoryDetailPanel
        territory={activeTerritory}
        currentUser={{ role: "manager" }}
        onReclaim={() => {}}
      />
    );
    const swatch = screen.getByTestId("territory-color");
    expect(swatch).toHaveStyle({ backgroundColor: activeTerritory.color });
    expect(swatch).not.toHaveStyle({ backgroundColor: colorForRep(7) });
  });
});

// ── The operational numbers ─────────────────────────────────────────────────
// The progress endpoint has returned knocked and sold all along; the panel's own
// prop type dropped them, so a manager saw a location-verification percentage
// and had no idea how much of the area had actually been walked.
describe("<TerritoryDetailPanel /> stats", () => {
  const stats = {
    total: 84, verifiedWorkedLeads: 20, areaWorkedPct: 25,
    verified: 20, needsReview: 0, invalid: 0, avgDistanceM: 12, maxAllowedDistanceM: 60,
    knocked: 24, sold: 8, untouched: 56, availableBase: 80, attempts: 31,
    penetrationRate: 10, knockCompletionRate: 30, contactRate: 45.8,
    lastActivityAt: "2026-07-28T14:00:00Z",
  };

  it("says how many of the workable doors are done, and how many are left", () => {
    render(<TerritoryDetailPanel territory={activeTerritory} currentUser={{ role: "manager" }} progress={stats} />);
    expect(screen.getByTestId("stat-knock-summary")).toHaveTextContent("24 of 80 knocked");
    expect(screen.getByTestId("territory-stats")).toHaveTextContent("56 remaining");
  });

  it("separates doors knocked from total attempts", () => {
    // 31 knocks across 24 doors. Conflating them would overstate coverage.
    render(<TerritoryDetailPanel territory={activeTerritory} currentUser={{ role: "manager" }} progress={stats} />);
    expect(screen.getByTestId("territory-stats")).toHaveTextContent("31 attempts");
  });

  it("hides the attempts line when nobody has gone back to a door", () => {
    // attempts === knocked is the ordinary case; showing it would be noise.
    render(<TerritoryDetailPanel territory={activeTerritory} currentUser={{ role: "manager" }}
      progress={{ ...stats, attempts: 24 }} />);
    expect(screen.getByTestId("territory-stats")).not.toHaveTextContent("attempts");
  });

  it("shows sold, penetration and contact rate", () => {
    render(<TerritoryDetailPanel territory={activeTerritory} currentUser={{ role: "manager" }} progress={stats} />);
    expect(screen.getByTestId("stat-sold")).toHaveTextContent("8");
    expect(screen.getByTestId("stat-penetration")).toHaveTextContent("10.0%");
    expect(screen.getByTestId("stat-contact")).toHaveTextContent("45.8%");
  });

  it("exposes knock completion as an accessible progress bar, not colour alone", () => {
    render(<TerritoryDetailPanel territory={activeTerritory} currentUser={{ role: "manager" }} progress={stats} />);
    const bar = screen.getByTestId("stat-knock-bar");
    expect(bar).toHaveAttribute("aria-valuenow", "30");
    expect(bar).toHaveAccessibleName(/30.0 percent/i);
  });

  it("stays silent rather than showing zeros when the figures are absent", () => {
    // An older cached response predates these fields. "0 of 0 knocked" would be
    // a claim about the area; showing nothing is the honest state.
    const { total, verifiedWorkedLeads, areaWorkedPct, verified, needsReview, invalid, avgDistanceM, maxAllowedDistanceM } = stats;
    render(<TerritoryDetailPanel territory={activeTerritory} currentUser={{ role: "manager" }}
      progress={{ total, verifiedWorkedLeads, areaWorkedPct, verified, needsReview, invalid, avgDistanceM, maxAllowedDistanceM }} />);
    expect(screen.queryByTestId("territory-stats")).not.toBeInTheDocument();
  });
});

// ── Editing the area's colour ───────────────────────────────────────────────
describe("<TerritoryDetailPanel /> colour editing", () => {
  it("turns the swatch into a picker when the caller may edit", async () => {
    render(<TerritoryDetailPanel territory={activeTerritory} currentUser={{ role: "manager" }} onRecolor={vi.fn()} />);
    expect(screen.getByTestId("territory-color-edit")).toBeInTheDocument();
  });

  it("reports the chosen colour", async () => {
    const onRecolor = vi.fn();
    render(<TerritoryDetailPanel territory={activeTerritory} currentUser={{ role: "manager" }} onRecolor={onRecolor} />);
    await userEvent.click(screen.getByTestId("territory-color-trigger"));
    await userEvent.click(screen.getByTestId("territory-color-16a34a"));
    expect(onRecolor).toHaveBeenCalledWith("#16A34A");
  });

  it("stays a read-only dot for someone who cannot edit", () => {
    // Server authorization is the real gate; this keeps a control that would
    // 403 off the screen entirely.
    render(<TerritoryDetailPanel territory={activeTerritory} currentUser={{ role: "rep" }} />);
    expect(screen.queryByTestId("territory-color-edit")).not.toBeInTheDocument();
    expect(screen.getByTestId("territory-color")).toBeInTheDocument();
  });

  it("shows the area's OWN colour, matching the polygon on the map", () => {
    // The map paints from territories.color. A swatch computed from the rep's
    // palette would disagree with the region right next to it.
    render(<TerritoryDetailPanel territory={{ ...activeTerritory, color: "#14C985" }} currentUser={{ role: "manager" }} />);
    expect(screen.getByTestId("territory-color")).toHaveStyle({ backgroundColor: "#14C985" });
  });
});
