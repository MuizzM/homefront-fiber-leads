// ── Quick Actions body (level 2) ─────────────────────────────────────────────
// The default working level (~35–45% of screen): primary row
// [Directions, Call (only with a valid phone), More] → the collapsible "More"
// section (remaining outcomes, Copy, Calling link, manager actions — all
// permission-gated where applicable) → the 2-column grid of the four most
// likely dispositions (Not Home | Interested / Sold | Not Interested) → the
// recent-activity line. The notes composer is injected by the shell.

import { Link } from "wouter";
import {
  Navigation, Phone, Copy, Check, ChevronDown, Building2, Trash2,
  type LucideIcon,
} from "lucide-react";
import { OutcomeButton } from "./OutcomeButton";
import { validPhone, MUTED, BODY_TEXT } from "./utils";
import type { KnockOutcome, OutcomeDef } from "@shared/knock";

export interface QuickBodyProps {
  directionsHref: string;
  phone?: string | null;
  copiedAddr: boolean;
  onCopyAddress: () => void;
  canOpenCalling: boolean;
  leadId: number;
  // "More" disclosure
  showMoreToggle: boolean;     // quick level only — details/docked force it open
  moreOpen: boolean;
  moreVisible: boolean;        // moreOpen || details || docked (computed by shell)
  onToggleMore: () => void;
  onOpenDetails: () => void;
  // Dispositions
  quickOutcomes: OutcomeDef[]; // the four most likely, 2-col grid
  moreOutcomes: OutcomeDef[];  // everything else (Follow-up, Prospect)
  iconMap: Record<string, LucideIcon>;
  activeOutcome: KnockOutcome | null;
  flashKey: KnockOutcome | null;
  onStatusTap: (key: KnockOutcome) => void;
  // Manager actions (permission-gated by the shell)
  canManage: boolean;
  onCentralMark?: (outcome: KnockOutcome) => void;
  onDelete?: () => void;
  centralMode: boolean;
  deleteArmed: boolean;
  onToggleCentral: () => void;
  onDeleteTap: () => void;
  // Recent-activity line
  recent: { label: string; who: string | null; time: string } | null;
  // Notes composer card (owned by the shell — same model as before)
  notes: React.ReactNode;
}

const ghostPill =
  "h-11 rounded-full bg-white/[0.05] border border-white/[0.08] flex items-center justify-center gap-1.5 text-[13px] font-semibold text-white active:scale-[0.97] transition";

export function QuickBody(props: QuickBodyProps): JSX.Element {
  const {
    directionsHref, phone, copiedAddr, onCopyAddress, canOpenCalling, leadId,
    showMoreToggle, moreOpen, moreVisible, onToggleMore, onOpenDetails,
    quickOutcomes, moreOutcomes, iconMap, activeOutcome, flashKey, onStatusTap,
    canManage, onCentralMark, onDelete, centralMode, deleteArmed, onToggleCentral, onDeleteTap,
    recent, notes,
  } = props;

  return (
    <>
      {/* Primary row — Field Map leads carry a phone only for authorized
          callers, so Call renders ONLY when a valid number is present. */}
      <div data-testid="knock-action-row" className="flex items-center gap-2 pt-1">
        <a
          data-testid="action-directions"
          href={directionsHref}
          target="_blank"
          rel="noopener"
          className={`${ghostPill} flex-1 min-w-0`}
        >
          <Navigation className="w-4 h-4 opacity-80" />
          Directions
        </a>
        {validPhone(phone) && (
          <a
            data-testid="action-call"
            href={`tel:${phone}`}
            aria-label="Call this lead"
            className={`${ghostPill} flex-1 min-w-0`}
          >
            <Phone className="w-4 h-4 opacity-80" />
            Call
          </a>
        )}
        {showMoreToggle && (
          <button
            type="button"
            data-testid="knock-more-toggle"
            aria-expanded={moreOpen}
            aria-controls="knock-more-section"
            onClick={onToggleMore}
            className={`${ghostPill} px-4 shrink-0`}
          >
            More
            <ChevronDown
              className={`w-4 h-4 opacity-80 transition-transform ${moreOpen ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>

      {/* More — the remaining dispositions, secondary actions, and the
          permission-gated manager row. Forced open in Details/docked. */}
      <div
        id="knock-more-section"
        data-testid="knock-more-section"
        hidden={!moreVisible}
      >
        {moreOutcomes.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {moreOutcomes.map(o => (
              <OutcomeButton
                key={o.key}
                outcome={o}
                icon={iconMap[o.icon]}
                active={activeOutcome === o.key}
                flashing={flashKey === o.key}
                onTap={onStatusTap}
                variant="pill"
              />
            ))}
          </div>
        )}
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            data-testid="action-copy"
            onClick={onCopyAddress}
            className={`${ghostPill} px-4 shrink-0`}
          >
            {copiedAddr ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 opacity-80" />}
            {copiedAddr ? "Copied" : "Copy"}
          </button>
          {canOpenCalling && (
            <Link
              data-testid="action-open-calling"
              href={`/calling/lead/${leadId}`}
              className={`${ghostPill} px-4 shrink-0`}
            >
              <Phone className="w-4 h-4 opacity-80" />
              Calling
            </Link>
          )}
          {showMoreToggle && (
            <button
              type="button"
              data-testid="knock-details-open"
              onClick={onOpenDetails}
              className="h-11 px-3 rounded-full text-[12.5px] font-semibold text-white/60 hover:text-white active:scale-95 transition inline-flex items-center gap-1"
            >
              Full details
              <ChevronDown className="w-3.5 h-3.5 -rotate-90 opacity-70" />
            </button>
          )}
        </div>

        {/* MANAGER ACTIONS (owner ask 2026-07-26): central-mark toggle + delete
            with inline two-tap confirm, for manually-added pins. Text labels
            only — no decorative emoji. */}
        {canManage && (onCentralMark || onDelete) ? (
          <div className="mt-2.5 flex items-center gap-2" data-testid="knock-manager-row">
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

      {/* The four most likely dispositions, 2 columns, FIXED order so a button
          never moves under the finger. One tap saves immediately. */}
      <div data-testid="knock-status-grid" className="mt-3 grid grid-cols-2 gap-2">
        {quickOutcomes.map(o => (
          <OutcomeButton
            key={o.key}
            outcome={o}
            icon={iconMap[o.icon]}
            active={activeOutcome === o.key}
            flashing={flashKey === o.key}
            onTap={onStatusTap}
            variant="grid"
          />
        ))}
      </div>

      {/* Recent-activity line: the last thing that happened at this door. */}
      {recent && (
        <div data-testid="knock-recent" className="mt-3 text-[12px] truncate" style={{ color: MUTED }}>
          <span className="font-semibold" style={{ color: BODY_TEXT }}>Last:</span>{" "}
          {[recent.label, recent.who, recent.time].filter(Boolean).join(" · ")}
        </div>
      )}

      {notes}
    </>
  );
}

export default QuickBody;
