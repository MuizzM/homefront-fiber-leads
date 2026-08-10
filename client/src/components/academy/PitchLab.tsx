// ── Pitch Lab ─────────────────────────────────────────────────────────────────
//
// A rep assembles their own pitch from approved blocks, sees it checked against
// structure, time and the live offer catalog, and rehearses it out loud.
//
// THE CHECK IS THE PRODUCT
//   Anyone can list blocks. What makes this worth opening is that it tells a rep
//   their pitch is fifty-two seconds long, or that they pitch before they ask,
//   or that the price block cannot render because their market has no live
//   offer. Those are the three mistakes that actually happen.
//
// PRICES COME FROM THE MARKET, NOT THE BLOCK
//   Blocks that quote a figure carry a token. It resolves against the market's
//   headline offer for today. Where the market has nothing live, the token stays
//   visible and the block is flagged rather than silently rendering a blank,
//   because a blank where a price should be is how an unsupported number gets
//   invented on a porch.

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Chip, Panel, PrimaryButton, QuietButton, WordingLadderCard } from "./primitives";
import { useActivityAutosave } from "@/lib/useAcademy";
import {
  BLOCK_CATEGORIES, CATEGORY_HINTS, CATEGORY_LABELS, PITCH_SECONDS_BUDGET,
  blocksIn, getPitchBlock, renderBlock, reviewPitch,
  type BlockCategory, type PitchBlock,
} from "@shared/academyPitchBlocks";
import { requiredDisclosures, type AcademyOffer } from "@shared/academyOffers";

export type PitchLabState = { blockIds: string[] };

export default function PitchLab({
  activityId, resume, offer, onComplete, onRehearse,
}: {
  activityId: string | null;
  resume: PitchLabState | null;
  /** The market's headline offer, or null when nothing is live. */
  offer: AcademyOffer | null;
  onComplete?: (score: number) => void;
  /** Opens the recorder with the assembled script. */
  onRehearse?: (script: string) => void;
}) {
  const [blockIds, setBlockIds] = useState<string[]>(resume?.blockIds ?? []);
  const [openCategory, setOpenCategory] = useState<BlockCategory | null>("introduction");
  const [inspecting, setInspecting] = useState<PitchBlock | null>(null);

  useActivityAutosave(activityId, { blockIds }, !!activityId);

  const review = useMemo(() => reviewPitch({ blockIds }, offer), [blockIds, offer]);
  const chosen = blockIds.map((id) => getPitchBlock(id)).filter((b): b is PitchBlock => !!b);
  const script = chosen.map((b) => renderBlock(b, offer).text).join(" ");

  // A pitch's readiness is the score: structurally sound and inside the time
  // budget is 100, and each structural problem costs 20. There is no partial
  // credit for a pitch with no close, because a pitch with no close is not one.
  const score = Math.max(0, 100 - review.problems.length * 20);

  function add(block: PitchBlock) {
    setBlockIds((prev) => [...prev, block.id]);
    setInspecting(null);
  }
  function removeAt(index: number) {
    setBlockIds((prev) => prev.filter((_, i) => i !== index));
  }
  function move(index: number, direction: -1 | 1) {
    setBlockIds((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <div className="space-y-4" data-testid="pitch-lab">
      {/* No live offer is a real state and it is stated first, because every
          price block below is unquotable until a supervisor fixes it. */}
      {!offer && (
        <Panel tone="warn" testId="pitch-lab-no-offer">
          <SectionLabel className="text-warning">No live offer in this market</SectionLabel>
          <p className="mt-1 text-[13px] leading-relaxed text-foreground">
            Nothing is configured to quote here today, so blocks that carry a price or a speed cannot be filled in. You
            can still build the shape of your pitch. Ask your supervisor to set the market's offer card.
          </p>
        </Panel>
      )}

      {/* Your pitch, in speaking order. */}
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3 px-1">
          <SectionLabel>Your pitch</SectionLabel>
          <span
            className={cn(
              "text-xs font-semibold tabular-nums",
              review.seconds > PITCH_SECONDS_BUDGET ? "text-warning" : "text-muted-foreground",
            )}
            data-testid="pitch-lab-seconds"
          >
            about {review.seconds}s
          </span>
        </div>

        {chosen.length === 0 ? (
          <Panel testId="pitch-lab-empty">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Nothing added yet. Start with an introduction, then a discovery question, then the one benefit this
              household would actually feel, then an ask.
            </p>
          </Panel>
        ) : (
          <ol className="space-y-2" data-testid="pitch-lab-blocks">
            {chosen.map((block, i) => {
              const rendered = renderBlock(block, offer);
              return (
                <li key={`${block.id}-${i}`} className="rounded-2xl border border-border bg-card p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <Chip tone="neutral">{CATEGORY_LABELS[block.category]}</Chip>
                    <div className="flex shrink-0 gap-1">
                      <IconAction label={`Move ${block.label} earlier`} onClick={() => move(i, -1)} disabled={i === 0} glyph="↑" testId={`pitch-up-${i}`} />
                      <IconAction label={`Move ${block.label} later`} onClick={() => move(i, 1)} disabled={i === chosen.length - 1} glyph="↓" testId={`pitch-down-${i}`} />
                      <IconAction label={`Remove ${block.label}`} onClick={() => removeAt(i)} glyph="×" testId={`pitch-remove-${i}`} />
                    </div>
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-foreground">{rendered.text}</p>
                  {rendered.unresolved.length > 0 && (
                    <p className="mt-1.5 text-[11px] leading-snug text-warning">
                      This block needs a live price or speed for your market. Do not say it until that is configured.
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* The check. */}
      {chosen.length > 0 && (
        <Panel tone={review.ready ? "accent" : "plain"} testId="pitch-lab-review">
          <SectionLabel className={review.ready ? "text-primary" : undefined}>
            {review.ready ? "This one holds up" : "Fix these first"}
          </SectionLabel>
          {review.problems.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {review.problems.map((p, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-foreground">
                  <span aria-hidden="true" className="mt-0.5 shrink-0 text-warning">!</span>
                  <span className="min-w-0 flex-1">{p}</span>
                </li>
              ))}
            </ul>
          )}
          {review.strengths.length > 0 && (
            <ul className={cn("space-y-1.5", review.problems.length > 0 && "mt-3")}>
              {review.strengths.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-muted-foreground">
                  <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                  <span className="min-w-0 flex-1">{s}</span>
                </li>
              ))}
            </ul>
          )}
          {review.signals.length > 0 && (
            <div className="mt-3">
              <SectionLabel>This pitch lands on</SectionLabel>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {review.signals.slice(0, 8).map((s) => <Chip key={s} tone="info">{s.replace(/_/g, " ")}</Chip>)}
              </div>
            </div>
          )}
        </Panel>
      )}

      {/* Disclosures ride with the pitch, never behind a link. */}
      {offer && chosen.some((b) => b.needsOffer) && (
        <Panel testId="pitch-lab-disclosures">
          <SectionLabel>Say these with the price</SectionLabel>
          <ul className="mt-2 space-y-1.5">
            {requiredDisclosures(offer).map((d, i) => (
              <li key={i} className="text-xs leading-relaxed text-muted-foreground">{d}</li>
            ))}
          </ul>
        </Panel>
      )}

      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {onRehearse && (
            <PrimaryButton onClick={() => onRehearse(script)} testId="pitch-lab-rehearse">Rehearse it out loud</PrimaryButton>
          )}
          {onComplete && (
            <QuietButton onClick={() => onComplete(score)} testId="pitch-lab-save">Save this pitch</QuietButton>
          )}
          <QuietButton onClick={() => setBlockIds([])} testId="pitch-lab-clear">Start over</QuietButton>
        </div>
      )}

      {/* The block library, one category at a time. */}
      <div className="space-y-2" data-testid="pitch-lab-library">
        <SectionLabel className="px-1">Approved blocks</SectionLabel>
        {BLOCK_CATEGORIES.map((category) => {
          const open = openCategory === category;
          const items = blocksIn(category);
          return (
            <div key={category} className="overflow-hidden rounded-2xl border border-border bg-card">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpenCategory(open ? null : category)}
                data-testid={`pitch-category-${category}`}
                className={cn(
                  "flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/50",
                  FOCUS,
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-foreground">{CATEGORY_LABELS[category]}</span>
                  <span className="block text-xs leading-snug text-muted-foreground">{CATEGORY_HINTS[category]}</span>
                </span>
                <span aria-hidden="true" className="shrink-0 text-muted-foreground">{open ? "−" : "+"}</span>
              </button>
              {open && (
                <div className="divide-y divide-border border-t border-border">
                  {items.map((block) => (
                    <div key={block.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold text-foreground">{block.label}</div>
                          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{block.whenToUse}</p>
                        </div>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{block.seconds}s</span>
                      </div>
                      <p className="mt-2 text-[13px] leading-relaxed text-foreground">{renderBlock(block, offer).text}</p>
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        <QuietButton onClick={() => add(block)} testId={`pitch-add-${block.id}`}>Add to my pitch</QuietButton>
                        <QuietButton
                          onClick={() => setInspecting(inspecting?.id === block.id ? null : block)}
                          pressed={inspecting?.id === block.id}
                          testId={`pitch-compare-${block.id}`}
                        >
                          Weak, better, excellent
                        </QuietButton>
                      </div>
                      {inspecting?.id === block.id && (
                        <div className="mt-3">
                          <WordingLadderCard ladder={block.ladder} testId={`pitch-ladder-${block.id}`} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A small square action. Labelled for screen readers, glyph for sighted use,
 *  and still 44px of touch target through the padded hit area. */
function IconAction({ label, onClick, glyph, disabled, testId }: {
  label: string;
  onClick: () => void;
  glyph: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      data-testid={testId}
      className={cn(
        "grid h-11 w-11 place-items-center rounded-lg text-sm font-bold text-muted-foreground",
        "transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-35",
        FOCUS,
      )}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}
