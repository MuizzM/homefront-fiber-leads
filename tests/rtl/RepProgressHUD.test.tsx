import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RepProgressHUD } from "@/components/RepProgressHUD";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACT — RepProgressHUD (client/src/components/RepProgressHUD.tsx)
 *
 * Four stats, derived client-side from the pins array (no endpoint):
 *   knocked  = pins with lastKnockedAt >= the rep's LOCAL midnight
 *   left     = pins where !visited            (the hero number, bold white)
 *   follow-ups = leadStatus === "follow_up"   (amber — the pin-color language)
 *   sold     = leadStatus === "sold"          (emerald)
 * "assigned" was removed — it never changed a rep's next step.
 * Mini pill shows "{left} left" while panning, or "Done ✓" when left === 0;
 * tapping either pill fires onToggle.
 * ────────────────────────────────────────────────────────────────────────────
 */

const todayNoon = () => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
};
const yesterday = () => new Date(Date.now() - 26 * 3600_000).toISOString();

// 6 pins: 2 knocked today, 1 knocked yesterday (visited), 3 untouched;
// 1 sold, 1 follow_up. left = 3.
const PINS = [
  { leadStatus: "interested", visited: true, lastKnockedAt: todayNoon() },
  { leadStatus: "sold", visited: true, lastKnockedAt: todayNoon() },
  { leadStatus: "follow_up", visited: true, lastKnockedAt: yesterday() },
  { leadStatus: "prospect", visited: false, lastKnockedAt: null },
  { leadStatus: "prospect", visited: false, lastKnockedAt: null },
  { leadStatus: "prospect", visited: false, lastKnockedAt: null },
];

describe("<RepProgressHUD />", () => {
  it("shows exactly the four rep stats with correct values — no 'assigned'", () => {
    render(<RepProgressHUD pins={PINS} mini={false} onToggle={vi.fn()} />);

    expect(screen.getByTestId("progress-stat-knocked")).toHaveTextContent("2");
    expect(screen.getByTestId("progress-stat-left")).toHaveTextContent("3");
    expect(screen.getByTestId("progress-stat-followups")).toHaveTextContent("1");
    expect(screen.getByTestId("progress-stat-sold")).toHaveTextContent("1");
    expect(screen.queryByTestId("progress-stat-assigned")).not.toBeInTheDocument();
  });

  it("counts 'knocked' against local midnight — yesterday's knock is excluded", () => {
    render(<RepProgressHUD pins={[PINS[2]]} mini={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId("progress-stat-knocked")).toHaveTextContent("0");
  });

  it("mini pill reads '{left} left' and fires onToggle on tap", async () => {
    const onToggle = vi.fn();
    render(<RepProgressHUD pins={PINS} mini onToggle={onToggle} />);

    const mini = screen.getByTestId("progress-hud-mini");
    expect(mini).toHaveTextContent("3");
    expect(mini).toHaveTextContent("left");
    await userEvent.click(mini);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("mini pill celebrates an empty street: 'Done ✓' when nothing is left", () => {
    const allWorked = PINS.map(p => ({ ...p, visited: true }));
    render(<RepProgressHUD pins={allWorked} mini onToggle={vi.fn()} />);
    expect(screen.getByTestId("progress-hud-mini")).toHaveTextContent("Done ✓");
  });

  it("full pill also fires onToggle (tap to collapse)", async () => {
    const onToggle = vi.fn();
    render(<RepProgressHUD pins={PINS} mini={false} onToggle={onToggle} />);
    await userEvent.click(screen.getByTestId("progress-hud"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
