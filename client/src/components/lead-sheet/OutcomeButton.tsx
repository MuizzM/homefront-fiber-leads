// ── Outcome button ───────────────────────────────────────────────────────────
// One button component for every knock disposition on the sheet — the 2-col
// quick grid cells and the compact pills inside "More". Same tap target (h-11),
// same active/flash styling, same testid contract (knock-outcome-{key}) so the
// disposition surface is identical no matter which level it renders at.

import {
  Check, DoorClosed, Star, DollarSign, X, Clock, Phone, ArrowDown, HelpCircle, UserCheck,
  Flag, KeyRound, Truck, Ban, RotateCcw, type LucideIcon,
} from "lucide-react";
import type { OutcomeDef } from "@shared/knock";
import { isLeadMapStatus, STATUS_CONFIG } from "@shared/statusConfig";

// lucide icon NAME (from OutcomeDef.icon) → component. THE one place a name
// string becomes a rendered glyph — the map card, the Today/PropertyDetail
// sheet, and the manager quick-log all read this map, so a disposition added
// to shared/knock.ts gets its icon everywhere at once.
export const ICON_MAP: Record<string, LucideIcon> = {
  DoorClosed, Star, DollarSign, X, Clock, Phone, ArrowDown, HelpCircle, UserCheck,
  Flag, KeyRound, Truck, Ban, RotateCcw,
};

export interface OutcomeButtonProps {
  outcome: OutcomeDef;
  icon?: LucideIcon;
  active: boolean;         // mirrors the lead's CURRENT display state
  flashing: boolean;       // brief tap-confirm flash (skips under reduced motion)
  onTap: (key: OutcomeDef["key"]) => void;
  variant: "grid" | "pill";
  disabled?: boolean;
}

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

/** Pin fills stay canonical; button text independently chooses the legible ink. */
export function outcomeFillTextColor(fill: string): "#07111B" | "#FFFFFF" {
  return contrast(fill, "#07111B") >= contrast(fill, "#FFFFFF") ? "#07111B" : "#FFFFFF";
}

// ── Compact disposition disc ─────────────────────────────────────────────────
// The strip form of the same disposition surface: a filled status-colored disc
// carrying the pin's glyph with the compact status code beneath (LEAD, ACTV,
// COMP… — the vocabulary reps carry from SalesRabbit-family tools). Same testid
// contract (knock-outcome-{key}), same active/flash semantics as the grid
// cells, one column narrow enough that every disposition stays one thumb-scroll
// away. The CODE is the accessible-name supplement, never the only signal —
// aria-label carries the full label.
//
// Two surfaces, one disc: "glass" (the map card's fixed-dark sheet — white
// ring/label chrome) and "card" (Today/PropertyDetail's themed shadcn Sheet
// and the manager Dialog — chrome from the semantic tokens so both themes
// hold AA without a per-status ink table). The status-colored fill and white
// pin glyph are theme-independent on both.
export interface OutcomeDiscProps extends Omit<OutcomeButtonProps, "variant"> {
  surface?: "glass" | "card";
}

export function OutcomeDisc({ outcome: o, icon: Icon, active, flashing, onTap, disabled = false, surface = "glass" }: OutcomeDiscProps): JSX.Element {
  const filled = active || flashing;
  const darkSheetColor = isLeadMapStatus(o.key)
    ? (STATUS_CONFIG[o.key].onDark ?? o.color)
    : o.color;
  const discShadow = surface === "glass"
    ? (filled
        ? `0 0 0 2px rgba(255,255,255,0.92)${flashing ? `, 0 2px 12px ${o.color}88` : ""}`
        : "0 0 0 1px rgba(255,255,255,0.22)")
    : (filled
        ? `0 0 0 2px hsl(var(--ring))${flashing ? `, 0 2px 12px ${o.color}88` : ""}`
        : "0 0 0 1px hsl(var(--border))");
  return (
    <button
      key={o.key}
      type="button"
      data-testid={`knock-outcome-${o.key}`}
      aria-pressed={active}
      aria-label={o.label}
      title={o.label}
      disabled={disabled}
      onClick={() => onTap(o.key)}
      className={[
        // 44px column min-width + the disc itself is the 44px target; snap-start
        // keeps a flicked strip landing on whole discs.
        "shrink-0 snap-start w-[52px] pt-0.5 pb-1 flex flex-col items-center gap-1 rounded-xl transition",
        disabled ? "cursor-not-allowed opacity-45" : "active:scale-95",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className="w-11 h-11 rounded-full flex items-center justify-center transition-shadow"
        style={{
          background: o.color,
          // Active = the ring the surface's selection language uses (white on
          // glass, --ring on tokens); the flash adds the grid cells' glow.
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
          className="text-2xs font-bold tracking-[0.04em] leading-none"
          style={{ color: filled ? "#FFFFFF" : darkSheetColor }}
        >
          {o.short}
        </span>
      ) : (
        <span
          className={`text-2xs font-bold tracking-[0.04em] leading-none ${filled ? "text-foreground" : "text-muted-foreground"}`}
        >
          {o.short}
        </span>
      )}
    </button>
  );
}

export function OutcomeButton({ outcome: o, icon: Icon, active, flashing, onTap, variant, disabled = false }: OutcomeButtonProps): JSX.Element {
  const filled = active || flashing;
  const darkSheetColor = isLeadMapStatus(o.key)
    ? (STATUS_CONFIG[o.key].onDark ?? o.color)
    : o.color;
  return (
    <button
      key={o.key}
      type="button"
      data-testid={`knock-outcome-${o.key}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={() => onTap(o.key)}
      className={[
        "h-11 rounded-xl border text-[13px] font-semibold inline-flex items-center gap-1.5 transition",
        disabled ? "cursor-not-allowed opacity-45" : "active:scale-95",
        variant === "grid" ? "w-full justify-center px-2" : "px-3.5 rounded-full whitespace-nowrap",
      ].join(" ")}
      style={filled
        ? { background: o.color, borderColor: o.color, color: outcomeFillTextColor(o.color), boxShadow: `0 2px 12px ${o.color}55` }
        : { background: `${o.color}14`, borderColor: `${o.color}55`, color: darkSheetColor }}
    >
      {flashing ? <Check aria-hidden="true" className="w-4 h-4" /> : Icon ? <Icon aria-hidden="true" className="w-4 h-4" /> : null}
      {o.label}
    </button>
  );
}

export default OutcomeButton;
