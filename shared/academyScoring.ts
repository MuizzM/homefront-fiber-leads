// ── Role-play scoring ─────────────────────────────────────────────────────────
//
// Eleven dimensions, scored from the transcript by rules stated in this file.
// Every score carries the turns it was derived from, so a rep can disagree with
// a number by looking at the exact sentence that produced it. A score a rep
// cannot audit is a score they will learn to ignore.
//
// WHAT IS DELIBERATELY NOT MEASURED
//   Aggression. Persistence-under-refusal. "Pushing through" a no. Those are
//   not dimensions with a good end of the scale, so they are not dimensions.
//   Pressure tactics appear here only as DEDUCTIONS against professionalism and
//   compliance, and as a coaching note in plain words. A rep can never raise a
//   score by leaning harder on someone.
//
//   The list is exported as UNSCORED_BEHAVIOURS and pinned by a test, because
//   the easiest way for this to rot is for someone to add "closing pressure" as
//   a well-meaning eleventh-and-a-half metric.
//
// BANDS, NOT JUST NUMBERS
//   A raw percentage invites comparison between reps. Each dimension also
//   carries a band (needs_practice / developing / strong), which is what the
//   supervisor dashboard renders. The number is for the rep's own trend line.

import { getPersona, SIGNAL_LABELS, type PersonaSignal } from "./academyPersonas";
import type { RepTurn, RolePlaySession, Turn } from "./academyRolePlay";
import { requiredDisclosures, type AcademyOffer } from "./academyOffers";

export const SCORE_DIMENSIONS = [
  "introduction",
  "clarity",
  "discovery",
  "listening",
  "empathy",
  "benefitAlignment",
  "objectionHandling",
  "accuracy",
  "compliance",
  "closing",
  "professionalism",
] as const;

export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

/** Behaviours this program refuses to score. Pinned by a test so the list
 *  cannot quietly grow a metric that rewards pushing people. */
export const UNSCORED_BEHAVIOURS = [
  "aggression",
  "pressure",
  "persistence_after_refusal",
  "urgency_manufacturing",
  "fear_appeals",
] as const;

export const DIMENSION_LABELS: Readonly<Record<ScoreDimension, string>> = {
  introduction: "Introduction",
  clarity: "Clarity",
  discovery: "Discovery",
  listening: "Listening",
  empathy: "Empathy",
  benefitAlignment: "Benefit alignment",
  objectionHandling: "Objection handling",
  accuracy: "Accuracy",
  compliance: "Compliance",
  closing: "Closing",
  professionalism: "Professionalism",
};

export type ScoreBand = "needs_practice" | "developing" | "strong";

export type DimensionScore = {
  dimension: ScoreDimension;
  /** 0 to 100. */
  score: number;
  band: ScoreBand;
  /** What produced this number, in one sentence. */
  note: string;
  /** Transcript turn indices the score was read from. */
  evidence: number[];
  /** A stronger way to have said it, when a specific turn can be improved. */
  betterWording?: { instead: string; say: string };
};

export type SessionScore = {
  sessionId: string;
  personaId: string;
  /** Unweighted mean of the eleven dimensions, for the rep's own trend only. */
  overall: number;
  dimensions: DimensionScore[];
  /** The two or three things to work on next, most useful first. */
  coaching: string[];
  /** Things that went right. Named specifically, so they can be repeated. */
  strengths: string[];
  /** Compliance and ethics flags, always surfaced regardless of score. */
  flags: string[];
};

export function bandFor(score: number): ScoreBand {
  if (score >= 80) return "strong";
  if (score >= 55) return "developing";
  return "needs_practice";
}

export const BAND_LABELS: Readonly<Record<ScoreBand, string>> = {
  needs_practice: "Needs practice",
  developing: "Developing",
  strong: "Strong",
};

function repTurns(turns: Turn[]): RepTurn[] {
  return turns.filter((t): t is RepTurn => t.role === "rep");
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** A rewrite for the most common weak opening: no name, no reason, no time
 *  boundary. Keyed by what the turn was missing. */
const OPENING_REWRITES: Record<string, { instead: string; say: string }> = {
  identity: {
    instead: "Hi, how are you doing today?",
    say: "Hi, my name is Sam, I'm with the Kinetic fiber crew working your street.",
  },
  reason: {
    instead: "I just wanted to talk to you about your internet.",
    say: "We finished running fiber down your block this week, and I'm letting the houses on it know.",
  },
  permission: {
    instead: "So let me tell you about what we're doing here.",
    say: "Thirty seconds and I'm out of your way. Is now okay, or is there a better time?",
  },
};

// ── The eleven ────────────────────────────────────────────────────────────────

function scoreIntroduction(session: RolePlaySession): DimensionScore {
  const reps = repTurns(session.turns);
  const first = reps[0];
  if (!first) {
    return {
      dimension: "introduction", score: 0, band: "needs_practice", evidence: [],
      note: "The drill ended before you said anything.",
    };
  }
  const parts = {
    identity: first.intents.includes("identity"),
    reason: first.intents.includes("reason"),
    permission: first.intents.includes("permission") || first.signals.includes("acknowledges_time"),
  };
  const got = Object.values(parts).filter(Boolean).length;
  const missing = (Object.keys(parts) as (keyof typeof parts)[]).find((k) => !parts[k]);
  const score = clamp((got / 3) * 100);
  return {
    dimension: "introduction",
    score,
    band: bandFor(score),
    evidence: [first.index],
    note: got === 3
      ? "Your opener carried your name, why you are there, and the time it would take."
      : `Your opener was missing ${missing === "identity" ? "who you are" : missing === "reason" ? "why you are on their street" : "a time boundary"}.`,
    betterWording: missing ? OPENING_REWRITES[missing] : undefined,
  };
}

function scoreClarity(session: RolePlaySession): DimensionScore {
  const reps = repTurns(session.turns);
  if (!reps.length) {
    return { dimension: "clarity", score: 0, band: "needs_practice", evidence: [], note: "No turns to read." };
  }
  // A door turn lives between about eight and forty words. Below that is a
  // grunt; above it is a monologue the person stopped hearing halfway through.
  const scores = reps.map((t) => {
    if (t.words >= 8 && t.words <= 40) return 100;
    if (t.words < 8) return 45 + t.words * 5;
    return Math.max(20, 100 - (t.words - 40) * 2);
  });
  const score = clamp(scores.reduce((a, b) => a + b, 0) / scores.length);
  const longest = reps.reduce((a, b) => (b.words > a.words ? b : a));
  return {
    dimension: "clarity",
    score,
    band: bandFor(score),
    evidence: [longest.index],
    note: longest.words > 40
      ? `Your longest turn ran ${longest.words} words. At a door, anything past about forty stops being heard.`
      : score >= 80
        ? "Your turns stayed short enough to be heard and long enough to say something."
        : "Several turns were too short to carry meaning. Give them a full thought.",
    betterWording: longest.words > 40
      ? {
        instead: longest.text.slice(0, 90) + (longest.text.length > 90 ? "..." : ""),
        say: "Cut it to the one sentence that matters, then stop and let them answer.",
      }
      : undefined,
  };
}

function scoreDiscovery(session: RolePlaySession): DimensionScore {
  const reps = repTurns(session.turns);
  const asks = reps.filter((t) => t.intents.includes("discovery"));
  const firstBenefit = reps.find((t) => t.intents.includes("benefit"));
  const askedBeforePitching = asks.some((t) => !firstBenefit || t.index < firstBenefit.index);
  let score = Math.min(80, asks.length * 40);
  if (askedBeforePitching) score += 20;
  score = clamp(score);
  return {
    dimension: "discovery",
    score,
    band: bandFor(score),
    evidence: asks.map((t) => t.index),
    note: asks.length === 0
      ? "You never asked what they have now or who uses it. Everything after that was a guess."
      : askedBeforePitching
        ? `You asked ${asks.length === 1 ? "a question" : `${asks.length} questions`} before you started pitching.`
        : "You asked, but only after you had already pitched. The answer arrived too late to use.",
    betterWording: asks.length === 0
      ? {
        instead: "We've got fiber available on your street now.",
        say: "Before I take up your time, who do you have now, and does it hold up in the evenings?",
      }
      : undefined,
  };
}

function scoreListening(session: RolePlaySession): DimensionScore {
  const pressed = session.turns.filter((t) => t.role === "customer" && t.reason === "press");
  const labels = repTurns(session.turns).filter((t) => t.intents.includes("label"));
  const raised = session.raised.length;
  const base = raised === 0 ? 70 : 100 - (pressed.length / Math.max(1, raised)) * 60;
  const score = clamp(base + labels.length * 10);
  return {
    dimension: "listening",
    score,
    band: bandFor(score),
    evidence: pressed.map((t) => t.index),
    note: pressed.length === 0
      ? "They never had to repeat themselves. That is what listening looks like from the other side of the door."
      : `They pushed back ${pressed.length === 1 ? "once" : `${pressed.length} times`} because your answer went somewhere else.`,
    betterWording: pressed.length
      ? {
        instead: "Right, so anyway, the other thing is the speed.",
        say: "So it sounds like the price is the piece that actually matters here. Let me answer that first.",
      }
      : undefined,
  };
}

function scoreEmpathy(session: RolePlaySession): DimensionScore {
  const reps = repTurns(session.turns);
  const objectionTurnIndices = session.turns
    .filter((t) => t.role === "customer" && t.reason === "objection")
    .map((t) => t.index);
  // Empathy is measured where it matters: the turn right after a concern.
  const answered = objectionTurnIndices.map((i) => reps.find((t) => t.index > i));
  const withEmpathy = answered.filter((t) => t && (t.intents.includes("empathy") || t.intents.includes("label")));
  const score = objectionTurnIndices.length === 0
    ? (reps.some((t) => t.intents.includes("empathy")) ? 80 : 60)
    : clamp((withEmpathy.length / objectionTurnIndices.length) * 100);
  return {
    dimension: "empathy",
    score,
    band: bandFor(score),
    evidence: withEmpathy.map((t) => t!.index),
    note: objectionTurnIndices.length === 0
      ? "No concerns came up, so there was little to acknowledge."
      : withEmpathy.length === objectionTurnIndices.length
        ? "You acknowledged every concern before you answered it."
        : `You answered ${objectionTurnIndices.length - withEmpathy.length} of their concerns without first acknowledging them.`,
    betterWording: withEmpathy.length < objectionTurnIndices.length
      ? {
        instead: "Actually, it's cheaper than what you have now.",
        say: "That's fair, and you are not the first person on this street to say it. Can I give you the number and you decide?",
      }
      : undefined,
  };
}

function scoreBenefitAlignment(session: RolePlaySession): DimensionScore {
  const persona = getPersona(session.personaId);
  const wins = persona?.wins ?? [];
  const hit = wins.filter((w) => session.signalsHit.includes(w));
  const missed = wins.filter((w) => !session.signalsHit.includes(w));
  const score = wins.length ? clamp((hit.length / wins.length) * 100) : 60;
  const missedLabel = missed.slice(0, 2).map((s) => SIGNAL_LABELS[s]).join(" and ");
  return {
    dimension: "benefitAlignment",
    score,
    band: bandFor(score),
    evidence: repTurns(session.turns).filter((t) => t.signals.some((s) => wins.includes(s))).map((t) => t.index),
    note: hit.length === wins.length
      ? "Every point you made was one this person actually cares about."
      : hit.length === 0
        ? `Nothing you said spoke to what moves this person. They care about ${wins.slice(0, 2).map((s) => SIGNAL_LABELS[s]).join(" and ")}.`
        : `You landed ${hit.length} of ${wins.length}. Still on the table: ${missedLabel}.`,
    betterWording: missed.length ? benefitRewrite(missed[0]) : undefined,
  };
}

/** A sayable line for each signal, used when the rep never raised it. */
function benefitRewrite(signal: PersonaSignal): { instead: string; say: string } | undefined {
  const table: Partial<Record<PersonaSignal, { instead: string; say: string }>> = {
    upload_speed: {
      instead: "It's way faster.",
      say: "The part most people never look at is upload. On cable it is a fraction of the download. On fiber it is the same number both ways.",
    },
    latency: {
      instead: "It's really fast for gaming.",
      say: "Download speed is not what you feel in a match. Latency is, and that is what changes on a fiber line.",
    },
    work_calls: {
      instead: "You'll get better internet.",
      say: "When your camera freezes and someone says you are breaking up, that is upload. That is the number this fixes.",
    },
    price_transparency: {
      instead: "It's a great deal.",
      say: "Here is the whole monthly number, including equipment. Nothing else lands on the bill.",
    },
    no_contract: {
      instead: "You should sign up now.",
      say: "There is no term on it. If it does not do what I said, you are not stuck.",
    },
    install_handled: {
      instead: "The install is easy.",
      say: "A tech comes out in a two hour window, and you do not have to do anything except let them in.",
    },
    landlord_friendly: {
      instead: "You can definitely get it.",
      say: "Worth checking your lease, but nothing here is permanent to the building, and the account is in your name, not the owner's.",
    },
    verifiable_proof: {
      instead: "Trust me, we're legit.",
      say: "Here is my badge, and the crew truck is on the corner. You can also call the number on the card before anything happens.",
    },
    written_details: {
      instead: "I'll remember to follow up.",
      say: "I will leave this with the plan and the price written on it, so you are not going off what I said.",
    },
    local_crew: {
      instead: "Our team is great.",
      say: "The crew doing your street is local. Same people who did the block behind you last month.",
    },
    acknowledges_time: {
      instead: "This will just take a moment.",
      say: "Thirty seconds, and then I am gone either way.",
    },
    many_devices: {
      instead: "It handles everything.",
      say: "The test is not one device. It is the evening when the TV, two phones and a console are all going at once.",
    },
    streaming: {
      instead: "No more buffering.",
      say: "The buffering usually shows up around eight at night, when the whole street is on. That is the part that changes.",
    },
  };
  return table[signal];
}

function scoreObjectionHandling(session: RolePlaySession): DimensionScore {
  const raised = session.raised;
  const pressed = session.turns.filter((t) => t.role === "customer" && t.reason === "press").length;
  if (!raised.length) {
    return {
      dimension: "objectionHandling", score: 60, band: "developing", evidence: [],
      note: "No concerns came up in this run. Try a persona that pushes back harder.",
    };
  }
  const handled = Math.max(0, raised.length - (session.openObjection ? 1 : 0) - pressed);
  const score = clamp((handled / raised.length) * 100);
  return {
    dimension: "objectionHandling",
    score,
    band: bandFor(score),
    evidence: session.turns.filter((t) => t.role === "customer" && t.reason === "objection").map((t) => t.index),
    note: session.openObjection
      ? `You left "${session.openObjection.replace(/_/g, " ")}" unanswered when the conversation ended.`
      : score >= 80
        ? `You answered all ${raised.length} concerns they raised.`
        : "Some concerns got an answer that did not match the question.",
  };
}

function scoreAccuracy(session: RolePlaySession): DimensionScore {
  const bad = session.violations.filter((v) => v.kind === "unsupported_claim");
  const score = clamp(100 - bad.length * 35);
  return {
    dimension: "accuracy",
    score,
    band: bandFor(score),
    evidence: repTurns(session.turns).filter((t) => t.violations.some((v) => v.kind === "unsupported_claim")).map((t) => t.index),
    // "Figures" was wrong here: this bucket also holds superlatives and
    // guarantees, whose fragments are words, so the note read "2 figures you
    // quoted: guarantee, $22". Say claims, which is true of both.
    note: bad.length === 0
      ? "Every number and claim you used was supported."
      : `${bad.length} thing${bad.length === 1 ? "" : "s"} you said cannot be supported: ${bad.map((v) => `"${v.fragment}"`).join(", ")}.`,
    betterWording: bad.length
      ? { instead: bad[0].fragment, say: "Quote only what is on the offer card for your market today, or say you will confirm it and follow up." }
      : undefined,
  };
}

function scoreCompliance(session: RolePlaySession, offers: AcademyOffer[]): DimensionScore {
  const flags: string[] = [];
  let score = 100;
  const reps = repTurns(session.turns);

  const quotedPrice = reps.some((t) => t.intents.includes("price"));
  const saidDisclosure = offers.some((o) =>
    requiredDisclosures(o).some((d) => {
      const key = d.toLowerCase().split(" ").slice(0, 4).join(" ");
      return reps.some((t) => t.text.toLowerCase().includes(key));
    }),
  );
  if (quotedPrice && offers.length && !saidDisclosure) {
    score -= 25;
    flags.push("You quoted a price without the disclosure that goes with it.");
  }
  for (const v of session.violations) {
    if (v.kind === "ignored_no") { score -= 50; flags.push(v.message); }
    if (v.kind === "pressure") { score -= 30; flags.push(v.message); }
    if (v.kind === "unsupported_claim") { score -= 10; }
  }
  score = clamp(score);
  return {
    dimension: "compliance",
    score,
    band: bandFor(score),
    evidence: reps.filter((t) => t.violations.length).map((t) => t.index),
    note: flags.length ? flags[0] : "Nothing in this run crossed a compliance line.",
  };
}

function scoreClosing(session: RolePlaySession): DimensionScore {
  const reps = repTurns(session.turns);
  const closes = reps.filter((t) => t.intents.includes("close"));
  const polite = session.outcome === "polite_exit";
  if (polite) {
    return {
      dimension: "closing", score: 85, band: "strong",
      evidence: reps.slice(-1).map((t) => t.index),
      note: "You left well. Knowing when the answer is no, and going out clean, is a close.",
    };
  }
  if (!closes.length) {
    return {
      dimension: "closing", score: 20, band: "needs_practice", evidence: [],
      note: "You never asked for anything. A conversation without an ask is a chat.",
      betterWording: {
        instead: "So, let me know if you're interested.",
        say: "I have Thursday at ten or Saturday at nine. Which one fits your week better?",
      },
    };
  }
  const first = closes[0];
  const early = session.warmth < 3 && first.index <= 2;
  const score = session.outcome === "advanced" ? 95 : early ? 45 : 70;
  return {
    dimension: "closing",
    score,
    band: bandFor(score),
    evidence: closes.map((t) => t.index),
    note: session.outcome === "advanced"
      ? "You asked at the point they were ready, and they moved."
      : early
        ? "You asked for the appointment before they had a reason to say yes."
        : "You asked, but the ask was vague. Give two concrete options instead of an open question.",
    betterWording: score < 80
      ? { instead: "Do you want to sign up?", say: "Thursday at ten or Saturday at nine. Which is easier?" }
      : undefined,
  };
}

function scoreProfessionalism(session: RolePlaySession): DimensionScore {
  let score = 100;
  const bad = session.violations.filter((v) => v.kind === "pressure" || v.kind === "disparagement" || v.kind === "ignored_no");
  score -= bad.length * 30;
  if (session.outcome === "polite_exit") score = Math.min(100, score + 10);
  if (session.outcome === "door_closed") score -= 10;
  score = clamp(score);
  return {
    dimension: "professionalism",
    score,
    band: bandFor(score),
    evidence: repTurns(session.turns).filter((t) => t.violations.length).map((t) => t.index),
    note: bad.length === 0
      ? "You stayed on the right side of the line the whole way through."
      : bad[0].message,
  };
}

// ── Assembly ──────────────────────────────────────────────────────────────────

export type ScoreOptions = {
  /** The market's live offers, for accuracy and disclosure checks. */
  offers?: AcademyOffer[];
};

export function scoreSession(session: RolePlaySession, opts: ScoreOptions = {}): SessionScore {
  const offers = opts.offers ?? [];
  const dimensions: DimensionScore[] = [
    scoreIntroduction(session),
    scoreClarity(session),
    scoreDiscovery(session),
    scoreListening(session),
    scoreEmpathy(session),
    scoreBenefitAlignment(session),
    scoreObjectionHandling(session),
    scoreAccuracy(session),
    scoreCompliance(session, offers),
    scoreClosing(session),
    scoreProfessionalism(session),
  ];

  const overall = clamp(dimensions.reduce((a, d) => a + d.score, 0) / dimensions.length);

  // Coaching: the two weakest dimensions that carry an actionable note, plus
  // any compliance flag, which always comes first regardless of rank.
  const ranked = [...dimensions].sort((a, b) => a.score - b.score);
  const coaching: string[] = [];
  const compliance = dimensions.find((d) => d.dimension === "compliance")!;
  if (compliance.score < 100) coaching.push(compliance.note);
  for (const d of ranked) {
    if (coaching.length >= 3) break;
    if (d.dimension === "compliance") continue;
    if (d.score >= 80) continue;
    coaching.push(`${DIMENSION_LABELS[d.dimension]}: ${d.note}`);
  }
  if (!coaching.length) coaching.push("Nothing stood out as weak. Run a harder persona.");

  const strengths = dimensions
    .filter((d) => d.score >= 80)
    .slice(0, 3)
    .map((d) => `${DIMENSION_LABELS[d.dimension]}: ${d.note}`);

  const flags = [...new Set(session.violations.map((v) => v.message))];

  return { sessionId: session.id, personaId: session.personaId, overall, dimensions, coaching, strengths, flags };
}

/** Dimensions a rep is weakest at across several sessions. Drives "areas
 *  needing practice" on the rep's own page and the team gap view. */
export function weakestDimensions(scores: SessionScore[], take = 3): { dimension: ScoreDimension; average: number }[] {
  if (!scores.length) return [];
  const totals = new Map<ScoreDimension, number[]>();
  for (const s of scores) {
    for (const d of s.dimensions) {
      const list = totals.get(d.dimension) ?? [];
      list.push(d.score);
      totals.set(d.dimension, list);
    }
  }
  return [...totals.entries()]
    .map(([dimension, list]) => ({ dimension, average: Math.round(list.reduce((a, b) => a + b, 0) / list.length) }))
    .sort((a, b) => a.average - b.average)
    .slice(0, take);
}
