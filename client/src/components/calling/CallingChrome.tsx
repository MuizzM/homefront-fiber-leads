import { Link } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { AlertTriangle, LockKeyhole, PhoneCall, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCan } from "@/lib/capabilities";

export function CallingChrome({ children }: { children: React.ReactNode }) {
  const [location] = useHashLocation();
  const canReadCompliance = useCan("calling.compliance.read");
  const canReadQueue = useCan("calling.queue.read");
  const tabs = [
    { href: "/calling", label: "Queue", show: canReadQueue },
    { href: "/calling/compliance", label: "Compliance", show: canReadCompliance },
  ].filter(item => item.show);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col">
      <div className="sticky top-0 z-20 border-b border-border/80 bg-background/95 px-4 backdrop-blur-xl md:px-6">
        <div className="flex h-14 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
            <PhoneCall className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold tracking-tight">Calling</div>
            <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              <LockKeyhole className="h-3 w-3" /> Manual, gated pilot
            </div>
          </div>
          <nav aria-label="Calling module" className="flex h-full items-end gap-1">
            {tabs.map(tab => {
              const active = tab.href === "/calling"
                ? location === tab.href || location.startsWith("/calling/lead/")
                : location.startsWith(tab.href);
              return (
                <Link key={tab.href} href={tab.href} aria-current={active ? "page" : undefined}
                  className={cn("relative grid min-h-11 place-items-center px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground",
                    active && "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary")}>
                  {tab.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
      {children}
    </div>
  );
}

export function CallingAvailability({ status }: { status: { callable: boolean; blockers: string[] } }) {
  if (status.callable) {
    return (
      <div data-testid="calling-ready" className="flex items-start gap-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.08] p-3.5">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-emerald-400">Manual calling gates are ready</div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Every number is still re-checked when a rep requests a one-use call authorization.</p>
        </div>
      </div>
    );
  }
  return (
    <section data-testid="calling-blocked" role="status" className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-amber-400">Calling is locked</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">No phone number can be revealed and no call can start until every authoritative server gate passes.</p>
        </div>
      </div>
      <ul className="mt-3 space-y-1.5 border-t border-amber-500/20 pt-3">
        {(status.blockers.length ? status.blockers : ["Calling prerequisites are incomplete"]).map(blocker => (
          <li key={blocker} className="flex items-start gap-2 text-xs text-foreground">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
            <span>{blocker.replace(/_/g, " ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CallingUnknownState({ retry }: { retry: () => void }) {
  return (
    <div data-testid="calling-status-unknown" role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/[0.08] p-5 text-center">
      <LockKeyhole className="mx-auto h-6 w-6 text-red-400" />
      <h2 className="mt-2 text-sm font-semibold text-red-400">Calling status is unknown</h2>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">The compliance service could not be verified. Calling remains locked; no number is available.</p>
      <button type="button" onClick={retry} className="mt-4 min-h-11 rounded-xl border border-border bg-card px-4 text-sm font-semibold hover:bg-secondary">Retry status check</button>
    </div>
  );
}

export function CallingPageSkeleton() {
  return (
    <div className="space-y-3" aria-label="Loading calling module" aria-busy="true">
      <div className="app-skeleton h-24 rounded-2xl bg-muted" />
      <div className="app-skeleton h-16 rounded-2xl bg-muted" />
      <div className="app-skeleton h-28 rounded-2xl bg-muted" />
      <div className="app-skeleton h-28 rounded-2xl bg-muted" />
    </div>
  );
}
