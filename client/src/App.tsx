import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { queryClient, persistOptions } from "@/lib/queryClient";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { lazyRoute } from "@/lib/staleChunk";
import { Lock } from "lucide-react";
import { Suspense, useCallback, useDeferredValue, useEffect } from "react";
import { can, type Capability, type Role as AppRole } from "@shared/capabilities";
import { KeepAliveStages } from "@/components/KeepAliveStages";

// Eager: the shell + the unauthenticated entry point + tiny 404.
import Layout from "@/pages/Layout";
import Login from "@/pages/Login";
import NotFound from "@/pages/not-found";
import { UpdatePrompt } from "@/components/UpdatePrompt";

// Route-level code splitting — every in-app page ships as its own lazy chunk
// (Mapbox/GL, recharts, the five scanners, etc. no longer weigh down the
// initial load). The first paint only pulls the shell + login; the landing
// page and any route the user visits are fetched on demand. Factories go
// through lazyRoute, so a chunk 404ing after a deploy reloads once into the
// new build (lib/staleChunk.ts) instead of dead-ending in the ErrorBoundary.
const Dashboard = lazyRoute(() => import("@/pages/Dashboard"));
const Today = lazyRoute(() => import("@/pages/Today"));
const PropertyDetail = lazyRoute(() => import("@/pages/PropertyDetail"));
const FollowUps = lazyRoute(() => import("@/pages/FollowUps"));
const MapView = lazyRoute(() => {
  // Kick the mapbox-gl CDN download (idempotent loader in index.html) the moment
  // the route chunk is requested instead of after it parses and the component
  // mounts — overlapping the two fetches shaves ~0.5-1.5s off time-to-map on LTE.
  (window as unknown as { __loadMapbox?: () => void }).__loadMapbox?.();
  return import("@/pages/MapView");
});
const Leads = lazyRoute(() => import("@/pages/Leads"));
// Area Console — the addressable read-and-act surface for one territory, plus
// its index. Both are pure consumers of the existing /api/territories* routes.
const Areas = lazyRoute(() => import("@/pages/Areas"));
const AreaDetail = lazyRoute(() => import("@/pages/AreaDetail"));
const Scanners = lazyRoute(() => import("@/pages/Scanners"));
const FiberIntelligence = lazyRoute(() => import("@/pages/FiberIntelligence"));
const TokenSetup = lazyRoute(() => import("@/pages/TokenSetup"));
const Team = lazyRoute(() => import("@/pages/Team"));
const StatementPage = lazyRoute(() => import("@/pages/StatementPage"));
const Leaderboard = lazyRoute(() => import("@/pages/Leaderboard"));
const Incentives = lazyRoute(() => import("@/pages/Incentives"));
const Mileage = lazyRoute(() => import("@/pages/Mileage"));
const Referrals = lazyRoute(() => import("@/pages/Referrals"));
const Messages = lazyRoute(() => import("@/pages/Messages"));
const Applications = lazyRoute(() => import("@/pages/Applications"));
const MyCommission = lazyRoute(() => import("@/pages/MyCommission"));
const CommissionConsole = lazyRoute(() => import("@/pages/CommissionConsole"));
const MyDocuments = lazyRoute(() => import("@/pages/MyDocuments"));
const TaxAndPay = lazyRoute(() => import("@/pages/TaxAndPay"));
const LiveMap = lazyRoute(() => import("@/pages/LiveMap"));
const ClockIn = lazyRoute(() => import("@/pages/ClockIn"));
const Profile = lazyRoute(() => import("@/pages/Profile"));
const Diagnostics = lazyRoute(() => import("@/pages/Diagnostics"));
const LoginActivity = lazyRoute(() => import("@/pages/LoginActivity"));
const Governance = lazyRoute(() => import("@/pages/Governance"));
const Billing = lazyRoute(() => import("@/pages/Billing"));
const SuperAdmin = lazyRoute(() => import("@/pages/SuperAdmin"));
const Training = lazyRoute(() => import("@/pages/Training"));
const Coach = lazyRoute(() => import("@/pages/Coach"));
const CallingQueue = lazyRoute(() => import("@/pages/CallingQueue"));
const CallingLead = lazyRoute(() => import("@/pages/CallingLead"));

// Radix Toast and the dismissable-layer/presence machinery behind it are ~9 KB
// gzipped, and nothing renders a toast at first paint. The toast STORE lives in
// hooks/use-toast.ts (types-only import of the primitive, so it stays cheap and
// stays in the entry), which means a toast() fired before this chunk lands is
// queued and rendered the moment it arrives — nothing is dropped.
const Toaster = lazyRoute(() => import("@/components/ui/toaster").then(m => ({ default: m.Toaster })));

// On-brand fallback shown in the content area (the sidebar shell stays put)
// while a page chunk loads — never a blank screen.
function PageLoader() {
  return (
    <div className="flex-1 overflow-hidden px-4 pt-5 md:px-6" style={{ minHeight: 0 }} data-testid="page-loader" aria-busy="true" aria-label="Loading page">
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <div className="flex items-center gap-3">
          <div className="app-skeleton h-11 w-11 rounded-2xl bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="app-skeleton h-5 w-40 rounded-lg bg-muted" />
            <div className="app-skeleton h-3 w-56 max-w-[70vw] rounded bg-muted" />
          </div>
        </div>
        <div className="app-skeleton h-36 rounded-2xl bg-muted" />
        <div className="grid grid-cols-3 gap-2">
          <div className="app-skeleton h-20 rounded-2xl bg-muted" />
          <div className="app-skeleton h-20 rounded-2xl bg-muted" />
          <div className="app-skeleton h-20 rounded-2xl bg-muted" />
        </div>
      </div>
    </div>
  );
}

// Super-admin (SaaS tenant management) is gated by identity, not just role —
// on the immutable is_super_admin column the session carries, never on a role
// list hardcoded client-side.

function hasRole(userRole: string | undefined, ...allowed: AppRole[]) {
  return allowed.includes((userRole ?? "rep") as AppRole);
}

// AUDIT FIX: denied routes used to silently redirect to "/" (which can loop for
// calling roles). Users deserve an explicit "no access" state instead of a
// mystery teleport home.
function AccessDenied() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-secondary text-muted-foreground">
        <Lock className="h-6 w-6" aria-hidden="true" />
      </div>
      <h1 className="text-lg font-semibold">No access to this area</h1>
      <p className="text-sm text-muted-foreground">Your role doesn't include this workspace. Ask your manager if you need it, or head back to your queue.</p>
      <a href="/#/" className="text-sm font-semibold text-primary underline underline-offset-4">Back to home</a>
    </div>
  );
}

function Guard({ role, allowed, children }: {
  role: string | undefined;
  allowed: AppRole[];
  children: React.ReactNode;
}) {
  if (!hasRole(role, ...allowed)) return <AccessDenied />;
  return <>{children}</>;
}

function CapabilityGuard({ role, capability, children }: {
  role: string | undefined;
  capability: Capability;
  children: React.ReactNode;
}) {
  if (!can(role, capability)) return <AccessDenied />;
  return <>{children}</>;
}

// The tabs worth keeping mounted after a visit: the heavy, constantly revisited
// surfaces where a cold remount is what users feel as the "tab switch freeze"
// (mapbox re-init on /map, chart + KPI rebuild on the dashboard, table rebuild
// on /leads). Detail routes and admin one-offs are deliberately absent - they
// are cheap, parameterized (unbounded distinct locations), or rarely revisited.
const KEEP_ALIVE_PATHS = new Set(["/today", "/map", "/leads", "/areas", "/calling", "/followups"]);
// Stage cap. Active tab + three warm ones bounds memory (a hidden MapView keeps
// its WebGL context alive); least-recently-used beyond that unmounts.
const MAX_KEPT_STAGES = 4;
// "/" renders Dashboard for office roles but is a pure <Redirect> for field and
// calling roles - a kept hidden stage holding a Redirect would re-show as an
// empty page (the redirect effect fires on MOUNT, and a kept stage never
// remounts). So "/" is kept exactly for the roles that get a real page there.
const HOME_REDIRECT_ROLES = new Set(["rep", "calling_rep", "calling_manager", "compliance_admin", "auditor"]);
function keepAliveTab(location: string, role: string | undefined): boolean {
  if (location === "/") return !HOME_REDIRECT_ROLES.has(role ?? "");
  return KEEP_ALIVE_PATHS.has(location);
}

function AppRoutes() {
  const { user, isFirstRun, loading } = useAuth();
  const [location] = useHashLocation();
  // The route stage renders from THIS value, one deferred step behind the live
  // location. wouter keeps the location in useSyncExternalStore, and React
  // hard-codes store-change re-renders to the urgent SyncLane (react-dom's
  // forceStoreRerender never consults the transition context), so the old
  // aroundNav={startTransition(...)} wrapper deferred nothing: a tap on a
  // route whose chunk was still downloading committed the PageLoader fallback
  // synchronously, tearing down the screen the rep was reading for the whole
  // fetch — seconds on field LTE, and on EVERY first visit per route right
  // after a deploy empties the chunk cache. The deferred re-render runs on a
  // transition lane, which is the one path React keeps the previous page
  // mounted and interactive on when the incoming lazy route suspends.
  const deferredLocation = useDeferredValue(location);
  // True exactly while an incoming route's chunk/render hasn't committed yet —
  // drives the hairline pending bar so a slow tap still visibly "took".
  const routePending = location !== deferredLocation;
  const role = user?.role;

  // Keep-alive policy for the stage list — stable per role so the stages
  // component's effect deps stay quiet.
  const stageKeepAlive = useCallback((loc: string) => keepAliveTab(loc, role), [role]);

  // Warm likely destinations only after the browser is idle. Save-Data and
  // slower cellular connections never prefetch the large Mapbox chunk: the
  // current screen wins the bandwidth budget on a rep's phone.
  useEffect(() => {
    if (!user) return;
    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
      deviceMemory?: number;
    }).connection;
    const fieldRole = ["rep", "team_lead", "manager", "admin", "super_admin"].includes(user.role);
    const canWarmMap = !connection?.saveData
      && !["slow-2g", "2g", "3g"].includes(connection?.effectiveType ?? "")
      && ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4) >= 4;
    const warm = () => {
      if (user.role === "calling_rep" || user.role === "calling_manager") import("@/pages/CallingQueue");
      else {
        import("@/pages/Leads");
        if (user.role === "rep") import("@/pages/Today");
        else {
          import("@/pages/Dashboard");
          // Ops roles live in Fiber Intelligence — warm its chunk on idle so the
          // workspace opens instantly. Matches the server's requireManager set
          // (admin + manager); other roles can't open /fiber, so don't spend
          // their bandwidth on it.
          if (user.role === "admin" || user.role === "manager") import("@/pages/FiberIntelligence");
        }
      }
      if (canWarmMap && fieldRole) {
        import("@/pages/MapView");
        // Warm the mapbox-gl CDN lib too, so a rep's first Field Map tap mounts
        // against an already-cached library instead of a fresh ~290KB fetch.
        (window as unknown as { __loadMapbox?: () => void }).__loadMapbox?.();
      }
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (idleWindow.requestIdleCallback) {
      const id = idleWindow.requestIdleCallback(warm, { timeout: 5000 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(warm, 3500);
    return () => window.clearTimeout(timer);
  }, [user]);

  if (loading) {
    return (
      <div className="min-h-[100dvh] bg-background px-5 pt-[max(5rem,env(safe-area-inset-top))]">
        <div className="mx-auto max-w-sm" aria-busy="true" aria-label="Loading Home Front Solutions">
          <div className="text-lg font-bold tracking-tight">Home Front</div>
          <div className="text-[11px] font-semibold tracking-[0.18em] text-primary">SOLUTIONS</div>
          <div className="app-skeleton mt-8 h-12 rounded-2xl bg-muted" />
          <div className="app-skeleton mt-3 h-12 rounded-2xl bg-muted" />
          <div className="app-skeleton mt-6 h-12 rounded-2xl bg-muted" />
        </div>
      </div>
    );
  }

  if (!user || isFirstRun) {
    return <Login />;
  }

  return (
    // Everything location-driven in the stage below — the ErrorBoundary reset,
    // the keyed remount, the Switch match — runs off deferredLocation (see its
    // comment above), so a cold chunk load keeps the outgoing page on screen.
    // Nav highlights (Layout, BottomTabs) read useHashLocation directly and
    // still flip urgently on tap; PageLoader now only appears when there is no
    // previous page to keep (cold boot / deep link) or while a stale-chunk
    // recovery reload is in flight (lib/staleChunk.ts parks the import).
    <Router hook={useHashLocation}>
      <Layout>
        {routePending && <div className="route-pending-bar" aria-hidden="true" data-testid="route-pending" />}
        <ErrorBoundary resetKey={deferredLocation}>
        <Suspense fallback={<PageLoader />}>
        {/* Keep-alive stages (see components/KeepAliveStages for the invariants
            — commit-gated kept list, inline display toggling, and why it must
            sit inside this one shared Suspense). Heavy tabs stay mounted after
            a visit, so returning is a visibility flip, not a cold remount. */}
        <KeepAliveStages
          activeLocation={deferredLocation}
          keepAlive={stageKeepAlive}
          maxKept={MAX_KEPT_STAGES}
          resetKey={`${user?.id ?? ""}:${role ?? ""}`}
          className="app-canvas app-route-stage flex-1 flex flex-col min-h-0 overflow-y-auto"
          renderStage={(loc) => (
            // Per-stage boundary: hidden kept stages keep rendering on state
            // updates, so one tab's render error must stay in ITS stage — the
            // outer boundary would swap the healthy visible tab for the error
            // card. resetKey flips with visibility so re-showing an errored
            // stage retries it (the closest analogue to the old remount).
            <ErrorBoundary resetKey={`${loc}:${String(loc === deferredLocation)}`}>
              <RouteTable location={loc} role={role} isSuperAdmin={!!user?.isSuperAdmin} />
            </ErrorBoundary>
          )}
        />
        </Suspense>
        </ErrorBoundary>
      </Layout>
    </Router>
  );
}

// The full route table, one <Switch> per mounted stage. `location` is FIXED
// per stage (a kept stage never re-matches; the stage list above decides what
// exists and what is visible), so this component's subtree is stable for the
// stage's whole lifetime.
function RouteTable({ location, role, isSuperAdmin }: {
  location: string;
  role: string | undefined;
  isSuperAdmin: boolean;
}) {
  return (
        <Switch location={location}>
          {/* ── All roles ── */}
          {/* Reps land on Today (the rep-first home); managers keep the ops Dashboard. */}
          <Route path="/">{role === "rep" ? <Redirect to="/today" />
            : role === "calling_rep" || role === "calling_manager" ? <Redirect to="/calling" />
            // Compliance/auditor roles land on the queue too: scrubbing is
            // Tracerfy's job now and enforcement is server-side, so there is no
            // separate console left to send them to — one calling surface.
            : role === "compliance_admin" || role === "auditor" ? <Redirect to="/calling" />
            : <Dashboard />}</Route>
          <Route path="/calling/lead/:id">
            <CapabilityGuard role={role} capability="calling.lead.read"><CallingLead /></CapabilityGuard>
          </Route>
          <Route path="/calling">
            <CapabilityGuard role={role} capability="calling.queue.read"><CallingQueue /></CapabilityGuard>
          </Route>
          <Route path="/today"><CapabilityGuard role={role} capability="field.app.use"><Today /></CapabilityGuard></Route>
          <Route path="/followups"><CapabilityGuard role={role} capability="field.app.use"><FollowUps /></CapabilityGuard></Route>
          {/* Folded into the single Cold Calling surface. Redirect rather than
              delete the path: it was in the field nav, so reps have it bookmarked. */}
          <Route path="/ready-to-call"><Redirect to="/calling" /></Route>
          <Route path="/lead/:id"><CapabilityGuard role={role} capability="field.app.use"><PropertyDetail /></CapabilityGuard></Route>
          <Route path="/map"><CapabilityGuard role={role} capability="field.app.use"><MapView /></CapabilityGuard></Route>
          <Route path="/leads"><CapabilityGuard role={role} capability="field.app.use"><Leads /></CapabilityGuard></Route>
          {/* Area Console. The detail route is listed first so /areas/:id can
              never be shadowed by the index as the switch grows. Both sit on
              field.app.use like the rest of the field surfaces; the lifecycle
              ACTIONS inside the detail page are separately rank-gated (and the
              server independently enforces the same ranks). */}
          <Route path="/areas/:id"><CapabilityGuard role={role} capability="field.app.use"><AreaDetail /></CapabilityGuard></Route>
          <Route path="/areas"><CapabilityGuard role={role} capability="field.app.use"><Areas /></CapabilityGuard></Route>
          <Route path="/leaderboard"><CapabilityGuard role={role} capability="field.app.use"><Leaderboard /></CapabilityGuard></Route>
          {/* Incentives — every bonus a rep can earn. Each field role sees their
              own feed + heat; the team heat leaderboard and admin approve/pay
              controls are gated inside the page and independently on the server.
              /spiffs is the surface's old path and still resolves: it is baked
              into shipped push payloads and reps' bookmarks, and a dead link is
              a worse outcome than a redirect nobody notices. */}
          <Route path="/incentives"><CapabilityGuard role={role} capability="field.app.use"><Incentives /></CapabilityGuard></Route>
          <Route path="/spiffs"><Redirect to="/incentives" /></Route>
          {/* Open to the whole field, like /leaderboard: the hub is the chat,
              the feed, and the board for everyone who works the floor. The
              MEGAPHONE inside it (composer, sent log, retraction) stays gated
              on commission.structure.manage — in the page and on the API. */}
          <Route path="/messages"><CapabilityGuard role={role} capability="field.app.use"><Messages /></CapabilityGuard></Route>
          {/* My Territory removed — everyone knocks + manages via Field Map & Leads */}
          <Route path="/my-territory">
            <Redirect to="/map" />
          </Route>
          <Route path="/clock"><CapabilityGuard role={role} capability="field.app.use"><ClockIn /></CapabilityGuard></Route>
          {/* Mileage is gated on the rep-level capability; the manager queue
              inside the page is gated separately on mileage.approve. */}
          <Route path="/mileage"><CapabilityGuard role={role} capability="mileage.submit.self"><Mileage /></CapabilityGuard></Route>
          {/* Every rep sees their own link and pipeline; the approval queue
              inside the page is gated separately on referral.approve. */}
          <Route path="/referrals"><CapabilityGuard role={role} capability="referral.read.self"><Referrals /></CapabilityGuard></Route>
          {/* Training — D2D psychology & pitch curriculum. Every field role can
              study; the manager rollup inside the page is gated separately. */}
          <Route path="/training"><CapabilityGuard role={role} capability="field.app.use"><Training /></CapabilityGuard></Route>
          {/* Coach — the field coaching engine (drill cards, field modes,
              what-to-say-next). Same capability as the Training Library. */}
          <Route path="/coach"><CapabilityGuard role={role} capability="field.app.use"><Coach /></CapabilityGuard></Route>
          {/* Legacy commission bookmarks now land in the role-appropriate,
              authoritative commission workspace. */}
          <Route path="/commissions">
            {role === "rep" ? <Redirect to="/my-commission" /> : <Redirect to="/commission-console" />}
          </Route>
          <Route path="/my-commission"><CapabilityGuard role={role} capability="commission.read.self"><MyCommission /></CapabilityGuard></Route>
          {/* A statement gets its own address so it can be linked, bookmarked and
              re-opened. It was previously reachable only as a modal inside the
              console or My Commission, which meant "send me that statement" had
              no answer. Gated on read.self only — the SERVER scopes every
              statement route to who may see that rep, so a guessed id 403s/404s
              exactly as it does for the modal. */}
          <Route path="/statements/:id">
            {(params: { id: string }) => (
              <CapabilityGuard role={role} capability="commission.read.self">
                <StatementPage statementId={Number(params.id)} />
              </CapabilityGuard>
            )}
          </Route>
          <Route path="/my-documents"><CapabilityGuard role={role} capability="onboarding.documents.read.self"><MyDocuments /></CapabilityGuard></Route>
          {/* Tax & direct deposit — the caller's OWN W-9 and bank details. Not
              capability-gated (like /profile): every authenticated user may
              manage their own pay record, and the server independently scopes
              /api/me/w9 and /api/me/bank to the session's linked rep. */}
          <Route path="/tax-and-pay" component={TaxAndPay} />
          <Route path="/commission-console">
            <Guard role={role} allowed={["admin", "manager", "team_lead"]}>
              <CommissionConsole />
            </Guard>
          </Route>
          <Route path="/profile" component={Profile} />
          <Route path="/diagnostics">
            <Guard role={role} allowed={["admin", "manager"]}><Diagnostics /></Guard>
          </Route>
          <Route path="/login-activity">
            {/* Admin/manager visibility into the org's auth trail (server
                scopes by tenant). Matches requireManager on
                /api/auth/login-attempts — the page's only data source — which
                does not admit team_lead. Widening the server would be wrong:
                the endpoint returns the whole org's auth trail. */}
            <Guard role={role} allowed={["admin", "manager"]}><LoginActivity /></Guard>
          </Route>
          <Route path="/governance">
            <Guard role={role} allowed={["admin"]}><Governance /></Guard>
          </Route>
          <Route path="/billing">
            <Guard role={role} allowed={["admin"]}><Billing /></Guard>
          </Route>

          {/* ── Team Lead + Manager + Admin ── */}
          <Route path="/team">
            <Guard role={role} allowed={["admin", "manager", "team_lead"]}>
              <Team />
            </Guard>
          </Route>

          {/* ── Scan Intelligence — market discovery. Manager+ can read the
              intelligence + deploy; only admin can start a (money-spending)
              scan, gated inside the page and on the server. ── */}
          {/* ── Fiber Intelligence — ONE consolidated map-first workspace
              (Fresh Now · Map · Coming Soon · Coverage · Operations). Replaces the
              separate city / USA / Kinetic scanners, Markets, and Sweeps pages. ── */}
          {/* Role set mirrors the server's requireManager middleware
              (server/routes.ts) — every Fiber Intelligence data endpoint allows
              exactly admin + manager, so wider client access would only render
              permanently empty tabs. */}
          <Route path="/fiber">
            <Guard role={role} allowed={["admin", "manager"]}>
              <FiberIntelligence />
            </Guard>
          </Route>
          {/* Old scanner routes redirect into the consolidated workspace (bookmarks preserved). */}
          <Route path="/markets"><Redirect to="/fiber" /></Route>
          <Route path="/sweeps"><Redirect to="/fiber" /></Route>
          <Route path="/scanner"><Redirect to="/fiber" /></Route>
          <Route path="/city-scan"><Redirect to="/fiber" /></Route>
          <Route path="/usa-scan"><Redirect to="/fiber" /></Route>
          <Route path="/kinetic-scanner"><Redirect to="/fiber" /></Route>

          {/* Deep scanner tools remain reachable directly for admins who need them. */}
          <Route path="/scanner-tools">
            <Guard role={role} allowed={["admin"]}>
              <Scanners />
            </Guard>
          </Route>
          <Route path="/live-map">
            <Guard role={role} allowed={["admin", "manager"]}>
              <LiveMap />
            </Guard>
          </Route>
          {/* ── Admin only ── */}
          <Route path="/token">
            <Guard role={role} allowed={["admin"]}>
              <TokenSetup />
            </Guard>
          </Route>
          {/* /users removed — the Team page is the one place to manage people;
              members with an email automatically get login access */}
          <Route path="/users">
            <Redirect to="/team" />
          </Route>
          <Route path="/applications">
            <Guard role={role} allowed={["admin", "manager"]}>
              <Applications />
            </Guard>
          </Route>
          <Route path="/super-admin">
            {/* Super-admin is identity-gated (matches the nav): a normal tenant
                admin who types the URL is redirected, not shown a dead shell.
                The server independently enforces requireSuperAdmin on all data.

                The immutable is_super_admin flag rides on the session user, so
                this resolves synchronously. It used to also wait on an
                /api/config/app allowlist fetch — an endpoint that no longer
                returns a list, and that 403s for every non-admin who booted
                the app. */}
            {isSuperAdmin ? <SuperAdmin /> : <Redirect to="/" />}
          </Route>

          <Route component={NotFound} />
        </Switch>
  );
}

function App() {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <AuthProvider>
        <AppRoutes />
        <Suspense fallback={null}><Toaster /></Suspense>
        <UpdatePrompt />
      </AuthProvider>
    </PersistQueryClientProvider>
  );
}

export default App;
