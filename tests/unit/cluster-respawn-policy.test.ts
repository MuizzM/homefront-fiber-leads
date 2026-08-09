import { describe, it, expect } from "vitest";
import { decideRespawn, type RespawnConfig } from "../../server/clusterRespawnPolicy";

const CFG: RespawnConfig = { minHealthyMs: 60_000, maxRapid: 8, backoffCapMs: 60_000 };

describe("cluster respawn policy - crash-loop backoff without pegging the box", () => {
  it("a one-off crash after healthy uptime respawns fast and resets the counter", () => {
    const d = decideRespawn(2, 120_000, { rapid: 5 }, CFG); // was looping, but stayed up 2min
    expect(d).toEqual({ action: "respawn", delayMs: 1_000, rapid: 0 });
  });

  it("rapid crashes escalate the delay exponentially, capped", () => {
    // uptime under the healthy threshold each time → rapid climbs.
    expect(decideRespawn(2, 500, { rapid: 0 }, CFG)).toMatchObject({ action: "respawn", rapid: 1, delayMs: 1_000 });
    expect(decideRespawn(2, 500, { rapid: 1 }, CFG)).toMatchObject({ rapid: 2, delayMs: 2_000 });
    expect(decideRespawn(2, 500, { rapid: 2 }, CFG)).toMatchObject({ rapid: 3, delayMs: 4_000 });
    expect(decideRespawn(2, 500, { rapid: 5 }, CFG)).toMatchObject({ rapid: 6, delayMs: 32_000 });
    expect(decideRespawn(2, 500, { rapid: 6 }, CFG)).toMatchObject({ rapid: 7, delayMs: 60_000 }); // capped
  });

  it("a non-control worker is PARKED after maxRapid rapid crashes", () => {
    const d = decideRespawn(3, 500, { rapid: 7 }, CFG); // 7 → 8 == maxRapid
    expect(d).toEqual({ action: "park", delayMs: 0, rapid: 8 });
  });

  it("the CONTROL worker (index 0) is never parked - it retries at the capped delay", () => {
    const d = decideRespawn(0, 500, { rapid: 20 }, CFG);
    expect(d.action).toBe("respawn");
    expect(d.delayMs).toBe(60_000); // capped, but always retries — the app needs a control worker
  });

  it("recovering to healthy uptime clears a near-park counter", () => {
    const d = decideRespawn(3, 90_000, { rapid: 7 }, CFG);
    expect(d).toEqual({ action: "respawn", delayMs: 1_000, rapid: 0 });
  });
});
