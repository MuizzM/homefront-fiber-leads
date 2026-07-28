import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerritoryDetailPanel } from "@/components/TerritoryDetailPanel";

// Removing a rep pulls their doors back, so the control must be deliberate:
// permission-gated, two-step, and never firing from a single mis-tap next to a
// chip label on a phone.
const territory = {
  id: 1, name: "Shared patch", status: "shared" as const,
  repIds: [7, 8], color: "#3EA394", leadCount: 12, workedCount: 3,
};
const names = { 7: "Ann Rivera", 8: "Bo Chen" };

const panel = (over: Partial<Parameters<typeof TerritoryDetailPanel>[0]> = {}) =>
  render(
    <TerritoryDetailPanel
      territory={territory}
      currentUser={{ role: "manager" }}
      teamNames={names}
      onUnassignRep={vi.fn()}
      {...over}
    />,
  );

describe("TerritoryDetailPanel — remove a rep from an area", () => {
  it("offers a labelled remove control per assigned rep", () => {
    panel();
    expect(screen.getByRole("button", { name: "Remove Ann Rivera from this area" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Bo Chen from this area" })).toBeInTheDocument();
  });

  it("does NOT fire on the first tap — it asks first", async () => {
    const onUnassignRep = vi.fn();
    panel({ onUnassignRep });
    await userEvent.click(screen.getByRole("button", { name: "Remove Ann Rivera from this area" }));
    expect(onUnassignRep).not.toHaveBeenCalled();
    expect(screen.getByText("Remove Ann Rivera?")).toBeInTheDocument();
  });

  it("removes only the confirmed rep", async () => {
    const onUnassignRep = vi.fn();
    panel({ onUnassignRep });
    await userEvent.click(screen.getByRole("button", { name: "Remove Ann Rivera from this area" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm removing Ann Rivera from this area" }));
    expect(onUnassignRep).toHaveBeenCalledTimes(1);
    expect(onUnassignRep).toHaveBeenCalledWith(7);
  });

  it("cancelling keeps the rep assigned", async () => {
    const onUnassignRep = vi.fn();
    panel({ onUnassignRep });
    await userEvent.click(screen.getByRole("button", { name: "Remove Ann Rivera from this area" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep Ann Rivera assigned" }));
    expect(onUnassignRep).not.toHaveBeenCalled();
    expect(screen.queryByText("Remove Ann Rivera?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Ann Rivera from this area" })).toBeInTheDocument();
  });

  it("hides the control from a rep — the server also refuses, this is just honesty in the UI", () => {
    panel({ currentUser: { role: "rep" } });
    expect(screen.queryByRole("button", { name: /Remove .* from this area/ })).not.toBeInTheDocument();
  });

  // The route is requireTeamLead. If the UI gate drifts above that, a team lead
  // can call the API but has no way to reach it — which is what shipped first.
  it.each(["team_lead", "manager", "admin"])("shows the control to %s, matching the route's gate", (role) => {
    panel({ currentUser: { role } });
    expect(screen.getByRole("button", { name: "Remove Ann Rivera from this area" })).toBeInTheDocument();
  });

  it("hides the control when no handler is wired (read-only contexts)", () => {
    panel({ onUnassignRep: undefined });
    expect(screen.queryByRole("button", { name: /Remove .* from this area/ })).not.toBeInTheDocument();
  });

  it("disables only the rep being removed, not the whole list", () => {
    panel({ unassigningRepId: 7 });
    expect(screen.getByRole("button", { name: "Remove Ann Rivera from this area" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Bo Chen from this area" })).toBeEnabled();
  });

  it("still shows an unassigned area as in the pool", () => {
    panel({ territory: { ...territory, repIds: [], status: "unassigned" as const } });
    expect(screen.getByText(/Unassigned — in the pool/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove .* from this area/ })).not.toBeInTheDocument();
  });
});
