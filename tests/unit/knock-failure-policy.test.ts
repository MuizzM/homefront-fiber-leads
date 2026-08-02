// ── Dead-letter policy: terminal-vs-retryable classification, rehydration
// triage/migration, and the honest-explanation presentation strings. These
// tests ARE the spec for client/src/features/knocking/knockFailurePolicy.ts —
// the queue (knockQueue.ts) delegates every failure-routing decision here.
import { describe, expect, it } from "vitest";
import {
  classifyKnockFailure,
  droppedKnockToast,
  forbiddenKnockReason,
  isAutoRetryableDeadKnock,
  isKnockableLeadId,
  isLikelyRestartBurst403,
  knockFailureStatus,
  migrateQueuedKnock,
  needsAttentionText,
  RESTART_BURST_WINDOW_MS,
  scopeDeniedKnockReason,
  summarizeDeadKnock,
  terminalKnockReason,
  triageRehydratedKnock,
} from "@/features/knocking/knockFailurePolicy";
import type { QueuedKnock } from "@shared/knock";

const item = (over: Partial<QueuedKnock> = {}): QueuedKnock => ({
  clientId: "c1",
  leadId: 7,
  repId: 9,
  outcome: "interested",
  knockedAt: "2026-07-30T12:00:00.000Z",
  notes: null,
  callbackDate: null,
  callbackTime: null,
  attempts: 0,
  nextAttemptAt: 0,
  lastError: null,
  ...over,
});

describe("classifyKnockFailure — terminal vs retryable", () => {
  it("treats network/timeout errors (no HTTP status) as retryable", () => {
    expect(classifyKnockFailure("Failed to fetch")).toBe("retryable");
    expect(classifyKnockFailure("TypeError: NetworkError when attempting to fetch")).toBe("retryable");
    expect(classifyKnockFailure(null)).toBe("retryable");
    expect(classifyKnockFailure("")).toBe("retryable");
  });

  it("treats every 5xx and throttle/timeout status as retryable — a flap must never be terminal", () => {
    for (const e of ["500: boom", "502: bad gateway", "503: unavailable", "504: timeout", "429: slow down", "408: request timeout"]) {
      expect(classifyKnockFailure(e)).toBe("retryable");
    }
  });

  it("routes 401 to auth (valid knock waiting on re-login)", () => {
    expect(classifyKnockFailure("401: session expired")).toBe("auth");
  });

  it("routes 403 to forbidden (bounded retries — a CSRF 403 heals after re-auth)", () => {
    expect(classifyKnockFailure("403: CSRF validation failed")).toBe("forbidden");
  });

  it("routes the remaining 4xx to terminal — the server will never accept them", () => {
    for (const e of ["400: invalid outcome", "404: Not found", "409: conflict", "410: gone", "413: too large", "422: unprocessable"]) {
      expect(classifyKnockFailure(e)).toBe("terminal");
    }
  });

  it("parses the status only from the queue's own '<status>: <text>' shape", () => {
    expect(knockFailureStatus("404: Not found")).toBe(404);
    expect(knockFailureStatus("Failed to fetch")).toBeNull();
    expect(knockFailureStatus("99: not an http status")).toBeNull();
  });
});

describe("isLikelyRestartBurst403 — a 403 during a restart burst is a proxy artifact", () => {
  it("treats a 403 within the burst window of a transient failure as transient", () => {
    expect(isLikelyRestartBurst403("forbidden", 1_000, 1_000)).toBe(true);
    expect(isLikelyRestartBurst403("forbidden", 1_000, 1_000 + RESTART_BURST_WINDOW_MS)).toBe(true);
  });

  it("a clean-air 403 (no transient failure seen, or window expired) is NOT a burst", () => {
    expect(isLikelyRestartBurst403("forbidden", 0, 5_000)).toBe(false); // never saw one
    expect(isLikelyRestartBurst403("forbidden", 1_000, 1_001 + RESTART_BURST_WINDOW_MS)).toBe(false);
  });

  it("applies only to the forbidden (403) class and tolerates clock weirdness", () => {
    expect(isLikelyRestartBurst403("retryable", 1_000, 2_000)).toBe(false);
    expect(isLikelyRestartBurst403("terminal", 1_000, 2_000)).toBe(false);
    expect(isLikelyRestartBurst403("auth", 1_000, 2_000)).toBe(false);
    expect(isLikelyRestartBurst403("forbidden", 5_000, 1_000)).toBe(false); // clock went backwards
  });
});

describe("isAutoRetryableDeadKnock — what a recovery signal may silently retry", () => {
  it("allows the 403 class and transient leftovers — the same set that gets a Retry button", () => {
    expect(isAutoRetryableDeadKnock(item({ lastError: "403: forbidden" }))).toBe(true);
    expect(isAutoRetryableDeadKnock(item({ lastError: "503: unavailable" }))).toBe(true);
    expect(isAutoRetryableDeadKnock(item({ lastError: "Failed to fetch" }))).toBe(true);
  });

  it("NEVER allows a terminal leftover — auto-retrying it would be the same lie as its Retry", () => {
    expect(isAutoRetryableDeadKnock(item({ lastError: "404: Not found" }))).toBe(false);
    expect(isAutoRetryableDeadKnock(item({ lastError: "400: invalid outcome" }))).toBe(false);
    expect(isAutoRetryableDeadKnock(item({ lastError: "422: unprocessable" }))).toBe(false);
  });
});

describe("isKnockableLeadId — temp optimistic pins can never take a knock", () => {
  it("accepts only positive safe integers", () => {
    expect(isKnockableLeadId(42)).toBe(true);
    expect(isKnockableLeadId(-1)).toBe(false); // one-tap add temp pin
    expect(isKnockableLeadId(0)).toBe(false);
    expect(isKnockableLeadId(1.5)).toBe(false);
    expect(isKnockableLeadId(NaN)).toBe(false);
    expect(isKnockableLeadId("7")).toBe(false);
    expect(isKnockableLeadId(null)).toBe(false);
  });
});

describe("terminal reasons — the honest explanation the rep sees", () => {
  it("names the temp-pin cause before anything else", () => {
    expect(terminalKnockReason(item({ leadId: -2, lastError: "404: Not found" })))
      .toContain("never finished saving");
  });

  it("explains a 404 as the lead being gone or out of area — with the assignment path, never a retry hint", () => {
    const reason = terminalKnockReason(item({ lastError: "404: Not found" }));
    expect(reason).toContain("no longer exists");
    expect(reason).toContain("isn't in your assigned area");
    expect(reason).toContain("your manager can assign it");
    expect(reason).not.toContain("sign out");
    expect(reason).not.toContain("retry");
  });

  it("explains 400/422 as a server rejection", () => {
    expect(terminalKnockReason(item({ lastError: "400: invalid outcome" }))).toContain("rejected it as invalid");
    expect(terminalKnockReason(item({ lastError: "422: nope" }))).toContain("rejected it as invalid");
  });

  it("explains an outcome the server no longer recognizes", () => {
    expect(terminalKnockReason(item({ outcome: "door_slam" as never, lastError: "400: invalid outcome" })))
      .toContain("older app version");
  });
});

describe("forbiddenKnockReason — the message splits on the ACTUAL status", () => {
  it("a real 401 keeps the re-auth guidance (the session really expired)", () => {
    expect(forbiddenKnockReason("401: session expired"))
      .toBe("not authorized right now — sign out and back in, then retry");
  });

  it("a 403 is NOT a re-auth wild goose — it points at assignment", () => {
    const reason = forbiddenKnockReason("403: Forbidden");
    expect(reason).toBe(scopeDeniedKnockReason());
    expect(reason).toContain("isn't in your assigned area");
    expect(reason).toContain("your manager can assign it");
    expect(reason).not.toContain("sign out");
  });

  it("a missing/unparseable status defaults to the scope copy, never re-auth", () => {
    expect(forbiddenKnockReason(null)).toBe(scopeDeniedKnockReason());
    expect(forbiddenKnockReason(undefined)).toBe(scopeDeniedKnockReason());
    expect(forbiddenKnockReason("Failed to fetch")).toBe(scopeDeniedKnockReason());
  });
});

describe("summarizeDeadKnock — what the FieldStatusBar renders", () => {
  it("a 403 item stays retryable (heals on assignment/server fix) WITHOUT the re-auth hint", () => {
    const s = summarizeDeadKnock(item({ lastError: "403: forbidden" }));
    expect(s).toMatchObject({ clientId: "c1", leadId: 7, retryable: true });
    expect(s.reason).toBe(scopeDeniedKnockReason());
    expect(s.reason).not.toContain("sign out");
  });

  it("a real 401 leftover is retryable WITH the re-auth guidance", () => {
    const s = summarizeDeadKnock(item({ lastError: "401: session expired" }));
    expect(s.retryable).toBe(true);
    expect(s.reason).toBe("not authorized right now — sign out and back in, then retry");
  });

  it("a transient leftover is retryable with a retry-now reason", () => {
    const s = summarizeDeadKnock(item({ lastError: "503: unavailable" }));
    expect(s.retryable).toBe(true);
    expect(s.reason).toContain("retry");
  });

  it("a terminal leftover is NOT retryable — Retry would be a lie", () => {
    const s = summarizeDeadKnock(item({ lastError: "404: Not found" }));
    expect(s.retryable).toBe(false);
    expect(s.reason).toContain("no longer exists");
    expect(s.reason).toContain("isn't in your assigned area");
  });
});

describe("triageRehydratedKnock — reload survival and self-healing", () => {
  it("keeps a valid pending item pending", () => {
    const t = triageRehydratedKnock(item(), "pending");
    expect(t).toMatchObject({ action: "pending" });
  });

  it("drops a pending item against a temp (negative) lead id, with the pin reason", () => {
    const t = triageRehydratedKnock(item({ leadId: -3 }), "pending");
    expect(t?.action).toBe("drop");
    expect((t as { reason: string }).reason).toContain("never finished saving");
  });

  it("drops a dead item whose last failure was terminal (the owner's stuck nag)", () => {
    const t = triageRehydratedKnock(item({ lastError: "404: Not found", attempts: 3 }), "dead");
    expect(t?.action).toBe("drop");
    expect((t as { reason: string }).reason).toContain("no longer exists");
  });

  it("keeps a 403 dead item parked for a human retry", () => {
    expect(triageRehydratedKnock(item({ lastError: "403: forbidden" }), "dead")?.action).toBe("dead");
  });

  it("returns an old transient dead-letter to pending with a fresh attempt budget", () => {
    const t = triageRehydratedKnock(item({ lastError: "503: unavailable", attempts: 8, nextAttemptAt: 999 }), "dead");
    expect(t?.action).toBe("pending");
    expect((t as { item: QueuedKnock }).item).toMatchObject({ attempts: 0, nextAttemptAt: 0 });
  });

  it("ignores unreadable garbage entirely", () => {
    expect(triageRehydratedKnock(null, "pending")).toBeNull();
    expect(triageRehydratedKnock("junk", "dead")).toBeNull();
    expect(triageRehydratedKnock({ leadId: 7 }, "pending")).toBeNull(); // no clientId
  });
});

describe("migrateQueuedKnock — stale-shaped payloads are repaired, not lost", () => {
  it("fills fields an older app version never wrote", () => {
    const m = migrateQueuedKnock({
      clientId: "old", leadId: 7, repId: 9, outcome: "callback",
      knockedAt: "2026-07-30T12:00:00.000Z", notes: "n",
      callbackDate: "2026-08-02", callbackTime: "18:00",
      attempts: 2, nextAttemptAt: 5, lastError: "500: x",
    });
    expect(m).toMatchObject({
      clientId: "old", leadId: 7, outcome: "callback", attempts: 2,
      repLat: null, repLng: null, gpsAccuracy: null, deviceTs: null,
      mockLocation: null, netState: null, appVersion: null,
    });
  });

  it("normalizes corrupt scalar fields instead of crashing the queue", () => {
    const m = migrateQueuedKnock({ clientId: "c", leadId: "7", outcome: 5, attempts: "x", nextAttemptAt: -2, notes: 9 });
    expect(m).toMatchObject({ leadId: 0, attempts: 0, nextAttemptAt: 0, notes: null });
  });
});

describe("presentation strings", () => {
  it("droppedKnockToast names the door and the reason", () => {
    const t = droppedKnockToast("42 Oak St", "the lead no longer exists or is no longer yours");
    expect(t.title).toBe("42 Oak St couldn't save");
    expect(t.description).toContain("The lead no longer exists");
    expect(t.description).toContain("removed from the sync queue");
  });

  it("droppedKnockToast falls back honestly when the address is unknown", () => {
    expect(droppedKnockToast(null, "reason").title).toBe("A field update couldn't save");
    expect(droppedKnockToast("   ", "reason").title).toBe("A field update couldn't save");
  });

  it("needsAttentionText: one item shows the door + reason", () => {
    expect(needsAttentionText(1, "42 Oak St", "not authorized right now — sign out and back in, then retry"))
      .toBe("42 Oak St needs attention — not authorized right now — sign out and back in, then retry");
    expect(needsAttentionText(1, null, "r")).toBe("1 field update needs attention — r");
  });

  it("needsAttentionText: several items show count + first reason", () => {
    expect(needsAttentionText(3, "42 Oak St", "r")).toBe("3 field updates need attention — r");
    expect(needsAttentionText(2, null, null)).toBe("2 field updates need attention");
  });
});
