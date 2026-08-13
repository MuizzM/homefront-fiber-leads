import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clipboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { CallingAvailability, CallingChrome, CallingPageSkeleton, CallingUnknownState } from "@/components/calling/CallingChrome";
import { LeadScriptPanel } from "@/components/calling/LeadScriptPanel";
import {
  addInternalOptOut, auditPhoneCopy, authorizeManualCall, traceCallingLead, evaluateCallingLead, formatDecision, formatStage,
  getCallingLead, getCallingQueue, getCallingStatus, newIdempotencyKey, revokeCallingConsent, saveConsent, saveDisposition,
  selectTracedPhone, startManualCall,
  type CallingLeadDetail, type CallingStatus, type ConsentEvidence, type DispositionCode,
} from "@/lib/callingApi";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useCan } from "@/lib/capabilities";

/**
 * Every number the trace returned for this door.
 *
 * The queue carries ONE number per household — that is the right shape, since
 * frequency, dispositions and callbacks are all per-door — but a trace often
 * returns three or four. Without this panel a wrong-party answer on the
 * imported number ended the door while untried numbers sat in the database.
 *
 * Selecting one repoints the queue entry through the full import path, so the
 * new number gets its own association and its own compliance evaluation. The
 * decision panel resets on purpose: a verdict for the previous number tells a
 * rep nothing about this one.
 */
function TracedPhonePanel({ detail, onSwitched }: {
  detail: CallingLeadDetail;
  onSwitched: () => void;
}) {
  const { toast } = useToast();
  const options = detail.tracedPhones ?? [];
  const mutation = useMutation({
    mutationFn: (tracedPhoneId: number) => selectTracedPhone(detail.candidate.leadId, tracedPhoneId),
    onSuccess: result => {
      toast({
        title: result.alreadyActive ? "Already the working number" : "Switched to this number",
        description: result.invalidatedAuthorizations > 0
          ? "The previous call authorization was cancelled - run the compliance check again."
          : "Run the compliance check before dialling.",
      });
      onSwitched();
    },
    onError: (error: Error) => toast({ title: "Could not switch number", description: error.message, variant: "destructive" }),
  });

  if (options.length <= 1) return null;
  const dialable = options.filter(option => option.ready).length;

  return (
    <section className="rounded-2xl border border-border bg-card p-4" data-testid="traced-phone-panel">
      <div className="flex items-start gap-3">
        
        <div>
          <h2 className="text-sm font-semibold">Other numbers for this address</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The trace returned {options.length} numbers for this door, {dialable} of them clear of the registries.
            Switching runs a fresh compliance check - a suppressed number stays suppressed.
          </p>
        </div>
      </div>
      <ul className="mt-3 space-y-2">
        {options.map(option => (
          <li key={option.id}
            className={cn("flex items-center gap-3 rounded-xl border p-3",
              option.active ? "border-primary/40 bg-primary/[0.06]" : "border-border bg-background/50")}
            data-testid={`traced-phone-${option.id}`}>
            <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", option.ready ? "bg-success" : "bg-destructive")} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-sm">{option.masked}</div>
              <div className={cn("mt-0.5 truncate text-[11px]", option.ready ? "text-muted-foreground" : "text-destructive")}>
                {option.lineType} · {option.label}
              </div>
            </div>
            {option.active ? (
              <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-primary">Working</span>
            ) : (
              <Button variant="outline" size="sm" className="shrink-0"
                disabled={!option.selectable || mutation.isPending}
                onClick={() => mutation.mutate(option.id)}>
                {mutation.isPending ? "Switching…" : "Use this"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const DISPOSITIONS: Array<{ code: DispositionCode; label: string; tone?: string }> = [
  { code: "NO_ANSWER", label: "No answer" },
  { code: "VOICEMAIL_REACHED", label: "Voicemail" },
  { code: "LEFT_NO_MESSAGE", label: "Left no message" },
  { code: "BUSY", label: "Busy" },
  { code: "INTERESTED", label: "Interested", tone: "border-violet-500/35 bg-violet-500/10 text-violet-300" },
  { code: "APPOINTMENT_SCHEDULED", label: "Appointment", tone: "border-success/35 bg-success/[0.08] text-success" },
  { code: "SALE_STARTED", label: "Sale started", tone: "border-success/35 bg-success/[0.08] text-success" },
  { code: "SALE_COMPLETED", label: "Sale complete", tone: "border-success/35 bg-success/[0.08] text-success" },
  { code: "NOT_INTERESTED", label: "Not interested", tone: "border-destructive/15 bg-destructive/[0.07] text-destructive" },
  { code: "DO_NOT_CALL", label: "Do not call", tone: "border-destructive/45 bg-destructive/10 text-destructive" },
  { code: "WRONG_NUMBER", label: "Wrong number", tone: "border-destructive/35 bg-destructive/[0.08] text-destructive" },
  { code: "WRONG_PARTY", label: "Wrong party", tone: "border-destructive/35 bg-destructive/[0.08] text-destructive" },
  { code: "CONSENT_REVOKED", label: "Consent revoked", tone: "border-destructive/45 bg-destructive/10 text-destructive" },
  { code: "CONSENT_GRANTED", label: "Consent evidence captured" },
  { code: "DISCONNECTED", label: "Disconnected" },
  { code: "PROPERTY_OWNER_NOT_RESIDENT", label: "Owner not resident" },
  { code: "ALREADY_HAS_SERVICE", label: "Already has service" },
  { code: "NOT_SERVICEABLE", label: "Not serviceable" },
  { code: "LANGUAGE_BARRIER", label: "Language barrier" },
  { code: "REVIEW_REQUIRED", label: "Needs review" },
];

type ActiveAttempt = {
  attemptId: string;
  phoneNumber: string | null;
  maskedPhone: string;
  script: NonNullable<CallingStatus["activeScript"]>;
  noAutomaticNextCall: true;
  resumed: boolean;
};

function expirySeconds(iso: string | null): number {
  return iso ? Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 1000)) : 0;
}

function dateLabel(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not available";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

/**
 * Convert a datetime-local wall time (e.g. "2026-07-27T14:30") to an ISO
 * instant AS SEEN in the given IANA timezone. The input has no zone, so we
 * solve the tz offset at that wall time via Intl parts (no library).
 */
function wallTimeToIso(wallTime: string, timeZone: string): string | null {
  try {
    const naive = new Date(wallTime + ":00");
    if (!Number.isFinite(naive.getTime())) return null;
    // First guess: treat the wall time as UTC, then measure the tz offset there.
    const asUtc = new Date(Date.UTC(
      naive.getFullYear(), naive.getMonth(), naive.getDate(),
      naive.getHours(), naive.getMinutes(), 0,
    ));
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(asUtc);
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
    const zonedAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const offsetMs = zonedAsUtc - asUtc.getTime();
    return new Date(asUtc.getTime() - offsetMs).toISOString();
  } catch { return null; }
}

function dateLabelTz(value: string | null | undefined, timeZone: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not available";
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(new Date(value));
  } catch { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
}

function DecisionPanel({ detail, evaluation }: { detail: CallingLeadDetail; evaluation: Awaited<ReturnType<typeof evaluateCallingLead>> | null }) {
  const decision = evaluation?.evaluation ?? detail.decision;
  if (!decision) {
    // AUDIT FIX: a failed decision fetch used to render identically to a
    // genuinely unchecked lead — reps ran redundant paid evaluations and
    // couldn't tell something broke. Distinct unavailable state.
    if (detail.decisionError) {
      return (
        <div className="flex items-start gap-3 rounded-xl border border-warning/15 bg-warning/[0.08] p-3" data-testid="calling-decision-error">
          
          <div className="min-w-0">
            <div className="text-sm font-semibold text-warning">Decision unavailable</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">The recorded decision couldn't be loaded ({detail.decisionError}). Retry, or run a new compliance check.</div>
          </div>
        </div>
      );
    }
    return <p className="text-xs leading-relaxed text-muted-foreground">No current decision. A server-side compliance check is required before authorization.</p>;
  }
  // AUDIT FIX: a stale eligible decision used to render green "Eligible"
  // forever. Compute expiry here so the panel tells the truth.
  const expired = Number.isFinite(Date.parse(decision.expiresAt)) && Date.parse(decision.expiresAt) <= Date.now();
  if (expired) {
    return (
      <div className="space-y-3" data-testid="calling-decision">
        <div className="flex items-start gap-3 rounded-xl border border-warning/15 bg-warning/[0.08] p-3">
          
          <div className="min-w-0">
            <div className="text-sm font-semibold text-warning">Decision expired</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">This evaluation lapsed {dateLabel(decision.expiresAt)}. Run a new compliance check before authorizing.</div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="calling-decision">
      <div className={cn("flex items-start gap-3 rounded-xl border p-3",
        decision.eligible ? "border-success/15 bg-success/[0.08]" : "border-destructive/15 bg-destructive/[0.07]")}>
        {decision.eligible ? null : null}
        <div className="min-w-0">
          <div className={cn("text-sm font-semibold", decision.eligible ? "text-success" : "text-destructive")}>{formatDecision("decision" in decision ? decision.decision : decision.finalStatus)}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">Rule {decision.ruleVersion} · expires {dateLabel(decision.expiresAt)}{decision.localTime ? ` · ${decision.localTime}` : ""}</div>
        </div>
      </div>
      {!decision.eligible && decision.reasonCodes.length > 0 && (
        <ul className="space-y-1.5">
          {decision.reasonCodes.map(reason => <li key={reason} className="flex items-start gap-2 text-xs"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />{formatDecision(reason)}</li>)}
        </ul>
      )}
      <details className="group rounded-xl border border-border bg-background/40">
        <summary className="flex min-h-11 cursor-pointer select-none items-center px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground">Rule evidence ({decision.rules.length})</summary>
        <div className="divide-y divide-border/70 border-t border-border px-3">
          {decision.rules.map(rule => (
            <div key={rule.rule} className="flex min-h-10 items-center gap-2 py-2 text-xs">
              {rule.passed ? <Check className="h-3.5 w-3.5 shrink-0 text-success" /> : null}
              <span className="min-w-0 flex-1 truncate">{formatDecision(rule.rule)}</span>
              <span className="max-w-[42%] truncate text-2xs text-muted-foreground">{formatDecision(rule.reasonCode)}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function ConsentForm({ detail, attempt, onSaved }: {
  detail: CallingLeadDetail;
  attempt: ActiveAttempt;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const candidate = detail.candidate;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  const [method, setMethod] = useState<ConsentEvidence["method"]>("recorded_call");
  const [consumerIdentity, setConsumerIdentity] = useState(candidate.contactName ?? "");
  const [scope, setScope] = useState("Fiber internet sales calls for this service address");
  const [affirmativeAction, setAffirmativeAction] = useState("");
  const [disclosureVersion] = useState(attempt.script.version);
  const [disclosureHash] = useState(attempt.script.disclosureSha256);
  const [evidenceRef, setEvidenceRef] = useState("");
  const [capturedAt, setCapturedAt] = useState("");
  const mutation = useMutation({
    mutationFn: () => saveConsent(candidate.leadId, {
      consumerIdentity: consumerIdentity.trim(), consentType: "express_written_telemarketing",
      channels: ["manual_voice_call"], scope: scope.trim(), affirmativeAction: affirmativeAction.trim(),
      disclosureVersion: disclosureVersion.trim(), disclosureTextSha256: disclosureHash.trim().toLowerCase(),
      capturedAt: new Date(capturedAt).toISOString(), timeZone, method, evidenceArtifactRef: evidenceRef.trim(),
      voiceRecordingRef: method === "recorded_call" ? evidenceRef.trim() : undefined,
      signatureRef: method !== "recorded_call" ? evidenceRef.trim() : undefined, sourceRef: attempt.attemptId,
    }),
    onSuccess: () => { toast({ title: "Consent evidence saved", description: "The immutable evidence record was added to the audit trail." }); onSaved(); },
    onError: (error: Error) => toast({ title: "Consent not saved", description: error.message, variant: "destructive" }),
  });
  const valid = Boolean(candidate.phoneId && consumerIdentity.trim() && scope.trim() && affirmativeAction.trim() && disclosureVersion.trim()
    && /^[a-f0-9]{64}$/i.test(disclosureHash.trim()) && /^[a-f0-9-]{36}$/i.test(evidenceRef.trim())
    && capturedAt && Number.isFinite(Date.parse(capturedAt)));

  return (
    <details className="rounded-2xl border border-border bg-card">
      <summary className="flex min-h-14 cursor-pointer items-center gap-2 px-4 text-sm font-semibold"> Record verified consent evidence</summary>
      <form className="space-y-3 border-t border-border p-4" onSubmit={event => { event.preventDefault(); if (valid) mutation.mutate(); }}>
        <p className="text-xs leading-relaxed text-muted-foreground">This stores evidence; it does not create consent by itself. The artifact ID must already be hash-verified by a compliance administrator and retained for at least five years.</p>
        <label className="block text-xs font-semibold">Consumer identity stated on the evidence<input required value={consumerIdentity} onChange={event => setConsumerIdentity(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" /></label>
        <label className="block text-xs font-semibold">Consent scope<textarea required value={scope} onChange={event => setScope(event.target.value)} rows={2} className="mt-1 w-full rounded-xl border border-border bg-background p-3 font-normal" /></label>
        <label className="block text-xs font-semibold">Affirmative action taken by consumer<textarea required value={affirmativeAction} onChange={event => setAffirmativeAction(event.target.value)} rows={2} placeholder="Exact affirmative action shown in the retained evidence" className="mt-1 w-full rounded-xl border border-border bg-background p-3 font-normal" /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-semibold">Disclosure version<input readOnly value={disclosureVersion} className="mt-1 h-11 w-full rounded-xl border border-border bg-secondary/60 px-3 font-normal" /></label>
          <label className="block text-xs font-semibold">Evidence method<select value={method} onChange={event => setMethod(event.target.value as ConsentEvidence["method"])} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal"><option value="recorded_call">Recorded call</option><option value="signed_form">Signed form</option><option value="written">Written record</option><option value="other">Other durable proof</option></select></label>
        </div>
        <label className="block text-xs font-semibold">Disclosure SHA-256<input readOnly value={disclosureHash} className="mt-1 h-11 w-full rounded-xl border border-border bg-secondary/60 px-3 font-mono font-normal" /></label>
        <label className="block text-xs font-semibold">Verified evidence artifact ID<input required value={evidenceRef} onChange={event => setEvidenceRef(event.target.value)} placeholder="UUID issued by compliance evidence registry" className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-mono font-normal" /></label>
        <label className="block text-xs font-semibold">Artifact capture date and local time<input required type="datetime-local" value={capturedAt} onChange={event => setCapturedAt(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" /></label>
        <div className="rounded-xl bg-secondary/70 p-3 text-[11px] leading-relaxed text-muted-foreground">{timeZone} · Manual voice-call channel · Service address, phone, approved disclosure, and evidence artifact are server-bound.</div>
        <Button type="submit" disabled={!valid || mutation.isPending} className="w-full">{mutation.isPending ? "Saving evidence…" : "Save consent evidence"}</Button>
      </form>
    </details>
  );
}

export default function CallingLead() {
  const params = useParams<{ id: string }>();
  const leadId = Number(params.id);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canTrace = useCan("lead.skip_trace.request");
  const canAttemptManual = useCan("calling.attempt.manual");
  const canOptOut = useCan("calling.opt_out.write");
  const [evaluation, setEvaluation] = useState<Awaited<ReturnType<typeof evaluateCallingLead>> | null>(null);
  const [humanReady, setHumanReady] = useState(false);
  const [authorization, setAuthorization] = useState<Awaited<ReturnType<typeof authorizeManualCall>> | null>(null);
  const [expiresIn, setExpiresIn] = useState(0);
  const [activeAttempt, setActiveAttempt] = useState<ActiveAttempt | null>(null);
  const attemptRevalidationFloorRef = useRef(0);
  const [copied, setCopied] = useState(false);
  const [notes, setNotes] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  // AUDIT FIX: permanently-suppressing outcomes (DNC/revoke/wrong-number)
  // used to fire on a single thumb-tap mid-call - one slip permanently burns a
  // number. These four now arm first ("Confirm?"), fire on second tap.
  const SUPPRESSING: ReadonlySet<DispositionCode> = new Set(["DO_NOT_CALL", "CONSENT_REVOKED", "WRONG_NUMBER", "WRONG_PARTY"]);
  const [armedDisposition, setArmedDisposition] = useState<DispositionCode | null>(null);
  const [callbackEvidenceRef, setCallbackEvidenceRef] = useState("");
  const [showCallback, setShowCallback] = useState(false);
  const [completed, setCompleted] = useState<string | null>(null);
  const [optOutReason, setOptOutReason] = useState<"do_not_call" | "stop_request" | "wrong_number" | "wrong_party" | "consent_revoked">("stop_request");
  const [revocationEvidence, setRevocationEvidence] = useState("");
  const statusQuery = useQuery({ queryKey: ["/api/v1/calling/status"], queryFn: getCallingStatus, staleTime: 10_000, retry: 1 });
  const detailQuery = useQuery({
    queryKey: ["/api/v1/calling/leads", leadId], queryFn: () => getCallingLead(leadId),
    enabled: Number.isSafeInteger(leadId) && leadId > 0 && statusQuery.isSuccess, staleTime: 5_000, retry: 1,
    refetchInterval: activeAttempt ? 2_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!authorization) { setExpiresIn(0); return; }
    const tick = () => {
      const remaining = expirySeconds(authorization.expiresAt);
      setExpiresIn(remaining);
      // AUDIT FIX: an expired authorization used to leave the rep stranded -
      // start disabled forever with no way back but a page reload.
      if (remaining <= 0) {
        setAuthorization(null);
        toast({ title: "Authorization expired", description: "Re-authorize when you're ready to place the call." });
      }
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [authorization]);
  useEffect(() => () => { setAuthorization(null); setActiveAttempt(null); }, []);
  // Lead-to-lead navigation (the completion card's "Next eligible lead" CTA)
  // keeps this route mounted - reset all per-lead UI state so a saved outcome
  // or revealed number can never bleed into the next lead's screen.
  useEffect(() => {
    setEvaluation(null); setHumanReady(false); setAuthorization(null); setActiveAttempt(null);
    setCompleted(null); setNotes(""); setCallbackAt(""); setCallbackEvidenceRef("");
    setShowCallback(false); setArmedDisposition(null); setCopied(false);
  }, [leadId]);
  useEffect(() => {
    const open = detailQuery.data?.openAttempt;
    if (!open || activeAttempt || completed) return;
    attemptRevalidationFloorRef.current = detailQuery.dataUpdatedAt;
    setActiveAttempt({ attemptId: open.attemptId, phoneNumber: null, maskedPhone: open.maskedPhone,
      script: open.script, noAutomaticNextCall: true, resumed: true });
  }, [activeAttempt, completed, detailQuery.data?.openAttempt, detailQuery.dataUpdatedAt]);
  useEffect(() => {
    if (!activeAttempt || !detailQuery.data) return;
    const serverAttempt = detailQuery.data.openAttempt;
    if (serverAttempt?.attemptId === activeAttempt.attemptId) {
      attemptRevalidationFloorRef.current = detailQuery.dataUpdatedAt;
      return;
    }
    // Ignore the cached pre-start response. The first successful response
    // newer than the attempt start is authoritative, as are all later polls
    // and focus refetches.
    if (detailQuery.dataUpdatedAt <= attemptRevalidationFloorRef.current) return;
    const suppressed = detailQuery.data.candidate.queueStage === "SUPPRESSED"
      || detailQuery.data.candidate.phoneValidationStatus === "INTERNAL_DNC";
    setActiveAttempt(null);
    setAuthorization(null);
    setCopied(false);
    setCompleted(suppressed ? "Suppressed - permanent internal DNC" : "Attempt closed in another session");
    toast({ title: suppressed ? "STOP recorded" : "Attempt closed",
      description: suppressed
        ? "The number was suppressed in another session and removed from this screen."
        : "The server closed this attempt in another session. No next call was started." });
  }, [activeAttempt, detailQuery.data, detailQuery.dataUpdatedAt, toast]);

  const evaluateMutation = useMutation({ mutationFn: () => evaluateCallingLead(leadId), onSuccess: value => setEvaluation(value),
    onError: (error: Error) => toast({ title: "Compliance check failed", description: error.message, variant: "destructive" }) });
  const authorizeMutation = useMutation({ mutationFn: () => authorizeManualCall(leadId), onSuccess: value => setAuthorization(value),
    onError: (error: Error) => toast({ title: "Authorization blocked", description: error.message, variant: "destructive" }) });
  const startMutation = useMutation({ mutationFn: () => startManualCall(authorization!.token), onSuccess: value => {
    attemptRevalidationFloorRef.current = detailQuery.dataUpdatedAt;
    setActiveAttempt({ ...value, maskedPhone: detailQuery.data!.candidate.maskedPhone ?? "Protected number", resumed: false });
    setAuthorization(null);
  },
    onError: (error: Error) => { setAuthorization(null); toast({ title: "Call could not start", description: error.message, variant: "destructive" }); } });
  const dispositionMutation = useMutation({
    mutationFn: (code: DispositionCode) => saveDisposition(activeAttempt!.attemptId, {
      code, notes: notes.trim() || undefined,
      // QA GATE FIX (C1): the datetime-local input is wall time in the LEAD's
      // timezone - interpret it there so instant and label agree (previously
      // the instant was device-local while the label claimed the lead's zone).
      callbackAt: code === "CALLBACK_REQUESTED"
        ? (wallTimeToIso(callbackAt, detailQuery.data?.decision?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) ?? new Date(callbackAt).toISOString())
        : undefined,
      callbackTimeZone: code === "CALLBACK_REQUESTED" ? (detailQuery.data?.decision?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) : undefined,
      callbackConsentEvidenceRef: code === "CALLBACK_REQUESTED" ? callbackEvidenceRef.trim() : undefined,
      idempotencyKey: newIdempotencyKey(),
    }),
    onSuccess: value => {
      setCompleted(formatStage(value.stage)); setActiveAttempt(null); setAuthorization(null); setCopied(false);
      void queryClient.invalidateQueries({ predicate: query => String(query.queryKey[0] ?? "").startsWith("/api/v1/calling") });
      toast({ title: "Outcome saved", description: "No next call was started. Return to the queue when you are ready." });
    },
    onError: (error: Error) => toast({ title: "Outcome not saved", description: error.message, variant: "destructive" }),
  });
  const optOutMutation = useMutation({
    mutationFn: () => addInternalOptOut(leadId, {
      reason: optOutReason, channel: activeAttempt ? "live_call" : "other",
      sourceRef: activeAttempt?.attemptId ?? "manual-ui-stop-request",
    }),
    onSuccess: () => { setCompleted("Suppressed - permanent internal DNC"); setActiveAttempt(null); setAuthorization(null); void queryClient.invalidateQueries({ predicate: query => String(query.queryKey[0] ?? "").startsWith("/api/v1/calling") }); toast({ title: "STOP recorded", description: "The number was immediately suppressed and pending call authorizations were invalidated." }); },
    onError: (error: Error) => toast({ title: "STOP was not recorded", description: error.message, variant: "destructive" }),
  });
  // Completion CTA: jump straight to the top ELIGIBLE lead (skipping the one
  // just dispositioned - it may still be in a stale queue snapshot). Honest
  // fallback: no eligible lead or a failed fetch returns the rep to the queue.
  const nextLeadMutation = useMutation({
    mutationFn: async () => {
      const queue = await getCallingQueue({ stage: "ELIGIBLE_MANUAL_CALL", limit: 25 });
      return queue.find(item => item.leadId !== leadId) ?? null;
    },
    onSuccess: next => navigate(next ? `/calling/lead/${next.leadId}` : "/calling"),
    onError: (error: Error) => {
      toast({ title: "Next lead unavailable", description: error.message, variant: "destructive" });
      navigate("/calling");
    },
  });
  const traceMutation = useMutation({ mutationFn: () => traceCallingLead(leadId),
    onSuccess: (result) => {
      setEvaluation(null);
      void detailQuery.refetch();
      toast({
        title: result.phonesFound > 0 ? `Found ${result.phonesFound} number${result.phonesFound === 1 ? "" : "s"}` : "No numbers found",
        description: result.phonesFound === 0 ? "Tracerfy had nothing for this address."
          : result.dialable ? "Scrubbed and imported. The compliance check still decides whether it can be dialled."
            : "Every number came back on a do-not-call registry, so none of them are dialable.",
      });
    },
    onError: (error: Error) => toast({ title: "Trace failed", description: error.message, variant: "destructive" }) });
  const copyMutation = useMutation({ mutationFn: async () => {
    if (!activeAttempt?.phoneNumber) throw new Error("The full number is not re-exposed after a page refresh");
    await auditPhoneCopy(activeAttempt.attemptId);
    await navigator.clipboard.writeText(activeAttempt.phoneNumber);
  }, onSuccess: () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); },
    onError: (error: Error) => { void detailQuery.refetch(); toast({ title: "Number was not copied", description: error.message, variant: "destructive" }); } });
  const revokeMutation = useMutation({ mutationFn: () => revokeCallingConsent(detailQuery.data!.consent.id!, {
    scope: "all_manual_voice_call_consent", method: "other", evidenceRef: revocationEvidence.trim(),
  }), onSuccess: () => { setCompleted("Suppressed - consent revoked"); setActiveAttempt(null); void queryClient.invalidateQueries({ predicate: query => String(query.queryKey[0] ?? "").startsWith("/api/v1/calling") }); toast({ title: "Consent revoked", description: "The revocation and permanent internal DNC suppression were recorded together." }); },
    onError: (error: Error) => toast({ title: "Consent revocation failed", description: error.message, variant: "destructive" }) });

  const currentDecision = evaluation?.evaluation ?? detailQuery.data?.decision;
  const decisionStatus = currentDecision && ("decision" in currentDecision ? currentDecision.decision : currentDecision.finalStatus);
  const manualConfirmationOnly = decisionStatus === "BLOCKED_AUTOMATED_DIAL_ATTEMPT"
    && currentDecision?.reasonCodes.length === 1
    && ["MANUAL_ACTION_REQUIRED", "WIRELESS_REQUIRES_MANUAL_ACTION"].includes(currentDecision.reasonCodes[0]);
  const eligible = Boolean(statusQuery.data?.callable && currentDecision
    && (currentDecision.eligible || manualConfirmationOnly)
    && Date.parse(currentDecision.expiresAt) > Date.now());
  const candidate = detailQuery.data?.candidate;
  // Older cached payloads and rolling deployments may omit these optional
  // history collections. Render a safe empty history instead of crashing the
  // regulated call screen during a mixed-version rollout.
  const attempts = detailQuery.data?.attempts ?? [];
  const callbacks = detailQuery.data?.callbacks ?? [];
  const manualFlowDisabled = !candidate?.phoneId || !candidate.maskedPhone || Boolean(candidate.wrongParty || candidate.reassignedRisk);
  const callbackValid = useMemo(() => callbackAt && Date.parse(callbackAt) > Date.now()
    && /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(callbackEvidenceRef.trim()), [callbackAt, callbackEvidenceRef]);

  return (
    <CallingChrome>
      <div className="flex-1 px-4 pb-28 pt-4 md:px-6 md:pb-8">
        <Link href="/calling" className="mb-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"> Back to queue</Link>
        {statusQuery.isLoading || detailQuery.isLoading ? <CallingPageSkeleton /> : statusQuery.isError || !statusQuery.data ? (
          <CallingUnknownState retry={() => void statusQuery.refetch()} />
        ) : detailQuery.isError || !detailQuery.data || !candidate ? (
          <div role="alert" className="rounded-2xl border border-destructive/25 bg-destructive/[0.08] p-6 text-center"><h1 className="mt-2 text-base font-semibold text-destructive">Calling lead unavailable</h1><p className="mt-1 text-xs text-muted-foreground">No phone or calling action is available. The record may not belong to this organization or rep.</p></div>
        ) : (
          <div className="space-y-4">
            <CallingAvailability status={statusQuery.data} />
            <section className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-start gap-3">
                
                <div className="min-w-0 flex-1"><div className="text-[11px] font-semibold uppercase tracking-wider text-primary">Cross-verified fresh fiber</div><h1 className="mt-1 text-lg font-semibold tracking-tight">{candidate.address}</h1><p className="text-sm text-muted-foreground">{candidate.city}, {candidate.state} {candidate.zip}</p></div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border">
                <div className="bg-background/70 p-3"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Resident match</div><div className="mt-1 flex items-center gap-1.5 truncate text-sm">{candidate.contactName || "Not verified"}</div></div>
                <div className="bg-background/70 p-3"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Protected phone</div><div className="mt-1 truncate font-mono text-sm">{candidate.maskedPhone || "Unavailable"}</div></div>
                <div className="bg-background/70 p-3"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Line validation</div><div className="mt-1 truncate text-sm">{candidate.phoneValidationStatus || "Not validated"}{candidate.lineType ? ` · ${candidate.lineType}` : ""}</div></div>
                <div className="bg-background/70 p-3"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Pipeline stage</div><div className="mt-1 truncate text-sm">{formatStage(candidate.queueStage)}</div></div>
              </div>
            </section>

            {!activeAttempt && (
              <TracedPhonePanel detail={detailQuery.data}
                onSwitched={() => { setEvaluation(null); void detailQuery.refetch(); }} />
            )}

            <LeadScriptPanel leadId={leadId} />

            {canTrace && !candidate.phoneId && (
              <section className="rounded-2xl border border-border bg-card p-4" data-testid="trace-lead-card">
                <h2 className="text-sm font-semibold">No number on this door yet</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Run a Tracerfy skip trace for this address. Anything it finds is scrubbed against the
                  registries and still has to pass the compliance check below before it can be dialled.
                </p>
                <Button className="mt-3 w-full" variant="outline" data-testid="trace-lead-button"
                  disabled={traceMutation.isPending} onClick={() => traceMutation.mutate()}>
                  {traceMutation.isPending ? "Tracing…" : "Trace this door"}
                </Button>
              </section>
            )}

            <section className="rounded-2xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between gap-3"><div><div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Authoritative decision</div><h2 className="mt-0.5 text-base font-semibold">Compliance gate</h2></div><Button variant="outline" size="sm" disabled={evaluateMutation.isPending || manualFlowDisabled || Boolean(activeAttempt)} onClick={() => evaluateMutation.mutate()}>{evaluateMutation.isPending ? "Checking…" : "Run check"}</Button></div>
              <DecisionPanel detail={detailQuery.data} evaluation={evaluation} />
            </section>

            {!activeAttempt && !completed && canAttemptManual && (
              <section className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-start gap-3"><div><h2 className="text-base font-semibold">One manual call</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Authorization is short-lived, bound to you and this exact lead, and can be used once. It does not dial automatically.</p></div></div>
                <label className="mt-4 flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-border bg-background/55 p-3"><input type="checkbox" checked={humanReady} onChange={event => setHumanReady(event.target.checked)} className="mt-0.5 h-5 w-5 accent-[hsl(var(--primary))]" /><span className="text-xs leading-relaxed">I am the authorized rep, physically ready to place one manual call, and will use the approved script.</span></label>
                {!authorization ? (
                  <Button className="mt-3 w-full" size="lg" disabled={!eligible || !humanReady || authorizeMutation.isPending || manualFlowDisabled} onClick={() => authorizeMutation.mutate()}>{authorizeMutation.isPending ? "Authorizing…" : "Authorize one manual call"}</Button>
                ) : (
                  <div className="mt-3 rounded-xl border border-success/15 bg-success/[0.08] p-3"><div className="flex items-center justify-between gap-3 text-xs"><span className="font-semibold text-success">One-use authorization ready</span><span className="font-mono tabular-nums text-muted-foreground">{expiresIn}s</span></div><Button className="mt-3 w-full" size="lg" disabled={expiresIn <= 0 || startMutation.isPending} onClick={() => startMutation.mutate()}>{startMutation.isPending ? "Re-checking gates…" : "Reveal number & start manual attempt"}</Button></div>
                )}
                {!eligible && <p className="mt-3 text-center text-[11px] text-muted-foreground">A current eligible compliance decision is required. The frontend cannot override a blocked decision.</p>}
              </section>
            )}

            {!canAttemptManual && !activeAttempt && !completed && (
              <div className="rounded-2xl border border-border bg-card p-4 text-xs leading-relaxed text-muted-foreground">
                 Read-only calling access. Starting an attempt requires the calling.attempt.manual capability.
              </div>
            )}

            {activeAttempt && (
              <>
                <section className="rounded-2xl border border-primary/30 bg-primary/[0.06] p-4" data-testid="active-manual-attempt">
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-primary"> Manual attempt active</div>
                  <div className="mt-3 flex items-center gap-2"><div className="min-w-0 flex-1 truncate font-mono text-2xl font-semibold tracking-tight">{activeAttempt.phoneNumber ?? activeAttempt.maskedPhone}</div>{activeAttempt.phoneNumber && <Button variant="outline" size="icon" aria-label="Copy phone number" disabled={copyMutation.isPending} onClick={() => copyMutation.mutate()}>{copied ? <Check className="h-4 w-4 text-success" /> : <Clipboard className="h-4 w-4" />}</Button>}</div>
                  {activeAttempt.resumed && <p className="mt-2 text-[11px] text-warning">Resumed open attempt after navigation or refresh. The full number is not revealed again; record the outcome to close this attempt.</p>}
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"> No auto-dial, phone link, auto-next, recording, or prerecorded voice is initiated by this app.</p>
                </section>
                <section className="rounded-2xl border border-border bg-card p-4"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Approved script · {activeAttempt.script.version}</div><h2 className="mt-1 text-base font-semibold">{activeAttempt.script.title}</h2><div className="mt-3 rounded-xl border border-border bg-background/60 p-4 text-sm leading-relaxed whitespace-pre-wrap"><div className="mb-2 font-semibold">{activeAttempt.script.sellerName} · {activeAttempt.script.companyName} · {activeAttempt.script.purpose}</div>{activeAttempt.script.body}</div></section>
                <section className="rounded-2xl border border-border bg-card p-4"><div className="flex items-center gap-2"><h2 className="text-base font-semibold">Record outcome</h2></div><textarea value={notes} onChange={event => setNotes(event.target.value)} rows={3} placeholder="Call notes (do not enter sensitive payment data)" className="mt-3 w-full rounded-xl border border-border bg-background p-3 text-sm" />
                  <div className="mt-3 grid grid-cols-2 gap-2">{DISPOSITIONS.filter(item => item.code !== "CONSENT_GRANTED" || detailQuery.data.consent.verified).map(item => {
                    const armed = armedDisposition === item.code;
                    return (
                      <button
                        key={item.code}
                        type="button"
                        disabled={dispositionMutation.isPending}
                        aria-pressed={armed}
                        onClick={() => {
                          if (SUPPRESSING.has(item.code) && !armed) {
                            setArmedDisposition(item.code);
                            window.setTimeout(() => setArmedDisposition(a => (a === item.code ? null : a)), 4000);
                            return;
                          }
                          setArmedDisposition(null);
                          dispositionMutation.mutate(item.code);
                        }}
                        className={cn(
                          "min-h-11 rounded-xl border border-border bg-background px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-50",
                          item.tone,
                          // The semantic token, not a raw light-red shade. The armed state
                          // is the CONFIRM step on a control that suppresses a
                          // number - "Confirm: Do not call?" - and near-white
                          // ink on a 15% destructive tint over a white card
                          // measured 1.05:1. The rep could not read the word on
                          // the button they were about to press twice. The
                          // semantic token is designed to sit on its own tint
                          // and measures 4.69:1.
                          armed && "border-destructive bg-destructive/15 text-destructive ring-1 ring-destructive",
                        )}
                      >
                        {armed ? `Confirm: ${item.label}?` : item.label}
                      </button>
                    );
                  })}</div>
                  {!showCallback ? <button type="button" onClick={() => setShowCallback(true)} className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-info/25 bg-info/[0.08] text-xs font-semibold text-info"> Customer requested callback</button> : <div className="mt-2 space-y-3 rounded-xl border border-info/15 bg-info/[0.06] p-3"><label className="block text-xs font-semibold">Callback date and local time<input type="datetime-local" value={callbackAt} onChange={event => setCallbackAt(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3" /></label><label className="block text-xs font-semibold">Verified callback evidence artifact ID<input value={callbackEvidenceRef} onChange={event => setCallbackEvidenceRef(event.target.value)} placeholder="UUID bound to this exact call attempt" className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-mono font-normal" /></label><p className="text-[11px] leading-relaxed text-muted-foreground">The server accepts only a retained, verified evidence artifact bound to this tenant, lead, phone, and call attempt. A free-form note cannot authorize a callback.</p><Button variant="outline" className="w-full border-info/25 text-info" disabled={!callbackValid || dispositionMutation.isPending} onClick={() => dispositionMutation.mutate("CALLBACK_REQUESTED")}>Save requested callback</Button></div>}
                </section>
                <ConsentForm detail={detailQuery.data} attempt={activeAttempt} onSaved={() => void detailQuery.refetch()} />
              </>
            )}

            {completed && <section className="rounded-2xl border border-success/15 bg-success/[0.08] p-5 text-center"><h2 className="mt-2 text-base font-semibold text-success">Outcome saved</h2><p className="mt-1 text-sm text-muted-foreground">{completed}</p><div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center"><Button data-testid="next-eligible-lead" disabled={nextLeadMutation.isPending} onClick={() => nextLeadMutation.mutate()}>{nextLeadMutation.isPending ? "Finding next eligible lead…" : "Next eligible lead"}</Button><Button asChild variant="outline"><Link href="/calling">Return to queue</Link></Button></div></section>}

            {/* Safe-area: the sticky thumb-zone bar must clear the home
                indicator on notched phones (same env() pattern as the map). */}
            {activeAttempt && !completed && (
              <div className="sticky bottom-0 z-30 -mx-4 mt-4 border-t border-border bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-background/80" data-testid="calling-quick-dispositions">
                <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Quick outcome</div>
                <div className="mt-2 grid grid-cols-4 gap-2">
                  {([
                    { code: "NO_ANSWER", label: "No answer" },
                    { code: "INTERESTED", label: "Interested" },
                    { code: "SALE_COMPLETED", label: "Sale complete" },
                    { code: "NOT_INTERESTED", label: "Not interested" },
                  ] as Array<{ code: DispositionCode; label: string }>).map(item => {
                    // QA GATE FIX (C3): a sticky thumb-zone button that instantly
                    // records a SALE deserves the same arm-then-confirm as the
                    // suppressing outcomes.
                    const needsConfirm = item.code === "SALE_COMPLETED";
                    const armed = armedDisposition === item.code;
                    return (
                      <button
                        key={item.code}
                        type="button"
                        disabled={dispositionMutation.isPending}
                        aria-pressed={armed}
                        onClick={() => {
                          if (needsConfirm && !armed) {
                            setArmedDisposition(item.code);
                            window.setTimeout(() => setArmedDisposition(a => (a === item.code ? null : a)), 4000);
                            return;
                          }
                          setArmedDisposition(null);
                          dispositionMutation.mutate(item.code);
                        }}
                        className={cn(
                          "min-h-12 rounded-xl border border-border bg-background px-2 text-[12px] font-semibold transition-colors hover:bg-secondary active:scale-95 disabled:opacity-50",
                          armed && "border-success bg-success/15 text-emerald-100 ring-1 ring-success",
                        )}
                      >
                        {armed ? "Confirm sale?" : item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {candidate.phoneId && !completed && canOptOut && (
              <section className="rounded-2xl border border-destructive/15 bg-destructive/[0.05] p-4"><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold text-destructive">STOP / do not call</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Use immediately for any stop request, wrong number, or consent revocation. This permanently suppresses the number for this organization.</p></div></div>
                <label className="mt-3 block text-xs font-semibold">Suppression reason<select value={optOutReason} onChange={event => setOptOutReason(event.target.value as typeof optOutReason)} className="mt-1 h-11 w-full rounded-xl border border-destructive/15 bg-background px-3 font-normal"><option value="stop_request">Consumer said STOP / take me off the list</option><option value="do_not_call">Do not call request</option><option value="wrong_number">Wrong number</option><option value="wrong_party">Wrong party</option><option value="consent_revoked">Consent revoked</option></select></label>
                <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive" className="mt-3 w-full">Record STOP and suppress now</Button></AlertDialogTrigger><AlertDialogContent className="max-w-[calc(100vw-2rem)] rounded-2xl"><AlertDialogHeader><AlertDialogTitle>Suppress this number permanently?</AlertDialogTitle><AlertDialogDescription>This immediately adds the number to the internal DNC list, cancels callbacks, and invalidates unused call authorizations. It cannot be undone by a rep.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={optOutMutation.isPending} onClick={() => optOutMutation.mutate()} className="bg-destructive text-white hover:bg-red-700">{optOutMutation.isPending ? "Suppressing…" : "Confirm STOP"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
              </section>
            )}

            {detailQuery.data.consent.id && detailQuery.data.consent.verified && !detailQuery.data.consent.revoked && !completed && canOptOut && (
              <section className="rounded-2xl border border-destructive/15 bg-card p-4"><h2 className="text-sm font-semibold">Revoke recorded consent</h2><p className="mt-1 text-xs text-muted-foreground">Records an immutable revocation and permanent internal DNC suppression in one transaction.</p><label className="mt-3 block text-xs font-semibold">Revocation evidence reference<input value={revocationEvidence} onChange={event => setRevocationEvidence(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" /></label><Button variant="destructive" className="mt-3 w-full" disabled={revocationEvidence.trim().length < 3 || revokeMutation.isPending} onClick={() => revokeMutation.mutate()}>{revokeMutation.isPending ? "Revoking…" : "Revoke consent and suppress"}</Button></section>
            )}

            <section className="rounded-2xl border border-border bg-card"><details><summary className="flex min-h-14 cursor-pointer items-center gap-2 px-4 text-sm font-semibold"> Immutable activity trail ({detailQuery.data.timeline.length})</summary><div className="max-h-80 divide-y divide-border overflow-y-auto border-t border-border px-4">{detailQuery.data.timeline.length ? detailQuery.data.timeline.map(event => <div key={event.id} className="py-3"><div className="flex items-baseline justify-between gap-3"><span className="text-xs font-semibold">{formatDecision(event.eventType)}</span><time className="shrink-0 text-2xs text-muted-foreground">{dateLabel(event.createdAt)}</time></div><div className="mt-1 truncate font-mono text-2xs text-muted-foreground">{event.eventSha256}</div></div>) : <p className="py-4 text-xs text-muted-foreground">No calling activity yet.</p>}</div></details></section>
            <section className="rounded-2xl border border-border bg-card"><details><summary className="flex min-h-14 cursor-pointer items-center gap-2 px-4 text-sm font-semibold"> Attempts and callbacks ({attempts.length + callbacks.length})</summary><div className="divide-y divide-border border-t border-border px-4">{attempts.map(attempt => <div key={attempt.id} className="py-3 text-xs"><div className="flex justify-between gap-3"><span className="font-semibold">{attempt.dispositionCode ? formatDecision(attempt.dispositionCode) : "Open manual attempt"}</span><time className="text-2xs text-muted-foreground">{dateLabel(attempt.startedAt)}</time></div><div className="mt-1 text-[11px] text-muted-foreground">Rep #{attempt.representativeUserId} · script {attempt.scriptVersion}</div></div>)}{callbacks.map(callback => <div key={callback.id} className="py-3 text-xs"><div className="flex justify-between gap-3"><span className="font-semibold">Callback · {formatDecision(callback.status)}</span><time className="text-2xs text-muted-foreground">{dateLabelTz(callback.dueAt, callback.timeZone)}</time></div><div className="mt-1 text-[11px] text-muted-foreground">{callback.timeZone}</div></div>)}{!attempts.length && !callbacks.length && <p className="py-4 text-xs text-muted-foreground">No attempts or callbacks yet.</p>}</div></details></section>
          </div>
        )}
      </div>
    </CallingChrome>
  );
}
