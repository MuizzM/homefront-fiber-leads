// ── Billing Ops (platform owner) ──────────────────────────────────────────────
// Cross-tenant billing control room for the SaaS Control Center. One row per
// tenant with its live billing summary (dark tenants show "Not set up") and inline
// controls: provision, change plan, move billing state, grant credits. Every
// mutation goes through the same owner-gated /api/billing/* endpoints the tenant's
// own Billing page reads — so the two views can never disagree.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { FOCUS } from "@/lib/a11y";

type PlanKey = "starter" | "growth" | "professional" | "enterprise";
type BillingState = "trial" | "active" | "past_due" | "suspended" | "canceled";
interface Plan { key: PlanKey; name: string; monthlyCredits: number | null; monthlyPriceUsd: number | null }
interface Row {
  tenantId: number; companyName: string; slug: string;
  enabled: boolean; planKey: PlanKey | null; planName: string | null; state: BillingState | null;
  unlimited: boolean; creditsIncluded: number; creditsRemaining: number | null; creditsUsed: number;
  usagePct: number; level: "ok" | "warn" | "critical" | "exhausted"; overageUsed: number;
}

const STATE_CLS: Record<BillingState, string> = {
  trial: "bg-info/10 text-info", active: "bg-success/10 text-success",
  past_due: "bg-warning/10 text-warning", suspended: "bg-destructive/10 text-destructive",
  canceled: "bg-muted text-muted-foreground",
};
const BAR: Record<Row["level"], string> = { ok: "bg-primary", warn: "bg-warning", critical: "bg-destructive", exhausted: "bg-destructive" };
const STATES: BillingState[] = ["trial", "active", "past_due", "suspended", "canceled"];

// A staged (not yet applied) selector change. Selection alone never POSTs —
// the change waits in local state behind an inline confirm strip (audit
// finding: plan/state selects used to fire the mutation directly onChange).
type StagedChange = { kind: "plan"; value: PlanKey } | { kind: "state"; value: BillingState };

export function BillingOps() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery<{ plans: Plan[]; tenants: Row[] }>({ queryKey: ["/api/sa/billing"] });
  const [busy, setBusy] = useState<number | null>(null);
  const [grant, setGrant] = useState<Record<number, string>>({});
  const [provisionPlan, setProvisionPlan] = useState<Record<number, PlanKey>>({});
  const [staged, setStaged] = useState<Record<number, StagedChange | undefined>>({});

  const plans = data?.plans ?? [];
  const rows = data?.tenants ?? [];
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["/api/sa/billing"] });
    qc.invalidateQueries({ queryKey: ["/api/billing"] });
  };

  async function post(tenantId: number, path: string, body: Record<string, unknown>, ok: string) {
    setBusy(tenantId);
    try {
      const r = await apiRequest("POST", path, { tenantId, ...body });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `${r.status}`); }
      toast({ title: ok });
      refresh();
    } catch (e: any) {
      toast({ title: e.message || "Failed", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden" data-testid="billing-ops">
      <div className="flex items-center gap-2 px-4 py-3.5 border-b border-border">
        
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground">Billing &amp; credits</h2>
        <span className="text-[12px] text-muted-foreground">· lead-credit metering per tenant</span>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-muted-foreground">No tenants yet.</p>
      ) : (
        <div className="divide-y divide-border/60">
          {rows.map(t => {
            const dark = !t.enabled;
            return (
              <div key={t.tenantId} className="px-4 py-3.5 flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-4" data-testid={`billing-row-${t.tenantId}`}>
                {/* Tenant identity */}
                <div className="min-w-0 lg:w-48 shrink-0">
                  <div className="text-[13.5px] font-semibold tracking-tight text-foreground truncate">{t.companyName}</div>
                  <div className="text-[11px] text-muted-foreground truncate">{t.slug}</div>
                </div>

                {dark ? (
                  // Dark tenant → provision inline.
                  <div className="flex items-center gap-2 flex-wrap flex-1">
                    <span className="inline-flex items-center h-5 px-2 rounded-full bg-muted text-[11px] font-medium text-muted-foreground">Not set up</span>
                    <select
                      value={provisionPlan[t.tenantId] ?? "starter"}
                      aria-label={`Provision plan for ${t.companyName}`}
                      onChange={e => setProvisionPlan(p => ({ ...p, [t.tenantId]: e.target.value as PlanKey }))}
                      className="h-8 rounded-lg bg-secondary border border-border px-2 text-[12px] text-foreground focus:outline-none focus:border-primary/60"
                      data-testid={`provision-plan-${t.tenantId}`}>
                      {plans.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                    </select>
                    <button
                      disabled={busy === t.tenantId}
                      onClick={() => post(t.tenantId, "/api/billing/provision", { planKey: provisionPlan[t.tenantId] ?? "starter", state: "trial" }, "Billing provisioned")}
                      className="h-8 px-3 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1"
                      data-testid={`provision-btn-${t.tenantId}`}>
                       Provision
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Plan + state selectors — selection only STAGES the change;
                        the POST fires from the inline confirm strip below. */}
                    {(() => {
                      const sc = staged[t.tenantId];
                      const stagedPlan = sc?.kind === "plan" ? sc.value : null;
                      const stagedState = sc?.kind === "state" ? sc.value : null;
                      const danger = stagedState === "suspended" || stagedState === "canceled";
                      const stagedLabel = sc == null
                        ? null
                        : sc.kind === "plan"
                          ? (plans.find(p => p.key === sc.value)?.name ?? sc.value)
                          : sc.value.replace("_", " ");
                      const applyStaged = async () => {
                        if (!sc) return;
                        if (sc.kind === "plan") await post(t.tenantId, "/api/billing/plan", { planKey: sc.value }, "Plan changed");
                        else await post(t.tenantId, "/api/billing/state", { state: sc.value }, "State updated");
                        setStaged(s => ({ ...s, [t.tenantId]: undefined }));
                      };
                      const cancelStaged = () => setStaged(s => ({ ...s, [t.tenantId]: undefined }));
                      return (
                        <div className="flex items-center gap-2 flex-wrap">
                          <select
                            value={stagedPlan ?? t.planKey ?? "starter"}
                            disabled={busy === t.tenantId}
                            onChange={e => setStaged(s => ({ ...s, [t.tenantId]: { kind: "plan", value: e.target.value as PlanKey } }))}
                            aria-label={`Change plan for ${t.companyName}`}
                            className="h-8 rounded-lg bg-secondary border border-border px-2 text-[12px] text-foreground focus:outline-none focus:border-primary/60"
                            data-testid={`plan-sel-${t.tenantId}`}>
                            {plans.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                          </select>
                          <select
                            value={stagedState ?? t.state ?? "trial"}
                            disabled={busy === t.tenantId}
                            onChange={e => setStaged(s => ({ ...s, [t.tenantId]: { kind: "state", value: e.target.value as BillingState } }))}
                            aria-label={`Change billing state for ${t.companyName}`}
                            className={`h-8 rounded-lg border border-border px-2 text-[12px] font-medium focus:outline-none focus:border-primary/60 ${t.state ? STATE_CLS[t.state] : "bg-secondary text-foreground"}`}
                            data-testid={`state-sel-${t.tenantId}`}>
                            {STATES.map(s => <option key={s} value={s} className="bg-card text-foreground">{s.replace("_", " ")}</option>)}
                          </select>
                          {sc && (
                            <div
                              role="alert"
                              data-testid={`confirm-strip-${t.tenantId}`}
                              className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] ${danger ? "border-destructive/30 bg-destructive/8 text-destructive" : "border-border bg-secondary/60 text-foreground"}`}>
                              <span>Change {t.companyName} to {stagedLabel}?</span>
                              <button
                                disabled={busy === t.tenantId}
                                onClick={applyStaged}
                                data-testid={`confirm-apply-${t.tenantId}`}
                                className={`h-8 px-2.5 rounded-lg text-[12px] font-semibold disabled:opacity-50 ${danger ? "bg-destructive text-white hover:bg-destructive/90" : "bg-primary text-primary-foreground hover:bg-primary/90"} ${FOCUS}`}>
                                {busy === t.tenantId ? "Applying…" : "Confirm"}
                              </button>
                              <button
                                disabled={busy === t.tenantId}
                                onClick={cancelStaged}
                                data-testid={`confirm-cancel-${t.tenantId}`}
                                className={`h-8 px-2.5 rounded-lg border border-border text-[12px] font-medium text-foreground hover:bg-secondary disabled:opacity-50 ${FOCUS}`}>
                                Cancel
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Credit meter */}
                    <div className="flex-1 min-w-[140px]">
                      {t.unlimited ? (
                        <div className="text-[12.5px] text-foreground">∞ Unlimited · {t.creditsUsed.toLocaleString()} used</div>
                      ) : (
                        <>
                          <div className="flex items-center justify-between text-[12px] mb-1">
                            <span className="text-muted-foreground tabular-nums">{t.creditsUsed.toLocaleString()} / {t.creditsIncluded.toLocaleString()} credits</span>
                            <span className="text-muted-foreground tabular-nums">{(t.creditsRemaining ?? 0).toLocaleString()} left{t.overageUsed > 0 ? ` · +${t.overageUsed} over` : ""}</span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                            <div className={`h-full rounded-full ${BAR[t.level]}`} style={{ width: `${Math.min(100, t.usagePct)}%` }} />
                          </div>
                        </>
                      )}
                    </div>

                    {/* Grant credits */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <input
                        type="number" min={1} placeholder="+ credits"
                        aria-label={`Credits to grant to ${t.companyName}`}
                        value={grant[t.tenantId] ?? ""}
                        onChange={e => setGrant(g => ({ ...g, [t.tenantId]: e.target.value }))}
                        className="h-8 w-24 rounded-lg bg-secondary border border-border px-2 text-[12px] text-foreground tabular-nums focus:outline-none focus:border-primary/60"
                        data-testid={`grant-input-${t.tenantId}`} />
                      <button
                        disabled={busy === t.tenantId || !(Number(grant[t.tenantId]) > 0)}
                        onClick={() => { post(t.tenantId, "/api/billing/credits", { amount: Number(grant[t.tenantId]) }, "Credits granted"); setGrant(g => ({ ...g, [t.tenantId]: "" })); }}
                        className="h-8 px-2.5 rounded-lg border border-border text-[12px] font-medium text-foreground hover:bg-secondary disabled:opacity-40 inline-flex items-center gap-1"
                        data-testid={`grant-btn-${t.tenantId}`}>
                         Grant
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
