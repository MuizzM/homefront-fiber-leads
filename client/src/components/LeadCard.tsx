// ── LeadCard — the property card shown when you tap a scanned dot or a house ───
// Mobbin anatomy (Compass / Zillow property card): a status badge up top, the
// address as the hero, a row of key-fact chips, then the actions. Works for a
// live scan hit, a reverse-geocoded tap, or an existing lead. Pure UI — the
// parent owns "add as lead" and "open".
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { MapPin, Zap, Wifi, TrendingUp, Plus, ArrowUpRight, Gauge } from "lucide-react";
import { CopyAddressButton } from "@/components/CopyAddressButton";
import { formatFullAddress } from "@/lib/reverseGeocode";

export interface CardProperty {
  id?: number;                       // present → already a saved lead
  address: string;
  city?: string | null; state?: string | null; zip?: string | null;
  lat?: number | null; lng?: number | null;
  fiberStatus?: string | null; isNewFiber?: boolean | null; billingStatus?: string | null;
  speedTier?: string | null; maxDownloadMbps?: number | null;
  competitorName?: string | null; leadTag?: string | null; leadScore?: number | null;
  source?: "scan" | "tap" | "lead";
}

function speedLabel(mbps?: number | null): string | null {
  if (!mbps) return null;
  return mbps >= 1000 ? `${(mbps / 1000).toFixed(mbps % 1000 ? 1 : 0)} Gig` : `${mbps} Mbps`;
}

function statusBadge(p: CardProperty): { text: string; cls: string } {
  if (p.isNewFiber && p.billingStatus === "N") return { text: "New-fiber lead", cls: "bg-emerald-500/15 text-emerald-500 ring-emerald-500/30" };
  if (p.isNewFiber) return { text: "New fiber here", cls: "bg-teal-500/15 text-teal-500 ring-teal-500/30" };
  if (p.leadTag === "coming_soon") return { text: "Fiber coming soon", cls: "bg-amber-500/15 text-amber-500 ring-amber-500/30" };
  if (p.competitorName) return { text: `Competitor: ${p.competitorName}`, cls: "bg-orange-500/15 text-orange-500 ring-orange-500/30" };
  if (p.fiberStatus === "copper" || p.fiberStatus === "no_service") return { text: "No fiber yet", cls: "bg-muted text-muted-foreground ring-border" };
  if (p.source === "tap") return { text: "Tapped location", cls: "bg-sky-500/15 text-sky-500 ring-sky-500/30" };
  return { text: p.fiberStatus || "Unknown", cls: "bg-muted text-muted-foreground ring-border" };
}

export function LeadCard({ property, onClose, onAddLead, onOpen, canAdd = true }: {
  property: CardProperty | null;
  onClose: () => void;
  onAddLead: (p: CardProperty) => void;
  onOpen?: (id: number) => void;
  canAdd?: boolean; // only roles that can create a lead (team_lead+) see "Add"
}) {
  const open = !!property;
  const p = property;
  const badge = p ? statusBadge(p) : { text: "", cls: "" };
  const spd = speedLabel(p?.maxDownloadMbps);
  const full = p ? formatFullAddress(p) : "";

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="rounded-t-3xl p-0 border-border max-h-[85vh] overflow-y-auto" data-testid="lead-card">
        {p && (
          <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <div className="mx-auto mb-4 h-1 w-9 rounded-full bg-border" aria-hidden="true" />

            {/* Status badge */}
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ring-1 ${badge.cls}`}>
              {p.isNewFiber ? <Zap className="w-3 h-3" /> : <MapPin className="w-3 h-3" />}
              {badge.text}
            </span>

            {/* Address — the hero */}
            <h2 className="mt-3 text-[22px] font-bold tracking-tight text-foreground leading-tight">{p.address}</h2>
            <p className="text-[14px] text-muted-foreground mt-0.5">
              {[p.city, [p.state, p.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
            </p>

            {/* Key-fact chips */}
            <div className="mt-4 flex flex-wrap gap-2">
              {spd && <Fact icon={<Gauge className="w-3.5 h-3.5" />} label={spd} tone="text-sky-500" />}
              {p.speedTier && !spd && <Fact icon={<Wifi className="w-3.5 h-3.5" />} label={p.speedTier} tone="text-sky-500" />}
              {p.competitorName && <Fact icon={<TrendingUp className="w-3.5 h-3.5" />} label={p.competitorName} tone="text-orange-500" />}
              {typeof p.leadScore === "number" && p.leadScore > 0 && <Fact icon={<Zap className="w-3.5 h-3.5" />} label={`Score ${p.leadScore}`} tone="text-emerald-500" />}
              {p.fiberStatus && !p.isNewFiber && <Fact icon={<Wifi className="w-3.5 h-3.5" />} label={p.fiberStatus} tone="text-muted-foreground" />}
            </div>

            {/* Actions */}
            <div className="mt-5 flex items-center gap-2">
              {p.id ? (
                <button type="button" onClick={() => onOpen?.(p.id!)} data-testid="lead-card-open"
                  className="flex-1 inline-flex items-center justify-center gap-1.5 h-12 rounded-2xl bg-primary text-primary-foreground text-[15px] font-semibold active:scale-[0.99] transition">
                  Open lead <ArrowUpRight className="w-4 h-4" />
                </button>
              ) : canAdd ? (
                <button type="button" onClick={() => onAddLead(p)} data-testid="lead-card-add"
                  className="flex-1 inline-flex items-center justify-center gap-1.5 h-12 rounded-2xl bg-primary text-primary-foreground text-[15px] font-semibold active:scale-[0.99] transition">
                  <Plus className="w-4 h-4" /> Add as lead
                </button>
              ) : null}
              <CopyAddressButton text={full} className={p.id || canAdd ? "h-12 px-4" : "h-12 flex-1"} />
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Fact({ icon, label, tone }: { icon: React.ReactNode; label: string; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-secondary/60 border border-border px-2.5 py-1.5 text-[12.5px] font-medium text-foreground">
      <span className={tone}>{icon}</span>{label}
    </span>
  );
}
