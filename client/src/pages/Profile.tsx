// ── Profile — the fourth bottom tab ───────────────────────────────────────────
// Identity + session controls, mobile-first. Deliberately small: who am I,
// which role, light/dark, sign out. Everything else lives in its own tab.

import { LogOut, Moon, Sun } from "lucide-react";
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
          <div className="rounded-xl bg-card border border-border divide-y divide-border overflow-hidden">
            {/* Identity row */}
            <div className="p-5 flex items-center gap-4">
              <div className="w-14 h-14 rounded-full bg-primary/20 text-primary flex items-center justify-center text-lg font-bold shrink-0">
                {user.name?.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-[17px] font-semibold tracking-tight text-foreground truncate">{user.name}</div>
                <div className="text-[13px] text-muted-foreground truncate">{user.email}</div>
              </div>
            </div>
            {/* Role row — label + control */}
            <div className="px-5 py-4 flex items-center justify-between gap-4">
              <span className="text-[14px] text-foreground">Role</span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span className="w-1.5 h-1.5 rounded-full bg-primary" aria-hidden="true" />
                {ROLE_LABEL[user.role] ?? user.role}
              </span>
            </div>
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
