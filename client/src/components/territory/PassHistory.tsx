

// Past sweeps of one area, newest first.
//
// This is the visible half of "history doesn't go away": after a reset the pins
// all look fresh, so without this panel a manager has no way to see that the
// area was already worked twice. Each row is one closed pass with what it
// produced, so "should we knock this again?" has an answer on screen.

export interface PassHistoryRow {
  id: number;
  passNumber: number;
  closedAt: string;
  closedByName: string | null;
  territoryAction: string;
  leadsTotal: number;
  leadsReset: number;
  leadsFrozen: number;
  note: string | null;
  stats: {
    knocks: number; doorsAnswered: number; sold: number;
    interested: number; notInterested: number; notHome: number; callbacks: number;
  } | null;
}

export interface PassHistoryProps {
  currentPass: number;
  passes: PassHistoryRow[];
  loading?: boolean;
  error?: string | null;
  /** repId → name, to render who worked each pass when available. */
  teamNames?: Record<number, string>;
}

const ACTION_LABEL: Record<string, string> = {
  keep: "kept the same rep",
  return_to_pool: "returned to the pool",
  reassign: "handed to another rep",
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function PassHistory({ currentPass, passes, loading, error }: PassHistoryProps) {
  if (loading) {
    return <div role="status" className="text-sm text-muted-foreground py-3">Loading pass history…</div>;
  }
  if (error) {
    return <div role="alert" className="text-sm text-destructive py-3">{error}</div>;
  }

  if (!passes.length) {
    return (
      <div className="py-4 text-sm text-muted-foreground space-y-1">
        <div className="flex items-center gap-2 font-medium text-foreground">
          
          First pass in progress
        </div>
        <p>This area hasn't been swept and reset yet. Once you start pass 2, pass 1's results stay here.</p>
      </div>
    );
  }

  return (
    <section aria-label="Pass history" className="space-y-3">
      <header className="flex items-center gap-2 text-sm font-medium">
        
        Pass history
        <span className="text-muted-foreground font-normal">· now on pass {currentPass}</span>
      </header>

      <ol className="space-y-2.5">
        {passes.map(p => (
          <li key={p.id} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <span className="font-medium text-sm">Pass {p.passNumber}</span>
              <span className="text-xs text-muted-foreground">
                closed {when(p.closedAt)}
                {p.closedByName ? ` by ${p.closedByName}` : ""}
              </span>
            </div>

            {p.stats && (
              // Sales lead because that's the number that decides whether the
              // area is worth another sweep.
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <Stat label="sold" value={p.stats.sold} emphasis />
                <Stat label="knocked" value={p.stats.knocks} />
                <Stat label="answered" value={p.stats.doorsAnswered} />
                <Stat label="interested" value={p.stats.interested} />
                <Stat label="not home" value={p.stats.notHome} />
              </div>
            )}

            <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
              <span>{p.leadsReset} re-opened</span>
              {p.leadsFrozen > 0 && (
                <span className="inline-flex items-center gap-1">
                  
                  {p.leadsFrozen} left alone
                </span>
              )}
              <span>{ACTION_LABEL[p.territoryAction] ?? p.territoryAction}</span>
            </div>

            {p.note && <p className="text-xs italic text-muted-foreground">“{p.note}”</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <span className={emphasis && value > 0 ? "font-medium text-foreground" : "text-muted-foreground"}>
      <span className="tabular-nums">{value}</span> {label}
    </span>
  );
}

export default PassHistory;
