// ── lazyRoute rendering contract ─────────────────────────────────────────────
// Success: the page renders as soon as the import resolves — no added latency.
// First stale import of the session: ONE reload fires and the route parks on
// the Suspense fallback (never an error-card flash) while the reload lands.
// Stale import after the session's reload is spent: the ErrorBoundary card
// with its manual "Reload screen" button is the recovery surface.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { lazyRoute, __resetStaleChunkForTests } from "@/lib/staleChunk";

function mount(Broken: React.ComponentType) {
  return render(
    <ErrorBoundary resetKey="test">
      <Suspense fallback={<div data-testid="page-loader" />}>
        <Broken />
      </Suspense>
    </ErrorBoundary>,
  );
}

describe("lazyRoute", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    reload = vi.fn();
    __resetStaleChunkForTests(reload);
  });

  it("renders the page as soon as a successful import resolves", async () => {
    const Fine = lazyRoute(() => Promise.resolve({ default: () => <div data-testid="page-ok" /> }));
    mount(Fine);
    await waitFor(() => expect(screen.getByTestId("page-ok")).toBeInTheDocument());
    expect(reload).not.toHaveBeenCalled();
  });

  it("first stale import: one reload, fallback stays parked, no error card", async () => {
    const Broken = lazyRoute(() => Promise.reject(new Error("failed to fetch chunk")));
    mount(Broken);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // Parked promise → the skeleton stays up while the reload lands; the
    // ErrorBoundary card must never flash first.
    expect(screen.getByTestId("page-loader")).toBeInTheDocument();
    expect(screen.queryByText(/needs a refresh/i)).not.toBeInTheDocument();
  });

  it("stale import after the reload was spent: ErrorBoundary card with manual reload", async () => {
    sessionStorage.setItem("hfs:stale-chunk-reloaded", "1");
    // The boundary logs the caught error; keep the test output quiet.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Broken = lazyRoute(() => Promise.reject(new Error("failed to fetch chunk")));
    mount(Broken);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /reload screen/i })).toBeInTheDocument(),
    );
    expect(reload).not.toHaveBeenCalled();
  });
});
