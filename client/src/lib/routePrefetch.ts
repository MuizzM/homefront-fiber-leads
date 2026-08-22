// ── Route prefetch on navigation intent ──────────────────────────────────────
// Every page in App.tsx is a React.lazy() route, so its JS chunk isn't fetched
// until you click the link — the first paint of a new screen waits on a network
// round-trip for the code itself, and then a SECOND round-trip for the data the
// screen needs. This module warms both the moment a user shows intent (hovers,
// focuses, or puts a finger down on a nav target), so by the time the tap
// completes the code is in memory and the first query is already in flight.
//
// The import specifiers here MUST match App.tsx's lazy() imports EXACTLY — Vite
// keys one chunk per dynamically-imported module, so an identical specifier
// dedupes to the same chunk lazy() will use (calling import() twice is cheap and
// idempotent; the module cache returns the in-flight/resolved promise). Paths
// with no heavy chunk (redirects, tiny pages) are simply omitted — a miss is a
// no-op, never an error.
import { queryClient } from "@/lib/queryClient";
import { LEADS_LIST_DEFAULTS, leadsListQueryOptions } from "@/lib/leadsListQuery";

type Thunk = () => Promise<unknown>;

// Exact-match routes. "/" lives here and NOT in the prefix table: every path
// starts with "/", so a prefix entry would make an unknown route warm the
// dashboard chunk for no reason.
const EXACT_CHUNKS: Record<string, Thunk> = {
  "/": () => import("@/pages/Dashboard"),
};

// Longest-prefix match, so "/lead/123" and "/areas/7" resolve to the right
// chunk. "/areas/" (detail) is a longer prefix than "/areas" (index), so the
// detail page wins for "/areas/7" — that ordering is load-bearing, not cosmetic.
const PREFIX_CHUNKS: Record<string, Thunk> = {
  "/today": () => import("@/pages/Today"),
  "/map": () => import("@/pages/MapView"),
  "/leads": () => import("@/pages/Leads"),
  "/lead/": () => import("@/pages/PropertyDetail"),
  "/followups": () => import("@/pages/FollowUps"),
  "/areas": () => import("@/pages/Areas"),
  "/areas/": () => import("@/pages/AreaDetail"),
  "/leaderboard": () => import("@/pages/Leaderboard"),
  "/messages": () => import("@/pages/Messages"),
  "/incentives": () => import("@/pages/Incentives"),
  "/spiffs": () => import("@/pages/Incentives"),
  "/training": () => import("@/pages/Training"),
  "/coach": () => import("@/pages/Coach"),
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
  "/live-ops": () => import("@/pages/LiveOps"),
  "/calling": () => import("@/pages/CallingQueue"),
  "/calling/lead/": () => import("@/pages/CallingLead"),
  "/profile": () => import("@/pages/Profile"),
  "/diagnostics": () => import("@/pages/Diagnostics"),
  "/login-activity": () => import("@/pages/LoginActivity"),
  "/governance": () => import("@/pages/Governance"),
  "/billing": () => import("@/pages/Billing"),
  "/super-admin": () => import("@/pages/SuperAdmin"),
  "/token": () => import("@/pages/TokenSetup"),
  // Added with the console shell: these had nav entries (and now palette
  // rows) but no warm-up, so their first open always paid a cold chunk fetch
  // at tap time.
  "/leads/import": () => import("@/pages/ImportLeads"),
  "/metrics": () => import("@/pages/Metrics"),
  "/mileage": () => import("@/pages/Mileage"),
  "/referrals": () => import("@/pages/Referrals"),
  "/my-recoveries": () => import("@/pages/MyRecoveries"),
  "/order-recovery": () => import("@/pages/OrderRecovery"),
  "/order-imports": () => import("@/pages/OrderImports"),
  "/order-messaging": () => import("@/pages/OrderMessaging"),
  "/action-approvals": () => import("@/pages/ActionApprovals"),
  "/rulebook": () => import("@/pages/Rulebook"),
};

// ── Data warm-up ─────────────────────────────────────────────────────────────
// The chunk is only half the wait. These are the queries each screen fires on
// mount, keyed the same way the page keys them so the mounted useQuery finds a
// populated cache entry instead of starting from scratch. Single-segment keys
// only: the app's default queryFn fetches queryKey[0], so a one-element key is
// exactly the request the page will make.
//
// SAFETY: prefetch is only ever triggered from nav affordances that are already
// role-filtered (Layout's NAV_ITEMS, BottomTabs' capability-gated TABS), so a
// user can only warm endpoints they are allowed to call. Anything role-specific
// or parameterised (per-lead, per-week, per-statement) is deliberately absent —
// warming the wrong parameter is worse than not warming at all.
const ROUTE_QUERIES: Record<string, readonly string[]> = {
  // stats/saas and leaderboard are the Dashboard's other two above-the-fold
  // queries — both single-segment, both previously cold on every visit.
  "/": ["/api/stats", "/api/stats/saas", "/api/leaderboard"],
  // NO "/api/leads/map" here: Today keys its feed ["/api/leads/map",
  // "today-route"], so the bare-key warm never matched it — it just downloaded
  // the full object-format map feed into MapView's cache slot on every Today
  // tap, a few hundred KB aimed at the wrong page (and briefly able to serve
  // lens-unfiltered pins inside MapView's staleTime).
  "/today": ["/api/clock/status", "/api/followups"],
  // NO "/api/leads" here: Leads keys its list by filters + page (an 8-element
  // key with its own limit=100 fetcher), so the bare-key warm never matched —
  // it downloaded the server's default 200-row page into a slot nothing reads,
  // on every nav-intent, all session long. The real first-page key is warmed by
  // warmLeadsList() below, which cannot drift from the page's key.
  "/followups": ["/api/followups"],
  "/areas": ["/api/territories/progress"],
  "/leaderboard": ["/api/leaderboard"],
  "/incentives": ["/api/spiffs/mine"],
  "/spiffs": ["/api/spiffs/mine"],
  "/training": ["/api/training/summary"],
  "/clock": ["/api/clock/status", "/api/clock/sessions"],
  "/my-commission": ["/api/commission/statements/me/current"],
  "/my-documents": ["/api/onboarding/documents/me"],
  "/team": ["/api/team", "/api/leaderboard"],
  // NO "/messages" entry: Layout's always-mounted 30s unread-badge poll keeps
  // ["/api/chat"] fresh for everyone who can see the nav item, so a data warm
  // here would never fire — the chunk warm above is the whole win.
  "/commission-console": ["/api/commission/week-overview"],
  "/applications": ["/api/onboarding/pipeline"],
  "/calling": ["/api/v1/calling/status"],
};

// Fire each chunk/query at most once per session — a resolved import is cached
// by the module system anyway, but skipping the repeat call avoids churn on
// rapid hover-in/hover-out over a nav rail.
const warmedChunks = new Set<string>();

/** Test-only: reset the once-per-session guard between cases. */
export function __resetPrefetchForTests(): void {
  warmedChunks.clear();
  cancelPendingData();
}

function resolveThunk(path: string): [string, Thunk] | null {
  const exact = EXACT_CHUNKS[path];
  if (exact) return [path, exact];
  let best: [string, Thunk] | null = null;
  for (const [prefix, thunk] of Object.entries(PREFIX_CHUNKS)) {
    if ((path === prefix || path.startsWith(prefix)) && (!best || prefix.length > best[0].length)) {
      best = [prefix, thunk];
    }
  }
  return best;
}

function resolveQueries(path: string): readonly string[] {
  const exact = ROUTE_QUERIES[path];
  if (exact) return exact;
  let best: [string, readonly string[]] | null = null;
  for (const [prefix, keys] of Object.entries(ROUTE_QUERIES)) {
    // "/" is the dashboard's EXACT key; skip it here or it would match everything.
    if (prefix === "/") continue;
    if (path.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, keys];
  }
  return best ? best[1] : [];
}

/** The one query on Leads that isn't a bare endpoint key: its first page is
 *  keyed by filters + page and fetched with an explicit limit/offset. Key AND
 *  fetcher come from the same helper the page mounts with, so this warms the
 *  exact entry the page reads — the only way the two can't drift. staleTime
 *  mirrors the page's own (30s), so the warm no-ops precisely when the mounted
 *  query would have re-used the entry anyway. */
function warmLeadsList(): void {
  void queryClient.prefetchQuery({
    ...leadsListQueryOptions(LEADS_LIST_DEFAULTS),
    staleTime: 30_000,
  }).catch(() => {});
}

/** True when the device/connection can afford speculative DATA bytes. A rep on
 *  3G or with Data Saver on gets the screen they asked for and nothing else. */
export function canPrefetch(): boolean {
  if (typeof navigator === "undefined") return false;
  if (navigator.onLine === false) return false;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (connection?.saveData) return false;
  return !["slow-2g", "2g", "3g"].includes(connection?.effectiveType ?? "");
}

/** Route CODE chunks get a laxer gate than data: a tab's chunk is a few tens of
 *  KB, cached immutably by the SW, and each deploy rotates every hashed URL —
 *  so the reps this gate used to exclude (field LTE reads as "3g" surprisingly
 *  often) were exactly the ones paying a cold chunk fetch at TAP time on every
 *  first per-build visit. 3G can afford tens of KB off the idle path; Data
 *  Saver and 2G still mean no. Data prefetches keep the strict gate above —
 *  data is bigger and stale by the time it's read. */
export function canPrefetchRouteChunks(): boolean {
  if (typeof navigator === "undefined") return false;
  if (navigator.onLine === false) return false;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (connection?.saveData) return false;
  return !["slow-2g", "2g"].includes(connection?.effectiveType ?? "");
}

/** Warm the code chunk for a route href (hash-router "/foo" form). Safe to call
 *  on every hover/focus/pointerdown; no-op for unknown or already-warm paths. */
export function prefetchRoute(href: string | undefined | null): void {
  if (!href) return;
  const path = href.replace(/^#/, "");
  const match = resolveThunk(path);
  if (!match) return;
  const [key, thunk] = match;
  if (warmedChunks.has(key)) return;
  warmedChunks.add(key);
  // The map screen also needs the Mapbox GL library from the CDN. Kicking it
  // here overlaps that ~230KB fetch with the route chunk instead of starting it
  // only once the component mounts.
  if (key === "/map" && canPrefetch()) {
    (window as unknown as { __loadMapbox?: () => void }).__loadMapbox?.();
  }
  // Never let a prefetch failure surface — the real navigation will retry the
  // import and show its own error boundary if the chunk is genuinely gone.
  void thunk().catch(() => warmedChunks.delete(key));
}

/** Warm the queries a route fires on mount. Skipped entirely on metered or slow
 *  connections. Failures are swallowed: a failed warm just leaves the page to
 *  fetch normally when it mounts.
 *
 *  Deliberately NOT guarded by a once-per-session set the way chunks are. A
 *  chunk is immutable, so warming it twice is pointless; data goes stale, and a
 *  rep tapping Leads on their fourth trip of the shift deserves the same warm
 *  start as the first. prefetchQuery is already the right gate: it no-ops while
 *  the entry is fresh (staleTime matches the client default, so a warm entry is
 *  used as-is on mount) and de-dupes against an in-flight fetch. */
export function prefetchRouteData(href: string | undefined | null): void {
  if (!href || !canPrefetch()) return;
  const path = href.replace(/^#/, "");
  if (path.startsWith("/leads")) warmLeadsList();
  for (const url of resolveQueries(path)) {
    void queryClient.prefetchQuery({ queryKey: [url], staleTime: 60_000 }).catch(() => {});
  }
}

// Hovering is a weaker signal than a finger going down: a mouse sweeping down a
// nav rail crosses every item on its way to one of them. Chunks are warmed
// immediately on hover (cheap, cached, no server load), but DATA waits out a
// short dwell so a sweep doesn't fire a request per item it passed over.
const HOVER_DWELL_MS = 140;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPendingData(): void {
  if (hoverTimer !== null) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
}

/**
 * Handlers to spread onto a nav link/button. Hover and focus warm the chunk at
 * once and the data after a short dwell; a pointer going down means the tap is
 * happening, so both fire immediately — that still lands ~100-300ms before the
 * route renders, which is exactly the round-trip we are trying to hide.
 */
export function navIntentHandlers(href: string | undefined | null) {
  return {
    onPointerEnter: () => {
      prefetchRoute(href);
      cancelPendingData();
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        prefetchRouteData(href);
      }, HOVER_DWELL_MS);
    },
    onPointerLeave: cancelPendingData,
    // pointerdown/touchstart land 80-150ms before the click that actually
    // navigates — enough to have both the chunk and the first query in flight
    // before the route commits. Both are wired because iOS Safari is the one
    // that reliably fires touchstart; the once-per-session guards make the
    // duplicate call free.
    onPointerDown: () => {
      cancelPendingData();
      prefetchRouteAll(href);
    },
    onTouchStart: () => {
      cancelPendingData();
      prefetchRouteAll(href);
    },
    onFocus: () => {
      prefetchRoute(href);
      cancelPendingData();
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        prefetchRouteData(href);
      }, HOVER_DWELL_MS);
    },
  };
}

/** Warm code AND data for a route, right now. */
export function prefetchRouteAll(href: string | undefined | null): void {
  prefetchRoute(href);
  prefetchRouteData(href);
}
