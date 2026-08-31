// ── Configure the standing door bonus ────────────────────────────────────────
// The ladder pays automatically and forever, which makes it the single most
// expensive thing on this page if it is set carelessly. So the editor leads with
// the number nobody works out by hand:
//
//     per-rep ceiling × active reps = what a perfect week costs you
//
// A $25/$50/$100 ladder across 20 reps is $3,500 a week if everyone tops out.
// That figure is on screen BEFORE the save button, not in a help doc.
//
// Validation is shared with the server (validateLadder), so the button disables
// for the same reasons the API would have rejected the save.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ErrorState } from "@/components/ErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";
import {
  validateLadder, ladderCeilingCents, usd,
  type MilestoneLadder, type MilestonePeriod, type MilestoneRung,
} from "@shared/knockMilestones";

interface Exposure {
  enabled: boolean; periodLabel: string;
  awardedCents: number; awardCount: number;
  perRepCeilingCents: number; activeReps: number; worstCaseCents: number;
}

/** Dollars on the form, cents on the wire — a manager types "25", never "2500". */
const toDollars = (c: number) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));

export function MilestoneLadderEditor() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery<{ ladder: MilestoneLadder; exposure: Exposure }>({
    queryKey: ["/api/spiff-milestones"],
  });

  const [draft, setDraft] = useState<{ enabled: boolean; period: MilestonePeriod; rungs: Array<{ doors: string; reward: string }> } | null>(null);

  // Seed the form from the server ONCE it arrives, and never again — a
  // background refetch must not stomp on edits a manager is halfway through.
  useEffect(() => {
    if (!data?.ladder || draft) return;
    setDraft({
      enabled: data.ladder.enabled,
      period: data.ladder.period,
      rungs: data.ladder.rungs.map(r => ({ doors: String(r.doors), reward: toDollars(r.rewardCents) })),
    });
  }, [data?.ladder, draft]);

  const save = useMutation({
    mutationFn: async (ladder: MilestoneLadder) => {
      const res = await apiRequest("PUT", "/api/spiff-milestones", ladder);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/spiff-milestones"] });
      qc.invalidateQueries({ queryKey: ["/api/me/milestones"] });
      toast({ title: "Door bonus saved" });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: String(e?.message ?? e), variant: "destructive" }),
  });

  if (isLoading || (!draft && !isError)) {
    return <Skeleton className="h-40 w-full rounded-2xl" data-testid="ladder-loading" />;
  }
  if (!draft) {
    return (
      <ErrorState
        title="Couldn't load the door bonus ladder"
        description="The standing bonus config is hidden until this loads - it was not changed."
        onRetry={() => void refetch()}
        testId="ladder-error"
      />
    );
  }

  const rungs: MilestoneRung[] = draft.rungs.map(r => ({
    doors: Math.trunc(Number(r.doors)),
    rewardCents: Math.round(Number(r.reward) * 100),
  }));
  const ladder: MilestoneLadder = { enabled: draft.enabled, period: draft.period, rungs };
  const problem = validateLadder(ladder);

  const ceiling = ladderCeilingCents(ladder);
  const reps = data?.exposure.activeReps ?? 0;
  const worstCase = ceiling * reps;

  const patchRung = (i: number, field: "doors" | "reward", value: string) =>
    setDraft(d => d && ({ ...d, rungs: d.rungs.map((r, n) => (n === i ? { ...r, [field]: value } : r)) }));

  return (
    <section className="space-y-3" data-testid="milestone-editor">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel className="flex items-center gap-1.5">
          
          Standing door bonus
        </SectionLabel>
        <div className="flex items-center gap-2">
          <Label htmlFor="milestones-on" className="text-[13px] text-muted-foreground">On</Label>
          <Switch id="milestones-on" checked={draft.enabled} data-testid="milestone-enabled"
                  onCheckedChange={v => setDraft(d => d && ({ ...d, enabled: v }))} />
        </div>
      </div>

      <p className="text-[13px] text-muted-foreground">
        Pays automatically onto the rep's commission statement when they clear a rung.
        Counts each address once, and only knocks GPS confirmed - re-knocking the same
        door, or logging from the truck, moves nothing.
      </p>

      <div className="space-y-2" data-testid="milestone-rung-rows">
        {draft.rungs.map((r, i) => (
          <div key={i} className="flex items-end gap-2" data-testid={`milestone-row-${i}`}>
            <div className="flex-1">
              {i === 0 && <Label htmlFor={`rung-doors-${i}`}>Verified doors</Label>}
              <Input id={`rung-doors-${i}`} inputMode="numeric" value={r.doors}
                     data-testid={`rung-doors-${i}`}
                     onChange={e => patchRung(i, "doors", e.target.value)} />
            </div>
            <div className="flex-1">
              {i === 0 && <Label htmlFor={`rung-reward-${i}`}>Pays</Label>}
              <Input id={`rung-reward-${i}`} inputMode="decimal" value={r.reward}
                     data-testid={`rung-reward-${i}`}
                     onChange={e => patchRung(i, "reward", e.target.value)} />
            </div>
            <button type="button" aria-label={`Remove milestone ${i + 1}`}
              data-testid={`rung-remove-${i}`}
              onClick={() => setDraft(d => d && ({ ...d, rungs: d.rungs.filter((_, n) => n !== i) }))}
              className={cn("inline-flex min-h-[44px] shrink-0 items-center rounded-xl bg-secondary px-3 text-[13px] font-semibold text-destructive", FOCUS)}>
              Remove
            </button>
          </div>
        ))}
      </div>

      <button type="button" data-testid="rung-add"
        onClick={() => setDraft(d => d && ({ ...d, rungs: [...d.rungs, { doors: "", reward: "" }] }))}
        className={cn("inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-secondary px-3 text-sm font-semibold text-foreground", FOCUS)}>
         Add a milestone
      </button>

      {/* The bill, before the save button. This is the number that stops a
          ladder being switched on without anyone deciding to spend it. */}
      <div className="rounded-2xl border border-border bg-secondary/40 p-3" data-testid="milestone-exposure">
        <SectionLabel className="mb-1">What a perfect {draft.period === "day" ? "day" : "week"} costs</SectionLabel>
        <p className="text-sm font-semibold tabular-nums text-foreground">
          {usd(ceiling)} per rep × {reps} active rep{reps === 1 ? "" : "s"} = {usd(worstCase)}
        </p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {usd(data?.exposure.awardedCents ?? 0)} awarded so far
          {data?.exposure.periodLabel ? ` · ${data.exposure.periodLabel}` : ""}
        </p>
      </div>

      {problem && (
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-destructive" data-testid="milestone-error">
           {problem}
        </p>
      )}

      <button type="button" disabled={!!problem || save.isPending}
        onClick={() => save.mutate(ladder)} data-testid="milestone-save"
        className={cn(
          "inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50",
          FOCUS,
        )}>
        {save.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        Save door bonus
      </button>
    </section>
  );
}
