import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";

interface Operation {
  id: string; state: string; total: number; updated: number; createdAt: string; restored: number; skipped: number; repId: number | null;
  canUndo: boolean; undoExpiresAt: string | null;
  result: { undoToken?: string; undoExpiresAt?: string } | null;
}
export function AssignmentRecovery() {
  const qc = useQueryClient();
  const [message, setMessage] = useState("");
  const query = useQuery<{ operations: Operation[] }>({ queryKey: ["/api/leads/assignment-operations"],
    queryFn: () => apiRequest("GET", "/api/leads/assignment-operations").then(r => r.json()), staleTime: 15_000, refetchInterval: 30_000 });
  const mutation = useMutation({
    mutationFn: async ({ op, undo }: { op: Operation; undo: boolean }) =>
      (await apiRequest("POST", undo ? "/api/leads/assign-selection/undo" : `/api/leads/assignment-operations/${op.id}/resume`,
        undo ? { token: op.result?.undoToken } : {})).json(),
    onMutate: () => setMessage(""),
    onSuccess: (data, variables) => {
      setMessage(data.state === "cancelled" ? `Remaining work was stopped. ${data.updated.toLocaleString()} doors were updated before it stopped.` : (variables.undo || variables.op.state === "undoing") ? `Put back ${data.restored.toLocaleString()} doors. ${data.skipped.toLocaleString()} were left unchanged.` : `Assignment completed. ${data.updated.toLocaleString()} doors updated.`);
    },
    onSettled: () => {
      for (const key of ["/api/leads/assignment-operations", "/api/leads", "/api/leads/map", "/api/ops/queue", "/api/ops/workload", "/api/ops/overview"]) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
  if (!query.isLoading && !query.isError && !query.data?.operations?.length) return null;
  return <section className="space-y-3 border-t border-border pt-4" aria-labelledby="assignment-recovery-title">
    <h2 id="assignment-recovery-title" className="text-base font-semibold">Your recent assignments</h2>
    <p className="text-sm text-muted-foreground">Continue interrupted work here after reconnecting. Each retry keeps the original selection.</p>
    {query.isLoading && <p role="status">Loading assignment history…</p>}
    {query.isError && <div role="alert"><p>Assignment history could not be loaded. Its status is unknown.</p><Button variant="outline" onClick={() => query.refetch()}>Try again</Button></div>}
    <p role="status" className="text-sm">{message}</p>
    {mutation.isError && <p role="alert" className="text-sm text-destructive">{mutation.error.message} Your recovery record is still available.</p>}
    <details open={query.data?.operations?.some(op => op.state === "running" || op.state === "undoing")}>
      <summary className="min-h-tap cursor-pointer py-3 text-sm font-medium focus-visible:outline focus-visible:outline-2">Assignment history</summary>
      <ul className="divide-y divide-border">
        {query.data?.operations?.map(op => <li key={op.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0 text-sm"><p className="font-medium">{op.updated.toLocaleString()} of {op.total.toLocaleString()} doors updated · {op.state === "running" ? "In progress or interrupted" : op.state === "undoing" ? "Put back in progress" : op.state === "undone" ? "Put back completed" : op.state === "cancelled" ? "Remaining work stopped" : "Completed"}</p><p className="break-all text-muted-foreground">Assignment {op.id} · {op.repId == null ? "Unassign" : `Rep #${op.repId}`}</p>{(op.state === "undone" || op.state === "undoing") && <p>{op.restored.toLocaleString()} put back · {op.skipped.toLocaleString()} left unchanged</p>}<time className="text-muted-foreground" dateTime={op.createdAt}>{new Date(op.createdAt).toLocaleString()}</time></div>
          {(op.state === "running" || op.state === "undoing") && <Button variant="outline" loading={mutation.isPending && mutation.variables?.op.id === op.id} disabled={mutation.isPending} onClick={() => mutation.mutate({ op, undo: false })}>{op.state === "undoing" ? "Continue put back" : "Continue assignment"}</Button>}
          {op.canUndo && op.result?.undoToken && Date.parse(op.undoExpiresAt ?? "") > Date.now() && <Button variant="outline" loading={mutation.isPending && mutation.variables?.op.id === op.id} disabled={mutation.isPending} onClick={() => mutation.mutate({ op, undo: true })}>Put back</Button>}
        </li>)}
      </ul>
    </details>
  </section>;
}
