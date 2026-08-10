// ── Pitch Lab blocks ──────────────────────────────────────────────────────────
//
// The approved building blocks a rep assembles their own pitch from. Six
// categories in the order a door conversation actually runs: introduction,
// discovery, benefit, objection, transition, close.
//
// WHY BLOCKS RATHER THAN A SCRIPT
//   A script produces reps who sound like a script. Blocks produce reps who
//   sound like themselves inside a structure that has been checked. The
//   structure is what compliance and accuracy live in; the wording inside it is
//   the rep's own, which is why they will actually say it.
//
// EVERY BLOCK CARRIES ITS LADDER
//   weak / improved / excellent, plus why. A rep who only reads the excellent
//   line cannot see what they personally do wrong. The weak line is the one
//   they recognise, and recognition is where the learning starts.
//
// NUMBERS LIVE IN THE OFFER CATALOG, NOT HERE
//   A block that needs a price or a speed carries a placeholder token and
//   `needsOffer: true`. `renderBlock` substitutes the live figures for the
//   rep's market at render time. A market with no live offer renders the block
//   with the placeholder visible and flagged, which is the honest state: it
//   tells the rep there is nothing approved to say yet.

import type { PersonaSignal } from "./academyPersonas";
import {
  ACADEMY_OBJECTIONS,
  type AcademyObjectionKey, type EthicalTechnique,
} from "./academyObjections";
import { centsToUsd, effectivePriceCents, type AcademyOffer } from "./academyOffers";

export const BLOCK_CATEGORIES = [
  "introduction",
  "discovery",
  "benefit",
  "objection",
  "transition",
  "close",
] as const;

export type BlockCategory = (typeof BLOCK_CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<BlockCategory, string>> = {
  introduction: "Introduction",
  discovery: "Discovery question",
  benefit: "Benefit statement",
  objection: "Objection response",
  transition: "Transition",
  close: "Close",
};

export const CATEGORY_HINTS: Readonly<Record<BlockCategory, string>> = {
  introduction: "Who you are, why you are on their street, and how long this takes. Ten seconds, no more.",
  discovery: "One question that tells you what to say next. Ask it before you pitch, not after.",
  benefit: "An outcome they feel, not a specification. Pick the one this household actually cares about.",
  objection: "Acknowledge, then answer the question they actually asked.",
  transition: "The sentence that moves the conversation forward without a hard turn.",
  close: "A concrete ask with two options. Never an open question.",
};

/** Placeholder tokens a block may contain. Substituted from the live offer. */
export const OFFER_TOKENS = ["{price}", "{speed}", "{upload}", "{plan}"] as const;

export type PitchBlock = {
  /** Stable id, stored in a rep's saved pitch. Never rename. */
  id: string;
  category: BlockCategory;
  /** Short name in the block picker. */
  label: string;
  /** The approved wording. May contain offer tokens. */
  text: string;
  /** When this block is the right choice. */
  whenToUse: string;
  /** Persona signals this block lands, used to score an assembled pitch. */
  signals: PersonaSignal[];
  /** True when the text contains an offer token and needs live figures. */
  needsOffer: boolean;
  /** Set on objection blocks. */
  objectionKey?: AcademyObjectionKey;
  /** Ethical techniques this block demonstrates. */
  techniques: EthicalTechnique[];
  ladder: { weak: string; improved: string; excellent: string; why: string };
  /** Spoken length in seconds, at door pace. Drives the pitch time budget. */
  seconds: number;
};

// ── Objection blocks ──────────────────────────────────────────────────────────
// DERIVED from shared/academyObjections.ts rather than authored twice. The
// dojo teaches the answer and the Pitch Lab lets a rep bolt it into their own
// pitch, and because both read the same ladder they can never disagree about
// what the approved answer is. A block's text IS the excellent rung; the weak
// and better rungs come along so the Pitch Lab's comparison view works exactly
// as it does on an authored block.
const OBJECTION_BLOCKS: readonly PitchBlock[] = ACADEMY_OBJECTIONS.map((objection) => ({
  id: `obj-${objection.key}`,
  category: "objection" as const,
  label: `"${objection.cue}"`,
  text: objection.ladder.excellent,
  whenToUse: objection.whatItMeans,
  signals: [],
  needsOffer: false,
  objectionKey: objection.key,
  techniques: objection.techniques,
  ladder: objection.ladder,
  // Roughly two and a half words per second at door pace, rounded up: these
  // are the longest single things a rep says, and the time budget has to see
  // them honestly or a pitch with two objection blocks reads as short.
  seconds: Math.max(6, Math.min(20, Math.ceil(objection.ladder.excellent.split(/\s+/).length / 2.5))),
}));

export const PITCH_BLOCKS: readonly PitchBlock[] = [
  // ── Introductions ───────────────────────────────────────────────────────────
  {
    id: "intro-build-crew",
    category: "introduction",
    label: "The build crew opener",
    text: "Hi, my name is {name} and I'm with the Kinetic fiber crew that's been working your street. Thirty seconds and I'm out of your way.",
    whenToUse: "Default opener anywhere the build is visibly finished or in progress.",
    signals: ["names_the_street", "acknowledges_time", "local_crew"],
    needsOffer: false,
    techniques: ["asking_permission"],
    ladder: {
      weak: "Hi, how are you today? Do you have a minute to talk about your internet?",
      improved: "Hi, I'm with the fiber company working in your neighborhood. Got a minute?",
      excellent: "Hi, my name is Sam and I'm with the Kinetic fiber crew that's been working your street. Thirty seconds and I'm out of your way.",
      why: "A name, a specific crew on a specific street, and a time budget you can be held to. The weak version asks for an unbounded amount of time from a stranger.",
    },
    seconds: 7,
  },
  {
    id: "intro-flags",
    category: "introduction",
    label: "The orange flags opener",
    text: "You've probably seen the orange flags along the road. That's us, we're putting fiber in. I'm just letting the houses on this block know what it means.",
    whenToUse: "When construction markers, flags or trenching are visible from the porch.",
    signals: ["names_the_street", "local_crew"],
    needsOffer: false,
    techniques: ["verifiable_social_proof"],
    ladder: {
      weak: "We're doing some work in the area and I wanted to tell you about our services.",
      improved: "You might have seen the crews out here. We're running fiber through the neighborhood.",
      excellent: "You've probably seen the orange flags along the road. That's us, we're putting fiber in. I'm just letting the houses on this block know what it means.",
      why: "It attaches you to something they have already seen with their own eyes, which is the cheapest credibility available at a door.",
    },
    seconds: 8,
  },
  {
    id: "intro-permission-first",
    category: "introduction",
    label: "Permission first",
    text: "Hi, my name is {name}, I'm with the Kinetic fiber build on this street. Is now a bad time, or can I give you thirty seconds?",
    whenToUse: "Evenings, dinner hours, or any door that opens looking harassed.",
    signals: ["asks_permission", "acknowledges_time", "names_the_street"],
    needsOffer: false,
    techniques: ["asking_permission"],
    ladder: {
      weak: "Sorry to bother you, this will only take a second.",
      improved: "Is this a good time? I promise I'll be quick.",
      excellent: "Hi, my name is Sam, I'm with the Kinetic fiber build on this street. Is now a bad time, or can I give you thirty seconds?",
      why: "Offering the no first makes the yes real. Apologising for existing, as the weak line does, sets you below the person you are talking to.",
    },
    seconds: 8,
  },

  // ── Discovery ───────────────────────────────────────────────────────────────
  {
    id: "disc-current-provider",
    category: "discovery",
    label: "Who do you have now",
    text: "Who do you have for internet right now?",
    whenToUse: "Almost always first. Everything you say next depends on the answer.",
    signals: ["asks_about_current_service"],
    needsOffer: false,
    techniques: ["active_listening"],
    ladder: {
      weak: "You're probably with Spectrum like everybody else, right?",
      improved: "Do you have internet right now?",
      excellent: "Who do you have for internet right now?",
      why: "Open, neutral, and impossible to answer with a yes or no. The weak version puts words in their mouth and invites a correction instead of an answer.",
    },
    seconds: 3,
  },
  {
    id: "disc-evening-test",
    category: "discovery",
    label: "The evening test",
    text: "When everyone's home in the evening and it's all going at once, does it hold up?",
    whenToUse: "After you know the provider. This is the question that finds the pain.",
    signals: ["asks_about_household", "many_devices", "streaming"],
    needsOffer: false,
    techniques: ["active_listening"],
    ladder: {
      weak: "Are you happy with your internet?",
      improved: "Does it ever slow down on you?",
      excellent: "When everyone's home in the evening and it's all going at once, does it hold up?",
      why: "It names a specific moment they have lived through this week. Are you happy invites a defensive yes; the evening test invites a story.",
    },
    seconds: 5,
  },
  {
    id: "disc-work-from-home",
    category: "discovery",
    label: "Anyone working from home",
    text: "Is anyone in the house working from home, or on video calls much?",
    whenToUse: "Daytime knocks, home offices visible, cars in the driveway at noon.",
    signals: ["asks_about_household", "work_calls"],
    needsOffer: false,
    techniques: ["active_listening"],
    ladder: {
      weak: "Do you need fast internet?",
      improved: "Do you work from home?",
      excellent: "Is anyone in the house working from home, or on video calls much?",
      why: "It covers the whole household rather than the one person at the door, and video calls is the phrase that surfaces the upload problem without you naming it.",
    },
    seconds: 4,
  },
  {
    id: "disc-what-matters",
    category: "discovery",
    label: "What would you fix",
    text: "If you could fix one thing about your internet, what would it be?",
    whenToUse: "When they say it's fine but their tone says otherwise.",
    signals: ["asks_about_household"],
    needsOffer: false,
    techniques: ["active_listening", "labeling"],
    ladder: {
      weak: "So what's wrong with it?",
      improved: "Anything about it that bugs you?",
      excellent: "If you could fix one thing about your internet, what would it be?",
      why: "It presumes one small imperfection rather than a failure, which is easy to admit. What's wrong with it asks them to condemn a choice they made.",
    },
    seconds: 4,
  },

  // ── Benefits ────────────────────────────────────────────────────────────────
  {
    id: "ben-symmetrical-upload",
    category: "benefit",
    label: "Upload is the hidden number",
    text: "The number nobody looks at is upload. On cable it's a small fraction of the download. On this it's {upload} both ways, which is the number your camera actually uses.",
    whenToUse: "Remote workers, anyone who mentions calls freezing, and every cable customer.",
    signals: ["upload_speed", "work_calls"],
    needsOffer: true,
    techniques: ["active_listening"],
    ladder: {
      weak: "Our internet is way faster than cable.",
      improved: "Fiber gives you better upload speeds than cable does.",
      excellent: "The number nobody looks at is upload. On cable it's a small fraction of the download. On this it's the same both ways, which is the number your camera actually uses.",
      why: "It teaches them something checkable on their own bill and connects it to a moment they have experienced. Way faster is a claim; the upload asymmetry is a fact.",
    },
    seconds: 12,
  },
  {
    id: "ben-work-calls",
    category: "benefit",
    label: "Calls that hold up",
    text: "When your video freezes and someone says you're breaking up, that's upload, not download. That's the part this changes.",
    whenToUse: "Remote workers and anyone who has mentioned a call problem.",
    signals: ["work_calls", "upload_speed"],
    needsOffer: false,
    techniques: ["active_listening"],
    ladder: {
      weak: "You'll never have problems with Zoom again.",
      improved: "It's much better for video calls.",
      excellent: "When your video freezes and someone says you're breaking up, that's upload, not download. That's the part this changes.",
      why: "It explains the mechanism instead of promising an outcome. Never have problems again is a guarantee nobody can make.",
    },
    seconds: 9,
  },
  {
    id: "ben-evening-load",
    category: "benefit",
    label: "The eight o'clock test",
    text: "Cable is shared with the street, so it sags right when everyone gets home. A fiber line doesn't have neighbors on it.",
    whenToUse: "Households that described a slowdown in the evening.",
    signals: ["streaming", "many_devices"],
    needsOffer: false,
    techniques: ["active_listening"],
    ladder: {
      weak: "It never slows down, ever.",
      improved: "Fiber handles a lot more traffic than cable.",
      excellent: "Cable is shared with the street, so it sags right when everyone gets home. A fiber line doesn't have neighbors on it.",
      why: "It gives them the reason behind a thing they already noticed. Never slows down is both unverifiable and, at some level, untrue.",
    },
    seconds: 9,
  },
  {
    id: "ben-latency",
    category: "benefit",
    label: "Latency for gaming",
    text: "Download speed isn't what you feel in a match. Latency is, and that's what a direct fiber line changes. It won't fix a bad game server, though.",
    whenToUse: "Gamers, and anyone who asks about ping.",
    signals: ["latency", "many_devices"],
    needsOffer: false,
    techniques: ["active_listening"],
    ladder: {
      weak: "Zero lag, guaranteed.",
      improved: "It's much better for gaming, way lower ping.",
      excellent: "Download speed isn't what you feel in a match. Latency is, and that's what a direct fiber line changes. It won't fix a bad game server, though.",
      why: "Naming what it does not fix is what makes the rest believable to someone who knows the subject. Zero lag guaranteed ends the conversation with a technical customer.",
    },
    seconds: 11,
  },
  {
    id: "ben-price-plain",
    category: "benefit",
    label: "The whole number",
    text: "{plan} is {price} a month. That's the whole thing, equipment included. Nothing else lands on the bill.",
    whenToUse: "Price-sensitive households, and any time you are asked the price. Answer it first.",
    signals: ["price_transparency"],
    needsOffer: true,
    techniques: ["simplifying_choices"],
    ladder: {
      weak: "It depends on a lot of factors, but it's very competitive.",
      improved: "It starts at a good price, and there are a few plans.",
      excellent: "The gig plan is seventy a month. That's the whole thing, equipment included. Nothing else lands on the bill.",
      why: "The question was the price. Anything other than the price reads as a dodge, and a dodge on price is the single fastest way to lose a budget-conscious household.",
    },
    seconds: 8,
  },
  {
    id: "ben-no-contract",
    category: "benefit",
    label: "Nothing to be stuck in",
    text: "There's no term on it. If it doesn't do what I said it does, you're not stuck with it.",
    whenToUse: "Renters, skeptics, and anyone burned by a previous provider.",
    signals: ["no_contract"],
    // No token: the term length is a fact about the plan the rep is on, and the
    // Pitch Lab surfaces the offer's own term disclosure beside it.
    needsOffer: false,
    techniques: ["honest_loss_aversion"],
    ladder: {
      weak: "You've got nothing to lose, honestly.",
      improved: "There's no long contract like the other guys.",
      excellent: "There's no term on it. If it doesn't do what I said it does, you're not stuck with it.",
      why: "It ties the exit to your own claim, which is a real commitment. Nothing to lose is a phrase people have heard from everyone who ever cost them something.",
    },
    seconds: 7,
  },
  {
    id: "ben-install",
    category: "benefit",
    label: "The install, honestly",
    text: "A tech comes out in a two hour window. You don't have to do anything except be there to let them in.",
    whenToUse: "Senior residents, busy households, anyone whose real objection is disruption.",
    signals: ["install_handled"],
    needsOffer: false,
    techniques: ["simplifying_choices"],
    ladder: {
      weak: "The install is super easy, don't even worry about it.",
      improved: "Someone comes out and sets it up for you.",
      excellent: "A tech comes out in a two hour window. You don't have to do anything except be there to let them in.",
      why: "It answers the question actually being asked, which is how much of my day does this cost. Don't worry about it answers nothing.",
    },
    seconds: 8,
  },
  {
    id: "ben-neighbors",
    category: "benefit",
    label: "Named neighbors",
    text: "We connected the houses on the corner last week. If you see the truck tomorrow, that's the same crew.",
    whenToUse: "Only when it is literally true and you can name the street and week.",
    signals: ["names_the_street", "local_crew"],
    needsOffer: false,
    techniques: ["verifiable_social_proof"],
    ladder: {
      weak: "Everybody on this street is switching over.",
      improved: "A lot of your neighbors have signed up already.",
      excellent: "We connected the houses on the corner last week. If you see the truck tomorrow, that's the same crew.",
      why: "Social proof is only usable when it is checkable. Everybody on this street is a number you did not count, and one neighbor comparing notes destroys it.",
    },
    seconds: 8,
  },

  // ── Transitions ─────────────────────────────────────────────────────────────
  {
    id: "trans-permission-bridge",
    category: "transition",
    label: "Ask before continuing",
    text: "Can I ask you one more thing before I let you go?",
    whenToUse: "Any time the conversation has run past what you asked for.",
    signals: ["asks_permission"],
    needsOffer: false,
    techniques: ["asking_permission"],
    ladder: {
      weak: "So anyway, the other thing is...",
      improved: "One more quick thing.",
      excellent: "Can I ask you one more thing before I let you go?",
      why: "It renews consent, which is what keeps a conversation from becoming an imposition. So anyway takes time you were not given.",
    },
    seconds: 3,
  },
  {
    id: "trans-label",
    category: "transition",
    label: "Label what you heard",
    text: "So it sounds like the piece that actually matters here is the price. Let me answer that first.",
    whenToUse: "Right after they raise a concern, before you answer it.",
    signals: [],
    needsOffer: false,
    techniques: ["labeling", "active_listening"],
    ladder: {
      weak: "Right, but here's the thing about that.",
      improved: "I understand. So about the price.",
      excellent: "So it sounds like the piece that actually matters here is the price. Let me answer that first.",
      why: "Naming their concern proves you heard it, and reordering to answer it first proves you took it seriously. Right but signals you were waiting to talk.",
    },
    seconds: 6,
  },
  {
    id: "trans-two-things",
    category: "transition",
    label: "Two things worth knowing",
    text: "Two things worth knowing, and then you can decide if it's worth more of your time.",
    whenToUse: "When you need to deliver information without it feeling like a pitch.",
    signals: ["acknowledges_time"],
    needsOffer: false,
    techniques: ["simplifying_choices"],
    ladder: {
      weak: "Let me explain everything about how this works.",
      improved: "There's a few things I should tell you.",
      excellent: "Two things worth knowing, and then you can decide if it's worth more of your time.",
      why: "A bounded number tells them when this ends, and handing them the decision at the end of it removes the reason to brace.",
    },
    seconds: 5,
  },

  // ── Closes ──────────────────────────────────────────────────────────────────
  {
    id: "close-two-slots",
    category: "close",
    label: "Two install slots",
    text: "I've got Thursday at ten or Saturday at nine. Which one fits your week better?",
    whenToUse: "The default close, once they have stopped raising concerns.",
    signals: ["install_handled"],
    needsOffer: false,
    techniques: ["simplifying_choices"],
    ladder: {
      weak: "So do you want to sign up?",
      improved: "When would be a good time to get you scheduled?",
      excellent: "I've got Thursday at ten or Saturday at nine. Which one fits your week better?",
      why: "Two concrete options are easier to answer than an open question, and easier to decline cleanly too. Do you want to sign up invites the reflex no.",
    },
    seconds: 6,
  },
  {
    id: "close-check-address",
    category: "close",
    label: "Check the address first",
    text: "Let me check your address before we talk about anything else, so I'm not selling you something that isn't there yet. Takes a minute.",
    whenToUse: "Anywhere serviceability is not certain. Also the honest close for a skeptic.",
    signals: ["verifiable_proof", "install_handled"],
    needsOffer: false,
    techniques: ["simplifying_choices", "verifiable_social_proof"],
    ladder: {
      weak: "You're definitely covered, we can get you set up right now.",
      improved: "I think your address should be serviceable.",
      excellent: "Let me check your address before we talk about anything else, so I'm not selling you something that isn't there yet. Takes a minute.",
      why: "Serviceability is checked, never asserted. Saying so out loud is also the most disarming thing a skeptical household will hear all week.",
    },
    seconds: 9,
  },
  {
    id: "close-written",
    category: "close",
    label: "Leave it in writing",
    text: "Let me write the plan and the price on this so you're not going off what I said. Is there an evening this week you're both around?",
    whenToUse: "Spouse objections, senior residents, and anyone who asked for information.",
    signals: ["written_details"],
    needsOffer: false,
    techniques: ["simplifying_choices", "leaving_respectfully"],
    ladder: {
      weak: "Just take my word for it, it's a good deal.",
      improved: "Here's my card, give me a call if you're interested.",
      excellent: "Let me write the plan and the price on this so you're not going off what I said. Is there an evening this week you're both around?",
      why: "It removes the memory problem that kills most callbacks, and pairs the leave-behind with one concrete next step instead of hoping they phone.",
    },
    seconds: 10,
  },
  {
    id: "close-respectful-exit",
    category: "close",
    label: "The respectful exit",
    text: "Then I'll leave you to your evening. If it ever gets annoying, the crew is on this street for a few more weeks.",
    whenToUse: "When the answer is genuinely no. This is a close, and it is scored as one.",
    signals: ["leaves_politely", "local_crew"],
    needsOffer: false,
    techniques: ["leaving_respectfully"],
    ladder: {
      weak: "Are you sure? Because this deal won't be around forever.",
      improved: "Okay, no problem. Have a good night.",
      excellent: "Then I'll leave you to your evening. If it ever gets annoying, the crew is on this street for a few more weeks.",
      why: "It ends the conversation on their terms and leaves one true, unpressured door open. The weak line manufactures a deadline, which this program does not teach.",
    },
    seconds: 8,
  },

  // ── Objection responses, derived from the dojo ──────────────────────────────
  ...OBJECTION_BLOCKS,
];

const BLOCK_BY_ID: ReadonlyMap<string, PitchBlock> = new Map(PITCH_BLOCKS.map((b) => [b.id, b]));

export function getPitchBlock(id: string): PitchBlock | undefined {
  return BLOCK_BY_ID.get(id);
}

export function blocksIn(category: BlockCategory): PitchBlock[] {
  return PITCH_BLOCKS.filter((b) => b.category === category);
}

// ── Rendering with live offer figures ─────────────────────────────────────────

export type RenderedBlock = {
  block: PitchBlock;
  /** The text with offer tokens substituted, and {name} left for the rep. */
  text: string;
  /** Tokens that could not be filled because the market has no live offer. */
  unresolved: string[];
};

/**
 * Substitute live offer figures into a block. `offer` is the market's headline
 * offer, or null when the market has nothing live: in that case the tokens are
 * left visible and reported, because a blank where a price should be is a lie
 * of omission and a rep needs to see that the market is unconfigured.
 */
export function renderBlock(block: PitchBlock, offer: AcademyOffer | null): RenderedBlock {
  if (!block.needsOffer) return { block, text: block.text, unresolved: [] };
  if (!offer) {
    const unresolved = OFFER_TOKENS.filter((t) => block.text.includes(t));
    return { block, text: block.text, unresolved: [...unresolved] };
  }
  const text = block.text
    .replaceAll("{price}", centsToUsd(effectivePriceCents(offer)))
    .replaceAll("{speed}", `${offer.downloadMbps} Mbps`)
    .replaceAll("{upload}", `${offer.uploadMbps} Mbps`)
    .replaceAll("{plan}", offer.name);
  return { block, text, unresolved: [] };
}

// ── Assembled pitch ───────────────────────────────────────────────────────────

export type AssembledPitch = {
  /** Block ids in speaking order. */
  blockIds: string[];
  /** Optional rep-written lines, keyed by the block they replace. Checked
   *  against the offer catalog before they can be saved. */
  customText?: Record<string, string>;
};

export type PitchReview = {
  /** Total spoken seconds at door pace. */
  seconds: number;
  /** Categories present, in order encountered. */
  categories: BlockCategory[];
  /** Blocks whose tokens could not be resolved for this market. */
  unresolved: { blockId: string; tokens: string[] }[];
  /** Structural problems, most important first. Empty means the shape is sound. */
  problems: string[];
  /** What is good about it, named specifically. */
  strengths: string[];
  /** Persona signals this pitch would land. */
  signals: PersonaSignal[];
  /** True when the pitch is structurally complete and inside the time budget. */
  ready: boolean;
};

/** A door pitch that runs past this has stopped being a pitch. */
export const PITCH_SECONDS_BUDGET = 45;

/**
 * Check an assembled pitch. This is the Pitch Lab's feedback: structure, time,
 * unresolved offer tokens, and what it would actually land on a real door.
 */
export function reviewPitch(pitch: AssembledPitch, offer: AcademyOffer | null): PitchReview {
  const blocks = pitch.blockIds.map((id) => BLOCK_BY_ID.get(id)).filter((b): b is PitchBlock => !!b);
  const seconds = blocks.reduce((a, b) => a + b.seconds, 0);
  const categories = blocks.map((b) => b.category);
  const unresolved = blocks
    .map((b) => ({ blockId: b.id, tokens: renderBlock(b, offer).unresolved }))
    .filter((u) => u.tokens.length > 0);

  const problems: string[] = [];
  const strengths: string[] = [];

  if (!blocks.length) {
    return { seconds: 0, categories: [], unresolved: [], problems: ["Nothing added yet. Start with an introduction."], strengths: [], signals: [], ready: false };
  }
  if (!categories.includes("introduction")) problems.push("No introduction. They do not know who you are or why you are there.");
  if (!categories.includes("discovery")) problems.push("No discovery question. Every benefit after this is a guess about a household you have not asked about.");
  if (!categories.includes("benefit")) problems.push("No benefit statement. You have introduced yourself and asked a question, but never said what changes for them.");
  if (!categories.includes("close")) problems.push("No close. A conversation without an ask is a chat.");

  const firstIntro = categories.indexOf("introduction");
  const firstBenefit = categories.indexOf("benefit");
  const firstDiscovery = categories.indexOf("discovery");
  if (firstIntro > 0) problems.push("The introduction is not first. Everything before it is a stranger talking.");
  if (firstBenefit >= 0 && firstDiscovery >= 0 && firstBenefit < firstDiscovery) {
    problems.push("You pitch before you ask. Move the discovery question above the benefit.");
  }
  const lastCategory = categories[categories.length - 1];
  if (categories.includes("close") && lastCategory !== "close") {
    problems.push("The close is not last. Anything after the ask talks them back out of it.");
  }
  if (seconds > PITCH_SECONDS_BUDGET) {
    problems.push(`This runs about ${seconds} seconds. Past ${PITCH_SECONDS_BUDGET} at a door, they have stopped listening. Cut a block.`);
  }
  if (unresolved.length) {
    problems.push("Some blocks need a price or speed and this market has no live offer configured. Those numbers cannot be quoted yet.");
  }

  const benefitCount = categories.filter((c) => c === "benefit").length;
  if (benefitCount > 3) problems.push("More than three benefits is a brochure. Pick the ones this household cares about.");

  if (!problems.length) strengths.push("The shape is right: you introduce, ask, say what changes, and make one concrete ask.");
  if (seconds <= 30 && categories.length >= 4) strengths.push(`Tight at about ${seconds} seconds, which is inside a real door's attention.`);
  if (categories.includes("objection")) strengths.push("You have a prepared answer for the concern you expect. That is the difference between rehearsed and improvised.");
  if (blocks.some((b) => b.techniques.includes("leaving_respectfully"))) {
    strengths.push("You have planned how to leave well, which most reps never do.");
  }

  const signals = [...new Set(blocks.flatMap((b) => b.signals))];
  return { seconds, categories, unresolved, problems, strengths, signals, ready: problems.length === 0 };
}
