// ── AddLeadSheet — manual "add a lead" flow ───────────────────────────────────
// Opens prefilled from a tapped house or a scanned dot (address/city/state/zip +
// any fiber fields carried through), or blank for a pure manual entry. Posts to
// POST /api/leads (tenant stamped server-side). Minimal required fields, big
// touch targets — a rep can add a door in a few taps.
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, MapPin } from "lucide-react";
import type { CardProperty } from "@/components/LeadCard";

export function AddLeadSheet({ initial, onClose, onCreated }: {
  initial: Partial<CardProperty> | null;
  onClose: () => void;
  onCreated?: (leadId: number) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("NC");
  const [zip, setZip] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [saving, setSaving] = useState(false);

  // Re-seed the form whenever a new source property opens the sheet.
  useEffect(() => {
    if (!initial) return;
    setAddress(initial.address ?? "");
    setCity(initial.city ?? "");
    setState(initial.state ?? "NC");
    setZip(initial.zip ?? "");
    setOwnerName(""); setOwnerPhone("");
  }, [initial]);

  const open = !!initial;
  const canSave = address.trim().length >= 3 && city.trim().length >= 2 && zip.trim().length >= 3 && !saving;

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        address: address.trim(), city: city.trim(), state: state.trim() || "NC", zip: zip.trim(),
        leadStatus: "prospect",
        lat: initial?.lat ?? null, lng: initial?.lng ?? null,
        // carry through anything the scan/tap already knew, so a new-fiber hit
        // added by hand keeps its qualification.
        fiberStatus: initial?.fiberStatus ?? "unknown",
        isNewFiber: initial?.isNewFiber ?? false,
        billingStatus: initial?.billingStatus ?? null,
        leadTag: initial?.leadTag ?? null,
        maxDownloadMbps: initial?.maxDownloadMbps ?? null,
        competitorName: initial?.competitorName ?? null,
      };
      if (ownerName.trim()) body.ownerName = ownerName.trim();
      if (ownerPhone.trim()) body.ownerPhone = ownerPhone.trim();
      const res = await apiRequest("POST", "/api/leads", body);
      const lead = await res.json();
      toast({ title: "Lead added", description: address.trim() });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      onCreated?.(lead?.id);
      onClose();
    } catch (e: any) {
      const msg = String(e?.message ?? "").replace(/^\s*\d{3}:\s*/, "");
      toast({ title: "Couldn't add lead", description: msg || "Try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="rounded-t-3xl p-0 border-border max-h-[90vh] overflow-y-auto" data-testid="add-lead-sheet">
        <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto mb-4 h-1 w-9 rounded-full bg-border" aria-hidden="true" />
          <h2 className="text-[19px] font-bold tracking-tight text-foreground flex items-center gap-2">
            <span className="grid place-items-center w-8 h-8 rounded-xl bg-primary/12 text-primary"><Plus className="w-4 h-4" /></span>
            Add a lead
          </h2>
          {initial?.lat != null && (
            <p className="text-[12px] text-muted-foreground mt-1 flex items-center gap-1"><MapPin className="w-3 h-3" /> From the map — check the address below.</p>
          )}

          <div className="mt-4 space-y-3">
            <Field label="Street address" value={address} onChange={setAddress} placeholder="402 Nard Ln" testid="add-lead-address" autoFocus />
            <div className="grid grid-cols-[1fr_84px_96px] gap-2">
              <Field label="City" value={city} onChange={setCity} placeholder="Inman" testid="add-lead-city" />
              <Field label="State" value={state} onChange={(v) => setState(v.toUpperCase().slice(0, 2))} placeholder="SC" testid="add-lead-state" />
              <Field label="ZIP" value={zip} onChange={(v) => setZip(v.replace(/\D/g, "").slice(0, 5))} placeholder="29349" inputMode="numeric" testid="add-lead-zip" />
            </div>
            <Field label="Owner name (optional)" value={ownerName} onChange={setOwnerName} placeholder="—" testid="add-lead-owner" />
            <Field label="Phone (optional)" value={ownerPhone} onChange={setOwnerPhone} placeholder="—" inputMode="tel" testid="add-lead-phone" />
          </div>

          <button type="button" onClick={submit} disabled={!canSave} data-testid="add-lead-submit"
            className="mt-5 w-full h-12 rounded-2xl bg-primary text-primary-foreground text-[15px] font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99] transition">
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Adding…</> : <>Add lead</>}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, value, onChange, placeholder, inputMode, autoFocus, testid }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
  inputMode?: "text" | "numeric" | "tel"; autoFocus?: boolean; testid?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{label}</span>
      <input
        value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        inputMode={inputMode} autoFocus={autoFocus} data-testid={testid}
        className="w-full h-11 rounded-xl border border-border bg-card px-3 text-[15px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
    </label>
  );
}
