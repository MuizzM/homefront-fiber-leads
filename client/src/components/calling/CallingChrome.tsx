import { Link } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { LockKeyhole, PhoneCall, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCan } from "@/lib/capabilities";

export function CallingChrome({ children }: { children: React.ReactNode }) {
  const [location] = useHashLocation();
  const canReadQueue = useCan("calling.queue.read");
  const tabs = [
    // ONE calling surface. The compliance console is gone: Tracerfy scrubs
    // every number on ingest and enforcement lives server-side, so a second tab
    // existed only to show a rep a second, weaker answer to "may I dial this".
    { href: "/calling", label: "Queue", show: canReadQueue },
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
            <div className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              <LockKeyhole className="h-3 w-3" aria-hidden="true" /> Manual, gated pilot
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

/** Humanized name + one-line meaning for every authoritative server gate the
 *  status endpoint can report. Unknown codes fall back to a humanized form of
 *  the raw code so no gate is ever hidden. */
const GATE_INFO: Record<string, { label: string; meaning: string }> = {
  module_flag_off: { label: "Calling module", meaning: "Platform-level calling flag is off" },
  global_emergency_stop_on: { label: "Global emergency stop", meaning: "Calling is halted platform-wide" },
  organization_not_in_pilot: { label: "Pilot access", meaning: "Organization is not enrolled in the calling pilot" },
  calling_secrets_missing: { label: "Calling secrets", meaning: "Required provider credentials are not configured" },
  national_dnc_flag_off: { label: "National DNC checks", meaning: "National Do Not Call screening is switched off" },
  state_dnc_flag_off: { label: "State DNC checks", meaning: "State Do Not Call screening is switched off" },
  manual_call_flag_off: { label: "Manual click-to-call", meaning: "Human-initiated calling flag is off" },
  organization_calling_off: { label: "Organization calling", meaning: "Calling is disabled in the organization profile" },
  organization_emergency_stop_on: { label: "Organization emergency stop", meaning: "This organization has an active emergency stop" },
  representative_hold_active: { label: "Representative hold", meaning: "A compliance hold is placed on your calling access" },
  counsel_approval_missing: { label: "Counsel approval", meaning: "Legal counsel has not approved the calling program" },
  seller_authorization_missing: { label: "Seller authorization", meaning: "No authorized seller is recorded" },
  active_seller_authorization_evidence_missing: { label: "Seller authorization evidence", meaning: "No current authorization evidence is on file" },
  caller_id_authorization_missing: { label: "Caller ID authorization", meaning: "No authorized outbound caller ID is on file" },
  approved_script_missing: { label: "Approved script", meaning: "No counsel-approved call script is active" },
  approved_rules_missing: { label: "Approved rules", meaning: "No approved compliance rule version is active" },
  national_dnc_missing_or_stale: { label: "National DNC data", meaning: "The national DNC dataset is missing or stale" },
  calling_prerequisites_incomplete: { label: "Calling prerequisites", meaning: "The server reports calling is not ready" },
};

function gateInfo(code: string): { label: string; meaning: string } {
  return GATE_INFO[code] ?? {
    label: code.replace(/_/g, " ").replace(/^\w/, char => char.toUpperCase()),
    meaning: "This authoritative server gate has not passed",
  };
}

export function CallingAvailability({ status }: { status: { callable: boolean; blockers: string[] } }) {
  if (status.callable) {
    return (
      <div data-testid="calling-ready" className="flex items-start gap-3 rounded-2xl border border-border bg-card px-4 py-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold leading-5 text-foreground">Manual calling gates are ready</div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Every number is still re-checked when a rep requests a one-use call authorization.</p>
        </div>
      </div>
    );
  }
  const gates = status.blockers.length ? status.blockers : ["calling_prerequisites_incomplete"];
  return (
    <section data-testid="calling-blocked" role="status" className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <LockKeyhole className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold leading-5 text-foreground">Calling is locked</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">No phone number can be revealed and no call can start until every authoritative server gate passes.</p>
        </div>
        <span className="mt-0.5 inline-flex shrink-0 items-center rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-amber-600 dark:text-amber-400">
          {gates.length} blocking
        </span>
      </div>
      <div className="px-4 pb-2 pt-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Server gates</h3>
        <ul className="mt-1 divide-y divide-border/60">
          {gates.map(code => {
            const gate = gateInfo(code);
            return (
              <li key={code} className="flex items-start gap-2.5 py-2">
                <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                <div className="min-w-0 flex-1 sm:grid sm:grid-cols-[13.5rem_minmax(0,1fr)] sm:items-baseline sm:gap-2">
                  <span className="block truncate text-[13px] font-medium leading-5 text-foreground">{gate.label}</span>
                  <span className="block truncate text-xs leading-5 text-muted-foreground">{gate.meaning}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

export function CallingUnknownState({ retry }: { retry: () => void }) {
  return (
    <div data-testid="calling-status-unknown" role="alert" className="rounded-2xl border border-red-500/25 bg-card p-5 text-center">
      <span className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-red-500/10">
        <LockKeyhole aria-hidden="true" className="h-[18px] w-[18px] text-red-600 dark:text-red-400" />
      </span>
      <h2 className="mt-2.5 text-[13px] font-semibold text-foreground">Calling status is unknown</h2>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">The compliance service could not be verified. Calling remains locked; no number is available.</p>
      <button type="button" onClick={retry} className="mt-4 min-h-10 rounded-xl border border-border bg-card px-4 text-[13px] font-semibold transition-colors hover:bg-secondary/60">Retry status check</button>
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
