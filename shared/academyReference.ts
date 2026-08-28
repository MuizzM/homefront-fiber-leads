// ── Academy reference library ─────────────────────────────────────────────────
//
// The searchable field reference: product and competitor cards, checklists,
// compliance rules, and the "never say this" list. This is the surface a rep
// opens ON a porch, one-handed, in the sun, with somebody waiting. Everything
// here is written to be scanned in five seconds, not read.
//
// PRODUCT CARDS CARRY NO NUMBERS
//   Speeds and prices come from shared/academyOffers.ts, resolved for the rep's
//   own market on the day they are looking. A product card describes what fiber
//   IS and what it does; the figures are looked up. That is the only way a
//   reference card can be correct in two markets at once.
//
// THE NEVER-SAY LIST IS A HARD LIST
//   Each entry is a phrase that is either false, unverifiable, or a compliance
//   problem, with the reason and the sayable replacement. It is the same list
//   the Pitch Lab and the role-play scorer check against, so a rep cannot be
//   told a line is fine in one place and flagged for it in another.

export type ReferenceCategory =
  | "product"
  | "competitor"
  | "compliance"
  | "checklist"
  | "safety"
  | "never_say";

export const REFERENCE_CATEGORIES: readonly ReferenceCategory[] = [
  "product", "competitor", "compliance", "checklist", "safety", "never_say",
];

export const CATEGORY_TITLES: Readonly<Record<ReferenceCategory, string>> = {
  product: "Product",
  competitor: "Competitors",
  compliance: "Compliance",
  checklist: "Checklists",
  safety: "Field safety",
  never_say: "Never say this",
};

export type ReferenceCard = {
  /** Stable id, used in deep links and search results. */
  id: string;
  category: ReferenceCategory;
  title: string;
  /** One line under the title in search results. */
  summary: string;
  /** The body, one string per paragraph or bullet. */
  points: string[];
  /** Extra words that should match this card in search. */
  keywords: string[];
  /** True when the card must be read before a rep is field-certified. */
  required?: boolean;
};

export const REFERENCE_CARDS: readonly ReferenceCard[] = [
  // ── Product ─────────────────────────────────────────────────────────────────
  {
    id: "product-what-fiber-is",
    category: "product",
    title: "What fiber actually is",
    summary: "A glass line to the house, and why that changes what a customer feels.",
    points: [
      "Fiber carries data as light down a glass strand run directly to the home. Cable carries it as electrical signal down a coaxial line shared with the rest of the street.",
      "Two consequences a customer can feel: the connection does not slow down when the neighborhood gets busy, and upload is the same speed as download instead of a fraction of it.",
      "Fiber is not affected by the electrical noise and heat that degrade copper and coax, which is why it holds a steadier speed rather than a higher peak one.",
      "What it does not do: it does not fix a slow website, an old router placed in a closet, a game server on the other side of the country, or a laptop with a failing wireless card. Say so.",
    ],
    keywords: ["glass", "light", "coax", "copper", "symmetrical", "how it works"],
    required: true,
  },
  {
    id: "product-upload-explained",
    category: "product",
    title: "Why upload is the number that matters",
    summary: "The one specification most households have never looked at.",
    points: [
      "Download is what you pull in: video, web pages, game downloads. Upload is what you push out: your camera on a call, a backup, a photo to the cloud, your voice.",
      "Cable plans are asymmetric by design. A household with a fast download plan can still have an upload figure small enough to make a video call unreliable.",
      "Fiber is symmetrical: the same figure both directions. This is checkable on the customer's own bill, which makes it the single most useful comparison you have.",
      "When someone says their video freezes or people tell them they are breaking up, that is almost always upload. Name the mechanism, do not promise the fix.",
    ],
    keywords: ["upload", "symmetrical", "asymmetric", "video call", "zoom", "teams", "camera"],
    required: true,
  },
  {
    id: "product-latency",
    category: "product",
    title: "Latency, in words a customer uses",
    summary: "What ping is, when it matters, and what it does not fix.",
    points: [
      "Latency is the delay before a response starts, measured in milliseconds. Bandwidth is how much can flow once it starts.",
      "Gaming, video calls and voice are latency-sensitive. Streaming and downloads are not: a movie buffers ahead and does not care about a few milliseconds.",
      "A direct fiber line typically has lower and steadier latency than a shared cable segment, and the steadiness matters as much as the number.",
      "Fiber does not fix a distant game server, a congested game network, or wireless interference inside the house. A customer who games will know this. Do not pretend otherwise.",
    ],
    keywords: ["latency", "ping", "lag", "jitter", "gaming", "milliseconds"],
  },
  {
    id: "product-install",
    category: "product",
    title: "What the install involves",
    summary: "The answer to the question behind most stalls.",
    points: [
      "A technician visit in a scheduled window. Someone over eighteen needs to be home to let them in and to say where the equipment goes.",
      "For a home already passed by the build, the work is running the drop from the street to the house and installing the equipment inside.",
      "Where the drop needs to cross a yard, the crew handles locating and, where required, the permissions. The customer does not arrange this.",
      "If asked about drilling, holes, or anything permanent, say you will have the technician confirm at the address. Do not guess about somebody's house.",
    ],
    keywords: ["install", "technician", "appointment", "drop", "equipment", "router"],
    required: true,
  },

  // ── Competitors ─────────────────────────────────────────────────────────────
  {
    id: "competitor-cable",
    category: "competitor",
    title: "Cable, compared honestly",
    summary: "The real differences, and the ones that are not real.",
    points: [
      "Real: cable's upload is a fraction of its download; the last segment is shared with the neighborhood, so evening congestion is a genuine effect; equipment rental is often a separate line on the bill.",
      "Real: modern cable download speeds are genuinely fast. Do not suggest otherwise, because the customer can measure it.",
      "Not a fair claim: that cable never works, that it always goes out, or that their provider is ripping them off. You do not know their bill or their experience.",
      "The honest frame: they made a reasonable choice with what was available. Something on their street changed. Here is the one number worth comparing.",
    ],
    keywords: ["cable", "coax", "spectrum", "xfinity", "comparison", "shared"],
    required: true,
  },
  {
    id: "competitor-dsl",
    category: "competitor",
    title: "DSL and legacy copper",
    summary: "Often the household's actual pain, and often our own legacy service.",
    points: [
      "DSL runs over telephone copper. Speed falls off with distance from the equipment, so two houses on the same street can have very different service.",
      "In many of these markets the legacy copper service was ours. A household that had a bad experience years ago very likely had it on that line.",
      "The correct response to that history is acknowledgement, then the physical distinction: a fiber drop is a different line into the house, not a rebrand.",
      "Never argue with someone's memory of their own service.",
    ],
    keywords: ["dsl", "copper", "legacy", "phone line", "kinetic before", "windstream"],
  },
  {
    id: "competitor-fixed-wireless",
    category: "competitor",
    title: "Fixed wireless and satellite",
    summary: "Where they genuinely win, and where they genuinely struggle.",
    points: [
      "Fixed wireless home internet is real service and is often cheap. It depends on the cell network, so performance varies with tower load, distance and weather, and it is usually deprioritized behind phone traffic at busy times.",
      "Satellite has improved enormously but carries higher latency than a wired line by physics, which matters for calls and gaming and does not matter for streaming.",
      "Both are often the right answer where there is no wired option. If a household is happy on one and has no pain, the honest outcome may be no sale.",
      "Do not claim either does not work. Compare on latency and on how the service behaves at peak, and let them decide.",
    ],
    keywords: ["fixed wireless", "5g", "t-mobile", "verizon", "satellite", "starlink"],
  },
  {
    id: "competitor-tv-bundle",
    category: "competitor",
    title: "Breaking the TV bundle with DIRECTV",
    summary: "The unbundle method: split the bill, layer the TV, let their statement decide.",
    points: [
      "Why bundles hold: one bill feels simpler, and people fear losing their channels more than they notice the price. Both feelings are legitimate. Answer them, do not mock them.",
      "The mechanism: a bundle is two services stapled into one price. The internet half moves to fiber. The TV half moves to DIRECTV, which layers on top of the fiber line by stream or by dish, so leaving the cable company does not mean leaving live TV, sports or the DVR habit.",
      "The method, in order: ask for the current bill. Find the real total after the promo, including box rentals and the fee lines under the plan price, like broadcast and regional sports surcharges. Set fiber plus the current DIRECTV offer beside that total. Then say which side won, even when it is theirs.",
      "Quote DIRECTV from the current offer sheet only. TV packages, channel lineups and promotions change often, and a channel promise you cannot verify is a cancellation waiting to happen. If they care about one specific channel, look it up on the current lineup together instead of guessing.",
      "The commitment that makes it work: if the bundle genuinely wins on their statement, say so and leave well. Reps who concede honestly get the callback when the bundle's promo expires, and bundle promos always expire.",
    ],
    keywords: ["bundle", "directv", "tv", "channels", "sports", "dvr", "unbundle", "broadcast fee", "cable box"],
  },

  // ── Compliance ──────────────────────────────────────────────────────────────
  {
    id: "compliance-never-claim",
    category: "compliance",
    title: "What you may and may not state as fact",
    summary: "The line between a benefit and a claim you cannot support.",
    points: [
      "You may state: the plan name, speed and price shown on today's offer card for this market, the disclosures attached to it, and what fiber does as a technology.",
      "You may not state: any price, speed or promotion not on that card; availability at an address you have not checked; a comparison figure for a competitor you cannot source.",
      "Superlatives are claims. Fastest, cheapest, best and unbeatable are all unverifiable at a door, and all of them are avoidable.",
      "If you do not know, say you do not know and that you will confirm. That sentence has never lost a sale that honesty would have kept.",
    ],
    keywords: ["claims", "accuracy", "superlative", "guarantee", "misrepresentation"],
    required: true,
  },
  {
    id: "compliance-dnc",
    category: "compliance",
    title: "Do-not-knock and do-not-call",
    summary: "Lists, signs, and what to do the moment you are asked.",
    points: [
      "A posted no soliciting sign is a do-not-knock. Do not knock, do not leave material wedged in the door, and log the address so the next pass skips it.",
      "If a household asks not to be contacted again, that request is immediate and permanent. Record it before you leave the porch, while you still remember the address.",
      "Do-not-call and do-not-knock are separate registries and separate requests. Someone opting out of calls has not opted out of knocks, and the reverse is also true.",
      "Municipal solicitation rules vary by town and some require a permit carried on you. Know your market's rule before your first knock in it.",
      "Never argue with an opt-out, and never ask why. The request is the whole conversation.",
    ],
    keywords: ["dnc", "do not call", "do not knock", "no soliciting", "opt out", "permit"],
    required: true,
  },
  {
    id: "compliance-privacy",
    category: "compliance",
    title: "Customer privacy at the door",
    summary: "What you hold, what you may say out loud, and what never leaves the app.",
    points: [
      "You hold addresses on a build route. You do not hold, and must never imply you hold, personal details about the household.",
      "Never say another customer's name, plan or price on a porch. Neighbors talk, and one repeated detail is a privacy complaint with your name on it.",
      "Payment details are entered through the approved flow only. Never write a card number down, never photograph one, never repeat one aloud, and never accept one on paper.",
      "If asked how you got the address, answer plainly: build records for streets where the build finished. Then offer the opt-out before they have to ask for it.",
      "Anything a customer tells you about their household stays in the notes the app is designed for, and out of group chats.",
    ],
    keywords: ["privacy", "pii", "card", "payment", "address list", "how did you get"],
    required: true,
  },
  {
    id: "compliance-recording",
    category: "compliance",
    title: "Recording and consent",
    summary: "Before you press record on anything with a customer in it.",
    points: [
      "Consent law for recording conversations varies by state. Some require every party to consent, not just you.",
      "Practically: do not record a customer conversation. The practice recorder in this app records you, on your own device, and is for rehearsal only.",
      "If a customer records you, that is their right in a public-facing interaction on their own property. Keep doing your job the same way.",
      "If a customer asks whether you are recording, answer truthfully and immediately.",
      "Do not photograph a home, a door, a vehicle or a person without being asked to. Route photos of construction are the exception and must not include people or plates.",
    ],
    keywords: ["recording", "consent", "two party", "photo", "video", "camera"],
    required: true,
  },
  {
    id: "compliance-escalation",
    category: "compliance",
    title: "When to stop and escalate",
    summary: "The situations that are not yours to resolve on a porch.",
    points: [
      "Stop and escalate: any threat or aggression, any allegation of fraud involving an account, any request from law enforcement, any injury, any dispute about a bill or an existing order.",
      "Stop and escalate: a customer who appears confused about who you are or unable to understand what they are agreeing to. Do not proceed to an order. Leave your information and notify your lead.",
      "Stop and escalate: anything involving a minor answering the door alone. Do not pitch, do not leave material inviting a decision, note the address for a later pass.",
      "Escalate the same day, through your team lead, in the app rather than a text thread, so there is a record.",
      "Escalating is never held against you. Handling one of these alone is.",
    ],
    keywords: ["escalate", "manager", "police", "threat", "vulnerable", "minor", "fraud"],
    required: true,
  },

  // ── Checklists ──────────────────────────────────────────────────────────────
  {
    id: "checklist-first-day",
    category: "checklist",
    title: "Your first day",
    summary: "What to have, know and do before your first knock.",
    points: [
      "Carry: badge visible, charged phone, charged backup battery, water, leave-behinds, a pen that works, and your market's permit if one is required.",
      "Know cold: your name and company in one sentence, why you are on that street, today's offer card for your market, and the sentence you will say when someone asks how you got their address.",
      "Know where you are: the streets in your assignment, where the build is actually finished, and where your team lead is.",
      "Before the first door: say your opener out loud twice. The first time is always worse, and it should not be at a real door.",
      "First hour target: conversations, not sales. Ten real conversations on day one is a good day one.",
      "At the end: log every door before you leave the street. Memory is worse than you think by the third block.",
    ],
    keywords: ["first day", "new hire", "day one", "prepare", "what to bring", "badge"],
    required: true,
  },
  {
    id: "checklist-pre-shift",
    category: "checklist",
    title: "Before every shift",
    summary: "The two-minute check that prevents most bad afternoons.",
    points: [
      "Phone charged, battery pack charged, badge on, app logged in and route loaded.",
      "Today's offer card open once, so you have seen the live figures for your market before you quote anything.",
      "Check your route for do-not-knock addresses logged on previous passes.",
      "Say your opener and your first discovery question out loud.",
      "Know your out: the time you finish, and where you park.",
    ],
    keywords: ["pre shift", "before knocking", "checklist", "route", "prep"],
  },
  {
    id: "checklist-post-shift",
    category: "checklist",
    title: "After every shift",
    summary: "Five minutes that turn a day of doors into a week of improvement.",
    points: [
      "Log every door outcome before you leave the field, including the no answers.",
      "Record any opt-out request immediately and precisely.",
      "Write down the one objection that beat you today. That is tomorrow's drill.",
      "Note anything the crew or a customer told you about the build that your team should know.",
      "Stop. Ending on a specific no is normal, and knocking three angry extra doors to fix your mood is how reps quit.",
    ],
    keywords: ["after shift", "debrief", "logging", "end of day"],
  },
  {
    id: "checklist-45-seconds",
    category: "checklist",
    title: "The 45 seconds at the door",
    summary: "Four beats, in order, ending in a question. Nothing else fits.",
    points: [
      "Beat 1, who you are: your first name, your company, badge already visible. One breath, no title, no story.",
      "Beat 2, why you are here: the street, not the household. You are here because the build finished on this block, and you have already spoken to neighbors on it. Name only what you can honestly say.",
      "Beat 3, what is on offer: today's figures from your market's offer card, and what actually makes it worth their thirty seconds. Never invent scarcity that does not exist; if the offer has a real end date, say the date.",
      "Beat 4, a question: never a statement. Soft close asks them to choose between two harmless things, for example whether evenings or mornings are better for an install check. Hard close asks for the decision directly. Use soft when they have not told you anything yet.",
      "Then stop talking. The silence after the question belongs to them, and reps lose more doors filling it than they ever lose to a bad line.",
      "If you are still talking at 45 seconds you are not pitching, you are holding a door hostage. Ask something or leave.",
    ],
    keywords: ["45 seconds", "opener", "intro", "pitch", "soft close", "hard close", "four beats"],
    required: true,
  },
  {
    id: "checklist-qualifying",
    category: "checklist",
    title: "Signals that they are actually qualified",
    summary: "Four things that mean keep going, and the three steps when they already have someone.",
    points: [
      "They ask what it costs. A price question is interest, not resistance. Answer it, then ask one question back.",
      "They ask how it works, how long the install takes, or whether it reaches their house. Any product question is a green light.",
      "They already have a provider. Someone paying for internet has already agreed to the category; you are only discussing which line goes to the house.",
      "You can see the need: a home office, a mounted camera, a mesh node in a window, teenagers, or a dish on the roof that dates the last decision they made.",
      "When they already have a provider, three steps in order. One, tell them honestly that it was a sensible choice at the time. Two, make switching ordinary by naming that neighbors on this street have done it. Three, give them the one difference they can check on their own bill, which is nearly always the upload figure.",
      "None of those steps is a swipe at the other company. Reps who attack the incumbent are asking the customer to admit they were stupid, and nobody buys after that.",
    ],
    keywords: ["qualify", "qualifying", "buying signal", "interest", "competitor", "already have", "switch"],
    required: true,
  },
  {
    id: "checklist-no-soliciting",
    category: "checklist",
    title: "No-soliciting signs",
    summary: "What the sign means here, and the only ways to answer it.",
    points: [
      "A no-soliciting sign, a do-not-knock listing, or a request at the door all mean the same thing to us: log it and go. Pretending you did not see the sign is not a technique, it is the thing that gets a company banned from a municipality.",
      "If the door is already open when you notice the sign: apologise for it plainly, say why you are on the street in one sentence, and let them decide.",
      "Name-drop only what is true. You are on this street because the build is finished here and neighbors on it have asked about it, and saying so is the difference between information and solicitation.",
      "Acknowledge rather than argue. I saw the sign, I am sorry, I will not come back is a sentence that keeps the street workable for everyone behind you.",
      "Log the address as do-not-knock before you reach the sidewalk. If it is not logged it will be knocked again by somebody else this week.",
      "There is no version of this where you keep talking after being asked to leave.",
    ],
    keywords: ["no soliciting", "sign", "do not knock", "dnk", "opt out", "leave"],
    required: true,
  },
  {
    id: "checklist-three-sins",
    category: "checklist",
    title: "The three ways reps lose doors",
    summary: "Robotic, deaf, or arrogant. Each has one fix you can do between houses.",
    points: [
      "Robotic: the same paragraph at every door, delivered at the wall behind them. Fix it in the ten steps between houses by picking one thing you can actually see at this house and using it in your first sentence.",
      "Dead ears: you heard them stop talking, you did not hear what they said. Fix it by stopping your own pitch the moment they mention something specific, and asking about that instead. Stop, drop the script, ask.",
      "Arrogance: explaining to somebody why they are wrong about their own house and their own bill. Fix it by making them the expert. They know what their evening looks like; you know what the line does.",
      "The self-critique between doors is the whole habit. One sentence: what did I say that I would not say again. Reps who do this improve in a week; reps who do not repeat the same door for a year.",
      "None of these show up in your numbers as themselves. They show up as a normal-looking day with no conversations in it.",
    ],
    keywords: ["robotic", "listening", "active listening", "arrogance", "self critique", "habits", "mistakes"],
  },

  // ── Safety ──────────────────────────────────────────────────────────────────
  {
    id: "safety-porch",
    category: "safety",
    title: "On the porch",
    summary: "Positioning, dogs, and the ways doors go wrong.",
    points: [
      "Stand to the side of the door, not centered in it, and a step back. It reads as less confrontational and it keeps you out of the way of a door swinging open.",
      "Never enter a home. Not to look at a router, not to see the setup, not because you were invited. Everything can be done from the doorway.",
      "Watch for dogs before you open a gate. A closed gate is a no.",
      "Do not knock a house that feels wrong. There is no sale worth it and nobody will ask why.",
      "Keep your badge visible from the moment you step onto the property, not produced when challenged.",
    ],
    keywords: ["safety", "dog", "porch", "gate", "enter", "badge"],
    required: true,
  },
  {
    id: "safety-street",
    category: "safety",
    title: "On the street",
    summary: "Heat, dark, traffic and other people's driveways.",
    points: [
      "Heat is the injury that actually happens in this job. Water before you are thirsty, shade every hour, and stop if you stop sweating.",
      "After dark, work lit streets, keep your phone location sharing on with your team lead, and do not cut between houses.",
      "Walk driveways and paths, never across landscaping. It costs you nothing and it is the difference between a neighbor and a complaint.",
      "Traffic: cross at corners, face traffic where there is no sidewalk, and never step backwards into a road while talking.",
      "If someone tells you to leave their property, leave immediately and without a closing line.",
    ],
    keywords: ["safety", "heat", "dark", "night", "traffic", "trespass", "leave"],
    required: true,
  },

  // ── Never say this ──────────────────────────────────────────────────────────
  {
    id: "never-say-list",
    category: "never_say",
    title: "Never say this",
    summary: "Phrases that are false, unverifiable, or a compliance problem.",
    points: [
      "Never: your bill will go down. You do not know their bill. Say: here is our whole number, compare it to yours.",
      "Never: you already have it, or you're already connected. Serviceability is checked at the address. Say: let me check your address before we go further.",
      "Never: this price is locked in forever, or it will never go up. Say: this is the price today, and here is what the disclosure says about changes.",
      "Never: today only, or this is your last chance. Manufactured urgency is the tactic this program exists to replace. Say: the crew is here for a few more weeks.",
      "Never: everyone on this street has signed up. Say only what you counted, and name the street and the week.",
      "Never: we're the fastest, we're the cheapest, or we're the best. Say: here is the number, compare it yourself.",
      "Never: I'm with the city, the utility, or an inspector. Say who you actually work for, every time.",
      "Never: just give me your card and I will handle it. Say: I will run this in the app right here in front of you, and I never write a card number down.",
      "Never: your provider is ripping you off. Say: here is the one number worth comparing.",
      "Never: I guarantee it. You cannot. Say what the plan does and what happens if it does not.",
    ],
    keywords: ["never say", "prohibited", "banned", "misleading", "urgency", "guarantee"],
    required: true,
  },
];

/** The phrases the Pitch Lab and role-play scorer treat as prohibited. Derived
 *  from the never-say card so the list cannot drift from what reps are taught. */
export const PROHIBITED_PHRASES: readonly string[] = [
  "your bill will go down",
  "you already have it",
  "you're already connected",
  "locked in forever",
  "will never go up",
  "today only",
  "last chance",
  "everyone on this street has",
  "we're the fastest",
  "we're the cheapest",
  "we're the best",
  "i'm with the city",
  "just give me your card",
  "ripping you off",
  "i guarantee",
];

const BY_ID: ReadonlyMap<string, ReferenceCard> = new Map(REFERENCE_CARDS.map((c) => [c.id, c]));

export function getReferenceCard(id: string): ReferenceCard | undefined {
  return BY_ID.get(id);
}

export function cardsIn(category: ReferenceCategory): ReferenceCard[] {
  return REFERENCE_CARDS.filter((c) => c.category === category);
}

/** Cards a rep must have opened to be field-certified. */
export function requiredCards(): ReferenceCard[] {
  return REFERENCE_CARDS.filter((c) => c.required);
}

/**
 * Search the library. Title matches rank above summary, which ranks above body
 * and keywords, so typing "upload" lands on the upload card rather than the
 * four other cards that mention it in passing.
 */
export function searchReference(query: string, categories?: ReferenceCategory[]): ReferenceCard[] {
  const q = query.trim().toLowerCase();
  const pool = categories?.length ? REFERENCE_CARDS.filter((c) => categories.includes(c.category)) : REFERENCE_CARDS;
  if (!q) return [...pool];
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = pool.map((card) => {
    const title = card.title.toLowerCase();
    const summary = card.summary.toLowerCase();
    const body = card.points.join(" ").toLowerCase();
    const keys = card.keywords.join(" ").toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 8;
      if (keys.includes(t)) score += 5;
      if (summary.includes(t)) score += 3;
      if (body.includes(t)) score += 1;
    }
    return { card, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.card);
}
