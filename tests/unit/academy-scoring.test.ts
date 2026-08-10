// Role-play scoring, including the promise the product makes about what it
// will NOT measure.
//
// The most important test in this file is the one asserting that pressure can
// never raise a score. Everything else is a rubric; that one is the ethics of
// the whole feature, and it is the easiest thing for a well-meaning change to
// break.
import { describe, expect, it } from "vitest";
import {
  BAND_LABELS, DIMENSION_LABELS, SCORE_DIMENSIONS, UNSCORED_BEHAVIOURS,
  bandFor, scoreSession, weakestDimensions,
} from "../../shared/academyScoring";
import { respond, startSession, type RolePlaySession } from "../../shared/academyRolePlay";
import type { AcademyOffer } from "../../shared/academyOffers";

const OFFERS: AcademyOffer[] = [{
  id: "gig", provider: "kinetic", market: "*", name: "Kinetic Fiber 1 Gig",
  downloadMbps: 1000, uploadMbps: 1000, priceCents: 6999,
  promoPriceCents: null, promoMonths: null, termMonths: 0,
  equipmentCents: 0, installCents: 0, unlimitedData: true,
  effectiveFrom: "2026-01-01", effectiveTo: null,
  disclosures: ["Price and availability are confirmed at the address before any order is placed."],
}];

function run(personaId: any, lines: string[], id = "score-run"): RolePlaySession {
  let s = startSession({ id, personaId, market: "nc-lexington" });
  for (const line of lines) {
    if (s.outcome !== "in_progress") break;
    s = respond(s, line, { offers: OFFERS });
  }
  return s;
}

const STRONG_OPENER = "Hi, my name is Sam, I'm with the Kinetic fiber crew on your street. Thirty seconds and I'm out of your way.";

describe("the rubric shape", () => {
  it("scores exactly eleven dimensions", () => {
    expect(SCORE_DIMENSIONS).toHaveLength(11);
    const score = scoreSession(run("busy_homeowner", [STRONG_OPENER]), { offers: OFFERS });
    expect(score.dimensions.map((d) => d.dimension)).toEqual([...SCORE_DIMENSIONS]);
  });

  it("labels every dimension and every band", () => {
    for (const d of SCORE_DIMENSIONS) expect(DIMENSION_LABELS[d].length).toBeGreaterThan(0);
    expect(Object.keys(BAND_LABELS).sort()).toEqual(["developing", "needs_practice", "strong"]);
  });

  it("bands on 80 and 55", () => {
    expect(bandFor(80)).toBe("strong");
    expect(bandFor(79)).toBe("developing");
    expect(bandFor(55)).toBe("developing");
    expect(bandFor(54)).toBe("needs_practice");
  });

  it("keeps every score inside 0 to 100", () => {
    const s = run("skeptic", ["Come on. Come on. Just sign here. You'd be crazy not to. Trust me."]);
    for (const d of scoreSession(s, { offers: OFFERS }).dimensions) {
      expect(d.score, d.dimension).toBeGreaterThanOrEqual(0);
      expect(d.score, d.dimension).toBeLessThanOrEqual(100);
    }
  });
});

describe("what is deliberately not scored", () => {
  it("names the excluded behaviours, and none of them is a dimension", () => {
    expect(UNSCORED_BEHAVIOURS).toContain("aggression");
    expect(UNSCORED_BEHAVIOURS).toContain("pressure");
    expect(UNSCORED_BEHAVIOURS).toContain("persistence_after_refusal");
    for (const behaviour of UNSCORED_BEHAVIOURS) {
      expect(SCORE_DIMENSIONS as readonly string[]).not.toContain(behaviour);
    }
  });

  it("never lets pressure raise a score, on any dimension", () => {
    const polite = run("skeptic", [STRONG_OPENER, "Who do you have for internet right now?"], "polite");
    const pushy = run("skeptic", [STRONG_OPENER, "Who do you have for internet right now? Come on, this is your last chance."], "pushy");
    const a = scoreSession(polite, { offers: OFFERS });
    const b = scoreSession(pushy, { offers: OFFERS });
    for (const dimension of SCORE_DIMENSIONS) {
      const before = a.dimensions.find((d) => d.dimension === dimension)!.score;
      const after = b.dimensions.find((d) => d.dimension === dimension)!.score;
      expect(after, `${dimension} must not improve when the rep pressures`).toBeLessThanOrEqual(before);
    }
    expect(b.overall).toBeLessThan(a.overall);
  });

  it("deducts from professionalism and compliance when pressure appears", () => {
    const s = run("senior_resident", ["Just sign here, this is your last chance."]);
    const score = scoreSession(s, { offers: OFFERS });
    expect(score.dimensions.find((d) => d.dimension === "professionalism")!.score).toBeLessThan(100);
    expect(score.dimensions.find((d) => d.dimension === "compliance")!.score).toBeLessThan(100);
    expect(score.flags.length).toBeGreaterThan(0);
  });
});

describe("introduction", () => {
  it("scores a full opener at 100", () => {
    const s = run("busy_homeowner", [STRONG_OPENER]);
    expect(scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "introduction")!.score).toBe(100);
  });

  it("marks down an opener with no name and offers a rewrite", () => {
    const s = run("busy_homeowner", ["We're running fiber on your street, got thirty seconds?"]);
    const intro = scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "introduction")!;
    expect(intro.score).toBeLessThan(100);
    expect(intro.note).toContain("who you are");
    expect(intro.betterWording?.say.length).toBeGreaterThan(0);
  });

  it("scores zero when the rep never said anything", () => {
    const s = startSession({ id: "empty", personaId: "gamer", market: "" });
    expect(scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "introduction")!.score).toBe(0);
  });
});

describe("clarity", () => {
  it("penalises a monologue and says how long it ran", () => {
    const long = Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ");
    const s = run("gamer", [long]);
    const clarity = scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "clarity")!;
    expect(clarity.score).toBeLessThan(80);
    expect(clarity.note).toContain("70 words");
  });

  it("rewards door-length turns", () => {
    const s = run("gamer", [STRONG_OPENER]);
    expect(scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "clarity")!.score).toBe(100);
  });
});

describe("discovery", () => {
  it("scores zero and names the gap when the rep never asked", () => {
    const s = run("gamer", ["The upload is the same as the download on this."]);
    const discovery = scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "discovery")!;
    expect(discovery.score).toBe(0);
    expect(discovery.note).toContain("never asked");
    expect(discovery.betterWording).toBeTruthy();
  });

  it("rewards asking before pitching", () => {
    const s = run("gamer", ["Who do you have for internet right now?", "The upload is the same both ways on this."]);
    expect(scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "discovery")!.score)
      .toBeGreaterThanOrEqual(60);
  });
});

describe("accuracy", () => {
  it("is perfect when every number matches a live offer", () => {
    const s = run("price_sensitive", ["The whole monthly number is $69.99, nothing else lands on the bill."]);
    const accuracy = scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "accuracy")!;
    expect(accuracy.score).toBe(100);
    expect(accuracy.note).toContain("was supported");
  });

  it("marks down a figure nobody configured, and quotes it back", () => {
    const s = run("price_sensitive", ["I can get you in at $35 a month."]);
    const accuracy = scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "accuracy")!;
    expect(accuracy.score).toBeLessThan(100);
    expect(accuracy.note).toContain("$35");
  });

  it("describes a guarantee as something said, not as a figure quoted", () => {
    const s = run("skeptic", ["I guarantee your bill goes down."]);
    const accuracy = scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "accuracy")!;
    expect(accuracy.score).toBeLessThan(100);
    expect(accuracy.note).toContain("cannot be supported");
    expect(accuracy.note).not.toContain("figure");
  });
});

describe("compliance", () => {
  it("flags quoting a price without its disclosure", () => {
    const s = run("price_sensitive", ["It's $69.99 a month."]);
    const compliance = scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "compliance")!;
    expect(compliance.score).toBeLessThan(100);
    expect(compliance.note.toLowerCase()).toContain("disclosure");
  });

  it("is clean when nothing crossed a line", () => {
    const s = run("busy_homeowner", [STRONG_OPENER]);
    const compliance = scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "compliance")!;
    expect(compliance.score).toBe(100);
    expect(compliance.note).toContain("Nothing");
  });

  it("puts the compliance note first in the coaching list whenever it is not perfect", () => {
    const s = run("senior_resident", ["Just sign here, this is your last chance."]);
    const score = scoreSession(s, { offers: OFFERS });
    const compliance = score.dimensions.find((d) => d.dimension === "compliance")!;
    expect(score.coaching[0]).toBe(compliance.note);
  });
});

describe("closing", () => {
  it("treats a respectful exit as a strong close", () => {
    const s = run("satisfied_customer", [STRONG_OPENER, "Then I'll let you go. Thanks for your time."]);
    const closing = scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "closing")!;
    expect(closing.band).toBe("strong");
    expect(closing.note).toContain("left well");
  });

  it("scores a conversation with no ask at all near the floor", () => {
    const s = run("gamer", [STRONG_OPENER, "The upload is the same both ways."]);
    const closing = scoreSession(s, { offers: OFFERS }).dimensions.find((d) => d.dimension === "closing")!;
    expect(closing.score).toBeLessThan(40);
    expect(closing.betterWording?.say).toContain("Thursday");
  });
});

describe("coaching output", () => {
  it("gives at most three coaching lines, and always at least one", () => {
    const s = run("skeptic", [STRONG_OPENER]);
    const score = scoreSession(s, { offers: OFFERS });
    expect(score.coaching.length).toBeGreaterThanOrEqual(1);
    expect(score.coaching.length).toBeLessThanOrEqual(3);
  });

  it("carries the session and persona ids so a report can be traced", () => {
    const s = run("renter", [STRONG_OPENER], "traceable");
    const score = scoreSession(s, { offers: OFFERS });
    expect(score.sessionId).toBe("traceable");
    expect(score.personaId).toBe("renter");
  });

  it("anchors evidence on real turn indices", () => {
    const s = run("renter", [STRONG_OPENER, "Who do you have for internet right now?"]);
    const score = scoreSession(s, { offers: OFFERS });
    for (const d of score.dimensions) {
      for (const index of d.evidence) {
        expect(index, `${d.dimension} evidence`).toBeLessThan(s.turns.length);
        expect(index).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("weakest dimensions", () => {
  it("returns nothing for no sessions", () => {
    expect(weakestDimensions([])).toEqual([]);
  });

  it("ranks the lowest average first", () => {
    const a = scoreSession(run("gamer", ["The upload is the same both ways."], "a"), { offers: OFFERS });
    const b = scoreSession(run("gamer", ["The upload is the same both ways."], "b"), { offers: OFFERS });
    const ranked = weakestDimensions([a, b], 3);
    expect(ranked).toHaveLength(3);
    expect(ranked[0].average).toBeLessThanOrEqual(ranked[1].average);
    expect(ranked[1].average).toBeLessThanOrEqual(ranked[2].average);
  });
});
