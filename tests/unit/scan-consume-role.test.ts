import { describe, expect, it } from "vitest";
import { consumesScanRuns } from "../../server/scanConsumeRole";

describe("which processes consume scan runs", () => {
  it("single-process and one-worker rigs always consume: nobody else can", () => {
    expect(consumesScanRuns({ scanWorkers: 0, role: undefined, consumeRole: undefined })).toBe(true);
    expect(consumesScanRuns({ scanWorkers: 1, role: "control", consumeRole: "control" })).toBe(true);
  });

  it("under the cluster the control worker consumes and HTTP workers do not, by default", () => {
    expect(consumesScanRuns({ scanWorkers: 4, role: "control", consumeRole: undefined })).toBe(true);
    expect(consumesScanRuns({ scanWorkers: 4, role: "scan", consumeRole: undefined })).toBe(false);
    expect(consumesScanRuns({ scanWorkers: 4, role: "scan", consumeRole: "control" })).toBe(false);
  });

  it("SCAN_CONSUME_ROLE=all restores consumption in every worker", () => {
    expect(consumesScanRuns({ scanWorkers: 4, role: "scan", consumeRole: "all" })).toBe(true);
    expect(consumesScanRuns({ scanWorkers: 4, role: "scan", consumeRole: " ALL " })).toBe(true);
  });

  it("an unknown value fails closed to the control worker", () => {
    expect(consumesScanRuns({ scanWorkers: 4, role: "scan", consumeRole: "everyone" })).toBe(false);
  });
});

describe("thisProcessConsumesScanRuns reads the cluster env", () => {
  const saved = { SCAN_WORKERS: process.env.SCAN_WORKERS, HF_ROLE: process.env.HF_ROLE, SCAN_CONSUME_ROLE: process.env.SCAN_CONSUME_ROLE };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  };

  it("an HTTP worker under the cluster does not consume; the control worker does; single-process always does", async () => {
    const { thisProcessConsumesScanRuns } = await import("../../server/scanConsumeRole");
    try {
      process.env.SCAN_WORKERS = "4"; process.env.HF_ROLE = "scan"; delete process.env.SCAN_CONSUME_ROLE;
      expect(thisProcessConsumesScanRuns()).toBe(false);
      process.env.HF_ROLE = "control";
      expect(thisProcessConsumesScanRuns()).toBe(true);
      process.env.HF_ROLE = "scan"; process.env.SCAN_CONSUME_ROLE = "all";
      expect(thisProcessConsumesScanRuns()).toBe(true);
      process.env.SCAN_WORKERS = "0"; delete process.env.HF_ROLE; delete process.env.SCAN_CONSUME_ROLE;
      expect(thisProcessConsumesScanRuns()).toBe(true);
    } finally { restore(); }
  });
});
