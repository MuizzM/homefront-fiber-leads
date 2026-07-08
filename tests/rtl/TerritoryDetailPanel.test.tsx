import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerritoryDetailPanel } from "@/components/TerritoryDetailPanel";

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
});
