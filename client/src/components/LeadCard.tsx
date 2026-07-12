// ── LeadCard — the field-map property card (tap a scanned dot or a house) ──────
// In-depth Mobbin anatomy (Realtor.com "Key facts" grid + Zenly/Tabby place
// sheet): status badge → address hero → a labeled Details grid (fiber, speed,
// tech, competitor, segment, score) → actions (Add / Open, Directions, Copy).
// Works for a live scan hit, a reverse-geocoded tap, or an existing lead. Pure
// UI — the parent owns "add as lead" and "open".
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { MapPin, Zap, Plus, ArrowUpRight, Navigation } from "lucide-react";
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
  techType?: string | null; placement?: string | null; householdSegmentType?: string | null;
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

// The labeled "Details" rows — only facts that are actually present.
function buildFacts(p: CardProperty): Array<{ label: string; value: string; tone?: string }> {
  const f: Array<{ label: string; value: string; tone?: string }> = [];
  const fiber = p.isNewFiber ? "New fiber available"
    : p.fiberStatus === "copper" ? "Copper only"
    : p.fiberStatus === "no_service" ? "No service"
    : p.fiberStatus ? p.fiberStatus.replace(/_/g, " ") : null;
  if (fiber) f.push({ label: "Fiber", value: fiber, tone: p.isNewFiber ? "text-emerald-500" : undefined });
  if (p.billingStatus) f.push({ label: "Occupancy", value: p.billingStatus === "N" ? "No current subscriber" : "Has service", tone: p.billingStatus === "N" ? "text-emerald-500" : undefined });
  const spd = speedLabel(p.maxDownloadMbps);
  if (spd) f.push({ label: "Max speed", value: spd, tone: "text-sky-500" });
  else if (p.speedTier) f.push({ label: "Plan", value: p.speedTier });
  if (p.techType) f.push({ label: "Technology", value: p.techType });
  if (p.placement) f.push({ label: "Placement", value: p.placement });
  if (p.competitorName) f.push({ label: "Competitor", value: p.competitorName, tone: "text-orange-500" });
  if (p.householdSegmentType) f.push({ label: "Segment", value: p.householdSegmentType });
  if (typeof p.leadScore === "number" && p.leadScore > 0) f.push({ label: "Lead score", value: String(p.leadScore), tone: "text-emerald-500" });
  return f;
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
  const full = p ? formatFullAddress(p) : "";
  const facts = p ? buildFacts(p) : [];
  const mapsUrl = p
    ? (p.lat != null && p.lng != null
        ? `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(full)}`)
    : "#";

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="rounded-t-3xl p-0 border-border max-h-[88vh] overflow-y-auto" data-testid="lead-card">
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

            {/* Details — the in-depth labeled grid (only present facts). */}
            {facts.length > 0 && (
              <div className="mt-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 px-0.5">Details</div>
                <dl className="rounded-2xl border border-border bg-secondary/40 divide-y divide-border overflow-hidden">
                  {facts.map((row, i) => (
                    <div key={i} className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                      <dt className="text-[13px] text-muted-foreground shrink-0">{row.label}</dt>
                      <dd className={`text-[13.5px] font-semibold text-right ${row.tone ?? "text-foreground"}`}>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {/* Primary action */}
            <div className="mt-5">
              {p.id ? (
                <button type="button" onClick={() => onOpen?.(p.id!)} data-testid="lead-card-open"
                  className="w-full inline-flex items-center justify-center gap-1.5 h-12 rounded-2xl bg-primary text-primary-foreground text-[15px] font-semibold active:scale-[0.99] transition">
                  Open lead <ArrowUpRight className="w-4 h-4" />
                </button>
              ) : canAdd ? (
                <button type="button" onClick={() => onAddLead(p)} data-testid="lead-card-add"
                  className="w-full inline-flex items-center justify-center gap-1.5 h-12 rounded-2xl bg-primary text-primary-foreground text-[15px] font-semibold active:scale-[0.99] transition">
                  <Plus className="w-4 h-4" /> Add as lead
                </button>
              ) : null}
            </div>

            {/* Secondary actions — Directions + Copy (a rep on the doorstep). */}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer" data-testid="lead-card-directions"
                className="inline-flex items-center justify-center gap-1.5 h-11 rounded-xl border border-border bg-secondary/60 text-[13px] font-medium text-foreground active:scale-[0.98] transition">
                <Navigation className="w-4 h-4 text-sky-500" /> Directions
              </a>
              <CopyAddressButton text={full} className="h-11" />
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
