import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateWork, currentWorkLease, purgeWork, quarantineWork } from "../../client/src/lib/workAuthority";
import { appendFieldFix, queuedFieldFixes } from "../../client/src/lib/fieldFixQueue";
import { useFieldTracking } from "../../client/src/lib/fieldTracking";
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: 10, tenantId: 1, teamMemberId: 20 } }) }));
const owner = { userId: 10, tenantId: 1, teamMemberId: 20 };
const fetchMock = vi.fn<typeof fetch>();
const gps = vi.fn();
const allowed = { tracking: true, reason: "ok", clockedIn: true, needsDisclosure: false };
const fix = { lat: 30, lng: -70, accuracyM: 10, capturedAt: "2026-09-08T12:00:00Z" };
beforeEach(() => {
  purgeWork(); localStorage.clear(); activateWork(owner, "field-session");
  fetchMock.mockReset(); gps.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: gps } });
});
afterEach(() => { purgeWork(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("location work authority", () => {
  it("does not sample before fresh server permission and ignores a late GPS callback after quarantine", async () => {
    let finish!: (res: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = renderHook(() => useFieldTracking()); expect(gps).not.toHaveBeenCalled();
    await act(async () => finish(Response.json(allowed))); await waitFor(() => expect(gps).toHaveBeenCalledTimes(1));
    const callback = gps.mock.calls[0][0];
    act(() => quarantineWork(owner, "MFA_REQUIRED"));
    act(() => callback({ coords: { latitude: 30, longitude: -70, accuracy: 5 }, timestamp: Date.now() }));
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(view.result.current.active).toBe(false); view.unmount();
  });

  it("does not resume sampling from a stale permission response after unmount", async () => {
    let finish!: (res: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = renderHook(() => useFieldTracking()); view.unmount();
    await act(async () => finish(Response.json(allowed))); expect(gps).not.toHaveBeenCalled();
  });

  it("drains an acknowledged out-of-order fix and keeps authorized sampling active", async () => {
    const lease = currentWorkLease()!; appendFieldFix(lease, fix); appendFieldFix(lease, { ...fix, capturedAt: "2026-09-08T12:01:00Z" });
    let sent = 0;
    fetchMock.mockImplementation(async url => String(url).endsWith("/me") ? Response.json(allowed)
      : Response.json(++sent === 1 ? { stored: false, reason: "out-of-order" } : { stored: true, reason: "accepted" }));
    const view = renderHook(() => useFieldTracking());
    await waitFor(() => expect(queuedFieldFixes(lease)).toBe(0));
    expect(sent).toBe(2); expect(view.result.current.active).toBe(true); view.unmount();
  });

  it("retains a throttled fix, waits for retry, and keeps sampling authorization", async () => {
    vi.useFakeTimers(); const lease = currentWorkLease()!; appendFieldFix(lease, fix); let sent = 0;
    fetchMock.mockImplementation(async url => String(url).endsWith("/me") ? Response.json(allowed)
      : Response.json(++sent === 1 ? { stored: false, reason: "rate-limited" } : { stored: true, reason: "accepted" }));
    const view = renderHook(() => useFieldTracking());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(sent).toBe(1); expect(view.result.current.active).toBe(true); expect(queuedFieldFixes(lease)).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); }); expect(sent).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
    expect(sent).toBe(2); expect(queuedFieldFixes(lease)).toBe(0); expect(view.result.current.active).toBe(true); view.unmount();
  });

  it.each(["not-clocked-in", "disclosure-outdated", "no-tenant"])("stops promptly on an authoritative tracking restriction (%s)", async reason => {
    appendFieldFix(currentWorkLease()!, fix);
    fetchMock.mockImplementation(async url => Response.json(String(url).endsWith("/me") ? allowed : { stored: false, reason }));
    const view = renderHook(() => useFieldTracking()); await waitFor(() => expect(view.result.current.reason).toBe(reason));
    expect(view.result.current.active).toBe(false); view.unmount();
  });
});

it("does not let an older permission read rearm GPS after an authoritative ping restriction", async () => {
  let permissionReads = 0; let finishPermission!: (res: Response) => void; let finishPing!: (res: Response) => void;
  appendFieldFix(currentWorkLease()!, fix);
  fetchMock.mockImplementation(url => {
    if (String(url).endsWith("/me")) {
      if (++permissionReads === 1) return Promise.resolve(Response.json(allowed));
      return new Promise(resolve => { finishPermission = resolve; });
    }
    return new Promise(resolve => { finishPing = resolve; });
  });
  const view = renderHook(() => useFieldTracking()); await waitFor(() => expect(finishPing).toBeDefined());
  act(() => view.result.current.refresh());
  await act(async () => finishPing(Response.json({ stored: false, reason: "paused" })));
  const sampled = gps.mock.calls.length;
  await act(async () => finishPermission(Response.json(allowed)));
  expect(view.result.current.active).toBe(false); expect(view.result.current.reason).toBe("paused");
  expect(gps).toHaveBeenCalledTimes(sampled); view.unmount();
});
