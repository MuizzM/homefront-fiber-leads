// ── Remove FCC imports — bulk purge of unworked FCC-added doors, made safe ────
// Admin-only (same gate as the reclaim-all sweep). Same staged destructive
// grammar as ReclaimAllDialog: state the exact blast radius up front (from the
// server's preview, computed by the SAME SQL predicate the delete uses), require
// a typed confirmation before the destructive button arms, lock every close path
// while committing, fail loudly. Worked doors are never touched — the copy says
// so with numbers, not adjectives.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { FOCUS } from "@/lib/a11y";
import { AlertTriangle, Loader2, RefreshCw, Trash2 } from "lucide-react";

interface FccPurgePreview {
  total: number;      // every fcc-tagged lead in the tenant
  removable: number;  // completely unworked — the only ones removed
  protected: number;  // total - removable — worked doors that stay
}

export function FccPurgeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirmText, setConfirmText] = useState("");

  // The blast radius comes from the server (the same predicate the delete
  // runs), never a client-side estimate — the count confirmed is the count
  // removed. staleTime 0 so every open re-asks.
  const preview = useQuery<FccPurgePreview>({
    queryKey: ["/api/leads/fcc-purge/preview"],
    queryFn: () => apiRequest("GET", "/api/leads/fcc-purge/preview").then((r) => r.json()),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });

  const armed = confirmText.trim().toUpperCase() === "REMOVE";

  const purge = useMutation({
    mutationFn: () => apiRequest("POST", "/api/leads/fcc-purge", {}).then((r) => r.json()),
    onSuccess: (res: { removed: number }) => {
      // Every surface that counts or draws leads re-reads.
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map/count"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map/grid"] });
      toast({
        title: `Removed ${res.removed} FCC lead${res.removed === 1 ? "" : "s"}`,
        description: res.removed > 0 ? "Worked doors were protected and stay on the map." : "Nothing was unworked - every FCC door is protected.",
        severity: "success",
      });
      setConfirmText("");
      onClose();
    },
    onError: (e: any) =>
      toast({ title: "Couldn't remove FCC imports", description: String(e?.message ?? e).slice(0, 160), variant: "destructive" }),
  });

  // Every close path funnels through here so no armed state survives a reopen
  // (the ReclaimAllDialog lesson: a confirm ritual that only has to be
  // performed once isn't one), and a commit in flight is not interruptible.
  const close = () => {
    if (purge.isPending) return;
    setConfirmText("");
    onClose();
  };

  // Escape closes, like the scrim and Cancel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!open) return null;

  const p = preview.data;
  const nothingToRemove = p != null && p.removable === 0;

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="fcc-purge-title" data-testid="fcc-purge-dialog">
      {/* Scrim — a real close control, locked while committing. */}
      <button type="button" aria-label="Close" onClick={close} disabled={purge.isPending} className="absolute inset-0 bg-black/60" data-testid="fcc-purge-scrim" />

      <div className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-border bg-card p-5 shadow-xl animate-in fade-in slide-in-from-bottom-4 sm:slide-in-from-bottom-0 duration-200">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl bg-rose-500/15 text-rose-400 flex items-center justify-center shrink-0">
            <Trash2 className="w-5 h-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="fcc-purge-title" className="text-[16px] font-bold text-foreground leading-tight">Remove FCC imports</h2>
            <p className="text-[13px] text-muted-foreground mt-0.5">Delete FCC-imported doors no one has worked. Knocked, sold, and follow-up doors always stay.</p>
          </div>
        </div>

        {/* Blast radius — exact server numbers, before anything is armed. */}
        <div className="mt-4 rounded-xl border border-border bg-secondary/40 px-4 py-3" data-testid="fcc-purge-impact">
          {preview.isPending ? (
            <p role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Counting FCC-imported doors…
            </p>
          ) : preview.isError ? (
            <p role="alert" className="text-[13px] text-foreground" data-testid="fcc-purge-preview-error">
              Couldn't load the preview - nothing can be removed until the counts are known.
            </p>
          ) : p!.total === 0 ? (
            <p className="text-[13px] text-muted-foreground">No FCC-imported leads found - there is nothing to remove.</p>
          ) : (
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[13px]">
              <dt className="text-muted-foreground">FCC-imported doors</dt>
              <dd className="text-right font-bold tabular-nums text-foreground" data-testid="fcc-purge-total">{p!.total}</dd>
              <dt className="text-muted-foreground">Unworked - will be removed</dt>
              <dd className="text-right font-bold tabular-nums text-rose-400" data-testid="fcc-purge-removable">{p!.removable}</dd>
              <dt className="text-muted-foreground">Worked - protected, stay</dt>
              <dd className="text-right font-bold tabular-nums text-foreground" data-testid="fcc-purge-protected">{p!.protected}</dd>
            </dl>
          )}
        </div>

        {/* Typed confirmation - the purge has no undo. Only offered once the
            preview shows something is actually removable. */}
        {p != null && p.removable > 0 && (
          <div className="mt-4">
            <label htmlFor="fcc-purge-confirm" className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
              Type <span className="font-bold text-foreground tracking-wide">REMOVE</span> to confirm - this cannot be undone.
            </label>
            <input
              id="fcc-purge-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off" spellCheck={false} data-testid="fcc-purge-confirm-input"
              className={`mt-1.5 w-full h-11 rounded-lg bg-secondary border border-border px-3 text-[14px] font-semibold tracking-wide text-foreground placeholder:text-muted-foreground/50 ${FOCUS}`}
              placeholder="REMOVE"
            />
          </div>
        )}

        <div className="mt-5 flex gap-2.5">
          <button type="button" onClick={close} disabled={purge.isPending} data-testid="fcc-purge-cancel"
            className={`flex-1 h-11 rounded-xl bg-secondary border border-border text-[14px] font-semibold text-foreground active:scale-[.98] transition-transform hover:bg-secondary/70 disabled:opacity-50 ${FOCUS}`}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => purge.mutate()}
            disabled={p == null || nothingToRemove || !armed || purge.isPending}
            data-testid="fcc-purge-submit"
            className={`flex-1 h-11 rounded-xl bg-rose-600 text-white text-[14px] font-semibold active:scale-[.98] transition-transform hover:bg-rose-600/90 disabled:opacity-40 disabled:pointer-events-none inline-flex items-center justify-center gap-2 ${FOCUS}`}
          >
            {purge.isPending
              ? <><RefreshCw className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />Removing…</>
              : `Remove ${p?.removable || ""} FCC lead${p?.removable === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
