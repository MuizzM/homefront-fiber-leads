// The in-flight GET de-dupe vs mutations — the "my new lead vanished" race.
//
// apiRequest shares one network request among concurrent GETs of the same URL.
// A response that left the server BEFORE a mutation committed must never be
// handed to a caller who asked AFTER the mutation (an invalidation refetch):
// that is exactly how the post-create leads-list refetch was served the
// pre-create page, wiping the optimistic row until some later fetch found the
// lead again. A completed mutation therefore busts the share map — without
// aborting the underlying requests, whose original callers still get bodies.
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, apiUpload, NetworkError } from "../../client/src/lib/queryClient";

afterEach(() => vi.unstubAllGlobals());

describe("apiRequest GET share vs mutations", () => {
  it("still de-dupes concurrent GETs of the same URL into one fetch", async () => {
    let resolveShared!: (r: Response) => void;
    const fetchMock = vi.fn().mockReturnValueOnce(new Promise<Response>(r => { resolveShared = r; }));
    vi.stubGlobal("fetch", fetchMock);

    const a = apiRequest("GET", "/api/share-keeps-working");
    const b = apiRequest("GET", "/api/share-keeps-working");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveShared(new Response('{"v":1}', { status: 200 }));
    const [ra, rb] = await Promise.all([a, b]);
    expect(await ra.json()).toEqual({ v: 1 });
    expect(await rb.json()).toEqual({ v: 1 });
  });

  it("a completed mutation stops later GETs from joining a pre-mutation response", async () => {
    let resolveStale!: (r: Response) => void;
    const fetchMock = vi.fn()
      // GET #1 — left "the server" before the write; stays in flight.
      .mockImplementationOnce(() => new Promise<Response>(r => { resolveStale = r; }))
      // The mutation.
      .mockImplementationOnce(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })))
      // GET #2 — after the write; must be a REAL second network request.
      .mockImplementationOnce(() => Promise.resolve(new Response('{"v":"fresh"}', { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    const stale = apiRequest("GET", "/api/bust-on-mutation");
    await apiRequest("POST", "/api/bust-on-mutation/mutate", { a: 1 });
    const fresh = await apiRequest("GET", "/api/bust-on-mutation");

    // The post-mutation GET did not join the stale share.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await fresh.json()).toEqual({ v: "fresh" });

    // The original caller still gets its own (honestly pre-write) body.
    resolveStale(new Response('{"v":"stale"}', { status: 200 }));
    expect(await (await stale).json()).toEqual({ v: "stale" });
  });

  it("apiUpload (multipart) busts the share too - uploads mutate", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(() => { /* stale GET never settles */ }))
      .mockImplementationOnce(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })))
      .mockImplementationOnce(() => Promise.resolve(new Response('{"v":"fresh"}', { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    void apiRequest("GET", "/api/bust-on-upload").catch(() => { /* never settles */ });
    await apiUpload("/api/bust-on-upload/photo", new FormData());
    const fresh = await apiRequest("GET", "/api/bust-on-upload");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await fresh.json()).toEqual({ v: "fresh" });
  });

  it("a mutation that fails at the network still busts the share (write fate unknown)", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(() => { /* stale GET never settles */ }))
      .mockImplementationOnce(() => Promise.reject(new Error("network down")))
      .mockImplementationOnce(() => Promise.resolve(new Response('{"v":"fresh"}', { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    void apiRequest("GET", "/api/bust-on-failed-mutation").catch(() => { /* never settles */ });
    // A dead fetch is raised as NetworkError, not the platform's own TypeError:
    // Safari's message for it is the literal string "Load failed", and mutations
    // put e.message straight into a toast. The original is kept on `cause`.
    // See docs/architecture/BULK_ASSIGNMENT.md.
    const failure = await apiRequest("POST", "/api/bust-on-failed-mutation/mutate", { a: 1 })
      .then(() => null, (e) => e);
    expect(failure).toBeInstanceOf(NetworkError);
    expect(failure.message).not.toMatch(/network down/);
    expect((failure.cause as Error)?.message).toBe("network down");
    const fresh = await apiRequest("GET", "/api/bust-on-failed-mutation");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await fresh.json()).toEqual({ v: "fresh" });
  });
});
