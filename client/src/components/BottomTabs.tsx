// Mobile field navigation follows the five-destination pattern used by shipped
// workforce and map apps: work queue, leads, one prominent map action, pay, and
// a More gateway. Every target is thumb-reachable and safe-area aware.

import { Link } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { Home, Map, DollarSign, MapPin, Menu } from "lucide-react";
import type { Ref } from "react";

const TABS = [
  { href: "/today", label: "Today", icon: Home },
  { href: "/leads", label: "Leads", icon: MapPin },
  { href: "/map", label: "Map", icon: Map, primary: true },
  { href: "/my-commission", label: "Pay", icon: DollarSign },
] as const;

export function BottomTabs({ onMore, moreOpen = false, moreButtonRef }: { onMore?: () => void; moreOpen?: boolean; moreButtonRef?: Ref<HTMLButtonElement> }) {
  const [location] = useHashLocation();
  return (
    <nav
      data-testid="bottom-tabs"
      aria-label="Primary navigation"
      className="md:hidden fixed inset-x-0 bottom-0 z-30 border-t border-border/80 bg-card shadow-[0_-8px_24px_rgba(0,0,0,0.18)]"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 6px)" }}
    >
      <div className="grid grid-cols-5 h-[58px] px-1">
      {TABS.map(({ href, label, icon: Icon, ...tab }) => {
        const active = location === href;
        const primary = "primary" in tab && tab.primary;
        return (
          <Link
            key={href}
            href={href}
            data-testid={`tab-${label.toLowerCase()}`}
            aria-current={active ? "page" : undefined}
            className={`relative flex flex-col items-center justify-center gap-0.5 active:scale-95 transition-transform ${primary ? "-mt-3" : ""}`}
          >
            <span className={primary
              ? `grid h-11 w-11 place-items-center rounded-full border-4 border-card shadow-lg ${active ? "bg-primary text-primary-foreground" : "bg-foreground text-background"}`
              : `grid h-7 w-9 place-items-center rounded-lg ${active ? "bg-primary/[0.12] text-primary" : "text-muted-foreground"}`}>
              <Icon className={primary ? "w-5 h-5" : "w-[19px] h-[19px]"} strokeWidth={active ? 2.4 : 2} />
            </span>
            <span className={`text-[10px] font-semibold ${active ? "text-primary" : "text-muted-foreground"}`}>
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
        <span className={`grid h-7 w-9 place-items-center rounded-lg ${moreOpen ? "bg-primary/[0.12] text-primary" : "text-muted-foreground"}`}><Menu className="w-[19px] h-[19px]" /></span>
        <span className={`text-[10px] font-semibold ${moreOpen ? "text-primary" : "text-muted-foreground"}`}>More</span>
      </button>
      </div>
    </nav>
  );
}

export default BottomTabs;
