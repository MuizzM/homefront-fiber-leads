// ── Details body (level 3) ───────────────────────────────────────────────────
// Everything deep, one drag/tap above the unified quick grid: verified-premise
// (customer/service) facts, the capability-gated assignment row, ADMIN ACTIONS
// (manager central-mark + delete confirm, and the gated Calling-workspace
// link), and the full History timeline with scan evidence (location
// verification + distance when marked). The full status list and the notes
// composer stay visible above via the quick body.

import { Link } from "wouter";
import { Phone, Building2, Trash2 } from "lucide-react";
import { VerificationBadge, formatDistance } from "@/components/verification";
import { isKnockOutcome, OUTCOME_META, type KnockOutcome } from "@shared/knock";
import { relativeTime, shortRepName, MUTED, BODY_TEXT } from "./utils";
import type { HistoryRow, LeadDetail, TeamMember } from "./types";

// Verified-premise facts: what the scanner actually proved at this address.
// Rendered only when a fact exists — no guessed fields; the review banner
// covers the incomplete case.
export function VerifiedPremiseFacts({ detail }: { detail: LeadDetail | undefined }): JSX.Element | null {
  if (!detail) return null;
  const facts: Array<[string, string]> = [];
  if (detail.householdSegmentType) facts.push(["Segment", detail.householdSegmentType]);
  if (detail.billingStatus) {
    facts.push(["Occupancy", detail.billingStatus === "N" ? "No current subscriber" : `Billing ${detail.billingStatus}`]);
  }
  if (detail.competitorName || detail.competitorTech) {
    facts.push(["Competitor", [detail.competitorName, detail.competitorTech].filter(Boolean).join(" · ")]);
  }
  if (detail.freshConfirmedAt) {
    facts.push(["Verified", relativeTime(detail.freshConfirmedAt) || detail.freshConfirmedAt]);
  }
  if (!facts.length) return null;
  return (
    <div data-testid="knock-premise-facts" className="flex flex-wrap gap-x-3 gap-y-0.5">
      {facts.map(([label, value]) => (
        <span key={label} className="text-[11px] leading-tight" style={{ color: "rgba(255,255,255,0.55)" }}>
          <span className="uppercase tracking-wide text-[9.5px] mr-1" style={{ color: "rgba(255,255,255,0.35)" }}>{label}</span>
          {value}
        </span>
      ))}
    </div>
  );
}

export interface DetailsBodyProps {
  hidden: boolean;             // not the details level (and not docked)
  docked: boolean;
  detail: LeadDetail | undefined;
  // Assignment — the ONE role difference on the shared card; lead.assign only.
  canAssignLead: boolean;
  assignedRepId?: number | null;
  team: TeamMember[];
  onAssign: (repId: number | null) => void;
  // Deep actions: the gated Calling-workspace link and ADMIN actions (owner ask
  // 2026-07-26: central mark with no rep credit, delete with two-tap confirm).
  canOpenCalling: boolean;
  leadId: number;
  canManage: boolean;
  onCentralMark?: (outcome: KnockOutcome) => void;
  onDelete?: () => void;
  centralMode: boolean;
  deleteArmed: boolean;
  onToggleCentral: () => void;
  onDeleteTap: () => void;
  // History timeline
  history: HistoryRow[];
  historyLoading: boolean;
}

export function DetailsBody(props: DetailsBodyProps): JSX.Element {
  const {
    hidden, docked, detail, canAssignLead, assignedRepId, team, onAssign,
    canOpenCalling, leadId, canManage, onCentralMark, onDelete,
    centralMode, deleteArmed, onToggleCentral, onDeleteTap,
    history, historyLoading,
  } = props;
  return (
    <div data-testid="knock-details-body" hidden={hidden} className="mt-5">
      {/* Customer/service details — verified premise facts. */}
      <VerifiedPremiseFacts detail={detail} />

      {/* Assignment — rendered only for lead.assign holders (team lead+); reps
          never see it. The same server capability gate enforces it, so this is
          display parity, not security. "Unassigned" appears only here, where it
          is actionable. */}
      {canAssignLead && (
        <div className="mt-3 flex items-center gap-2.5" data-testid="card-assign-row">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] shrink-0" style={{ color: MUTED }}>
            Assigned to
          </span>
          <select
            value={assignedRepId ?? ""}
            onChange={e => onAssign(e.target.value ? Number(e.target.value) : null)}
            data-testid="card-assign-select"
            className="flex-1 h-11 min-w-0 rounded-xl bg-white/[0.04] border border-white/[0.08] px-2.5 text-[13px] text-white focus:outline-none focus:border-primary/60"
          >
            <option value="" className="text-slate-900">Unassigned</option>
            {team.filter(m => m.active).map(m => (
              <option key={m.id} value={m.id} className="text-slate-900">{m.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Deep actions — the gated Calling-workspace jump and the permission-
          gated admin row. Text labels only — no decorative emoji. */}
      {(canOpenCalling || (canManage && (onCentralMark || onDelete))) && (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="knock-details-actions">
          {canOpenCalling && (
            <Link
              data-testid="action-open-calling"
              href={`/calling/lead/${leadId}`}
              className="h-10 px-3.5 rounded-full bg-white/[0.06] border border-white/15 text-white/70 text-[12.5px] font-semibold whitespace-nowrap inline-flex items-center gap-1.5 active:scale-95 transition"
            >
              <Phone className="w-3.5 h-3.5" />
              Open in Calling
            </Link>
          )}
          {canManage && (onCentralMark || onDelete) ? (
            <div className="flex items-center gap-2" data-testid="knock-manager-row">
              {onCentralMark ? (
                <button
                  type="button"
                  data-testid="knock-central-toggle"
                  aria-pressed={centralMode}
                  onClick={onToggleCentral}
                  className={`h-10 px-3.5 rounded-full border text-[12.5px] font-semibold whitespace-nowrap inline-flex items-center gap-1.5 active:scale-95 transition ${
                    centralMode
                      ? "bg-teal-500/30 border-teal-300/60 text-teal-100"
                      : "bg-white/[0.06] border-white/15 text-white/70"
                  }`}
                  title="Mark this door on behalf of the central team — no rep credit"
                >
                  <Building2 className="w-3.5 h-3.5" />
                  {centralMode ? "Central: ON" : "Central mark"}
                </button>
              ) : null}
              {onDelete ? (
                <button
                  type="button"
                  data-testid="knock-delete"
                  onClick={onDeleteTap}
                  className={`h-10 px-3.5 rounded-full border text-[12.5px] font-semibold whitespace-nowrap inline-flex items-center gap-1.5 active:scale-95 transition ${
                    deleteArmed
                      ? "bg-red-500/80 border-red-400 text-white"
                      : "bg-white/[0.06] border-red-400/40 text-red-300"
                  }`}
                  title={deleteArmed ? "Tap again to confirm delete" : "Remove this lead"}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {deleteArmed ? "Confirm delete?" : "Delete"}
                </button>
              ) : null}
              {centralMode ? (
                <span className="text-[11px] text-teal-200/80 leading-tight">Next status tap marks centrally (no rep)</span>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {/* History — newest first. Left-rail dot + bold actor+verb + right-aligned
          relative time; three event kinds keep VerificationBadge/distance (the
          scan evidence). NOT keyed on lead id → no remount flash while a swap
          refetches. */}
      <div className="mt-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] mb-2.5" style={{ color: MUTED }}>
          History
        </div>
        <div data-testid="knock-history-list" className={`${docked ? "max-h-[42vh]" : "max-h-56"} overflow-y-auto overscroll-contain pr-1 pb-2`}>
          {historyLoading ? (
            <div className="space-y-3">
              <div className="h-4 rounded bg-white/[0.06] animate-pulse" />
              <div className="h-4 rounded bg-white/[0.06] animate-pulse w-2/3" />
            </div>
          ) : history.length === 0 ? (
            <div className="text-xs italic" style={{ color: MUTED }}>No changes yet</div>
          ) : (
            // One unified timeline, three event kinds. Left-rail dot colored by
            // the event (status hue, teal for assignments, slate for notes); a
            // hairline connects rows. React escapes all text — note previews
            // render as plain text, never markup.
            history.map((h, i) => {
              const meta = h.type === "status_change" && isKnockOutcome(h.status) ? OUTCOME_META[h.status] : null;
              const dot = h.type === "status_change" ? (meta?.color ?? "#64748b")
                : h.type === "assignment" ? "#3EA394" : "#94a3b8";
              const who = h.type === "assignment"
                ? (h.assignedBy ? shortRepName(h.assignedBy) : null)
                : (h.actor ? shortRepName(h.actor) : null);
              const verb = h.type === "status_change" ? `marked ${meta?.label ?? h.status}`
                : h.type === "assignment" ? `assigned to ${h.assignedTo ? shortRepName(h.assignedTo) : "—"}`
                : "added a note";
              const isLast = i === history.length - 1;
              return (
                <div
                  key={h.id}
                  data-testid={`knock-history-item-${i}`}
                  data-type={h.type}
                  className="flex gap-3 min-w-0"
                >
                  {/* Left rail: dot aligned to the title line + a hairline down
                      to the next event (dropped on the last row). */}
                  <div className="relative flex flex-col items-center shrink-0">
                    <span className="w-2.5 h-2.5 rounded-full mt-[3px]" style={{ background: dot }} />
                    {!isLast && <span className="w-px flex-1 mt-1 -mb-3 bg-white/10" />}
                  </div>
                  <div className="min-w-0 flex-1 leading-tight pb-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] truncate">
                        {who && <span className="font-semibold text-white">{who} </span>}
                        <span className={who ? "text-white/65" : "font-semibold text-white"}>
                          {who ? verb : (meta?.label ?? verb)}
                        </span>
                      </span>
                      <span className="text-[11px] shrink-0" style={{ color: MUTED }}>{relativeTime(h.changedAt)}</span>
                    </div>
                    {h.type === "note" && h.notePreview && (
                      <div className="text-[12px] mt-0.5 line-clamp-2" style={{ color: BODY_TEXT }}>
                        “{h.notePreview}”
                      </div>
                    )}
                    {/* Location verification — distance the rep was from the lead
                        WHEN MARKED (never recomputed against a current position). */}
                    {h.type === "status_change" && h.verification != null && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: BODY_TEXT }}>
                        <VerificationBadge status={h.verification} />
                        <span data-testid="history-distance">{formatDistance(h.distanceM)}</span>
                        {h.gpsAccuracyM != null && <span>· GPS ±{Math.round(h.gpsAccuracyM)} m</span>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export default DetailsBody;
