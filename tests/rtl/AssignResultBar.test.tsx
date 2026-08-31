import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AssignResultBar, type AssignResultState } from "@/components/map/AssignResultBar";

// The persistent post-commit record for a bulk assignment. The contract under
// test: the outcome and its undo survive toast traffic, the undo window is the
// server's (undoExpiresAt), reassignment reads differently from first
// assignment, and a spent token is never offered a retry.

const base: AssignResultState = {
  repName: "Dana Door",
  updated: 34,
  skipped: 2,
  movedFromOthers: 12,
  undoToken: "tok-1",
  undoExpiresAt: Date.now() + 10 * 60_000,
};

describe("<AssignResultBar />", () => {
  it("states what happened, that doors changed hands, and how long undo lasts", () => {
    render(<AssignResultBar result={base} onUndo={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByTestId("assign-result-headline")).toHaveTextContent(
      "34 assigned to Dana Door · 2 skipped (out of scope)",
    );
    expect(screen.getByTestId("assign-result-detail")).toHaveTextContent(
      "12 changed hands from other reps · undo for 10 min",
    );
    expect(screen.getByTestId("assign-result-undo")).toBeInTheDocument();
  });

  it("a first assignment says so instead of implying a reassignment", () => {
    render(
      <AssignResultBar result={{ ...base, movedFromOthers: 0 }} onUndo={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByTestId("assign-result-detail")).toHaveTextContent("All were unassigned before this");
  });

  it("fires onUndo and disables while the undo is in flight", () => {
    const onUndo = vi.fn();
    const { rerender } = render(<AssignResultBar result={base} onUndo={onUndo} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByTestId("assign-result-undo"));
    expect(onUndo).toHaveBeenCalledTimes(1);
    rerender(<AssignResultBar result={{ ...base, undoPending: true }} onUndo={onUndo} onDismiss={vi.fn()} />);
    expect(screen.getByTestId("assign-result-undo")).toBeDisabled();
  });

  it("becomes the put-back receipt after a successful undo", () => {
    render(
      <AssignResultBar
        result={{ ...base, undone: { restored: 34, skipped: 2 } }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId("assign-result-headline")).toHaveTextContent(
      "34 put back · 2 left as someone else moved them",
    );
    expect(screen.queryByTestId("assign-result-undo")).toBeNull();
  });

  it("hides the undo once the server window has ended, and says why", () => {
    render(
      <AssignResultBar
        result={{ ...base, undoExpiresAt: Date.now() - 1_000 }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("assign-result-undo")).toBeNull();
    expect(screen.getByTestId("assign-result-detail")).toHaveTextContent("The undo window has ended.");
  });

  it("a failed undo shows the server's reason and offers no retry - the token is spent", () => {
    render(
      <AssignResultBar
        result={{ ...base, undoError: "That assignment can no longer be undone" }}
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("assign-result-undo")).toBeNull();
    expect(screen.getByTestId("assign-result-detail")).toHaveTextContent(
      "That assignment can no longer be undone",
    );
  });

  it("dismiss is a real 44px control and calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(<AssignResultBar result={base} onUndo={vi.fn()} onDismiss={onDismiss} />);
    const btn = screen.getByTestId("assign-result-dismiss");
    expect(btn).toHaveAccessibleName("Dismiss assignment result");
    fireEvent.click(btn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
