// ── Profile — the fourth bottom tab ───────────────────────────────────────────
// Identity + session controls, mobile-first. Deliberately small: who am I,
// which role, light/dark, sign out. Everything else lives in its own tab.

import { ChevronRight, Clock3, FileSignature, Landmark, LogOut, Moon, Sun, Trophy } from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/hooks/use-theme";

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
        {/* Page title */}
        <header className="pt-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Settings</h1>
          <p className="text-[13px] text-muted-foreground mt-1">
            Manage your account and preferences.
          </p>
        </header>

        {/* ── Account ─────────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-1">
            Account
          </h2>
          <div className="rounded-2xl bg-card border border-border overflow-hidden">
            {/* Gradient banner + overlapping avatar — a proper identity header */}
            <div className="h-16 bg-gradient-to-r from-primary/30 via-primary/12 to-transparent" aria-hidden="true" />
            <div className="px-5 pb-5 -mt-9">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-emerald-600 text-white flex items-center justify-center text-xl font-bold ring-4 ring-card shadow-lg">
                {user.name?.slice(0, 2).toUpperCase()}
              </div>
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <h3 className="text-[18px] font-bold tracking-tight text-foreground">{user.name}</h3>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/12 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-primary">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary" aria-hidden="true" />
                  {ROLE_LABEL[user.role] ?? user.role}
                </span>
              </div>
              <div className="text-[13px] text-muted-foreground mt-1 truncate">{user.email}</div>
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
                <span className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                  <FileSignature className="w-4 h-4" />
                </span>
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
                <span className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                  <Landmark className="w-4 h-4" />
                </span>
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
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sky-500/10 text-sky-400"><Clock3 className="h-4 w-4" /></span>
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">Field hours</span><span className="block text-xs text-muted-foreground">Clock in and review sessions</span></span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
            <Link
              href="/leaderboard"
              className="flex min-h-[60px] items-center gap-3 px-4 py-3 active:bg-secondary/60"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-400"><Trophy className="h-4 w-4" /></span>
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
              className="w-full px-5 py-4 flex items-center justify-between gap-4 text-[14px] font-medium text-red-400 active:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:outline-none transition-colors"
            >
              <span>Sign out</span>
              <LogOut className="w-4 h-4" />
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
