import { useState } from "react";
import { Check, Pencil, X, ShieldCheck, AlertTriangle, Ban, History, Ruler, UserMinus } from "lucide-react";
import { can, type Role } from "@shared/permissions";
import { colorForRep } from "@shared/repColors";
import type { TerritoryStatus } from "@shared/territory";

// Location-verified progress for this territory (from /api/territories/progress).
export interface TerritoryProgress {
  total: number;
  verifiedWorkedLeads: number;
  areaWorkedPct: number;          // verifiedWorkedLeads ÷ total × 100 (2dp)
  verified: number;
  needsReview: number;
  invalid: number;
  avgDistanceM: number | null;
  maxAllowedDistanceM: number;
}

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
  progress?: TerritoryProgress;       // location-verified worked %
  onReclaim?: () => void;
  onComplete?: () => void;
  onReassign?: () => void;
  onRename?: (name: string) => void;  // provided for manager+ — shows the pencil
  onViewHistory?: () => void;         // opens the verified activity timeline
  /** Remove ONE rep from this area. Provided only when the caller may manage
   *  assignment; the chip's remove control is hidden entirely without it. */
  onUnassignRep?: (repId: number) => void;
  /** repId currently being removed — disables just that chip, not the list. */
  unassigningRepId?: number | null;
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
export function TerritoryDetailPanel({ territory, currentUser, teamNames, progress, onReclaim, onComplete, onReassign, onRename, onViewHistory, onUnassignRep, unassigningRepId }: TerritoryDetailPanelProps) {
  const role = currentUser.role as Role;
  const isUnassigned = territory.status === "unassigned" || territory.repIds.length === 0;
  const swatch = isUnassigned ? colorForRep(null) : (territory.color ?? colorForRep(territory.repIds[0]));
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(territory.name);
  // Two-step remove: taking an area off a rep pulls their doors back too, so it
  // asks before it acts rather than firing on a mis-tap next to the chip label.
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);
  // Removing ONE rep is assignment management, not whole-area reclamation, so it
  // rides on assign_territory (team_lead+) to match the route's requireTeamLead.
  // Gating it on reclaim_territory (manager+) meant a team lead could call the
  // API but never see the control — the permission the server enforces and the
  // permission the UI checks must be the same one.
  const canUnassign = Boolean(onUnassignRep) && can(role, "assign_territory");

  const saveName = () => {
    const next = draftName.trim();
    if (next && next !== territory.name) onRename?.(next);
    setEditingName(false);
  };

  return (
    // glass-surface glass-opaque: joins the map's liquid-glass family (this was
    // the one opaque bg-card orphan floating over the map — review finding);
    // glass-ink-scope keeps its semantic-token interior dark in BOTH app themes.
    <div className="glass-surface glass-opaque glass-ink-scope w-72 p-4" data-testid="territory-panel">
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <span
          data-testid="territory-color"
          className="mt-1 w-3.5 h-3.5 rounded-full flex-shrink-0 border border-white/20"
          style={{ backgroundColor: swatch }}
        />
        <div className="min-w-0 flex-1">
          {editingName ? (
            /* Inline rename — Enter/check saves, Esc/x cancels */
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }}
                maxLength={60}
                data-testid="territory-name-input"
                className="h-7 min-w-0 flex-1 rounded-md bg-secondary text-foreground text-sm font-semibold px-2 border border-border focus:outline-none focus:ring-2 focus:ring-teal-400/60"
                placeholder="Area name"
              />
              <button data-testid="territory-name-save" onClick={saveName} title="Save name"
                className="w-7 h-7 rounded-md flex items-center justify-center text-emerald-400 hover:bg-emerald-500/15 transition-colors flex-shrink-0">
                <Check className="w-4 h-4" />
              </button>
              <button onClick={() => setEditingName(false)} title="Cancel"
                className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-secondary transition-colors flex-shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 min-w-0">
              <h3 className="text-sm font-bold text-foreground truncate">{territory.name}</h3>
              {onRename && (
                <button
                  data-testid="territory-rename-btn"
                  onClick={() => { setDraftName(territory.name); setEditingName(true); }}
                  title="Rename area"
                  className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
          <span
            data-testid="territory-status"
            className={`inline-block mt-1 text-2xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${STATUS_STYLE[territory.status] ?? STATUS_STYLE.draft}`}
          >
            {territory.status}
          </span>
        </div>
      </div>

      {/* Assignees */}
      <div className="mt-3">
        <div className="text-2xs uppercase tracking-wide text-muted-foreground mb-1.5">
          {territory.repIds.length > 1 ? "Assigned reps" : "Assigned rep"}
        </div>
        {territory.repIds.length === 0 ? (
          <span className="text-xs text-muted-foreground italic">Unassigned — in the pool</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {territory.repIds.map(id => {
              const name = teamNames?.[id] ?? `Rep #${id}`;
              const confirming = confirmRemoveId === id;
              const busy = unassigningRepId === id;
              return (
                <span
                  key={id}
                  data-testid="rep-chip"
                  className={`inline-flex items-center gap-1.5 text-[11px] font-medium pl-2 ${canUnassign ? "pr-0.5" : "pr-2"} py-0.5 rounded-full ${
                    confirming ? "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/40" : "bg-secondary text-foreground"
                  } ${busy ? "opacity-60" : ""}`}
                >
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colorForRep(id) }} />
                  {confirming ? `Remove ${name}?` : name}
                  {canUnassign && (confirming ? (
                    <span className="inline-flex items-center gap-0.5">
                      <button
                        type="button"
                        aria-label={`Confirm removing ${name} from this area`}
                        data-testid={`confirm-unassign-${id}`}
                        disabled={busy}
                        onClick={() => { setConfirmRemoveId(null); onUnassignRep?.(id); }}
                        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-500/25 text-rose-200 hover:bg-rose-500/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60 disabled:opacity-50"
                      >
                        <Check className="w-3 h-3" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Keep ${name} assigned`}
                        data-testid={`cancel-unassign-${id}`}
                        onClick={() => setConfirmRemoveId(null)}
                        className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      >
                        <X className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Remove ${name} from this area`}
                      title={`Remove ${name} — their doors here return to the pool`}
                      data-testid={`unassign-rep-${id}`}
                      disabled={busy}
                      onClick={() => setConfirmRemoveId(id)}
                      className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-rose-500/20 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60 disabled:opacity-50"
                    >
                      <UserMinus className="w-3 h-3" aria-hidden="true" />
                    </button>
                  ))}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Area Worked — the primary metric (location-verified only) ── */}
      {progress ? (
        <div className="mt-3.5">
          <div className="flex items-baseline justify-between">
            <span
              className="text-2xs uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1"
              title="Area Worked = verified worked leads ÷ total leads. Only activities that pass location verification count."
            >
              Area Worked
              <span className="cursor-help text-muted-foreground/60" aria-hidden>ⓘ</span>
            </span>
            <span data-testid="area-worked-pct" className="text-2xl font-bold text-foreground tabular-nums leading-none">
              {progress.areaWorkedPct.toFixed(2)}<span className="text-sm font-semibold text-muted-foreground">%</span>
            </span>
          </div>
          {/* Accessible progress bar (value in aria + text, never colour alone) */}
          <div
            className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-secondary"
            role="progressbar"
            aria-valuenow={Math.round(progress.areaWorkedPct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Area worked ${progress.areaWorkedPct.toFixed(2)} percent`}
          >
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
              style={{ width: `${Math.min(100, Math.max(progress.areaWorkedPct, progress.areaWorkedPct > 0 ? 2 : 0))}%` }}
            />
          </div>
          <div data-testid="area-worked-caption" className="mt-1 text-xs text-muted-foreground">
            {progress.areaWorkedPct.toFixed(2)}% — {progress.verifiedWorkedLeads} of {progress.total} leads worked
          </div>

          {/* Verification summary — icon + text (WCAG: not colour alone) */}
          <div className="mt-3 grid grid-cols-3 gap-1.5" data-testid="verification-summary">
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-2 py-1.5 text-center">
              <div className="inline-flex items-center gap-1 text-emerald-400"><ShieldCheck className="h-3 w-3" /><span className="text-sm font-bold tabular-nums">{progress.verified}</span></div>
              <div className="text-2xs uppercase tracking-wide text-muted-foreground">Verified</div>
            </div>
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-2 py-1.5 text-center">
              <div className="inline-flex items-center gap-1 text-amber-400"><AlertTriangle className="h-3 w-3" /><span className="text-sm font-bold tabular-nums">{progress.needsReview}</span></div>
              <div className="text-2xs uppercase tracking-wide text-muted-foreground">Review</div>
            </div>
            <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-2 py-1.5 text-center">
              <div className="inline-flex items-center gap-1 text-red-400"><Ban className="h-3 w-3" /><span className="text-sm font-bold tabular-nums">{progress.invalid}</span></div>
              <div className="text-2xs uppercase tracking-wide text-muted-foreground">Invalid</div>
            </div>
          </div>

          {/* Distance summary */}
          <div className="mt-2.5 flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5" title="Average distance from the lead when marked (verified activities)">
              <Ruler className="h-3.5 w-3.5" />
              Avg {progress.avgDistanceM != null ? `${progress.avgDistanceM} m` : "—"}
            </span>
            <span title="Configured maximum allowed distance for a mark to verify">Max allowed {progress.maxAllowedDistanceM} m</span>
          </div>
        </div>
      ) : (
        // Fallback while progress loads: the plain counts we always had.
        <div className="mt-3 flex items-center gap-4">
          <div>
            <div data-testid="lead-count" className="text-lg font-bold text-foreground tabular-nums">{territory.leadCount}</div>
            <div className="text-2xs text-muted-foreground uppercase tracking-wide">Leads</div>
          </div>
          {territory.workedCount != null && (
            <div>
              <div className="text-lg font-bold text-foreground tabular-nums">{territory.workedCount}</div>
              <div className="text-2xs text-muted-foreground uppercase tracking-wide">Worked</div>
            </div>
          )}
        </div>
      )}

      {/* View Activity — opens the verified-activity history */}
      {onViewHistory && (
        <button
          data-testid="view-history-btn"
          onClick={onViewHistory}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-secondary"
        >
          <History className="h-3.5 w-3.5" /> View Activity
        </button>
      )}

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
