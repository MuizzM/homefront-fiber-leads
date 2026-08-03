// "The pin changed back" — pinned.
//
// The optimistic recolor used to be a one-shot patch into the react-query cache,
// so any server read landing before the queued knock flushed replaced it and the
// pin visibly reverted. These tests pin the property that fixes it: the overlay
// is a DERIVATION of durable queue state, so a refetch cannot lose it.
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  applyPendingOutcome, installPendingKnockOverlay, mergePendingOutcomes,
} from "../../client/src/lib/pendingKnockOverlay";

const serverPins = () => ({
  pins: [
    { id: 1, leadStatus: "new", visited: false, knockCount: 0, lastOutcome: null, lastOutcomeAt: null },
    { id: 2, leadStatus: "new", visited: false, knockCount: 0, lastOutcome: null, lastOutcomeAt: null },
  ],
});

describe("merging an unsent knock over server data", () => {
  it("re-applies the rep's tap that the server has not seen yet", () => {
    const merged = mergePendingOutcomes(serverPins(), {
      1: { outcome: "not_home", at: "2026-08-03T12:00:00.000Z" },
    })!;
    const pin = merged.pins.find(p => p.id === 1)!;
    expect(pin.lastOutcome).toBe("not_home");
    expect(pin.visited).toBe(true);
    expect(pin.leadStatus).toBe("prospect"); // OUTCOME_TO_STATUS, shared with the server
    // Untouched doors stay exactly as the server sent them.
    expect(merged.pins.find(p => p.id === 2)!.lastOutcome).toBeNull();
  });

  it("returns the SAME object when there is nothing pending", () => {
    const data = serverPins();
    // Reference equality — the caller skips a pointless cache write and render.
    expect(mergePendingOutcomes(data, {})).toBe(data);
  });

  it("returns the same object when the server already agrees", () => {
    const data = {
      pins: [{ id: 1, leadStatus: "prospect", visited: true, knockCount: 1, lastOutcome: "not_home", lastOutcomeAt: "2026-08-03T12:00:00.000Z" }],
    };
    expect(mergePendingOutcomes(data, { 1: { outcome: "not_home", at: "2026-08-03T12:00:00.000Z" } })).toBe(data);
  });

  it("does NOT resurrect a tap the server has already superseded", () => {
    // A teammate closed the door, or a manager corrected it, AFTER this rep's
    // queued tap. Re-applying the older outcome would undo a settled decision —
    // the same recency rule the server's own outcome CAS enforces.
    const data = {
      pins: [{ id: 1, leadStatus: "sold", visited: true, knockCount: 2, lastOutcome: "sold", lastOutcomeAt: "2026-08-03T13:00:00.000Z" }],
    };
    const merged = mergePendingOutcomes(data, { 1: { outcome: "not_home", at: "2026-08-03T12:00:00.000Z" } })!;
    expect(merged.pins[0].lastOutcome).toBe("sold");
    expect(merged).toBe(data);
  });

  it("never inflates the knock count, however many times it re-runs", () => {
    // The overlay re-applies on EVERY read. An increment here would climb with
    // the poll interval and a door tapped once would claim eleven knocks.
    let data: any = serverPins();
    const pending = { 1: { outcome: "not_home", at: "2026-08-03T12:00:00.000Z" } };
    for (let i = 0; i < 10; i += 1) data = mergePendingOutcomes(data, pending);
    expect(data.pins.find((p: any) => p.id === 1).knockCount).toBe(0);
  });

  it("survives a payload with no pins", () => {
    expect(mergePendingOutcomes(undefined, { 1: { outcome: "sold", at: "x" } })).toBeUndefined();
    const empty = { pins: [] };
    expect(mergePendingOutcomes(empty, { 1: { outcome: "sold", at: "x" } })).toBe(empty);
  });

  it("applyPendingOutcome keeps an unknown outcome from blanking the status", () => {
    const pin = { id: 1, leadStatus: "interested", visited: true } as any;
    expect(applyPendingOutcome(pin, { outcome: "not_a_real_outcome", at: "" }).leadStatus).toBe("interested");
  });
});

describe("a refetch can no longer revert the pin", () => {
  it("re-applies the overlay when a server read lands mid-queue", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    // The rep tapped door 1; the knock is still in the queue (GPS, or offline).
    let pending: any = { 1: { outcome: "not_home", at: "2026-08-03T12:00:00.000Z" } };
    const stop = installPendingKnockOverlay(qc, () => pending);

    // A poll / map-changed refetch lands with data that predates the tap.
    qc.setQueryData(["/api/leads/map"], serverPins());
    // ^ setQueryData emits a non-"success" action, so simulate the fetch result
    //   the subscriber actually reacts to:
    const query = qc.getQueryCache().find({ queryKey: ["/api/leads/map"] })!;
    query.setData(serverPins() as any, { manual: false } as any);

    const after = qc.getQueryData(["/api/leads/map"]) as any;
    const pin = after.pins.find((p: any) => p.id === 1);
    expect(pin.lastOutcome, "the pin reverted — this is the reported bug").toBe("not_home");
    expect(pin.visited).toBe(true);

    // Once the knock reaches the server the overlay stops applying, and the very
    // next read is plain server truth. Nothing to expire or clean up.
    pending = {};
    query.setData(serverPins() as any, { manual: false } as any);
    expect((qc.getQueryData(["/api/leads/map"]) as any).pins.find((p: any) => p.id === 1).lastOutcome).toBeNull();

    stop();
  });

  it("stops re-applying once the subscriber is torn down", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const stop = installPendingKnockOverlay(qc, () => ({ 1: { outcome: "not_home", at: "2026-08-03T12:00:00.000Z" } }));
    stop();
    qc.setQueryData(["/api/leads/map"], serverPins());
    const query = qc.getQueryCache().find({ queryKey: ["/api/leads/map"] })!;
    query.setData(serverPins() as any, { manual: false } as any);
    expect((qc.getQueryData(["/api/leads/map"]) as any).pins[0].lastOutcome).toBeNull();
  });

  it("ignores other query keys", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const stop = installPendingKnockOverlay(qc, () => ({ 1: { outcome: "sold", at: "2026-08-03T12:00:00.000Z" } }));
    qc.setQueryData(["/api/leaderboard"], serverPins());
    const query = qc.getQueryCache().find({ queryKey: ["/api/leaderboard"] })!;
    query.setData(serverPins() as any, { manual: false } as any);
    expect((qc.getQueryData(["/api/leaderboard"]) as any).pins[0].lastOutcome).toBeNull();
    stop();
  });
});
