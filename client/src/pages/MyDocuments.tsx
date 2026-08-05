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
import { PdfReviewPane, prefetchPdf } from "@/components/PdfReviewPane";
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
  completedPdfSha256?: string | null;
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
  const endRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);
  const [readToEnd, setReadToEnd] = useState(false);
  // The rep reviews the REAL agreement PDF by default — the same document the
  // executed copy is rendered from, paginated exactly as it will be filed. The
  // text version stays one tap away because an <object> PDF is opaque to screen
  // readers, so the accessible path must not be the PDF.
  const [viewMode, setViewMode] = useState<"pdf" | "text">("pdf");
  const [readProgress, setReadProgress] = useState(0);
  const [sectionIndex, setSectionIndex] = useState(0);
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

  const snapshot = content.data?.snapshot;
  // Every agreement section, plus the electronic-record disclosure that closes
  // the document — the disclosure is part of what the rep must read.
  const snapshotSectionCount = snapshot ? snapshot.sections.length + 1 : 0;

  useEffect(() => {
    setReadToEnd(false);
    setReadProgress(0);
    setSectionIndex(0);
    setConsent(false);
    setAcknowledge(false);
    setIntent(false);
    setTypedName("");
    setDeclining(false);
    setDeclineReason("");
  }, [record?.id]);

  useEffect(() => {
    const node = scrollRef.current;
    if (content.data && node && node.scrollHeight <= node.clientHeight + 8) {
      setReadToEnd(true);
      setReadProgress(100);
    }
  }, [content.data]);

  // Reading progress is measured, not guessed: the bar tracks real scroll
  // position and the section counter reports the heading actually under the
  // top of the viewport, so the gate reads as "here is how much is left"
  // instead of an unexplained disabled button.
  const trackReading = (node: HTMLDivElement) => {
    const scrollable = Math.max(1, node.scrollHeight - node.clientHeight);
    const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 24;
    setReadProgress(atEnd ? 100 : Math.min(100, Math.max(0, Math.round((node.scrollTop / scrollable) * 100))));
    const containerTop = node.getBoundingClientRect().top;
    let index = 0;
    sectionRefs.current.forEach((element, position) => {
      if (element && element.getBoundingClientRect().top - containerTop <= 96) index = position;
    });
    setSectionIndex(index);
    if (atEnd) setReadToEnd(true);
  };

  // Keyboard and screen-reader users cannot "scroll to the bottom" the way a
  // mouse wheel does, and a scroll container they must drag is a wall, not a
  // gate. This jumps them to the end of the agreement and moves focus there,
  // so the same acknowledgment is reachable without a pointer.
  const jumpToEnd = () => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
      trackReading(node);
    }
    setReadToEnd(true);
    setReadProgress(100);
    setSectionIndex(Math.max(0, (snapshotSectionCount || 1) - 1));
    endRef.current?.focus();
  };

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
        description: `${result.receiptSent ? "Resend emailed your completed PDF." : "Your PDF is ready in My Documents."} Its SHA-256 is listed next to the download so you can verify it against the certificate page.`,
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

        {content.isLoading && <div className="flex-1 p-5 space-y-3" role="status" aria-busy="true" aria-label="Loading agreement"><div className="h-7 bg-secondary rounded animate-pulse" /><div className="h-52 bg-secondary/60 rounded animate-pulse" /></div>}
        {content.isError && <div className="flex-1 grid place-items-center p-6"><div className="text-center"><AlertTriangle className="w-7 h-7 text-red-400 mx-auto" /><p className="text-sm font-semibold mt-2">Couldn’t open this agreement</p><Button variant="outline" size="sm" className="mt-3" onClick={() => content.refetch()}>Try again</Button></div></div>}

        {content.data && snapshot && (
          <>
            <div className="flex items-center gap-1.5 border-b border-border px-5 py-2 flex-shrink-0" role="tablist" aria-label="Document view">
              {([["pdf", "Document"], ["text", "Text version"]] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={viewMode === mode}
                  onClick={() => setViewMode(mode)}
                  data-testid={`signing-view-${mode}`}
                  className={`h-8 px-3 rounded-lg text-xs font-semibold transition-colors ${viewMode === mode ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {label}
                </button>
              ))}
              <span className="ml-auto text-2xs text-muted-foreground">
                {viewMode === "pdf" ? "The full agreement, exactly as it will be filed" : "Screen-reader friendly"}
              </span>
            </div>

            {viewMode === "pdf" && (
              <PdfReviewPane
                url={`/api/onboarding/documents/${record!.id}/preview.pdf`}
                openBeaconUrl={`/api/onboarding/documents/${record!.id}/preview-opened`}
                fileName={`${snapshot.title.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-review.pdf`}
                title={`${snapshot.title} — full document`}
                testId="agreement-pdf-review"
                // Loading the complete document IS the review surface: the rep
                // can scroll, zoom and page through every clause natively. The
                // acknowledgment checkbox below remains the attestation — this
                // only unblocks it, it does not stand in for it.
                onLoaded={() => { setReadToEnd(true); setReadProgress(100); }}
              />
            )}

            <div className={`flex items-center gap-3 border-b border-border px-5 py-2.5 flex-shrink-0 ${viewMode === "pdf" ? "hidden" : ""}`} data-testid="reading-progress">
              <div className="flex-1">
                <div
                  className="h-1.5 rounded-full bg-muted overflow-hidden"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={readProgress}
                  aria-label="Agreement reading progress"
                >
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${readProgress}%` }} />
                </div>
                <p className="text-2xs text-muted-foreground mt-1" aria-live="polite">
                  Section {Math.min(sectionIndex + 1, Math.max(snapshotSectionCount, 1))} of {Math.max(snapshotSectionCount, 1)}
                  {readToEnd ? " — you reached the end" : ""}
                </p>
              </div>
              <Button variant="outline" size="sm" className="h-8 flex-shrink-0 text-xs" onClick={jumpToEnd} data-testid="skip-to-agreement-end">
                Skip to the end
              </Button>
            </div>

            <div
              ref={scrollRef}
              className={`flex-1 overflow-y-auto px-5 sm:px-7 py-5 ${viewMode === "pdf" ? "hidden" : ""}`}
              tabIndex={0}
              role="document"
              aria-label={`${snapshot.title} agreement text`}
              onScroll={event => trackReading(event.currentTarget)}
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
                  {snapshot.sections.map((section, sectionPosition) => (
                    <section key={section.heading} ref={element => { sectionRefs.current[sectionPosition] = element; }}>
                      <h3 className="text-sm font-bold text-slate-900">{section.heading}</h3>
                      {section.paragraphs.map((paragraph, index) => <p key={index} className="text-xs leading-6 mt-2">{paragraph}</p>)}
                      {!!section.bullets?.length && <ul className="list-disc pl-5 mt-2 space-y-1.5">{section.bullets.map(bullet => <li key={bullet} className="text-xs leading-5">{bullet}</li>)}</ul>}
                      {/* The rate table, rendered here too. A table that exists
                          only in the PDF would mean the document a rep scrolls
                          before signing is not the document they sign. */}
                      {!!section.rows?.length && (
                        <table className="mt-3 w-full border-collapse text-xs" data-testid="agreement-rate-table">
                          <thead>
                            <tr className="border-b border-teal-200 text-2xs uppercase tracking-wide text-slate-500">
                              <th scope="col" className="py-1.5 text-left font-bold">Qualified sales in a commission week</th>
                              <th scope="col" className="py-1.5 text-right font-bold">Rate</th>
                            </tr>
                          </thead>
                          <tbody>
                            {section.rows.map(row => (
                              <tr key={row.band} className="border-b border-slate-100 last:border-0">
                                <td className="py-1.5 pr-3 text-slate-700">{row.band}</td>
                                <td className="py-1.5 text-right font-bold tabular-nums text-slate-900">{row.rate}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </section>
                  ))}
                </div>
                <section className="mt-7 pt-5 border-t border-slate-200" ref={element => { sectionRefs.current[snapshot.sections.length] = element; }}>
                  <h3 className="text-sm font-bold text-slate-900">{content.data.disclosure.title}</h3>
                  {content.data.disclosure.paragraphs.map(paragraph => <p key={paragraph} className="text-xs leading-5 mt-2 text-slate-600">{paragraph}</p>)}
                </section>
                <div
                  ref={endRef}
                  tabIndex={-1}
                  className="mt-7 rounded-lg bg-teal-50 border border-teal-200 p-3 text-xs font-semibold text-teal-900 flex items-center gap-2"
                  data-testid="agreement-end-marker"
                >
                  <FileCheck2 className="w-4 h-4" /> You reached the end of the agreement.
                </div>
              </div>
            </div>

            <div className="border-t border-border bg-card px-4 sm:px-6 py-4 max-h-[46vh] overflow-y-auto flex-shrink-0" data-testid="signature-panel">
              {!readToEnd && <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-300 mb-3">Scroll through the complete agreement before signing, or use “Skip to the end”.</div>}
              {!declining ? (
                <div className="space-y-2.5 max-w-2xl mx-auto">
                  <LegalCheckbox checked={consent} onChange={setConsent} testId="esign-consent">I consent to receive and sign this agreement electronically, understand I may request a free paper copy, and confirm I can access this electronic record.</LegalCheckbox>
                  <LegalCheckbox checked={acknowledge} onChange={setAcknowledge} testId="esign-read">I have reviewed the complete agreement and the electronic-record disclosure.</LegalCheckbox>
                  <LegalCheckbox checked={intent} onChange={setIntent} testId="esign-intent">I intend my typed name below to be my electronic signature and to bind me to this agreement.</LegalCheckbox>
                  <div>
                    {/* The expected name is NOT shown next to this field. Printing
                        it here turned the signature into a copy-and-paste exercise:
                        whoever was at the keyboard could produce a perfect match
                        without knowing whose name it was. The rep types the name
                        they know; the server still matches it (shared/onboardingDocuments). */}
                    <label htmlFor="typed-signature" className="text-[11px] font-semibold text-muted-foreground">
                      Type your full legal name exactly as it appears on your agreement
                    </label>
                    <Input id="typed-signature" value={typedName} onChange={event => setTypedName(event.target.value)} placeholder="Type your full legal name" className="mt-1.5 h-11 font-medium" autoComplete="off" data-testid="typed-signature" />
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

  // Warm the PDF bytes for whatever the signer is about to open, while they are
  // still looking at the list — the signing dialog then opens onto a rendered
  // document instead of a spinner. PDF ONLY, and via the warm=1 variant that
  // writes no audit row: GET /content is deliberately NOT prefetched, because
  // that endpoint IS the view-evidence recorder (markDocumentViewed, the
  // hash-chained document_viewed event) and pre-firing it would both fabricate
  // opens and, via the shared query cache, swallow the real one.
  useEffect(() => {
    const actionable = (query.data?.documents ?? []).filter(
      document => document.envelope && (document.envelope.status === "sent" || document.envelope.status === "delivered"),
    );
    for (const document of actionable) {
      prefetchPdf(`/api/onboarding/documents/${document.envelope!.id}/preview.pdf`);
    }
  }, [query.data]);

  const download = async (document: DocumentItem) => {
    if (!document.envelope) return;
    try {
      await downloadOnboardingDocument(document.envelope.id, `${document.type.replace(/_/g, "-")}.pdf`);
    } catch (error: any) {
      toast({ title: "Download failed", description: error.message, variant: "destructive" });
    }
  };

  const data = query.data;
  // Tax paperwork status, so the W-9 row in the packet reports the truth rather
  // than a static "go do this". Both endpoints 404 when nothing is on file yet,
  // which is a normal state for a new rep, not an error worth retrying.
  const w9 = useQuery<{ submitted?: boolean } | null>({
    queryKey: ["/api/me/w9"],
    queryFn: () => apiRequest("GET", "/api/me/w9").then(r => (r.ok ? r.json() : null)).catch(() => null),
    retry: false,
  });
  const bank = useQuery<{ last4?: string } | null>({
    queryKey: ["/api/me/bank"],
    queryFn: () => apiRequest("GET", "/api/me/bank").then(r => (r.ok ? r.json() : null)).catch(() => null),
    retry: false,
  });
  const w9Filed = !!w9.data?.submitted;
  const taxReady = w9Filed && !!bank.data?.last4;

  const percentage = data?.progress.total ? Math.round((data.progress.completed / data.progress.total) * 100) : 0;
  const nextDocument = data?.documents.find(document =>
    document.envelope?.status === "sent" || document.envelope?.status === "delivered"
  );

  return (
    <div className="hf-stagger p-4 sm:p-6 pb-24 md:pb-6 max-w-3xl mx-auto space-y-5">
      <header>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Rep onboarding</div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground mt-0.5 flex items-center gap-2"><FileSignature className="w-5 h-5 text-primary" /> My documents</h1>
        <p className="text-sm text-muted-foreground mt-1">Review, sign, and download your agreements with Home Front Sign.</p>
      </header>

      {query.isLoading && <div className="h-40 rounded-2xl bg-card border border-border animate-pulse" role="status" aria-busy="true" aria-label="Loading your documents" />}
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
          {percentage === 100 && (
            <section
              className="hf-shine relative overflow-hidden rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 flex items-center gap-3"
              aria-label="All agreements signed"
              data-testid="all-signed-banner"
            >
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-500/15 text-emerald-400">
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Every agreement is signed — you're field-ready.</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Your executed PDFs live below, hash-verified, whenever you need them.</p>
              </div>
            </section>
          )}
          <section className="rounded-2xl bg-card border border-border p-4" aria-label="Onboarding progress">
            <div className="flex items-center justify-between gap-3"><div><div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Onboarding progress</div><div className="text-lg font-semibold mt-0.5">{data.progress.completed} of {data.progress.total} signed</div></div><div className={`w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold ${percentage === 100 ? "bg-emerald-500/15 text-emerald-400" : "bg-primary/10 text-primary"}`}>{percentage}%</div></div>
            <div className="h-2 rounded-full bg-muted mt-3 overflow-hidden"><div className={`h-full rounded-full transition-all duration-500 ${percentage === 100 ? "bg-emerald-500" : "bg-primary"}`} style={{ width: `${percentage}%` }} /></div>
          </section>
          <section className="rounded-2xl bg-card border border-border overflow-hidden"><div className="divide-y divide-border">
            {/* The W-9 is onboarding paperwork the company requires before it can
                pay anyone, so it belongs IN the packet — one list of everything a
                rep owes, with one progress number — rather than as a separate
                destination they have to remember to visit. It links out to the
                tax form because a W-9 is filled in, not counter-signed like an
                agreement; the form itself opens the real IRS PDF. */}
            <article className="render-lazy p-4 flex flex-col sm:flex-row sm:items-start gap-3" data-testid="onboarding-document-w9">
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${taxReady ? "bg-emerald-500/10" : "bg-secondary"}`}>
                  {taxReady ? <CheckCircle2 className="w-5 h-5 text-emerald-400" /> : <Landmark className="w-5 h-5 text-muted-foreground" />}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-sm font-semibold">IRS Form W-9 &amp; direct deposit</h2>
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${taxReady ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"}`} data-testid="w9-packet-status">
                      {taxReady ? "On file" : w9Filed ? "Bank details needed" : "Not filed"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Certify your taxpayer information on the official IRS form and tell us which account your commission lands in. You cannot be paid until both are on file.
                  </p>
                </div>
              </div>
              <div className="flex-shrink-0 pl-[52px] sm:pl-0">
                <Link href="/tax-and-pay" data-testid="link-tax-and-pay">
                  <Button size="sm" variant={taxReady ? "outline" : "default"} className="h-9">
                    <Landmark className="w-3.5 h-3.5 mr-1" /> {taxReady ? "View" : "Complete"}
                  </Button>
                </Link>
              </div>
            </article>
            {data.documents.map(document => {
              const record = document.envelope;
              const actionable = record && (record.status === "sent" || record.status === "delivered");
              return <article key={document.type} className="render-lazy p-4 flex flex-col sm:flex-row sm:items-start gap-3" data-testid={`onboarding-document-${document.type}`}>
                <div className="flex items-start gap-3 min-w-0 flex-1"><div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${record?.status === "completed" ? "bg-emerald-500/10" : "bg-secondary"}`}>{record?.status === "completed" ? <CheckCircle2 className="w-5 h-5 text-emerald-400" /> : <FileText className="w-5 h-5 text-muted-foreground" />}</div><div className="min-w-0"><div className="flex items-center gap-2 flex-wrap"><h2 className="text-sm font-semibold">{document.label}</h2>{record && <StatusPill status={record.status} />}</div><p className="text-xs text-muted-foreground mt-1 leading-relaxed">{document.description}</p>{record?.failureReason && <p className="text-[11px] text-red-400 mt-1">{record.failureReason}</p>}{record?.status === "completed" && record.completedPdfSha256 && <p className="text-2xs text-muted-foreground font-mono mt-1.5 break-all" data-testid={`completed-pdf-sha-${document.type}`}><span className="font-sans font-semibold">Signed PDF SHA-256</span> {record.completedPdfSha256}</p>}{!record && <p className="text-[11px] text-muted-foreground mt-1 inline-flex items-center gap-1"><Clock3 className="w-3 h-3" /> Waiting for your manager</p>}</div></div>
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
