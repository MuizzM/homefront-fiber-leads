import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The one empty-state primitive for the app, so every "nothing here yet" moment
 * reads the same: a soft icon tile, a clear title, a calm one-line explanation,
 * and an optional call to action. Tone maps to the app's semantic colors so an
 * all-caught-up state feels good (emerald) and a neutral one stays quiet.
 *
 * Pages pass their own `testId` so existing selectors keep working after the
 * swap; the icon tile is decorative (aria-hidden) and the whole block is a
 * polite status region for screen readers.
 */
type Tone = "neutral" | "positive" | "primary";

const TONES: Record<Tone, { tile: string; icon: string; ring: string }> = {
  neutral: { tile: "bg-muted", icon: "text-muted-foreground", ring: "border-border" },
  // The light-mode override matters: text-emerald-400 on the light card is
  // ~2:1 — decorative here (aria-hidden tile), but the shared primitive should
  // model the correct both-themes pattern it asks pages to follow.
  positive: { tile: "bg-emerald-500/15", icon: "text-emerald-400 [.light_&]:text-emerald-700", ring: "border-emerald-500/25" },
  primary: { tile: "bg-primary/10", icon: "text-primary", ring: "border-border" },
};

export function EmptyState({
    title,
  description,
  action,
  tone = "neutral",
  bordered = false,
  className = "",
  testId,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: Tone;
  /** Wrap in a soft card (for inline/section empties). Full-page empties leave it off. */
  bordered?: boolean;
  className?: string;
  testId?: string;
}) {
  const t = TONES[tone];
  return (
    <div
      role="status"
      data-testid={testId}
      className={`flex flex-col items-center justify-center px-6 py-12 text-center ${
        bordered ? `rounded-2xl border ${t.ring} ${tone === "positive" ? "bg-emerald-500/[0.06]" : "bg-card"}` : ""
      } ${className}`}
    >
      
      <h3 className="mt-3.5 text-[15px] font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
