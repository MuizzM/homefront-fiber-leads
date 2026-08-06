// ── Door drops — a surprise bonus that can land on ANY verified door ────────
//
// Every incentive in the app so far pays for an OUTCOME or a THRESHOLD: close a
// sale, clear 40 doors, hold a streak. All of them share a weakness — they go
// quiet exactly when a rep needs them most. A rep 12 doors into a dead street
// with no sale in sight is not chasing anything; the campaign is out of reach,
// the ladder is hours away, and the next door is worth nothing in particular.
//
// A door drop makes EVERY door worth something in particular. Small money, low
// odds, no warning:
//
//     "Door drop — $15. Nice one."
//
// ── WHY VARIABLE ODDS AND NOT A COUNTER ────────────────────────────────────
//
// A fixed "every 50th door pays" is a countdown a rep can do in their head, and
// the 3 doors after a payout are worth nothing. Random reinforcement doesn't
// have a trough: the next door is always the one that might pay. That is the
// entire reason this mechanic exists alongside the deterministic ones rather
// than replacing them.
//
// ── BUT THE DRY SPELL IS BOUNDED ───────────────────────────────────────────
//
// Pure randomness is cruel at the tail. Someone will knock 200 doors and get
// nothing, decide the whole thing is a lie, and stop believing any of it. So a
// rescue ramp lifts the odds deep into a dry run and reaches certainty at the
// ceiling. A rep can have a quiet run; they cannot have an endless one.
//
// The ramp deliberately does NOT start at door 0. Through the first ~60% of the
// window — more than a full day at the shipped default — every door carries the
// exact same chance, so there is no cold trough right after a payout and no warm
// run a rep can feel building. See FLAT_SHARE.
//
// ── AND THE ODDS NUMBER MEANS WHAT IT SAYS ─────────────────────────────────
//
// `oddsOneIn` is the budget lever. Because the rescue ramp adds drops on top of
// whatever base rate sits under it, starting the curve at a flat 1/oddsOneIn
// would run ~2× rich. The base is solved for instead, so the REALIZED long-run
// rate is the number the manager typed. See calibratedBaseChance.
//
// ── DETERMINISTIC, SO IT CANNOT BE FARMED OR RE-ROLLED ─────────────────────
//
// The roll is a hash of stable identity — tenant, rep, knock id. The same knock
// always rolls the same value, so a retry, an offline replay, or a double-tapped
// submit re-computes an identical result instead of buying another spin. Nothing
// here reads a clock or a random source.
//
// PURE: no clock, no database, no Math.random.

import { usd } from "./moneyFormat";

export interface DoorDropConfig {
  enabled: boolean;
  /** Base chance per verified door, as 1-in-N. */
  oddsOneIn: number;
  /** Doors since the last drop at which a drop becomes CERTAIN. Bounds the
   *  worst-case dry spell so nobody concludes the mechanic is fake. */
  pityAtDoors: number;
  /** Award band, integer cents. Drawn on the same deterministic roll. */
  minCents: number;
  maxCents: number;
  /** Awards land on this step so amounts read as money, not as noise. */
  stepCents: number;
  /** 0 = uncapped. */
  maxPerRepPerDay: number;
  maxCentsPerRepPerDay: number;
  maxCentsPerOrgPerDay: number;
}

export const DEFAULT_DOOR_DROP_CONFIG: DoorDropConfig = {
  enabled: true,
  // ~1 in 45 doors. A good day is 60–90 doors, so a rep sees one or two — often
  // enough to be real, rare enough to still be a surprise.
  oddsOneIn: 45,
  pityAtDoors: 120,
  minCents: 500,
  maxCents: 2_500,
  stepCents: 500,
  maxPerRepPerDay: 3,
  maxCentsPerRepPerDay: 6_000,
  maxCentsPerOrgPerDay: 40_000,
};

export interface DoorDropSignals {
  repId: number;
  /** Stable id of the knock being evaluated — the seed, and the idempotency key. */
  knockId: number;
  /** Verified doors this rep has worked since their last drop. Drives the pity
   *  curve. */
  doorsSinceLastDrop: number;
  dropsToday: number;
  awardedToRepTodayCents: number;
  awardedOrgTodayCents: number;
}

export type DoorDropSkip =
  | "disabled" | "no_roll" | "rep_count_cap" | "rep_money_cap" | "org_money_cap";

const cents = (n: unknown) => Math.max(0, Math.trunc(Number(n) || 0));

/**
 * FNV-1a plus a murmur3 final-avalanche mix → a stable, well-spread 32-bit value.
 *
 * Deliberately not Math.random: the same knock must always produce the same
 * verdict so a retry cannot buy a second spin, and so an award can be re-derived
 * from the ledger months later when someone asks why it paid.
 *
 * THE AVALANCHE STEP IS NOT OPTIONAL. Plain FNV-1a barely mixes its high bits
 * for short, highly-similar inputs — and "door:7:9001", "door:7:9002" … is
 * exactly that. Measured over 400 sequential knock ids, raw FNV-1a produced no
 * value below 0.141 and clustered hard in a few deciles, which means a 1-in-45
 * roll could NEVER fire: the drop would only ever land at the pity ceiling, and
 * a mechanic sold as random would really be a fixed 120-door counter.
 *
 * fmix32 spreads every input bit across the whole word, so sequential ids land
 * uniformly.
 */
export function seedHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // murmur3 fmix32 — the avalanche.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Two independent 0..1 draws from one seed — one decides IF, one decides HOW
 *  MUCH. Splitting them means the amount is not correlated with how close the
 *  hit was, which would otherwise make big awards cluster suspiciously.
 *
 *  Uses the FULL 32 bits (÷ 2^32) rather than a shifted slice: taking the high
 *  24 bits was the other half of the clustering above. */
export function rolls(seed: string): { hit: number; amount: number } {
  return {
    hit: seedHash(seed) / 4_294_967_296,
    amount: seedHash(`${seed}:amt`) / 4_294_967_296,
  };
}

/**
 * The share of the pity window that stays FLAT at the base rate before the
 * rescue ramp starts.
 *
 * At the shipped default (pity 120) that is the first 72 doors — more than a
 * full day of knocking. This is the point of the whole mechanic: within a normal
 * day every door carries the same honest chance, so there is no cold trough
 * after a payout and no warm run a rep can feel coming. The ramp exists for the
 * rep carrying a dead streak across days, not for the shape of an ordinary one.
 *
 * A ramp that starts at door 0 (what this originally did) cannot be both honest
 * and calibrated: to average 1-in-45 the base has to fall to ~1-in-366, which
 * makes the doors right after a drop nearly worthless — the exact trough this
 * mechanic exists to avoid.
 */
const FLAT_SHARE = 0.6;

/** Hazard at door `n`: flat at `base`, then quadratic to certainty at `pity`. */
function hazardAt(base: number, pity: number, n: number): number {
  if (n >= pity) return 1;
  const rampStart = pity * FLAT_SHARE;
  if (n < rampStart) return base;
  const u = (n - rampStart) / (pity - rampStart);
  return Math.min(1, base + (1 - base) * u * u);
}

/** Expected doors per drop for a given base chance, walking the pity curve.
 *
 *  Survival product: the chance of reaching door n with nothing yet, summed. */
function meanDoorsPerDrop(base: number, pity: number): number {
  let survives = 1, mean = 0;
  for (let n = 0; n <= pity; n += 1) {
    mean += survives;
    survives *= 1 - hazardAt(base, pity, n);
    if (survives <= 1e-12) break;
  }
  return mean;
}

// Solving the base rate costs a few hundred float ops, and this runs on every
// verified knock. The answer depends only on two config numbers, so memoise it.
const baseCache = new Map<string, number>();

/**
 * The base chance the curve must START at so that the REALIZED long-run rate is
 * actually 1-in-`oddsOneIn`.
 *
 * THIS IS NOT COSMETIC. `oddsOneIn` is the budget lever — it is the one number a
 * manager sets to decide what this programme costs. Starting the curve at a flat
 * `1 / oddsOneIn` looks correct and is not: the pity climb adds drops on top of
 * the base rate, so the realized rate overshoots badly, and by an amount that
 * moves with the settings. Measured against a ramp starting at door 0:
 *
 *     set 1-in-45,  pity 120  →  really 1-in-22.4   (2.01× the drops)
 *     set 1-in-30,  pity  90  →  really 1-in-17.2   (1.74×)
 *     set 1-in-100, pity 250  →  really 1-in-39.6   (2.53×)
 *
 * So a manager budgeting for one drop per rep per day would have spent double,
 * and could not even learn a correction factor because the error is not
 * constant — it grows exactly as they try to be MORE conservative. We solve for
 * the base instead: bisect until the modelled mean matches the number typed.
 *
 * If the ramp alone already pays more often than requested (a pity ceiling set
 * very tight against the odds), base bottoms out at 0 and the ramp wins;
 * `validateDoorDropConfig` refuses to store such a config.
 */
export function calibratedBaseChance(cfg: DoorDropConfig = DEFAULT_DOOR_DROP_CONFIG): number {
  const target = Math.max(2, Math.trunc(Number(cfg.oddsOneIn) || 2));
  const pity = Math.max(1, Math.trunc(Number(cfg.pityAtDoors) || 1));
  const cacheKey = `${target}:${pity}`;
  const hit = baseCache.get(cacheKey);
  if (hit !== undefined) return hit;

  // meanDoorsPerDrop DECREASES as base rises (more base chance → drops sooner),
  // so a mean still above target means the base is too LOW. Bisect accordingly.
  let answer = 0;
  if (meanDoorsPerDrop(0, pity) > target) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if (meanDoorsPerDrop(mid, pity) > target) lo = mid; else hi = mid;
    }
    answer = (lo + hi) / 2;
  }
  // else: the ceiling alone is already richer than asked — there is no base to
  // subtract, so it bottoms out at 0. validateDoorDropConfig refuses to store
  // such a config, but a legacy or hand-edited row must still be survivable.
  baseCache.set(cacheKey, answer);
  return answer;
}

/** The leanest rate a given guarantee can honour — the rescue ramp with NO base
 *  chance under it. Ask for anything rarer and the ramp overrides you. */
export function leanestOddsFor(pityAtDoors: number): number {
  return meanDoorsPerDrop(0, Math.max(1, Math.trunc(Number(pityAtDoors) || 1)));
}

/** The smallest guarantee that can honour the given odds. Used to tell a manager
 *  what to type instead of just refusing them. */
export function minimumPityFor(oddsOneIn: number): number {
  const target = Math.max(2, Math.trunc(Number(oddsOneIn) || 2));
  // leanestOddsFor is monotonic in pity, so walk up in coarse steps then round
  // to something a human would actually type.
  let pity = target;
  while (pity < 100_000 && leanestOddsFor(pity) < target) pity = Math.ceil(pity * 1.05);
  return Math.ceil(pity / 10) * 10;
}

/**
 * The chance this door pays, 0..1.
 *
 * Flat at the calibrated base through the first `FLAT_SHARE` of the window, then
 * quadratic to certainty at `pityAtDoors`.
 *
 * Shares `hazardAt` with the calibration above ON PURPOSE — if the solver and
 * the live roll used different curves the realized rate would silently drift
 * from the configured one, which is the whole class of bug this fixes.
 */
export function dropChance(doorsSinceLastDrop: number, cfg: DoorDropConfig = DEFAULT_DOOR_DROP_CONFIG): number {
  const pity = Math.max(1, Math.trunc(Number(cfg.pityAtDoors) || 1));
  const since = Math.max(0, Math.trunc(Number(doorsSinceLastDrop) || 0));
  return hazardAt(calibratedBaseChance(cfg), pity, since);
}

/** Snap into the band, on the configured step. Money should read as money. */
export function drawAmountCents(roll: number, cfg: DoorDropConfig = DEFAULT_DOOR_DROP_CONFIG): number {
  const min = cents(cfg.minCents), max = Math.max(min, cents(cfg.maxCents));
  const step = Math.max(1, cents(cfg.stepCents));
  const steps = Math.floor((max - min) / step) + 1;
  const pick = Math.min(steps - 1, Math.floor(Math.max(0, Math.min(0.999999, roll)) * steps));
  return min + pick * step;
}

export interface DoorDrop {
  amountCents: number;
  /** What the rep reads. */
  headline: string;
  /** The ledger line, and what shows on their pay statement weeks later. */
  reason: string;
}

/**
 * Does this door pay?
 *
 * Caps are checked BEFORE the roll is spent, so a rep at their ceiling does not
 * silently burn a winning door — the pity counter keeps climbing and the drop
 * lands tomorrow instead of evaporating.
 */
export function evaluateDoorDrop(
  s: DoorDropSignals, cfg: DoorDropConfig = DEFAULT_DOOR_DROP_CONFIG,
): { drop: DoorDrop } | { skip: DoorDropSkip } {
  if (!cfg.enabled) return { skip: "disabled" };

  if (cfg.maxPerRepPerDay > 0 && s.dropsToday >= cfg.maxPerRepPerDay) return { skip: "rep_count_cap" };
  if (cfg.maxCentsPerRepPerDay > 0 && cents(s.awardedToRepTodayCents) >= cfg.maxCentsPerRepPerDay) {
    return { skip: "rep_money_cap" };
  }
  if (cfg.maxCentsPerOrgPerDay > 0 && cents(s.awardedOrgTodayCents) >= cfg.maxCentsPerOrgPerDay) {
    return { skip: "org_money_cap" };
  }

  const seed = `door:${s.repId}:${s.knockId}`;
  const r = rolls(seed);
  if (r.hit >= dropChance(s.doorsSinceLastDrop, cfg)) return { skip: "no_roll" };

  let amount = drawAmountCents(r.amount, cfg);
  // Trim to whatever room is left rather than refusing — same rule campaigns and
  // milestones use. A drop worth less is still a drop.
  if (cfg.maxCentsPerRepPerDay > 0) {
    amount = Math.min(amount, cfg.maxCentsPerRepPerDay - cents(s.awardedToRepTodayCents));
  }
  if (cfg.maxCentsPerOrgPerDay > 0) {
    amount = Math.min(amount, cfg.maxCentsPerOrgPerDay - cents(s.awardedOrgTodayCents));
  }
  if (amount <= 0) return { skip: "rep_money_cap" };

  return {
    drop: {
      amountCents: amount,
      headline: `Door drop — ${usd(amount)}`,
      reason: "Door drop — surprise bonus on a verified door",
    },
  };
}

/** The one definition lives in ./moneyFormat (dependency-free, see its header
 *  for the bundle rationale). Re-exported here so existing importers keep
 *  working — the import flows INTO this module, never out of it. */
export { usd };

/**
 * The line on the rep's card between drops.
 *
 * Deliberately NOT a percentage or a countdown. Showing "2.2% chance" turns a
 * field app into a slot machine readout, and showing "37 doors to go" hands back
 * the deterministic counter this mechanic exists to avoid. What a rep gets is
 * the honest shape of it: every door can pay, and a long dry run means one is
 * coming.
 */
export function dropStatusLine(
  doorsSinceLastDrop: number, cfg: DoorDropConfig = DEFAULT_DOOR_DROP_CONFIG,
): string {
  const since = Math.max(0, Math.trunc(Number(doorsSinceLastDrop) || 0));
  if (since === 0) return "Any door can drop a surprise bonus.";
  const chance = dropChance(since, cfg);
  if (chance >= 0.5) return `${since} doors since your last drop — one is due.`;
  if (since >= Math.round(cfg.pityAtDoors * 0.25)) return `${since} doors since your last drop — the odds are climbing.`;
  return "Any door can drop a surprise bonus.";
}

/** Shared by the API and the admin form. Returns null when valid. */
export function validateDoorDropConfig(input: unknown): string | null {
  const c = input as DoorDropConfig | null;
  if (!c || typeof c !== "object") return "The configuration is missing.";

  const ints: Array<[string, number, number, number]> = [
    ["Odds (1 in N)", Number(c.oddsOneIn), 2, 1_000],
    ["Guaranteed-by doors", Number(c.pityAtDoors), 1, 5_000],
    ["Minimum award", Number(c.minCents), 1, 100_000],
    ["Maximum award", Number(c.maxCents), 1, 100_000],
    ["Award step", Number(c.stepCents), 1, 100_000],
  ];
  for (const [label, v, lo, hi] of ints) {
    if (!Number.isInteger(v) || v < lo || v > hi) return `${label} must be between ${lo} and ${hi}.`;
  }
  if (Number(c.maxCents) < Number(c.minCents)) return "The maximum award cannot be below the minimum.";
  // A drop is a small surprise. Four figures is a fat finger, and the same
  // ceiling every other incentive here enforces.
  if (Number(c.maxCents) > 100_000) return "A door drop cannot exceed $1,000.";
  // A guarantee set too close to the odds makes the rescue ramp — not the odds —
  // decide the rate, which turns the mechanic into a countdown and quietly pays
  // more than the manager asked for. This is COMPUTED from the actual curve
  // rather than guessed at ("pity >= odds" was the guess, and it accepted
  // configs that ran 3× rich).
  const leanest = leanestOddsFor(Number(c.pityAtDoors));
  if (Number(c.oddsOneIn) > leanest) {
    return `A guarantee at ${c.pityAtDoors} doors already pays about 1 in ${Math.floor(leanest)} `
      + `on its own, so 1 in ${c.oddsOneIn} cannot be honoured — every drop would just be a `
      + `countdown. Raise the guarantee to about ${minimumPityFor(Number(c.oddsOneIn))} doors, `
      + `or set the odds to 1 in ${Math.floor(leanest)} or better.`;
  }
  for (const [label, v] of [
    ["Drops per rep per day", c.maxPerRepPerDay],
    ["Per-rep daily cap", c.maxCentsPerRepPerDay],
    ["Org daily cap", c.maxCentsPerOrgPerDay],
  ] as const) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) return `${label} must be a whole number (0 = uncapped).`;
  }
  return null;
}

/** What a drop programme costs at a given door volume — the number a manager
 *  needs before switching it on, and one nobody works out by hand. */
export function expectedDailyCostCents(
  doorsPerRepPerDay: number, activeReps: number, cfg: DoorDropConfig = DEFAULT_DOOR_DROP_CONFIG,
): number {
  const doors = Math.max(0, Math.trunc(Number(doorsPerRepPerDay) || 0));
  const reps = Math.max(0, Math.trunc(Number(activeReps) || 0));
  const avgAward = (cents(cfg.minCents) + cents(cfg.maxCents)) / 2;
  // Safe to divide by the STATED odds only because dropChance is calibrated to
  // realize them. Against an uncalibrated curve this estimate was ~half the
  // true bill.
  const expectedDrops = Math.min(
    cfg.maxPerRepPerDay > 0 ? cfg.maxPerRepPerDay : Infinity,
    doors / Math.max(2, cfg.oddsOneIn),
  );
  const perRep = Math.min(
    expectedDrops * avgAward,
    cfg.maxCentsPerRepPerDay > 0 ? cfg.maxCentsPerRepPerDay : Infinity,
  );
  const total = perRep * reps;
  return Math.round(Math.min(total, cfg.maxCentsPerOrgPerDay > 0 ? cfg.maxCentsPerOrgPerDay : total));
}
