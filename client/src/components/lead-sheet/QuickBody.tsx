import { useEffect, useRef } from "react";
import { Phone, Copy, Check, type LucideIcon } from "lucide-react";
import { OutcomeButton, OutcomeDisc } from "./OutcomeButton";
import { validPhone, MUTED, BODY_TEXT } from "./utils";
import type { KnockOutcome, OutcomeDef } from "@shared/knock";

export interface QuickBodyProps {
  directionsHref: string;
  phone?: string | null;
  copiedAddr: boolean;
  onCopyAddress: () => void;
  // The ONE disposition surface, two tiers: the four most likely reads as full
  // grid cells, every other disposition as a compact disc in the strip below.
  primaryOutcomes: OutcomeDef[];
  stripOutcomes: OutcomeDef[];
  iconMap: Record<string, LucideIcon>;
  activeOutcome: KnockOutcome | null;
  flashKey: KnockOutcome | null;
  onStatusTap: (key: KnockOutcome) => void;
  outcomesDisabled?: boolean;
  // Live distance chip (shell-owned: needs the GPS fix state) — rendered at the
  // end of the utility row; null when no honest distance exists.
  proximity?: React.ReactNode;
  // Appointment composer (shell-owned, same slot model as notes).
  appointment?: React.ReactNode;
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
    primaryOutcomes, stripOutcomes, iconMap, activeOutcome, flashKey, onStatusTap,
    outcomesDisabled = false, proximity, appointment,
    recent, notes,
  } = props;

  // Bring the pressed disc into view when a card opens on a strip-tier status
  // (a NOSO door must show its pressed NOSO disc, not a scrolled-away strip).
  // "nearest" never scrolls the page vertically; instant, so reduced-motion
  // needs no special case.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeOutcome || !stripOutcomes.some(o => o.key === activeOutcome)) return;
    try {
      stripRef.current
        ?.querySelector<HTMLElement>(`[data-testid="knock-outcome-${activeOutcome}"]`)
        ?.scrollIntoView({ inline: "nearest", block: "nearest" });
    } catch { /* jsdom / older WebView — the strip still scrolls by hand */ }
  }, [activeOutcome, stripOutcomes]);

  return (
    <>
      {/* Secondary utility row — Field Map leads carry a phone only for
          authorized callers, so Call renders ONLY when a valid number exists.
          The proximity chip sits at the far end: same row as Directions because
          they answer the same question ("how do I get to this door?"). */}
      <div data-testid="knock-action-row" className="flex items-center gap-2 pt-1">
        <a
          data-testid="action-directions"
          href={directionsHref}
          target="_blank"
          rel="noopener"
          aria-label="Directions"
          className={primaryUtilBtn}
        >
          
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
        {proximity}
      </div>

      {/* THE disposition surface — one container, two tiers. The four most
          likely reads keep their full-width 2-col cells (they are ~90% of taps
          and deserve the big targets); every other disposition renders as a
          compact status-coded disc in one horizontally-scrollable strip — the
          SalesRabbit vocabulary row — in FIXED order (a disc never moves under
          the finger). One tap saves immediately either way; the active state
          mirrors the lead's current display state in place. */}
      <div data-testid="knock-status-grid" className="mt-3">
        <div className="grid grid-cols-2 gap-2">
          {primaryOutcomes.map(o => (
            <OutcomeButton
              key={o.key}
              outcome={o}
              icon={iconMap[o.icon]}
              active={activeOutcome === o.key}
              flashing={flashKey === o.key}
              onTap={onStatusTap}
              variant="grid"
              disabled={outcomesDisabled}
            />
          ))}
        </div>
        <div
          ref={stripRef}
          data-testid="knock-status-strip"
          role="group"
          aria-label="More dispositions"
          // -mx-4/px-4: the strip bleeds to the sheet edge so a half-visible
          // disc advertises the scroll; scrollbar hidden (the peeking disc is
          // the affordance), snap keeps flicks landing on whole discs.
          className="mt-2 -mx-4 px-4 flex gap-1.5 overflow-x-auto overscroll-x-contain snap-x scrollbar-none"
        >
          {stripOutcomes.map(o => (
            <OutcomeDisc
              key={o.key}
              outcome={o}
              icon={iconMap[o.icon]}
              active={activeOutcome === o.key}
              flashing={flashKey === o.key}
              onTap={onStatusTap}
              disabled={outcomesDisabled}
            />
          ))}
        </div>
      </div>
      {outcomesDisabled && (
        <p className="mt-2 text-[12px] font-semibold text-destructive" role="status">
          Outcome logging is blocked for this address.
        </p>
      )}

      {appointment}

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
