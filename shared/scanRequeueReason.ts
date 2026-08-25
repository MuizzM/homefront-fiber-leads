// ── scanRequeueReason — why an address went back on the queue ─────────────────
// A requeue is the scan engine's only "try again" primitive, and it is invisible
// by construction: the target flips back to 'queued', no counter moves, and the
// run keeps reporting healthy. Two live runs on 2026-08-24 proved how expensive
// that silence is — run_1_mt7hy05z logged 31,777 requeues against 755 completions
// (42:1) and run_1_mt7n0iyz logged 657 requeues with nothing verified at all.
// Neither could be diagnosed from the database, because the only recorded
// discriminator was a two-value `category` (provider_blocked | inconclusive).
//
// So every requeue now names itself from this CLOSED vocabulary, and the reason
// is stamped into fiber_job_events.payload_json alongside the underlying HTTP
// status / error text. One query answers "why is this run churning":
//
//   SELECT json_extract(payload_json,'$.reason') AS reason, COUNT(*)
//   FROM fiber_job_events
//   WHERE run_id=? AND event_type='address.requeued'
//   GROUP BY 1 ORDER BY 2 DESC;
//
// This file is deliberately dependency-free so the producer (server/scanner.ts),
// the queue primitive (server/scanIntelStore.ts), and any operator/admin surface
// share ONE definition and can never drift apart.

/** Every reason an address may be returned to the queue. Closed set — a new
 *  requeue path must add its code here, which is what makes the vocabulary
 *  queryable instead of free text. */
export const REQUEUE_REASONS = [
  // ── Provider answered, but not with an answer ──────────────────────────────
  /** 401/403 from the provider: token/session rejected. Token invalidated and
   *  the residential session rotated before the retry. */
  "auth_denied",
  /** 429: the provider's rolling window for this egress IP is spent. */
  "rate_limited",
  /** 5xx: provider-side fault. */
  "provider_server_error",
  /** Any other 4xx (400/404/422…): possibly the request contract, possibly the
   *  token shape. Rotated up to 3× before being called a contract fault. */
  "provider_bad_request",
  // ── Provider answered 200, but the body is not a verdict ───────────────────
  /** AddressNeedsFix / AddressSuggestions: the address string is not (yet) in
   *  the provider's fabric. THE ONLY reason that backs off exponentially and
   *  can eventually conclude `address_not_found`. */
  "inconclusive_address_needs_fix",
  /** Malformed, unparseable, soft success=false, or an identity mismatch
   *  between the requested door and the echoed one. Never a no-service verdict. */
  "inconclusive_response",
  // ── Never reached the provider ─────────────────────────────────────────────
  /** Transport failure: timeout, socket error, black-holed egress, "fetch
   *  failed". No response was ever seen. */
  "transient_transport",
  /** No authorized session/token could be leased (mint failed, pool empty). */
  "token_unavailable",
  /** Automation is not authorized and no manual token is ready — fail closed. */
  "not_authorized",
  /** The proxy circuit breaker was open, so the check was never attempted. */
  "breaker_open",
  /** The provider coordinator was saturated; admission was never granted. */
  "admission_timeout",
  // ── The worker, not the provider ───────────────────────────────────────────
  /** An unexpected throw in the worker or in persistence. */
  "worker_exception",
  /** Crash recovery: an 'inflight' claim whose worker died is returned to the
   *  queue on resume / re-open. */
  "crash_orphan_reclaim",
  /** An operator explicitly requeued the run's in-flight targets. */
  "operator_reset",
  // ── Closed rather than retried (tail terminalization) ──────────────────────
  /** The run already spent its full budget; the leftover tail is closed instead
   *  of re-opened forever. */
  "budget",
  /** The tail is closed because the run itself is being retired (re-open budget
   *  exhausted). The addresses stay in scan_targets for the next sweep. */
  "superseded",
  /** A requeue whose producer did not name itself. Should be zero; a non-zero
   *  count in production means a new requeue path shipped without a reason. */
  "unknown",
] as const;

export type RequeueReason = (typeof REQUEUE_REASONS)[number];

const REQUEUE_REASON_SET: ReadonlySet<string> = new Set(REQUEUE_REASONS);

export function isRequeueReason(value: unknown): value is RequeueReason {
  return typeof value === "string" && REQUEUE_REASON_SET.has(value);
}

// THE canonical needs-fix test. `scanEngine` gates the exponential backoff and
// the `address_not_found` terminal verdict on this exact pattern, and the
// scanner stamps `inconclusive_address_needs_fix` on this exact pattern, so the
// two can never disagree about which addresses take the slow lane. Widening it
// would move addresses into the terminal-verdict path — a product-rule change,
// not a diagnostics change.
export const NEEDS_FIX_NOTE = /AddressNeedsFix|AddressSuggestions/i;

/** The non-answer fields a requeue reason can be derived from. Structural so
 *  this file never has to import the server's ScanResult. */
export interface RequeueSignals {
  blocked?: boolean;
  notes?: string | null;
  /** Set by the producer. Authoritative when present. */
  retryReason?: string | null;
  /** Provider HTTP status, when the non-answer came from a response. */
  httpStatus?: number | null;
}

/**
 * The reason a non-answer must be requeued.
 *
 * Prefers the producer's own typed stamp. Falls back to the legacy note text
 * ONLY so a checker that predates `retryReason` — an injected replay checker, a
 * carrier added later — still yields something queryable rather than a hole.
 * Never returns undefined: an unnameable requeue is recorded as "unknown", which
 * is itself the signal that a requeue path shipped without a reason.
 */
export function requeueReasonFor(signals: RequeueSignals | null | undefined): RequeueReason {
  if (!signals) return "unknown";
  if (isRequeueReason(signals.retryReason)) return signals.retryReason;

  const notes = String(signals.notes ?? "");
  if (NEEDS_FIX_NOTE.test(notes)) return "inconclusive_address_needs_fix";

  const status = Number(signals.httpStatus ?? 0);
  if (status === 401 || status === 403) return "auth_denied";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_server_error";
  if (status >= 400) return "provider_bad_request";

  if (/no authorized session/i.test(notes)) return "token_unavailable";
  if (/transient|timed? ?out|fetch failed|socket|network/i.test(notes)) return "transient_transport";
  if (/non-conclusive|malformed|unparseable/i.test(notes)) return "inconclusive_response";
  // A `blocked` result with nothing else to go on is back-pressure of some kind;
  // an unblocked one is a body we could not read as a verdict.
  return signals.blocked ? "transient_transport" : "inconclusive_response";
}

/** Bound for the free-text detail carried alongside a reason. The message is
 *  already stored in full on `fiber_job_failures.message`; the event payload
 *  only needs enough to read at a glance, and fiber_job_events is the table that
 *  grew to 7.7M rows once. */
export const REQUEUE_DETAIL_MAX = 200;

export function requeueDetail(message: unknown): string | null {
  const text = String(message ?? "").trim();
  return text ? text.slice(0, REQUEUE_DETAIL_MAX) : null;
}
