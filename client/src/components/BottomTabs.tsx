// Mobile field navigation follows the five-destination pattern used by shipped
// workforce and map apps: work queue, leads, one prominent map action, pay, and
// a More gateway. Every target is thumb-reachable and safe-area aware.
//
// The bar itself is LIQUID chrome (TIDE / Moonly via Mobbin, the iOS-26-era
// pattern): detached from the screen edges, fully rounded, blurred glass with
// a hairline and specular edge, and the active destination marked by a solid
// pill INSIDE the glass rather than an underline at its rim. Floating means
// page content scrolls visibly BEHIND the bar — that see-through moment is
// what makes it read as material instead of a painted footer.

import { Link } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { Home, Map, DollarSign, MapPin, Menu } from "lucide-react";
import type { Ref } from "react";
import { can, type Role } from "@shared/capabilities";

// Each tab is capability-gated: roles without field.app.use (e.g. calling-only
// or audit roles) never see dead field tabs, and Pay only shows when the role
// can read its own commission.
const TABS = [
  { href: "/today", label: "Today", icon: Home, cap: "field.app.use" },
  { href: "/leads", label: "Leads", icon: MapPin, cap: "field.app.use" },
  { href: "/map", label: "Map", icon: Map, primary: true, cap: "field.app.use" },
  { href: "/my-commission", label: "Pay", icon: DollarSign, cap: "commission.read.self" },
] as const;

// Tailwind needs static class names — one entry per possible cell count
// (visible tabs + the always-present More button).
const GRID_COLS = ["grid-cols-1", "grid-cols-2", "grid-cols-3", "grid-cols-4", "grid-cols-5"] as const;

export function BottomTabs({ role, onMore, moreOpen = false, moreButtonRef }: { role: Role; onMore?: () => void; moreOpen?: boolean; moreButtonRef?: Ref<HTMLButtonElement> }) {
  const [location] = useHashLocation();
  const visibleTabs = TABS.filter(tab => can(role, tab.cap));
  return (
    <nav
      data-testid="bottom-tabs"
      aria-label="Primary navigation"
      className="liquid-bar md:hidden fixed inset-x-3 z-30"
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 10px)" }}
    >
      <div className={`grid ${GRID_COLS[visibleTabs.length]} h-[62px] px-1.5`}>
      {visibleTabs.map(({ href, label, icon: Icon, ...tab }) => {
        // Reps land on "/" (App redirects to /today) — light the Today tab for
        // either location so the home screen always has an active tab.
        const active = href === "/today" ? location === "/today" || location === "/" : location === href;
        const primary = "primary" in tab && tab.primary;
        return (
          <Link
            key={href}
            href={href}
            data-testid={`tab-${label.toLowerCase()}`}
            aria-current={active ? "page" : undefined}
            className={`relative flex flex-col items-center justify-center gap-0.5 active:scale-95 transition-transform ${primary ? "-mt-2.5" : ""}`}
          >
            <span className={primary
              ? `grid h-11 w-11 place-items-center rounded-full border-4 border-card shadow-lg ${active ? "bg-primary text-primary-foreground" : "bg-foreground text-background"}`
              : `grid h-7 w-11 place-items-center rounded-full transition-colors ${active ? "bg-primary/[0.16] text-primary" : "text-muted-foreground"}`}>
              <Icon className={primary ? "w-5 h-5" : "w-[19px] h-[19px]"} strokeWidth={active ? 2.4 : 2} />
            </span>
            <span className={`text-2xs font-semibold ${active ? "text-primary" : "text-muted-foreground"}`}>
              {label}
            </span>
          </Link>
        );
      })}
      <button
        type="button"
        ref={moreButtonRef}
        data-testid="tab-more"
        aria-label="Open more navigation"
        aria-expanded={moreOpen}
        aria-controls="mobile-more-sheet"
        onClick={() => onMore ? onMore() : window.dispatchEvent(new CustomEvent("hfs:open-menu"))}
        className="flex flex-col items-center justify-center gap-0.5 active:scale-95"
      >
        <span className={`grid h-7 w-11 place-items-center rounded-full transition-colors ${moreOpen ? "bg-primary/[0.16] text-primary" : "text-muted-foreground"}`}><Menu className="w-[19px] h-[19px]" /></span>
        <span className={`text-2xs font-semibold ${moreOpen ? "text-primary" : "text-muted-foreground"}`}>More</span>
      </button>
      </div>
    </nav>
  );
}

export default BottomTabs;
