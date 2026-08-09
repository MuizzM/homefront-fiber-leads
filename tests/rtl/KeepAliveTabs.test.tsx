// ── Keep-alive tab stages — the tab-switch performance contract ──────────────
// Pins the four behaviors the tab-switch fix promises, against the REAL
// KeepAliveStages component (not a mirror), wired exactly like App.tsx: shell
// as a sibling of the stages, one shared Suspense, Switch driven by the
// deferred location, lazy routes through lazyRoute.
//   1. A tab switch never unmounts the shared shell / tab bar.
//   2. A previously visited tab re-renders with NO full-page skeleton and NO
//      remount (kept-alive → instant).
//   3. A tab stuck loading its chunk never blocks switching to another tab.
//   4. A tab whose DATA is slow still switches in immediately — the stage
//      swaps at once and only the tab's own content area shows loading.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { Suspense, useDeferredValue, useEffect, useRef, useState, type ComponentType } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Router, Route, Switch } from "wouter";
import { useHashLocation, navigate } from "wouter/use-hash-location";
import { lazyRoute, __resetStaleChunkForTests } from "@/lib/staleChunk";
import { KeepAliveStages } from "@/components/KeepAliveStages";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

// Mount counters — how we prove "kept alive" vs "remounted".
const mounts: Record<string, number> = {};
function Counting({ id }: { id: string }) {
  useEffect(() => {
    mounts[id] = (mounts[id] ?? 0) + 1;
  }, [id]);
  return <div data-testid={`page-${id}`}>{id} content</div>;
}

const KEEP = new Set(["/a", "/b", "/c", "/slow-data"]);

// Mirrors App.tsx: shell sibling of the stages, shared Suspense, deferred
// location driving both the stage list and each transient Switch. A
// QueryClientProvider always wraps the stages in the real app
// (PersistQueryClientProvider) — KeepAliveStages needs it for the re-show
// revalidation — so the harness provides one too (callers may pass their own
// to observe fetches).
function Harness({ routes, client }: { routes: Record<string, ComponentType>; client?: QueryClient }) {
  const [location] = useHashLocation();
  const deferred = useDeferredValue(location);
  const shellRenders = useRef(0);
  shellRenders.current += 1;
  const qcRef = useRef<QueryClient | null>(null);
  if (!qcRef.current) qcRef.current = client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qcRef.current}>
      <Router hook={useHashLocation}>
        <nav data-testid="shell-nav">shell</nav>
        <Suspense fallback={<div data-testid="page-loader" />}>
          <KeepAliveStages
            activeLocation={deferred}
            keepAlive={(loc) => KEEP.has(loc)}
            maxKept={4}
            renderStage={(loc) => (
              <ErrorBoundary resetKey={`${loc}:${String(loc === deferred)}`}>
                <Switch location={loc}>
                  {Object.entries(routes).map(([path, C]) => (
                    <Route key={path} path={path}><C /></Route>
                  ))}
                </Switch>
              </ErrorBoundary>
            )}
          />
        </Suspense>
      </Router>
    </QueryClientProvider>
  );
}

describe("keep-alive tab stages", () => {
  beforeEach(() => {
    __resetStaleChunkForTests();
    sessionStorage.clear();
    for (const k of Object.keys(mounts)) delete mounts[k];
    window.history.replaceState(null, "", "#/a");
  });

  it("a tab switch never unmounts the shared shell / tab bar", async () => {
    const A = () => <Counting id="a" />;
    const B = lazyRoute(() => Promise.resolve({ default: () => <Counting id="b" /> }));
    render(<Harness routes={{ "/a": A, "/b": B }} />);
    const shell = screen.getByTestId("shell-nav");
    act(() => { navigate("/b"); });
    await act(async () => {});
    expect(screen.getByTestId("page-b")).toBeInTheDocument();
    // Same DOM node — the shell was not remounted, only re-rendered around.
    expect(screen.getByTestId("shell-nav")).toBe(shell);
  });

  it("a previously visited tab re-shows instantly: no skeleton, no remount, old tab kept", async () => {
    const A = () => <Counting id="a" />;
    const B = lazyRoute(() => Promise.resolve({ default: () => <Counting id="b" /> }));
    render(<Harness routes={{ "/a": A, "/b": B }} />);
    expect(mounts["a"]).toBe(1);

    act(() => { navigate("/b"); });
    await act(async () => {});
    expect(screen.getByTestId("page-b")).toBeInTheDocument();
    // A's stage is hidden, not unmounted…
    expect(screen.getByTestId("page-a")).toBeInTheDocument();
    expect(screen.getByTestId("page-a").closest("[data-stage-path]")).not.toBeVisible();

    act(() => { navigate("/a"); });
    await act(async () => {});
    // …so returning is a visibility flip: same mount, visible immediately,
    // and at no point did the full-page skeleton appear.
    expect(screen.getByTestId("page-a")).toBeVisible();
    expect(mounts["a"]).toBe(1);
    expect(mounts["b"]).toBe(1);
    expect(screen.queryByTestId("page-loader")).not.toBeInTheDocument();

    // Round-trip once more — still the original mounts.
    act(() => { navigate("/b"); });
    await act(async () => {});
    expect(screen.getByTestId("page-b")).toBeVisible();
    expect(mounts["b"]).toBe(1);
  });

  it("a tab stuck loading never blocks switching to another tab", async () => {
    let resolveB: ((m: { default: ComponentType }) => void) | undefined;
    const A = () => <Counting id="a" />;
    const B = lazyRoute(() => new Promise<{ default: ComponentType }>((res) => { resolveB = res; }));
    const C = lazyRoute(() => Promise.resolve({ default: () => <Counting id="c" /> }));
    render(<Harness routes={{ "/a": A, "/b": B, "/c": C }} />);

    // Tap B — its chunk never lands. The current page stays; no skeleton.
    act(() => { navigate("/b"); });
    await act(async () => {});
    expect(screen.getByTestId("page-a")).toBeVisible();
    expect(screen.queryByTestId("page-loader")).not.toBeInTheDocument();

    // While B is still pending, tap C: it must render immediately.
    act(() => { navigate("/c"); });
    await act(async () => {});
    expect(screen.getByTestId("page-c")).toBeVisible();
    expect(screen.queryByTestId("page-loader")).not.toBeInTheDocument();

    // And back to A — instant, still the original mount.
    act(() => { navigate("/a"); });
    await act(async () => {});
    expect(screen.getByTestId("page-a")).toBeVisible();
    expect(mounts["a"]).toBe(1);

    // B's chunk finally lands much later: nothing on screen may change, and
    // no hidden stage may drag the shared boundary down to the skeleton.
    await act(async () => { resolveB?.({ default: () => <Counting id="b" /> }); });
    expect(screen.getByTestId("page-a")).toBeVisible();
    expect(screen.queryByTestId("page-loader")).not.toBeInTheDocument();
  });

  it("slow DATA: the tab switches in immediately with a local loader only", async () => {
    // A page whose layout renders instantly while its data hangs — the stage
    // must swap at once; loading stays inside the page's own content area.
    let resolveData: ((rows: string) => void) | undefined;
    const pending = new Promise<string>((res) => { resolveData = res; });
    function SlowDataPage() {
      const [data, setData] = useState<string | null>(null);
      useEffect(() => { let on = true; void pending.then((d) => { if (on) setData(d); }); return () => { on = false; }; }, []);
      return (
        <div data-testid="page-slow-data">
          <header data-testid="slow-data-header">Slow tab layout</header>
          {data == null
            ? <div data-testid="slow-data-local-loading" aria-busy="true" />
            : <div data-testid="slow-data-rows">{data}</div>}
        </div>
      );
    }
    const A = () => <Counting id="a" />;
    render(<Harness routes={{ "/a": A, "/slow-data": SlowDataPage }} />);

    act(() => { navigate("/slow-data"); });
    await act(async () => {});
    // The switch happened immediately: layout + local loader, no full-page
    // skeleton, and the shell/nav never went anywhere.
    expect(screen.getByTestId("slow-data-header")).toBeVisible();
    expect(screen.getByTestId("slow-data-local-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("page-loader")).not.toBeInTheDocument();
    expect(screen.getByTestId("shell-nav")).toBeInTheDocument();

    // Navigation stays responsive while the data hangs.
    act(() => { navigate("/a"); });
    await act(async () => {});
    expect(screen.getByTestId("page-a")).toBeVisible();

    // Data lands → returning shows rows, still the same single mount of A.
    await act(async () => { resolveData?.("rows"); });
    act(() => { navigate("/slow-data"); });
    await act(async () => {});
    expect(screen.getByTestId("slow-data-rows")).toBeVisible();
    expect(mounts["a"]).toBe(1);
  });

  it("a render error in a HIDDEN kept tab never takes down the visible tab", async () => {
    // Hidden kept stages keep rendering on state updates. Their errors must
    // stay inside their own stage boundary (App wires one per stage) — the
    // old single boundary swapped the healthy visible tab for the error card.
    let explode: (() => void) | undefined;
    function Volatile() {
      const [broken, setBroken] = useState(false);
      explode = () => setBroken(true);
      if (broken) throw new Error("hidden tab exploded");
      return <div data-testid="page-volatile">volatile</div>;
    }
    const A = () => <Counting id="a" />;
    render(<Harness routes={{ "/a": A, "/b": Volatile }} />);

    act(() => { navigate("/b"); });
    await act(async () => {});
    expect(screen.getByTestId("page-volatile")).toBeVisible();

    // Back to A; /b stays mounted hidden, then blows up in the background.
    act(() => { navigate("/a"); });
    await act(async () => {});
    expect(screen.getByTestId("page-a")).toBeVisible();
    act(() => { explode?.(); });

    // The visible tab is untouched; the error card is confined to the hidden
    // stage (and nothing full-page replaced the app).
    expect(screen.getByTestId("page-a")).toBeVisible();
    expect(screen.queryByTestId("page-loader")).not.toBeInTheDocument();
    expect(screen.getByTestId("shell-nav")).toBeInTheDocument();
  });

  it("a portaled sheet open in a kept tab hides with its tab and returns with it", async () => {
    // Radix sheets portal to document.body — a hidden stage's display:none
    // can't reach them. The ui wrappers render no portal while the owning
    // stage is hidden, so an open sheet cannot sit modally over the next tab
    // (and its body scroll/pointer locks unmount with it); it re-appears when
    // its own tab does.
    function SheetPage() {
      return (
        <div data-testid="page-sheet">
          <Sheet open>
            <SheetContent><SheetTitle>Door details</SheetTitle><div data-testid="sheet-body">sheet body</div></SheetContent>
          </Sheet>
        </div>
      );
    }
    const A = () => <Counting id="a" />;
    render(<Harness routes={{ "/a": A, "/b": SheetPage }} />);

    act(() => { navigate("/b"); });
    await act(async () => {});
    expect(screen.getByTestId("sheet-body")).toBeInTheDocument();

    // Leave the tab: the kept stage hides AND the portal content unmounts —
    // nothing floats over tab A, and the body pointer lock is gone.
    act(() => { navigate("/a"); });
    await act(async () => {});
    expect(screen.getByTestId("page-a")).toBeVisible();
    expect(screen.queryByTestId("sheet-body")).not.toBeInTheDocument();
    expect(document.body.style.pointerEvents).not.toBe("none");

    // Return: the sheet the rep left open is right where they left it.
    act(() => { navigate("/b"); });
    await act(async () => {});
    expect(screen.getByTestId("sheet-body")).toBeInTheDocument();
  });

  it("returning to a kept tab revalidates its stale queries (remount was the app's only refresh trigger)", async () => {
    // The app sets refetchOnWindowFocus:false globally and most queries have
    // no interval — before keep-alive, the remount on every visit was what
    // refreshed a tab. KeepAliveStages must replace that: re-showing an
    // already-mounted stage refetches stale mounted queries.
    let fetches = 0;
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: 0, gcTime: 300_000, refetchOnWindowFocus: false, retry: false } },
    });
    function QueryPage() {
      const q = useQuery({ queryKey: ["kept-tab-data"], queryFn: async () => { fetches += 1; return `payload-${fetches}`; } });
      return <div data-testid="page-q">{q.data ?? "loading"}</div>;
    }
    const A = () => <Counting id="a" />;
    render(<Harness routes={{ "/a": QueryPage, "/b": A }} client={qc} />);
    await waitFor(() => expect(screen.getByTestId("page-q")).toHaveTextContent("payload-1"));

    // Leave (stage stays mounted, hidden) …
    act(() => { navigate("/b"); });
    await act(async () => {});
    expect(screen.getByTestId("page-a")).toBeVisible();
    const fetchesBeforeReturn = fetches;

    // … and return: the stale query refetches WITHOUT a remount.
    act(() => { navigate("/a"); });
    await waitFor(() => expect(fetches).toBeGreaterThan(fetchesBeforeReturn));
    await waitFor(() => expect(screen.getByTestId("page-q")).toHaveTextContent(`payload-${fetches}`));
  });
});
