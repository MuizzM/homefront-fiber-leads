// Unit tests for the drill-card review outbox (client/src/lib/trainingReviewQueue.ts).
// Mirrors the knockQueue test approach: injected storage/post/clock, no DOM.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createTrainingReviewQueue,
  type StorageLike,
  type TrainingReviewQueue,
} from "@/lib/trainingReviewQueue";

function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function throwingStorage(): StorageLike {
  return {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
}

let queues: TrainingReviewQueue[] = [];
function make(opts: Partial<Parameters<typeof createTrainingReviewQueue>[0]> = {}) {
  const q = createTrainingReviewQueue({
    ownerKey: 42,
    post: vi.fn().mockResolvedValue({ ok: true, updated: 1 }),
    isOnline: () => true,
    ...opts,
  });
  queues.push(q);
  return q;
}

beforeEach(() => {
  queues = [];
});
afterEach(() => {
  for (const q of queues) q.destroy();
});

describe("trainingReviewQueue", () => {
  it("persists enqueued reviews and flushes them as ONE batch", async () => {
    const storage = memStorage();
    const post = vi.fn().mockResolvedValue({ ok: true, updated: 2 });
    const q = make({ storage, post });

    q.enqueue({ cardId: "card:m1-a:takeaway:0", grade: "good", reviewedAt: "2025-01-01T10:00:00.000Z", rungBefore: 0 });
    q.enqueue({ cardId: "card:m1-b:drill:0", grade: "again", reviewedAt: "2025-01-01T10:01:00.000Z", rungBefore: 1 });

    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/training/reviews", {
      reviews: [
        { cardId: "card:m1-a:takeaway:0", grade: "good", reviewedAt: "2025-01-01T10:00:00.000Z", rungBefore: 0 },
        { cardId: "card:m1-b:drill:0", grade: "again", reviewedAt: "2025-01-01T10:01:00.000Z", rungBefore: 1 },
      ],
    });
    await vi.waitFor(() => expect(q.getSnapshot().pendingCount).toBe(0));
    // Delivered → storage envelope removed.
    expect(storage.map.has("hf.trainingReviews.v1.42")).toBe(false);
  });

  it("dedupes an identical (cardId, reviewedAt) - a double-tap queues once", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, updated: 1 });
    const q = make({ post, storage: memStorage() });
    const review = { cardId: "card:m1-a:takeaway:0", grade: "easy" as const, reviewedAt: "2025-01-01T10:00:00.000Z" };

    expect(q.enqueue(review).deduped).toBe(false);
    expect(q.enqueue(review).deduped).toBe(true);
    expect(q.enqueue({ ...review, grade: "good" as const }).deduped).toBe(true); // same key fields
    await vi.waitFor(() => expect(q.getSnapshot().pendingCount).toBe(0));
  });

  it("stays pending offline and delivers on reconnect without the rep seeing a thing", async () => {
    vi.useFakeTimers();
    try {
      let online = false;
      const storage = memStorage();
      const post = vi.fn().mockResolvedValue({ ok: true, updated: 1 });
      const q = createTrainingReviewQueue({
        ownerKey: 43,
        storage,
        post,
        isOnline: () => online,
      });
      queues.push(q);

      q.enqueue({ cardId: "card:m1-a:takeaway:0", grade: "good", reviewedAt: "2025-01-01T10:00:00.000Z" });
      await q.flush();
      expect(post).not.toHaveBeenCalled();
      expect(q.getSnapshot().pendingCount).toBe(1);
      // Durable across a simulated reload: the old queue is torn down (page
      // unload) and a fresh queue over the same storage rehydrates the review.
      q.destroy();
      const q2 = createTrainingReviewQueue({ ownerKey: 43, storage, post, isOnline: () => online });
      queues.push(q2);
      expect(q2.getSnapshot().pendingCount).toBe(1);

      // Reconnect → the 30s heartbeat delivers.
      online = true;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(post).toHaveBeenCalledTimes(1);
      expect(q2.getSnapshot().pendingCount).toBe(0);
      expect(storage.map.has("hf.trainingReviews.v1.43")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps reviews pending with backoff on a transient failure", async () => {
    const post = vi.fn().mockRejectedValue(new Error("503: server busy"));
    const q = make({ post, storage: memStorage() });
    q.enqueue({ cardId: "card:m1-a:takeaway:0", grade: "good", reviewedAt: "2025-01-01T10:00:00.000Z" });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(q.getSnapshot().pendingCount).toBe(1);
  });

  it("drops a permanently rejected batch (4xx) instead of retrying forever", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const post = vi.fn().mockRejectedValue(new Error("400: unknown card id"));
    const q = make({ post, storage: memStorage() });
    q.enqueue({ cardId: "card:bogus:takeaway:0", grade: "good", reviewedAt: "2025-01-01T10:00:00.000Z" });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(q.getSnapshot().pendingCount).toBe(0));
    expect(post).toHaveBeenCalledTimes(1); // no retry storm
    errSpy.mockRestore();
  });

  it("works with blocked storage (Safari private / sandboxed iframe) via the in-memory mirror", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, updated: 1 });
    const q = make({ storage: throwingStorage(), post });
    q.enqueue({ cardId: "card:m1-a:takeaway:0", grade: "good", reviewedAt: "2025-01-01T10:00:00.000Z" });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(q.getSnapshot().pendingCount).toBe(0));
  });

  it("discards a corrupt envelope instead of crashing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = memStorage();
    storage.setItem("hf.trainingReviews.v1.44", "{not json");
    const q = createTrainingReviewQueue({ ownerKey: 44, storage, post: vi.fn(), isOnline: () => false });
    queues.push(q);
    expect(q.getSnapshot().pendingCount).toBe(0);
    warnSpy.mockRestore();
  });
});
