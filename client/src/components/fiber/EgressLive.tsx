// WATCH THE PAIR RULE WORK.
//
// One residential IP and one Kinetic token serve about 20 checks, then both
// switch together - that is what Kinetic throttles, measured 60/60 answers for a
// fresh pair every 20 against 20/60 for a token ridden across fresh IPs. Until
// now the only way to see it happen was the server log.
//
// Diagnostics only. The masked session id and the sticky PORT that selects a
// residential IP; never a credential, never the proxy URL, and the IP itself is
// not known to the server either.
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";

export interface EgressActivity {
  proxy: {
    connected: boolean; sessionId: string; stickyPort: number | null;
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

/** How far through its budget the current pair is. */
function Budget({ used, of, label, testId }: { used: number; of: number; label: string; testId: string }) {
  const pct = of > 0 ? Math.min(100, Math.round((used / of) * 100)) : 0;
  // The last few checks on a spent IP are where the denials start, so the bar
  // says so before the switch rather than after.
  const tone = pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-amber-500" : "bg-primary";
  return (
    <div data-testid={testId}>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="text-[12px] font-semibold tabular-nums text-foreground">{used} / {of}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function EgressLive() {
  const { data, isLoading, isError } = useQuery<EgressActivity>({
    queryKey: ["/api/scan/egress"],
    queryFn: () => apiRequest("GET", "/api/scan/egress").then((r) => r.json()),
    refetchInterval: 1500,
    staleTime: 0,
  });

  if (isLoading) return <Skeleton className="h-44 w-full rounded-2xl" />;
  if (isError || !data) return <p className="text-[12px] text-muted-foreground">Could not read the egress state.</p>;

  const { proxy, token, mints, pairs } = data;

  return (
    <section className="rounded-2xl border border-border bg-card p-4" data-testid="egress-live">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Live egress</h3>
          <p className="text-[12px] text-muted-foreground">
            One IP and one token, {proxy.checksPerIp} checks, then both switch.
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
            proxy.connected ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"
          }`}
          data-testid="egress-connected"
        >
          {proxy.connected ? "Decodo connected" : "No proxy"}
        </span>
      </header>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-background p-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Residential IP</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground" data-testid="egress-port">
            {proxy.stickyPort == null ? "rotating gateway" : `port ${proxy.stickyPort}`}
          </div>
          <div className="text-[11px] text-muted-foreground">session {proxy.sessionId}</div>
          <div className="mt-2">
            <Budget used={proxy.checksOnThisIp} of={proxy.checksPerIp} label="Checks on this IP" testId="egress-ip-budget" />
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground" data-testid="egress-denials">
            Denial streak {proxy.denialStreak} of {proxy.rotateAfterDenials}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-background p-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Token</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground" data-testid="egress-token-ready">
            {token.ready} ready
          </div>
          <div className="text-[11px] text-muted-foreground">
            {token.inFlight} in flight{token.refreshing ? `, ${token.refreshing} minting` : ""}
          </div>
          <div className="mt-2">
            <Budget used={token.activeChecksUsed} of={token.maxChecksPerToken} label="Checks on this token" testId="egress-token-budget" />
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground" data-testid="egress-warm">
            Warm reserve {token.warmMinimum}, pool {token.total}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-background px-3 py-2" data-testid="egress-pairs">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Pairs switched</div>
          <div className="text-lg font-semibold tabular-nums text-foreground">{pairs.retired}</div>
          <div className="text-[11px] text-muted-foreground">{ago(pairs.lastAt)}</div>
        </div>
        <div className="rounded-xl border border-border bg-background px-3 py-2" data-testid="egress-mints-ok">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Tokens minted</div>
          <div className="text-lg font-semibold tabular-nums text-foreground">{mints.ok}</div>
          <div className="text-[11px] text-muted-foreground">{ago(mints.lastAt)}</div>
        </div>
        <div className="rounded-xl border border-border bg-background px-3 py-2" data-testid="egress-mints-failed">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Mints failed</div>
          <div className={`text-lg font-semibold tabular-nums ${mints.failed ? "text-destructive" : "text-foreground"}`}>{mints.failed}</div>
          <div className="text-[11px] text-muted-foreground">
            {mints.ok + mints.failed > 0 ? `${Math.round((mints.ok / (mints.ok + mints.failed)) * 100)}% success` : "no mints yet"}
          </div>
        </div>
      </div>

      {pairs.lastReason ? (
        <p className="mt-2 text-[11px] text-muted-foreground" data-testid="egress-last-reason">
          Last switch: {pairs.lastReason}
        </p>
      ) : null}
      {mints.lastError ? (
        <p className="mt-1 text-[11px] text-destructive" data-testid="egress-last-error">
          Last mint error: {mints.lastError}
        </p>
      ) : null}
    </section>
  );
}
