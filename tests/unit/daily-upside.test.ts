// "What today is still worth" — the number a rep uses to decide whether to work
// the next two hours.
//
// The whole value of this card rests on ONE property: it never promises money
// the rep cannot actually still reach. A motivation figure caught lying once
// discredits every other number on the screen, so the tests here are mostly
// about what it REFUSES to count.
import { describe, expect, it } from "vitest";
import { dailyUpside, doorsStillWalkable, usd, type UpsideInput } from "../../shared/dailyUpside";

const base = (over: Partial<UpsideInput> = {}): UpsideInput => ({
  earnedTodayCents: 5_000,
  verifiedDoorsToday: 40,
  medianDoorsPerDay: 60,
  minutesLeftInShift: 180,
  openRewards: [],
  perSaleCommissionCents: 0,
  ...over,
});

describe("what's still walkable", () => {
  it("is paced from the rep's own median, not a burst rate", () => {
    // 60 doors / 8h = 7.5 an hour. Three hours left → ~22, not the 60 a
    // "you could still do a full day" figure would imply.
    expect(doorsStillWalkable(60, 180)).toBe(22);
    expect(doorsStillWalkable(90, 180)).toBe(33);
  });

  it("is zero once the shift is over", () => {
    expect(doorsStillWalkable(60, 0)).toBe(0);
    expect(doorsStillWalkable(60, -30)).toBe(0);
  });

  it("falls back to a sane pace for a rep with no history", () => {
    expect(doorsStillWalkable(0, 480)).toBe(60);
  });
});

describe("it refuses to count money the rep cannot reach", () => {
  it("drops a reward needing more doors than there is shift left", () => {
    const u = dailyUpside(base({
      minutesLeftInShift: 60,           // ~7 doors walkable
      openRewards: [
        { label: "Sprint", rewardCents: 2_000, doorsNeeded: 40, needsSale: false, minutesLeft: 60 },
      ],
    }));
    expect(u.items).toEqual([]);
    expect(u.reachableCents).toBe(0);
  });

  it("drops a reward whose OWN deadline is too close, even with shift left", () => {
    // 6 hours of shift but the campaign closes in 20 minutes: ~2 doors fit in
    // its window. Judging by the shift alone would have promised this.
    const u = dailyUpside(base({
      minutesLeftInShift: 360,
      openRewards: [
        { label: "Sprint", rewardCents: 2_000, doorsNeeded: 25, needsSale: false, minutesLeft: 20 },
      ],
    }));
    expect(u.items).toEqual([]);
  });

  it("drops an already-closed reward", () => {
    const u = dailyUpside(base({
      openRewards: [
        { label: "Early Bird", rewardCents: 4_000, doorsNeeded: 0, needsSale: true, minutesLeft: 0 },
      ],
    }));
    expect(u.items).toEqual([]);
  });

  it("keeps one that genuinely fits", () => {
    const u = dailyUpside(base({
      minutesLeftInShift: 240,          // ~30 doors walkable
      openRewards: [
        { label: "20 doors + a sale by 3", rewardCents: 5_000, doorsNeeded: 12, needsSale: true, minutesLeft: 120 },
      ],
    }));
    expect(u.items).toHaveLength(1);
    expect(u.items[0]!.requirement).toBe("12 more doors and a sale");
    expect(u.reachableCents).toBe(5_000);
  });
});

describe("the numbers add up", () => {
  it("potential = banked + everything still reachable", () => {
    const u = dailyUpside(base({
      earnedTodayCents: 7_500,
      minutesLeftInShift: 300,
      openRewards: [
        { label: "A", rewardCents: 2_500, doorsNeeded: 10, needsSale: false, minutesLeft: 200 },
      ],
      perSaleCommissionCents: 12_000,
    }));
    expect(u.reachableCents).toBe(14_500);
    expect(u.potentialTodayCents).toBe(22_000);
    expect(u.earnedTodayCents).toBe(7_500);
  });

  it("leads with the biggest reachable thing and what it takes", () => {
    const u = dailyUpside(base({
      minutesLeftInShift: 300,
      openRewards: [
        { label: "Small", rewardCents: 2_000, doorsNeeded: 5, needsSale: false, minutesLeft: 200 },
        { label: "Big", rewardCents: 9_000, doorsNeeded: 20, needsSale: false, minutesLeft: 200 },
      ],
    }));
    expect(u.items[0]!.label).toBe("Big");
    expect(u.subline).toBe("$90 more for 20 more doors.");
  });

  it("a sale is always reachable while the shift runs — the next door might be it", () => {
    const u = dailyUpside(base({ openRewards: [], perSaleCommissionCents: 15_000 }));
    expect(u.items.map(i => i.label)).toContain("One more sale");
    expect(u.items.find(i => i.label === "One more sale")!.requirement).toBe("close one");
  });
});

describe("what it says when there is nothing to chase", () => {
  it("closes out the day rather than nagging", () => {
    const u = dailyUpside(base({
      minutesLeftInShift: 0, earnedTodayCents: 18_000, perSaleCommissionCents: 12_000,
    }));
    expect(u.items).toEqual([]);
    expect(u.headline).toBe("$180 today");
    expect(u.subline).toBe("Shift's done. Nice work.");
  });

  it("stays honest when no campaign is running", () => {
    const u = dailyUpside(base({ perSaleCommissionCents: 0, openRewards: [] }));
    expect(u.subline).toBe("Nothing else on the clock — every sale still pays.");
  });
});

describe("money formatting", () => {
  it("never shows a float", () => {
    expect(usd(5_000)).toBe("$50");
    expect(usd(12_550)).toBe("$125.50");
    expect(usd(0)).toBe("$0");
  });
});
