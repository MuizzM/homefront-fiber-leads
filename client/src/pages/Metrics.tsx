// ── Metrics — the shell ──────────────────────────────────────────────────────
//
// One route, six sub-pages, a segmented switcher. That shape is deliberate on a
// phone: six sidebar entries is six taps away from each other, while a segmented
// control keeps the whole feature one thumb-reach wide and preserves the
// scrolled position of the page around it. The sidebar still lists the sub-pages
// for desktop users who navigate that way; both point at the same routes.
//
// EVERY TAB IS CAPABILITY-GATED, and the gate reads the same shared map the
// server authorizes against. A tab the API would refuse is never rendered - not
// disabled, not empty, absent - which is the house convention (see
// client/src/lib/capabilities.ts) and the only version of this that cannot
// mislead somebody into thinking they lost access to something they had.

import { useRoute, useLocation } from "wouter";
import { PageHeader } from "@/components/ui/page-scaffold";
import { useCan } from "@/lib/capabilities";
import { useAuth } from "@/lib/auth";
import { MyMetrics } from "@/components/metrics/MyMetrics";
import { TeamMetrics } from "@/components/metrics/TeamMetrics";
import { TerritoryMetrics } from "@/components/metrics/TerritoryMetrics";
import { CoachingBoard } from "@/components/metrics/CoachingBoard";
import { Reports } from "@/components/metrics/Reports";
import type { Capability } from "@shared/capabilities";

export interface MetricsTab {
  key: string;
  label: string;
  capability: Capability;
  subtitle: string;
}

/** The tab order is the reading order: your own numbers, then your team's, then
 *  the ground, then what to do about it, then live, then the org. */
export const METRICS_TABS: MetricsTab[] = [
  { key: "my", label: "My Metrics", capability: "dashboard.read.self", subtitle: "Your doors, conversion and field time" },
  { key: "team", label: "Team Metrics", capability: "dashboard.read.team", subtitle: "Activity and conversion across your team" },
  { key: "territory", label: "Territory Metrics", capability: "dashboard.read.team", subtitle: "Utilization, coverage and areas needing review" },
  { key: "coaching", label: "Coaching Insights", capability: "coaching.read.team", subtitle: "Explainable findings, each with a suggested action" },
  { key: "live", label: "Live Field Activity", capability: "field.location.read.team", subtitle: "Who is in the field right now" },
  { key: "reports", label: "Reports", capability: "dashboard.read.org", subtitle: "Yield by team, carrier, product and program" },
];

export default function Metrics() {
  const [, params] = useRoute("/metrics/:tab");
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const role = user?.role;

  // One hook call per tab, unconditionally, in a fixed order - hooks cannot be
  // called from inside a filter callback.
  const allowed: Record<string, boolean> = {
    my: useCan("dashboard.read.self"),
    team: useCan("dashboard.read.team"),
    territory: useCan("dashboard.read.team"),
    coaching: useCan("coaching.read.team"),
    live: useCan("field.location.read.team"),
    reports: useCan("dashboard.read.org"),
  };

  const tabs = METRICS_TABS.filter((t) => allowed[t.key]);
  const requested = params?.tab ?? "";
  // A rep deep-linked to /metrics/team gets their own metrics rather than an
  // access-denied card: the tab simply is not theirs, and the useful response is
  // the page they do have.
  const active = tabs.find((t) => t.key === requested) ?? tabs[0];

  if (!active) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6">
        <PageHeader title="Metrics" subtitle="No metrics surfaces are available for your role." />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6">
      <PageHeader title="Metrics" subtitle={active.subtitle} />

      {tabs.length > 1 && (
        <div className="-mx-4 mt-4 flex gap-1 overflow-x-auto px-4 pb-1 md:-mx-6 md:px-6"
             role="tablist" aria-label="Metrics sections">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={t.key === active.key}
              onClick={() => navigate(`/metrics/${t.key}`)}
              className={`shrink-0 rounded-full px-3.5 py-2 text-[13px] font-semibold transition-colors ${
                t.key === active.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`metrics-tab-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="mt-5">
        {active.key === "my" && <MyMetrics />}
        {active.key === "team" && <TeamMetrics />}
        {active.key === "territory" && <TerritoryMetrics />}
        {active.key === "coaching" && <CoachingBoard />}
        {active.key === "reports" && <Reports />}
        {active.key === "live" && <LiveHandoff />}
      </div>

      <p className="mt-8 text-[11px] leading-relaxed text-muted-foreground">
        Numbers are rolled up in the background and are typically under a minute old. Rates with no
        denominator show as a dash rather than zero, because a rep who knocked no doors has no contact
        rate rather than a bad one. Every metric card explains its own formula behind the question mark.
        Role: {role}.
      </p>
    </div>
  );
}

/**
 * Live Field Activity already exists as a full screen (/live-ops), built around
 * the live-state table, the SSE stream and the audited history export.
 *
 * Rebuilding it inside this tab would mean a second read path over the same
 * location data, re-deriving the same branch scope - and a mistake in that
 * derivation would push one manager's reps into another manager's browser. So
 * this tab points at the existing screen instead of duplicating it. The nav
 * entry and the tab both lead to one implementation with one audit trail.
 */
function LiveHandoff() {
  const [, navigate] = useLocation();
  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <h2 className="text-[15px] font-bold tracking-tight text-foreground">Live Field Activity</h2>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        Live positions, territory boundaries, coverage trails and the audited history export live on the
        Live Operations screen. It is one implementation with one audit trail, rather than a second view
        over the same location data.
      </p>
      <button
        type="button"
        onClick={() => navigate("/live-ops")}
        className="mt-3 rounded-xl bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-foreground"
        data-testid="open-live-ops"
      >
        Open Live Operations
      </button>
    </div>
  );
}
