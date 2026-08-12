// ── Admin: recovery messaging ────────────────────────────────────────────────
//
// Three things live here, and they are the three things that decide whether a
// message ever leaves the building: the recovery policy, the approved
// templates, and the suppression list.
//
// The page is built to make the OFF state legible. An admin arriving here for
// the first time should be able to read, in one screen, exactly why nothing is
// being sent - the server flag, the organization approval, the consent policy,
// the sender, the templates - rather than discovering it one failed send at a
// time.

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, SectionLabel } from "@/components/ui/page-scaffold";
import { useToast } from "@/hooks/use-toast";
import {
  TEMPLATE_KIND_LABELS, TEMPLATE_VARIABLES, VARIABLE_LABELS, type TemplateKind,
} from "@shared/orderRecoveryTemplates";
import { DEFAULT_RECOVERY_POLICY, type RecoveryPolicy } from "@shared/orderRecovery";

interface PolicyResponse {
  config: {
    policy: RecoveryPolicy;
    messagingApproved: boolean;
    messagingApprovedAt: string | null;
    consentPolicyConfigured: boolean;
    automatedSequencesEnabled: boolean;
    supportPhone: string | null;
    companyMailingAddress: string | null;
    smsSenderIdentity: string | null;
    emailSenderIdentity: string | null;
    emailReplyTo: string | null;
    callbackUrl: string | null;
    quietHoursStart: number;
    quietHoursEnd: number;
    maxPerDestinationPerDay: number;
    maxPerCaseTotal: number;
    minHoursBetweenOutreach: number;
    reportTimezone: string;
  };
  defaults: RecoveryPolicy;
  flags: { orderSyncEnabled: boolean; recoveryMessagingEnabled: boolean };
}

interface TemplateRow {
  id: number; kind: TemplateKind; channel: "sms" | "email"; name: string;
  subject: string | null; body: string; version: number; approved: number; is_active: number;
}

export default function OrderMessaging() {
  const { toast } = useToast();
  const policy = useQuery<PolicyResponse>({ queryKey: ["/api/order-recovery/policy"] });
  const templates = useQuery<{ templates: TemplateRow[] }>({ queryKey: ["/api/order-recovery/templates"] });
  const suppressions = useQuery<{ suppressions: any[] }>({ queryKey: ["/api/order-recovery/suppressions"] });

  const [form, setForm] = useState<PolicyResponse["config"] | null>(null);
  const config = form ?? policy.data?.config ?? null;

  const savePolicy = useMutation({
    mutationFn: async () => (await apiRequest("PUT", "/api/order-recovery/policy", config)).json(),
    onSuccess: () => {
      toast({ title: "Saved" });
      void queryClient.invalidateQueries({ queryKey: ["/api/order-recovery/policy"] });
    },
    onError: (e: any) => toast({ title: "Not saved", description: e?.message, variant: "destructive" }),
  });

  const patch = (next: Partial<PolicyResponse["config"]>) => {
    if (!config) return;
    setForm({ ...config, ...next });
  };
  const patchPolicy = (next: Partial<RecoveryPolicy>) => {
    if (!config) return;
    setForm({ ...config, policy: { ...config.policy, ...next } });
  };

  const flags = policy.data?.flags;
  const blockers = config ? messagingBlockers(config, flags, templates.data?.templates ?? []) : [];

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-16 pt-5 md:px-6" data-testid="order-messaging-page">
      <PageHeader
        title="Order recovery messaging"
        subtitle="What may be sent, to whom, and who may never be contacted again."
      />

      {/* ── Why nothing is sending ───────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Sending status</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {blockers.length === 0 ? (
            <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-success" data-testid="sending-ready">
              Every requirement is met. Reps can send approved messages, subject to each customer's consent and the
              limits below.
            </p>
          ) : (
            <>
              <p className="text-muted-foreground">Messages are not being sent because:</p>
              <ul className="space-y-1" data-testid="sending-blockers">
                {blockers.map((b) => (
                  <li key={b} className="rounded-md bg-amber-500/10 px-3 py-2 text-warning">{b}</li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {policy.isLoading && <Skeleton className="mb-4 h-48 w-full" />}

      {config && (
        <Card className="mb-4">
          <CardHeader><CardTitle className="text-base">Policy</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <div>
              <SectionLabel>Approvals</SectionLabel>
              <div className="space-y-3">
                <ToggleRow
                  label="Messaging is approved for this organization"
                  help="A named administrator takes responsibility for the sender identity, the templates and the consent policy."
                  checked={config.messagingApproved}
                  testId="toggle-messaging-approved"
                  onChange={(v) => patch({ messagingApproved: v })}
                />
                <ToggleRow
                  label="A consent policy is configured and documented"
                  help="Confirm that consent is captured, recorded with its basis and source, and reviewable."
                  checked={config.consentPolicyConfigured}
                  testId="toggle-consent-configured"
                  onChange={(v) => patch({ consentPolicyConfigured: v })}
                />
                <ToggleRow
                  label="Automated sequences"
                  help="Off by default. When off, every message is drafted and sent by a person. This also requires the server flag."
                  checked={config.automatedSequencesEnabled}
                  testId="toggle-automated"
                  onChange={(v) => patch({ automatedSequencesEnabled: v })}
                />
              </div>
            </div>

            <div>
              <SectionLabel>Identity</SectionLabel>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Support phone" value={config.supportPhone} onChange={(v) => patch({ supportPhone: v })} testId="support-phone" />
                <Field label="Callback link" value={config.callbackUrl} onChange={(v) => patch({ callbackUrl: v })} testId="callback-url" />
                <Field label="Text sender" value={config.smsSenderIdentity} onChange={(v) => patch({ smsSenderIdentity: v })} testId="sms-sender" />
                <Field label="Email sender" value={config.emailSenderIdentity} onChange={(v) => patch({ emailSenderIdentity: v })} testId="email-sender" />
                <Field label="Email reply-to" value={config.emailReplyTo} onChange={(v) => patch({ emailReplyTo: v })} />
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">Company mailing address (required in every email)</Label>
                  <Textarea
                    rows={2}
                    value={config.companyMailingAddress ?? ""}
                    data-testid="mailing-address"
                    onChange={(e) => patch({ companyMailingAddress: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div>
              <SectionLabel>Limits</SectionLabel>
              <div className="grid gap-3 sm:grid-cols-3">
                <NumberField label="Earliest local hour" value={config.quietHoursStart} onChange={(v) => patch({ quietHoursStart: v })} />
                <NumberField label="Latest local hour" value={config.quietHoursEnd} onChange={(v) => patch({ quietHoursEnd: v })} />
                <NumberField label="Messages per contact per day" value={config.maxPerDestinationPerDay} onChange={(v) => patch({ maxPerDestinationPerDay: v })} testId="cap-daily" />
                <NumberField label="Messages per case in total" value={config.maxPerCaseTotal} onChange={(v) => patch({ maxPerCaseTotal: v })} testId="cap-case" />
                <NumberField label="Hours between messages" value={config.minHoursBetweenOutreach} onChange={(v) => patch({ minHoursBetweenOutreach: v })} />
              </div>
            </div>

            <div>
              <SectionLabel>When an order counts as stalled</SectionLabel>
              <div className="grid gap-3 sm:grid-cols-3">
                <NumberField label="Days submitted with no progress" value={config.policy.staleSubmittedDays} onChange={(v) => patchPolicy({ staleSubmittedDays: v })} testId="stale-submitted" />
                <NumberField label="Days accepted with no install date" value={config.policy.acceptedNoScheduleDays} onChange={(v) => patchPolicy({ acceptedNoScheduleDays: v })} />
                <NumberField label="Grace days after a scheduled install" value={config.policy.installOverdueGraceDays} onChange={(v) => patchPolicy({ installOverdueGraceDays: v })} />
                <NumberField label="Days a cancellation stays recoverable" value={config.policy.cancellationRecoveryWindowDays} onChange={(v) => patchPolicy({ cancellationRecoveryWindowDays: v })} />
                <NumberField label="Hours that count as urgent" value={config.policy.urgentRecentIssueHours} onChange={(v) => patchPolicy({ urgentRecentIssueHours: v })} />
                <NumberField label="Estimated value per order (cents)" value={config.policy.estimatedOrderValueCents} onChange={(v) => patchPolicy({ estimatedOrderValueCents: v })} testId="order-value" />
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <ListField
                  label="Cancellation reasons worth chasing"
                  help="Empty means no cancellation is ever auto-recovered, which is the default."
                  value={config.policy.recoverableCancellationReasons}
                  onChange={(v) => patchPolicy({ recoverableCancellationReasons: v })}
                  testId="recoverable-reasons"
                />
                <ListField
                  label="Reasons that must never open a case"
                  help="Checked first, so anything here wins over the list beside it."
                  value={config.policy.nonRecoverableReasons}
                  onChange={(v) => patchPolicy({ nonRecoverableReasons: v })}
                  testId="nonrecoverable-reasons"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => savePolicy.mutate()} disabled={savePolicy.isPending} data-testid="save-policy">
                Save policy
              </Button>
              <Button
                variant="outline"
                onClick={() => setForm({ ...config, policy: { ...DEFAULT_RECOVERY_POLICY } })}
              >
                Reset stall windows to defaults
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <TemplatesPanel templates={templates.data?.templates ?? []} loading={templates.isLoading} />

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base">Suppression list</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Anyone here is blocked on that channel. A reply of STOP and an email unsubscribe both land here
            automatically and immediately. A rep cannot override an entry; lifting one is an administrator action and
            is recorded with a reason.
          </p>
          {suppressions.isLoading && <Skeleton className="h-20 w-full" />}
          <div className="space-y-1">
            {(suppressions.data?.suppressions ?? []).map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 p-2 text-sm">
                <div>
                  <span className="font-medium">{s.destination_masked ?? "hidden"}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {s.channel === "sms" ? "Text" : "Email"} - {s.reason} - {String(s.suppressed_at).slice(0, 10)}
                  </span>
                </div>
                {s.lifted_at ? (
                  <Badge className="bg-muted text-muted-foreground">Lifted</Badge>
                ) : (
                  <Badge className="bg-destructive/15 text-destructive">Blocked</Badge>
                )}
              </div>
            ))}
            {(suppressions.data?.suppressions ?? []).length === 0 && !suppressions.isLoading && (
              <p className="text-sm text-muted-foreground">Nobody is suppressed.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TemplatesPanel({ templates, loading }: { templates: TemplateRow[]; loading: boolean }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<TemplateRow | null>(null);

  const approve = useMutation({
    mutationFn: async ({ id, approved }: { id: number; approved: boolean }) =>
      (await apiRequest("POST", `/api/order-recovery/templates/${id}/approve`, { approved })).json(),
    onSuccess: () => {
      toast({ title: "Updated" });
      void queryClient.invalidateQueries({ queryKey: ["/api/order-recovery/templates"] });
    },
    onError: (e: any) =>
      toast({ title: "Not approved", description: (e?.message ?? "").slice(0, 300), variant: "destructive" }),
  });

  const save = useMutation({
    mutationFn: async (row: TemplateRow) =>
      (await apiRequest("POST", "/api/order-recovery/templates", {
        kind: row.kind, channel: row.channel, name: row.name,
        subject: row.subject, body: row.body, replacesId: row.id,
      })).json(),
    onSuccess: () => {
      toast({ title: "Saved as a new draft version" });
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/order-recovery/templates"] });
    },
    onError: (e: any) =>
      toast({ title: "Not saved", description: (e?.message ?? "").slice(0, 300), variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Templates</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Only approved templates can be sent. Editing an approved template publishes a new draft rather than changing
          words that were already approved. Available variables:{" "}
          {TEMPLATE_VARIABLES.map((v) => VARIABLE_LABELS[v]).join(", ")}.
        </p>
        {loading && <Skeleton className="h-32 w-full" />}
        {templates.map((t) => (
          <div key={t.id} className="rounded-lg border border-border/60 p-3" data-testid={`template-${t.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{t.name}</p>
                <p className="text-xs text-muted-foreground">
                  {TEMPLATE_KIND_LABELS[t.kind]} - {t.channel === "sms" ? "Text" : "Email"} - version {t.version}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge className={t.approved ? "bg-emerald-500/15 text-success" : "bg-muted text-muted-foreground"}>
                  {t.approved ? "Approved" : "Draft"}
                </Badge>
                <Button size="sm" variant="outline" onClick={() => setEditing(editing?.id === t.id ? null : t)}>
                  {editing?.id === t.id ? "Cancel" : "Edit"}
                </Button>
                <Button
                  size="sm"
                  variant={t.approved ? "ghost" : "default"}
                  data-testid={`approve-${t.id}`}
                  onClick={() => approve.mutate({ id: t.id, approved: !t.approved })}
                >
                  {t.approved ? "Withdraw approval" : "Approve"}
                </Button>
              </div>
            </div>

            {editing?.id === t.id ? (
              <div className="mt-3 space-y-2">
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="Name"
                />
                {editing.channel === "email" && (
                  <Input
                    value={editing.subject ?? ""}
                    onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
                    placeholder="Subject"
                  />
                )}
                <Textarea
                  rows={8}
                  value={editing.body}
                  data-testid={`template-body-${t.id}`}
                  onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                />
                <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(editing)}>
                  Save as new version
                </Button>
              </div>
            ) : (
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{t.body}</pre>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Small controls ───────────────────────────────────────────────────────────

function ToggleRow({ label, help, checked, onChange, testId }: {
  label: string; help: string; checked: boolean; onChange: (v: boolean) => void; testId?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border/60 p-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} data-testid={testId} />
    </div>
  );
}

function Field({ label, value, onChange, testId }: {
  label: string; value: string | null; onChange: (v: string) => void; testId?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input value={value ?? ""} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
    </div>
  );
}

function NumberField({ label, value, onChange, testId }: {
  label: string; value: number; onChange: (v: number) => void; testId?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        min={0}
        value={String(value)}
        data-testid={testId}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
      />
    </div>
  );
}

function ListField({ label, help, value, onChange, testId }: {
  label: string; help: string; value: string[]; onChange: (v: string[]) => void; testId?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Textarea
        rows={3}
        value={value.join("\n")}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
      />
      <p className="text-xs text-muted-foreground">{help} One phrase per line.</p>
    </div>
  );
}

/** Everything standing between this organization and a sent message, in plain
 *  words. Mirrors the server gate; the server is still the wall. */
function messagingBlockers(
  config: PolicyResponse["config"],
  flags: PolicyResponse["flags"] | undefined,
  templates: TemplateRow[],
): string[] {
  const out: string[] = [];
  if (!flags?.recoveryMessagingEnabled) {
    out.push("Recovery messaging is turned off on the server. An administrator sets PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED.");
  }
  if (!config.messagingApproved) out.push("Messaging has not been approved for this organization.");
  if (!config.consentPolicyConfigured) out.push("No consent policy has been confirmed.");
  if (!config.smsSenderIdentity && !config.emailSenderIdentity) out.push("No sender identity is configured.");
  if (!config.companyMailingAddress) out.push("No company mailing address is set, so no email can be sent.");
  if (!templates.some((t) => t.approved)) out.push("No template has been approved.");
  return out;
}
