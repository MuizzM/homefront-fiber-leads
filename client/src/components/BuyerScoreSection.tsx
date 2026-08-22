// ── Buyer score, explained: the property page section ────────────────────────
// The number a rep sorts their day by, with the math in front of them: every
// door starts at 5.0 and each signal adds or subtracts, so the list below adds
// up to the headline. Reads the persisted reasons (server/buyerScoreJob.ts
// writes them with the score); it never recomputes on the client, because the
// two aggregates the model needs (knock history, sold neighbours) live on the
// server.
//
// Three states, each honest:
//   scored   -> headline, tier, rail, reasons
//   removed  -> one quiet line saying why (closed door, do not knock)
//   unscored -> nothing. A door the job has not reached yet should not carry a
//               placeholder that reads like a verdict.
import { buyerTier, BUYER_TIER_LABEL, formatDelta, parseBuyerReasons, type BuyerTier } from "@shared/buyerScore";

const HEADLINE_CLASS: Record<BuyerTier, string> = {
  likely: "text-gold-text",
  possible: "text-primary",
  unlikely: "text-muted-foreground",
  none: "text-muted-foreground",
};
const RAIL_CLASS: Record<BuyerTier, string> = {
  likely: "bg-gold",
  possible: "bg-primary",
  unlikely: "bg-muted-foreground",
  none: "bg-muted-foreground",
};

export function BuyerScoreSection({ lead }: {
  lead: { leadStatus: string; buyerScore?: number | null; buyerScoreReasons?: string | null; buyerScoredAt?: string | null; doNotKnock?: boolean | number | null };
}) {
  const scoredAt = lead.buyerScoredAt ?? null;
  const score = typeof lead.buyerScore === "number" && Number.isFinite(lead.buyerScore) ? lead.buyerScore : null;
  if (score == null && !scoredAt) return null;

  if (score == null) {
    const why = lead.doNotKnock ? "The occupant asked us not to return." : "This door is closed, so it is not scored.";
    return (
      <>
        <h2 className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Buyer score</h2>
        <div className="rounded-xl border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground" data-testid="buyer-score-removed">{why}</div>
      </>
    );
  }

  const tier = buyerTier(score);
  const reasons = parseBuyerReasons(lead.buyerScoreReasons);
  const pct = Math.max(0, Math.min(100, (score / 10) * 100));
  return (
    <>
      <h2 className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Buyer score</h2>
      <section className="rounded-xl border border-border bg-card p-4" data-testid="buyer-score-section" data-tier={tier}>
        <div className="flex items-center gap-3.5">
          <div className={`text-[36px] font-bold leading-none tracking-tight ${HEADLINE_CLASS[tier]}`} data-testid="buyer-score-headline">{score.toFixed(1)}</div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-foreground">{BUYER_TIER_LABEL[tier]} buyer</div>
            <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">Likely is 8 and up, Possible 5 to 7.9, Unlikely under 5.</div>
          </div>
        </div>
        <div className="relative mt-3.5 h-1.5 rounded-full bg-muted" role="progressbar" aria-valuenow={score} aria-valuemin={1} aria-valuemax={10} aria-label="Buyer score">
          <span className={`absolute inset-y-0 left-0 rounded-full ${RAIL_CLASS[tier]}`} style={{ width: `${pct.toFixed(1)}%` }} />
          <span aria-hidden="true" className="absolute -top-[3px] -bottom-[3px] left-1/2 w-px bg-foreground/25" />
          <span aria-hidden="true" className="absolute -top-[3px] -bottom-[3px] left-[80%] w-px bg-foreground/25" />
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground"><span>1</span><span>5 Possible</span><span>8 Likely</span><span>10</span></div>
        {reasons.length > 0 && (
          <ul className="mt-3.5 divide-y divide-border" data-testid="buyer-score-reasons">
            {reasons.map((r) => (
              <li key={r.key} className="flex items-baseline justify-between gap-3 py-2.5">
                <span className={`text-[13px] leading-snug ${r.key === "base" ? "text-muted-foreground" : "text-foreground"}`}>{r.label}</span>
                <span className={`shrink-0 text-[13px] font-semibold tabular-nums ${r.key === "base" ? "text-muted-foreground" : "text-foreground"}`}>
                  {r.key === "base" ? formatDelta(r.delta, { signed: false }) : formatDelta(r.delta)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2.5 text-[11px] leading-snug text-muted-foreground">Scored from what this door and its street have shown so far. Updates nightly and after every knock.</p>
      </section>
    </>
  );
}
