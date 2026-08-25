// RUN A CITY: harvest it from OpenStreetMap, check it, and stop early on the
// streets that have no fiber.
//
// A blind run measured 2026-08-24 checked 250 Charlotte doors and got 250
// unmatched, because that inventory is an OSM address grid over a city Kinetic
// barely serves. The sweep probes each street first and parks the rest of any
// street that answers with no fiber, so this panel reports what the prune saved
// beside what the run found.
//
// The card leads with the one number a manager acts on - doors a rep can knock -
// and demotes the mechanics to a line under it. Six equal-weight tiles made the
// outcome compete with "harvested".
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const STATES = ["NC", "SC", "GA", "FL", "IA", "KY"] as const;
type SweepState = (typeof STATES)[number];

export interface SweepJob {
  id: string; kind: string; query: string; city: string | null; state: string | null;
  phase: string; status: string; source: string | null;
  harvested: number; queued: number; checked: number; failed: number;
  freshFound: number; opportunitiesFound: number;
  streetsParked: number; doorsSkipped: number; probeCount: number;
  maxChecks: number; error: string | null; startedAt: string; completedAt: string | null;
}

const PHASE_COPY: Record<string, string> = {
  queued: "Queued", harvesting: "Harvesting from OpenStreetMap", checking: "Checking doors",
  complete: "Complete", cancelled: "Stopped", failed: "Failed", error: "Failed",
};

/** Doors reached, against everything that was on the list. */
function progressPct(job: SweepJob): number {
  const denominator = job.queued || job.harvested || 0;
  if (!denominator) return 0;
  return Math.min(100, Math.round(((job.checked + job.doorsSkipped) / denominator) * 100));
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
  const run = () => { if (canRun) start.mutate({ city: city.trim(), state, maxChecks }); };

  return (
    <section className="space-y-3" data-testid="city-sweep-runner">
      <div className="rounded-2xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-balance text-foreground">Run a city</h3>
        <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-pretty text-muted-foreground">
          Harvests every address in the city from OpenStreetMap, then checks it. Each street is probed
          first: if the probes come back with no fiber, the rest of that street is parked instead of
          checked. One token and one residential IP serve 20 checks, then both switch.
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[180px] flex-1">
            <Label htmlFor="city-sweep-city" className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              City
            </Label>
            <Input
              id="city-sweep-city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") run(); }}
              placeholder="Salisbury"
              autoComplete="address-level2"
              className="mt-1"
              data-testid="city-sweep-city"
            />
          </div>
          <div>
            <Label htmlFor="city-sweep-state" className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              State
            </Label>
            <Select value={state} onValueChange={(v) => setState(v as SweepState)}>
              <SelectTrigger id="city-sweep-state" className="mt-1 w-[84px]" data-testid="city-sweep-state">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="city-sweep-max" className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Max checks
            </Label>
            <Input
              id="city-sweep-max"
              type="number" inputMode="numeric" min={1} max={50000} step={500}
              value={maxChecks}
              onChange={(e) => setMaxChecks(Math.max(1, Math.min(50000, Number(e.target.value) || 1)))}
              className="mt-1 w-28 tabular-nums"
              data-testid="city-sweep-max"
            />
          </div>
          <Button type="button" disabled={!canRun} onClick={run} data-testid="city-sweep-run">
            {start.isPending ? "Starting" : "Run city"}
          </Button>
        </div>

        {notice ? (
          <p className="mt-2 text-[12px] font-medium text-pretty text-destructive" role="alert" data-testid="city-sweep-error">
            {notice}
          </p>
        ) : null}
      </div>

      {sweeps.isLoading ? <Skeleton className="h-32 w-full rounded-2xl" /> : null}
      {sweeps.isError ? (
        <p className="text-[12px] text-pretty text-muted-foreground">Could not load recent sweeps.</p>
      ) : null}

      {jobs.map((job) => {
        const pct = progressPct(job);
        const savedPct = job.queued ? Math.round((job.doorsSkipped / job.queued) * 100) : 0;
        const running = job.status === "running";
        return (
          <article key={job.id} className="rounded-2xl border border-border bg-card p-4" data-testid={`city-sweep-job-${job.id}`}>
            <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-0">
                <h4 className="truncate text-sm font-semibold text-foreground">
                  {job.city ? `${job.city}, ${job.state}` : job.query}
                </h4>
                <p className="text-[12px] text-muted-foreground">{PHASE_COPY[job.phase] ?? job.phase}</p>
              </div>
              {running ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" data-testid={`city-sweep-cancel-${job.id}`}>Stop</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Stop the {job.city} sweep?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Doors already checked keep their answers. The {Math.max(0, job.queued - job.checked - job.doorsSkipped).toLocaleString()} still
                        queued are left unchecked, and starting again re-harvests the city.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep scanning</AlertDialogCancel>
                      <AlertDialogAction onClick={() => cancel.mutate(job.id)} data-testid={`city-sweep-cancel-confirm-${job.id}`}>
                        Stop the sweep
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </header>

            {/* The outcome first: doors a rep can knock. */}
            <p className="mt-3 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums text-foreground" data-testid={`stat-sellable-${job.id}`}>
                {job.opportunitiesFound.toLocaleString()}
              </span>
              <span className="text-[13px] text-muted-foreground">sellable · fiber, nobody on it</span>
            </p>

            <Progress
              value={pct}
              aria-label={`${job.city ?? job.query} sweep progress`}
              className="mt-2 h-1.5"
            />

            {/* The mechanics, one quiet line. */}
            <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">Checked</dt>
                <dd className="font-semibold tabular-nums text-foreground" data-testid={`stat-checked-${job.id}`}>
                  {job.checked.toLocaleString()} of {job.queued.toLocaleString()}
                </dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">Streets parked</dt>
                <dd className="font-semibold tabular-nums text-foreground" data-testid={`stat-parked-${job.id}`}>
                  {job.streetsParked.toLocaleString()}
                  {job.doorsSkipped ? (
                    <span className="font-normal text-muted-foreground"> · {job.doorsSkipped.toLocaleString()} doors saved ({savedPct}%)</span>
                  ) : null}
                </dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">Newly lit</dt>
                <dd className="font-semibold tabular-nums text-foreground" data-testid={`stat-fresh-${job.id}`}>{job.freshFound.toLocaleString()}</dd>
              </div>
              {job.failed ? (
                <div className="flex gap-1.5">
                  <dt className="text-muted-foreground">Failed</dt>
                  <dd className="font-semibold tabular-nums text-destructive" data-testid={`stat-failed-${job.id}`}>{job.failed.toLocaleString()}</dd>
                </div>
              ) : null}
            </dl>

            {job.error ? (
              <p className="mt-2 text-[12px] text-pretty text-destructive" data-testid={`city-sweep-job-error-${job.id}`}>{job.error}</p>
            ) : null}
          </article>
        );
      })}

      {!sweeps.isLoading && !jobs.length ? (
        <p className="text-[12px] text-pretty text-muted-foreground" data-testid="city-sweep-empty">
          No city sweeps yet. Enter a city above to harvest and check it.
        </p>
      ) : null}
    </section>
  );
}
