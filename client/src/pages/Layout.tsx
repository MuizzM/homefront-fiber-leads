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
  GraduationCap,
  Gift,
  LayoutGrid,
  Zap,
  MessagesSquare,
  Car,
  UserPlus,
  LifeBuoy,
  PackageSearch,
  FileUp,
  Send,
  BarChart3,
  Lightbulb,
  FileBarChart,
} from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { BottomTabs } from "@/components/BottomTabs";
import { PaywallBanner } from "@/components/PaywallBanner";
import { FieldStatusBar } from "@/components/FieldStatusBar";
import { useAuth } from "@/lib/auth";
import { navIntentHandlers } from "@/lib/routePrefetch";
import { TrainingLock, useTrainingGate } from "@/components/TrainingLock";
import { useTheme } from "@/hooks/use-theme";
import { can, type Role as AppRole } from "@shared/capabilities";
import { can as roleCan } from "@shared/permissions";

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
  show: (role: AppRole, user?: { isSuperAdmin?: boolean }) => boolean;
  group?: string;
};

const NAV_ITEMS: NavItem[] = [
  // ── Core ──────────────────────────────────────────────────────────────────
  { href: "/today", label: "Dashboard",    icon: LayoutDashboard, show: (r: AppRole) => r === "rep",                       group: "Core" },
  { href: "/",      label: "Dashboard",    icon: LayoutDashboard, show: (r: AppRole) => isFieldRole(r) && r !== "rep",       group: "Core" },
  { href: "/map",   label: "Field Map",    icon: Map,             show: isFieldRole,                                   group: "Core" },
  { href: "/leads", label: "Leads",        icon: MapPin,          show: isFieldRole,                                   group: "Core" },
  // Metrics sits in Core, not in Field: for a rep it is the second screen they
  // open after the map, and burying it under a collapsed group would make the
  // one surface built for them the hardest to find. The sub-pages below are
  // each gated on the SAME capability the tab inside the page checks, so a nav
  // entry can never point somebody at a tab that would not render for them.
  { href: "/metrics/my",        label: "Metrics",             icon: BarChart3,   show: r => can(r, "dashboard.read.self"),        group: "Core" },
  { href: "/metrics/team",      label: "Team Metrics",        icon: BarChart3,   show: r => can(r, "dashboard.read.team"),        group: "Metrics" },
  { href: "/metrics/territory", label: "Territory Metrics",   icon: LayoutGrid,  show: r => can(r, "dashboard.read.team"),        group: "Metrics" },
  { href: "/metrics/coaching",  label: "Coaching Insights",   icon: Lightbulb,   show: r => can(r, "coaching.read.team"),         group: "Metrics" },
  { href: "/metrics/reports",   label: "Reports",             icon: FileBarChart,show: r => can(r, "dashboard.read.org"),         group: "Metrics" },
  // Calling is a separate, capability-gated workspace. Field-map access never
  // implies calling authority and the map never reveals a phone number.
  { href: "/calling", label: "Cold Calling", icon: PhoneCall, show: r => can(r, "calling.queue.read"), group: "Calling" },
  // ── Field ─────────────────────────────────────────────────────────────────
  // Areas — the console for territory ground truth: who holds which ground,
  // pass progress, assignment and reclaim. That is a MANAGEMENT view, not a
  // rep's daily surface. A rep works the doors they were given, on the Field
  // Map; showing them the roster of every area invites them to go looking for
  // ground that is not theirs. Gated on the same capability that hands areas
  // out, so the people who can assign are the people who can see the board.
  { href: "/areas",        label: "Areas",         icon: LayoutGrid,   show: r => roleCan(r, "assign_territory"),          group: "Field" },
  { href: "/leaderboard",  label: "Leaderboard",  icon: Trophy,       show: isFieldRole,                              group: "Field" },
  // The hub (chat + announcements + board) is a FIELD surface now — every rep
  // reads and writes the room. Matches the route's field.app.use guard; the
  // composer inside stays capability-gated, so this entry never advertises a
  // power the API would refuse.
  { href: "/messages",     label: "Messages",     icon: MessagesSquare, show: isFieldRole,                            group: "Field" },
  { href: "/incentives",   label: "Incentives",   icon: Gift,         show: isFieldRole,                              group: "Field" },
  { href: "/training",     label: "Training",     icon: GraduationCap,show: isFieldRole,                              group: "Field" },
  { href: "/coach",        label: "Coach",        icon: Zap,          show: isFieldRole,                              group: "Field" },
  { href: "/clock",        label: "Field Hours",   icon: Clock,        show: isFieldRole,                              group: "Field" },
  // Mileage and Referrals had live routes, pages, and server APIs but NO nav
  // entry anywhere — reachable only by typed URL. A tax-deduction log and a
  // paid referral program are not features to hide from the people they pay.
  // Gates mirror the routes' CapabilityGuards exactly, so neither entry can
  // ever point a role at a page that would render Access Denied.
  { href: "/mileage",      label: "Mileage",       icon: Car,          show: r => can(r, "mileage.submit.self"),       group: "Field" },
  { href: "/referrals",    label: "Referrals",     icon: UserPlus,     show: r => can(r, "referral.read.self"),        group: "Field" },
  // A rep's own stalled orders. Gated on the same capability the route and the
  // API use, so it can never point somebody at a page that would refuse them.
  { href: "/my-recoveries", label: "My recoveries", icon: LifeBuoy,    show: r => can(r, "recovery.read.self"),        group: "Field" },
  { href: "/my-commission",label: "My commission", icon: Wallet,       show: isFieldRole,                              group: "Field" },
  { href: "/my-documents", label: "My documents",  icon: FileSignature,show: isFieldRole,                              group: "Field" },
  // NOTE: /tax-and-pay is deliberately NOT a nav item. The W-9 and direct
  // deposit are onboarding paperwork, not a standing destination — a rep fills
  // them once. They live inside My documents alongside the agreements they
  // sign, so there is ONE place a rep goes for "paperwork I owe the company".
  // The route stays registered so existing links and bookmarks resolve.
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
  { href: "/live-ops",     label: "Live Operations", icon: Radio,       show: r => can(r, "field.location.read.team"),  group: "Manage" },
  // Order recovery is a MANAGE surface, not a governance one: it is a queue of
  // work, and the people who run it are the people who run the floor.
  { href: "/order-recovery", label: "Order Recovery", icon: PackageSearch, show: r => can(r, "recovery.read.team"),   group: "Manage" },
  // ── Governance (Phase 2) ──────────────────────────────────────────────────
  // admin + manager only: /api/auth/login-attempts is behind requireManager,
  // which does not admit team_lead, so a team lead tapping this landed on a
  // "Couldn't load the audit trail" dead end with a Retry that could never work.
  { href: "/login-activity", label: "Login Activity", icon: ShieldCheck, show: r => hasRole(r, "admin", "manager"), group: "Governance" },
  { href: "/diagnostics",  label: "Diagnostics",   icon: Activity,     show: r => hasRole(r, "admin", "manager"),      group: "Governance" },
  { href: "/governance",   label: "Permissions",   icon: ShieldCheck,  show: r => hasRole(r, "admin"),                 group: "Governance" },
  { href: "/billing",      label: "Billing",       icon: CreditCard,   show: r => hasRole(r, "admin"),                 group: "Governance" },
  // The two admin screens behind the recovery queue: how a provider export is
  // read, and what may be said to a customer. Both are org policy, which is why
  // they sit in Governance rather than beside the queue itself.
  { href: "/order-imports", label: "Order Imports", icon: FileUp,      show: r => can(r, "order.import.manage"),       group: "Governance" },
  { href: "/order-messaging", label: "Recovery Messaging", icon: Send, show: r => can(r, "messaging.templates.manage"), group: "Governance" },
  // The approval queue in front of dangerous writes. Governance rather than
  // Manage: it is where you go to answer "who allowed this, and can it be put
  // back", which is an oversight question even when a floor manager is the one
  // clicking Approve. Also filtered on the feature flag below - the capability
  // alone would point at an empty screen while the gate is off.
  { href: "/action-approvals", label: "Action Approvals", icon: ShieldCheck, show: r => can(r, "action.queue.read"), group: "Governance" },
  // ── Admin ─────────────────────────────────────────────────────────────────
  // Gated on the immutable is_super_admin column that rides on the session
  // user. This used to compare the user's email against a list fetched from
  // /api/config/app — but that endpoint stopped returning the list (it is a
  // per-caller `{ youAreSuperAdmin }` now, deliberately: the apex email set is
  // not something to disclose), so the list was permanently empty and this item
  // was invisible to everyone, the platform owner included.
  { href: "/super-admin",  label: "SaaS Tenants",  icon: Globe,        show: (_r, u) => !!u?.isSuperAdmin, group: "Admin" },
];

// ── Role badge for sidebar footer ─────────────────────────────────────────────
function RoleBadge({ role }: { role: string }) {
  // One treatment for every role. Each entry used to carry its own hue (admin
  // orange, manager amber, team_lead purple, ...) and all eight failed AA on
  // the light default. Colour was never doing work here anyway: only the
  // signed-in user's own badge is ever rendered, the label says the role in
  // words, and the icon already differentiates.
  const map: Record<string, { label: string; Icon: React.ElementType }> = {
    admin: { label: "Admin", Icon: ShieldCheck },
    manager: { label: "Manager", Icon: Crown },
    team_lead: { label: "Team Lead", Icon: Star },
    rep: { label: "Sales Rep", Icon: UserIcon },
    calling_rep: { label: "Calling Rep", Icon: PhoneCall },
    calling_manager: { label: "Calling Manager", Icon: PhoneCall },
    compliance_admin: { label: "Compliance Admin", Icon: ShieldCheck },
    auditor: { label: "Auditor", Icon: Activity },
  };
  const { label, Icon } = map[role] ?? map.rep;
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <Icon className="w-3 h-3" />
      {label}
    </div>
  );
}

// ── Avatar ────────────────────────────────────────────────────────────────────
// The brand navy, one colour for everyone. This used to map role to a hue
// (admin orange, manager amber, team_lead purple, ...), but all three call
// sites render the CURRENT user's own avatar - nobody needs a colour to tell
// them their own role, and no other person's avatar is ever drawn with it. All
// it bought was a saturated orange circle as the loudest thing on the screen,
// carrying white text at 2.8:1.
const AVATAR = "bg-primary text-primary-foreground";

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

  // ── Training gate ─────────────────────────────────────────────────────────
  // A new rep sees Training and nothing else until they finish. This hides the
  // nav and swaps the page for the lock screen; it is a COURTESY, not the lock —
  // the server refuses the same routes independently (server/routes.ts
  // trainingGate), so a typed URL or a replayed request is refused too.
  const gateQ = useTrainingGate(!!user);
  const gated = gateQ.data?.gated === true;
  // Reachable while gated. Kept in step with TRAINING_GATE_ALLOWED_PREFIXES on
  // the server: training itself, plus the account and paperwork lanes, because
  // a rep who cannot open their own W-9 can never finish onboarding at all.
  const gateOpenPath = (path: string) =>
    path === "/training" || path.startsWith("/training/") ||
    path === "/profile" || path === "/my-documents" || path === "/tax-and-pay";
  const lockThisPage = gated && !gateOpenPath(location);
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

  // Floor-chat unread — the count on the Messages nav entry. Same query key
  // the hub and its chat pane observe, so the sidebar, the tab badge, and the
  // room can never disagree; this observer just sets the slow 30s baseline.
  // Gated reps are excluded (the server would 403 the poll anyway).
  const { data: chatPage } = useQuery<{ unread: number; threadsUnread?: number }>({
    queryKey: ["/api/chat"],
    refetchInterval: 30000,
    enabled: isFieldRole(role) && !gated,
  });
  // Floor + DMs + groups — one number for the one nav entry they live behind.
  const chatUnread = (chatPage?.unread ?? 0) + (chatPage?.threadsUnread ?? 0);

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
    : location === "/tax-and-pay" ? "Tax & pay"
    : location === "/followups" ? "Follow-ups"
    : location === "/mileage" ? "Mileage"
    : location === "/referrals" ? "Referrals"
    : location === "/my-territory" ? "My territory"
    : onCalling ? "Calling"
    : location === "/profile" ? "Profile"
    : NAV_ITEMS.find(item => item.href === location)?.label ?? orgName;

  // While gated, the sidebar shows only what the server would actually answer.
  // Listing links that 403 on tap is worse than hiding them: it reads as a
  // broken app rather than a locked one.
  //
  // The action gate needs one more filter than a capability can express. It is
  // behind a process flag that ships off, and with the flag down every
  // /api/actions route answers 404 - so a role that HOLDS action.queue.read
  // would still land on a permanently empty screen. The count endpoint is the
  // probe: a 200 means the feature is on, and it doubles as the badge. Same
  // mistake the Login Activity comment above records, avoided the same way.
  const gateProbe = useQuery<{ pending: number }>({
    queryKey: ["/api/actions/pending-count"],
    refetchInterval: 60_000,
    enabled: can(role, "action.queue.read") && !gated,
    retry: false,
  });
  const actionGateLive = gateProbe.isSuccess;
  const pendingActionCount = gateProbe.data?.pending ?? 0;

  const visibleNav = NAV_ITEMS
    .filter(item => item.show(role, user ?? undefined))
    .filter(item => !gated || gateOpenPath(item.href))
    .filter(item => item.href !== "/action-approvals" || actionGateLive);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-[min(88vw,360px)] md:w-60 bg-card border-r border-border flex flex-col transition-transform duration-200 ease-out motion-reduce:duration-0",
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
                        // The bare /metrics path resolves to the first tab the
                        // caller may see, which for a rep is My Metrics. Light
                        // that entry rather than leaving the whole group dark.
                        : href === "/metrics/my"
                          ? location === href || location === "/metrics"
                          : location === href;
                    const badgeCount =
                      href === "/messages" ? chatUnread
                      : canManage && href === "/map" && pendingTerritoryCount > 0 ? pendingTerritoryCount
                      : href === "/action-approvals" ? pendingActionCount
                      : 0;
                    return (
                      <Link
                        key={href}
                        href={href}
                        onClick={() => setMobileOpen(false)}
                        {...navIntentHandlers(href)}
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
                            {badgeCount > 9 ? "9+" : badgeCount}
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
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${AVATAR}`}>
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
        <div className="fixed inset-0 z-40 bg-overlay backdrop-blur-[2px] md:hidden animate-in fade-in duration-200 motion-reduce:duration-0" onClick={() => setMobileOpen(false)} />
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile header — standard app chrome on every page EXCEPT the map:
            the Field Map is full-bleed (owner spec) with its own floating menu. */}
        {!onMap && (
        <header
          className="liquid-header md:hidden sticky top-0 z-30 flex min-h-14 items-center gap-2 px-3"
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
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[11px] font-bold ring-2 ring-border ${AVATAR}`}>
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
        <main className={`flex-1 overflow-hidden ${onMap || onCalling ? "" : "pb-[calc(88px+env(safe-area-inset-bottom))] md:pb-0"}`} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {lockThisPage ? <TrainingLock /> : children}
        </main>
        {!onMap && !onCalling && !gated && <BottomTabs role={role} moreOpen={moreOpen} moreButtonRef={moreTriggerRef} moreDot={(canManage && pendingTerritoryCount > 0) || chatUnread > 0} onMore={() => { setMobileOpen(false); setMoreOpen(true); }} />}
      </div>

      {/* The More sheet renders wherever the header does (everywhere but the
          full-bleed map) — on calling pages the header avatar is its only
          entry point, so it must not be gated behind !onCalling. */}
      {moreOpen && !onMap && (
        <div className="fixed inset-0 z-[60] md:hidden" role="presentation">
          <button type="button" aria-label="Close more menu" className="absolute inset-0 bg-overlay backdrop-blur-[2px]" onClick={closeMore} />
          <div
            id="mobile-more-sheet"
            ref={moreSheetRef}
            role="dialog"
            aria-modal="true"
            aria-label="More navigation"
            className="liquid-glass absolute inset-x-0 bottom-0 max-h-[86dvh] overflow-y-auto rounded-t-[28px] border-t border-border animate-in slide-in-from-bottom duration-200 ease-out motion-reduce:duration-0"
            style={{ paddingBottom: "max(1rem,env(safe-area-inset-bottom))" }}
          >
            <div className="sticky top-0 z-10 bg-card/80 px-4 pb-3 pt-2">
              <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-muted-foreground/25" aria-hidden="true" />
              <div className="flex items-center gap-3">
                <div className={`grid h-11 w-11 place-items-center rounded-full text-sm font-bold ${AVATAR}`}>{user?.name?.slice(0, 2).toUpperCase()}</div>
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
                    <Link key={href} href={href} onClick={() => setMoreOpen(false)} {...navIntentHandlers(href)} className="flex min-h-[68px] items-center gap-3 rounded-2xl border border-border bg-background/55 px-3.5 py-3 text-left active:scale-[.98] transition hover:border-primary/25">
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
