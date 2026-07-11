import { Link } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import {
  LayoutDashboard,
  Map,
  MapPin,
  Users,
  Menu,
  X,
  Radar,
  TrendingUp,
  Trophy,
  LogOut,
  Sun,
  Moon,
  ShieldCheck,
  Activity,
  Crown,
  Star,
  User as UserIcon,
  Globe,
  ClipboardList,
  Bell,
  DollarSign,
  Wallet,
  Banknote,
  Clock,
  Radio,
} from "lucide-react";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { BottomTabs } from "@/components/BottomTabs";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/hooks/use-theme";

// ── Brand mark — the Home Front Solutions house (teal roof, cream walls, orange
// door + path). Crisp inline SVG so it scales anywhere with no image request.
function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Home Front Solutions">
      {/* roof */}
      <path d="M24 5 L43 21 H39 L24 9 L9 21 H5 Z" fill="#3EA394" />
      {/* body */}
      <path d="M9 20 H39 V42 H9 Z" fill="#F3EEE2" stroke="#3EA394" strokeWidth="1.5" />
      {/* windows */}
      <rect x="13.5" y="25" width="4.5" height="7" rx="1" fill="#E0982F" />
      <rect x="30" y="25" width="4.5" height="7" rx="1" fill="#E0982F" />
      {/* door */}
      <path d="M21 42 V27 a3 3 0 0 1 6 0 V42 Z" fill="#E0982F" />
      {/* path to door */}
      <path d="M24 42 C22 37 27 34 24 30" stroke="#3EA394" strokeWidth="2" strokeLinecap="round" opacity="0.55" />
    </svg>
  );
}

// ── Role hierarchy helpers ────────────────────────────────────────────────────
type AppRole = "admin" | "manager" | "team_lead" | "rep";

function hasRole(userRole: string | undefined, ...allowed: AppRole[]) {
  return allowed.includes((userRole ?? "rep") as AppRole);
}

// ── Nav item definitions with per-role visibility ─────────────────────────────
type NavItem = {
  href: string;
  label: string;
  icon: React.ElementType;
  show: (role: AppRole, email?: string) => boolean;
  group?: string;
};

const NAV_ITEMS: NavItem[] = [
  // ── Core ──────────────────────────────────────────────────────────────────
  { href: "/",      label: "Dashboard",    icon: LayoutDashboard, show: () => true,                                    group: "Core" },
  { href: "/map",   label: "Field Map",    icon: Map,             show: () => true,                                    group: "Core" },
  { href: "/leads", label: "Leads",        icon: MapPin,          show: () => true,                                    group: "Core" },
  // ── Field ─────────────────────────────────────────────────────────────────
  { href: "/leaderboard",  label: "Leaderboard",  icon: Trophy,       show: () => true,                               group: "Field" },
  { href: "/clock",        label: "Field Hours",   icon: Clock,        show: () => true,                               group: "Field" },
  { href: "/my-commission",label: "My Commission", icon: Wallet,       show: () => true,                               group: "Field" },
  { href: "/commissions",  label: "Commissions",   icon: DollarSign,   show: () => true,                               group: "Field" },
  // ── Scan — market intelligence (manager+ read/deploy); Scanner=admin tools ─
  { href: "/markets",      label: "Markets",       icon: TrendingUp,   show: r => hasRole(r, "admin", "manager", "team_lead"), group: "Scan" },
  { href: "/scanner",      label: "Scan Tools",    icon: Radar,        show: r => hasRole(r, "admin"),                 group: "Scan" },
  // ── Manage — Team is the one place for people (members with email can log in)
  { href: "/team",         label: "Team",          icon: Users,        show: r => hasRole(r, "admin", "manager", "team_lead"), group: "Manage" },
  { href: "/commission-console", label: "Payroll", icon: Banknote,     show: r => hasRole(r, "admin", "manager", "team_lead"), group: "Manage" },
  { href: "/applications", label: "Applications",  icon: ClipboardList,show: r => hasRole(r, "admin", "manager"),      group: "Manage" },
  { href: "/live-map",     label: "Live Map",       icon: Radio,        show: r => hasRole(r, "admin", "manager"),      group: "Manage" },
  // ── Governance (Phase 2) ──────────────────────────────────────────────────
  { href: "/diagnostics",  label: "Diagnostics",   icon: Activity,     show: r => hasRole(r, "admin", "manager"),      group: "Governance" },
  { href: "/governance",   label: "Permissions",   icon: ShieldCheck,  show: r => hasRole(r, "admin"),                 group: "Governance" },
  // ── Admin ─────────────────────────────────────────────────────────────────
  { href: "/super-admin",  label: "SaaS Tenants",  icon: Globe,        show: (_r: string, email?: string) => email === "muizzm21@gmail.com", group: "Admin" },
];

// ── Role badge for sidebar footer ─────────────────────────────────────────────
function RoleBadge({ role }: { role: string }) {
  const map: Record<string, { label: string; color: string; Icon: React.ElementType }> = {
    admin: { label: "Admin", color: "text-orange-400", Icon: ShieldCheck },
    manager: { label: "Manager", color: "text-amber-400", Icon: Crown },
    team_lead: { label: "Team Lead", color: "text-purple-400", Icon: Star },
    rep: { label: "Sales Rep", color: "text-blue-400", Icon: UserIcon },
  };
  const { label, color, Icon } = map[role] ?? map.rep;
  return (
    <div className={`flex items-center gap-1 text-xs ${color}`}>
      <Icon className="w-3 h-3" />
      {label}
    </div>
  );
}

// ── Avatar color per role ─────────────────────────────────────────────────────
function avatarBg(role: string) {
  const map: Record<string, string> = {
    admin: "bg-orange-500",
    manager: "bg-amber-500",
    team_lead: "bg-purple-500",
    rep: "bg-blue-500",
  };
  return map[role] ?? "bg-blue-500";
}

// ── Layout ────────────────────────────────────────────────────────────────────
export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useHashLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const role = (user?.role ?? "rep") as AppRole;

  // The Field Map is FULL-BLEED for every role: no mobile header, no bottom
  // tabs, no padding — the map itself carries a floating menu button that
  // fires "hfs:open-menu" to open the sidebar drawer.
  const onMap = location === "/map";
  useEffect(() => {
    const open = () => setMobileOpen(true);
    window.addEventListener("hfs:open-menu", open);
    return () => window.removeEventListener("hfs:open-menu", open);
  }, []);

  // Territory request pending count (admin/manager only)
  const canManage = hasRole(role, "admin", "manager");
  const { data: territoryRequests } = useQuery<{ id: number; status: string }[]>({
    queryKey: ["/api/territory-requests"],
    refetchInterval: 30000,
    enabled: canManage,
  });
  const pendingTerritoryCount = (territoryRequests ?? []).filter(r => r.status === "pending").length;

  // The caller's organization — real tenant branding, not a hardcode. Falls
  // back to the Home Front Solutions brand while loading / for legacy sessions.
  const { data: tenantMe } = useQuery<{ tenant: { companyName: string; tagline: string | null; plan: string } | null }>({
    queryKey: ["/api/tenant/me"],
    staleTime: 5 * 60 * 1000,
  });
  const orgName = tenantMe?.tenant?.companyName || "Home Front Solutions";
  const orgTagline = tenantMe?.tenant?.tagline || null;

  const visibleNav = NAV_ITEMS.filter(item => item.show(role, user?.email));

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-60 bg-card border-r border-border flex flex-col transition-transform duration-200",
        "md:relative md:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-border">
          <BrandMark className="w-8 h-8 flex-shrink-0" />
          <div className="leading-tight">
            <div className="text-sm font-bold text-foreground">Home Front</div>
            <div className="text-[11px] font-medium tracking-wide text-primary">SOLUTIONS</div>
          </div>
          <button
            type="button"
            aria-label="Close navigation menu"
            className="ml-auto md:hidden inline-flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={() => setMobileOpen(false)}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Nav — grouped by section */}
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {(() => {
            const groups: string[] = [];
            const seen = new Set<string>();
            visibleNav.forEach(item => {
              const g = item.group ?? "Other";
              if (!seen.has(g)) { seen.add(g); groups.push(g); }
            });
            return groups.map(group => {
              const items = visibleNav.filter(item => (item.group ?? "Other") === group);
              return (
                <div key={group} className="mb-1">
                  <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                    {group}
                  </div>
                  {items.map(({ href, label, icon: Icon }) => {
                    const isActive = location === href;
                    const badgeCount = canManage && href === "/map" && pendingTerritoryCount > 0 ? pendingTerritoryCount : 0;
                    return (
                      <Link
                        key={href}
                        href={href}
                        onClick={() => setMobileOpen(false)}
                        className={cn(
                          "flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors",
                          isActive
                            ? "bg-secondary text-foreground"
                            : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
                        )}
                        data-testid={`nav-${label.toLowerCase().replace(/\s/g, "-")}`}
                      >
                        <Icon className={cn("w-4 h-4 flex-shrink-0", isActive && "text-primary")} />
                        <span className="flex-1 text-[13px]">{label}</span>
                        {badgeCount > 0 && (
                          <span className="min-w-[18px] h-[18px] rounded-full bg-amber-500 text-[10px] font-bold text-black flex items-center justify-center px-1">
                            {badgeCount}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              );
            });
          })()}

          {/* Territory Requests alert */}
          {canManage && pendingTerritoryCount > 0 && (
            <div className="mt-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/20">
              <div className="flex items-center gap-2 text-xs text-amber-400 font-medium">
                <Bell className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="flex-1">{pendingTerritoryCount} territory request{pendingTerritoryCount !== 1 ? "s" : ""}</span>
              </div>
            </div>
          )}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-border space-y-3">
          {/* User info */}
          <div className="flex items-center gap-2">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 ${avatarBg(role)}`}>
              {user?.name?.slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground truncate">{user?.name}</div>
              <RoleBadge role={role} />
            </div>
            <button
              onClick={toggle}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              data-testid="button-theme-toggle"
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button
              onClick={() => logout()}
              title="Sign out"
              data-testid="button-logout"
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <LogOut size={14} />
            </button>
          </div>

          <div className="text-[11px] text-muted-foreground" data-testid="org-footer">
            {orgName}{orgTagline ? ` · ${orgTagline}` : ""}
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile header — standard app chrome on every page EXCEPT the map:
            the Field Map is full-bleed (owner spec) with its own floating menu. */}
        {!onMap && (
        <header className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-card">
          <button type="button" aria-label="Open navigation menu" aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
            className="inline-flex h-11 w-11 -ml-2 items-center justify-center text-muted-foreground hover:text-foreground">
            <Menu className="w-5 h-5" aria-hidden="true" />
          </button>
          <div className="flex items-center gap-2">
            <BrandMark className="w-6 h-6" />
            <span className="text-sm font-bold">{orgName}</span>
          </div>
        </header>
        )}

        {/* pb clears the mobile tab bar (h-14 + safe area); zero on desktop and
            on the full-bleed map (no tabs there) */}
        <main className={`flex-1 overflow-hidden ${onMap ? "" : "pb-14 md:pb-0"}`} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {children}
        </main>
        {!onMap && <BottomTabs />}
      </div>
    </div>
  );
}
