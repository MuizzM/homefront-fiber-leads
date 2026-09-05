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
