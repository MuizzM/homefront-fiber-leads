// ── Coaching insights — explainable rules, never an opaque score ─────────────
//
// PURE. Every insight this file produces is a function of numbers the rep can
// see on their own screen, and every one carries the arithmetic that produced
// it. That is the whole design: the spec's requirement is not "generate advice",
// it is "generate advice a manager can defend to the person receiving it".
//
// Five rules govern everything below, and they are worth stating because each
// one is a mistake this kind of engine makes by default.
//
//   1. NO RULE FIRES ON A SMALL SAMPLE.
//      Every rule declares a minimum denominator. A 0% close rate over four
//      doors is a Tuesday, not a coaching need, and a system that flags it
//      teaches managers to ignore the system.
//
//   2. NO RULE COMPARES AGAINST A TEAM OF TWO.
//      Team baselines need MIN_TEAM_FOR_BASELINE members. Below that the
//      "team median" is one identifiable colleague, and telling a rep they are
//      below it is telling them about that person's numbers.
//
//   3. AN ABSENT RATE IS NOT A BAD RATE.
//      shared/repMetrics returns null for a rate with no denominator. Every
//      rule here treats null as "no signal" and declines to fire. A rep who was
//      off sick must never come back to a coaching flag.
//
//   4. THE ACTION IS THE POINT.
//      An insight with no suggested action is an accusation. Every rule below
//      produces something the rep or the manager can DO tomorrow.
//
//   5. LOCATION NEVER PRODUCES AN ADVERSE INSIGHT ON ITS OWN.
//      No rule fires on GPS alone. Pace and territory-time rules require door
//      activity to corroborate them, because an unverified fix means a weak
//      signal far more often than it means a rep somewhere they should not be -
//      and the privacy brief forbids adverse decisions from location data
//      without human review.

import {
  formatDuration,
  formatRate,
  type DerivedMetrics,
  type RepDailyFacts,
} from "./repMetrics";

export const INSIGHT_SEVERITIES = ["positive", "neutral", "coaching_needed", "urgent"] as const;
export type InsightSeverity = (typeof INSIGHT_SEVERITIES)[number];

/**
 * Below this headcount a team median identifies an individual, so no baseline
 * comparison is offered at all. Four (not two or three) because the median of
 * three is one person's exact number.
 */
export const MIN_TEAM_FOR_BASELINE = 4;

/** Sample floors. Named rather than inlined so the thresholds are reviewable
 *  in one place instead of scattered through twenty conditionals. */
export const MIN_DOORS_FOR_CONTACT_RULE = 25;
export const MIN_CONTACTS_FOR_CLOSE_RULE = 15;
export const MIN_GAPS_FOR_PACE_RULE = 10;
export const MIN_SUBMITTED_FOR_INSTALL_RULE = 5;
export const MIN_FOLLOWUPS_FOR_CALLBACK_RULE = 5;

export interface TeamBaseline {
  /** How many reps the medians were computed from. Below MIN_TEAM_FOR_BASELINE
   *  the caller must pass null instead of a baseline. */
  memberCount: number;
  contactRate: number | null;
  closeRate: number | null;
  submissionRate: number | null;
  installRate: number | null;
  medianSecondsBetweenDoors: number | null;
  doorsPerActiveHour: number | null;
  utilizationRate: number | null;
  callbackCompletionRate: number | null;
}

export interface InsightContext {
  repId: number;
  repName: string;
  /** ISO dates, inclusive. Rendered verbatim on the insight. */
  periodStart: string;
  periodEnd: string;
  facts: RepDailyFacts;
  metrics: DerivedMetrics;
  /** null when the team is too small to compare against — see rule 2. */
  baseline: TeamBaseline | null;
  /** The rep's own trailing average, for "compared with your usual". */
  personal: DerivedMetrics | null;
  /** Unworked assigned doors within the area the rep already walked today.
   *  Used only to make a pace insight ACTIONABLE, never to trigger one. */
  nearbyUnworkedDoors: number;
  /** Follow-ups past their callback date. */
  overdueFollowUps: number;
  /** Hours since the rep's last logged door. null = never active. */
  hoursSinceLastActivity: number | null;
  /** True when the rep holds assigned doors they have never started. */
  hasUnstartedTerritory: boolean;
}

export interface SupportingMetric {
  key: string;
  label: string;
  value: string;
  /** What it is being measured against, when there is a baseline. */
  baseline?: string;
}

export interface CoachingInsight {
  /** Stable per (rep, type, period) so re-running the engine updates rather
   *  than duplicates, and a dismissal sticks. */
  insightType: string;
  severity: InsightSeverity;
  title: string;
  /** What happened, in plain language, with the numbers in it. */
  explanation: string;
  /** What to do about it. Never absent - see rule 4. */
  suggestedAction: string;
  supportingMetrics: SupportingMetric[];
  /** Where to go to see the data behind it. A client route, not a URL. */
  dataLink: string;
  periodStart: string;
  periodEnd: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** True when `value` is meaningfully below `baseline`. Both must be present -
 *  rule 3 - and the gap must clear a relative margin so noise does not fire. */
function meaningfullyBelow(value: number | null, baseline: number | null, margin = 0.2): boolean {
  if (value == null || baseline == null || baseline <= 0) return false;
  return value < baseline * (1 - margin);
}

function meaningfullyAbove(value: number | null, baseline: number | null, margin = 0.2): boolean {
  if (value == null || baseline == null || baseline <= 0) return false;
  return value > baseline * (1 + margin);
}

function metric(key: string, label: string, value: string, baseline?: string): SupportingMetric {
  return baseline ? { key, label, value, baseline } : { key, label, value };
}

const repLink = (repId: number) => `/metrics/team?rep=${repId}`;

// ── The rules ────────────────────────────────────────────────────────────────

type Rule = (ctx: InsightContext) => CoachingInsight | null;

/**
 * High activity, low contact rate.
 *
 * The most common real coaching need in D2D, and the one most often
 * misdiagnosed as laziness: the rep is working hard and knocking at the wrong
 * hours. The action is a time-of-day change, not "try harder".
 */
const highActivityLowContact: Rule = (ctx) => {
  const { metrics, baseline, facts } = ctx;
  if (facts.doorsAttempted < MIN_DOORS_FOR_CONTACT_RULE) return null;
  if (!baseline || baseline.memberCount < MIN_TEAM_FOR_BASELINE) return null;
  if (!meaningfullyBelow(metrics.contactRate, baseline.contactRate)) return null;

  return {
    insightType: "high_activity_low_contact",
    severity: "coaching_needed",
    title: "Plenty of doors, fewer answers",
    explanation:
      `Over this period you knocked ${facts.doorsAttempted} doors and reached ` +
      `${formatRate(metrics.contactRate)} of them. The team median is ` +
      `${formatRate(baseline.contactRate)}. The volume is there, so this is about ` +
      `WHEN the doors are being knocked rather than how many.`,
    suggestedAction:
      "Try moving a block of the run into the 5-7 PM window, and re-knock today's " +
      "no-answers rather than starting a new street. Evening returns are where most " +
      "of this gap closes.",
    supportingMetrics: [
      metric("doorsAttempted", "Doors attempted", String(facts.doorsAttempted)),
      metric("contactRate", "Contact rate", formatRate(metrics.contactRate), `team ${formatRate(baseline.contactRate)}`),
      metric("noAnswerRecords", "No-answer doors", String(facts.noAnswerRecords)),
    ],
    dataLink: repLink(ctx.repId),
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
  };
};

/**
 * Good conversations, few submissions.
 *
 * Explicitly recommends pitch coaching rather than territory reduction. The
 * spec calls this out by name, and the reason matters: a rep who talks to
 * people and does not close needs a different conversation from a rep who is
 * not talking to anyone, and cutting their territory would fix neither.
 */
const highContactLowSubmission: Rule = (ctx) => {
  const { metrics, baseline, facts } = ctx;
  if (facts.contacts < MIN_CONTACTS_FOR_CLOSE_RULE) return null;
  if (!baseline || baseline.memberCount < MIN_TEAM_FOR_BASELINE) return null;
  // Contact rate at or above the team's, but closing below it. Both halves are
  // required: without the first this is just "sells less", which is not a
  // diagnosis.
  const contactOk = metrics.contactRate != null && baseline.contactRate != null
    && metrics.contactRate >= baseline.contactRate;
  if (!contactOk) return null;
  if (!meaningfullyBelow(metrics.closeRate, baseline.closeRate)) return null;

  return {
    insightType: "high_contact_low_submission",
    severity: "coaching_needed",
    title: "Getting to the conversation, not through it",
    explanation:
      `You spoke with ${facts.contacts} people this period - a contact rate of ` +
      `${formatRate(metrics.contactRate)}, at or above the team median of ` +
      `${formatRate(baseline.contactRate)}. Of those conversations, ` +
      `${formatRate(metrics.closeRate)} produced a submitted order against a team ` +
      `median of ${formatRate(baseline.closeRate)}. The door-opening is working; ` +
      `the close is where the drop-off is.`,
    suggestedAction:
      "Book a short objection-handling session and run the two objections you hear " +
      "most. This is a pitch conversation, not a territory one - the doors and the " +
      "conversations are already there.",
    supportingMetrics: [
      metric("contacts", "Contacts", String(facts.contacts)),
      metric("contactRate", "Contact rate", formatRate(metrics.contactRate), `team ${formatRate(baseline.contactRate)}`),
      metric("closeRate", "Close rate", formatRate(metrics.closeRate), `team ${formatRate(baseline.closeRate)}`),
      metric("submittedOrders", "Submitted orders", String(facts.submittedOrders)),
    ],
    dataLink: repLink(ctx.repId),
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
  };
};

/**
 * Low activity, strong conversion.
 *
 * The inverse case, and the one a naive leaderboard punishes. This rep should
 * be given MORE territory, and the insight says so explicitly so the manager
 * does not read "low activity" and reach for the usual lever.
 */
const lowActivityHighConversion: Rule = (ctx) => {
  const { metrics, baseline, facts } = ctx;
  if (facts.contacts < MIN_CONTACTS_FOR_CLOSE_RULE) return null;
  if (!baseline || baseline.memberCount < MIN_TEAM_FOR_BASELINE) return null;
  if (!meaningfullyAbove(metrics.closeRate, baseline.closeRate)) return null;
  if (!meaningfullyBelow(metrics.doorsPerActiveHour, baseline.doorsPerActiveHour)) return null;

  return {
    insightType: "low_activity_high_conversion",
    severity: "positive",
    title: "Converting well - there is room for more doors",
    explanation:
      `Your close rate is ${formatRate(metrics.closeRate)} against a team median of ` +
      `${formatRate(baseline.closeRate)}, on ${facts.contacts} conversations. Door ` +
      `volume is running below the team at ${metrics.doorsPerActiveHour?.toFixed(1)} ` +
      `per active hour. The conversion is the hard part and it is already working.`,
    suggestedAction:
      "Worth a conversation about a larger assignment or a denser area. More doors at " +
      "this conversion rate is the highest-yield change available on this team.",
    supportingMetrics: [
      metric("closeRate", "Close rate", formatRate(metrics.closeRate), `team ${formatRate(baseline.closeRate)}`),
      metric("doorsPerActiveHour", "Doors per active hour", metrics.doorsPerActiveHour?.toFixed(1) ?? "—", `team ${baseline.doorsPerActiveHour?.toFixed(1) ?? "—"}`),
      metric("submittedOrders", "Submitted orders", String(facts.submittedOrders)),
    ],
    dataLink: repLink(ctx.repId),
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
  };
};

/**
 * Slow pace between doors.
 *
 * Requires a real sample of gaps AND unworked doors nearby, because "slow" with
 * nothing left to knock is not slow - it is a rep who finished the area. Rule 5:
 * this is a route-planning insight, and it never reads as a discipline note.
 */
const slowPace: Rule = (ctx) => {
  const { metrics, baseline, facts } = ctx;
  if (facts.interDoorGapSamples < MIN_GAPS_FOR_PACE_RULE) return null;
  if (!baseline || baseline.memberCount < MIN_TEAM_FOR_BASELINE) return null;
  if (!meaningfullyAbove(metrics.medianSecondsBetweenDoors, baseline.medianSecondsBetweenDoors, 0.5)) return null;
  // Nothing nearby left to knock means the gap is travel between areas, which
  // is a routing fact about the assignment and not about the rep.
  if (ctx.nearbyUnworkedDoors < 10) return null;

  return {
    insightType: "slow_pace_between_doors",
    severity: "coaching_needed",
    title: "Time between doors is running long",
    explanation:
      `Your median gap between doors was ${formatDuration(metrics.medianSecondsBetweenDoors)} ` +
      `against a team median of ${formatDuration(baseline.medianSecondsBetweenDoors)}, across ` +
      `${facts.interDoorGapSamples} measured gaps. There were ${ctx.nearbyUnworkedDoors} ` +
      `unworked assigned doors in the same area, so the distance is not what is adding ` +
      `the time. Breaks and drives over 45 minutes are already excluded from this figure.`,
    suggestedAction:
      "Work one side of a street to the end before crossing, and set the next door on the " +
      "map before leaving the current one. Most of this gap is decision time, not walking.",
    supportingMetrics: [
      metric("medianSecondsBetweenDoors", "Median between doors", formatDuration(metrics.medianSecondsBetweenDoors), `team ${formatDuration(baseline.medianSecondsBetweenDoors)}`),
      metric("nearbyUnworkedDoors", "Unworked doors nearby", String(ctx.nearbyUnworkedDoors)),
      metric("doorsAttempted", "Doors attempted", String(facts.doorsAttempted)),
    ],
    dataLink: repLink(ctx.repId),
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
  };
};

/**
 * Overdue callbacks.
 *
 * Uses only the rep's own committed follow-ups, so no baseline and no team
 * comparison is needed - a promise to come back is measured against itself.
 */
const overdueFollowUps: Rule = (ctx) => {
  if (ctx.overdueFollowUps < 3) return null;
  const completion = ctx.metrics.callbackCompletionRate;
  return {
    insightType: "overdue_follow_ups",
    severity: ctx.overdueFollowUps >= 10 ? "urgent" : "coaching_needed",
    title: `${ctx.overdueFollowUps} callbacks are past their date`,
    explanation:
      `You have ${ctx.overdueFollowUps} follow-ups whose callback date has passed` +
      (completion != null ? `, and ${formatRate(completion)} of the follow-ups you booked have been completed` : "") +
      `. These are doors where somebody already agreed to talk again, which makes them ` +
      `the highest-converting work available.`,
    suggestedAction:
      "Clear today's callbacks before opening a new street. A booked return converts far " +
      "better than a cold door on the same run.",
    supportingMetrics: [
      metric("overdueFollowUps", "Overdue callbacks", String(ctx.overdueFollowUps)),
      metric("callbackCompletionRate", "Callback completion", formatRate(completion)),
      metric("followUps", "Follow-ups created", String(ctx.facts.followUps)),
    ],
    dataLink: "/followups",
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
  };
};

/**
 * Territory assigned but never started.
 *
 * Deliberately `neutral`, not `coaching_needed`: the overwhelmingly common
 * cause is an assignment made yesterday afternoon that the rep has not reached
 * yet. It is a prompt, not a finding.
 */
const unstartedTerritory: Rule = (ctx) => {
  if (!ctx.hasUnstartedTerritory) return null;
  const untouched = ctx.metrics.untouchedAssignedDoors;
  if (untouched < 20) return null;
  return {
    insightType: "unstarted_territory",
    severity: "neutral",
    title: "Assigned doors not started yet",
    explanation:
      `${untouched} eligible doors in your assignment have not been knocked. ` +
      (ctx.facts.freshAssigned > 0
        ? `${ctx.facts.freshAssigned - ctx.facts.freshAttempted} of them are newly lit fiber, where the first rep through usually sees the best conversion.`
        : ""),
    suggestedAction:
      "Start on the newly lit doors first - they convert best while the area is fresh.",
    supportingMetrics: [
      metric("untouchedAssignedDoors", "Untouched doors", String(untouched)),
      metric("utilizationRate", "Territory utilization", formatRate(ctx.metrics.utilizationRate)),
      metric("freshUtilizationRate", "Fresh-lead utilization", formatRate(ctx.metrics.freshUtilizationRate)),
    ],
    dataLink: "/map",
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
  };
};

/** Strong submission rate. Positive insights are not decoration - a board that
 *  only ever flags problems gets read as a punishment tool and then ignored. */
const strongSubmission: Rule = (ctx) => {
  const { metrics, baseline, facts } = ctx;
  if (facts.doorsAttempted < MIN_DOORS_FOR_CONTACT_RULE) return null;
  if (!baseline || baseline.memberCount < MIN_TEAM_FOR_BASELINE) return null;
  if (!meaningfullyAbove(metrics.submissionRate, baseline.submissionRate)) return null;
  return {
    insightType: "strong_submission_rate",
    severity: "positive",
    title: "Submission rate is ahead of the team",
    explanation:
      `${formatRate(metrics.submissionRate)} of the doors you knocked produced a ` +
      `submitted order, against a team median of ${formatRate(baseline.submissionRate)} - ` +
      `${facts.submittedOrders} orders from ${facts.doorsAttempted} doors.`,
    suggestedAction:
      "Keep prioritising newly lit doors and booked callbacks; that is where this rate comes from.",
    supportingMetrics: [
      metric("submissionRate", "Submission rate", formatRate(metrics.submissionRate), `team ${formatRate(baseline.submissionRate)}`),
      metric("submittedOrders", "Submitted orders", String(facts.submittedOrders)),
    ],
    dataLink: repLink(ctx.repId),
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
  };
};

/** Strong install rate — the metric that separates a real sale from a booked one. */
const strongInstall: Rule = (ctx) => {
  const { metrics, baseline, facts } = ctx;
  if (facts.submittedOrders < MIN_SUBMITTED_FOR_INSTALL_RULE) return null;
  if (!baseline || baseline.memberCount < MIN_TEAM_FOR_BASELINE) return null;
  if (!meaningfullyAbove(metrics.installRate, baseline.installRate, 0.1)) return null;
  return {
    insightType: "strong_install_rate",
    severity: "positive",
    title: "Orders are sticking",
    explanation:
      `${formatRate(metrics.installRate)} of your submitted orders installed, against a ` +
      `team median of ${formatRate(baseline.installRate)}. That is qualification quality: ` +
      `the customers you sign are the ones who actually get service.`,
    suggestedAction:
      "Worth sharing how you qualify at the door on the next team call - install rate is the " +
      "hardest part of this to teach.",
    supportingMetrics: [
      metric("installRate", "Install rate", formatRate(metrics.installRate), `team ${formatRate(baseline.installRate)}`),
      metric("installedOrders", "Installed orders", String(facts.installedOrders)),
      metric("submittedOrders", "Submitted orders", String(facts.submittedOrders)),
    ],
    dataLink: repLink(ctx.repId),
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
  };
};

/** High cancellation rate — a qualification problem, phrased as one. */
const highCancellation: Rule = (ctx) => {
  const { metrics, facts } = ctx;
  if (facts.submittedOrders < MIN_SUBMITTED_FOR_INSTALL_RULE) return null;
  if (metrics.cancellationRate == null || metrics.cancellationRate < 0.25) return null;
  return {
    insightType: "high_cancellation_rate",
    severity: "coaching_needed",
    title: "Orders are cancelling before install",
    explanation:
      `${formatRate(metrics.cancellationRate)} of your submitted orders cancelled ` +
      `(${facts.canceledOrders} of ${facts.submittedOrders}). The doors and the close are ` +
      `working; something between signature and install is not.`,
    suggestedAction:
      "Confirm the install window and the first-bill amount at the door, and check the " +
      "recovery queue - most of these are saveable with one call in the first 48 hours.",
    supportingMetrics: [
      metric("cancellationRate", "Cancellation rate", formatRate(metrics.cancellationRate)),
      metric("canceledOrders", "Canceled orders", String(facts.canceledOrders)),
      metric("submittedOrders", "Submitted orders", String(facts.submittedOrders)),
    ],
    dataLink: "/my-recoveries",
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
  };
};

/** Low callback completion, independent of the overdue count. */
const lowCallbackCompletion: Rule = (ctx) => {
  const { metrics, facts } = ctx;
  if (facts.followUps < MIN_FOLLOWUPS_FOR_CALLBACK_RULE) return null;
  if (metrics.callbackCompletionRate == null || metrics.callbackCompletionRate >= 0.5) return null;
  return {
    insightType: "low_callback_completion",
    severity: "coaching_needed",
    title: "Booked returns are not being worked",
    explanation:
      `You booked ${facts.followUps} follow-ups and completed ${facts.followUpsCompleted} ` +
      `(${formatRate(metrics.callbackCompletionRate)}). Booked returns convert several times ` +
      `better than cold doors, so this is the cheapest available lift.`,
    suggestedAction:
      "Put the first hour of each run on callbacks that are due, before any new street.",
    supportingMetrics: [
      metric("callbackCompletionRate", "Callback completion", formatRate(metrics.callbackCompletionRate)),
      metric("followUps", "Follow-ups created", String(facts.followUps)),
      metric("followUpsCompleted", "Follow-ups completed", String(facts.followUpsCompleted)),
    ],
    dataLink: "/followups",
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
  };
};

/**
 * Low utilization of assigned fresh territory.
 *
 * Fresh fiber decays: the first team through a newly lit area sees the best
 * conversion, so unworked fresh doors are a time-limited opportunity rather
 * than a backlog.
 */
const freshTerritoryUnworked: Rule = (ctx) => {
  const { metrics, facts } = ctx;
  if (facts.freshAssigned < 25) return null;
  if (metrics.freshUtilizationRate == null || metrics.freshUtilizationRate >= 0.3) return null;
  const remaining = Math.max(0, facts.freshAssigned - facts.freshAttempted);
  return {
    insightType: "fresh_territory_unworked",
    severity: "coaching_needed",
    title: `${remaining} newly lit doors still untouched`,
    explanation:
      `${formatRate(metrics.freshUtilizationRate)} of the newly lit doors assigned to you ` +
      `have been worked (${facts.freshAttempted} of ${facts.freshAssigned}). Fresh areas ` +
      `convert best in the first pass, and that advantage fades as competitors reach them.`,
    suggestedAction:
      "Prioritise the fresh doors on the next run - filter the map to newly lit and work " +
      "that list before the standard assignment.",
    supportingMetrics: [
      metric("freshUtilizationRate", "Fresh-lead utilization", formatRate(metrics.freshUtilizationRate)),
      metric("freshAssigned", "Fresh doors assigned", String(facts.freshAssigned)),
      metric("freshAttempted", "Fresh doors worked", String(facts.freshAttempted)),
    ],
    dataLink: "/map",
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
  };
};

/**
 * Verified activity with no sales.
 *
 * The spec's headline example. The severity is `coaching_needed`, and the
 * explanation says out loud that territory should NOT be the lever - because
 * the reflex on seeing "55 doors, 0 sales" is to take doors away, and that is
 * the wrong move when the contact rate is healthy.
 */
const activityWithoutSales: Rule = (ctx) => {
  const { metrics, baseline, facts } = ctx;
  if (facts.verifiedDoors < 40) return null;
  if (facts.submittedOrders > 0) return null;
  if (!baseline || baseline.memberCount < MIN_TEAM_FOR_BASELINE) return null;
  const contactHealthy = metrics.contactRate != null && baseline.contactRate != null
    && metrics.contactRate >= baseline.contactRate;
  if (!contactHealthy) return null;

  return {
    insightType: "verified_activity_no_sales",
    severity: "coaching_needed",
    title: "The work is there, the close is not",
    explanation:
      `${facts.verifiedDoors} verified door visits this period with no submitted orders. ` +
      `Contact rate is ${formatRate(metrics.contactRate)}, at or above the team median of ` +
      `${formatRate(baseline.contactRate)} - so the doors are being knocked and people are ` +
      `answering. This is an objection-handling and closing gap, not a territory one.`,
    suggestedAction:
      "Run objection-handling and a closing drill before changing anything about the " +
      "assignment. Reducing territory here would remove the conversations the coaching needs.",
    supportingMetrics: [
      metric("verifiedDoors", "Verified doors", String(facts.verifiedDoors)),
      metric("contacts", "Contacts", String(facts.contacts)),
      metric("contactRate", "Contact rate", formatRate(metrics.contactRate), `team ${formatRate(baseline.contactRate)}`),
      metric("submittedOrders", "Submitted orders", "0"),
    ],
    dataLink: repLink(ctx.repId),
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
  };
};

/**
 * Long inactive stretch inside an active shift.
 *
 * Deliberately `neutral` and deliberately worded as a question rather than a
 * finding. A two-hour gap is a training session, an appointment, a flat tyre,
 * or a phone that died - and rule 5 forbids treating an absence of data as
 * evidence of an absence of work.
 */
const longInactivity: Rule = (ctx) => {
  const { facts } = ctx;
  if (facts.longestInactiveSeconds < 2 * 3600) return null;
  if (facts.doorsAttempted < 5) return null; // no activity at all is a different rule
  // "While clocked in" must be literally true. With no shift recorded,
  // computePace still measures gaps over a synthetic all-day window while
  // activeSeconds stays 0 - which produced cards claiming an 18h gap inside a
  // 0s shift. A gap can also never exceed the clocked-in time it sits inside.
  if (facts.activeSeconds <= 0) return null;
  if (facts.longestInactiveSeconds >= facts.activeSeconds) return null;
  return {
    insightType: "long_inactive_period",
    severity: "neutral",
    title: "A long gap inside an active shift",
    explanation:
      `The longest stretch between doors was ${formatDuration(facts.longestInactiveSeconds)} ` +
      `while clocked in, across ${facts.inactivePeriodCount} gaps over 20 minutes. Appointments, ` +
      `drives between areas, training and a dead phone all look identical here - the system ` +
      `cannot tell them apart and does not try.`,
    suggestedAction:
      "Worth a quick check that nothing is blocking the run - a route that needs re-planning, " +
      "or a phone that is losing signal in that area.",
    supportingMetrics: [
      metric("longestInactiveSeconds", "Longest gap", formatDuration(facts.longestInactiveSeconds)),
      metric("inactivePeriodCount", "Gaps over 20 min", String(facts.inactivePeriodCount)),
      metric("activeSeconds", "Active field time", formatDuration(facts.activeSeconds)),
    ],
    dataLink: repLink(ctx.repId),
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
  };
};

/** Every rule, in the order they are evaluated. */
export const RULES: readonly Rule[] = [
  activityWithoutSales,
  highContactLowSubmission,
  highActivityLowContact,
  lowActivityHighConversion,
  slowPace,
  overdueFollowUps,
  lowCallbackCompletion,
  freshTerritoryUnworked,
  highCancellation,
  unstartedTerritory,
  longInactivity,
  strongSubmission,
  strongInstall,
];

const SEVERITY_ORDER: Record<InsightSeverity, number> = {
  urgent: 0, coaching_needed: 1, positive: 2, neutral: 3,
};

/**
 * Run every rule and return what fired, most important first.
 *
 * Capped at `limit` because an insight list of fourteen items is a list nobody
 * reads, and the cap is applied AFTER sorting so the most severe survive. At
 * least one positive insight is kept when any fired, so a rep with problems
 * still sees what is working - a board of pure red gets dismissed as noise, and
 * then the real finding goes unread with it.
 */
export function generateInsights(ctx: InsightContext, limit = 6): CoachingInsight[] {
  const fired = RULES.map((rule) => {
    try { return rule(ctx); } catch { return null; }
  }).filter((i): i is CoachingInsight => i != null);

  fired.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  if (fired.length <= limit) return fired;

  const head = fired.slice(0, limit);
  if (!head.some((i) => i.severity === "positive")) {
    const positive = fired.find((i) => i.severity === "positive");
    if (positive) head[head.length - 1] = positive;
  }
  return head;
}

/**
 * Build a team baseline, or null when the team is too small to compare against.
 *
 * Reps with a null rate are EXCLUDED from that rate's median rather than
 * counted as zero — rule 3 again, at the aggregate level. A team of six where
 * two were off does not have a contact rate a third lower than it really is.
 */
export function buildTeamBaseline(
  rows: ReadonlyArray<{ metrics: DerivedMetrics }>,
): TeamBaseline | null {
  if (rows.length < MIN_TEAM_FOR_BASELINE) return null;
  const pick = (fn: (m: DerivedMetrics) => number | null): number | null => {
    const xs = rows.map((r) => fn(r.metrics)).filter((v): v is number => v != null).sort((a, b) => a - b);
    if (xs.length === 0) return null;
    const mid = xs.length >> 1;
    return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  };
  return {
    memberCount: rows.length,
    contactRate: pick((m) => m.contactRate),
    closeRate: pick((m) => m.closeRate),
    submissionRate: pick((m) => m.submissionRate),
    installRate: pick((m) => m.installRate),
    medianSecondsBetweenDoors: pick((m) => m.medianSecondsBetweenDoors),
    doorsPerActiveHour: pick((m) => m.doorsPerActiveHour),
    utilizationRate: pick((m) => m.utilizationRate),
    callbackCompletionRate: pick((m) => m.callbackCompletionRate),
  };
}
