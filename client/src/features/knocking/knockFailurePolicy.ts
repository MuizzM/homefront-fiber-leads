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
//               (retry works), a real authorization rejection never will. It
//               gets bounded retries, then parks in the dead lane where the
//               rep sees the door + reason WITH a Retry that plausibly works.
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
      return "the lead no longer exists or is no longer yours";
    case 400:
    case 422:
      return "the server rejected it as invalid";
    default:
      return "the server can never accept it";
  }
}

export function forbiddenKnockReason(): string {
  return "not authorized right now — sign out and back in, then retry";
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
    reason:
      kind === "forbidden"
        ? forbiddenKnockReason()
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
