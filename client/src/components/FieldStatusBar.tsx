import { RefreshCw, TriangleAlert, WifiOff } from "lucide-react";
import { useKnockLogger } from "@/lib/useKnockLogger";
import { useNetworkStatus } from "@/hooks/use-network-status";

export function FieldStatusBar({ overlay = false }: { overlay?: boolean }) {
  const online = useNetworkStatus();
  const { queue, snap } = useKnockLogger();
  const failed = snap.deadCount;
  const pending = snap.pendingCount;
  if (online && pending === 0 && failed === 0) return null;

  const retry = () => {
    queue?.retryDead();
    void queue?.flush();
  };
  const tone = failed > 0
    ? "border-red-500/30 bg-red-950/92 text-red-100"
    : !online
      ? "border-slate-500/35 bg-slate-950/92 text-slate-100"
      : "border-teal-500/30 bg-slate-950/92 text-white";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="field-status"
      className={`${overlay ? "pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+8rem)] left-1/2 z-[45] w-[min(92vw,420px)] -translate-x-1/2 rounded-full shadow-xl [&_button]:pointer-events-auto" : "border-b"} ${tone} flex min-h-10 items-center gap-2 border px-3 py-2 text-[12px] font-medium backdrop-blur-xl`}
    >
      {failed > 0 ? <TriangleAlert className="h-4 w-4 shrink-0 text-red-400" />
        : !online ? <WifiOff className="h-4 w-4 shrink-0" />
          : <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-teal-400" />}
      <span className="min-w-0 flex-1 truncate">
        {failed > 0
          ? `${failed} field update${failed === 1 ? "" : "s"} need attention`
          : !online
            ? `Offline — ${pending ? `${pending} update${pending === 1 ? "" : "s"} saved on this device` : "new work will save on this device"}`
            : `Syncing ${pending} field update${pending === 1 ? "" : "s"}…`}
      </span>
      {failed > 0 && online && (
        <button type="button" onClick={retry} className="min-h-8 shrink-0 rounded-full bg-white/12 px-3 font-semibold text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
          Retry
        </button>
      )}
    </div>
  );
}
