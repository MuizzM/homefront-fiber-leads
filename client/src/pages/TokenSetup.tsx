import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";

export default function TokenSetup() {
  const { toast } = useToast();

  const { data: status, isError, refetch } = useQuery<{
    hasToken: boolean;
    expiresIn: number | null;
    source: string;
  }>({
    queryKey: ["/api/token-status"],
    refetchInterval: 15000,
  });

  // Distinguish "we don't know" from "the token is bad": before the first
  // response (and on a failed fetch) this page used to open on the red
  // "Token Expired" alarm for ~200ms on every visit — a false outage.
  const unknown = status === undefined;
  const tokenOk = !!status?.hasToken && (status.expiresIn ?? 0) > 60;
  const expiresMin = status?.expiresIn ? Math.round(status.expiresIn / 60) : 0;

  const refreshMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/internal/refresh-token", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/token-status"] });
      refetch();
      toast({ title: "Token refreshed" });
    },
    onError: () => toast({ title: "Refresh failed", variant: "destructive" }),
  });

  return (
    <div className="max-w-sm mx-auto p-6 space-y-4 mt-8">
      {/* Status card */}
      <h1 className="sr-only">Scanner token</h1>
      <div role="status" className={`rounded-2xl p-5 border ${
        unknown
          ? "bg-card border-border"
          : tokenOk
            ? "bg-green-500/10 border-green-500/25"
            : "bg-red-500/10 border-red-500/25"
      }`}>
        <div className="flex items-center gap-3">
          {unknown ? (
            <RefreshCw className="w-6 h-6 text-muted-foreground flex-shrink-0 animate-spin" />
          ) : tokenOk ? (
            <CheckCircle2 className="w-6 h-6 text-green-400 flex-shrink-0" />
          ) : (
            <AlertTriangle className="w-6 h-6 text-red-400 flex-shrink-0" />
          )}
          <div>
            <p className="font-semibold text-foreground">
              {unknown ? (isError ? "Status unavailable" : "Checking…") : tokenOk ? "Scanner Connected" : "Token Expired"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {unknown
                ? (isError ? "Couldn't reach the token service - retrying automatically." : "Fetching the current token status.")
                : tokenOk
                  ? `Expires in ~${expiresMin} min · auto-refreshes via proxy`
                  : "Click refresh to reconnect via proxy"}
            </p>
          </div>
        </div>
      </div>

      {/* Refresh button */}
      <button
        onClick={() => refreshMutation.mutate()}
        disabled={refreshMutation.isPending}
        className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 disabled:opacity-40 text-primary-foreground text-sm font-semibold py-3 rounded-xl transition-colors"
        data-testid="button-refresh-token"
      >
        {refreshMutation.isPending ? (
          <><RefreshCw className="w-4 h-4 animate-spin" /> Refreshing…</>
        ) : (
          <><RefreshCw className="w-4 h-4" /> Refresh Token</>
        )}
      </button>

      <p className="text-center text-xs text-muted-foreground">
        Token auto-refreshes every 25 min via residential proxy.
      </p>
    </div>
  );
}
