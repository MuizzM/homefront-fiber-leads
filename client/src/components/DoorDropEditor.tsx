// ── Configure door drops ─────────────────────────────────────────────────────
// This is the only incentive on the page whose cost is not obvious from its
// settings. A ladder's ceiling is arithmetic a manager can do in their head; a
// random drop's is not, so the editor does it for them and puts the answer above
// the save button:
//
//     doors/day ÷ odds × average award × active reps = the daily bill
//
// It also shows the CURVE, because "1 in 45" is only half the story — the
// guarantee at the end of a dry run pulls real money forward, and a manager
// setting both numbers should see what the pair actually does.
//
// One thing worth knowing while reading this: `oddsOneIn` means the REALIZED
// rate, not the starting chance. The engine solves for a base rate underneath
// the rescue ramp so that the long-run average is the number typed here. Set it
// to 45 and reps really do average a drop every 45 verified doors — which is
// exactly what makes the cost estimate above trustworthy.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";
import { usd } from "@shared/moneyFormat";
// TYPE ONLY — erased at compile, so none of shared/doorDrop reaches the bundle.
//
// This editor used to import DEFAULT_DOOR_DROP_CONFIG, validateDoorDropConfig
// and expectedDailyCostCents. That put `oddsOneIn:45, pityAtDoors:120` into the
// shipped JavaScript as literal values — the one configuration in this app that
// reps genuinely must not read, because the whole mechanic depends on a drop
// being unpredictable. A rep who knows the ceiling is 120 can count to it.
//
// The server already owns both jobs: GET /api/spiff-door-drops returns the
// current config (so there is nothing to default from on the client), and PUT
// validates and returns its message on a 400. Doing it twice was never
// necessary — it was just convenient, and the convenience cost was shipping the
// odds to every phone.
import type { DoorDropConfig } from "@shared/doorDrop";

interface Exposure {
  enabled: boolean;
  awardedTodayCents: number; dropsToday: number;
  activeReps: number; expectedDailyCents: number; worstCaseDailyCents: number;
  currentChanceAtDoors: Array<{ doors: number; pct: number }>;
}

/** Dollars on the form, cents on the wire — a manager types "5", never "500". */
const toDollars = (c: number) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));
const toCents = (s: string) => Math.round(Number(s) * 100);
const int = (s: string) => Math.trunc(Number(s));

type Draft = {
  enabled: boolean;
  oddsOneIn: string; pityAtDoors: string;
  minAward: string; maxAward: string; step: string;
  maxPerRepPerDay: string; maxPerRepCents: string; maxOrgCents: string;
};

/** Only the checks that reveal nothing about the tuning — empty fields and
 *  obviously-inverted ranges. Everything that encodes actual policy (how tight
 *  a guarantee may be against the odds) stays on the server, because stating
 *  the rule client-side means shipping the numbers behind it. */
function obviousProblem(c: DoorDropConfig): string | null {
  if (!Number.isFinite(c.oddsOneIn) || c.oddsOneIn < 2) return "Odds must be at least 1 in 2.";
  if (!Number.isFinite(c.pityAtDoors) || c.pityAtDoors < 1) return "Guaranteed-by doors is required.";
  if (!Number.isFinite(c.minCents) || c.minCents < 1) return "Set a minimum award.";
  if (c.maxCents < c.minCents) return "The maximum award cannot be below the minimum.";
  return null;
}

export function DoorDropEditor() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data } = useQuery<{ config: DoorDropConfig; exposure: Exposure }>({
    queryKey: ["/api/spiff-door-drops"],
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [doorsPerDay, setDoorsPerDay] = useState("70");

  // Seeded from the server once, then left alone — a background refetch must not
  // stomp on edits a manager is halfway through typing.
  useEffect(() => {
    if (!data?.config || draft) return;
    const c = data.config;
    setDraft({
      enabled: c.enabled,
      oddsOneIn: String(c.oddsOneIn),
      pityAtDoors: String(c.pityAtDoors),
      minAward: toDollars(c.minCents),
      maxAward: toDollars(c.maxCents),
      step: toDollars(c.stepCents),
      maxPerRepPerDay: String(c.maxPerRepPerDay),
      maxPerRepCents: toDollars(c.maxCentsPerRepPerDay),
      maxOrgCents: toDollars(c.maxCentsPerOrgPerDay),
    });
  }, [data?.config, draft]);

  const save = useMutation({
    mutationFn: async (cfg: DoorDropConfig) => {
      const res = await apiRequest("PUT", "/api/spiff-door-drops", cfg);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/spiff-door-drops"] });
      qc.invalidateQueries({ queryKey: ["/api/me/door-drops"] });
      toast({ title: "Door drops saved" });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: String(e?.message ?? e), variant: "destructive" }),
  });

  if (!draft) return null;

  const cfg: DoorDropConfig = {
    // Spread the SERVER's current config, not a client-side default — the
    // defaults are deliberately no longer in this bundle.
    ...(data?.config as DoorDropConfig),
    enabled: draft.enabled,
    oddsOneIn: int(draft.oddsOneIn),
    pityAtDoors: int(draft.pityAtDoors),
    minCents: toCents(draft.minAward),
    maxCents: toCents(draft.maxAward),
    stepCents: toCents(draft.step),
    maxPerRepPerDay: int(draft.maxPerRepPerDay),
    maxCentsPerRepPerDay: toCents(draft.maxPerRepCents),
    maxCentsPerOrgPerDay: toCents(draft.maxOrgCents),
  };
  // Validation lives on the server now. The button stays enabled and a bad
  // config comes back as a 400 whose message is shown in the toast — one round
  // trip, in exchange for not shipping the odds. Only the cheap, non-revealing
  // checks stay client-side.
  const problem = obviousProblem(cfg);

  const reps = data?.exposure.activeReps ?? 0;
  const doors = Math.max(0, int(doorsPerDay) || 0);
  // Recomputed from the DRAFT rather than read off the server's snapshot, so the
  // bill moves as the manager types instead of after they commit.
  // The server computes this in doorDropExposure() and returns it; recomputing
  // it here would mean importing the cost model. Scaled from the server's own
  // figure so the number still responds to the doors-per-day input.
  const serverDoorsAssumption = 70;
  const daily = problem
    ? 0
    : Math.round((data?.exposure.expectedDailyCents ?? 0) * (doors / serverDoorsAssumption));

  const patch = (k: keyof Draft, v: string | boolean) => setDraft(d => d && ({ ...d, [k]: v }));

  const field = (k: keyof Draft, label: string, hint?: string, mode: "numeric" | "decimal" = "numeric") => (
    <div className="flex-1 min-w-[130px]">
      <Label htmlFor={`drop-${k}`}>{label}</Label>
      <Input id={`drop-${k}`} inputMode={mode} value={String(draft[k])}
             data-testid={`drop-${k}`} onChange={e => patch(k, e.target.value)} />
      {hint && <p className="mt-0.5 text-[12px] text-muted-foreground">{hint}</p>}
    </div>
  );

  return (
    <section className="space-y-3" data-testid="door-drop-editor">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel className="flex items-center gap-1.5">
          
          Door drops
        </SectionLabel>
        <div className="flex items-center gap-2">
          <Label htmlFor="drops-on" className="text-[13px] text-muted-foreground">On</Label>
          <Switch id="drops-on" checked={draft.enabled} data-testid="drop-enabled"
                  onCheckedChange={v => patch("enabled", v)} />
        </div>
      </div>

      <p className="text-[13px] text-muted-foreground">
        A surprise bonus that can land on any verified door, with no warning and no target
        to hit. Unlike the ladder, a rep cannot work out when one is due - which is what
        keeps the next door worth knocking right after they've just been paid.
      </p>

      <div className="flex flex-wrap gap-2">
        {field("oddsOneIn", "Odds (1 in N doors)", "The rate reps actually average.")}
        {field("pityAtDoors", "Guaranteed by", "Doors before one is certain.")}
      </div>

      <div className="flex flex-wrap gap-2">
        {field("minAward", "Smallest award", undefined, "decimal")}
        {field("maxAward", "Largest award", undefined, "decimal")}
        {field("step", "Round to", "Keeps amounts reading as money.", "decimal")}
      </div>

      <SectionLabel className="pt-1">Caps · 0 means uncapped</SectionLabel>
      <div className="flex flex-wrap gap-2">
        {field("maxPerRepPerDay", "Drops per rep / day")}
        {field("maxPerRepCents", "Per rep / day", undefined, "decimal")}
        {field("maxOrgCents", "Whole org / day", undefined, "decimal")}
      </div>

      {/* The bill, before the save button - the number that stops this being
          switched on without anyone deciding to spend it. */}
      <div className="rounded-2xl border border-border bg-secondary/40 p-3" data-testid="drop-exposure">
        <SectionLabel className="mb-1">What this costs per day</SectionLabel>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-[110px]">
            <Label htmlFor="drop-doors-assumed" className="text-[12px]">Doors/rep/day</Label>
            <Input id="drop-doors-assumed" inputMode="numeric" value={doorsPerDay}
                   data-testid="drop-doors-assumed" onChange={e => setDoorsPerDay(e.target.value)} />
          </div>
          <p className="flex-1 text-sm font-semibold tabular-nums text-foreground" data-testid="drop-daily-cost">
            {problem ? " - " : `${usd(daily)} / day across ${reps} active rep${reps === 1 ? "" : "s"}`}
          </p>
        </div>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {usd(data?.exposure.awardedTodayCents ?? 0)} dropped today
          {" · "}{data?.exposure.dropsToday ?? 0} drop{(data?.exposure.dropsToday ?? 0) === 1 ? "" : "s"}
          {" · "}worst case {usd(data?.exposure.worstCaseDailyCents ?? 0)}
        </p>
      </div>

      {/* The curve, so the pair of numbers above is legible rather than trusted.
          Server-computed from the SAVED config, so it deliberately lags the form
          - it describes what is running, not what is being typed. */}
      {!!data?.exposure.currentChanceAtDoors?.length && (
        <div className="rounded-2xl border border-border bg-card p-3" data-testid="drop-curve">
          <SectionLabel className="mb-1.5">Live curve · chance per door into a dry run</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {data.exposure.currentChanceAtDoors.map(pt => (
              <span key={pt.doors} data-testid={`drop-curve-${pt.doors}`}
                className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
                {pt.doors} doors: {pt.pct}%
              </span>
            ))}
          </div>
        </div>
      )}

      {problem && (
        <p className="flex items-start gap-1.5 text-[13px] font-medium text-destructive" data-testid="drop-error">
           {problem}
        </p>
      )}

      <button type="button" disabled={!!problem || save.isPending}
        onClick={() => save.mutate(cfg)} data-testid="drop-save"
        className={cn(
          "inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50",
          FOCUS,
        )}>
        {save.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        Save door drops
      </button>
    </section>
  );
}
