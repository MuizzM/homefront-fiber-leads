// ── Momentum spiffs — catch a rep while they are hot ─────────────────────────
// Three incentive layers already exist and all of them are scheduled or
// retrospective:
//
//   spiffEngine      rewards what already happened, off sale history
//   spiffCampaign    a contest someone launched this morning
//   knockMilestones  a standing ladder that resets each pay period
//
// None of them react to the thing that actually decides a rep's afternoon: a
// run where the doors are opening, the conversations are landing, and nothing
// has closed yet. That rep is thirty minutes from either a sale or going flat,
// and which one happens is genuinely influenceable.
//
// A momentum spiff is a PERSONAL, TIME-BOXED, SELF-ARMING offer that appears at
// exactly that moment:
//
//     "You're hot — 3 conversations in the last hour.
//      Close one in the next 40 minutes and it's +$40."
//
// ── WHAT MAKES A STREAK, AND WHY IT IS NOT DOOR COUNT ───────────────────────
//
// Knocking fast is not being hot. A rep can burn forty doors in an hour by
// walking a dead street and logging `not_home` at every one — that is activity,
// not momentum, and paying to accelerate it teaches speed over conversation.
//
// The signal that actually predicts a close is CONVERSATION QUALITY: doors that
// opened, people who engaged, interest that did not convert yet. So the trigger
// is a composite, and every part must clear:
//
//   pace          — doors above the rep's OWN trailing baseline (they are in rhythm)
//   conversation  — enough doors actually opened (not a dead street)
//   interest      — at least one live signal: interested / follow-up
//   dry           — no sale yet in the dry window (or there is nothing to convert)
//
// ── SANDBAGGING IS THE OBVIOUS ATTACK, AND FLOORS ARE THE ANSWER ────────────
//
// Any rule measured against a rep's own baseline invites them to lower it:
// coast for two weeks, then "spike" to 12 doors and collect. That is why the
// pace ratio is necessary but NOT sufficient — absolute floors sit alongside
// it, so a low baseline can never manufacture an offer on its own. You have to
// actually be working to look like you are working.
//
// PURE: no clock, no database. The caller supplies `nowMs` and the rep's live
// signals, already resolved from verified field activity.

import { usd } from "./moneyFormat";

export interface MomentumConfig {
  /** Rolling window the signals are measured over. */
  windowMinutes: number;
  /** How long an armed offer stays live. Short enough to be urgent, long
   *  enough to actually walk to another door and have a conversation. */
  offerMinutes: number;
  /** No sale in this many minutes, or there is nothing to convert. */
  dryMinutes: number;

  // ── Floors. Absolute, and checked BEFORE the ratio, so sandbagging a
  // baseline cannot arm an offer on its own.
  minDoorsInWindow: number;
  minConversationsInWindow: number;
  minInterestSignals: number;
  /** Pace must beat the rep's own trailing baseline by at least this multiple. */
  paceRatio: number;

  /** Momentum score (0–100) required to arm. */
  armAtScore: number;

  /** Offer tiers, ascending by the score that unlocks them. */
  tiers: Array<{ atScore: number; amountCents: number }>;

  /** Bounds. 0 = uncapped. */
  maxOffersPerRepPerDay: number;
  maxCentsPerRepPerDay: number;
  maxCentsPerOrgPerDay: number;

  enabled: boolean;
}

export const DEFAULT_MOMENTUM_CONFIG: MomentumConfig = {
  windowMinutes: 90,
  offerMinutes: 45,
  dryMinutes: 90,

  // A rep working a live street clears these without thinking about them; a rep
  // logging not_home down a dead block never does.
  minDoorsInWindow: 12,
  minConversationsInWindow: 3,
  minInterestSignals: 1,
  paceRatio: 1.15,

  armAtScore: 55,

  // Deliberately steep at the top. The whole point is that the last tier is
  // worth changing your behaviour for.
  tiers: [
    { atScore: 55, amountCents: 2_500 },
    { atScore: 70, amountCents: 4_000 },
    { atScore: 85, amountCents: 6_000 },
  ],

  maxOffersPerRepPerDay: 2,
  maxCentsPerRepPerDay: 10_000,
  maxCentsPerOrgPerDay: 50_000,

  enabled: true,
};

/** Everything the rules read, resolved from VERIFIED field activity. */
export interface MomentumSignals {
  repId: number;
  /** Distinct GPS-verified doors in the window. */
  doorsInWindow: number;
  /** Doors that actually opened — anything but not_home. */
  conversationsInWindow: number;
  /** Live interest that has not closed: interested + follow_up + callback. */
  interestSignalsInWindow: number;
  /** The rep's own trailing doors-per-hour, over a longer baseline period. */
  baselineDoorsPerHour: number;
  /** Minutes since this rep's last qualified sale; null if they have never sold. */
  minutesSinceLastSale: number | null;
  /** Offers already armed for this rep today — feeds the count cap. */
  offersArmedToday: number;
  /** Cents already awarded to this rep by momentum today. */
  awardedToRepTodayCents: number;
  /** Cents already awarded org-wide by momentum today. */
  awardedOrgTodayCents: number;
}

export type MomentumBlock =
  | "disabled" | "cold" | "too_few_doors" | "too_few_conversations"
  | "no_interest" | "off_pace" | "just_sold"
  | "rep_offer_cap" | "rep_money_cap" | "org_money_cap";

const cents = (n: unknown) => Math.max(0, Math.trunc(Number(n) || 0));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * How hot is this rep, 0–100.
 *
 * Weighted toward CONVERSATION over volume on purpose: 45 points come from
 * doors that opened and interest expressed, 30 from beating their own pace, and
 * only 25 from raw door count. A rep who knocks fast and talks to nobody tops
 * out around 25 and never arms an offer — which is the correct outcome, because
 * paying them to go faster would just teach them to skip conversations.
 */
export function momentumScore(s: MomentumSignals, cfg: MomentumConfig = DEFAULT_MOMENTUM_CONFIG): number {
  const hours = Math.max(0.25, cfg.windowMinutes / 60);

  // Conversation rate — up to 30. Maxed when half the doors opened, which is a
  // genuinely good hour in this trade.
  const convRate = s.doorsInWindow > 0 ? s.conversationsInWindow / s.doorsInWindow : 0;
  const convPart = clamp(convRate / 0.5, 0, 1) * 30;

  // Live interest — up to 15. Three unconverted interested doors is a rep who
  // is one good pitch from a close.
  const interestPart = clamp(s.interestSignalsInWindow / 3, 0, 1) * 15;

  // Pace against their OWN baseline — up to 30, maxed at 2× their normal rate.
  // A rep with no baseline (new hire, first week) reads as neutral rather than
  // infinite: they get 60% of this band, so they can still arm on the strength
  // of conversations without a single day of history inventing a 10× ratio.
  const perHour = s.doorsInWindow / hours;
  const ratio = s.baselineDoorsPerHour > 0 ? perHour / s.baselineDoorsPerHour : 1.6;
  const pacePart = clamp((ratio - 1) / 1, 0, 1) * 30;

  // Raw volume — up to 25, maxed at 30 doors in the window. The smallest band,
  // because it is the most gameable and the least predictive.
  const volumePart = clamp(s.doorsInWindow / 30, 0, 1) * 25;

  return Math.round(clamp(convPart + interestPart + pacePart + volumePart, 0, 100));
}

export interface MomentumOffer {
  amountCents: number;
  expiresAtMs: number;
  score: number;
  /** The line the rep reads. Names what they did and what it is worth. */
  headline: string;
  /** The instruction. */
  callToAction: string;
}

/** The tier this score unlocks — the highest whose threshold it clears. */
export function tierFor(score: number, cfg: MomentumConfig = DEFAULT_MOMENTUM_CONFIG): number {
  const sorted = [...cfg.tiers].sort((a, b) => a.atScore - b.atScore);
  let amount = 0;
  for (const t of sorted) if (score >= t.atScore) amount = cents(t.amountCents);
  return amount;
}

/**
 * Should we arm an offer for this rep right now?
 *
 * Returns the offer, or the FIRST reason it was blocked. The reason is for the
 * admin console and the logs — it is deliberately never shown to the rep, because
 * "you were nearly hot enough" is demotivating noise and teaches them to game
 * the threshold rather than talk to people.
 */
export function evaluateMomentum(
  s: MomentumSignals, nowMs: number, cfg: MomentumConfig = DEFAULT_MOMENTUM_CONFIG,
): { offer: MomentumOffer } | { block: MomentumBlock; score: number } {
  const score = momentumScore(s, cfg);
  const no = (block: MomentumBlock) => ({ block, score });

  if (!cfg.enabled) return no("disabled");

  // Floors first, and before the score, so a sandbagged baseline can never
  // manufacture an offer out of a slow hour.
  if (s.doorsInWindow < cfg.minDoorsInWindow) return no("too_few_doors");
  if (s.conversationsInWindow < cfg.minConversationsInWindow) return no("too_few_conversations");
  if (s.interestSignalsInWindow < cfg.minInterestSignals) return no("no_interest");

  const hours = Math.max(0.25, cfg.windowMinutes / 60);
  const perHour = s.doorsInWindow / hours;
  // A rep with no baseline is not held to a ratio they cannot have.
  if (s.baselineDoorsPerHour > 0 && perHour < s.baselineDoorsPerHour * cfg.paceRatio) {
    return no("off_pace");
  }

  // Nothing to convert if they just closed one. This is not a punishment — it
  // is what stops the app offering a bonus for the sale they are already
  // writing up.
  if (s.minutesSinceLastSale != null && s.minutesSinceLastSale < cfg.dryMinutes) {
    return no("just_sold");
  }

  if (score < cfg.armAtScore) return no("cold");

  if (cfg.maxOffersPerRepPerDay > 0 && s.offersArmedToday >= cfg.maxOffersPerRepPerDay) {
    return no("rep_offer_cap");
  }

  let amount = tierFor(score, cfg);
  if (amount <= 0) return no("cold");

  // Caps TRIM rather than reject, the same rule campaigns use: an offer worth
  // less is still worth chasing, and a rep who watches the board withhold a
  // bonus entirely because it did not fit learns the board lies to them.
  if (cfg.maxCentsPerRepPerDay > 0) {
    const room = cfg.maxCentsPerRepPerDay - cents(s.awardedToRepTodayCents);
    if (room <= 0) return no("rep_money_cap");
    amount = Math.min(amount, room);
  }
  if (cfg.maxCentsPerOrgPerDay > 0) {
    const room = cfg.maxCentsPerOrgPerDay - cents(s.awardedOrgTodayCents);
    if (room <= 0) return no("org_money_cap");
    amount = Math.min(amount, room);
  }

  return {
    offer: {
      amountCents: amount,
      expiresAtMs: nowMs + cfg.offerMinutes * 60_000,
      score,
      headline: streakHeadline(s),
      callToAction: `Close one in the next ${cfg.offerMinutes} minutes for ${usd(amount)}.`,
    },
  };
}

/** Names what the rep actually did to earn the offer. Specific, because "you're
 *  on fire!" is a slogan and a rep tunes it out the second time. */
export function streakHeadline(s: MomentumSignals): string {
  if (s.interestSignalsInWindow >= 2) {
    return `${s.interestSignalsInWindow} doors interested and none closed yet`;
  }
  if (s.conversationsInWindow >= 4) {
    return `${s.conversationsInWindow} real conversations in the last hour`;
  }
  return `${s.doorsInWindow} doors and people are talking`;
}

/** The one definition lives in ./moneyFormat (dependency-free, see its header
 *  for the bundle rationale). Re-exported here so existing importers keep
 *  working — the import flows INTO this module, never out of it. */
export { usd };

/** The ledger line, and what the rep reads on their statement weeks later. */
export function momentumReason(amountCents: number): string {
  void amountCents;
  return "Hot streak - closed while running hot";
}

/** Milliseconds left on a live offer; 0 once expired. */
export function offerRemainingMs(expiresAtMs: number, nowMs: number): number {
  return Math.max(0, expiresAtMs - nowMs);
}

/** "12m left" / "1m left" / "Expired". Seconds would make the card twitch. */
export function offerCountdown(expiresAtMs: number, nowMs: number): string {
  const ms = offerRemainingMs(expiresAtMs, nowMs);
  if (ms <= 0) return "Expired";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "Under a minute";
  return `${mins}m left`;
}

/** Shared by the API and the admin form. Returns null when valid. */
export function validateMomentumConfig(input: unknown): string | null {
  const c = input as MomentumConfig | null;
  if (!c || typeof c !== "object") return "The configuration is missing.";

  const ints: Array<[string, number, number, number]> = [
    ["Window", Number(c.windowMinutes), 15, 480],
    ["Offer length", Number(c.offerMinutes), 5, 240],
    ["Dry period", Number(c.dryMinutes), 0, 1440],
    ["Minimum doors", Number(c.minDoorsInWindow), 1, 500],
    ["Minimum conversations", Number(c.minConversationsInWindow), 0, 200],
    ["Minimum interest signals", Number(c.minInterestSignals), 0, 100],
    ["Arm-at score", Number(c.armAtScore), 1, 100],
  ];
  for (const [label, v, lo, hi] of ints) {
    if (!Number.isInteger(v) || v < lo || v > hi) return `${label} must be between ${lo} and ${hi}.`;
  }
  const ratio = Number(c.paceRatio);
  if (!Number.isFinite(ratio) || ratio < 1 || ratio > 5) return "Pace multiple must be between 1 and 5.";

  if (!Array.isArray(c.tiers) || c.tiers.length === 0) return "Add at least one offer tier.";
  if (c.tiers.length > 5) return "Use at most 5 offer tiers.";
  for (const t of c.tiers) {
    const at = Number(t?.atScore), amt = Number(t?.amountCents);
    if (!Number.isInteger(at) || at < 1 || at > 100) return "Each tier's score must be between 1 and 100.";
    if (!Number.isInteger(amt) || amt < 1) return "Each tier must pay a whole number of cents above zero.";
    // The same ceiling campaigns and milestones enforce, for the same reason.
    if (amt > 100_000) return "A momentum spiff cannot exceed $1,000.";
  }
  for (const [label, v] of [
    ["Offers per rep per day", c.maxOffersPerRepPerDay],
    ["Per-rep daily cap", c.maxCentsPerRepPerDay],
    ["Org daily cap", c.maxCentsPerOrgPerDay],
  ] as const) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) return `${label} must be a whole number (0 = uncapped).`;
  }
  // An enabled config whose lowest tier is unreachable would look live and never
  // fire — worse than being switched off, because nobody would know why.
  if (c.enabled !== false) {
    const lowest = Math.min(...c.tiers.map(t => Number(t.atScore)));
    if (lowest > Number(c.armAtScore)) {
      return "The lowest tier's score must be at or below the arm-at score, or no offer can ever fire.";
    }
  }
  return null;
}
