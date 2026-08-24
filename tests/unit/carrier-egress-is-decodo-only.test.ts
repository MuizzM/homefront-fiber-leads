// NO CARRIER REQUEST LEAVES FROM THIS BOX (owner directive, 2026-08-24).
//
// Decodo's sticky ports ARE residential IPs - that is what the account buys -
// so "residential" and "Decodo" name the same egress. What is NOT Decodo is the
// machine's own connection, and until CARRIER_DIRECT_EGRESS existed three
// carrier paths used it BY DEFAULT:
//
//   server/scanner.ts        imp-direct mint rung (curl-impersonate, proxy=null)
//   server/scanner.ts        the legacy direct mint rung (global fetch)
//   server/frontierScanner.ts  serviceability, direct FIRST and proxy only on failure
//
// ...and a fourth, the Kinetic directory poll in server/kineticMarketCatalog.ts,
// had no switch at all. None of them announced itself: the logs said the request
// went out, never that it went out from here. A blocked home or server IP is
// also not something you can rotate your way out of.
//
// Direct carrier egress is opt-IN now. These tests pin both halves: the default
// is Decodo, and the opt-in still works for an operator who wants the measured
// hybrid ladder back (curl-impersonate direct mints 6/6 from a clean IP and
// spend no residential search budget).
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");

// Every module that talks to a carrier. A new one belongs on this list.
const CARRIER_MODULES = [
  "server/scanner.ts",
  "server/curlMint.ts",
  "server/frontierScanner.ts",
  "server/kineticMarketCatalog.ts",
];

/** Bare `fetch(...)` calls - the global, not `proxyFetch` or any other member. */
function bareFetchCalls(file: string): number[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "fetch") {
      lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

describe("carrier modules never call global fetch", () => {
  // A structural rule, because the leak is invisible at runtime: `await
  // fetch(url, init)` in frontierScanner read exactly like the proxied call
  // beside it. Route carrier traffic through proxyFetch, or through
  // directCarrierFetch when it is genuinely meant to leave from this box - that
  // one refuses unless an operator opted in.
  it.each(CARRIER_MODULES)("%s", (rel) => {
    const hits = bareFetchCalls(path.join(REPO, rel));
    expect(hits, `${rel} calls the global fetch at line(s) ${hits.join(", ")}. Use proxyFetch, `
      + `or directCarrierFetch if the request is deliberately unproxied.`).toEqual([]);
  });

  it("the impersonate mint refuses a null proxy at the point of egress", () => {
    // curl-impersonate is spawned, not fetched, so the rule above cannot see it.
    // The guarantee lives inside mintViaImpersonate instead.
    const src = fs.readFileSync(path.join(REPO, "server/curlMint.ts"), "utf8");
    expect(src).toContain("if (!proxyUrl && !directCarrierEgressAllowed())");
  });
});

// ── The behaviour, not just the shape ────────────────────────────────────────
const { proxyFetch, mintViaImpersonate } = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  mintViaImpersonate: vi.fn(),
}));
vi.mock("../../server/curlMint", () => ({ mintViaImpersonate }));
vi.mock("../../server/proxy-fetch", async (importOriginal) => {
  // The REAL gate and the REAL directCarrierFetch: this suite is about whether
  // the policy holds, so mocking it would test nothing. Only the transport is
  // faked.
  const actual = await importOriginal<typeof import("../../server/proxy-fetch")>();
  return {
    ...actual,
    proxyFetch,
    rotateProxySession: vi.fn(async () => {}),
    advanceProxyEgress: vi.fn(async () => {}),
    getProxySessionId: () => "decodo-s1",
    isProxyConnected: () => true,
    currentEgressProxyUrl: () => "http://user:pass@us.decodo.com:10001",
  };
});
vi.mock("../../server/distributedProviderCoordinator", () => {
  class DistributedProviderCoordinator<T> {
    async execute(_key: string, _source: string, task: () => Promise<T>): Promise<T> { return task(); }
    pauseFor() { return Date.now(); }
    halt() {}
    resume() {}
    snapshot() {
      return { active: 0, queued: 0, startsLastMinute: 0, maxConcurrency: 45, maxRequestsPerMinute: 100,
        pausedUntil: null, halted: false, haltReason: null, instanceId: "test" };
    }
  }
  return { DistributedProviderCoordinator, DistributedProviderHaltedError: Error };
});

let scanner: typeof import("../../server/scanner");
const ENV_KEYS = ["CARRIER_DIRECT_EGRESS", "KFS_MINT_IMPERSONATE", "KFS_MINT_DIRECT", "KFS_MINT_MIN_INTERVAL_MS"];
let saved: Record<string, string | undefined> = {};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("the mint ladder egresses through Decodo by default", () => {
  beforeAll(async () => {
    process.env.KFS_MINT_MIN_INTERVAL_MS = "0";
    scanner = await import("../../server/scanner");
  });

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    // Deliberately DO NOT set the mint flags: the whole point is what happens to
    // a deployment that configures nothing.
    delete process.env.CARRIER_DIRECT_EGRESS;
    delete process.env.KFS_MINT_IMPERSONATE;
    delete process.env.KFS_MINT_DIRECT;
    process.env.KFS_MINT_MIN_INTERVAL_MS = "0";
    proxyFetch.mockReset();
    mintViaImpersonate.mockReset();
    scanner.__resetTokenTransportStateForTests();
    scanner.setManualToken("test-server-token-with-a-safe-fallback-expiry");
  });

  function restore() {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }

  it("skips the direct rungs entirely and mints through the sticky proxy", async () => {
    try {
      mintViaImpersonate.mockResolvedValue({ token: "minted-through-decodo", expiresAt: Date.now() + 2_100_000 });
      const token = await scanner.forceFreshTokenFromApi();
      expect(token).toBe("minted-through-decodo");
      // ONE impersonate call, and it carried a proxy URL. A null fourth argument
      // is curl egressing from this box.
      expect(mintViaImpersonate).toHaveBeenCalledTimes(1);
      expect(mintViaImpersonate.mock.calls[0][3], "the mint must not egress direct")
        .toBe("http://user:pass@us.decodo.com:10001");
    } finally { restore(); }
  });

  it("falls to the Decodo transport - never the legacy direct rung - when impersonate fails", async () => {
    try {
      mintViaImpersonate.mockRejectedValue(new Error("Auto-auth blocked (403 via imp-proxy)"));
      proxyFetch.mockImplementation(async (url: string) => {
        expect(url).toContain("/api/v1/auth/session");
        return json(200, { access_token: "minted-on-the-decodo-rung", expires_in: 2_100 });
      });
      await expect(scanner.forceFreshTokenFromApi()).resolves.toBe("minted-on-the-decodo-rung");
      // The legacy direct rung would have called the global fetch, not proxyFetch,
      // and would have won the race to return before this.
      expect(proxyFetch).toHaveBeenCalled();
    } finally { restore(); }
  });

  it("CARRIER_DIRECT_EGRESS=on puts the direct rung back", async () => {
    try {
      process.env.CARRIER_DIRECT_EGRESS = "on";
      mintViaImpersonate.mockResolvedValue({ token: "minted-direct", expiresAt: Date.now() + 2_100_000 });
      await expect(scanner.forceFreshTokenFromApi()).resolves.toBe("minted-direct");
      expect(mintViaImpersonate.mock.calls[0][3], "the opt-in restores the direct rung").toBeNull();
    } finally { restore(); }
  });
});

describe("directCarrierFetch is the gate, not a convenience", () => {
  it("refuses unless an operator opted in, and allows it when they did", async () => {
    const mod = await import("../../server/proxy-fetch");
    const prev = process.env.CARRIER_DIRECT_EGRESS;
    try {
      delete process.env.CARRIER_DIRECT_EGRESS;
      expect(mod.directCarrierEgressAllowed()).toBe(false);
      await expect(mod.directCarrierFetch("https://buy.gokinetic.com/api/v1/auth/session"))
        .rejects.toThrow(/direct carrier egress is off/);
      // Not a boolean-ish parse: only the explicit opt-in counts.
      process.env.CARRIER_DIRECT_EGRESS = "true";
      expect(mod.directCarrierEgressAllowed(), '"true" is not "on"').toBe(false);
      process.env.CARRIER_DIRECT_EGRESS = "on";
      expect(mod.directCarrierEgressAllowed()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CARRIER_DIRECT_EGRESS; else process.env.CARRIER_DIRECT_EGRESS = prev;
    }
  });
});
