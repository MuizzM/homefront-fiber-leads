// ── Training gate — a new rep finishes training before they touch the field ──
// A rep who has not been trained costs more than they earn: they burn doors with
// a bad pitch, mislabel dispositions the whole team then works off, and put the
// company's name on a conversation nobody coached. So a NEW rep lands in the app
// with one thing available — Training — and everything else opens when they
// finish.
//
// ── THIS IS A SERVER RULE, NOT A HIDDEN MENU ────────────────────────────────
// Hiding nav items is a courtesy, not a lock. The same predicate below runs in
// the API middleware, so a gated rep who types a URL, replays a saved request,
// or drives the app from a script gets a 403 exactly as if they had tapped.
//
// ── WHO IS NEVER GATED ──────────────────────────────────────────────────────
// Admins, managers, and team leads run the org — gating a manager out of the
// team screen because of a training counter would be an outage, not a policy.
// The gate applies to the `rep` role only.
//
// ── WHY EXISTING PEOPLE ARE NOT SWEPT UP ────────────────────────────────────
// The requirement is carried by a per-user flag that defaults ON for accounts
// created from now on, and is backfilled OFF for everyone who already exists.
// A rep who has been selling for months does not get locked out of their own
// route on a Tuesday because a new policy shipped — they were trained on the
// job, and the gate is about onboarding, not about re-certifying the floor.

export const TRAINING_GATE_EXEMPT_ROLES = ["admin", "super_admin", "manager", "team_lead"] as const;

/** A gated rep can still reach these. Everything else is refused.
 *
 * The list is deliberately short but NOT empty-minus-training: a rep who cannot
 * open their own paperwork can never finish onboarding, and one who cannot read
 * their profile or sign out is stuck in a dead app. Locking someone out of the
 * work is the policy; locking them out of becoming employable is a bug.
 *
 * Matched as path PREFIXES against the request path.
 */
export const TRAINING_GATE_ALLOWED_PREFIXES: readonly string[] = [
  "/api/auth",             // session, logout — never trap someone signed in
  "/api/training",         // the one thing they are here to do
  "/api/me",               // their own profile, documents, W-9, banking
  "/api/onboarding",       // signing the packet is part of becoming a rep
  "/api/notifications",    // "your training is required" has to be able to arrive
  "/api/diagnostics",      // support can still see what a stuck phone reports
  "/api/client-errors",    // a crash during training must still be reportable
  "/api/health",
];

/** Everything a gated rep is refused, expressed for the UI so the lock screen
 *  can name what is waiting rather than showing a blank app. */
export const TRAINING_GATE_LOCKED_LABELS: readonly string[] = [
  "The map and your doors",
  "Logging knocks and sales",
  "Leads and follow-ups",
  "Leaderboard and spiffs",
  "Your commission",
];

export interface TrainingGateState {
  /** The signed-in user's role. */
  role: string | null | undefined;
  /** Does this account still owe training? Persisted per user. */
  trainingRequired: boolean;
  /** Distinct lessons completed. */
  completedLessons: number;
  /** Lessons that must be completed to clear the gate. */
  requiredLessons: number;
}

export function isRoleExempt(role: string | null | undefined): boolean {
  return TRAINING_GATE_EXEMPT_ROLES.includes(String(role ?? "") as any);
}

/** Has this account finished what the org asks for? */
export function trainingComplete(s: Pick<TrainingGateState, "completedLessons" | "requiredLessons">): boolean {
  const need = Math.max(0, Math.trunc(Number(s.requiredLessons) || 0));
  if (need <= 0) return true; // an org that requires nothing gates nobody
  return Math.max(0, Math.trunc(Number(s.completedLessons) || 0)) >= need;
}

/**
 * The ONE rule. Both the API middleware and the client nav read this, so what a
 * rep can see and what the server will answer cannot drift apart.
 */
export function isTrainingGated(s: TrainingGateState): boolean {
  if (isRoleExempt(s.role)) return false;
  if (!s.trainingRequired) return false;
  return !trainingComplete(s);
}

/** Is this request path reachable while gated? */
export function pathAllowedWhileGated(path: string): boolean {
  const p = String(path ?? "");
  return TRAINING_GATE_ALLOWED_PREFIXES.some(prefix => p === prefix || p.startsWith(`${prefix}/`));
}

export interface TrainingGateProgress {
  completed: number;
  required: number;
  remaining: number;
  /** 0–100, clamped. */
  pct: number;
  /** One line the rep reads. Concrete — a number they can close. */
  headline: string;
}

/** What the lock screen says. Names the remaining count, because "complete your
 *  training" is a wall and "9 lessons left" is a finish line. */
export function gateProgress(s: Pick<TrainingGateState, "completedLessons" | "requiredLessons">): TrainingGateProgress {
  const required = Math.max(0, Math.trunc(Number(s.requiredLessons) || 0));
  const completed = Math.min(required, Math.max(0, Math.trunc(Number(s.completedLessons) || 0)));
  const remaining = Math.max(0, required - completed);
  const pct = required <= 0 ? 100 : Math.max(0, Math.min(100, Math.round((completed / required) * 100)));
  return {
    completed, required, remaining, pct,
    headline: remaining === 0
      ? "Training complete - everything is unlocked"
      : `${remaining} lesson${remaining === 1 ? "" : "s"} left to unlock the app`,
  };
}

/** Validation shared by the API and the admin form. Returns null when valid. */
export function validateRequiredLessons(value: unknown, totalAvailable: number): string | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return "Required lessons must be a whole number of 0 or more.";
  if (n > totalAvailable) return `There are only ${totalAvailable} lessons - the requirement cannot exceed that.`;
  return null;
}
