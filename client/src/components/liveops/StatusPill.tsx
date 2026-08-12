import type { LocationFreshness, RepStatus } from "@shared/liveOps";

// ── Status and freshness, shown as two separate things ───────────────────────
//
// They are rendered side by side and never merged, because they answer
// different questions. "Saad is knocking" and "we last heard from Saad's phone
// 18 minutes ago" are both true at once, and a single green dot standing for
// the pair tells a supervisor something false.
//
// Colour is never the only signal. Every pill carries a word, and the freshness
// badge carries a shape as well, so the board survives colour-blindness, a
// sunlit phone screen, and a greyscale print-out.

const STATUS_LABEL: Record<RepStatus, string> = {
  offline: "Offline",
  online: "Online",
  active: "Active",
  knocking: "Knocking",
  traveling: "Traveling",
  appointment: "Appointment",
  break: "On break",
  inactive: "Idle",
  location_unavailable: "No location",
};

/** Semantic tokens only - these are AA on both themes and on their own tint
 *  chips (see docs/DESIGN_SYSTEM.md). Raw palette steps are not used here. */
const STATUS_TONE: Record<RepStatus, string> = {
  knocking: "bg-success/10 text-success border-success/25",
  active: "bg-success/10 text-success border-success/25",
  traveling: "bg-info/10 text-info border-info/25",
  appointment: "bg-gold-soft text-gold-text border-gold/30",
  online: "bg-primary/10 text-primary border-primary/25",
  break: "bg-warning/10 text-warning border-warning/25",
  inactive: "bg-warning/10 text-warning border-warning/25",
  location_unavailable: "bg-destructive/10 text-destructive border-destructive/25",
  offline: "bg-secondary text-muted-foreground border-border",
};

export function StatusPill({ status, className = "" }: { status: RepStatus; className?: string }) {
  return (
    <span
      data-testid={`status-${status}`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[status]} ${className}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

const FRESHNESS_LABEL: Record<LocationFreshness, string> = {
  live: "Live",
  recent: "Recent",
  stale: "Last known",
  none: "No fix",
};

const FRESHNESS_TONE: Record<LocationFreshness, string> = {
  live: "bg-success/10 text-success border-success/25",
  recent: "bg-info/10 text-info border-info/25",
  stale: "bg-warning/10 text-warning border-warning/25",
  none: "bg-secondary text-muted-foreground border-border",
};

/** Age in words. Deliberately blunt: "14 min ago" is a fact a supervisor can
 *  act on, where a bare pin is an implication they cannot check. */
export function ageLabel(capturedAt: string | null | undefined, nowMs = Date.now()): string {
  if (!capturedAt) return "never";
  const t = Date.parse(capturedAt);
  if (!Number.isFinite(t)) return "unknown";
  const secs = Math.max(0, Math.round((nowMs - t) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function FreshnessBadge({
  freshness, capturedAt, className = "",
}: { freshness: LocationFreshness; capturedAt: string | null; className?: string }) {
  return (
    <span
      data-testid={`freshness-${freshness}`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${FRESHNESS_TONE[freshness]} ${className}`}
    >
      {/* A shape as well as a colour: filled for live, hollow for recent, a bar
          for stale. The distinction survives greyscale. */}
      <span aria-hidden="true" className="text-2xs leading-none">
        {freshness === "live" ? "●" : freshness === "recent" ? "○" : freshness === "stale" ? "▬" : "–"}
      </span>
      {FRESHNESS_LABEL[freshness]}
      {freshness !== "none" && (
        <span className="font-medium opacity-80">· {ageLabel(capturedAt)}</span>
      )}
    </span>
  );
}
