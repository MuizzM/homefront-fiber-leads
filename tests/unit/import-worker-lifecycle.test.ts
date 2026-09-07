// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ vendorClaim: vi.fn(), commissionClaim: vi.fn(), vendorReclaim: vi.fn(), commissionReclaim: vi.fn() }));
vi.mock("../../server/vendorOrderStore", () => ({ claimNextPendingImport: mocks.vendorClaim, reclaimStalledImports: mocks.vendorReclaim }));
vi.mock("../../server/commissionFileStore", () => ({ claimNextPendingCommissionImport: mocks.commissionClaim, reclaimStalledCommissionImports: mocks.commissionReclaim }));
import { startVendorOrderImportWorker, stopVendorOrderImportWorker } from "../../server/vendorOrderImportWorker";
import { startCommissionFileImportWorker, stopCommissionFileImportWorker } from "../../server/commissionFileImportWorker";
afterEach(() => { stopVendorOrderImportWorker(); stopCommissionFileImportWorker(); vi.useRealTimers(); });
describe("import worker timers", () => {
  it.each([
    ["vendor", startVendorOrderImportWorker, mocks.vendorClaim],
    ["commission", startCommissionFileImportWorker, mocks.commissionClaim],
  ] as const)("%s cancels boot work on stop and has one timer set after restart", async (_name, start, claim) => {
    vi.useFakeTimers();
    start().stop();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(claim).not.toHaveBeenCalled();
    const handle = start(); start(); // repeated startup is idempotent
    await vi.advanceTimersByTimeAsync(1_001);
    expect(claim).toHaveBeenCalledTimes(1);
    handle.stop(); await vi.advanceTimersByTimeAsync(30_000);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
