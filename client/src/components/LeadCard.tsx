// ── LeadCard — the field-map property card (tap a scanned dot or a house) ──────
// In-depth Mobbin anatomy (Realtor.com "Key facts" grid + Zenly/Tabby place
// sheet): status badge → address hero → a labeled Details grid (fiber, speed,
// tech, competitor, segment, score) → actions (Add / Open, Directions, Copy).
// Works for a live scan hit, a reverse-geocoded tap, or an existing lead. Pure
// UI — the parent owns "add as lead" and "open".
//
// THREE presentation variants, selectable via the `cardVariant` URL param
// (1 | 2 | 3, default 1). Same props, same behavior, same testids — only the
// layout differs:
//   1 "Compact row-sheet" — tight single column, inline equal-width action row.
//   2 "Stat-strip"        — hairline-divided score/status/confidence strip,
//                            stacked full-width actions.
//   3 "Hero-accent"       — status-tinted band behind the address, floating
//                            action row, larger tap targets for gloved use.
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { MapPin, Zap, Plus, ArrowUpRight, Navigation } from "lucide-react";
import { CopyAddressButton } from "@/components/CopyAddressButton";
import { formatFullAddress } from "@/lib/reverseGeocode";
import { leadMarkMeta } from "@shared/leadMark";
import { LeadContacts } from "@/components/LeadContacts";
import type { TracedPhone } from "@shared/tracerfy";

export interface CardProperty {
  id?: number;                       // present → already a saved lead
  address: string;
  city?: string | null; state?: string | null; zip?: string | null;
  lat?: number | null; lng?: number | null;
  fiberStatus?: string | null; isNewFiber?: boolean | null; billingStatus?: string | null;
  speedTier?: string | null; maxDownloadMbps?: number | null;
  competitorName?: string | null; leadTag?: string | null; leadScore?: number | null;
  freshConfidence?: string | null; assignMark?: string | null;
  techType?: string | null; placement?: string | null; householdSegmentType?: string | null;
  source?: "scan" | "tap" | "lead";
  // Skip-trace results. The name is the highest-value thing a trace buys — a
  // knocker who can open with "is that Dana?" converts better than one who
  // opens with "hi there" — so LeadContacts renders ABOVE the facts grid in
  // every variant. DNC numbers stay visible there, badged and un-tappable.
  ownerName?: string | null;
  phones?: TracedPhone[];
}

// Which layout to render. Works with the SPA's hash router: the param may sit
// before the hash (?cardVariant=2#/map) or inside it (#/map?cardVariant=2).
// TOUCH devices default to V3 "Hero-accent" (h-14 primary action — gloved-thumb
// sizing); mouse/trackpad keeps V1. ?cardVariant= always overrides for testing.
export type CardVariant = 1 | 2 | 3;
export function readCardVariant(): CardVariant {
  try {
    const hash = window.location.hash;
    const qIdx = hash.indexOf("?");
    const fromHash = qIdx >= 0
      ? new URLSearchParams(hash.slice(qIdx + 1)).get("cardVariant")
      : null;
    const fromSearch = new URLSearchParams(window.location.search).get("cardVariant");
    const v = Number(fromHash ?? fromSearch);
    if (v === 1 || v === 2 || v === 3) return v;
    return window.matchMedia?.("(pointer: coarse)")?.matches ? 3 : 1;
  } catch {
    return 1;
  }
}

function speedLabel(mbps?: number | null): string | null {
  if (!mbps) return null;
  return mbps >= 1000 ? `${(mbps / 1000).toFixed(mbps % 1000 ? 1 : 0)} Gig` : `${mbps} Mbps`;
}

// Status chip + tone system. Every accent pairs a -600 light shade with a
// dark:-400 shade over a 10% tinted bg, so the chip clears AA in BOTH themes.
// `tone` is the bare text pairing (V2's stat strip), `band` feeds V3's hero
// gradient (≈8-10% tint fading to transparent).
type Badge = { text: string; short: string; cls: string; tone: string; band: string };
function statusBadge(p: CardProperty): Badge {
  const emerald = { tone: "text-emerald-600 dark:text-emerald-400", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/30", band: "from-emerald-500/10" };
  if (p.leadTag === "fresh_fiber_confirmed")
    return { text: "Confirmed fresh fiber", short: "Fresh fiber", ...emerald };
  if (p.isNewFiber && p.billingStatus === "N")
    return { text: "New-fiber lead", short: "New lead", ...emerald };
  if (p.isNewFiber)
    return { text: "New fiber here", short: "New fiber", tone: "text-teal-600 dark:text-teal-400", cls: "bg-teal-500/10 text-teal-600 dark:text-teal-400 ring-teal-500/30", band: "from-teal-500/10" };
  if (p.leadTag === "coming_soon")
    return { text: "Fiber coming soon", short: "Coming soon", tone: "text-amber-600 dark:text-amber-400", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-amber-500/30", band: "from-amber-500/10" };
  if (p.competitorName)
    return { text: `Competitor: ${p.competitorName}`, short: "Competitor", tone: "text-orange-600 dark:text-orange-400", cls: "bg-orange-500/10 text-orange-600 dark:text-orange-400 ring-orange-500/30", band: "from-orange-500/10" };
  if (p.fiberStatus === "copper" || p.fiberStatus === "no_service")
    return { text: "No fiber yet", short: "No fiber", tone: "text-foreground", cls: "bg-muted text-muted-foreground ring-border", band: "from-muted/40" };
  if (p.source === "tap")
    return { text: "Tapped location", short: "Tapped", tone: "text-sky-600 dark:text-sky-400", cls: "bg-sky-500/10 text-sky-600 dark:text-sky-400 ring-sky-500/30", band: "from-sky-500/10" };
  return { text: p.fiberStatus || "Unknown", short: p.fiberStatus || "Unknown", tone: "text-foreground", cls: "bg-muted text-muted-foreground ring-border", band: "from-muted/40" };
}

// Accent text tones — the same -600/dark:-400 pairing as the badge, so a value
// highlighted in the facts list stays readable on white and on ink.
const TONE = {
  emerald: "text-emerald-600 dark:text-emerald-400",
  sky: "text-sky-600 dark:text-sky-400",
  orange: "text-orange-600 dark:text-orange-400",
} as const;

// The labeled "Details" rows — only facts that are actually present.
function buildFacts(p: CardProperty): Array<{ label: string; value: string; tone?: string }> {
  const f: Array<{ label: string; value: string; tone?: string }> = [];
  const fiber = p.isNewFiber ? "New fiber available"
    : p.fiberStatus === "copper" ? "Copper only"
    : p.fiberStatus === "no_service" ? "No service"
    : p.fiberStatus ? p.fiberStatus.replace(/_/g, " ") : null;
  if (fiber) f.push({ label: "Fiber", value: fiber, tone: p.isNewFiber ? TONE.emerald : undefined });
  if (p.billingStatus) f.push({ label: "Occupancy", value: p.billingStatus === "N" ? "No current subscriber" : "Has service", tone: p.billingStatus === "N" ? TONE.emerald : undefined });
  const spd = speedLabel(p.maxDownloadMbps);
  if (spd) f.push({ label: "Max speed", value: spd, tone: TONE.sky });
  else if (p.speedTier) f.push({ label: "Plan", value: p.speedTier });
  if (p.techType) f.push({ label: "Technology", value: p.techType });
  if (p.placement) f.push({ label: "Placement", value: p.placement });
  if (p.competitorName) f.push({ label: "Competitor", value: p.competitorName, tone: TONE.orange });
  if (p.householdSegmentType) f.push({ label: "Segment", value: p.householdSegmentType });
  if (typeof p.leadScore === "number" && p.leadScore > 0) f.push({ label: "Lead score", value: String(p.leadScore), tone: TONE.emerald });
  if (p.freshConfidence === "cross_verified") f.push({ label: "Evidence", value: "Cross-verified", tone: TONE.emerald });
  else if (p.freshConfidence === "kinetic_new_fiber") f.push({ label: "Evidence", value: "Kinetic new fiber (billing N)", tone: TONE.emerald });
  return f;
}

// ── Shared building blocks (identical behavior across variants) ───────────────

function Grabber() {
  return <div className="mx-auto mb-4 h-1 w-9 rounded-full bg-border" aria-hidden="true" />;
}

// A manager's pre-assignment triage mark (priority / hold), shown so anyone
// looking at the lead knows it's been flagged before assignment.
function MarkChip({ mark }: { mark?: string | null }) {
  const meta = leadMarkMeta(mark);
  if (!meta) return null;
  return (
    <span
      className={`mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.chip}`}
      data-testid="lead-mark-chip"
      title={meta.description}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.ring }} />
      {meta.label}
    </span>
  );
}

function BadgePill({ p, badge, size = "sm" }: {
  p: CardProperty;
  badge: { text: string; cls: string };
  size?: "sm" | "md";
}) {
  const dims = size === "md" ? "px-3 py-1.5 text-[12px]" : "px-2.5 py-1 text-[11px]";
  const icon = size === "md" ? "w-3.5 h-3.5" : "w-3 h-3";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold uppercase tracking-wider ring-1 ${dims} ${badge.cls}`}>
      {p.isNewFiber ? <Zap className={icon} /> : <MapPin className={icon} />}
      {badge.text}
    </span>
  );
}

function FactsList({ facts, dense = true, label = "Details" }: {
  facts: Array<{ label: string; value: string; tone?: string }>;
  dense?: boolean;
  label?: string;
}) {
  if (facts.length === 0) return null;
  const rowPad = dense ? "px-3.5 py-2.5" : "px-4 py-3";
  const labelSize = dense ? "text-[13px]" : "text-[14px]";
  const valueSize = dense ? "text-[13px]" : "text-[14px]";
  return (
    <div className="mt-4">
      <div className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <dl className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-secondary/40">
        {facts.map((row, i) => (
          <div key={i} className={`flex items-center justify-between gap-4 ${rowPad}`}>
            <dt className={`${labelSize} shrink-0 text-muted-foreground`}>{row.label}</dt>
            <dd className={`${valueSize} text-right font-semibold tabular-nums ${row.tone ?? "text-foreground"}`}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// Primary action (Open lead / Add as lead). `className` tunes the emphasis per
// variant; the click behavior and testids never change. `withIcon:false` keeps
// the compact variant's 3-up row from overflowing at 320px.
function PrimaryAction({ p, canAdd, onAddLead, onOpen, className, withIcon = true }: {
  p: CardProperty;
  canAdd: boolean;
  onAddLead: (p: CardProperty) => void;
  onOpen?: (id: number) => void;
  className: string;
  withIcon?: boolean;
}) {
  if (p.id) {
    return (
      <button type="button" onClick={() => onOpen?.(p.id!)} data-testid="lead-card-open" className={className}>
        Open lead {withIcon && <ArrowUpRight className="h-4 w-4" />}
      </button>
    );
  }
  if (!canAdd) return null;
  return (
    <button type="button" onClick={() => onAddLead(p)} data-testid="lead-card-add" className={className}>
      {withIcon && <Plus className="h-4 w-4" />} Add as lead
    </button>
  );
}

function DirectionsLink({ mapsUrl, className }: { mapsUrl: string; className: string }) {
  return (
    <a href={mapsUrl} target="_blank" rel="noopener noreferrer" data-testid="lead-card-directions" className={className}>
      <Navigation className="h-4 w-4 text-sky-600 dark:text-sky-400" /> Directions
    </a>
  );
}

// Quiet bordered button base — Linear-style: 1px hairline, subtle hover fill.
const QUIET =
  "inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-secondary/40 font-medium text-foreground transition-colors hover:bg-secondary active:scale-[0.98]";

export function LeadCard({ property, onClose, onAddLead, onOpen, canAdd = true }: {
  property: CardProperty | null;
  onClose: () => void;
  onAddLead: (p: CardProperty) => void;
  onOpen?: (id: number) => void;
  canAdd?: boolean; // only roles that can create a lead (team_lead+) see "Add"
}) {
  const open = !!property;
  const p = property;
  const variant = readCardVariant();
  const badge: Badge = p ? statusBadge(p) : { text: "", short: "", cls: "", tone: "", band: "" };
  const full = p ? formatFullAddress(p) : "";
  const facts = p ? buildFacts(p) : [];
  const mapsUrl = p
    ? (p.lat != null && p.lng != null
        ? `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(full)}`)
    : "#";
  const cityLine = p
    ? [p.city, [p.state, p.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    : "";
  const hasPrimary = !!p && (!!p.id || canAdd);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side="bottom"
        // transition-none overrides the sheet base's bare `transition`
        // (= transition-all on a full-width surface — a paint/layout trap);
        // enter/exit stay on the base's GPU keyframes (slide+fade, 200ms in /
        // 150ms out). will-change keeps the slide on the compositor.
        className="max-h-[88vh] overflow-y-auto rounded-t-3xl border-border p-0 transition-none will-change-transform"
        data-testid="lead-card"
        data-variant={variant}
      >
        {p && variant === 1 && (
          /* ── V1 "Compact row-sheet" — tight single column; one inline row of
                 equal-width quiet actions, teal reserved for the primary. ── */
          <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <Grabber />
            <BadgePill p={p} badge={badge} />
            <h2 className="mt-2.5 text-[19px] font-bold leading-tight tracking-tight text-foreground">{p.address}</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">{cityLine}</p>
            <MarkChip mark={p.assignMark} />

            <LeadContacts ownerName={p.ownerName} address={p.address} phones={p.phones} className="mt-3" />
            <FactsList facts={facts} />

            <div className={`mt-4 grid gap-2 ${hasPrimary ? "grid-cols-3" : "grid-cols-2"}`}>
              <PrimaryAction
                p={p} canAdd={canAdd} onAddLead={onAddLead} onOpen={onOpen} withIcon={false}
                className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-primary/40 bg-primary/10 text-[13px] font-semibold text-primary transition-colors hover:bg-primary/15 active:scale-[0.98]"
              />
              <DirectionsLink mapsUrl={mapsUrl} className={`${QUIET} h-11 text-[13px]`} />
              <CopyAddressButton text={full} className="h-11 text-[13px]" />
            </div>
          </div>
        )}

        {p && variant === 2 && (
          /* ── V2 "Stat-strip" — header, then a 3-cell hairline-divided strip
                 (score · status · confidence), then stacked full-width actions. ── */
          <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <Grabber />
            <BadgePill p={p} badge={badge} />
            <h2 className="mt-3 text-[21px] font-bold leading-tight tracking-tight text-foreground">{p.address}</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">{cityLine}</p>
            <MarkChip mark={p.assignMark} />

            <div className="mt-4 grid grid-cols-3 divide-x divide-border overflow-hidden rounded-xl border border-border bg-secondary/40">
              {[
                {
                  label: "Score",
                  value: typeof p.leadScore === "number" && p.leadScore > 0 ? String(p.leadScore) : " - ",
                  tone: typeof p.leadScore === "number" && p.leadScore > 0 ? TONE.emerald : "text-muted-foreground",
                },
                {
                  label: "Status",
                  value: badge.short,
                  tone: badge.tone,
                },
                {
                  label: "Confidence",
                  value: p.freshConfidence === "cross_verified" ? "Verified"
                    : p.freshConfidence === "kinetic_new_fiber" ? "Kinetic"
                    : " - ",
                  tone: p.freshConfidence === "cross_verified" || p.freshConfidence === "kinetic_new_fiber"
                    ? TONE.emerald
                    : "text-muted-foreground",
                },
              ].map((cell) => (
                <div key={cell.label} className="px-2 py-2.5 text-center">
                  <div className={`truncate text-[14px] font-semibold tabular-nums ${cell.tone}`}>{cell.value}</div>
                  <div className="mt-0.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{cell.label}</div>
                </div>
              ))}
            </div>

            {/* Score + evidence live in the strip above — don't repeat them. */}
            <LeadContacts ownerName={p.ownerName} address={p.address} phones={p.phones} className="mt-3" />
            <FactsList facts={facts.filter((f) => f.label !== "Lead score" && f.label !== "Evidence")} />

            <div className="mt-4 flex flex-col gap-2">
              <PrimaryAction
                p={p} canAdd={canAdd} onAddLead={onAddLead} onOpen={onOpen}
                className="inline-flex h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-primary text-[15px] font-semibold text-primary-foreground transition hover:bg-primary/90 active:scale-[0.99]"
              />
              <DirectionsLink mapsUrl={mapsUrl} className={`${QUIET} h-11 w-full text-[13px]`} />
              <CopyAddressButton text={full} className="h-11 w-full text-[13px]" />
            </div>
          </div>
        )}

        {p && variant === 3 && (
          /* ── V3 "Hero-accent" — status-tinted band behind the address, a
                 floating action row, larger tap targets for gloved field use. ── */
          <div className="pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <div className={`bg-gradient-to-b ${badge.band} to-transparent px-5 pb-2 pt-5`}>
              <Grabber />
              <BadgePill p={p} badge={badge} size="md" />
              <h2 className="mt-3 text-[24px] font-bold leading-tight tracking-tight text-foreground">{p.address}</h2>
              <p className="mt-1 text-[14px] text-muted-foreground">{cityLine}</p>
            </div>

            <div className="px-5">
              {/* Floating action card — lifted off the band with a soft shadow.
                  Full-width primary + a 2-up secondary row: big gloved-thumb
                  targets that can't overflow at 320px. */}
              <div className="mt-2 space-y-2 rounded-2xl border border-border bg-card p-2 shadow-lg shadow-black/10 dark:shadow-black/30">
                <PrimaryAction
                  p={p} canAdd={canAdd} onAddLead={onAddLead} onOpen={onOpen}
                  className="inline-flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary text-[16px] font-semibold text-primary-foreground transition hover:bg-primary/90 active:scale-[0.98]"
                />
                <div className="grid grid-cols-2 gap-2">
                  <DirectionsLink mapsUrl={mapsUrl} className={`${QUIET} h-12 text-[14px]`} />
                  <CopyAddressButton text={full} className="h-12 text-[14px]" />
                </div>
              </div>

              <LeadContacts ownerName={p.ownerName} address={p.address} phones={p.phones} className="mt-3" />
              <FactsList facts={facts} dense={false} />
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
