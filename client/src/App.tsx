import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { queryClient, persistOptions } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { AuthProvider, useAuth } from "@/lib/auth";
import { useSuperAdminEmails, isSuperAdmin } from "@/lib/appConfig";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Suspense, lazy, useEffect } from "react";
import { can, type Capability, type Role as AppRole } from "@shared/capabilities";

// Eager: the shell + the unauthenticated entry point + tiny 404.
import Layout from "@/pages/Layout";
import Login from "@/pages/Login";
import NotFound from "@/pages/not-found";
import { UpdatePrompt } from "@/components/UpdatePrompt";

// Route-level code splitting — every in-app page ships as its own lazy chunk
// (Mapbox/GL, recharts, the five scanners, etc. no longer weigh down the
// initial load). The first paint only pulls the shell + login; the landing
// page and any route the user visits are fetched on demand.
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Today = lazy(() => import("@/pages/Today"));
const PropertyDetail = lazy(() => import("@/pages/PropertyDetail"));
const FollowUps = lazy(() => import("@/pages/FollowUps"));
const MapView = lazy(() => {
  // Kick the mapbox-gl CDN download (idempotent loader in index.html) the moment
  // the route chunk is requested instead of after it parses and the component
  // mounts — overlapping the two fetches shaves ~0.5-1.5s off time-to-map on LTE.
  (window as unknown as { __loadMapbox?: () => void }).__loadMapbox?.();
  return import("@/pages/MapView");
});
const Leads = lazy(() => import("@/pages/Leads"));
const Scanners = lazy(() => import("@/pages/Scanners"));
const FiberIntelligence = lazy(() => import("@/pages/FiberIntelligence"));
const TokenSetup = lazy(() => import("@/pages/TokenSetup"));
const Team = lazy(() => import("@/pages/Team"));
const Leaderboard = lazy(() => import("@/pages/Leaderboard"));
const Applications = lazy(() => import("@/pages/Applications"));
const MyCommission = lazy(() => import("@/pages/MyCommission"));
const CommissionConsole = lazy(() => import("@/pages/CommissionConsole"));
const MyDocuments = lazy(() => import("@/pages/MyDocuments"));
const LiveMap = lazy(() => import("@/pages/LiveMap"));
const ClockIn = lazy(() => import("@/pages/ClockIn"));
const Profile = lazy(() => import("@/pages/Profile"));
const Diagnostics = lazy(() => import("@/pages/Diagnostics"));
const Governance = lazy(() => import("@/pages/Governance"));
const Billing = lazy(() => import("@/pages/Billing"));
const SuperAdmin = lazy(() => import("@/pages/SuperAdmin"));
const CallingQueue = lazy(() => import("@/pages/CallingQueue"));
const CallingLead = lazy(() => import("@/pages/CallingLead"));
const CallingCompliance = lazy(() => import("@/pages/CallingCompliance"));

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

// Super-admin (SaaS tenant management) is gated by identity, not just role.
// Server-owned via /api/config/app — never hardcode role lists client-side.

function hasRole(userRole: string | undefined, ...allowed: AppRole[]) {
  return allowed.includes((userRole ?? "rep") as AppRole);
}

// AUDIT FIX: denied routes used to silently redirect to "/" (which can loop for
// calling roles). Users deserve an explicit "no access" state instead of a
// mystery teleport home.
function AccessDenied() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-4xl">🔒</div>
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

function AppRoutes() {
  const { user, isFirstRun, loading } = useAuth();
  const [location] = useHashLocation();
  const role = user?.role;
  const superAdminEmails = useSuperAdminEmails();

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
      else if (user.role === "compliance_admin" || user.role === "auditor") import("@/pages/CallingCompliance");
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
    <Router hook={useHashLocation}>
      <Layout>
        <ErrorBoundary resetKey={location}>
        <Suspense fallback={<PageLoader />}>
        {/* Keyed by route → each page fades/slides in for a smooth tab switch.
            Also the single scroll container for tall pages (map pages fill it). */}
        <div key={location} className="app-canvas app-route-stage flex-1 flex flex-col min-h-0 overflow-y-auto">
        <Switch>
          {/* ── All roles ── */}
          {/* Reps land on Today (the rep-first home); managers keep the ops Dashboard. */}
          <Route path="/">{role === "rep" ? <Redirect to="/today" />
            : role === "calling_rep" || role === "calling_manager" ? <Redirect to="/calling" />
            : role === "compliance_admin" || role === "auditor" ? <Redirect to="/calling/compliance" />
            : <Dashboard />}</Route>
          <Route path="/calling/lead/:id">
            <CapabilityGuard role={role} capability="calling.lead.read"><CallingLead /></CapabilityGuard>
          </Route>
          <Route path="/calling/compliance">
            <CapabilityGuard role={role} capability="calling.compliance.read"><CallingCompliance /></CapabilityGuard>
          </Route>
          <Route path="/calling">
            <CapabilityGuard role={role} capability="calling.queue.read"><CallingQueue /></CapabilityGuard>
          </Route>
          <Route path="/today"><CapabilityGuard role={role} capability="field.app.use"><Today /></CapabilityGuard></Route>
          <Route path="/followups"><CapabilityGuard role={role} capability="field.app.use"><FollowUps /></CapabilityGuard></Route>
          <Route path="/lead/:id"><CapabilityGuard role={role} capability="field.app.use"><PropertyDetail /></CapabilityGuard></Route>
          <Route path="/map"><CapabilityGuard role={role} capability="field.app.use"><MapView /></CapabilityGuard></Route>
          <Route path="/leads"><CapabilityGuard role={role} capability="field.app.use"><Leads /></CapabilityGuard></Route>
          <Route path="/leaderboard"><CapabilityGuard role={role} capability="field.app.use"><Leaderboard /></CapabilityGuard></Route>
          {/* My Territory removed — everyone knocks + manages via Field Map & Leads */}
          <Route path="/my-territory">
            <Redirect to="/map" />
          </Route>
          <Route path="/clock"><CapabilityGuard role={role} capability="field.app.use"><ClockIn /></CapabilityGuard></Route>
          {/* Legacy commission bookmarks now land in the role-appropriate,
              authoritative commission workspace. */}
          <Route path="/commissions">
            {role === "rep" ? <Redirect to="/my-commission" /> : <Redirect to="/commission-console" />}
          </Route>
          <Route path="/my-commission"><CapabilityGuard role={role} capability="commission.read.self"><MyCommission /></CapabilityGuard></Route>
          <Route path="/my-documents"><CapabilityGuard role={role} capability="onboarding.documents.read.self"><MyDocuments /></CapabilityGuard></Route>
          <Route path="/commission-console">
            <Guard role={role} allowed={["admin", "manager", "team_lead"]}>
              <CommissionConsole />
            </Guard>
          </Route>
          <Route path="/profile" component={Profile} />
          <Route path="/diagnostics">
            <Guard role={role} allowed={["admin", "manager"]}><Diagnostics /></Guard>
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
                The server independently enforces requireSuperAdmin on all data. */}
            {isSuperAdmin(user?.email, superAdminEmails)
              ? <SuperAdmin />
              : <Redirect to="/" />}
          </Route>

          <Route component={NotFound} />
        </Switch>
        </div>
        </Suspense>
        </ErrorBoundary>
      </Layout>
    </Router>
  );
}

function App() {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <AuthProvider>
        <AppRoutes />
        <Toaster />
        <UpdatePrompt />
      </AuthProvider>
    </PersistQueryClientProvider>
  );
}

export default App;
