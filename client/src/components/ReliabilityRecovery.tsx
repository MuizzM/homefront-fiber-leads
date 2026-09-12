import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface Item { id: string; category: "login" | "notification" | "financial"; status: string; attempts: number; at: string; guidance: string; replayable: boolean; eventType?: string }
interface Recovery {
  enabled: boolean; canManage: boolean; scannerMonitoringEnabled: boolean;
  items: Item[]; queue: Array<{ status: string; count: number }>;
  assignments: { operations: number; replays: number };
  pendingAssignments: Array<{ id: string; actorUserId: number; repId: number | null; createdAt: number; state: string; total: number; updated: number }>;
  scanners: Array<{ runId: string; phase: string; inflight: number; stalled: number; recovering: number }>;
}
type Action = { id: string; category: Item["category"] | "assignment"; action: "replay" | "discard" | "stop"; guidance: string; identity?: string };
const categoryLabel = { login: "Sign-in delivery", notification: "Alert delivery", financial: "Financial event" };
export function ReliabilityRecovery() {
  const qc = useQueryClient();
  const refreshButton = useRef<HTMLButtonElement>(null);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const actionTrigger = useRef<HTMLElement | null>(null);
  const [selected, setSelected] = useState<Action | null>(null);
  useEffect(() => { if (selected) reasonInput.current?.focus(); else if (actionTrigger.current) (actionTrigger.current.isConnected ? actionTrigger.current : refreshButton.current)?.focus(); }, [selected]);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const query = useQuery<Recovery>({ queryKey: ["/api/reliability/recovery"],
    queryFn: () => apiRequest("GET", "/api/reliability/recovery").then(r => r.json()), staleTime: 15_000, refetchInterval: 30_000 });
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      const url = action.category === "assignment" ? `/api/reliability/assignments/${action.id}/stop`
        : action.category === "financial" ? `/api/commission/queue/events/${action.id}/action`
          : `/api/reliability/recovery/${action.category}/${action.id}/discard`;
      return (await apiRequest("POST", url, { reason,
        ...(action.category === "financial" ? { action: action.action === "replay" ? "RETRY" : "DEAD_LETTER" } : {}) })).json();
    },
    onSuccess: () => {
      setNotice("Recovery action recorded."); setSelected(null); setReason("");
      void qc.invalidateQueries({ queryKey: ["/api/reliability/recovery"] });
      void qc.invalidateQueries({ queryKey: ["/api/leads/assignment-operations"] });
    },
  });
  const choose = (action: Action, trigger: HTMLElement) => { actionTrigger.current = trigger; setSelected(action); setReason(""); setNotice(""); mutation.reset(); };
  if (query.data?.enabled === false) return null;
  return <section className="space-y-4 border-t border-border pt-5" aria-labelledby="reliability-recovery-title">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="reliability-recovery-title" className="text-base font-semibold">Reliability and recovery</h2><Button ref={refreshButton} variant="outline" loading={query.isFetching} onClick={() => query.refetch()}>Refresh recovery</Button></div>
    {query.isLoading && <p role="status">Loading recovery status…</p>}
    {query.isError && <p role="alert">Recovery status could not be loaded. Refresh to try again.</p>}
    <p role="status" className="text-sm">{notice}</p>
    {query.data?.enabled && <>
      <p className="text-sm text-muted-foreground">{query.data.assignments.replays.toLocaleString()} assignment retries handled with durable receipts. Sign-in delivery: {query.data.queue.filter(q => q.status === "pending" || q.status === "processing").reduce((sum, q) => sum + q.count, 0).toLocaleString()} awaiting completion.</p>
      <h3 className="text-sm font-semibold">Scanner progress</h3>
      {!query.data.scannerMonitoringEnabled ? <p className="text-sm text-muted-foreground">Progress monitoring is not enabled for this organization.</p> : query.data.scanners.length === 0 ? <p className="text-sm text-muted-foreground">No active monitored runs.</p> : <ul className="space-y-2 text-sm">{query.data.scanners.map(run => <li key={run.runId}>{run.phase} · {run.inflight} in progress · {run.recovering ? "Worker heartbeat overdue" : run.stalled ? "Progress overdue" : "Heartbeat current"}</li>)}</ul>}
      <h3 className="text-sm font-semibold">Failed deliveries and events</h3>
      <p className="text-sm text-muted-foreground">Up to 50 items per category. Message contents and sign-in codes are hidden.</p>
      {query.data.items.length === 0 ? <p className="text-sm">No failed items in these queues.</p> : <div className="overflow-x-auto rounded-lg border border-border"><table className="block w-full text-left text-sm sm:table"><caption className="sr-only">Failed work available for review</caption><thead className="sr-only bg-muted sm:not-sr-only sm:table-header-group"><tr><th className="p-3" scope="col">Work</th><th className="p-3" scope="col">Attempts</th><th className="p-3" scope="col">Created or updated</th><th className="p-3" scope="col">Recovery</th></tr></thead><tbody className="block divide-y divide-border sm:table-row-group">{query.data.items.map(item => <tr className="block py-3 sm:table-row sm:py-0" key={`${item.category}:${item.id}`}><th scope="row" className="block break-words px-3 pb-2 font-medium sm:table-cell sm:p-3">{categoryLabel[item.category]} #{item.id}<span className="block text-muted-foreground">{item.eventType}</span><span className="block font-normal text-muted-foreground">{item.status}</span></th><td className="block px-3 pb-2 tabular-nums sm:table-cell sm:p-3"><span className="text-muted-foreground sm:hidden">Attempts: </span>{item.attempts}</td><td className="block px-3 pb-2 sm:table-cell sm:p-3"><span className="text-muted-foreground sm:hidden">Created or updated: </span>{new Date(item.at).toLocaleString()}</td><td className="block px-3 sm:table-cell sm:p-3"><p className="max-w-md text-muted-foreground">{item.guidance}</p>{query.data!.canManage && <div className="mt-2 flex flex-wrap gap-2">{item.replayable && <Button variant="outline" disabled={mutation.isPending} onClick={event => choose({ ...item, identity: `${categoryLabel[item.category]} #${item.id}${item.eventType ? ` · ${item.eventType}` : ""}`, action: "replay" }, event.currentTarget)}>Replay</Button>}{item.status !== "dead_lettered" && <Button variant="outline" disabled={mutation.isPending} onClick={event => choose({ ...item, identity: `${categoryLabel[item.category]} #${item.id}`, action: "discard" }, event.currentTarget)}>{item.category === "financial" ? "Set aside" : "Discard"}</Button>}</div>}</td></tr>)}</tbody></table></div>}
      {query.data.canManage && query.data.pendingAssignments.length > 0 && <div className="space-y-2"><h3 className="text-sm font-semibold">Interrupted assignments</h3><p className="text-sm text-muted-foreground">Owners can continue these in Operations. If access has been revoked, stop the remaining work to release its pending slot.</p><ul className="divide-y divide-border">{query.data.pendingAssignments.map(op => <li key={op.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"><span>Assignment {op.id}<span className="block text-muted-foreground">Actor #{op.actorUserId} · {op.repId == null ? "Unassign" : `Rep #${op.repId}`} · {new Date(op.createdAt).toLocaleString()}</span>{op.updated.toLocaleString()} of {op.total.toLocaleString()} doors updated</span><Button variant="outline" disabled={mutation.isPending} onClick={event => choose({ id: op.id, category: "assignment", action: "stop", identity: `Assignment ${op.id} · actor #${op.actorUserId}`, guidance: "Completed assignments and completed put backs stay as they are. Remaining work will stop." }, event.currentTarget)}>Stop remaining work</Button></li>)}</ul></div>}
    </>}
    {selected && <form className="space-y-3 rounded-lg border border-border p-4" onSubmit={event => { event.preventDefault(); if (reason.trim().length >= 5 && !mutation.isPending) mutation.mutate(selected); }}>
      <h3 className="font-semibold">{selected.action === "stop" ? "Stop remaining work" : selected.action === "replay" ? "Replay this event" : selected.category === "financial" ? "Set aside this event" : "Discard this item"}</h3><p className="break-all text-sm">{selected.identity ?? selected.id}</p><p id="recovery-action-help" className="text-sm text-muted-foreground">{selected.guidance}</p>
      <Label htmlFor="recovery-reason">Reason (required)</Label><Textarea ref={reasonInput} id="recovery-reason" aria-describedby="recovery-action-help" required minLength={5} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} disabled={mutation.isPending} />
      {mutation.isError && <p role="alert" className="text-sm text-destructive">{mutation.error.message} Your reason has been kept. Refresh the list if the item changed.</p>}
      <div className="flex flex-wrap gap-2"><Button type="submit" loading={mutation.isPending} disabled={reason.trim().length < 5}>Confirm {selected.category === "financial" && selected.action === "discard" ? "set aside" : selected.action}</Button><Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => setSelected(null)}>Cancel</Button></div>
    </form>}
  </section>;
}
