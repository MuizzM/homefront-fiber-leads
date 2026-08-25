// RUN A CITY: harvest it from OpenStreetMap, check it, and stop early on the
// streets that have no fiber.
//
// The server side already harvested and checked a whole city; what it did not do
// was stop. A blind run measured 2026-08-24 checked 250 Charlotte doors and got
// 250 unmatched, because that inventory is an OSM address grid over a city
// Kinetic barely serves. The sweep now probes each street first and parks the
// rest of any street that answers with no fiber, so this panel reports what the
// prune saved alongside what the run found.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";

const STATES = ["NC", "SC", "GA", "FL", "IA", "KY"] as const;
type SweepState = (typeof STATES)[number];

export interface SweepJob {
  id: string; kind: string; query: string; city: string | null; state: string | null;
  phase: string; status: string; source: string | null;
  harvested: number; queued: number; checked: number; failed: number;
  freshFound: number; opportunitiesFound: number;
  streetsParked: number; doorsSkipped: number;
  maxChecks: number; error: string | null; startedAt: string; completedAt: string | null;
}

const PHASE_COPY: Record<string, string> = {
  queued: "Queued", harvesting: "Harvesting from OpenStreetMap", checking: "Checking doors",
  complete: "Complete", cancelled: "Cancelled", failed: "Failed",
};

/** Doors actually reached, against everything that was on the list. */
function progressPct(job: SweepJob): number {
  const denominator = job.queued || job.harvested || 0;
  if (!denominator) return 0;
  return Math.min(100, Math.round(((job.checked + job.doorsSkipped) / denominator) * 100));
}

function Stat({ label, value, hint, testId }: { label: string; value: number | string; hint?: string; testId: string }) {
  return (
    <div className="rounded-xl border border-border bg-background px-3 py-2" data-testid={testId}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-foreground">{value}</div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export default function CitySweepRunner() {
  const queryClient = useQueryClient();
  const [city, setCity] = useState("");
  const [state, setState] = useState<SweepState>("NC");
  const [maxChecks, setMaxChecks] = useState(5000);
  const [notice, setNotice] = useState<string | null>(null);

  // GET /api/sweeps answers { sweeps: [...] }, not a bare array.
  const sweeps = useQuery<{ sweeps: SweepJob[] }>({
    queryKey: ["/api/sweeps"],
    queryFn: () => apiRequest("GET", "/api/sweeps?limit=8").then((r) => r.json()),
    // A running sweep moves; a settled list does not need the same attention.
    refetchInterval: (query) =>
      (query.state.data?.sweeps ?? []).some((job) => job.status === "running") ? 3000 : 20000,
    staleTime: 2000,
  });
  const jobs = sweeps.data?.sweeps ?? [];

  const start = useMutation({
    mutationFn: (body: { city: string; state: string; maxChecks: number }) =>
      apiRequest("POST", "/api/sweeps/city", body).then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Could not start the sweep (${r.status})`);
        return r.json();
      }),
    onSuccess: () => { setNotice(null); setCity(""); void queryClient.invalidateQueries({ queryKey: ["/api/sweeps"] }); },
    onError: (error: Error) => setNotice(error.message),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/sweeps/${id}/cancel`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/sweeps"] }),
  });

  const canRun = city.trim().length > 1 && !start.isPending;

  return (
    <section className="space-y-4" data-testid="city-sweep-runner">
      <div className="rounded-2xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Run a city</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          Harvests every address in the city from OpenStreetMap, then checks it. Each street is probed
          first: if the probes come back with no fiber, the rest of that street is parked instead of
          checked. One token and one residential IP serve 20 checks, then both switch.
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex-1 min-w-[180px]">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">City</span>
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canRun) start.mutate({ city: city.trim(), state, maxChecks }); }}
              placeholder="Salisbury"
              className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="city-sweep-city"
            />
          </label>
          <label>
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">State</span>
            <select
              value={state}
              onChange={(e) => setState(e.target.value as SweepState)}
              className="h-10 rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="city-sweep-state"
            >
              {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Max checks</span>
            <input
              type="number" min={1} max={50000} step={500} value={maxChecks}
              onChange={(e) => setMaxChecks(Math.max(1, Math.min(50000, Number(e.target.value) || 1)))}
              className="h-10 w-28 rounded-xl border border-input bg-background px-3 text-sm tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="city-sweep-max"
            />
          </label>
          <button
            type="button"
            disabled={!canRun}
            onClick={() => start.mutate({ city: city.trim(), state, maxChecks })}
            className="h-10 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            data-testid="city-sweep-run"
          >
            {start.isPending ? "Starting" : "Run city"}
          </button>
        </div>

        {notice ? (
          <p className="mt-2 text-[12px] font-medium text-destructive" role="alert" data-testid="city-sweep-error">{notice}</p>
        ) : null}
      </div>

      {sweeps.isLoading ? <Skeleton className="h-40 w-full rounded-2xl" /> : null}
      {sweeps.isError ? (
        <p className="text-[12px] text-muted-foreground">Could not load recent sweeps.</p>
      ) : null}

      {jobs.map((job) => {
        const pct = progressPct(job);
        const savedPct = job.queued ? Math.round((job.doorsSkipped / job.queued) * 100) : 0;
        return (
          <article key={job.id} className="rounded-2xl border border-border bg-card p-4" data-testid={`city-sweep-job-${job.id}`}>
            <header className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold text-foreground">
                  {job.city ? `${job.city}, ${job.state}` : job.query}
                </h4>
                <p className="text-[12px] text-muted-foreground">
                  {PHASE_COPY[job.phase] ?? job.phase}
                  {job.status === "running" ? "" : ` (${job.status})`}
                </p>
              </div>
              {job.status === "running" ? (
                <button
                  type="button"
                  onClick={() => cancel.mutate(job.id)}
                  className="h-8 rounded-lg border border-border px-3 text-[12px] font-semibold text-foreground"
                  data-testid={`city-sweep-cancel-${job.id}`}
                >
                  Stop
                </button>
              ) : null}
            </header>

            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Harvested" value={job.harvested.toLocaleString()} hint="from OpenStreetMap" testId={`stat-harvested-${job.id}`} />
              <Stat label="Checked" value={job.checked.toLocaleString()} hint={`of ${job.queued.toLocaleString()} queued`} testId={`stat-checked-${job.id}`} />
              <Stat
                label="Streets parked"
                value={job.streetsParked.toLocaleString()}
                hint={job.doorsSkipped ? `${job.doorsSkipped.toLocaleString()} doors saved (${savedPct}%)` : "no fiber found"}
                testId={`stat-parked-${job.id}`}
              />
              <Stat label="Sellable" value={job.opportunitiesFound.toLocaleString()} hint="fiber, nobody on it" testId={`stat-sellable-${job.id}`} />
              <Stat label="Fresh" value={job.freshFound.toLocaleString()} hint="newly lit" testId={`stat-fresh-${job.id}`} />
              <Stat label="Failed" value={job.failed.toLocaleString()} hint="retried, not verdicts" testId={`stat-failed-${job.id}`} />
            </div>

            {job.error ? (
              <p className="mt-2 text-[12px] text-destructive" data-testid={`city-sweep-job-error-${job.id}`}>{job.error}</p>
            ) : null}
          </article>
        );
      })}

      {!sweeps.isLoading && !jobs.length ? (
        <p className="text-[12px] text-muted-foreground" data-testid="city-sweep-empty">
          No city sweeps yet. Enter a city above to harvest and check it.
        </p>
      ) : null}
    </section>
  );
}
