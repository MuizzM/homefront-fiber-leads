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
      <div className="max-w-md mx-auto space-y-4">
        {/* Identity */}
        <div className="rounded-2xl bg-card border border-border p-5 flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-primary/20 text-primary flex items-center justify-center text-lg font-bold shrink-0">
            {user.name?.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-[17px] font-bold text-foreground truncate">{user.name}</div>
            <div className="text-[13px] text-muted-foreground truncate">{user.email}</div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-primary mt-0.5">
              {ROLE_LABEL[user.role] ?? user.role}
            </div>
          </div>
        </div>

        {/* Settings — generous rows, one action each */}
        <div className="rounded-2xl bg-card border border-border divide-y divide-border overflow-hidden">
          <button
            type="button"
            onClick={toggle}
            data-testid="profile-theme-toggle"
            className="w-full h-14 px-5 flex items-center justify-between text-[15px] font-medium text-foreground active:bg-secondary/60 transition-colors"
          >
            <span>Appearance</span>
            <span className="flex items-center gap-2 text-muted-foreground text-[13px]">
              {theme === "dark" ? <>Dark <Moon className="w-4 h-4" /></> : <>Light <Sun className="w-4 h-4" /></>}
            </span>
          </button>
          <button
            type="button"
            onClick={() => logout()}
            data-testid="profile-logout"
            className="w-full h-14 px-5 flex items-center justify-between text-[15px] font-medium text-red-400 active:bg-secondary/60 transition-colors"
          >
            <span>Sign out</span>
            <LogOut className="w-4 h-4" />
          </button>
        </div>

        <div className="text-center text-[11px] text-muted-foreground pt-2">
          Home Front Solutions · Field
        </div>
      </div>
    </div>
  );
}
