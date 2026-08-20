// ── Outcome button ───────────────────────────────────────────────────────────
// One button component for every knock disposition on the sheet — the 2-col
// quick grid cells and the compact pills inside "More". Same tap target (h-11),
// same active/flash styling, same testid contract (knock-outcome-{key}) so the
// disposition surface is identical no matter which level it renders at.

import { Check, type LucideIcon } from "lucide-react";
import type { OutcomeDef } from "@shared/knock";
import { isLeadMapStatus, STATUS_CONFIG } from "@shared/statusConfig";

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
