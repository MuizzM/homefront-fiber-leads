// ── The numbers game, made touchable ─────────────────────────────────────────
// One slider — doors per day — and the whole funnel recomputes live against the
// REAL retroactive ladder from shared/commissionTiers, the same math the pay
// engine runs. That identity is the lesson: motivation here isn't a poster, it's
// arithmetic the rep can drag. The headline is the weekly number; the quiet
// killer is $/knock — every knock carries the same expected value BEFORE the
// door opens, which is what "the nos are part of the price" actually means.
//
// Rates are field averages, labeled as such — the point is the shape of the
// funnel, not false precision.
import { useEffect, useRef, useState } from "react";
import { DoorOpen, MessageCircle, Presentation, Handshake } from "lucide-react";
import { SectionLabel } from "@/components/ui/page-scaffold";
import {
  calculateRetroactiveCommission, DEFAULT_RETRO_TIERS, formatUsdCents, tierProgressMessage,
} from "@shared/commissionTiers";

// Field-average funnel: answer → real conversation → pitch heard → close.
const ANSWER_RATE = 0.35;
const CONVO_RATE = 0.5;
const CLOSE_RATE = 0.12;
const DAYS_PER_WEEK = 5;

/** Count-up that respects reduced motion — lands on the value instantly there.
 *  Each animation starts from the value currently ON SCREEN (shownRef), so a
 *  retarget mid-flight continues forward instead of snapping back to a stale
 *  start, and a reversal to the original target still settles exactly on it. */
function useCountUp(target: number, ms = 380): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    const commit = (value: number) => { shownRef.current = value; setShown(value); };
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      commit(target);
      return;
    }
    const from = shownRef.current;
    if (from === target) {
      commit(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      commit(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return shown;
}

function FunnelStat({ label, value, sub }: { icon: typeof DoorOpen; label: string; value: number; sub: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl border border-border bg-background px-2 py-2.5 text-center">
      
      <span className="text-base font-bold tabular-nums leading-none text-foreground">{value}</span>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-[10px] tabular-nums text-muted-foreground/70">{sub}</span>
    </div>
  );
}

// The funnel, as one function, so the skip-cost line below can run the SAME
// model at a lower volume instead of a linear approximation the retroactive
// ladder would contradict.
function weekAtDoors(doorsPerWeek: number) {
  const conversations = Math.round(doorsPerWeek * ANSWER_RATE);
  const pitches = Math.round(conversations * CONVO_RATE);
  const sales = Math.round(pitches * CLOSE_RATE);
  return { conversations, pitches, sales, retro: calculateRetroactiveCommission(sales, DEFAULT_RETRO_TIERS) };
}

export default function NumbersGame() {
  const [doorsPerDay, setDoorsPerDay] = useState(60);

  const doorsPerWeek = doorsPerDay * DAYS_PER_WEEK;
  const { conversations, pitches, sales, retro } = weekAtDoors(doorsPerWeek);
  const weeklyCents = retro.grossCommissionCents;
  const perKnockCents = doorsPerWeek > 0 ? Math.round(weeklyCents / doorsPerWeek) : 0;
  const shownWeekly = useCountUp(weeklyCents);
  // Honest skip-cost: re-run the funnel at 90% volume and diff. Retroactive
  // ladders make this nonlinear — dropping below a band boundary reprices the
  // whole week, which is exactly the point worth teaching. When the modeled
  // diff is zero, fall back to the expected value the skipped knocks carried.
  const knocksSkipped = Math.round(doorsPerWeek * 0.1);
  const skipDiffCents = weeklyCents - weekAtDoors(doorsPerWeek - knocksSkipped).retro.grossCommissionCents;
  const skipCostCents = skipDiffCents > 0 ? skipDiffCents : perKnockCents * knocksSkipped;

  return (
    <div className="rounded-2xl border border-primary/25 bg-primary/[0.05] p-4 md:p-5" data-testid="numbers-game">
      <div className="flex items-center gap-2">
        
        <SectionLabel className="text-primary">The numbers game</SectionLabel>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-foreground">
        Sales isn't a talent contest. It's a rate times a volume. Drag the slider and watch the week reprice itself.
      </p>

      {/* The headline — one week, on the house ladder, at field-average rates */}
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Projected week</div>
          <div className="text-3xl font-bold tabular-nums tracking-tight text-foreground" data-testid="numbers-game-weekly">
            {formatUsdCents(shownWeekly)}
          </div>
          <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
            ≈ {formatUsdCents(perKnockCents)} per knock, the nos included. That's the whole mindset.
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Ladder band</div>
          <div className="text-sm font-bold tabular-nums text-primary">
            {retro.tierLabel ?? " - "}{retro.rateCents > 0 ? ` · ${formatUsdCents(retro.rateCents)}/sale` : ""}
          </div>
        </div>
      </div>

      {/* The one input */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <label htmlFor="numbers-game-doors" className="text-xs font-semibold text-foreground">
            Doors per day
          </label>
          <span className="text-sm font-bold tabular-nums text-foreground">{doorsPerDay}</span>
        </div>
        <input
          id="numbers-game-doors"
          type="range"
          min={20}
          max={120}
          step={5}
          value={doorsPerDay}
          onChange={e => setDoorsPerDay(Number(e.target.value))}
          className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
          data-testid="numbers-game-slider"
          aria-valuetext={`${doorsPerDay} doors per day`}
        />
        <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground/70">
          <span>20 · a warm-up</span>
          <span>60 · a shift</span>
          <span>120 · a grinder</span>
        </div>
      </div>

      {/* The funnel - where the week actually comes from */}
      <div className="mt-4 flex items-stretch gap-2" role="group" aria-label="Weekly funnel at field-average rates">
        <FunnelStat icon={DoorOpen} label="Knocks" value={doorsPerWeek} sub={`${DAYS_PER_WEEK} days`} />
        <FunnelStat icon={MessageCircle} label="Answers" value={conversations} sub="~35% open" />
        <FunnelStat icon={Presentation} label="Pitches" value={pitches} sub="~50% listen" />
        <FunnelStat icon={Handshake} label="Sales" value={sales} sub="~12% close" />
      </div>

      {/* The behavioral payoff - the ladder nudge in the pay engine's own words */}
      <p className="mt-3 rounded-xl border border-border bg-background px-3 py-2.5 text-xs leading-relaxed text-muted-foreground" data-testid="numbers-game-nudge">
        {tierProgressMessage(retro)}{" "}
        <span className="text-foreground">
          Skipping {knocksSkipped} knocks doesn't save effort. At these rates it spends about{" "}
          <span className="font-semibold tabular-nums">{formatUsdCents(skipCostCents)}</span>.
        </span>
      </p>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/60">
        Field-average rates, house ladder - your live plan and week are on My commission. This is the shape, not a promise.
      </p>
    </div>
  );
}
