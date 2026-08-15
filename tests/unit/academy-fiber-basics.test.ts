// Fiber 101 and the daily quotes.
//
// The glossary and the journey are speaking tools: every entry must carry the
// plain meaning AND the analogy a rep can hand a homeowner, and none of it may
// quote a figure that belongs to the offer catalog. The quotes are a factual
// surface too: every attributed line carries a real name, and the daily pick is
// deterministic so a whole crew sees the same line on the same day.
import { describe, expect, it } from "vitest";
import {
  CABLE_VS_FIBER, FIBER_GLOSSARY, GLOSSARY_CATEGORIES, GLOSSARY_CATEGORY_TITLES,
  SAY_IT_SIMPLE, UNDERGROUND_JOURNEY, WHY_FIBER, WHY_PEOPLE_SWITCH,
  getGlossaryTerm, glossaryIn, searchGlossary,
} from "../../shared/academyFiberBasics";
import { ACADEMY_QUOTES, quoteForDay, quoteIndexFor } from "../../shared/academyQuotes";

describe("the glossary", () => {
  it("has unique ids and at least two terms in every category", () => {
    const ids = FIBER_GLOSSARY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of GLOSSARY_CATEGORIES) {
      expect(glossaryIn(category).length, category).toBeGreaterThanOrEqual(2);
      expect(GLOSSARY_CATEGORY_TITLES[category].length).toBeGreaterThan(0);
    }
  });

  it("gives every term a plain meaning and an analogy a rep could say out loud", () => {
    for (const t of FIBER_GLOSSARY) {
      expect(t.term.trim().length, t.id).toBeGreaterThan(0);
      expect(t.plain.length, t.id).toBeGreaterThan(60);
      expect(t.analogy.length, t.id).toBeGreaterThan(30);
      if (t.atTheDoor !== null) expect(t.atTheDoor.length, t.id).toBeGreaterThan(30);
    }
  });

  it("covers the words a new rep actually meets", () => {
    for (const id of [
      "term-fiber", "term-ont", "term-drop", "term-conduit", "term-bore",
      "term-vault", "term-splice", "term-locates", "term-symmetrical", "term-latency",
    ]) {
      expect(getGlossaryTerm(id), id).toBeTruthy();
    }
  });

  it("quotes no prices or speeds, because those belong to the offer catalog", () => {
    const body = JSON.stringify([
      FIBER_GLOSSARY, UNDERGROUND_JOURNEY, WHY_FIBER, CABLE_VS_FIBER, WHY_PEOPLE_SWITCH, SAY_IT_SIMPLE,
    ]);
    expect(body).not.toMatch(/\$\s?\d/);
    expect(body).not.toMatch(/\d+\s?(mbps|gbps)/i);
  });

  it("finds terms by the word a rep would type", () => {
    expect(searchGlossary("mole").map((t) => t.id)).toContain("term-bore");
    expect(searchGlossary("flags").map((t) => t.id)).toContain("term-locates");
    expect(searchGlossary("glass").map((t) => t.id)).toContain("term-fiber");
    expect(searchGlossary("")).toHaveLength(FIBER_GLOSSARY.length);
    expect(searchGlossary("zzzqqq")).toHaveLength(0);
  });
});

describe("fiber, in their words", () => {
  it("gives every benefit a felt outcome and a porch line, never a spec", () => {
    for (const w of WHY_FIBER) {
      expect(w.benefit.trim().length, w.id).toBeGreaterThan(0);
      expect(w.feel.length, w.id).toBeGreaterThan(50);
      expect(w.sayIt.length, w.id).toBeGreaterThan(40);
    }
    const ids = WHY_FIBER.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the cable comparison honest: every row carries a customer-checkable fact", () => {
    for (const row of CABLE_VS_FIBER) {
      expect(row.question.trim().length, row.id).toBeGreaterThan(0);
      expect(row.cable.length, row.id).toBeGreaterThan(40);
      expect(row.fiber.length, row.id).toBeGreaterThan(40);
      expect(row.check.length, row.id).toBeGreaterThan(20);
    }
    // The comparison concedes cable's real strength rather than swiping at it.
    const downloadRow = CABLE_VS_FIBER.find((r) => r.id === "vs-download")!;
    expect(downloadRow.cable.toLowerCase()).toContain("genuinely");
  });

  it("ends the switch list with who should not switch", () => {
    expect(WHY_PEOPLE_SWITCH.length).toBeGreaterThanOrEqual(5);
    const last = WHY_PEOPLE_SWITCH.at(-1)!;
    expect(last.id).toBe("switch-not");
    expect(last.story.toLowerCase()).toContain("happy");
    for (const s of WHY_PEOPLE_SWITCH) {
      expect(s.reason.trim().length, s.id).toBeGreaterThan(0);
      expect(s.story.length, s.id).toBeGreaterThan(50);
    }
  });

  it("translates the jargon a rep actually says, and the simple version stays simple", () => {
    const jargon = SAY_IT_SIMPLE.map((t) => t.jargon.toLowerCase());
    for (const required of ["a gig", "mbps", "symmetrical", "upload"]) {
      expect(jargon.some((j) => j.includes(required)), required).toBe(true);
    }
    for (const t of SAY_IT_SIMPLE) {
      expect(t.theyHear.trim().length, t.id).toBeGreaterThan(0);
      expect(t.sayInstead.length, t.id).toBeGreaterThan(40);
      // The replacement must not lean on the unit words it exists to replace.
      expect(t.sayInstead.toLowerCase(), t.id).not.toMatch(/\bmbps\b|\bgbps\b|megabit|gigabit/);
    }
  });
});

describe("the underground journey", () => {
  it("tells the story in contiguous order with nothing missing", () => {
    expect(UNDERGROUND_JOURNEY.map((s) => s.step)).toEqual(
      UNDERGROUND_JOURNEY.map((_, i) => i + 1),
    );
    expect(UNDERGROUND_JOURNEY.length).toBeGreaterThanOrEqual(5);
  });

  it("gives every step the mechanism, the picture and the door line", () => {
    for (const s of UNDERGROUND_JOURNEY) {
      expect(s.title.trim().length, `step ${s.step}`).toBeGreaterThan(0);
      expect(s.what.length, `step ${s.step}`).toBeGreaterThan(60);
      expect(s.analogy.length, `step ${s.step}`).toBeGreaterThan(20);
      expect(s.atTheDoor.length, `step ${s.step}`).toBeGreaterThan(40);
    }
  });

  it("starts at the hut and ends at the wall", () => {
    expect(UNDERGROUND_JOURNEY[0].title.toLowerCase()).toContain("hut");
    expect(UNDERGROUND_JOURNEY.at(-1)!.title.toLowerCase()).toContain("ont");
  });
});

describe("the daily quotes", () => {
  it("gives every quote real text and either a real name or no name", () => {
    for (const q of ACADEMY_QUOTES) {
      expect(q.text.trim().length).toBeGreaterThan(10);
      expect(q.text.length).toBeLessThan(220);
      if (q.attribution !== null) expect(q.attribution.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps the theme on consistency, with attributed lines in the mix", () => {
    const attributed = ACADEMY_QUOTES.filter((q) => q.attribution !== null);
    expect(attributed.length).toBeGreaterThanOrEqual(8);
    const everything = ACADEMY_QUOTES.map((q) => q.text.toLowerCase()).join(" ");
    expect(everything).toContain("consistency");
  });

  it("is deterministic: the same day picks the same quote on every device", () => {
    const day = new Date(2026, 7, 15);
    expect(quoteForDay(day)).toBe(quoteForDay(new Date(2026, 7, 15)));
    expect(quoteIndexFor(day)).toBe(quoteIndexFor(new Date(2026, 7, 15, 23, 59)));
  });

  it("walks the whole list before repeating", () => {
    const seen = new Set<number>();
    for (let i = 0; i < ACADEMY_QUOTES.length; i++) {
      seen.add(quoteIndexFor(new Date(2026, 0, 1 + i)));
    }
    expect(seen.size).toBe(ACADEMY_QUOTES.length);
  });
});
