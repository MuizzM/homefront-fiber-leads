import { useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  validateTiers, calculateRetroactiveCommission, formatUsdCents,
  type CommissionTier,
} from "@shared/commissionTiers";

// Editing weekly sales bands.
//
// The rule these express is RETROACTIVE: the band a rep lands in sets the rate
// for EVERY sale that week, not just the ones above the threshold. Sell 6 at the
// 1-6 band and it's 6 x $150; sell a 7th and all seven pay $200 — $1,400, not
// $900 + $200. That is a $500 swing on one sale, so the editor shows the payout
// at each boundary rather than asking anyone to hold it in their head.
//
// Bands must tile the whole range with no gap or overlap, and the last must be
// open-ended — otherwise a rep who beats the top band earns nothing.
//
// ── THE BUG THIS REWRITE FIXES ──────────────────────────────────────────────
// The old handler read:
//
//     onChange={e => update(i, { maximumSales: parseInt(e.target.value, 10)
//                                              || t.minimumSales })}
//
// Clearing the field to retype it makes parseInt("") NaN, and `NaN || minimum`
// collapses the band to a single sale. Band 1-6 becomes 1-1, which re-tiles the
// next band to 2+. The manager sees "1-" and "2+", tries to fix it, and every
// attempt to clear the field snaps it back. The range is effectively uneditable,
// and deleting a band doesn't help because the collapse happens again on the
// next keystroke.
//
// The fix is to let the field hold text that is not yet a valid number. A
// half-typed value is a normal state of an input, not an error to correct
// mid-keystroke. Nothing is committed until it parses; on blur, an unusable
// draft reverts to the last good value rather than silently becoming 1.

export interface TierEditorProps {
  tiers: CommissionTier[];
  onChange: (tiers: CommissionTier[]) => void;
  disabled?: boolean;
  /** Guard rail against a ladder nobody can reason about. Stripe surfaces the
   *  remaining count before you hit the wall; so does the Add control below. */
  maxBands?: number;
}

// Sanity ceilings. The server is authoritative, but a fat-fingered paste should
// not be allowed to build a plan that reprices a rep's whole week at $10bn a
// sale, or a band boundary no rep could ever cross. Rejecting at the input is
// kinder than a validation error after save.
const MAX_RATE_CENTS = 1_000_00;   // $1,000 per sale
const MAX_BAND_TOP = 9_999;        // sales in one week

/** Dollars ⇄ cents at the edge only. All money stays integer cents inside. */
const toDollars = (cents: number) => String(Math.round(cents) / 100);

function bandLabel(minimumSales: number, maximumSales: number | null): string {
  return maximumSales == null ? `${minimumSales}+` : `${minimumSales}-${maximumSales}`;
}

/**
 * Re-tile bands so they stay contiguous and the last stays open-ended.
 *
 * Each band starts one past the previous band's maximum, so editing one maximum
 * pushes the next band's minimum rather than leaving a hole. Only the MAXIMUM is
 * editable per row; the minimum is derived, which makes a gap or an overlap
 * unreachable rather than merely reported.
 *
 * The label is derived here too. It used to be carried over untouched, so a band
 * created as "1-6" kept that label after being widened to 1-12 — and the label
 * is what gets persisted and shown to the rep on their statement. A band that
 * pays 1-12 while calling itself 1-6 is a payroll dispute, not a cosmetic slip.
 */
function retile(rows: CommissionTier[]): CommissionTier[] {
  const out: CommissionTier[] = [];
  let nextMin = 1;
  rows.forEach((row, i) => {
    const isLast = i === rows.length - 1;
    const min = nextMin;
    // A maximum below the minimum is meaningless; hold it at the minimum so the
    // band stays at least one sale wide while the manager is mid-edit.
    const max = isLast ? null : Math.max(min, row.maximumSales ?? min);
    out.push({ ...row, position: i, minimumSales: min, maximumSales: max, label: bandLabel(min, max) });
    nextMin = (max ?? min) + 1;
  });
  return out;
}

export function TierEditor({ tiers, onChange, disabled = false, maxBands = 8 }: TierEditorProps) {
  // Text the manager is part-way through typing, keyed by row. Absent = the row
  // is showing its committed value. This is the whole fix: an input is allowed
  // to be empty or half-typed without the model reacting to it.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const validation = useMemo(() => validateTiers(tiers), [tiers]);

  // A week's pay at the first and last sale of each band. The pair is the point:
  // the last sale of one band and the first of the next is where the retroactive
  // jump happens, and that jump is the number a manager is actually deciding.
  const preview = useMemo(() => {
    if (!validation.ok) return [];
    const rows = validation.normalized ?? tiers;
    return rows.map(t => {
      const top = t.maximumSales ?? t.minimumSales;
      const atMin = calculateRetroactiveCommission(t.minimumSales, rows);
      const atMax = calculateRetroactiveCommission(top, rows);
      return {
        key: `${t.minimumSales}-${t.maximumSales ?? "open"}`,
        label: bandLabel(t.minimumSales, t.maximumSales),
        rate: atMin.rateCents,
        low: { at: t.minimumSales, total: atMin.grossCommissionCents },
        high: { at: top, total: atMax.grossCommissionCents },
        openEnded: t.maximumSales == null,
      };
    });
  }, [tiers, validation]);

  const commit = (i: number, patch: Partial<CommissionTier>) => {
    onChange(retile(tiers.map((t, k) => (k === i ? { ...t, ...patch } : t))));
  };

  const setDraft = (key: string, value: string) => setDrafts(d => ({ ...d, [key]: value }));
  const clearDraft = (key: string) =>
    setDrafts(d => { const next = { ...d }; delete next[key]; return next; });

  /** Commit only a value that is actually usable. Anything else stays a draft. */
  const onMaxChange = (i: number, raw: string) => {
    setDraft(`max:${i}`, raw);
    if (!/^\d{1,4}$/.test(raw.trim())) return;  // "", "-", "1e3" — hold, don't collapse
    const parsed = Number.parseInt(raw, 10);
    if (parsed >= tiers[i].minimumSales && parsed <= MAX_BAND_TOP) commit(i, { maximumSales: parsed });
  };

  /** On blur, an unusable draft reverts. It never silently becomes the minimum. */
  const onMaxBlur = (i: number) => {
    const raw = drafts[`max:${i}`];
    clearDraft(`max:${i}`);
    if (raw === undefined) return;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= tiers[i].minimumSales && parsed <= MAX_BAND_TOP) {
      commit(i, { maximumSales: parsed });
    }
  };

  const onRateChange = (i: number, raw: string) => {
    setDraft(`rate:${i}`, raw);
    if (!/^\d*\.?\d*$/.test(raw.trim()) || raw.trim() === "") return;
    const cents = Math.round(parseFloat(raw) * 100);
    if (Number.isInteger(cents) && cents > 0 && cents <= MAX_RATE_CENTS) commit(i, { rateCents: cents });
  };

  const onRateBlur = (i: number) => {
    const raw = drafts[`rate:${i}`];
    clearDraft(`rate:${i}`);
    if (raw === undefined) return;
    const cents = Math.round(parseFloat(raw) * 100);
    if (!Number.isFinite(cents) || cents <= 0 || cents > MAX_RATE_CENTS) return;  // revert
    commit(i, { rateCents: cents });
  };

  const addBand = () => {
    const last = tiers[tiers.length - 1];
    // An empty ladder used to crash here reading `last.minimumSales` off
    // undefined. A plan with no bands is reachable (a failed load, a cleared
    // form), and the recovery from it should be this button, not a stack trace.
    if (!last) {
      onChange(retile([{ position: 0, minimumSales: 1, maximumSales: null, rateCents: 15000, label: "" }]));
      return;
    }
    if (tiers.length >= maxBands) return;
    // The new band takes over the open end; the old last band gets a maximum so
    // the range stays tiled. Six sales wide matches the default first band, so
    // 1+ becomes 1-6 and 7+ — the ladder managers actually described.
    const closed: CommissionTier = { ...last, maximumSales: last.minimumSales + 5 };
    const added: CommissionTier = {
      position: tiers.length, minimumSales: 0, maximumSales: null,
      rateCents: last.rateCents + 5000, label: "",
    };
    setDrafts({});
    onChange(retile([...tiers.slice(0, -1), closed, added]));
  };

  const removeBand = (i: number) => {
    if (tiers.length <= 1) return;  // one band is the minimum meaningful plan
    // Drafts are keyed by row index, so any left behind would land on whichever
    // band shifts up into that slot. Clearing them is what makes a delete stick.
    setDrafts({});
    onChange(retile(tiers.filter((_, k) => k !== i)));
  };

  const remaining = maxBands - tiers.length;

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {tiers.map((t, i) => {
          const isLast = i === tiers.length - 1;
          const maxValue = drafts[`max:${i}`] ?? (t.maximumSales == null ? "" : String(t.maximumSales));
          const rateValue = drafts[`rate:${i}`] ?? toDollars(t.rateCents);
          return (
            <div
              key={i}
              data-testid={`tier-row-${i}`}
              className="group relative flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-border bg-secondary/30 p-2.5 pr-9"
            >
              {/* The range reads as one phrase — "1 to 6 sales pay $150 each" —
                  rather than as disconnected inputs. The minimum is derived and
                  shown as text, because it is not the manager's to set: it is
                  always one past the band below. */}
              <span className="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-foreground">
                {t.minimumSales}
              </span>

              {isLast ? (
                <span
                  data-testid={`tier-open-${i}`}
                  className="rounded-md bg-muted px-2 py-1 text-[11px] font-semibold text-muted-foreground"
                >
                  and up
                </span>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground">to</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={maxValue}
                    disabled={disabled}
                    aria-label={`Top of band ${i + 1}`}
                    data-testid={`tier-max-${i}`}
                    onChange={e => onMaxChange(i, e.target.value)}
                    onBlur={() => onMaxBlur(i)}
                    className="h-9 w-16 rounded-md border border-border bg-background px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  />
                </>
              )}

              <span className="shrink-0 text-xs text-muted-foreground">sales pay</span>

              <div className="relative">
                <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={rateValue}
                  disabled={disabled}
                  aria-label={`Rate per sale for band ${i + 1}`}
                  data-testid={`tier-rate-${i}`}
                  onChange={e => onRateChange(i, e.target.value)}
                  onBlur={() => onRateBlur(i)}
                  className="h-9 w-24 rounded-md border border-border bg-background pl-5 pr-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                />
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">each</span>

              {/* Stripe puts remove in the row's top-right corner rather than in
                  the field flow, so it never competes with the inputs for the
                  same tap target. Drawn at 28px, hit area floored at 44px via
                  tap-expand; always rendered — a control that appears only on
                  hover is unusable on a touch screen. */}
              <button
                type="button"
                onClick={() => removeBand(i)}
                disabled={disabled || tiers.length <= 1}
                aria-label={`Remove band ${bandLabel(t.minimumSales, t.maximumSales)}`}
                title={tiers.length <= 1 ? "A plan needs at least one band" : "Remove this band"}
                data-testid={`tier-remove-${i}`}
                className="tap-expand absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-25"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={addBand}
          disabled={disabled || remaining <= 0}
          data-testid="tier-add"
          className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-secondary disabled:opacity-40"
        >
           Add a band
        </button>
        {/* Stripe shows the headroom before you hit it, so the disabled state is
            never a surprise. */}
        <span className="text-[11px] text-muted-foreground" data-testid="tier-remaining">
          {remaining > 0 ? `${remaining} more available` : "Maximum bands reached"}
        </span>
      </div>

      {!validation.ok && (
        <div role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs">
          <div className="flex items-center gap-1.5 font-semibold">
             This plan can't be saved yet
          </div>
          {validation.errors.map(e => <div key={e}>{e}</div>)}
        </div>
      )}

      {preview.length > 0 && (
        // Stripe pairs the editor with a live preview of the thing being built.
        // Here that means the week's pay at the bottom AND top of each band -
        // the jump between one band's top and the next band's bottom is the
        // retroactive rule made visible, and it is not obvious from rates alone.
        <div className="rounded-md border border-border bg-secondary/40 p-2.5 text-xs" data-testid="tier-preview">
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-foreground">
             A week's pay at each band
          </div>
          <div className="space-y-1.5">
            {preview.map(p => (
              <div key={p.key} className="flex items-baseline justify-between gap-3 tabular-nums">
                <span className="text-muted-foreground">
                  <span className="font-medium text-foreground">{p.label}</span> at {formatUsdCents(p.rate)} each
                </span>
                <span className="shrink-0 font-semibold text-foreground">
                  {formatUsdCents(p.low.total)}
                  {p.high.at !== p.low.at && (
                    <span className="font-normal text-muted-foreground">
                      {" - "}{formatUsdCents(p.high.total)}
                    </span>
                  )}
                  {p.openEnded && <span className="font-normal text-muted-foreground"> and up</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default TierEditor;
