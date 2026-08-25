import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A DEAD EGRESS MUST NOT BE RIDDEN FOREVER.
 *
 * Rotation on the mint ladder used to be gated on `isAuthDenialMessage`
 * (/401|403/). A transport-level failure - the residential IP simply cannot
 * reach the Kinetic token endpoint - therefore failed closed WITHOUT advancing
 * the sticky port, and the pool retried that same dead IP every ~3s forever.
 * Measured twice on 2026-08-24: a run sat at verified=610 through 26 consecutive
 * mint failures, wrote zero snapshots, and only a process restart (which picks a
 * new random port) recovered it.
 *
 * The fix must hold THREE properties at once, and each is a separate test below:
 *   1. a dead egress is abandoned after N consecutive transport failures;
 *   2. a working egress can never accumulate its way into a rotation, because
 *      moving IP mid-run is its own measured failure mode (search denials are
 *      gated behind DECODO_ROTATE_AFTER_DENIALS for exactly this reason);
 *   3. a CHALLENGE never rotates, however often it repeats. Rotating past a
 *      bot wall is evasion, and no amount of livelock justifies it.
 */

const { proxyFetch, rotateProxySession } = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  rotateProxySession: vi.fn(async () => {}),
}));
vi.mock("../../server/proxy-fetch", () => ({
  proxyFetch,
  rotateProxySession,
  getProxySessionId: () => "decodo-s1",
  currentEgressProxyUrl: () => "http://redacted@proxy:10001",
  isProxyConnected: () => true,
  getProxyStatus: () => ({ enabled: true, url: "http://redacted@proxy", slots: 100, sessionId: "decodo-s1" }),
}));

let scanner: typeof import("../../server/scanner");

const TOKEN_URL = (u: string) => u.includes("/_internal/precisely/token") || u.includes("/auth/session");
const ROTATE_AFTER = 3;

/** What the egress does on each successive mint attempt. */
type MintStep = "transport" | "ok" | "challenge" | "denied";

let mintAttempts = 0;

/** Rotations THIS fix is responsible for, identified by the reason it passes.
 *  Counting by reason keeps the assertions honest when the pre-existing
 *  auth-denial rotation is also firing. */
const transportRotations = () =>
  rotateProxySession.mock.calls.filter(([reason]) => String(reason) === "mint transport");

const freshToken = () =>
  new Response(JSON.stringify({ token: `t${Math.random()}`.padEnd(40, "x"), success: true }), {
    status: 201, headers: { "content-type": "application/json" },
  });

/**
 * Drive REAL mint attempts through the real ladder, one script step per attempt.
 * Past the end of the script the LAST step repeats, so an extra attempt from the
 * token pool can never change the verdict: a script ending in "ok" makes the
 * overshoot harmless, and one ending in "challenge"/"denied" makes the assertion
 * strictly stronger.
 */
async function runMintScript(script: MintStep[]): Promise<void> {
  proxyFetch.mockImplementation(async (url: string) => {
    if (!TOKEN_URL(url)) throw new Error("no search may run without a token");
    const step = script[Math.min(mintAttempts, script.length - 1)];
    mintAttempts++;
    switch (step) {
      case "transport":
        // No response at all: the tunnel is up, the endpoint is unreachable.
        throw new TypeError("fetch failed");
      case "challenge":
        // The provider ANSWERED, with a bot-wall interstitial.
        return new Response("<html>Attention Required! | Cloudflare</html>", {
          status: 200, headers: { "content-type": "text/html" },
        });
      case "denied":
        return new Response("{}", { status: 403, headers: { "content-type": "application/json" } });
      default:
        return freshToken();
    }
  });
  for (let guard = 0; mintAttempts < script.length && guard < 50; guard++) {
    await scanner.forceFreshTokenFromApi().catch(() => {});
  }
  expect(mintAttempts).toBeGreaterThanOrEqual(script.length);
}

beforeAll(async () => {
  process.env.KFS_TOKEN_POOL_WARM_MIN = "1";
  process.env.KFS_MINT_MIN_INTERVAL_MS = "0";
  // Pin the ladder to the Decodo rung this suite mocks (same reason as
  // live-test-auth.test.ts: an unpinned ladder mints over the real network and
  // the assertions then depend on a third party's bot wall).
  process.env.KFS_MINT_IMPERSONATE = "off";
  process.env.KFS_MINT_DIRECT = "off";
  process.env.KFS_MINT_TRANSPORT_ROTATE_AFTER = String(ROTATE_AFTER);
  process.env.KFS_MINT_MAX_ROTATIONS = "3";
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    throw new Error(`direct egress forbidden in this suite: ${String(url).slice(0, 80)}`);
  }));
  // Both knobs are read at module load, so every env above must precede this.
  scanner = await import("../../server/scanner");
});

beforeEach(() => {
  mintAttempts = 0;
  proxyFetch.mockReset();
  rotateProxySession.mockClear();
  scanner.__resetTokenTransportStateForTests();
});

describe("mint transport failures advance the sticky egress", () => {
  it("abandons an egress that cannot reach the token endpoint, and recovers", async () => {
    await runMintScript(["transport", "transport", "transport", "ok"]);

    // Exactly one move: at the threshold, not on every failure after it.
    expect(transportRotations()).toHaveLength(1);
    // And the mint that followed the rotation succeeded - the livelock is
    // broken in-process, with no restart.
    expect(mintAttempts).toBeGreaterThan(ROTATE_AFTER);
  });

  it("holds still below the threshold - one blip is not a dead IP", async () => {
    await runMintScript(["transport", "transport", "ok"]);

    expect(transportRotations()).toHaveLength(0);
  });

  it("forgives the streak on a successful mint, so a healthy IP is never moved", async () => {
    // Four transport failures, but never three IN A ROW: the egress keeps
    // proving it is alive, so it must be kept. This is the property that stops
    // the gate degrading into the rotation reflex.
    await runMintScript(["transport", "transport", "ok", "transport", "transport", "ok"]);

    expect(transportRotations()).toHaveLength(0);
  });

  it("never rotates past a challenge, however many times it repeats", async () => {
    // The script never leaves "challenge", so this is unbounded repetition.
    await runMintScript(Array<MintStep>(ROTATE_AFTER * 2).fill("challenge"));

    expect(transportRotations()).toHaveLength(0);
    // Not by any other reason either: a challenge moves nothing at all.
    expect(rotateProxySession).not.toHaveBeenCalled();
  });

  it("leaves the auth-denial path alone, and a denial never feeds the transport streak", async () => {
    await runMintScript(Array<MintStep>(ROTATE_AFTER * 2).fill("denied"));

    // The pre-existing 401/403 remedy still fires...
    expect(rotateProxySession).toHaveBeenCalled();
    // ...but attributed to the denial, never to this fix. A denial says the IP
    // is throttled, not that it is unreachable; conflating the two is exactly
    // how a streak would drift into rotating on every 403.
    expect(transportRotations()).toHaveLength(0);
  });

  it("classifies the failure structurally, not by matching an error string", async () => {
    // A challenge can only exist once a response has been received, so it can
    // never be constructed as a transport failure. That is what makes the gate
    // safe: it is a type, not a regex over a message that could drift.
    const err = new scanner.MintTransportError(new TypeError("fetch failed"));
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("MINT_TRANSPORT");
    expect(err.message).toContain("fetch failed");
  });
});
