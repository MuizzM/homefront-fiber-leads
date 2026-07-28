// ── Quick Actions body (level 2) ─────────────────────────────────────────────
// ONE unified action surface: a small icon-sized utility row (Directions, Call
// — only with a valid phone —, Copy) above a SINGLE 2-column outcomes grid.
// The four most likely dispositions lead (Not Home | Interested / Sold | Not
// Interested) and the remaining outcomes follow IN THE SAME GRID (Follow-up,
// Prospect) — fixed FIELD_OUTCOMES order, so a button never moves under the
// finger. No More collapse, no competing action rows, no nested cards. The
// notes composer is injected by the shell; deep content (history, assignment,
// evidence, admin) lives one level up in Details.

import { Navigation, Phone, Copy, Check, type LucideIcon } from "lucide-react";
import { OutcomeButton } from "./OutcomeButton";
import { validPhone, MUTED, BODY_TEXT } from "./utils";
import type { KnockOutcome, OutcomeDef } from "@shared/knock";

export interface QuickBodyProps {
  directionsHref: string;
  phone?: string | null;
  copiedAddr: boolean;
  onCopyAddress: () => void;
  // The ONE outcomes grid — every field disposition, fixed order, primary four
  // first.
  outcomes: OutcomeDef[];
  iconMap: Record<string, LucideIcon>;
  activeOutcome: KnockOutcome | null;
  flashKey: KnockOutcome | null;
  onStatusTap: (key: KnockOutcome) => void;
  // Recent-activity line
  recent: { label: string; who: string | null; time: string } | null;
  // Notes composer (owned by the shell — same model as before, flat section)
  notes: React.ReactNode;
}

// Icon-sized utility affordance: 40px glyph button with an expanded hit area —
// present, never competing with the outcomes grid.
// Directions is the one thing a rep standing on a sidewalk needs instantly, and
// it was a bare 18px arrow in a row of three identical grey circles — findable
// only if you already knew it was there. Labelled and given the primary weight;
// Call and Copy stay icon-only, which is fine because they're secondary and the
// arrow no longer has to be told apart from them by shape alone.
const utilBtn =
  "relative h-10 w-10 flex items-center justify-center rounded-full bg-white/[0.06] border border-white/[0.10] text-white/75 hover:text-white hover:bg-white/[0.12] active:scale-90 transition after:absolute after:-inset-1";
const primaryUtilBtn =
  "relative h-10 flex items-center gap-1.5 px-3.5 rounded-full bg-sky-500/15 border border-sky-400/30 text-sky-300 font-semibold text-[12.5px] hover:bg-sky-500/25 hover:text-sky-200 active:scale-95 transition after:absolute after:-inset-1";

export function QuickBody(props: QuickBodyProps): JSX.Element {
  const {
    directionsHref, phone, copiedAddr, onCopyAddress,
    outcomes, iconMap, activeOutcome, flashKey, onStatusTap,
    recent, notes,
  } = props;

  return (
    <>
      {/* Secondary utility row — Field Map leads carry a phone only for
          authorized callers, so Call renders ONLY when a valid number exists. */}
      <div data-testid="knock-action-row" className="flex items-center gap-2 pt-1">
        <a
          data-testid="action-directions"
          href={directionsHref}
          target="_blank"
          rel="noopener"
          aria-label="Directions"
          className={primaryUtilBtn}
        >
          <Navigation className="w-[17px] h-[17px] shrink-0" />
          Directions
        </a>
        {validPhone(phone) && (
          <a
            data-testid="action-call"
            href={`tel:${phone}`}
            aria-label="Call this lead"
            className={utilBtn}
          >
            <Phone className="w-[18px] h-[18px]" />
          </a>
        )}
        <button
          type="button"
          data-testid="action-copy"
          aria-label="Copy address"
          onClick={onCopyAddress}
          className={utilBtn}
        >
          {copiedAddr ? <Check className="w-[18px] h-[18px] text-emerald-400" /> : <Copy className="w-[18px] h-[18px]" />}
        </button>
      </div>

      {/* THE outcomes grid — all field dispositions in ONE 2-column grid, FIXED
          order (primary four lead). One tap saves immediately; the active state
          mirrors the lead's current display state in place. */}
      <div data-testid="knock-status-grid" className="mt-3 grid grid-cols-2 gap-2">
        {outcomes.map(o => (
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
