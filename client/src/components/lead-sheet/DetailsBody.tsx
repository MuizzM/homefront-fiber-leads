// ── Details body (level 3) ───────────────────────────────────────────────────
// Everything deep, one drag/tap above the unified quick grid: verified-premise
// (customer/service) facts, the capability-gated assignment row, ADMIN ACTIONS
// (manager central-mark + delete confirm, and the gated Calling-workspace
// link), and the full History timeline with scan evidence (location
// verification + distance when marked). The full status list and the notes
// composer stay visible above via the quick body.

import { Link } from "wouter";
import { FOCUS } from "@/lib/a11y";
import { useState } from "react";
import { VerificationBadge, DistanceDiagram, formatDistance } from "@/components/verification";
import { isKnockOutcome, OUTCOME_META, type KnockOutcome } from "@shared/knock";
import { relativeTime, shortRepName, MUTED, BODY_TEXT } from "./utils";
import type { HistoryRow, LeadDetail, TeamMember } from "./types";

// Verified-premise facts: what the scanner actually proved at this address.
// Rendered only when a fact exists — no guessed fields; the review banner
// covers the incomplete case. An inset list (label column + value), the same
// container every Details section shares.
export const INSET = "rounded-[14px] bg-white/[0.04] border border-white/[0.08] overflow-hidden";
export const INSET_ROW = "flex items-center gap-2.5 min-h-[44px] px-3 py-2";
export const SECTION_LABEL = "text-[11px] font-semibold uppercase tracking-[0.08em]";

export function InsetRow({ label, children, first = false }: { label: string; children: React.ReactNode; first?: boolean }): JSX.Element {
  return (
    <div className={`${INSET_ROW} ${first ? "" : "border-t border-white/[0.07]"}`}>
      <span className={`${SECTION_LABEL} w-[84px] shrink-0`} style={{ color: MUTED }}>{label}</span>
      <span className="min-w-0 flex-1 text-[13.5px] leading-snug text-white truncate">{children}</span>
    </div>
  );
}

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
    <div data-testid="knock-premise-facts" className="mt-4">
      <div className={`${SECTION_LABEL} mb-2`} style={{ color: MUTED }}>At this address</div>
      <div className={INSET}>
        {facts.map(([label, value], i) => (
          <InsetRow key={label} label={label} first={i === 0}>{value}</InsetRow>
        ))}
      </div>
    </div>
  );
}

export interface DetailsBodyProps {
  hidden: boolean;             // not the details level (and not docked)
  docked: boolean;
  detail: LeadDetail | undefined;
  // Shell-composed sections (same slot model as the quick body's notes):
  // rep-captured contact identity, address-contextual research links, and the
  // door-photo strip. Nodes so this body stays a layout, not a data owner.
  contact?: React.ReactNode;
  quickLinks?: React.ReactNode;
  photos?: React.ReactNode;
  // Assignment — the ONE role difference on the shared card; lead.assign only.
  canAssignLead: boolean;
  assignedRepId?: number | null;
  team: TeamMember[];
  onAssign: (repId: number | null) => void;
  assigning?: boolean;
  // Deep actions: the gated Calling-workspace link and ADMIN actions (owner ask
  // 2026-07-26: central mark with no rep credit, delete with two-tap confirm).
  canOpenCalling: boolean;
  leadId: number;
  canManage: boolean;
  onCentralMark?: (outcome: KnockOutcome) => boolean | void | Promise<boolean | void>;
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
    hidden, docked, detail, contact, quickLinks, photos,
    canAssignLead, assignedRepId, team, onAssign, assigning = false,
    canOpenCalling, leadId, canManage, onCentralMark, onDelete,
    centralMode, deleteArmed, onToggleCentral, onDeleteTap,
    history, historyLoading,
  } = props;
  // "Where they stood": one history row at a time opens its distance
  // diagram (rep position, this door, the measured gap when marked).
  const [openDistanceId, setOpenDistanceId] = useState<string | null>(null);
  return (
    <div data-testid="knock-details-body" hidden={hidden} className="mt-5">
      {/* Who lives here — the rep-captured identity leads the level. */}
      {contact}

      {/* Customer/service details — verified premise facts. */}
      <VerifiedPremiseFacts detail={detail} />

      {/* One-tap research for this address. */}
      {quickLinks}

      {/* Assignment — rendered only for lead.assign holders (team lead+); reps
          never see it. The same server capability gate enforces it, so this is
          display parity, not security. "Unassigned" appears only here, where it
          is actionable. */}
      {canAssignLead && (
        <div className="mt-3 flex items-center gap-2.5" data-testid="card-assign-row">
          <span className={`${SECTION_LABEL} shrink-0`} style={{ color: MUTED }}>
            Assigned to
          </span>
          <select
            value={assignedRepId ?? ""}
            onChange={e => onAssign(e.target.value ? Number(e.target.value) : null)}
            disabled={assigning}
            aria-busy={assigning}
            data-testid="card-assign-select"
            className="flex-1 h-11 min-w-0 rounded-xl bg-white/[0.04] border border-white/[0.08] px-2.5 text-[13px] text-white focus:outline-none focus:border-primary/60 disabled:cursor-wait disabled:opacity-60"
          >
            <option value="" className="text-slate-900">Unassigned</option>
            {team.filter(m => m.active).map(m => (
              <option key={m.id} value={m.id} className="text-slate-900">{m.name}</option>
            ))}
          </select>
          {assigning && <span className="sr-only" role="status">Saving assignment</span>}
        </div>
      )}

      {/* Deep actions — the gated Calling-workspace jump and the permission-
          gated admin row. Text labels only — no decorative emoji. Delete moved
          OUT of this pill cluster into its own full-width row below History
          (owner report: "each pin usually has delete — I need that" — it
          existed but was buried as a small pill nobody found). */}
      {(canOpenCalling || (canManage && onCentralMark)) && (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="knock-details-actions">
          {canOpenCalling && (
            <Link
              data-testid="action-open-calling"
              href={`/calling/lead/${leadId}`}
              className="h-10 px-3.5 rounded-full bg-white/[0.06] border border-white/15 text-white/70 text-[12.5px] font-semibold whitespace-nowrap inline-flex items-center gap-1.5 tap-press"
            >
              
              Open in Calling
            </Link>
          )}
          {canManage && onCentralMark ? (
            <div className="flex items-center gap-2" data-testid="knock-manager-row">
              <button
                type="button"
                data-testid="knock-central-toggle"
                aria-pressed={centralMode}
                onClick={onToggleCentral}
                className={`h-10 px-3.5 rounded-full border text-[12.5px] font-semibold whitespace-nowrap inline-flex items-center gap-1.5 tap-press ${
                  centralMode
                    ? "bg-teal-500/30 border-teal-300/60 text-teal-100"
                    : "bg-white/[0.06] border-white/15 text-white/70"
                }`}
                title="Mark this door on behalf of the central team - no rep credit"
              >
                
                {centralMode ? "Central: ON" : "Central mark"}
              </button>
              {centralMode ? (
                <span className="text-[11px] text-teal-200/80 leading-tight">Next status tap marks centrally (no rep)</span>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {/* Field evidence — the door-photo strip sits beside the timeline. */}
      {photos}

      {/* History — newest first. Left-rail dot + bold actor+verb + right-aligned
          relative time; three event kinds keep VerificationBadge/distance (the
          scan evidence). NOT keyed on lead id → no remount flash while a swap
          refetches. */}
      <div className="mt-5">
        <div className={`${SECTION_LABEL} mb-2.5`} style={{ color: MUTED }}>
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
              // A central/system status change carries an EXPLICIT display actor
              // ("Central Admin") — render it verbatim, never through the rep-name
              // shortener (which would mangle it to "C. Admin") and never resolved
              // against a rep id.
              const isDisplayActor = h.type === "status_change" && !!(h as any).source;
              const who = h.type === "assignment"
                ? (h.assignedBy ? shortRepName(h.assignedBy) : null)
                : isDisplayActor
                  ? (h.actor ?? null)
                  : (h.actor ? shortRepName(h.actor) : null);
              const verb = h.type === "status_change" ? `marked ${meta?.label ?? h.status}`
                : h.type === "assignment" ? `assigned to ${h.assignedTo ? shortRepName(h.assignedTo) : " - "}`
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
                    {!isLast && <span className="w-px flex-1 mt-1 -mb-3 bg-white/[0.14]" />}
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
                        {h.distanceM != null && Number.isFinite(h.distanceM) && (
                          <button
                            type="button"
                            data-testid={`history-where-${i}`}
                            aria-expanded={openDistanceId === h.id}
                            onClick={() => setOpenDistanceId((cur) => (cur === h.id ? null : h.id))}
                            className={`tap-expand relative ml-auto h-8 rounded-full border border-white/[0.12] px-2.5 text-[11px] font-semibold text-white/70 tap-press ${FOCUS}`}
                          >
                            {openDistanceId === h.id ? "Hide" : "Where they stood"}
                          </button>
                        )}
                      </div>
                    )}
                    {h.type === "status_change" && openDistanceId === h.id && (
                      <div className="mt-2" data-testid={`history-distance-diagram-${i}`}>
                        <DistanceDiagram distanceM={h.distanceM} accuracyM={h.gpsAccuracyM} status={h.verification} />
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Delete lead — the destructive row, full-width at the very bottom of
          Details where destructive actions live (owner ask: "each pin usually
          has delete"). Same permission gate as before (canManage → MapView's
          handleDeleteLead, which the server re-checks); works on ANY lead,
          FCC-imported or manual. Two-step confirm: first tap ARMS (the row
          turns solid rose and reads "Confirm delete"), a second tap fires
          onDelete once; the sheet auto-disarms after 4s and on card swap —
          the Applications reject grammar. 44px target, shared focus ring. */}
      {canManage && onDelete ? (
        <button
          type="button"
          data-testid="knock-delete"
          onClick={onDeleteTap}
          title={deleteArmed ? "Tap again to confirm delete" : "Remove this lead from the map"}
          className={`mt-4 w-full h-11 rounded-xl border text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 tap-press [--press-scale:0.98] ${FOCUS} ${
            deleteArmed
              ? "bg-rose-600 border-rose-500 text-white"
              : "bg-rose-500/10 border-rose-500/40 text-rose-300"
          }`}
        >
          
          {deleteArmed ? "Confirm delete?" : "Delete lead"}
        </button>
      ) : null}
    </div>
  );
}

export default DetailsBody;
