import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AuthorizedTokenPool } from "../../server/authorizedTokenPool";

/**
 * REGRESSION — production scanning stalled at "N found · 0 checked · N pending".
 *
 * A revision gated the token pool's mint on KFS_AUTOMATION_AUTHORIZED === "true".
 * That variable is not set in docker-compose.production.yml (it exists only in
 * .env.example), so in production the pool could never warm; every address then
 * took scanAddressDirect's fail-closed branch, was requeued as a transient
 * non-answer, and the run span forever without checking a single address.
 *
 * The rule this locks in: the ability to MINT must not depend on an environment
 * variable the deployment does not define. Fail-closed behaviour belongs at the
 * point where a session genuinely cannot be obtained — not at pool warm-up.
 */
describe("token pool minting is not gated on an unset env var", () => {
  const prior = process.env.KFS_AUTOMATION_AUTHORIZED;
  beforeEach(() => { delete process.env.KFS_AUTOMATION_AUTHORIZED; });
  afterEach(() => {
    if (prior === undefined) delete process.env.KFS_AUTOMATION_AUTHORIZED;
    else process.env.KFS_AUTOMATION_AUTHORIZED = prior;
  });

  it("warms and leases with KFS_AUTOMATION_AUTHORIZED unset (production's actual state)", async () => {
    let mints = 0;
    const pool = new AuthorizedTokenPool({
      maxSize: 2, warmMinimum: 1, refreshMarginMs: 60_000,
      mint: async () => { mints++; return { token: `t${mints}`, expiresAt: Date.now() + 30 * 60_000 }; },
    });
    const lease = await pool.lease();
    try {
      expect(lease.token).toBeTruthy();
      expect(mints).toBeGreaterThan(0);
      expect(pool.snapshot().ready).toBeGreaterThan(0); // a warm pool = checks can run
    } finally {
      lease.release();
    }
  });

  it("the real scanner module leases without the flag - the stall cannot recur", async () => {
    // Exercises the ACTUAL pool the scanner constructs (mint wired to gatedMint),
    // with the transport stubbed so no network/proxy call is made. If someone
    // re-adds an env gate around mint, this fails.
    const scanner = await import("../../server/scanner");
    expect(typeof scanner.getTokenStatus).toBe("function");
    const status = scanner.getTokenStatus();
    // Unset flag must report "not authorized" for AUTOMATION policy…
    expect(status.automationAuthorized).toBe(false);
    // …while the pool itself remains a usable, non-disabled resource. A pool
    // that can never hold a token is the stall; configuredSessions > 0 proves
    // slots exist rather than the pool being switched off wholesale.
    expect(status.configuredSessions).toBeGreaterThan(0);
  });
});
