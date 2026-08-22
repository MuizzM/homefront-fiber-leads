// ── Rulebook ─────────────────────────────────────────────────────────────────
// Every number the app computes, stated in one sentence with its thresholds.
//
// The figures on this page are READ FROM THE SHARED CONSTANTS the code runs
// on, never retyped, so the page cannot drift from the app: change a threshold
// in shared/ and this sentence changes with it. The two scores that live on
// the server (the 0-100 lead score, the opportunity rank) are cited by file,
// not restated - a number this page cannot import is a number it does not
// claim.
//
// It is a page rather than a sheet so it has a URL people can send each other,
// and it sits under Governance because "why did the app decide that" is an
// oversight question before it is a field one.

import { useState } from "react";
import { PageHeader } from "@/components/ui/page-scaffold";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DISCOUNT_MAX_M, SCORE_SATURATION } from "@shared/doorPriority";
import { BUYER_BASE, BUYER_MIN, BUYER_MAX, BUYER_CAPS, NEIGHBOR_RADIUS_M, NEIGHBOR_DAYS, buyerTier, BUYER_TIER_LABEL } from "@shared/buyerScore";
import { DEFAULT_RETRO_TIERS } from "@shared/commissionTiers";
import { DEFAULT_PAY_POLICY } from "@shared/commissionHold";
import { DEFAULT_RESERVE_CAP_CENTS } from "@shared/commissionReserve";
import { DEFAULT_TERRITORY_THRESHOLDS } from "@shared/territoryHealth";
import { DEFAULT_REFERRAL_CONFIG } from "@shared/referral";
import { DEFAULT_RAMP_BONUS_CONFIG } from "@shared/rampBonus";
import { DEFAULT_RECOVERY_POLICY } from "@shared/orderRecovery";
import { DEFAULT_GEO_CONFIG, IMPOSSIBLE_SPEED_MPS } from "@shared/geoVerify";
import { FRESHNESS_LIVE_MS, FRESHNESS_RECENT_MS } from "@shared/liveOps";
import { VERIFICATION_FRESH_DAYS, VERIFICATION_AGING_DAYS } from "@shared/kineticBuild2026";
import { FRESH_AGE_MAX_DAYS } from "@shared/doorOpener";
import { REMINDER_LEAD_MINUTES, REMINDER_WINDOW_MINUTES } from "@shared/reminders";
import { METRIC_DEFS } from "@shared/repMetrics";
import { SUSPICIOUS_SHIFT_MINUTES } from "@/lib/shiftDuration";

type Domain = "doors" | "areas" | "pay" | "recovery" | "calling" | "location" | "metrics";

const DOMAINS: { id: Domain | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "doors", label: "Doors" },
  { id: "areas", label: "Areas" },
  { id: "pay", label: "Pay" },
  { id: "recovery", label: "Recovery" },
  { id: "calling", label: "Calling" },
  { id: "location", label: "Location" },
  { id: "metrics", label: "Metrics" },
];

interface Rule {
  id: string;
  domain: Domain;
  title: string;
  /** The rule as a rep could read it, one sentence. */
  sentence: string;
  /** The thresholds, each a short chip. */
  facts: string[];
  /** Where the number lives. */
  source: string;
}

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: cents % 100 ? 2 : 0 })}`;
const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** Built at render so every chip reads the live constant. */
export function buildRules(): Rule[] {
  const t = DEFAULT_TERRITORY_THRESHOLDS;
  const r = DEFAULT_REFERRAL_CONFIG;
  const rec = DEFAULT_RECOVERY_POLICY;
  const ramp = DEFAULT_RAMP_BONUS_CONFIG;
  const geo = DEFAULT_GEO_CONFIG;
  const tierLabel = (score: number) => BUYER_TIER_LABEL[buyerTier(score)];
  return [
    {
      id: "next-door", domain: "doors", title: "Next door",
      sentence: `The nearest open door comes first; a strong opportunity can buy up to ${DISCOUNT_MAX_M} m of walking, never the route.`,
      facts: [
        `effective metres = distance - ${DISCOUNT_MAX_M} m × min(score / ${SCORE_SATURATION}, 1)`,
        "open door = never knocked, or knocked with nobody home",
        "no GPS fix: pure opportunity order",
        "unranked doors are neutral, never penalised",
      ],
      source: "shared/doorPriority.ts",
    },
    {
      id: "opportunity", domain: "doors", title: "Opportunity verdict",
      sentence: `Prime at a score of ${SCORE_SATURATION} or more, Strong from ${Math.round(SCORE_SATURATION * 0.6)}, Fair below that; the raw score is never shown.`,
      facts: [`pct = round(score / ${SCORE_SATURATION} × 100)`, "Prime at 100%", "Strong from 60%", "Fair otherwise"],
      source: "client/src/pages/Today.tsx · server/leadRanking.ts",
    },
    {
      id: "buyer-score", domain: "doors", title: "Buyer score",
      sentence: `Every open door starts at ${BUYER_BASE.toFixed(1)}; each signal adds or removes at most its cap, and the reasons list carries the exact contributions.`,
      facts: [
        `${BUYER_MIN.toFixed(1)} to ${BUYER_MAX.toFixed(1)}, one decimal`,
        `${tierLabel(8)} at 8.0 or more`, `${tierLabel(5)} from 5.0`, `${tierLabel(4.9)} under 5.0`,
        `fresh fiber up to +${BUYER_CAPS.FIBER_MAX.toFixed(1)}`, `no fiber ${BUYER_CAPS.FIBER_NONE.toFixed(1)}`,
        `homeowner up to +${BUYER_CAPS.HOMEOWNER_MAX.toFixed(1)}`, `renter ${BUYER_CAPS.RENTER.toFixed(1)}`,
        `competitor on cable or DSL up to +${BUYER_CAPS.COMPETITOR_MAX.toFixed(1)}`,
        `neighbours sold within ${NEIGHBOR_RADIUS_M} m in ${NEIGHBOR_DAYS} days +${BUYER_CAPS.NEIGHBOR_EACH.toFixed(1)} each, max +${BUYER_CAPS.NEIGHBOR_MAX.toFixed(1)}`,
        `interested +${BUYER_CAPS.INTERESTED.toFixed(1)}`, `follow-up +${BUYER_CAPS.FOLLOW_UP.toFixed(1)}`,
        `not home ${BUYER_CAPS.NOT_HOME_EACH.toFixed(1)} each, floor ${BUYER_CAPS.NOT_HOME_FLOOR.toFixed(1)}`,
        "sold, not interested and do-not-knock doors get no score",
      ],
      source: "shared/buyerScore.ts",
    },
    {
      id: "lead-score", domain: "doors", title: "Lead score (0 to 100)",
      sentence: "New fiber with nobody signed up starts at 90, tenured fiber with nobody signed up at 70, a house already on Kinetic at 20, non-fiber at 5; bonuses for speed, a competitor and a fresh fabric date cap it at 100.",
      facts: ["HIGH badge at 80 or more", "stamped at scan time, server side"],
      source: "server/lead-scoring.ts · client/src/pages/Leads.tsx",
    },
    {
      id: "territory-health", domain: "areas", title: "Territory health",
      sentence: `Under ${t.minDoorsForJudgement} eligible doors an area is always Healthy; otherwise the first matching rule wins, from fully worked down to needs attention.`,
      facts: [
        `fully worked at ${pct(t.fullyWorkedUtilization)} utilization`,
        `high conversion at ${pct(t.highConversionRate)} with 50+ doors attempted`,
        `reclaim candidate: age ${t.reclaimAgeDays} d or more, utilization under ${pct(t.reclaimUtilization)}, silent ${t.reclaimSilentHours} h or more`,
        `stale after ${t.staleHours} h silent`,
        `underworked under ${pct(t.underworkedUtilization)} after 24 h`,
        `high opportunity at ${t.highOpportunityDoors}+ untouched doors`,
      ],
      source: "shared/territoryHealth.ts",
    },
    {
      id: "area-rates", domain: "areas", title: "Area percentages",
      sentence: "Every rate divides by the available base, total doors minus unavailable minus disqualified, never by the raw total.",
      facts: ["penetration = sold ÷ available", "knock completion = knocked ÷ available", "contact rate = contacted ÷ knocked"],
      source: "shared/territoryMetrics.ts",
    },
    {
      id: "commission-tiers", domain: "pay", title: "Commission tiers",
      sentence: "The week total picks one rate, and that rate is paid on every sale that week; cross a boundary and the whole week re-prices.",
      facts: [
        ...DEFAULT_RETRO_TIERS.map(tier => `${tier.label} ${usd(tier.rateCents)} per sale`),
        "gross = qualified sales × rate",
        "weeks run Monday 00:00 to Monday 00:00 in the org's timezone",
      ],
      source: "shared/commissionTiers.ts · shared/workweek.ts",
    },
    {
      id: "hold-reserve", domain: "pay", title: "Install hold and reserve",
      sentence: `Commission is held until install is confirmed and for ${DEFAULT_PAY_POLICY.holdDays} days after; a percentage of payable pay is withheld as a chargeback reserve up to ${usd(DEFAULT_RESERVE_CAP_CENTS)}.`,
      facts: [
        `hold ${DEFAULT_PAY_POLICY.holdDays} days after install${DEFAULT_PAY_POLICY.requireInstallConfirm ? ", install confirmation required" : ""}`,
        `reserve cap ${usd(DEFAULT_RESERVE_CAP_CENTS)} by default`,
        "reserve + net = earned, exactly",
      ],
      source: "shared/commissionHold.ts · shared/commissionReserve.ts",
    },
    {
      id: "referral", domain: "pay", title: "Referral bonus",
      sentence: `Hired, activated${r.requireTrainingComplete ? ", trained" : ""}${r.requireActiveStatus ? ", still active" : ""}, and ${r.requiredApprovedSales} approved sales within ${r.qualificationWindowDays} days of hire earns ${usd(r.rewardCents)}, paid ${r.clawbackWindowDays} days after qualifying so a cancelled sale can still undo it.`,
      facts: [
        usd(r.rewardCents), `${r.requiredApprovedSales} approved sales`, `${r.qualificationWindowDays}-day window from hire`,
        `${r.clawbackWindowDays}-day clawback hold`, `${r.attributionWindowDays}-day attribution`,
        r.enabled ? "programme on by default" : "programme off by default",
      ],
      source: "shared/referral.ts",
    },
    {
      id: "ramp-bonus", domain: "pay", title: "Ramp bonus",
      sentence: `For the first ${ramp.windowDays} days a new rep earns ${usd(ramp.rewardCents)} for each day the training queue is cleared with real work behind it, plus ${usd(ramp.completionRewardCents)} for finishing the curriculum and ${usd(ramp.completionInWindowBonusCents)} more for finishing inside the ramp.`,
      facts: [
        `${ramp.windowDays}-day window`, `${usd(ramp.rewardCents)} per qualifying day`,
        `at least ${ramp.minCardsPerDay} distinct cards`, `at least ${ramp.minSpanMinutes} real minutes`,
        ramp.requireQueueCleared ? "nothing left due" : "queue may stay open",
      ],
      source: "shared/rampBonus.ts",
    },
    {
      id: "stalled-orders", domain: "recovery", title: "Stalled orders",
      sentence: `A submitted order that has not moved in ${rec.staleSubmittedDays} days becomes a recovery case; accepted with no install date at ${rec.acceptedNoScheduleDays} days; a passed install date after ${rec.installOverdueGraceDays} day of grace.`,
      facts: [
        `urgent inside ${rec.urgentRecentIssueHours} h of a failure`,
        `escalate after ${rec.escalateAfterDaysOpen} days open`,
        `cancellations recoverable for ${rec.cancellationRecoveryWindowDays} days`,
        rec.estimatedOrderValueCents ? `estimated value ${usd(rec.estimatedOrderValueCents)} per order` : "no dollar estimate until an admin sets a value",
        "recovered rate = wins ÷ resolved cases",
        "staleness counts from the provider's last update, not the submission",
      ],
      source: "shared/orderRecovery.ts",
    },
    {
      id: "calling-window", domain: "calling", title: "Calling window",
      sentence: "Calls are allowed 08:00 to 21:00 in the lead's own local time, only after every do-not-call list has been checked; an org can narrow the window but never widen it.",
      facts: ["08:00 to 21:00 local by default", "gates in order: internal DNC, consent, national, state, data freshness, hours", "a DNC hit clears only with verified consent"],
      source: "shared/calling.ts · server/calling",
    },
    {
      id: "verified-knock", domain: "location", title: "Verified knock",
      sentence: `A knock is verified within ${geo.maxDistanceM} m of the door with GPS accuracy better than ${geo.maxAccuracyM} m; outside that it is flagged Needs review, never counted against the rep.`,
      facts: [`max distance ${geo.maxDistanceM} m`, `max accuracy ${geo.maxAccuracyM} m`, "At door chip at 60 m or less", `over ${IMPOSSIBLE_SPEED_MPS} m/s between fixes is invalid`],
      source: "shared/geoVerify.ts · components/ProximityChip.tsx",
    },
    {
      id: "live-freshness", domain: "location", title: "Live position freshness",
      sentence: `Live means the rep's last fix is under ${minutes(FRESHNESS_LIVE_MS)} old, recent under ${minutes(FRESHNESS_RECENT_MS)}; older is last known, and a rep with no fix is never drawn as a zero.`,
      facts: [`live under ${minutes(FRESHNESS_LIVE_MS)}`, `recent under ${minutes(FRESHNESS_RECENT_MS)}`, "status and freshness both always render"],
      source: "shared/liveOps.ts",
    },
    {
      id: "verification-age", domain: "location", title: "Build verification age",
      sentence: `Fresh means verified in the last ${VERIFICATION_FRESH_DAYS} days, aging up to ${VERIFICATION_AGING_DAYS}, stale past that; confidence decays on the same bands so a pin's colour and its age can never disagree.`,
      facts: [`fresh to ${VERIFICATION_FRESH_DAYS} days`, `aging to ${VERIFICATION_AGING_DAYS} days`, "stale after"],
      source: "shared/kineticBuild2026.ts",
    },
    {
      id: "door-opener", domain: "doors", title: "Door opener",
      sentence: `The opening line says when fiber went live only for the first ${FRESH_AGE_MAX_DAYS} days; after that it stops being a hook.`,
      facts: [`${FRESH_AGE_MAX_DAYS}-day hook`, "today, yesterday, then N days ago"],
      source: "shared/doorOpener.ts",
    },
    {
      id: "reminders", domain: "doors", title: "Callback reminders",
      sentence: `A timed callback reminds ${REMINDER_LEAD_MINUTES} minutes before the visit, inside a ${REMINDER_WINDOW_MINUTES}-minute window; a follow-up is overdue the moment its date is before today.`,
      facts: [`${REMINDER_LEAD_MINUTES} min before`, `${REMINDER_WINDOW_MINUTES} min window`, "no grace period on overdue"],
      source: "shared/reminders.ts · client/src/pages/FollowUps.tsx",
    },
    {
      id: "field-hours", domain: "location", title: "Field hours",
      sentence: `A shift over ${SUSPICIOUS_SHIFT_MINUTES / 60} hours is flagged Review time; nothing closes it automatically, it is surfaced before pay is finalized.`,
      facts: [`${SUSPICIOUS_SHIFT_MINUTES / 60} h review line`, "one open session per rep", "unknown status renders a dash, never a zero"],
      source: "client/src/lib/shiftDuration.ts",
    },
  ];
}

export default function Rulebook() {
  const [domain, setDomain] = useState<Domain | "all">("all");
  const rules = buildRules();
  const shown = domain === "all" ? rules : rules.filter(rule => rule.domain === domain);
  const metricDefs = Object.entries(METRIC_DEFS);

  return (
    <div className="app-canvas flex-1 overflow-y-auto px-4 pb-24 pt-5 md:px-6 md:pb-10" data-testid="rulebook-page">
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <PageHeader
          title="Rulebook"
          subtitle="Every number the app computes, stated in one sentence with its thresholds. The figures are read from the same constants the code runs on, so this page cannot drift from the app."
        />

        <Tabs value={domain} onValueChange={value => setDomain(value as Domain | "all")}>
          <TabsList aria-label="Rule domains">
            {DOMAINS.map(({ id, label }) => (
              <TabsTrigger key={id} value={id} data-testid={`rulebook-domain-${id}`}>{label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {domain !== "metrics" && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2" data-testid="rulebook-rules">
            {shown.map(rule => (
              <section key={rule.id} data-testid={`rule-${rule.id}`} className="rounded-2xl border border-border bg-card p-4 md:rounded-xl md:p-5">
                <h2 className="text-base font-semibold text-foreground">{rule.title}</h2>
                <p className="mt-1 text-pretty text-sm leading-relaxed text-foreground">{rule.sentence}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {rule.facts.map(fact => <Badge key={fact} variant="outline" className="whitespace-normal text-left font-medium">{fact}</Badge>)}
                </div>
                <div className="mt-3 font-mono text-2xs text-muted-foreground">{rule.source}</div>
              </section>
            ))}
          </div>
        )}

        {(domain === "all" || domain === "metrics") && (
          <section data-testid="rulebook-metrics" className="overflow-hidden rounded-2xl border border-border bg-card md:rounded-xl">
            <div className="border-b border-border px-4 py-3 md:px-5">
              <h2 className="text-base font-semibold text-foreground">Metric formulas</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">The same text the question-mark button beside each metric opens.</p>
            </div>
            <dl className="divide-y divide-border">
              {metricDefs.map(([key, def]) => (
                <div key={key} className="grid grid-cols-1 gap-1 px-4 py-3 md:grid-cols-[220px_1fr] md:gap-4 md:px-5">
                  <dt className="text-sm-minus font-semibold text-foreground">{def.label}</dt>
                  <dd className="text-sm text-foreground">
                    {def.formula}
                    {def.note && <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{def.note}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </div>
  );
}
