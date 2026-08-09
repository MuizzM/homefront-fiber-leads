// ── Launch a SPIFF campaign ──────────────────────────────────────────────────
// A manager should be able to start a contest from their phone, mid-morning, in
// under thirty seconds — that is the entire design constraint. Everything here
// serves it:
//
//   PRESETS FIRST. Five one-tap contests that cover what actually gets launched
//   on a real Saturday. A blank form is why incentive tools go unused; nobody
//   composes a trigger from primitives while standing in a parking lot.
//
//   READ-BACK BEFORE COMMIT. The dialog says the promise back in one sentence
//   ("$100 for 40 knocks before 12 PM, until 6 PM today") because a campaign is
//   a public commitment and a fat-fingered zero is real money.
//
//   THE CEILING IS ON THE FORM. Not buried in an advanced panel. "$75 a sale,
//   everyone, all day" is exactly how a launcher writes an open cheque, so the
//   total cap sits next to the reward where it is impossible to skip.
//
// Validation is shared with the server (validateCampaignInput), so the button
// disables for the same reasons the API would have rejected it.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { Megaphone, Pause, Play, X, Loader2 } from "lucide-react";
import {
  describeTrigger, validateCampaignInput, hour12,
  type CampaignTrigger, type CampaignStatus,
} from "@shared/spiffCampaign";

interface AdminCampaign {
  id: number; name: string; description: string;
  startsAtMs: number; endsAtMs: number;
  trigger: CampaignTrigger; rewardCents: number;
  eligibleRepIds: number[] | null;
  perRepCapCents: number; campaignCapCents: number;
  status: CampaignStatus;
  summary: string;
  awardedCents: number;
}

function usd(cents: number): string {
  const v = Math.trunc(Number.isFinite(cents) ? cents : 0);
  const whole = Math.floor(Math.abs(v) / 100).toLocaleString("en-US");
  const rem = Math.abs(v) % 100;
  return rem === 0 ? `$${whole}` : `$${whole}.${String(rem).padStart(2, "0")}`;
}

/** Local wall-clock hour today → epoch ms. Campaign windows are set in the
 *  launcher's own timezone, which is the org's — a manager launching from the
 *  office is the authority on when "6 PM" is. */
function todayAtHour(hour: number): number {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}
const endOfTodayLocal = () => todayAtHour(23) + 59 * 60_000;

interface Preset {
  key: string;
  label: string;
  blurb: string;
  name: string;
  rewardCents: number;
  trigger: CampaignTrigger;
  endsAtMs: () => number;
}

// The five contests that actually get run. Effort-shaped ones lead, because a
// board where only closers can win goes quiet by lunch for everyone else.
const PRESETS: Preset[] = [
  {
    key: "knocks_noon",
    label: "40 doors before noon",
    blurb: "Pure effort - anyone who walks can win it.",
    name: "Morning grind",
    rewardCents: 5_000,
    trigger: { kind: "knocks_by_time", knocks: 40, byHourLocal: 12 },
    endsAtMs: endOfTodayLocal,
  },
  {
    key: "first_sale",
    label: "First sale before 2 PM",
    blurb: "Rewards starting early instead of warming up all morning.",
    name: "Early bird",
    rewardCents: 5_000,
    trigger: { kind: "sale_by_time", byHourLocal: 14 },
    endsAtMs: endOfTodayLocal,
  },
  {
    key: "per_sale",
    label: "Bonus on every sale",
    blurb: "The classic power hour. Set a total cap.",
    name: "Every sale pays",
    rewardCents: 7_500,
    trigger: { kind: "per_sale" },
    endsAtMs: () => todayAtHour(18),
  },
  {
    key: "double_up",
    label: "2 sales in one day",
    blurb: "Stops the day ending at the first close.",
    name: "Double up",
    rewardCents: 10_000,
    trigger: { kind: "sales_in_day", sales: 2 },
    endsAtMs: endOfTodayLocal,
  },
  {
    key: "streak",
    label: "5 days at 50+ knocks",
    blurb: "Pays showing up, not luck. Runs all week.",
    name: "Consistency streak",
    rewardCents: 15_000,
    trigger: { kind: "knock_streak", days: 5, knocksPerDay: 50 },
    endsAtMs: () => Date.now() + 7 * 86_400_000,
  },
];

/** The promise, in one sentence, exactly as the floor will hear it. */
function readBack(rewardCents: number, trigger: CampaignTrigger, endsAtMs: number): string {
  const when = new Date(endsAtMs);
  const sameDay = when.toDateString() === new Date().toDateString();
  const ends = sameDay
    ? `today at ${hour12(when.getHours())}`
    : when.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `${usd(rewardCents)} ${describeTrigger(trigger)}, until ${ends}.`;
}

const STATUS_CHIP: Record<CampaignStatus, string> = {
  live: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  scheduled: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  paused: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  ended: "bg-secondary text-muted-foreground",
  cancelled: "bg-secondary text-muted-foreground",
};

function LaunchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [presetKey, setPresetKey] = useState<string>(PRESETS[0].key);
  const preset = PRESETS.find(p => p.key === presetKey) ?? PRESETS[0];

  // Dollars on the form, cents on the wire. A manager types "50", never "5000".
  const [rewardDollars, setRewardDollars] = useState<string>("");
  const [capDollars, setCapDollars] = useState<string>("");
  const [name, setName] = useState<string>("");

  // The preset supplies every default; the three fields above only override it.
  const rewardCents = rewardDollars.trim()
    ? Math.round(Number(rewardDollars) * 100)
    : preset.rewardCents;
  const campaignCapCents = capDollars.trim() ? Math.round(Number(capDollars) * 100) : 0;
  const finalName = name.trim() || preset.name;
  const endsAtMs = useMemo(() => preset.endsAtMs(), [presetKey]);
  const startsAtMs = Date.now();

  const problem = validateCampaignInput({
    name: finalName, rewardCents, startsAtMs, endsAtMs,
    trigger: preset.trigger, campaignCapCents,
  });

  const launch = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/spiff-campaigns", {
        name: finalName,
        description: preset.blurb,
        startsAtMs, endsAtMs,
        trigger: preset.trigger,
        rewardCents,
        campaignCapCents,
      });
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/spiff-campaigns"] });
      qc.invalidateQueries({ queryKey: ["/api/me/campaigns"] });
      toast({ title: "Campaign is live", description: readBack(rewardCents, preset.trigger, endsAtMs) });
      onOpenChange(false);
      setRewardDollars(""); setCapDollars(""); setName("");
    },
    onError: (e: any) => toast({ title: "Couldn't launch", description: String(e?.message ?? e), variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid="campaign-launcher">
        <DialogHeader>
          <DialogTitle>Launch a SPIFF</DialogTitle>
          <DialogDescription>
            Every rep sees it on their phone immediately, with live progress. Awards land in the bonus ledger for your normal approval.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <SectionLabel className="mb-2">What earns it</SectionLabel>
            <div className="space-y-2">
              {PRESETS.map(p => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPresetKey(p.key)}
                  data-testid={`preset-${p.key}`}
                  aria-pressed={p.key === presetKey}
                  className={cn(
                    "w-full rounded-2xl border p-3 text-left transition-colors",
                    p.key === presetKey ? "border-primary bg-primary/[0.06]" : "border-border bg-card hover:bg-secondary/50",
                    FOCUS,
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">{p.label}</span>
                    <span className="shrink-0 text-sm font-bold tabular-nums text-foreground">{usd(p.rewardCents)}</span>
                  </div>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">{p.blurb}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="campaign-reward">Reward per award</Label>
              <Input
                id="campaign-reward" inputMode="decimal" data-testid="input-reward"
                placeholder={(preset.rewardCents / 100).toFixed(0)}
                value={rewardDollars} onChange={e => setRewardDollars(e.target.value)}
              />
            </div>
            <div>
              {/* Deliberately NOT behind an "advanced" disclosure — an uncapped
                  per-sale campaign on a hot day is the one way this feature
                  costs real money by accident. */}
              <Label htmlFor="campaign-cap">Total cap (optional)</Label>
              <Input
                id="campaign-cap" inputMode="decimal" data-testid="input-cap"
                placeholder="No cap" value={capDollars} onChange={e => setCapDollars(e.target.value)}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="campaign-name">Name</Label>
            <Input
              id="campaign-name" data-testid="input-name" maxLength={60}
              placeholder={preset.name} value={name} onChange={e => setName(e.target.value)}
            />
          </div>

          {/* Read the promise back before it becomes one. */}
          <div className="rounded-2xl border border-border bg-secondary/40 p-3" data-testid="campaign-readback">
            <SectionLabel className="mb-1">Your reps will see</SectionLabel>
            <p className="text-sm font-semibold text-foreground">{finalName}</p>
            <p className="text-[13px] text-muted-foreground">
              {readBack(rewardCents, preset.trigger, endsAtMs)}
              {campaignCapCents > 0 && ` Capped at ${usd(campaignCapCents)} total.`}
            </p>
          </div>

          {problem && (
            <p className="text-[13px] font-medium text-destructive" data-testid="campaign-error">{problem}</p>
          )}
        </div>

        <DialogFooter>
          <button
            type="button" onClick={() => onOpenChange(false)}
            className={cn("inline-flex min-h-[44px] items-center rounded-xl bg-secondary px-4 text-sm font-semibold text-foreground", FOCUS)}
          >
            Cancel
          </button>
          <button
            type="button" disabled={!!problem || launch.isPending}
            onClick={() => launch.mutate()}
            data-testid="launch-campaign"
            className={cn(
              "inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50",
              FOCUS,
            )}
          >
            {launch.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Launch
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Manager surface: launch, and watch what the running promises are costing. */
export function CampaignLauncher() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useQuery<{ campaigns: AdminCampaign[] }>({
    queryKey: ["/api/spiff-campaigns"],
    refetchInterval: 60_000,
  });
  const campaigns = data?.campaigns ?? [];
  const running = campaigns.filter(c => c.status === "live" || c.status === "paused" || c.status === "scheduled");
  const finished = campaigns.filter(c => !running.includes(c));

  const act = useMutation({
    mutationFn: async ({ id, verb }: { id: number; verb: "pause" | "resume" | "cancel" }) => {
      const res = await apiRequest("POST", `/api/spiff-campaigns/${id}/${verb}`);
      return res.json();
    },
    onSuccess: (_r, { verb }) => {
      qc.invalidateQueries({ queryKey: ["/api/spiff-campaigns"] });
      qc.invalidateQueries({ queryKey: ["/api/me/campaigns"] });
      toast({ title: verb === "cancel" ? "Campaign cancelled" : verb === "pause" ? "Campaign paused" : "Campaign resumed" });
    },
    onError: (e: any) => toast({ title: "Couldn't update campaign", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const row = (c: AdminCampaign) => (
    <li key={c.id} data-testid={`admin-campaign-${c.id}`}
        className="flex items-start gap-3 rounded-2xl border border-border bg-card p-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-semibold text-foreground">{c.name}</span>
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize", STATUS_CHIP[c.status])}
                data-testid={`admin-campaign-status-${c.id}`}>
            {c.status}
          </span>
        </div>
        <p className="text-[13px] text-muted-foreground">{c.summary}</p>
        {/* The live bill. A manager who launched "$75 a sale" needs to see this
            climbing BEFORE it turns up in payroll. */}
        <p className="mt-1 inline-flex items-center gap-1 text-[13px] font-semibold tabular-nums text-foreground"
           data-testid={`admin-campaign-cost-${c.id}`}>
          
          {usd(c.awardedCents)} awarded
          {c.campaignCapCents > 0 && (
            <span className="font-normal text-muted-foreground"> of {usd(c.campaignCapCents)} cap</span>
          )}
        </p>
      </div>
      {(c.status === "live" || c.status === "paused" || c.status === "scheduled") && (
        <div className="flex shrink-0 gap-1.5">
          <button type="button" disabled={act.isPending}
            onClick={() => act.mutate({ id: c.id, verb: c.status === "paused" ? "resume" : "pause" })}
            data-testid={`campaign-toggle-${c.id}`}
            aria-label={c.status === "paused" ? "Resume campaign" : "Pause campaign"}
            className={cn("grid h-11 w-11 place-items-center rounded-xl bg-secondary text-foreground disabled:opacity-50", FOCUS)}>
            {c.status === "paused" ? <Play className="h-4 w-4" aria-hidden="true" /> : <Pause className="h-4 w-4" aria-hidden="true" />}
          </button>
          <button type="button" disabled={act.isPending}
            onClick={() => act.mutate({ id: c.id, verb: "cancel" })}
            data-testid={`campaign-cancel-${c.id}`} aria-label="Cancel campaign"
            className={cn("grid h-11 w-11 place-items-center rounded-xl bg-secondary text-destructive disabled:opacity-50", FOCUS)}>
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </li>
  );

  return (
    <section className="space-y-3" data-testid="campaign-admin">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel className="flex items-center gap-1.5">
          
          Incentive campaigns
        </SectionLabel>
        <button type="button" onClick={() => setOpen(true)} data-testid="open-launcher"
          className={cn("inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground", FOCUS)}>
           Launch
        </button>
      </div>

      {isLoading ? null : running.length === 0 ? (
        <EmptyState icon={Megaphone} title="Nothing running" bordered testId="campaigns-empty"
          description="Launch a contest and every rep sees it on their phone with live progress. The ones that move a slow afternoon are effort-based - knocks before a cutoff, not just sales." />
      ) : (
        <ul className="space-y-2" data-testid="campaign-list">{running.map(row)}</ul>
      )}

      {finished.length > 0 && (
        <details className="rounded-2xl border border-border bg-card/50 p-3">
          <summary className={cn("cursor-pointer text-[13px] font-semibold text-muted-foreground", FOCUS)}>
            Past campaigns ({finished.length})
          </summary>
          <ul className="mt-2 space-y-2">{finished.slice(0, 20).map(row)}</ul>
        </details>
      )}

      <LaunchDialog open={open} onOpenChange={setOpen} />
    </section>
  );
}
