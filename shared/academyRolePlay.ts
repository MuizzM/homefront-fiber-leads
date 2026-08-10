// ── Role-play engine ──────────────────────────────────────────────────────────
//
// A simulated door, driven entirely by rules in this file. No model call, no
// network, no third-party service: the whole conversation is a pure function of
// (persona, seed, what the rep said). That is a deliberate constraint and it
// buys three things a hosted model would not.
//
//   Reproducible   The same seed and the same rep turns produce the same
//                  customer, every time, so a coaching note can point at turn
//                  four and a test can assert turn four.
//   Offline        A rep in a dead zone between houses can still run a drill.
//   Auditable      A supervisor can read WHY the customer walked away. The
//                  reason is a rule with a name, not a sampled token.
//
// HOW A TURN WORKS
//   1. classify() reads the rep's sentence and reports what it contains:
//      intents (permission, discovery, benefit, close), persona signals it
//      landed, and violations (pressure, unsupported claims).
//   2. The persona's patience moves. Landing something they care about buys a
//      turn. Saying nothing useful spends one. Pressure spends two and is
//      recorded.
//   3. The customer answers according to the state they are now in: they
//      soften, they ask a follow-up, they raise their next concern, they press
//      the one you dodged, or they end it.
//
// CLASSIFICATION IS LEXICAL AND HONEST ABOUT IT
//   These are keyword and shape rules, not comprehension. They are tuned to be
//   conservative: a turn that does not clearly do a thing is not credited with
//   doing it. Under-crediting produces a coaching note the rep can argue with;
//   over-crediting produces a score they cannot trust.

import { OBJECTION_TAXONOMY, type ObjectionKey } from "./trainingObjections";
import { getPersona, type Persona, type PersonaId, type PersonaSignal } from "./academyPersonas";
import { verifyClaim, type AcademyOffer } from "./academyOffers";

// ── Deterministic randomness ──────────────────────────────────────────────────
// mulberry32: tiny, fast, and reproducible from a 32-bit seed. Used only to
// pick between equally valid customer lines so two runs of the same drill do
// not read identically, while a replay of a stored session does.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string, so a session id is a usable seed. */
export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── Turn shapes ───────────────────────────────────────────────────────────────

export type ConversationStage = "opening" | "discovery" | "pitch" | "objection" | "closing" | "ended";

export type RepIntent =
  | "identity"
  | "reason"
  | "permission"
  | "discovery"
  | "benefit"
  | "proof"
  | "price"
  | "empathy"
  | "label"
  | "close"
  | "exit"
  | "filler";

export type ViolationKind = "pressure" | "unsupported_claim" | "ignored_no" | "disparagement";

export type Violation = {
  kind: ViolationKind;
  fragment: string;
  message: string;
};

export type RepTurn = {
  role: "rep";
  text: string;
  intents: RepIntent[];
  signals: PersonaSignal[];
  violations: Violation[];
  /** Word count, used by the clarity rubric. */
  words: number;
  /** Turn index in the transcript, for coaching that points at a moment. */
  index: number;
};

export type CustomerTurn = {
  role: "customer";
  text: string;
  /** Set when this turn raises a concern the rep must handle. */
  objection?: ObjectionKey;
  /** Why the customer said this, in engine terms. Rendered to supervisors. */
  reason: "opening" | "soften" | "followup" | "objection" | "press" | "exit" | "agree";
  index: number;
};

export type Turn = RepTurn | CustomerTurn;

export type RolePlayOutcome = "in_progress" | "advanced" | "polite_exit" | "door_closed" | "walked_away";

export type RolePlaySession = {
  /** Client-generated id. Seeds the engine and keys the stored transcript. */
  id: string;
  personaId: PersonaId;
  /** The market the drill is set in, so offers resolve the way they would live. */
  market: string;
  stage: ConversationStage;
  turns: Turn[];
  /** Turns of tolerance left. Zero ends the conversation on the next reply. */
  patience: number;
  /** 0 to 5. Rises when the rep lands what this person cares about. */
  warmth: number;
  /** Objections already raised, in order. */
  raised: ObjectionKey[];
  /** The concern currently on the table, unanswered. */
  openObjection: ObjectionKey | null;
  /** How many times the customer has said no in a row. Third push is the
   *  compliance line: at two, walking away is the correct answer. */
  refusals: number;
  outcome: RolePlayOutcome;
  /** Signals landed at any point, deduped. Feeds benefit alignment scoring. */
  signalsHit: PersonaSignal[];
  /** Every violation across the session, in order. */
  violations: Violation[];
};

// ── Lexicons ──────────────────────────────────────────────────────────────────
// Kept as flat arrays of lowercase fragments. Matching is substring-on-word-
// boundaries, which is crude and correct enough: these decide whether to credit
// a rep with asking permission, not whether a sentence is grammatical.

const L = {
  identity: ["my name is", "i'm with", "i am with", "i work with", "i'm from", "i am from", "this is", "i'm ", "name's"],
  company: ["kinetic", "homefront", "home front", "fiber team", "the build", "fiber crew"],
  reason: ["fiber", "the build", "building out", "running fiber", "in the neighborhood", "on your street", "on this street", "down the road", "in the area"],
  permission: ["do you have a", "got a minute", "got a second", "is now a bad time", "bad time", "can i ask", "mind if i", "may i ask", "is this a good time", "thirty seconds", "30 seconds", "two minutes", "quick question"],
  discoveryOpeners: ["who ", "what ", "when ", "where ", "how ", "which ", "do you", "are you", "is there", "does anyone", "have you", "would you", "could you", "tell me"],
  // Includes the ways reps actually acknowledge a bad experience, which is the
  // highest-value empathy moment in this job. A driven session showed "I believe
  // every word of that" going uncredited, which is the exact line the
  // bad-experience ladder teaches.
  empathy: ["that makes sense", "i hear you", "fair enough", "that's fair", "totally fair", "i understand", "i get that", "you're right", "makes sense", "i appreciate", "sorry to hear", "that's frustrating", "i believe you", "i believe every word", "i don't blame you", "i'm not going to tell you", "that's understandable", "you're not wrong", "i'm not going to defend"],
  label: ["sounds like", "seems like", "it sounds like", "so what i'm hearing", "what i'm hearing", "you're saying", "if i'm hearing"],
  close: ["thursday", "saturday", "which works", "what works better", "next step", "get you scheduled", "book you", "set up a time", "install date", "morning or afternoon", "would you want", "should we", "let's get", "sign you up", "get started"],
  exit: ["i'll let you go", "let you get back", "thanks for your time", "have a good", "appreciate your time", "i'll leave you", "no problem at all", "sorry to bother"],
  proof: ["neighbor", "next door", "down the street", "on maple", "the corner house", "you can check", "look it up", "i can show you", "here's my badge", "my badge", "id badge", "the crew", "our crew", "the truck"],
  price: ["$", " dollar", "per month", "a month", "monthly", "costs", "price", "pricing", "the bill"],
  pressure: [
    "you'd be crazy", "you'd be stupid", "everyone else on this street already",
    "this is your last chance", "today only", "i need an answer right now",
    "just sign here", "trust me", "what's the problem", "why not",
    "you're going to regret", "i'm not leaving until", "come on",
    "just give me your card", "let me just take your",
  ],
  disparage: ["spectrum is garbage", "spectrum sucks", "they're ripping you off", "they're scamming", "your provider is terrible", "that company is trash", "they lie to you"],
  refusalWords: ["not interested", "no thank", "no thanks", "we're good", "i'm good", "not right now", "no", "nope"],
};

/** Signals a benefit sentence can land, by the words that carry them. */
const SIGNAL_LEXICON: Readonly<Record<PersonaSignal, string[]>> = {
  acknowledges_time: ["thirty seconds", "30 seconds", "two minutes", "one minute", "won't take long", "i'll be quick", "then i'm gone", "and i'm out of your hair"],
  asks_permission: L.permission,
  names_the_street: ["your street", "this street", "this block", "your block", "the corner", "down the road here", "your neighborhood"],
  asks_about_household: ["how many", "who else", "anyone else", "in the house", "your household", "kids", "family", "everyone's on"],
  asks_about_current_service: ["who do you have", "what do you have now", "who are you with", "your current", "what are you paying", "your bill", "what provider"],
  upload_speed: ["upload", "uploading", "symmetrical", "same speed up", "up and down"],
  latency: ["latency", "ping", "lag", "responsive", "jitter"],
  work_calls: ["video call", "zoom", "teams call", "work from home", "wfh", "on camera", "freezing on calls", "breaking up on calls", "conference call"],
  streaming: ["streaming", "netflix", "buffering", "buffer", "4k", "watch tv", "youtube"],
  many_devices: ["devices", "everyone at once", "all at the same time", "multiple", "at the same time", "whole house"],
  price_transparency: ["total", "out the door", "nothing hidden", "no hidden", "flat", "that's the price", "all in", "what you see"],
  no_contract: ["no contract", "month to month", "no term", "cancel anytime", "not locked in", "no commitment"],
  install_handled: ["install", "installation", "technician", "tech comes out", "we handle", "we take care of", "two hour window", "appointment"],
  local_crew: ["local crew", "our crew", "the guys", "based here", "local team", "same crew", "crew is local", "crew doing your street", "crew on your street", "crew working your street"],
  landlord_friendly: ["landlord", "lease", "property owner", "renter", "renting", "nothing permanent", "take it with you"],
  verifiable_proof: ["you can check", "look it up", "in writing", "here's the", "my badge", "i can show you", "verify", "i don't know", "i'd have to check", "i won't guess"],
  leaves_politely: L.exit,
  written_details: ["in writing", "leave you", "card", "flyer", "paper", "email you", "text you the details", "something to look at"],
};

// ── Classification ────────────────────────────────────────────────────────────

function has(haystack: string, needles: string[]): string | null {
  for (const n of needles) {
    if (haystack.includes(n)) return n;
  }
  return null;
}

function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.includes("?")) return true;
  return L.discoveryOpeners.some((o) => t.startsWith(o));
}

export type Classification = {
  intents: RepIntent[];
  signals: PersonaSignal[];
  violations: Violation[];
  words: number;
};

/**
 * Read one rep utterance. `offers` are the market's live offers, used to flag
 * numbers the rep is not allowed to say; pass an empty array to skip the check
 * (the Pitch Lab does its own, richer pass).
 */
export function classify(text: string, offers: AcademyOffer[] = []): Classification {
  const lower = ` ${text.toLowerCase().replace(/\s+/g, " ").trim()} `;
  const intents = new Set<RepIntent>();
  const signals = new Set<PersonaSignal>();
  const violations: Violation[] = [];
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  if (has(lower, L.identity) && has(lower, L.company)) intents.add("identity");
  if (has(lower, L.reason)) intents.add("reason");
  if (has(lower, L.permission)) intents.add("permission");
  if (has(lower, L.empathy)) intents.add("empathy");
  if (has(lower, L.label)) intents.add("label");
  if (has(lower, L.proof)) intents.add("proof");
  if (has(lower, L.price)) intents.add("price");
  if (has(lower, L.close)) intents.add("close");
  if (has(lower, L.exit)) intents.add("exit");

  for (const [signal, words_] of Object.entries(SIGNAL_LEXICON) as [PersonaSignal, string[]][]) {
    if (has(lower, words_)) signals.add(signal);
  }
  // A question about the household or their current service is discovery; any
  // other question is still a question, but it is not credited as discovery.
  if (isQuestion(text)) {
    if (signals.has("asks_about_household") || signals.has("asks_about_current_service")) {
      intents.add("discovery");
    }
  }
  if (signals.size && !intents.has("discovery")) {
    // Mentioning something the persona cares about, outside a question, is a
    // benefit statement.
    const benefitCarrying: PersonaSignal[] = [
      "upload_speed", "latency", "work_calls", "streaming", "many_devices",
      "price_transparency", "no_contract", "install_handled", "landlord_friendly",
    ];
    if (benefitCarrying.some((s) => signals.has(s))) intents.add("benefit");
  }

  const pressure = has(lower, L.pressure);
  if (pressure) {
    violations.push({
      kind: "pressure",
      fragment: pressure.trim(),
      message: "That is pressure, not persuasion. It costs the door and it is not something this program teaches.",
    });
  }
  const disparage = has(lower, L.disparage);
  if (disparage) {
    violations.push({
      kind: "disparagement",
      fragment: disparage.trim(),
      message: "Attacking their provider attacks their judgment. Compare on facts instead.",
    });
  }
  for (const issue of verifyClaim(text, offers)) {
    violations.push({
      kind: "unsupported_claim",
      fragment: issue.fragment,
      message: issue.message,
    });
  }

  if (!intents.size) intents.add("filler");
  return { intents: [...intents], signals: [...signals], violations, words };
}

// ── Customer voice ────────────────────────────────────────────────────────────
// Persona-specific lines for the objections that persona actually raises. The
// taxonomy cue is the fallback so a persona can be handed any objection key
// (the objection dojo does this) without the engine going silent.

const PERSONA_OBJECTION_LINES: Readonly<Record<string, string[]>> = {
  "busy_homeowner:too_busy": ["Look, I've got maybe a minute before this burns.", "This really isn't a good time."],
  "busy_homeowner:leave_something": ["Can you just leave a flyer or something?", "Do you have a card? I'll look at it later."],
  "busy_homeowner:spouse": ["My husband handles all the utility stuff, honestly.", "I'd have to run it by him first."],
  "renter:renter": ["I rent, though. Doesn't that have to go through the owner?", "It's not my house, so I don't know if I can do that."],
  "renter:spouse": ["My roommate pays the internet bill, so it's not just me.", "I'd have to check with the person I live with."],
  "renter:price": ["What's it run a month? I'm splitting it two ways.", "How much are we talking?"],
  "skeptic:scam": ["How do I know you're actually with them and not just some guy?", "Yeah, everybody says that. How do I know this is real?"],
  "skeptic:not_interested": ["I'm not interested in whatever this is.", "Not interested. I've heard the pitch before."],
  "skeptic:price": ["And what's the catch on the price? There's always a catch.", "So what's it actually cost after the first six months?"],
  "skeptic:no_card": ["I'm not giving my card to somebody on my porch.", "You want a card number? At the door? No."],
  "spectrum_customer:happy_provider": ["We've been with Spectrum for years and it's been okay.", "Honestly, Spectrum's been fine for us."],
  "spectrum_customer:already_have": ["We already have internet, so I don't really see the point.", "We've got service. It works."],
  "spectrum_customer:price": ["We're paying somewhere around what we expected. Why would I switch?", "Is it actually cheaper, or is that a first-year thing?"],
  "price_sensitive:price": ["What's the monthly? Just the number.", "Okay but what does it actually cost me every month?"],
  "price_sensitive:spouse": ["I'd have to talk to my husband before we changed anything.", "That's not a call I make on my own."],
  "price_sensitive:think_about_it": ["I'd need to think about it and look at the budget.", "Let me sit with it."],
  "remote_worker:too_busy": ["I've got a call in a few minutes, so.", "I really can't do this right now."],
  "remote_worker:already_have": ["We have internet. It's not great, but we have it.", "We're already connected, so."],
  "remote_worker:price": ["What's it cost? I'm expensing part of it.", "How much a month?"],
  "gamer:already_have": ["I've already got a gig. What would I be gaining?", "I'm on cable and it's fine most nights."],
  "gamer:price": ["What's the actual monthly, not the promo?", "How much?"],
  "gamer:scam": ["You don't sound like you know the specs.", "Are you actually with them or a contractor?"],
  "senior_resident:scam": ["I've had people come around before who weren't who they said.", "How do I know you're really with the company?"],
  "senior_resident:already_have": ["We've had the same service for years. It's fine.", "I don't think we need anything different."],
  "senior_resident:spouse": ["I'd want to ask my daughter before I changed anything.", "My wife handles all that."],
  "senior_resident:leave_something": ["Could you leave something I can read?", "Do you have a paper or a card?"],
  "former_kinetic:bad_experience": ["We had Kinetic before and it went out constantly.", "Last time it took three weeks to get someone out here."],
  "former_kinetic:not_interested": ["I'm really not interested in going back.", "No. We did that already."],
  "former_kinetic:price": ["And I bet it costs more than it did then, too.", "How much, out of curiosity?"],
  "satisfied_customer:happy_provider": ["Ours honestly works great. No complaints.", "We're happy with what we've got."],
  "satisfied_customer:already_have": ["We're already set up, so I don't need anything.", "We've got service and it's fine."],
  "satisfied_customer:not_interested": ["I appreciate it, but I'm not interested.", "We're all set. Thanks though."],
};

/** Follow-up questions the customer asks when the rep lands a signal. This is
 *  what makes the door feel alive: land a real point and they lean in. */
const FOLLOWUP_BY_SIGNAL: Readonly<Partial<Record<PersonaSignal, string[]>>> = {
  upload_speed: ["What is the upload, actually?", "So the upload is the same as the download?"],
  latency: ["What kind of latency are we talking?", "Is that a real number or a marketing number?"],
  work_calls: ["Would that actually fix the calls freezing?", "That's my whole problem. Why does it happen?"],
  streaming: ["So it wouldn't buffer at night?", "Does that hold up with a few people watching?"],
  many_devices: ["We've got a lot of stuff connected. Does that matter?", "How many devices before it slows down?"],
  price_transparency: ["Is that the total, or does stuff get added?", "What's on the bill besides that?"],
  no_contract: ["So there's no contract at all?", "I could cancel if I hated it?"],
  install_handled: ["What does the install involve?", "How long does someone have to be here?"],
  landlord_friendly: ["Nothing gets drilled into the house?", "So I wouldn't need the owner's okay?"],
  local_crew: ["Is that crew local, or contracted out?", "Who actually shows up?"],
  written_details: ["Can you leave that in writing?", "Do you have something I can look at?"],
  verifiable_proof: ["Where would I check that?", "How would I verify that myself?"],
};

/** Lines the customer uses to press a concern the rep talked past. */
const PRESS_LINES = [
  "You didn't really answer what I asked.",
  "Okay, but that wasn't my question.",
  "Right, but what about what I just said?",
  "I hear you, but you skipped past my point.",
];

/** Lines the customer uses when the rep landed something. */
const SOFTEN_LINES = [
  "Okay. That's a fair point.",
  "Huh. I didn't know that.",
  "Alright, I'm listening.",
  "That's not what I expected you to say.",
];

function cueFor(key: ObjectionKey): string {
  return OBJECTION_TAXONOMY.find((e) => e.key === key)?.cue ?? "I'm not sure about this.";
}

function pick<T>(items: readonly T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length) % items.length];
}

function objectionLine(persona: Persona, key: ObjectionKey, rand: () => number): string {
  const lines = PERSONA_OBJECTION_LINES[`${persona.id}:${key}`];
  return lines ? pick(lines, rand) : cueFor(key);
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

export type StartOptions = {
  id: string;
  personaId: PersonaId;
  market: string;
};

export function startSession(opts: StartOptions): RolePlaySession {
  const persona = getPersona(opts.personaId);
  if (!persona) throw new Error(`unknown persona: ${opts.personaId}`);
  return {
    id: opts.id,
    personaId: persona.id,
    market: opts.market,
    stage: "opening",
    turns: [{ role: "customer", text: persona.openingLine, reason: "opening", index: 0 }],
    patience: persona.patience,
    warmth: 0,
    raised: [],
    openObjection: null,
    refusals: 0,
    outcome: "in_progress",
    signalsHit: [],
    violations: [],
  };
}

/** Stage the conversation should be in, given what has happened. Stages are a
 *  description, not a gate: a rep who closes in turn two is in "closing". */
function nextStage(current: ConversationStage, intents: RepIntent[], hasOpenObjection: boolean): ConversationStage {
  if (intents.includes("close")) return "closing";
  if (hasOpenObjection) return "objection";
  if (intents.includes("discovery")) return "discovery";
  if (intents.includes("benefit") || intents.includes("price")) return "pitch";
  if (current === "opening" && (intents.includes("identity") || intents.includes("reason"))) return "opening";
  return current;
}

/** True when the rep's turn actually addresses the concern on the table.
 *  Deliberately generous: acknowledging it, labelling it, or speaking to the
 *  signal behind it all count. Ignoring it entirely does not. */
function addressesObjection(key: ObjectionKey, c: Classification): boolean {
  if (c.intents.includes("empathy") || c.intents.includes("label")) return true;
  const bySignal: Partial<Record<ObjectionKey, PersonaSignal[]>> = {
    price: ["price_transparency", "no_contract"],
    renter: ["landlord_friendly", "no_contract"],
    too_busy: ["acknowledges_time", "written_details"],
    scam: ["verifiable_proof", "local_crew"],
    bad_experience: ["verifiable_proof", "local_crew", "install_handled"],
    happy_provider: ["asks_about_current_service", "upload_speed", "price_transparency"],
    already_have: ["asks_about_current_service", "upload_speed", "latency"],
    competitor_fiber: ["price_transparency", "no_contract"],
    spouse: ["written_details", "no_contract"],
    think_about_it: ["written_details", "price_transparency"],
    leave_something: ["written_details"],
    no_card: ["verifiable_proof", "price_transparency"],
    not_interested: ["acknowledges_time", "asks_about_current_service"],
    hoa: ["verifiable_proof", "local_crew"],
  };
  const wanted = bySignal[key] ?? [];
  return wanted.some((s) => c.signals.includes(s));
}

export type RespondOptions = {
  /** Live offers in the drill's market, for unsupported-claim detection. */
  offers?: AcademyOffer[];
};

/**
 * Advance the conversation by one exchange. Returns a NEW session; the input is
 * never mutated, so a caller can keep the prior state for an undo or a replay.
 */
export function respond(session: RolePlaySession, repText: string, opts: RespondOptions = {}): RolePlaySession {
  if (session.outcome !== "in_progress") return session;
  const persona = getPersona(session.personaId)!;
  const rand = mulberry32(seedFrom(`${session.id}:${session.turns.length}`));
  const c = classify(repText, opts.offers ?? []);

  const repTurn: RepTurn = {
    role: "rep",
    text: repText,
    intents: c.intents,
    signals: c.signals,
    violations: c.violations,
    words: c.words,
    index: session.turns.length,
  };

  const landed = c.signals.filter((s) => persona.wins.includes(s));
  const handledOpen = session.openObjection ? addressesObjection(session.openObjection, c) : false;
  const pressured = c.violations.some((v) => v.kind === "pressure");
  const unsupported = c.violations.some((v) => v.kind === "unsupported_claim");
  const disparaged = c.violations.some((v) => v.kind === "disparagement");

  // ── Patience ────────────────────────────────────────────────────────────────
  // Landing something they care about buys a turn back (capped at the persona's
  // own ceiling). Pressure costs two. An unsupported number costs the personas
  // who check things. Saying nothing useful costs one.
  let patience = session.patience;
  if (landed.length) patience = Math.min(persona.patience, patience + 1);
  if (handledOpen) patience = Math.min(persona.patience, patience + 1);
  if (!landed.length && !handledOpen) patience -= 1;
  if (pressured) patience -= 2;
  if (disparaged) patience -= 1;
  if (unsupported && persona.wins.includes("verifiable_proof")) patience -= 1;

  let warmth = session.warmth;
  if (landed.length) warmth = Math.min(5, warmth + landed.length);
  if (handledOpen) warmth = Math.min(5, warmth + 1);
  if (pressured || disparaged) warmth = Math.max(0, warmth - 2);
  if (unsupported) warmth = Math.max(0, warmth - 1);

  const signalsHit = [...new Set([...session.signalsHit, ...c.signals])];
  const violations = [...session.violations, ...c.violations];

  // A rep who leaves politely ends the drill on good terms. For the satisfied
  // customer this is the target outcome, not a consolation.
  if (c.intents.includes("exit") && !c.intents.includes("close")) {
    return {
      ...session,
      stage: "ended",
      turns: [...session.turns, repTurn, {
        role: "customer", text: persona.exitLine, reason: "exit", index: session.turns.length + 1,
      }],
      patience, warmth, signalsHit, violations,
      outcome: "polite_exit",
    };
  }

  // Third push after two refusals is where a drill has to stop being a drill.
  const refusals = session.refusals;
  if (refusals >= 2 && !c.intents.includes("exit")) {
    const v: Violation = {
      kind: "ignored_no",
      fragment: repText.slice(0, 60),
      message: "They said no twice. Continuing past a second refusal is the line this program will not teach you to cross.",
    };
    return {
      ...session,
      stage: "ended",
      turns: [...session.turns, { ...repTurn, violations: [...repTurn.violations, v] }, {
        role: "customer", text: persona.exitLine, reason: "exit", index: session.turns.length + 1,
      }],
      patience: 0, warmth: Math.max(0, warmth - 2), signalsHit,
      violations: [...violations, v],
      outcome: "door_closed",
    };
  }

  if (patience <= 0) {
    return {
      ...session,
      stage: "ended",
      turns: [...session.turns, repTurn, {
        role: "customer", text: persona.exitLine, reason: "exit", index: session.turns.length + 1,
      }],
      patience: 0, warmth, signalsHit, violations,
      outcome: pressured || disparaged ? "door_closed" : "walked_away",
    };
  }

  // ── The customer's reply ────────────────────────────────────────────────────
  const raised = [...session.raised];
  let openObjection = handledOpen ? null : session.openObjection;
  let reply: CustomerTurn;
  const nextIndex = session.turns.length + 1;

  const pending = persona.objections.find((o) => !raised.includes(o));
  const everythingRaised = !pending;
  const closing = c.intents.includes("close");

  if (pressured || disparaged) {
    openObjection = openObjection ?? pending ?? null;
    if (openObjection && !raised.includes(openObjection)) raised.push(openObjection);
    reply = {
      role: "customer",
      text: pressured
        ? "Okay, that's exactly the thing I don't like about this."
        : "I'm not going to sit here while you run down the company I pay.",
      reason: "press",
      index: nextIndex,
    };
  } else if (closing && everythingRaised && warmth >= 3) {
    return {
      ...session,
      stage: "ended",
      turns: [...session.turns, repTurn, {
        role: "customer", text: persona.agreeLine, reason: "agree", index: nextIndex,
      }],
      patience, warmth, raised, openObjection: null, signalsHit, violations,
      outcome: "advanced",
    };
  } else if (closing && warmth < 3) {
    // Closing before the person is warm is not punished, it is answered. The
    // objection that surfaces is the real one they had not said yet.
    const key = pending ?? persona.objections[persona.objections.length - 1];
    if (!raised.includes(key)) raised.push(key);
    openObjection = key;
    reply = { role: "customer", text: objectionLine(persona, key, rand), reason: "objection", index: nextIndex };
  } else if (openObjection && !handledOpen) {
    reply = { role: "customer", text: pick(PRESS_LINES, rand), reason: "press", index: nextIndex };
  } else if (landed.length && rand() < 0.6) {
    // They lean in on the thing that landed.
    const signal = landed[0];
    const followups = FOLLOWUP_BY_SIGNAL[signal];
    reply = followups
      ? { role: "customer", text: pick(followups, rand), reason: "followup", index: nextIndex }
      : { role: "customer", text: pick(SOFTEN_LINES, rand), reason: "soften", index: nextIndex };
  } else if (pending) {
    raised.push(pending);
    openObjection = pending;
    reply = { role: "customer", text: objectionLine(persona, pending, rand), reason: "objection", index: nextIndex };
  } else {
    reply = { role: "customer", text: pick(SOFTEN_LINES, rand), reason: "soften", index: nextIndex };
  }

  // A refusal is a concern that IS a no, rather than a question. Read it off
  // the objection now on the table (reply.objection is only attached on the way
  // out, so testing it here would always be undefined) plus the wording, since
  // several personas say no in their own words rather than the canonical cue.
  const isRefusal =
    reply.reason === "objection" &&
    (openObjection === "not_interested" || /not interested|we're all set|no thank/i.test(reply.text));

  return {
    ...session,
    stage: nextStage(session.stage, c.intents, openObjection !== null),
    turns: [...session.turns, repTurn, { ...reply, objection: openObjection ?? undefined }],
    patience,
    warmth,
    raised,
    openObjection,
    refusals: isRefusal ? refusals + 1 : handledOpen ? 0 : refusals,
    signalsHit,
    violations,
    outcome: "in_progress",
  };
}

/** Close a session the rep abandoned. Scoring still runs: an abandoned drill
 *  with four good turns is more useful feedback than no feedback. */
export function endSession(session: RolePlaySession): RolePlaySession {
  if (session.outcome !== "in_progress") return session;
  return { ...session, stage: "ended", outcome: "walked_away" };
}

/**
 * Re-derive every rep turn's classification from the words the rep actually
 * said, discarding whatever the caller attached to the turn.
 *
 * WHY THIS EXISTS
 *   `scoreSession` reads intents, signals and violations off the turns. On the
 *   client those are produced by `classify` a few milliseconds earlier and are
 *   trustworthy. On the server they arrive in a request body, and a client that
 *   posts `violations: []` beside a sentence full of pressure would otherwise
 *   score itself clean. Running this first makes the client's annotations
 *   advisory: the text is the only thing that counts.
 *
 *   One kind survives from the caller: `ignored_no`, which the engine derives
 *   from conversational state rather than from any sentence, so the server
 *   cannot recompute it from the text alone. Client-supplied violations are
 *   therefore UNIONED in for that kind only, which means a client can add a
 *   violation against itself but can never remove one.
 */
export function reclassifySession(session: RolePlaySession, offers: AcademyOffer[] = []): RolePlaySession {
  const turns = session.turns.map((turn) => {
    if (turn.role !== "rep") return turn;
    const c = classify(turn.text, offers);
    const stateDerived = (turn.violations ?? []).filter((v) => v.kind === "ignored_no");
    return { ...turn, intents: c.intents, signals: c.signals, words: c.words, violations: [...c.violations, ...stateDerived] };
  });
  const repTurns = turns.filter((t): t is RepTurn => t.role === "rep");
  return {
    ...session,
    turns,
    signalsHit: [...new Set(repTurns.flatMap((t) => t.signals))],
    violations: repTurns.flatMap((t) => t.violations),
  };
}

/** The transcript as plain lines, for export and for the coaching view. */
export function transcriptLines(session: RolePlaySession): string[] {
  const persona = getPersona(session.personaId);
  return session.turns.map((t) =>
    t.role === "rep" ? `You: ${t.text}` : `${persona?.name ?? "Customer"}: ${t.text}`,
  );
}
