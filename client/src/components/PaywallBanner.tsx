// ── Paywall / billing-status banner ───────────────────────────────────────────
// A thin, full-width banner (Dialpad/Rox/PlanetScale pattern) that surfaces a
// billing problem on every page. Renders NOTHING for a healthy or dark tenant, so
// it's invisible until billing is provisioned AND something needs attention:
// past_due (amber), suspended/canceled (red), or credits nearly/fully spent.
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { Link } from "wouter";
import { AlertTriangle } from "lucide-react";

interface Access {
  enabled: boolean; state: string | null; access: "full" | "paywall" | "blocked";
  scanningAllowed: boolean; level: string; creditsRemaining: number | null; usagePct: number; stripe: boolean;
}

export function PaywallBanner() {
  const { user } = useAuth();
  const { data } = useQuery<Access>({
    queryKey: ["/api/billing/access"],
    queryFn: () => apiRequest("GET", "/api/billing/access").then(r => r.json()),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  if (!data || !data.enabled) return null; // dark tenant → never shown

  let tone: "amber" | "red" | null = null;
  let msg = "";
  if (data.access === "blocked") { tone = "red"; msg = "Your subscription is canceled — reactivate billing to restore access."; }
  else if (data.access === "paywall") { tone = "red"; msg = "Your workspace is suspended for non-payment. Reactivate billing to restore full access."; }
  else if (data.state === "past_due") { tone = "amber"; msg = "Payment is past due — update your billing to avoid interruption."; }
  else if (data.level === "exhausted") { tone = "amber"; msg = "Lead credits are exhausted for this cycle — new lead delivery is paused."; }
  else if (data.level === "critical") { tone = "amber"; msg = "You've used 90%+ of this cycle's lead credits."; }
  if (!tone) return null;

  const cls = tone === "red"
    ? "bg-red-500/12 text-red-500 border-red-500/25"
    : "bg-amber-500/12 text-amber-600 dark:text-amber-500 border-amber-500/25";
  const isAdmin = user?.role === "admin";

  return (
    <div className={`flex items-center gap-2 px-4 py-2 border-b text-[12.5px] font-medium ${cls}`} role="status" data-testid="paywall-banner">
      <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{msg}</span>
      {isAdmin && (
        <Link href="/billing" className="ml-auto shrink-0 underline underline-offset-2 hover:opacity-80" data-testid="paywall-cta">
          Manage billing →
        </Link>
      )}
    </div>
  );
}
