// ── What a scanned door actually is ──────────────────────────────────────────
// Tapping a scanned-door glyph answers one question: can I sell this house?
// The tag is computed on the server (scannedDoors.ts) and passed through
// verbatim, so this card cannot invent a verdict the map does not agree with.
//
// The three tags are NOT decoration. "Tenured" and "Fiber, no account" both
// come back TENURED from Kinetic and look identical in the raw answer; the
// difference is whether anyone is paying, and it is the whole reason a rep
// walks up to one and past the other.
import { useEffect, useRef, useState } from "react";
import { X, Copy, Check, ArrowUpRight } from "lucide-react";
import { FOCUS } from "@/lib/a11y";

export type DoorTag = "new_fiber" | "fiber_open" | "tenured_active" | "coming_soon";

export interface ScannedDoorCardDoor {
  id: number;
  address: string;
  city: string;
  tag: DoorTag;
  label: string;
  scannedAt: string | null;
  promisedDate: string | null;
  band: string | null;
  providerQuote: string | null;
  leadId: number | null;
}

/** One source for the badge treatment, the map paint and the legend swatch. */
export const DOOR_TAG_STYLE: Record<DoorTag, { dot: string; badge: string; meaning: string }> = {
  new_fiber: {
    dot: "#16a34a",
    badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
    meaning: "Fiber is live and no one is on it. This is the sellable door.",
  },
  tenured_active: {
    dot: "#3b82f6",
    badge: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
    meaning: "Already a Kinetic customer with an active account.",
  },
  coming_soon: {
    dot: "#8b5cf6",
    badge: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
    meaning: "Kinetic says fiber is coming here. Not serviceable yet.",
  },
  fiber_open: {
    dot: "#f59e0b",
    badge: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
    meaning: "Fiber at the curb with no account on it. Worth a knock.",
  },
};

/** "2027-02-01" -> "Feb 2027". Never reformats into a precision we do not have. */
function formatPromised(d: string): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(d.trim());
  if (!m) return d;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = months[Number(m[2]) - 1] ?? m[2];
  return m[3] && m[3] !== "01" ? `${mon} ${m[3]}, ${m[1]}` : `${mon} ${m[1]}`;
}

function scannedAgo(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return null;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export interface ScannedDoorCardProps {
  door: ScannedDoorCardDoor | null;
  onClose: () => void;
  onOpenLead?: (leadId: number) => void;
  className?: string;
  style?: React.CSSProperties;
}

export function ScannedDoorCard({ door, onClose, onOpenLead, className, style }: ScannedDoorCardProps) {
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes, matching every other dismissible map overlay.
  useEffect(() => {
    if (!door) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [door, onClose]);

  // A new door resets the copy affordance, otherwise the tick carries over and
  // claims the previous address was copied.
  useEffect(() => { setCopied(false); }, [door?.id]);

  if (!door) return null;
  const style_ = DOOR_TAG_STYLE[door.tag];
  const ago = scannedAgo(door.scannedAt);
  const full = [door.address, door.city].filter(Boolean).join(", ");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked; the address is on screen to read */ }
  };

  return (
    <div
      role="dialog"
      aria-label={`Scanned door, ${door.address}`}
      data-testid="scanned-door-card"
      style={style}
      className={`w-[268px] rounded-xl border border-border bg-card/95 shadow-lg p-3 animate-in fade-in slide-in-from-bottom-1 duration-150 ${className ?? ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground leading-snug break-words" data-testid="scanned-door-address">
            {door.address || "Address unknown"}
          </p>
          {door.city ? (
            <p className="text-xs text-muted-foreground mt-0.5">{door.city}</p>
          ) : null}
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close door details"
          data-testid="scanned-door-close"
          className={`relative w-8 h-8 -mt-1 -mr-1 shrink-0 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors after:absolute after:-inset-2 ${FOCUS}`}
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <span
          data-testid={`scanned-door-tag-${door.tag}`}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${style_.badge}`}
        >
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: style_.dot }} aria-hidden="true" />
          {door.label}
        </span>
        {ago ? <span className="text-2xs text-muted-foreground">scanned {ago}</span> : null}
      </div>

      <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{style_.meaning}</p>

      {/* A promised date is only ever the carrier's own. When Kinetic has not
          stated one we say so rather than inventing a month. */}
      {door.tag === "coming_soon" ? (
        <div className="mt-2 rounded-lg border border-border bg-secondary/30 px-2.5 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xs uppercase tracking-wide text-muted-foreground">Turn-on date</span>
            {door.band ? (
              <span className="text-2xs font-medium text-muted-foreground">{door.band}</span>
            ) : null}
          </div>
          <p className="text-sm font-semibold text-foreground mt-0.5" data-testid="scanned-door-promised">
            {door.promisedDate ? formatPromised(door.promisedDate) : "Not stated by Kinetic"}
          </p>
          {door.providerQuote ? (
            <p className="text-2xs text-muted-foreground mt-1 break-words">{door.providerQuote}</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={copy}
          data-testid="scanned-door-copy"
          className={`relative flex-1 h-11 rounded-lg border border-border bg-secondary/40 hover:bg-secondary/70 text-xs font-medium text-foreground flex items-center justify-center gap-1.5 transition-colors ${FOCUS}`}
        >
          {copied
            ? <><Check className="w-3.5 h-3.5" aria-hidden="true" />Copied</>
            : <><Copy className="w-3.5 h-3.5" aria-hidden="true" />Copy address</>}
        </button>
        {door.leadId != null && onOpenLead ? (
          <button
            type="button"
            onClick={() => onOpenLead(door.leadId as number)}
            data-testid="scanned-door-open-lead"
            className={`relative flex-1 h-11 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${FOCUS}`}
          >
            Open lead
            <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {/* One atomic announcement, never a bare number and never a focus move. */}
      <span className="sr-only" role="status" aria-live="polite">
        {`${door.address || "Address unknown"}, ${door.label}. ${style_.meaning}`}
      </span>
    </div>
  );
}
