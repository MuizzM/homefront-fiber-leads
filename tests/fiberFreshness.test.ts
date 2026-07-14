import { describe, expect, it } from "vitest";
import { calculateFiberFreshness, scheduleComingSoonRecheck } from "@shared/fiberFreshness";

const NOW = Date.UTC(2026, 6, 14, 12);

describe("calculateFiberFreshness", () => {
  it("fails closed when the provider response is inconclusive", () => {
    expect(calculateFiberFreshness({ serviceability: "live", conclusive: false, checkedAtMs: NOW, nowMs: NOW }))
      .toMatchObject({ score: 0, verificationState: "failed" });
  });

  it("gives a recent corroborated transition the strongest score", () => {
    const score = calculateFiberFreshness({
      serviceability: "live", conclusive: true, checkedAtMs: NOW - 3_600_000,
      firstSeenLiveAtMs: NOW - 3_600_000, independentEvidenceAtMs: NOW - 7_200_000,
      providerConfidence: 1, nowMs: NOW,
    });
    expect(score.score).toBe(100);
    expect(score.explanation).toContain("Unavailable-to-live transition observed");
  });

  it("marks observations older than 30 days stale", () => {
    const score = calculateFiberFreshness({
      serviceability: "live", conclusive: true, checkedAtMs: NOW - 31 * 24 * 3_600_000,
      providerConfidence: 0.8, nowMs: NOW,
    });
    expect(score.verificationState).toBe("stale");
    expect(score.score).toBeLessThan(30);
  });
});

describe("scheduleComingSoonRecheck", () => {
  it("checks a newly changed address within 24 hours", () => {
    expect(scheduleComingSoonRecheck({ consecutiveComingSoon: 5, lastChangedAtMs: NOW - 3_600_000, nowMs: NOW }))
      .toMatchObject({ intervalHours: 24, priority: "urgent" });
  });

  it("backs off stable coming-soon addresses without dropping them", () => {
    expect(scheduleComingSoonRecheck({ consecutiveComingSoon: 12, lastChangedAtMs: NOW - 60 * 24 * 3_600_000, nowMs: NOW }))
      .toMatchObject({ intervalHours: 336, priority: "low" });
  });
});
