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
import { Check, Copy, Gift, Users, X, AlertCircle } from "lucide-react";

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
            {expanded === r.id && <QualificationChecklist referralId={r.id} />}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Referrals() {
  const canSeeOrg = useCan("referral.read.org");

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 pb-24" data-testid="referrals-page">
      <h1 className="text-xl font-semibold">Referrals</h1>
      <MyLinkCard />
      <Pipeline scope="mine" />
      {canSeeOrg && <Pipeline scope="org" />}
    </div>
  );
}
