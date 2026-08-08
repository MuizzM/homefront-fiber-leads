// ── Stale-chunk recovery — reload once into the new build ────────────────────
// Every deploy replaces dist/public wholesale, so a tab still running the
// previous build asks for route chunks by hashed names that no longer exist.
// The server answers those misses with a clean 404 (server/static.ts), the
// import() rejects, and this module turns that rejection into one transparent
// reload — landing the tab on the new index.html with a live set of chunk URLs
// instead of stranding the rep on an error card.
//
// Exactly ONE reload per tab session, latched in sessionStorage: if the fresh
// page still can't load its chunks (truly offline, server mid-swap), the next
// failure falls through to the ErrorBoundary card — never a reload loop.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

const RELOADED_KEY = "hfs:stale-chunk-reloaded";

// In-page latch: once a reload is in flight, every later failure on this page
// reports "handled" so nothing throws an error card over a page that is
// already navigating away.
let reloadStarted = false;

// Seam for tests only — jsdom's location.reload is unforgeable and unmockable.
let doReload: () => void = () => window.location.reload();

/** One-shot gate. True = a recovery reload is (now) in flight, callers should
 *  swallow the failure; false = the shot is spent or storage is unusable, let
 *  the failure surface. */
export function recoverFromStaleChunk(): boolean {
  if (reloadStarted) return true;
  try {
    if (sessionStorage.getItem(RELOADED_KEY)) return false;
    sessionStorage.setItem(RELOADED_KEY, "1");
  } catch {
    // No sessionStorage (hardened privacy mode) → no way to bound the retry,
    // so never auto-reload: the ErrorBoundary's manual Reload button is the
    // safe floor.
    return false;
  }
  reloadStarted = true;
  doReload();
  return true;
}

/** Wire the recovery to Vite's build-time preload helper. The event fires for
 *  ANY failed dynamic import in the production bundle — route chunks, their
 *  CSS deps, the idle warms and hover prefetches in routePrefetch.ts.
 *  Deliberately no preventDefault: the rejection must still reach each
 *  caller's own handling (lazyRoute parks, prefetch swallows) while the
 *  reload gets underway. Never fires under `vite dev`, which is fine — dev
 *  has no hashed chunks to go stale. */
export function installStaleChunkRecovery(): void {
  window.addEventListener("vite:preloadError", () => {
    recoverFromStaleChunk();
  });
}

/** Drop-in for React.lazy on route factories. A rejection that TRIGGERS the
 *  recovery parks the promise unresolved, so the Suspense skeleton (not an
 *  error-card flash) is what's on screen while the reload lands; a rejection
 *  after the shot is spent rethrows into the ErrorBoundary as before. */
export function lazyRoute<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((err: unknown): Promise<{ default: T }> => {
      if (recoverFromStaleChunk()) return new Promise<{ default: T }>(() => {});
      throw err;
    }),
  );
}

/** Test-only: reset the in-page latch and (optionally) stub the reload. */
export function __resetStaleChunkForTests(reload?: () => void): void {
  reloadStarted = false;
  doReload = reload ?? (() => window.location.reload());
}
