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
//
// MOTION (iOS Liquid Glass, Mobbin refs: Tide Guide / ElevenLabs / Tubi):
// the in-glass active pill is ONE element that GLIDES between destinations
// (spring-feel translate, slight overshoot), the tapped icon does a quick
// scale pop, labels crossfade, and the whole bar rises+fades in once per app
// session. All motion is CSS/rAF-free compositor work — GPU transforms only,
// no layout animation, no dependencies — and collapses to instant state
// changes under prefers-reduced-motion (global reduced-motion block + an
// explicit guard in index.css).

import { Link } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { Home, Map, DollarSign, MapPin, Menu } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { can, type Role } from "@shared/capabilities";
import { navIntentHandlers, prefetchRoute, canPrefetch, canPrefetchRouteChunks } from "@/lib/routePrefetch";

// Each tab is capability-gated: roles without field.app.use (e.g. calling-only
// or audit roles) never see dead field tabs, and Pay only shows when the role
// can read its own commission.
// Icon + label per destination, the shipped five-tab pattern (Mobbin:
// DoorDash / Opendoor / Turo / GoHenry). The ACTIVE destination wears the
// brand tint on both its icon and its label - those apps all colour the active
// tab rather than merely darkening it, and on a phone held at arm's length in
// sunlight a tint reads faster than a weight change.
const TABS = [
  { href: "/today", label: "Today", icon: Home, cap: "field.app.use" },
  { href: "/leads", label: "Leads", icon: MapPin, cap: "field.app.use" },
  { href: "/map", label: "Map", icon: Map, primary: true, cap: "field.app.use" },
  { href: "/my-commission", label: "Pay", icon: DollarSign, cap: "commission.read.self" },
] as const;

// Tailwind needs static class names — one entry per possible cell count
// (visible tabs + the always-present More button).
const GRID_COLS = ["grid-cols-1", "grid-cols-2", "grid-cols-3", "grid-cols-4", "grid-cols-5"] as const;

// The sliding lozenge's fixed footprint. It is a touch LARGER than the h-7 w-11
// icon capsule (56x40 vs 44x28) so the active icon floats centered on a soft
// frosted squircle with breathing room — the iOS-26 / Instagram look.
// Positioning is MEASURED, not derived from slot math: each tab's icon capsule
// is a data-pill-anchor ref, and the pill centers on the active anchor's rect
// relative to the bar. That stays exact at every viewport width regardless of
// grid padding, safe-area insets, or how many capability-gated tabs render.
const PILL_W = 56;
const PILL_H = 40;

// The entrance animation (rise + fade) runs ONCE per app session. BottomTabs
// unmounts on the full-bleed map and calling routes, so a mount-scoped flag
// would replay the entrance on every return trip — module scope survives.
let barHasEntered = false;
/** Test-only: lets the suite exercise the run-once entrance deterministically. */
export function __resetBarEntranceForTests() { barHasEntered = false; }

export function BottomTabs({ role, onMore, moreOpen = false, moreButtonRef, moreDot = false }: { role: Role; onMore?: () => void; moreOpen?: boolean; moreButtonRef?: Ref<HTMLButtonElement>; moreDot?: boolean }) {
  const [location] = useHashLocation();
  const visibleTabs = TABS.filter(tab => can(role, tab.cap));

  // Reps land on "/" (App redirects to /today) — light the Today tab for
  // either location so the home screen always has an active tab.
  const isActive = (href: string) =>
    href === "/today" ? location === "/today" || location === "/" : location === href;
  const activeIndex = visibleTabs.findIndex(tab => isActive(tab.href));
  const activeHref = activeIndex >= 0 ? visibleTabs[activeIndex].href : null;

  const barRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);
  const anchorRefs = useRef<(HTMLSpanElement | null)[]>([]);

  // Entrance: captured once at first mount of the session, constant thereafter
  // so route changes within tabs never replay it.
  const [entering] = useState(() => !barHasEntered);
  useEffect(() => { barHasEntered = true; }, []);

  // Position the ONE sliding pill under the active destination. `animate=false`
  // snaps instantly (first paint, resize/rotation); `animate=true` lets the
  // spring transition in .liquid-active-pill glide it. Inline
  // transition-duration:0s is the snap switch — it and the new transform land
  // in the same style recalc, so a snap can never half-animate.
  const positionPill = useCallback((animate: boolean) => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return;
    const anchor = activeIndex >= 0 ? anchorRefs.current[activeIndex] : null;
    if (!anchor) { pill.style.opacity = "0"; return; }
    const barBox = bar.getBoundingClientRect();
    const box = anchor.getBoundingClientRect();
    const x = box.left - barBox.left + (box.width - PILL_W) / 2;
    const y = box.top - barBox.top + (box.height - PILL_H) / 2;
    pill.style.transitionDuration = animate ? "" : "0s";
    pill.style.opacity = "1";
    pill.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, [activeIndex]);

  // First paint snaps into place before the user sees anything; every active
  // change after that glides. useLayoutEffect keeps the snap pre-paint.
  const firstPaint = useRef(true);
  useLayoutEffect(() => {
    positionPill(!firstPaint.current);
    firstPaint.current = false;
  }, [positionPill]);

  // Resize / rotation re-measures and snaps (no glide while the viewport is
  // mid-resize). Guarded — jsdom has no ResizeObserver.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => positionPill(false));
    ro.observe(bar);
    return () => ro.disconnect();
  }, [positionPill]);

  // Icon pop + haptic tick on tab CHANGE only — never on first mount, so the
  // entrance stays a single quiet rise. `popped` re-keys the pop class to the
  // incoming tab; removing it from the outgoing tab lets its tint crossfade
  // out via transition-colors.
  const [popped, setPopped] = useState<string | null>(null);
  const prevActive = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevActive.current !== undefined && prevActive.current !== activeHref && activeHref) {
      setPopped(activeHref);
      try { navigator.vibrate?.(8); } catch { /* haptics are best-effort */ }
    }
    prevActive.current = activeHref;
  }, [activeHref]);

  // The four bottom destinations ARE the app for a rep — they switch between
  // them all shift. Warm every visible tab's chunk once the browser goes idle so
  // the second, third and fourth tap never wait on a network round-trip. Code
  // only (a few tens of KB, cached immutably); data still warms on touch intent,
  // where it is current rather than stale by the time it is read.
  const tabHrefs = visibleTabs.map(t => t.href).join(",");
  useEffect(() => {
    if (!canPrefetchRouteChunks()) return;
    // The map chunk is ~10x the size of the other tabs (284KB + the mapbox CDN
    // lib its loader kicks) — it keeps the strict data gate; the small tab
    // chunks warm even on 3G, where paying tens of KB idle beats paying them
    // at tap time.
    const warm = () => {
      for (const href of tabHrefs.split(",")) {
        if (href === "/map" && !canPrefetch()) continue;
        prefetchRoute(href);
      }
    };
    const idle = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (idle.requestIdleCallback) {
      const id = idle.requestIdleCallback(warm, { timeout: 4000 });
      return () => idle.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(warm, 2500);
    return () => window.clearTimeout(timer);
  }, [tabHrefs]);

  return (
    <nav
      data-testid="bottom-tabs"
      aria-label="Primary navigation"
      className={`liquid-bar ${entering ? "liquid-bar-enter " : ""}md:hidden fixed inset-x-3 z-30`}
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 10px)" }}
    >
      <div ref={barRef} className={`relative grid ${GRID_COLS[visibleTabs.length]} h-[62px] px-1.5`}>
      {/* THE in-glass active pill — one element, moved by GPU transform only.
          First in DOM so the relative-positioned tab content paints above it. */}
      <span ref={pillRef} data-testid="tab-active-pill" aria-hidden="true" className="liquid-active-pill" />
      {visibleTabs.map(({ href, label, icon: Icon, ...tab }, index) => {
        const active = isActive(href);
        const primary = "primary" in tab && tab.primary;
        return (
          <Link
            key={href}
            href={href}
            data-testid={`tab-${label.toLowerCase()}`}
            aria-current={active ? "page" : undefined}
            {...navIntentHandlers(href)}
            className={`relative flex flex-col items-center justify-center gap-0.5 active:scale-[.94] transition-transform ${primary ? "-mt-2.5" : ""}`}
          >
            <span
              ref={el => { anchorRefs.current[index] = el; }}
              data-pill-anchor
              className={`${popped === href ? "tab-icon-pop " : ""}${primary
                ? `grid h-11 w-11 place-items-center rounded-full border-4 border-card shadow-lg transition-colors ${active ? "bg-primary text-primary-foreground" : "bg-foreground text-background"}`
                : `grid h-7 w-11 place-items-center rounded-full transition-colors ${active ? "text-primary" : "text-muted-foreground"}`}`}>
              <Icon className={primary ? "w-5 h-5" : "w-[19px] h-[19px]"} strokeWidth={active ? 2.4 : 2} />
            </span>
            <span className={`text-2xs font-semibold transition-colors ${active ? "text-primary" : "text-muted-foreground"}`}>
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
        className="relative flex flex-col items-center justify-center gap-0.5 active:scale-[.94] transition-transform"
      >
        <span className={`relative grid h-7 w-11 place-items-center rounded-2xl transition-colors ${moreOpen ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}>
          <Menu className="w-[19px] h-[19px]" />
          {moreDot && (
            <span
              data-testid="tab-more-dot"
              aria-hidden="true"
              className="absolute right-1.5 top-0 h-2 w-2 rounded-full bg-red-500 ring-2 ring-[hsl(var(--card))]"
            />
          )}
        </span>
        <span className={`text-2xs font-semibold transition-colors ${moreOpen ? "text-primary" : "text-muted-foreground"}`}>More</span>
      </button>
      </div>
    </nav>
  );
}

export default BottomTabs;
