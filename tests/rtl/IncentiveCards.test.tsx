// The three new bonus cards on the Incentives surface.
//
// Each one has the same load-bearing rule: it renders NOTHING when there is no
// bonus to earn. A card that dangles money a rep cannot get is worse than no
// card, so "renders nothing" is asserted as hard as "renders the number".
//
// The other thing tested here is that the anti-gaming rules are VISIBLE. A rep
// who logged 61 doors and sees 54 counted must be told why, on the card, before
// they find out at payroll — a silent filter reads as a broken counter.
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { DoorDayCard, DoorDaySection } from "../../client/src/components/DoorDayCard";
import { RampBonusCard } from "../../client/src/components/RampBonusCard";
import { AchievementLadder } from "../../client/src/components/AchievementLadder";

/** Render one card with a canned payload for its own endpoint. */
function renderCard(node: React.ReactElement, url: string, payload: any) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }) =>
          String(queryKey[0]).includes(url) ? Promise.resolve(payload) : Promise.resolve(null),
      },
    },
  });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const doorDay = (o: Partial<any> = {}) => ({
  enabled: true, target: 60, counted: 30, remaining: 30, pct: 50,
  rewardCents: 5_000, spanMinutes: 145, minSpanMinutes: 180,
  spanShort: false, earned: false, needsReview: false,
  headline: "30 more genuine doors today for $50",
  rejected: { same_address: 0, too_fast: 0, hour_cap: 0 },
  dayLabel: "2026-08-06", minGapSeconds: 20, maxPerRollingHour: 25,
  ...o,
});

const ramp = (o: Partial<any> = {}) => ({
  visible: true, inWindow: true, tenureDay: 3, windowDays: 14, daysLeft: 12,
  rewardCents: 5_000, earnedToday: false, blockedBy: "no_work",
  headline: "Do today's cards for $50 - 12 days of the ramp bonus left",
  cardsToday: 0, minCardsPerDay: 10, daysPaid: 2,
  completion: {
    enabled: true, paid: false, lessonsCompleted: 40, lessonsTotal: 91,
    remaining: 51, awardCents: 10_000, headline: "51 lessons left to finish training - $100",
  },
  ...o,
});

const achievements = (o: Partial<any> = {}) => ({
  enabled: true, dailySales: 1, careerSales: 47,
  nextDaily: { sales: 2, rewardCents: 2_500 },
  nextCareer: { sales: 50, rewardCents: 5_000 },
  earnedTodayCents: 0,
  daily: [{ sales: 2, rewardCents: 2_500 }, { sales: 4, rewardCents: 5_000 }],
  career: [{ sales: 10, rewardCents: 2_500 }, { sales: 50, rewardCents: 5_000 }],
  headline: "1 more sale today for $25", onRamp: false, dayLabel: "2026-08-06",
  ...o,
});

describe("the genuine-day card", () => {
  it("shows the count, the target, and the instruction", async () => {
    renderCard(<DoorDayCard />, "/api/me/door-day", doorDay());
    expect((await screen.findByTestId("door-day-counted")).textContent).toBe("30");
    expect(screen.getByTestId("door-day-headline").textContent).toContain("30 more genuine doors");
    expect(screen.getByTestId("door-day-reward").textContent).toBe("$50");
  });

  it("names every door that did not count, and why", async () => {
    renderCard(<DoorDayCard />, "/api/me/door-day",
      doorDay({ rejected: { same_address: 4, too_fast: 2, hour_cap: 7 } }));
    const strip = await screen.findByTestId("door-day-rejected");
    expect(strip.textContent).toContain("4 re-knocks");
    expect(strip.textContent).toContain("2 logged too close together");
    expect(strip.textContent).toContain("7 past the hourly cap");
  });

  it("explains the too-fast day rather than showing a silent zero", async () => {
    renderCard(<DoorDayCard />, "/api/me/door-day",
      doorDay({ counted: 60, remaining: 0, pct: 100, spanShort: true, spanMinutes: 25 }));
    const warning = await screen.findByTestId("door-day-span-warning");
    expect(warning.textContent).toContain("25 minutes");
    expect(warning.textContent).toContain("3 hours");
  });

  it("says a held day is held, not merely unearned", async () => {
    renderCard(<DoorDayCard />, "/api/me/door-day",
      doorDay({ needsReview: true, headline: "Location problems on today's knocks - held for review." }));
    expect((await screen.findByTestId("door-day-review")).textContent).toContain("held until a manager reviews");
  });

  it("states the rule up front", async () => {
    renderCard(<DoorDayCard />, "/api/me/door-day", doorDay());
    const rule = await screen.findByTestId("door-day-rule");
    expect(rule.textContent).toContain("Each address counts once");
    expect(rule.textContent).toContain("GPS confirms");
    expect(rule.textContent).toContain("25 an hour");
  });

  it("renders nothing at all when the org has it switched off", async () => {
    const { container } = renderCard(<DoorDaySection />, "/api/me/door-day", doorDay({ enabled: false }));
    await new Promise(r => setTimeout(r, 0));
    expect(container.querySelector('[data-testid="door-day-section"]')).toBeNull();
    expect(container.querySelector('[data-testid="door-day-card"]')).toBeNull();
  });
});

describe("the ramp bonus card", () => {
  it("shows the window closing, not just the money", async () => {
    renderCard(<RampBonusCard />, "/api/me/ramp-bonus", ramp());
    expect((await screen.findByTestId("ramp-day")).textContent).toBe("Day 3 of 14");
    expect(screen.getByTestId("ramp-reward").textContent).toBe("$50/day");
    expect(screen.getByTestId("ramp-headline").textContent).toContain("Do today's cards");
  });

  it("counts the days already banked", async () => {
    renderCard(<RampBonusCard />, "/api/me/ramp-bonus", ramp());
    expect((await screen.findByTestId("ramp-days-paid")).textContent).toContain("2 training days banked");
    expect(screen.getByTestId("ramp-days-paid").textContent).toContain("$100");
  });

  it("tracks the curriculum toward the finishing bonus", async () => {
    renderCard(<RampBonusCard />, "/api/me/ramp-bonus", ramp());
    expect((await screen.findByTestId("ramp-completion-award")).textContent).toBe("$100");
    expect(screen.getByTestId("ramp-completion-headline").textContent).toContain("51 lessons left");
    expect(screen.getByTestId("ramp-completion").textContent).toContain("40 of 91 lessons");
    expect(screen.getByTestId("ramp-training-count-explainer").textContent).toMatch(/Academy Path groups lessons and practice/i);
  });

  it("marks the finishing bonus earned once it is paid", async () => {
    renderCard(<RampBonusCard />, "/api/me/ramp-bonus", ramp({
      completion: { ...ramp().completion, paid: true, headline: "Training finished" },
    }));
    expect((await screen.findByTestId("ramp-completion-award")).textContent).toBe("Earned");
  });

  it("still offers the finishing bonus to a veteran who never finished", async () => {
    renderCard(<RampBonusCard />, "/api/me/ramp-bonus", ramp({ inWindow: false, daysLeft: 0 }));
    // The daily half is gone; the one they can still collect is not.
    expect(await screen.findByTestId("ramp-completion")).toBeTruthy();
    expect(screen.queryByTestId("ramp-day")).toBeNull();
  });

  it("renders nothing for a veteran with nothing left to earn", async () => {
    const { container } = renderCard(<RampBonusCard />, "/api/me/ramp-bonus", ramp({ visible: false }));
    await new Promise(r => setTimeout(r, 0));
    expect(container.querySelector('[data-testid="ramp-card"]')).toBeNull();
  });
});

describe("the achievement ladder", () => {
  it("leads with the instruction, in sales", async () => {
    renderCard(<AchievementLadder />, "/api/me/achievements", achievements());
    expect((await screen.findByTestId("achievement-headline")).textContent).toBe("1 more sale today for $25");
    expect(screen.getByTestId("achievement-daily-sales").textContent).toBe("1");
  });

  it("shows the whole ladder, cleared rungs included", async () => {
    renderCard(<AchievementLadder />, "/api/me/achievements", achievements({ dailySales: 3 }));
    expect((await screen.findByTestId("achievement-daily-2")).textContent).toContain("2: $25");
    expect(screen.getByTestId("achievement-daily-4").textContent).toContain("4: $50");
    expect(screen.getByTestId("achievement-career-50").textContent).toContain("50: $50");
  });

  it("shows what today has already paid", async () => {
    renderCard(<AchievementLadder />, "/api/me/achievements",
      achievements({ dailySales: 2, earnedTodayCents: 2_500 }));
    expect((await screen.findByTestId("achievement-earned")).textContent).toContain("$25 today");
  });

  it("renders nothing for a rep still on the ramp bonus", async () => {
    // They are being paid to train instead; two competing bonuses on one screen
    // is how a rep ends up chasing neither.
    const { container } = renderCard(<AchievementLadder />, "/api/me/achievements",
      achievements({ enabled: false, onRamp: true, headline: null }));
    await new Promise(r => setTimeout(r, 0));
    expect(container.querySelector('[data-testid="achievement-card"]')).toBeNull();
  });
});
