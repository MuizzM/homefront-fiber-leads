// ── Drill-Card Deck ───────────────────────────────────────────────────────────
// Pure adapter over TRAINING_MODULES (lane CE-3 contract): flattens the
// authored curriculum into flashcard-shaped DrillCards for the coaching engine
// (CE-1 server, CE-2 client). No I/O, no mutation — the source modules are
// deep-frozen and this file only reads them. The deck is built once at import
// and frozen; card ids are deterministic across re-runs.
//
// Card kinds and extraction rules:
//   takeaway  — one card per entry in lesson.keyTakeaways.
//               front = the takeaway's stem (its leading clause, see
//               takeawayStem), back = the full takeaway verbatim.
//   say-this  — one card per module sayThisNotThat swap, attributed to the
//               module's first lesson. front = the reflex line to drop
//               (instead), back = the line that lands (say).
//   objection — one card per objection-titled section in m5/m12/m18, keyed via
//               OBJECTION_SECTION_HEADINGS (shared/trainingObjections.ts).
//               front = the objection verbatim cue (heading, wrapping quotes
//               stripped), back = the response paragraphs, note = the
//               "The psychology:" line when the section carries one.
//   script    — one card per lesson pitchDrill. front = the scenario prompt
//               (lesson title + summary), back = the rehearsal script verbatim.
//   drill     — one card per lesson drillPrompt. front = the drill prompt
//               verbatim, back = the "next 10 doors" guidance (the prompt's
//               10-doors sentences, or the standard fallback line).
//
// Deck order is deterministic: modules in authored order; per module the
// say-this card first, then per lesson takeaway, objection, script, drill.
// prevCardIds/nextCardIds chain each card to its deck neighbors (≤1 each).

import { TRAINING_MODULES, type TrainingLesson, type TrainingModule } from "./trainingContent";
import { objectionKeyForHeading, type ObjectionKey } from "./trainingObjections";

export type CardKind = "takeaway" | "say-this" | "objection" | "script" | "drill";

export const CARD_KINDS: readonly CardKind[] = ["takeaway", "say-this", "objection", "script", "drill"];

/** Where in the door conversation a card belongs. */
export type DoorStage =
  | "opener"
  | "discovery"
  | "pitch"
  | "objection"
  | "close"
  | "followup"
  | "mindset"
  | "compliance";

export const DOOR_STAGES: readonly DoorStage[] = [
  "opener",
  "discovery",
  "pitch",
  "objection",
  "close",
  "followup",
  "mindset",
  "compliance",
];

// ── Stage table ───────────────────────────────────────────────────────────────
// Module → default stage, with per-lesson overrides below. Derived from each
// module's position in the curriculum arc:
//   m1  The Door Mindset                  mindset   — rejection math, identity
//   m2  The First Seven Seconds           opener    — approach, pattern interrupt
//   m3  The Pitch That Lands              pitch     — problem-first skeleton
//   m4  Reading People                    discovery — archetypes, buying signals
//   m5  Objection Psychology              objection — reflexes, the big six
//   m6  Closing and Follow-through        close     — closes, install date
//   m7  The Closing Playbook              close     — the six close types
//   m8  Advanced Door Psychology          pitch     — persuasion mechanics
//   m9  Pitch Styles and Situations       pitch     — analyst/story/demo pitches
//   m10 Reading the Door in Five Seconds  opener    — state read before the open
//   m11 The Kinetic Pitch Framework       pitch     — situational Kinetic pitches
//   m12 Objection Killers                 objection — every field objection
//   m13 Card on File the Compliant Way    compliance— secure payment handling
//   m14 The Installation Close            close     — two-day choice, soft commit
//   m15 Door Discipline and the Daily System mindset — pacing, logging
//   m16 The Knocker's Math                mindset   — unit economics of knocking
//   m17 The Buildout Window               followup  — timing passes, second passes
//   m18 Advanced Objection Mastery        objection — triage, deep-dives
//   m19 The Follow-Up Fortune             followup  — callbacks, referrals
//   m20 Magic Words and the Sound of the Close close — verbatim lines, tonality
//   m21 The Team Lead's Operating System  mindset   — huddles, scorecards
//   m22 Compliance Is the Pitch           compliance— cooling-off, territory law
//   m23 How to Think About Doors          mindset   — streaks, cancels, shutdown
export const MODULE_STAGE_TABLE: Readonly<Record<string, DoorStage>> = {
  m1: "mindset",
  m2: "opener",
  m3: "pitch",
  m4: "discovery",
  m5: "objection",
  m6: "close",
  m7: "close",
  m8: "pitch",
  m9: "pitch",
  m10: "opener",
  m11: "pitch",
  m12: "objection",
  m13: "compliance",
  m14: "close",
  m15: "mindset",
  m16: "mindset",
  m17: "followup",
  m18: "objection",
  m19: "followup",
  m20: "close",
  m21: "mindset",
  m22: "compliance",
  m23: "mindset",
};

/** Per-lesson overrides where a lesson's job differs from its module default. */
export const LESSON_STAGE_OVERRIDES: Readonly<Record<string, DoorStage>> = {
  "m6-callback": "followup", // booking returns, not closing today
  "m6-debrief": "followup", // post-door logging feeds the next pass
  "m11-opener-structure": "opener", // the opener lesson inside a pitch module
  "m15-compliance-safety": "compliance", // safety/legal lesson inside a discipline module
};

/** Stage for a card: lesson override first, then its module's table entry. */
export function getDoorStage(moduleId: string, lessonId: string): DoorStage {
  return LESSON_STAGE_OVERRIDES[lessonId] ?? MODULE_STAGE_TABLE[moduleId] ?? "mindset";
}

export type DrillCardId = `card:${string}:${CardKind}:${number}`;

export type DrillCard = {
  /** Deterministic: card:{lessonId}:{kind}:{index}, index 0-based per lesson+kind. */
  id: DrillCardId;
  lessonId: string;
  moduleId: string;
  kind: CardKind;
  stage: DoorStage;
  /** Set only on objection cards; null everywhere else. */
  objectionKey: ObjectionKey | null;
  front: string;
  back: string;
  /** Psychology line on objection cards that carry one. */
  note?: string;
  /** Deck neighbors (≤1 each; empty at the ends). */
  prevCardIds: readonly DrillCardId[];
  nextCardIds: readonly DrillCardId[];
};

const CARD_ID_PATTERN = /^card:[a-z0-9-]+:(takeaway|say-this|objection|script|drill):\d+$/;

/** Validates the shape of a drill-card id (round-trips every id this module
 *  mints; rejects anything it could not have minted). */
export function isDrillCardId(value: unknown): value is DrillCardId {
  return typeof value === "string" && CARD_ID_PATTERN.test(value);
}

/** Leading clause of a takeaway: the text before the first " — ", ": ", or
 *  sentence boundary, when that boundary leaves a meaningful stem (≥12 chars);
 *  otherwise the whole takeaway. Deterministic by construction. */
function takeawayStem(takeaway: string): string {
  const boundaries = [" — ", ": ", ". "];
  let cut = -1;
  for (const b of boundaries) {
    const i = takeaway.indexOf(b);
    if (i >= 0 && (cut === -1 || i < cut)) cut = i;
  }
  if (cut >= 12) return takeaway.slice(0, cut);
  return takeaway;
}

/** The "next 10 doors" guidance inside a drill prompt: its sentences that
 *  mention the 10-door rep scheme, or the standard fallback when a prompt
 *  uses a different rep scheme (role-play rounds, weekly builds). */
function nextTenDoorsGuidance(drillPrompt: string): string {
  const sentences = drillPrompt.split(/(?<=[.!?])\s+/);
  const hits = sentences.filter((s) => /\b10 doors\b/i.test(s));
  if (hits.length > 0) return hits.join(" ");
  return "Take this to your next 10 doors: apply the drill at each door, log what happens, and review what changed by door 10.";
}

/** Objection cue for a card front: the section heading with one layer of
 *  wrapping double quotes stripped (m12/m18 headings quote the verbatim cue). */
function objectionCue(heading: string): string {
  const t = heading.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

function cardId(lessonId: string, kind: CardKind, index: number): DrillCardId {
  return `card:${lessonId}:${kind}:${index}`;
}

type CardSeed = Omit<DrillCard, "prevCardIds" | "nextCardIds">;

function seedsForLesson(module: TrainingModule, lesson: TrainingLesson): CardSeed[] {
  const stage = getDoorStage(module.id, lesson.id);
  const seeds: CardSeed[] = [];

  lesson.keyTakeaways.forEach((takeaway, i) => {
    seeds.push({
      id: cardId(lesson.id, "takeaway", i),
      lessonId: lesson.id,
      moduleId: module.id,
      kind: "takeaway",
      stage,
      objectionKey: null,
      front: takeawayStem(takeaway),
      back: takeaway,
    });
  });

  // Objection cards: only objection-titled sections (m5/m12/m18 carry them).
  let objectionIndex = 0;
  for (const section of lesson.sections) {
    const key = objectionKeyForHeading(section.heading);
    if (!key) continue;
    // A paragraph opening with "The psychology:" is the note, not the response.
    const notePara = section.body.find((p) => p.startsWith("The psychology:"));
    const response = section.body.filter((p) => p !== notePara).join("\n\n");
    seeds.push({
      id: cardId(lesson.id, "objection", objectionIndex++),
      lessonId: lesson.id,
      moduleId: module.id,
      kind: "objection",
      stage,
      objectionKey: key,
      front: objectionCue(section.heading),
      back: response,
      ...(notePara ? { note: notePara } : {}),
    });
  }

  if (lesson.pitchDrill) {
    seeds.push({
      id: cardId(lesson.id, "script", 0),
      lessonId: lesson.id,
      moduleId: module.id,
      kind: "script",
      stage,
      objectionKey: null,
      front: `Rehearse out loud: ${lesson.title}. ${lesson.summary}`,
      back: lesson.pitchDrill,
    });
  }

  seeds.push({
    id: cardId(lesson.id, "drill", 0),
    lessonId: lesson.id,
    moduleId: module.id,
    kind: "drill",
    stage,
    objectionKey: null,
    front: lesson.drillPrompt,
    back: nextTenDoorsGuidance(lesson.drillPrompt),
  });

  return seeds;
}

function buildDeck(): DrillCard[] {
  const seeds: CardSeed[] = [];
  for (const module of TRAINING_MODULES) {
    if (module.sayThisNotThat && module.lessons.length > 0) {
      // Module-level swap, attributed to the module's first lesson.
      const firstLesson = module.lessons[0];
      seeds.push({
        id: cardId(firstLesson.id, "say-this", 0),
        lessonId: firstLesson.id,
        moduleId: module.id,
        kind: "say-this",
        stage: getDoorStage(module.id, firstLesson.id),
        objectionKey: null,
        front: module.sayThisNotThat.instead,
        back: module.sayThisNotThat.say,
      });
    }
    for (const lesson of module.lessons) seeds.push(...seedsForLesson(module, lesson));
  }

  return seeds.map((seed, i) =>
    Object.freeze({
      ...seed,
      prevCardIds: Object.freeze(i > 0 ? [seeds[i - 1].id] : []),
      nextCardIds: Object.freeze(i < seeds.length - 1 ? [seeds[i + 1].id] : []),
    }),
  );
}

const DECK: readonly DrillCard[] = Object.freeze(buildDeck());
const DECK_BY_ID: ReadonlyMap<string, DrillCard> = new Map(DECK.map((c) => [c.id, c]));

/** The full drill deck in deterministic order (frozen — do not mutate). */
export function buildDrillDeck(): readonly DrillCard[] {
  return DECK;
}

/** Lookup by id; undefined for anything that is not a minted card id. */
export function getDrillCard(id: string): DrillCard | undefined {
  return DECK_BY_ID.get(id);
}

/** All objection cards for one taxonomy key (empty for named gap keys). */
export function cardsByObjection(key: ObjectionKey): DrillCard[] {
  return DECK.filter((c) => c.kind === "objection" && c.objectionKey === key);
}

/** All cards (any kind) belonging to one door stage. */
export function cardsByStage(stage: DoorStage): DrillCard[] {
  return DECK.filter((c) => c.stage === stage);
}
