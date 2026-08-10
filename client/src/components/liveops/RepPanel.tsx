import { X } from "lucide-react";
import type { RepLiveState } from "@shared/liveOps";
import { StatusPill, FreshnessBadge, ageLabel } from "./StatusPill";
import { accuracyLabel } from "@/lib/fieldTracking";
import { Skeleton } from "@/components/ui/skeleton";

// ── One rep, in detail ───────────────────────────────────────────────────────
//
// The panel's job is to make an untrustworthy position obvious rather than
// hide it. Whenever the fix is stale the position block is replaced outright by
// a plain statement of when we last heard - there is no map reading, no
// coordinates, and no "approximately here". A supervisor deciding whether to
// drive somewhere should not have to work out for themselves that the pin is
// twenty minutes old.

interface Props {
  rep: RepLiveState | null;
  loading?: boolean;
  onClose: () => void;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-[14px] text-foreground">{value}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 bg-card p-3">
      <div className="text-[22px] font-bold leading-none tabular-nums text-foreground">{value}</div>
      <div className="mt-1 text-[11px] font-medium text-muted-foreground">{label}</div>
    </div>
  );
}

export function RepPanel({ rep, loading, onClose }: Props) {
  if (loading) {
    return (
      <aside className="flex w-full flex-col gap-4 border-l border-border bg-card p-5" data-testid="rep-panel-loading">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-16 w-full" />
      </aside>
    );
  }
  if (!rep) return null;

  const initials = rep.repName.split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("");
  const positionKnown = rep.lat != null && rep.lng != null;

  return (
    <aside
      className="flex w-full flex-col overflow-y-auto border-l border-border bg-card"
      aria-label={`${rep.repName} details`}
      data-testid="rep-panel"
    >
      <div className="sticky top-0 z-10 flex items-start gap-3 border-b border-border bg-card px-5 py-4">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-bold text-foreground">{rep.repName}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <StatusPill status={rep.status} />
            <FreshnessBadge freshness={rep.freshness} capturedAt={rep.capturedAt} />
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close details"
          className="-mr-2 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-5 px-5 py-4">
        {/* Position, or an honest account of its absence. */}
        <section>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Position</div>
          {positionKnown ? (
            <div className="mt-1.5 rounded-xl border border-border bg-background p-3">
              <div className="text-[14px] tabular-nums text-foreground">
                {rep.lat!.toFixed(5)}, {rep.lng!.toFixed(5)}
              </div>
              <div className="mt-1 text-[12px] text-muted-foreground">
                {accuracyLabel(rep.accuracyM)}
                {rep.accuracyM != null && ` · ±${Math.round(rep.accuracyM)} m`}
                {" · "}{ageLabel(rep.capturedAt)}
              </div>
            </div>
          ) : (
            <div
              className="mt-1.5 rounded-xl border border-dashed border-border bg-background p-3 text-[13px] text-muted-foreground"
              data-testid="rep-panel-no-position"
            >
              {rep.status === "location_unavailable"
                ? "This rep's device cannot provide a location right now."
                : rep.capturedAt
                  ? `No current position. Last heard ${ageLabel(rep.capturedAt)}.`
                  : "No position recorded for this shift."}
            </div>
          )}
        </section>

        <section className="grid grid-cols-2 gap-3">
          <Field label="Team lead" value={rep.teamLeadName ?? "Unassigned"} />
          <Field label="Manager" value={rep.managerName ?? "Unassigned"} />
          <Field
            label="Territory"
            value={
              rep.outsideTerritory ? (
                <span className="text-warning">Outside assigned area</span>
              ) : (rep.territoryName ?? "None")
            }
          />
          <Field
            label="Shift"
            value={rep.clockedInAt ? `Started ${ageLabel(rep.clockedInAt)}` : "Not clocked in"}
          />
          <Field label="Last door" value={rep.lastKnockAt ? ageLabel(rep.lastKnockAt) : "None today"} />
          <Field label="Status since" value={rep.statusSince ? ageLabel(rep.statusSince) : "Unknown"} />
        </section>

        <section>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Today
          </div>
          <div className="grid grid-cols-4 gap-px overflow-hidden rounded-xl border border-border bg-border">
            <Stat label="Doors" value={rep.doorsToday} />
            <Stat label="Interested" value={rep.interestedToday} />
            <Stat label="Appts" value={rep.appointmentsToday} />
            <Stat label="Sales" value={rep.salesToday} />
          </div>
        </section>
      </div>
    </aside>
  );
}
