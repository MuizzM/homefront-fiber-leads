import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateWork, currentWorkLease, hasWorkQuarantine, isCurrentWorkLease, purgeWork, quarantineWork,
  retireWorkLocally, workOwnerKey, workRequest, type WorkOwner } from "../../client/src/lib/workAuthority";
import { createKnockQueue } from "../../client/src/lib/knockQueue";
import { createTrainingReviewQueue } from "../../client/src/lib/trainingReviewQueue";
import { flushPendingNotes, pendingNoteCount, saveLeadNote, stashNote } from "../../client/src/lib/leadNotes";
import { appendFieldFix, flushFieldFixes, queuedFieldFixes } from "../../client/src/lib/fieldFixQueue";
const owner: WorkOwner = { userId: 10, tenantId: 2, teamMemberId: 30 };
const other: WorkOwner = { userId: 11, tenantId: 3, teamMemberId: 31 };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const ok = { ok: true, status: 200, json: async () => ({}) };
beforeEach(() => { purgeWork(); localStorage.clear(); activateWork(owner, "first-session"); });
afterEach(() => { purgeWork(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("owner-bound field work", () => {
  it.each(["success", "failure"])("quarantines an in-flight knock without late effects (%s)", async result => {
    const first = deferred<any>(); const post = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue({ id: 12 });
    const saved = vi.fn(); const q = createKnockQueue({ repId: 30, owner, post, patch: vi.fn(), onSaved: saved });
    q.stage({ leadId: 1, outcome: "not_home" }); q.stage({ leadId: 2, outcome: "not_home" });
    const flushing = q.flush(); expect(post).toHaveBeenCalledTimes(1);
    const before = localStorage.getItem(`hf.knockQueue.v2.${workOwnerKey(owner)}`);
    quarantineWork(owner, "MFA_REQUIRED");
    expect(q.canCapture()).toBe(false);
    expect(q.enrich("any", { repLat: 1 })).toBe(false);
    expect(() => q.stage({ leadId: 3, outcome: "not_home" })).toThrow(/Sign in/);
    window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); q.notifyRecovery(); q.retryDead();
    if (result === "success") first.resolve({ id: 11 }); else first.reject(new Error("503: unavailable"));
    await flushing; await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1); expect(saved).not.toHaveBeenCalled();
    expect(localStorage.getItem(`hf.knockQueue.v2.${workOwnerKey(owner)}`)).toBe(before);
    const newLease = activateWork(owner, "second-session"); await q.flush(); await Promise.resolve(); await q.flush();
    expect(post).toHaveBeenCalledTimes(3); expect(saved).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].clientId).toBe(post.mock.calls[0][1].clientId);
    expect(post.mock.calls[1][2]).toBe(newLease);
    q.destroy();
  });

  it("purges old queue memory and blocks a late response after switching tenant", async () => {
    const request = deferred<any>(); const post = vi.fn(() => request.promise); const onSaved = vi.fn();
    const q = createKnockQueue({ repId: 30, owner, post, patch: vi.fn(), onSaved });
    q.stage({ leadId: 1, outcome: "not_home" }); q.stage({ leadId: 2, outcome: "not_home" });
    const run = q.flush(); activateWork({ ...owner, tenantId: 99 }, "other-tenant"); request.resolve({ id: 10 }); await run;
    expect(post).toHaveBeenCalledTimes(1); expect(onSaved).not.toHaveBeenCalled();
    expect(localStorage.getItem(`hf.knockQueue.v2.${workOwnerKey(owner)}`)).toBeNull();
    expect(q.canCapture()).toBe(false);
  });

  it("invalidates the old finally block before a resumed flush", async () => {
    const old = deferred<any>(), next = deferred<any>();
    const post = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise).mockResolvedValue({ id: 1 });
    const q = createKnockQueue({ repId: 30, owner, post, patch: vi.fn() }); q.stage({ leadId: 1, outcome: "not_home" });
    const firstRun = q.flush(); quarantineWork(owner, "SESSION_EXPIRED"); activateWork(owner, "second");
    await Promise.resolve(); expect(post).toHaveBeenCalledTimes(2);
    old.resolve({ id: 1 }); await firstRun; await q.flush(); expect(post).toHaveBeenCalledTimes(2);
    next.resolve({ id: 1 }); await Promise.resolve(); await Promise.resolve(); expect(q.getSnapshot().pendingCount).toBe(0); q.destroy();
  });

  it.each(["success", "failure"])("suspends training batch callbacks and retry accounting (%s)", async result => {
    const request = deferred<any>(); const post = vi.fn().mockImplementationOnce(() => request.promise).mockResolvedValue({}); const synced = vi.fn();
    const q = createTrainingReviewQueue({ owner, ownerKey: 30, post, onSynced: synced });
    q.enqueue({ cardId: "first", grade: "good", reviewedAt: "2026-09-08T12:00:00Z" });
    const run = q.flush(); q.enqueue({ cardId: "second", grade: "good", reviewedAt: "2026-09-08T12:01:00Z" });
    const before = localStorage.getItem(`hf.trainingReviews.v2.${workOwnerKey(owner)}`);
    quarantineWork(owner, "SESSION_EXPIRED"); window.dispatchEvent(new Event("online"));
    if (result === "success") request.resolve({}); else request.reject(new Error("500: unavailable"));
    await run; await Promise.resolve(); expect(post).toHaveBeenCalledTimes(1); expect(synced).not.toHaveBeenCalled();
    expect(localStorage.getItem(`hf.trainingReviews.v2.${workOwnerKey(owner)}`)).toBe(before);
    activateWork(owner, "next"); await Promise.resolve(); await q.flush(); expect(q.pending()).toHaveLength(0); q.destroy();
  });

  it("retains memory-only queues through same-owner reauth, then destroys on switch", async () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
    const post = vi.fn().mockResolvedValue({ id: 1 }); let online = false;
    const q = createKnockQueue({ repId: 30, owner, storage: broken, isOnline: () => online, post, patch: vi.fn() });
    q.stage({ leadId: 1, outcome: "not_home" }); quarantineWork(owner, "MFA_REQUIRED");
    activateWork(owner, "next"); expect(q.getSnapshot().pendingCount).toBe(1); online = true; await q.flush();
    expect(post).toHaveBeenCalledTimes(1); q.stage({ leadId: 2, outcome: "not_home" });
    activateWork(other, "other"); await q.flush(); expect(post).toHaveBeenCalledTimes(1);
  });

  it("stops delivery as soon as another tab changes the persisted owner stamp", async () => {
    const lease = currentWorkLease()!;
    localStorage.setItem("hfs.work.owner.v1", JSON.stringify({ owner: other, sessionId: "other-session" }));
    expect(isCurrentWorkLease(lease)).toBe(false);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(workRequest(lease, "POST", "/api/leads/1/knock", {})).rejects.toThrow(/suspended/);
    expect(fetchMock).not.toHaveBeenCalled();
    localStorage.setItem(`hf.knockQueue.v2.${workOwnerKey(other)}`, "new owner's pending work");
    retireWorkLocally();
    expect(localStorage.getItem(`hf.knockQueue.v2.${workOwnerKey(other)}`)).toBe("new owner's pending work");
  });

  it("never adopts untagged legacy work from a different tenant", () => {
    localStorage.setItem("hfs.sid", "legacy"); localStorage.setItem("hfs.user", JSON.stringify({ id: 10, tenantId: 99, teamMemberId: 30 }));
    localStorage.setItem("hf.knockQueue.v1.30", JSON.stringify({ v: 1, items: [{ leadId: 1, outcome: "not_home" }] }));
    activateWork(owner, "new");
    const q = createKnockQueue({ repId: 30, owner, post: vi.fn(), patch: vi.fn(), isOnline: () => false });
    expect(q.getSnapshot().pendingCount).toBe(0); q.destroy();
  });
});

describe("notes and location persistence", () => {
  it("retains a staged note through quarantine but never recreates it after purge", async () => {
    const request = deferred<any>(); const run = saveLeadNote(() => request.promise, 1, "field note", null);
    quarantineWork(owner, "MFA_REQUIRED"); request.reject(new Error("offline")); await run;
    activateWork(owner, "next"); expect(pendingNoteCount()).toBe(1);
    const next = deferred<any>(); const oldSave = saveLeadNote(() => next.promise, 2, "another", null);
    purgeWork(); activateWork(other, "other"); next.reject(new Error("offline")); await oldSave;
    expect(pendingNoteCount()).toBe(0);
  });

  it("a slow acknowledged note cannot delete a newer edit", async () => {
    const request = deferred<any>(); stashNote(1, "first", null);
    const run = flushPendingNotes(() => request.promise); stashNote(1, "newer", null); request.resolve(ok); await run;
    expect(pendingNoteCount()).toBe(1);
    const post = vi.fn().mockResolvedValue(ok); await flushPendingNotes(post);
    expect(post).toHaveBeenCalledWith(1, { notes: "newer", baseUpdatedAt: null });
  });

  it("does not send the next note after a session switch", async () => {
    const request = deferred<any>(); const post = vi.fn(() => request.promise);
    stashNote(1, "a", null); stashNote(2, "b", null); const run = flushPendingNotes(post);
    activateWork(other, "other"); request.resolve(ok); await run; expect(post).toHaveBeenCalledTimes(1);
  });

  it("keeps the entire unsent GPS tail after a failed first delivery", async () => {
    const lease = currentWorkLease()!;
    for (let i = 0; i < 3; i++) appendFieldFix(lease, { lat: 30 + i, lng: -70, accuracyM: 10, capturedAt: new Date(1000 * i).toISOString() });
    const failed = vi.fn().mockRejectedValue(new Error("offline")); await flushFieldFixes(lease, failed);
    expect(failed).toHaveBeenCalledTimes(1); expect(queuedFieldFixes(lease)).toBe(3);
    const success = vi.fn().mockResolvedValue({}); await flushFieldFixes(lease, success);
    expect(success).toHaveBeenCalledTimes(3); expect(queuedFieldFixes(lease)).toBe(0);
  });

  it("keeps uncertain GPS delivery through quarantine without draining under a new owner", async () => {
    const lease = currentWorkLease()!; const request = deferred<any>(); const deliver = vi.fn(() => request.promise);
    for (let i = 0; i < 2; i++) appendFieldFix(lease, { lat: 30, lng: -70, accuracyM: 10, capturedAt: new Date(i).toISOString() });
    const run = flushFieldFixes(lease, deliver); quarantineWork(owner, "SESSION_EXPIRED"); request.resolve({}); await run;
    expect(deliver).toHaveBeenCalledTimes(1); const next = activateWork(owner, "next"); expect(queuedFieldFixes(next)).toBe(2);
    activateWork(other, "other"); expect(queuedFieldFixes(currentWorkLease())).toBe(0);
  });
});

describe("work boundary regression cases", () => {
  it.each([200, 503])("bounds a response that stalls after its headers (%s)", async status => {
    vi.useFakeTimers(); const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status })));
    const request = workRequest(currentWorkLease(), "POST", "/api/leads/1/knock", {});
    const result = expect(request).rejects.toThrow(/too long/);
    await vi.advanceTimersByTimeAsync(30_001); await result; expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("aborts body consumption after headers when work is quarantined", async () => {
    const cancel = vi.fn(); const fetched = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => fetched.promise));
    const request = workRequest(currentWorkLease(), "POST", "/api/leads/1/knock", {});
    const result = expect(request).rejects.toBeDefined();
    fetched.resolve(new Response(new ReadableStream({ cancel }), { status: 200 }));
    await Promise.resolve(); await Promise.resolve(); quarantineWork(owner, "MFA_REQUIRED");
    await result; expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects a removed owner stamp before the peer logout event arrives", async () => {
    const lease = currentWorkLease(); localStorage.removeItem("hfs.work.owner.v1");
    expect(isCurrentWorkLease(lease)).toBe(false);
    const post = vi.fn(); vi.stubGlobal("fetch", post);
    await expect(workRequest(lease, "POST", "/api/leads/1/knock", {})).rejects.toThrow(/suspended/);
    expect(post).not.toHaveBeenCalled();
  });

  it("preserves a durable legacy note when replacement storage is full", () => {
    localStorage.setItem("hfs.sid", "legacy-session");
    localStorage.setItem("hfs.user", JSON.stringify({ id: owner.userId, tenantId: owner.tenantId, teamMemberId: owner.teamMemberId }));
    localStorage.setItem("hf.pendingNotes.v1", JSON.stringify({ 1: { notes: "durable old note", baseUpdatedAt: null, at: 1 } }));
    activateWork(owner, "next-session");
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key.startsWith("hf.pendingNotes.v2.")) throw new DOMException("full", "QuotaExceededError");
      return original.call(this, key, value);
    });
    expect(pendingNoteCount()).toBe(1); expect(localStorage.getItem("hf.pendingNotes.v1")).toContain("durable old note");
  });

  it("keeps rate-limited GPS fixes with bounded retry and continues after an out-of-order replay", async () => {
    vi.useFakeTimers(); const lease = currentWorkLease()!;
    for (let i = 0; i < 3; i++) appendFieldFix(lease, { lat: 30, lng: -70, accuracyM: 10, capturedAt: new Date(i).toISOString() });
    const deliver = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ retryAfterMs: 30_000 }).mockResolvedValue({});
    // The first response acknowledges an out-of-order duplicate; the next is throttled.
    expect(await flushFieldFixes(lease, deliver)).toEqual({ retryAfterMs: 30_000 });
    expect(queuedFieldFixes(lease)).toBe(2); expect(deliver).toHaveBeenCalledTimes(2);
    await flushFieldFixes(lease, deliver); expect(deliver).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_001); await flushFieldFixes(lease, deliver);
    expect(queuedFieldFixes(lease)).toBe(0); expect(deliver).toHaveBeenCalledTimes(4);
  });
});

it.each([{}, null, [null, { lat: 900, lng: 0, accuracyM: null, capturedAt: "invalid" }]])("ignores malformed owner-bound GPS payloads (%j)", async value => {
  const lease = currentWorkLease()!;
  localStorage.setItem(`hfs.fieldTracking.v2.${workOwnerKey(owner)}`, JSON.stringify({ v: 2, owner, value }));
  const deliver = vi.fn(); await flushFieldFixes(lease, deliver);
  expect(queuedFieldFixes(lease)).toBe(0); expect(deliver).not.toHaveBeenCalled();
});
it("bounds an oversized persisted GPS backlog before replay", async () => {
  const lease = currentWorkLease()!;
  localStorage.setItem(`hfs.fieldTracking.v2.${workOwnerKey(owner)}`, JSON.stringify({ v: 2, owner,
    value: Array.from({ length: 250 }, (_, i) => ({ lat: 30, lng: -70, accuracyM: 10, capturedAt: new Date(i).toISOString() })) }));
  expect(queuedFieldFixes(lease)).toBe(200);
  const deliver = vi.fn().mockResolvedValue({}); await flushFieldFixes(lease, deliver);
  expect(deliver).toHaveBeenCalledTimes(200); expect(deliver.mock.calls[0][0].capturedAt).toBe(new Date(50).toISOString());
});

it("fails closed if storage becomes unreadable after a quota fallback", () => {
  const original = Storage.prototype.setItem;
  const failing = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
    if (key === "hfs.work.owner.v1") throw new DOMException("full", "QuotaExceededError");
    return original.call(this, key, value);
  });
  localStorage.setItem("hfs.sid", "renewed"); const lease = activateWork(owner, "renewed");
  expect(isCurrentWorkLease(lease)).toBe(true); failing.mockRestore();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  expect(isCurrentWorkLease(lease)).toBe(false);
});
