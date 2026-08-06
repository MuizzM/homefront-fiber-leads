import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { usd } from "@/lib/money";
import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { OverrideConfigWire } from "@shared/commissionOverrides";

// ── Downline override pay — org config ────────────────────────────────────────
// HouseAmountCard's mechanics, one shelf over: the same ["/api/commission/config"]
// query, the same draft-string-until-saved editing, the same PATCH →
// setQueryData → toast loop. Dollars live only in the editor; integer cents
// cross the wire, converted ONCE at submit (parseReservePatch discipline).
// Basis is fixed at flat-per-sale — PERCENT_OF_COMMISSION exists in the schema
// but the server refuses to enable it, so the UI never offers it.
// When the switch is off the rate inputs are HIDDEN, not zeroed (house style:
// hide, don't print zeros) — and the saved rates survive a disable, so
// re-enabling doesn't re-type the plan.
export function OverrideConfigCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: config } = useQuery<OverrideConfigWire>({
    queryKey: ["/api/commission/config"],
    queryFn: () => apiRequest("GET", "/api/commission/config").then(r => r.json()),
  });

  // `undefined` = "showing the saved value"; anything else = the operator is editing.
  const [draftEnabled, setDraftEnabled] = useState<boolean | undefined>(undefined);
  const [draftTeamLead, setDraftTeamLead] = useState<string | undefined>(undefined);
  const [draftManager, setDraftManager] = useState<string | undefined>(undefined);

  const savedEnabled = config?.overridesEnabled ?? false;
  const enabled = draftEnabled ?? savedEnabled;
  const savedTeamLead = config?.overrideTeamLeadCents ?? 0;
  const savedManager = config?.overrideManagerCents ?? 0;
  const shownTeamLead = draftTeamLead ?? (savedTeamLead > 0 ? (savedTeamLead / 100).toFixed(2) : "");
  const shownManager = draftManager ?? (savedManager > 0 ? (savedManager / 100).toFixed(2) : "");
  const dirty = draftEnabled !== undefined || draftTeamLead !== undefined || draftManager !== undefined;

  const save = useMutation({
    mutationFn: (patch: { overridesEnabled: boolean; overrideTeamLeadCents?: number; overrideManagerCents?: number }) =>
      apiRequest("PATCH", "/api/commission/config", patch).then(r => r.json()),
    onSuccess: (cfg: any) => {
      setDraftEnabled(undefined); setDraftTeamLead(undefined); setDraftManager(undefined);
      qc.setQueryData(["/api/commission/config"], cfg);
      toast({
        title: cfg.overridesEnabled
          ? `Overrides on — ${usd(cfg.overrideTeamLeadCents)} team lead · ${usd(cfg.overrideManagerCents)} manager`
          : "Overrides off",
        description: cfg.overridesEnabled
          ? "Each qualified downline sale now pays the upline slots these amounts. Existing ledger rows keep their frozen rates."
          : "No new override rows will be earned. Everything already on the ledger stands.",
      });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
    // The sheet and the rep card both project this config forward — refresh
    // them whichever way the save went.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["/api/commission/overrides/sheet"] });
      qc.invalidateQueries({ queryKey: ["/api/commission/overrides/me"] });
    },
  });

  const submit = () => {
    // Tri-state contract: absent = keep. Disabling sends ONLY the flag, so the
    // saved rates survive for the next enable.
    if (!enabled) return save.mutate({ overridesEnabled: false });
    const teamLead = shownTeamLead.trim() === "" ? 0 : Number(shownTeamLead);
    const manager = shownManager.trim() === "" ? 0 : Number(shownManager);
    if (!Number.isFinite(teamLead) || teamLead < 0 || !Number.isFinite(manager) || manager < 0) {
      return toast({ title: "Enter dollar amounts", description: "Override rates must be zero or more.", variant: "destructive" });
    }
    save.mutate({
      overridesEnabled: true,
      overrideTeamLeadCents: Math.round(teamLead * 100),
      overrideManagerCents: Math.round(manager * 100),
    });
  };

  return (
    <div className="rounded-xl bg-card border border-border p-4" data-testid="override-config-card">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <Label htmlFor="override-enabled" className="text-sm font-semibold flex items-center gap-1.5">
            <GitBranch className="w-3.5 h-3.5 text-primary" /> Downline overrides
          </Label>
          <p className="text-[12px] text-muted-foreground mt-0.5 max-w-md">
            Pays the first active team lead and manager above each seller a flat
            amount per qualified sale — on top of the seller's own commission,
            never out of it. Basis: <span className="text-foreground font-medium">Flat per sale</span>.
          </p>
        </div>
        <Switch
          id="override-enabled"
          checked={enabled}
          onCheckedChange={v => setDraftEnabled(v)}
          aria-label="Enable downline overrides"
          data-testid="override-enabled-switch"
        />
      </div>

      {enabled && (
        <div className="mt-3 flex items-end gap-3 flex-wrap" data-testid="override-rate-inputs">
          <div className="space-y-1">
            <Label htmlFor="override-teamlead" className="text-2xs font-semibold text-muted-foreground">Team lead, per sale</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <Input
                id="override-teamlead"
                inputMode="decimal"
                placeholder="0.00"
                value={shownTeamLead}
                onChange={e => setDraftTeamLead(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") submit(); }}
                className="w-32 pl-7 tabular-nums"
                data-testid="override-teamlead-input"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="override-manager" className="text-2xs font-semibold text-muted-foreground">Manager, per sale</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <Input
                id="override-manager"
                inputMode="decimal"
                placeholder="0.00"
                value={shownManager}
                onChange={e => setDraftManager(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") submit(); }}
                className="w-32 pl-7 tabular-nums"
                data-testid="override-manager-input"
              />
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          onClick={submit}
          disabled={save.isPending || !dirty}
          data-testid="override-config-save"
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
