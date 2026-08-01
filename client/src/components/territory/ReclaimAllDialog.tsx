// ── Reclaim ALL areas — the org-wide sweep, made safe ─────────────────────────
// Admin-only (reclaim_all_territories). This is the destructive-bulk-action
// grammar every serious admin console uses (GitHub's delete-repo, Vercel's
// project transfer): state the exact blast radius up front, make the operator
// choose what happens to the leads, and require a typed confirmation before
// the destructive button arms. One POST, one audit row, one toast.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, RefreshCw, Undo2 } from "lucide-react";

interface AreaLite { id: number; repIds: number[]; status: string }

export function ReclaimAllDialog({
  open, onClose, areas, teamNames,
}: {
  open: boolean;
  onClose: () => void;
  areas: AreaLite[];
  teamNames?: Record<number, string>;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [mode, setMode] = useState<"return_to_pool" | "keep_leads">("return_to_pool");
  const [confirmText, setConfirmText] = useState("");

  // The blast radius, computed from the same list the admin is looking at.
  const impact = useMemo(() => {
    const held = areas.filter(a => a.status !== "archived" && (a.repIds?.length ?? 0) > 0);
    const reps = new Set<number>();
    held.forEach(a => a.repIds.forEach(r => reps.add(r)));
    return { areaCount: held.length, repIds: [...reps] };
  }, [areas]);

  const armed = confirmText.trim().toUpperCase() === "RECLAIM";

  const sweep = useMutation({
    mutationFn: () => apiRequest("POST", "/api/territories/reclaim-all", { mode }).then(r => r.json()),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ["/api/territories"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      toast({
        title: `${res.reclaimed} area${res.reclaimed === 1 ? "" : "s"} reclaimed`,
        description: res.reclaimed > 0
          ? `${res.repsAffected} rep${res.repsAffected === 1 ? "" : "s"} affected · ${mode === "return_to_pool" ? `${res.leadsAffected} leads returned to the pool` : "reps kept their leads"}`
          : "No held areas to reclaim.",
        severity: "success",
      });
      setConfirmText("");
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't reclaim areas", description: String(e?.message ?? e), variant: "destructive" }),
  });

  // Every close path funnels through here so no armed state survives a reopen:
  // the component stays MOUNTED with open=false, so without this a typed
  // "RECLAIM" persisted and the next open showed the destructive button already
  // live — a confirm ritual that only has to be performed once isn't one.
  const close = () => {
    if (sweep.isPending) return; // a commit in flight is not interruptible
    setConfirmText("");
    onClose();
  };

  // Escape closes, like the scrim and Cancel — a modal all three of whose
  // siblings honour Escape must not be the odd one out.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="reclaim-all-title" data-testid="reclaim-all-dialog">
      {/* Scrim */}
      <button type="button" aria-label="Close" onClick={close} disabled={sweep.isPending} className="absolute inset-0 bg-black/60" data-testid="reclaim-all-scrim" />

      <div className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-border bg-card p-5 shadow-xl animate-in fade-in slide-in-from-bottom-4 sm:slide-in-from-bottom-0 duration-200">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl bg-rose-500/15 text-rose-400 flex items-center justify-center shrink-0">
            <Undo2 className="w-5 h-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="reclaim-all-title" className="text-[16px] font-bold text-foreground leading-tight">Reclaim every area</h2>
            <p className="text-[13px] text-muted-foreground mt-0.5">Take all assigned areas back from every rep in one action.</p>
          </div>
        </div>

        {/* Blast radius — exact numbers, before anything is armed. */}
        <div className="mt-4 rounded-xl border border-border bg-secondary/40 px-4 py-3" data-testid="reclaim-all-impact">
          {impact.areaCount === 0 ? (
            <p className="text-[13px] text-muted-foreground">No areas are currently held — there is nothing to reclaim.</p>
          ) : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
              <dt className="text-muted-foreground">Areas taken back</dt>
              <dd className="text-right font-bold tabular-nums text-foreground" data-testid="reclaim-all-area-count">{impact.areaCount}</dd>
              <dt className="text-muted-foreground">Reps affected</dt>
              <dd className="text-right font-bold tabular-nums text-foreground" data-testid="reclaim-all-rep-count">{impact.repIds.length}</dd>
            </dl>
          )}
          {impact.repIds.length > 0 && teamNames && (
            <p className="mt-1.5 text-[11.5px] text-muted-foreground truncate">
              {impact.repIds.map(id => teamNames[id] ?? `Rep #${id}`).slice(0, 4).join(", ")}{impact.repIds.length > 4 ? ` +${impact.repIds.length - 4} more` : ""}
            </p>
          )}
        </div>

        {/* What happens to the leads — the operator decides, explicitly. */}
        <fieldset className="mt-4">
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">What happens to their leads</legend>
          <div className="mt-2 space-y-2">
            {([
              { key: "return_to_pool", title: "Return leads to the pool", body: "Doors go back to unassigned — ready to hand to new reps." },
              { key: "keep_leads", title: "Reps keep their leads", body: "Areas come back, but each rep keeps the doors already assigned to them." },
            ] as const).map(o => (
              <label key={o.key} className={`flex items-start gap-3 rounded-xl border px-3.5 py-3 cursor-pointer transition-colors ${mode === o.key ? "border-primary/50 bg-primary/[0.07]" : "border-border hover:border-primary/25"}`}>
                <input
                  type="radio" name="reclaim-mode" value={o.key} checked={mode === o.key}
                  onChange={() => setMode(o.key)} className="mt-0.5 accent-[hsl(var(--primary))]"
                  data-testid={`reclaim-all-mode-${o.key}`}
                />
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-semibold text-foreground">{o.title}</span>
                  <span className="block text-[12px] text-muted-foreground mt-0.5">{o.body}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* Typed confirmation — the sweep has no undo. */}
        {impact.areaCount > 0 && (
          <div className="mt-4">
            <label htmlFor="reclaim-all-confirm" className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
              Type <span className="font-bold text-foreground tracking-wide">RECLAIM</span> to confirm — this cannot be undone.
            </label>
            <input
              id="reclaim-all-confirm" value={confirmText} onChange={e => setConfirmText(e.target.value)}
              autoComplete="off" spellCheck={false} data-testid="reclaim-all-confirm-input"
              className="mt-1.5 w-full h-11 rounded-lg bg-secondary border border-border px-3 text-[14px] font-semibold tracking-wide text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-rose-500/40"
              placeholder="RECLAIM"
            />
          </div>
        )}

        <div className="mt-5 flex gap-2.5">
          <button type="button" onClick={close} disabled={sweep.isPending} data-testid="reclaim-all-cancel"
            className="flex-1 h-11 rounded-xl bg-secondary border border-border text-[14px] font-semibold text-foreground active:scale-[.98] transition-transform hover:bg-secondary/70 disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => sweep.mutate()}
            disabled={impact.areaCount === 0 || !armed || sweep.isPending}
            data-testid="reclaim-all-submit"
            className="flex-1 h-11 rounded-xl bg-rose-600 text-white text-[14px] font-semibold active:scale-[.98] transition-transform hover:bg-rose-600/90 disabled:opacity-40 disabled:pointer-events-none inline-flex items-center justify-center gap-2"
          >
            {sweep.isPending ? <><RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />Reclaiming…</> : `Reclaim ${impact.areaCount || ""} area${impact.areaCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
