import { useMemo } from "react";
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import {
  validateTiers, calculateRetroactiveCommission, formatUsdCents,
  type CommissionTier,
} from "@shared/commissionTiers";

// Editing weekly sales tiers.
//
// The rule these express is RETROACTIVE: the band a rep lands in sets the rate
// for EVERY sale that week, not just the ones above the threshold. Sell 6 at the
// 1–6 band and it's 6 × $150; sell a 7th and all seven pay $200 — $1,400, not
// $900 + $200. That is a $500 swing on one sale, so the editor shows the payout
// at each boundary rather than asking anyone to hold it in their head.
//
// Bands must tile the whole range with no gap or overlap, and the last one must
// be open-ended — otherwise a rep who beats the top band earns nothing. The
// editor maintains that invariant as you type instead of rejecting you at save.

export interface TierEditorProps {
  tiers: CommissionTier[];
  onChange: (tiers: CommissionTier[]) => void;
  disabled?: boolean;
}

/** Dollars ⇄ cents at the edge only. All money stays integer cents inside. */
const toDollars = (cents: number) => String(Math.round(cents) / 100);
const toCents = (dollars: string) => Math.round((parseFloat(dollars) || 0) * 100);

/**
 * Re-tile bands so they stay contiguous and the last stays open-ended.
 *
 * Each band starts one past the previous band's maximum, so editing one
 * maximum pushes the next band's minimum rather than leaving a hole. Only the
 * MAXIMUM is editable per row; the minimum is derived, which makes an invalid
 * arrangement unreachable rather than merely reported.
 */
function retile(rows: CommissionTier[]): CommissionTier[] {
  const out: CommissionTier[] = [];
  let nextMin = 1;
  rows.forEach((row, i) => {
    const isLast = i === rows.length - 1;
    const min = nextMin;
    // A maximum below the minimum is meaningless; hold it at the minimum so the
    // band is at least one sale wide while the manager is mid-edit.
    const max = isLast ? null : Math.max(min, row.maximumSales ?? min);
    out.push({ ...row, position: i, minimumSales: min, maximumSales: max });
    nextMin = (max ?? min) + 1;
  });
  return out;
}

function bandLabel(t: CommissionTier): string {
  return t.maximumSales == null ? `${t.minimumSales}+` : `${t.minimumSales}–${t.maximumSales}`;
}

export function TierEditor({ tiers, onChange, disabled = false }: TierEditorProps) {
  const validation = useMemo(() => validateTiers(tiers), [tiers]);

  // The payout at each band's first and last sale — where the retroactive jump
  // is visible. This is the number a manager is actually deciding.
  const preview = useMemo(() => {
    if (!validation.ok) return [];
    return tiers.map(t => {
      const at = t.minimumSales;
      const r = calculateRetroactiveCommission(at, validation.normalized ?? tiers);
      return { label: bandLabel(t), at, total: r.grossCommissionCents, rate: r.rateCents };
    });
  }, [tiers, validation]);

  const update = (i: number, patch: Partial<CommissionTier>) => {
    const next = tiers.map((t, k) => (k === i ? { ...t, ...patch } : t));
    onChange(retile(next));
  };

  const addBand = () => {
    const last = tiers[tiers.length - 1];
    // The new band takes over the open end; the old last band gets a maximum so
    // the range stays tiled.
    const closed: CommissionTier = { ...last, maximumSales: last.minimumSales + 5 };
    const added: CommissionTier = {
      position: tiers.length, minimumSales: 0, maximumSales: null,
      rateCents: last.rateCents + 5000, label: "",
    };
    onChange(retile([...tiers.slice(0, -1), closed, added]));
  };

  const removeBand = (i: number) => {
    if (tiers.length <= 1) return; // one band is the minimum meaningful plan
    onChange(retile(tiers.filter((_, k) => k !== i)));
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {tiers.map((t, i) => {
          const isLast = i === tiers.length - 1;
          return (
            <div key={i} className="flex items-center gap-2" data-testid={`tier-row-${i}`}>
              <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">
                {t.minimumSales}
                {isLast ? "+" : "–"}
              </span>

              {!isLast && (
                <input
                  type="number"
                  min={t.minimumSales}
                  step={1}
                  value={t.maximumSales ?? ""}
                  disabled={disabled}
                  aria-label={`Top of band ${i + 1}`}
                  data-testid={`tier-max-${i}`}
                  onChange={e => update(i, { maximumSales: parseInt(e.target.value, 10) || t.minimumSales })}
                  className="h-9 w-20 rounded-md border bg-secondary px-2 text-sm tabular-nums"
                />
              )}

              <span className="text-xs text-muted-foreground shrink-0">sales pay</span>

              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={toDollars(t.rateCents)}
                  disabled={disabled}
                  aria-label={`Rate per sale for band ${i + 1}`}
                  data-testid={`tier-rate-${i}`}
                  onChange={e => update(i, { rateCents: toCents(e.target.value) })}
                  className="h-9 w-24 rounded-md border bg-secondary pl-5 pr-2 text-sm tabular-nums"
                />
              </div>
              <span className="text-xs text-muted-foreground shrink-0">each</span>

              <button
                type="button"
                onClick={() => removeBand(i)}
                disabled={disabled || tiers.length <= 1}
                aria-label={`Remove band ${i + 1}`}
                data-testid={`tier-remove-${i}`}
                className="ml-auto h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive disabled:opacity-30"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={addBand}
        disabled={disabled}
        data-testid="tier-add"
        className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" /> Add a band
      </button>

      {!validation.ok && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs space-y-1">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="h-3.5 w-3.5" /> This plan can't be saved yet
          </div>
          {validation.errors.map(e => <div key={e}>{e}</div>)}
        </div>
      )}

      {preview.length > 0 && (
        // The retroactive jump, spelled out. Hitting the next band re-prices the
        // whole week, and that is not obvious from the rates alone.
        <div className="rounded-md border bg-secondary/40 p-2.5 text-xs space-y-1" data-testid="tier-preview">
          <div className="font-semibold text-foreground">A week's pay at each band</div>
          {preview.map(p => (
            <div key={p.label} className="flex justify-between tabular-nums">
              <span className="text-muted-foreground">
                {p.at} {p.at === 1 ? "sale" : "sales"} ({p.label}) × {formatUsdCents(p.rate)}
              </span>
              <span className="font-semibold text-foreground">{formatUsdCents(p.total)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default TierEditor;
