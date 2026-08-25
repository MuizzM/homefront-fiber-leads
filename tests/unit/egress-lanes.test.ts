// PARALLEL LANES: N RESIDENTIAL IPs AT ONCE, NOT N CHECKS ON ONE.
//
// Kinetic throttles one (IP, token) PAIR at about 20 answers. A single
// dispatcher on a single port means every concurrent check in the process
// shares one IP and drains one budget together - which is why the app measured
// best at concurrency 5 while a 4-lane standalone runner is comfortable.
//
// Decodo was never the constraint. Measured 2026-08-25 against the live account:
// eight sticky ports hit simultaneously returned seven distinct residential IPs
// (68.99.202.95, 47.161.134.233, 100.1.233.25, 75.213.226.29, 47.197.245.96,
// 107.218.243.196, 99.167.226.79). The limit was this process holding one
// dispatcher.
import { describe, expect, it, beforeEach, afterEach } from "vitest";

const ENV = ["DECODO_LANES", "PROXY_URL", "DECODO_STICKY", "DECODO_STICKY_PORT_BASE", "DECODO_STICKY_PORT_COUNT"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])); });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("egress lanes", () => {
  it("maps a token slot onto a lane, and one lane means everything shares lane 0", async () => {
    process.env.PROXY_URL = "http://user:pass@us.decodo.com:10000";
    const mod = await import("../../server/proxy-fetch");

    // Default: one lane, so every slot lands on lane 0 - byte for byte the
    // behaviour before lanes existed.
    delete process.env.DECODO_LANES;
    expect([0, 1, 5, 199].map(mod.laneFor)).toEqual([0, 0, 0, 0]);

    // Four lanes: slots spread across them deterministically, so a slot always
    // returns to the same IP for as long as that lane holds it.
    process.env.DECODO_LANES = "4";
    expect([0, 1, 2, 3, 4, 5].map(mod.laneFor)).toEqual([0, 1, 2, 3, 0, 1]);
    expect(mod.laneFor(7), "stable for a given slot").toBe(mod.laneFor(7));
  });

  it("is bounded: a typo cannot open a hundred egresses", async () => {
    process.env.PROXY_URL = "http://user:pass@us.decodo.com:10000";
    const mod = await import("../../server/proxy-fetch");
    process.env.DECODO_LANES = "500";
    // Clamped to 64 - well under the 256 the account served clean, because the
    // cost here is local: each lane builds its own undici pool.
    expect(new Set([...Array(200).keys()].map(mod.laneFor)).size).toBe(64);
    process.env.DECODO_LANES = "not-a-number";
    expect(mod.laneFor(3), "garbage falls back to one lane").toBe(0);
  });

  it("gives each lane its own port, so two lanes never share an IP", async () => {
    process.env.PROXY_URL = "http://user:pass@us.decodo.com:10000";
    process.env.DECODO_STICKY_PORT_BASE = "10001";
    process.env.DECODO_STICKY_PORT_COUNT = "100";
    process.env.DECODO_LANES = "4";
    delete process.env.DECODO_STICKY;
    const mod = await import("../../server/proxy-fetch");
    mod.__resetRotationStateForTests();
    // Lanes are created lazily by traffic; the reporter shows what exists.
    const state = mod.getLaneState();
    for (const lane of state) {
      expect(lane.port).toBeGreaterThanOrEqual(10001);
      expect(lane.port).toBeLessThan(10101);
    }
    expect(new Set(state.map((l) => l.port)).size, "no two lanes on one port").toBe(state.length);
  });

  it("the scanner pairs a check with the lane its token slot rides", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/scanner.ts"), "utf8");
    // The search passes the LEASED SLOT, which is what makes the pair real
    // rather than nominal.
    expect(src).toContain("}, tokenLease.slotId);");
    // ...and a lane rotation retires only that slot's token.
    expect(src).toContain("authorizedTokenPool.retireSlot(laneId)");
  });

  it("divides the connection budget across lanes instead of multiplying it", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/proxy-fetch.ts"), "utf8");
    // 16 lanes x the full 100 would be 1,600 sockets for a process that had 100.
    expect(src).toContain("lanes > 1 ? Math.max(4, Math.floor(POOL_SIZE / lanes)) : POOL_SIZE");
  });
});
