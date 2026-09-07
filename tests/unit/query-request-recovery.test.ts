import { MutationObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, apiRequestIdempotent, getQueryFn, queryClient, setSessionId, invalidateRequestScope, fetchSessionJson, setUnauthorizedHandler, getStoredSessionId } from "../../client/src/lib/queryClient";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("query request recovery", () => {
  it("passes query cancellation to the network request", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await getQueryFn({ on401: "throw" })({ queryKey: ["/api/cancellable"], signal: controller.signal, client: queryClient, meta: undefined });
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("bounds the full query including a stalled response body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream())));
    const result = getQueryFn({ on401: "throw" })({ queryKey: ["/api/stalled-body"], signal: new AbortController().signal, client: queryClient, meta: undefined }).catch(error => error);
    await vi.advanceTimersByTimeAsync(30_001);
    // A bounded race makes this assertion deterministic even if fetch ignores abort.
    const settled = await Promise.race([result, Promise.resolve("still pending")]);
    expect(settled).toMatchObject({ name: "RequestTimeoutError" });
  });

  it("explains GET connection failures using the shared typed error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(apiRequest("GET", "/api/network-failed-read")).rejects.toMatchObject({ name: "NetworkError" });
  });

  it("bounds custom query body readers and aborts the underlying shared request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream()));
    vi.stubGlobal("fetch", fetchMock);
    const response = await apiRequest("GET", "/api/custom-stalled-body");
    const result = response.json().catch(error => error);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await result).toMatchObject({ name: "RequestTimeoutError" });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("does not expose proxy HTML as the user's recovery message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html><h1>Bad Gateway</h1><footer>proxy-internal-host</footer></html>", { status: 502 })));
    const error = await apiRequest("GET", "/api/proxy-error").catch(error => error);
    expect(error.message).not.toContain("proxy-internal-host");
    expect(error.message).toMatch(/try again|temporarily unavailable/i);
  });
});


describe("response and identity boundaries", () => {
  it("keeps independently readable clones without another network request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ value: 7 }));
    vi.stubGlobal("fetch", fetchMock);
    const [first, second] = await Promise.all([apiRequest("GET", "/api/shared-clones"), apiRequest("GET", "/api/shared-clones")]);
    const third = first.clone();
    expect(await Promise.all([first.json(), second.json(), third.json()])).toEqual([{ value: 7 }, { value: 7 }, { value: 7 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a late response and a delayed body reader from an old identity", async () => {
    setSessionId("old-session");
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ private: "old" }))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })));
    const body = await apiRequest("GET", "/api/old-body");
    const pending = apiRequest("GET", "/api/old-request").catch(error => error);
    setSessionId("new-session");
    finish(Response.json({ private: "old" }));
    expect(await pending).toMatchObject({ name: "AbortError" });
    await expect(body.json()).rejects.toMatchObject({ name: "AbortError" });
    setSessionId(null);
  });

  it.each(["success", "failure"])("suppresses old-account mutation callbacks after %s without replaying a write", async outcome => {
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const late = new Promise<string>((ok, fail) => { resolve = ok; reject = fail; });
    const onSuccess = vi.fn(() => queryClient.setQueryData(["private-fixture"], "old account"));
    const onError = vi.fn(() => queryClient.setQueryData(["private-fixture"], "old account"));
    const mutationFn = vi.fn(() => late);
    const observer = new MutationObserver(queryClient, { mutationFn, onSuccess, onError });
    const result = observer.mutate().catch(() => {});
    await Promise.resolve(); await Promise.resolve();
    invalidateRequestScope(); queryClient.clear();
    queryClient.setQueryData(["private-fixture"], "new account");
    if (outcome === "success") resolve("old response"); else reject(new Error("old write failed"));
    await result;
    expect(queryClient.getQueryData(["private-fixture"])).toBe("new account");
    expect(onSuccess).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    expect(mutationFn).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });
});


it("cancels an old selection's internal write retry when the request scope changes", async () => {
  vi.useFakeTimers(); setSessionId("first-retry-session");
  const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("network failed"))
    .mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  const pending = apiRequestIdempotent("POST", "/api/leads/assign-selection", { selectionId: "old-selection" }).catch(error => error);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  setSessionId("second-retry-session");
  expect(await pending).toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(8_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1].headers["x-session-id"]).toBe("first-retry-session");
  setSessionId(null);
});

it("aborts a body-reading transport immediately when its scope ends", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream()));
  vi.stubGlobal("fetch", fetchMock);
  const response = await apiRequest("GET", "/api/old-scope-body");
  const pending = response.clone().blob().catch(error => error);
  invalidateRequestScope();
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

it("boots the query client with persistence disabled when browser storage is blocked", async () => {
  vi.resetModules();
  const storage = vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("Storage blocked", "SecurityError"); });
  try {
    const module = await import("../../client/src/lib/queryClient");
    expect(await module.queryPersister.restoreClient()).toBeUndefined();
  } finally { storage.mockRestore(); }
});

it("an old-scope late 401 cannot sign out the new account", async () => {
  const expired = vi.fn(); setUnauthorizedHandler(expired); setSessionId("old-map-session");
  let finish!: (response:Response)=>void;
  vi.stubGlobal("fetch",vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;})));
  const pending = fetchSessionJson("/api/leads/map").catch(error=>error);
  setSessionId("new-map-session"); finish(new Response(null,{status:401}));
  expect(await pending).toMatchObject({name:"AbortError"});
  await Promise.resolve(); await Promise.resolve();
  expect(expired).not.toHaveBeenCalled(); expect(getStoredSessionId()).toBe("new-map-session");
  setUnauthorizedHandler(null); setSessionId(null);
});
