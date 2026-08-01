import { RefreshCw, TriangleAlert, WifiOff } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useKnockLogger } from "@/lib/useKnockLogger";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { useSustained } from "@/hooks/use-sustained";
import { needsAttentionText } from "@/features/knocking/knockFailurePolicy";

export function FieldStatusBar({ overlay = false }: { overlay?: boolean }) {
  const online = useNetworkStatus();
  const qc = useQueryClient();
  const { queue, snap } = useKnockLogger();
  const failed = snap.deadCount;
  const pending = snap.pendingCount;
  // A normal online save keeps items pending for a sub-second blip — flashing
  // "Syncing" over the map on every mark is noise (owner report). The syncing
  // state surfaces only when deliveries have been waiting long enough to mean
  // a real problem; offline and needs-attention remain immediate truth.
  const stuck = useSustained(online && pending > 0, 3000);
  if (online && failed === 0 && !stuck) return null;

  // "Needs attention" tells the rep WHICH door and WHY (oldest dead item);
  // Retry appears only when a retry can plausibly work (e.g. a 403 that heals
  // after signing back in) — terminal failures never park here, they
  // auto-resolve with their own toast.
  const oldestDead = snap.deadItems[0] ?? null;
  const deadAddress = (() => {
    if (!oldestDead) return null;
    const pins = (qc.getQueryData(["/api/leads/map"]) as { pins?: Array<{ id: number; address?: string }> } | undefined)?.pins;
    const address = pins?.find((p) => p.id === oldestDead.leadId)?.address;
    return typeof address === "string" && address.trim() ? address.trim() : null;
  })();
  const canRetry = failed > 0 && online && oldestDead?.retryable === true;

  const retry = () => {
    queue?.retryDead();
    void queue?.flush();
  };
  // Overlay (floating over the dark map) keeps its dark chip styling; the
  // in-flow banner uses theme tokens so it stays readable in light mode too.
  const tone = overlay
    ? failed > 0
      ? "border-red-500/30 bg-red-950/92 text-red-100"
      : !online
        ? "border-slate-500/35 bg-slate-950/92 text-slate-100"
        : "border-teal-500/30 bg-slate-950/92 text-white"
    : failed > 0
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : !online
        ? "border-border bg-muted text-muted-foreground"
        : "border-primary/30 bg-primary/10 text-primary";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="field-status"
      className={`${overlay ? "pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+8rem)] left-1/2 z-[45] w-[min(92vw,420px)] -translate-x-1/2 rounded-full shadow-xl [&_button]:pointer-events-auto" : "border-b"} ${tone} flex min-h-10 items-center gap-2 border px-3 py-2 text-[12px] font-medium backdrop-blur-xl`}
    >
      {failed > 0 ? <TriangleAlert className={`h-4 w-4 shrink-0 ${overlay ? "text-red-400" : ""}`} />
        : !online ? <WifiOff className="h-4 w-4 shrink-0" />
          : <RefreshCw className={`h-4 w-4 shrink-0 animate-spin ${overlay ? "text-teal-400" : ""}`} />}
      <span className="min-w-0 flex-1 truncate">
        {failed > 0
          ? needsAttentionText(failed, deadAddress, oldestDead?.reason ?? null)
          : !online
            ? `Offline — ${pending ? `${pending} update${pending === 1 ? "" : "s"} saved on this device` : "new work will save on this device"}`
            : `Syncing ${pending} field update${pending === 1 ? "" : "s"}…`}
      </span>
      {canRetry && (
        <button type="button" onClick={retry} className={`min-h-11 shrink-0 rounded-full px-4 font-semibold focus-visible:outline-none focus-visible:ring-2 ${overlay ? "bg-white/12 text-white hover:bg-white/20 focus-visible:ring-white" : "bg-secondary text-secondary-foreground hover:bg-secondary/80 focus-visible:ring-ring"}`}>
          Retry
        </button>
      )}
    </div>
  );
}
