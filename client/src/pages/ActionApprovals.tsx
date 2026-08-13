// ── Action approvals ─────────────────────────────────────────────────────────
//
// Three things on one screen, because they are three views of the same object
// and splitting them would mean an approver hunting for what happened to the
// thing they just approved.
//
//   WAITING   What needs a decision from THIS person. The server only returns
//             kinds they hold the approve capability for, so nothing here is a
//             button that would 403.
//   RECENT    What has already happened, and what can still be reversed.
//   POLICY    How strict the gate is, for an admin. Rendered from the server's
//             clamped answer, never from what was typed - an admin who asks for
//             something below a kind's floor sees the floor come back.
//
// The undo button is the part worth being careful about. It renders only when
// the server says the action is reversible AND the window is open AND an
// inverse was captured. Every other case shows the server's own sentence about
// why not, so the screen never implies a mistake is recoverable when it is not.

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader, StatStrip, StatTile } from "@/components/ui/page-scaffold";
import { useToast } from "@/hooks/use-toast";
import { useCan } from "@/lib/capabilities";
import { GATE_MODES, type GateMode, type GuardedActionState } from "@shared/guardedActions";

// ── Wire shapes ──────────────────────────────────────────────────────────────

interface ActionRow {
  id: number;
  kind: string;
  kindLabel: string;
  describes: string;
  reversibility: "reversible" | "irreversible";
  state: GuardedActionState;
  magnitude: number;
  magnitudeUnit: string;
  targetLabel: string | null;
  requestedBy: string | null;
  requestedAt: string;
  requestReason: string | null;
  gateReason: string;
  expiresAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  executedAt: string | null;
  resultSummary: string | null;
  failureReason: string | null;
  undoneAt: string | null;
  undoneBy: string | null;
  undo:
    | { available: true; deadline: string }
    | { available: false; because: string; reason: string };
}

interface PolicyRow {
  kind: string;
  mode: GateMode;
  approvalAboveMagnitude: number | null;
  selfApproval: boolean;
  undoWindowMinutes: number;
  pendingExpiryMinutes: number;
  configured: boolean;
}

interface CatalogueKind {
  kind: string;
  label: string;
  describes: string;
  floor: GateMode;
  reversibility: "reversible" | "irreversible";
  maxUndoWindowMinutes: number;
  magnitudeUnit: string;
  canApprove: boolean;
  policy: PolicyRow;
}

// ── Presentation helpers ─────────────────────────────────────────────────────

const STATE_TONE: Record<GuardedActionState, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "default",
  approved: "secondary",
  executed: "secondary",
  undone: "outline",
  rejected: "destructive",
  failed: "destructive",
  expired: "outline",
};

const STATE_LABEL: Record<GuardedActionState, string> = {
  pending: "Waiting",
  approved: "Approved",
  executed: "Done",
  undone: "Reversed",
  rejected: "Rejected",
  failed: "Failed",
  expired: "Expired",
};

const MODE_LABEL: Record<GateMode, string> = {
  auto: "Runs immediately",
  approval: "Needs approval",
  deny: "Blocked",
};

function when(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function until(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (mins <= 0) return "closing now";
  if (mins < 60) return `${mins}m left`;
  return `${Math.round(mins / 60)}h left`;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ActionApprovals() {
  const { toast } = useToast();
  const canManagePolicy = useCan("action.policy.manage");
  const [note, setNote] = useState<Record<number, string>>({});

  const pending = useQuery<{ actions: ActionRow[]; total: number }>({
    queryKey: ["/api/actions/pending"],
    // Somebody is usually waiting on the other side of one of these, so the
    // queue refreshes on its own rather than needing a reload.
    refetchInterval: 60_000,
  });
  const recent = useQuery<{ actions: ActionRow[]; total: number }>({
    queryKey: ["/api/actions?limit=25"],
  });
  const catalogue = useQuery<{ kinds: CatalogueKind[] }>({
    queryKey: ["/api/actions/catalogue"],
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/actions/pending"] });
    queryClient.invalidateQueries({ queryKey: ["/api/actions?limit=25"] });
    queryClient.invalidateQueries({ queryKey: ["/api/actions/pending-count"] });
  };

  const decide = useMutation({
    mutationFn: async (input: { id: number; verb: "approve" | "reject" | "undo" }) => {
      const body = input.verb === "undo" ? { reason: note[input.id] ?? null } : { note: note[input.id] ?? null };
      const res = await apiRequest("POST", `/api/actions/${input.id}/${input.verb}`, body);
      return (await res.json()) as { action: ActionRow };
    },
    onSuccess: ({ action }) => {
      refresh();
      setNote((prev) => ({ ...prev, [action.id]: "" }));
      toast({
        title:
          action.state === "executed" ? "Done"
          : action.state === "undone" ? "Reversed"
          : action.state === "rejected" ? "Rejected"
          : "Updated",
        description: action.resultSummary ?? action.failureReason ?? undefined,
      });
    },
    // The server's refusal is the message. Paraphrasing it here is how a UI
    // ends up telling somebody a different story from the audit record.
    onError: (error: any) => toast({
      title: "Not applied",
      description: String(error?.message ?? error),
      variant: "destructive",
    }),
  });

  const waiting = pending.data?.actions ?? [];
  const history = recent.data?.actions ?? [];
  const reversible = history.filter((a) => a.undo.available).length;

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-16 pt-5 md:px-6" data-testid="action-approvals-page">
      <PageHeader
        title="Action approvals"
        subtitle="Changes big enough to need a second pair of eyes, and what has already run."
      />

      <StatStrip columns={3} className="mb-4">
        <StatTile label="Waiting on you" value={String(waiting.length)} accent testId="approvals-waiting" />
        <StatTile label="Recent" value={String(history.length)} testId="approvals-recent" />
        <StatTile label="Still reversible" value={String(reversible)} testId="approvals-reversible" />
      </StatStrip>

      {/* ── Waiting ────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Waiting for a decision</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {pending.isLoading && <Skeleton className="h-24 w-full" />}
          {/* "Nothing is waiting on you" is a clearance to stop looking, and it
              was being issued from `?? []` on a failed request. Guarded actions
              then sit unapproved until somebody chases them out of band - and
              because the query refetches, the approver is told all-clear again
              on every poll. isSuccess only. */}
          {pending.isError && (
            <ErrorState
              title="Can't load the approval queue"
              description="There may be actions waiting. This is a failed request, not an empty queue."
              onRetry={() => void pending.refetch()}
              bordered={false}
              testId="approvals-error"
            />
          )}
          {pending.isSuccess && waiting.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="approvals-empty">
              Nothing is waiting on you.
            </p>
          )}
          {waiting.map((action) => (
            <div key={action.id} className="rounded-lg border p-3" data-testid={`pending-${action.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{action.kindLabel}</span>
                    <Badge variant="outline">{action.magnitude} {action.magnitudeUnit}</Badge>
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">{action.targetLabel ?? action.describes}</p>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <div>{action.requestedBy ?? "Someone"} - {when(action.requestedAt)}</div>
                  {action.expiresAt && <div>Expires {until(action.expiresAt)}</div>}
                </div>
              </div>

              {/* Why it is here at all. An approver deciding without this is
                  guessing at whether the gate caught something unusual. */}
              <p className="mt-2 text-xs text-muted-foreground">{action.gateReason}</p>
              {action.requestReason && (
                <p className="mt-1 text-sm">Reason given: {action.requestReason}</p>
              )}
              {action.reversibility === "irreversible" && (
                <p className="mt-2 text-sm font-medium text-destructive" data-testid={`irreversible-${action.id}`}>
                  This cannot be undone once it runs.
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-end gap-2">
                <div className="min-w-[12rem] flex-1">
                  <Label htmlFor={`note-${action.id}`} className="text-xs">Note (optional)</Label>
                  <Input
                    id={`note-${action.id}`}
                    value={note[action.id] ?? ""}
                    onChange={(e) => setNote((prev) => ({ ...prev, [action.id]: e.target.value }))}
                    placeholder="What did you check?"
                  />
                </div>
                <Button
                  onClick={() => decide.mutate({ id: action.id, verb: "approve" })}
                  disabled={decide.isPending}
                  data-testid={`approve-${action.id}`}
                >
                  Approve
                </Button>
                <Button
                  variant="outline"
                  onClick={() => decide.mutate({ id: action.id, verb: "reject" })}
                  disabled={decide.isPending}
                  data-testid={`reject-${action.id}`}
                >
                  Reject
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ── Recent ─────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Recently</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {recent.isLoading && <Skeleton className="h-24 w-full" />}
          {!recent.isLoading && history.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing has gone through the gate yet.</p>
          )}
          {history.map((action) => (
            <div key={action.id} className="rounded-lg border p-3 text-sm" data-testid={`action-${action.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant={STATE_TONE[action.state]}>{STATE_LABEL[action.state]}</Badge>
                    <span className="font-medium">{action.kindLabel}</span>
                  </div>
                  <p className="mt-0.5 text-muted-foreground">{action.targetLabel ?? action.describes}</p>
                  {action.resultSummary && <p className="mt-1">{action.resultSummary}</p>}
                  {action.failureReason && (
                    <p className="mt-1 text-destructive">{action.failureReason}</p>
                  )}
                  {action.undoneAt && (
                    <p className="mt-1 text-muted-foreground">
                      Reversed by {action.undoneBy ?? "someone"} {when(action.undoneAt)}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  <div>{action.requestedBy ?? "Someone"} - {when(action.requestedAt)}</div>
                  {action.decidedBy && <div>Decided by {action.decidedBy}</div>}
                </div>
              </div>

              {/* The honest half. Either a working button, or the server's own
                  sentence about why there is no button. */}
              {action.undo.available ? (
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => decide.mutate({ id: action.id, verb: "undo" })}
                    disabled={decide.isPending}
                    data-testid={`undo-${action.id}`}
                  >
                    Undo
                  </Button>
                  <span className="text-xs text-muted-foreground">{until(action.undo.deadline)}</span>
                </div>
              ) : action.state === "executed" ? (
                <p className="mt-2 text-xs text-muted-foreground" data-testid={`no-undo-${action.id}`}>
                  {action.undo.reason}
                </p>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ── Policy ─────────────────────────────────────────────────────── */}
      {canManagePolicy && <PolicyEditor kinds={catalogue.data?.kinds ?? []} loading={catalogue.isLoading} />}
    </div>
  );
}

// ── Policy editor ────────────────────────────────────────────────────────────

function PolicyEditor({ kinds, loading }: { kinds: CatalogueKind[]; loading: boolean }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Record<string, Partial<PolicyRow>>>({});

  const save = useMutation({
    mutationFn: async (kind: CatalogueKind) => {
      const merged = { ...kind.policy, ...draft[kind.kind] };
      const res = await apiRequest("PUT", `/api/actions/policies/${kind.kind}`, {
        mode: merged.mode,
        approvalAboveMagnitude: merged.approvalAboveMagnitude,
        selfApproval: merged.selfApproval,
        undoWindowMinutes: merged.undoWindowMinutes,
        pendingExpiryMinutes: merged.pendingExpiryMinutes,
      });
      return (await res.json()) as { policy: PolicyRow; floor: GateMode };
    },
    onSuccess: ({ policy, floor }, kind) => {
      queryClient.invalidateQueries({ queryKey: ["/api/actions/catalogue"] });
      setDraft((prev) => ({ ...prev, [kind.kind]: {} }));
      // The saved value can differ from the typed one, and saying so is the
      // point: the floor is the one thing an admin cannot configure away.
      const clamped = draft[kind.kind]?.mode && draft[kind.kind]?.mode !== policy.mode;
      toast({
        title: clamped ? `Saved as "${MODE_LABEL[policy.mode]}"` : "Saved",
        description: clamped
          ? `${kind.label} can never be looser than "${MODE_LABEL[floor]}".`
          : undefined,
      });
    },
    onError: (error: any) => toast({
      title: "Not saved",
      description: String(error?.message ?? error),
      variant: "destructive",
    }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">How strict the gate is</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <Skeleton className="h-32 w-full" />}
        {kinds.map((kind) => {
          const current = { ...kind.policy, ...draft[kind.kind] };
          const dirty = Object.keys(draft[kind.kind] ?? {}).length > 0;
          return (
            <div key={kind.kind} className="rounded-lg border p-3" data-testid={`policy-${kind.kind}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium">{kind.label}</div>
                  <p className="text-sm text-muted-foreground">{kind.describes}</p>
                </div>
                {kind.reversibility === "irreversible" && (
                  <Badge variant="destructive">Cannot be undone</Badge>
                )}
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <Label className="text-xs">When someone requests it</Label>
                  <select
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={current.mode}
                    onChange={(e) => setDraft((p) => ({ ...p, [kind.kind]: { ...p[kind.kind], mode: e.target.value as GateMode } }))}
                    data-testid={`mode-${kind.kind}`}
                  >
                    {GATE_MODES.map((mode) => (
                      // Modes below the floor stay visible but unselectable, so
                      // the constraint is legible rather than a silent absence.
                      <option key={mode} value={mode} disabled={mode === "auto" && kind.floor !== "auto"}>
                        {MODE_LABEL[mode]}
                      </option>
                    ))}
                  </select>
                  {kind.floor !== "auto" && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Always at least "{MODE_LABEL[kind.floor]}".
                    </p>
                  )}
                </div>

                <div>
                  <Label className="text-xs">Approval above ({kind.magnitudeUnit})</Label>
                  <Input
                    className="mt-1"
                    inputMode="numeric"
                    value={current.approvalAboveMagnitude ?? ""}
                    placeholder="No limit"
                    onChange={(e) => setDraft((p) => ({
                      ...p,
                      [kind.kind]: {
                        ...p[kind.kind],
                        approvalAboveMagnitude: e.target.value === "" ? null : Number(e.target.value),
                      },
                    }))}
                    data-testid={`threshold-${kind.kind}`}
                  />
                </div>

                <div>
                  <Label className="text-xs">Undo window (minutes)</Label>
                  <Input
                    className="mt-1"
                    inputMode="numeric"
                    value={kind.reversibility === "irreversible" ? "" : current.undoWindowMinutes}
                    disabled={kind.reversibility === "irreversible"}
                    placeholder={kind.reversibility === "irreversible" ? "Not available" : undefined}
                    onChange={(e) => setDraft((p) => ({
                      ...p,
                      [kind.kind]: { ...p[kind.kind], undoWindowMinutes: Number(e.target.value || 0) },
                    }))}
                    data-testid={`undo-window-${kind.kind}`}
                  />
                  {kind.reversibility === "reversible" && (
                    <p className="mt-1 text-xs text-muted-foreground">Up to {kind.maxUndoWindowMinutes} minutes.</p>
                  )}
                </div>

                <div className="flex flex-col justify-between">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={current.selfApproval}
                      onChange={(e) => setDraft((p) => ({
                        ...p,
                        [kind.kind]: { ...p[kind.kind], selfApproval: e.target.checked },
                      }))}
                      data-testid={`self-approval-${kind.kind}`}
                    />
                    Let the requester approve it
                  </label>
                  <Button
                    className="mt-2"
                    size="sm"
                    disabled={!dirty || save.isPending}
                    onClick={() => save.mutate(kind)}
                    data-testid={`save-${kind.kind}`}
                  >
                    Save
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
