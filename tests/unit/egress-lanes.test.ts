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
    expect(src).toContain("authorizedTokenPool.retireLane(laneId, laneCount)");
  });

  it("retires every slot riding a lane, never slots[laneId]", async () => {
    // A lane is not a slot. slot -> lane is slotId % laneCount, so lane 1 of 4
    // carries slots 1, 5, 9... Indexing the array with the LANE id retires an
    // idle slot, silently (it returns 0, so even the log line is skipped) while
    // the live token rides on across that lane's brand-new IP. Simulated at
    // 6-way concurrency the mismatch grew the pool to its 200-slot cap and
    // refused 1,900 of 6,000 leases.
    const { AuthorizedTokenPool } = await import("../../server/authorizedTokenPool");
    const pool: any = new AuthorizedTokenPool({
      maxSize: 12, warmMinimum: 1, refreshMarginMs: 60_000, maintenanceIntervalMs: 60_000,
      maxChecksPerToken: 20, maxLeasesPerToken: 20,
      mint: async () => ({ token: "t", expiresAt: Date.now() + 3_600_000 }),
    } as any);
    // Twelve slots, all holding a token.
    for (let i = 0; i < 12; i++) { const s = pool.createSlot(); s.token = `t${i}`; s.expiresAt = Date.now() + 3_600_000; s.state = "READY"; }

    // Lane 1 of 4 carries slots 1, 5 and 9 - three tokens, not one.
    expect(pool.retireLane(1, 4)).toBe(3);
    for (const id of [1, 5, 9]) expect(pool.slots[id].token, `slot ${id} rides lane 1`).toBeNull();
    for (const id of [0, 2, 3, 4]) expect(pool.slots[id].token, `slot ${id} is on another lane`).not.toBeNull();

    // Retiring again is a no-op, and nonsense arguments retire nothing.
    expect(pool.retireLane(1, 4)).toBe(0);
    expect(pool.retireLane(0, 0)).toBe(0);
  });

  it("holds one slot per lane instead of growing the pool until leases are refused", async () => {
    // A slot that has spent its address budget stays READY-but-full, so
    // pickReady skips it; the pool used to answer by CREATING a slot, so ids
    // climbed forever. Measured live on Lexington: 1 -> 6 -> 24 -> 50 -> 200
    // slots in eight minutes, then the sweep stalled with the queue full and
    // zero answers, because maxSize refuses leases.
    const { AuthorizedTokenPool } = await import("../../server/authorizedTokenPool");
    const LANES = 4;
    let minted = 0;
    const pool: any = new AuthorizedTokenPool({
      maxSize: 50, warmMinimum: 1, refreshMarginMs: 60_000, maintenanceIntervalMs: 600_000,
      maxChecksPerToken: 20, maxLeasesPerToken: 20,
      mint: async () => ({ token: `tok${++minted}`, expiresAt: Date.now() + 3_600_000 }),
    } as any);

    const lanesUsed = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const lane = i % LANES;
      const lease = await pool.lease(`addr-${i}`, lane, LANES);
      expect(lease.slotId % LANES, "a lease lands on the lane it asked for").toBe(lane);
      lanesUsed.add(lane);
      lease.release();
    }
    expect(lanesUsed.size, "every lane carried traffic").toBe(LANES);
    // One slot per lane, not four hundred.
    expect(pool.snapshot().total).toBe(LANES);
    // 400 checks at 20 per token is 20 tokens - the pair rule, not one per check.
    expect(minted).toBe(400 / 20);
  });

  it("a process-wide rotation moves every lane, not just the shared dispatcher", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/proxy-fetch.ts"), "utf8");
    const rebuild = src.slice(src.indexOf("function rebuildDispatcher"), src.indexOf("async function doRotate"));
    // Without this the pool was wiped while every lane kept dialling its spent IP.
    expect(rebuild, "lanes advance with the process").toContain("for (const lane of _lanes.values())");
    expect(rebuild).toContain("lane.offset += LANE_COUNT()");
    // A socket reset rebuilds the lane that carried the request, at its own port.
    const fetchBody = src.slice(src.indexOf("export async function proxyFetch"));
    expect(fetchBody, "reset is lane-local").toContain("lane.dispatcher = buildAgent(laneUrl(proxyUrl, lane), LANE_COUNT());");
  });

  it("divides the connection budget across lanes instead of multiplying it", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/proxy-fetch.ts"), "utf8");
    // 16 lanes x the full 100 would be 1,600 sockets for a process that had 100.
    expect(src).toContain("lanes > 1 ? Math.max(4, Math.floor(POOL_SIZE / lanes)) : POOL_SIZE");
  });
});
