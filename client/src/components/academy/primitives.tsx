// ── Academy UI primitives ─────────────────────────────────────────────────────
//
// The small pieces every Academy screen builds from, so the six sections cannot
// drift into six visual dialects. Tokens only, no raw colours, 44px minimum on
// anything tappable, and the shared FOCUS ring on every raw interactive.
//
// Gold is used exactly where the design system says it may be: earned state and
// the one emphasis per surface. Everything structural is blue. Nothing here
// paints gold as a surface behind text, which is the mistake the token comments
// in index.css exist to prevent.

import { type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";

/** Progress ring with the count inside it. Decorative: the count is repeated
 *  in text beside every use, so the ring itself is aria-hidden. */
export function Ring({ done, total, size = 44, tone = "primary" }: {
  done: number;
  total: number;
  size?: number;
  tone?: "primary" | "gold";
}) {
  const stroke = 3.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? Math.min(1, done / total) : 0;
  const complete = pct >= 1;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-border" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
          className={cn(
            "transition-[stroke-dashoffset] duration-500 ease-out",
            complete ? "stroke-success" : tone === "gold" ? "stroke-[hsl(var(--accent-gold))]" : "stroke-primary",
          )}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[11px] font-bold tabular-nums text-foreground">
        {done}/{total}
      </span>
    </div>
  );
}

/** A quiet status chip. `tone` maps to the semantic tokens, never raw colours. */
export function Chip({ tone = "neutral", children, className }: {
  tone?: "neutral" | "good" | "warn" | "bad" | "gold" | "info";
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    neutral: "bg-secondary text-muted-foreground",
    good: "bg-success/10 text-success",
    warn: "bg-warning/10 text-warning",
    bad: "bg-destructive/10 text-destructive",
    info: "bg-info/10 text-info",
    gold: "bg-[hsl(var(--accent-gold-soft))] text-[hsl(var(--accent-gold-text))]",
  } as const;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", tones[tone], className)}>
      {children}
    </span>
  );
}

/** Primary action. One per surface. */
export function PrimaryButton({ children, onClick, disabled, type = "button", testId, className, full }: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  testId?: string;
  className?: string;
  full?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground",
        "transition-transform duration-150 active:scale-[.98] disabled:pointer-events-none disabled:opacity-55",
        full && "w-full",
        FOCUS,
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Secondary action. Bordered, never gold. */
export function QuietButton({ children, onClick, disabled, testId, className, full, pressed }: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  testId?: string;
  className?: string;
  full?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-semibold",
        "transition-colors disabled:pointer-events-none disabled:opacity-55",
        pressed
          ? "border-primary/40 bg-primary/[0.08] text-primary"
          : "border-border bg-card text-foreground hover:bg-secondary/60",
        full && "w-full",
        FOCUS,
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Back link, consistent across every drill-down in the tab. */
export function BackLink({ label, onClick, testId }: { label: string; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId ?? "academy-back"}
      className={cn(
        "-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground",
        FOCUS,
      )}
    >
      <span aria-hidden="true">&lsaquo;</span> {label}
    </button>
  );
}

/** The card every Academy panel sits in. */
export function Panel({ children, className, testId, tone = "plain" }: {
  children: ReactNode;
  className?: string;
  testId?: string;
  tone?: "plain" | "accent" | "warn";
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "rounded-2xl border p-4 md:p-5",
        tone === "accent" && "border-primary/25 bg-primary/[0.06]",
        tone === "warn" && "border-warning/30 bg-warning/[0.07]",
        tone === "plain" && "border-border bg-card",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The weak / improved / excellent ladder. The teaching device the whole Pitch
 * Lab and objection dojo are built on: reps recognise the weak line as their
 * own, which is the moment the excellent line becomes learnable.
 */
export function WordingLadderCard({ ladder, testId }: {
  ladder: { weak: string; improved: string; excellent: string; why: string };
  testId?: string;
}) {
  const rungs = [
    { label: "Weak", text: ladder.weak, tone: "bad" as const },
    { label: "Better", text: ladder.improved, tone: "warn" as const },
    { label: "Excellent", text: ladder.excellent, tone: "good" as const },
  ];
  return (
    <div className="space-y-2" data-testid={testId}>
      {rungs.map((rung) => (
        <div
          key={rung.label}
          className={cn(
            "rounded-xl border p-3",
            rung.tone === "bad" && "border-destructive/25 bg-destructive/[0.05]",
            rung.tone === "warn" && "border-warning/25 bg-warning/[0.05]",
            rung.tone === "good" && "border-success/30 bg-success/[0.06]",
          )}
        >
          <Chip tone={rung.tone}>{rung.label}</Chip>
          <p className="mt-1.5 text-[13px] leading-relaxed text-foreground">{rung.text}</p>
        </div>
      ))}
      <div className="rounded-xl border border-border bg-secondary/40 p-3">
        <SectionLabel>Why the last one wins</SectionLabel>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{ladder.why}</p>
      </div>
    </div>
  );
}

/** Loading skeleton shaped like the content it replaces, not a spinner. */
export function PanelSkeleton({ rows = 3, testId }: { rows?: number; testId?: string }) {
  return (
    <div
      className="space-y-2 rounded-2xl border border-border bg-card p-4"
      data-testid={testId ?? "academy-loading"}
      role="status"
      aria-label="Loading"
    >
      <div className="h-3 w-24 animate-pulse rounded bg-secondary" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-11 animate-pulse rounded-xl bg-secondary" style={{ opacity: 1 - i * 0.15 }} />
      ))}
    </div>
  );
}

/** Error state with a retry, never a bare message. */
export function ErrorPanel({ title, description, onRetry, testId }: {
  title: string;
  description: string;
  onRetry?: () => void;
  testId?: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId ?? "academy-error"}
      className="rounded-2xl border border-destructive/25 bg-destructive/[0.05] p-4"
    >
      <div className="text-[15px] font-semibold text-foreground">{title}</div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      {onRetry && (
        <div className="mt-3">
          <QuietButton onClick={onRetry} testId="academy-retry">Try again</QuietButton>
        </div>
      )}
    </div>
  );
}

/** A tick that reads as done without an icon font. */
export function DoneDot({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-bold",
        done ? "border-success bg-success text-white" : "border-border bg-background text-muted-foreground",
      )}
    >
      {done && <Check className="h-3.5 w-3.5" />}
    </span>
  );
}

/** Horizontal scroll strip of section tabs. Keyboard-navigable as a tablist. */
export function SectionTabs<T extends string>({ tabs, value, onChange, testIdPrefix }: {
  tabs: { id: T; label: string; badge?: number }[];
  value: T;
  onChange: (id: T) => void;
  testIdPrefix?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Academy sections"
      className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0"
      style={{ scrollbarWidth: "none" }}
      onKeyDown={(e) => {
        const i = tabs.findIndex((t) => t.id === value);
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length;
          onChange(tabs[next].id);
        }
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            data-testid={`${testIdPrefix ?? "academy-tab"}-${tab.id}`}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border px-3.5 text-[13px] font-semibold transition-colors",
              active
                ? "border-primary/40 bg-primary/[0.09] text-primary"
                : "border-border bg-card text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              FOCUS,
            )}
          >
            {tab.label}
            {tab.badge != null && tab.badge > 0 && (
              <span className="rounded-full bg-primary px-1.5 text-[10px] font-bold tabular-nums text-primary-foreground">
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
