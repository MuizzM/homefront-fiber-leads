import { can, type Role } from "@shared/permissions";
import { colorForRep } from "@shared/repColors";
import type { TerritoryStatus } from "@shared/territory";

export interface TerritoryDetailPanelProps {
  territory: {
    id: number;
    name: string;
    status: TerritoryStatus;
    repIds: number[];
    color?: string;
    leadCount: number;
    workedCount?: number;
  };
  currentUser: { role: Role | string };
  teamNames?: Record<number, string>; // repId → display name (optional)
  onReclaim?: () => void;
  onComplete?: () => void;
  onReassign?: () => void;
}

const STATUS_STYLE: Record<string, string> = {
  active:     "bg-emerald-500/15 text-emerald-400",
  shared:     "bg-blue-500/15 text-blue-400",
  completed:  "bg-slate-500/15 text-slate-300",
  reclaimed:  "bg-amber-500/15 text-amber-400",
  unassigned: "bg-zinc-500/15 text-zinc-400",
  archived:   "bg-zinc-700/20 text-zinc-500",
  draft:      "bg-slate-500/15 text-slate-400",
};

/**
 * Area info panel — the SalesRabbit-style popout for a territory. Shows who owns
 * it (multi-rep chips), status, lead count, and role-gated lifecycle actions.
 */
export function TerritoryDetailPanel({ territory, currentUser, teamNames, onReclaim, onComplete, onReassign }: TerritoryDetailPanelProps) {
  const role = currentUser.role as Role;
  const isUnassigned = territory.status === "unassigned" || territory.repIds.length === 0;
  const swatch = isUnassigned ? colorForRep(null) : (territory.color ?? colorForRep(territory.repIds[0]));

  return (
    <div className="w-72 rounded-xl border border-border bg-card p-4 shadow-xl" data-testid="territory-panel">
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <span
          data-testid="territory-color"
          className="mt-1 w-3.5 h-3.5 rounded-full flex-shrink-0 border border-white/20"
          style={{ backgroundColor: swatch }}
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-foreground truncate">{territory.name}</h3>
          <span
            data-testid="territory-status"
            className={`inline-block mt-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${STATUS_STYLE[territory.status] ?? STATUS_STYLE.draft}`}
          >
            {territory.status}
          </span>
        </div>
      </div>

      {/* Assignees */}
      <div className="mt-3">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
          {territory.repIds.length > 1 ? "Assigned reps" : "Assigned rep"}
        </div>
        {territory.repIds.length === 0 ? (
          <span className="text-xs text-muted-foreground italic">Unassigned — in the pool</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {territory.repIds.map(id => (
              <span
                key={id}
                data-testid="rep-chip"
                className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-secondary text-foreground"
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colorForRep(id) }} />
                {teamNames?.[id] ?? `Rep #${id}`}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Counts */}
      <div className="mt-3 flex items-center gap-4">
        <div>
          <div data-testid="lead-count" className="text-lg font-bold text-foreground tabular-nums">{territory.leadCount}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Leads</div>
        </div>
        {territory.workedCount != null && (
          <div>
            <div className="text-lg font-bold text-foreground tabular-nums">{territory.workedCount}</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Worked</div>
          </div>
        )}
      </div>

      {/* Role-gated actions */}
      {can(role, "reclaim_territory") && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            data-testid="reclaim-btn"
            onClick={onReclaim}
            className="flex-1 h-8 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 transition-colors"
          >
            Reclaim
          </button>
          {onReassign && (
            <button
              data-testid="reassign-btn"
              onClick={onReassign}
              className="flex-1 h-8 rounded-lg text-xs font-semibold bg-secondary text-foreground hover:bg-secondary/70 transition-colors"
            >
              Reassign
            </button>
          )}
          {onComplete && (
            <button
              data-testid="complete-btn"
              onClick={onComplete}
              className="flex-1 h-8 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors"
            >
              Complete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default TerritoryDetailPanel;
