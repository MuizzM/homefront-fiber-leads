import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ClipboardCheck, Clock3, Download, Loader2, RefreshCw, UserCheck, Users } from "lucide-react";
import { parseOverrideDollars, centsToDollarsDraft } from "@/lib/overrideMoney";
import { apiRequest, apiUpload, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { downloadOnboardingDocument } from "@/lib/onboardingDocuments";
import { CompTermsEditor } from "@/components/onboarding/CompTermsEditor";
import { copyText } from "@/lib/clipboard";
import { DEFAULT_COMMISSION_TERMS, normalizeCommissionTerms, type CommissionTerms } from "@shared/commissionTerms";
import type { CommissionTier } from "@shared/commissionTiers";
import type { OnboardingDocumentType } from "@shared/onboardingDocuments";
import { hrStatusLabel, type HrCheckpointKind, type HrCheckpointStatus } from "@shared/onboardingHr";
import { HIRABLE_ROLES, isValidSupervisorRole, type MemberRole } from "@shared/teamHierarchy";
import type { TeamMember } from "@shared/schema";

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

interface HrCheckpoint {
  kind: HrCheckpointKind;
  label: string;
  description: string;
  required: boolean;
  status: HrCheckpointStatus;
  statuses: HrCheckpointStatus[];
  provider: string | null;
  externalRef: string | null;
  hasBadgePhoto: boolean;
  notes: string | null;
  cleared: boolean;
  failed: boolean;
  completedAt: string | null;
  updatedAt: string | null;
}

interface HrState {
  cleared: number;
  total: number;
  allClear: boolean;
  anyFailed: boolean;
  checkpoints: HrCheckpoint[];
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
    // What was OFFERED. The approval panel opens on these, so the terms that
    // become pay are the terms the candidate was invited on unless a reviewer
    // deliberately changes them.
    commissionStructure: "FLAT" | "TIERED" | null;
    flatRateCents: number | null;
    reservePercent: number | null;
    reserveCapCents: number | null;
    commissionTiers: CommissionTier[] | null;
    // The org-chart half of the offer: what role the candidate was invited AS,
    // and who they were proposed to report to. Name + active ride along so the
    // review panel can flag a since-offboarded supervisor without a lookup.
    invitedRole: string | null;
    invitedSupervisorId: number | null;
    invitedSupervisorName: string | null;
    invitedSupervisorActive: boolean | null;
    // Per-hire override rates the hirer chose (null = inherit org default).
    invitedOverrideTeamLeadCents: number | null;
    invitedOverrideManagerCents: number | null;
    // Members the hirer picked for this leader to take over at approval.
    invitedDownlineIds: number[];
  };
  application: null | {
    status: string; phone: string; city: string; state: string; zip: string;
    preferredCarriers: string; hasSalesExperience: boolean; salesExperienceDetails: string | null;
    hasReliableTransportation: boolean | null;
    referralSource: string | null; headshotPath: string | null; licensePath: string | null;
    // Ad attribution captured by the careers site; null = pre-capture or untagged.
    channel: string | null; attribution: string | null;
    reviewNotes: string | null; createdAt: string;
  };
  account: null | { userId: number; repId: number | null; active: boolean };
  documents: PipelineDocument[];
  hr: HrState;
  timeline: Array<{ label: string; at: string; done: boolean }>;
}

interface PipelineResponse {
  configured: boolean;
  gustoConfigured: boolean;
  summary: { total: number; needsAction: number; inProgress: number; active: number };
  records: PipelineRecord[];
}

const STAGES: Record<PipelineStage, { label: string; tone: string; dot: string; next: string }> = {
  invited: { label: "Invited", tone: "bg-info/[0.08] text-info border-info/[0.12]", dot: "bg-info", next: "Waiting for application" },
  under_review: { label: "Needs review", tone: "bg-warning/[0.08] text-warning border-warning/[0.12]", dot: "bg-warning", next: "Review and approve" },
  approved: { label: "Approved", tone: "bg-info/[0.08] text-info border-info/[0.12]", dot: "bg-info", next: "Send access and documents" },
  login_code_sent: { label: "Login sent", tone: "bg-info/[0.08] text-info border-info/[0.12]", dot: "bg-info", next: "Confirm agreements" },
  agreements_issued: { label: "Awaiting signatures", tone: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20", dot: "bg-violet-400", next: "Waiting for signatures" },
  partially_signed: { label: "Partially signed", tone: "bg-warning/[0.08] text-warning border-warning/[0.12]", dot: "bg-warning", next: "Complete remaining agreements" },
  fully_signed: { label: "Fully signed", tone: "bg-success/[0.08] text-success border-success/[0.12]", dot: "bg-success", next: "Finalizing activation" },
  active: { label: "Active rep", tone: "bg-success/[0.08] text-success border-success/[0.12]", dot: "bg-success", next: "Onboarding complete" },
  rejected: { label: "Rejected", tone: "bg-destructive/[0.08] text-destructive border-destructive/[0.12]", dot: "bg-destructive", next: "Closed" },
  failed: { label: "Delivery failed", tone: "bg-destructive/[0.08] text-destructive border-destructive/[0.12]", dot: "bg-destructive", next: "Resend invitation" },
};

const FILTERS = ["all", "needs_action", "in_progress", "active", "closed"] as const;
type FilterKey = typeof FILTERS[number];

function StagePill({ stage }: { stage: PipelineStage }) {
  const meta = STAGES[stage];
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${meta.tone}`}><span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />{meta.label}</span>;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not yet" : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const MEMBER_ROLE_LABEL: Record<MemberRole, string> = { rep: "Sales Rep", team_lead: "Team Lead", manager: "Manager" };
const memberRoleLabel = (role: string) => MEMBER_ROLE_LABEL[role as MemberRole] ?? role;



function hrTone(checkpoint: HrCheckpoint) {
  if (checkpoint.failed) return "text-destructive bg-destructive/[0.08] border-destructive/[0.12]";
  if (checkpoint.cleared) return "text-success bg-success/[0.08] border-success/[0.12]";
  if (checkpoint.status !== "not_started") return "text-warning bg-warning/[0.08] border-warning/[0.12]";
  return "text-muted-foreground bg-secondary border-border";
}

// Badge photo is served through an authed, tenant-walled endpoint; a native
// image request can't carry the session header, so fetch it as a blob (the same
// pattern used by the door-photo AuthedImg in PropertyDetail).
function BadgePhoto({ applicationId, cacheKey, alt }: { applicationId: number; cacheKey: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let objectUrl = "";
    setUrl(null);
    apiRequest("GET", `/api/onboarding/applications/${applicationId}/hr/badge-photo`)
      .then(response => response.blob())
      .then(blob => { if (!alive) return; objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); })
      .catch(() => { /* no photo yet */ });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [applicationId, cacheKey]);
  if (!url) return <div className="grid h-16 w-16 shrink-0 place-items-center rounded-lg bg-secondary"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  return <img src={url} alt={alt} className="h-16 w-16 shrink-0 rounded-lg object-cover" />;
}

function ApplicantFileReview({
  applicationId,
  kind,
  label,
  present,
}: {
  applicationId: number;
  kind: "headshot" | "license";
  label: string;
  present: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState<{ url: string; type: string } | null>(null);

  useEffect(() => () => { if (file?.url) URL.revokeObjectURL(file.url); }, [file?.url]);

  const openReview = async () => {
    if (!present) return;
    if (file) { setExpanded(current => !current); return; }
    setLoading(true);
    setError("");
    try {
      const response = await apiRequest("GET", `/api/onboarding/applications/${applicationId}/files/${kind}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      setFile({ url, type: blob.type || response.headers.get("content-type") || "application/octet-stream" });
      setExpanded(true);
    } catch (requestError: any) {
      setError(requestError?.message || `Could not open ${label.toLowerCase()}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-secondary/25 p-3" data-testid={`applicant-file-${kind}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">{label}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{present ? "Supplied by applicant · review before approval" : "Not supplied"}</p>
        </div>
        <button
          type="button"
          onClick={openReview}
          disabled={!present || loading}
          className="inline-flex h-9 shrink-0 items-center rounded-lg border border-border bg-background px-3 text-xs font-semibold text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
          data-testid={`review-applicant-${kind}`}
          aria-expanded={expanded}
        >
          {loading ? "Opening…" : expanded ? "Hide" : "Review"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>}
      {expanded && file && (
        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-slate-100" data-testid={`applicant-${kind}-viewer`}>
          <div className="flex items-center justify-between gap-2 border-b border-border bg-background px-3 py-2">
            <span className="text-[11px] font-semibold text-foreground">Verify that the name, face, and document are readable.</span>
            <button type="button" onClick={() => window.open(file.url, "_blank", "noopener,noreferrer")} className="text-[11px] font-semibold text-primary underline underline-offset-2">Open full size</button>
          </div>
          {file.type === "application/pdf"
            ? <object data={file.url} type="application/pdf" title={`${label} supplied by applicant`} className="h-96 w-full"><p className="p-4 text-xs text-slate-700">This legacy PDF cannot be displayed here. Use Open full size.</p></object>
            : <img src={file.url} alt={`${label} supplied by applicant`} className="max-h-96 w-full object-contain" />}
        </div>
      )}
    </div>
  );
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
  // Comp terms the manager sets when sending the invite. These ride the invite →
  // application and seed the rep's plan + chargeback reserve at approval, and
  // they are what the candidate's commission agreement will state.
  //
  // ONE CommissionTerms object, edited by the same control the agreements panel
  // uses. It replaces four dollar-STRING fields that could only express "tiered"
  // as a word — there was nowhere to say WHICH tiers, so a TIERED invite carried
  // no ladder and every reader downstream substituted the house one. Integer
  // cents throughout now; the Math.round(Number(x) * 100) conversions are gone.
  const [inviteTerms, setInviteTerms] = useState<CommissionTerms>(DEFAULT_COMMISSION_TERMS);
  const inviteTermsCheck = normalizeCommissionTerms(inviteTerms);
  // The org-chart half of the offer. Role options come from HIRABLE_ROLES (the
  // same strictly-above map the server enforces — a manager can't invite a
  // manager), and the supervisor list is filtered by isValidSupervisorRole for
  // the chosen role, exactly like the Team page's supervisor picker.
  // `undefined` supervisor = "never touched" → defaults to the inviter's own
  // member row whenever that row passes the filter; changing role resets to
  // this default because eligibility changes with the role (Team page rule).
  const [inviteRole, setInviteRole] = useState<MemberRole>("rep");
  const [inviteSupervisorId, setInviteSupervisorId] = useState<number | null | undefined>(undefined);
  // Per-hire override rates: what the team-lead / manager slots keep from each
  // of THIS hire's qualified sales. Draft dollar strings (HouseAmountCard
  // idiom); "" = inherit the org default, converted to integer cents ONCE at
  // submit. Never part of what the candidate sees or signs.
  const [inviteOverrideTlDollars, setInviteOverrideTlDollars] = useState("");
  const [inviteOverrideMgrDollars, setInviteOverrideMgrDollars] = useState("");
  // A LEADER hire can arrive with their team: existing members re-homed under
  // them at approval. Only offered for team_lead/manager invites (a rep
  // supervises nobody), and only members the invited role would outrank.
  const [inviteDownlineIds, setInviteDownlineIds] = useState<number[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // Terms the approval commits the rep to. NOT a fresh house default: approval
  // is where the offer becomes pay, so it opens on what the candidate was
  // INVITED on (seeded below) and the reviewer edits from there.
  //
  // This used to be a TIERED/FLAT toggle and a flat-rate dollar string, with no
  // ladder anywhere on it — the same hole the invite form had. It was worse
  // here, because the console always sends a `commission` object on approve,
  // and the server only falls back to the invite's stored ladder when that
  // object is ABSENT. So `{ structure: "TIERED" }` from this panel out-ranked
  // the invited bands and assignStructureToRep landed on the house ones: the
  // rep signed 1-6 at $175 and was paid $150, which is precisely the divergence
  // the invite ladder was built to end.
  const [reviewTerms, setReviewTerms] = useState<CommissionTerms>(DEFAULT_COMMISSION_TERMS);
  const reviewTermsCheck = normalizeCommissionTerms(reviewTerms);
  // Role + upline the approval will create. Seeded from the invite (below) the
  // same way the comp terms are — approval opens on the OFFER, not a default.
  const [reviewRole, setReviewRole] = useState<MemberRole>("rep");
  const [reviewSupervisorId, setReviewSupervisorId] = useState<number | null>(null);
  // Same per-hire override drafts for the approval panel, seeded from the
  // invite's choice (below) the way the comp terms are.
  const [reviewOverrideTlDollars, setReviewOverrideTlDollars] = useState("");
  const [reviewOverrideMgrDollars, setReviewOverrideMgrDollars] = useState("");
  const [reviewDownlineIds, setReviewDownlineIds] = useState<number[]>([]);
  const [reviewNotes, setReviewNotes] = useState("");
  // Two-step reject (audit finding: reject mutated instantly and is
  // irreversible). First tap arms the button, which auto-disarms after 3s;
  // only a second tap while armed fires the mutation.
  const [rejectArmed, setRejectArmed] = useState(false);
  // Approving is the HIGHER-consequence decision on this screen — it creates
  // the account, assigns the commission plan + reserve, re-parents downline
  // members and issues four legal agreements — so it carries the same
  // arm-then-confirm guard as Reject. One mis-click must not hire someone.
  const [approveArmed, setApproveArmed] = useState(false);
  const [voidTarget, setVoidTarget] = useState<{ envelopeId: number; label: string } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const rejectTimer = useRef<number | null>(null);
  const approveTimer = useRef<number | null>(null);
  useEffect(() => {
    setRejectArmed(false);
    setApproveArmed(false);
    setVoidTarget(null);
    setVoidReason("");
    return () => {
      if (rejectTimer.current) window.clearTimeout(rejectTimer.current);
      if (approveTimer.current) window.clearTimeout(approveTimer.current);
    };
  }, [selectedKey]);

  const pipeline = useQuery<PipelineResponse>({
    queryKey: ["/api/onboarding/pipeline"],
    queryFn: () => apiRequest("GET", "/api/onboarding/pipeline").then(response => response.json()),
    enabled: canManage,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  // The roster feeds both supervisor pickers (invite + review).
  const teamQuery = useQuery<TeamMember[]>({
    queryKey: ["/api/team"],
    queryFn: () => apiRequest("GET", "/api/team").then(response => response.json()),
    enabled: canManage,
  });
  // Org override defaults — placeholders for the per-hire rate inputs, so a
  // blank field visibly means "inherit $X" rather than "zero".
  const configQuery = useQuery<{ overridesEnabled?: boolean; overrideTeamLeadCents?: number; overrideManagerCents?: number }>({
    queryKey: ["/api/commission/config"],
    queryFn: () => apiRequest("GET", "/api/commission/config").then(response => response.json()),
    enabled: canManage,
    staleTime: 60_000,
  });
  const orgOverrideTlCents = configQuery.data?.overrideTeamLeadCents ?? 0;
  const orgOverrideMgrCents = configQuery.data?.overrideManagerCents ?? 0;
  // "" = inherit (null on the wire); a value = whole dollars → integer cents,
  // converted ONCE at the boundary via the SHARED strict parser - an invalid
  // draft throws (surfaced by the mutation's onError) instead of being
  // silently coerced to "clear the override" (see lib/overrideMoney).
  const overrideDollarsToCents = (draft: string): number | null => {
    const parsed = parseOverrideDollars(draft);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.cents;
  };
  const team = Array.isArray(teamQuery.data) ? teamQuery.data : [];
  // Only ACTIVE members whose role ranks strictly above the chosen role may
  // supervise — the same shared-module filter the Team page and server use.
  const inviteSupervisors = team.filter(m => m.active && isValidSupervisorRole(inviteRole, m.role));
  const allowedInviteRoles = (HIRABLE_ROLES[user?.role ?? ""] ?? ["rep"]) as readonly MemberRole[];
  // Default supervisor = the inviter themself, when their own member row passes
  // the filter for the chosen role. Resolved lazily so the default lands even
  // when the roster arrives after first render.
  const myMemberId = user?.teamMemberId ?? null;
  const selfMember = myMemberId != null ? team.find(m => m.id === myMemberId) : undefined;
  const selfSupervises = !!selfMember && selfMember.active && isValidSupervisorRole(inviteRole, selfMember.role);
  const effectiveInviteSupervisorId: number | null =
    inviteSupervisorId !== undefined ? inviteSupervisorId : (selfSupervises ? myMemberId : null);
  // The review panel's supervisor list — same filter, keyed on the REVIEW role.
  const reviewSupervisors = team.filter(m => m.active && isValidSupervisorRole(reviewRole, m.role));
  // Who a leader hire could take over: active members the invited role ranks
  // strictly above (the supervisor filter, read the other way), minus whoever
  // was picked as the hire's OWN supervisor — that pairing is a loop the
  // server refuses, so it is never offered.
  const assignableDownline = (role: MemberRole, supervisorId: number | null) =>
    team.filter(m => m.active && m.id !== supervisorId && isValidSupervisorRole(m.role, role));
  const inviteDownlineOptions = assignableDownline(inviteRole, effectiveInviteSupervisorId);
  const reviewDownlineOptions = assignableDownline(reviewRole, reviewSupervisorId);
  const toggleId = (list: number[], id: number): number[] =>
    list.includes(id) ? list.filter(x => x !== id) : [...list, id];

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

  // ── The approval opens on the OFFER ───────────────────────────────────────
  // Keyed on the invite's terms rather than on selectedKey alone, so a record
  // selected before the pipeline query resolves still gets seeded when it does
  // — otherwise the panel would sit on the house default and a reviewer who
  // approved without touching it would quietly re-price the candidate.
  //
  // No stored terms (a careers/public applicant, or a pre-ladder invite) means
  // the house default, which is what those candidates have always been given.
  const invitedTermsKey = selected?.invite
    ? JSON.stringify([
        selected.invite.commissionStructure, selected.invite.flatRateCents,
        selected.invite.reservePercent, selected.invite.reserveCapCents,
        selected.invite.commissionTiers,
        // Hierarchy is part of the same offer — in the key so a reselect (or a
        // late-resolving pipeline query) reseeds the role/upline pickers too.
        selected.invite.invitedRole, selected.invite.invitedSupervisorId,
        selected.invite.invitedOverrideTeamLeadCents, selected.invite.invitedOverrideManagerCents,
        selected.invite.invitedDownlineIds,
      ])
    : null;
  useEffect(() => {
    const invite = selected?.invite;
    // Role + upline seed from the invite whenever one exists; careers/public
    // applicants (no invite) open on rep / top-level.
    setReviewRole(((invite?.invitedRole ?? "rep") as MemberRole));
    setReviewSupervisorId(invite?.invitedSupervisorId ?? null);
    // Per-hire override rates open on the hirer's invite-time choice; blank =
    // inherit the org default (matching what approval would stamp).
    setReviewOverrideTlDollars(centsToDollarsDraft(invite?.invitedOverrideTeamLeadCents));
    setReviewOverrideMgrDollars(centsToDollarsDraft(invite?.invitedOverrideManagerCents));
    // The team the hirer promised this leader. Stale entries (offboarded,
    // promoted) are skipped server-side with a warning, so seeding the raw
    // list is honest: it shows what was PROMISED, not a silently pruned copy.
    setReviewDownlineIds(invite?.invitedDownlineIds ?? []);
    if (!invite?.commissionStructure) { setReviewTerms(DEFAULT_COMMISSION_TERMS); return; }
    setReviewTerms(normalizeCommissionTerms({
      structure: invite.commissionStructure,
      flatRateCents: invite.flatRateCents,
      tiers: invite.commissionTiers ?? [],
      reservePercent: invite.reservePercent ?? DEFAULT_COMMISSION_TERMS.reservePercent,
      reserveCapCents: invite.reserveCapCents ?? DEFAULT_COMMISSION_TERMS.reserveCapCents,
    }).normalized);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, invitedTermsKey]);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["/api/onboarding/pipeline"] });
    queryClient.invalidateQueries({ queryKey: ["/api/onboarding/applications"] });
  }

  const inviteMutation = useMutation({
    mutationFn: () => {
      // Send the NORMALIZED terms — the same .ok / .normalized pattern the
      // agreements panel uses — so the ladder that leaves here is one the
      // commission engine would pay against, not raw editor state.
      const terms = normalizeCommissionTerms(inviteTerms).normalized;
      const body: Record<string, unknown> = {
        name: inviteName.trim(),
        email: inviteEmail.trim(),
        commissionStructure: terms.structure,
        reservePercent: terms.reservePercent,
        // 0 ceiling means uncapped — send 0 through (the engine reads 0 = uncapped).
        reserveCapCents: terms.reserveCapCents,
        // The org-chart half of the offer. The schema is .strict(): exactly
        // these keys, id-or-null (null = top-level, reports to admin).
        invitedRole: inviteRole,
        invitedSupervisorId: effectiveInviteSupervisorId,
        // Per-hire override rates (null = inherit the org default).
        invitedOverrideTeamLeadCents: overrideDollarsToCents(inviteOverrideTlDollars),
        invitedOverrideManagerCents: overrideDollarsToCents(inviteOverrideMgrDollars),
        // The team this leader arrives with (empty for a rep hire).
        invitedDownlineIds: inviteRole === "rep" ? [] : inviteDownlineIds,
      };
      if (terms.structure === "FLAT") body.flatRateCents = terms.flatRateCents ?? 0;
      // THE LADDER. `id` is stripped because the invite schema is .strict() and
      // a ladder prefilled from an existing plan version carries one.
      else body.tiers = terms.tiers.map(({ position, minimumSales, maximumSales, rateCents, label }) =>
        ({ position, minimumSales, maximumSales, rateCents, label }));
      return apiRequest("POST", "/api/onboarding/invitations", body).then(response => response.json());
    },
    onSuccess: (data: any) => {
      setInviteName(""); setInviteEmail("");
      setInviteOverrideTlDollars(""); setInviteOverrideMgrDollars(""); setInviteDownlineIds([]);
      refresh();
      toast({ title: "Private invitation sent", description: `${data.invitation.candidateName} received a secure 14-day application link.` });
    },
    onError: (error: any) => toast({ title: "Invitation not sent", description: error.message, variant: "destructive" }),
  });

  const reviewMutation = useMutation({
    mutationFn: ({ status }: { status: "approved" | "rejected" }) => {
      if (!selected?.applicationId) throw new Error("Application not found");
      // The whole instrument, not the word for it: structure, the LADDER, and
      // the chargeback reserve. Sending `{ structure: "TIERED" }` alone is not
      // "no opinion" to the server — it is an override that suppresses the
      // invite fallback, so an incomplete object here silently becomes the
      // house plan. Normalized first, for the same reason the invite is: what
      // leaves must be a ladder the commission engine would pay against.
      const terms = normalizeCommissionTerms(reviewTerms).normalized;
      const commission = status === "approved"
        ? {
            structure: terms.structure,
            ...(terms.structure === "FLAT"
              ? { flatRateCents: terms.flatRateCents ?? 0 }
              : { tiers: terms.tiers.map(({ position, minimumSales, maximumSales, rateCents, label }) =>
                    ({ position, minimumSales, maximumSales, rateCents, label })) }),
            reservePercent: terms.reservePercent,
            reserveCapCents: terms.reserveCapCents,
          }
        : undefined;
      // Role + upline the approval creates — explicit like `commission`, so
      // what the reviewer SEES is what the server assigns, never a fallback.
      // The per-hire override rates ride the same object (null = inherit).
      const hierarchy = status === "approved"
        ? {
            role: reviewRole, reportsToId: reviewSupervisorId,
            overrideTeamLeadCents: overrideDollarsToCents(reviewOverrideTlDollars),
            overrideManagerCents: overrideDollarsToCents(reviewOverrideMgrDollars),
            // Explicit like everything else on this object: what the reviewer
            // SEES checked is exactly who gets moved, an empty list included.
            downlineIds: reviewRole === "rep" ? [] : reviewDownlineIds,
          }
        : undefined;
      return apiRequest("PATCH", `/api/onboarding/applications/${selected.applicationId}`, { status, reviewNotes: reviewNotes || null, commission, hierarchy }).then(response => response.json());
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

  // ── Comp terms at send time ───────────────────────────────────────────────
  // Opening on the rep's RESOLVED terms, not a blank form: a manager editing
  // this is adjusting an existing offer, and a form that defaults to the house
  // plan would silently rewrite a rep already on something else the moment it
  // was sent.
  const [termsOpen, setTermsOpen] = useState(false);
  const [compTerms, setCompTerms] = useState<CommissionTerms>(DEFAULT_COMMISSION_TERMS);
  const selectedRepId = selected?.account?.repId ?? null;
  useQuery({
    queryKey: [`/api/onboarding/documents/reps/${selectedRepId}/comp-terms`],
    enabled: termsOpen && selectedRepId != null,
    queryFn: async () => {
      const data = await apiRequest("GET", `/api/onboarding/documents/reps/${selectedRepId}/comp-terms`).then(r => r.json());
      if (data?.terms) setCompTerms(data.terms as CommissionTerms);
      return data;
    },
  });

  // Send the agreements WITH the terms on screen, so the paperwork states the
  // plan the manager just confirmed rather than whatever was last stored.
  const sendWithTermsMutation = useMutation({
    mutationFn: ({ inviteId, terms }: { inviteId: number; terms: CommissionTerms }) =>
      apiRequest("POST", `/api/onboarding/pipeline/${inviteId}/resend-documents`, { compTerms: terms }).then(r => r.json()),
    onSuccess: () => {
      setTermsOpen(false);
      refresh();
      toast({ title: "Agreements sent", description: "The commission agreement states these terms." });
    },
    onError: (error: any) => toast({ title: "Agreements not sent", description: error.message, variant: "destructive" }),
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

  // Voiding cancels an agreement that should never be signed as issued (wrong
  // version, wrong rep, candidate withdrew). It is only offered for an issued,
  // UNSIGNED agreement — a signed one has no void control at all, and the API
  // refuses it independently.
  const voidMutation = useMutation({
    mutationFn: ({ envelopeId, reason }: { envelopeId: number; reason: string }) =>
      apiRequest("POST", `/api/onboarding/documents/${envelopeId}/void`, { reason }).then(response => response.json()),
    onSuccess: () => {
      setVoidTarget(null);
      setVoidReason("");
      refresh();
      toast({ title: "Agreement voided", description: "The rep can no longer sign it. The void and its reason are in the signature chain." });
    },
    onError: (error: any) => toast({ title: "Could not void", description: error.message, variant: "destructive" }),
  });

  const hrMutation = useMutation({
    mutationFn: ({ kind, body }: { kind: HrCheckpointKind; body: Record<string, unknown> }) => {
      if (!selected?.applicationId) throw new Error("Application not found");
      return apiRequest("PATCH", `/api/onboarding/applications/${selected.applicationId}/hr/${kind}`, body).then(response => response.json());
    },
    onSuccess: () => refresh(),
    onError: (error: any) => toast({ title: "Update failed", description: error.message, variant: "destructive" }),
  });

  const badgeMutation = useMutation({
    mutationFn: (file: File) => {
      if (!selected?.applicationId) throw new Error("Application not found");
      const form = new FormData();
      form.append("badge", file);
      return apiUpload(`/api/onboarding/applications/${selected.applicationId}/hr/badge-photo`, form).then(response => response.json());
    },
    onSuccess: () => { refresh(); toast({ title: "Badge photo uploaded", description: "Marked awaiting approval." }); },
    onError: (error: any) => toast({ title: "Upload failed", description: error.message, variant: "destructive" }),
  });

  const gustoVerifyMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/onboarding/hr/gusto/verify", {}).then(response => response.json()),
    onSuccess: (data: any) => toast({ title: data.ok ? "Gusto connected" : "Gusto not connected", description: data.message, variant: data.ok ? "default" : "destructive" }),
    onError: (error: any) => toast({ title: "Verification failed", description: error.message, variant: "destructive" }),
  });

  async function copySecureLink(record: PipelineRecord) {
    if (!record.invite?.secureUrl) return;
    if (!(await copyText(record.invite.secureUrl))) {
      toast({ title: "Copy failed", description: "This browser refused the copy - open the link from the row instead.", variant: "destructive" });
      return;
    }
    setCopiedKey(record.key);
    setTimeout(() => setCopiedKey(null), 2000);
    toast({ title: "Private link copied", description: "The link is candidate-specific and expires after 14 days." });
  }

  if (!canManage) return <div className="grid h-full place-items-center"><div className="text-center text-muted-foreground"><p>Manager or Admin access required</p></div></div>;

  const summary = pipeline.data?.summary ?? { total: 0, needsAction: 0, inProgress: 0, active: 0 };

  return (
    <div className="mx-auto max-w-[1440px] p-4 sm:p-5 lg:p-6" data-testid="onboarding-console">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">Recruiting operations</div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Rep onboarding</h1>
          <p className="mt-1 text-sm text-muted-foreground">Invite, review, issue agreements, and activate every rep from one queue.</p>
        </div>
        <button onClick={() => pipeline.refetch()} className="inline-flex h-10 items-center justify-center gap-2 self-start rounded-xl border border-border px-3 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground" data-testid="refresh-onboarding"><RefreshCw className={`h-4 w-4 ${pipeline.isFetching ? "animate-spin" : ""}`} />Refresh</button>
      </header>

      <section className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Onboarding summary">
        {[
          { label: "Pipeline", value: summary.total, icon: Users, tone: "text-info" },
          { label: "Needs action", value: summary.needsAction, icon: ClipboardCheck, tone: "text-warning" },
          { label: "In progress", value: summary.inProgress, icon: Clock3, tone: "text-info" },
          { label: "Active", value: summary.active, icon: UserCheck, tone: "text-success" },
        ].map(metric => <div key={metric.label} className="rounded-2xl border border-border bg-card p-3.5"><div className="flex items-center justify-between"><span className="text-xs font-medium text-muted-foreground">{metric.label}</span></div><div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{metric.value}</div></div>)}
      </section>

      <section className="mb-4 rounded-2xl border border-border bg-card p-4" aria-label="Invite a candidate">
        <div className="flex items-start gap-3"><div><h2 className="text-sm font-semibold text-foreground">Invite a potential rep</h2><p className="mt-0.5 text-xs text-muted-foreground">Creates the onboarding record first, then emails a candidate-specific private link.</p></div></div>
        {/* Terms are checked on submit as well as on the button: pressing Enter
            in the name field submits a form whose disabled button was never
            clicked, and an invalid ladder must not become an offer either way. */}
        <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); if (!inviteMutation.isPending && inviteTermsCheck.ok) inviteMutation.mutate(); }}>
          <div className="grid gap-2 sm:grid-cols-2">
            <div><label className="sr-only" htmlFor="invite-candidate-name">Candidate full name</label><input id="invite-candidate-name" value={inviteName} onChange={event => setInviteName(event.target.value)} required minLength={2} maxLength={120} placeholder="Candidate full name" className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" data-testid="input-candidate-name" /></div>
            <div><label className="sr-only" htmlFor="invite-candidate-email">Candidate email</label><input id="invite-candidate-email" type="email" value={inviteEmail} onChange={event => setInviteEmail(event.target.value)} required maxLength={254} placeholder="candidate@email.com" className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" data-testid="input-candidate-email" /></div>
          </div>

          {/* Role + upline travel with the invite too. Options mirror the
              server's strictly-above rules: HIRABLE_ROLES caps what THIS
              inviter may offer, and the supervisor list holds only active
              members ranking above the chosen role. Changing role resets the
              supervisor to the default (the inviter, when eligible) because
              eligibility changes with the role. */}
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label htmlFor="invite-role" className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Invited role</label>
              <select
                id="invite-role"
                value={inviteRole}
                onChange={event => { setInviteRole(event.target.value as MemberRole); setInviteSupervisorId(undefined); setInviteDownlineIds([]); }}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary"
                data-testid="invite-role-select"
              >
                {allowedInviteRoles.map(role => <option key={role} value={role}>{MEMBER_ROLE_LABEL[role]}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="invite-supervisor" className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Reports to</label>
              <select
                id="invite-supervisor"
                value={effectiveInviteSupervisorId != null ? String(effectiveInviteSupervisorId) : "none"}
                onChange={event => setInviteSupervisorId(event.target.value === "none" ? null : Number(event.target.value))}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary"
                data-testid="invite-supervisor-select"
              >
                <option value="none"> - None (reports to Admin) - </option>
                {inviteSupervisors.map(member => (
                  <option key={member.id} value={String(member.id)}>{member.name} · {memberRoleLabel(member.role)}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Per-hire override rates — what the upline keeps from each of this
              hire's qualified sales. Blank = inherit the org default (shown as
              the placeholder). Hidden for manager invites: managers sit at the
              top of the chain, so no slot above them ever pays. Not part of
              what the candidate sees or signs. */}
          {inviteRole !== "manager" && (
            <div className="rounded-xl border border-border bg-background/40 p-3" data-testid="invite-override-rates">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Upline keep per sale (overrides - not shown to the candidate)</div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label htmlFor="invite-override-tl" className="mb-1 block text-[11px] text-muted-foreground">Team lead keeps</label>
                  <div className="flex h-10 items-center rounded-xl border border-border bg-background px-3">
                    <span className="mr-1 text-sm text-muted-foreground">$</span>
                    <input
                      id="invite-override-tl" inputMode="decimal"
                      value={inviteOverrideTlDollars}
                      onChange={event => setInviteOverrideTlDollars(event.target.value)}
                      placeholder={`${(orgOverrideTlCents / 100).toFixed(2)} (org default)`}
                      className="w-full bg-transparent text-sm text-foreground outline-none"
                      data-testid="invite-override-tl"
                    />
                    <span className="ml-1 whitespace-nowrap text-[11px] text-muted-foreground">/sale</span>
                  </div>
                </div>
                <div>
                  <label htmlFor="invite-override-mgr" className="mb-1 block text-[11px] text-muted-foreground">Manager keeps</label>
                  <div className="flex h-10 items-center rounded-xl border border-border bg-background px-3">
                    <span className="mr-1 text-sm text-muted-foreground">$</span>
                    <input
                      id="invite-override-mgr" inputMode="decimal"
                      value={inviteOverrideMgrDollars}
                      onChange={event => setInviteOverrideMgrDollars(event.target.value)}
                      placeholder={`${(orgOverrideMgrCents / 100).toFixed(2)} (org default)`}
                      className="w-full bg-transparent text-sm text-foreground outline-none"
                      data-testid="invite-override-mgr"
                    />
                    <span className="ml-1 whitespace-nowrap text-[11px] text-muted-foreground">/sale</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* A LEADER arrives with a team. Hiring a team lead or manager and
              then re-parenting each rep by hand on the Team page is the same
              decision made twice — this makes it part of the offer, and
              approval performs the moves. Reps are never offered it (they
              supervise nobody), and the list only holds members the invited
              role outranks, minus the hire's own supervisor. */}
          {inviteRole !== "rep" && (
            <div className="rounded-xl border border-border bg-background/40 p-3" data-testid="invite-downline">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Downline (who reports to them on day one)
              </div>
              <p className="mb-2 text-[11px] text-muted-foreground">
                {inviteDownlineIds.length > 0
                  ? `${inviteDownlineIds.length === 1 ? "1 member moves" : `${inviteDownlineIds.length} members move`} under them when this hire is approved.`
                  : "Optional - leave empty and they start with no reports."}
              </p>
              {inviteDownlineOptions.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">No eligible members to assign yet.</p>
              ) : (
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {inviteDownlineOptions.map(member => (
                    <label key={member.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-secondary/60">
                      <input
                        type="checkbox"
                        checked={inviteDownlineIds.includes(member.id)}
                        onChange={() => setInviteDownlineIds(list => toggleId(list, member.id))}
                        className="h-3.5 w-3.5 accent-primary"
                        data-testid={`invite-downline-${member.id}`}
                      />
                      <span className="text-foreground">{member.name}</span>
                      <span className="text-muted-foreground">· {memberRoleLabel(member.role)}</span>
                      {member.reportsToId != null && (
                        <span className="ml-auto text-2xs text-muted-foreground">
                          now under {team.find(x => x.id === member.reportsToId)?.name ?? "another leader"}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* The comp terms travel with the invite, state themselves in the
              candidate's commission agreement, and seed the rep's plan +
              reserve at approval. The SAME editor the agreements panel uses, so
              a ladder can be chosen here — before, this was four fields that
              could say "Tiered" but not which tiers, and the ladder was picked
              after approval, by which point the offer had already been made. */}
          <div className="rounded-xl border border-border bg-background/40 p-3" data-testid="invite-comp-terms">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Commission &amp; reserve (what the candidate will sign)</div>
            <CompTermsEditor value={inviteTerms} onChange={setInviteTerms} disabled={inviteMutation.isPending} />
          </div>

          <button type="submit" disabled={!pipeline.data?.configured || !inviteName.trim() || !inviteEmail.trim() || !inviteTermsCheck.ok || inviteMutation.isPending} className="inline-flex h-11 md:h-10 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50 sm:w-auto" data-testid="send-candidate-invite">{inviteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Send private invite</button>
        </form>
        {pipeline.data && !pipeline.data.configured && <p className="mt-2 text-xs text-warning">Resend must be connected before invitations can be sent.</p>}
      </section>

      <div className="grid min-h-[620px] gap-4 xl:grid-cols-[minmax(420px,0.9fr)_minmax(560px,1.25fr)]">
        <section className="overflow-hidden rounded-2xl border border-border bg-card" aria-label="Candidate onboarding queue">
          <div className="border-b border-border p-3">
            <div className="relative"><input aria-label="Search candidates" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search candidates" className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary" /></div>
            <div className="mt-2 flex gap-1 overflow-x-auto pb-1" aria-label="Pipeline filters">{FILTERS.map(key => <button key={key} onClick={() => setFilter(key)} className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium ${filter === key ? "bg-primary/[0.12] text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}>{key.replace(/_/g, " ")}</button>)}</div>
          </div>
          <div className="max-h-[720px] overflow-y-auto">
            {pipeline.isLoading && <div className="grid h-48 place-items-center text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>}
            {/* A fetch failure must NOT masquerade as an empty queue: a manager
                who sees "no candidates" on a network blip may re-invite people
                already in flight (a duplicate onboarding invite). Error+retry
                comes before the empty state, gated so the two never overlap. */}
            {!pipeline.isLoading && pipeline.isError && (
              <div className="p-10 text-center" role="alert" data-testid="pipeline-error">
                
                <p className="text-sm font-medium text-foreground">Couldn&apos;t load the candidate pipeline</p>
                <p className="mt-1 text-xs text-muted-foreground">Check your connection - your candidates are safe. Don&apos;t re-invite anyone until this loads.</p>
                <button type="button" onClick={() => pipeline.refetch()} data-testid="pipeline-retry"
                  className="mt-4 inline-flex h-9 items-center justify-center rounded-lg border border-border bg-secondary px-4 text-sm font-semibold text-foreground active:scale-95 transition-transform">
                  Retry
                </button>
              </div>
            )}
            {!pipeline.isLoading && !pipeline.isError && !filtered.length && <div className="p-10 text-center"><p className="text-sm font-medium text-foreground">No candidates in this view</p><p className="mt-1 text-xs text-muted-foreground">Send a private invite or change the filters.</p></div>}
            {filtered.map(record => {
              const selectedRow = record.key === selectedKey;
              const percent = record.progress.total > 0 ? Math.round((record.progress.completed / record.progress.total) * 100) : 0;
              return <button key={record.key} onClick={() => setSelectedKey(record.key)} className={`render-lazy w-full border-b border-border p-4 text-left transition-colors last:border-0 ${selectedRow ? "bg-primary/[0.07]" : "hover:bg-secondary/50"}`} data-testid={`pipeline-record-${record.key}`}>
                <div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-foreground">{record.candidateName.split(/\s+/).map(part => part[0]).slice(0, 2).join("").toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold text-foreground">{record.candidateName}</span><StagePill stage={record.stage} /></div><p className="mt-0.5 truncate text-xs text-muted-foreground">{record.candidateEmail}</p><p className="mt-1 text-2xs font-semibold uppercase tracking-wide text-primary/80">{record.source === "careers" ? "Website careers" : record.source === "invited" ? "Private invite" : "Public join link"}{record.desiredRole ? ` · ${record.desiredRole}` : ""}</p><div className="mt-3 flex items-center gap-2"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} /></div><span className="text-2xs font-semibold tabular-nums text-muted-foreground">{record.progress.completed}/{record.progress.total}</span></div><div className="mt-2 flex items-center justify-between text-[11px]"><span className="text-muted-foreground">{STAGES[record.stage].next}</span></div></div></div>
              </button>;
            })}
          </div>
        </section>

        <section className="min-w-0 rounded-2xl border border-border bg-card xl:sticky xl:top-4 xl:max-h-[calc(100vh-7rem)] xl:overflow-y-auto" aria-label="Candidate onboarding details">
          {!selected && <div className="grid h-full min-h-96 place-items-center p-8 text-center"><div><p className="text-sm font-medium text-foreground">Select a candidate</p><p className="mt-1 text-xs text-muted-foreground">Their full onboarding state will appear here.</p></div></div>}
          {/* Keyed on the record so switching candidates re-runs the entrance —
              the panel visibly answers "you are now looking at someone else". */}
          {selected && <div key={selected.key} className="hf-rise">
            <div className="border-b border-border p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="mb-2"><StagePill stage={selected.stage} /></div><h2 className="truncate text-xl font-semibold tracking-tight text-foreground">{selected.candidateName}</h2><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span className="flex items-center gap-1">{selected.candidateEmail}</span>{selected.application && <span className="flex items-center gap-1">{selected.application.city}, {selected.application.state}</span>}</div></div>{selected.stage === "active" && null}</div>
            </div>

            <div className="space-y-4 p-4 sm:p-5">
              <div className="rounded-xl border border-border bg-background/50 p-4"><div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Onboarding progression</h3><span className="text-xs font-semibold text-foreground">{selected.progress.completed} of {selected.progress.total}</span></div><div className="grid grid-cols-7 gap-1">{selected.timeline.map((step, index) => <div key={step.label} className="group relative"><div className={`h-1.5 rounded-full ${step.done ? "bg-primary" : "bg-secondary"}`} /><div className="pointer-events-none absolute right-0 top-3 z-10 hidden w-36 rounded-lg border border-border bg-popover p-2 text-2xs text-popover-foreground shadow-xl group-hover:block"><div className="font-semibold">{index + 1}. {step.label}</div><div className="mt-0.5 text-muted-foreground">{step.done ? formatDate(step.at) : "Pending"}</div></div></div>)}</div><div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground"><span>Invited</span><span>Active rep</span></div></div>

              {selected.invite && <div className="rounded-xl border border-border p-4"><div className="flex items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">{selected.milestones.applied ? "Invitation delivery" : "Private application link"}</h3><p className="mt-1 text-xs text-muted-foreground">{selected.milestones.applied ? `Application received ${formatDate(selected.timeline[1]?.at)}` : `Expires ${formatDate(selected.invite.expiresAt)}`} · {selected.invite.deliveryAttempts} delivery attempt{selected.invite.deliveryAttempts === 1 ? "" : "s"}</p></div>{!selected.milestones.applied && <div className="flex gap-2"><button onClick={() => copySecureLink(selected)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary" data-testid="copy-secure-invite">{copiedKey === selected.key ? <Check className="h-3.5 w-3.5 text-success" /> : null}Copy</button>{["invited", "failed"].includes(selected.stage) && selected.inviteId && <button onClick={() => actionMutation.mutate({ action: "invite", inviteId: selected.inviteId! })} disabled={actionMutation.isPending} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground">Resend</button>}</div>}</div>{selected.invite.failureReason && <p className="mt-2 rounded-lg bg-destructive/[0.08] px-3 py-2 text-xs text-destructive">{selected.invite.failureReason}</p>}</div>}

              {selected.application && <div className="rounded-xl border border-border p-4"><div className="mb-3 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">Application review</h3><span className="text-[11px] text-muted-foreground">Applied {formatDate(selected.application.createdAt)}</span></div><div className="mb-2 flex flex-wrap gap-2 text-2xs font-semibold uppercase tracking-wide"><span className="rounded-full bg-primary/10 px-2 py-1 text-primary">{selected.source === "careers" ? "Website careers" : selected.source === "invited" ? "Private invite" : "Public join link"}</span>{selected.desiredRole && <span className="rounded-full bg-secondary px-2 py-1 text-muted-foreground">{selected.desiredRole}</span>}</div><div className="grid gap-2 text-xs sm:grid-cols-2"><div className="rounded-lg bg-secondary/50 p-3"><span className="text-muted-foreground">Phone</span><div className="mt-0.5 font-medium text-foreground">{selected.application.phone}</div></div><div className="rounded-lg bg-secondary/50 p-3"><span className="text-muted-foreground">Territory</span><div className="mt-0.5 font-medium text-foreground">{selected.application.city}, {selected.application.state} {selected.application.zip}</div></div><div className="rounded-lg bg-secondary/50 p-3"><span className="text-muted-foreground">Carriers</span><div className="mt-0.5 font-medium text-foreground">{selected.application.preferredCarriers}</div></div><div className="rounded-lg bg-secondary/50 p-3"><span className="text-muted-foreground">Sales experience</span><div className="mt-0.5 font-medium text-foreground">{selected.application.hasSalesExperience ? "Yes" : "No"}</div></div><div className="rounded-lg bg-secondary/50 p-3"><span className="text-muted-foreground">Reliable transportation</span><div className={`mt-0.5 font-medium ${selected.application.hasReliableTransportation === false ? "text-warning" : "text-foreground"}`}>{selected.application.hasReliableTransportation == null ? "Not asked" : selected.application.hasReliableTransportation ? "Yes" : "No"}</div></div>{selected.application.channel && <div className="rounded-lg bg-secondary/50 p-3" title={selected.application.attribution ? selected.application.attribution.replace(/[{}"]/g, "").split(",").join("\n") : undefined}><span className="text-muted-foreground">Ad channel</span><div className="mt-0.5 font-medium text-foreground">{selected.application.channel}</div></div>}</div>{selected.application.salesExperienceDetails && <p className="mt-2 rounded-lg bg-secondary/50 p-3 text-xs text-muted-foreground">{selected.application.salesExperienceDetails}</p>}
                {selected.applicationId && canReview && <div className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Applicant identity files"><ApplicantFileReview applicationId={selected.applicationId} kind="headshot" label="Headshot" present={!!selected.application.headshotPath} /><ApplicantFileReview applicationId={selected.applicationId} kind="license" label="Driver’s license or government ID" present={!!selected.application.licensePath} /></div>}
                {selected.applicationId && !canReview && (selected.application.headshotPath || selected.application.licensePath) && <p className="mt-3 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">Identity files are restricted to the administrator responsible for the approval decision.</p>}
                {selected.stage === "under_review" && canReview && <div className="mt-4 border-t border-border pt-4" data-testid="review-comp-terms">
                <div className="mb-4" data-testid="review-hierarchy">
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Role &amp; upline (what this approval creates)</h4>
                  <p className="mb-2 text-[11px] text-muted-foreground">{selected.invite?.invitedRole ? "Opened on the role and supervisor this candidate was invited with." : "No hierarchy travelled with this application - approving as a top-level rep unless you change it."}</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <label htmlFor="review-role" className="sr-only">Role</label>
                      <select
                        id="review-role"
                        value={reviewRole}
                        onChange={event => { setReviewRole(event.target.value as MemberRole); setReviewSupervisorId(null); setReviewDownlineIds([]); }}
                        disabled={reviewMutation.isPending}
                        className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
                        data-testid="review-role-select"
                      >
                        {allowedInviteRoles.map(role => <option key={role} value={role}>{MEMBER_ROLE_LABEL[role]}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="review-supervisor" className="sr-only">Reports to</label>
                      <select
                        id="review-supervisor"
                        value={reviewSupervisorId != null ? String(reviewSupervisorId) : "none"}
                        onChange={event => setReviewSupervisorId(event.target.value === "none" ? null : Number(event.target.value))}
                        disabled={reviewMutation.isPending}
                        className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
                        data-testid="review-supervisor-select"
                      >
                        <option value="none"> - None (top level) - </option>
                        {reviewSupervisors.map(member => (
                          <option key={member.id} value={String(member.id)}>{member.name} · {memberRoleLabel(member.role)}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {selected.invite?.invitedSupervisorActive === false && (
                    <p className="mt-2 rounded-lg border border-warning/[0.12] bg-warning/[0.08] px-3 py-2 text-xs text-warning" data-testid="review-supervisor-offboarded">
                      The proposed supervisor{selected.invite.invitedSupervisorName ? ` (${selected.invite.invitedSupervisorName})` : ""} was offboarded - pick a replacement or approve as top-level.
                    </p>
                  )}
                  {/* Per-hire override rates — approval stamps these onto the new
                      member's row (blank = inherit the org default). Hidden for
                      manager approvals: no slot above a manager ever pays. */}
                  {reviewRole !== "manager" && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2" data-testid="review-override-rates">
                      <div>
                        <label htmlFor="review-override-tl" className="mb-1 block text-[11px] text-muted-foreground">Team lead keeps /sale</label>
                        <div className="flex h-10 items-center rounded-xl border border-border bg-background px-3">
                          <span className="mr-1 text-sm text-muted-foreground">$</span>
                          <input
                            id="review-override-tl" inputMode="decimal"
                            value={reviewOverrideTlDollars}
                            onChange={event => setReviewOverrideTlDollars(event.target.value)}
                            placeholder={`${(orgOverrideTlCents / 100).toFixed(2)} (org default)`}
                            disabled={reviewMutation.isPending}
                            className="w-full bg-transparent text-sm text-foreground outline-none disabled:opacity-50"
                            data-testid="review-override-tl"
                          />
                        </div>
                      </div>
                      <div>
                        <label htmlFor="review-override-mgr" className="mb-1 block text-[11px] text-muted-foreground">Manager keeps /sale</label>
                        <div className="flex h-10 items-center rounded-xl border border-border bg-background px-3">
                          <span className="mr-1 text-sm text-muted-foreground">$</span>
                          <input
                            id="review-override-mgr" inputMode="decimal"
                            value={reviewOverrideMgrDollars}
                            onChange={event => setReviewOverrideMgrDollars(event.target.value)}
                            placeholder={`${(orgOverrideMgrCents / 100).toFixed(2)} (org default)`}
                            disabled={reviewMutation.isPending}
                            className="w-full bg-transparent text-sm text-foreground outline-none disabled:opacity-50"
                            data-testid="review-override-mgr"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                  {/* The team this leader takes over on approval. Seeded from
                      the invite; the reviewer's checkmarks are what actually
                      moves. Stale picks (offboarded, promoted) are skipped
                      server-side and reported back as a warning. */}
                  {reviewRole !== "rep" && (
                    <div className="mt-3" data-testid="review-downline">
                      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Downline (who moves under them)
                      </div>
                      {reviewDownlineOptions.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground">No eligible members to assign.</p>
                      ) : (
                        <div className="max-h-36 space-y-1 overflow-y-auto rounded-xl border border-border bg-background/40 p-2">
                          {reviewDownlineOptions.map(member => (
                            <label key={member.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-secondary/60">
                              <input
                                type="checkbox"
                                checked={reviewDownlineIds.includes(member.id)}
                                onChange={() => setReviewDownlineIds(list => toggleId(list, member.id))}
                                disabled={reviewMutation.isPending}
                                className="h-3.5 w-3.5 accent-primary"
                                data-testid={`review-downline-${member.id}`}
                              />
                              <span className="text-foreground">{member.name}</span>
                              <span className="text-muted-foreground">· {memberRoleLabel(member.role)}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Commission &amp; reserve (what this approval pays)</h4><p className="mb-2 text-[11px] text-muted-foreground">{selected.invite?.commissionStructure ? "Opened on the terms this candidate was invited on. Approving assigns exactly what is shown." : "No terms travelled with this application, so the house plan is shown. Approving assigns exactly what is shown."}</p><CompTermsEditor value={reviewTerms} onChange={setReviewTerms} disabled={reviewMutation.isPending} /><textarea value={reviewNotes} onChange={event => setReviewNotes(event.target.value)} placeholder="Decision reason / internal review notes" maxLength={1000} className="mt-3 min-h-20 w-full rounded-xl border border-border bg-background p-3 text-sm outline-none focus:border-primary" /><div className="mt-3 flex gap-2"><button onClick={() => {
                  if (!approveArmed) {
                    setApproveArmed(true);
                    if (approveTimer.current) window.clearTimeout(approveTimer.current);
                    approveTimer.current = window.setTimeout(() => setApproveArmed(false), 4000);
                    return;
                  }
                  if (approveTimer.current) window.clearTimeout(approveTimer.current);
                  setApproveArmed(false);
                  reviewMutation.mutate({ status: "approved" });
                }} disabled={reviewMutation.isPending || !reviewTermsCheck.ok} aria-label={approveArmed ? "Confirm: approve and start onboarding on the terms shown" : "Approve and start onboarding"} className={approveArmed ? "inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-success text-sm font-semibold text-success-foreground hover:bg-success/90" : "inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50"} data-testid="approve-start-onboarding">{reviewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{approveArmed ? "Confirm - assigns the plan shown & sends agreements" : "Approve & start onboarding"}</button><button onClick={() => {
                  if (!rejectArmed) {
                    setRejectArmed(true);
                    if (rejectTimer.current) window.clearTimeout(rejectTimer.current);
                    rejectTimer.current = window.setTimeout(() => setRejectArmed(false), 3000);
                    return;
                  }
                  if (rejectTimer.current) window.clearTimeout(rejectTimer.current);
                  setRejectArmed(false);
                  reviewMutation.mutate({ status: "rejected" });
                }} disabled={reviewMutation.isPending} aria-label={rejectArmed ? "Confirm rejecting this application" : "Reject this application"} data-testid="reject-application" className={rejectArmed ? "inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-destructive px-3 text-sm font-semibold text-white hover:bg-destructive/90" : "inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold text-destructive hover:bg-destructive/5"}>{rejectArmed ? "Confirm reject" : "Reject"}</button></div></div>}
                {selected.stage === "under_review" && !canReview && <p className="mt-4 border-t border-border pt-4 text-xs text-muted-foreground">An administrator in this organization must approve or reject this application.</p>}
              </div>}

              {selected.milestones.approved && <div className="rounded-xl border border-border p-4"><div className="mb-3 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">Account access</h3><span className={`text-[11px] font-semibold ${selected.milestones.loginCodeSent ? "text-success" : "text-warning"}`}>{selected.milestones.loginCodeSent ? "Login code sent" : "Delivery pending"}</span></div><p className="text-xs text-muted-foreground">The rep account can access My Documents while the field-sales profile stays inactive until every required agreement is signed.</p>{selected.inviteId && <button onClick={() => actionMutation.mutate({ action: "login", inviteId: selected.inviteId! })} disabled={actionMutation.isPending} className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary">Send a new login code</button>}</div>}

              {selected.milestones.approved && <div className="rounded-xl border border-border p-4"><div className="mb-3 flex items-center justify-between"><div><h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">Required agreements</h3><p className="mt-1 text-xs text-muted-foreground">{selected.milestones.signedCount} of 4 signed</p></div><div className="flex gap-2">{selectedRepId != null && <button onClick={() => setTermsOpen(open => !open)} aria-expanded={termsOpen} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary" data-testid="open-comp-terms">{termsOpen ? "Hide terms" : "Edit terms"}</button>}{selectedRepId != null && <a href={`/api/onboarding/documents/reps/${selectedRepId}/packet.pdf`} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary" data-testid="open-packet-pdf">One PDF</a>}{selected.inviteId && <button onClick={() => actionMutation.mutate({ action: "documents", inviteId: selected.inviteId! })} disabled={actionMutation.isPending} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary">Resend pending</button>}</div></div>{termsOpen && selectedRepId != null && <div className="mb-3 rounded-xl border border-border bg-background/40 p-3" data-testid="comp-terms-panel"><CompTermsEditor value={compTerms} onChange={setCompTerms} disabled={sendWithTermsMutation.isPending} /><div className="mt-3 flex justify-end gap-2"><button onClick={() => setTermsOpen(false)} className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary">Cancel</button><button onClick={() => selected.inviteId && sendWithTermsMutation.mutate({ inviteId: selected.inviteId, terms: normalizeCommissionTerms(compTerms).normalized })} disabled={!selected.inviteId || sendWithTermsMutation.isPending || !normalizeCommissionTerms(compTerms).ok} className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50" data-testid="send-with-terms">{sendWithTermsMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Send agreements with these terms</button></div></div>}<div className="space-y-2">{selected.documents.map(document => <div key={document.type} className="flex items-center gap-3 rounded-xl bg-secondary/45 p-3"><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-foreground">{document.label}</p><p className="mt-0.5 text-[11px] capitalize text-muted-foreground">{document.status.replace(/_/g, " ")}{document.completedAt ? ` · ${formatDate(document.completedAt)}` : ""}</p></div>{["sent", "delivered"].includes(document.status) && document.envelopeId && <button onClick={() => { setVoidTarget({ envelopeId: document.envelopeId!, label: document.label }); setVoidReason(""); }} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11px] font-semibold text-muted-foreground hover:bg-background hover:text-foreground" aria-label={`Void ${document.label}`} data-testid={`void-document-${document.type}`}>Void</button>}{document.status === "completed" && document.envelopeId && <button onClick={() => downloadOnboardingDocument(document.envelopeId!, `${selected.candidateName}-${document.type}.pdf`)} className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-background hover:text-foreground" aria-label={`Download ${document.label}`}><Download className="h-4 w-4" /></button>}</div>)}</div>{voidTarget && <div className="mt-3 rounded-xl border border-destructive/15 bg-destructive/5 p-3" data-testid="void-document-panel"><p className="text-xs font-semibold text-foreground">Void {voidTarget.label}?</p><p className="mt-1 text-[11px] text-muted-foreground">The rep can no longer sign this agreement. A signed agreement can never be voided. The reason is written into the signature chain.</p><input value={voidReason} onChange={event => setVoidReason(event.target.value)} maxLength={500} placeholder="Reason for voiding" className="mt-2 h-9 w-full rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary" data-testid="void-document-reason" /><div className="mt-2 flex justify-end gap-2"><button onClick={() => { setVoidTarget(null); setVoidReason(""); }} className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary">Cancel</button><button onClick={() => voidMutation.mutate({ envelopeId: voidTarget.envelopeId, reason: voidReason.trim() })} disabled={voidReason.trim().length < 2 || voidMutation.isPending} className="inline-flex h-9 items-center gap-2 rounded-lg bg-destructive px-3 text-xs font-semibold text-white disabled:opacity-50" data-testid="confirm-void-document">{voidMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Confirm void</button></div></div>}</div>}

              {selected.milestones.approved && selected.hr.checkpoints.length > 0 && (
                <div className="rounded-xl border border-border p-4" data-testid="hr-compliance">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">HR &amp; compliance</h3>
                      <p className="mt-1 text-xs text-muted-foreground">{selected.hr.cleared} of {selected.hr.total} gates cleared</p>
                    </div>
                    {selected.hr.anyFailed
                      ? <span className="inline-flex items-center gap-1 rounded-full border border-destructive/[0.12] bg-destructive/[0.08] px-2.5 py-1 text-[11px] font-semibold text-destructive">Action needed</span>
                      : selected.hr.allClear
                        ? <span className="inline-flex items-center gap-1 rounded-full border border-success/[0.12] bg-success/[0.08] px-2.5 py-1 text-[11px] font-semibold text-success">All clear</span>
                        : <span className="inline-flex items-center gap-1 rounded-full border border-warning/[0.12] bg-warning/[0.08] px-2.5 py-1 text-[11px] font-semibold text-warning">In progress</span>}
                  </div>

                  {canReview && !pipeline.data?.gustoConfigured && (
                    <div className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-secondary/50 px-3 py-2 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1.5">Gusto isn’t connected - confirm employees manually or set the API keys.</span>
                      <button onClick={() => gustoVerifyMutation.mutate()} disabled={gustoVerifyMutation.isPending} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 font-semibold hover:bg-background">{gustoVerifyMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}Test</button>
                    </div>
                  )}

                  <div className="space-y-2">
                    {selected.hr.checkpoints.map(cp => {
                      const gustoLocked = cp.kind === "gusto" && !canReview;
                      return (
                        <div key={cp.kind} className="rounded-xl bg-secondary/45 p-3">
                          <div className="flex items-start gap-3">
                            
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <p className="truncate text-xs font-semibold text-foreground">{cp.label}</p>
                                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-2xs font-semibold ${hrTone(cp)}`}>{hrStatusLabel(cp.status)}</span>
                              </div>
                              <p className="mt-0.5 text-[11px] text-muted-foreground">{cp.description}</p>
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <select
                                  value={cp.status}
                                  disabled={gustoLocked || hrMutation.isPending}
                                  onChange={event => hrMutation.mutate({ kind: cp.kind, body: { status: event.target.value } })}
                                  className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50"
                                  data-testid={`hr-status-${cp.kind}`}
                                >
                                  {cp.statuses.map(status => <option key={status} value={status}>{hrStatusLabel(status)}</option>)}
                                </select>
                                {cp.kind !== "badge_photo" && (
                                  <input
                                    key={`${cp.kind}-${cp.updatedAt ?? ""}`}
                                    defaultValue={cp.externalRef ?? ""}
                                    disabled={gustoLocked}
                                    placeholder={cp.kind === "gusto" ? "Gusto employee ID" : "Vendor case ID"}
                                    maxLength={200}
                                    onBlur={event => { const value = event.target.value.trim(); if (value !== (cp.externalRef ?? "")) hrMutation.mutate({ kind: cp.kind, body: { externalRef: value || null } }); }}
                                    className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50"
                                  />
                                )}
                                {cp.kind === "badge_photo" && (
                                  <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-semibold hover:bg-background">
                                    {badgeMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{cp.hasBadgePhoto ? "Replace" : "Upload photo"}
                                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) badgeMutation.mutate(file); event.target.value = ""; }} />
                                  </label>
                                )}
                              </div>
                              {cp.kind === "badge_photo" && cp.hasBadgePhoto && selected.applicationId && (
                                <div className="mt-2"><BadgePhoto applicationId={selected.applicationId} cacheKey={cp.updatedAt ?? ""} alt={`${selected.candidateName} badge photo`} /></div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-border p-4"><h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">Audit timeline</h3><div className="space-y-0">{selected.timeline.map((event, index) => <div key={event.label} className="flex gap-3"><div className="flex w-5 flex-col items-center"><span className={`mt-1.5 h-2 w-2 rounded-full ${event.done ? "bg-primary" : "bg-secondary ring-1 ring-border"}`} />{index < selected.timeline.length - 1 && <span className={`h-9 w-px ${event.done ? "bg-primary/40" : "bg-border"}`} />}</div><div className="pb-3"><p className={`text-xs font-medium ${event.done ? "text-foreground" : "text-muted-foreground"}`}>{event.label}</p><p className="mt-0.5 text-2xs text-muted-foreground">{event.done ? formatDate(event.at) : "Pending"}</p></div></div>)}</div></div>

              {selected.stage === "active" && <div className="rounded-xl border border-success/15 bg-success/[0.08] p-4"><div className="flex gap-3"><div><h3 className="text-sm font-semibold text-success">Onboarding complete</h3><p className="mt-1 text-xs text-emerald-200/70">All four required agreements are signed. The rep’s field-sales profile is active.</p></div></div></div>}
            </div>
          </div>}
        </section>
      </div>
    </div>
  );
}
