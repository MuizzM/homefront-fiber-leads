// ── Offer console ─────────────────────────────────────────────────────────────
//
// Where a supervisor sets what reps in a market are allowed to say. Everything
// downstream reads from here: the reference library's offer card, the Pitch
// Lab's price and speed tokens, and the accuracy dimension of the role-play
// scorer, which flags any number a rep says that no offer here supports.
//
// EFFECTIVE DATES ARE MANDATORY, END DATES ARE NOT
//   Every offer needs a start. An end date is optional, and its absence means
//   "until we say otherwise" rather than "forever". A promotional price is the
//   one case where an end IS required, because a promotion with no end is not a
//   promotion, it is the price, and calling it a promotion at a door is the
//   kind of small lie this whole module exists to make impossible.
//
// The console shows expired rows greyed rather than hiding them, so a
// supervisor can see that their market went quiet rather than wondering why
// reps are reporting an empty offer card.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Chip, ErrorPanel, Panel, PanelSkeleton, PrimaryButton, QuietButton } from "./primitives";
import {
  calendarDay, centsToUsd, isOfferExpired, validateOffer,
  type AcademyOffer, type OfferCatalog,
} from "@shared/academyOffers";

const CATALOG_KEY = ["/api/training/academy/offers/catalog"];

/** A blank offer, dated from today so the common case needs no date typing. */
function blankOffer(day: string): AcademyOffer {
  return {
    id: "", provider: "kinetic", market: "*", name: "",
    downloadMbps: 1000, uploadMbps: 1000,
    priceCents: 0, promoPriceCents: null, promoMonths: null,
    termMonths: 0, equipmentCents: 0, installCents: 0, unlimitedData: true,
    effectiveFrom: day, effectiveTo: null,
    disclosures: ["Price and availability are confirmed at the address before any order is placed."],
  };
}

export default function OfferConsole() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const today = useMemo(() => calendarDay(new Date()), []);
  const { data, isLoading, isError, refetch } = useQuery<OfferCatalog>({
    queryKey: CATALOG_KEY,
    queryFn: async () => (await apiRequest("GET", "/api/training/academy/offers/catalog")).json(),
    staleTime: 30_000,
  });

  const [draft, setDraft] = useState<AcademyOffer[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  useEffect(() => { if (data) setDraft(data.offers); }, [data]);

  const save = useMutation({
    mutationFn: async (offers: AcademyOffer[]) => {
      const res = await apiRequest("PUT", "/api/training/academy/offers/catalog", {
        offers, competitors: data?.competitors ?? [],
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Offers saved", description: "Reps see the new figures on their next load." });
      queryClient.invalidateQueries({ queryKey: CATALOG_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/training/academy/offers"] });
      setEditingIndex(null);
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Nothing was saved",
        description: "One or more offers were rejected. Fix the highlighted fields and save again.",
      });
    },
  });

  if (isLoading) return <PanelSkeleton rows={3} testId="offer-console-loading" />;
  if (isError) {
    return (
      <ErrorPanel
        title="The offer catalog didn't load"
        description="Reps are still seeing whatever was last saved."
        onRetry={() => refetch()}
        testId="offer-console-error"
      />
    );
  }

  const problems = draft.flatMap((o) => validateOffer(o).map((p) => `${o.id || "(no id)"}: ${p}`));

  return (
    <div className="space-y-4" data-testid="offer-console">
      <Panel tone="accent">
        <SectionLabel className="text-primary">What reps may say</SectionLabel>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground">
          Every price and speed a rep is allowed to quote comes from this list, scoped to a market and a date range.
          Anything a rep says that is not here is flagged as an unsupported claim in their coaching report.
        </p>
      </Panel>

      <div className="space-y-2">
        {draft.map((offer, i) => {
          const expired = isOfferExpired(offer, today);
          const editing = editingIndex === i;
          return (
            <div
              key={`${offer.id}-${i}`}
              className={cn(
                "overflow-hidden rounded-2xl border bg-card",
                expired ? "border-border opacity-70" : "border-border",
              )}
              data-testid={`offer-row-${i}`}
            >
              <div className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-bold text-foreground">{offer.name || "Untitled offer"}</div>
                  <div className="text-xs text-muted-foreground">
                    {offer.market === "*" ? "every market" : offer.market} · {offer.downloadMbps}/{offer.uploadMbps} Mbps
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {offer.effectiveFrom} to {offer.effectiveTo ?? "open"}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[13px] font-bold tabular-nums text-foreground">{centsToUsd(offer.priceCents)}</div>
                  {expired && <Chip tone="warn">Expired</Chip>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 border-t border-border px-4 py-2.5">
                <QuietButton onClick={() => setEditingIndex(editing ? null : i)} pressed={editing} testId={`offer-edit-${i}`}>
                  {editing ? "Close" : "Edit"}
                </QuietButton>
                <QuietButton
                  onClick={() => setDraft((prev) => prev.filter((_, j) => j !== i))}
                  testId={`offer-delete-${i}`}
                >
                  Remove
                </QuietButton>
                {!expired && !offer.effectiveTo && (
                  <QuietButton
                    onClick={() => setDraft((prev) => prev.map((o, j) => (j === i ? { ...o, effectiveTo: today } : o)))}
                    testId={`offer-expire-${i}`}
                  >
                    End it today
                  </QuietButton>
                )}
              </div>
              {editing && (
                <OfferEditor
                  offer={offer}
                  onChange={(next) => setDraft((prev) => prev.map((o, j) => (j === i ? next : o)))}
                />
              )}
            </div>
          );
        })}
      </div>

      {problems.length > 0 && (
        <div role="alert" className="rounded-2xl border border-destructive/25 bg-destructive/[0.05] p-4" data-testid="offer-problems">
          <SectionLabel className="text-destructive">Fix before saving</SectionLabel>
          <ul className="mt-2 space-y-1">
            {problems.map((p, i) => <li key={i} className="text-xs leading-relaxed text-foreground">{p}</li>)}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <QuietButton onClick={() => setDraft((prev) => [...prev, blankOffer(today)])} testId="offer-add">
          Add an offer
        </QuietButton>
        <PrimaryButton
          onClick={() => save.mutate(draft)}
          disabled={save.isPending || problems.length > 0}
          testId="offer-save"
        >
          {save.isPending ? "Saving..." : "Save the catalog"}
        </PrimaryButton>
      </div>
    </div>
  );
}

function OfferEditor({ offer, onChange }: { offer: AcademyOffer; onChange: (next: AcademyOffer) => void }) {
  const set = <K extends keyof AcademyOffer>(key: K, value: AcademyOffer[K]) => onChange({ ...offer, [key]: value });

  return (
    <div className="space-y-3 border-t border-border bg-secondary/25 px-4 py-3.5" data-testid="offer-editor">
      <Field label="Id (never change once reps have used it)">
        <TextInput value={offer.id} onChange={(v) => set("id", v.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} testId="offer-field-id" />
      </Field>
      <Field label="Plan name, as it appears on a bill">
        <TextInput value={offer.name} onChange={(v) => set("name", v)} testId="offer-field-name" />
      </Field>
      <Field label='Market ("*" for every market)'>
        <TextInput value={offer.market} onChange={(v) => set("market", v.toLowerCase())} testId="offer-field-market" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Download Mbps">
          <NumberInput value={offer.downloadMbps} onChange={(v) => set("downloadMbps", v)} testId="offer-field-down" />
        </Field>
        <Field label="Upload Mbps">
          <NumberInput value={offer.uploadMbps} onChange={(v) => set("uploadMbps", v)} testId="offer-field-up" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Monthly price, in dollars">
          <NumberInput
            value={Math.round(offer.priceCents / 100)}
            onChange={(v) => set("priceCents", v * 100)}
            testId="offer-field-price"
          />
        </Field>
        <Field label="Equipment, in dollars">
          <NumberInput
            value={Math.round(offer.equipmentCents / 100)}
            onChange={(v) => set("equipmentCents", v * 100)}
            testId="offer-field-equipment"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Promo price, in dollars (blank for none)">
          <NumberInput
            value={offer.promoPriceCents == null ? null : Math.round(offer.promoPriceCents / 100)}
            onChange={(v) => onChange({ ...offer, promoPriceCents: v == null ? null : v * 100, promoMonths: v == null ? null : offer.promoMonths ?? 12 })}
            testId="offer-field-promo"
            allowEmpty
          />
        </Field>
        <Field label="Promo months">
          <NumberInput
            value={offer.promoMonths}
            onChange={(v) => set("promoMonths", v)}
            testId="offer-field-promo-months"
            allowEmpty
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Quotable from">
          <DateInput value={offer.effectiveFrom} onChange={(v) => set("effectiveFrom", v)} testId="offer-field-from" />
        </Field>
        <Field label="Quotable until (blank for open)">
          <DateInput value={offer.effectiveTo ?? ""} onChange={(v) => set("effectiveTo", v || null)} testId="offer-field-to" />
        </Field>
      </div>
      <Field label="Term months (0 for no contract)">
        <NumberInput value={offer.termMonths} onChange={(v) => set("termMonths", v)} testId="offer-field-term" />
      </Field>
      <Field label="Disclosures, one per line. Reps say these with the price.">
        <textarea
          value={offer.disclosures.join("\n")}
          onChange={(e) => set("disclosures", e.target.value.split("\n").filter((l) => l.trim()))}
          rows={3}
          data-testid="offer-field-disclosures"
          className={cn(
            "w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground",
            FOCUS,
          )}
        />
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function TextInput({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId?: string }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
      className={cn("min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground", FOCUS)}
    />
  );
}

function NumberInput({ value, onChange, testId, allowEmpty }: {
  value: number | null;
  onChange: (v: any) => void;
  testId?: string;
  allowEmpty?: boolean;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      value={value ?? ""}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "" && allowEmpty) { onChange(null); return; }
        const n = Number(raw);
        onChange(Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
      }}
      data-testid={testId}
      className={cn("min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm tabular-nums text-foreground", FOCUS)}
    />
  );
}

function DateInput({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId?: string }) {
  return (
    <input
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
      className={cn("min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground", FOCUS)}
    />
  );
}
