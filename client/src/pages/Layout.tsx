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
  Wallet,
  Banknote,
  Clock,
  Radio,
  CreditCard,
  FileSignature,
  PhoneCall,
} from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { BottomTabs } from "@/components/BottomTabs";
import { PaywallBanner } from "@/components/PaywallBanner";
import { FieldStatusBar } from "@/components/FieldStatusBar";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/hooks/use-theme";
import { can, type Role as AppRole } from "@shared/capabilities";

// (BrandMark logo removed per owner — brand is now text-only wordmark.)

// ── Role hierarchy helpers ────────────────────────────────────────────────────
function hasRole(userRole: string | undefined, ...allowed: AppRole[]) {
  return allowed.includes((userRole ?? "rep") as AppRole);
}

function isFieldRole(role: AppRole): boolean {
  return hasRole(role, "rep", "team_lead", "manager", "admin", "super_admin");
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
  { href: "/",      label: "Dashboard",    icon: LayoutDashboard, show: isFieldRole,                                   group: "Core" },
  { href: "/map",   label: "Field Map",    icon: Map,             show: isFieldRole,                                   group: "Core" },
  { href: "/leads", label: "Leads",        icon: MapPin,          show: isFieldRole,                                   group: "Core" },
  // Calling is a separate, capability-gated workspace. Field-map access never
  // implies calling authority and the map never reveals a phone number.
  { href: "/calling", label: "Calling Queue", icon: PhoneCall, show: r => can(r, "calling.queue.read"), group: "Calling" },
  { href: "/calling/compliance", label: "Calling Compliance", icon: ShieldCheck, show: r => can(r, "calling.compliance.read"), group: "Calling" },
  // ── Field ─────────────────────────────────────────────────────────────────
  { href: "/leaderboard",  label: "Leaderboard",  icon: Trophy,       show: isFieldRole,                              group: "Field" },
  { href: "/clock",        label: "Field Hours",   icon: Clock,        show: isFieldRole,                              group: "Field" },
  { href: "/my-commission",label: "My Commission", icon: Wallet,       show: isFieldRole,                              group: "Field" },
  { href: "/my-documents", label: "My Documents",  icon: FileSignature,show: isFieldRole,                              group: "Field" },
  // ── Fiber Intelligence — ONE consolidated map-first workspace (Fresh Now · Map
  //    · Coming Soon · Coverage · Operations). Old Markets/Sweeps/Scanner routes
  //    redirect here. Deep scan tools stay admin-only.
  // Matches the server's requireManager set (admin + manager) — the /fiber data
  // endpoints 403 for anyone else, which would render permanently empty tabs.
  { href: "/fiber",        label: "Fiber Intelligence", icon: Radar,   show: r => hasRole(r, "admin", "manager"), group: "Fiber" },
  { href: "/scanner-tools",label: "Scan Tools",    icon: TrendingUp,   show: r => hasRole(r, "admin"),                 group: "Fiber" },
  // ── Manage — Team is the one place for people (members with email can log in)
  { href: "/team",         label: "Team",          icon: Users,        show: r => hasRole(r, "admin", "manager", "team_lead"), group: "Manage" },
  { href: "/commission-console", label: "Commissions & Pay", icon: Banknote, show: r => hasRole(r, "admin", "manager", "team_lead"), group: "Manage" },
  { href: "/applications", label: "Rep Onboarding", icon: ClipboardList,show: r => hasRole(r, "admin", "manager"),      group: "Manage" },
  { href: "/live-map",     label: "Live Map",       icon: Radio,        show: r => hasRole(r, "admin", "manager"),      group: "Manage" },
  // ── Governance (Phase 2) ──────────────────────────────────────────────────
  { href: "/diagnostics",  label: "Diagnostics",   icon: Activity,     show: r => hasRole(r, "admin", "manager"),      group: "Governance" },
  { href: "/governance",   label: "Permissions",   icon: ShieldCheck,  show: r => hasRole(r, "admin"),                 group: "Governance" },
  { href: "/billing",      label: "Billing",       icon: CreditCard,   show: r => hasRole(r, "admin"),                 group: "Governance" },
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
    calling_rep: { label: "Calling Rep", color: "text-emerald-400", Icon: PhoneCall },
    calling_manager: { label: "Calling Manager", color: "text-teal-400", Icon: PhoneCall },
    compliance_admin: { label: "Compliance Admin", color: "text-amber-400", Icon: ShieldCheck },
    auditor: { label: "Auditor", color: "text-sky-400", Icon: Activity },
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
    calling_rep: "bg-emerald-600",
    calling_manager: "bg-teal-600",
    compliance_admin: "bg-amber-600",
    auditor: "bg-sky-600",
  };
  return map[role] ?? "bg-blue-500";
}

// ── Layout ────────────────────────────────────────────────────────────────────
export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useHashLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreSheetRef = useRef<HTMLDivElement | null>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const role = (user?.role ?? "rep") as AppRole;
  // The Field Map is FULL-BLEED for every role: no mobile header, no bottom
  // tabs, no padding — the map itself carries a floating menu button that
  // fires "hfs:open-menu" to open the sidebar drawer.
  const onMap = location === "/map";
  const onCalling = location.startsWith("/calling");
  const closeMore = useCallback(() => {
    setMoreOpen(false);
    requestAnimationFrame(() => moreTriggerRef.current?.focus());
  }, []);
  useEffect(() => {
    const open = () => setMobileOpen(true);
    window.addEventListener("hfs:open-menu", open);
    return () => window.removeEventListener("hfs:open-menu", open);
  }, []);
  useEffect(() => { setMoreOpen(false); }, [location]);

  // Mobile More is a real modal bottom sheet: initial focus, Escape, and a
  // contained Tab loop. The desktop sidebar remains available from the header.
  useEffect(() => {
    if (!moreOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const sheet = moreSheetRef.current;
    const first = sheet?.querySelector<HTMLElement>("a,button");
    requestAnimationFrame(() => first?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { closeMore(); return; }
      if (event.key !== "Tab" || !sheet) return;
      const focusable = [...sheet.querySelectorAll<HTMLElement>("a,button")].filter(el => !el.hasAttribute("disabled"));
      if (!focusable.length) return;
      const head = focusable[0], tail = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === head) { event.preventDefault(); tail.focus(); }
      else if (!event.shiftKey && document.activeElement === tail) { event.preventDefault(); head.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen, closeMore]);

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
  const mobileTitle = location === "/today" || location === "/" ? "Today"
    : location === "/map" ? "Field map"
    : location === "/leads" || location.startsWith("/lead/") ? "My leads"
    : location === "/my-commission" ? "My pay"
    : location === "/clock" ? "Field hours"
    : location === "/leaderboard" ? "Leaderboard"
    : location === "/my-documents" ? "Documents"
    : location === "/followups" ? "Follow-ups"
    : location === "/my-territory" ? "My territory"
    : onCalling ? "Calling"
    : location === "/profile" ? "Profile"
    : NAV_ITEMS.find(item => item.href === location)?.label ?? orgName;

  const visibleNav = NAV_ITEMS.filter(item => item.show(role, user?.email));

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-[min(88vw,360px)] md:w-60 bg-card border-r border-border flex flex-col transition-transform duration-300 ease-out motion-reduce:duration-0",
        "md:relative md:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        {/* Wordmark — logo mark removed per owner; text-only brand */}
        <div className="flex min-h-16 items-center gap-2.5 border-b border-border px-5 py-4 pt-[max(1rem,env(safe-area-inset-top))]">
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
        <nav className="flex-1 p-3 pb-6 space-y-0.5 overflow-y-auto">
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
                  <div className="px-3 pt-3 pb-1 text-2xs font-semibold uppercase tracking-widest text-muted-foreground/50">
                    {group}
                  </div>
                  {items.map(({ href, label, icon: Icon }) => {
                    // "/" also lights on /today (App redirects rep home there);
                    // "/calling" stays lit inside a lead workspace.
                    const isActive = href === "/"
                      ? location === "/" || location === "/today"
                      : href === "/calling"
                        ? location === href || location.startsWith("/calling/lead/")
                        : location === href;
                    const badgeCount = canManage && href === "/map" && pendingTerritoryCount > 0 ? pendingTerritoryCount : 0;
                    return (
                      <Link
                        key={href}
                        href={href}
                        onClick={() => setMobileOpen(false)}
                        className={cn(
                          "relative flex min-h-11 md:min-h-0 items-center gap-3 rounded-xl md:rounded-lg px-3 py-2.5 md:py-2 text-[14px] md:text-[13px] font-medium transition-colors",
                          isActive
                            ? "bg-primary/12 text-foreground"
                            : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
                        )}
                        data-testid={`nav-${label.toLowerCase().replace(/\s/g, "-")}`}
                      >
                        {isActive && <span aria-hidden className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary" />}
                        <Icon className={cn("w-[18px] h-[18px] md:w-4 md:h-4 flex-shrink-0", isActive && "text-primary")} />
                        <span className="flex-1">{label}</span>
                        {badgeCount > 0 && (
                          <span className="min-w-[18px] h-[18px] rounded-full bg-amber-500 text-2xs font-bold text-black flex items-center justify-center px-1">
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

        {/* Footer — account card */}
        <div className="p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-border space-y-2">
          <div className="flex items-center gap-2.5 rounded-xl border border-border bg-secondary/40 px-2.5 py-2">
            <Link
              href="/profile"
              onClick={() => setMobileOpen(false)}
              data-testid="link-profile"
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg -mx-1 -my-0.5 px-1 py-0.5 hover:bg-secondary transition-colors"
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 ${avatarBg(role)}`}>
                {user?.name?.slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-foreground truncate">{user?.name}</div>
                <RoleBadge role={role} />
              </div>
            </Link>
            <button
              onClick={toggle}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              data-testid="button-theme-toggle"
              className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button
              onClick={() => logout()}
              title="Sign out"
              data-testid="button-logout"
              className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <LogOut size={14} />
            </button>
          </div>

          <div className="px-1 text-[11px] text-muted-foreground" data-testid="org-footer">
            {orgName}{orgTagline ? ` · ${orgTagline}` : ""}
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px] md:hidden animate-in fade-in duration-200 motion-reduce:duration-0" onClick={() => setMobileOpen(false)} />
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile header — standard app chrome on every page EXCEPT the map:
            the Field Map is full-bleed (owner spec) with its own floating menu. */}
        {!onMap && (
        <header
          className="md:hidden sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-border/70 bg-card/80 px-3 backdrop-blur-xl supports-[backdrop-filter]:bg-card/70"
          style={{ paddingTop: "calc(env(safe-area-inset-top) + 12px)", paddingBottom: "8px" }}
        >
          <button type="button" aria-label="Open navigation menu" aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground">
            <Menu className="w-[19px] h-[19px]" aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold tracking-tight text-foreground">{mobileTitle}</div>
            {mobileTitle !== orgName && (
              <div className="truncate text-2xs text-muted-foreground">{orgName}</div>
            )}
          </div>
          <button type="button" aria-label="Open account menu" aria-expanded={moreOpen} aria-controls="mobile-more-sheet"
            onClick={() => { setMobileOpen(false); setMoreOpen(true); }}
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white ring-2 ring-border ${avatarBg(role)}`}>
            {user?.name?.slice(0, 2).toUpperCase()}
          </button>
        </header>
        )}

        {/* Billing status — renders only when a provisioned tenant has a problem
            (past_due / suspended / low credits); invisible otherwise. */}
        <PaywallBanner />
        {!onCalling && <FieldStatusBar overlay={onMap} />}

        {/* Standard pages reserve space for the field tab bar. The map stays
            full-bleed and uses its own floating menu and map controls. */}
        <main className={`flex-1 overflow-hidden ${onMap || onCalling ? "" : "pb-[calc(70px+env(safe-area-inset-bottom))] md:pb-0"}`} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {children}
        </main>
        {!onMap && !onCalling && <BottomTabs role={role} moreOpen={moreOpen} moreButtonRef={moreTriggerRef} onMore={() => { setMobileOpen(false); setMoreOpen(true); }} />}
      </div>

      {/* The More sheet renders wherever the header does (everywhere but the
          full-bleed map) — on calling pages the header avatar is its only
          entry point, so it must not be gated behind !onCalling. */}
      {moreOpen && !onMap && (
        <div className="fixed inset-0 z-[60] md:hidden" role="presentation">
          <button type="button" aria-label="Close more menu" className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={closeMore} />
          <div
            id="mobile-more-sheet"
            ref={moreSheetRef}
            role="dialog"
            aria-modal="true"
            aria-label="More navigation"
            className="absolute inset-x-0 bottom-0 max-h-[86dvh] overflow-y-auto rounded-t-[28px] border-t border-border bg-card shadow-2xl animate-in slide-in-from-bottom duration-300 ease-out motion-reduce:duration-0"
            style={{ paddingBottom: "max(1rem,env(safe-area-inset-bottom))" }}
          >
            <div className="sticky top-0 z-10 bg-card/95 px-4 pb-3 pt-2 backdrop-blur-xl">
              <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-muted-foreground/25" aria-hidden="true" />
              <div className="flex items-center gap-3">
                <div className={`grid h-11 w-11 place-items-center rounded-full text-sm font-bold text-white ${avatarBg(role)}`}>{user?.name?.slice(0, 2).toUpperCase()}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-semibold text-foreground">{user?.name}</div>
                  <div className="truncate text-[12px] text-muted-foreground">{orgName} · {role.replace("_", " ")}</div>
                </div>
                <button type="button" onClick={closeMore} aria-label="Close more menu" className="grid h-11 w-11 place-items-center rounded-full bg-secondary text-muted-foreground hover:text-foreground">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="px-4 pb-4">
              <div className="grid grid-cols-2 gap-2">
                {visibleNav
                  .filter(item => !["/", "/today", "/leads", "/map", "/my-commission"].includes(item.href))
                  .map(({ href, label, icon: Icon }) => (
                    <Link key={href} href={href} onClick={() => setMoreOpen(false)} className="flex min-h-[68px] items-center gap-3 rounded-2xl border border-border bg-background/55 px-3.5 py-3 text-left active:scale-[.98] transition hover:border-primary/25">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-secondary text-primary"><Icon className="h-[19px] w-[19px]" /></span>
                      <span className="min-w-0 text-[13px] font-semibold leading-tight text-foreground">{label}</span>
                    </Link>
                  ))}
              </div>

              <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-background/45">
                <Link href="/profile" onClick={() => setMoreOpen(false)} className="flex min-h-12 items-center gap-3 px-4 text-[13px] font-medium text-foreground hover:bg-secondary/60">
                  <UserIcon className="h-4 w-4 text-muted-foreground" /><span className="flex-1">Profile and account</span>
                </Link>
                <button type="button" onClick={toggle} className="flex min-h-12 w-full items-center gap-3 border-t border-border px-4 text-left text-[13px] font-medium text-foreground hover:bg-secondary/60">
                  {theme === "dark" ? <Sun className="h-4 w-4 text-muted-foreground" /> : <Moon className="h-4 w-4 text-muted-foreground" />}
                  <span className="flex-1">Switch to {theme === "dark" ? "light" : "dark"} mode</span>
                </button>
                <button type="button" onClick={() => { setMoreOpen(false); void logout(); }} className="flex min-h-12 w-full items-center gap-3 border-t border-border px-4 text-left text-[13px] font-medium text-red-500 hover:bg-red-500/5">
                  <LogOut className="h-4 w-4" /><span className="flex-1">Sign out</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
