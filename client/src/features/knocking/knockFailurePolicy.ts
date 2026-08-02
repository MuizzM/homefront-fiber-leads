// ── Knock delivery failure policy ─────────────────────────────────────────────
// PURE and framework-free. The single source of truth for what the offline
// knock queue does when a delivery fails:
//
//   auth      → 401. The knock is valid; the SESSION expired. The queue pauses
//               the line without consuming an attempt and resumes after re-auth.
//   retryable → network flap, timeout, 408/425/429, any 5xx. The knock stays
//               PENDING and keeps backing off (capped) forever — a transient
//               failure must never become a permanent "needs attention" nag,
//               because the queue's own heartbeat will deliver it once the
//               world recovers.
//   forbidden → 403. Ambiguous: a stale CSRF token heals itself on re-login
//               (retry works), a scope denial heals once a manager assigns the
//               door (or the server opens the field to unassigned leads). It
//               gets bounded retries, then parks in the dead lane where the
//               rep sees the door + reason WITH a Retry that plausibly works.
//               Two self-healing refinements (owner report: the pill after
//               every server restart): a 403 within RESTART_BURST_WINDOW_MS of
//               a transient failure on the same queue is treated as TRANSIENT
//               (proxy artifact of the restart, budget untouched), and parked
//               retryable items are silently auto-retried on recovery signals
//               (see knockQueue's autoSweep) so the pill clears on its own
//               once the server is actually healthy.
//   terminal  → every other 4xx (400 validation, 404 lead gone/not yours…).
//               The server will NEVER accept this payload, so retrying is a
//               lie. The queue AUTO-RESOLVES it: drop the item, tell the rep
//               once (door + reason), and log it for support.
//
// Also owns rehydration triage (what happens to persisted items on reload,
// including migration/repair of stale-shaped payloads) and the human-readable
// reasons the FieldStatusBar and drop toasts display.

import { isKnockOutcome, type KnockOutcome, type QueuedKnock } from "@shared/knock";

export type KnockFailureKind = "auth" | "retryable" | "forbidden" | "terminal";

// A knock may only ever target a REAL server lead id. Temp optimistic pins
// (the one-tap add) use negative ids while reconciling — a knock enqueued
// against one can only ever 404, forever. Every enqueue path checks this.
export function isKnockableLeadId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}

// apiRequest throws Error("<status>: <detail>") — extract the status if there
// is one. A network failure ("Failed to fetch", timeout) has no status.
export function knockFailureStatus(lastError: string | null | undefined): number | null {
  if (!lastError) return null;
  const status = parseInt(lastError, 10);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

export function classifyKnockFailure(lastError: string | null | undefined): KnockFailureKind {
  const status = knockFailureStatus(lastError);
  if (status == null) return "retryable"; // network / timeout / unparseable
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 408 || status === 425 || status === 429) return "retryable";
  if (status >= 500) return "retryable";
  if (status >= 400) return "terminal";
  return "retryable"; // 1xx-3xx should never surface as an error; stay safe
}

// ── Restart-burst 403s (owner report: the pill after every server restart) ────
// While the server restarts, the reverse proxy can answer with 403/4xx bursts
// for requests that never reached the app at all. A 403 landing while the SAME
// queue is also seeing genuinely transient failures (network flap, 5xx,
// timeout) is far more likely such a proxy artifact than a real CSRF/authz
// rejection — so the queue reclassifies it as TRANSIENT: it stays pending with
// backoff and the bounded-retry budget is untouched, instead of marching an
// honest knock into the dead lane. Deliberately conservative: only REAL
// transient failures open/refresh the window (a burst-classified 403 never
// does, so a genuine 403 storm cannot keep itself "transient" forever), and a
// clean-air 403 keeps the current bounded → dead-lane behavior.
export const RESTART_BURST_WINDOW_MS = 120_000;

export function isLikelyRestartBurst403(
  kind: KnockFailureKind,
  lastTransientFailureAt: number,
  at: number,
): boolean {
  if (kind !== "forbidden") return false;
  if (!(lastTransientFailureAt > 0)) return false; // no transient failure seen — clean air
  const elapsed = at - lastTransientFailureAt;
  return elapsed >= 0 && elapsed <= RESTART_BURST_WINDOW_MS;
}

// Which dead-lane items a RECOVERY SIGNAL (back online, app foregrounded, a
// successful authenticated response, app load) may silently retry: exactly the
// ones whose manual Retry the FieldStatusBar offers. A terminal leftover is
// never re-posted — retrying it would be the same lie as showing its Retry.
export function isAutoRetryableDeadKnock(item: Pick<QueuedKnock, "lastError">): boolean {
  return classifyKnockFailure(item.lastError) !== "terminal";
}

// Short human reason for a knock the queue is dropping — completes the
// sentence "<door> couldn't save — <reason>".
export function terminalKnockReason(item: Pick<QueuedKnock, "leadId" | "lastError" | "outcome">): string {
  if (!isKnockableLeadId(item.leadId)) {
    return "the pin it was logged on never finished saving";
  }
  if (!isKnockOutcome(item.outcome)) {
    return "it was recorded by an older app version the server no longer accepts";
  }
  switch (knockFailureStatus(item.lastError)) {
    case 404:
      // Scope denial surfaces as 404 (the server never leaks existence across
      // the scope wall), so "gone" and "not your area" are the same status —
      // name both, and give the one path that actually resolves it. Retry is
      // NOT offered: nothing the rep can do redeems this knock as-is.
      return "the lead no longer exists or isn't in your assigned area — your manager can assign it";
    case 400:
    case 422:
      return "the server rejected it as invalid";
    default:
      return "the server can never accept it";
  }
}

// The one path that resolves a scope-denied knock — assignment, never re-auth.
export function scopeDeniedKnockReason(): string {
  return "this door isn't in your assigned area — your manager can assign it";
}

// Dead-lane copy for the forbidden/auth classes, split by the ACTUAL status
// the queue recorded ("<status>: <text>" — see knockFailureStatus):
//   401 → the session really did expire; re-auth is the fix, retry works after.
//   403 → NOT a re-auth problem. The knock route answers scope denial with 404,
//         so a 403 is CSRF/capability ambiguity OR a parked scope failure from
//         before the open-field server fix — either way "sign out and back in"
//         was a wild goose (owner report: reps told to re-auth on doors that
//         were simply unassigned). Point at the resolution that exists.
export function forbiddenKnockReason(lastError?: string | null): string {
  if (knockFailureStatus(lastError) === 401) {
    return "not authorized right now — sign out and back in, then retry";
  }
  return scopeDeniedKnockReason();
}

// ── Snapshot summary of a dead-lane item — what the FieldStatusBar renders ────
export interface DeadKnockSummary {
  clientId: string;
  leadId: number;
  outcome: KnockOutcome;
  reason: string;
  // Retry is only offered when it can plausibly work (403 heals after
  // re-auth; a rehydrated transient failure delivers on retry). A terminal
  // item never reaches the dead lane, but if legacy storage put one there we
  // stay honest and hide Retry.
  retryable: boolean;
}

export function summarizeDeadKnock(item: QueuedKnock): DeadKnockSummary {
  const kind = classifyKnockFailure(item.lastError);
  return {
    clientId: item.clientId,
    leadId: item.leadId,
    outcome: item.outcome,
    // Retryable flags are honest: a real 401 heals on re-auth (retryable), a
    // 403 heals on re-auth/assignment/server-fix (retryable — the self-heal
    // sweep depends on it), a terminal 4xx can never be redeemed by the rep
    // alone (NOT retryable — scope-denied needs a manager to assign the door).
    reason:
      kind === "auth" || kind === "forbidden"
        ? forbiddenKnockReason(item.lastError)
        : kind === "terminal"
          ? terminalKnockReason(item)
          : "delivery keeps failing — retry to send it now",
    retryable: kind !== "terminal",
  };
}

// ── Rehydration triage — persisted items resurfacing after a reload ───────────
// Migration/repair first (old queued shapes keep flushing after a deploy),
// then routing: poison items are DROPPED with a reason (auto-resolve, exactly
// like an in-flight terminal failure), transient dead-lane leftovers from the
// old "8 strikes = dead" policy go BACK TO PENDING, and only forbidden (403)
// items stay parked for a human.
export type RehydratedKnockTriage =
  | { action: "pending"; item: QueuedKnock }
  | { action: "dead"; item: QueuedKnock }
  | { action: "drop"; item: QueuedKnock; reason: string };

// Structural repair of a persisted item. Returns null only for unreadable
// garbage (nothing worth reporting); otherwise fills any fields an older app
// version didn't write so the current flush path can send it unchanged.
export function migrateQueuedKnock(raw: unknown): QueuedKnock | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.clientId !== "string" || r.clientId.length === 0) return null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    clientId: r.clientId,
    leadId: num(r.leadId, 0), // 0 = unknowable → triaged out as undeliverable
    repId: num(r.repId, 0),
    outcome: (str(r.outcome) ?? "") as QueuedKnock["outcome"],
    knockedAt: str(r.knockedAt) ?? str(r.deviceTs) ?? new Date().toISOString(),
    notes: str(r.notes),
    callbackDate: str(r.callbackDate),
    callbackTime: str(r.callbackTime),
    attempts: Math.max(0, Math.trunc(num(r.attempts, 0))),
    nextAttemptAt: Math.max(0, num(r.nextAttemptAt, 0)),
    lastError: str(r.lastError),
    repLat: typeof r.repLat === "number" ? r.repLat : null,
    repLng: typeof r.repLng === "number" ? r.repLng : null,
    gpsAccuracy: typeof r.gpsAccuracy === "number" ? r.gpsAccuracy : null,
    deviceTs: str(r.deviceTs),
    mockLocation: typeof r.mockLocation === "boolean" ? r.mockLocation : null,
    netState: r.netState === "online" || r.netState === "offline" ? r.netState : null,
    appVersion: str(r.appVersion),
  };
}

export function triageRehydratedKnock(
  raw: unknown,
  lane: "pending" | "dead",
): RehydratedKnockTriage | null {
  const item = migrateQueuedKnock(raw);
  if (item == null) return null;
  // Undeliverable regardless of lane: a temp/absent lead id or an outcome the
  // server's validator rejects can only ever 4xx — resolve it now instead of
  // letting it fail its way into a permanent nag.
  if (!isKnockableLeadId(item.leadId) || !isKnockOutcome(item.outcome)) {
    return { action: "drop", item, reason: terminalKnockReason(item) };
  }
  if (lane === "pending") return { action: "pending", item };
  const kind = classifyKnockFailure(item.lastError);
  if (kind === "terminal") {
    return { action: "drop", item, reason: terminalKnockReason(item) };
  }
  if (kind === "forbidden") return { action: "dead", item };
  // Transient (or unknown) failure parked by the old policy — it belongs back
  // in delivery, fresh attempt budget, immediately due.
  return { action: "pending", item: { ...item, attempts: 0, nextAttemptAt: 0, lastError: item.lastError } };
}

// ── Presentation ──────────────────────────────────────────────────────────────
// One-time toast when a terminal knock auto-resolves:
//   "42 Oak St couldn't save — the lead no longer exists…"
export function droppedKnockToast(
  address: string | null | undefined,
  reason: string,
): { title: string; description: string } {
  const door = address && address.trim() ? address.trim() : "A field update";
  return {
    title: `${door} couldn't save`,
    description: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}. It was removed from the sync queue.`,
  };
}

// FieldStatusBar "needs attention" line — door + reason for the oldest dead
// item, or count + first reason when several are parked.
export function needsAttentionText(
  count: number,
  address: string | null,
  reason: string | null,
): string {
  const suffix = reason ? ` — ${reason}` : "";
  if (count === 1) {
    return `${address ?? "1 field update"} needs attention${suffix}`;
  }
  return `${count} field updates need attention${suffix}`;
}
