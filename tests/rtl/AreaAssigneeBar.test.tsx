// Editing who works an area, on the map, on the area.
//
// The set of holders was already editable — but only via tap area → detail card
// → scroll → "Who works this area" → full-screen modal. Four steps and a
// takeover of the map you were looking at, for the most common field decision
// there is.
//
// These specs pin the behaviour that makes the shortcut safe to use: that the
// control speaks in COMPLETE holder sets (what /share expects), that it cannot
// empty an area (Reclaim's job, because it decides where the doors go), and that
// removing a rep takes two taps, since their doors leave with them.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AreaAssigneeBar } from "../../client/src/components/territory/AreaAssigneeBar";

const REPS = [
  { id: 1, name: "Rae Rivera", areaCount: 1, atCap: false },
  { id: 2, name: "Sam Okafor", areaCount: 2, atCap: false },
  { id: 3, name: "Tal Nguyen", areaCount: 5, atCap: true },
  { id: 4, name: "Ivy Chen", areaCount: 0, atCap: false },
];

function setup(over: Partial<React.ComponentProps<typeof AreaAssigneeBar>> = {}) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(
    <AreaAssigneeBar
      areaName="Maple Ridge"
      color="#14C985"
      reps={REPS}
      assigneeIds={[1, 2]}
      onChange={onChange}
      onClose={onClose}
      {...over}
    />,
  );
  return { onChange, onClose };
}

describe("the area's colour, not a rep's", () => {
  it("shows the colour the area was drawn in", () => {
    // One area is one colour for everybody looking at it, however many reps are
    // on it. A holder's hue here would make the card disagree with the polygon.
    setup();
    expect(screen.getByTestId("area-color-dot")).toHaveStyle({ backgroundColor: "#14C985" });
  });

  it("keeps that colour when the holder set changes", () => {
    setup({ assigneeIds: [2, 1] }); // different primary
    expect(screen.getByTestId("area-color-dot")).toHaveStyle({ backgroundColor: "#14C985" });
  });
});

describe("who is on it", () => {
  it("shows every holder by name", () => {
    setup();
    expect(screen.getByTestId("area-assignee-1")).toHaveTextContent("Rae Rivera");
    expect(screen.getByTestId("area-assignee-2")).toHaveTextContent("Sam Okafor");
  });

  it("counts them in words a manager reads at a glance", () => {
    setup();
    expect(screen.getByText("2 reps on this area")).toBeInTheDocument();
  });

  it("says '1 rep', not '1 reps'", () => {
    setup({ assigneeIds: [1] });
    expect(screen.getByText("1 rep on this area")).toBeInTheDocument();
  });

  it("marks the primary, because the API treats the first as primary", () => {
    // Hidden ordering that changes behaviour is how you get "why did the colour
    // move" reports. It is shown.
    setup();
    expect(within(screen.getByTestId("area-assignee-1")).getByText("1st")).toBeInTheDocument();
    expect(within(screen.getByTestId("area-assignee-2")).queryByText("1st")).toBeNull();
  });

  it("does not label a primary when there is only one holder", () => {
    setup({ assigneeIds: [1] });
    expect(screen.queryByText("1st")).toBeNull();
  });
});

describe("adding a rep", () => {
  it("emits the COMPLETE holder set, not just the addition", () => {
    // /share replaces the holder set. Sending only the new rep would silently
    // drop everyone else off the area.
    const { onChange } = setup();
    fireEvent.click(screen.getByTestId("area-assignee-add"));
    fireEvent.click(screen.getByText("Ivy Chen"));
    expect(onChange).toHaveBeenCalledWith([1, 2, 4]);
  });

  it("appends rather than reordering, so the primary does not move", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByTestId("area-assignee-add"));
    fireEvent.click(screen.getByText("Ivy Chen"));
    expect(onChange.mock.calls[0][0][0]).toBe(1); // still first
  });

  it("does not offer reps already on the area", () => {
    setup();
    fireEvent.click(screen.getByTestId("area-assignee-add"));
    expect(screen.queryByText("Sam Okafor")).not.toBeNull(); // the holder chip
    // ...but not a second time as an addable option.
    expect(screen.getAllByText("Sam Okafor")).toHaveLength(1);
  });

  it("closes the picker once a rep is chosen", () => {
    setup();
    fireEvent.click(screen.getByTestId("area-assignee-add"));
    fireEvent.click(screen.getByText("Ivy Chen"));
    expect(screen.getByTestId("area-assignee-add")).toBeInTheDocument();
  });

  it("will not add a rep who is already at the area cap", () => {
    // The server 409s at MAX_ACTIVE_AREAS_PER_REP. Finding that out through an
    // error toast, after choosing someone, is worse than not offering them: the
    // count is on the row so the reason is visible before the tap.
    const { onChange } = setup();
    fireEvent.click(screen.getByTestId("area-assignee-add"));
    fireEvent.click(screen.getByText("Tal Nguyen"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("removing a rep takes two taps", () => {
  // Dropping a rep hands their doors back. A single tap next to a name is a
  // mis-tap that costs someone their working queue.
  it("arms on the first tap without emitting anything", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByTestId("area-assignee-1"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("area-assignee-1")).toHaveTextContent("Remove?");
  });

  it("emits the remaining set on the second tap", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByTestId("area-assignee-1"));
    fireEvent.click(screen.getByTestId("area-assignee-1"));
    expect(onChange).toHaveBeenCalledWith([2]);
  });

  it("disarms when the chip loses focus, so it does not stay hot", () => {
    setup();
    const chip = screen.getByTestId("area-assignee-1");
    fireEvent.click(chip);
    fireEvent.blur(chip);
    expect(chip).toHaveTextContent("Rae Rivera");
  });
});

describe("an area cannot be emptied here", () => {
  // The API refuses an empty holder set: emptying an area is Reclaim's job,
  // because Reclaim is what decides where the doors go. Blocking it here beats
  // letting someone tap twice and collect a 400.
  it("refuses to remove the only holder", () => {
    const { onChange } = setup({ assigneeIds: [1] });
    const chip = screen.getByTestId("area-assignee-1");
    fireEvent.click(chip);
    fireEvent.click(chip);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says why, and points at Reclaim", () => {
    setup({ assigneeIds: [1] });
    expect(screen.getByTestId("area-assignee-last")).toHaveTextContent(/Reclaim/);
  });

  it("drops the warning as soon as a second rep is on", () => {
    setup({ assigneeIds: [1, 2] });
    expect(screen.queryByTestId("area-assignee-last")).toBeNull();
  });
});

describe("while a save is in flight", () => {
  it("locks every control so a double-tap cannot race the request", () => {
    setup({ pending: true });
    expect(screen.getByTestId("area-assignee-add")).toBeDisabled();
    expect(screen.getByTestId("area-assignee-1")).toBeDisabled();
  });

  it("says it is saving rather than looking inert", () => {
    setup({ pending: true });
    expect(screen.getByTestId("area-assignee-pending")).toBeInTheDocument();
  });
});

describe("it stays out of the way", () => {
  it("closes without changing anything", () => {
    const { onChange, onClose } = setup();
    fireEvent.click(screen.getByTestId("area-assignee-close"));
    expect(onClose).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears the home-indicator gesture zone", () => {
    // A control a thumb cannot reach without triggering the system swipe is a
    // control that does not exist on a phone.
    setup();
    expect(screen.getByTestId("area-assignee-bar")).toHaveStyle({
      bottom: "calc(env(safe-area-inset-bottom) + 1rem)",
    });
  });

  it("names itself for screen readers by the area it edits", () => {
    setup();
    expect(screen.getByRole("group", { name: "Who works Maple Ridge" })).toBeInTheDocument();
  });
});

// ── Theme + control polish (owner screenshot: white card, broken pill) ───────
describe("it belongs to the map's dark glass chrome", () => {
  it("sits on the glass surface with the ink scope, never a hardcoded white card", () => {
    setup();
    const bar = screen.getByTestId("area-assignee-bar");
    expect(bar.className).toMatch(/glass-surface/);
    expect(bar.className).toMatch(/glass-opaque/);
    expect(bar.className).toMatch(/glass-ink-scope/);
    // The regression: a translucent app-background fill that renders white in
    // light theme.
    expect(bar.className).not.toMatch(/bg-background|bg-white/);
  });

  it("styles the primary badge as a real token chip, not a ghost pill", () => {
    setup();
    const chip = within(screen.getByTestId("area-assignee-1")).getByText("1st");
    expect(chip.className).toMatch(/text-primary/);
    expect(chip.className).toMatch(/bg-primary\/15/);
    expect(chip.className).not.toMatch(/bg-foreground\/10/);
  });

  it("close is a 44px target with the shared focus ring", () => {
    setup();
    const close = screen.getByTestId("area-assignee-close");
    expect(close.className).toMatch(/\bh-11\b/);
    expect(close.className).toMatch(/\bw-11\b/);
    expect(close.className).toMatch(/focus-visible:ring-2/);
    expect(close).toHaveAccessibleName("Close");
  });

  it("the picker's Cancel is a 44px, properly styled control that collapses without emitting", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByTestId("area-assignee-add"));
    const cancel = screen.getByTestId("area-assignee-add-cancel");
    expect(cancel.className).toMatch(/\bh-11\b/);
    expect(cancel.className).toMatch(/text-foreground/);
    expect(cancel.className).toMatch(/focus-visible:ring-2/);
    fireEvent.click(cancel);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("area-assignee-add-cancel")).toBeNull();
    expect(screen.getByTestId("area-assignee-add")).toBeInTheDocument();
  });

  it("locks the picker's Cancel too while a save is in flight", () => {
    setup({ pending: true });
    fireEvent.click(screen.getByTestId("area-assignee-add")); // disabled — no-op
    expect(screen.queryByTestId("area-assignee-add-cancel")).toBeNull();
  });

  it("announces the saving state politely", () => {
    setup({ pending: true });
    expect(screen.getByTestId("area-assignee-pending")).toHaveAttribute("role", "status");
    expect(screen.getByTestId("area-assignee-pending")).toHaveTextContent(/saving/i);
  });

  it("names every per-rep control after its rep", () => {
    setup();
    expect(screen.getByRole("button", { name: "Remove Rae Rivera" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("area-assignee-1"));
    expect(screen.getByRole("button", { name: "Confirm removing Rae Rivera" })).toBeInTheDocument();
  });

  it("stacks ABOVE the territory detail panel (z-40 over the panel's z-30)", () => {
    // Both surfaces mount for the same selected area. At equal z the panel —
    // later in the DOM — painted over this bar on narrow screens, and the
    // add-a-rep picker expanded upward underneath it: visible, untappable.
    setup();
    expect(screen.getByTestId("area-assignee-bar").className).toMatch(/\bz-40\b/);
  });
});
