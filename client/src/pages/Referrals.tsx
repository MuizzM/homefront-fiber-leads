// ── Referrals — the rep's link and pipeline, the admin's approval queue ─────
//
// The progress a rep stares at and the rule an admin's approval enforces come
// from the SAME server evaluation (`qualification.requirements`), never from a
// second calculation in the client. A progress bar that lies is worse than no
// progress bar: a rep who is told they are at 6 of 6 and then sees a rejection
// stops trusting the whole program.

import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RejectReasonDialog } from "@/components/RejectReasonDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useCan } from "@/lib/capabilities";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Check, X, Settings } from "lucide-react";
import { PageHeader, SectionLabel } from "@/components/ui/page-scaffold";

interface Requirement {
  key: string; label: string; met: boolean; current?: number; target?: number;
}
interface Referral {
  id: number; referrerRepId: number; referrerName?: string;
  referredName: string | null; referredEmail: string | null;
  status: string; qualifyingSalesCount: number; rewardAmountCents: number;
  qualifiedAt: string | null; createdAt: string; stageIndex: number;
}
interface MyLink {
  code: string; url: string; clickCount: number;
  programEnabled: boolean; rewardCents: number; requiredApprovedSales: number;
}
interface Progress {
  referral: Referral;
  qualification: { qualified: boolean; requirements: Requirement[]; salesRemaining: number; progress: number; blocked: string | null };
  rewardCents: number; requiredApprovedSales: number;
  releasable: { releasable: boolean; daysRemaining: number };
}

// Sign-preserving: a clawback is negative money and must render that way —
// the old formatter ran Math.abs and printed −$150 as "$150".
const money = (cents: number) => {
  const abs = Math.abs(cents);
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}${abs % 100 ? `.${String(abs % 100).padStart(2, "0")}` : ""}`;
};

// Human labels for the raw DB enum — users were reading "REWARD_PENDING" and
// "CLAWED_BACK" verbatim, underscores included.
const STATUS_LABEL: Record<string, string> = {
  CLICKED: "Invited",
  APPLIED: "Applied",
  HIRED: "Hired",
  ACTIVATED: "Activated",
  IN_PROGRESS: "In progress",
  QUALIFIED: "Qualified",
  REWARD_PENDING: "Pending approval",
  APPROVED: "Approved",
  PAID: "Paid",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  CLAWED_BACK: "Reversed",
};

const STATUS_TONE: Record<string, string> = {
  CLICKED: "bg-muted text-muted-foreground",
  APPLIED: "bg-muted text-muted-foreground",
  HIRED: "bg-sky-500/15 text-info",
  ACTIVATED: "bg-sky-500/15 text-info",
  IN_PROGRESS: "bg-amber-500/15 text-warning",
  QUALIFIED: "bg-emerald-500/15 text-success",
  REWARD_PENDING: "bg-emerald-500/15 text-success",
  APPROVED: "bg-emerald-600/20 text-success",
  PAID: "bg-emerald-600/20 text-success",
  REJECTED: "bg-destructive/15 text-destructive",
  EXPIRED: "bg-destructive/10 text-muted-foreground",
  CLAWED_BACK: "bg-destructive/15 text-destructive",
};

// Rows where the sales-progress bar is meaningful: the referee is hired and
// counting, or already made it. Terminal failures explain themselves in the
// checklist instead of wearing a frozen bar.
const SALES_BAR_STATUSES = new Set([
  "HIRED", "ACTIVATED", "IN_PROGRESS", "QUALIFIED", "REWARD_PENDING", "APPROVED", "PAID",
]);

interface Settings {
  enabled: boolean; rewardCents: number; requiredApprovedSales: number;
  qualificationWindowDays: number; clawbackWindowDays: number;
  attributionWindowDays: number;
  requireTrainingComplete: boolean; requireActiveStatus: boolean;
  liability: { pendingCents: number; approvedCents: number; inProgress: number };
}
interface MyStatus {
  attributed: boolean;
  rewardState: "none" | "in_progress" | "in_review" | "approved" | "paid" | "unavailable";
  salesProgress: { current: number; target: number } | null;
  milestones: { hired: boolean; activated: boolean; trainingComplete: boolean };
  headline: string;
}
interface HistoryRow {
  id: number; eventType: string; metadata: string | null; createdAt: string;
}

const get = <T,>(url: string) => apiRequest("GET", url).then(r => r.json() as Promise<T>);

// ── The hero: what referring pays ───────────────────────────────────────────
// Venmo/Setel via Mobbin: the promise as money first, the rule in one
// sentence, and the live pipeline summarized - never a marketing panel.
function ReferralHero() {
  const { data: link } = useQuery<MyLink>({
    queryKey: ["/api/referrals/my-link"],
    queryFn: () => get<MyLink>("/api/referrals/my-link"),
  });
  const { data: referrals = [] } = useQuery<Referral[]>({
    queryKey: ["/api/referrals", "mine"],
    queryFn: () => get<Referral[]>("/api/referrals"),
  });
  if (!link || !link.programEnabled) return null;

  const sum = (statuses: string[]) =>
    referrals.filter(r => statuses.includes(r.status)).reduce((n, r) => n + r.rewardAmountCents, 0);
  const paidCents = sum(["PAID"]);
  const inReviewCents = sum(["QUALIFIED", "REWARD_PENDING", "APPROVED"]);
  const working = referrals.filter(r => ["HIRED", "ACTIVATED", "IN_PROGRESS"].includes(r.status)).length;

  return (
    <Card className="rounded-2xl" data-testid="referral-hero">
      <CardContent className="p-4">
        <SectionLabel>Referral earnings</SectionLabel>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-3xl font-bold tabular-nums leading-none tracking-tight text-gold-text"
                data-testid="referral-earned">
            {money(paidCents)}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {inReviewCents > 0 && (
              <span data-testid="referral-in-review"
                    className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
                {money(inReviewCents)} in review
              </span>
            )}
            <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-success">
              {money(link.rewardCents)} per hire
            </span>
          </span>
        </div>
        <p className="mt-2 text-[13px] text-muted-foreground" data-testid="referral-rule">
          Refer a future rep. When they're hired, finish training, and close{" "}
          {link.requiredApprovedSales} verified sales, {money(link.rewardCents)} lands in your bonus
          ledger.{working > 0 ? ` ${working} referral${working === 1 ? "" : "s"} working toward it now.` : ""}
        </p>
      </CardContent>
    </Card>
  );
}

// ── My link ─────────────────────────────────────────────────────────────────

function MyLinkCard() {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const { data: link, isLoading, isError, error, refetch } = useQuery<MyLink>({
    queryKey: ["/api/referrals/my-link"],
    queryFn: () => get<MyLink>("/api/referrals/my-link"),
  });

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (isError) {
    // Owner/admin logins are valid without a field-rep profile. The API
    // deliberately refuses to mint a money-bearing referral code until the
    // login is linked to one, so render that expected account state as setup
    // guidance rather than telling the operator the portal is broken.
    if (error instanceof ApiError && error.code === "NO_REP") {
      return (
        <Card data-testid="referral-link-unlinked">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Personal referral link unavailable</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>This administrator login is not linked to a field-rep profile, so it cannot receive referral credit.</p>
            <p>Link the login to the correct person in Team management only if this account should earn referral rewards.</p>
            <a href="#/team" className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4">
              Open Team management
            </a>
          </CardContent>
        </Card>
      );
    }
    // Returning null here deleted the whole "Refer a rep" card on a network
    // blip — the rep had no link and no explanation.
    return (
      <Card role="alert" data-testid="referral-link-error">
        <CardContent className="flex items-center gap-3 py-4">
          <p className="flex-1 text-sm text-muted-foreground">Couldn't load your referral link.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }
  if (!link) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is permission-gated and fails silently in some contexts;
      // showing the URL is the fallback that always works.
      toast({ title: "Copy failed - select the link below instead" });
    }
  };

  return (
    <Card data-testid="referral-my-link">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          Refer a rep
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!link.programEnabled ? (
          // Honest rather than hopeful: showing a link and a dollar figure for a
          // programme nobody has switched on is a promise the org has not made.
          <p className="flex items-start gap-2 text-sm text-muted-foreground" data-testid="referral-program-off">
            
            The referral programme is not running right now. Your link still works for tracking,
            but no reward is being earned.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Earn <strong className="text-foreground">{money(link.rewardCents)}</strong> when someone you
            refer is hired, finishes training, and closes {link.requiredApprovedSales} approved sales.
          </p>
        )}

        <div className="flex min-w-0 items-center gap-2">
          {/* A readonly field keeps the long URL on one calm line without
              hiding it: focus selects the complete value, so manual copy still
              works when clipboard permission is denied. `min-w-0` is what lets
              the field shrink instead of widening a 375px viewport. */}
          <input
            type="url"
            readOnly
            value={link.url}
            onFocus={(event) => event.currentTarget.select()}
            aria-label="Personal referral link"
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-muted px-3 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="referral-url"
          />
          <Button className="shrink-0" size="sm" variant="outline" onClick={copy} data-testid="referral-copy">
            {copied ? <Check className="h-4 w-4" /> : null}
            <span>{copied ? "Copied" : "Copy link"}</span>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Code <span className="font-mono">{link.code}</span> · {link.clickCount} click{link.clickCount === 1 ? "" : "s"}
        </p>
      </CardContent>
    </Card>
  );
}

// ── The qualification checklist ─────────────────────────────────────────────

function QualificationChecklist({ referralId }: { referralId: number }) {
  const { data } = useQuery<Progress>({
    queryKey: [`/api/referrals/${referralId}/progress`],
    queryFn: () => get<Progress>(`/api/referrals/${referralId}/progress`),
  });
  if (!data) return null;

  const sales = data.qualification.requirements.find(r => r.key === "sales");

  return (
    <div className="mt-3 space-y-3 rounded-md border p-3" data-testid={`referral-checklist-${referralId}`}>
      {sales && (
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Approved sales</span>
            <span className="font-medium tabular-nums" data-testid={`referral-sales-${referralId}`}>
              {sales.current ?? 0} of {sales.target}
            </span>
          </div>
          <Progress value={Math.round(data.qualification.progress * 100)} className="h-2" />
        </div>
      )}

      <ul className="space-y-1">
        {data.qualification.requirements.map(r => (
          <li key={r.key} className="flex items-center gap-2 text-xs">
            {/* An unmet requirement rendered nothing, so its label started 5.5px
                left of the met ones - the checklist read as ragged. Both states
                now occupy the same 3.5 slot (token success, not raw emerald). */}
            {r.met
              ? <Check className="h-3.5 w-3.5 shrink-0 text-success" />
              : <span className="h-3.5 w-3.5 shrink-0 grid place-items-center" aria-hidden="true"><span className="h-1.5 w-1.5 rounded-full border border-muted-foreground/50" /></span>}
            <span className={r.met ? "text-foreground" : "text-muted-foreground"}>{r.label}</span>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between border-t pt-2 text-xs">
        <span className="text-muted-foreground">Expected reward</span>
        <span className="font-medium tabular-nums">{money(data.rewardCents)}</span>
      </div>

      {data.qualification.blocked === "window_expired" && (
        // "Never" is a different fact from "not yet", and a rep is owed the
        // difference rather than a bar that sits still forever.
        <p className="text-xs text-destructive" data-testid={`referral-expired-${referralId}`}>
          The qualification window has closed, so this referral can no longer qualify.
        </p>
      )}
      {data.qualification.qualified && !data.releasable.releasable && (
        <p className="text-xs text-muted-foreground" data-testid={`referral-holding-${referralId}`}>
          Qualified. The reward is held for {data.releasable.daysRemaining} more day
          {data.releasable.daysRemaining === 1 ? "" : "s"} in case a sale cancels.
        </p>
      )}
    </div>
  );
}

// ── Pipeline ────────────────────────────────────────────────────────────────

function Pipeline({ scope }: { scope: "mine" | "org" }) {
  const { toast } = useToast();
  const canApprove = useCan("referral.approve");
  const [expanded, setExpanded] = useState<number | null>(null);
  // Approving releases a cash reward - arm-then-confirm (the app's standard
  // two-tap guard for irreversible money actions), never a single tap.
  const [armedApprove, setArmedApprove] = useState<number | null>(null);
  useEffect(() => {
    if (armedApprove == null) return;
    const t = setTimeout(() => setArmedApprove(null), 4000);
    return () => clearTimeout(t);
  }, [armedApprove]);

  const { data: referrals = [], isLoading, isError, refetch } = useQuery<Referral[]>({
    queryKey: ["/api/referrals", scope],
    queryFn: () => get<Referral[]>(`/api/referrals${scope === "org" ? "?scope=org" : ""}`),
  });
  // The live rule (target + reward) for the always-visible progress bar on a
  // rep's own rows. Same cache key as the link card - one request.
  const { data: myLink } = useQuery<MyLink>({
    queryKey: ["/api/referrals/my-link"],
    queryFn: () => get<MyLink>("/api/referrals/my-link"),
    enabled: scope === "mine",
  });

  const [rejectRef, setRejectRef] = useState<Referral | null>(null);
  const decide = useMutation({
    mutationFn: ({ id, action, reason }: { id: number; action: "approve" | "reject"; reason?: string }) =>
      apiRequest("POST", `/api/referrals/${id}/${action}`, reason ? { reason } : {}).then(async r => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed");
        return json;
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/referrals"] }); setRejectRef(null); },
    onError: (e: any) => toast({ title: "Could not update the referral", description: String(e?.message ?? ""), variant: "destructive" }),
  });

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  return (
    <Card data-testid={`referral-pipeline-${scope}`}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
           {scope === "org" ? "All referrals" : "My referrals"}
          <Badge variant="secondary">{referrals.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isError ? (
          // A failed fetch is not "no referrals" — that empty copy told reps
          // their pipeline was gone.
          <div role="alert" className="py-6 text-center">
            <p className="text-sm text-muted-foreground">Couldn't load referrals - nothing has changed.</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
          </div>
        ) : referrals.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {scope === "org" ? "No referrals yet." : "No referral activity yet. New referrals will appear here."}
          </p>
        ) : referrals.map(r => (
          <div key={r.id} className="border-b py-3 last:border-0" data-testid={`referral-row-${r.id}`}>
            <div className="flex items-start justify-between gap-3">
              <button
                className="min-w-0 flex-1 text-left"
                onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                data-testid={`referral-expand-${r.id}`}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {r.referredName ?? r.referredEmail ?? "Applicant"}
                  </span>
                  <Badge className={STATUS_TONE[r.status] ?? ""} variant="secondary">{STATUS_LABEL[r.status] ?? r.status}</Badge>
                </div>
                {scope === "org" ? (
                  <p className="text-xs text-muted-foreground">
                    Referred by {r.referrerName} · {r.qualifyingSalesCount} approved sale{r.qualifyingSalesCount === 1 ? "" : "s"}
                  </p>
                ) : SALES_BAR_STATUSES.has(r.status) && myLink ? (
                  // The number a referrer actually watches: how close their
                  // referee is to the six sales that release the reward. On the
                  // row, always - not behind the expand.
                  <div className="mt-1.5 flex items-center gap-2.5">
                    <Progress
                      value={Math.min(100, Math.round((r.qualifyingSalesCount / Math.max(1, myLink.requiredApprovedSales)) * 100))}
                      className="h-1.5 flex-1"
                    />
                    <span className="shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground"
                          data-testid={`referral-row-sales-${r.id}`}>
                      {r.qualifyingSalesCount} of {myLink.requiredApprovedSales} sales
                    </span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {r.qualifyingSalesCount} approved sale{r.qualifyingSalesCount === 1 ? "" : "s"}
                  </p>
                )}
              </button>
              <div className="flex shrink-0 items-center gap-2">
                {/* Before qualification the frozen amount is 0 - show the LIVE
                    prospective reward on a rep's own rows so the row reads
                    "this is worth $500", not "$0". Org rows keep the frozen
                    figure: that is the number an approval releases. */}
                <span className="text-sm tabular-nums">
                  {money(scope === "mine" && r.rewardAmountCents === 0 && SALES_BAR_STATUSES.has(r.status) && myLink
                    ? myLink.rewardCents : r.rewardAmountCents)}
                </span>
                {canApprove && r.status === "REWARD_PENDING" && (
                  <>
                    <Button size="sm" variant="outline" data-testid={`referral-approve-${r.id}`}
                      aria-label={armedApprove === r.id
                        ? `Confirm: release the ${money(r.rewardAmountCents)} reward?`
                        : `Approve the ${money(r.rewardAmountCents)} reward for ${r.referredName ?? r.referredEmail ?? "this referral"}`}
                      aria-pressed={armedApprove === r.id}
                      className={armedApprove === r.id ? "border-emerald-500/50 text-emerald-500" : undefined}
                      disabled={decide.isPending}
                      onClick={() => {
                        if (armedApprove === r.id) { setArmedApprove(null); decide.mutate({ id: r.id, action: "approve" }); }
                        else setArmedApprove(r.id);
                      }}>
                      {armedApprove === r.id ? <span className="text-xs font-semibold px-0.5">Release {money(r.rewardAmountCents)}?</span> : <Check className="h-4 w-4" aria-hidden="true" />}
                    </Button>
                    <Button size="sm" variant="ghost" data-testid={`referral-reject-${r.id}`}
                      aria-label="Reject this referral with a reason"
                      disabled={decide.isPending}
                      onClick={() => setRejectRef(r)}>
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </>
                )}
              </div>
            </div>
            {expanded === r.id && (
              <>
                <QualificationChecklist referralId={r.id} />
                {scope === "org" && <AuditHistory referralId={r.id} />}
              </>
            )}
          </div>
        ))}
      </CardContent>
      <RejectReasonDialog
        open={rejectRef != null}
        onOpenChange={o => !o && setRejectRef(null)}
        title="Reject this referral?"
        description={rejectRef ? `${rejectRef.referredName ?? rejectRef.referredEmail ?? "This referral"} will be rejected and your reason written to the audit trail.` : undefined}
        label="Reason for rejection"
        placeholder="e.g. Not a real referral, or already credited"
        confirmLabel="Reject referral"
        busy={decide.isPending}
        onConfirm={reason => rejectRef && decide.mutate({ id: rejectRef.id, action: "reject", reason })}
      />
    </Card>
  );
}

// ── The referred person's own view ──────────────────────────────────────────

/**
 * Shown to someone who was REFERRED, about the referral they are the subject of.
 *
 * Renders only what the server sent, and the server sends no amount, no
 * referrer identity, and no reason for a decline. There is deliberately nothing
 * here that derives or infers those — a client that reconstructed a reward
 * figure from the programme settings would defeat the redaction entirely.
 */
function MyReferralStatus() {
  const { data } = useQuery<MyStatus>({
    queryKey: ["/api/referrals/my-status"],
    queryFn: () => get<MyStatus>("/api/referrals/my-status"),
  });

  // Nobody referred this person — say nothing rather than showing an empty
  // card that implies they missed out on something.
  if (!data || !data.attributed) return null;

  const TONE: Record<MyStatus["rewardState"], string> = {
    none: "text-muted-foreground",
    in_progress: "text-warning",
    in_review: "text-info",
    approved: "text-success",
    paid: "text-success",
    unavailable: "text-muted-foreground",
  };

  return (
    <Card data-testid="my-referral-status">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
           Your referral
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className={`text-sm ${TONE[data.rewardState]}`} data-testid="my-referral-headline">
          {data.headline}
        </p>

        {data.salesProgress && (
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Approved sales</span>
              <span className="font-medium tabular-nums" data-testid="my-referral-sales">
                {data.salesProgress.current} of {data.salesProgress.target}
              </span>
            </div>
            <Progress
              value={Math.round((data.salesProgress.current / Math.max(1, data.salesProgress.target)) * 100)}
              className="h-2"
            />
          </div>
        )}

        <ul className="space-y-1">
          {([
            ["Hired", data.milestones.hired],
            ["Account activated", data.milestones.activated],
            ["Training complete", data.milestones.trainingComplete],
          ] as const).map(([label, met]) => (
            <li key={label} className="flex items-center gap-2 text-xs">
              {met
                ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                : null}
              <span className={met ? "text-foreground" : "text-muted-foreground"}>{label}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ── Admin tracker ───────────────────────────────────────────────────────────

/**
 * What the programme is COSTING, split three ways.
 *
 * In-progress, pending and approved are shown as separate figures rather than
 * one total, for the same reason the mileage and earnings summaries do it: a
 * referral that has qualified but is still inside its clawback window is a
 * different kind of number from one an admin has released, and blending them
 * overstates what the org actually owes.
 */
function LiabilityCard({ settings }: { settings: Settings }) {
  const l = settings.liability;
  return (
    <Card data-testid="referral-liability">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
           Programme liability
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 divide-y divide-border text-left sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:text-center">
        <div className="py-3 sm:px-3 sm:py-0">
          <p className="text-xs text-muted-foreground">In progress</p>
          <p className="text-lg font-semibold tabular-nums" data-testid="referral-liability-inprogress">{l.inProgress}</p>
          <p className="text-[11px] text-muted-foreground">referrals working</p>
        </div>
        <div className="py-3 sm:px-3 sm:py-0">
          <p className="text-xs text-muted-foreground">Qualified, holding</p>
          <p className="text-lg font-semibold tabular-nums" data-testid="referral-liability-pending">{money(l.pendingCents)}</p>
          <p className="text-[11px] text-muted-foreground">may still claw back</p>
        </div>
        <div className="py-3 sm:px-3 sm:py-0">
          <p className="text-xs text-muted-foreground">Approved</p>
          <p className="text-lg font-semibold tabular-nums" data-testid="referral-liability-approved">{money(l.approvedCents)}</p>
          <p className="text-[11px] text-muted-foreground">owed now</p>
        </div>
      </CardContent>
    </Card>
  );
}

function SettingsCard({ settings }: { settings: Settings }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState({
    rewardDollars: String(settings.rewardCents / 100),
    requiredApprovedSales: String(settings.requiredApprovedSales),
    qualificationWindowDays: String(settings.qualificationWindowDays),
    clawbackWindowDays: String(settings.clawbackWindowDays),
  });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest("PUT", "/api/referrals/settings", body).then(async r => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed");
        return json;
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/referrals/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/referrals"] });
      toast({ title: "Referral settings saved" });
    },
    onError: (e: any) => toast({ title: "Could not save", description: String(e?.message ?? ""), variant: "destructive" }),
  });

  const num = (v: string) => Math.trunc(Number(v));

  return (
    <Card data-testid="referral-settings">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
           Referral settings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* The health warning, in the one place an admin can fix it. A silent
            OFF state is how the program stayed dark for weeks. */}
        {!settings.enabled && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-medium text-warning"
             data-testid="referral-disabled-warning">
            The referral program is OFF. Referrers earn nothing for qualified hires until it is
            turned on below.
          </p>
        )}
        <div className="flex items-center justify-between rounded-md border p-3">
          <div className="pr-4">
            <Label htmlFor="ref-enabled" className="text-sm font-medium">Programme running</Label>
            <p className="text-xs text-muted-foreground">
              While this is off, links still work for tracking but no applicant is attributed
              and no reward is created.
            </p>
          </div>
          <Switch
            id="ref-enabled" checked={settings.enabled} data-testid="referral-enabled"
            onCheckedChange={(enabled) => save.mutate({ enabled })}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="ref-reward" className="text-xs">Reward ($)</Label>
            <Input id="ref-reward" inputMode="decimal" data-testid="referral-reward"
              value={draft.rewardDollars}
              onChange={e => setDraft(d => ({ ...d, rewardDollars: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="ref-sales" className="text-xs">Approved sales required</Label>
            <Input id="ref-sales" inputMode="numeric" data-testid="referral-required-sales"
              value={draft.requiredApprovedSales}
              onChange={e => setDraft(d => ({ ...d, requiredApprovedSales: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="ref-window" className="text-xs">Qualification window (days)</Label>
            <Input id="ref-window" inputMode="numeric" data-testid="referral-qualification-window"
              value={draft.qualificationWindowDays}
              onChange={e => setDraft(d => ({ ...d, qualificationWindowDays: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="ref-clawback" className="text-xs">Clawback hold (days)</Label>
            <Input id="ref-clawback" inputMode="numeric" data-testid="referral-clawback-window"
              value={draft.clawbackWindowDays}
              onChange={e => setDraft(d => ({ ...d, clawbackWindowDays: e.target.value }))} />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Changing these affects referrals that have not qualified yet. A referral that already
          met the bar keeps the terms it qualified under.
        </p>

        <Button
          className="w-full" data-testid="referral-save-settings" disabled={save.isPending}
          onClick={() => save.mutate({
            rewardCents: Math.round(Number(draft.rewardDollars) * 100),
            requiredApprovedSales: num(draft.requiredApprovedSales),
            qualificationWindowDays: num(draft.qualificationWindowDays),
            clawbackWindowDays: num(draft.clawbackWindowDays),
          })}
        >
          Save settings
        </Button>
      </CardContent>
    </Card>
  );
}

/** The append-only funnel history — what happened to this referral and when. */
function AuditHistory({ referralId }: { referralId: number }) {
  const { data: rows = [] } = useQuery<HistoryRow[]>({
    queryKey: [`/api/referrals/${referralId}/history`],
    queryFn: () => get<HistoryRow[]>(`/api/referrals/${referralId}/history`),
  });
  if (rows.length === 0) return null;
  return (
    <div className="mt-2 rounded-md border p-3" data-testid={`referral-history-${referralId}`}>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
         History
      </p>
      <ol className="space-y-1">
        {rows.map(r => (
          <li key={r.id} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="font-medium">{r.eventType}</span>
            <span className="text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Referrals() {
  const canSeeOrg = useCan("referral.read.org");
  const canConfigure = useCan("referral.settings.manage");

  const { data: settings } = useQuery<Settings>({
    queryKey: ["/api/referrals/settings"],
    queryFn: () => get<Settings>("/api/referrals/settings"),
    // Only org readers may call this at all; asking as a rep would 403 on every
    // render and fill the console with noise.
    enabled: canSeeOrg,
  });

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 pb-24" data-testid="referrals-page">
      {/* The live promise (amount + sales bar) renders in the hero from server
          config - the subtitle stays generic so the header can never disagree
          with settings an admin later edits. */}
      <PageHeader
        title="Referrals"
        subtitle="Refer the next rep and earn the bonus when their sales verify."
      />

      {/* Every rep sees their own link and pipeline first — this page is
          primarily theirs, and the admin tracker sits below it. */}
      {/* If this person was themselves referred, their own status comes first —
          it is the thing they are most likely to have opened the page for. */}
      <MyReferralStatus />
      <ReferralHero />
      <MyLinkCard />
      <Pipeline scope="mine" />

      {canSeeOrg && settings && <LiabilityCard settings={settings} />}
      {canSeeOrg && <Pipeline scope="org" />}
      {canConfigure && settings && <SettingsCard settings={settings} />}
    </div>
  );
}
