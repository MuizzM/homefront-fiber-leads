import { ChevronDown, ChevronRight, Moon, Sun } from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/hooks/use-theme";
import { useErrorCenter } from "@/hooks/use-toast";
import { PageHeader, SectionLabel } from "@/components/ui/page-scaffold";

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super Admin", admin: "Admin", manager: "Manager",
  team_lead: "Team Lead", rep: "Sales Rep",
};

export default function Profile() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  if (!user) return null;

  return (
    <div className="flex-1 overflow-y-auto p-4 pb-24">
      <div className="max-w-lg mx-auto space-y-8">
        <PageHeader className="pt-2" title="Settings" subtitle="Manage your account and preferences." />

        {/* ── Account ─────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionLabel className="px-1">Account</SectionLabel>
          <div className="rounded-2xl bg-card border border-border overflow-hidden">
            <div className="flex items-center gap-4 px-5 py-5">
              <div className="grid size-14 shrink-0 place-items-center rounded-xl bg-primary text-lg font-bold text-primary-foreground">
                {user.name?.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[18px] font-bold tracking-tight text-foreground">{user.name}</h2>
                  <span className="inline-flex items-center rounded-full bg-primary/[0.12] px-2.5 py-1 text-[11px] font-semibold text-primary">
                  {ROLE_LABEL[user.role] ?? user.role}
                  </span>
                </div>
                <div className="mt-1 break-all text-[13px] text-muted-foreground">{user.email}</div>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-1">
            Onboarding
          </h2>
          <div className="rounded-xl bg-card border border-border overflow-hidden">
            <Link
              href="/my-documents"
              data-testid="profile-my-documents"
              className="w-full px-5 py-4 flex items-center justify-between gap-4 text-left active:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:outline-none transition-colors"
            >
              <span className="flex items-center gap-3">
                
                <span>
                  <span className="block text-[14px] font-medium text-foreground">My documents</span>
                  <span className="block text-[12px] text-muted-foreground mt-0.5">Review and sign rep agreements</span>
                </span>
              </span>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </Link>
            <Link
              href="/tax-and-pay"
              data-testid="profile-tax-and-pay"
              className="w-full px-5 py-4 flex items-center justify-between gap-4 text-left border-t border-border active:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:outline-none transition-colors"
            >
              <span className="flex items-center gap-3">
                
                <span>
                  <span className="block text-[14px] font-medium text-foreground">Tax &amp; Direct Deposit</span>
                  <span className="block text-[12px] text-muted-foreground mt-0.5">File your W-9 and set where your pay lands</span>
                </span>
              </span>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </Link>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-1">
            Field tools
          </h2>
          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
            <Link
              href="/clock"
              className="flex min-h-[60px] items-center gap-3 px-4 py-3 active:bg-secondary/60"
            >
              
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">Field hours</span><span className="block text-xs text-muted-foreground">Clock in and review sessions</span></span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
            <Link
              href="/leaderboard"
              className="flex min-h-[60px] items-center gap-3 px-4 py-3 active:bg-secondary/60"
            >
              
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">Leaderboard</span><span className="block text-xs text-muted-foreground">See team progress and your rank</span></span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
          </div>
        </section>

        {/* ── Preferences ─────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-1">
            Preferences
          </h2>
          <div className="rounded-xl bg-card border border-border overflow-hidden">
            <button
              type="button"
              onClick={toggle}
              data-testid="profile-theme-toggle"
              className="w-full px-5 py-4 flex items-center justify-between gap-4 text-left active:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:outline-none transition-colors"
            >
              <span>
                <span className="block text-[14px] font-medium text-foreground">Appearance</span>
                <span className="block text-[12px] text-muted-foreground mt-0.5">Theme for this device</span>
              </span>
              <span className="flex items-center gap-2 text-muted-foreground text-[13px] shrink-0">
                {theme === "dark" ? <>Dark <Moon className="w-4 h-4" /></> : <>Light <Sun className="w-4 h-4" /></>}
              </span>
            </button>
          </div>
        </section>

        {/* ── Recent errors on this device ─────────────────────
            The durable half of the 6-second error toast: every error,
            warning, offline and payment notice from this session, so a
            failure missed in the field is recoverable instead of gone. */}
        <RecentErrorsSection />

        {/* ── Session ─────────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-1">
            Session
          </h2>
          <div className="rounded-xl bg-card border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => logout()}
              data-testid="profile-logout"
              className="w-full px-5 py-4 flex items-center justify-between gap-4 text-[14px] font-medium text-destructive active:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:outline-none transition-colors"
            >
              <span>Sign out</span>
              
            </button>
          </div>
        </section>

        <div className="text-center text-[11px] text-muted-foreground pt-2">
          Home Front Solutions · Field
        </div>
      </div>
    </div>
  );
}

/** The error center's first real consumer: the auto-dismiss policy for error
 *  toasts (6s) was justified by this durable log existing - and it was
 *  written to but rendered nowhere. Collapsed by default; session-only. */
function RecentErrorsSection() {
  const { notifications, clear } = useErrorCenter();
  if (notifications.length === 0) return null;
  return (
    <section className="space-y-3" data-testid="recent-errors">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-1">
        Recent errors on this device
      </h2>
      <details className="group rounded-xl bg-card border border-border overflow-hidden">
        <summary className="flex min-h-tap cursor-pointer select-none items-center justify-between gap-3 px-5 text-[14px] font-medium text-foreground [&::-webkit-details-marker]:hidden">
          <span>{notifications.length} since you opened the app</span>
          <ChevronDown aria-hidden="true" className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-border">
          <ul className="max-h-64 divide-y divide-border/60 overflow-y-auto">
            {notifications.map(n => (
              <li key={n.id} className="px-5 py-2.5">
                <div className="text-[13px] font-medium text-foreground">{n.title}</div>
                {n.description && <div className="mt-0.5 text-xs text-muted-foreground">{n.description}</div>}
                <div className="mt-0.5 text-2xs text-muted-foreground">
                  {new Date(n.at).toLocaleTimeString()} · {n.severity}
                </div>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={clear}
            data-testid="recent-errors-clear"
            className="w-full border-t border-border px-5 py-3 text-left text-[13px] font-medium text-muted-foreground hover:text-foreground"
          >
            Clear the list
          </button>
        </div>
      </details>
    </section>
  );
}
