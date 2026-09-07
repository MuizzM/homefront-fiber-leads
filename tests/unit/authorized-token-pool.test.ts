import { describe, expect, it, vi } from "vitest";
import { AuthorizedTokenPool } from "../../server/authorizedTokenPool";

describe("AuthorizedTokenPool", () => {
  it("uses installed and on-demand tokens without background timers in an HTTP worker", async () => {
    vi.useFakeTimers();
    const mint = vi.fn(async () => ({ token: "demand-token", expiresAt: Date.now() + 120_000 }));
    const pool = new AuthorizedTokenPool({ maxSize: 1, warmMinimum: 1, refreshMarginMs: 1000, backgroundMaintenance: false, mint });
    try {
      pool.start();
      expect(mint).not.toHaveBeenCalled();
      pool.install("installed-token", Date.now() + 120_000);
      const installed = await pool.lease();
      expect(installed.token).toBe("installed-token");
      installed.release();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(mint).not.toHaveBeenCalled();
      const demand = await pool.lease();
      expect(demand.token).toBe("demand-token");
      expect(mint).toHaveBeenCalledTimes(1);
      demand.release();
      expect(vi.getTimerCount()).toBe(0);
    } finally { pool.stop(); vi.useRealTimers(); }
  });
  it("keeps only the configured warm minimum and leases least-loaded round-robin", async () => {
    let now = 1_000;
    const mint = vi.fn(async (slotId: number) => ({ token: `token-${slotId}`, expiresAt: now + 120_000 }));
    const pool = new AuthorizedTokenPool({ maxSize: 100, warmMinimum: 2, refreshMarginMs: 10_000, mint, now: () => now });
    const first = await pool.lease();
    const second = await pool.lease();
    expect(first.slotId).not.toBe(second.slotId);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(pool.snapshot()).toMatchObject({ maxSize: 100, warmMinimum: 2, total: 2, ready: 2, activeLeases: 2 });
    first.release(); second.release();
    const third = await pool.lease();
    expect(mint).toHaveBeenCalledTimes(2);
    third.release();
    pool.stop();
  });

  it("single-flights concurrent refreshes for one slot", async () => {
    let calls = 0;
    const pool = new AuthorizedTokenPool({
      maxSize: 1, warmMinimum: 1, refreshMarginMs: 1_000,
      mint: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return { token: `token-${calls}`, expiresAt: Date.now() + 60_000 }; },
    });
    const lease = await pool.lease();
    const before = calls;
    const [a, b, c] = await Promise.all([pool.refreshLease(lease), pool.refreshLease(lease), pool.refreshLease(lease)]);
    expect(calls - before).toBe(1);
    expect(a).toBe(b); expect(b).toBe(c);
    lease.release(); pool.stop();
  });

  it("caps refresh concurrency across different slots to prevent token storms", async () => {
    let activeMints = 0, peakMints = 0, calls = 0;
    const pool = new AuthorizedTokenPool({
      maxSize: 6,
      warmMinimum: 6,
      refreshMarginMs: 1_000,
      maxConcurrentRefreshes: 2,
      mint: async slotId => {
        calls++;
        activeMints++;
        peakMints = Math.max(peakMints, activeMints);
        await new Promise(resolve => setTimeout(resolve, 5));
        activeMints--;
        return { token: `token-${slotId}`, expiresAt: Date.now() + 60_000 };
      },
    });
    const leases = await Promise.all(Array.from({ length: 6 }, () => pool.lease()));
    // Leases unblock on the FIRST ready token (cold-start fix) while the rest
    // of the pool warms in the background — so all 6 leases are served, the
    // storm cap held, and the full warm completes shortly after.
    expect(peakMints).toBe(2);
    expect(leases).toHaveLength(6);
    await vi.waitFor(() => {
      expect(calls).toBe(6);
      expect(pool.snapshot()).toMatchObject({ ready: 6, activeLeases: 6, activeRefreshes: 0 });
    });
    expect(peakMints).toBe(2); // background warm respected the cap too
    leases.forEach(lease => lease.release());
    pool.stop();
  });

  it("expands lazily under lease pressure without minting the configured maximum", async () => {
    let calls = 0;
    const pool = new AuthorizedTokenPool({
      maxSize: 100, warmMinimum: 1, maxLeasesPerToken: 1, refreshMarginMs: 1_000,
      mint: async () => ({ token: `token-${++calls}`, expiresAt: Date.now() + 60_000 }),
    });
    const leases = [await pool.lease(), await pool.lease(), await pool.lease()];
    expect(pool.snapshot()).toMatchObject({ total: 3, ready: 3, activeLeases: 3, maxSize: 100 });
    expect(calls).toBe(3);
    leases.forEach(lease => lease.release());
    pool.stop();
  });

  it("self-heals a transient mint failure with no cooldown, expires stale tokens, is never disabled", async () => {
    let now = 1_000, attempts = 0;
    const pool = new AuthorizedTokenPool({
      maxSize: 1, warmMinimum: 1, refreshMarginMs: 1_000, now: () => now,
      mint: async () => {
        attempts++;
        if (attempts === 1) throw new Error("temporary mint failure");
        return { token: "ready", expiresAt: now + 5_000 };
      },
    });
    // A transient mint failure is recovered automatically within the same lease —
    // no cooldown, no wedge — and the lease still returns a valid token.
    const lease = await pool.lease();
    expect(lease.token).toBe("ready");
    expect(attempts).toBeGreaterThanOrEqual(2); // it re-minted immediately, no wait
    lease.release();
    // After expiry the slot is EXPIRED and yields no stale token.
    now += 5_001;
    expect(pool.snapshot().states.EXPIRED).toBe(1);
    // There is no disable()/disabled state — the pool can never be halted.
    expect((pool as unknown as { disable?: unknown }).disable).toBeUndefined();
    expect(pool.snapshot()).not.toHaveProperty("disabled");
  });

  it("drains one token at a time across a sequential batch - 45 checks ride ONE token (sticky reuse)", async () => {
    const mint = vi.fn(async (slotId: number) => ({ token: `token-${slotId}`, expiresAt: Date.now() + 120_000 }));
    const pool = new AuthorizedTokenPool({
      maxSize: 100, warmMinimum: 4, maxChecksPerToken: 250, maxLeasesPerToken: 1_000,
      refreshMarginMs: 10_000, mint,
    });
    for (let index = 0; index < 45; index++) {
      const lease = await pool.lease(`address-${index}`);
      lease.release();
    }
    // Owner directive: a working token is REUSED for the whole 40-50 batch —
    // exactly one slot carries every check, and no mint beyond the warm pool.
    const used = pool.snapshot().slots.filter(slot => slot.checksUsed > 0);
    expect(used).toHaveLength(1);
    expect(used[0].checksUsed).toBe(45);
    await vi.waitFor(() => expect(mint.mock.calls.length).toBe(4)); // warm mints only
    pool.stop();
  });

  it("hands off token-by-token at capacity and enforces per-token batch capacity", async () => {
    const pool = new AuthorizedTokenPool({
      maxSize: 3,
      warmMinimum: 3,
      maxChecksPerToken: 100,
      maxLeasesPerToken: 1_000,
      refreshMarginMs: 1_000,
      mint: async slotId => ({ token: `token-${slotId}`, expiresAt: Date.now() + 60_000 }),
    });
    for (let index = 0; index < 300; index++) {
      const lease = await pool.lease(`address-${index}`);
      lease.release();
    }
    const snapshot = pool.snapshot();
    expect(snapshot).toMatchObject({
      maxChecksPerToken: 100,
      maxBatchCapacity: 300,
      checksUsed: 300,
      checksRemaining: 0,
      healthy: 3,
    });
    expect(snapshot.slots.map(slot => slot.checksUsed)).toEqual([100, 100, 100]);
    const repeat = await pool.lease("address-0");
    repeat.release();
    expect(pool.snapshot().checksUsed).toBe(300);
    await expect(pool.lease("address-301")).rejects.toThrow("AUTHORIZED_TOKEN_BATCH_CAPACITY_EXHAUSTED");
    pool.stop();
  });
});
