import { useState } from "react";
import { Check, Pencil, X, UserMinus } from "lucide-react";
import { FOCUS } from "@/lib/a11y";
import { can, type Role } from "@shared/permissions";
import { repColorOf } from "@shared/repColors";
import { territoryColor } from "@/lib/territoryStyle";
import { TerritoryColorPicker } from "@/components/territory/TerritoryColorPicker";
import { AreaStatsCard } from "@/components/territory/AreaStatsCard";
import { shortDate } from "@shared/territoryLabel";
import type { TerritoryStatus } from "@shared/territory";

// Location-verified progress for this territory (from /api/territories/progress).
export interface TerritoryProgress {
  total: number;
  verifiedWorkedLeads: number;
  areaWorkedPct: number;          // verifiedWorkedLeads ÷ total × 100 (2dp)
  // The operational figures. The progress endpoint has been returning knocked
  // and sold all along; this type simply dropped them, so the panel could not
  // show numbers that were already on the wire. Optional because older cached
  // responses predate the rest.
  knocked?: number;
  sold?: number;
  untouched?: number;
  availableBase?: number;
  attempts?: number;
  penetrationRate?: number;
  knockCompletionRate?: number;
  contactRate?: number;
  lastActivityAt?: string | null;
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
  /** repId → persisted rep colour (team_members.color from /api/team). Absent
   *  entries (or the whole map) fall back to the legacy repId-hash hue, so
   *  callers that don't have the roster loaded render exactly as before. */
  teamColors?: Record<number, string | null | undefined>;
  progress?: TerritoryProgress;       // location-verified worked %
  onReclaim?: () => void;
  /** True while the reclaim mode chooser this button toggles is on screen —
   *  drives aria-expanded and the button's pressed look, so toggling it open
   *  and closed is legible instead of a button that "does nothing" twice. */
  reclaimOpen?: boolean;
  onComplete?: () => void;
  /** True while the two-step Complete confirm is armed — the button re-labels
   *  to "Sure? Tap again" so the second tap is an informed one. Completing
   *  stamps this area's outcome into market memory, so it must not fire on a
   *  single mis-tap next to Reclaim. */
  completeConfirming?: boolean;
  /** True while the complete request is in flight — disables the button. */
  completing?: boolean;
  onReassign?: () => void;
  onRename?: (name: string) => void;  // provided for manager+ — shows the pencil
  /** Change the area's colour. Provided only when the caller may edit the area;
   *  without it the swatch stays a read-only dot, as it was. */
  onRecolor?: (color: string) => void;
  onViewHistory?: () => void;         // opens the verified activity timeline
  /** Re-open this area for another sweep (manager+). Opens the confirm dialog
   *  rather than acting immediately — a pass reset clears the whole team's
   *  outcomes and has no undo. */
  onStartNextPass?: () => void;
  /** Which sweep this area is on. 1 (or absent) means it has never been reset. */
  currentPass?: number;
  /** ISO date this area was handed to its current rep. */
  assignedAt?: string | null;
  /** Open the "who works this area" editor. An area can be shared by several
   *  reps, so this edits the whole holder set rather than a single owner. */
  onEditAssignees?: () => void;
  /** Remove ONE rep from this area. Provided only when the caller may manage
   *  assignment; the chip's remove control is hidden entirely without it. */
  onUnassignRep?: (repId: number) => void;
  /** repId currently being removed — disables just that chip, not the list. */
  unassigningRepId?: number | null;
}

const STATUS_STYLE: Record<string, string> = {
  active:     "bg-success/10 text-success",
  shared:     "bg-info/10 text-info",
  // The four quiet states are all "no signal to act on", which is what --muted
  // is for. They were three different raw greys (slate-300, zinc-400, zinc-500,
  // slate-400) picked against the old dark ground; on the light default they
  // land between 1.8:1 and 3.1:1, so the statuses nobody needs to act on were
  // also the ones nobody could read.
  completed:  "bg-muted text-muted-foreground",
  reclaimed:  "bg-warning/10 text-warning",
  unassigned: "bg-muted text-muted-foreground",
  archived:   "bg-muted text-muted-foreground",
  draft:      "bg-muted text-muted-foreground",
};

/**
 * Area info panel — the SalesRabbit-style popout for a territory. Shows who owns
 * it (multi-rep chips), status, lead count, and role-gated lifecycle actions.
 */
export function TerritoryDetailPanel({ territory, currentUser, teamNames, teamColors, progress, onReclaim, reclaimOpen = false, onComplete, completeConfirming = false, completing = false, onReassign, onRename, onRecolor, onViewHistory, onUnassignRep, unassigningRepId, onStartNextPass, currentPass, assignedAt, onEditAssignees }: TerritoryDetailPanelProps) {
  const role = currentUser.role as Role;
  const isUnassigned = territory.status === "unassigned" || territory.repIds.length === 0;
  // A person's hue: persisted team_members.color when the caller supplied the
  // roster colours, the legacy hash otherwise — repColorOf in both cases.
  const repHue = (id: number | null) => repColorOf(id == null ? null : { id, color: teamColors?.[id] });
  // The SAME rule the map paints the polygon with: the area's own stored colour,
  // falling back to the primary rep's hue only for rows written before the
  // colour was captured. An earlier revision computed this from colorForRep
  // unconditionally, which was right when the map did too — but the map now
  // prefers the stored value, so this swatch would have shown one colour while
  // the region on screen showed another. One rule, one source.
  //
  // The rep chips below stay on the rep's own hue deliberately: those dots
  // identify a PERSON, and a person's hue is not a property of the ground.
  const swatch = territoryColor(
    { color: territory.color, status: territory.status },
    repHue(isUnassigned ? null : territory.repIds[0]),
  );
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
        {onRecolor ? (
          // Editable: the swatch IS the control, so changing an area's colour is
          // where you already look for its colour rather than behind a menu.
          // Rendered at the picker's native h-11 size: the old scale-[0.42]
          // wrapper shrank the hit target to ~18px along with the visual, which
          // failed the 44px bar — a mis-tap magnet on a field phone.
          <div className="flex-shrink-0" data-testid="territory-color-edit">
            {/* direction="down": this panel sits at the top of the viewport
                inside an overflow-y-auto wrapper, where the default upward grid
                opens into clipped negative overflow and is simply invisible. */}
            <TerritoryColorPicker value={swatch} onChange={onRecolor} label="Area colour" direction="down" />
          </div>
        ) : (
          <span
            data-testid="territory-color"
            className="mt-1 w-3.5 h-3.5 rounded-full flex-shrink-0 border border-white/20"
            style={{ backgroundColor: swatch }}
          />
        )}
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
                className="h-9 min-w-0 flex-1 rounded-md bg-secondary text-foreground text-sm font-semibold px-2 border border-border focus:outline-none focus:ring-2 focus:ring-success/60"
                placeholder="Area name"
              />
              {/* 36px visual, 44px effective target via the ::after halo. */}
              <button type="button" data-testid="territory-name-save" onClick={saveName} title="Save name"
                aria-label="Save name"
                className={`relative w-9 h-9 rounded-md flex items-center justify-center text-success hover:bg-success/10 transition-colors flex-shrink-0 after:absolute after:-inset-1 after:content-[''] ${FOCUS}`}>
                <Check className="w-4 h-4" aria-hidden="true" />
              </button>
              <button type="button" data-testid="territory-name-cancel" onClick={() => setEditingName(false)} title="Cancel"
                aria-label="Cancel rename"
                className={`relative w-9 h-9 rounded-md flex items-center justify-center text-muted-foreground hover:bg-secondary transition-colors flex-shrink-0 after:absolute after:-inset-1 after:content-[''] ${FOCUS}`}>
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 min-w-0">
              <h3 className="text-sm font-bold text-foreground truncate">{territory.name}</h3>
              {onRename && (
                <button
                  type="button"
                  data-testid="territory-rename-btn"
                  onClick={() => { setDraftName(territory.name); setEditingName(true); }}
                  title="Rename area"
                  aria-label="Rename area"
                  className={`relative w-9 h-9 -my-1.5 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0 after:absolute after:-inset-1 after:content-[''] ${FOCUS}`}
                >
                  <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
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
          <span className="text-xs text-muted-foreground italic">Unassigned - in the pool</span>
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
                    confirming ? "bg-destructive/10 text-destructive ring-1 ring-destructive/30" : "bg-secondary text-foreground"
                  } ${busy ? "opacity-60" : ""}`}
                >
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: repHue(id) }} />
                  {confirming ? `Remove ${name}?` : name}
                  {canUnassign && (confirming ? (
                    <span className="inline-flex items-center gap-0.5">
                      <button
                        type="button"
                        aria-label={`Confirm removing ${name} from this area`}
                        data-testid={`confirm-unassign-${id}`}
                        disabled={busy}
                        onClick={() => { setConfirmRemoveId(null); onUnassignRep?.(id); }}
                        className="relative inline-flex h-6 w-6 items-center justify-center rounded-full bg-destructive/15 text-rose-200 hover:bg-destructive/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/60 disabled:opacity-50 after:absolute after:-inset-y-2.5 after:-inset-x-0.5 after:content-['']"
                      >
                        <Check className="w-3 h-3" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Keep ${name} assigned`}
                        data-testid={`cancel-unassign-${id}`}
                        onClick={() => setConfirmRemoveId(null)}
                        className="relative inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 after:absolute after:-inset-y-2.5 after:-inset-x-0.5 after:content-['']"
                      >
                        <X className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Remove ${name} from this area`}
                      title={`Remove ${name} - their doors here return to the pool`}
                      data-testid={`unassign-rep-${id}`}
                      disabled={busy}
                      onClick={() => setConfirmRemoveId(id)}
                      className="relative inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/[0.12] hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/60 disabled:opacity-50 after:absolute after:-inset-y-2.5 after:-inset-x-0.5 after:content-['']"
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
          {/* Operational figures. The endpoint has returned knocked and sold all
              along; the panel simply never showed them, so a manager had a
              location-verification percentage and no idea how much of the area was
              actually walked. Every rate divides by the same base (see
              shared/territoryMetrics) so the numbers on this card agree. */}
          {progress.knocked != null && (
            <div className="mb-3 pb-3 border-b border-white/10" data-testid="territory-stats">
              {/* One card, one hierarchy. This was a flat 3-column grid of
                  equal-weight figures plus a separate bar — nine numbers all
                  shouting at the same volume, so a manager scanning twenty areas
                  had to read all nine to find the one they came for. The hero
                  number is now doors worked, with the ring as a garnish on it
                  rather than a competitor, and every rate states the denominator
                  it divides by. See AreaStatsCard for the borrowed patterns. */}
              <AreaStatsCard
                total={progress.total}
                availableBase={progress.availableBase}
                knocked={progress.knocked}
                sold={progress.sold}
                untouched={progress.untouched ?? Math.max(0, (progress.availableBase ?? progress.total) - progress.knocked)}
                penetrationRate={progress.penetrationRate}
                knockCompletionRate={progress.knockCompletionRate}
                contactRate={progress.contactRate}
                color={swatch}
              />
              {progress.lastActivityAt && (
                <div className="mt-1.5 text-2xs text-muted-foreground" data-testid="stat-last-activity">
                  Last activity {shortDate(progress.lastActivityAt)}
                </div>
              )}
            </div>
          )}

          <div className="flex items-baseline justify-between">
            <span
              className="text-2xs uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1"
              title="Area Worked = verified worked leads ÷ total leads. Only activities that pass location verification count."
            >
              Area Worked
              
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
              className="h-full rounded-full bg-success transition-[width] duration-500"
              style={{ width: `${Math.min(100, Math.max(progress.areaWorkedPct, progress.areaWorkedPct > 0 ? 2 : 0))}%` }}
            />
          </div>
          <div data-testid="area-worked-caption" className="mt-1 text-xs text-muted-foreground">
            {progress.areaWorkedPct.toFixed(2)}% - {progress.verifiedWorkedLeads} of {progress.total} leads worked
          </div>

          {/* Verification summary — icon + text (WCAG: not colour alone) */}
          <div className="mt-3 grid grid-cols-3 gap-1.5" data-testid="verification-summary">
            <div className="rounded-lg border border-success/15 bg-success/[0.08] px-2 py-1.5 text-center">
              <div className="inline-flex items-center gap-1 text-success"><span className="text-sm font-bold tabular-nums">{progress.verified}</span></div>
              <div className="text-2xs uppercase tracking-wide text-muted-foreground">Verified</div>
            </div>
            <div className="rounded-lg border border-warning/15 bg-warning/[0.08] px-2 py-1.5 text-center">
              <div className="inline-flex items-center gap-1 text-warning"><span className="text-sm font-bold tabular-nums">{progress.needsReview}</span></div>
              <div className="text-2xs uppercase tracking-wide text-muted-foreground">Review</div>
            </div>
            <div className="rounded-lg border border-destructive/15 bg-destructive/[0.08] px-2 py-1.5 text-center">
              <div className="inline-flex items-center gap-1 text-destructive"><span className="text-sm font-bold tabular-nums">{progress.invalid}</span></div>
              <div className="text-2xs uppercase tracking-wide text-muted-foreground">Invalid</div>
            </div>
          </div>

          {/* Distance summary */}
          <div className="mt-2.5 flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5" title="Average distance from the lead when marked (verified activities)">
              
              Avg {progress.avgDistanceM != null ? `${progress.avgDistanceM} m` : " - "}
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
          type="button"
          data-testid="view-history-btn"
          onClick={onViewHistory}
          className={`mt-3 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary ${FOCUS}`}
        >
           View Activity
        </button>
      )}

      {/* Several reps can work one area. The chips above show who; this edits the
          set — add a second rep, or take one off — in one place, so "who works
          this" is a single decision rather than an assign here and a remove there. */}
      {onEditAssignees && can(role, "assign_territory") && (
        <button
          type="button"
          data-testid="edit-assignees-btn"
          onClick={onEditAssignees}
          className={`mt-3 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary ${FOCUS}`}
        >
          
          {territory.repIds.length > 1
            ? `${territory.repIds.length} reps on this area`
            : "Who works this area"}
        </button>
      )}

      {/* How long the current rep has had it. "Assigned 3 weeks ago" is the cue
          that an area is going stale — a date alone makes you do that maths. */}
      {assignedAt && territory.repIds.length > 0 && (
        <div data-testid="territory-assigned-at" className="mt-3 text-xs text-muted-foreground">
          Assigned {shortDate(assignedAt)}
          {(() => {
            const days = Math.floor((Date.now() - new Date(assignedAt).getTime()) / 86_400_000);
            return Number.isFinite(days) && days >= 1
              ? ` · ${days === 1 ? "1 day" : `${days} days`} ago`
              : "";
          })()}
        </div>
      )}

      {/* Knock it again. Sits with the other manager actions but reads as its own
          step, because "start pass 3" is a different decision from "reclaim". */}
      {onStartNextPass && can(role, "reset_territory_pass") && (
        <button
          type="button"
          data-testid="next-pass-btn"
          onClick={onStartNextPass}
          className={`mt-3 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary ${FOCUS}`}
        >
          
          Start pass {(currentPass ?? 1) + 1}
        </button>
      )}

      {/* Role-gated actions.
          Gated on the HANDLER as well as the role. Reclaim used to render
          whenever the viewer's role permitted it, while MapView only supplies
          onReclaim for an area somebody actually holds — so on a pool area the
          button appeared, fully styled and enabled, wired to onClick={undefined}.
          Tapping it did nothing at all, which reads as "reclaim is broken"
          because from the outside it is indistinguishable from a failed request.
          A control you cannot use should not be on screen; the role decides
          whether you MAY, the handler decides whether there is anything TO do. */}
      {can(role, "reclaim_territory") && (onReclaim || onReassign || onComplete) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {onReclaim && (
          <button
            type="button"
            data-testid="reclaim-btn"
            onClick={onReclaim}
            aria-expanded={reclaimOpen}
            aria-haspopup="menu"
            className={`flex-1 h-11 rounded-lg text-xs font-semibold transition-colors ${
              reclaimOpen
                ? "bg-warning/25 text-warning ring-1 ring-warning/50"
                : "bg-warning/10 text-warning hover:bg-warning/15"
            } ${FOCUS}`}
          >
            Reclaim
          </button>
          )}
          {onReassign && (
            <button
              type="button"
              data-testid="reassign-btn"
              onClick={onReassign}
              className={`flex-1 h-11 rounded-lg text-xs font-semibold bg-secondary text-foreground hover:bg-secondary/70 transition-colors ${FOCUS}`}
            >
              Reassign
            </button>
          )}
          {onComplete && (
            <button
              type="button"
              data-testid="complete-btn"
              onClick={onComplete}
              disabled={completing}
              aria-live="polite"
              className={`flex-1 h-11 rounded-lg text-xs font-semibold transition-colors disabled:opacity-60 ${
                completeConfirming
                  ? "bg-success/25 text-success ring-1 ring-success/50"
                  : "bg-success/10 text-success hover:bg-success/15"
              } ${FOCUS}`}
            >
              {completing ? "Completing…" : completeConfirming ? "Sure? Tap again" : "Complete"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default TerritoryDetailPanel;
