// ── SPIFF campaigns — the incentive a manager LAUNCHES ───────────────────────
// shared/spiffEngine.ts already awards spiffs automatically off sale history
// (surprise, streak, improvement, milestone). That engine is good at rewarding
// what already happened. It cannot do the thing that actually moves a Tuesday
// afternoon: a manager saying "$75 a sale until 6 PM, go".
//
// A campaign is that — a time-boxed, rule-shaped promise, announced up front.
//
// TWO FUNCTIONS, ONE RULE. `evaluateCampaign` decides whether a rep has earned
// it; `campaignProgress` says how close they are. They read the SAME counters
// and the same trigger, so the card a rep stares at all afternoon ("18 of 40
// knocks · 2h 14m left · $75") cannot promise something the award logic then
// refuses to pay. Progress that lies is worse than no progress bar.
//
// PURE: no clock, no timezone maths, no database. The caller supplies `nowMs`
// and the rep's counters, already resolved in the org's local time. That keeps
// every rule below testable at any instant, including 11:59 on the last day.
//
// WHY THESE TRIGGERS. Paying per sale rewards the outcome; a rep having a cold
// day disengages from it by lunchtime because it is already out of reach. The
// triggers that keep someone knocking are the ones still winnable at 2 PM:
// a knock count before a cutoff, a first sale before a cutoff, a streak that
// only needs today. At least one campaign should always be effort-shaped, not
// outcome-shaped, or the bottom half of the board stops trying.

export const CAMPAIGN_TRIGGER_KINDS = [
  "per_sale", "knocks_by_time", "sale_by_time", "sales_in_day", "knock_streak",
  "knocks_and_sale_by_time",
] as const;

export type CampaignTrigger =
  /** Every qualifying sale inside the window pays the reward. */
  | { kind: "per_sale" }
  /** N knocks logged before a local hour, on a day inside the window. The pure
   *  effort trigger — winnable by anyone who walks, regardless of luck. */
  | { kind: "knocks_by_time"; knocks: number; byHourLocal: number }
  /** First sale of the day before a local hour — rewards starting early. */
  | { kind: "sale_by_time"; byHourLocal: number }
  /** N sales in a single day — rewards not stopping after the first. */
  | { kind: "sales_in_day"; sales: number }
  /** N consecutive days each clearing a knock bar — rewards showing up. */
  | { kind: "knock_streak"; days: number; knocksPerDay: number }
  /**
   * BOTH: N knocks AND a sale, both before a local hour. "20 doors and a sale
   * before 3."
   *
   * Worth its own kind rather than two campaigns, because two campaigns pay
   * twice and pay for either half alone — which is exactly the behaviour this
   * is designed to prevent. A knocks-only campaign rewards someone who walks
   * past 20 doors without pitching; a sale-only campaign rewards a lucky first
   * door and then a long lunch. Requiring both in one trigger is what makes it
   * mean "work the morning properly", and it is still winnable at 1 PM by
   * anyone willing to move, which is the property that keeps the bottom half of
   * the board trying.
   */
  | { kind: "knocks_and_sale_by_time"; knocks: number; byHourLocal: number };

export const CAMPAIGN_STATUSES = ["scheduled", "live", "paused", "ended", "cancelled"] as const;
export type CampaignStatus = typeof CAMPAIGN_STATUSES[number];

export interface SpiffCampaign {
  id: number;
  name: string;
  description: string;
  startsAtMs: number;
  endsAtMs: number;
  trigger: CampaignTrigger;
  /** Flat award, integer cents. Money is never a float. */
  rewardCents: number;
  /** null = everyone in the tenant. */
  eligibleRepIds: number[] | null;
  /** 0 = uncapped. Bounds one rep's take. */
  perRepCapCents: number;
  /** 0 = uncapped. Bounds the WHOLE campaign — the liability ceiling that stops
   *  "$75 a sale, all markets" on a hot Saturday writing an open cheque. */
  campaignCapCents: number;
  status: CampaignStatus;
}

/** Everything the rules read about one rep, resolved in the org's local time. */
export interface RepWindowCounters {
  repId: number;
  /** Knocks logged inside the campaign window. */
  knocksInWindow: number;
  /** Knocks logged TODAY before the trigger's cutoff hour. */
  knocksBeforeCutoffToday: number;
  /** Qualifying sales inside the campaign window. */
  salesInWindow: number;
  /** Qualifying sales today. */
  salesToday: number;
  /** Local hour (0–23) of today's first sale, or null if none yet. */
  firstSaleHourLocalToday: number | null;
  /** Consecutive days, ending today, clearing the streak trigger's knock bar. */
  streakDaysMeetingBar: number;
  /** Already awarded to THIS rep by THIS campaign. */
  awardedToRepCents: number;
  /** Already awarded to everyone by THIS campaign. */
  awardedTotalCents: number;
}

export interface CampaignAward {
  campaignId: number;
  repId: number;
  amountCents: number;
  /** Short, rep-readable reason — goes on the ledger row and the announcement. */
  reason: string;
}

/** Why a campaign did NOT pay. Surfaced to admins; never shown as a rep-facing
 *  failure, because "you missed it" is demotivating noise after the fact. */
export type CampaignSkip =
  | "not_live" | "window_closed" | "not_eligible"
  | "trigger_unmet" | "rep_cap_reached" | "campaign_cap_reached";

const cents = (n: unknown) => Math.max(0, Math.trunc(Number(n) || 0));

/** Is the campaign accepting awards at this instant? */
export function isCampaignLive(c: SpiffCampaign, nowMs: number): boolean {
  if (c.status !== "live") return false;
  return nowMs >= c.startsAtMs && nowMs < c.endsAtMs;
}

/** Has this rep been included? A null list means the whole tenant. */
export function isRepEligible(c: SpiffCampaign, repId: number): boolean {
  return c.eligibleRepIds == null || c.eligibleRepIds.includes(repId);
}

/**
 * Has the rep met the trigger? Pure predicate over the counters — no money, no
 * caps, no window. Split out so `campaignProgress` and `evaluateCampaign` can
 * never disagree about what "met" means.
 */
export function triggerMet(trigger: CampaignTrigger, counters: RepWindowCounters): boolean {
  switch (trigger.kind) {
    case "per_sale":
      return counters.salesInWindow > 0;
    case "knocks_by_time":
      return counters.knocksBeforeCutoffToday >= Math.max(1, trigger.knocks);
    case "sale_by_time":
      return counters.firstSaleHourLocalToday != null
        && counters.firstSaleHourLocalToday < trigger.byHourLocal;
    case "sales_in_day":
      return counters.salesToday >= Math.max(1, trigger.sales);
    case "knock_streak":
      return counters.streakDaysMeetingBar >= Math.max(1, trigger.days);
    case "knocks_and_sale_by_time":
      // BOTH halves, both before the cutoff. The sale check reuses
      // firstSaleHourLocalToday rather than salesToday so a sale closed at 4 PM
      // cannot satisfy a "before 3" campaign.
      return counters.knocksBeforeCutoffToday >= Math.max(1, trigger.knocks)
        && counters.firstSaleHourLocalToday != null
        && counters.firstSaleHourLocalToday < trigger.byHourLocal;
    default:
      return false;
  }
}

export interface CampaignProgress {
  /** Where the rep is now, in the trigger's own unit. */
  current: number;
  /** What they need. */
  target: number;
  /** 0–100, clamped. */
  pct: number;
  met: boolean;
  /** Milliseconds left in the window; 0 once closed. Drives the countdown. */
  msRemaining: number;
  /** One line the rep reads. Concrete and second-person — never a slogan. */
  headline: string;
  /** What to do next. Empty once met. */
  nextStep: string;
}

/**
 * Live progress toward a campaign, for the rep's card.
 *
 * The headline is deliberately specific ("22 more knocks before 12 PM"), never
 * "keep pushing!". A rep can act on a number; they tune out a slogan by the
 * second time they see it.
 */
export function campaignProgress(
  c: SpiffCampaign, counters: RepWindowCounters, nowMs: number,
): CampaignProgress {
  const msRemaining = Math.max(0, c.endsAtMs - nowMs);
  const met = triggerMet(c.trigger, counters);
  const t = c.trigger;

  let current = 0, target = 1, headline = "", nextStep = "";
  switch (t.kind) {
    case "per_sale":
      current = counters.salesInWindow; target = Math.max(1, current + 1);
      headline = current > 0
        ? `${current} sale${current === 1 ? "" : "s"} in this campaign`
        : `Every sale pays extra`;
      nextStep = "Every sale while this runs pays the bonus.";
      break;
    case "knocks_by_time": {
      current = counters.knocksBeforeCutoffToday; target = Math.max(1, t.knocks);
      const left = Math.max(0, target - current);
      headline = met ? `${target} knocks in — bonus earned` : `${current} of ${target} knocks before ${hour12(t.byHourLocal)}`;
      nextStep = met ? "" : `${left} more knock${left === 1 ? "" : "s"} before ${hour12(t.byHourLocal)}.`;
      break;
    }
    case "sale_by_time":
      current = counters.firstSaleHourLocalToday != null ? 1 : 0; target = 1;
      headline = met ? `First sale in before ${hour12(t.byHourLocal)}` : `Sell before ${hour12(t.byHourLocal)}`;
      nextStep = met ? "" : `Your first sale before ${hour12(t.byHourLocal)} earns it.`;
      break;
    case "sales_in_day": {
      current = counters.salesToday; target = Math.max(1, t.sales);
      const left = Math.max(0, target - current);
      headline = met ? `${current} sales today — bonus earned` : `${current} of ${target} sales today`;
      nextStep = met ? "" : `${left} more sale${left === 1 ? "" : "s"} today.`;
      break;
    }
    case "knock_streak": {
      current = counters.streakDaysMeetingBar; target = Math.max(1, t.days);
      const left = Math.max(0, target - current);
      headline = met ? `${current}-day streak — bonus earned` : `Day ${current} of ${target}`;
      nextStep = met ? "" : `${left} more day${left === 1 ? "" : "s"} at ${t.knocksPerDay}+ knocks.`;
      break;
    }
    case "knocks_and_sale_by_time": {
      // Two halves, so the bar tracks the one still OUTSTANDING rather than an
      // average of the two. A bar at 50% because the doors are done but the sale
      // is not tells a rep nothing about what to do next; "doors done — now get
      // one in" does.
      const doorsTarget = Math.max(1, t.knocks);
      const doorsDone = counters.knocksBeforeCutoffToday >= doorsTarget;
      const saleDone = counters.firstSaleHourLocalToday != null
        && counters.firstSaleHourLocalToday < t.byHourLocal;
      const by = hour12(t.byHourLocal);

      if (met) {
        current = 2; target = 2;
        headline = `${doorsTarget} doors and a sale before ${by} — bonus earned`;
        nextStep = "";
      } else if (doorsDone) {
        // The motivating state: the hard, slow half is banked and one sale
        // collects it. Say exactly that.
        current = 1; target = 2;
        headline = `Doors done — one sale before ${by} takes it`;
        nextStep = `Close one before ${by}.`;
      } else {
        // Track doors, because that is the half the rep controls directly.
        current = counters.knocksBeforeCutoffToday; target = doorsTarget;
        const left = Math.max(0, doorsTarget - current);
        headline = `${current} of ${doorsTarget} doors before ${by}`;
        nextStep = saleDone
          ? `Sale's in — ${left} more door${left === 1 ? "" : "s"} before ${by}.`
          : `${left} more door${left === 1 ? "" : "s"} and a sale before ${by}.`;
      }
      break;
    }
  }

  const pct = target <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((current / target) * 100)));
  return { current, target, pct, met: met, msRemaining, headline, nextStep };
}

/** 14 → "2 PM". Campaign cutoffs are always on the hour. */
export function hour12(hour24: number): string {
  const h = ((Math.trunc(hour24) % 24) + 24) % 24;
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/**
 * Decide whether this campaign owes this rep money right now.
 *
 * Caps TRIM rather than reject: a rep $20 from their cap on a $75 campaign gets
 * $20, not nothing. Refusing the whole award because it does not fit is how a
 * rep learns the board lies to them. The caller records the award; making it
 * idempotent (one award per rep per qualifying event) is the store's job, and
 * `awardedToRepCents` closes the loop on the next evaluation.
 */
export function evaluateCampaign(
  c: SpiffCampaign, counters: RepWindowCounters, nowMs: number,
): { award: CampaignAward } | { skip: CampaignSkip } {
  if (c.status !== "live") return { skip: c.status === "ended" || c.status === "cancelled" ? "window_closed" : "not_live" };
  if (nowMs < c.startsAtMs || nowMs >= c.endsAtMs) return { skip: "window_closed" };
  if (!isRepEligible(c, counters.repId)) return { skip: "not_eligible" };
  if (!triggerMet(c.trigger, counters)) return { skip: "trigger_unmet" };

  let amount = cents(c.rewardCents);
  if (amount <= 0) return { skip: "trigger_unmet" };

  const perRepCap = cents(c.perRepCapCents);
  if (perRepCap > 0) {
    const room = perRepCap - cents(counters.awardedToRepCents);
    if (room <= 0) return { skip: "rep_cap_reached" };
    amount = Math.min(amount, room);
  }
  const campaignCap = cents(c.campaignCapCents);
  if (campaignCap > 0) {
    const room = campaignCap - cents(counters.awardedTotalCents);
    if (room <= 0) return { skip: "campaign_cap_reached" };
    amount = Math.min(amount, room);
  }

  return { award: { campaignId: c.id, repId: counters.repId, amountCents: amount, reason: awardReason(c) } };
}

/** The ledger/announcement line. Names the campaign, so a rep reading their pay
 *  statement six weeks later knows exactly which promise this was. */
export function awardReason(c: SpiffCampaign): string {
  const t = c.trigger;
  switch (t.kind) {
    case "per_sale":        return `${c.name} — sale bonus`;
    case "knocks_by_time":  return `${c.name} — ${t.knocks} knocks before ${hour12(t.byHourLocal)}`;
    case "sale_by_time":    return `${c.name} — sale before ${hour12(t.byHourLocal)}`;
    case "sales_in_day":    return `${c.name} — ${t.sales} sales in a day`;
    case "knock_streak":    return `${c.name} — ${t.days}-day knock streak`;
    default:                return c.name;
  }
}

/** Human summary of the rule, for the launcher's preview and the rep's card.
 *  A manager should be able to read back what they are about to promise. */
export function describeTrigger(t: CampaignTrigger): string {
  switch (t.kind) {
    case "per_sale":        return "for every sale";
    case "knocks_by_time":  return `for ${t.knocks} knocks before ${hour12(t.byHourLocal)}`;
    case "sale_by_time":    return `for a sale before ${hour12(t.byHourLocal)}`;
    case "sales_in_day":    return `for ${t.sales} sales in one day`;
    case "knock_streak":    return `for ${t.days} days straight at ${t.knocksPerDay}+ knocks`;
    default:                return "";
  }
}

/** Validation shared by the API and the launcher, so the form and the server
 *  agree on what a sane campaign is. Returns null when valid. */
export function validateCampaignInput(input: {
  name?: unknown; rewardCents?: unknown; startsAtMs?: unknown; endsAtMs?: unknown;
  trigger?: CampaignTrigger; perRepCapCents?: unknown; campaignCapCents?: unknown;
}): string | null {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 60) return "Give the campaign a name between 2 and 60 characters.";

  const reward = Number(input.rewardCents);
  if (!Number.isInteger(reward) || reward <= 0) return "The reward must be a whole number of cents above zero.";
  // A four-figure per-event spiff is a fat finger, not an incentive.
  if (reward > 100_000) return "The reward cannot exceed $1,000 per award.";

  const start = Number(input.startsAtMs), end = Number(input.endsAtMs);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "The campaign needs a start and an end.";
  if (end <= start) return "The campaign must end after it starts.";
  // Urgency is the point. A month-long "spiff" is just a comp plan, and it stops
  // reading as something to act on today.
  if (end - start > 31 * 86_400_000) return "A campaign can run for at most 31 days — use the commission plan for anything longer.";

  const t = input.trigger;
  if (!t || !CAMPAIGN_TRIGGER_KINDS.includes(t.kind)) return "Choose what earns the bonus.";
  if (t.kind === "knocks_by_time") {
    if (!Number.isInteger(t.knocks) || t.knocks < 1 || t.knocks > 500) return "Knock target must be between 1 and 500.";
    if (!Number.isInteger(t.byHourLocal) || t.byHourLocal < 1 || t.byHourLocal > 23) return "Cutoff hour must be between 1 and 23.";
  }
  if (t.kind === "sale_by_time" && (!Number.isInteger(t.byHourLocal) || t.byHourLocal < 1 || t.byHourLocal > 23)) {
    return "Cutoff hour must be between 1 and 23.";
  }
  if (t.kind === "sales_in_day" && (!Number.isInteger(t.sales) || t.sales < 1 || t.sales > 50)) {
    return "Sales target must be between 1 and 50.";
  }
  if (t.kind === "knock_streak") {
    if (!Number.isInteger(t.days) || t.days < 2 || t.days > 30) return "Streak length must be between 2 and 30 days.";
    if (!Number.isInteger(t.knocksPerDay) || t.knocksPerDay < 1 || t.knocksPerDay > 500) return "Daily knock bar must be between 1 and 500.";
  }

  for (const [label, v] of [["Per-rep cap", input.perRepCapCents], ["Campaign cap", input.campaignCapCents]] as const) {
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) return `${label} must be a whole number of cents (0 = uncapped).`;
  }
  return null;
}
