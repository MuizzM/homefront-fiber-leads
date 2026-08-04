// Contract tests for the drill-card adapter (lane CE-3). Pins what CE-1/CE-2
// build against: deterministic ids, full lesson coverage, id round-trips,
// objection-key coverage with named gaps, the stage table covering every
// module, and proof the adapter never mutates the deep-frozen curriculum.
import { describe, expect, it } from "vitest";
import {
  buildDrillDeck,
  getDrillCard,
  cardsByObjection,
  cardsByStage,
  isDrillCardId,
  getDoorStage,
  CARD_KINDS,
  DOOR_STAGES,
  MODULE_STAGE_TABLE,
  LESSON_STAGE_OVERRIDES,
} from "../../shared/trainingCards";
import { OBJECTION_KEYS, OBJECTION_CARD_GAPS } from "../../shared/trainingObjections";
import { TRAINING_MODULES, TRAINING_LESSONS } from "../../shared/trainingContent";

const deck = buildDrillDeck();

describe("drill-card deck", () => {
  it("mints deterministic ids, stable across re-runs and deep-equal rebuilds", () => {
    const first = buildDrillDeck().map((c) => c.id);
    const second = buildDrillDeck().map((c) => c.id);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    // Spot-pin the id format at both ends of the deck.
    expect(first[0]).toBe("card:m1-rejection-math:say-this:0");
    expect(first[first.length - 1]).toMatch(/^card:m22-[a-z-]+:drill:0$/);
  });

  it("validates every minted id via isDrillCardId, and round-trips through getDrillCard", () => {
    for (const card of deck) {
      expect(isDrillCardId(card.id), card.id).toBe(true);
      expect(getDrillCard(card.id)).toBe(card);
    }
    for (const bad of [
      "card:m1-x:bogus:0",
      "card:m1-x:takeaway:-1",
      "card:m1-x:takeaway",
      "m1-x:takeaway:0",
      "card::takeaway:0",
      "card:m1-x:takeaway:0:extra",
      "",
      42,
      null,
      undefined,
    ]) {
      expect(isDrillCardId(bad), String(bad)).toBe(false);
    }
    expect(getDrillCard("card:nope:takeaway:0")).toBeUndefined();
  });

  it("yields at least one card for every authored lesson", () => {
    const byLesson = new Map<string, number>();
    for (const card of deck) byLesson.set(card.lessonId, (byLesson.get(card.lessonId) ?? 0) + 1);
    for (const lesson of TRAINING_LESSONS) {
      expect(byLesson.get(lesson.id) ?? 0, lesson.id).toBeGreaterThanOrEqual(1);
    }
  });

  it("produces every card kind with consistent card shape", () => {
    const kinds = new Set(deck.map((c) => c.kind));
    for (const kind of CARD_KINDS) expect(kinds.has(kind), kind).toBe(true);
    for (const card of deck) {
      expect(CARD_KINDS).toContain(card.kind);
      expect(DOOR_STAGES).toContain(card.stage);
      expect(card.front.trim().length, card.id).toBeGreaterThan(0);
      expect(card.back.trim().length, card.id).toBeGreaterThan(0);
      expect(card.lessonId.startsWith(`${card.moduleId}-`), card.id).toBe(true);
      if (card.kind !== "objection") expect(card.objectionKey, card.id).toBeNull();
      if (card.kind === "objection") expect(card.objectionKey, card.id).not.toBeNull();
      expect(getDoorStage(card.moduleId, card.lessonId)).toBe(card.stage);
    }
  });

  it("chains prev/next across the whole deck, reciprocally", () => {
    expect(deck[0].prevCardIds).toEqual([]);
    expect(deck[deck.length - 1].nextCardIds).toEqual([]);
    for (let i = 0; i < deck.length; i++) {
      if (i > 0) {
        expect(deck[i].prevCardIds).toEqual([deck[i - 1].id]);
        expect(deck[i - 1].nextCardIds).toEqual([deck[i].id]);
      }
      expect(deck[i].prevCardIds.length).toBeLessThanOrEqual(1);
      expect(deck[i].nextCardIds.length).toBeLessThanOrEqual(1);
    }
  });
});

describe("card extraction rules", () => {
  it("mints one takeaway card per keyTakeaways entry, stem front / verbatim back", () => {
    const lesson = TRAINING_LESSONS.find((l) => l.id === "m1-rejection-math")!;
    const cards = deck.filter((c) => c.lessonId === lesson.id && c.kind === "takeaway");
    expect(cards).toHaveLength(lesson.keyTakeaways.length);
    cards.forEach((card, i) => {
      expect(card.id).toBe(`card:m1-rejection-math:takeaway:${i}`);
      expect(card.back).toBe(lesson.keyTakeaways[i]);
      expect(lesson.keyTakeaways[i].startsWith(card.front), card.id).toBe(true);
    });
  });

  it("mints one say-this card per module swap, front=instead back=say", () => {
    const withSwap = TRAINING_MODULES.filter((m) => m.sayThisNotThat);
    const cards = deck.filter((c) => c.kind === "say-this");
    expect(cards).toHaveLength(withSwap.length);
    for (const mod of withSwap) {
      const card = cards.find((c) => c.moduleId === mod.id)!;
      expect(card.front).toBe(mod.sayThisNotThat!.instead);
      expect(card.back).toBe(mod.sayThisNotThat!.say);
      expect(card.lessonId).toBe(mod.lessons[0].id);
    }
  });

  it("mints one script card per pitchDrill and one drill card per lesson", () => {
    const withPitch = TRAINING_LESSONS.filter((l) => l.pitchDrill);
    const scripts = deck.filter((c) => c.kind === "script");
    expect(scripts).toHaveLength(withPitch.length);
    for (const lesson of withPitch) {
      const card = scripts.find((c) => c.lessonId === lesson.id)!;
      expect(card.back).toBe(lesson.pitchDrill);
      expect(card.front).toContain(lesson.title);
    }
    const drills = deck.filter((c) => c.kind === "drill");
    expect(drills).toHaveLength(TRAINING_LESSONS.length);
    for (const lesson of TRAINING_LESSONS) {
      const card = drills.find((c) => c.lessonId === lesson.id)!;
      expect(card.front).toBe(lesson.drillPrompt);
      expect(card.back.trim().length).toBeGreaterThan(0);
    }
  });

  it("mints objection cards with verbatim cue, response back, psychology note", () => {
    const happy = getDrillCard("card:m12-happy-price-works:objection:0")!;
    expect(happy.objectionKey).toBe("happy_provider");
    expect(happy.front).toBe("I'm happy with my provider"); // quotes stripped
    expect(happy.back).toContain("Happy is great");
    expect(happy.note).toMatch(/^The psychology:/);
    expect(happy.back).not.toContain("The psychology:");
    // m5 sections carry psychology inline — no note, response intact.
    const busy = getDrillCard("card:m5-big-six-1:objection:0")!;
    expect(busy.objectionKey).toBe("too_busy");
    expect(busy.front).toBe("I'm busy right now");
    expect(busy.note).toBeUndefined();
    expect(busy.back).toContain("Totally get it");
  });
});

describe("objection coverage", () => {
  it("covers every taxonomy key with >=1 card, except the named gaps", () => {
    for (const key of OBJECTION_KEYS) {
      const cards = cardsByObjection(key);
      if (OBJECTION_CARD_GAPS[key] === null) {
        expect(cards.length, `key ${key} should have cards`).toBeGreaterThanOrEqual(1);
        for (const card of cards) {
          expect(card.kind).toBe("objection");
          expect(card.objectionKey).toBe(key);
          expect(["m5", "m12", "m18"], card.id).toContain(card.moduleId);
        }
      } else {
        expect(cards, `named gap ${key} should have no cards yet`).toHaveLength(0);
      }
    }
  });

  it("keeps the named-gap set pinned to the contract", () => {
    const gaps = OBJECTION_KEYS.filter((k) => OBJECTION_CARD_GAPS[k] !== null);
    expect(gaps).toEqual(["no_card", "leave_something", "hoa"]);
  });
});

describe("stage table", () => {
  it("covers every authored module exactly once", () => {
    expect(Object.keys(MODULE_STAGE_TABLE).sort()).toEqual(
      TRAINING_MODULES.map((m) => m.id).sort(),
    );
    for (const stage of Object.values(MODULE_STAGE_TABLE)) {
      expect(DOOR_STAGES).toContain(stage);
    }
  });

  it("lesson overrides reference real lessons in real modules", () => {
    const lessonIds = new Set(TRAINING_LESSONS.map((l) => l.id));
    for (const [lessonId, stage] of Object.entries(LESSON_STAGE_OVERRIDES)) {
      expect(lessonIds.has(lessonId), lessonId).toBe(true);
      expect(DOOR_STAGES).toContain(stage);
    }
  });

  it("populates every door stage with at least one card", () => {
    for (const stage of DOOR_STAGES) {
      expect(cardsByStage(stage).length, stage).toBeGreaterThanOrEqual(1);
    }
  });

  it("pins the documented module defaults and lesson overrides", () => {
    expect(getDoorStage("m5", "m5-big-six-1")).toBe("objection");
    expect(getDoorStage("m12", "m12-scam-bad-notinterested")).toBe("objection");
    expect(getDoorStage("m18", "m18-money-competitor")).toBe("objection");
    expect(getDoorStage("m11", "m11-opener-structure")).toBe("opener"); // override
    expect(getDoorStage("m11", "m11-pitch-fresh-fiber")).toBe("pitch"); // default
    expect(getDoorStage("m6", "m6-callback")).toBe("followup"); // override
    expect(getDoorStage("m6", "m6-closes")).toBe("close"); // default
    expect(getDoorStage("m13", "m13-no-card-objection")).toBe("compliance");
  });
});

describe("immutability", () => {
  it("never mutates the deep-frozen curriculum while building the deck", () => {
    const snapshot = JSON.stringify(TRAINING_MODULES);
    buildDrillDeck();
    buildDrillDeck();
    expect(JSON.stringify(TRAINING_MODULES)).toBe(snapshot);
    expect(Object.isFrozen(TRAINING_MODULES)).toBe(true);
    for (const mod of TRAINING_MODULES) {
      expect(Object.isFrozen(mod)).toBe(true);
      expect(Object.isFrozen(mod.lessons)).toBe(true);
      for (const lesson of mod.lessons) {
        expect(Object.isFrozen(lesson)).toBe(true);
        expect(Object.isFrozen(lesson.keyTakeaways)).toBe(true);
        expect(Object.isFrozen(lesson.sections)).toBe(true);
      }
    }
  });

  it("returns a frozen deck of frozen cards", () => {
    expect(Object.isFrozen(deck)).toBe(true);
    for (const card of deck) {
      expect(Object.isFrozen(card), card.id).toBe(true);
      expect(Object.isFrozen(card.prevCardIds), card.id).toBe(true);
      expect(Object.isFrozen(card.nextCardIds), card.id).toBe(true);
    }
  });
});
