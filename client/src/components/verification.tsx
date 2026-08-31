import { ShieldCheck, AlertTriangle, Ban, HelpCircle } from "lucide-react";

export type VStatus = "verified" | "needs_review" | "invalid" | null | undefined;

interface VMeta { label: string; Icon: typeof ShieldCheck; text: string; bg: string; ring: string; dot: string; }

export const V_META: Record<"verified" | "needs_review" | "invalid" | "unknown", VMeta> = {
  verified:     { label: "Verified",     Icon: ShieldCheck,   text: "text-success", bg: "bg-success/[0.12]", ring: "border-success/30", dot: "hsl(var(--success))" },
  needs_review: { label: "Needs Review", Icon: AlertTriangle, text: "text-warning",   bg: "bg-warning/[0.12]",   ring: "border-warning/30",   dot: "hsl(var(--warning))" },
  invalid:      { label: "Invalid",      Icon: Ban,           text: "text-destructive",     bg: "bg-destructive/[0.12]",     ring: "border-destructive/30",     dot: "hsl(var(--destructive))" },
  // The other three rows moved onto semantic tokens and this one was left on
  // raw slate. `text-slate-400` is ~2.4:1 on the light card, so the one status
  // that means "we do not know" was the least readable of the four.
  unknown:      { label: "Unverified",   Icon: HelpCircle,    text: "text-muted-foreground",   bg: "bg-muted",   ring: "border-border",   dot: "hsl(var(--muted-foreground))" },
};

export function metaFor(status: VStatus): VMeta {
  return V_META[(status ?? "unknown") as keyof typeof V_META] ?? V_META.unknown;
}

// "42 m away" · "1.2 km away" · "Location unavailable" (never a misleading 0).
export function formatDistance(distanceM: number | null | undefined): string {
  if (distanceM == null || !Number.isFinite(distanceM)) return "Location unavailable";
  if (distanceM < 1000) return `${Math.round(distanceM)} m away`;
  return `${(distanceM / 1000).toFixed(1)} km away`;
}

export function VerificationBadge({ status, title }: { status: VStatus; title?: string }) {
  const m = metaFor(status);
  return (
    <span
      role="status"
      title={title ?? m.label}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${m.bg} ${m.ring} ${m.text}`}
      data-testid={`verify-badge-${status ?? "unknown"}`}
    >
      {m.label}
    </span>
  );
}

/**
 * Distance diagram — rep's recorded position, the lead, a connecting line, and
 * the measured distance. A schematic (not a tile): pins sit at a legible fixed
 * layout, the number is the truth. Accessible via a text summary in <title>.
 */
export function DistanceDiagram({
  distanceM, accuracyM, maxAllowedM, status,
}: { distanceM: number | null | undefined; accuracyM?: number | null; maxAllowedM?: number | null; status?: VStatus }) {
  const unavailable = distanceM == null || !Number.isFinite(distanceM);
  const within = !unavailable && maxAllowedM != null ? (distanceM as number) <= maxAllowedM : undefined;
  const m = metaFor(status);
  const summary = unavailable
    ? "Location unavailable when this lead was marked"
    : `Rep was ${formatDistance(distanceM)} from the lead when marked${accuracyM != null ? `, GPS accuracy ±${Math.round(accuracyM)} m` : ""}${maxAllowedM != null ? `, allowed radius ${maxAllowedM} m` : ""}`;

  return (
    <figure className="rounded-lg border border-border bg-background/60 p-3" data-testid="distance-diagram">
      <svg viewBox="0 0 260 72" role="img" aria-label={summary} className="w-full">
        <title>{summary}</title>
        {unavailable ? (
          <text x="130" y="40" textAnchor="middle" className="fill-muted-foreground" fontSize="11">Location unavailable</text>
        ) : (
          <>
            {/* connecting line */}
            <line x1="34" y1="40" x2="226" y2="40" stroke={m.dot} strokeWidth="2" strokeDasharray="4 3" opacity="0.8" />
            {/* rep recorded position (left) */}
            <circle cx="34" cy="40" r="11" fill={m.dot} opacity="0.18" />
            <circle cx="34" cy="40" r="5" fill={m.dot} />
            <text x="34" y="64" textAnchor="middle" className="fill-muted-foreground" fontSize="9">Rep</text>
            {/* lead (right) */}
            <circle cx="226" cy="40" r="11" fill="hsl(var(--primary))" opacity="0.18" />
            <text x="226" y="66" textAnchor="middle" className="fill-muted-foreground" fontSize="9">Lead</text>
            {/* distance label */}
            <rect x="96" y="14" width="68" height="18" rx="9" fill="hsl(var(--card))" stroke={m.dot} strokeWidth="1" />
            <text x="130" y="26" textAnchor="middle" fill={m.dot} fontSize="11" fontWeight="700">
              {distanceM! < 1000 ? `${Math.round(distanceM!)} m` : `${(distanceM! / 1000).toFixed(1)} km`}
            </text>
          </>
        )}
      </svg>
      {/* Iconography for the pins (screen-reader hidden; the <title> carries meaning) */}
      <div className="mt-1 flex items-center justify-between text-2xs text-muted-foreground" aria-hidden>
        <span className="inline-flex items-center gap-1"> Rep position</span>
        {within != null && (
          <span className={within ? "text-success" : "text-warning"}>
            {within ? "Within radius" : "Outside radius"}
          </span>
        )}
        <span className="inline-flex items-center gap-1"> Lead</span>
      </div>
    </figure>
  );
}
