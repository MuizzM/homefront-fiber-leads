// Content integrity for the Academy.
//
// Everything a rep reads is authored data, and the client renders it blindly.
// These tests are the proofreader: ids are unique and stable, every reference
// resolves, the ten required objections are all present, the house copy rules
// hold (no emoji, no em dashes, no arrows), and the never-say list is not a
// separate opinion from the checks that enforce it.
import { describe, expect, it } from "vitest";
import {
  ACADEMY_OBJECTIONS, ACADEMY_OBJECTION_KEYS, ETHICAL_TECHNIQUES,
  TECHNIQUE_LABELS, TECHNIQUE_NOTES, getAcademyObjection, isAcademyObjectionKey,
  taxonomyBackedObjections,
} from "../../shared/academyObjections";
import { ACADEMY_PERSONAS, SIGNAL_LABELS, getPersona, isPersonaId, personasRaising } from "../../shared/academyPersonas";
import {
  ALL_ACTIVITIES, BRANCH_TREES, CERTIFICATIONS, PATH_STAGES, SCENARIO_SETS,
  TOTAL_ACTIVITIES, TOTAL_PATH_MINUTES, getBranchNode, getBranchTree,
  getScenarioSet, isActivityId, pathLessonsResolve, referencedLessonIds,
  stageForActivity,
} from "../../shared/academyPath";
import { PITCH_BLOCKS, BLOCK_CATEGORIES, PITCH_SECONDS_BUDGET, blocksIn, renderBlock, reviewPitch } from "../../shared/academyPitchBlocks";
import {
  PROHIBITED_PHRASES, REFERENCE_CARDS, REFERENCE_CATEGORIES,
  cardsIn, getReferenceCard, requiredCards, searchReference,
} from "../../shared/academyReference";
import { OBJECTION_KEYS } from "../../shared/trainingObjections";
import { getTrainingLesson } from "../../shared/trainingContent";
import { ACADEMY_QUOTES } from "../../shared/academyQuotes";
import {
  CABLE_VS_FIBER, FIBER_GLOSSARY, SAY_IT_SIMPLE, UNDERGROUND_JOURNEY,
  WHY_FIBER, WHY_PEOPLE_SWITCH,
} from "../../shared/academyFiberBasics";

/** Everything a rep can read, as one string, for the copy-rule sweeps. */
const ALL_COPY = JSON.stringify([
  ACADEMY_OBJECTIONS, ACADEMY_PERSONAS, PATH_STAGES, SCENARIO_SETS,
  BRANCH_TREES, PITCH_BLOCKS, REFERENCE_CARDS, CERTIFICATIONS,
  TECHNIQUE_NOTES, TECHNIQUE_LABELS, SIGNAL_LABELS,
  ACADEMY_QUOTES, FIBER_GLOSSARY, UNDERGROUND_JOURNEY,
  WHY_FIBER, CABLE_VS_FIBER, WHY_PEOPLE_SWITCH, SAY_IT_SIMPLE,
]);

describe("house copy rules", () => {
  it("contains no emoji or pictographs anywhere", () => {
    expect(ALL_COPY).not.toMatch(/[\p{Extended_Pictographic}\u{FE0F}]/u);
  });

  it("uses hyphens, never em or en dashes", () => {
    expect(ALL_COPY).not.toMatch(/[–—]/);
  });

  it("contains no arrow glyphs in rep-facing copy", () => {
    expect(ALL_COPY).not.toMatch(/[←-⇿➔-➿]/);
  });
});

describe("the objections", () => {
  it("covers the ten the field brief names, plus the TV bundle", () => {
    expect([...ACADEMY_OBJECTION_KEYS]).toEqual([
      "not_interested", "under_contract", "competitor_fiber", "bad_experience",
      "price", "spouse", "renter", "too_busy", "leave_something", "data_source",
      "tv_bundle",
    ]);
    expect(ACADEMY_OBJECTIONS).toHaveLength(11);
  });

  it("keeps the frozen drill taxonomy untouched, and bridges to it where it maps", () => {
    // The CE-3 taxonomy is frozen at fourteen keys by its own contract test.
    // The Academy adds its three extra objections in its OWN union rather than
    // appending to that list, and every bridge it claims must be real.
    expect(OBJECTION_KEYS).toHaveLength(14);
    for (const objection of taxonomyBackedObjections()) {
      expect(OBJECTION_KEYS, objection.key).toContain(objection.taxonomyKey!);
    }
    // The three the taxonomy has no key for own themselves.
    expect(getAcademyObjection("under_contract")!.taxonomyKey).toBeNull();
    expect(getAcademyObjection("data_source")!.taxonomyKey).toBeNull();
    expect(getAcademyObjection("tv_bundle")!.taxonomyKey).toBeNull();
  });

  it("names a real persona wherever an objection picks its own sparring partner", () => {
    for (const o of ACADEMY_OBJECTIONS) {
      if (o.practicePersonaId) expect(getPersona(o.practicePersonaId), o.key).toBeTruthy();
    }
    // The TV bundle has no taxonomy bridge, so it must pick one explicitly.
    expect(getAcademyObjection("tv_bundle")!.practicePersonaId).toBeTruthy();
  });

  it("teaches the bundle honestly: the bill decides, not the rep", () => {
    const bundle = getAcademyObjection("tv_bundle")!;
    expect(bundle.ladder.excellent.toLowerCase()).toContain("directv");
    // The excellent line commits to conceding when the bundle wins.
    expect(bundle.ladder.excellent.toLowerCase()).toContain("if your bundle genuinely wins");
    // The trap forbids quoting DIRECTV numbers from memory.
    expect(bundle.trap.toLowerCase()).toContain("offer sheet");
  });

  it("gives every objection a full ladder, a trap and at least one technique", () => {
    for (const o of ACADEMY_OBJECTIONS) {
      expect(o.cue.trim().length, o.key).toBeGreaterThan(0);
      expect(o.chip.length, o.key).toBeLessThanOrEqual(22);
      expect(o.whatItMeans.length, o.key).toBeGreaterThan(40);
      expect(o.techniques.length, o.key).toBeGreaterThan(0);
      expect(o.trap.length, o.key).toBeGreaterThan(20);
      for (const rung of ["weak", "improved", "excellent", "why"] as const) {
        expect(o.ladder[rung].trim().length, `${o.key}.${rung}`).toBeGreaterThan(0);
      }
      // The excellent line should actually be the longest thought, not a slogan.
      expect(o.ladder.excellent.length, o.key).toBeGreaterThan(o.ladder.weak.length);
    }
  });

  it("only cites techniques from the closed ethical list", () => {
    for (const o of ACADEMY_OBJECTIONS) {
      for (const t of o.techniques) expect(ETHICAL_TECHNIQUES, o.key).toContain(t);
    }
  });

  it("has no technique that is pressure under another name", () => {
    const names = ETHICAL_TECHNIQUES.join(" ");
    for (const banned of ["urgency", "scarcity", "fear", "push", "overcome"]) {
      expect(names, banned).not.toContain(banned);
    }
    // Loss aversion is present, and its note is explicit about the limit.
    expect(ETHICAL_TECHNIQUES).toContain("honest_loss_aversion");
    expect(TECHNIQUE_NOTES.honest_loss_aversion.toLowerCase()).toContain("never invent a deadline");
  });

  it("labels and explains every technique", () => {
    for (const t of ETHICAL_TECHNIQUES) {
      expect(TECHNIQUE_LABELS[t].length, t).toBeGreaterThan(0);
      expect(TECHNIQUE_NOTES[t].length, t).toBeGreaterThan(60);
    }
  });

  it("guards unknown keys", () => {
    expect(isAcademyObjectionKey("price")).toBe(true);
    expect(isAcademyObjectionKey("nonsense")).toBe(false);
    expect(isAcademyObjectionKey(7)).toBe(false);
  });
});

describe("personas", () => {
  it("covers the ten households the brief names", () => {
    expect(ACADEMY_PERSONAS.map((p) => p.id)).toEqual([
      "busy_homeowner", "renter", "skeptic", "spectrum_customer", "price_sensitive",
      "remote_worker", "gamer", "senior_resident", "former_kinetic", "satisfied_customer",
    ]);
  });

  it("gives each one patience, wins, objections and a briefing", () => {
    for (const p of ACADEMY_PERSONAS) {
      expect(p.patience, p.id).toBeGreaterThanOrEqual(3);
      expect(p.wins.length, p.id).toBeGreaterThan(0);
      expect(p.objections.length, p.id).toBeGreaterThan(0);
      expect(p.briefing.length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.openingLine.trim().length, p.id).toBeGreaterThan(0);
      expect(p.exitLine.trim().length, p.id).toBeGreaterThan(0);
      expect(p.agreeLine.trim().length, p.id).toBeGreaterThan(0);
    }
  });

  it("only cites objections that exist in the frozen taxonomy", () => {
    for (const p of ACADEMY_PERSONAS) {
      for (const key of p.objections) expect(OBJECTION_KEYS, p.id).toContain(key);
    }
  });

  it("labels every signal a persona can care about", () => {
    for (const p of ACADEMY_PERSONAS) {
      for (const signal of [...p.wins, ...p.expects]) {
        expect(SIGNAL_LABELS[signal], `${p.id}:${signal}`).toBeTruthy();
      }
    }
  });

  it("finds personas by objection and by id", () => {
    expect(personasRaising("price").length).toBeGreaterThan(0);
    expect(getPersona("gamer")?.name).toBe("Jae");
    expect(getPersona("nobody")).toBeUndefined();
    expect(isPersonaId("renter")).toBe(true);
    expect(isPersonaId("landlord")).toBe(false);
  });

  it("includes a persona where the right answer may be no sale", () => {
    const satisfied = getPersona("satisfied_customer")!;
    expect(satisfied.wins).toContain("leaves_politely");
    expect(satisfied.briefing.join(" ").toLowerCase()).toContain("polite exit");
  });
});

describe("the path", () => {
  it("covers every subject the brief lists, in teaching order", () => {
    expect(PATH_STAGES.map((s) => s.id)).toEqual([
      "stage-product", "stage-benefits", "stage-intro", "stage-discovery",
      "stage-psychology", "stage-trust", "stage-pitch", "stage-competitive",
      "stage-objections", "stage-closing", "stage-followup", "stage-compliance",
      "stage-field",
    ]);
  });

  it("has unique activity ids", () => {
    const ids = ALL_ACTIVITIES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TOTAL_ACTIVITIES).toBe(ids.length);
  });

  it("resolves every lesson it references", () => {
    expect(pathLessonsResolve()).toBe(true);
    for (const id of referencedLessonIds()) expect(getTrainingLesson(id), id).toBeTruthy();
  });

  it("resolves every reference card, scenario set and branch tree it points at", () => {
    for (const a of ALL_ACTIVITIES) {
      if (a.cardId) expect(getReferenceCard(a.cardId), a.id).toBeTruthy();
      if (a.scenarioId) expect(getScenarioSet(a.scenarioId), a.id).toBeTruthy();
      if (a.branchId) expect(getBranchTree(a.branchId), a.id).toBeTruthy();
      if (a.personaId) expect(getPersona(a.personaId), a.id).toBeTruthy();
      if (a.objectionKey) expect(getAcademyObjection(a.objectionKey), a.id).toBeTruthy();
      if (a.kind === "fiber_101") expect(a.fiberSection, a.id).toBeTruthy();
    }
  });

  it("gives every activity an honest minute estimate and a detail line", () => {
    for (const a of ALL_ACTIVITIES) {
      expect(a.minutes, a.id).toBeGreaterThan(0);
      expect(a.minutes, a.id).toBeLessThanOrEqual(20);
      expect(a.detail.trim().length, a.id).toBeGreaterThan(0);
    }
    expect(TOTAL_PATH_MINUTES).toBeGreaterThan(60);
  });

  it("drills every objection in the objection stage", () => {
    const stage = PATH_STAGES.find((s) => s.id === "stage-objections")!;
    const drilled = stage.activities.filter((a) => a.kind === "objection_drill").map((a) => a.objectionKey);
    expect(drilled).toEqual([...ACADEMY_OBJECTION_KEYS]);
  });

  it("locates the stage for any activity", () => {
    expect(stageForActivity("act-timed-intro")?.id).toBe("stage-intro");
    expect(stageForActivity("nope")).toBeUndefined();
    expect(isActivityId("act-timed-intro")).toBe(true);
    expect(isActivityId("act-nope")).toBe(false);
  });

  it("requires a perfect score on the ethics and compliance scenarios", () => {
    for (const id of ["act-ethics-scenario", "act-compliance-scenario"]) {
      const activity = ALL_ACTIVITIES.find((a) => a.id === id)!;
      expect(activity.passScore, id).toBe(100);
    }
  });
});

describe("scenario sets", () => {
  it("points every answerIndex at a real option", () => {
    for (const set of SCENARIO_SETS) {
      expect(set.questions.length, set.id).toBeGreaterThan(0);
      for (const [i, q] of set.questions.entries()) {
        expect(q.options.length, `${set.id}#${i}`).toBeGreaterThanOrEqual(3);
        expect(q.answerIndex, `${set.id}#${i}`).toBeGreaterThanOrEqual(0);
        expect(q.answerIndex, `${set.id}#${i}`).toBeLessThan(q.options.length);
        // The explanation has to teach, so it must be more than a restatement.
        expect(q.explanation.length, `${set.id}#${i}`).toBeGreaterThan(80);
      }
    }
  });

  it("has unique set ids", () => {
    const ids = SCENARIO_SETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("branching trees", () => {
  it("resolves every branch target and terminates on every path", () => {
    for (const tree of BRANCH_TREES) {
      expect(getBranchNode(tree, tree.startNodeId), tree.id).toBeTruthy();
      for (const node of tree.nodes) {
        const terminal = !!node.outcome;
        expect(terminal || !!node.options?.length, `${tree.id}:${node.id}`).toBe(true);
        for (const option of node.options ?? []) {
          expect(getBranchNode(tree, option.next), `${tree.id}:${node.id} -> ${option.next}`).toBeTruthy();
          expect(option.why.length, `${tree.id}:${node.id}`).toBeGreaterThan(30);
        }
      }
    }
  });

  it("offers at least one strong choice at every decision", () => {
    for (const tree of BRANCH_TREES) {
      for (const node of tree.nodes) {
        if (!node.options?.length) continue;
        expect(node.options.some((o) => o.quality === "strong"), `${tree.id}:${node.id}`).toBe(true);
      }
    }
  });

  it("names a real persona", () => {
    for (const tree of BRANCH_TREES) expect(getPersona(tree.personaId), tree.id).toBeTruthy();
  });
});

describe("pitch blocks", () => {
  it("covers all six categories with at least two blocks each", () => {
    for (const category of BLOCK_CATEGORIES) {
      expect(blocksIn(category).length, category).toBeGreaterThanOrEqual(2);
    }
  });

  it("has unique ids and a full ladder on every block", () => {
    const ids = PITCH_BLOCKS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of PITCH_BLOCKS) {
      for (const rung of ["weak", "improved", "excellent", "why"] as const) {
        expect(b.ladder[rung].trim().length, `${b.id}.${rung}`).toBeGreaterThan(0);
      }
      expect(b.seconds, b.id).toBeGreaterThan(0);
      expect(b.seconds, b.id).toBeLessThanOrEqual(20);
    }
  });

  it("marks needsOffer on exactly the blocks that carry a token", () => {
    for (const b of PITCH_BLOCKS) {
      const hasToken = /\{(price|speed|upload|plan)\}/.test(b.text);
      expect(b.needsOffer, b.id).toBe(hasToken);
    }
  });

  it("leaves tokens visible and reported when the market has no live offer", () => {
    const priced = PITCH_BLOCKS.find((b) => b.needsOffer)!;
    const rendered = renderBlock(priced, null);
    expect(rendered.unresolved.length).toBeGreaterThan(0);
    expect(rendered.text).toContain("{");
  });

  it("substitutes live figures when there is an offer", () => {
    const priced = PITCH_BLOCKS.find((b) => b.text.includes("{price}"))!;
    const rendered = renderBlock(priced, {
      id: "gig", provider: "kinetic", market: "*", name: "Kinetic Fiber 1 Gig",
      downloadMbps: 1000, uploadMbps: 1000, priceCents: 6999,
      promoPriceCents: null, promoMonths: null, termMonths: 0,
      equipmentCents: 0, installCents: 0, unlimitedData: true,
      effectiveFrom: "2026-01-01", effectiveTo: null, disclosures: [],
    });
    expect(rendered.unresolved).toEqual([]);
    expect(rendered.text).toContain("$69.99");
    expect(rendered.text).not.toContain("{");
  });

  it("teaches a respectful exit as a close", () => {
    const exit = PITCH_BLOCKS.find((b) => b.id === "close-respectful-exit")!;
    expect(exit.category).toBe("close");
    expect(exit.techniques).toContain("leaving_respectfully");
  });
});

describe("pitch review", () => {
  const noOffer = null;

  it("tells an empty pitch where to start", () => {
    const review = reviewPitch({ blockIds: [] }, noOffer);
    expect(review.ready).toBe(false);
    expect(review.problems[0]).toContain("Nothing added yet");
  });

  it("names every missing structural piece", () => {
    const review = reviewPitch({ blockIds: ["intro-build-crew"] }, noOffer);
    const joined = review.problems.join(" ");
    expect(joined).toContain("No discovery question");
    expect(joined).toContain("No benefit statement");
    expect(joined).toContain("No close");
  });

  it("flags pitching before asking", () => {
    const review = reviewPitch(
      { blockIds: ["intro-build-crew", "ben-work-calls", "disc-current-provider", "close-two-slots"] },
      noOffer,
    );
    expect(review.problems.join(" ")).toContain("pitch before you ask");
  });

  it("flags an introduction that is not first", () => {
    const review = reviewPitch({ blockIds: ["disc-current-provider", "intro-build-crew", "close-two-slots"] }, noOffer);
    expect(review.problems.join(" ")).toContain("introduction is not first");
  });

  it("flags anything after the close", () => {
    const review = reviewPitch(
      { blockIds: ["intro-build-crew", "disc-current-provider", "ben-work-calls", "close-two-slots", "trans-two-things"] },
      noOffer,
    );
    expect(review.problems.join(" ")).toContain("close is not last");
  });

  it("flags a pitch that runs past the door budget", () => {
    const long = ["intro-build-crew", "intro-flags", "intro-permission-first", "disc-current-provider",
      "disc-evening-test", "disc-work-from-home", "ben-work-calls", "ben-evening-load",
      "ben-latency", "close-written"];
    const review = reviewPitch({ blockIds: long }, noOffer);
    expect(review.seconds).toBeGreaterThan(PITCH_SECONDS_BUDGET);
    expect(review.problems.join(" ")).toContain("Cut a block");
  });

  it("accepts a sound, short pitch and says what is good about it", () => {
    const review = reviewPitch(
      { blockIds: ["intro-build-crew", "disc-current-provider", "ben-work-calls", "close-two-slots"] },
      noOffer,
    );
    expect(review.problems).toEqual([]);
    expect(review.ready).toBe(true);
    expect(review.strengths.length).toBeGreaterThan(0);
    expect(review.signals.length).toBeGreaterThan(0);
  });

  it("refuses to call a pitch ready when its price token cannot resolve", () => {
    const review = reviewPitch(
      { blockIds: ["intro-build-crew", "disc-current-provider", "ben-price-plain", "close-two-slots"] },
      noOffer,
    );
    expect(review.ready).toBe(false);
    expect(review.problems.join(" ")).toContain("no live offer configured");
  });
});

describe("reference library", () => {
  it("has unique ids and covers every category", () => {
    const ids = REFERENCE_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of REFERENCE_CATEGORIES) {
      expect(cardsIn(category).length, category).toBeGreaterThan(0);
    }
  });

  it("carries the compliance subjects the brief names", () => {
    const ids = REFERENCE_CARDS.map((c) => c.id);
    for (const required of [
      "compliance-dnc", "compliance-privacy", "compliance-recording",
      "compliance-escalation", "never-say-list", "checklist-first-day",
      "safety-porch", "safety-street",
    ]) {
      expect(ids, required).toContain(required);
    }
  });

  it("quotes no prices or speeds, because those belong to the offer catalog", () => {
    for (const card of REFERENCE_CARDS) {
      const body = card.points.join(" ");
      expect(body, card.id).not.toMatch(/\$\s?\d/);
      expect(body, card.id).not.toMatch(/\d+\s?(mbps|gbps)/i);
    }
  });

  it("makes every required card substantial", () => {
    const required = requiredCards();
    expect(required.length).toBeGreaterThanOrEqual(8);
    for (const card of required) {
      expect(card.points.length, card.id).toBeGreaterThanOrEqual(3);
    }
  });

  it("gives the never-say list a reason and a replacement for every entry", () => {
    const card = getReferenceCard("never-say-list")!;
    expect(card.points.length).toBeGreaterThanOrEqual(10);
    for (const point of card.points) {
      expect(point, point).toMatch(/^Never: /);
      expect(point, point).toContain("Say");
    }
  });

  it("keeps the enforced phrase list aligned with what reps are taught", () => {
    const taught = getReferenceCard("never-say-list")!.points.join(" ").toLowerCase();
    for (const phrase of PROHIBITED_PHRASES) {
      // Each enforced phrase is recognisable in the card a rep actually reads.
      const stem = phrase.split(" ").slice(0, 2).join(" ");
      expect(taught, phrase).toContain(stem);
    }
  });

  it("ranks a title match above a passing mention", () => {
    const results = searchReference("upload");
    expect(results[0].id).toBe("product-upload-explained");
  });

  it("finds cards by the word a rep would actually type", () => {
    expect(searchReference("dnc").map((c) => c.id)).toContain("compliance-dnc");
    expect(searchReference("dog").map((c) => c.id)).toContain("safety-porch");
    expect(searchReference("first day").map((c) => c.id)).toContain("checklist-first-day");
  });

  it("returns everything for an empty query and nothing for nonsense", () => {
    expect(searchReference("")).toHaveLength(REFERENCE_CARDS.length);
    expect(searchReference("zzzzqqq")).toHaveLength(0);
  });

  it("filters by category", () => {
    const results = searchReference("", ["never_say"]);
    expect(results.every((c) => c.category === "never_say")).toBe(true);
  });
});

describe("certifications", () => {
  it("references only real stages and activities", () => {
    const stageIds = new Set(PATH_STAGES.map((s) => s.id));
    for (const cert of CERTIFICATIONS) {
      expect(cert.stageIds.length, cert.id).toBeGreaterThan(0);
      for (const id of cert.stageIds) expect(stageIds, `${cert.id} -> ${id}`).toContain(id);
      for (const id of cert.activityIds ?? []) expect(isActivityId(id), `${cert.id} -> ${id}`).toBe(true);
      expect(cert.meaning.length, cert.id).toBeGreaterThan(30);
    }
  });

  it("has a full certification covering the whole path", () => {
    const full = CERTIFICATIONS.find((c) => c.id === "cert-full")!;
    expect(full.stageIds).toHaveLength(PATH_STAGES.length);
  });
});
