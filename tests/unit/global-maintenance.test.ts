// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ audit: vi.fn(), drain: vi.fn(), next: vi.fn(), stop: vi.fn(), calling: vi.fn(), tx: vi.fn(), read: vi.fn() }));
vi.mock("../../server/db", () => ({ rawDb: { prepare: () => ({ get: mocks.read }) } }));
vi.mock("../../server/interactiveDb", () => ({
  interactiveTransaction: (_db: unknown, work: () => unknown) => { mocks.tx(); return Promise.resolve(work()); },
  retrySqliteOperation: (_db: unknown, work: () => unknown) => Promise.resolve(work()),
}));
vi.mock("../../server/callingMaintenance", () => ({ startCallingMaintenance: mocks.calling }));
vi.mock("../../server/calling/store", () => ({ verifyCallingAuditIntegrity: mocks.audit }));
vi.mock("../../server/incentiveSubscriber", () => ({ drainOnce: mocks.drain, SUBSCRIBER_NAME: "incentives" }));
vi.mock("../../server/domainEventStore", () => ({ nextBatch: mocks.next }));
vi.mock("../../server/structuredLog", () => ({ structuredLog: vi.fn() }));
import { startGlobalMaintenance } from "../../server/globalMaintenance";
const result = { processed: 1, awarded: 1, reversed: 0, failed: [], deferred: [], skipped: [] };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  mocks.calling.mockResolvedValue(mocks.stop);
  mocks.audit.mockReturnValue({ invalidTenants: [], tenantsChecked: 1, eventsChecked: 2 });
  mocks.next.mockReturnValue([]); mocks.read.mockReturnValue(undefined);
  mocks.drain.mockReturnValue(result);
});
afterEach(() => vi.useRealTimers());
const yieldReal = () => new Promise(resolve => setImmediate(resolve));
describe("global maintenance ownership and progress", () => {
  it("installs no work in any cluster worker, even over six-hour timer cycles", async () => {
    const stop = await startGlobalMaintenance(true);
    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000);
    expect(mocks.calling).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.next).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled(); stop();
  });
  it("runs on the sole owner, takes no writer for idle incentives, and stops every timer", async () => {
    const stop = await startGlobalMaintenance(false);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.read).toHaveBeenCalledTimes(4);
    expect(mocks.tx).not.toHaveBeenCalled();
    const calls = mocks.next.mock.calls.length;
    stop(); await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(mocks.audit).toHaveBeenCalledTimes(2); expect(mocks.next).toHaveBeenCalledTimes(calls);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });
  it("continues past an operator-cleared event to the next payable event without a 30s delay", async () => {
    mocks.next.mockReturnValueOnce([1]).mockReturnValueOnce([2]).mockReturnValue([]);
    mocks.drain.mockReturnValueOnce({ ...result, processed: 0, awarded: 0, skipped: [1] }).mockReturnValue(result);
    const stop = await startGlobalMaintenance(false);
    await yieldReal(); await yieldReal(); await yieldReal();
    expect(mocks.drain).toHaveBeenCalledTimes(2);
    expect(mocks.drain.mock.calls.every(call => call[1] === 1)).toBe(true);
    stop();
  });
  it.each(["failed", "deferred"])("does not pass a %s event or reorder financial work", async key => {
    mocks.next.mockReturnValue([1]); mocks.drain.mockReturnValue({ ...result, [key]: [1] });
    const stop = await startGlobalMaintenance(false); await yieldReal();
    expect(mocks.drain).toHaveBeenCalledTimes(1); stop();
  });
});
