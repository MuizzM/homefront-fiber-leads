// Contract tests for the 14-key objection taxonomy (lane CE-3). Pins the frozen
// key set, chip labels, and the section-heading → key map that trainingCards
// uses to mint objection cards — including that every mapped heading is a real
// authored section heading inside the objection modules m5/m12/m18.
import { describe, expect, it } from "vitest";
import {
  OBJECTION_KEYS,
  OBJECTION_TAXONOMY,
  OBJECTION_SECTION_HEADINGS,
  OBJECTION_CARD_GAPS,
  isObjectionKey,
  objectionChip,
  objectionKeyForHeading,
} from "../../shared/trainingObjections";
import { TRAINING_MODULES } from "../../shared/trainingContent";

const OBJECTION_MODULE_IDS = ["m5", "m12", "m18"];

describe("objection taxonomy", () => {
  it("defines exactly the 14 frozen keys", () => {
    expect([...OBJECTION_KEYS]).toEqual([
      "not_interested",
      "happy_provider",
      "price",
      "spouse",
      "think_about_it",
      "too_busy",
      "scam",
      "bad_experience",
      "competitor_fiber",
      "renter",
      "no_card",
      "leave_something",
      "already_have",
      "hoa",
    ]);
    expect(new Set(OBJECTION_KEYS).size).toBe(14);
  });

  it("carries a unique short chip label for every key", () => {
    expect(OBJECTION_TAXONOMY).toHaveLength(14);
    const chips = new Set<string>();
    for (const entry of OBJECTION_TAXONOMY) {
      expect(OBJECTION_KEYS).toContain(entry.key);
      expect(entry.chip.trim().length, entry.key).toBeGreaterThan(0);
      expect(entry.chip.length, `chip for ${entry.key} should stay short`).toBeLessThanOrEqual(22);
      expect(entry.cue.trim().length, entry.key).toBeGreaterThan(0);
      chips.add(entry.chip);
      expect(objectionChip(entry.key)).toBe(entry.chip);
    }
    expect(chips.size).toBe(14);
  });

  it("isObjectionKey accepts exactly the 14 keys", () => {
    for (const key of OBJECTION_KEYS) expect(isObjectionKey(key)).toBe(true);
    for (const bad of ["price ", "Price", "not-interested", "", "hoa2", 3, null, undefined, {}]) {
      expect(isObjectionKey(bad), String(bad)).toBe(false);
    }
  });

  it("maps section headings only to real taxonomy keys", () => {
    for (const [heading, key] of Object.entries(OBJECTION_SECTION_HEADINGS)) {
      expect(isObjectionKey(key), heading).toBe(true);
      expect(objectionKeyForHeading(heading)).toBe(key);
    }
    expect(objectionKeyForHeading("The forced-choice isolate")).toBeNull();
    expect(objectionKeyForHeading("not a heading")).toBeNull();
  });

  it("every mapped heading is an authored section heading in m5/m12/m18", () => {
    const headings = new Set<string>();
    for (const mod of TRAINING_MODULES) {
      if (!OBJECTION_MODULE_IDS.includes(mod.id)) continue;
      for (const lesson of mod.lessons) {
        for (const section of lesson.sections) headings.add(section.heading);
      }
    }
    for (const heading of Object.keys(OBJECTION_SECTION_HEADINGS)) {
      expect(headings.has(heading), `heading not found in m5/m12/m18: ${heading}`).toBe(true);
    }
  });

  it("names a reason for every taxonomy key with no objection section", () => {
    expect(Object.keys(OBJECTION_CARD_GAPS).sort()).toEqual([...OBJECTION_KEYS].sort());
    const mappedKeys = new Set(Object.values(OBJECTION_SECTION_HEADINGS));
    for (const key of OBJECTION_KEYS) {
      const gap = OBJECTION_CARD_GAPS[key];
      if (mappedKeys.has(key)) {
        expect(gap, `${key} has mapped sections, so no gap reason`).toBeNull();
      } else {
        expect(typeof gap, `${key} is a named gap and must carry a reason`).toBe("string");
        expect(gap!.length).toBeGreaterThan(0);
      }
    }
    // The three current named gaps, pinned so a future content addition that
    // closes one forces a deliberate contract update here.
    const gaps = OBJECTION_KEYS.filter((k) => OBJECTION_CARD_GAPS[k] !== null);
    expect(gaps).toEqual(["no_card", "leave_something", "hoa"]);
  });
});
