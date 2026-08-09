// ── The genuine-door day bonus — paying for a real day on the doors ──────────
// "60 verified doors in a day → $50." One line, and the entire difficulty is in
// the word GENUINE.
//
// The standing ladder (shared/knockMilestones.ts) already refuses to pay for two
// obvious frauds: the hundredth tap on the same house (it counts DISTINCT leads)
// and the knock logged from the couch (it counts only knocks the SERVER's own
// geo check rated `verified` — see shared/geoVerify.ts, where distance, mock-GPS
// detection, impossible travel, and clock skew are all decided server-side).
//
// Those two filters are necessary and they are not sufficient. A rep who walks
// one street with the lead list open can stand on the sidewalk and log sixty
// DISTINCT houses, every one of them inside the geo radius, in eleven minutes.
// Every knock passes the geo check. Not one door was knocked. That is the exact
// attack this module exists to defeat, and it is defeated by TIME:
//
//   minGapSeconds       Two doors logged 4 seconds apart are one walk between
//                       houses that did not happen. The second does not count.
//
//   maxPerRollingHour   A real hour on the doors is 15–25 houses. Anything past
//                       the cap in any rolling 60 minutes stops counting — so a
//                       burst cannot be laundered by pacing it at 3 seconds.
//
//   minSpanMinutes      The qualifying doors must have taken a real stretch of
//                       the day to accumulate. Sixty doors is a shift, not an
//                       errand, and a day that "earned" sixty inside ninety
//                       minutes did not happen.
//
// Each of the three catches what the other two miss. The gap rule alone is
// beaten by pacing; the hour cap alone is beaten by two bursts eight hours
// apart; the span alone is beaten by one door at 8am and fifty-nine at 5pm.
// Together there is no shape of fabricated day that clears all three without
// the rep having actually spent the hours outside.
//
// ── WHAT DOES NOT COUNT, AND WHY IT STILL DOES NOT COUNT WHEN A REP MARKS IT ─
//
// Nothing in this file reads what the rep claimed. The events it is handed are
// already filtered server-side to verified, non-superseded, distinct doors. A
// rep marking a door "knocked" does not produce a counted door; the server
// rating the location `verified` produces a counted door. That is the whole
// answer to "even if they mark it".
//
// And a day carrying HARD TAMPER EVIDENCE (mock location, a duplicate submit,
// travel no human could make) does not pay at all — not "pays for the clean
// knocks". A rep who spoofed nine doors and walked sixty is not owed the sixty
// until a human has looked, because the nine tell you the phone was lying.
// `voidOnTamper` is what makes the whole day withheld and flagged, and it is on
// by default: an incentive that pays around detected fraud teaches the floor
// that the detector is decorative.
//
// PURE: no clock, no database, no randomness. The caller supplies the day's
// events and the config; the same inputs always produce the same verdict, which
// is what makes every edge case below a unit test rather than an argument.

/** One verified door, as the counter sees it. */
export interface DoorEvent {
  /** The address. Two events with the same leadId are the same house. */
  leadId: number;
  /** When the SERVER recorded it (never the device's own clock). */
  atMs: number;
}

export interface DoorDayConfig {
  enabled: boolean;
  /** Genuine doors required in the local day. */
  doors: number;
  /** Flat award, integer cents. Money is never a float. */
  rewardCents: number;
  /** The qualifying doors must span at least this long. */
  minSpanMinutes: number;
  /** Most doors that can count inside any rolling 60 minutes. */
  maxPerRollingHour: number;
  /** Two doors closer together than this: the second is not a walk. */
  minGapSeconds: number;
  /** Hard tamper evidence anywhere in the day withholds the whole day. */
  voidOnTamper: boolean;
}

// Defaults sized off a real shift. A committed rep runs 60–100 doors a day at
// 15–25 an hour, so: 25/hour leaves headroom over a genuinely fast street while
// still making a 60-door burst arithmetically impossible; 3 hours is the least
// time 60 real doors has ever taken; 20 seconds is faster than anyone has ever
// walked between two houses and had a conversation at the second one.
export const DEFAULT_DOOR_DAY_CONFIG: DoorDayConfig = {
  enabled: true,
  doors: 60,
  rewardCents: 5_000,        // $50
  minSpanMinutes: 180,       // 3 hours
  maxPerRollingHour: 25,
  minGapSeconds: 20,
  voidOnTamper: true,
};

const HOUR_MS = 3_600_000;

/** Why a logged door did not count toward the bonus. */
export type DoorRejection = "same_address" | "too_fast" | "hour_cap";

/** Why a day that logged enough doors still did not pay. */
export type DoorDayBlock = "disabled" | "doors" | "span" | "tamper";

export interface GenuineDoorCount {
  /** Doors that survived every genuineness filter. */
  counted: number;
  /** Doors handed in, before filtering. */
  submitted: number;
  /** Per-reason tally of what was dropped — the rep is TOLD this, because a
   *  counter that silently discards work reads as a broken counter. */
  rejected: Record<DoorRejection, number>;
  /** Minutes spanned by the qualifying doors: from the first counted door to
   *  the one that hit the target (or to the last counted door when the target
   *  is not reached yet). This is "how long the day took", not "how long the
   *  rep was logged in". */
  spanMinutes: number;
  firstAtMs: number | null;
  lastAtMs: number | null;
}

const EMPTY_COUNT: GenuineDoorCount = {
  counted: 0, submitted: 0,
  rejected: { same_address: 0, too_fast: 0, hour_cap: 0 },
  spanMinutes: 0, firstAtMs: null, lastAtMs: null,
};

function int(n: unknown, fallback = 0): number {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Count the day's GENUINE doors.
 *
 * Events are processed oldest-first, and each filter is applied against the
 * doors that already COUNTED — never against the raw stream. That ordering is
 * load-bearing: if the gap were measured against the previous *submitted* door,
 * a rep could pad a burst with junk taps to space out the ones that count.
 *
 * Ties (two events at the same instant) are broken by leadId so the verdict is
 * deterministic — the same day always counts to the same number, which is what
 * lets an award be recomputed on a retry instead of re-earned.
 */
export function countGenuineDoors(
  events: readonly DoorEvent[],
  config: DoorDayConfig = DEFAULT_DOOR_DAY_CONFIG,
): GenuineDoorCount {
  const list = (events ?? []).filter(e => e && Number.isFinite(e.atMs));
  if (list.length === 0) return { ...EMPTY_COUNT, rejected: { ...EMPTY_COUNT.rejected } };

  const target = Math.max(1, int(config.doors, DEFAULT_DOOR_DAY_CONFIG.doors));
  const minGapMs = Math.max(0, int(config.minGapSeconds, 0)) * 1000;
  const hourCap = Math.max(0, int(config.maxPerRollingHour, 0));

  const sorted = [...list].sort((a, b) => (a.atMs - b.atMs) || (a.leadId - b.leadId));
  const rejected: Record<DoorRejection, number> = { same_address: 0, too_fast: 0, hour_cap: 0 };
  const seenLeads = new Set<number>();
  // Timestamps of counted doors, oldest first. Only the trailing hour is ever
  // inspected, so this stays a cheap sliding window rather than a rescan.
  const countedAt: number[] = [];
  let windowStart = 0; // index of the oldest counted door still inside the hour

  for (const e of sorted) {
    // 1. One house, one door. The hundredth tap at the same address is worth
    //    nothing — the rule the standing ladder already enforces in SQL, kept
    //    here too so this function is correct on any input, not only on the
    //    query that happens to feed it today.
    if (seenLeads.has(e.leadId)) { rejected.same_address += 1; continue; }

    // 2. Nobody walks to the next house in four seconds. Measured from the last
    //    door that COUNTED.
    const last = countedAt.length ? countedAt[countedAt.length - 1] : null;
    if (last != null && minGapMs > 0 && e.atMs - last < minGapMs) { rejected.too_fast += 1; continue; }

    // 3. The rolling-hour ceiling. Slide the window forward, then test.
    if (hourCap > 0) {
      while (windowStart < countedAt.length && e.atMs - countedAt[windowStart] >= HOUR_MS) windowStart += 1;
      if (countedAt.length - windowStart >= hourCap) { rejected.hour_cap += 1; continue; }
    }

    seenLeads.add(e.leadId);
    countedAt.push(e.atMs);
  }

  // The span that matters is how long it took to reach the target. Measuring to
  // the LAST door of the day instead would let a burst of 60 at lunchtime be
  // rescued by a single door at 6pm.
  const spanEndIdx = countedAt.length >= target ? target - 1 : countedAt.length - 1;
  const firstAtMs = countedAt.length ? countedAt[0] : null;
  const spanMs = countedAt.length ? countedAt[spanEndIdx] - countedAt[0] : 0;

  return {
    counted: countedAt.length,
    submitted: sorted.length,
    rejected,
    spanMinutes: Math.floor(spanMs / 60_000),
    firstAtMs,
    lastAtMs: countedAt.length ? countedAt[countedAt.length - 1] : null,
  };
}

export interface DoorDayDecision {
  qualifies: boolean;
  /** Integer cents. 0 whenever `qualifies` is false. */
  awardCents: number;
  count: GenuineDoorCount;
  /** Set when the day did NOT pay; null when it did. */
  blockedBy: DoorDayBlock | null;
  /** True when real work was withheld pending a human look, rather than simply
   *  not yet earned. The distinction matters: one is a rep who needs to keep
   *  knocking, the other is a rep an admin needs to talk to. */
  needsReview: boolean;
  /** The ledger line — what the rep DID, in the words they would use. */
  reason: string;
  /** One line for the rep's card. Concrete, second-person, never a slogan. */
  headline: string;
}

/**
 * Decide one rep's day.
 *
 * @param tamperedKnocks knocks the SERVER rated `invalid` for this rep on this
 *   day — mock location, duplicate submission, or physically impossible travel.
 *   Not "needs review": an unverifiable knock is merely uncounted, but a
 *   fabricated one is evidence about the whole day.
 */
export function evaluateDoorDay(
  events: readonly DoorEvent[],
  tamperedKnocks: number,
  config: DoorDayConfig = DEFAULT_DOOR_DAY_CONFIG,
): DoorDayDecision {
  const cfg = { ...DEFAULT_DOOR_DAY_CONFIG, ...config };
  const count = countGenuineDoors(events, cfg);
  const target = Math.max(1, int(cfg.doors, DEFAULT_DOOR_DAY_CONFIG.doors));
  const minSpan = Math.max(0, int(cfg.minSpanMinutes, 0));
  const reward = Math.max(0, int(cfg.rewardCents, 0));

  const no = (blockedBy: DoorDayBlock, headline: string, needsReview = false): DoorDayDecision => ({
    qualifies: false, awardCents: 0, count, blockedBy, needsReview,
    reason: `${target} genuine doors in a day`, headline,
  });

  if (cfg.enabled === false || reward <= 0) return no("disabled", "");

  // Tamper first, and it outranks everything — including a day that otherwise
  // cleared the bar. Paying a day that contains spoofed GPS would teach exactly
  // the wrong lesson, and "the clean ones still counted" is the loophole.
  if (cfg.voidOnTamper && int(tamperedKnocks) > 0) {
    return no("tamper", "Location problems on today's knocks - held for review.", true);
  }

  if (count.counted < target) {
    const remaining = target - count.counted;
    return no("doors", `${remaining} more genuine door${remaining === 1 ? "" : "s"} today for ${usd(reward)}`);
  }

  // Enough doors, too fast a day. Told plainly, because a rep who cleared 60 and
  // got nothing deserves to know it was the clock and not a bug.
  if (count.spanMinutes < minSpan) {
    return no("span", `${target} doors counted, but inside ${formatSpan(count.spanMinutes)} - the bonus needs a full ${formatSpan(minSpan)} on the doors.`);
  }

  return {
    qualifies: true,
    awardCents: reward,
    count,
    blockedBy: null,
    needsReview: false,
    reason: `${target} genuine doors in a day`,
    headline: `${count.counted} genuine doors today - ${usd(reward)} earned`,
  };
}

/** What the rep's card shows before the bonus is earned. */
export interface DoorDayProgress {
  enabled: boolean;
  target: number;
  counted: number;
  remaining: number;
  /** 0–100 toward the target. */
  pct: number;
  rewardCents: number;
  spanMinutes: number;
  minSpanMinutes: number;
  /** True once the doors are there but the day is still too short. */
  spanShort: boolean;
  earned: boolean;
  needsReview: boolean;
  headline: string;
  /** Doors that did not count, and why — shown so the counter never looks
   *  broken to a rep who logged more than it credits. */
  rejected: Record<DoorRejection, number>;
}

export function doorDayProgress(decision: DoorDayDecision, config: DoorDayConfig = DEFAULT_DOOR_DAY_CONFIG): DoorDayProgress {
  const cfg = { ...DEFAULT_DOOR_DAY_CONFIG, ...config };
  const target = Math.max(1, int(cfg.doors, DEFAULT_DOOR_DAY_CONFIG.doors));
  const counted = decision.count.counted;
  return {
    enabled: cfg.enabled !== false && Math.max(0, int(cfg.rewardCents, 0)) > 0,
    target,
    counted,
    remaining: Math.max(0, target - counted),
    pct: Math.max(0, Math.min(100, Math.round((counted / target) * 100))),
    rewardCents: Math.max(0, int(cfg.rewardCents, 0)),
    spanMinutes: decision.count.spanMinutes,
    minSpanMinutes: Math.max(0, int(cfg.minSpanMinutes, 0)),
    spanShort: decision.blockedBy === "span",
    earned: decision.qualifies,
    needsReview: decision.needsReview,
    headline: decision.headline,
    rejected: decision.count.rejected,
  };
}

/** Integer cents → "$50" / "$47.50". No float ever reaches a rendered digit. */
export function usd(c: number): string {
  const v = Math.trunc(Number.isFinite(c) ? c : 0);
  const whole = Math.floor(Math.abs(v) / 100).toLocaleString("en-US");
  const rem = Math.abs(v) % 100;
  const body = rem === 0 ? `$${whole}` : `$${whole}.${String(rem).padStart(2, "0")}`;
  return v < 0 ? `-${body}` : body;
}

/** "3 hours" / "90 minutes" — the way a rep says it, not "180m". */
export function formatSpan(minutes: number): string {
  const m = Math.max(0, Math.trunc(Number(minutes) || 0));
  if (m < 90) return `${m} minute${m === 1 ? "" : "s"}`;
  const hours = m / 60;
  const rounded = Math.round(hours * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} hours`;
}

/** Shared by the API and the admin form, so the server and the UI cannot
 *  disagree about what a sane config is. Returns null when valid. */
export function validateDoorDayConfig(input: unknown): string | null {
  const c = input as DoorDayConfig | null;
  if (!c || typeof c !== "object") return "The daily door bonus config is missing.";

  const doors = Number(c.doors);
  if (!Number.isInteger(doors) || doors < 1 || doors > 500) {
    return "The daily door target must be between 1 and 500 doors.";
  }
  const reward = Number(c.rewardCents);
  if (!Number.isInteger(reward) || reward < 1) return "The bonus must be a whole number of cents above zero.";
  // The same four-figure ceiling the campaign and milestone validators enforce:
  // a $2,000 daily bonus is a fat finger, not an incentive.
  if (reward > 100_000) return "A daily bonus cannot pay more than $1,000.";

  const span = Number(c.minSpanMinutes);
  if (!Number.isInteger(span) || span < 0 || span > 1_440) {
    return "The minimum span must be between 0 minutes and 24 hours.";
  }
  const hourCap = Number(c.maxPerRollingHour);
  if (!Number.isInteger(hourCap) || hourCap < 0 || hourCap > 500) {
    return "The hourly cap must be between 0 and 500 doors.";
  }
  const gap = Number(c.minGapSeconds);
  if (!Number.isInteger(gap) || gap < 0 || gap > 3_600) {
    return "The minimum gap between doors must be between 0 seconds and an hour.";
  }

  // A config that cannot physically be satisfied would show every rep a bonus
  // they can never earn. 25 doors/hour and a 60-door target needs 3 hours; a
  // manager who sets the span to 1 hour has written an unreachable rule, and
  // finding that out from an empty payout report is finding out too late.
  if (c.enabled !== false && hourCap > 0) {
    const minutesNeeded = Math.ceil((doors - 1) / hourCap) * 60;
    if (span > 0 && minutesNeeded > 1_440) {
      return `${doors} doors at ${hourCap} an hour cannot fit in a day. Raise the hourly cap or lower the target.`;
    }
  }
  if (c.enabled !== false && gap > 0) {
    const minutesNeeded = ((doors - 1) * gap) / 60;
    if (minutesNeeded > 1_440) {
      return `${doors} doors ${gap} seconds apart cannot fit in a day. Lower the target or the gap.`;
    }
  }
  return null;
}
