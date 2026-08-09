// ── Outcome button ───────────────────────────────────────────────────────────
// One button component for every knock disposition on the sheet — the 2-col
// quick grid cells and the compact pills inside "More". Same tap target (h-11),
// same active/flash styling, same testid contract (knock-outcome-{key}) so the
// disposition surface is identical no matter which level it renders at.

import { Check, type LucideIcon } from "lucide-react";
import type { OutcomeDef } from "@shared/knock";

export interface OutcomeButtonProps {
  outcome: OutcomeDef;
  icon?: LucideIcon;
  active: boolean;         // mirrors the lead's CURRENT display state
  flashing: boolean;       // brief tap-confirm flash (skips under reduced motion)
  onTap: (key: OutcomeDef["key"]) => void;
  variant: "grid" | "pill";
}

export function OutcomeButton({ outcome: o, icon: Icon, active, flashing, onTap, variant }: OutcomeButtonProps): JSX.Element {
  const filled = active || flashing;
  return (
    <button
      key={o.key}
      type="button"
      data-testid={`knock-outcome-${o.key}`}
      aria-pressed={active}
      onClick={() => onTap(o.key)}
      className={[
        "h-11 rounded-xl border text-[13px] font-semibold inline-flex items-center gap-1.5 active:scale-95 transition",
        variant === "grid" ? "w-full justify-center px-2" : "px-3.5 rounded-full whitespace-nowrap",
      ].join(" ")}
      style={filled
        ? { background: o.color, borderColor: o.color, color: "#ffffff", boxShadow: `0 2px 12px ${o.color}55` }
        : { background: `${o.color}14`, borderColor: `${o.color}55`, color: o.color }}
    >
      {flashing ? <Check className="w-4 h-4" /> : Icon ? null : null}
      {o.label}
    </button>
  );
}

export default OutcomeButton;
