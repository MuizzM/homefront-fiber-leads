// The failure twin of EmptyState. What these tests protect is not the styling,
// it is the semantic split: an empty list is a calm true report (role="status"),
// a failed fetch is an alert that the number on screen is unknown rather than
// zero (role="alert"). Collapsing the two is the exact defect that shipped four
// times and that tests/rtl/ErrorStatesAreNotEmpties.test.tsx was written for.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorState } from "@/components/ErrorState";
import { EmptyState } from "@/components/EmptyState";
import { Inbox } from "lucide-react";

describe("ErrorState", () => {
  it("is an alert, not a status - so a failed fetch never reads as 'nothing here'", () => {
    render(<ErrorState testId="err" title="Couldn't load your follow-ups" />);
    expect(screen.getByTestId("err")).toHaveAttribute("role", "alert");
  });

  it("does not share a role with EmptyState", () => {
    render(
      <>
        <ErrorState testId="err" title="Couldn't load" />
        <EmptyState testId="empty" icon={Inbox} title="All caught up" />
      </>,
    );
    expect(screen.getByTestId("err").getAttribute("role")).not.toEqual(
      screen.getByTestId("empty").getAttribute("role"),
    );
  });

  it("carries a default explanation so no caller has to invent the second line", () => {
    render(<ErrorState testId="err" title="Couldn't load the leaderboard" />);
    expect(screen.getByText("Check your connection and try again.")).toBeInTheDocument();
  });

  it("wires Retry to the caller's refetch", () => {
    const onRetry = vi.fn();
    render(<ErrorState testId="err" title="Couldn't load" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // 44px is the one-handed hit-area floor (WCAG 2.5.5, iOS HIG). Several of the
  // hand-rolled retry buttons this primitive replaces were h-9 or h-10.
  it("keeps the retry control on the 44px tap floor", () => {
    render(<ErrorState testId="err" title="Couldn't load" onRetry={() => {}} />);
    expect(screen.getByRole("button", { name: "Retry" }).className).toContain("min-h-11");
  });

  it("renders no retry control when there is nothing to re-try", () => {
    render(<ErrorState testId="err" title="Couldn't load" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
