import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowRight, Check, CheckCircle2, ClipboardCheck, Clock3, Copy,
  DollarSign, Download, FileCheck2, FileText, Filter, KeyRound, Layers, Link2,
  Loader2, Mail, MapPin, RefreshCw, RotateCw, Search, Send, ShieldCheck,
  TrendingUp, UserCheck, UserPlus, Users, XCircle,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { downloadOnboardingDocument } from "@/lib/onboardingDocuments";
import type { OnboardingDocumentType } from "@shared/onboardingDocuments";

type PipelineStage =
  | "invited" | "under_review" | "approved" | "login_code_sent"
  | "agreements_issued" | "partially_signed" | "fully_signed" | "active"
  | "rejected" | "failed";

interface PipelineDocument {
  type: OnboardingDocumentType;
  label: string;
  required: boolean;
  status: string;
  envelopeId: number | null;
  sentAt: string | null;
  completedAt: string | null;
}

interface PipelineRecord {
  key: string;
  inviteId: number | null;
  applicationId: number | null;
  candidateName: string;
  candidateEmail: string;
  source: "invited" | "careers" | "public_join";
  desiredRole: string | null;
  stage: PipelineStage;
  progress: { completed: number; total: number };
  milestones: {
    invited: boolean; applied: boolean; approved: boolean; loginCodeSent: boolean;
    agreementsIssued: boolean; signedCount: number; fullySigned: boolean; active: boolean;
  };
  invite: null | {
    status: string; sentAt: string | null; expiresAt: string | null; deliveryAttempts: number;
    failureReason: string | null; secureUrl: string;
  };
  application: null | {
    status: string; phone: string; city: string; state: string; zip: string;
    preferredCarriers: string; hasSalesExperience: boolean; salesExperienceDetails: string | null;
    referralSource: string | null; headshotPath: string | null; licensePath: string | null;
    reviewNotes: string | null; createdAt: string;
  };
  account: null | { userId: number; repId: number | null; active: boolean };
  documents: PipelineDocument[];
  timeline: Array<{ label: string; at: string; done: boolean }>;
}

interface PipelineResponse {
  configured: boolean;
  summary: { total: number; needsAction: number; inProgress: number; active: number };
  records: PipelineRecord[];
}

const STAGES: Record<PipelineStage, { label: string; tone: string; dot: string; next: string }> = {
  invited: { label: "Invited", tone: "bg-sky-500/10 text-sky-400 border-sky-500/20", dot: "bg-sky-400", next: "Waiting for application" },
  under_review: { label: "Needs review", tone: "bg-amber-500/10 text-amber-400 border-amber-500/20", dot: "bg-amber-400", next: "Review and approve" },
  approved: { label: "Approved", tone: "bg-blue-500/10 text-blue-400 border-blue-500/20", dot: "bg-blue-400", next: "Send access and documents" },
  login_code_sent: { label: "Login sent", tone: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20", dot: "bg-cyan-400", next: "Confirm agreements" },
  agreements_issued: { label: "Awaiting signatures", tone: "bg-violet-500/10 text-violet-400 border-violet-500/20", dot: "bg-violet-400", next: "Waiting for signatures" },
  partially_signed: { label: "Partially signed", tone: "bg-orange-500/10 text-orange-400 border-orange-500/20", dot: "bg-orange-400", next: "Complete remaining agreements" },
  fully_signed: { label: "Fully signed", tone: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20", dot: "bg-emerald-400", next: "Finalizing activation" },
  active: { label: "Active rep", tone: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20", dot: "bg-emerald-400", next: "Onboarding complete" },
  rejected: { label: "Rejected", tone: "bg-rose-500/10 text-rose-400 border-rose-500/20", dot: "bg-rose-400", next: "Closed" },
  failed: { label: "Delivery failed", tone: "bg-rose-500/10 text-rose-400 border-rose-500/20", dot: "bg-rose-400", next: "Resend invitation" },
};

const FILTERS = ["all", "needs_action", "in_progress", "active", "closed"] as const;
type FilterKey = typeof FILTERS[number];
type Structure = "TIERED" | "FLAT";

function StagePill({ stage }: { stage: PipelineStage }) {
  const meta = STAGES[stage];
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${meta.tone}`}><span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />{meta.label}</span>;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not yet" : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function documentTone(status: string) {
  if (status === "completed") return "text-emerald-400 bg-emerald-500/10 border-emerald-500/20";
  if (["sent", "delivered"].includes(status)) return "text-violet-400 bg-violet-500/10 border-violet-500/20";
  if (status === "failed") return "text-rose-400 bg-rose-500/10 border-rose-500/20";
  return "text-muted-foreground bg-secondary border-border";
}

export default function Applications() {
  const { user } = useAuth();
  const { toast } = useToast();
  const canManage = user?.role === "admin" || user?.role === "manager";
  const canReview = user?.role === "admin";
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [structure, setStructure] = useState<Structure>("TIERED");
  const [flatRate, setFlatRate] = useState("150");
  const [reviewNotes, setReviewNotes] = useState("");

  const pipeline = useQuery<PipelineResponse>({
    queryKey: ["/api/onboarding/pipeline"],
    queryFn: () => apiRequest("GET", "/api/onboarding/pipeline").then(response => response.json()),
    enabled: canManage,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const records = pipeline.data?.records ?? [];
  const filtered = useMemo(() => records.filter(record => {
    const term = search.trim().toLowerCase();
    if (term && !`${record.candidateName} ${record.candidateEmail}`.toLowerCase().includes(term)) return false;
    if (filter === "needs_action") return ["under_review", "failed"].includes(record.stage);
    if (filter === "in_progress") return ["approved", "login_code_sent", "agreements_issued", "partially_signed", "fully_signed"].includes(record.stage);
    if (filter === "active") return record.stage === "active";
    if (filter === "closed") return record.stage === "rejected";
    return true;
  }), [records, filter, search]);

  useEffect(() => {
    if (selectedKey && records.some(record => record.key === selectedKey)) return;
    const preferred = records.find(record => ["under_review", "failed"].includes(record.stage)) ?? records[0];
    setSelectedKey(preferred?.key ?? null);
  }, [records, selectedKey]);

  const selected = records.find(record => record.key === selectedKey) ?? null;

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["/api/onboarding/pipeline"] });
    queryClient.invalidateQueries({ queryKey: ["/api/onboarding/applications"] });
  }

  const inviteMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/onboarding/invitations", { name: inviteName.trim(), email: inviteEmail.trim() }).then(response => response.json()),
    onSuccess: (data: any) => {
      setInviteName(""); setInviteEmail(""); refresh();
      toast({ title: "Private invitation sent", description: `${data.invitation.candidateName} received a secure 14-day application link.` });
    },
    onError: (error: any) => toast({ title: "Invitation not sent", description: error.message, variant: "destructive" }),
  });

  const reviewMutation = useMutation({
    mutationFn: ({ status }: { status: "approved" | "rejected" }) => {
      if (!selected?.applicationId) throw new Error("Application not found");
      const commission = status === "approved"
        ? structure === "FLAT" ? { structure, flatRateCents: Math.round(Number(flatRate || 0) * 100) } : { structure }
        : undefined;
      return apiRequest("PATCH", `/api/onboarding/applications/${selected.applicationId}`, { status, reviewNotes: reviewNotes || null, commission }).then(response => response.json());
    },
    onSuccess: (data: any, variables) => {
      refresh();
      toast({
        title: variables.status === "approved" ? "Onboarding started" : "Application rejected",
        description: variables.status === "approved"
          ? data.onboardingWarning || data.welcomeWarning || "Account, login code, commission plan, and four agreements were processed."
          : "The candidate record is closed and remains in the audit trail.",
        variant: data.onboardingWarning || data.welcomeWarning ? "destructive" : "default",
      });
    },
    onError: (error: any) => toast({ title: "Review failed", description: error.message, variant: "destructive" }),
  });

  const actionMutation = useMutation({
    mutationFn: ({ action, inviteId }: { action: "invite" | "login" | "documents"; inviteId: number }) => {
      const path = action === "invite"
        ? `/api/onboarding/invitations/${inviteId}/resend`
        : `/api/onboarding/pipeline/${inviteId}/resend-${action}`;
      return apiRequest("POST", path, {}).then(response => response.json());
    },
    onSuccess: (_data, variables) => {
      refresh();
      toast({ title: variables.action === "invite" ? "Invitation resent" : variables.action === "login" ? "New login code sent" : "Agreement email sent safely" });
    },
    onError: (error: any) => toast({ title: "Action failed", description: error.message, variant: "destructive" }),
  });

  async function copySecureLink(record: PipelineRecord) {
    if (!record.invite?.secureUrl) return;
    await navigator.clipboard.writeText(record.invite.secureUrl);
    setCopiedKey(record.key);
    setTimeout(() => setCopiedKey(null), 2000);
    toast({ title: "Private link copied", description: "The link is candidate-specific and expires after 14 days." });
  }

  if (!canManage) return <div className="grid h-full place-items-center"><div className="text-center text-muted-foreground"><AlertTriangle className="mx-auto mb-2 h-8 w-8 text-amber-400" /><p>Manager or Admin access required</p></div></div>;

  const summary = pipeline.data?.summary ?? { total: 0, needsAction: 0, inProgress: 0, active: 0 };

  return (
    <div className="mx-auto max-w-[1440px] p-4 sm:p-5 lg:p-6" data-testid="onboarding-console">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary"><ShieldCheck className="h-3.5 w-3.5" />Recruiting operations</div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Rep onboarding</h1>
          <p className="mt-1 text-sm text-muted-foreground">Invite, review, issue agreements, and activate every rep from one queue.</p>
        </div>
        <button onClick={() => pipeline.refetch()} className="inline-flex h-10 items-center justify-center gap-2 self-start rounded-xl border border-border px-3 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground" data-testid="refresh-onboarding"><RefreshCw className={`h-4 w-4 ${pipeline.isFetching ? "animate-spin" : ""}`} />Refresh</button>
      </header>

      <section className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Onboarding summary">
        {[
          { label: "Pipeline", value: summary.total, icon: Users, tone: "text-sky-400" },
          { label: "Needs action", value: summary.needsAction, icon: ClipboardCheck, tone: "text-amber-400" },
          { label: "In progress", value: summary.inProgress, icon: Clock3, tone: "text-violet-400" },
          { label: "Active", value: summary.active, icon: UserCheck, tone: "text-emerald-400" },
        ].map(metric => <div key={metric.label} className="rounded-2xl border border-border bg-card p-3.5"><div className="flex items-center justify-between"><span className="text-xs font-medium text-muted-foreground">{metric.label}</span><metric.icon className={`h-4 w-4 ${metric.tone}`} /></div><div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{metric.value}</div></div>)}
      </section>

      <section className="mb-4 rounded-2xl border border-border bg-card p-4" aria-label="Invite a candidate">
        <div className="flex items-start gap-3"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><UserPlus className="h-4 w-4" /></div><div><h2 className="text-sm font-semibold text-foreground">Invite a potential rep</h2><p className="mt-0.5 text-xs text-muted-foreground">Creates the onboarding record first, then emails a candidate-specific private link.</p></div></div>
        <form className="mt-3 grid gap-2 sm:grid-cols-[1fr_1.25fr_auto]" onSubmit={event => { event.preventDefault(); if (!inviteMutation.isPending) inviteMutation.mutate(); }}>
          <label className="sr-only" htmlFor="invite-candidate-name">Candidate full name</label><input id="invite-candidate-name" value={inviteName} onChange={event => setInviteName(event.target.value)} required minLength={2} maxLength={120} placeholder="Candidate full name" className="h-10 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" data-testid="input-candidate-name" />
          <label className="sr-only" htmlFor="invite-candidate-email">Candidate email</label><input id="invite-candidate-email" type="email" value={inviteEmail} onChange={event => setInviteEmail(event.target.value)} required maxLength={254} placeholder="candidate@email.com" className="h-10 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" data-testid="input-candidate-email" />
          <button type="submit" disabled={!pipeline.data?.configured || !inviteName.trim() || !inviteEmail.trim() || inviteMutation.isPending} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50" data-testid="send-candidate-invite">{inviteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}Send private invite</button>
        </form>
        {pipeline.data && !pipeline.data.configured && <p className="mt-2 text-xs text-amber-400">Resend must be connected before invitations can be sent.</p>}
      </section>

      <div className="grid min-h-[620px] gap-4 xl:grid-cols-[minmax(420px,0.9fr)_minmax(560px,1.25fr)]">
        <section className="overflow-hidden rounded-2xl border border-border bg-card" aria-label="Candidate onboarding queue">
          <div className="border-b border-border p-3">
            <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search candidates" className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary" /></div>
            <div className="mt-2 flex gap-1 overflow-x-auto pb-1" aria-label="Pipeline filters"><Filter className="mr-1 mt-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />{FILTERS.map(key => <button key={key} onClick={() => setFilter(key)} className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium ${filter === key ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}>{key.replace(/_/g, " ")}</button>)}</div>
          </div>
          <div className="max-h-[720px] overflow-y-auto">
            {pipeline.isLoading && <div className="grid h-48 place-items-center text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>}
            {!pipeline.isLoading && !filtered.length && <div className="p-10 text-center"><Users className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" /><p className="text-sm font-medium text-foreground">No candidates in this view</p><p className="mt-1 text-xs text-muted-foreground">Send a private invite or change the filters.</p></div>}
            {filtered.map(record => {
              const selectedRow = record.key === selectedKey;
              const percent = Math.round((record.progress.completed / record.progress.total) * 100);
              return <button key={record.key} onClick={() => setSelectedKey(record.key)} className={`render-lazy w-full border-b border-border p-4 text-left transition-colors last:border-0 ${selectedRow ? "bg-primary/[0.07]" : "hover:bg-secondary/50"}`} data-testid={`pipeline-record-${record.key}`}>
                <div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-foreground">{record.candidateName.split(/\s+/).map(part => part[0]).slice(0, 2).join("").toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold text-foreground">{record.candidateName}</span><StagePill stage={record.stage} /></div><p className="mt-0.5 truncate text-xs text-muted-foreground">{record.candidateEmail}</p><p className="mt-1 text-2xs font-semibold uppercase tracking-wide text-primary/80">{record.source === "careers" ? "Website careers" : record.source === "invited" ? "Private invite" : "Public join link"}{record.desiredRole ? ` · ${record.desiredRole}` : ""}</p><div className="mt-3 flex items-center gap-2"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} /></div><span className="text-2xs font-semibold tabular-nums text-muted-foreground">{record.progress.completed}/{record.progress.total}</span></div><div className="mt-2 flex items-center justify-between text-[11px]"><span className="text-muted-foreground">{STAGES[record.stage].next}</span><ArrowRight className={`h-3.5 w-3.5 ${selectedRow ? "text-primary" : "text-muted-foreground"}`} /></div></div></div>
              </button>;
            })}
          </div>
        </section>

        <section className="min-w-0 rounded-2xl border border-border bg-card xl:sticky xl:top-4 xl:max-h-[calc(100vh-7rem)] xl:overflow-y-auto" aria-label="Candidate onboarding details">
          {!selected && <div className="grid h-full min-h-96 place-items-center p-8 text-center"><div><UserCheck className="mx-auto mb-3 h-9 w-9 text-muted-foreground/30" /><p className="text-sm font-medium text-foreground">Select a candidate</p><p className="mt-1 text-xs text-muted-foreground">Their full onboarding state will appear here.</p></div></div>}
          {selected && <>
            <div className="border-b border-border p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="mb-2"><StagePill stage={selected.stage} /></div><h2 className="truncate text-xl font-semibold tracking-tight text-foreground">{selected.candidateName}</h2><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span className="flex items-center gap-1"><Mail className="h-3 w-3" />{selected.candidateEmail}</span>{selected.application && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{selected.application.city}, {selected.application.state}</span>}</div></div>{selected.stage === "active" && <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-500/12 text-emerald-400"><CheckCircle2 className="h-5 w-5" /></div>}</div>
            </div>

            <div className="space-y-4 p-4 sm:p-5">
              <div className="rounded-xl border border-border bg-background/50 p-4"><div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Onboarding progression</h3><span className="text-xs font-semibold text-foreground">{selected.progress.completed} of {selected.progress.total}</span></div><div className="grid grid-cols-7 gap-1">{selected.timeline.map((step, index) => <div key={step.label} className="group relative"><div className={`h-1.5 rounded-full ${step.done ? "bg-primary" : "bg-secondary"}`} /><div className="pointer-events-none absolute right-0 top-3 z-10 hidden w-36 rounded-lg border border-border bg-popover p-2 text-2xs text-popover-foreground shadow-xl group-hover:block"><div className="font-semibold">{index + 1}. {step.label}</div><div className="mt-0.5 text-muted-foreground">{step.done ? formatDate(step.at) : "Pending"}</div></div></div>)}</div><div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground"><span>Invited</span><span>Active rep</span></div></div>

              {selected.invite && <div className="rounded-xl border border-border p-4"><div className="flex items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><Link2 className="h-4 w-4 text-sky-400" />{selected.milestones.applied ? "Invitation delivery" : "Private application link"}</h3><p className="mt-1 text-xs text-muted-foreground">{selected.milestones.applied ? `Application received ${formatDate(selected.timeline[1]?.at)}` : `Expires ${formatDate(selected.invite.expiresAt)}`} · {selected.invite.deliveryAttempts} delivery attempt{selected.invite.deliveryAttempts === 1 ? "" : "s"}</p></div>{!selected.milestones.applied && <div className="flex gap-2"><button onClick={() => copySecureLink(selected)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary" data-testid="copy-secure-invite">{copiedKey === selected.key ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}Copy</button>{["invited", "failed"].includes(selected.stage) && selected.inviteId && <button onClick={() => actionMutation.mutate({ action: "invite", inviteId: selected.inviteId! })} disabled={actionMutation.isPending} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground"><RotateCw className="h-3.5 w-3.5" />Resend</button>}</div>}</div>{selected.invite.failureReason && <p className="mt-2 rounded-lg bg-rose-500/8 px-3 py-2 text-xs text-rose-400">{selected.invite.failureReason}</p>}</div>}

              {selected.application && <div className="rounded-xl border border-border p-4"><div className="mb-3 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><ClipboardCheck className="h-4 w-4 text-amber-400" />Application review</h3><span className="text-[11px] text-muted-foreground">Applied {formatDate(selected.application.createdAt)}</span></div><div className="mb-2 flex flex-wrap gap-2 text-2xs font-semibold uppercase tracking-wide"><span className="rounded-full bg-primary/10 px-2 py-1 text-primary">{selected.source === "careers" ? "Website careers" : selected.source === "invited" ? "Private invite" : "Public join link"}</span>{selected.desiredRole && <span className="rounded-full bg-secondary px-2 py-1 text-muted-foreground">{selected.desiredRole}</span>}</div><div className="grid gap-2 text-xs sm:grid-cols-2"><div className="rounded-lg bg-secondary/50 p-3"><span className="text-muted-foreground">Phone</span><div className="mt-0.5 font-medium text-foreground">{selected.application.phone}</div></div><div className="rounded-lg bg-secondary/50 p-3"><span className="text-muted-foreground">Territory</span><div className="mt-0.5 font-medium text-foreground">{selected.application.city}, {selected.application.state} {selected.application.zip}</div></div><div className="rounded-lg bg-secondary/50 p-3"><span className="text-muted-foreground">Carriers</span><div className="mt-0.5 font-medium text-foreground">{selected.application.preferredCarriers}</div></div><div className="rounded-lg bg-secondary/50 p-3"><span className="text-muted-foreground">Sales experience</span><div className="mt-0.5 font-medium text-foreground">{selected.application.hasSalesExperience ? "Yes" : "No"}</div></div></div>{selected.application.salesExperienceDetails && <p className="mt-2 rounded-lg bg-secondary/50 p-3 text-xs text-muted-foreground">{selected.application.salesExperienceDetails}</p>}
                {selected.stage === "under_review" && canReview && <div className="mt-4 border-t border-border pt-4"><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Commission structure</h4><div className="grid grid-cols-2 gap-2"><button onClick={() => setStructure("TIERED")} className={`rounded-xl border p-3 text-left ${structure === "TIERED" ? "border-primary bg-primary/5" : "border-border"}`}><div className="flex items-center gap-2 text-xs font-semibold"><Layers className="h-4 w-4 text-primary" />Tiered</div><p className="mt-1 text-[11px] text-muted-foreground">Weekly retroactive ladder</p></button><button onClick={() => setStructure("FLAT")} className={`rounded-xl border p-3 text-left ${structure === "FLAT" ? "border-primary bg-primary/5" : "border-border"}`}><div className="flex items-center gap-2 text-xs font-semibold"><DollarSign className="h-4 w-4 text-primary" />Flat</div><p className="mt-1 text-[11px] text-muted-foreground">One rate per sale</p></button></div>{structure === "FLAT" && <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">Rate per sale $<input type="number" min="1" value={flatRate} onChange={event => setFlatRate(event.target.value)} className="h-9 w-24 rounded-lg border border-border bg-background px-2 text-foreground" /></label>}<textarea value={reviewNotes} onChange={event => setReviewNotes(event.target.value)} placeholder="Decision reason / internal review notes" maxLength={1000} className="mt-3 min-h-20 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-primary" /><div className="mt-3 flex gap-2"><button onClick={() => reviewMutation.mutate({ status: "approved" })} disabled={reviewMutation.isPending} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground" data-testid="approve-start-onboarding">{reviewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCheck className="h-4 w-4" />}Approve & start onboarding</button><button onClick={() => reviewMutation.mutate({ status: "rejected" })} disabled={reviewMutation.isPending} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold text-rose-400 hover:bg-rose-500/5"><XCircle className="h-4 w-4" />Reject</button></div></div>}
                {selected.stage === "under_review" && !canReview && <p className="mt-4 border-t border-border pt-4 text-xs text-muted-foreground">An administrator in this organization must approve or reject this application.</p>}
              </div>}

              {selected.milestones.approved && <div className="rounded-xl border border-border p-4"><div className="mb-3 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><KeyRound className="h-4 w-4 text-cyan-400" />Account access</h3><span className={`text-[11px] font-semibold ${selected.milestones.loginCodeSent ? "text-emerald-400" : "text-amber-400"}`}>{selected.milestones.loginCodeSent ? "Login code sent" : "Delivery pending"}</span></div><p className="text-xs text-muted-foreground">The rep account can access My Documents while the field-sales profile stays inactive until every required agreement is signed.</p>{selected.inviteId && <button onClick={() => actionMutation.mutate({ action: "login", inviteId: selected.inviteId! })} disabled={actionMutation.isPending} className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary"><RotateCw className="h-3.5 w-3.5" />Send a new login code</button>}</div>}

              {selected.milestones.approved && <div className="rounded-xl border border-border p-4"><div className="mb-3 flex items-center justify-between"><div><h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><FileCheck2 className="h-4 w-4 text-violet-400" />Required agreements</h3><p className="mt-1 text-xs text-muted-foreground">{selected.milestones.signedCount} of 4 signed</p></div>{selected.inviteId && <button onClick={() => actionMutation.mutate({ action: "documents", inviteId: selected.inviteId! })} disabled={actionMutation.isPending} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary"><RotateCw className="h-3.5 w-3.5" />Resend pending</button>}</div><div className="space-y-2">{selected.documents.map(document => <div key={document.type} className="flex items-center gap-3 rounded-xl bg-secondary/45 p-3"><div className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${documentTone(document.status)}`}>{document.status === "completed" ? <Check className="h-4 w-4" /> : <FileText className="h-4 w-4" />}</div><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-foreground">{document.label}</p><p className="mt-0.5 text-[11px] capitalize text-muted-foreground">{document.status.replace(/_/g, " ")}{document.completedAt ? ` · ${formatDate(document.completedAt)}` : ""}</p></div>{document.status === "completed" && document.envelopeId && <button onClick={() => downloadOnboardingDocument(document.envelopeId!, `${selected.candidateName}-${document.type}.pdf`)} className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-background hover:text-foreground" aria-label={`Download ${document.label}`}><Download className="h-4 w-4" /></button>}</div>)}</div></div>}

              <div className="rounded-xl border border-border p-4"><h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground"><TrendingUp className="h-4 w-4 text-primary" />Audit timeline</h3><div className="space-y-0">{selected.timeline.map((event, index) => <div key={event.label} className="flex gap-3"><div className="flex w-5 flex-col items-center"><span className={`mt-1.5 h-2 w-2 rounded-full ${event.done ? "bg-primary" : "bg-secondary ring-1 ring-border"}`} />{index < selected.timeline.length - 1 && <span className={`h-9 w-px ${event.done ? "bg-primary/40" : "bg-border"}`} />}</div><div className="pb-3"><p className={`text-xs font-medium ${event.done ? "text-foreground" : "text-muted-foreground"}`}>{event.label}</p><p className="mt-0.5 text-2xs text-muted-foreground">{event.done ? formatDate(event.at) : "Pending"}</p></div></div>)}</div></div>

              {selected.stage === "active" && <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/8 p-4"><div className="flex gap-3"><CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" /><div><h3 className="text-sm font-semibold text-emerald-300">Onboarding complete</h3><p className="mt-1 text-xs text-emerald-200/70">All four required agreements are signed. The rep’s field-sales profile is active.</p></div></div></div>}
            </div>
          </>}
        </section>
      </div>
    </div>
  );
}
