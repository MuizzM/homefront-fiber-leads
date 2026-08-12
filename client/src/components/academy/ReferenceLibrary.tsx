// ── Reference library ─────────────────────────────────────────────────────────
//
// The surface a rep opens ON a porch: one-handed, in the sun, with somebody
// waiting. So it is search-first, the results are titles rather than previews,
// and a card opens to scannable bullets rather than prose.
//
// The live offer card sits at the top and is not searchable away, because it is
// the one thing a rep must have seen before quoting anything, and because it is
// the only content on this screen that changes by market and by day.

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { BackLink, Chip, Panel } from "./primitives";
import {
  CATEGORY_TITLES, REFERENCE_CATEGORIES, getReferenceCard, searchReference,
  type ReferenceCard, type ReferenceCategory,
} from "@shared/academyReference";
import {
  centsToUsd, effectivePriceCents, isCompetitorStale, requiredDisclosures,
  type AcademyOffer, type CompetitorOffer,
} from "@shared/academyOffers";

export default function ReferenceLibrary({
  offers, expired, competitors, day, market, readCardIds, onOpenCard, focusCardId, onCloseCard,
}: {
  offers: AcademyOffer[];
  expired: AcademyOffer[];
  competitors: CompetitorOffer[];
  day: string;
  market: string | null;
  readCardIds: Set<string>;
  /** Fired when a required card is opened, so the path can mark it read. */
  onOpenCard?: (cardId: string) => void;
  focusCardId?: string | null;
  onCloseCard?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<ReferenceCategory[]>([]);
  const [openId, setOpenId] = useState<string | null>(focusCardId ?? null);

  const results = useMemo(() => searchReference(query, filters), [query, filters]);
  const open = openId ? getReferenceCard(openId) : undefined;

  function openCard(card: ReferenceCard) {
    setOpenId(card.id);
    onOpenCard?.(card.id);
  }

  if (open) {
    return (
      <div className="space-y-4" data-testid={`reference-card-${open.id}`}>
        <BackLink label="All reference" onClick={() => { setOpenId(null); onCloseCard?.(); }} />
        <div>
          <SectionLabel>{CATEGORY_TITLES[open.category]}</SectionLabel>
          <h2 className="mt-1 text-lg font-bold leading-snug tracking-tight text-foreground">{open.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{open.summary}</p>
        </div>
        <ul className="space-y-2.5">
          {open.points.map((point, i) => (
            <li
              key={i}
              className={cn(
                "rounded-xl border p-3.5 text-[13px] leading-relaxed",
                open.category === "never_say"
                  ? "border-destructive/25 bg-destructive/[0.04] text-foreground"
                  : "border-border bg-card text-foreground",
              )}
            >
              {point}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="reference-library">
      {/* Today's offer card. Never filtered away. */}
      <OfferCard offers={offers} expired={expired} day={day} market={market} />

      <div>
        <label htmlFor="reference-search" className="sr-only">Search the reference library</label>
        <input
          id="reference-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search: upload, DNC, dogs, never say, install"
          data-testid="reference-search"
          className={cn(
            "min-h-11 w-full rounded-xl border border-border bg-card px-3.5 text-sm text-foreground placeholder:text-muted-foreground",
            FOCUS,
          )}
        />
      </div>

      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0" style={{ scrollbarWidth: "none" }}>
        {REFERENCE_CATEGORIES.map((category) => {
          const active = filters.includes(category);
          return (
            <button
              key={category}
              type="button"
              aria-pressed={active}
              onClick={() => setFilters((prev) => (active ? prev.filter((c) => c !== category) : [...prev, category]))}
              data-testid={`reference-filter-${category}`}
              className={cn(
                "inline-flex min-h-11 shrink-0 items-center rounded-xl border px-3.5 text-[13px] font-semibold transition-colors",
                active
                  ? "border-primary/40 bg-primary/[0.09] text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                FOCUS,
              )}
            >
              {CATEGORY_TITLES[category]}
            </button>
          );
        })}
      </div>

      {results.length === 0 ? (
        <Panel testId="reference-empty">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Nothing matches &ldquo;{query}&rdquo;. Try a word a customer would use: upload, contract, install, price,
            dog, sign.
          </p>
        </Panel>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card" data-testid="reference-results">
          {results.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => openCard(card)}
              data-testid={`reference-open-${card.id}`}
              className={cn(
                "flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/50",
                FOCUS,
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold leading-snug text-foreground">{card.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{card.summary}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {card.required && !readCardIds.has(card.id) && <Chip tone="gold">Required</Chip>}
                {card.required && readCardIds.has(card.id) && <Chip tone="good">Read</Chip>}
                <span aria-hidden="true" className="text-muted-foreground/50">&rsaquo;</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {competitors.length > 0 && (
        <div data-testid="reference-competitors">
          <SectionLabel className="mb-1.5 px-1">Competitor figures in this market</SectionLabel>
          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
            {competitors.map((c) => {
              const stale = isCompetitorStale(c, day);
              return (
                <div key={c.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-foreground">{c.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {c.downloadMbps} down, {c.uploadMbps} up, {c.medium.replace(/_/g, " ")}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[13px] font-bold tabular-nums text-foreground">{centsToUsd(c.priceCents)}</div>
                      {stale && <Chip tone="warn">Stale</Chip>}
                    </div>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                    {c.source}. Checked {c.asOf}.
                    {stale && " Do not quote this until someone re-checks it."}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Today's quotable offers for this market, with their disclosures attached. */
function OfferCard({ offers, expired, day, market }: {
  offers: AcademyOffer[];
  expired: AcademyOffer[];
  day: string;
  market: string | null;
}) {
  if (!offers.length) {
    return (
      <Panel tone="warn" testId="offer-card-empty">
        <SectionLabel className="text-warning">No live offer today</SectionLabel>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground">
          {expired.length
            ? `Everything configured for this market has expired. The last one ended ${expired[0].effectiveTo}. Do not quote a price or a speed until a supervisor sets the market's offers.`
            : "Nothing is configured for this market yet. Do not quote a price or a speed until a supervisor sets it."}
        </p>
      </Panel>
    );
  }
  return (
    <div data-testid="offer-card">
      <div className="mb-1.5 flex items-baseline justify-between gap-3 px-1">
        <SectionLabel>What you may quote today</SectionLabel>
        <span className="text-xs text-muted-foreground">{market ?? "all markets"}, {day}</span>
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {offers.map((offer) => (
          <div key={offer.id} className="px-4 py-3" data-testid={`offer-${offer.id}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-bold text-foreground">{offer.name}</div>
                <div className="text-xs text-muted-foreground">
                  {offer.downloadMbps} Mbps down, {offer.uploadMbps} Mbps up
                  {offer.termMonths === 0 ? ", no term" : `, ${offer.termMonths} month term`}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-base font-bold tabular-nums leading-none text-foreground">
                  {centsToUsd(effectivePriceCents(offer))}
                </div>
                <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">per month</div>
              </div>
            </div>
            <ul className="mt-2 space-y-1">
              {requiredDisclosures(offer).map((d, i) => (
                <li key={i} className="text-[11px] leading-snug text-muted-foreground">{d}</li>
              ))}
            </ul>
            {offer.effectiveTo && (
              <p className="mt-1.5 text-[11px] font-semibold text-warning">
                Quotable until {offer.effectiveTo}.
              </p>
            )}
          </div>
        ))}
      </div>
      {expired.length > 0 && (
        <p className="mt-1.5 px-1 text-[11px] text-muted-foreground" data-testid="offer-expired-note">
          {expired.length} offer{expired.length === 1 ? "" : "s"} expired and can no longer be quoted.
        </p>
      )}
    </div>
  );
}
