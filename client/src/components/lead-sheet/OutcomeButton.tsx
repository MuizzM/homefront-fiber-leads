// ── Disposition discs ────────────────────────────────────────────────────────
// ONE control for every knock disposition, everywhere a disposition can be
// marked (the map card, the Today/PropertyDetail sheet, the manager quick-log):
// a 44px status-colored disc carrying the pin's own glyph with the compact
// status code beneath (NH, INT, SOLD, NI, FU, GB, ACTV, COMP, RENT, MOV, NOSO,
// LEAD - the vocabulary reps carry from SalesRabbit-family tools). The
// rectangular 2-column cells that used to lead the surface are gone (owner
// call, 2026-08-22: "remove all the rectangles, keep only circles"), so the
// surface is a single fixed-order grid and a control never moves under the
// finger. Same testid contract as before (knock-outcome-{key}), same
// active/flash semantics.

import {
  Check, DoorClosed, Star, DollarSign, X, Clock, Phone, ArrowDown, HelpCircle, UserCheck,
  Flag, KeyRound, Truck, Ban, RotateCcw, type LucideIcon,
} from "lucide-react";
import { FIELD_OUTCOMES, type KnockOutcome, type OutcomeDef } from "@shared/knock";
import { isLeadMapStatus, STATUS_CONFIG } from "@shared/statusConfig";
import { FOCUS } from "@/lib/a11y";

// lucide icon NAME (from OutcomeDef.icon) → component. THE one place a name
// string becomes a rendered glyph — the map card, the Today/PropertyDetail
// sheet, and the manager quick-log all read this map, so a disposition added
// to shared/knock.ts gets its icon everywhere at once.
export const ICON_MAP: Record<string, LucideIcon> = {
  DoorClosed, Star, DollarSign, X, Clock, Phone, ArrowDown, HelpCircle, UserCheck,
  Flag, KeyRound, Truck, Ban, RotateCcw,
};

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16) / 255);
  const linear = (channel: number) => channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(channels[0]) + 0.7152 * linear(channels[1]) + 0.0722 * linear(channels[2]);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** Pin fills stay canonical; a filled control independently chooses the legible ink. */
export function outcomeFillTextColor(fill: string): "#07111B" | "#FFFFFF" {
  return contrast(fill, "#07111B") >= contrast(fill, "#FFFFFF") ? "#07111B" : "#FFFFFF";
}

/** The text color a disposition's code reads in on the map's dark glass. */
export function outcomeInkOnDark(o: OutcomeDef): string {
  return isLeadMapStatus(o.key) ? (STATUS_CONFIG[o.key].onDark ?? o.color) : o.color;
}

// Two surfaces, one disc: "glass" (the map card's fixed-dark sheet — white
// ring/label chrome) and "card" (Today/PropertyDetail's themed shadcn Sheet
// and the manager Dialog — chrome from the semantic tokens so both themes
// hold AA without a per-status ink table). The status-colored fill and white
// pin glyph are theme-independent on both.
export interface OutcomeDiscProps {
  outcome: OutcomeDef;
  icon?: LucideIcon;
  active: boolean;         // mirrors the lead's CURRENT display state
  flashing: boolean;       // brief tap-confirm flash (skips under reduced motion)
  onTap: (key: KnockOutcome) => void;
  disabled?: boolean;
  surface?: "glass" | "card";
  /** Grid cells stretch to their column; a strip keeps the 52px column. */
  fluid?: boolean;
  /** The Today/PropertyDetail sheet keeps its own `outcome-` ids. */
  testIdPrefix?: string;
}

export function OutcomeDisc(props: OutcomeDiscProps): JSX.Element {
  const {
    outcome: o, icon: Icon, active, flashing, onTap, disabled = false,
    surface = "glass", fluid = false, testIdPrefix = "knock-outcome-",
  } = props;
  const filled = active || flashing;
  const discShadow = surface === "glass"
    ? (filled
        ? `0 0 0 2px rgba(255,255,255,0.92)${flashing ? `, 0 2px 12px ${o.color}88` : ""}`
        : "0 0 0 1px rgba(255,255,255,0.22)")
    : (filled
        ? `0 0 0 2px hsl(var(--ring))${flashing ? `, 0 2px 12px ${o.color}88` : ""}`
        : "0 0 0 1px hsl(var(--border))");
  return (
    <button
      type="button"
      data-testid={`${testIdPrefix}${o.key}`}
      aria-pressed={active}
      aria-label={o.label}
      title={o.label}
      disabled={disabled}
      onClick={() => onTap(o.key)}
      className={[
        // The 44px disc IS the target; the column adds the label beneath.
        "shrink-0 snap-start pt-0.5 pb-1 flex flex-col items-center gap-1 rounded-xl transition",
        fluid ? "w-full min-w-[44px]" : "w-[52px]",
        disabled ? "cursor-not-allowed opacity-45" : "active:scale-95",
        FOCUS,
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className="w-11 h-11 rounded-full flex items-center justify-center transition-shadow"
        style={{
          background: o.color,
          // Active = the ring the surface's selection language uses (white on
          // glass, --ring on tokens); the flash adds a glow in the status hue.
          // Idle discs sit on a hairline so the dark NOSO disc never dissolves
          // into a dark surface.
          boxShadow: discShadow,
        }}
      >
        {flashing
          ? <Check aria-hidden="true" className="w-5 h-5" style={{ color: outcomeFillTextColor(o.color) }} />
          : Icon ? <Icon aria-hidden="true" className="w-5 h-5 text-white" /> : null}
      </span>
      {surface === "glass" ? (
        <span
          className="text-2xs font-bold tracking-[0.04em] leading-none whitespace-nowrap"
          style={{ color: filled ? "#FFFFFF" : outcomeInkOnDark(o) }}
        >
          {o.short}
        </span>
      ) : (
        <span
          className={`text-2xs font-bold tracking-[0.04em] leading-none whitespace-nowrap ${filled ? "text-foreground" : "text-muted-foreground"}`}
        >
          {o.short}
        </span>
      )}
    </button>
  );
}

// ── The disposition surface ──────────────────────────────────────────────────
// Every field disposition as the same disc, six per row, FIXED order
// (FIELD_OUTCOMES verbatim: the four most likely reads lead the first row).
// 12 discs in two rows fit a 343px phone sheet with nothing to scroll; wider
// homes (tablet sheet, docked panel, the Today sheet) spread the columns.
export interface DispositionGridProps {
  outcomes?: OutcomeDef[];
  activeOutcome: KnockOutcome | null;
  flashKey?: KnockOutcome | null;
  onTap: (key: KnockOutcome) => void;
  disabled?: boolean;
  surface?: "glass" | "card";
  testIdPrefix?: string;
  className?: string;
  "data-testid"?: string;
}

export function DispositionGrid(props: DispositionGridProps): JSX.Element {
  const {
    outcomes = FIELD_OUTCOMES, activeOutcome, flashKey = null, onTap, disabled = false,
    surface = "glass", testIdPrefix, className = "",
  } = props;
  return (
    <div
      data-testid={props["data-testid"] ?? "knock-status-grid"}
      role="group"
      aria-label="Disposition"
      className={`grid grid-cols-6 gap-x-1 gap-y-1.5 justify-items-center ${className}`}
    >
      {outcomes.map(o => (
        <OutcomeDisc
          key={o.key}
          outcome={o}
          icon={ICON_MAP[o.icon]}
          active={activeOutcome === o.key}
          flashing={flashKey === o.key}
          onTap={onTap}
          disabled={disabled}
          surface={surface}
          fluid
          testIdPrefix={testIdPrefix}
        />
      ))}
    </div>
  );
}

export default OutcomeDisc;
