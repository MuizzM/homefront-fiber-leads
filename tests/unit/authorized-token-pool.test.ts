import { describe, expect, it, vi } from "vitest";
import { AuthorizedTokenPool } from "../../server/authorizedTokenPool";

describe("AuthorizedTokenPool", () => {
  it("keeps only the configured warm minimum and leases least-loaded round-robin", async () => {
    let now = 1_000;
    const mint = vi.fn(async (slotId: number) => ({ token: `token-${slotId}`, expiresAt: now + 120_000 }));
    const pool = new AuthorizedTokenPool({ maxSize: 300, warmMinimum: 2, refreshMarginMs: 10_000, mint, now: () => now });
    const first = await pool.lease();
    const second = await pool.lease();
    expect(first.slotId).not.toBe(second.slotId);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(pool.snapshot()).toMatchObject({ maxSize: 300, warmMinimum: 2, total: 2, ready: 2, activeLeases: 2 });
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

  it("expands lazily under lease pressure without minting the configured maximum", async () => {
    let calls = 0;
    const pool = new AuthorizedTokenPool({
      maxSize: 300, warmMinimum: 1, maxLeasesPerToken: 1, refreshMarginMs: 1_000,
      mint: async () => ({ token: `token-${++calls}`, expiresAt: Date.now() + 60_000 }),
    });
    const leases = [await pool.lease(), await pool.lease(), await pool.lease()];
    expect(pool.snapshot()).toMatchObject({ total: 3, ready: 3, activeLeases: 3, maxSize: 300 });
    expect(calls).toBe(3);
    leases.forEach(lease => lease.release());
    pool.stop();
  });

  it("tracks cooldown, expiry, and disabled lifecycle states without returning stale tokens", async () => {
    let now = 1_000, fail = true;
    const pool = new AuthorizedTokenPool({
      maxSize: 1, warmMinimum: 1, refreshMarginMs: 1_000, cooldownBaseMs: 250, now: () => now,
      mint: async () => {
        if (fail) { fail = false; throw new Error("temporary mint failure"); }
        return { token: "ready", expiresAt: now + 5_000 };
      },
    });
    await expect(pool.lease()).rejects.toThrow();
    expect(pool.snapshot()).toMatchObject({ total: 1, states: { COOLDOWN: 1 } });
    await expect(pool.lease()).rejects.toThrow();
    expect(pool.snapshot().total).toBe(1);
    now += 500;
    const lease = await pool.lease();
    expect(lease.token).toBe("ready");
    lease.release();
    now += 5_001;
    expect(pool.snapshot().states.EXPIRED).toBe(1);
    pool.disable();
    expect(pool.snapshot()).toMatchObject({ disabled: true, states: { DISABLED: 1 } });
    await expect(pool.lease()).rejects.toThrow("AUTHORIZED_TOKEN_POOL_DISABLED");
  });
});
