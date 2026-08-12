// ── What to say at the door, pinned ───────────────────────────────────────────
// The reason this module has a test at all is the rule it enforces: NOTHING
// INVENTED. `fact` may only restate what the system verified, and when it
// verified nothing the opener is null and the card shows no line.
//
// A rep who repeats a claim the app made up gets caught on a porch, and then
// stops trusting the pin colours, the route order and the earnings number too.
// So the assertions below are mostly about what the copy must NOT contain.
import { describe, expect, it } from "vitest";
import { doorOpener, parseStamp, FRESH_AGE_MAX_DAYS } from "@shared/doorOpener";

const NOW = Date.parse("2026-08-11T15:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("parseStamp", () => {
  it("reads both timestamp shapes these tables hold", () => {
    // ISO, as the projector writes it…
    expect(parseStamp("2026-08-09T12:00:00.000Z")).toBe(Date.parse("2026-08-09T12:00:00.000Z"));
    // …and SQLite's space-separated UTC, as older rows hold it.
    expect(parseStamp("2026-08-09 12:00:00")).toBe(Date.parse("2026-08-09T12:00:00Z"));
  });

  it("returns null for absent or unparseable values instead of NaN", () => {
    expect(parseStamp(null)).toBeNull();
    expect(parseStamp(undefined)).toBeNull();
    expect(parseStamp("")).toBeNull();
    expect(parseStamp("not a date")).toBeNull();
  });
});

describe("doorOpener - silence when nothing is verified", () => {
  it("returns null with no carrier and no confirmed-fresh stamp", () => {
    expect(doorOpener({}, NOW)).toBeNull();
    expect(doorOpener({ carrier: null, freshConfirmedAt: null }, NOW)).toBeNull();
  });

  it("returns null for an unparseable stamp and an unknown carrier", () => {
    // An unknown carrier is not a fact - it must not become "Fiber is live" on
    // its own, because nothing verified that either.
    expect(doorOpener({ carrier: "someone-else", freshConfirmedAt: "garbage" }, NOW)).toBeNull();
  });
});

describe("doorOpener - the fact is the verified fact", () => {
  it("names the carrier and the lit age", () => {
    const o = doorOpener({ carrier: "kinetic", freshConfirmedAt: daysAgo(3) }, NOW);
    expect(o?.fact).toBe("Kinetic fiber went live at this address 3 days ago.");
    expect(o?.litDays).toBe(3);
  });

  it("says today and yesterday rather than 0 and 1 days ago", () => {
    expect(doorOpener({ carrier: "kinetic", freshConfirmedAt: daysAgo(0) }, NOW)?.fact)
      .toBe("Kinetic fiber went live at this address today.");
    expect(doorOpener({ carrier: "frontier", freshConfirmedAt: daysAgo(1) }, NOW)?.fact)
      .toBe("Frontier fiber went live at this address yesterday.");
  });

  it("drops the age once it stops being a hook", () => {
    const stale = doorOpener({ carrier: "kinetic", freshConfirmedAt: daysAgo(FRESH_AGE_MAX_DAYS + 1) }, NOW);
    expect(stale?.fact).toBe("Kinetic fiber is live at this address.");
    // The age is still reported for anything else that wants it.
    expect(stale?.litDays).toBe(FRESH_AGE_MAX_DAYS + 1);
    // …and the boundary itself still carries the age.
    expect(doorOpener({ carrier: "kinetic", freshConfirmedAt: daysAgo(FRESH_AGE_MAX_DAYS) }, NOW)?.fact)
      .toContain(`${FRESH_AGE_MAX_DAYS} days ago`);
  });

  it("falls back to a carrier-free fact when only the stamp is known", () => {
    // "Fiber", not "Fiber fiber" - the carrier is the subject's adjective, and
    // dropping it must not leave the noun doubled.
    const o = doorOpener({ carrier: null, freshConfirmedAt: daysAgo(2) }, NOW);
    expect(o?.fact).toBe("Fiber went live at this address 2 days ago.");
    expect(o?.fact).not.toMatch(/fiber fiber/i);
  });

  it("states only that fiber is live when the carrier is known but the date is not", () => {
    const o = doorOpener({ carrier: "kinetic" }, NOW);
    expect(o?.fact).toBe("Kinetic fiber is live at this address.");
    expect(o?.litDays).toBeNull();
  });

  it("accepts the carrier in any case the wire happens to use", () => {
    expect(doorOpener({ carrier: "KINETIC" }, NOW)?.fact).toContain("Kinetic");
    expect(doorOpener({ carrier: "Frontier" }, NOW)?.fact).toContain("Frontier");
  });

  it("never claims a future date - a clock skew reads as today, not negative days", () => {
    const o = doorOpener({ carrier: "kinetic", freshConfirmedAt: daysAgo(-5) }, NOW);
    expect(o?.litDays).toBe(0);
    expect(o?.fact).toContain("today");
  });
});

describe("doorOpener - the ask is a question, never a close", () => {
  it("opens with discovery on a first visit", () => {
    expect(doorOpener({ carrier: "kinetic" }, NOW)?.ask)
      .toBe("Do you know what you're paying for internet right now?");
  });

  it("changes the ask on a nobody-home revisit - that is a timing problem", () => {
    const o = doorOpener({ carrier: "kinetic", lastOutcome: "not_home", knockCount: 1 }, NOW);
    expect(o?.ask).toBe("Second time by - is now a better moment?");
  });

  it("does not treat a first knock with another outcome as a revisit", () => {
    const o = doorOpener({ carrier: "kinetic", lastOutcome: "interested", knockCount: 2 }, NOW);
    expect(o?.ask).toContain("Do you know what");
  });
});

describe("doorOpener - house style", () => {
  it("uses no dash-family glyphs, arrows or emoji in any produced copy", () => {
    const samples = [
      doorOpener({ carrier: "kinetic", freshConfirmedAt: daysAgo(0) }, NOW),
      doorOpener({ carrier: "frontier", freshConfirmedAt: daysAgo(1) }, NOW),
      doorOpener({ carrier: "kinetic", freshConfirmedAt: daysAgo(9) }, NOW),
      doorOpener({ carrier: "kinetic", lastOutcome: "not_home", knockCount: 3 }, NOW),
      doorOpener({ freshConfirmedAt: daysAgo(4) }, NOW),
    ];
    for (const o of samples) {
      const copy = `${o!.fact} ${o!.ask}`;
      // em dash, en dash, minus sign, arrows, and any astral-plane emoji
      expect(copy).not.toMatch(/[‒-―−←-⇿]/);
      expect(copy).not.toMatch(/[\u{1F000}-\u{1FAFF}]/u);
    }
  });

  it("makes no claim about price, competitors, neighbours or urgency", () => {
    const forbidden = /neighbou?rs?|cheaper|save|discount|deal|offer|limited|crew|last chance|today only/i;
    for (const carrier of ["kinetic", "frontier"]) {
      for (const age of [0, 1, 5, 45]) {
        const o = doorOpener({ carrier, freshConfirmedAt: daysAgo(age) }, NOW)!;
        expect(`${o.fact} ${o.ask}`).not.toMatch(forbidden);
      }
    }
  });
});
