// ── Shared recovery case rendering ───────────────────────────────────────────
//
// The rep's queue and the manager's queue show the SAME case with the same
// facts and the same actions. Sharing the component is not just economy: it
// means a manager cannot be looking at a different version of the truth from
// the rep they are about to ask about it.
//
// Every difference between the two views comes from capabilities, which the
// server enforces independently, so a control that is hidden here is also a
// route that would refuse.

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useCan } from "@/lib/capabilities";
import { ORDER_STATUS_LABELS, type NormalizedOrderStatus } from "@shared/orderStatusSource";
import {
  RECOVERY_REASON_LABELS, RESOLUTION_CODES,
  type RecoveryPriority, type RecoveryReason, type ResolutionCode,
} from "@shared/orderRecovery";
import { BLOCK_REASON_LABELS, type ContactBlockReason } from "@shared/contactConsent";

export interface RecoveryCaseRow {
  id: number;
  vendorOrderId: number;
  reason: RecoveryReason;
  priority: RecoveryPriority;
  status: string;
  daysStalled: number;
  nextActionAt: string | null;
  lastOutreachAt: string | null;
  outreachCount: number;
  optOutBlocked: boolean;
  openedAt: string;
  assignedToRepId: number | null;
  customerName: string | null;
  customerNameShort: string | null;
  serviceAddress: string | null;
  carrier: string | null;
  productSold: string | null;
  program: string | null;
  orderStatus: NormalizedOrderStatus;
  sourceStatus: string | null;
  failureReason: string | null;
  requiredCustomerAction: string | null;
  installScheduledAt: string | null;
  installDate: string | null;
  repExternalName: string | null;
  customerPhoneMasked: string | null;
  customerEmailMasked: string | null;
  matchStatus: string;
  matchConfidence: number | null;
  externalOrderId: string | null;
}

export const PRIORITY_TONE: Record<RecoveryPriority, string> = {
  urgent: "bg-destructive/15 text-destructive",
  high: "bg-amber-500/15 text-warning",
  medium: "bg-sky-500/15 text-info",
  low: "bg-muted text-muted-foreground",
};

export const PRIORITY_LABEL: Record<RecoveryPriority, string> = {
  urgent: "Urgent", high: "High", medium: "Medium", low: "Low",
};

const RESOLUTION_LABELS: Record<ResolutionCode, string> = {
  recovered_installed: "Recovered and installed",
  recovered_rescheduled: "Rebooked the install",
  customer_completed_action: "Customer did what was needed",
  documents_received: "Documents received",
  resubmitted_as_new_order: "Resubmitted as a new order",
  not_recoverable_customer_declined: "Customer does not want it",
  not_recoverable_no_serviceability: "Not serviceable",
  not_recoverable_unreachable: "Could not reach the customer",
  not_recoverable_duplicate: "Duplicate order",
  closed_no_action_needed: "No action needed",
};

export function CaseSummaryRow({ row, onOpen }: { row: RecoveryCaseRow; onOpen: (id: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(row.id)}
      data-testid={`recovery-case-${row.id}`}
      className="w-full rounded-lg border border-border/60 p-3 text-left transition hover:border-border"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {row.customerName ?? "Unnamed customer"}
          </p>
          <p className="truncate text-xs text-muted-foreground">{row.serviceAddress ?? "No address on file"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {row.optOutBlocked && <Badge className="bg-destructive/15 text-destructive">Opted out</Badge>}
          <Badge className={PRIORITY_TONE[row.priority]}>{PRIORITY_LABEL[row.priority]}</Badge>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{RECOVERY_REASON_LABELS[row.reason]}</span>
        {/* The reason and the order status are often the same words - a failed
            install is here BECAUSE it failed. Printing both then reads as a
            stutter, so the status only appears when it adds something. */}
        {ORDER_STATUS_LABELS[row.orderStatus] !== RECOVERY_REASON_LABELS[row.reason] && (
          <span>{ORDER_STATUS_LABELS[row.orderStatus]}</span>
        )}
        <span>{row.daysStalled} day{row.daysStalled === 1 ? "" : "s"} stalled</span>
        {row.carrier && <span>{row.carrier}</span>}
        {row.productSold && <span>{row.productSold}</span>}
        {row.installScheduledAt && <span>Install {row.installScheduledAt.slice(0, 10)}</span>}
        {row.lastOutreachAt && <span>Last contact {row.lastOutreachAt.slice(0, 10)}</span>}
      </div>
    </button>
  );
}

interface CaseDetail {
  case: RecoveryCaseRow;
  order: Record<string, any>;
  timeline: { id: number; event_type: string; actor_name: string | null; detail: string | null; created_at: string }[];
  orderEvents: { id: number; event_type: string; old_status: string | null; new_status: string; effective_at: string }[];
  outreach: {
    id: number; channel: string; status: string; subject: string | null; body: string;
    recipient: string | null; blockedReasons: string[] | null; sentAt: string | null; createdAt: string;
  }[];
  commission: { commission_status: string; amount_cents: number; effective_at: string }[];
  templates: { id: number; name: string; channel: string; kind: string; version: number }[];
}

export function CaseDetailPanel({ caseId, onClose }: { caseId: number; onClose: () => void }) {
  const { toast } = useToast();
  const canWork = useCan("recovery.work");
  const canManage = useCan("recovery.manage");
  const canDraft = useCan("recovery.message.draft");
  const canSend = useCan("recovery.message.send");

  const [note, setNote] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [templateId, setTemplateId] = useState<string>("");
  const [resolution, setResolution] = useState<string>("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [draft, setDraft] = useState<{ body: string; subject: string | null; destinationMasked: string | null; gate: { allowed: boolean; blockedBy: ContactBlockReason[] }; renderIssues: string[] } | null>(null);

  const detail = useQuery<CaseDetail>({ queryKey: [`/api/order-recovery/cases/${caseId}`] });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [`/api/order-recovery/cases/${caseId}`] });
    void queryClient.invalidateQueries({ queryKey: ["/api/order-recovery/cases"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/order-recovery/metrics"] });
  };

  const addNote = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/order-recovery/cases/${caseId}/note`, { note })).json(),
    onSuccess: () => { setNote(""); invalidate(); },
    onError: (e: any) => toast({ title: "Note not saved", description: e?.message, variant: "destructive" }),
  });

  const scheduleCallback = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/order-recovery/cases/${caseId}/callback`, { at: new Date(callbackAt).toISOString() })).json(),
    onSuccess: () => { setCallbackAt(""); toast({ title: "Callback scheduled" }); invalidate(); },
    onError: (e: any) => toast({ title: "Not scheduled", description: e?.message, variant: "destructive" }),
  });

  const resolve = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/order-recovery/cases/${caseId}/resolve`, {
        resolutionCode: resolution, note: resolutionNote,
      })).json(),
    onSuccess: () => { toast({ title: "Case closed" }); invalidate(); onClose(); },
    onError: (e: any) => toast({ title: "Not closed", description: e?.message, variant: "destructive" }),
  });

  const makeDraft = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/order-recovery/cases/${caseId}/draft`, { templateId: Number(templateId) })).json(),
    onSuccess: (data: any) => setDraft(data),
    onError: (e: any) => toast({ title: "Could not build the message", description: e?.message, variant: "destructive" }),
  });

  const send = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/order-recovery/cases/${caseId}/send`, { templateId: Number(templateId) })).json(),
    onSuccess: () => { toast({ title: "Sent" }); setDraft(null); invalidate(); },
    onError: (e: any) => toast({ title: "Not sent", description: e?.message, variant: "destructive" }),
  });

  if (detail.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!detail.data) return <p className="text-sm text-muted-foreground">This case is no longer available.</p>;

  const row = detail.data.case;

  return (
    <div className="space-y-4" data-testid="case-detail">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <div className="min-w-0">
            <CardTitle className="text-base">{row.customerName ?? "Unnamed customer"}</CardTitle>
            <p className="text-xs text-muted-foreground">{row.serviceAddress ?? "No address on file"}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="close-case">Close</Button>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <Fact label="Order status" value={ORDER_STATUS_LABELS[row.orderStatus]} />
            <Fact label="Provider status" value={row.sourceStatus ?? "-"} />
            <Fact label="Why it is here" value={RECOVERY_REASON_LABELS[row.reason]} />
            <Fact label="Priority" value={PRIORITY_LABEL[row.priority]} />
            <Fact label="Days stalled" value={String(row.daysStalled)} />
            <Fact label="Carrier" value={row.carrier ?? "-"} />
            <Fact label="Product" value={row.productSold ?? "-"} />
            <Fact label="Program" value={row.program ?? "-"} />
            <Fact label="Original rep" value={row.repExternalName ?? "-"} />
            <Fact label="Install scheduled" value={row.installScheduledAt?.slice(0, 10) ?? "-"} />
            <Fact label="Installed" value={row.installDate?.slice(0, 10) ?? "-"} />
            <Fact label="Next action" value={row.nextActionAt ? new Date(row.nextActionAt).toLocaleString() : "-"} />
            <Fact label="Last contact" value={row.lastOutreachAt ? new Date(row.lastOutreachAt).toLocaleString() : "None"} />
            <Fact label="Phone on file" value={row.customerPhoneMasked ?? "None"} />
            <Fact label="Email on file" value={row.customerEmailMasked ?? "None"} />
          </div>

          {row.requiredCustomerAction && (
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-warning">
              Customer action needed: {row.requiredCustomerAction}
            </p>
          )}
          {row.failureReason && (
            <p className="rounded-md bg-muted px-3 py-2 text-muted-foreground">
              Provider reason: {row.failureReason}
            </p>
          )}
          {row.optOutBlocked && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive" data-testid="opt-out-banner">
              This customer has opted out. Messaging is blocked and cannot be overridden. Work this case by phone or in
              person, or close it.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Commission ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle className="text-base">Commission</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {detail.data.commission.length === 0 ? (
            <p className="text-muted-foreground">
              No commission record for this order yet. An installed order is not a paid one: payment appears here when
              it arrives on a commission file.
            </p>
          ) : (
            <ul className="space-y-1">
              {detail.data.commission.map((c, i) => (
                <li key={i} className="flex justify-between">
                  <span>{c.commission_status}</span>
                  <span className="text-muted-foreground">
                    {(c.amount_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} on {c.effective_at.slice(0, 10)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Messaging ──────────────────────────────────────────────────── */}
      {canDraft && (
        <Card>
          <CardHeader><CardTitle className="text-base">Message the customer</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {detail.data.templates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No approved templates yet. An administrator approves the wording before anything can be sent.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Template</Label>
                    <select
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                      value={templateId}
                      data-testid="template-select"
                      onChange={(e) => { setTemplateId(e.target.value); setDraft(null); }}
                    >
                      <option value="">Choose</option>
                      {detail.data.templates.map((t) => (
                        <option key={t.id} value={t.id}>{t.name} ({t.channel})</option>
                      ))}
                    </select>
                  </div>
                  <Button
                    variant="outline"
                    disabled={!templateId || makeDraft.isPending}
                    onClick={() => makeDraft.mutate()}
                    data-testid="draft-button"
                  >
                    Build draft
                  </Button>
                </div>

                {draft && (
                  <div className="space-y-2 rounded-lg border border-border/60 p-3" data-testid="draft-preview">
                    {draft.subject && <p className="text-sm font-medium">{draft.subject}</p>}
                    <pre className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{draft.body}</pre>
                    <p className="text-xs text-muted-foreground">
                      Would go to {draft.destinationMasked ?? "no contact on file"}
                    </p>
                    {draft.renderIssues.length > 0 && (
                      <ul className="space-y-1 text-xs text-warning">
                        {draft.renderIssues.map((m, i) => <li key={i}>{m}</li>)}
                      </ul>
                    )}
                    {!draft.gate.allowed && (
                      <ul className="space-y-1 text-xs text-destructive" data-testid="gate-blocks">
                        {draft.gate.blockedBy.map((r) => <li key={r}>{BLOCK_REASON_LABELS[r] ?? r}</li>)}
                      </ul>
                    )}
                    {canSend && (
                      <Button
                        size="sm"
                        disabled={!draft.gate.allowed || send.isPending}
                        onClick={() => send.mutate()}
                        data-testid="send-button"
                      >
                        Send
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}

            {detail.data.outreach.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs uppercase text-muted-foreground">Messages so far</p>
                {detail.data.outreach.map((o) => (
                  <div key={o.id} className="rounded-md border border-border/60 p-2 text-xs">
                    <div className="flex justify-between">
                      <span>{o.channel === "sms" ? "Text" : "Email"} to {o.recipient ?? "unknown"}</span>
                      <span className="text-muted-foreground">{o.status}</span>
                    </div>
                    {o.blockedReasons && (
                      <p className="mt-1 text-destructive">
                        {o.blockedReasons.map((r) => BLOCK_REASON_LABELS[r as ContactBlockReason] ?? r).join("; ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Work the case ──────────────────────────────────────────────── */}
      {canWork && (
        <Card>
          <CardHeader><CardTitle className="text-base">Work this case</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs">Add a note</Label>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} data-testid="note-input" />
              <Button size="sm" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate()}>
                Save note
              </Button>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Schedule a callback</Label>
              <div className="flex gap-2">
                <Input type="datetime-local" value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} className="max-w-xs" />
                <Button size="sm" variant="outline" disabled={!callbackAt || scheduleCallback.isPending} onClick={() => scheduleCallback.mutate()}>
                  Schedule
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Close this case</Label>
              <select
                className="h-9 w-full max-w-sm rounded-md border border-input bg-background px-2 text-sm"
                value={resolution}
                data-testid="resolution-select"
                onChange={(e) => setResolution(e.target.value)}
              >
                <option value="">Choose an outcome</option>
                {RESOLUTION_CODES.map((code) => (
                  <option key={code} value={code}>{RESOLUTION_LABELS[code]}</option>
                ))}
              </select>
              <Textarea
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
                rows={2}
                placeholder="What happened"
              />
              <Button size="sm" disabled={!resolution || resolve.isPending} onClick={() => resolve.mutate()} data-testid="resolve-button">
                Close case
              </Button>
            </div>

            {canManage && <AssignControl caseId={caseId} onDone={invalidate} />}
          </CardContent>
        </Card>
      )}

      {/* ── Timeline ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle className="text-base">Activity</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {detail.data.timeline.map((e) => (
            <div key={e.id} className="border-l-2 border-border/60 pl-3">
              <p className="text-xs text-muted-foreground">
                {new Date(e.created_at).toLocaleString()} - {e.actor_name ?? "System"}
              </p>
              <p>{e.detail ?? e.event_type}</p>
            </div>
          ))}
          {detail.data.orderEvents.map((e) => (
            <div key={`o${e.id}`} className="border-l-2 border-border/40 pl-3">
              <p className="text-xs text-muted-foreground">{new Date(e.effective_at).toLocaleString()} - Provider</p>
              <p>
                {e.old_status
                  ? `Status moved from ${ORDER_STATUS_LABELS[e.old_status as NormalizedOrderStatus] ?? e.old_status} to ${ORDER_STATUS_LABELS[e.new_status as NormalizedOrderStatus] ?? e.new_status}`
                  : `Order imported as ${ORDER_STATUS_LABELS[e.new_status as NormalizedOrderStatus] ?? e.new_status}`}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function AssignControl({ caseId, onDone }: { caseId: number; onDone: () => void }) {
  const { toast } = useToast();
  const [repId, setRepId] = useState("");
  const team = useQuery<{ id: number; name: string }[]>({ queryKey: ["/api/team"] });

  const assign = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/order-recovery/cases/${caseId}/assign`, {
        repId: repId ? Number(repId) : null,
      })).json(),
    onSuccess: () => { toast({ title: "Reassigned" }); onDone(); },
    onError: (e: any) => toast({ title: "Not reassigned", description: e?.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-2">
      <Label className="text-xs">Assign to</Label>
      <div className="flex gap-2">
        <select
          className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-2 text-sm"
          value={repId}
          data-testid="assign-select"
          onChange={(e) => setRepId(e.target.value)}
        >
          <option value="">Unassigned</option>
          {(Array.isArray(team.data) ? team.data : []).map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <Button size="sm" variant="outline" disabled={assign.isPending} onClick={() => assign.mutate()}>
          Assign
        </Button>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  );
}
