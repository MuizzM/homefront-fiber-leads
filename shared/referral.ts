// ── Rep referral program (PURE) ─────────────────────────────────────────────
//
// An existing rep shares a link; someone applies through it; if they are hired,
// activated, trained, and go on to close N approved sales, the referrer earns a
// reward. This file owns every rule in that sentence. No clock, no database.
//
// ── WHY QUALIFICATION IS A CHECKLIST, NOT A BOOLEAN ─────────────────────────
// `evaluateQualification` returns each requirement's state, not just a verdict.
// The rep-facing dashboard has to show "0 of 6 sales · training incomplete", and
// a progress display derived separately from the award rule is a progress
// display that eventually lies. One function answers both questions, exactly as
// shared/spiffCampaign.ts already does for campaign progress.
//
// ── THE REWARD IS PENDING UNTIL THE CLAWBACK WINDOW CLOSES ──────────────────
// Sales cancel. A referral reward paid the instant the sixth sale lands is a
// reward paid on sales that may not survive the month. QUALIFIED → REWARD_PENDING
// → APPROVED is the shape that lets an org hold the money for a configured
// window and still show the referrer that they earned it.

export const REFERRAL_STATUSES = [
  "CLICKED",
  "APPLICATION_STARTED",
  "APPLIED",
  "HIRED",
  "TRAINING_PENDING",
  "ACTIVATED",
  "IN_PROGRESS",
  "QUALIFIED",
  "REWARD_PENDING",
  "APPROVED",
  "PAID",
  "REJECTED",
  "EXPIRED",
  "CLAWED_BACK",
] as const;

export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/**
 * Legal transitions.
 *
 * Terminal states (PAID, REJECTED, EXPIRED, CLAWED_BACK) have no exits by
 * design: reinstating a rejected referral is a NEW referral with its own audit
 * trail, not a status flip that erases why it was rejected.
 *
 * REJECTED and EXPIRED are reachable from every live state because an admin can
 * kill a referral at any point and an unqualified referral can time out at any
 * point — but neither is reachable from a paid one, because that money already
 * moved and its reversal is CLAWED_BACK.
 */
const LIVE_STATES: ReferralStatus[] = [
  "CLICKED", "APPLICATION_STARTED", "APPLIED", "HIRED",
  "TRAINING_PENDING", "ACTIVATED", "IN_PROGRESS", "QUALIFIED", "REWARD_PENDING",
];

const REFERRAL_TRANSITIONS: Record<ReferralStatus, readonly ReferralStatus[]> = {
  CLICKED: ["APPLICATION_STARTED", "APPLIED", "REJECTED", "EXPIRED"],
  APPLICATION_STARTED: ["APPLIED", "REJECTED", "EXPIRED"],
  APPLIED: ["HIRED", "REJECTED", "EXPIRED"],
  HIRED: ["TRAINING_PENDING", "ACTIVATED", "REJECTED", "EXPIRED"],
  TRAINING_PENDING: ["ACTIVATED", "REJECTED", "EXPIRED"],
  ACTIVATED: ["IN_PROGRESS", "QUALIFIED", "REJECTED", "EXPIRED"],
  IN_PROGRESS: ["QUALIFIED", "REJECTED", "EXPIRED"],
  QUALIFIED: ["REWARD_PENDING", "REJECTED", "EXPIRED"],
  REWARD_PENDING: ["APPROVED", "REJECTED", "EXPIRED"],
  // Approval commits the money; from there it is paid or clawed back.
  APPROVED: ["PAID", "CLAWED_BACK", "REJECTED"],
  PAID: ["CLAWED_BACK"],
  REJECTED: [],
  EXPIRED: [],
  CLAWED_BACK: [],
};

export function canReferralTransition(from: ReferralStatus, to: ReferralStatus): boolean {
  if (from === to) return true;
  return (REFERRAL_TRANSITIONS[from] ?? []).includes(to);
}

export function isReferralLive(status: ReferralStatus): boolean {
  return LIVE_STATES.includes(status);
}

/** Has money been committed? Gates the anti-tamper rules below. */
export function isReferralCommitted(status: ReferralStatus): boolean {
  return status === "APPROVED" || status === "PAID";
}

/** How far through the funnel, for a progress bar. */
export function referralStageIndex(status: ReferralStatus): number {
  const i = LIVE_STATES.indexOf(status);
  if (i >= 0) return i;
  return status === "APPROVED" || status === "PAID" ? LIVE_STATES.length : -1;
}

// ── Program configuration ───────────────────────────────────────────────────

/**
 * Everything an admin may tune. The DEFAULTS encode the spec's recommended
 * rule; none of it is hard-coded anywhere else.
 */
export interface ReferralProgramConfig {
  /** Master switch. OFF for every org until an admin turns it on, so shipping
   *  this creates no liability anywhere. */
  enabled: boolean;
  /** Integer cents. $500 by default. */
  rewardCents: number;
  /** Approved, non-cancelled sales the referred rep must produce. */
  requiredApprovedSales: number;
  /** Days from HIRED within which those sales must land. 0 = no deadline. */
  qualificationWindowDays: number;
  /** Days after qualification before the reward may be approved — the window in
   *  which a cancelled sale can still un-qualify it. */
  clawbackWindowDays: number;
  /** Must the referred rep have finished required training? */
  requireTrainingComplete: boolean;
  /** Must they be ACTIVE at the moment of qualification? */
  requireActiveStatus: boolean;
  /** Days a click/application stays attributable before it expires. */
  attributionWindowDays: number;
}

export const DEFAULT_REFERRAL_CONFIG: ReferralProgramConfig = {
  enabled: false,          // dark until an admin opts in
  rewardCents: 50_000,     // $500
  requiredApprovedSales: 6,
  qualificationWindowDays: 180,
  clawbackWindowDays: 30,
  requireTrainingComplete: true,
  requireActiveStatus: true,
  attributionWindowDays: 90,
};

export function validateReferralConfig(c: Partial<ReferralProgramConfig>): string[] {
  const problems: string[] = [];
  if (c.rewardCents != null && (!Number.isInteger(c.rewardCents) || c.rewardCents < 0)) {
    problems.push("rewardCents must be a whole number of cents");
  }
  // A zero-sale threshold would pay for a signup, which is how referral fraud
  // becomes profitable rather than merely possible.
  if (c.requiredApprovedSales != null && (!Number.isInteger(c.requiredApprovedSales) || c.requiredApprovedSales < 1)) {
    problems.push("requiredApprovedSales must be at least 1");
  }
  for (const key of ["qualificationWindowDays", "clawbackWindowDays", "attributionWindowDays"] as const) {
    const v = c[key];
    if (v != null && (!Number.isInteger(v) || v < 0)) problems.push(`${key} must be a whole number of days`);
  }
  return problems;
}

// ── Qualification ───────────────────────────────────────────────────────────

/** Everything known about a referred rep at evaluation time. */
export interface ReferralFacts {
  /** Referral row state. */
  hiredAt: string | null;
  activatedAt: string | null;
  /** Approved, non-cancelled sales attributed to the referred rep. */
  approvedSalesCount: number;
  /** Has the referred rep finished the org's required training? */
  trainingComplete: boolean;
  /** Is the referred rep's team-member record active right now? */
  repActive: boolean;
  /** Instant of the qualifying (Nth) sale, if it has happened. */
  thresholdReachedAt: string | null;
}

export interface RequirementState {
  key: "hired" | "activated" | "training" | "active" | "sales" | "window";
  label: string;
  met: boolean;
  /** For countable requirements — drives "3 of 6". */
  current?: number;
  target?: number;
}

export interface QualificationResult {
  qualified: boolean;
  requirements: RequirementState[];
  /** Sales still needed. 0 once the bar is cleared. */
  salesRemaining: number;
  /** 0..1, for a progress bar. Sales-weighted, since that is the long pole. */
  progress: number;
  /** Why it can never qualify, when that is already decided. */
  blocked: "window_expired" | null;
}

const DAY_MS = 86_400_000;

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso), b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return (b - a) / DAY_MS;
}

/**
 * The one function that decides both "has this qualified?" and "how close is
 * it?". The rep's checklist and the award logic read the same answer, so the
 * dashboard cannot promise a reward the engine then refuses.
 *
 * `nowIso` is supplied — this module has no clock.
 */
export function evaluateQualification(
  facts: ReferralFacts,
  config: ReferralProgramConfig,
  nowIso: string,
): QualificationResult {
  const target = Math.max(1, config.requiredApprovedSales);
  const sales = Math.max(0, Math.trunc(facts.approvedSalesCount));

  // The window runs from HIRE, not from the click: the referrer's job ends when
  // the person is hired, and holding them to a clock that started while the
  // applicant was still deciding would punish a slow hiring process.
  const windowOpen = config.qualificationWindowDays <= 0
    || !facts.hiredAt
    || daysBetween(facts.hiredAt, nowIso) <= config.qualificationWindowDays;

  const requirements: RequirementState[] = [
    { key: "hired", label: "Referred rep hired", met: !!facts.hiredAt },
    { key: "activated", label: "Account activated", met: !!facts.activatedAt },
  ];
  if (config.requireTrainingComplete) {
    requirements.push({ key: "training", label: "Required training complete", met: facts.trainingComplete });
  }
  if (config.requireActiveStatus) {
    requirements.push({ key: "active", label: "Currently active", met: facts.repActive });
  }
  requirements.push({
    key: "sales", label: `${target} approved sales`, met: sales >= target,
    current: Math.min(sales, target), target,
  });
  if (config.qualificationWindowDays > 0) {
    requirements.push({
      key: "window",
      label: `Within ${config.qualificationWindowDays} days of hire`,
      met: windowOpen,
    });
  }

  return {
    qualified: requirements.every(r => r.met),
    requirements,
    salesRemaining: Math.max(0, target - sales),
    progress: Math.min(1, sales / target),
    // Once the clock has run out the referral can never qualify, which is a
    // different fact from "not yet" and is surfaced as such.
    blocked: windowOpen ? null : "window_expired",
  };
}

/**
 * May the reward be APPROVED yet? Qualification starts a holding period; the
 * money is only releasable once the clawback window has closed, because a sale
 * cancelled in week two must be able to un-qualify a referral from week one.
 */
export function rewardReleasable(
  qualifiedAtIso: string | null,
  config: ReferralProgramConfig,
  nowIso: string,
): { releasable: boolean; daysRemaining: number } {
  if (!qualifiedAtIso) return { releasable: false, daysRemaining: config.clawbackWindowDays };
  if (config.clawbackWindowDays <= 0) return { releasable: true, daysRemaining: 0 };
  const elapsed = daysBetween(qualifiedAtIso, nowIso);
  const remaining = Math.max(0, Math.ceil(config.clawbackWindowDays - elapsed));
  return { releasable: remaining <= 0, daysRemaining: remaining };
}

/** Has an unconverted click/application aged out of attribution? */
export function attributionExpired(
  createdAtIso: string,
  config: ReferralProgramConfig,
  nowIso: string,
): boolean {
  if (config.attributionWindowDays <= 0) return false;
  return daysBetween(createdAtIso, nowIso) > config.attributionWindowDays;
}

// ── Referral codes ──────────────────────────────────────────────────────────

/**
 * The alphabet excludes 0/O/1/I/L — a referral code is read aloud, written on
 * a napkin, and typed by someone who has never seen it. Ambiguous glyphs turn
 * into support tickets and, worse, into attributions that land on nobody.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const REFERRAL_CODE_LENGTH = 8;

/**
 * Build a code from caller-supplied randomness, so this stays pure and a test
 * can pin the exact output. The server passes real random bytes.
 */
export function referralCodeFrom(bytes: Uint8Array | readonly number[]): string {
  let out = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    const b = Number(bytes[i] ?? 0) & 0xff;
    out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Normalize whatever an applicant typed, or null if it cannot be a code.
 *
 * Case-insensitive, and separators people add themselves (spaces, dashes) are
 * dropped. Ambiguous glyphs are NOT folded to a guess: because the alphabet
 * excludes both members of every confusable pair (0/O, 1/I/L), a character
 * outside it is genuinely unresolvable, and silently rewriting it would attach
 * a signup to whichever rep's code happened to match.
 *
 * Validating the shape here means a malformed code never reaches a database
 * lookup — which also keeps the signup endpoint from being a code oracle.
 */
export function normalizeReferralCode(raw: unknown): string | null {
  const cleaned = String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== REFERRAL_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return null;
  return cleaned;
}

export function referralUrl(baseUrl: string, code: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/join?ref=${encodeURIComponent(code)}`;
}

// ── Anti-fraud ──────────────────────────────────────────────────────────────

export type ReferralRejection =
  | "self_referral"
  | "existing_user"
  | "already_referred"
  | "referrer_inactive"
  | "program_disabled"
  | "attribution_expired";

export interface AttributionCandidate {
  /** team_members.id of the rep whose code was used. */
  referrerRepId: number;
  referrerActive: boolean;
  /** Normalized email of the applicant. */
  applicantEmail: string;
  /** The referrer's own email, normalized. */
  referrerEmail: string;
  /** Does a user account already exist for the applicant's email? */
  applicantAlreadyHasAccount: boolean;
  /** Is there already a live referral for this applicant? */
  applicantAlreadyReferred: boolean;
  /** Link creation instant, for the attribution window. */
  linkCreatedAt: string;
}

/**
 * May this attribution be recorded? Returns the reason it cannot, or null.
 *
 * Ordered so the most specific, most abuse-relevant reason wins: someone
 * referring themselves should be told exactly that, not "already referred".
 */
export function rejectAttribution(
  c: AttributionCandidate,
  config: ReferralProgramConfig,
  nowIso: string,
): ReferralRejection | null {
  if (!config.enabled) return "program_disabled";
  // The cheapest fraud there is: apply through your own link with a second
  // email. Same-address matching is the floor, not the ceiling — the store
  // additionally refuses when the applicant resolves to the referrer's user.
  if (c.applicantEmail && c.applicantEmail === c.referrerEmail) return "self_referral";
  // "The referred person must be a NEW applicant, not an existing user."
  if (c.applicantAlreadyHasAccount) return "existing_user";
  if (c.applicantAlreadyReferred) return "already_referred";
  if (!c.referrerActive) return "referrer_inactive";
  if (attributionExpired(c.linkCreatedAt, config, nowIso)) return "attribution_expired";
  return null;
}

export const REJECTION_MESSAGES: Record<ReferralRejection, string> = {
  self_referral: "A rep cannot refer themselves.",
  existing_user: "This person already has an account, so the referral cannot be credited.",
  already_referred: "Someone has already referred this applicant.",
  referrer_inactive: "The referring rep is no longer active.",
  program_disabled: "The referral program is not currently running.",
  attribution_expired: "This referral link is older than the attribution window.",
};

/**
 * May the referrer on an existing referral be CHANGED?
 *
 * Never once the referred rep is hired, unless an admin overrides — which is
 * exactly the spec's rule, and mirrors the immutable `recruited_by_member_id`
 * sponsor edge the roster already protects with a database trigger. A referrer
 * that can be re-pointed after hire is a reward that can be redirected to
 * whoever asks last.
 */
export function canChangeReferrer(
  status: ReferralStatus,
  actorIsAdmin: boolean,
): { allowed: boolean; reason: string | null } {
  const preHire: ReferralStatus[] = ["CLICKED", "APPLICATION_STARTED", "APPLIED"];
  if (preHire.includes(status)) return { allowed: true, reason: null };
  if (isReferralCommitted(status)) {
    return { allowed: false, reason: "The reward has already been committed to the current referrer." };
  }
  if (actorIsAdmin) return { allowed: true, reason: null };
  return { allowed: false, reason: "Changing the referrer after hire requires an admin." };
}

// ── The referred person's own view ──────────────────────────────────────────
//
// What someone who was REFERRED may see about the referral they are the subject
// of. Kept here, pure, so there is exactly ONE definition of what is safe to
// show and it can be tested without a server.
//
// ── WHAT IS DELIBERATELY ABSENT, AND WHY ───────────────────────────────────
// The referred person is not the beneficiary. The reward is the REFERRER's
// compensation, so no amount appears here at all — not the configured reward,
// not a partial, not a currency field left at zero. A zero would invite "why is
// my bonus $0", and any real figure is someone else's pay.
//
// Nothing identifies the referrer either. The applicant already knows who gave
// them a link; the platform confirming it turns a social fact into a record,
// and one that survives the referrer leaving.
//
// And a declined referral never says WHY. "Invalid code", "referrer offboarded"
// and "anti-fraud rule triggered" are each a probe someone could use to tune a
// next attempt, so every non-qualifying terminal state collapses to the single
// opaque `unavailable`.

/** Plain-language reward state, from the referred person's point of view. */
export type ApplicantRewardState =
  /** No referral is attached to this person at all. */
  | "none"
  /** Attributed and still working toward the bar. */
  | "in_progress"
  /** The bar is met; the organization is reviewing or holding it. */
  | "in_review"
  | "approved"
  | "paid"
  /** Closed without a reward. Deliberately says nothing about the cause. */
  | "unavailable";

export interface ApplicantReferralStatus {
  /** Was this person referred by someone? */
  attributed: boolean;
  rewardState: ApplicantRewardState;
  /** Their OWN qualifying sales toward the threshold. Safe because it is their
   *  own work, and it is the one number that makes the view actionable. Null
   *  before there is anything to count. */
  salesProgress: { current: number; target: number } | null;
  /** Their own funnel milestones — facts about themselves, not about the
   *  programme's rules. */
  milestones: { hired: boolean; activated: boolean; trainingComplete: boolean };
  /** One sentence for the UI. Never contains a reason for a decline. */
  headline: string;
}

const APPLICANT_TERMINAL_UNAVAILABLE: ReadonlySet<ReferralStatus> = new Set<ReferralStatus>([
  "REJECTED", "EXPIRED", "CLAWED_BACK",
]);

/**
 * Project a referral into what its SUBJECT may see.
 *
 * Takes the already-computed qualification result rather than recomputing, so
 * this view can never disagree with the one the referrer and the admin see
 * about the same referral — they are three renderings of one evaluation.
 */
export function applicantStatusView(
  referral: {
    status: ReferralStatus;
    hiredAt: string | null;
    activatedAt: string | null;
  } | null,
  qualification: QualificationResult | null,
  trainingComplete: boolean,
): ApplicantReferralStatus {
  if (!referral) {
    return {
      attributed: false,
      rewardState: "none",
      salesProgress: null,
      milestones: { hired: false, activated: false, trainingComplete: false },
      headline: "You were not referred by anyone, so there is nothing to track here.",
    };
  }

  const salesRequirement = qualification?.requirements.find(r => r.key === "sales");
  const salesProgress = salesRequirement?.target != null
    ? { current: salesRequirement.current ?? 0, target: salesRequirement.target }
    : null;

  const milestones = {
    hired: !!referral.hiredAt,
    activated: !!referral.activatedAt,
    trainingComplete,
  };

  // Order matters: the terminal check runs FIRST so a rejected referral can
  // never fall through into a state that describes progress.
  let rewardState: ApplicantRewardState;
  if (APPLICANT_TERMINAL_UNAVAILABLE.has(referral.status)) rewardState = "unavailable";
  else if (referral.status === "PAID") rewardState = "paid";
  else if (referral.status === "APPROVED") rewardState = "approved";
  else if (referral.status === "QUALIFIED" || referral.status === "REWARD_PENDING") rewardState = "in_review";
  else rewardState = "in_progress";

  const HEADLINES: Record<ApplicantRewardState, string> = {
    none: "You were not referred by anyone, so there is nothing to track here.",
    in_progress: salesProgress
      ? `You are ${salesProgress.current} of ${salesProgress.target} approved sales toward completing your referral.`
      : "Your referral is on file. Your progress will show here once you start selling.",
    in_review: "You have met everything asked of you. Your referral is with your organization for review.",
    approved: "Your referral has been approved.",
    paid: "Your referral is complete.",
    // No cause, by design.
    unavailable: "This referral is closed. Ask your manager if you have questions.",
  };

  return { attributed: true, rewardState, salesProgress, milestones, headline: HEADLINES[rewardState] };
}
