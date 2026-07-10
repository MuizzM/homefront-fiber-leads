// ── Bottom tab bar — mobile primary navigation ────────────────────────────────
// Four thumb-reachable destinations: Map · Dashboard · Commission · Profile.
// Mobile-only (the desktop sidebar covers navigation there); ≥44px targets;
// safe-area padded for home-bar phones. The knock sheet (z-40) intentionally
// covers it while a lead is open — the card is the whole screen's job then.

import { Link } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { Map, LayoutDashboard, DollarSign, User as UserIcon } from "lucide-react";

const TABS = [
  { href: "/map", label: "Map", icon: Map },
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  // The authoritative weekly-commission rep view (the legacy /commissions page
  // remains in the sidebar for its per-sale records).
  { href: "/my-commission", label: "Commission", icon: DollarSign },
  { href: "/profile", label: "Profile", icon: UserIcon },
] as const;

export function BottomTabs() {
  const [location] = useHashLocation();
  return (
    <nav
      data-testid="bottom-tabs"
      className="md:hidden fixed inset-x-0 bottom-0 z-30 bg-card/95 backdrop-blur-md border-t border-border flex"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = location === href;
        return (
          <Link
            key={href}
            href={href}
            data-testid={`tab-${label.toLowerCase()}`}
            className="flex-1 h-14 flex flex-col items-center justify-center gap-0.5 active:scale-95 transition-transform"
          >
            <Icon className={`w-5 h-5 ${active ? "text-primary" : "text-muted-foreground"}`} />
            <span className={`text-[10px] font-semibold ${active ? "text-primary" : "text-muted-foreground"}`}>
              {label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

export default BottomTabs;
