// ── Deferred navigation keeps the outgoing page, never the skeleton ──────────
// wouter's location lives in useSyncExternalStore, and React renders store
// changes on the urgent SyncLane — startTransition around navigate() defers
// NOTHING (react-dom's forceStoreRerender never reads the transition context),
// so routing straight off the live location commits the Suspense fallback the
// moment a cold lazy route suspends, blanking the screen for the whole chunk
// fetch. App.tsx therefore drives the route stage (Switch location, keyed
// remount) from useDeferredValue(location); the deferred re-render runs on a
// transition lane, the one path React keeps the previous page mounted on.
// This harness mirrors that exact wiring and pins the behavior.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { Suspense, useDeferredValue, type ComponentType } from "react";
import { Router, Route, Switch } from "wouter";
import { useHashLocation, navigate } from "wouter/use-hash-location";
import { lazyRoute, __resetStaleChunkForTests } from "@/lib/staleChunk";

function PageA() {
  return <div data-testid="page-a">Alpha content</div>;
}

// Mirrors App.tsx's route stage: Suspense fallback + location-keyed container
// + Switch matched against the DEFERRED location.
function Stage({ B }: { B: ComponentType }) {
  const [location] = useHashLocation();
  const deferred = useDeferredValue(location);
  return (
    <Router hook={useHashLocation}>
      <Suspense fallback={<div data-testid="page-loader" />}>
        <div key={deferred}>
          <Switch location={deferred}>
            <Route path="/a"><PageA /></Route>
            <Route path="/b"><B /></Route>
          </Switch>
        </div>
      </Suspense>
    </Router>
  );
}

describe("deferred route stage", () => {
  beforeEach(() => {
    __resetStaleChunkForTests();
    sessionStorage.clear();
    // replaceState: set the starting route without firing hashchange.
    window.history.replaceState(null, "", "#/a");
  });

  it("keeps the outgoing page on screen during a cold chunk load, then swaps — no skeleton, no delay", async () => {
    let resolveB: ((m: { default: ComponentType }) => void) | undefined;
    const B = lazyRoute(() => new Promise<{ default: ComponentType }>((res) => { resolveB = res; }));

    render(<Stage B={B} />);
    expect(screen.getByTestId("page-a")).toBeInTheDocument();

    act(() => { navigate("/b"); });

    // The /b chunk is still in flight: the old page must still be there, and
    // the Suspense fallback must NOT have replaced it.
    expect(screen.getByTestId("page-a")).toBeInTheDocument();
    expect(screen.queryByTestId("page-loader")).not.toBeInTheDocument();

    // The chunk lands → the new page commits from the resolution alone; no
    // timers to advance, no polling — an intentional delay would fail this.
    await act(async () => { resolveB!({ default: () => <div data-testid="page-b" /> }); });
    expect(screen.getByTestId("page-b")).toBeInTheDocument();
    expect(screen.queryByTestId("page-a")).not.toBeInTheDocument();
  });

  it("an already-resolved route swaps synchronously on navigation", async () => {
    const B = lazyRoute(() => Promise.resolve({ default: () => <div data-testid="page-b" /> }));
    render(<Stage B={B} />);
    // Warm the module (first suspension resolves immediately).
    act(() => { navigate("/b"); });
    await act(async () => {});
    expect(screen.getByTestId("page-b")).toBeInTheDocument();
    // Round-trip back and forth: warm chunks never surface the fallback.
    act(() => { navigate("/a"); });
    await act(async () => {});
    expect(screen.getByTestId("page-a")).toBeInTheDocument();
    act(() => { navigate("/b"); });
    await act(async () => {});
    expect(screen.getByTestId("page-b")).toBeInTheDocument();
    expect(screen.queryByTestId("page-loader")).not.toBeInTheDocument();
  });

  it("cold boot (no previous page to keep) still shows the Suspense fallback", () => {
    window.history.replaceState(null, "", "#/b");
    const B = lazyRoute(() => new Promise<{ default: ComponentType }>(() => {}));
    render(<Stage B={B} />);
    expect(screen.getByTestId("page-loader")).toBeInTheDocument();
  });
});
