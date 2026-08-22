// ── Status pin chip ──────────────────────────────────────────────────────────
// The pin's own disc carried into the card header and the peek lip: the map
// status fill with the same glyph the pin shows, so card and map agree at a
// glance (was a 10px dot). Purely presentational; the status LINE next to it
// still carries the words.
import type { LucideIcon } from "lucide-react";

export interface StatusPinChipProps {
  color: string;            // STATUS_CONFIG[status].color — the PIN fill, never onDark
  icon?: LucideIcon;
  size?: 28 | 32;
  "data-testid"?: string;
}

export function StatusPinChip({ color, icon: Icon, size = 32, ...rest }: StatusPinChipProps): JSX.Element {
  const glyph = size === 32 ? "w-4 h-4" : "w-[14px] h-[14px]";
  return (
    <span
      data-testid={rest["data-testid"] ?? "knock-status-dot"}
      aria-hidden="true"
      className={`${size === 32 ? "w-8 h-8" : "w-7 h-7"} rounded-full shrink-0 flex items-center justify-center`}
      style={{ background: color, boxShadow: "0 0 0 1px rgba(255,255,255,0.22)" }}
    >
      {Icon ? <Icon data-testid="knock-status-icon" className={`${glyph} text-white`} /> : null}
    </span>
  );
}

export default StatusPinChip;
