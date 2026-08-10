// ── Academy personas ──────────────────────────────────────────────────────────
//
// Ten customers a rep actually meets on a residential fiber route. Each one is
// a data record, not a script: the role-play engine (shared/academyRolePlay.ts)
// reads these fields to decide how the door behaves, and the branching lessons
// read the same records so a persona cannot mean one thing in practice and
// another in a quiz.
//
// WHAT MAKES A PERSONA REAL
//   Three things, and they are all here as data:
//     patience     how many turns of nothing-useful before the door closes.
//                  A busy homeowner is not "rude", they have four minutes.
//     wins/loses   the specific signals that move them. A gamer moves on
//                  latency and upload; a senior resident moves on the install
//                  being handled and nobody phoning them afterwards.
//     objections   the order they raise concerns in. Not a random draw: a
//                  price-sensitive household asks the price FIRST and hears
//                  nothing until it is answered.
//
// NOTHING HERE QUOTES A NUMBER. Personas reference offer fields; the live
// figures come from shared/academyOffers.ts against the rep's own market.

import type { ObjectionKey } from "./trainingObjections";

/** Stable persona id. Stored on role-play sessions, so never rename. */
export type PersonaId =
  | "busy_homeowner"
  | "renter"
  | "skeptic"
  | "spectrum_customer"
  | "price_sensitive"
  | "remote_worker"
  | "gamer"
  | "senior_resident"
  | "former_kinetic"
  | "satisfied_customer";

/** What the rep can do that this person responds to. Scoring reads these too:
 *  a benefit that lands for a gamer is not the same benefit that lands for a
 *  senior resident, and "benefit alignment" means matching THIS list. */
export type PersonaSignal =
  | "acknowledges_time"
  | "asks_permission"
  | "names_the_street"
  | "asks_about_household"
  | "asks_about_current_service"
  | "upload_speed"
  | "latency"
  | "work_calls"
  | "streaming"
  | "many_devices"
  | "price_transparency"
  | "no_contract"
  | "install_handled"
  | "local_crew"
  | "landlord_friendly"
  | "verifiable_proof"
  | "leaves_politely"
  | "written_details";

export type Persona = {
  id: PersonaId;
  /** First name only. A door is not a CRM record. */
  name: string;
  /** The label a rep picks from. Plain, no adjectives that flatter the rep. */
  label: string;
  /** One line the supervisor dashboard uses to explain why this drill exists. */
  summary: string;
  /** How they answer the door, before the rep has said anything. */
  openingLine: string;
  /** Turns of low-value conversation this person tolerates before leaving.
   *  Every turn that lands a signal they care about buys one back. */
  patience: number;
  /** Signals that move this person toward listening. */
  wins: PersonaSignal[];
  /** Signals whose ABSENCE costs the rep. Used for coaching, not punishment:
   *  "you never asked what they use it for" is the note this produces. */
  expects: PersonaSignal[];
  /** The concerns they raise, in the order they raise them. */
  objections: ObjectionKey[];
  /** What the rep should understand before opening their mouth. Shown as the
   *  briefing card before a role-play starts, hidden during it. */
  briefing: string[];
  /** The line they say when they end the conversation on their own terms. */
  exitLine: string;
  /** The line they say when the rep has earned the next step. */
  agreeLine: string;
};

export const ACADEMY_PERSONAS: readonly Persona[] = [
  {
    id: "busy_homeowner",
    name: "Dana",
    label: "Busy homeowner",
    summary: "Answers mid-task with something on the stove. Not hostile, just spent.",
    openingLine: "Hey, sorry, I've got something on the stove. What is this about?",
    patience: 3,
    wins: ["acknowledges_time", "names_the_street", "install_handled", "written_details"],
    expects: ["acknowledges_time", "asks_permission"],
    objections: ["too_busy", "leave_something", "spouse"],
    briefing: [
      "She is not saying no. She is saying not like this, not right now.",
      "The single highest-value move is naming the time cost up front and holding to it.",
      "If you run past the time you asked for, you have taught her that your word is soft.",
    ],
    exitLine: "I really do have to go. Sorry.",
    agreeLine: "Okay, that's actually useful. What would the next step look like?",
  },
  {
    id: "renter",
    name: "Marcus",
    label: "Renter",
    summary: "Rents the house, assumes internet decisions are not his to make.",
    openingLine: "Oh, I rent. You'd probably need to talk to the owner.",
    patience: 4,
    wins: ["landlord_friendly", "no_contract", "install_handled", "price_transparency"],
    expects: ["asks_about_current_service"],
    objections: ["renter", "spouse", "price"],
    briefing: [
      "Renters buy their own internet constantly. The assumption that they cannot is the obstacle, not the lease.",
      "What he actually needs to know: whether anything gets drilled, whether he can take it with him, and whether he is signing a term he cannot exit.",
      "Do not tell him what his lease says. Ask what it says.",
    ],
    exitLine: "Yeah, I'd rather not deal with it. Thanks though.",
    agreeLine: "Huh. So I wouldn't need the landlord for that part?",
  },
  {
    id: "skeptic",
    name: "Ray",
    label: "Skeptic",
    summary: "Has been burned by a door salesman before and expects to be again.",
    openingLine: "Let me guess. You're going to tell me my bill is going down.",
    patience: 5,
    wins: ["verifiable_proof", "price_transparency", "no_contract", "leaves_politely"],
    expects: ["verifiable_proof"],
    objections: ["scam", "not_interested", "price", "no_card"],
    briefing: [
      "He is testing whether you will overclaim. Every unsupported number you say confirms his read of you.",
      "The move that works is being the first person at his door to say what you do not know.",
      "Pushing harder makes him more certain he was right. Slowing down does not.",
    ],
    exitLine: "Right. That's what I thought. Have a good one.",
    agreeLine: "Okay. You're the first one who didn't dodge that. Keep going.",
  },
  {
    id: "spectrum_customer",
    name: "Priya",
    label: "Existing Spectrum customer",
    summary: "Under contract with cable, mostly content, mildly annoyed about upload.",
    openingLine: "We're with Spectrum. I think we're in a contract until spring.",
    patience: 5,
    wins: ["upload_speed", "price_transparency", "asks_about_current_service", "no_contract"],
    expects: ["asks_about_current_service"],
    objections: ["happy_provider", "already_have", "price"],
    briefing: [
      "Do not attack her provider. She chose it, and criticising the choice criticises her.",
      "The honest contrast is technical and checkable: cable upload is a fraction of its download; fiber is symmetrical.",
      "A contract is a date, not a wall. Find out the date.",
    ],
    exitLine: "We're fine for now. Maybe come back in the spring.",
    agreeLine: "Wait, the upload is actually the thing that annoys me. Say more.",
  },
  {
    id: "price_sensitive",
    name: "Tonya",
    label: "Price-sensitive household",
    summary: "Running a tight household budget. Every dollar is already assigned.",
    openingLine: "How much? That's the only part I care about.",
    patience: 4,
    wins: ["price_transparency", "no_contract", "install_handled", "written_details"],
    expects: ["price_transparency"],
    objections: ["price", "spouse", "think_about_it"],
    briefing: [
      "She will not hear a single benefit until the number is on the table. Answer the price question first, plainly.",
      "Hiding the price to build value reads as a trick, because it usually is one.",
      "Total monthly cost matters more than the headline: equipment, install, and what happens when a promotion ends.",
    ],
    exitLine: "That's more than I've got. Thanks anyway.",
    agreeLine: "Okay, and that's the real number? Nothing gets added later?",
  },
  {
    id: "remote_worker",
    name: "Elena",
    label: "Remote worker",
    summary: "Works from home full time. Her calls dropping is a work problem, not an annoyance.",
    openingLine: "I'm actually on a call in ten minutes, so make it quick.",
    patience: 4,
    wins: ["work_calls", "upload_speed", "install_handled", "acknowledges_time"],
    expects: ["asks_about_household", "acknowledges_time"],
    objections: ["too_busy", "already_have", "price"],
    briefing: [
      "Her pain is specific and she has felt it this week: freezing on camera while someone says you're breaking up.",
      "Upload is the mechanism behind that, and it is the number her current plan is worst at.",
      "An install that costs her a working day is a real objection, not a stall.",
    ],
    exitLine: "I have to hop on. Sorry.",
    agreeLine: "Okay, the camera thing is real. What does the install actually involve?",
  },
  {
    id: "gamer",
    name: "Jae",
    label: "Gamer",
    summary: "Knows more about the network than the rep does. Will check every claim.",
    openingLine: "What's the ping look like? And is it actually symmetrical?",
    patience: 5,
    wins: ["latency", "upload_speed", "many_devices", "verifiable_proof"],
    expects: ["latency"],
    objections: ["already_have", "price", "scam"],
    briefing: [
      "He will catch a wrong number instantly, and one wrong number ends the conversation.",
      "If you do not know the latency figure, say you do not know it. He respects that more than a guess.",
      "Speak plainly about what fiber does and does not fix. It does not fix a bad game server.",
    ],
    exitLine: "Yeah, you don't actually know. I'm good.",
    agreeLine: "Alright, that's a straight answer. What's the upload again?",
  },
  {
    id: "senior_resident",
    name: "Walter",
    label: "Senior resident",
    summary: "Lived here forty years. Cautious about strangers and about changing what works.",
    openingLine: "I'm sorry, who are you with? I didn't catch that.",
    patience: 6,
    wins: ["install_handled", "local_crew", "price_transparency", "written_details", "leaves_politely"],
    expects: ["install_handled", "written_details"],
    objections: ["scam", "already_have", "spouse", "leave_something"],
    briefing: [
      "Slow down and say your name and company twice. He asked once because he did not hear it, not to stall.",
      "The thing that worries him is disruption: someone in the house, a day lost, a bill he did not expect.",
      "Never rush him toward a decision. Pressure on a senior resident is both wrong and a compliance problem.",
    ],
    exitLine: "I don't think so, but thank you for stopping by.",
    agreeLine: "Well. That does sound simpler than I expected. Do you have that in writing?",
  },
  {
    id: "former_kinetic",
    name: "Bree",
    label: "Previous Kinetic customer",
    summary: "Left years ago after a bad stretch on the old copper network. Still annoyed.",
    openingLine: "We had Kinetic. It was terrible. Not doing that again.",
    patience: 4,
    wins: ["verifiable_proof", "local_crew", "no_contract", "install_handled"],
    expects: ["verifiable_proof"],
    objections: ["bad_experience", "not_interested", "price"],
    briefing: [
      "Her experience was real. Arguing with it is the fastest way to lose the door.",
      "What changed is the physical network, not a promise: copper to fiber is a different line into the house.",
      "Acknowledge first, and let her tell you what happened before you say a single thing about today.",
    ],
    exitLine: "No. We've been through this before. Have a good day.",
    agreeLine: "So it's not the same line? That's different, I guess.",
  },
  {
    id: "satisfied_customer",
    name: "Chris",
    label: "Satisfied current-provider customer",
    summary: "Genuinely happy with what he has. There may be no sale here, and that is fine.",
    openingLine: "Honestly, ours works great. I don't think we need anything.",
    patience: 4,
    wins: ["asks_about_current_service", "price_transparency", "leaves_politely", "written_details"],
    expects: ["leaves_politely"],
    objections: ["happy_provider", "already_have", "not_interested"],
    briefing: [
      "Sometimes the correct outcome is a polite exit and a good impression. This drill scores that as a win.",
      "The only honest opening is a comparison he can check himself: what he pays, and what he gets for it.",
      "If he says no twice, pushing a third time is the wrong answer here, and the scoring reflects that.",
    ],
    exitLine: "We're all set, but thanks for being straight with me.",
    agreeLine: "Actually, what are we paying for upload? Now I want to look.",
  },
];

const BY_ID: ReadonlyMap<PersonaId, Persona> = new Map(ACADEMY_PERSONAS.map((p) => [p.id, p]));

export function getPersona(id: string): Persona | undefined {
  return BY_ID.get(id as PersonaId);
}

export function isPersonaId(value: unknown): value is PersonaId {
  return typeof value === "string" && BY_ID.has(value as PersonaId);
}

/** Personas that raise a given objection, for the objection dojo's "practice
 *  this against a real person" jump. */
export function personasRaising(key: ObjectionKey): Persona[] {
  return ACADEMY_PERSONAS.filter((p) => p.objections.includes(key));
}

/** Human label for a signal, used in coaching notes and the briefing card. */
export const SIGNAL_LABELS: Readonly<Record<PersonaSignal, string>> = {
  acknowledges_time: "naming the time this will take",
  asks_permission: "asking permission before continuing",
  names_the_street: "referring to work on their actual street",
  asks_about_household: "asking who uses the internet in the house",
  asks_about_current_service: "asking what they have now",
  upload_speed: "upload speed",
  latency: "latency and responsiveness",
  work_calls: "video calls that hold up",
  streaming: "streaming without buffering",
  many_devices: "several devices at once",
  price_transparency: "a plain, total monthly number",
  no_contract: "no term commitment",
  install_handled: "the install being handled for them",
  local_crew: "a local crew they can identify",
  landlord_friendly: "nothing that needs a landlord's permission",
  verifiable_proof: "something they can check themselves",
  leaves_politely: "leaving well when the answer is no",
  written_details: "something in writing to look at later",
};
