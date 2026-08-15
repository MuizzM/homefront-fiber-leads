// Fiber 101 and the daily quotes.
//
// The glossary and the journey are speaking tools: every entry must carry the
// plain meaning AND the analogy a rep can hand a homeowner, and none of it may
// quote a figure that belongs to the offer catalog. The quotes are a factual
// surface too: every attributed line carries a real name, and the daily pick is
// deterministic so a whole crew sees the same line on the same day.
import { describe, expect, it } from "vitest";
import {
  FIBER_GLOSSARY, GLOSSARY_CATEGORIES, GLOSSARY_CATEGORY_TITLES, UNDERGROUND_JOURNEY,
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
    const body = JSON.stringify([FIBER_GLOSSARY, UNDERGROUND_JOURNEY]);
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
