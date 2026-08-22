// ── Buyer score pill and tile ─────────────────────────────────────────────────
// One presentation for the household-level "will they buy" number everywhere it
// shows (Leads rows and table, the property page, Today). The tier carries the
// colour, and the tiers are deliberately NOT green or red: gold is the brand's
// "this is money" accent (Likely), navy is structure (Possible), muted recedes
// (Unlikely), so nothing here collides with the status pin palette.
//
// Gold as TEXT must be `text-gold-text` (5.3:1 on white, 5.0:1 on gold-soft);
// the gold fill is 2.6:1 and never carries text. See docs/DESIGN_SYSTEM.md.
import { buyerTier, BUYER_TIER_LABEL, type BuyerTier } from "@shared/buyerScore";

const TIER_CLASS: Record<BuyerTier, string> = {
  likely: "border-gold/55 bg-gold-soft text-gold-text",
  possible: "border-border bg-secondary text-primary",
  unlikely: "border-border bg-transparent text-muted-foreground",
  none: "border-dashed border-border bg-transparent text-muted-foreground",
};

const TIER_LABEL_CLASS: Record<BuyerTier, string> = {
  likely: "text-gold-text",
  possible: "text-secondary-foreground",
  unlikely: "text-muted-foreground",
  none: "text-muted-foreground",
};

// The server stores one decimal; round here too so a raw value like 7.95 can
// never display as "8.0" while wearing the Possible tier.
function oneDecimal(score: number | null | undefined): number | null {
  return typeof score === "number" && Number.isFinite(score) ? Math.round(score * 10) / 10 : null;
}

export function BuyerScorePill({ score: rawScore, size = "sm", label = false, className = "" }: {
  score: number | null | undefined;
  /** sm 22px (rows), md 28px (cards). */
  size?: "sm" | "md";
  /** Append the tier word ("8.4 Likely"). */
  label?: boolean;
  className?: string;
}) {
  const score = oneDecimal(rawScore);
  const tier = buyerTier(score);
  const h = size === "sm" ? "h-[22px] px-2 gap-1" : "h-7 px-2.5 gap-1.5";
  const num = size === "sm" ? "text-xs" : "text-sm";
  const lbl = size === "sm" ? "text-2xs" : "text-xs";
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border tabular-nums ${h} ${TIER_CLASS[tier]} ${className}`}
      data-testid="buyer-score-pill"
      data-tier={tier}
      title="Buyer score"
    >
      {score == null
        ? <span className={`${lbl} font-medium`}>{BUYER_TIER_LABEL.none}</span>
        : <>
            <span className={`${num} font-bold leading-none`}>{score.toFixed(1)}</span>
            {label && <span className={`${lbl} font-medium leading-none ${TIER_LABEL_CLASS[tier]}`}>{BUYER_TIER_LABEL[tier]}</span>}
          </>}
    </span>
  );
}

/** Stages the model removes from scoring (shared/buyerScore.ts CLOSED_STATUSES). */
export function isClosedForScoring(leadStatus: string | null | undefined): boolean {
  return leadStatus === "sold" || leadStatus === "not_interested";
}

/** Fixed-width leading tile for list rows, so the column scans. A closed
 *  door keeps the column's width but carries nothing: it was removed from
 *  scoring, which is not the same as "not scored yet". */
export function BuyerScoreTile({ score: rawScore, closed = false, className = "" }: { score: number | null | undefined; closed?: boolean; className?: string }) {
  const score = oneDecimal(rawScore);
  const tier = buyerTier(score);
  if (closed && score == null) {
    return <span aria-hidden="true" data-testid="buyer-score-tile" data-tier="closed" className={`inline-block h-7 w-11 shrink-0 ${className}`} />;
  }
  return (
    <span
      className={`inline-flex h-7 w-11 shrink-0 items-center justify-center rounded-md border text-[13px] font-bold leading-none tabular-nums ${TIER_CLASS[tier]} ${className}`}
      data-testid="buyer-score-tile"
      data-tier={tier}
      title="Buyer score"
      aria-label={score == null ? "No buyer score yet" : `Buyer score ${score.toFixed(1)}, ${BUYER_TIER_LABEL[tier]}`}
    >
      {score == null ? <span className="text-2xs font-medium">new</span> : score.toFixed(1)}
    </span>
  );
}
