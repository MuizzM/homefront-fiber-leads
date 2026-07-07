import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Suspense, lazy } from "react";
import { Wifi } from "lucide-react";

// Eager: the shell + the unauthenticated entry point + tiny 404.
import Layout from "@/pages/Layout";
import Login from "@/pages/Login";
import NotFound from "@/pages/not-found";

// Route-level code splitting — every in-app page ships as its own lazy chunk
// (Mapbox/GL, recharts, the five scanners, etc. no longer weigh down the
// initial load). The first paint only pulls the shell + login; the landing
// page and any route the user visits are fetched on demand.
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const FiberScanner = lazy(() => import("@/pages/FiberScanner"));
const MapView = lazy(() => import("@/pages/MapView"));
const Leads = lazy(() => import("@/pages/Leads"));
const CityScanner = lazy(() => import("@/pages/CityScanner"));
const BrowserScanner = lazy(() => import("@/pages/BrowserScanner"));
const TokenSetup = lazy(() => import("@/pages/TokenSetup"));
const Team = lazy(() => import("@/pages/Team"));
const Leaderboard = lazy(() => import("@/pages/Leaderboard"));
const Users = lazy(() => import("@/pages/Users"));
const Applications = lazy(() => import("@/pages/Applications"));
const MyTerritory = lazy(() => import("@/pages/MyTerritory"));
const Commissions = lazy(() => import("@/pages/Commissions"));
const LiveMap = lazy(() => import("@/pages/LiveMap"));
const ComingSoon = lazy(() => import("@/pages/ComingSoon"));
const ClockIn = lazy(() => import("@/pages/ClockIn"));
const SuperAdmin = lazy(() => import("@/pages/SuperAdmin"));
const CnsScanner = lazy(() => import("@/pages/CnsScanner"));
const USAScanner = lazy(() => import("@/pages/USAScanner"));

// On-brand fallback shown in the content area (the sidebar shell stays put)
// while a page chunk loads — never a blank screen.
function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ minHeight: 0 }} data-testid="page-loader">
      <div className="flex flex-col items-center gap-3">
        <div className="w-11 h-11 rounded-2xl bg-primary/15 border border-primary/25 flex items-center justify-center animate-pulse">
          <Wifi className="w-5 h-5 text-primary" />
        </div>
        <div className="text-xs text-muted-foreground">Loading…</div>
      </div>
    </div>
  );
}

type AppRole = "admin" | "manager" | "team_lead" | "rep";

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
        <Switch>
          {/* ── All roles ── */}
          <Route path="/" component={Dashboard} />
          <Route path="/map" component={MapView} />
          <Route path="/leads" component={Leads} />
          <Route path="/leaderboard" component={Leaderboard} />
          <Route path="/my-territory" component={MyTerritory} />
          <Route path="/clock" component={ClockIn} />
          <Route path="/commissions" component={Commissions} />

          {/* ── Team Lead + Manager + Admin ── */}
          <Route path="/team">
            <Guard role={role} allowed={["admin", "manager", "team_lead"]}>
              <Team />
            </Guard>
          </Route>

          {/* ── Manager + Admin only ── */}
          <Route path="/scanner">
            <Guard role={role} allowed={["admin", "manager"]}>
              <FiberScanner />
            </Guard>
          </Route>
          <Route path="/browser-scan">
            <Guard role={role} allowed={["admin", "manager"]}>
              <BrowserScanner />
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

          {/* ── Admin only ── */}
          <Route path="/city-scan">
            <Guard role={role} allowed={["admin", "manager"]}>
              <CityScanner />
            </Guard>
          </Route>
          <Route path="/usa-scan">
            <Guard role={role} allowed={["admin", "manager"]}>
              <USAScanner />
            </Guard>
          </Route>
          <Route path="/cns-scanner">
            <Guard role={role} allowed={["admin", "manager"]}>
              <CnsScanner />
            </Guard>
          </Route>
          <Route path="/token">
            <Guard role={role} allowed={["admin"]}>
              <TokenSetup />
            </Guard>
          </Route>
          <Route path="/users">
            <Guard role={role} allowed={["admin"]}>
              <Users />
            </Guard>
          </Route>
          <Route path="/applications">
            <Guard role={role} allowed={["admin", "manager"]}>
              <Applications />
            </Guard>
          </Route>
          <Route path="/super-admin">
            <Guard role={role} allowed={["admin"]}>
              <SuperAdmin />
            </Guard>
          </Route>

          <Route component={NotFound} />
        </Switch>
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
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
