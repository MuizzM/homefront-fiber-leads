import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Suspense, lazy, useEffect } from "react";

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
const MapView = lazy(() => import("@/pages/MapView"));
const Leads = lazy(() => import("@/pages/Leads"));
const Scanners = lazy(() => import("@/pages/Scanners"));
const ScanIntel = lazy(() => import("@/pages/ScanIntel"));
const SweepCommand = lazy(() => import("@/pages/SweepCommand"));
const TokenSetup = lazy(() => import("@/pages/TokenSetup"));
const Team = lazy(() => import("@/pages/Team"));
const Leaderboard = lazy(() => import("@/pages/Leaderboard"));
const Applications = lazy(() => import("@/pages/Applications"));
const MyCommission = lazy(() => import("@/pages/MyCommission"));
const CommissionConsole = lazy(() => import("@/pages/CommissionConsole"));
const MyDocuments = lazy(() => import("@/pages/MyDocuments"));
const LiveMap = lazy(() => import("@/pages/LiveMap"));
const ComingSoon = lazy(() => import("@/pages/ComingSoon"));
const ClockIn = lazy(() => import("@/pages/ClockIn"));
const Profile = lazy(() => import("@/pages/Profile"));
const Diagnostics = lazy(() => import("@/pages/Diagnostics"));
const Governance = lazy(() => import("@/pages/Governance"));
const Billing = lazy(() => import("@/pages/Billing"));
const SuperAdmin = lazy(() => import("@/pages/SuperAdmin"));

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

type AppRole = "admin" | "manager" | "team_lead" | "rep";

// Super-admin (SaaS tenant management) is gated by identity, not just role.
// Mirrors the server's SUPER_ADMIN_EMAILS check and the sidebar nav gate.
const SUPER_ADMIN_EMAIL = "muizzm21@gmail.com";

function hasRole(userRole: string | undefined, ...allowed: AppRole[]) {
  return allowed.includes((userRole ?? "rep") as AppRole);
}

function Guard({ role, allowed, children }: {
  role: string | undefined;
  allowed: AppRole[];
  children: React.ReactNode;
}) {
  if (!hasRole(role, ...allowed)) return <Redirect to="/" />;
  return <>{children}</>;
}

function AppRoutes() {
  const { user, isFirstRun, loading } = useAuth();
  const [location] = useHashLocation();
  const role = user?.role;

  // Warm likely destinations only after the browser is idle. Save-Data and
  // slower cellular connections never prefetch the large Mapbox chunk: the
  // current screen wins the bandwidth budget on a rep's phone.
  useEffect(() => {
    if (!user) return;
    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
      deviceMemory?: number;
    }).connection;
    const canWarmMap = !connection?.saveData
      && !["slow-2g", "2g", "3g"].includes(connection?.effectiveType ?? "")
      && ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4) >= 4;
    const warm = () => {
      import("@/pages/Leads");
      if (user.role === "rep") import("@/pages/Today");
      else import("@/pages/Dashboard");
      if (canWarmMap) import("@/pages/MapView");
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
        <div key={location} className="app-canvas flex-1 flex flex-col min-h-0 overflow-y-auto animate-in fade-in duration-150">
        <Switch>
          {/* ── All roles ── */}
          {/* Reps land on Today (the rep-first home); managers keep the ops Dashboard. */}
          <Route path="/">{role === "rep" ? <Redirect to="/today" /> : <Dashboard />}</Route>
          <Route path="/today" component={Today} />
          <Route path="/followups" component={FollowUps} />
          <Route path="/lead/:id" component={PropertyDetail} />
          <Route path="/map" component={MapView} />
          <Route path="/leads" component={Leads} />
          <Route path="/leaderboard" component={Leaderboard} />
          {/* My Territory removed — everyone knocks + manages via Field Map & Leads */}
          <Route path="/my-territory">
            <Redirect to="/map" />
          </Route>
          <Route path="/clock" component={ClockIn} />
          {/* Legacy commission bookmarks now land in the role-appropriate,
              authoritative commission workspace. */}
          <Route path="/commissions">
            {role === "rep" ? <Redirect to="/my-commission" /> : <Redirect to="/commission-console" />}
          </Route>
          <Route path="/my-commission" component={MyCommission} />
          <Route path="/my-documents" component={MyDocuments} />
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
          <Route path="/markets">
            <Guard role={role} allowed={["admin", "manager", "team_lead"]}>
              <ScanIntel />
            </Guard>
          </Route>
          <Route path="/sweeps">
            <Guard role={role} allowed={["admin", "manager", "team_lead"]}>
              <SweepCommand />
            </Guard>
          </Route>

          {/* ── Scanner — admin only (advanced tools + token; scanning spends proxy money) ── */}
          <Route path="/scanner">
            <Guard role={role} allowed={["admin"]}>
              <Scanners />
            </Guard>
          </Route>
          <Route path="/coming-soon">
            <Guard role={role} allowed={["admin", "manager"]}>
              <ComingSoon />
            </Guard>
          </Route>
          <Route path="/live-map">
            <Guard role={role} allowed={["admin", "manager"]}>
              <LiveMap />
            </Guard>
          </Route>

          {/* Old scanner bookmarks land on the right tab of the Scanner hub */}
          <Route path="/city-scan">
            <Guard role={role} allowed={["admin"]}>
              <Scanners initialTab="city" />
            </Guard>
          </Route>
          <Route path="/usa-scan">
            <Guard role={role} allowed={["admin"]}>
              <Scanners initialTab="usa" />
            </Guard>
          </Route>
          <Route path="/cns-scanner">
            <Guard role={role} allowed={["admin"]}>
              <Scanners initialTab="cns" />
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
            {user?.email === SUPER_ADMIN_EMAIL
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
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AppRoutes />
        <Toaster />
        <UpdatePrompt />
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
