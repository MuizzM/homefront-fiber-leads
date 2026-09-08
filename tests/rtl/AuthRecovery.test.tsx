import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const firstUser = { id: 101, name: "First rep", email: "first@example.test", role: "rep" as const, tenantId: 1 };
const secondUser = { id: 202, name: "Second rep", email: "second@example.test", role: "rep" as const, tenantId: 2 };
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  window.sessionStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function rememberUser() {
  localStorage.setItem("hfs.sid", "first-test-session");
  localStorage.setItem("hfs.sid.until", String(Date.now() + 60_000));
  localStorage.setItem("hfs.user", JSON.stringify(firstUser));
}

async function mountAuth() {
  const { AuthProvider, useAuth } = await import("../../client/src/lib/auth");
  function Probe() {
    const auth = useAuth();
    return <>
      <output data-testid="identity">{auth.user?.name ?? "signed out"}</output>
      <output data-testid="role">{auth.user?.role}</output>
      <output data-testid="status-error">{auth.statusError}</output>
      <button onClick={() => auth.retryStatus?.()}>Retry status</button>
      <output data-testid="loading">{String(auth.loading)}</output>
      <button onClick={() => auth.login("second-test-session", secondUser)}>Switch user</button>
      <button onClick={() => auth.login("renewed-session", firstUser)}>Sign in again</button>
      <button onClick={() => auth.login("reassigned-session", { ...firstUser, teamMemberId: 55 })}>Changed rep profile</button>
      <button onClick={() => void auth.logout()}>Sign out</button>
    </>;
  }
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => { await Promise.resolve(); });
}

describe("authentication startup and recovery", () => {
  it("shows sign-in immediately without an unnecessary anonymous status request", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await mountAuth();
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [503, { error: "Temporarily unavailable" }],
    [200, {}],
  ])("preserves a session and its offline snapshot for an inconclusive status (%s)", async (status, body) => {
    rememberUser();
    fetchMock.mockResolvedValue(Response.json(body, { status }));
    await mountAuth();
    expect(screen.getByTestId("identity")).toHaveTextContent("First rep");
    expect(localStorage.getItem("hfs.sid")).toBe("first-test-session");
  });

  it("bounds a stalled startup and opens the existing offline snapshot", async () => {
    rememberUser();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await mountAuth();
    vi.useFakeTimers();
    // Remount under the fake clock so the request deadline is controlled.
    cleanup();
    await mountAuth();
    await act(async () => { await vi.advanceTimersByTimeAsync(8_001); });
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(screen.getByTestId("identity")).toHaveTextContent("First rep");
  });

  it("ignores a late startup response after another identity signs in", async () => {
    rememberUser();
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await mountAuth();
    fireEvent.click(screen.getByText("Switch user"));
    await act(async () => { finish(Response.json({ isFirstRun: false, currentUser: firstUser })); });
    expect(screen.getByTestId("identity")).toHaveTextContent("Second rep");
    expect(localStorage.getItem("hfs.sid")).toBe("second-test-session");
  });

  it("clears local identity immediately even if server logout stalls", async () => {
    rememberUser();
    fetchMock.mockResolvedValueOnce(Response.json({ isFirstRun: false, currentUser: firstUser }));
    await mountAuth();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(screen.getByText("Sign out"));
    expect(screen.getByTestId("identity")).toHaveTextContent("signed out");
    expect(localStorage.getItem("hfs.sid")).toBeNull();
  });
});


describe("authoritative identity boundaries", () => {
  it("purges private caches and queued writes after an authoritative revocation", async () => {
    rememberUser();
    localStorage.setItem("hf.pendingNotes.v1", "private notes");
    fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: null, accessRevoked: true }));
    await mountAuth();
    expect(screen.getByTestId("identity")).toHaveTextContent("signed out");
    expect(localStorage.getItem("hfs.sid")).toBeNull();
    expect(localStorage.getItem("hf.pendingNotes.v1")).toBeNull();
  });

  it("shows recovery when a stored session has no usable offline snapshot", async () => {
    rememberUser(); localStorage.removeItem("hfs.user");
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await mountAuth();
    expect(screen.getByTestId("status-error")).toHaveTextContent("try again");
    expect(localStorage.getItem("hfs.sid")).toBe("first-test-session");
    fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: firstUser }));
    await act(async () => fireEvent.click(screen.getByText("Retry status")));
    expect(screen.getByTestId("identity")).toHaveTextContent("First rep");
  });

  it.each([false, true])("purges old scope snapshots while retaining only same-rep pending writes (reassigned=%s)", async reassigned => {
    rememberUser();
    const oldUser = { ...firstUser, role: "manager", teamMemberId: 7 };
    localStorage.setItem("hfs.user", JSON.stringify(oldUser));
    localStorage.setItem("hf.mapPinsSnapshot.old", "old pins");
    localStorage.setItem("hf.pendingNotes.v1", "pending notes");
    const { queryClient } = await import("../../client/src/lib/queryClient");
    queryClient.setQueryData(["/api/team"], ["manager-only data"]);
    fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: { ...oldUser, role: "rep", tenantId: reassigned ? 2 : 1 } }));
    await mountAuth();
    expect(queryClient.getQueryData(["/api/team"])).toBeUndefined();
    expect(localStorage.getItem("hf.mapPinsSnapshot.old")).toBeNull();
    expect(localStorage.getItem("hf.pendingNotes.v1")).toBe(reassigned ? null : "pending notes");
  });

  it("does not let an older 401 confirmation revert a newer status for the same session", async () => {
    rememberUser();
    fetchMock.mockResolvedValueOnce(Response.json({ isFirstRun: false, currentUser: { ...firstUser, role: "manager" } }));
    await mountAuth();
    const { apiRequest } = await import("../../client/src/lib/queryClient");
    const pending: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(url => String(url).endsWith("/auth/status")
      ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(Response.json({}, { status: 401 })));
    await act(async () => { await apiRequest("GET", "/api/protected").catch(() => {}); });
    fireEvent.click(screen.getByText("Retry status"));
    expect(pending).toHaveLength(2);
    await act(async () => pending[1](Response.json({ isFirstRun: false, currentUser: firstUser })));
    await act(async () => pending[0](Response.json({ isFirstRun: false, currentUser: { ...firstUser, role: "manager" } })));
    expect(screen.getByTestId("role")).toHaveTextContent("rep");
  });

  it("never overwrites another tab's newer persisted identity", async () => {
    rememberUser();
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await mountAuth();
    localStorage.setItem("hfs.sid", "second-tab-session");
    localStorage.setItem("hfs.user", JSON.stringify(secondUser));
    await act(async () => finish(Response.json({ isFirstRun: false, currentUser: firstUser })));
    expect(JSON.parse(localStorage.getItem("hfs.user")!)).toEqual(secondUser);
  });
});


describe("recoverable work quarantine", () => {
  const owner = { userId: firstUser.id, tenantId: firstUser.tenantId, teamMemberId: null };
  it.each(["Sign in again", "Switch user", "Changed rep profile"])("resumes only the exact owner (%s)", async action => {
    rememberUser();
    localStorage.setItem("hf.knockQueue.v2.101.1.none", "unsent owner work");
    localStorage.setItem("hf.mapPinsSnapshot.old", "protected pins");
    fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: null, disposition: "reauth", reason: "MFA_REQUIRED", owner }));
    await mountAuth();
    expect(screen.getByTestId("identity")).toHaveTextContent("signed out");
    expect(localStorage.getItem("hf.mapPinsSnapshot.old")).toBeNull();
    expect(localStorage.getItem("hfs.user")).toBeNull();
    expect(localStorage.getItem("hfs.sid")).toBeNull();
    expect(localStorage.getItem("hf.knockQueue.v2.101.1.none")).toBe("unsent owner work");
    expect(localStorage.getItem("hfs.work.quarantine.v1")).not.toBeNull();
    fireEvent.click(screen.getByText(action));
    expect(localStorage.getItem("hf.knockQueue.v2.101.1.none")).toBe(action === "Sign in again" ? "unsent owner work" : null);
    expect(localStorage.getItem("hfs.work.quarantine.v1")).toBeNull();
  });

  it.each(["REAUTH_REQUIRED", "DIRECTORY_INACTIVE"])("does not preserve work for generic or revoked decisions (%s)", async reason => {
    rememberUser(); localStorage.setItem("hf.pendingNotes.v2.101.1.none", "work");
    fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: null, disposition: "reauth", reason, owner }));
    await mountAuth(); expect(localStorage.getItem("hf.pendingNotes.v2.101.1.none")).toBeNull();
  });

  it("does not allow a foreign owner in a reauth response to preserve work", async () => {
    rememberUser(); localStorage.setItem("hf.pendingNotes.v2.101.1.none", "work");
    fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: null, disposition: "reauth", reason: "SESSION_EXPIRED", owner: { ...owner, tenantId: 99 } }));
    await mountAuth(); expect(localStorage.getItem("hf.pendingNotes.v2.101.1.none")).toBeNull();
  });

  it("quarantine survives reload and prevents offline snapshot authentication", async () => {
    rememberUser();
    localStorage.setItem("hfs.work.quarantine.v1", JSON.stringify({ owner, reason: "MFA_REQUIRED" }));
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await mountAuth(); expect(screen.getByTestId("identity")).toHaveTextContent("signed out");
    expect(fetchMock).not.toHaveBeenCalled(); expect(localStorage.getItem("hfs.work.quarantine.v1")).not.toBeNull();
  });

  it("retires a peer tab without deleting the newly signed-in owner's work", async () => {
    rememberUser(); fetchMock.mockResolvedValueOnce(Response.json({ isFirstRun: false, currentUser: firstUser })); await mountAuth();
    const { currentWorkLease } = await import("../../client/src/lib/workAuthority"); const oldLease = currentWorkLease()!;
    localStorage.setItem("hfs.sid", "peer-session"); localStorage.setItem("hfs.user", JSON.stringify(secondUser));
    localStorage.setItem("hfs.work.owner.v1", JSON.stringify({ owner: { userId: 202, tenantId: 2, teamMemberId: null }, sessionId: "peer-session" }));
    localStorage.setItem("hf.pendingNotes.v2.202.2.none", "peer work");
    fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: secondUser }));
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "hfs.sid", newValue: "peer-session" })));
    expect(oldLease.signal.aborted).toBe(true); expect(screen.getByTestId("identity")).toHaveTextContent("Second rep");
    expect(localStorage.getItem("hf.pendingNotes.v2.202.2.none")).toBe("peer work");
    expect(localStorage.getItem("hfs.sid")).toBe("peer-session");
  });
});

it.each([true, false])("ignores old status before a peer storage event (allowed=%s)", async allowed => {
  rememberUser(); let finish!: (response: Response) => void;
  fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; })); await mountAuth();
  localStorage.setItem("hfs.sid", "peer-session"); localStorage.setItem("hfs.user", JSON.stringify(secondUser));
  const stamp = JSON.stringify({ owner: { userId: 202, tenantId: 2, teamMemberId: null }, sessionId: "peer-session" });
  localStorage.setItem("hfs.work.owner.v1", stamp); localStorage.setItem("hf.pendingNotes.v2.202.2.none", "peer work");
  await act(async () => finish(Response.json({ isFirstRun: false, currentUser: allowed ? firstUser : null, accessRevoked: !allowed })));
  expect(localStorage.getItem("hfs.work.owner.v1")).toBe(stamp);
  expect(localStorage.getItem("hf.pendingNotes.v2.202.2.none")).toBe("peer work");
  expect(screen.getByTestId("identity")).toHaveTextContent("signed out");
});

it("keeps this tab's memory-only work through peer quarantine and same-owner sign-in", async () => {
  rememberUser(); fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: firstUser })); await mountAuth();
  const { createKnockQueue } = await import("../../client/src/lib/knockQueue");
  const owner = { userId: 101, tenantId: 1, teamMemberId: null };
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() {} };
  const queue = createKnockQueue({ owner, repId: -101, storage: broken, isOnline: () => false, post: vi.fn(), patch: vi.fn() });
  queue.stage({ leadId: 1, outcome: "not_home" });
  localStorage.setItem("hfs.work.quarantine.v1", JSON.stringify({ owner, reason: "MFA_REQUIRED" })); localStorage.removeItem("hfs.sid");
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "hfs.work.quarantine.v1" })));
  expect(queue.canCapture()).toBe(false); expect(queue.getSnapshot().pendingCount).toBe(1);
  localStorage.removeItem("hfs.work.quarantine.v1"); localStorage.setItem("hfs.sid", "peer-renewed");
  localStorage.setItem("hfs.work.owner.v1", JSON.stringify({ owner, sessionId: "peer-renewed" }));
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "hfs.sid" })));
  expect(queue.canCapture()).toBe(true); expect(queue.getSnapshot().pendingCount).toBe(1); queue.destroy();
});

it("migrates legacy work after initial recoverable denial, reload, and same-owner login", async () => {
  rememberUser();
  localStorage.setItem("hf.pendingNotes.v1", JSON.stringify({ 1: { notes: "old field note", baseUpdatedAt: null, at: 1 } }));
  fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: null, disposition: "reauth", reason: "SESSION_EXPIRED",
    owner: { userId: 101, tenantId: 1, teamMemberId: null } }));
  await mountAuth(); expect(localStorage.getItem("hfs.work.quarantine.v1")).toContain('"legacy":true');
  cleanup(); vi.resetModules(); await mountAuth();
  fireEvent.click(screen.getByText("Sign in again"));
  const { pendingNoteCount } = await import("../../client/src/lib/leadNotes");
  expect(pendingNoteCount()).toBe(1); expect(localStorage.getItem("hf.pendingNotes.v1")).toBeNull();
  expect(localStorage.getItem("hf.pendingNotes.v2.101.1.none")).toContain("old field note");
});

it.each([true, false])("a deadline quota error cannot disable the peer-session fence (allowed=%s)", async allowed => {
  await mountAuth(); const original = Storage.prototype.setItem;
  const failing = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
    if (key === "hfs.sid.until") throw new DOMException("full", "QuotaExceededError");
    return original.call(this, key, value);
  });
  fireEvent.click(screen.getByText("Sign in again")); failing.mockRestore();
  let finish!: (response: Response) => void;
  fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByText("Retry status"));
  localStorage.setItem("hfs.sid", "peer-session"); localStorage.setItem("hfs.user", JSON.stringify(secondUser));
  const stamp = JSON.stringify({ owner: { userId: 202, tenantId: 2, teamMemberId: null }, sessionId: "peer-session" });
  localStorage.setItem("hfs.work.owner.v1", stamp); localStorage.setItem("hf.pendingNotes.v2.202.2.none", "peer work");
  await act(async () => finish(Response.json({ isFirstRun: false, currentUser: allowed ? firstUser : null, accessRevoked: !allowed })));
  expect(localStorage.getItem("hfs.sid")).toBe("peer-session"); expect(localStorage.getItem("hfs.work.owner.v1")).toBe(stamp);
  expect(localStorage.getItem("hf.pendingNotes.v2.202.2.none")).toBe("peer work");
});

it("retains same-owner memory during repeated peer events without a cached user", async () => {
  rememberUser(); fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: firstUser })); await mountAuth();
  const { createKnockQueue } = await import("../../client/src/lib/knockQueue"); const owner = { userId: 101, tenantId: 1, teamMemberId: null };
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() {} };
  const queue = createKnockQueue({ owner, repId: -101, storage: broken, isOnline: () => false, post: vi.fn(), patch: vi.fn() });
  queue.stage({ leadId: 1, outcome: "not_home" });
  localStorage.setItem("hfs.sid", "peer-renewed"); localStorage.removeItem("hfs.user");
  localStorage.setItem("hfs.work.owner.v1", JSON.stringify({ owner, sessionId: "peer-renewed" }));
  const requests: Array<(response: Response) => void> = [];
  fetchMock.mockImplementation(() => new Promise(resolve => requests.push(resolve)));
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "hfs.work.owner.v1" })));
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "hfs.sid" })));
  expect(queue.getSnapshot().pendingCount).toBe(1);
  await act(async () => requests.at(-1)!(Response.json({ isFirstRun: false, currentUser: firstUser })));
  expect(queue.canCapture()).toBe(true); expect(queue.getSnapshot().pendingCount).toBe(1); queue.destroy();
});

it("keeps same-owner reauth usable after an owner-stamp quota failure while fencing peer changes", async () => {
  rememberUser(); fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: firstUser })); await mountAuth();
  const owner = { userId: 101, tenantId: 1, teamMemberId: null };
  fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: null, disposition: "reauth", reason: "MFA_REQUIRED", owner }));
  await act(async () => fireEvent.click(screen.getByText("Retry status")));
  const original = Storage.prototype.setItem;
  const failing = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
    if (key === "hfs.work.owner.v1") throw new DOMException("full", "QuotaExceededError");
    return original.call(this, key, value);
  });
  fireEvent.click(screen.getByText("Sign in again")); failing.mockRestore();
  const { currentWorkLease, isCurrentWorkLease } = await import("../../client/src/lib/workAuthority");
  const lease = currentWorkLease(); expect(lease?.sessionId).toBe("renewed-session");
  localStorage.setItem("hfs.sid", "peer-session"); expect(isCurrentWorkLease(lease)).toBe(false);
});

it("resumes preserved queues after quota fallback, then recovers that persisted state on reload", async () => {
  rememberUser(); fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: firstUser })); await mountAuth();
  const { createKnockQueue } = await import("../../client/src/lib/knockQueue"); const owner = { userId: 101, tenantId: 1, teamMemberId: null };
  const queue = createKnockQueue({ owner, repId: -101, isOnline: () => false, post: vi.fn(), patch: vi.fn() });
  queue.stage({ leadId: 1, outcome: "not_home" });
  fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: null, disposition: "reauth", reason: "MFA_REQUIRED", owner }));
  await act(async () => fireEvent.click(screen.getByText("Retry status")));
  const original = Storage.prototype.setItem;
  const failing = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
    if (key === "hfs.work.owner.v1") throw new DOMException("full", "QuotaExceededError");
    return original.call(this, key, value);
  });
  fireEvent.click(screen.getByText("Sign in again")); expect(queue.canCapture()).toBe(true); expect(queue.getSnapshot().pendingCount).toBe(1);
  failing.mockRestore(); queue.destroy(); cleanup(); vi.resetModules();
  fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: firstUser })); await mountAuth();
  expect(screen.getByTestId("identity")).toHaveTextContent("First rep");
  const { createKnockQueue: reloadedQueue } = await import("../../client/src/lib/knockQueue");
  const restored = reloadedQueue({ owner, repId: -101, isOnline: () => false, post: vi.fn(), patch: vi.fn() });
  expect(restored.canCapture()).toBe(true); expect(restored.getSnapshot().pendingCount).toBe(1); restored.destroy();
});

it("purges old memory when a peer signs out then rapidly signs in as the same owner", async () => {
  rememberUser(); fetchMock.mockResolvedValue(Response.json({ isFirstRun: false, currentUser: firstUser })); await mountAuth();
  const { createKnockQueue } = await import("../../client/src/lib/knockQueue"); const owner = { userId: 101, tenantId: 1, teamMemberId: null };
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() {} };
  const queue = createKnockQueue({ owner, repId: -101, storage: broken, isOnline: () => false, post: vi.fn(), patch: vi.fn() });
  queue.stage({ leadId: 1, outcome: "not_home" });
  localStorage.setItem("hfs.work.purge.v1", "peer-logout-tombstone");
  localStorage.setItem("hfs.sid", "peer-renewed");
  localStorage.setItem("hfs.work.owner.v1", JSON.stringify({ owner, sessionId: "peer-renewed" }));
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "hfs.sid", newValue: "peer-renewed" })));
  expect(queue.canCapture()).toBe(false);
  const replacement = createKnockQueue({ owner, repId: -101, storage: broken, isOnline: () => false, post: vi.fn(), patch: vi.fn() });
  expect(replacement.getSnapshot().pendingCount).toBe(0); replacement.destroy();
});
