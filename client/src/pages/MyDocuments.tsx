import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowRight, CheckCircle2, Clock3, Download, FileCheck2,
  FileSignature, FileText, Landmark, Loader2, LockKeyhole, ShieldCheck, XCircle,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { downloadOnboardingDocument } from "@/lib/onboardingDocuments";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  AgreementSnapshot,
  OnboardingDocumentStatus,
  OnboardingDocumentType,
} from "@shared/onboardingDocuments";

interface SigningRecord {
  id: number;
  documentType: OnboardingDocumentType;
  status: OnboardingDocumentStatus;
  signerName: string;
  sentAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  contentSha256: string;
}

interface DocumentItem {
  type: OnboardingDocumentType;
  label: string;
  description: string;
  required: boolean;
  version: string;
  envelope: SigningRecord | null;
}

interface DocumentsResponse {
  configured: boolean;
  provider: "homefront_sign";
  noRepProfile?: boolean;
  documents: DocumentItem[];
  progress: { completed: number; total: number };
}

interface SigningContent {
  id: number;
  recordId: string;
  status: OnboardingDocumentStatus;
  contentSha256: string;
  snapshot: AgreementSnapshot;
  disclosure: { title: string; paragraphs: readonly string[] };
  consentVersion: string;
}

const STATUS: Record<OnboardingDocumentStatus, { label: string; className: string }> = {
  creating: { label: "Preparing", className: "bg-sky-500/15 text-sky-400" },
  sent: { label: "Ready to sign", className: "bg-amber-500/15 text-amber-400" },
  delivered: { label: "Opened", className: "bg-purple-500/15 text-purple-400" },
  completed: { label: "Signed", className: "bg-emerald-500/15 text-emerald-400" },
  declined: { label: "Declined", className: "bg-red-500/15 text-red-400" },
  voided: { label: "Voided", className: "bg-muted text-muted-foreground" },
  failed: { label: "Needs attention", className: "bg-red-500/15 text-red-400" },
};

function StatusPill({ status }: { status: OnboardingDocumentStatus }) {
  const item = STATUS[status];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-semibold ${item.className}`}>{item.label}</span>;
}

function LegalCheckbox({ checked, onChange, children, testId }: { checked: boolean; onChange: (checked: boolean) => void; children: React.ReactNode; testId: string }) {
  return (
    <label className="flex items-start gap-3 rounded-xl border border-border bg-secondary/20 px-3.5 py-3 cursor-pointer hover:border-primary/40">
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} className="mt-0.5 h-5 w-5 rounded accent-primary" data-testid={testId} />
      <span className="text-xs leading-relaxed text-foreground">{children}</span>
    </label>
  );
}

function SigningDialog({ record, onClose }: { record: SigningRecord | null; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [readToEnd, setReadToEnd] = useState(false);
  const [consent, setConsent] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [intent, setIntent] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState("");

  const content = useQuery<SigningContent>({
    queryKey: ["/api/onboarding/documents/content", record?.id],
    queryFn: () => apiRequest("GET", `/api/onboarding/documents/${record!.id}/content`).then(response => response.json()),
    enabled: !!record,
    staleTime: Infinity,
  });

  useEffect(() => {
    setReadToEnd(false);
    setConsent(false);
    setAcknowledge(false);
    setIntent(false);
    setTypedName("");
    setDeclining(false);
    setDeclineReason("");
  }, [record?.id]);

  useEffect(() => {
    const node = scrollRef.current;
    if (content.data && node && node.scrollHeight <= node.clientHeight + 8) setReadToEnd(true);
  }, [content.data]);

  const sign = useMutation({
    mutationFn: () => apiRequest("POST", `/api/onboarding/documents/${record!.id}/sign`, {
      typedName,
      documentSha256: content.data!.contentSha256,
      consentToElectronicRecords: consent,
      acknowledgeRead: acknowledge,
      intentToSign: intent,
    }).then(response => response.json()),
    onSuccess: result => {
      toast({
        title: "Agreement signed",
        description: result.receiptSent ? "Resend emailed your completed PDF." : "Your PDF is ready in My Documents.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/documents/me"] });
      onClose();
    },
    onError: (error: any) => toast({ title: "Signature not completed", description: error.message, variant: "destructive" }),
  });

  const decline = useMutation({
    mutationFn: () => apiRequest("POST", `/api/onboarding/documents/${record!.id}/decline`, { reason: declineReason }).then(response => response.json()),
    onSuccess: () => {
      toast({ title: "Agreement declined", description: "Your manager can see that you declined this agreement." });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/documents/me"] });
      onClose();
    },
    onError: (error: any) => toast({ title: "Could not decline", description: error.message, variant: "destructive" }),
  });

  const ready = readToEnd && consent && acknowledge && intent && typedName.trim().length >= 2;
  const snapshot = content.data?.snapshot;

  return (
    <Dialog open={!!record} onOpenChange={open => !open && onClose()}>
      <DialogContent className="bg-card border-border text-foreground max-w-3xl h-[92vh] sm:h-[88vh] p-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border flex-shrink-0">
          <DialogTitle className="text-base flex items-center gap-2 pr-8">
            <span className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center"><FileSignature className="w-4 h-4" /></span>
            {snapshot?.title || "Loading agreement"}
          </DialogTitle>
          {content.data && <p className="text-2xs text-muted-foreground font-mono mt-1">Document SHA-256 {content.data.contentSha256}</p>}
        </DialogHeader>

        {content.isLoading && <div className="flex-1 p-5 space-y-3"><div className="h-7 bg-secondary rounded animate-pulse" /><div className="h-52 bg-secondary/60 rounded animate-pulse" /></div>}
        {content.isError && <div className="flex-1 grid place-items-center p-6"><div className="text-center"><AlertTriangle className="w-7 h-7 text-red-400 mx-auto" /><p className="text-sm font-semibold mt-2">Couldn’t open this agreement</p><Button variant="outline" size="sm" className="mt-3" onClick={() => content.refetch()}>Try again</Button></div></div>}

        {content.data && snapshot && (
          <>
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto px-5 sm:px-7 py-5"
              tabIndex={0}
              role="document"
              aria-label={`${snapshot.title} agreement text`}
              onScroll={event => {
                const node = event.currentTarget;
                if (node.scrollTop + node.clientHeight >= node.scrollHeight - 24) setReadToEnd(true);
              }}
              data-testid="signing-document-scroll"
            >
              <div className="max-w-2xl mx-auto rounded-xl bg-white text-slate-800 border border-slate-200 shadow-sm px-5 sm:px-8 py-7">
                <div className="text-center border-b border-slate-200 pb-5">
                  <p className="text-2xs font-bold tracking-[0.18em] uppercase text-teal-700">Home Front Sign</p>
                  <h2 className="text-xl font-bold text-slate-900 mt-2">{snapshot.title}</h2>
                  <p className="text-xs text-slate-500 mt-2">Version {snapshot.documentVersion} • Issued {new Date(snapshot.issuedAt).toLocaleDateString()}</p>
                </div>
                <div className="grid sm:grid-cols-2 gap-3 py-5 text-xs">
                  <div className="rounded-lg bg-slate-50 p-3"><span className="font-bold block text-2xs text-slate-500 uppercase">Company</span>{snapshot.companyName}</div>
                  <div className="rounded-lg bg-slate-50 p-3"><span className="font-bold block text-2xs text-slate-500 uppercase">Signer</span>{snapshot.signerName}<br />{snapshot.signerEmail}</div>
                </div>
                <div className="space-y-5">
                  {snapshot.sections.map(section => (
                    <section key={section.heading}>
                      <h3 className="text-sm font-bold text-slate-900">{section.heading}</h3>
                      {section.paragraphs.map((paragraph, index) => <p key={index} className="text-xs leading-6 mt-2">{paragraph}</p>)}
                      {!!section.bullets?.length && <ul className="list-disc pl-5 mt-2 space-y-1.5">{section.bullets.map(bullet => <li key={bullet} className="text-xs leading-5">{bullet}</li>)}</ul>}
                    </section>
                  ))}
                </div>
                <section className="mt-7 pt-5 border-t border-slate-200">
                  <h3 className="text-sm font-bold text-slate-900">{content.data.disclosure.title}</h3>
                  {content.data.disclosure.paragraphs.map(paragraph => <p key={paragraph} className="text-xs leading-5 mt-2 text-slate-600">{paragraph}</p>)}
                </section>
                <div className="mt-7 rounded-lg bg-teal-50 border border-teal-200 p-3 text-xs font-semibold text-teal-900 flex items-center gap-2">
                  <FileCheck2 className="w-4 h-4" /> You reached the end of the agreement.
                </div>
              </div>
            </div>

            <div className="border-t border-border bg-card px-4 sm:px-6 py-4 max-h-[46vh] overflow-y-auto flex-shrink-0">
              {!readToEnd && <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-300 mb-3">Scroll through the complete agreement before signing.</div>}
              {!declining ? (
                <div className="space-y-2.5 max-w-2xl mx-auto">
                  <LegalCheckbox checked={consent} onChange={setConsent} testId="esign-consent">I consent to receive and sign this agreement electronically, understand I may request a free paper copy, and confirm I can access this electronic record.</LegalCheckbox>
                  <LegalCheckbox checked={acknowledge} onChange={setAcknowledge} testId="esign-read">I have reviewed the complete agreement and the electronic-record disclosure.</LegalCheckbox>
                  <LegalCheckbox checked={intent} onChange={setIntent} testId="esign-intent">I intend my typed name below to be my electronic signature and to bind me to this agreement.</LegalCheckbox>
                  <div>
                    <label htmlFor="typed-signature" className="text-[11px] font-semibold text-muted-foreground">Type your full legal name exactly as shown</label>
                    <Input id="typed-signature" value={typedName} onChange={event => setTypedName(event.target.value)} placeholder={snapshot.signerName} className="mt-1.5 h-11 font-medium" autoComplete="name" data-testid="typed-signature" />
                  </div>
                  <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2 pt-1">
                    <Button variant="ghost" className="text-red-400 hover:text-red-300" onClick={() => setDeclining(true)}><XCircle className="w-4 h-4 mr-1.5" /> Decline</Button>
                    <Button disabled={!ready || sign.isPending} onClick={() => sign.mutate()} className="h-11 bg-primary hover:bg-primary/90 text-white" data-testid="complete-signature">
                      {sign.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <LockKeyhole className="w-4 h-4 mr-2" />} Sign agreement
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 max-w-2xl mx-auto">
                  <div><p className="text-sm font-semibold">Decline this agreement?</p><p className="text-xs text-muted-foreground mt-1">Your manager will be notified. No electronic signature will be created.</p></div>
                  <Textarea value={declineReason} onChange={event => setDeclineReason(event.target.value)} placeholder="Brief reason for declining" className="min-h-20" data-testid="decline-reason" />
                  <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setDeclining(false)}>Back</Button><Button variant="destructive" disabled={declineReason.trim().length < 2 || decline.isPending} onClick={() => decline.mutate()}>{decline.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Confirm decline</Button></div>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function MyDocuments() {
  const { toast } = useToast();
  const [activeRecord, setActiveRecord] = useState<SigningRecord | null>(null);
  const query = useQuery<DocumentsResponse>({
    queryKey: ["/api/onboarding/documents/me"],
    queryFn: () => apiRequest("GET", "/api/onboarding/documents/me").then(response => response.json()),
  });

  const download = async (document: DocumentItem) => {
    if (!document.envelope) return;
    try {
      await downloadOnboardingDocument(document.envelope.id, `${document.type.replace(/_/g, "-")}.pdf`);
    } catch (error: any) {
      toast({ title: "Download failed", description: error.message, variant: "destructive" });
    }
  };

  const data = query.data;
  const percentage = data?.progress.total ? Math.round((data.progress.completed / data.progress.total) * 100) : 0;
  const nextDocument = data?.documents.find(document =>
    document.envelope?.status === "sent" || document.envelope?.status === "delivered"
  );

  return (
    <div className="p-4 sm:p-6 pb-24 md:pb-6 max-w-3xl mx-auto space-y-5">
      <header>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Rep onboarding</div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground mt-0.5 flex items-center gap-2"><FileSignature className="w-5 h-5 text-primary" /> My Documents</h1>
        <p className="text-sm text-muted-foreground mt-1">Review, sign, and download your agreements with Home Front Sign.</p>
      </header>

      {query.isLoading && <div className="h-40 rounded-2xl bg-card border border-border animate-pulse" />}
      {query.isError && <div className="rounded-2xl bg-card border border-red-500/30 p-6 text-center"><p className="text-sm font-semibold">Couldn’t load your documents</p><Button variant="outline" size="sm" className="mt-3" onClick={() => query.refetch()}>Try again</Button></div>}
      {data?.noRepProfile && <div className="rounded-2xl bg-card border border-amber-500/30 p-5 flex items-start gap-3"><AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" /><div><p className="text-sm font-semibold">No rep profile linked</p><p className="text-xs text-muted-foreground mt-1">Ask your manager to link your login to your team profile.</p></div></div>}
      {data && !data.noRepProfile && !data.configured && <div className="rounded-2xl bg-card border border-amber-500/30 p-4 flex items-start gap-3"><AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" /><div><p className="text-sm font-semibold">Onboarding email is temporarily unavailable</p><p className="text-xs text-muted-foreground mt-1">Existing agreements remain available to review, sign, and download. Your manager cannot issue new ones until Resend is connected.</p></div></div>}

      {data && !data.noRepProfile && (
        <>
          {nextDocument?.envelope && (
            <section className="rounded-2xl border border-primary/25 bg-primary/[0.07] p-4" aria-label="Next onboarding task" data-testid="next-document-task">
              <div className="flex items-start gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">
                  <FileSignature className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-primary">Next step</div>
                  <div className="mt-0.5 text-[15px] font-semibold text-foreground">Sign {nextDocument.label}</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Review the agreement and confirm your consent to keep onboarding moving.</p>
                </div>
              </div>
              <Button className="mt-4 w-full" onClick={() => setActiveRecord(nextDocument.envelope)}>
                Review &amp; sign <ArrowRight className="h-4 w-4" />
              </Button>
            </section>
          )}
          {/* Signing agreements is only half of onboarding — a rep cannot be
              PAID until their W-9 and bank details are on file. That surface
              lives on its own page; this is the signpost to it. */}
          <Link
            href="/tax-and-pay"
            data-testid="link-tax-and-pay"
            className="block rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/40 focus-visible:border-primary/40 focus-visible:outline-none"
          >
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <Landmark className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Before you can be paid</div>
                <div className="mt-0.5 text-[15px] font-semibold text-foreground">Tax form &amp; direct deposit</div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  File your IRS Form W-9 and tell us which bank account your commission lands in.
                </p>
              </div>
              <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </div>
          </Link>
          <section className="rounded-2xl bg-card border border-border p-4" aria-label="Onboarding progress">
            <div className="flex items-center justify-between gap-3"><div><div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Onboarding progress</div><div className="text-lg font-semibold mt-0.5">{data.progress.completed} of {data.progress.total} signed</div></div><div className={`w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold ${percentage === 100 ? "bg-emerald-500/15 text-emerald-400" : "bg-primary/10 text-primary"}`}>{percentage}%</div></div>
            <div className="h-2 rounded-full bg-muted mt-3 overflow-hidden"><div className="h-full bg-primary rounded-full transition-all" style={{ width: `${percentage}%` }} /></div>
          </section>
          <section className="rounded-2xl bg-card border border-border overflow-hidden"><div className="divide-y divide-border">
            {data.documents.map(document => {
              const record = document.envelope;
              const actionable = record && (record.status === "sent" || record.status === "delivered");
              return <article key={document.type} className="render-lazy p-4 flex flex-col sm:flex-row sm:items-start gap-3" data-testid={`onboarding-document-${document.type}`}>
                <div className="flex items-start gap-3 min-w-0 flex-1"><div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${record?.status === "completed" ? "bg-emerald-500/10" : "bg-secondary"}`}>{record?.status === "completed" ? <CheckCircle2 className="w-5 h-5 text-emerald-400" /> : <FileText className="w-5 h-5 text-muted-foreground" />}</div><div className="min-w-0"><div className="flex items-center gap-2 flex-wrap"><h2 className="text-sm font-semibold">{document.label}</h2>{record && <StatusPill status={record.status} />}</div><p className="text-xs text-muted-foreground mt-1 leading-relaxed">{document.description}</p>{record?.failureReason && <p className="text-[11px] text-red-400 mt-1">{record.failureReason}</p>}{!record && <p className="text-[11px] text-muted-foreground mt-1 inline-flex items-center gap-1"><Clock3 className="w-3 h-3" /> Waiting for your manager</p>}</div></div>
                <div className="flex-shrink-0 pl-[52px] sm:pl-0">{actionable && <Button size="sm" className="h-9 bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setActiveRecord(record)} data-testid={`sign-document-${document.type}`}><FileSignature className="w-3.5 h-3.5 mr-1" /> Review &amp; sign</Button>}{record?.status === "completed" && <Button size="sm" variant="outline" className="h-9 border-border" onClick={() => download(document)}><Download className="w-3.5 h-3.5 mr-1" /> Signed PDF</Button>}</div>
              </article>;
            })}
          </div></section>
          <div className="rounded-xl bg-secondary/30 border border-border px-4 py-3 flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck className="w-4 h-4 text-primary mt-px flex-shrink-0" /> Home Front Sign binds your authenticated account and explicit consent to the exact SHA-256 document hash. Resend delivers invitations and completed copies.</div>
        </>
      )}
      <SigningDialog record={activeRecord} onClose={() => setActiveRecord(null)} />
    </div>
  );
}
