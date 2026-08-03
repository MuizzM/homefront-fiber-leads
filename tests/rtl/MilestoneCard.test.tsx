// The standing door-bonus card, pinned.
//
// This card quotes money a rep will chase all week, so the properties worth a
// test are the ones that would make them feel lied to:
//
//   1. The headline is the SERVER's copy, verbatim. The client never re-derives
//      a rule it does not evaluate.
//   2. The rung strip shows the whole ladder, with cleared rungs visibly banked
//      — a rep should see the money ahead of them, not just the next step.
//   3. The counting rule is STATED. A rep who learns at payroll that re-knocks
//      and unverified taps did not count feels cheated; one who was told up
//      front just knocks more doors.
//   4. A disabled ladder renders literally nothing — never an empty rung strip
//      implying a bonus this org does not pay.
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { MilestoneCard, type MilestoneCardData } from "../../client/src/components/MilestoneCard";

function data(over: Partial<MilestoneCardData> = {}): MilestoneCardData {
  return {
    enabled: true,
    period: "week",
    periodLabel: "Aug 3 – Aug 9, 2026",
    rungs: [
      { doors: 100, rewardCents: 2_500 },
      { doors: 250, rewardCents: 5_000 },
      { doors: 500, rewardCents: 10_000 },
    ],
    progress: {
      doors: 62, target: 100, remaining: 38, pct: 62,
      nextRewardCents: 2_500, earnedCents: 0, toppedOut: false,
      headline: "38 more verified doors this week for $25",
    },
    ...over,
  };
}

function renderCard(d: MilestoneCardData | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qc.setQueryData(["/api/me/milestones"], d);
  return render(<QueryClientProvider client={qc}><MilestoneCard /></QueryClientProvider>);
}

describe("what the rep reads", () => {
  it("shows the door count and the server's headline verbatim", () => {
    renderCard(data());
    expect(screen.getByTestId("milestone-doors").textContent).toBe("62");
    expect(screen.getByTestId("milestone-headline").textContent)
      .toBe("38 more verified doors this week for $25");
  });

  it("draws the bar at the server's percentage", () => {
    renderCard(data());
    expect((screen.getByTestId("milestone-bar") as HTMLElement).style.width).toBe("62%");
  });

  it("shows the whole ladder so the money ahead is visible", () => {
    renderCard(data());
    expect(screen.getByTestId("milestone-rung-100").textContent).toContain("$25");
    expect(screen.getByTestId("milestone-rung-250").textContent).toContain("$50");
    expect(screen.getByTestId("milestone-rung-500").textContent).toContain("$100");
  });

  it("marks a cleared rung differently from one still ahead", () => {
    renderCard(data({
      progress: { ...data().progress, doors: 260, earnedCents: 7_500, target: 500, remaining: 240, pct: 4 },
    }));
    const banked = screen.getByTestId("milestone-rung-100").className;
    const ahead = screen.getByTestId("milestone-rung-500").className;
    expect(banked).not.toBe(ahead);
    expect(screen.getByTestId("milestone-earned").textContent).toContain("$75");
  });

  it("states the counting rule instead of hiding it", () => {
    renderCard(data());
    const rule = screen.getByTestId("milestone-rule").textContent ?? "";
    expect(rule).toMatch(/each address once/i);
    expect(rule).toMatch(/GPS/i);
    // …and says where the money shows up, because that is the promise.
    expect(rule).toMatch(/commission statement/i);
  });

  it("drops the progress bar once every rung is cleared", () => {
    renderCard(data({
      progress: {
        doors: 640, target: 0, remaining: 0, pct: 100, nextRewardCents: 0,
        earnedCents: 17_500, toppedOut: true,
        headline: "640 verified doors this week — every bonus earned",
      },
    }));
    expect(screen.queryByTestId("milestone-bar")).toBeNull();
    expect(screen.getByTestId("milestone-earned").textContent).toContain("$175");
  });
});

describe("an org that does not run this", () => {
  it("renders nothing at all when the ladder is off", () => {
    const { container } = renderCard(data({ enabled: false }));
    expect(screen.queryByTestId("milestone-card")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders nothing when the server sent no progress", () => {
    const { container } = renderCard(data({ progress: null }));
    expect(container.textContent).toBe("");
  });
});
