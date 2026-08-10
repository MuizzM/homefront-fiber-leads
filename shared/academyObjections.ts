// ── Academy objection dojo ────────────────────────────────────────────────────
//
// The ten objections a residential fiber rep hears most, each with the ethical
// technique that answers it, a weak/improved/excellent wording ladder, and the
// trap that makes the objection worse.
//
// RELATIONSHIP TO shared/trainingObjections.ts
//   That file holds the FROZEN 14-key taxonomy the drill-card engine depends on
//   (its contract test asserts exactly fourteen keys). Two of the objections the
//   Academy must teach have no key there: being under contract, and how the rep
//   got the household's information. Rather than break a frozen contract, the
//   Academy defines its own key union that reuses the taxonomy where it maps and
//   adds exactly those two. `taxonomyKey` is the bridge, so a drill card and an
//   Academy lesson can never teach different answers to the same words.
//
// THE TECHNIQUES ARE THE CURRICULUM
//   Every entry names the technique it teaches, and the technique list is
//   closed. There is no "create urgency" and no "overcome the no", because
//   those are not techniques, they are pressure with a nicer name. The one
//   entry that touches loss aversion is explicit that it works by stating what
//   is already true, not by manufacturing a deadline.

import { isObjectionKey, type ObjectionKey } from "./trainingObjections";

/** Objection keys the Academy teaches. The first ten are the required set. */
export const ACADEMY_OBJECTION_KEYS = [
  "not_interested",
  "under_contract",
  "competitor_fiber",
  "bad_experience",
  "price",
  "spouse",
  "renter",
  "too_busy",
  "leave_something",
  "data_source",
] as const;

export type AcademyObjectionKey = (typeof ACADEMY_OBJECTION_KEYS)[number];

/** The ethical techniques this program teaches. Closed list, pinned by test. */
export const ETHICAL_TECHNIQUES = [
  "active_listening",
  "labeling",
  "asking_permission",
  "honest_loss_aversion",
  "verifiable_social_proof",
  "simplifying_choices",
  "leaving_respectfully",
] as const;

export type EthicalTechnique = (typeof ETHICAL_TECHNIQUES)[number];

export const TECHNIQUE_LABELS: Readonly<Record<EthicalTechnique, string>> = {
  active_listening: "Active listening",
  labeling: "Labeling the concern",
  asking_permission: "Asking permission",
  honest_loss_aversion: "Honest loss aversion",
  verifiable_social_proof: "Verifiable social proof",
  simplifying_choices: "Simplifying the choice",
  leaving_respectfully: "Leaving respectfully",
};

export const TECHNIQUE_NOTES: Readonly<Record<EthicalTechnique, string>> = {
  active_listening:
    "Let them finish, then repeat the substance back before you answer. A person who has been heard argues less, and you find out what the objection actually was.",
  labeling:
    "Name the feeling under the words: it sounds like the timing is the problem. Naming it drains it. Guessing wrong is fine, they will correct you and now you know.",
  asking_permission:
    "Ask before you continue, and mean it. Permission converts an interruption into a conversation, and a no to permission is a cheap no that costs you nothing.",
  honest_loss_aversion:
    "People weigh losing more heavily than gaining. That is only usable honestly: state what they are already paying or already living with. Never invent a deadline, a last chance, or a price that is about to vanish.",
  verifiable_social_proof:
    "Neighbors move people, but only if the claim is checkable. Name the street, name the week. Never say a number of neighbors you did not count.",
  simplifying_choices:
    "Two options beat an open question, and beat five options. Thursday or Saturday. Not whether, not which of six.",
  leaving_respectfully:
    "When the answer is no, go out clean and say something true on the way. It protects the brand, it protects the next rep on that street, and it is the only version of this job worth doing.",
};

/** A weak, improved and excellent way to say the same thing. The ladder is the
 *  teaching device: reps rarely learn from the excellent line alone, because
 *  they cannot see what they were doing wrong. */
export type WordingLadder = {
  weak: string;
  improved: string;
  excellent: string;
  /** Why the excellent line is better, in one sentence. */
  why: string;
};

export type AcademyObjection = {
  key: AcademyObjectionKey;
  /** The taxonomy key this maps to, or null when the Academy owns it alone. */
  taxonomyKey: ObjectionKey | null;
  /** How the homeowner actually says it. */
  cue: string;
  /** Short label for chips. */
  chip: string;
  /** What is really going on, one or two sentences. */
  whatItMeans: string;
  techniques: EthicalTechnique[];
  ladder: WordingLadder;
  /** The reflex that makes it worse. */
  trap: string;
  /** The question that opens it back up, when there is one. */
  reopener: string | null;
};

export const ACADEMY_OBJECTIONS: readonly AcademyObjection[] = [
  {
    key: "not_interested",
    taxonomyKey: "not_interested",
    cue: "Not interested.",
    chip: "Not interested",
    whatItMeans:
      "Almost never about your offer. It is the sentence people use to end a door conversation before it starts, and it fires before they have heard a single fact.",
    techniques: ["asking_permission", "labeling", "leaving_respectfully"],
    ladder: {
      weak: "Wait, you haven't even heard what it is yet.",
      improved: "That's fair. Can I give you one sentence and then get out of your way?",
      excellent:
        "Totally fair, you don't know what this is yet. One sentence: they finished running fiber on your street, and most houses here are on a plan that costs more than the fiber does. If that's not interesting, I'm gone.",
      why: "It agrees with them, buys a bounded amount of attention, and puts the reason for the knock in one checkable sentence. The exit is offered by you, not demanded by them.",
    },
    trap: "Arguing that they should be interested. You are now the thing they were trying to end.",
    reopener: "Before I go, can I ask one thing? Who do you have now?",
  },
  {
    key: "under_contract",
    taxonomyKey: null,
    cue: "I'm under contract.",
    chip: "Under contract",
    whatItMeans:
      "Usually true, and usually a date rather than a wall. Most people do not know their own end date, and many are already past it on a month-to-month rollover.",
    techniques: ["active_listening", "simplifying_choices", "honest_loss_aversion"],
    ladder: {
      weak: "We'll buy out your contract, no problem.",
      improved: "That's good to know. Do you know roughly when it ends?",
      excellent:
        "Makes sense, and I'm not going to ask you to break it. Two things worth knowing: a lot of those rolled to month-to-month a while back without anyone mentioning it, and if yours has a real end date, I'd rather come back the month before than talk you into an early termination fee.",
      why: "It refuses to cost them money, gives them a fact they can check on their own bill, and turns the objection into a calendar entry instead of a dead end.",
    },
    trap: "Promising a buyout or a credit that nobody has authorized you to promise. That is a compliance problem, not a clever close.",
    reopener: "Worth a look at the bill for the end date. If it's already month-to-month, that changes the math.",
  },
  {
    key: "competitor_fiber",
    taxonomyKey: "competitor_fiber",
    cue: "I already have fiber.",
    chip: "Already have fiber",
    whatItMeans:
      "Sometimes true, and then the right answer is a polite exit. Often it is cable sold as fiber, or fiber to the neighborhood and coax to the house.",
    techniques: ["active_listening", "verifiable_social_proof", "leaving_respectfully"],
    ladder: {
      weak: "Are you sure it's actually fiber?",
      improved: "Nice, who's it with? I ask because a couple of things around here get called fiber.",
      excellent:
        "Good, that's the right thing to have. Out of curiosity, is your upload the same as your download on the bill? If it is, you're genuinely set and I'll leave you alone. If it isn't, the line stops short of the house and that's worth two minutes.",
      why: "It hands them a single checkable test, commits in advance to leaving if they pass it, and never once calls them wrong.",
    },
    trap: "Telling them they do not have what they think they have. Ask a question that lets them find out themselves.",
    reopener: "Check the upload number on your bill sometime. That one number settles it.",
  },
  {
    key: "bad_experience",
    taxonomyKey: "bad_experience",
    cue: "Kinetic was bad before.",
    chip: "Bad experience",
    whatItMeans:
      "It happened. On the old copper network, in a lot of these markets, it happened a lot. Arguing with a lived experience loses the door in one sentence.",
    techniques: ["active_listening", "labeling", "verifiable_social_proof"],
    ladder: {
      weak: "That was a while ago, things are different now.",
      improved: "I hear that a lot, and I'm not going to tell you it didn't happen. What went wrong?",
      excellent:
        "Yeah. If you were on the copper line, I believe every word of that, and you're not the only house on this street that says it. The only thing I'd point out is that this is a physically different line into the house, not the same service with a new name. What actually went wrong for you?",
      why: "It validates without grovelling, names the concrete change instead of asking for faith, and ends on a question so they do the talking.",
    },
    trap: "Defending the company. Their complaint is evidence, not an attack you have to rebut.",
    reopener: "What happened, specifically? I'd rather know than guess.",
  },
  {
    key: "price",
    taxonomyKey: "price",
    cue: "It costs too much.",
    chip: "Costs too much",
    whatItMeans:
      "Either it genuinely does not fit the budget, or they are comparing your number to a promotional rate they are no longer on. Find out which before answering.",
    techniques: ["active_listening", "honest_loss_aversion", "simplifying_choices"],
    ladder: {
      weak: "It's actually a really good deal compared to what you're paying.",
      improved: "Fair. What are you paying now, roughly?",
      excellent:
        "That's fair, and I'd rather not guess at your budget. What's on the bill now? A lot of people here are still comparing against a promo rate that ended a year ago, and if that's the case for you, you already know the number I'm about to say.",
      why: "It asks instead of assuming, and the loss-aversion move is honest: it points at money already leaving their account, not at an invented deadline.",
    },
    trap: "Discounting on the porch, or hinting at a price you cannot actually give. Quote the live offer for the market and nothing else.",
    reopener: "What's the number on your bill now? That's the only comparison that matters.",
  },
  {
    key: "spouse",
    taxonomyKey: "spouse",
    cue: "I need to ask my spouse.",
    chip: "Ask my spouse",
    whatItMeans:
      "Frequently real, and treating it as a brush-off insults a household that makes decisions together. Sometimes it is a soft no, and the way you find out is to make it easy to be a real yes.",
    techniques: ["active_listening", "asking_permission", "simplifying_choices"],
    ladder: {
      weak: "What would they say? I mean, it's your bill too, right?",
      improved: "Of course. When are you both around?",
      excellent:
        "That's how it should work. Two options: I can leave the plan and the price in writing so you're not repeating me from memory, or I can swing back when you're both here. Is there an evening this week that's easier?",
      why: "It respects the household, removes the memory problem that kills most spouse callbacks, and offers two concrete options instead of an open question.",
    },
    trap: "Trying to get them to commit without the other person. It creates cancels, chargebacks and a household that will not open the door next time.",
    reopener: "What's a normal evening for you two? I'd rather catch you both than have you relay it.",
  },
  {
    key: "renter",
    taxonomyKey: "renter",
    cue: "I'm renting.",
    chip: "Renting",
    whatItMeans:
      "Renters buy internet in their own name constantly. The blocker is usually the assumption that they cannot, plus a real worry about drilling holes and signing terms they cannot exit.",
    techniques: ["active_listening", "asking_permission", "simplifying_choices"],
    ladder: {
      weak: "That doesn't matter, anyone can sign up.",
      improved: "That's fine, the account would be in your name. Do you know if your lease says anything about it?",
      excellent:
        "That's common on this street. Three things usually matter to renters: whose name the account is in, which is yours, whether anything permanent happens to the building, and whether you're locked into a term if you move. Worth a look at the lease, but none of those are usually the problem people expect.",
      why: "It answers the three real questions in order, and it sends them to their own lease rather than telling them what it says.",
    },
    trap: "Telling a renter what their lease permits. You have not read it, and being wrong here can cost them their deposit.",
    reopener: "Do you know how long you're staying? That changes which plan makes sense.",
  },
  {
    key: "too_busy",
    taxonomyKey: "too_busy",
    cue: "I'm busy.",
    chip: "Busy",
    whatItMeans:
      "Usually literal. Something is on the stove, a call starts in ten minutes, a kid is yelling. It is not a rejection, it is a scheduling fact.",
    techniques: ["asking_permission", "simplifying_choices", "leaving_respectfully"],
    ladder: {
      weak: "It'll only take a second, I promise.",
      improved: "No problem. Is there a better time today?",
      excellent:
        "Then I won't hold you. One line so the knock isn't wasted: fiber went in on your street, and the plan runs the same speed up as down. I'm on this block until about six if you want the rest.",
      why: "It gives back the time it asked for, leaves one concrete fact behind, and names a window instead of demanding a commitment.",
    },
    trap: "Saying it will only take a second and then taking four minutes. You have now taught them your word is soft.",
    reopener: "Is there a better time today, or should I catch you on the next pass?",
  },
  {
    key: "leave_something",
    taxonomyKey: "leave_something",
    cue: "Send me information.",
    chip: "Send me info",
    whatItMeans:
      "Sometimes a polite exit, sometimes genuine. Either way the paper alone almost never converts, so the move is to leave something AND get one piece of information back.",
    techniques: ["active_listening", "asking_permission", "simplifying_choices"],
    ladder: {
      weak: "I don't really have anything to leave, but let me just explain.",
      improved: "Sure, I'll leave this. What's the best way to follow up?",
      excellent:
        "Happy to. Before I do, one question so what I leave is actually useful: is it the price you'd want to compare, or the speed? I'll write the relevant one on here so it's not a generic flyer.",
      why: "It honors the request immediately, then asks a single question that turns a brush-off into a qualified follow-up. Nothing is withheld to force a conversation.",
    },
    trap: "Refusing to leave anything until they hear the pitch. That converts a soft no into a complaint.",
    reopener: "Is price or speed the thing you'd be comparing? I'll note that on here.",
  },
  {
    key: "data_source",
    taxonomyKey: null,
    cue: "How did you get my information?",
    chip: "How'd you get my info",
    whatItMeans:
      "A privacy question, and it deserves a straight privacy answer. Usually they have just realised you knew something about the address and want to know why.",
    techniques: ["active_listening", "verifiable_social_proof", "leaving_respectfully"],
    ladder: {
      weak: "It's just public information, everybody has it.",
      improved: "Fair question. We work from the address list for the streets where the build is finished.",
      excellent:
        "Fair question, and I'd ask it too. I don't have anything personal about you. I have a list of addresses on the streets where the fiber build finished, which comes from the build records, and I'm walking it door to door. If you'd rather not be knocked again, I can note this address and it comes off my list.",
      why: "It answers precisely, distinguishes an address from personal data, and offers the opt-out before being asked. That last part is what converts a complaint into trust.",
    },
    trap: "Being vague, joking, or saying it is public record without explaining what you actually hold. Vagueness here reads as evasion and generates complaints.",
    reopener: "Do you want me to note the address so nobody knocks it again?",
  },
];

const BY_KEY: ReadonlyMap<string, AcademyObjection> = new Map(ACADEMY_OBJECTIONS.map((o) => [o.key, o]));

export function getAcademyObjection(key: string): AcademyObjection | undefined {
  return BY_KEY.get(key);
}

export function isAcademyObjectionKey(value: unknown): value is AcademyObjectionKey {
  return typeof value === "string" && BY_KEY.has(value);
}

/** Objections that also exist in the frozen drill taxonomy, so the Coach deck
 *  and the Academy dojo can cross-link without duplicating content. */
export function taxonomyBackedObjections(): AcademyObjection[] {
  return ACADEMY_OBJECTIONS.filter((o) => o.taxonomyKey !== null && isObjectionKey(o.taxonomyKey));
}
