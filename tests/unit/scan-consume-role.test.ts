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
