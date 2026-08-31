import { Link } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import {
  ListChecks,
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
  ChevronDown,
  ChevronRight,
  BookOpen,
  Plus,
  Lasso,
  Search,
  Home,
} from "lucide-react";
import { lazy, Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useModalA11y } from "@/hooks/use-modal-a11y";
import { BottomTabs } from "@/components/BottomTabs";
import { PaywallBanner } from "@/components/PaywallBanner";
import { FieldStatusBar } from "@/components/FieldStatusBar";
import { useAuth } from "@/lib/auth";
import { navIntentHandlers } from "@/lib/routePrefetch";
import { TrainingLock, useTrainingGate } from "@/components/TrainingLock";
import { PaletteTrigger, usePaletteShortcut, loadCommandPalette, type PaletteAction } from "@/components/paletteShell";
import { canPrefetchRouteChunks } from "@/lib/routePrefetch";

// The palette carries cmdk and the Radix dialog - loaded the first time it is
// opened (or warmed on idle below), never on the entry path.
const CommandPalette = lazy(loadCommandPalette);
import { leadsAddIntent } from "@/lib/leadsFilterHandoff";
import { useTheme } from "@/hooks/use-theme";
import { useIsMobile } from "@/hooks/use-mobile";
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
  { href: "/today", label: "Today",        icon: LayoutDashboard, show: (r: AppRole) => r === "rep",                       group: "Core" },
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
  { href: "/leads/import", label: "Import Leads",  icon: FileUp,       show: r => can(r, "lead.assign"),                group: "Field" },
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
  { href: "/ops",          label: "Operations",      icon: ListChecks,  show: r => can(r, "dashboard.read.team"),       group: "Manage" },
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
  // Every number the app computes, stated in one sentence with its thresholds,
  // read from the shared constants. Governance because it answers "why did the
  // app decide that", which is an oversight question before it is a field one.
  { href: "/rulebook",     label: "Rulebook",      icon: BookOpen,     show: r => hasRole(r, "admin", "manager"),      group: "Governance" },
  // ── Admin ─────────────────────────────────────────────────────────────────
  // Gated on the immutable is_super_admin column that rides on the session
  // user. This used to compare the user's email against a list fetched from
  // /api/config/app — but that endpoint stopped returning the list (it is a
  // per-caller `{ youAreSuperAdmin }` now, deliberately: the apex email set is
  // not something to disclose), so the list was permanently empty and this item
  // was invisible to everyone, the platform owner included.
  { href: "/super-admin",  label: "SaaS Tenants",  icon: Globe,        show: (_r, u) => !!u?.isSuperAdmin, group: "Admin" },
];

function navItemIsActive(href: string, location: string): boolean {
  if (href === "/") return location === "/";
  if (href === "/today") return location === "/today";
  if (href === "/calling") return location === href || location.startsWith("/calling/lead/");
  if (href === "/metrics/my") return location === href || location === "/metrics";
  if (href === "/leads") return location === href || location.startsWith("/lead/");
  if (href === "/areas") return location === href || location.startsWith("/areas/");
  return location === href;
}

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

/**
 * Routes a training-gated rep must still be able to use.
 *
 * Hash routers normally hand Layout a clean `/training` path, but old service
 * workers and direct links have also surfaced `#/training`, query strings, and
 * trailing slashes. Normalize all of those before applying the gate so the
 * screen that tells a rep to start training can never lock the training screen
 * itself.
 */
export function isTrainingGateOpenClientPath(value: string): boolean {
  let path = String(value ?? "").trim();
  if (path.startsWith("#")) path = path.slice(1);
  path = path.split(/[?#]/, 1)[0] || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/+$/, "") || "/";
  return path === "/training" || path.startsWith("/training/") ||
    path === "/profile" || path === "/my-documents" || path === "/tax-and-pay";
}

// ── Layout ────────────────────────────────────────────────────────────────────
export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useHashLocation();
  const isMobile = useIsMobile();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() => {
    const activeGroup = NAV_ITEMS.find(item => navItemIsActive(item.href, location))?.group;
    return activeGroup && activeGroup !== "Core" ? { [activeGroup]: true } : {};
  });
  const moreSheetRef = useRef<HTMLDivElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Cmd-K palette: every page this role can open, plus the common actions.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Mounted on first open and kept mounted after, so the close animation and
  // the typed query behave like a native control from the second use on.
  const [paletteMounted, setPaletteMounted] = useState(false);
  const togglePalette = useCallback(() => { setPaletteMounted(true); setPaletteOpen(open => !open); }, []);
  usePaletteShortcut(togglePalette);
  // Warm the palette chunk once the browser is idle, on the same connection
  // gate the tab chunks use, so the first Cmd-K never waits on the network.
  useEffect(() => {
    if (!canPrefetchRouteChunks()) return;
    const idle = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const warm = () => { void loadCommandPalette(); };
    if (idle.requestIdleCallback) {
      const id = idle.requestIdleCallback(warm, { timeout: 5000 });
      return () => idle.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(warm, 3000);
    return () => window.clearTimeout(timer);
  }, []);
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
  const lockThisPage = gated && !isTrainingGateOpenClientPath(location);
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
  // Any navigation (link, hardware back, programmatic) dismisses the mobile
  // overlays - a hardware-back with the drawer open used to navigate the page
  // underneath while the drawer stayed put.
  useEffect(() => { setMoreOpen(false); setMobileOpen(false); }, [location]);

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

  // The mobile nav drawer gets the same modal treatment as the More sheet:
  // focus moved in, Escape, contained Tab, scroll lock, focus restored.
  useModalA11y(asideRef, { active: isMobile && mobileOpen, onClose: () => setMobileOpen(false) });

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
  const mobileTitle = location === "/today" ? "Today"
    : location === "/" ? "Dashboard"
    : location === "/map" ? "Field map"
    : location === "/leads" || location.startsWith("/lead/") ? (role === "rep" ? "My leads" : "Leads")
    : location === "/my-commission" ? "My pay"
    : location === "/clock" ? "Field hours"
    : location === "/leaderboard" ? "Leaderboard"
    : location === "/my-documents" ? "Documents"
    : location === "/tax-and-pay" ? "Tax & pay"
    : location === "/leads/import" ? "Import leads"
    : location === "/followups" ? "Schedule"
    : location === "/mileage" ? "Mileage"
    : location === "/referrals" ? "Referrals"
    : onCalling ? "Calling"
    : location === "/profile" ? "Profile"
    : location.startsWith("/areas/") ? "Areas"
    : location.startsWith("/statements/") ? "Statement"
    : location.startsWith("/property/") ? "Property"
    : location === "/metrics" ? "Metrics"
    : location === "/token" ? "Scanner setup"
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
  //
  // The flag state itself rides the session payload (like isSuperAdmin), and
  // the poll only runs where it says the feature is on. Probing blind meant
  // every flag-off environment logged a console 404 per minute per approver -
  // the browser prints "Failed to load resource" for a 404 whether or not the
  // app handles it. The probe's 200 is still what turns the nav entry on, so
  // a server whose flag dropped mid-session converges to hidden on the next
  // poll; a flip ON is noticed at the next sign-in or app relaunch, which is
  // how an env-var change already reaches clients.
  const gateProbe = useQuery<{ pending: number }>({
    queryKey: ["/api/actions/pending-count"],
    refetchInterval: 60_000,
    enabled: can(role, "action.queue.read") && !gated && user?.guardedActionsEnabled === true,
    retry: false,
  });
  const actionGateLive = gateProbe.isSuccess;
  const pendingActionCount = gateProbe.data?.pending ?? 0;

  const visibleNav = NAV_ITEMS
    .filter(item => item.show(role, user ?? undefined))
    .filter(item => !gated || isTrainingGateOpenClientPath(item.href))
    .filter(item => item.href !== "/action-approvals" || actionGateLive);
  const currentNavGroup = visibleNav.find(item => navItemIsActive(item.href, location))?.group;
  const mobilePrimaryHrefs = new Set(["/", "/today", "/leads", "/map", "/my-commission"]);
  const mobileMoreGroups = visibleNav
    .filter(item => !mobilePrimaryHrefs.has(item.href))
    .reduce<{ group: string; items: NavItem[] }[]>((groups, item) => {
      const group = item.group ?? "Other";
      const existing = groups.find(entry => entry.group === group);
      if (existing) existing.items.push(item);
      else groups.push({ group, items: [item] });
      return groups;
    }, []);
  const navBadgeCount = (href: string) =>
    href === "/messages" ? chatUnread
    : canManage && href === "/map" && pendingTerritoryCount > 0 ? pendingTerritoryCount
    : href === "/action-approvals" ? pendingActionCount
    : 0;

  useEffect(() => {
    if (!currentNavGroup || currentNavGroup === "Core") return;
    setExpandedGroups(groups => groups[currentNavGroup]
      ? groups
      : { ...groups, [currentNavGroup]: true });
  }, [currentNavGroup]);

  // Palette actions. Each one is gated exactly as the screen it lands on, so
  // the list never advertises a power the page would refuse. Navigation is a
  // hash change like every other link; "Add a lead" hands its intent to Leads.
  const paletteActions: PaletteAction[] = [];
  if (!gated) {
    if (hasRole(role, "admin", "manager", "team_lead")) {
      paletteActions.push({ id: "add-lead", label: "Add a lead", keywords: ["new", "door", "create"], icon: Plus, run: () => { leadsAddIntent(); window.location.hash = "#/leads"; } });
    }
    if (can(role, "lead.assign")) {
      paletteActions.push({ id: "import-leads", label: "Import a spreadsheet", keywords: ["csv", "xlsx", "upload"], icon: FileUp, run: () => { window.location.hash = "#/leads/import"; } });
    }
    if (roleCan(role, "assign_territory")) {
      paletteActions.push({ id: "draw-area", label: "Draw an area on the map", keywords: ["lasso", "territory"], icon: Lasso, run: () => { window.location.hash = "#/map"; } });
    }
    if (hasRole(role, "admin", "manager", "team_lead")) {
      paletteActions.push({ id: "finalize-week", label: "Review this week's pay", keywords: ["commission", "payroll", "finalize"], icon: Banknote, run: () => { window.location.hash = "#/commission-console"; } });
    }
    if (hasRole(role, "admin", "manager")) {
      paletteActions.push({ id: "invite-rep", label: "Send a private invite", keywords: ["onboarding", "recruit", "candidate"], icon: Send, run: () => { window.location.hash = "#/applications"; } });
    }
    if (role === "rep") {
      paletteActions.push({ id: "next-door", label: "Open my next door", keywords: ["today", "route", "knock"], icon: Home, run: () => { window.location.hash = "#/today"; } });
      paletteActions.push({ id: "clock", label: "Clock in or out", keywords: ["shift", "hours"], icon: Clock, run: () => { window.location.hash = "#/clock"; } });
    }
  }
  const openPalette = () => { setMoreOpen(false); setMobileOpen(false); setPaletteMounted(true); setPaletteOpen(true); };

  // Desktop breadcrumb: the group the sidebar would light, then the page.
  const activeNav = visibleNav.find(item => navItemIsActive(item.href, location));
  const crumbGroup = activeNav?.group ?? (location === "/profile" ? "Account" : location === "/followups" ? "Today" : "Core");
  const crumbTitle = activeNav?.label ?? mobileTitle;

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <a
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
        className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-lg transition-transform focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      >
        Skip to main content
      </a>
      {/* Sidebar */}
      <aside
        ref={asideRef}
        aria-hidden={isMobile && !mobileOpen ? true : undefined}
        // A translated off-canvas drawer is still focusable and exposed to
        // assistive technology. `inert` closes both paths while the phone nav
        // is visually hidden; desktop navigation remains fully interactive.
        {...(isMobile && !mobileOpen ? { inert: "" } : {})}
        className={cn(
        "fixed inset-y-0 left-0 z-50 flex w-[min(88vw,360px)] flex-col border-r border-border bg-card/95 transition-transform duration-200 ease-out motion-reduce:duration-0 md:w-[264px]",
        "md:relative md:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        {/* Wordmark — logo mark removed per owner; text-only brand */}
        <div className="flex min-h-[72px] items-center gap-2.5 border-b border-border px-5 py-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="leading-tight">
            <div className="text-[15px] font-bold tracking-tight text-foreground">Home Front</div>
            <div className="text-[11px] font-semibold tracking-[0.14em] text-primary">SOLUTIONS</div>
            <div className="mt-1 text-2xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Field operations</div>
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

        <div className="px-3 pt-3">
          <PaletteTrigger onOpen={openPalette} />
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
              const groupOpen = group === "Core" || expandedGroups[group] === true;
              const groupId = `desktop-nav-group-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
              return (
                <div key={group} className="mb-1">
                  {group === "Core" ? (
                    <div className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {group}
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-expanded={groupOpen}
                      aria-controls={groupId}
                      onClick={() => setExpandedGroups(current => ({ ...current, [group]: !groupOpen }))}
                      className="group flex min-h-10 w-full items-center rounded-lg px-3 pb-1 pt-3 text-left text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      data-testid={`nav-group-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                    >
                      <span className="flex-1">{group}</span>
                      <ChevronDown
                        aria-hidden="true"
                        className={cn("h-3.5 w-3.5 transition-transform", groupOpen && "rotate-180")}
                      />
                    </button>
                  )}
                  <div id={groupId} hidden={!groupOpen}>
                  {items.map(({ href, label, icon: Icon }) => {
                    const isActive = navItemIsActive(href, location);
                    const badgeCount = navBadgeCount(href);
                    return (
                      <Link
                        key={href}
                        href={href}
                        onClick={() => setMobileOpen(false)}
                        aria-current={isActive ? "page" : undefined}
                        {...navIntentHandlers(href)}
                        className={cn(
                          "relative flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium transition-[color,background-color,box-shadow] md:min-h-10 md:rounded-lg md:py-2",
                          isActive
                            ? "bg-primary/[0.12] font-semibold text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.12)]"
                            : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
                        )}
                        data-testid={`nav-${label.toLowerCase().replace(/\s/g, "-")}`}
                      >
                        {isActive && <span aria-hidden className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary" />}
                        <Icon aria-hidden="true" className={cn("w-[18px] h-[18px] md:w-4 md:h-4 flex-shrink-0", isActive && "text-primary")} />
                        <span className="flex-1">{label}</span>
                        {badgeCount > 0 && (
                          <span className="min-w-[18px] h-[18px] rounded-full bg-warning text-2xs font-bold text-warning-foreground flex items-center justify-center px-1">
                            {badgeCount > 9 ? "9+" : badgeCount}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                  </div>
                </div>
              );
            });
          })()}

          {/* Territory Requests alert */}
          {canManage && pendingTerritoryCount > 0 && (
            <div className="mt-2 px-3 py-2 rounded-md bg-warning/10 border border-warning/20">
              <div className="flex items-center gap-2 text-xs text-warning font-medium">
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
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg -mx-1 -my-0.5 px-1 py-0.5 hover:bg-secondary transition-colors"
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
              type="button"
              onClick={toggle}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              data-testid="button-theme-toggle"
              className="grid h-11 w-11 md:h-9 md:w-9 place-items-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button
              type="button"
              onClick={() => logout()}
              title="Sign out"
              aria-label="Sign out"
              data-testid="button-logout"
              className="grid h-11 w-11 md:h-9 md:w-9 place-items-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
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
        <button type="button" aria-label="Close navigation menu" className="fixed inset-0 z-40 bg-overlay backdrop-blur-[2px] md:hidden animate-in fade-in duration-200 motion-reduce:duration-0" onClick={() => setMobileOpen(false)} />
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
          <button type="button" aria-label={`Open navigation and account for ${user?.name ?? "your profile"}`} aria-expanded={moreOpen} aria-controls="mobile-more-sheet"
            onClick={() => { setMobileOpen(false); setMoreOpen(true); }}
            className={`grid size-11 shrink-0 place-items-center rounded-full text-[11px] font-bold ring-2 ring-border ${AVATAR}`}>
            {user?.name?.slice(0, 2).toUpperCase()}
          </button>
        </header>
        )}

        {/* Billing status — renders only when a provisioned tenant has a problem
            (past_due / suspended / low credits); invisible otherwise. */}
        <PaywallBanner />
        {!onCalling && <FieldStatusBar overlay={onMap} />}

        {/* Desktop breadcrumb bar — where am I, in the sidebar's own words.
            Full-bleed routes (map, calling) carry their own chrome instead. */}
        {!onMap && !onCalling && (
          <nav aria-label="Breadcrumb" data-testid="breadcrumb-bar" className="hidden md:flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-card/60 px-6 text-sm">
            <span className="text-muted-foreground">{crumbGroup}</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="font-semibold text-foreground" aria-current="page">{crumbTitle}</span>
            <span className="flex-1" />
            <button type="button" onClick={openPalette} aria-label="Search or jump to a page" className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Search className="h-4 w-4" aria-hidden="true" />
            </button>
          </nav>
        )}

        {/* Standard pages reserve space for the field tab bar. The map stays
            full-bleed and uses its own floating menu and map controls. */}
        {/* Reserve tab-bar space only when the tab bar will actually render:
            a training-gated rep gets no BottomTabs, and reserving 88px+inset
            under the lock screen was just dead space on phones. */}
        <main id="main-content" tabIndex={-1} className={`flex-1 overflow-hidden outline-none ${onMap || onCalling || gated ? "" : "pb-[calc(88px+env(safe-area-inset-bottom))] md:pb-0"}`} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
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
              <button type="button" onClick={openPalette} data-testid="more-palette-trigger" className="mb-4 flex min-h-12 w-full items-center gap-3 rounded-2xl border border-border bg-background/55 px-4 text-left text-sm-minus font-medium text-muted-foreground hover:border-primary/25 hover:bg-secondary/40">
                <Search className="h-4 w-4" aria-hidden="true" /><span className="flex-1">Search or jump to a page</span>
              </button>
              <div className="space-y-5">
                {mobileMoreGroups.map(({ group, items }) => {
                  const groupId = `mobile-more-group-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
                  return (
                    <section key={group} aria-labelledby={groupId}>
                      <h2 id={groupId} className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        {group}
                      </h2>
                      <div className="grid grid-cols-2 gap-2">
                        {items.map(({ href, label, icon: Icon }) => {
                          const isActive = navItemIsActive(href, location);
                          const badgeCount = navBadgeCount(href);
                          return (
                            <Link
                              key={href}
                              href={href}
                              onClick={() => setMoreOpen(false)}
                              aria-current={isActive ? "page" : undefined}
                              {...navIntentHandlers(href)}
                              className={cn(
                                "relative flex min-h-[68px] min-w-0 items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition-[transform,border-color,background-color] active:scale-[.98]",
                                isActive
                                  ? "border-primary/30 bg-primary/[0.09]"
                                  : "border-border bg-background/55 hover:border-primary/25 hover:bg-secondary/40",
                              )}
                            >
                              <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-secondary", isActive ? "text-primary" : "text-muted-foreground")}>
                                <Icon className="h-[19px] w-[19px]" aria-hidden="true" />
                              </span>
                              <span className="min-w-0 flex-1 break-words text-sm-minus font-semibold leading-tight text-foreground [overflow-wrap:anywhere]">{label}</span>
                              {badgeCount > 0 && (
                                <span className="absolute right-2 top-2 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-warning px-1 text-2xs font-bold text-background">
                                  {badgeCount > 9 ? "9+" : badgeCount}
                                </span>
                              )}
                            </Link>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>

              <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-background/45">
                <Link href="/profile" onClick={() => setMoreOpen(false)} className="flex min-h-12 items-center gap-3 px-4 text-sm-minus font-medium text-foreground hover:bg-secondary/60">
                  <UserIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" /><span className="flex-1">Profile and account</span>
                </Link>
                <button type="button" onClick={toggle} className="flex min-h-12 w-full items-center gap-3 border-t border-border px-4 text-left text-sm-minus font-medium text-foreground hover:bg-secondary/60">
                  {theme === "dark" ? <Sun className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> : <Moon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
                  <span className="flex-1">Switch to {theme === "dark" ? "light" : "dark"} mode</span>
                </button>
                <button type="button" onClick={() => { setMoreOpen(false); void logout(); }} className="flex min-h-12 w-full items-center gap-3 border-t border-border px-4 text-left text-sm-minus font-medium text-destructive hover:bg-destructive/5">
                  <LogOut className="h-4 w-4" aria-hidden="true" /><span className="flex-1">Sign out</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {paletteMounted && (
        <Suspense fallback={null}>
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} pages={visibleNav} actions={paletteActions} />
        </Suspense>
      )}
    </div>
  );
}
