// ── Areas — the index into the Area Console ───────────────────────────────────
//
// One card per area, sorted the way a manager triages: the ground somebody is
// walking first, the pool after it. Each card carries only what decides whether
// you open it — who holds it, how far through it is, and what it has produced.
//
// The whole page is ONE request: GET /api/territories/progress already returns
// a stats row for every area the caller may see (server-scoped), so there is no
// second fetch and no client-side maths. Percentages are printed exactly as the
// server computed them against availableBase (shared/territoryMetrics.ts).

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, Search, Trash2, X } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { can } from "@shared/permissions";
import { AreaDeleteDialog, type AreaDeleteTarget } from "@/components/AreaDeleteDialog";
import { FOCUS } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { PageHeader, SectionLabel } from "@/components/ui/page-scaffold";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { repColorOf } from "@shared/repColors";
import { shortDate } from "@shared/territoryLabel";
import {
  AREA_STATUS_FILTERS, areaHolders, areaStatusMeta, isPoolArea, type AreaProgressRow,
} from "@/lib/areaProgress";

const CHIP = "text-[10px] font-bold uppercase tracking-[0.09em] rounded-full px-2.5 py-1";

export default function Areas() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("all");
  const { user } = useAuth();
  // Admin-only, matching the API. A team lead sees no delete affordance at all
  // rather than one that 403s — an action you are offered and then refused is
  // worse than one that was never there.
  const canDelete = can(user?.role, "delete_territory");
  const [pendingDelete, setPendingDelete] = useState<AreaDeleteTarget | null>(null);

  const { data, isLoading, isError } = useQuery<AreaProgressRow[]>({
    queryKey: ["/api/territories/progress"],
  });

  const rows = useMemo(() => {
    const all = data ?? [];
    const needle = query.trim().toLowerCase();
    const filtered = all.filter(row => {
      if (status !== "all" && String(row.status) !== status) return false;
      if (!needle) return true;
      return String(row.name ?? "").toLowerCase().includes(needle);
    });
    // Held ground first (it is the ground being worked right now), then by the
    // most recent activity, then by name so the order never shuffles.
    return [...filtered].sort((a, b) =>
      Number(isPoolArea(a)) - Number(isPoolArea(b))
      || String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? ""))
      || String(a.name ?? "").localeCompare(String(b.name ?? "")));
  }, [data, query, status]);

  const total = data?.length ?? 0;

  // ── The portfolio, above the grid ─────────────────────────────────────────
  // Every card already answers "how far through is THIS area". Nothing
  // answered "how far through are we", which is the question a manager opens
  // this screen with - and the one they were doing in their head across a
  // dozen cards. Stake's Manage screen (via Mobbin) is the shape: the total
  // first, its composition underneath.
  //
  // Computed from the ROWS ON SCREEN rather than every area that exists, so
  // the total always agrees with the cards below it. A rollup that quietly
  // ignored the filter would print a number you cannot count.
  const roll = useMemo(() => {
    let doors = 0, knocked = 0, sold = 0, unassigned = 0;
    for (const row of rows) {
      doors += Number(row.total) || 0;
      knocked += Number(row.knocked) || 0;
      sold += Number(row.sold) || 0;
      if (isPoolArea(row)) unassigned += 1;
    }
    // Clamped for the same reason the card bar is: repeat passes can push the
    // count past the available base, and a 109% bar reads as a bug.
    const covered = doors > 0 ? Math.min(100, Math.round((knocked / doors) * 100)) : 0;
    return { doors, knocked, sold, unassigned, covered, remaining: Math.max(0, doors - knocked) };
  }, [rows]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-4 pt-5 pb-24 md:p-6" data-testid="areas-page">
      <PageHeader
        title="Areas"
        icon={LayoutGrid}
        subtitle="Every area you can see, with who holds it and how far through it is."
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search areas"
            aria-label="Search areas by name"
            data-testid="areas-search"
            className={cn("h-11 w-full rounded-xl border border-border bg-card pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground", FOCUS)}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              data-testid="areas-search-clear"
              onClick={() => setQuery("")}
              className={cn("absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground", FOCUS)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        <select
          value={status}
          onChange={e => setStatus(e.target.value)}
          aria-label="Filter areas by status"
          data-testid="areas-status-filter"
          className={cn("h-11 rounded-xl border border-border bg-card px-3 text-sm text-foreground", FOCUS)}
        >
          <option value="all">All statuses</option>
          {AREA_STATUS_FILTERS.map(s => (
            <option key={s} value={s}>{areaStatusMeta(s).label}</option>
          ))}
        </select>
      </div>

      {!isLoading && !isError && rows.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-4" data-testid="areas-rollup">
          <SectionLabel>{status === "all" && !query.trim() ? "All areas" : "Matching areas"}</SectionLabel>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-3xl font-bold tabular-nums leading-none tracking-tight text-primary"
                  data-testid="areas-rollup-doors">
              {roll.doors.toLocaleString()}
            </span>
            <span className="text-[13px] font-medium text-muted-foreground">doors</span>
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground"
                    data-testid="areas-rollup-knocked">
                {roll.knocked.toLocaleString()} knocked
              </span>
              <span className="inline-flex items-center rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-success"
                    data-testid="areas-rollup-sold">
                {roll.sold.toLocaleString()} sold
              </span>
              {roll.unassigned > 0 && (
                <span className="inline-flex items-center rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-warning"
                      data-testid="areas-rollup-unassigned">
                  {roll.unassigned} unassigned
                </span>
              )}
            </span>
          </div>

          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-secondary"
               role="progressbar" aria-valuenow={roll.covered} aria-valuemin={0} aria-valuemax={100}
               aria-label={`${roll.covered}% of available doors knocked across these areas`}>
            <div className="h-full rounded-full bg-primary transition-[width] duration-500"
                 style={{ width: `${roll.covered}%` }} />
          </div>
          {/* "of ALL doors" on purpose. A card's bar is measured against
              AVAILABLE doors (the server's knockCompletionRate, which excludes
              some), so a bare "67%" here next to a card reading "83%" is two
              similar-looking percentages with different denominators - the
              second number nobody trusts. Naming the basis, and printing the
              counts that produced it, makes the two readable together. */}
          <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="areas-rollup-coverage">
            {roll.covered >= 100
              ? `All ${roll.doors.toLocaleString()} doors knocked`
              : `${roll.knocked.toLocaleString()} of ${roll.doors.toLocaleString()} doors knocked (${roll.covered}%) · ${roll.remaining.toLocaleString()} left`}
          </p>
        </section>
      )}

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="areas-loading">
          {[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-40 rounded-2xl" />)}
        </div>
      ) : isError ? (
        <div role="alert" className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-foreground" data-testid="areas-error">
          Couldn't load your areas. Check your connection and try again.
        </div>
      ) : total === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title="No areas yet"
          description="Areas are drawn on the Field Map. Draw one there and it shows up here with its numbers."
          action={
            <Link href="/map" className={cn("text-sm font-semibold text-primary underline underline-offset-4", FOCUS)}>
              Open the Field Map
            </Link>
          }
          testId="areas-empty"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Search}
          bordered
          title="No areas match"
          description="Nothing here fits that name and status. Clear the filters to see all of them again."
          testId="areas-no-match"
        />
      ) : (
        <>
          <div data-testid="areas-count">
            <SectionLabel>{rows.length} of {total} {total === 1 ? "area" : "areas"}</SectionLabel>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="areas-grid">
            {rows.map(row => (
              <AreaCard key={row.id} row={row}
                onDelete={canDelete ? () => setPendingDelete({
                  id: row.id, name: String(row.name ?? "this area"),
                  total: Number(row.total) || 0, sold: Number(row.sold) || 0,
                  repName: isPoolArea(row) ? null : row.repName,
                }) : undefined} />
            ))}
          </div>
        </>
      )}

      <AreaDeleteDialog
        target={pendingDelete}
        open={pendingDelete != null}
        onOpenChange={open => { if (!open) setPendingDelete(null); }}
        onDeleted={() => setPendingDelete(null)}
      />
    </div>
  );
}

function AreaCard({ row, onDelete }: { row: AreaProgressRow; onDelete?: () => void }) {
  const meta = areaStatusMeta(row.status);
  const pool = isPoolArea(row);
  // The card used to print one name for ground that can be walked by a crew, so
  // a two-rep area read as one rep's. Two names fit; past that it counts.
  const holders = areaHolders(row);
  const crew = holders.length > 2
    ? `${holders[0].name} +${holders.length - 1}`
    : holders.map(h => h.name).join(" · ");
  const dot = row.color || repColorOf({ id: row.repId, color: null });
  // Straight off the wire: knocked / available doors, already computed once,
  // server-side, against the one denominator.
  const covered = Math.max(0, Math.min(100, Number(row.knockCompletionRate) || 0));

  return (
    // The delete control is a SIBLING of the Link, not a child: a <button>
    // nested in an <a> is invalid HTML and breaks keyboard activation — the
    // Enter key would follow the link instead of opening the dialog.
    <div className="relative">
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${row.name}`}
          data-testid={`area-card-${row.id}-delete`}
          className={cn(
            "absolute right-2 top-2 z-10 grid h-9 w-9 place-items-center rounded-xl",
            "text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive",
            FOCUS,
          )}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    <Link
      href={`/areas/${row.id}`}
      data-testid={`area-card-${row.id}`}
      className={cn(
        "block rounded-2xl border border-border bg-card p-4 transition-colors hover:bg-secondary/40",
        FOCUS,
      )}
    >
      {/* pr clears the absolutely-positioned delete button — without it the
          status chip renders UNDER the trash icon on narrow screens. */}
      <div className={cn("flex items-start gap-2.5", onDelete && "pr-9")}>
        <span
          aria-hidden="true"
          className="mt-1 h-3 w-3 shrink-0 rounded-full border border-foreground/10"
          style={{ backgroundColor: dot }}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold text-foreground">{row.name}</div>
          <div
            className="truncate text-[13px] text-muted-foreground"
            data-testid={`area-card-${row.id}-rep`}
            title={holders.length > 2 ? holders.map(h => h.name).join(", ") : undefined}
          >
            {/* The chip already says UNASSIGNED; repeating it here wastes the
                line. Pool cards only ever render for team_lead+ (server scope),
                and the console they open leads with Assign — so say that. */}
            {pool ? "In the pool · open to assign" : crew || row.repName}
          </div>
        </div>
        <span className={cn(CHIP, meta.chip, "shrink-0")}>{meta.label}</span>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <CardStat label="Doors" value={row.total} />
        <CardStat label="Knocked" value={row.knocked} />
        {/* Sold is the number a manager triages by — the one quiet tint on the
            card, so the eye lands there first without the card shouting. */}
        <CardStat label="Sold" value={row.sold} emphasis />
      </dl>

      <div
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-valuenow={Math.round(covered)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${row.name} knocked ${covered}% of available doors`}
      >
        <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${covered}%` }} />
      </div>
      {/* The label must agree with the bar. The raw rate can exceed 100 (repeat
          passes count against the same available base), and "109.24%" on a card
          reads as a bug, not as diligence. Clamp to the same value the bar
          draws, drop the false-precision decimals, and let a finished area say
          so in words. The exact rate stays on the title attr for anyone who
          hovers to check the maths. */}
      <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span title={`${row.knockCompletionRate}% exact`}>
          {covered >= 100
            ? "All available doors knocked"
            : <><span className="tabular-nums">{Math.round(covered)}%</span> of available doors knocked</>}
        </span>
        <span>{shortDate(row.lastActivityAt) ?? "no activity"}</span>
      </div>
    </Link>
    </div>
  );
}

function CardStat({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className={cn("rounded-xl py-1.5", emphasis ? "bg-primary/10" : "bg-secondary/50")}>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-base font-bold leading-tight tabular-nums text-foreground">{value.toLocaleString()}</dd>
    </div>
  );
}
