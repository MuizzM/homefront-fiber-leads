// ── Referrals — the rep's link and pipeline, the admin's approval queue ─────
//
// The progress a rep stares at and the rule an admin's approval enforces come
// from the SAME server evaluation (`qualification.requirements`), never from a
// second calculation in the client. A progress bar that lies is worse than no
// progress bar: a rep who is told they are at 6 of 6 and then sees a rejection
// stops trusting the whole program.

import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useCan } from "@/lib/capabilities";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Check, Copy, Gift, Users, X, AlertCircle, Settings, History, TrendingUp } from "lucide-react";

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

const money = (cents: number) =>
  `$${Math.floor(Math.abs(cents) / 100).toLocaleString("en-US")}${cents % 100 ? `.${String(Math.abs(cents) % 100).padStart(2, "0")}` : ""}`;

const STATUS_TONE: Record<string, string> = {
  APPLIED: "bg-muted text-muted-foreground",
  HIRED: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  ACTIVATED: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  IN_PROGRESS: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  QUALIFIED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  REWARD_PENDING: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  APPROVED: "bg-emerald-600/20 text-emerald-800 dark:text-emerald-300",
  PAID: "bg-emerald-600/20 text-emerald-800 dark:text-emerald-300",
  REJECTED: "bg-destructive/15 text-destructive",
  EXPIRED: "bg-destructive/10 text-muted-foreground",
  CLAWED_BACK: "bg-destructive/15 text-destructive",
};

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

// ── My link ─────────────────────────────────────────────────────────────────

function MyLinkCard() {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const { data: link, isLoading } = useQuery<MyLink>({
    queryKey: ["/api/referrals/my-link"],
    queryFn: () => get<MyLink>("/api/referrals/my-link"),
  });

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!link) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is permission-gated and fails silently in some contexts;
      // showing the URL is the fallback that always works.
      toast({ title: "Copy failed — select the link below instead" });
    }
  };

  return (
    <Card data-testid="referral-my-link">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gift className="h-4 w-4" /> Refer a rep
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!link.programEnabled ? (
          // Honest rather than hopeful: showing a link and a dollar figure for a
          // programme nobody has switched on is a promise the org has not made.
          <p className="flex items-start gap-2 text-sm text-muted-foreground" data-testid="referral-program-off">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            The referral programme is not running right now. Your link still works for tracking,
            but no reward is being earned.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Earn <strong className="text-foreground">{money(link.rewardCents)}</strong> when someone you
            refer is hired, finishes training, and closes {link.requiredApprovedSales} approved sales.
          </p>
        )}

        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 text-xs" data-testid="referral-url">
            {link.url}
          </code>
          <Button size="sm" variant="outline" onClick={copy} data-testid="referral-copy">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            <span className="ml-2">{copied ? "Copied" : "Copy"}</span>
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
            {r.met
              ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
              : <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
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

  const { data: referrals = [], isLoading } = useQuery<Referral[]>({
    queryKey: ["/api/referrals", scope],
    queryFn: () => get<Referral[]>(`/api/referrals${scope === "org" ? "?scope=org" : ""}`),
  });

  const decide = useMutation({
    mutationFn: ({ id, action, reason }: { id: number; action: "approve" | "reject"; reason?: string }) =>
      apiRequest("POST", `/api/referrals/${id}/${action}`, reason ? { reason } : {}).then(async r => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed");
        return json;
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/referrals"] }),
    onError: (e: any) => toast({ title: "Could not update the referral", description: String(e?.message ?? ""), variant: "destructive" }),
  });

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  return (
    <Card data-testid={`referral-pipeline-${scope}`}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4" /> {scope === "org" ? "All referrals" : "My referrals"}
          <Badge variant="secondary">{referrals.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {referrals.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {scope === "org" ? "No referrals yet." : "Share your link to get started."}
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
                  <Badge className={STATUS_TONE[r.status] ?? ""} variant="secondary">{r.status}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {scope === "org" ? `Referred by ${r.referrerName} · ` : ""}
                  {r.qualifyingSalesCount} approved sale{r.qualifyingSalesCount === 1 ? "" : "s"}
                </p>
              </button>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-sm tabular-nums">{money(r.rewardAmountCents)}</span>
                {canApprove && r.status === "REWARD_PENDING" && (
                  <>
                    <Button size="sm" variant="outline" data-testid={`referral-approve-${r.id}`}
                      onClick={() => decide.mutate({ id: r.id, action: "approve" })}>
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" data-testid={`referral-reject-${r.id}`}
                      onClick={() => {
                        const reason = window.prompt("Why is this referral being rejected?");
                        if (reason?.trim()) decide.mutate({ id: r.id, action: "reject", reason: reason.trim() });
                      }}>
                      <X className="h-4 w-4" />
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
    in_progress: "text-amber-700 dark:text-amber-400",
    in_review: "text-sky-700 dark:text-sky-400",
    approved: "text-emerald-700 dark:text-emerald-400",
    paid: "text-emerald-700 dark:text-emerald-400",
    unavailable: "text-muted-foreground",
  };

  return (
    <Card data-testid="my-referral-status">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gift className="h-4 w-4" /> Your referral
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
                : <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
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
          <TrendingUp className="h-4 w-4" /> Programme liability
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-4 text-center">
        <div>
          <p className="text-xs text-muted-foreground">In progress</p>
          <p className="text-lg font-semibold tabular-nums" data-testid="referral-liability-inprogress">{l.inProgress}</p>
          <p className="text-[11px] text-muted-foreground">referrals working</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Qualified, holding</p>
          <p className="text-lg font-semibold tabular-nums" data-testid="referral-liability-pending">{money(l.pendingCents)}</p>
          <p className="text-[11px] text-muted-foreground">may still claw back</p>
        </div>
        <div>
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
          <Settings className="h-4 w-4" /> Referral settings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
        <History className="h-3.5 w-3.5" /> History
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
      <h1 className="text-xl font-semibold">Referrals</h1>

      {/* Every rep sees their own link and pipeline first — this page is
          primarily theirs, and the admin tracker sits below it. */}
      {/* If this person was themselves referred, their own status comes first —
          it is the thing they are most likely to have opened the page for. */}
      <MyReferralStatus />
      <MyLinkCard />
      <Pipeline scope="mine" />

      {canSeeOrg && settings && <LiabilityCard settings={settings} />}
      {canSeeOrg && <Pipeline scope="org" />}
      {canConfigure && settings && <SettingsCard settings={settings} />}
    </div>
  );
}
