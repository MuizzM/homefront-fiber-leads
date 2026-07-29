import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

// ── The assignee sees the numbers too ───────────────────────────────────────
// The panel was rendered behind `canAssign && …`, so a rep could never open it.
// The person actually walking the area had no way to see how much of it was
// done — and management controls were already role-gated INSIDE the panel, so
// hiding the whole thing bought no safety, only blindness.
describe("<TerritoryDetailPanel /> for the rep who works the area", () => {
  const stats = {
    total: 84, verifiedWorkedLeads: 20, areaWorkedPct: 25,
    verified: 20, needsReview: 0, invalid: 0, avgDistanceM: 12, maxAllowedDistanceM: 60,
    knocked: 24, sold: 8, untouched: 56, availableBase: 80, attempts: 31,
    penetrationRate: 10, knockCompletionRate: 30, contactRate: 45.8,
  };

  it("shows a rep the same numbers a manager sees", () => {
    render(<TerritoryDetailPanel territory={activeTerritory} currentUser={{ role: "rep" }} progress={stats} />);
    expect(screen.getByTestId("stat-knock-summary")).toHaveTextContent("24 of 80 knocked");
    expect(screen.getByTestId("stat-sold")).toHaveTextContent("8");
    expect(screen.getByTestId("stat-penetration")).toHaveTextContent("10.0%");
  });

  it("shows the rep who else is on the area", () => {
    render(<TerritoryDetailPanel territory={activeTerritory} currentUser={{ role: "rep" }} progress={stats} />);
    expect(screen.getAllByTestId("rep-chip")).toHaveLength(2);
  });

  it("gives the rep no management controls at all", () => {
    // Reading the numbers is not permission to change anything. The server
    // re-checks every one of these regardless; this keeps buttons that would
    // 403 off a field phone.
    render(
      <TerritoryDetailPanel
        territory={activeTerritory}
        currentUser={{ role: "rep" }}
        progress={stats}
        onReclaim={() => {}}
      />,
    );
    expect(screen.queryByTestId("reclaim-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("territory-rename-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("territory-color-edit")).not.toBeInTheDocument();
  });
});

// ── A control you cannot use must not be on screen ──────────────────────────
// Reported from production, on a real pool area: "claim and reclaim are not
// working, it's just refresh."
//
// Reclaim was gated on the viewer's ROLE alone, while MapView only supplies
// onReclaim for an area somebody actually holds. On an unassigned area the
// button therefore rendered — full colour, no disabled state, correct label —
// wired to onClick={undefined}. Tapping it did nothing whatsoever, which from
// the outside is indistinguishable from a request that silently failed. Hence
// "not working": the control was never connected to anything.
//
// onReassign and onComplete each guarded themselves. Reclaim was the one that
// did not, which is why it was the one that got reported.
describe("actions render only when there is something to do", () => {
  const poolArea = {
    id: 99,
    name: "Unassigned area",
    status: "unassigned" as const,
    repIds: [],
    leadCount: 1150,
  };

  it("hides Reclaim on a pool area, where the handler is not supplied", () => {
    render(
      <TerritoryDetailPanel
        territory={poolArea}
        currentUser={{ role: "manager" }}
        // MapView passes `!isPool && canReclaim ? fn : undefined` — this IS the
        // production shape for an area in the pool.
      />,
    );
    expect(screen.queryByTestId("reclaim-btn")).toBeNull();
  });

  it("shows Reclaim when an area is actually held", () => {
    // The fix must not remove the feature — this is the case that matters.
    render(
      <TerritoryDetailPanel
        territory={{ ...poolArea, status: "active", repIds: [7] }}
        currentUser={{ role: "manager" }}
        onReclaim={() => {}}
      />,
    );
    expect(screen.getByTestId("reclaim-btn")).toBeInTheDocument();
  });

  it("never renders a reclaim-row button without a handler behind it", () => {
    // The general form of the bug, across all three buttons in that row.
    render(
      <TerritoryDetailPanel
        territory={{ ...poolArea, status: "active", repIds: [7] }}
        currentUser={{ role: "manager" }}
        onReclaim={() => {}}
      />,
    );
    expect(screen.getByTestId("reclaim-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("reassign-btn")).toBeNull();  // not supplied
    expect(screen.queryByTestId("complete-btn")).toBeNull();  // not supplied
  });

  it("drops the whole action row when no action is available", () => {
    // A permitted role with nothing to do should get no empty strip of chrome.
    const { container } = render(
      <TerritoryDetailPanel territory={poolArea} currentUser={{ role: "manager" }} />,
    );
    for (const id of ["reclaim-btn", "reassign-btn", "complete-btn"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(container.querySelector(".mt-4.flex.flex-wrap")).toBeNull();
  });

  it("still hides the row from a role that may not reclaim, even with handlers", () => {
    // Permission is still the first gate — the handler check is an ADDITIONAL
    // condition, not a replacement for the role check.
    render(
      <TerritoryDetailPanel
        territory={{ ...poolArea, status: "active", repIds: [7] }}
        currentUser={{ role: "rep" }}
        onReclaim={() => {}}
        onComplete={() => {}}
      />,
    );
    expect(screen.queryByTestId("reclaim-btn")).toBeNull();
    expect(screen.queryByTestId("complete-btn")).toBeNull();
  });

  it("calls the handler when Reclaim is actually pressed", () => {
    const onReclaim = vi.fn();
    render(
      <TerritoryDetailPanel
        territory={{ ...poolArea, status: "active", repIds: [7] }}
        currentUser={{ role: "manager" }}
        onReclaim={onReclaim}
      />,
    );
    fireEvent.click(screen.getByTestId("reclaim-btn"));
    expect(onReclaim).toHaveBeenCalledTimes(1);
  });
});

describe("no panel control can submit a form", () => {
  // "It's just refresh" is also what an implicit submit looks like. A bare
  // <button> defaults to type="submit"; there is no <form> around this panel
  // today, so nothing submitted — but that is a property of the surrounding
  // markup, not of these controls, and it costs one attribute to stop relying
  // on it.
  it("declares type=button on every button it renders", () => {
    const { container } = render(
      <TerritoryDetailPanel
        territory={{ id: 1, name: "Held", status: "active" as const, repIds: [7], leadCount: 10 }}
        currentUser={{ role: "manager" }}
        teamNames={{ 7: "Rae Rivera" }}
        onReclaim={() => {}}
        onReassign={() => {}}
        onComplete={() => {}}
        onViewHistory={() => {}}
        onStartNextPass={() => {}}
        onEditAssignees={() => {}}
        onRename={() => {}}
        onUnassignRep={() => {}}
      />,
    );
    const untyped = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.getAttribute("type") !== "button",
    );
    expect(
      untyped.map((b) => b.getAttribute("data-testid") ?? b.textContent?.trim()),
      "these default to type=submit",
    ).toEqual([]);
  });
});
