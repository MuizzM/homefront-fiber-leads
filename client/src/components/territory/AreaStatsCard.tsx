// The numbers on an area, arranged so the operational one wins.
//
// The old block was a flat grid: every figure the same size, the same weight,
// in whatever order the fields happened to be declared. Nine equal numbers is a
// spreadsheet, and a manager scanning twenty areas has to read all nine to learn
// the one thing they came for — how much of this ground is left.
//
// Hierarchy borrowed from shipped patterns, not invented:
//
//   * Fi — one big number with its unit, a COMPACT ring beside it rather than a
//     dashboard centrepiece, secondary figures on a divided row below. The ring
//     is a garnish on the number, not a competitor to it.
//   * Blinkist — the ring carries `done / total` inside it, so the percentage
//     never floats free of what it is a percentage of.
//   * Tonal — an ⓘ next to a derived metric, because "penetration" means
//     nothing until you know its denominator.
//   * Apple Fitness — a muted TRACK ring under the progress arc. At 0% this is
//     the whole design: without a track, an empty ring reads as a component
//     that failed to render. Real areas sit at 0 for their first week.
//
// Every rate here divides by availableBase (total − unavailable − disqualified),
// the single denominator defined in shared/territoryMetrics. The tooltips say so
// on screen, because a number nobody can reproduce is a number nobody trusts.

import { useId, useState } from "react";

export interface AreaStatsCardProps {
  /** Doors inside the boundary, before any exclusions. */
  total: number;
  /** total − unavailable − disqualified. The denominator for every rate. */
  availableBase?: number;
  knocked?: number;
  sold?: number;
  untouched?: number;
  /** Percentages, 0–100. */
  penetrationRate?: number;
  knockCompletionRate?: number;
  contactRate?: number;
  /** Ring + hero colour. The AREA's colour, so the card matches its polygon. */
  color: string;
}

const RING_SIZE = 72;
const RING_STROKE = 7;
const RADIUS = (RING_SIZE - RING_STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 0 when absent or not a number — never NaN, never "—" where a count belongs. */
function num(v: number | undefined | null): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** One decimal, but no trailing ".0" — "42%" reads better than "42.0%", and
 *  "0.4%" must not collapse to "0%" or a week of work disappears. */
function pct(v: number | undefined | null): string {
  const n = Math.max(0, Math.min(100, num(v)));
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

function Info({ label, formula }: { label: string; formula: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        aria-label={`How ${label} is calculated`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        data-testid={`stat-info-${label.toLowerCase().replace(/\s+/g, "-")}`}
        className="ml-1 flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-bold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        ⓘ
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute bottom-full left-1/2 z-20 mb-1 w-44 -translate-x-1/2 rounded-lg border border-border bg-popover px-2 py-1.5 text-[10px] leading-snug text-popover-foreground shadow-lg"
        >
          {formula}
        </span>
      )}
    </span>
  );
}

const DENOM = "of available doors (total minus unavailable and disqualified)";

export function AreaStatsCard({
  total,
  availableBase,
  knocked,
  sold,
  untouched,
  penetrationRate,
  knockCompletionRate,
  contactRate,
  color,
}: AreaStatsCardProps) {
  const base = num(availableBase) || num(total);
  const done = num(knocked);
  const completion = Math.max(0, Math.min(100, num(knockCompletionRate)));
  const offset = CIRCUMFERENCE * (1 - completion / 100);

  return (
    <div data-testid="area-stats" className="mt-3 rounded-xl border border-border bg-secondary/40 p-3">
      <div className="flex items-center gap-3">
        {/* Hero: doors worked. The number a manager came for. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span data-testid="stat-knocked" className="text-2xl font-bold leading-none text-foreground">
              {done.toLocaleString()}
            </span>
            <span className="text-[11px] font-medium text-muted-foreground">
              of {base.toLocaleString()} worked
            </span>
          </div>
          <div className="mt-1 flex items-center text-[10px] uppercase tracking-wide text-muted-foreground">
            Completion
            <Info label="completion" formula={`Doors knocked ÷ ${DENOM}.`} />
          </div>
        </div>

        {/* Compact ring. The muted track is load-bearing: at 0% it is the only
            thing on screen, and it has to look deliberate. */}
        <svg
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          className="flex-shrink-0 -rotate-90"
          role="img"
          aria-label={`${pct(completion)} complete`}
          data-testid="stat-ring"
        >
          <circle
            cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RADIUS}
            fill="none" stroke={color} strokeWidth={RING_STROKE}
            className="opacity-20" data-testid="stat-ring-track"
          />
          {completion > 0 && (
            <circle
              cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RADIUS}
              fill="none" stroke={color} strokeWidth={RING_STROKE} strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE} strokeDashoffset={offset}
              data-testid="stat-ring-arc"
            />
          )}
          <text
            x="50%" y="50%" dominantBaseline="central" textAnchor="middle"
            transform={`rotate(90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
            className="fill-foreground text-[13px] font-bold"
          >
            {pct(completion)}
          </text>
        </svg>
      </div>

      {/* Secondary row, divided rather than boxed — three tiles of chrome around
          three small numbers is more border than content at this width. */}
      <div className="mt-3 grid grid-cols-3 divide-x divide-border border-t border-border pt-2.5 text-center">
        <div>
          <div data-testid="stat-sold" className="text-sm font-bold text-emerald-400">
            {num(sold).toLocaleString()}
          </div>
          <div className="text-[9.5px] uppercase tracking-wide text-muted-foreground">Sold</div>
        </div>
        <div>
          <div data-testid="stat-penetration" className="text-sm font-bold text-foreground">
            {pct(penetrationRate)}
          </div>
          <div className="flex items-center justify-center text-[9.5px] uppercase tracking-wide text-muted-foreground">
            Penetration
            <Info label="penetration" formula={`Sales ÷ ${DENOM}.`} />
          </div>
        </div>
        <div>
          <div data-testid="stat-untouched" className="text-sm font-bold text-foreground">
            {num(untouched).toLocaleString()}
          </div>
          <div className="text-[9.5px] uppercase tracking-wide text-muted-foreground">Untouched</div>
        </div>
      </div>

      {contactRate != null && (
        <div className="mt-2 flex items-center justify-center text-[10px] text-muted-foreground">
          <span data-testid="stat-contact">{pct(contactRate)} contact rate</span>
          <Info label="contact rate" formula={`Doors that reached a person ÷ ${DENOM}.`} />
        </div>
      )}
    </div>
  );
}
