// ── Set the comp terms, and see the contract change ─────────────────────────
//
// The agreement used to say a rep is paid under "the commission structure
// assigned in the portal" and print no figure, so the person sending the
// paperwork had no way to check what the signer would read. This is the
// missing half: choose the plan, and watch the actual contract language update
// underneath it.
//
// The preview is not a mock-up of the contract — it calls describeCommissionTerms,
// the SAME pure function the PDF renders from. A preview that merely resembles
// the document is worse than none: it invites confidence in a paragraph nobody
// verified. This one cannot disagree with what gets signed.
//
// Shape borrowed from patterns that already solve this well: Dub states each
// structure as a card with its consequence written out rather than hiding the
// choice in a dropdown; Dribbble edits a ladder as compact rows with a running
// total; Fresha separates "the org default" from "custom for this person" so
// inheriting is visible rather than implied.

import { useMemo, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import {
  DEFAULT_COMMISSION_TERMS, describeCommissionTerms, normalizeCommissionTerms,
  summarizeCommissionTerms, type CommissionTerms,
} from "@shared/commissionTerms";
import { formatUsdCents, type CommissionTier } from "@shared/commissionTiers";

const dollars = (cents: number) => (cents / 100).toString();
const cents = (value: string) => Math.round(Number(value || 0) * 100);

export function CompTermsEditor({
  value, onChange, disabled = false,
}: {
  value: CommissionTerms;
  onChange: (next: CommissionTerms) => void;
  disabled?: boolean;
}) {
  const [showContract, setShowContract] = useState(true);
  // Validated on every keystroke, because the errors belong next to the field
  // being typed in — not behind a Send button that fails afterwards.
  const check = useMemo(() => normalizeCommissionTerms(value), [value]);

  const patch = (next: Partial<CommissionTerms>) => onChange({ ...value, ...next });

  const setTier = (index: number, next: Partial<CommissionTier>) => {
    const tiers = value.tiers.map((tier, i) => (i === index ? { ...tier, ...next } : tier));
    patch({ tiers });
  };

  const addTier = () => {
    const last = value.tiers[value.tiers.length - 1];
    // The new band starts where the previous one ended, and the previous one
    // gets the ceiling it was missing — so adding a row leaves a LADDER rather
    // than the gap that validateTiers would reject.
    const min = last ? (last.maximumSales ?? last.minimumSales) + 1 : 1;
    const tiers: CommissionTier[] = value.tiers.map((tier, i) =>
      i === value.tiers.length - 1 && tier.maximumSales == null
        ? { ...tier, maximumSales: min - 1 }
        : tier);
    tiers.push({ position: tiers.length, minimumSales: min, maximumSales: null, rateCents: (last?.rateCents ?? 15000) + 5000, label: "" });
    patch({ tiers });
  };

  const removeTier = (index: number) => {
    if (value.tiers.length <= 1) return;
    const tiers = value.tiers
      .filter((_, i) => i !== index)
      .map((tier, i, all) => ({ ...tier, position: i, maximumSales: i === all.length - 1 ? null : tier.maximumSales }));
    patch({ tiers });
  };

  return (
    <div className="space-y-4" data-testid="comp-terms-editor">
      {/* ── Structure: the consequence spelled out, not a dropdown ─────────── */}
      <fieldset className="space-y-2">
        <legend className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          How this rep is paid
        </legend>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Commission structure">
          <StructureCard
            checked={value.structure === "TIERED"}
            disabled={disabled}
            testId="comp-structure-tiered"
            title="Tiered"
            detail="More sales in a week re-prices the whole week at the higher rate."
            onSelect={() => patch({ structure: "TIERED", tiers: value.tiers.length ? value.tiers : DEFAULT_COMMISSION_TERMS.tiers })}
          />
          <StructureCard
            checked={value.structure === "FLAT"}
            disabled={disabled}
            testId="comp-structure-flat"
            title="Flat"
            detail="One rate per qualified sale, however many they close."
            onSelect={() => patch({ structure: "FLAT", flatRateCents: value.flatRateCents ?? 15000 })}
          />
        </div>
      </fieldset>

      {/* ── The numbers ───────────────────────────────────────────────────── */}
      {value.structure === "FLAT" ? (
        <Money
          label="Rate per qualified sale"
          testId="comp-flat-rate"
          disabled={disabled}
          value={value.flatRateCents ?? 0}
          onChange={(next) => patch({ flatRateCents: next })}
        />
      ) : (
        <div className="space-y-1.5" data-testid="comp-tier-rows">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tier ladder</span>
            <span className="text-[11px] text-muted-foreground">{value.tiers.length} bands</span>
          </div>
          {value.tiers.map((tier, index) => {
            const last = index === value.tiers.length - 1;
            return (
              <div key={index} className="flex items-center gap-2" data-testid={`comp-tier-${index}`}>
                <input
                  type="number" min={1} inputMode="numeric" disabled={disabled}
                  aria-label={`Band ${index + 1} minimum sales`}
                  data-testid={`comp-tier-${index}-min`}
                  value={tier.minimumSales}
                  onChange={(e) => setTier(index, { minimumSales: Math.max(1, Number(e.target.value) || 1) })}
                  className={cn("h-11 w-16 rounded-xl border border-border bg-card px-2 text-center text-sm tabular-nums", FOCUS)}
                />
                <span className="text-xs text-muted-foreground">to</span>
                <input
                  type="number" min={1} inputMode="numeric" disabled={disabled || last}
                  aria-label={`Band ${index + 1} maximum sales`}
                  data-testid={`comp-tier-${index}-max`}
                  placeholder={last ? "∞" : ""}
                  value={last ? "" : tier.maximumSales ?? ""}
                  onChange={(e) => setTier(index, { maximumSales: e.target.value === "" ? null : Number(e.target.value) })}
                  className={cn("h-11 w-16 rounded-xl border border-border bg-card px-2 text-center text-sm tabular-nums placeholder:text-muted-foreground disabled:opacity-60", FOCUS)}
                />
                <span className="flex-1 text-xs text-muted-foreground">sales pay</span>
                <div className="relative">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                  <input
                    type="number" min={0} step="5" inputMode="decimal" disabled={disabled}
                    aria-label={`Band ${index + 1} rate per sale`}
                    data-testid={`comp-tier-${index}-rate`}
                    value={dollars(tier.rateCents)}
                    onChange={(e) => setTier(index, { rateCents: cents(e.target.value) })}
                    className={cn("h-11 w-24 rounded-xl border border-border bg-card pl-6 pr-2 text-sm tabular-nums", FOCUS)}
                  />
                </div>
                <button
                  type="button" disabled={disabled || value.tiers.length <= 1}
                  onClick={() => removeTier(index)}
                  aria-label={`Remove band ${index + 1}`}
                  data-testid={`comp-tier-${index}-remove`}
                  className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-30", FOCUS)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            );
          })}
          <button
            type="button" disabled={disabled}
            onClick={addTier}
            data-testid="comp-tier-add"
            className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-dashed border-border px-3 text-[13px] font-semibold text-muted-foreground transition-colors hover:border-solid hover:bg-secondary hover:text-foreground", FOCUS)}
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Add a band
          </button>
        </div>
      )}

      {/* ── Reserve ───────────────────────────────────────────────────────── */}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Chargeback reserve</span>
          <div className="relative">
            <input
              type="number" min={0} max={100} inputMode="numeric" disabled={disabled}
              data-testid="comp-reserve-percent"
              value={value.reservePercent}
              onChange={(e) => patch({ reservePercent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
              className={cn("h-11 w-full rounded-xl border border-border bg-card px-3 pr-8 text-sm tabular-nums", FOCUS)}
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
          </div>
        </label>
        <Money
          label="Reserve cap (0 = uncapped)"
          testId="comp-reserve-cap"
          disabled={disabled}
          value={value.reserveCapCents}
          onChange={(next) => patch({ reserveCapCents: next })}
        />
      </div>

      {/* ── Problems, before Send rather than after ────────────────────────── */}
      {!check.ok && (
        <ul role="alert" data-testid="comp-terms-errors" className="space-y-1 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-[12px] text-destructive">
          {check.errors.map((error) => <li key={error}>{error}</li>)}
        </ul>
      )}

      {/* ── What the rep will actually read ───────────────────────────────── */}
      <div className="rounded-2xl border border-border bg-secondary/30">
        <button
          type="button"
          onClick={() => setShowContract((v) => !v)}
          aria-expanded={showContract}
          data-testid="comp-contract-toggle"
          className={cn("flex min-h-11 w-full items-center justify-between gap-2 px-3.5 text-left", FOCUS)}
        >
          <span className="text-[13px] font-semibold text-foreground">What the agreement will say</span>
          <span className="text-[11px] text-muted-foreground" data-testid="comp-terms-summary">
            {summarizeCommissionTerms(check.normalized)}
          </span>
        </button>
        {showContract && (
          <div className="space-y-2 border-t border-border px-3.5 py-3 text-[12px] leading-relaxed text-muted-foreground" data-testid="comp-contract-preview">
            {describeCommissionTerms(check.normalized).map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
            <p className="text-[11px] italic">
              This is the wording that goes into the Commission Agreement - rendered from the same terms the PDF is built from.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function StructureCard({
  checked, onSelect, disabled, testId, title, detail,
}: {
  checked: boolean; onSelect: () => void; disabled?: boolean;
  testId: string; title: string; detail: string;
}) {
  return (
    <button
      type="button" role="radio" aria-checked={checked} disabled={disabled}
      onClick={onSelect} data-testid={testId}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-50",
        checked ? "border-primary bg-primary/5" : "border-border hover:bg-secondary/40",
        FOCUS,
      )}
    >
      <span className={cn(
        "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border-2",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
      )} aria-hidden="true">
        {checked && <Check className="h-2.5 w-2.5" strokeWidth={4} />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-foreground">{title}</span>
        <span className="block text-[12px] leading-snug text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

function Money({
  label, value, onChange, disabled, testId,
}: {
  label: string; value: number; onChange: (cents: number) => void; disabled?: boolean; testId: string;
}) {
  return (
    <label className="space-y-1">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
        <input
          type="number" min={0} step="5" inputMode="decimal" disabled={disabled}
          data-testid={testId}
          value={dollars(value)}
          onChange={(e) => onChange(cents(e.target.value))}
          className={cn("h-11 w-full rounded-xl border border-border bg-card pl-7 pr-3 text-sm tabular-nums", FOCUS)}
        />
      </div>
      <span className="block text-[11px] text-muted-foreground">{formatUsdCents(value)}</span>
    </label>
  );
}
