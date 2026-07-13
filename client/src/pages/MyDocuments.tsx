import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, Clock3, Download, ExternalLink,
  FileSignature, FileText, Loader2, ShieldCheck,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { downloadOnboardingDocument } from "@/lib/onboardingDocuments";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import type { OnboardingDocumentStatus, OnboardingDocumentType } from "@shared/onboardingDocuments";

interface Envelope {
  id: number;
  documentType: OnboardingDocumentType;
  status: OnboardingDocumentStatus;
  sentAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
}

interface DocumentItem {
  type: OnboardingDocumentType;
  label: string;
  description: string;
  required: boolean;
  envelope: Envelope | null;
}

interface DocumentsResponse {
  configured: boolean;
  noRepProfile?: boolean;
  documents: DocumentItem[];
  progress: { completed: number; total: number };
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
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${item.className}`}>{item.label}</span>;
}

export default function MyDocuments() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery<DocumentsResponse>({
    queryKey: ["/api/onboarding/documents/me"],
    queryFn: () => apiRequest("GET", "/api/onboarding/documents/me").then(response => response.json()),
    refetchInterval: data => data.state.data?.documents.some(document => ["creating", "sent", "delivered"].includes(document.envelope?.status ?? "")) ? 15_000 : false,
  });

  useEffect(() => {
    if (!window.location.hash.includes("signing=returned")) return;
    toast({ title: "Returned from DocuSign", description: "Your signature status will update as soon as DocuSign confirms it." });
    queryClient.invalidateQueries({ queryKey: ["/api/onboarding/documents/me"] });
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/my-documents`);
  }, [queryClient, toast]);

  const sign = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/onboarding/documents/${id}/sign`).then(response => response.json()),
    onSuccess: data => {
      if (!data?.url) throw new Error("DocuSign did not return a signing link");
      window.location.assign(data.url);
    },
    onError: (error: any) => toast({ title: "Could not open DocuSign", description: error.message, variant: "destructive" }),
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

  return (
    <div className="p-4 sm:p-6 pb-24 md:pb-6 max-w-3xl mx-auto space-y-5">
      <header>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Rep onboarding</div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground mt-0.5 flex items-center gap-2">
          <FileSignature className="w-5 h-5 text-primary" /> My Documents
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Review and sign your required agreements securely through DocuSign.</p>
      </header>

      {query.isLoading && <div className="h-40 rounded-2xl bg-card border border-border animate-pulse" />}
      {query.isError && (
        <div className="rounded-2xl bg-card border border-red-500/30 p-6 text-center">
          <p className="text-sm font-semibold text-foreground">Couldn’t load your documents</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => query.refetch()}>Try again</Button>
        </div>
      )}

      {data?.noRepProfile && (
        <div className="rounded-2xl bg-card border border-amber-500/30 p-5 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" />
          <div><p className="text-sm font-semibold text-foreground">No rep profile linked</p><p className="text-xs text-muted-foreground mt-1">Ask your manager to link your login to your team profile.</p></div>
        </div>
      )}

      {data && !data.noRepProfile && !data.configured && (
        <div className="rounded-2xl bg-card border border-border p-6 text-center">
          <ShieldCheck className="w-8 h-8 text-muted-foreground mx-auto" />
          <p className="text-sm font-semibold text-foreground mt-3">Your documents aren’t ready yet</p>
          <p className="text-xs text-muted-foreground mt-1">Your manager will notify you when agreements are available to sign.</p>
        </div>
      )}

      {data && data.configured && (
        <>
          <section className="rounded-2xl bg-card border border-border p-4" aria-label="Onboarding progress">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Onboarding progress</div>
                <div className="text-lg font-semibold text-foreground mt-0.5">{data.progress.completed} of {data.progress.total} signed</div>
              </div>
              <div className={`w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold ${percentage === 100 ? "bg-emerald-500/15 text-emerald-400" : "bg-primary/10 text-primary"}`}>{percentage}%</div>
            </div>
            <div className="h-2 rounded-full bg-muted mt-3 overflow-hidden"><div className="h-full bg-primary rounded-full transition-all" style={{ width: `${percentage}%` }} /></div>
          </section>

          <section className="rounded-2xl bg-card border border-border overflow-hidden">
            <div className="divide-y divide-border">
              {data.documents.map(document => {
                const envelope = document.envelope;
                const actionable = envelope && (envelope.status === "sent" || envelope.status === "delivered");
                return (
                  <article key={document.type} className="p-4 flex items-start gap-3" data-testid={`onboarding-document-${document.type}`}>
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${envelope?.status === "completed" ? "bg-emerald-500/10" : "bg-secondary"}`}>
                      {envelope?.status === "completed" ? <CheckCircle2 className="w-5 h-5 text-emerald-400" /> : <FileText className="w-5 h-5 text-muted-foreground" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="text-sm font-semibold text-foreground">{document.label}</h2>
                        {envelope && <StatusPill status={envelope.status} />}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{document.description}</p>
                      {envelope?.failureReason && <p className="text-[11px] text-red-400 mt-1">{envelope.failureReason}</p>}
                      {!envelope && <p className="text-[11px] text-muted-foreground mt-1 inline-flex items-center gap-1"><Clock3 className="w-3 h-3" /> Waiting for your manager</p>}
                    </div>
                    <div className="flex-shrink-0">
                      {actionable && (
                        <Button size="sm" className="h-9 bg-primary hover:bg-primary/90 text-white" disabled={sign.isPending}
                          onClick={() => sign.mutate(envelope.id)} data-testid={`sign-document-${document.type}`}>
                          {sign.isPending && sign.variables === envelope.id ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5 mr-1" />} Review &amp; sign
                        </Button>
                      )}
                      {envelope?.status === "completed" && (
                        <Button size="sm" variant="outline" className="h-9 border-border" onClick={() => download(document)}>
                          <Download className="w-3.5 h-3.5 mr-1" /> PDF
                        </Button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <div className="rounded-xl bg-secondary/30 border border-border px-4 py-3 flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="w-4 h-4 text-primary mt-px flex-shrink-0" /> DocuSign handles identity, signing, and the completion certificate. Home Front stores the envelope status and audit history, not your signature credentials.
          </div>
        </>
      )}
    </div>
  );
}
