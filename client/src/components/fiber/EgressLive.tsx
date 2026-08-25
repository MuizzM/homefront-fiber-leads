// WHERE THE TRAFFIC IS LEAVING FROM, RIGHT NOW.
//
// One residential IP and one Kinetic token serve about 20 checks, then both
// switch together - that is what Kinetic throttles (60/60 answers for a fresh
// pair every 20, against 20/60 for a token ridden across fresh IPs).
//
// The address leads, because that is the question an operator actually has: is
// this leaving from Decodo, or from our building? Everything else is supporting
// detail and is sized like it.
//
// Diagnostics only: the address Decodo hands us and a masked session id. No
// credential, no proxy URL.
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export interface EgressActivity {
  proxy: {
    connected: boolean; sessionId: string; stickyPort: number | null; publicIp: string | null;
    publicIpError: string | null;
    checksOnThisIp: number; checksPerIp: number; denialStreak: number; rotateAfterDenials: number;
  };
  token: {
    ready: number; total: number; warmMinimum: number; maxChecksPerToken: number;
    activeChecksUsed: number; activeChecksRemaining: number; inFlight: number; refreshing: number;
  };
  mints: { ok: number; failed: number; lastAt: number | null; lastError: string | null };
  pairs: { retired: number; lastAt: number | null; lastReason: string | null };
}

function ago(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export default function EgressLive() {
  const { data, isLoading, isError } = useQuery<EgressActivity>({
    queryKey: ["/api/scan/egress"],
    queryFn: () => apiRequest("GET", "/api/scan/egress").then((r) => r.json()),
    refetchInterval: 1500,
    staleTime: 0,
  });

  if (isLoading) return <Skeleton className="h-40 w-full rounded-2xl" />;
  if (isError || !data) {
    return (
      <div className="rounded-2xl border border-border bg-card p-4" data-testid="egress-live-error">
        <p className="text-[13px] text-pretty text-muted-foreground">
          Could not read the egress state. Scanning is unaffected; this panel is diagnostics only.
        </p>
      </div>
    );
  }

  const { proxy, token, mints, pairs } = data;
  const pct = proxy.checksPerIp > 0 ? Math.min(100, Math.round((proxy.checksOnThisIp / proxy.checksPerIp) * 100)) : 0;
  const minted = mints.ok + mints.failed;
  const idle = proxy.checksOnThisIp === 0 && pairs.retired === 0;
  // The last stretch of an IP's budget is where denials start, so the bar says
  // so before the switch rather than after. Semantic tokens, not raw palette:
  // an undefined token silently falls back to currentColor (docs/DESIGN_SYSTEM.md).
  const barTone = pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-primary";

  return (
    <section className="rounded-2xl border border-border bg-card p-4" data-testid="egress-live">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Scanning from
          </h3>
          <p
            className="mt-0.5 truncate font-mono text-2xl font-semibold tabular-nums text-foreground"
            data-testid="egress-ip"
            title={proxy.publicIp ?? undefined}
          >
            {proxy.publicIp ?? (proxy.stickyPort == null ? "rotating gateway" : "resolving")}
          </p>
          <p className="text-[12px] text-pretty text-muted-foreground" data-testid="egress-port">
            {proxy.connected ? "Decodo residential" : "no proxy"}
            {proxy.stickyPort != null ? ` · port ${proxy.stickyPort}` : ""} · {proxy.sessionId}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold",
            proxy.connected ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive",
          )}
          data-testid="egress-connected"
        >
          {proxy.connected ? "Decodo" : "direct"}
        </span>
      </div>

      {/* The pair budget: the one number that explains when the IP changes. */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-medium text-foreground">This IP and token</span>
          <span className="text-[12px] font-semibold tabular-nums text-muted-foreground">
            {proxy.checksOnThisIp} of {proxy.checksPerIp} checks
          </span>
        </div>
        <Progress
          value={pct}
          aria-label={`Checks spent on this residential IP: ${proxy.checksOnThisIp} of ${proxy.checksPerIp}`}
          className="mt-1.5 h-2"
          indicatorClassName={barTone}
        />
        <p className="mt-1.5 text-[12px] text-pretty text-muted-foreground">
          {idle
            ? `Idle. Both switch after ${proxy.checksPerIp} checks; run a city below to see it move.`
            : `Both switch at ${proxy.checksPerIp}. Switched ${pairs.retired} times, last ${ago(pairs.lastAt)}.`}
        </p>
      </div>

      {/* Supporting detail, deliberately quiet. */}
      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-[12px]">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Tokens</dt>
          <dd className="font-semibold tabular-nums text-foreground" data-testid="egress-token-ready">
            {token.ready} ready{token.inFlight ? `, ${token.inFlight} in flight` : ""}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Minted</dt>
          <dd className="font-semibold tabular-nums text-foreground" data-testid="egress-mints">
            {mints.ok}
            {mints.failed ? <span className="font-normal text-destructive"> · {mints.failed} failed</span> : null}
            {minted ? <span className="font-normal text-muted-foreground"> ({Math.round((mints.ok / minted) * 100)}%)</span> : null}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Denials</dt>
          <dd className="font-semibold tabular-nums text-foreground" data-testid="egress-denials">
            {proxy.denialStreak} of {proxy.rotateAfterDenials}
          </dd>
        </div>
      </dl>

      {/* Errors name the problem, next to what they affect. */}
      {proxy.publicIpError ? (
        <p className="mt-2 text-[12px] text-pretty text-muted-foreground" data-testid="egress-ip-error">
          Address unresolved ({proxy.publicIpError}). Scanning continues; the port above is authoritative.
        </p>
      ) : null}
      {mints.lastError ? (
        <p className="mt-1 text-[12px] text-pretty text-destructive" data-testid="egress-last-error">
          Last mint failed: {mints.lastError}
        </p>
      ) : null}
    </section>
  );
}
