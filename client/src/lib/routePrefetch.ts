// ── Route-chunk prefetch on navigation intent ────────────────────────────────
// Every page in App.tsx is a React.lazy() route, so its JS chunk isn't fetched
// until you click the link — the first paint of a new screen waits on a network
// round-trip for the code itself. This warms that chunk the moment a user shows
// intent (hovers/focuses/touches a nav link), so by the time they click, the
// code is already in memory and the screen renders instantly.
//
// The import specifiers here MUST match App.tsx's lazy() imports EXACTLY — Vite
// keys one chunk per dynamically-imported module, so an identical specifier
// dedupes to the same chunk lazy() will use (calling import() twice is cheap and
// idempotent; the module cache returns the in-flight/[resolved promise). Paths
// with no heavy chunk (redirects, tiny pages) are simply omitted — a miss is a
// no-op, never an error.
type Thunk = () => Promise<unknown>;

// Longest-prefix match, so "/lead/123" and "/areas/7" resolve to their base
// route's chunk. Order matters only for readability; lookup picks the longest.
const ROUTE_CHUNKS: Record<string, Thunk> = {
  "/today": () => import("@/pages/Today"),
  "/map": () => import("@/pages/MapView"),
  "/leads": () => import("@/pages/Leads"),
  "/lead/": () => import("@/pages/PropertyDetail"),
  "/followups": () => import("@/pages/FollowUps"),
  "/areas": () => import("@/pages/Areas"),
  "/leaderboard": () => import("@/pages/Leaderboard"),
  "/spiffs": () => import("@/pages/Spiffs"),
  "/training": () => import("@/pages/Training"),
  "/clock": () => import("@/pages/ClockIn"),
  "/my-commission": () => import("@/pages/MyCommission"),
  "/my-documents": () => import("@/pages/MyDocuments"),
  "/tax-and-pay": () => import("@/pages/TaxAndPay"),
  "/fiber": () => import("@/pages/FiberIntelligence"),
  "/scanner-tools": () => import("@/pages/Scanners"),
  "/team": () => import("@/pages/Team"),
  "/commission-console": () => import("@/pages/CommissionConsole"),
  "/applications": () => import("@/pages/Applications"),
  "/live-map": () => import("@/pages/LiveMap"),
  "/calling": () => import("@/pages/CallingQueue"),
  "/profile": () => import("@/pages/Profile"),
};

// Fire each chunk at most once per session — a resolved import is cached by the
// module system anyway, but skipping the repeat call avoids churn on rapid
// hover-in/hover-out over a nav rail.
const warmed = new Set<string>();

function resolveThunk(path: string): [string, Thunk] | null {
  let best: [string, Thunk] | null = null;
  for (const [prefix, thunk] of Object.entries(ROUTE_CHUNKS)) {
    if ((path === prefix || path.startsWith(prefix)) && (!best || prefix.length > best[0].length)) {
      best = [prefix, thunk];
    }
  }
  return best;
}

/** Warm the code chunk for a route href (hash-router "/foo" form). Safe to call
 *  on every hover/focus; no-op for unknown paths and already-warmed chunks. */
export function prefetchRoute(href: string | undefined | null): void {
  if (!href) return;
  const path = href.replace(/^#/, "");
  const match = resolveThunk(path);
  if (!match) return;
  const [prefix, thunk] = match;
  if (warmed.has(prefix)) return;
  warmed.add(prefix);
  // Never let a prefetch failure surface — the real navigation will retry the
  // import and show its own error boundary if the chunk is genuinely gone.
  void thunk().catch(() => warmed.delete(prefix));
}
