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
const MapView = lazy(() => import("@/pages/MapView"));
const Leads = lazy(() => import("@/pages/Leads"));
const Scanners = lazy(() => import("@/pages/Scanners"));
const TokenSetup = lazy(() => import("@/pages/TokenSetup"));
const Team = lazy(() => import("@/pages/Team"));
const Leaderboard = lazy(() => import("@/pages/Leaderboard"));
const Applications = lazy(() => import("@/pages/Applications"));
const Commissions = lazy(() => import("@/pages/Commissions"));
const LiveMap = lazy(() => import("@/pages/LiveMap"));
const ComingSoon = lazy(() => import("@/pages/ComingSoon"));
const ClockIn = lazy(() => import("@/pages/ClockIn"));
const Profile = lazy(() => import("@/pages/Profile"));
const Diagnostics = lazy(() => import("@/pages/Diagnostics"));
const Governance = lazy(() => import("@/pages/Governance"));
const SuperAdmin = lazy(() => import("@/pages/SuperAdmin"));

// On-brand fallback shown in the content area (the sidebar shell stays put)
// while a page chunk loads — never a blank screen.
function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ minHeight: 0 }} data-testid="page-loader">
      <div className="flex flex-col items-center gap-3">
        <div className="w-11 h-11 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
          <div className="w-5 h-5 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
        </div>
        <div className="text-xs text-muted-foreground">Loading…</div>
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

  // Warm the heavy route chunks (Mapbox map, lead list) right after login so
  // the first click on Field Map / Leads is instant instead of a chunk fetch.
  useEffect(() => {
    if (!user) return;
    const t = setTimeout(() => {
      import("@/pages/MapView");
      import("@/pages/Leads");
      import("@/pages/Dashboard");
    }, 1500);
    return () => clearTimeout(t);
  }, [user]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm animate-pulse">Loading…</div>
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
        <div key={location} className="flex-1 flex flex-col min-h-0 overflow-y-auto animate-in fade-in slide-in-from-bottom-1 duration-200">
        <Switch>
          {/* ── All roles ── */}
          <Route path="/" component={Dashboard} />
          <Route path="/map" component={MapView} />
          <Route path="/leads" component={Leads} />
          <Route path="/leaderboard" component={Leaderboard} />
          {/* My Territory removed — everyone knocks + manages via Field Map & Leads */}
          <Route path="/my-territory">
            <Redirect to="/map" />
          </Route>
          <Route path="/clock" component={ClockIn} />
          <Route path="/commissions" component={Commissions} />
          <Route path="/profile" component={Profile} />
          <Route path="/diagnostics">
            <Guard role={role} allowed={["admin", "manager"]}><Diagnostics /></Guard>
          </Route>
          <Route path="/governance">
            <Guard role={role} allowed={["admin"]}><Governance /></Guard>
          </Route>

          {/* ── Team Lead + Manager + Admin ── */}
          <Route path="/team">
            <Guard role={role} allowed={["admin", "manager", "team_lead"]}>
              <Team />
            </Guard>
          </Route>

          {/* ── Scanner — admin only (scanning spends proxy money) ── */}
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
