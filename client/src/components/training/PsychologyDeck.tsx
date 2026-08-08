// ── Door psychology, as a flip deck ──────────────────────────────────────────
// Eight behavioral principles a rep can actually use between two doorbells.
// Front of the card is the hook; the flip is the payoff — what to say and why
// it works. Flipping is the interaction: curiosity does the teaching, the same
// mechanic every flashcard app rides on. Whole-card <button>, aria-pressed for
// the flipped state, so keyboard and screen-reader users get the same deck.
import { useState } from "react";
import {
  Gift, Users, TrendingDown, Footprints, Dice5, Timer, Tag, Sparkles, RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";

interface PsychTip {
  id: string;
  icon: typeof Gift;
  principle: string;
  hook: string;        // front — one line that earns the flip
  atTheDoor: string;   // back — the words to use
  why: string;         // back — the mechanism, one breath long
}

const TIPS: readonly PsychTip[] = [
  {
    id: "reciprocity",
    icon: Gift,
    principle: "Reciprocity",
    hook: "Give something first. Even thirty seconds of useful information counts.",
    atTheDoor: "“Before anything else — the construction on your street? That's fiber conduit. Here's what that means for your address.”",
    why: "People repay value with attention. Lead with a fact they didn't have, and listening back feels owed, not granted.",
  },
  {
    id: "social-proof",
    icon: Users,
    principle: "Social proof",
    hook: "Nobody wants to be first. Everybody wants to be next.",
    atTheDoor: "“I just set up the Hendersons two doors down — same install window, if you want it.”",
    why: "Uncertainty makes people copy their neighbors. Name real nearby installs. Proximity is the proof; the street sells the street.",
  },
  {
    id: "loss-aversion",
    icon: TrendingDown,
    principle: "Loss aversion",
    hook: "Losing $20 stings roughly twice as hard as winning $20 feels good.",
    atTheDoor: "“You're paying for copper speeds fiber left behind — every month at the old price is money already spent.”",
    why: "Frame the status quo as the cost. People move faster to stop a leak than to chase a gain. The math is identical; the feeling isn't.",
  },
  {
    id: "foot-in-door",
    icon: Footprints,
    principle: "Consistency",
    hook: "A small yes is a down payment on a bigger one.",
    atTheDoor: "“Would you at least want to know what speeds your address qualifies for? Takes ten seconds to check.”",
    why: "Once someone agrees to the check, staying for the answer is just being consistent with who they decided to be ten seconds ago.",
  },
  {
    id: "numbers-game",
    icon: Dice5,
    principle: "Rejection is data",
    hook: "The nos aren't failures. They're the price sheet for the yeses.",
    atTheDoor: "After a hard no: log it, note the objection, take one breath, then next door. That's the whole ritual.",
    why: "Conversion is a rate, not a verdict. At field-average rates every knock has the same expected value before the door opens. Volume is the strategy; mood is noise.",
  },
  {
    id: "first-frame",
    icon: Timer,
    principle: "The 3-second frame",
    hook: "The door decides in three seconds, before your pitch starts.",
    atTheDoor: "Step back off the porch after you knock, hands visible, smile before the door moves. Open with their street, not your company.",
    why: "First impressions are a threat assessment, not a product review. Lower the threat and the brain frees up to actually hear you.",
  },
  {
    id: "labeling",
    icon: Tag,
    principle: "Labeling",
    hook: "Tell people who they are, kindly, and they'll act like it.",
    atTheDoor: "“You seem like someone who does the homework before switching anything — so here are the actual numbers.”",
    why: "Handed a flattering identity, people perform it. A “homework” person now has to look at your numbers. That's the label doing the work.",
  },
  {
    id: "peak-end",
    icon: Sparkles,
    principle: "Peak-end rule",
    hook: "People remember the peak and the ending, and almost nothing else.",
    atTheDoor: "Whatever the answer, end warm: “Either way — the conduit work wraps this month, so you'll have options. Good talking with you.”",
    why: "Today's no is remembered by its last five seconds. End generous and the callback knock starts from warmth, not from a slammed door.",
  },
];

function FlipCard({ tip, flipped, onFlip }: { tip: PsychTip; flipped: boolean; onFlip: () => void }) {
  const Icon = tip.icon;
  // Faces are STACKED IN ONE GRID CELL, not absolutely positioned — the card
  // grows to whichever face is taller, so the back never needs an inner scroll
  // region a keyboard could not reach. The face turned away is aria-hidden:
  // without that, screen readers read both sides at once and the flip changes
  // nothing in the accessibility tree.
  return (
    <div className="hf-flip-scene h-full">
      <button
        type="button"
        aria-pressed={flipped}
        onClick={onFlip}
        data-testid={`psych-card-${tip.id}`}
        className={cn("hf-flip-inner grid h-full min-h-44 w-full rounded-2xl text-left", FOCUS, flipped && "is-flipped")}
      >
        {/* Front — principle + hook */}
        <span
          aria-hidden={flipped}
          className="hf-flip-face [grid-area:1/1] flex flex-col rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/40"
        >
          <span className="flex items-center gap-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="text-[13px] font-bold tracking-tight text-foreground">{tip.principle}</span>
          </span>
          <span className="mt-3 flex-1 text-sm leading-snug text-muted-foreground">{tip.hook}</span>
          <span className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
            <RotateCcw className="h-3 w-3" aria-hidden="true" /> Flip for the move
          </span>
        </span>
        {/* Back — the words, then the why */}
        <span
          aria-hidden={!flipped}
          className="hf-flip-face hf-flip-back [grid-area:1/1] flex flex-col rounded-2xl border border-primary/30 bg-primary/[0.07] p-4"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">At the door</span>
          <span className="mt-1.5 text-[13px] font-medium leading-snug text-foreground">{tip.atTheDoor}</span>
          <span className="mt-2.5 text-xs leading-relaxed text-muted-foreground">{tip.why}</span>
        </span>
      </button>
    </div>
  );
}

export default function PsychologyDeck() {
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const explored = flipped.size;
  const allExplored = explored >= TIPS.length;

  function toggle(id: string) {
    setFlipped(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-4 md:p-5" data-testid="psychology-deck">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <SectionLabel>Door psychology</SectionLabel>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Eight moves borrowed from behavioral science — tap a card, get the words.
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums",
            allExplored ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-secondary text-muted-foreground",
          )}
          data-testid="psych-deck-progress"
        >
          {allExplored ? "Deck explored, nice" : `${explored} of ${TIPS.length} flipped`}
        </span>
      </div>
      <div className="hf-stagger mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TIPS.map(tip => (
          <FlipCard key={tip.id} tip={tip} flipped={flipped.has(tip.id)} onFlip={() => toggle(tip.id)} />
        ))}
      </div>
    </div>
  );
}
