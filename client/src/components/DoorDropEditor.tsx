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
import { Gift, Loader2, AlertTriangle } from "lucide-react";
import {
  validateDoorDropConfig, expectedDailyCostCents, usd,
  DEFAULT_DOOR_DROP_CONFIG, type DoorDropConfig,
} from "@shared/doorDrop";

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
    ...DEFAULT_DOOR_DROP_CONFIG,
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
  // Shared with the server, so the button disables for exactly the reasons the
  // API would have rejected the save.
  const problem = validateDoorDropConfig(cfg);

  const reps = data?.exposure.activeReps ?? 0;
  const doors = Math.max(0, int(doorsPerDay) || 0);
  // Recomputed from the DRAFT rather than read off the server's snapshot, so the
  // bill moves as the manager types instead of after they commit.
  const daily = problem ? 0 : expectedDailyCostCents(doors, reps, cfg);

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
          <Gift className="h-3.5 w-3.5" aria-hidden="true" />
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
        to hit. Unlike the ladder, a rep cannot work out when one is due — which is what
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

      {/* The bill, before the save button — the number that stops this being
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
            {problem ? "—" : `${usd(daily)} / day across ${reps} active rep${reps === 1 ? "" : "s"}`}
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
          — it describes what is running, not what is being typed. */}
      {!!data?.exposure.currentChanceAtDoors?.length && (
        <div className="rounded-2xl border border-border bg-card p-3" data-testid="drop-curve">
          <SectionLabel className="mb-1.5">Live curve · chance per door into a dry run</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {data.exposure.currentChanceAtDoors.map(pt => (
              <span key={pt.doors} data-testid={`drop-curve-${pt.doors}`}
                className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
                {pt.doors} doors → {pt.pct}%
              </span>
            ))}
          </div>
        </div>
      )}

      {problem && (
        <p className="flex items-start gap-1.5 text-[13px] font-medium text-destructive" data-testid="drop-error">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {problem}
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
