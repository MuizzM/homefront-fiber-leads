import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PressureThresholds } from "../../server/resourcePressure";

// The disk/WAL pressure sentinel: threshold state machine with hysteresis, and
// the FAIL-OPEN published-state read (a stale row must never suppress scanning
// — the persisted-403-halt incident wedged prod at "0 checked" for days).

let rp: typeof import("../../server/resourcePressure");
let rawDb: import("better-sqlite3").Database;

const T: PressureThresholds = {
  warnFreeMb: 8192, throttleFreeMb: 6144, pauseFreeMb: 4096, emergencyFreeMb: 2560,
  warnWalMb: 1536, throttleWalMb: 2048, pauseWalMb: 3072, emergencyWalMb: 4096,
  hysteresisFreeMb: 1024, hysteresisWalMb: 256,
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-pressure-"));
  rp = await import("../../server/resourcePressure");
  ({ rawDb } = await import("../../server/db"));
  rp.ensurePressureTable();
});

describe("pressure level state machine", () => {
  it("classifies by free disk", () => {
    expect(rp.rawPressureLevel(20_000, 0, T)).toBe("normal");
    expect(rp.rawPressureLevel(8000, 0, T)).toBe("warn");
    expect(rp.rawPressureLevel(6000, 0, T)).toBe("throttle");
    expect(rp.rawPressureLevel(4000, 0, T)).toBe("pause");
    expect(rp.rawPressureLevel(2000, 0, T)).toBe("emergency");
  });

  it("classifies by WAL size - either trigger escalates", () => {
    expect(rp.rawPressureLevel(20_000, 1600, T)).toBe("warn");
    expect(rp.rawPressureLevel(20_000, 2100, T)).toBe("throttle");
    expect(rp.rawPressureLevel(20_000, 3100, T)).toBe("pause");
    expect(rp.rawPressureLevel(20_000, 5000, T)).toBe("emergency");
  });

  it("escalates immediately regardless of previous level", () => {
    expect(rp.decidePressureLevel(2000, 0, "normal", T)).toBe("emergency");
    expect(rp.decidePressureLevel(6000, 0, "warn", T)).toBe("throttle");
  });

  it("demotes only when clear of the trigger by the hysteresis margin", () => {
    // Just above the pause floor (4096): raw says throttle, but not by margin.
    expect(rp.decidePressureLevel(4200, 0, "pause", T)).toBe("pause");
    // Clear of pause+margin (5120) but not of throttle+margin (7168): throttle.
    expect(rp.decidePressureLevel(6500, 0, "pause", T)).toBe("throttle");
    // Fully clear of everything (warn 8192 + margin 1024 = 9216): normal.
    expect(rp.decidePressureLevel(9500, 0, "pause", T)).toBe("normal");
  });
});

describe("published pressure state (fail-open)", () => {
  it("round-trips a published level", () => {
    rp.publishPressure("pause", 4000, 100, 7000, "test", Date.now());
    const read = rp.readPressure();
    expect(read.level).toBe("pause");
    expect(read.stale).toBe(false);
  });

  it("a row older than the TTL reads as normal (stale sampler must fail open)", () => {
    rp.publishPressure("emergency", 1000, 5000, 7000, "test", Date.now() - rp.PRESSURE_TTL_MS - 1000);
    const read = rp.readPressure();
    expect(read.level).toBe("normal");
    expect(read.stale).toBe(true);
  });

  it("an unknown level value reads as normal, not a crash", () => {
    rp.publishPressure("pause", 4000, 100, 7000, "test", Date.now());
    rawDb.prepare(`UPDATE resource_pressure SET level='garbage' WHERE id=1`).run();
    expect(rp.readPressure().level).toBe("normal");
  });
});
