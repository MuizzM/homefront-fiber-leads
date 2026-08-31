import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DetailsBody } from "@/components/lead-sheet/DetailsBody";

function renderAssignment(assigning: boolean) {
  const onAssign = vi.fn();
  render(
    <DetailsBody
      hidden={false}
      docked={false}
      detail={undefined}
      canAssignLead
      assignedRepId={1}
      team={[
        { id: 1, name: "Rep One", active: true } as any,
        { id: 2, name: "Rep Two", active: true } as any,
      ]}
      onAssign={onAssign}
      assigning={assigning}
      canOpenCalling={false}
      leadId={7}
      canManage={false}
      centralMode={false}
      deleteArmed={false}
      onToggleCentral={vi.fn()}
      onDeleteTap={vi.fn()}
      history={[]}
      historyLoading={false}
    />,
  );
  return onAssign;
}

describe("lead-card assignment state", () => {
  it("disables repeat assignment while the server command is pending", () => {
    renderAssignment(true);
    const select = screen.getByTestId("card-assign-select");
    expect(select).toBeDisabled();
    expect(select).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent(/saving assignment/i);
  });

  it("sends the selected representative when idle", async () => {
    // The control is the searchable dialog picker now - open it, click a row.
    const onAssign = renderAssignment(false);
    await userEvent.click(screen.getByTestId("card-assign-select"));
    await userEvent.click(await screen.findByTestId("rep-option-2"));
    expect(onAssign).toHaveBeenCalledWith(2);
  });
});
