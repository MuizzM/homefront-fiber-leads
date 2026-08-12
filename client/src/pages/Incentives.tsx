// Incentives — every bonus a rep can earn, on one surface.
//
// The page is organized the way shipped incentive surfaces are (via Mobbin —
// Grab's Current/Past challenge tabs, Blackbird's balance-first rewards home,
// Deel's action-required approvals): the MONEY leads as a hero total that is
// always on screen, and everything under it lives behind one segmented control:
//
//   Earn      what a rep can chase right now — the live offer, contests, and
//             standing programs. The default tab, because this page's job is
//             changing what someone does with their afternoon.
//   Activity  the ledger: every award with its amount, why it fired in plain
//             language, when, and where it sits (earned → approved → paid).
//   Team      managers see the HEAT leaderboard; admins also get the approval
//             queue — pending money first, bulk approve, and a "mark paid"
//             action that is the single, terminal settlement (a bonus is paid
//             exactly once — see server/spiffStore.ts).
//   Manage    launching campaigns and the two standing-program editors, each
//             behind a disclosure — configuration is a deliberate visit, not
//             something to scroll past on the way to the queue.
//
// A NEW award since the rep's last visit gets one tasteful reveal above the
// hero (and none at all under prefers-reduced-motion). "What can I earn" is
// spelled out from the live engine config so the rules can never drift from
// the copy.
//
// Every bonus on this page rides ONE ledger, tracked earned -> approved -> paid;
// nothing here is commission or payroll. The ledger is still called `spiffs` in
// the database and the API — renaming a money table to match a label would be a
// migration with no upside — so "spiff" survives in the types and the routes and
// nowhere a rep can read it.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { FOCUS } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { PageHeader, StatStrip, StatTile, SectionLabel } from "@/components/ui/page-scaffold";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { CampaignBoard } from "@/components/CampaignBoard";
import { MilestoneSection } from "@/components/MilestoneCard";
import { DoorDropSection } from "@/components/DoorDropCard";
import { RampBonusSection } from "@/components/RampBonusCard";
import { DoorDaySection } from "@/components/DoorDayCard";
import { AchievementSection } from "@/components/AchievementLadder";
import { MomentumOffer } from "@/components/MomentumOffer";
import { MilestoneLadderEditor } from "@/components/MilestoneLadderEditor";
import { DoorDropEditor } from "@/components/DoorDropEditor";
import { CampaignLauncher } from "@/components/CampaignLauncher";
import { useAuth } from "@/lib/auth";
import { can, type Role as AppRole } from "@shared/capabilities";
import { usd } from "@shared/moneyFormat";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Gift, Flame, CheckCheck, BadgeCheck, X, AlertTriangle, Wallet, Loader2, ChevronDown, Footprints, type LucideIcon } from "lucide-react";
import {
  spiffReasonLabel, spiffReasonBlurb, spiffAmountBand, spiffAmountLadder,
  spiffTriggerGuide, DEFAULT_SPIFF_CONFIG,
  type PerfSnapshot, type SpiffReason,
} from "@shared/spiffEngine";

interface SpiffRow {
  id: number; repId: number; saleRef: string | null; amountCents: number;
  reason: string; status: string; createdAt: string;
  approvedBy: number | null; approvedAt: string | null; paidAt: string | null;
}
interface AwardBand {
  minCents: number; maxCents: number; incrementCents: number;
  ladderCents: number[];
  triggers: Array<{ reason: SpiffReason; title: string; how: string }>;
}
interface MineResponse {
  spiffs: SpiffRow[]; heat: number; snapshot: PerfSnapshot | null;
  totals: { earnedCents: number; approvedCents: number; paidCents: number; count: number };
  band?: AwardBand;
}
interface TeamHeatEntry {
  repId: number; name: string | null; role: string | null;
  heat: number; snapshot: PerfSnapshot;
  earnedCents: number; approvedCents: number; paidCents: number; spiffCount: number;
}
interface TeamResponse { reps: TeamHeatEntry[]; pending: (SpiffRow & { repName: string | null })[]; }

// One query for the rep's own money, shared by the reveal, the hero, and the
// Activity tab — react-query dedupes on the key, so "three components read it"
// costs one request.
function useMine() {
  return useQuery<MineResponse>({
    queryKey: ["/api/spiffs/mine"],
    refetchInterval: 60_000,
  });
}

// The live band from the server, falling back to the engine defaults so the
// "what can I earn" copy renders correctly before the first response lands.
function useAwardBand(fromServer: AwardBand | undefined): AwardBand {
  return useMemo(() => {
    if (fromServer) return fromServer;
    const b = spiffAmountBand(DEFAULT_SPIFF_CONFIG);
    return {
      minCents: b.minCents, maxCents: b.maxCents, incrementCents: b.incrementCents,
      ladderCents: spiffAmountLadder(DEFAULT_SPIFF_CONFIG),
      triggers: spiffTriggerGuide(DEFAULT_SPIFF_CONFIG),
    };
  }, [fromServer]);
}

// ── Money ─────────────────────────────────────────────────────────────────────
// Integer cents in, string out, with the split done in INTEGER arithmetic — no
// `cents / 100` float ever reaches a rendered digit, and no cents are silently
// rounded away. `usd` is imported from @shared/moneyFormat (above) — the one
// definition.

/** "Today" / "Yesterday" / "4 days ago" / a plain date. Never a raw ISO string. */
function whenLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const STATUS_COPY: Record<string, { label: string; hint: string; className: string }> = {
  earned: {
    label: "Earned",
    hint: "Waiting on approval",
    className: "bg-secondary text-muted-foreground",
  },
  approved: {
    label: "Approved",
    hint: "Cleared - payout queued",
    className: "bg-primary/15 text-primary",
  },
  paid: {
    label: "Paid",
    hint: "Settled",
    className: "bg-emerald-500/15 text-success",
  },
};
const statusCopy = (status: string) =>
  STATUS_COPY[status] ?? { label: status, hint: "", className: "bg-secondary text-muted-foreground" };


// Heat is the algorithm's 0..100 read on how locked-in a rep is. Warm tint the
// higher it climbs — never a bare colored number, and readable in BOTH themes.
// Three bands that all returned the same class is a ramp that carries no
// information: 15 and 95 rendered identically, so the number's colour told a
// rep nothing the number itself did not. The collapse happened during the
// palette migration, when three distinct amber steps were each replaced by the
// single token nearest to them.
//
// Cold is quiet, warming is amber, and the top band is gold because that is
// where the money is - the same split the rest of the app uses.
function heatTone(heat: number): string {
  if (heat >= 70) return "text-gold-text";
  if (heat >= 40) return "text-warning";
  if (heat >= 15) return "text-muted-foreground";
  return "text-muted-foreground";
}

function HeatMeter({ heat, testId }: { heat: number; testId?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(Number.isFinite(heat) ? heat : 0)));
  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary" role="meter"
           aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Heat score">
        <div className="h-full rounded-full bg-gold" style={{ width: `${pct}%` }} />
      </div>
      <span className={cn("w-9 shrink-0 text-right text-sm font-bold tabular-nums", heatTone(pct))}>{pct}</span>
    </div>
  );
}

// ── "New since you last looked" ───────────────────────────────────────────────
// Remembers the highest bonus id the rep has already seen so a fresh award gets
// exactly ONE reveal, not a re-run on every poll. localStorage can throw (private
// mode, disabled storage), so every access is guarded — a broken store must never
// break the page.
const SEEN_KEY = (repId: number | string) => `hf.spiffs.lastSeenId.${repId}`;
function readSeen(repId: number | string): number {
  try { return Number(window.localStorage.getItem(SEEN_KEY(repId))) || 0; } catch { return 0; }
}
function writeSeen(repId: number | string, id: number): void {
  try { window.localStorage.setItem(SEEN_KEY(repId), String(id)); } catch { /* storage unavailable */ }
}

function NewAwardReveal({ spiff, onDismiss }: { spiff: SpiffRow; onDismiss: () => void }) {
  return (
    <div
      data-testid="spiff-reveal"
      role="status"
      aria-live="polite"
      className={cn(
        "relative flex items-center gap-3 overflow-hidden rounded-2xl border border-primary/30 bg-primary/[0.07] p-4",
        // Tasteful: one short fade + slight zoom, and nothing at all when the
        // viewer has asked for reduced motion.
        "animate-in fade-in zoom-in-95 duration-300 motion-reduce:animate-none",
      )}
    >
      
      <div className="min-w-0 flex-1">
        <SectionLabel>New bonus</SectionLabel>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-2xl font-bold tabular-nums tracking-tight text-primary" data-testid="spiff-reveal-amount">
            {usd(spiff.amountCents)}
          </span>
          <span className="text-sm font-semibold text-foreground">{spiffReasonLabel(spiff.reason as SpiffReason)}</span>
        </div>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{spiffReasonBlurb(spiff.reason as SpiffReason)}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        data-testid="spiff-reveal-dismiss"
        aria-label="Dismiss new bonus"
        className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-secondary", FOCUS)}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** One reveal per genuinely-new award, keyed on viewer identity at the call
 *  site so a late-resolving auth re-reads the bookmark for the RIGHT person. */
function RevealSlot({ repKey }: { repKey: number | string }) {
  const { data } = useMine();
  const newest = data?.spiffs?.[0];
  const [seen, setSeen] = useState<number>(() => readSeen(repKey));
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (newest && newest.id > seen) writeSeen(repKey, newest.id);
  }, [newest?.id, seen, repKey]);
  const reveal = !dismissed && newest && newest.id > seen ? newest : null;
  if (!reveal) return null;
  const dismiss = () => {
    if (newest) { writeSeen(repKey, newest.id); setSeen(newest.id); }
    setDismissed(true);
  };
  return <NewAwardReveal spiff={reveal} onDismiss={dismiss} />;
}

// ── The hero: total won, always on screen ─────────────────────────────────────
// Blackbird / Base / Revolut (via Mobbin): one big tabular number the page is
// FOR, with the split as quiet tinted chips beside it — never four equal tiles
// fighting for the same glance. Heat rides here too: it is the other number a
// rep checks between doors, and folding it in retires a whole separate card.
function MoneyHero({ data, isLoading, isError }: {
  data: MineResponse | undefined; isLoading: boolean; isError: boolean;
}) {
  const totals = data?.totals;
  const runningTotal = totals ? totals.earnedCents + totals.approvedCents + totals.paidCents : 0;
  const awaiting = (totals?.earnedCents ?? 0) + (totals?.approvedCents ?? 0);
  return (
    <Card className="overflow-hidden rounded-2xl">
      <CardContent className="p-4">
        <SectionLabel>Total won</SectionLabel>
        {isLoading ? (
          <Skeleton className="mt-1 h-9 w-32" data-testid="hero-loading" />
        ) : (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-3xl font-bold tabular-nums leading-none tracking-tight text-gold-text"
                  data-testid="stat-total">
              {isError ? " - " : usd(runningTotal)}
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              <span data-testid="stat-pending"
                    className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
                
                {isError ? " - " : usd(awaiting)} awaiting
              </span>
              <span data-testid="stat-paid"
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-success">
                
                {isError ? " - " : usd(totals?.paidCents ?? 0)} paid
              </span>
            </span>
          </div>
        )}

        <div className="mt-4" data-testid="stat-heat">
          <div className="flex items-center gap-1.5">
            
            <SectionLabel>Heat</SectionLabel>
          </div>
          <div className="mt-1.5">
            <HeatMeter heat={isError ? 0 : data?.heat ?? 0} testId="my-heat" />
          </div>
          <p className="mt-1.5 text-[12px] text-muted-foreground">
            Streak, pace, improvement - the hotter you run, the more surprise bonuses the algorithm drops.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ── What can I earn ───────────────────────────────────────────────────────────
function EarnGuide({ band }: { band: AwardBand }) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-4">
        <SectionLabel className="mb-2">Surprise bonuses - what you can earn</SectionLabel>
        <p className="text-sm text-foreground">
          Every recognition bonus is worth{" "}
          <span className="font-bold tabular-nums" data-testid="earn-band">
            {usd(band.minCents)}-{usd(band.maxCents)}
          </span>
          , drawn in {usd(band.incrementCents)} steps. The harder one is to earn, the more the draw leans to the top of the band.
        </p>
        <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="earn-ladder" aria-label="Possible bonus amounts">
          {band.ladderCents.map((c) => (
            <li key={c} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
              {usd(c)}
            </li>
          ))}
        </ul>
        <ul className="mt-3 space-y-2" data-testid="earn-triggers">
          {band.triggers.map((t) => {
            return (
              <li key={t.reason} className="flex items-start gap-2.5">
                
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-foreground">{t.title}</span>
                  <span className="block text-[13px] text-muted-foreground">{t.how}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

// ── Earn: everything a rep can still win ──────────────────────────────────────
function EarnTab({ band }: { band: AwardBand }) {
  return (
    <div className="space-y-4" data-testid="earn-tab">
      {/* The live hot-streak offer, above everything — it is the only card with
          a deadline in minutes. */}
      <MomentumOffer />

      {/* The ramp bonus sits at the very top for the two weeks it exists. For a
          new hire it is the only bonus on this page they can actually clear
          today, so burying it under contests aimed at closers would hide the
          one thing that is theirs. It disappears on day 15. */}
      <RampBonusSection />

      <CampaignBoard />

      {/* The two standing, reachable bonuses: a full day on the doors, and the
          sales ladder. Both are always on and neither needs anyone to launch
          it, which is exactly why they belong on the screen every day. */}
      <DoorDaySection />

      <AchievementSection />

      {/* The standing knock ladder, under the contests. A campaign may or may
          not be running; this one always is. */}
      <MilestoneSection />

      {/* Drops last of the standing programs. Everything above is something a
          rep can aim at; this is the one they cannot, so it reads as a footnote
          to the plan rather than part of it — which is exactly its job. */}
      <DoorDropSection />

      {/* The engine's surprise bonuses, spelled out from live config so the
          rules can never drift from the copy. */}
      <EarnGuide band={band} />
    </div>
  );
}

// ── Activity: the ledger ──────────────────────────────────────────────────────
function ActivityTab({ band }: { band: AwardBand }) {
  const { data, isLoading, isError } = useMine();
  return (
    <div className="space-y-2" data-testid="my-spiffs">
      <SectionLabel>Recent bonuses</SectionLabel>
      {isLoading ? (
        <div className="space-y-2" data-testid="my-spiffs-loading" aria-busy="true">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[72px] w-full rounded-2xl" />)}
        </div>
      ) : isError ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load your bonuses" bordered testId="my-spiffs-error"
          description="Something went wrong reading the bonus ledger. Pull to refresh, or try again in a moment." />
      ) : !data || data.spiffs.length === 0 ? (
        <EmptyState icon={Gift} title="No bonuses yet" bordered testId="my-spiffs-empty"
          description={`Log a sale and you're in the running for a ${usd(band.minCents)}-${usd(band.maxCents)} bonus. Some drop at random; the rest come from streaks, milestones, and beating your own average.`} />
      ) : (
        <ul className="space-y-2" data-testid="my-spiff-list">
          {data.spiffs.map((s) => {
            const st = statusCopy(s.status);
            return (
              <li key={s.id} data-testid={`spiff-${s.id}`}
                  className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
                
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    {/* The amount is the hero: biggest thing on the row. */}
                    <span className="text-lg font-bold tabular-nums tracking-tight text-foreground"
                          data-testid={`spiff-amount-${s.id}`}>
                      {usd(s.amountCents)}
                    </span>
                    <span className="text-[13px] font-semibold text-foreground">
                      {spiffReasonLabel(s.reason as SpiffReason)}
                    </span>
                  </div>
                  <p className="truncate text-[13px] text-muted-foreground">{spiffReasonBlurb(s.reason as SpiffReason)}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", st.className)}
                        title={st.hint} data-testid={`spiff-status-${s.id}`}>
                    {st.label}
                  </span>
                  <span className="text-[11px] tabular-nums text-muted-foreground" data-testid={`spiff-when-${s.id}`}>
                    {whenLabel(s.createdAt)}
                  </span>
                  {/* The hint used to live only in title= — unreachable on the
                      phones this page is read on. Say it in visible text. */}
                  <span className="max-w-[140px] text-right text-2xs leading-tight text-muted-foreground/80">{st.hint}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Manager/admin: approve/pay queue + team heat ──────────────────────────────
// Order follows the job (Deel's action-required pattern): the money waiting on
// a decision leads, the leaderboard reads second. A manager without the admin
// capability sees only the heat table, as before.
function TeamHeat({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const { data, isLoading, isError } = useQuery<TeamResponse>({
    queryKey: ["/api/spiffs/team"],
    refetchInterval: 60_000,
  });

  const pending = data?.pending ?? [];
  const earnedRows = useMemo(() => pending.filter((s) => s.status === "earned"), [pending]);
  const approvedRows = useMemo(() => pending.filter((s) => s.status === "approved"), [pending]);
  const sumCents = (rows: SpiffRow[]) => rows.reduce((n, s) => n + (Number(s.amountCents) || 0), 0);
  const earnedCents = sumCents(earnedRows);
  const approvedCents = sumCents(approvedRows);

  // Selection lives on ids so a background refetch can never move the checkboxes
  // onto different rows; ids that vanish are dropped on the next render.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const visibleIds = useMemo(() => new Set(pending.map((s) => s.id)), [pending]);
  const liveSelected = useMemo(
    () => [...selected].filter((id) => visibleIds.has(id)),
    [selected, visibleIds],
  );
  const selectedRows = useMemo(
    () => pending.filter((s) => liveSelected.includes(s.id)),
    [pending, liveSelected],
  );
  const selectedEarned = selectedRows.filter((s) => s.status === "earned");
  const selectedApproved = selectedRows.filter((s) => s.status === "approved");

  const toggle = (id: number, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  const allSelected = pending.length > 0 && liveSelected.length === pending.length;
  const toggleAll = (on: boolean) => setSelected(on ? new Set(pending.map((s) => s.id)) : new Set());

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/spiffs/team"] });
    queryClient.invalidateQueries({ queryKey: ["/api/spiffs/mine"] });
  };

  const transition = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "approve" | "paid" }) => {
      const res = await apiRequest("POST", `/api/spiffs/${id}/${action}`);
      return res.json();
    },
    onSuccess: (_row, { action }) => {
      invalidate();
      toast({ title: action === "approve" ? "Bonus approved" : "Bonus marked paid" });
    },
    onError: (err: any) => toast({ title: "Couldn't update bonus", description: String(err?.message ?? err), variant: "destructive" }),
  });

  const bulk = useMutation({
    mutationFn: async ({ ids, action }: { ids: number[]; action: "approve" | "paid" }) => {
      const res = await apiRequest("POST", `/api/spiffs/bulk/${action}`, { ids });
      return res.json() as Promise<{ changed: SpiffRow[]; skipped: Array<{ id: number }>; totalCents: number }>;
    },
    onSuccess: (result, { action }) => {
      invalidate();
      setSelected(new Set());
      const n = result?.changed?.length ?? 0;
      const skipped = result?.skipped?.length ?? 0;
      toast({
        title: action === "approve"
          ? `Approved ${n} bonus${n === 1 ? "" : "es"} - ${usd(result?.totalCents ?? 0)}`
          : `Marked ${n} bonus${n === 1 ? "" : "es"} paid - ${usd(result?.totalCents ?? 0)}`,
        description: skipped > 0 ? `${skipped} already handled by someone else.` : undefined,
      });
    },
    onError: (err: any) => toast({ title: "Bulk action failed", description: String(err?.message ?? err), variant: "destructive" }),
  });

  const busy = transition.isPending || bulk.isPending;

  // "Mark paid" settles a bonus once, permanently (the page says so in its own
  // header) — it gets a real confirm restating count + dollars, like Messages'
  // retract and the payout submit. Approve stays one-click: it creates an owed
  // state, it doesn't settle money. `bulk` preserves which ENDPOINT the tap
  // came from — a one-row bulk selection still settles via the bulk route.
  const [confirmPaid, setConfirmPaid] = useState<{ ids: number[]; totalCents: number; bulk: boolean } | null>(null);

  return (
    <section className="space-y-4" data-testid="team-heat">
      {/* Labels sized for a 375px phone: three tiles share the row, so each
          gets two words at most or the strip truncates into "Awaiting ap…". */}
      {isAdmin && (
        <StatStrip columns={3}>
          <StatTile label="To approve" accent testId="queue-total-earned"
            value={usd(earnedCents)} icon={BadgeCheck}
            delta={<span className="text-[11px] font-semibold tabular-nums text-muted-foreground">{earnedRows.length}</span>} />
          <StatTile label="To pay" testId="queue-total-approved"
            value={usd(approvedCents)} icon={Wallet}
            delta={<span className="text-[11px] font-semibold tabular-nums text-muted-foreground">{approvedRows.length}</span>} />
          <StatTile label="Open" testId="queue-total-open"
            value={usd(earnedCents + approvedCents)} icon={Gift} />
        </StatStrip>
      )}

      {isAdmin && (
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <SectionLabel>Approve &amp; pay</SectionLabel>
            <p className="text-[11px] text-muted-foreground">
              Approving owes it. Marking paid settles it - once, permanently.
            </p>
          </div>

          {isLoading ? (
            <div className="space-y-2" data-testid="spiff-queue-loading" aria-busy="true">
              {[0, 1].map((i) => <Skeleton key={i} className="h-16 w-full rounded-2xl" />)}
            </div>
          ) : pending.length === 0 ? (
            // A failed read must never wear the all-clear face — "Nothing to
            // approve" on an error would tell an admin the money is handled
            // when the truth is unknown.
            isError ? (
              <EmptyState icon={AlertTriangle} title="Couldn't load the queue" bordered testId="spiff-queue-error"
                description="The bonus queue didn't load. Try again in a moment." />
            ) : (
              <EmptyState icon={CheckCheck} title="Nothing to approve" tone="positive" bordered testId="spiff-queue-empty"
                description="Every bonus is settled. New ones land here the moment they are awarded." />
            )
          ) : (
            <div className="rounded-2xl border border-border bg-card">
              {/* Bulk bar — the whole queue is drivable from the keyboard: tab to
                  the select-all box, space to toggle, tab to the bulk buttons. */}
              <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
                <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-foreground">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(v) => toggleAll(v === true)}
                    aria-label="Select every bonus in the queue"
                    data-testid="queue-select-all"
                    className={FOCUS}
                  />
                  <span data-testid="queue-selection-count">
                    {liveSelected.length > 0 ? `${liveSelected.length} selected` : "Select all"}
                  </span>
                </label>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy || selectedEarned.length === 0}
                    onClick={() => bulk.mutate({ ids: selectedEarned.map((s) => s.id), action: "approve" })}
                    data-testid="bulk-approve"
                    className={cn(
                      "inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-50",
                      FOCUS,
                    )}
                  >
                    {bulk.isPending
                      ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      : null}
                    Approve {selectedEarned.length > 0 ? `${selectedEarned.length} · ${usd(sumCents(selectedEarned))}` : "selected"}
                  </button>
                  <button
                    type="button"
                    disabled={busy || selectedApproved.length === 0}
                    onClick={() => setConfirmPaid({ ids: selectedApproved.map((s) => s.id), totalCents: sumCents(selectedApproved), bulk: true })}
                    data-testid="bulk-paid"
                    className={cn(
                      "inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-secondary px-3 text-[13px] font-semibold text-foreground disabled:opacity-50",
                      FOCUS,
                    )}
                  >
                    
                    Mark paid {selectedApproved.length > 0 ? `${selectedApproved.length} · ${usd(sumCents(selectedApproved))}` : ""}
                  </button>
                </div>
              </div>

              <ul className="divide-y divide-border" data-testid="spiff-queue">
                {pending.map((s) => {
                  const st = statusCopy(s.status);
                  const checked = liveSelected.includes(s.id);
                  return (
                    <li key={s.id} data-testid={`queue-spiff-${s.id}`} className="flex items-center gap-3 p-3">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => toggle(s.id, v === true)}
                        aria-label={`Select ${usd(s.amountCents)} bonus for ${s.repName ?? `rep ${s.repId}`}`}
                        data-testid={`queue-select-${s.id}`}
                        className={FOCUS}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-base font-bold tabular-nums tracking-tight text-foreground"
                                data-testid={`queue-amount-${s.id}`}>
                            {usd(s.amountCents)}
                          </span>
                          <span className="truncate text-[13px] font-medium text-foreground">{s.repName ?? `Rep ${s.repId}`}</span>
                          <span className="text-[13px] text-muted-foreground">
                            {spiffReasonLabel(s.reason as SpiffReason)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", st.className)}
                                data-testid={`queue-status-${s.id}`}>
                            {st.label}
                          </span>
                          <span className="text-[11px] tabular-nums text-muted-foreground">{whenLabel(s.createdAt)}</span>
                        </div>
                      </div>
                      {s.status === "earned" ? (
                        <button type="button" disabled={busy}
                          onClick={() => transition.mutate({ id: s.id, action: "approve" })}
                          data-testid={`approve-${s.id}`}
                          className={cn(
                            "inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-50",
                            FOCUS,
                          )}>
                           Approve
                        </button>
                      ) : (
                        <button type="button" disabled={busy}
                          onClick={() => setConfirmPaid({ ids: [s.id], totalCents: s.amountCents, bulk: false })}
                          data-testid={`paid-${s.id}`}
                          className={cn(
                            "inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl bg-secondary px-3 text-sm font-semibold text-foreground disabled:opacity-50",
                            FOCUS,
                          )}>
                           Mark paid
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      <div>
        <SectionLabel className="mb-2">Team heat - the algorithm's read</SectionLabel>
        {isLoading ? (
          <div className="space-y-2" data-testid="team-heat-loading" aria-busy="true">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full rounded-2xl" />)}
          </div>
        ) : data && data.reps.length > 0 ? (
          // Data first, error second: a failed background refetch must not
          // blank a table the last good response already filled.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-separate border-spacing-y-1.5 text-sm">
              <caption className="sr-only">Rep heat scores and bonus totals</caption>
              <thead>
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-3 py-1">Rep</th>
                  <th scope="col" className="px-3 py-1 w-40">Heat</th>
                  <th scope="col" className="px-3 py-1 text-right">Streak</th>
                  <th scope="col" className="px-3 py-1 text-right">Pace/day</th>
                  <th scope="col" className="px-3 py-1 text-right">Recent</th>
                  <th scope="col" className="px-3 py-1 text-right">Bonuses</th>
                </tr>
              </thead>
              <tbody>
                {data.reps.map((r) => (
                  <tr key={r.repId} className="bg-card" data-testid={`heat-row-${r.repId}`}>
                    <td className="rounded-l-xl px-3 py-2 font-medium text-foreground">{r.name ?? `Rep ${r.repId}`}</td>
                    <td className="px-3 py-2"><HeatMeter heat={r.heat} testId={`heat-meter-${r.repId}`} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.snapshot.currentStreakDays}d</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.snapshot.salesVelocityPerDay.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.snapshot.recentSalesCount}</td>
                    <td className="rounded-r-xl px-3 py-2 text-right tabular-nums font-semibold text-foreground">
                      {usd(r.earnedCents + r.approvedCents + r.paidCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : isError ? (
          <EmptyState icon={AlertTriangle} title="Couldn't load team heat" bordered testId="team-heat-error"
            description="The heat read failed. Try again in a moment." />
        ) : (
          <EmptyState icon={Flame} title="No heat data yet" bordered description="Rep heat appears here as sales come in." />
        )}
      </div>

      {/* Settle confirm - restates count and dollars; the action is permanent. */}
      <AlertDialog open={!!confirmPaid} onOpenChange={(v) => !v && setConfirmPaid(null)}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>Mark {confirmPaid?.ids.length === 1 ? "this bonus" : `${confirmPaid?.ids.length ?? 0} bonuses`} paid?</AlertDialogTitle>
            <AlertDialogDescription>
              {usd(confirmPaid?.totalCents ?? 0)} will be recorded as settled. Do this after the money
              actually moves - marking paid is permanent and can't be undone here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border">Not yet</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-mark-paid"
              onClick={() => {
                if (!confirmPaid) return;
                if (confirmPaid.bulk) bulk.mutate({ ids: confirmPaid.ids, action: "paid" });
                else transition.mutate({ id: confirmPaid.ids[0], action: "paid" });
                setConfirmPaid(null);
              }}>
              Mark paid - {usd(confirmPaid?.totalCents ?? 0)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

// ── Manage: launch campaigns + configure the standing programs ────────────────
// The editors live behind disclosures. Both are always-on money faucets whose
// forms run to a dozen fields; a manager comes here at most weekly, and an open
// form on every visit is how the queue ended up below the fold in the old
// layout. The launcher stays open - launching IS the frequent task.
function ConfigDisclosure({ title, description, children, testId }: {
  icon: LucideIcon; title: string; description: string; children: ReactNode; testId?: string;
}) {
  return (
    <details className="group overflow-hidden rounded-2xl border border-border bg-card" data-testid={testId}>
      <summary className={cn(
        "flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-2.5 [&::-webkit-details-marker]:hidden",
        "transition-colors hover:bg-secondary/50",
        FOCUS,
      )}>
        
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-foreground">{title}</span>
          <span className="block text-xs text-muted-foreground">{description}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="border-t border-border p-4">{children}</div>
    </details>
  );
}

function ManageTab() {
  return (
    <div className="space-y-4" data-testid="manage-tab">
      <CampaignLauncher />
      <div className="space-y-2">
        <SectionLabel>Standing programs</SectionLabel>
        <ConfigDisclosure icon={Footprints} title="Door bonus ladder" testId="manage-milestones"
          description="The always-on knock ladder - rungs, rewards, and what a perfect week costs.">
          <MilestoneLadderEditor />
        </ConfigDisclosure>
        <ConfigDisclosure icon={Gift} title="Door drops" testId="manage-drops"
          description="Random drops on verified doors - odds, awards, caps, and the daily bill.">
          <DoorDropEditor />
        </ConfigDisclosure>
      </div>
    </div>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────
type TabKey = "earn" | "activity" | "team" | "manage";

function TabButton({ id, label, active, onSelect, badge }: {
  id: TabKey; label: string; active: boolean; onSelect: (id: TabKey) => void; badge?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(id)}
      data-testid={`tab-${id}`}
      className={cn(
        "inline-flex h-11 md:h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition-colors",
        active ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
        FOCUS,
      )}
    >
      {label}
      {typeof badge === "number" && badge > 0 && (
        <span className="rounded-full bg-primary px-1.5 py-0.5 text-2xs font-bold leading-none tabular-nums text-primary-foreground"
              data-testid={`tab-${id}-badge`}>
          {badge}
        </span>
      )}
    </button>
  );
}

export default function Incentives() {
  const { user } = useAuth();
  const role = user?.role;
  const isManager = role === "manager" || role === "admin" || role === "super_admin";
  const isAdmin = role === "admin" || role === "super_admin";
  // Launching a campaign COMMITS MONEY, so it rides the same capability as
  // editing the commission plan (team lead and up) - not the manager role check
  // above, which would silently hide it from the team leads who hold the
  // permission on the server.
  const canLaunch = can(role as AppRole | undefined, "commission.structure.manage");
  const repKey = user?.teamMemberId ?? user?.id ?? "anon";

  const [tab, setTab] = useState<TabKey>("earn");
  const mine = useMine();
  const band = useAwardBand(mine.data?.band);

  // The team query is fetched at page level for managers so the Team tab can
  // wear the open-item count BEFORE anyone opens it - the Deel "action
  // required (n)" pattern. Same key as TeamHeat's own query, so it is one
  // request, not two. Badge only for admins: they are the ones who can act.
  const team = useQuery<TeamResponse>({
    queryKey: ["/api/spiffs/team"],
    refetchInterval: 60_000,
    enabled: isManager,
  });
  const openCount = isAdmin ? (team.data?.pending.length ?? 0) : 0;

  // A role change (or late-resolving auth) can strand `tab` on a tab the new
  // viewer does not have. Snap back rather than rendering an empty pane.
  const available: TabKey[] = ["earn", "activity", ...(isManager ? ["team" as const] : []), ...(canLaunch ? ["manage" as const] : [])];
  const activeTab = available.includes(tab) ? tab : "earn";

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 pt-5 pb-24 md:p-6">
      <PageHeader
        title="Incentives"
        icon={Gift}
        subtitle="Every bonus you can earn - training, doors, sales - on top of commission."
      />

      {/* Keyed on identity: if auth resolves late (or the viewer changes), the
          "already seen" bookmark is re-read for the RIGHT person rather than
          carrying another rep's state. */}
      <RevealSlot key={String(repKey)} repKey={repKey} />

      <MoneyHero data={mine.data} isLoading={mine.isLoading} isError={mine.isError} />

      <div className="inline-flex w-full rounded-xl border border-border bg-card p-1"
           role="tablist" aria-label="Incentives sections">
        <TabButton id="earn" label="Earn" active={activeTab === "earn"} onSelect={setTab} />
        <TabButton id="activity" label="Activity" active={activeTab === "activity"} onSelect={setTab} />
        {isManager && (
          <TabButton id="team" label="Team" active={activeTab === "team"} onSelect={setTab} badge={openCount} />
        )}
        {canLaunch && (
          <TabButton id="manage" label="Manage" active={activeTab === "manage"} onSelect={setTab} />
        )}
      </div>

      {activeTab === "earn" && <EarnTab band={band} />}
      {activeTab === "activity" && <ActivityTab band={band} />}
      {activeTab === "team" && isManager && <TeamHeat isAdmin={isAdmin} />}
      {activeTab === "manage" && canLaunch && <ManageTab />}
    </div>
  );
}
