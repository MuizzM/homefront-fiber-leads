import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKnockQueue, type StorageLike } from "@/lib/knockQueue";
import {
  createSavedKnockReconciliation,
  deriveFieldQueueOwnerKey,
  queryKeyMatchesApiPrefix,
  resolveCreditedRepId,
} from "@/features/knocking/savedKnockReconciliation";

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function makeReconciliation() {
  const notify = vi.fn();
  const invalidateQuery = vi.fn();
  const invalidatePrefix = vi.fn();
  const onSaved = createSavedKnockReconciliation({
    notify,
    invalidateQuery,
    invalidatePrefix,
  });
  return { notify, invalidateQuery, invalidatePrefix, onSaved };
}

let queueOwner = 40_000;

beforeEach(() => {
  vi.useFakeTimers();
  queueOwner += 1;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("canonical saved-knock reconciliation", () => {
  it("isolates queue ownership from the real rep receiving sales credit", () => {
    const manager = { id: 810, role: "manager", teamMemberId: null };
    const admin = { id: 811, role: "admin", teamMemberId: null };

    expect(deriveFieldQueueOwnerKey(manager)).toBe(-810);
    expect(deriveFieldQueueOwnerKey(admin)).toBe(-811);
    expect(resolveCreditedRepId(manager, 77)).toBe(77);
    expect(deriveFieldQueueOwnerKey({ id: 812, role: "rep" })).toBe(-812);
    expect(resolveCreditedRepId({ id: 812, role: "rep" }, 77)).toBeNull();
    expect(deriveFieldQueueOwnerKey({ id: 813, role: "calling_rep" })).toBeNull();
  });

  it("does not claim success while a sold knock remains offline", async () => {
    const saved = makeReconciliation();
    const queue = getKnockQueue({
      repId: queueOwner,
      storage: memoryStorage(),
      isOnline: () => false,
      post: async () => ({ id: 711 }),
      patch: async () => ({ id: 711 }),
      onSaved: saved.onSaved,
    });

    await queue.enqueue({ leadId: 42, outcome: "sold" });

    expect(queue.getSnapshot().byLead[42]).toBe("queued");
    expect(saved.notify).not.toHaveBeenCalled();
    expect(saved.invalidateQuery).not.toHaveBeenCalled();
    queue.destroy();
  });

  it("uses a neutral sale message only after durable confirmation", async () => {
    const saved = makeReconciliation();
    const queue = getKnockQueue({
      repId: queueOwner,
      storage: memoryStorage(),
      isOnline: () => true,
      post: async () => ({ id: 711 }),
      patch: async () => ({ id: 711 }),
      onSaved: saved.onSaved,
    });

    await queue.enqueue({ leadId: 42, outcome: "sold" });

    // Silent on the ordinary save: the optimistic pin recolour IS the
    // feedback, and a toast per door is noise on a good run.
    expect(saved.notify).not.toHaveBeenCalled();
    expect(JSON.stringify(saved.notify.mock.calls)).not.toMatch(/commission/i);
    expect(saved.invalidateQuery).toHaveBeenCalledWith(["/api/leads/map"]);
    queue.destroy();
  });

  it("never reports a stale sold knock as a saved sale", () => {
    const saved = makeReconciliation();

    saved.onSaved(42, "sold", true);

    expect(saved.notify).toHaveBeenCalledWith({
      title: "A newer outcome already stands",
      description:
        "This knock was recorded as history; the door keeps its latest status.",
    });
    expect(JSON.stringify(saved.notify.mock.calls)).not.toMatch(/sale saved/i);
    expect(saved.invalidateQuery).toHaveBeenCalledWith(["/api/leads/map"]);
  });

  it("invalidates singular, legacy plural, and payout money query families", () => {
    const saved = makeReconciliation();

    saved.onSaved(42, "not_interested");

    expect(saved.notify).not.toHaveBeenCalled();
    expect(saved.invalidatePrefix.mock.calls).toEqual([
      ["/api/commission"],
      ["/api/commissions"],
      ["/api/payouts"],
    ]);
    expect(queryKeyMatchesApiPrefix(
      ["/api/commission/week-overview", "2026-W31"],
      "/api/commission",
    )).toBe(true);
    expect(queryKeyMatchesApiPrefix(
      ["/api/commissions/summary"],
      "/api/commissions",
    )).toBe(true);
    expect(queryKeyMatchesApiPrefix(
      ["/api/payouts/week", "2026-W31"],
      "/api/payouts",
    )).toBe(true);
  });
});
