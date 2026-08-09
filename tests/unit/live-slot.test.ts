// The Live Slot — one urgent thing at a time.
//
// This is a ranking function, so the tests are mostly about ORDER, and each one
// pins a product decision rather than an implementation detail. If a future
// change makes one of these fail, the question to ask is "did we mean to change
// what a rep sees first?" — not "how do I make the test pass?".
import { describe, expect, it } from "vitest";
import {
  resolveLiveSlot, countdownLabel, isUrgent, msLeft, type LiveItem,
} from "../../shared/liveSlot";

const NOW = Date.UTC(2026, 7, 4, 15, 0, 0);
const mins = (n: number) => NOW + n * 60_000;

const item = (over: Partial<LiveItem> & Pick<LiveItem, "kind" | "id">): LiveItem => ({
  headline: "", nextStep: "", rewardCents: 5_000,
  endsAtMs: mins(60), pct: 0, started: false,
  ...over,
});

describe("only one thing is ever primary", () => {
  it("returns exactly one item and counts the rest", () => {
    const r = resolveLiveSlot([
      item({ kind: "ladder", id: "l", endsAtMs: null, rewardCents: 2_500 }),
      item({ kind: "momentum", id: "m", rewardCents: 4_000 }),
      item({ kind: "drop", id: "d", endsAtMs: null, rewardCents: 1_500 }),
    ], NOW);
    expect(r.primary?.id).toBe("m");
    expect(r.otherCount).toBe(2);
    // The combined value of what's hidden is the reason to tap through.
    expect(r.otherRewardCents).toBe(4_000);
  });

  it("renders nothing when nothing is live", () => {
    // Absence is the correct rendering of nothing. An empty-state card for each
    // of five systems is exactly the clutter this exists to remove.
    const r = resolveLiveSlot([], NOW);
    expect(r.primary).toBeNull();
    expect(r.otherCount).toBe(0);
  });
});

describe("expired items are not low-priority - they are gone", () => {
  it("drops anything past its deadline before ranking", () => {
    const r = resolveLiveSlot([
      item({ kind: "challenge", id: "dead", started: true, endsAtMs: mins(-1) }),
      item({ kind: "ladder", id: "l", endsAtMs: null }),
    ], NOW);
    // The expired challenge would otherwise outrank everything on kind alone,
    // and a stale card is how a rep learns the screen lies.
    expect(r.primary?.id).toBe("l");
    expect(r.otherCount).toBe(0);
  });

  it("keeps something with no deadline at all", () => {
    const r = resolveLiveSlot([item({ kind: "ladder", id: "l", endsAtMs: null })], NOW);
    expect(r.primary?.id).toBe("l");
  });
});

describe("started beats unstarted - that's the whole ranking idea", () => {
  it("a started challenge outranks an untouched one worth more", () => {
    // A rep 6 doors into 10 will finish. A rep at 0 has already decided not to.
    // Showing the started one is the only case where the card changes anything.
    const r = resolveLiveSlot([
      item({ kind: "challenge", id: "fresh", started: false, rewardCents: 12_000 }),
      item({ kind: "challenge", id: "going", started: true, rewardCents: 2_000 }),
    ], NOW);
    expect(r.primary?.id).toBe("going");
  });

  it("momentum outranks an UNSTARTED challenge - minutes beat hours", () => {
    const r = resolveLiveSlot([
      item({ kind: "challenge", id: "c", started: false, endsAtMs: mins(55) }),
      item({ kind: "momentum", id: "m", endsAtMs: mins(40) }),
    ], NOW);
    expect(r.primary?.id).toBe("m");
  });

  it("but a STARTED challenge outranks momentum", () => {
    const r = resolveLiveSlot([
      item({ kind: "challenge", id: "c", started: true }),
      item({ kind: "momentum", id: "m", endsAtMs: mins(5) }),
    ], NOW);
    expect(r.primary?.id).toBe("c");
  });
});

describe("standing programmes are the floor, not news", () => {
  it("the ladder and door drops sort below anything with a clock", () => {
    const r = resolveLiveSlot([
      item({ kind: "drop", id: "d", endsAtMs: null, rewardCents: 2_500 }),
      item({ kind: "ladder", id: "l", endsAtMs: null, rewardCents: 10_000 }),
      item({ kind: "campaign", id: "c", endsAtMs: mins(300), rewardCents: 1_000 }),
    ], NOW);
    // Even though the ladder is worth 10x, it is true every day — it cannot be
    // the thing that makes a rep look at the screen.
    expect(r.primary?.id).toBe("c");
  });

  it("the ladder still wins when it is all there is", () => {
    const r = resolveLiveSlot([
      item({ kind: "drop", id: "d", endsAtMs: null }),
      item({ kind: "ladder", id: "l", endsAtMs: null }),
    ], NOW);
    expect(r.primary?.id).toBe("l");
  });
});

describe("campaigns get promoted as they close", () => {
  it("one ending inside 90 minutes jumps ahead of one with hours left", () => {
    const r = resolveLiveSlot([
      item({ kind: "campaign", id: "later", endsAtMs: mins(300), rewardCents: 9_000 }),
      item({ kind: "campaign", id: "soon", endsAtMs: mins(45), rewardCents: 1_000 }),
    ], NOW);
    expect(r.primary?.id).toBe("soon");
  });

  it("among equals, soonest deadline wins, then the bigger prize", () => {
    const r = resolveLiveSlot([
      item({ kind: "campaign", id: "a", endsAtMs: mins(300), rewardCents: 1_000 }),
      item({ kind: "campaign", id: "b", endsAtMs: mins(200), rewardCents: 1_000 }),
    ], NOW);
    expect(r.primary?.id).toBe("b");

    const tie = resolveLiveSlot([
      item({ kind: "campaign", id: "small", endsAtMs: mins(200), rewardCents: 1_000 }),
      item({ kind: "campaign", id: "big", endsAtMs: mins(200), rewardCents: 8_000 }),
    ], NOW);
    expect(tie.primary?.id).toBe("big");
  });

  it("is stable - identical items never shuffle between renders", () => {
    // A card that reorders on a background refetch reads as a glitch, and on a
    // touch screen it means the thing under your thumb changed.
    const a = item({ kind: "campaign", id: "aaa", endsAtMs: mins(120) });
    const b = item({ kind: "campaign", id: "bbb", endsAtMs: mins(120) });
    expect(resolveLiveSlot([a, b], NOW).primary?.id).toBe("aaa");
    expect(resolveLiveSlot([b, a], NOW).primary?.id).toBe("aaa");
  });
});

describe("the countdown a rep reads", () => {
  it("stays in minutes under an hour", () => {
    expect(countdownLabel(43 * 60_000)).toBe("43 min");
    expect(countdownLabel(9 * 60_000)).toBe("9 min");
    expect(countdownLabel(0)).toBe("0 min");
  });

  it("switches to hours above one - '63 min' reads as a clock, '1h 3m' doesn't", () => {
    expect(countdownLabel(63 * 60_000)).toBe("1h 3m");
    expect(countdownLabel(120 * 60_000)).toBe("2h");
  });

  it("says nothing for something with no deadline", () => {
    expect(countdownLabel(Infinity)).toBe("");
  });

  it("turns urgent under ten minutes, and not before", () => {
    expect(isUrgent(11 * 60_000)).toBe(false);
    expect(isUrgent(10 * 60_000)).toBe(true);
    expect(isUrgent(30_000)).toBe(true);
    // Already over is not urgent — it is finished, and the item is filtered out.
    expect(isUrgent(0)).toBe(false);
    expect(isUrgent(Infinity)).toBe(false);
  });

  it("msLeft floors at zero and is Infinity with no deadline", () => {
    expect(msLeft({ endsAtMs: mins(-5) }, NOW)).toBe(0);
    expect(msLeft({ endsAtMs: mins(5) }, NOW)).toBe(300_000);
    expect(msLeft({ endsAtMs: null }, NOW)).toBe(Infinity);
  });
});
