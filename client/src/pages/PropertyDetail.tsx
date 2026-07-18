// ── Property Detail — the deep rep view of one door ───────────────────────────
// Open a property → see everything that matters instantly (fiber, competitor,
// score, contact), the full knock timeline with location verification, and act:
// Navigate · open the separate gated Calling workspace · Log. Wired to
// GET /api/leads/:id and /api/leads/:id/history — real data, real states.
//
// The top summary card ships in three visual variants — selectable with a
// `cardVariant` URL param (1|2|3, default 1; read from the hash query
// `#/lead/7?cardVariant=2` or the plain search string):
//   1 "Ledger"        flat card, pills row, segmented equal-width action row
//   2 "Split-panel"   address left · hairline-divided quick stats right (≥sm)
//   3 "Status-banded" 3px status-colored left border + tinted header band
// Same data and same actions in all three — the variants are presentation only.
//
// Layout note: the "Log outcome" CTA is sticky-in-flow at the page bottom (NOT
// position:fixed) — it reserves its own height, so it can never sit on top of
// page content, and it pins to the scrollport bottom which already sits above
// the mobile tab bar (Layout's <main> reserves that space).
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRoute, useLocation } from "wouter";
import { apiRequest, apiUpload } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useKnockLogger } from "@/lib/useKnockLogger";
import { OutcomeSheet, type SheetLead } from "@/components/OutcomeSheet";
import { OUTCOME_META, STATE_COLORS, STATE_LABELS, pinDisplayState, type KnockOutcome } from "@shared/knock";
import { Skeleton } from "@/components/ui/skeleton";
import { useCan } from "@/lib/capabilities";
import {
  ChevronLeft, Navigation, Phone, Zap, Wifi, Building2, User as UserIcon,
  Mail, ShieldCheck, AlertTriangle, ShieldX, StickyNote, UserPlus, RefreshCw, MapPin,
  WifiOff, CloudUpload, Camera,
} from "lucide-react";

interface Lead {
  id: number; address: string; city: string; state?: string | null; zip?: string | null;
  lat?: number | null; lng?: number | null; leadStatus: string; assignedRepId?: number | null;
  fiberStatus?: string | null; isNewFiber?: boolean | null; householdSegmentType?: string | null;
  speedTier?: string | null; maxDownloadMbps?: number | null; techType?: string | null;
  competitorName?: string | null; competitorSpeedMbps?: number | null; inCompetitorArea?: boolean | null;
  leadTag?: string | null; leadScore?: number | null;
  contactName?: string | null; contactEmail?: string | null;
  visited?: boolean | null; lastOutcome?: string | null;
}
interface HistoryRow {
  id: string; type: "status_change" | "assignment" | "note"; actor?: string | null; changedAt: string;
  status?: string; verification?: string | null; distanceM?: number | null;
  assignedTo?: string; assignedBy?: string; notePreview?: string;
}

const FIBER_LABEL: Record<string, string> = {
  new_fiber: "New fiber available", tenured_fiber: "Tenured fiber", existing_fiber: "Fiber available",
  copper: "Copper / DSL", no_service: "No service", unknown: "Unknown",
};
// Compact vocabulary for pills / quick stats (unknown intentionally absent —
// an unknown status renders in the Fiber section, not as a headline pill).
const FIBER_SHORT: Record<string, string> = {
  new_fiber: "New fiber", tenured_fiber: "Tenured fiber", existing_fiber: "Fiber",
  copper: "Copper / DSL", no_service: "No service",
};
// Pill tint per fiber state. Token-based (primary teal / neutral / destructive
// rose) so both themes stay readable — no dark-only accent text.
const FIBER_PILL_TONE: Record<string, string> = {
  new_fiber: "border-primary/30 bg-primary/10 text-primary",
  tenured_fiber: "border-primary/30 bg-primary/10 text-primary",
  existing_fiber: "border-primary/30 bg-primary/10 text-primary",
  copper: "border-border bg-secondary text-secondary-foreground",
  no_service: "border-rose-500/25 bg-rose-500/10 text-rose-500",
};

const fmtTime = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
// Prefer exact coords; fall back to the postal address so Navigate never opens a
// broken "destination=null,null" link when a lead has no lat/lng.
const directionsUrl = (l: Lead) => {
  const dest = l.lat != null && l.lng != null
    ? `${l.lat},${l.lng}`
    : encodeURIComponent([l.address, l.city, l.state, l.zip].filter(Boolean).join(", "));
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
};
const cityLine = (l: Lead) => `${l.city}${l.state ? `, ${l.state}` : ""}${l.zip ? ` ${l.zip}` : ""}`;

// The app routes on the URL hash, so a query can live either inside the hash
// (`#/lead/7?cardVariant=2` — what a pasted link produces) or in the real
// search string (`?cardVariant=2#/lead/7`). Accept both; anything else → the
// chosen default: V2 "Split-panel" (owner-selected from the three variants).
type CardVariant = 1 | 2 | 3;
function readCardVariant(): CardVariant {
  try {
    const hashQuery = window.location.hash.split("?")[1] ?? "";
    const raw = new URLSearchParams(hashQuery).get("cardVariant")
      ?? new URLSearchParams(window.location.search).get("cardVariant");
    return raw === "1" ? 1 : raw === "3" ? 3 : 2;
  } catch { return 2; }
}

function VerifyBadge({ v }: { v?: string | null }) {
  // Icon carries the tone (works on light + dark); the text stays tokenized.
  if (v === "verified") return <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><ShieldCheck className="h-3 w-3 text-emerald-500" aria-hidden="true" />Verified</span>;
  if (v === "needs_review") return <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><AlertTriangle className="h-3 w-3 text-amber-500" aria-hidden="true" />Needs review</span>;
  if (v === "invalid") return <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><ShieldX className="h-3 w-3 text-rose-500" aria-hidden="true" />Unverified</span>;
  return null;
}

export default function PropertyDetail() {
  const [, params] = useRoute("/lead/:id");
  const [, navigate] = useLocation();
  // parseInt (not Number): with hash routing a `?cardVariant=` query rides
  // inside the matched segment, and Number("7?cardVariant=2") would be NaN.
  const id = Number.parseInt(params?.id ?? "", 10);
  const { log, snap } = useKnockLogger();
  const canOpenCalling = useCan("calling.lead.read");
  const [sheetOpen, setSheetOpen] = useState(false);
  const variant = readCardVariant();

  const leadQ = useQuery<Lead>({
    queryKey: [`/api/leads/${id}`], queryFn: () => apiRequest("GET", `/api/leads/${id}`).then(r => r.json()),
    enabled: Number.isFinite(id),
  });
  const histQ = useQuery<HistoryRow[]>({
    queryKey: [`/api/leads/${id}/history`], queryFn: () => apiRequest("GET", `/api/leads/${id}/history`).then(r => r.json()),
    enabled: Number.isFinite(id),
  });
  const lead = leadQ.data;
  const back = () => { if (window.history.length > 1) window.history.back(); else navigate("/today"); };

  const sheetLead: SheetLead | null = lead
    ? { id: lead.id, address: lead.address, city: lead.city, zip: lead.zip, contactName: lead.contactName, leadStatus: lead.leadStatus, visited: lead.visited, lastOutcome: lead.lastOutcome }
    : null;
  const openLog = () => setSheetOpen(true);

  return (
    <div className="flex min-h-full flex-col bg-background">
      {/* Sticky top bar */}
      <div className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex h-12 max-w-lg items-center gap-1 px-2">
          <button onClick={back} aria-label="Back" data-testid="detail-back" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-foreground transition-all duration-150 hover:bg-secondary active:scale-95"><ChevronLeft className="h-5 w-5" aria-hidden="true" /></button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold tracking-tight text-foreground">{lead?.address ?? "Property"}</div>
            {lead && <div className="truncate text-[11px] text-muted-foreground">{cityLine(lead)}</div>}
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-lg flex-1 px-4 pb-6 pt-4">
        {leadQ.isLoading ? (
          <div className="space-y-4" role="status" aria-label="Loading property">
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-44 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        ) : leadQ.isError || !lead ? (
          <div className="rounded-xl border border-border bg-card p-6 text-center" data-testid="detail-error">
            <div className="text-[14px] font-semibold text-foreground">Couldn't open this property</div>
            <div className="mt-1 text-[13px] text-muted-foreground">It may not be assigned to you, or you're offline.</div>
            <button onClick={() => leadQ.refetch()} className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-secondary px-4 text-[13px] font-semibold text-foreground transition-colors hover:border-muted-foreground/40 hover:bg-accent"><RefreshCw className="h-4 w-4" aria-hidden="true" />Retry</button>
          </div>
        ) : (
          <>
            {/* Summary card — one of three visual variants, same data + actions */}
            {variant === 2 ? <SummarySplit lead={lead} canOpenCalling={canOpenCalling} onLog={openLog} />
              : variant === 3 ? <SummaryBanded lead={lead} canOpenCalling={canOpenCalling} onLog={openLog} />
              : <SummaryLedger lead={lead} canOpenCalling={canOpenCalling} onLog={openLog} />}

            {/* Fiber details */}
            <SectionLabel>Fiber</SectionLabel>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              <FactRow icon={Zap} tone="text-primary" label="Status" value={FIBER_LABEL[lead.fiberStatus ?? "unknown"] ?? lead.fiberStatus ?? "Unknown"} />
              {(lead.maxDownloadMbps || lead.speedTier) && <FactRow icon={Wifi} label="Speed" value={lead.maxDownloadMbps ? `${lead.maxDownloadMbps} Mbps${lead.techType ? ` · ${lead.techType}` : ""}` : (lead.speedTier ?? "—")} />}
              {lead.competitorName && <FactRow icon={Building2} label="Current provider" value={`${lead.competitorName}${lead.competitorSpeedMbps ? ` · ${lead.competitorSpeedMbps} Mbps` : ""}`} />}
              {lead.householdSegmentType && <FactRow icon={UserIcon} label="Segment" value={lead.householdSegmentType} />}
            </div>

            {/* Contact — only when the lead actually has contact data */}
            {(lead.contactName || lead.contactEmail) && (
              <>
                <SectionLabel>Contact</SectionLabel>
                <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                  {lead.contactName && <FactRow icon={UserIcon} label="Name" value={lead.contactName} />}
                  {lead.contactEmail && <FactRow icon={Mail} label="Email" value={lead.contactEmail} />}
                </div>
              </>
            )}

            {/* Photos — field evidence on this door */}
            <PhotoStrip leadId={lead.id} online={snap.online} />

            {/* Timeline */}
            <SectionLabel>Activity</SectionLabel>
            {histQ.isLoading ? (
              <div className="space-y-3 rounded-xl border border-border bg-card p-4"><Skeleton className="h-5 w-3/4" /><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /></div>
            ) : !histQ.data?.length ? (
              <div className="rounded-xl border border-border bg-card p-6 text-center text-[13px] text-muted-foreground" data-testid="detail-history-empty">No knocks yet — you'll be the first at this door.</div>
            ) : (
              <div className="rounded-xl border border-border bg-card p-4">
                <ol className="relative">
                  {histQ.data.map((h, i) => <TimelineRow key={h.id} h={h} last={i === histQ.data!.length - 1} />)}
                </ol>
              </div>
            )}
          </>
        )}
      </div>

      {/* Sticky-in-flow primary CTA — reserves its own height, pins to the
          scrollport bottom, and can never overlap the content above it. */}
      {lead && (
        <div className="sticky bottom-0 z-10 mt-auto border-t border-border bg-background/90 backdrop-blur-md">
          <div className="mx-auto w-full max-w-lg px-4 py-3">
            <SaveState state={snap.byLead[lead.id]} online={snap.online} />
            <button onClick={openLog} data-testid="detail-log-cta" className="h-12 w-full rounded-xl bg-primary text-[14px] font-semibold text-primary-foreground transition-all duration-150 hover:bg-primary/90 active:scale-[.99]">Log outcome</button>
          </div>
        </div>
      )}

      <OutcomeSheet
        lead={sheetOpen ? sheetLead : null}
        onClose={() => setSheetOpen(false)}
        onLog={(outcome, opts) => {
          if (lead) log({ id: lead.id, leadStatus: lead.leadStatus, assignedRepId: lead.assignedRepId }, outcome, opts);
          setSheetOpen(false);
        }}
      />
    </div>
  );
}

// ── Summary card building blocks ─────────────────────────────────────────────
interface SummaryProps { lead: Lead; canOpenCalling: boolean; onLog: () => void }

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</h2>;
}

// Status + fiber (+ score, + hot) pills. Tints come from the canonical status
// palette at low alpha with tokenized text, so both themes stay readable.
function PillsRow({ lead, showScore = true }: { lead: Lead; showScore?: boolean }) {
  const ds = pinDisplayState(lead);
  const color = STATE_COLORS[ds];
  const fiberShort = lead.fiberStatus ? FIBER_SHORT[lead.fiberStatus] : undefined;
  const pill = "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[10.5px] font-semibold uppercase tracking-wider";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span data-testid="detail-status-pill" className={`${pill} text-foreground`} style={{ backgroundColor: `${color}1F`, borderColor: `${color}52` }}>
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
        {STATE_LABELS[ds]}
      </span>
      {fiberShort && (
        <span className={`${pill} ${FIBER_PILL_TONE[lead.fiberStatus!]}`}>
          <Zap className="h-3 w-3" aria-hidden="true" />{fiberShort}
        </span>
      )}
      {showScore && lead.leadScore != null && (
        <span className={`${pill} border-border bg-secondary tabular-nums text-secondary-foreground`}>Score {lead.leadScore}</span>
      )}
      {lead.leadTag === "hot_lead" && (
        <span className={`${pill} border-rose-500/25 bg-rose-500/10 font-bold text-rose-500`}>Hot</span>
      )}
    </div>
  );
}

// Shared "Calling is gated" cell — same footprint as the live link.
function ProtectedCell({ className }: { className: string }) {
  return (
    <div className={`${className} cursor-not-allowed text-muted-foreground`} title="Requires calling access" aria-disabled="true">
      <Phone className="h-4 w-4" aria-hidden="true" />Protected
    </div>
  );
}

// V1 "Ledger" — flat card, pills row, one bordered equal-width action row.
function SummaryLedger({ lead, canOpenCalling, onLog }: SummaryProps) {
  const cell = "flex h-10 items-center justify-center gap-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
  return (
    <section className="rounded-xl border border-border bg-card p-4" data-testid="detail-summary" data-variant="1">
      <PillsRow lead={lead} />
      <h1 className="mt-2.5 text-[17px] font-semibold leading-snug tracking-tight text-foreground">{lead.address}</h1>
      <div className="mt-0.5 text-[13px] text-muted-foreground">{cityLine(lead)}</div>
      <div className="mt-4 grid grid-cols-3 divide-x divide-border overflow-hidden rounded-lg border border-border">
        <a href={directionsUrl(lead)} target="_blank" rel="noreferrer" data-testid="detail-navigate" className={`${cell} text-foreground hover:bg-secondary active:bg-secondary`}>
          <Navigation className="h-4 w-4 text-muted-foreground" aria-hidden="true" />Navigate
        </a>
        {canOpenCalling
          ? <Link href={`/calling/lead/${lead.id}`} data-testid="detail-open-calling" className={`${cell} text-foreground hover:bg-secondary active:bg-secondary`}><Phone className="h-4 w-4 text-muted-foreground" aria-hidden="true" />Calling</Link>
          : <ProtectedCell className={cell} />}
        <button type="button" onClick={onLog} data-testid="detail-log" className={`${cell} font-semibold text-primary hover:bg-primary/10 active:bg-primary/10`}>
          <StickyNote className="h-4 w-4" aria-hidden="true" />Log
        </button>
      </div>
    </section>
  );
}

// V2 "Split-panel" — address left, hairline-divided quick stats right on ≥sm
// (stacked on mobile), actions row under a hairline.
function SummarySplit({ lead, canOpenCalling, onLog }: SummaryProps) {
  const stats: Array<{ label: string; value: string }> = [];
  if (lead.leadScore != null) stats.push({ label: "Score", value: `${lead.leadScore}/100` });
  const fiberShort = lead.fiberStatus ? FIBER_SHORT[lead.fiberStatus] : undefined;
  if (fiberShort) stats.push({ label: "Fiber", value: fiberShort });
  if (lead.maxDownloadMbps) stats.push({ label: "Speed", value: `${lead.maxDownloadMbps} Mbps` });
  else if (lead.speedTier) stats.push({ label: "Speed", value: lead.speedTier });

  const btn = "flex h-10 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors";
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card" data-testid="detail-summary" data-variant="2">
      <div className="sm:flex sm:items-stretch">
        <div className="min-w-0 flex-1 p-4">
          <PillsRow lead={lead} showScore={false} />
          <h1 className="mt-2.5 text-[17px] font-semibold leading-snug tracking-tight text-foreground">{lead.address}</h1>
          <div className="mt-0.5 text-[13px] text-muted-foreground">{cityLine(lead)}</div>
        </div>
        {stats.length > 0 && (
          <div className="flex divide-x divide-border border-t border-border sm:min-w-[8.5rem] sm:flex-col sm:divide-x-0 sm:divide-y sm:border-l sm:border-t-0">
            {stats.map(s => (
              <div key={s.label} className="min-w-0 flex-1 px-4 py-2.5 sm:flex sm:flex-1 sm:flex-col sm:justify-center sm:py-3">
                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{s.label}</div>
                <div className="truncate text-[14px] font-semibold tabular-nums text-foreground" title={s.value}>{s.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2 border-t border-border p-3">
        <a href={directionsUrl(lead)} target="_blank" rel="noreferrer" data-testid="detail-navigate" className={`${btn} border border-border bg-secondary/50 text-foreground hover:bg-secondary`}>
          <Navigation className="h-4 w-4 text-primary" aria-hidden="true" />Navigate
        </a>
        {canOpenCalling
          ? <Link href={`/calling/lead/${lead.id}`} data-testid="detail-open-calling" className={`${btn} border border-border bg-secondary/50 text-foreground hover:bg-secondary`}><Phone className="h-4 w-4 text-primary" aria-hidden="true" />Calling</Link>
          : <ProtectedCell className={`${btn} border border-border bg-secondary/30`} />}
        <button type="button" onClick={onLog} data-testid="detail-log" className={`${btn} bg-primary font-semibold text-primary-foreground hover:bg-primary/90`}>
          <StickyNote className="h-4 w-4" aria-hidden="true" />Log
        </button>
      </div>
    </section>
  );
}

// V3 "Status-banded" — 3px status-colored left border, softly tinted header
// band, compact actions bottom-right.
function SummaryBanded({ lead, canOpenCalling, onLog }: SummaryProps) {
  const color = STATE_COLORS[pinDisplayState(lead)];
  const btn = "flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors";
  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-card"
      style={{ borderLeftWidth: 3, borderLeftColor: color }}
      data-testid="detail-summary" data-variant="3"
    >
      <div className="p-4" style={{ backgroundColor: `${color}14` }}>
        <PillsRow lead={lead} />
        <h1 className="mt-2.5 text-[17px] font-semibold leading-snug tracking-tight text-foreground">{lead.address}</h1>
        <div className="mt-0.5 text-[13px] text-muted-foreground">{cityLine(lead)}</div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-3">
        <a href={directionsUrl(lead)} target="_blank" rel="noreferrer" data-testid="detail-navigate" className={`${btn} border border-border text-foreground hover:bg-secondary`}>
          <Navigation className="h-4 w-4 text-muted-foreground" aria-hidden="true" />Navigate
        </a>
        {canOpenCalling
          ? <Link href={`/calling/lead/${lead.id}`} data-testid="detail-open-calling" className={`${btn} border border-border text-foreground hover:bg-secondary`}><Phone className="h-4 w-4 text-muted-foreground" aria-hidden="true" />Calling</Link>
          : <ProtectedCell className={`${btn} border border-border`} />}
        <button type="button" onClick={onLog} data-testid="detail-log" className={`${btn} bg-primary px-3.5 font-semibold text-primary-foreground hover:bg-primary/90`}>
          <StickyNote className="h-4 w-4" aria-hidden="true" />Log
        </button>
      </div>
    </section>
  );
}

// ── Photos — field evidence on this door ──────────────────────────────────────
// Auth is header-based (x-session-id), which a plain <img src> can't carry, so
// AuthedImg fetches the file as a blob through the authed endpoint and renders
// an object URL. Capture uses the native camera sheet (input capture) — zero
// typing. Uploads need a connection; offline the tile disables with a hint.
interface LeadPhotoRow { id: number; createdAt: string; takenBy: string | null }

function AuthedImg({ photoId, alt, className, onClick }: { photoId: number; alt: string; className?: string; onClick?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    let alive = true;
    apiRequest("GET", `/api/photos/${photoId}/file`)
      .then(r => r.blob())
      .then(b => { if (!alive) return; objectUrl = URL.createObjectURL(b); setUrl(objectUrl); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [photoId]);
  if (failed) return <div className={`${className} bg-secondary flex items-center justify-center`}><AlertTriangle className="w-4 h-4 text-muted-foreground" aria-hidden="true" /></div>;
  if (!url) return <Skeleton className={className} />;
  return <img src={url} alt={alt} className={className} onClick={onClick} loading="lazy" />;
}

function PhotoStrip({ leadId, online }: { leadId: number; online: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);

  const photosQ = useQuery<LeadPhotoRow[]>({
    queryKey: [`/api/leads/${leadId}/photos`],
    queryFn: () => apiRequest("GET", `/api/leads/${leadId}/photos`).then(r => r.json()),
  });
  const photos = photosQ.data ?? [];

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("photo", file);
      // Shared multipart helper: session + CSRF headers, API_BASE prefix, and
      // 401 → global re-auth — same guarantees as every other mutation.
      await apiUpload(`/api/leads/${leadId}/photos`, fd);
      qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}/photos`] });
      toast({ title: "Photo added" });
    } catch (e: any) {
      toast({ title: "Couldn't upload the photo", description: String(e?.message ?? e).slice(0, 120), variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div>
      <SectionLabel>Photos</SectionLabel>
      <div className="-m-1 flex gap-2 overflow-x-auto p-1" data-testid="photo-strip">
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden"
          aria-label="Take or choose a photo"
          onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={!online || uploading}
          data-testid="photo-add"
          className="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-card text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground active:scale-95 disabled:opacity-50 disabled:hover:border-border disabled:hover:text-muted-foreground"
        >
          {uploading ? <RefreshCw className="h-5 w-5 animate-spin text-primary" aria-hidden="true" /> : <Camera className="h-5 w-5" aria-hidden="true" />}
          <span className="text-[10px] font-semibold">{uploading ? "Uploading…" : online ? "Add" : "Offline"}</span>
        </button>
        {photos.map(p => (
          <button key={p.id} onClick={() => setViewer(p.id)}
            aria-label={`View door photo${p.takenBy ? ` by ${p.takenBy}` : ""}`}
            className="shrink-0 rounded-lg transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <AuthedImg photoId={p.id} alt={`Door photo${p.takenBy ? ` by ${p.takenBy}` : ""}`}
              className="h-20 w-20 rounded-lg border border-border object-cover" />
          </button>
        ))}
        {!photosQ.isLoading && photos.length === 0 && (
          <div className="flex items-center pl-1 text-[12px] text-muted-foreground">No photos yet — snap the house, equipment, or paperwork.</div>
        )}
      </div>

      {/* Full-screen viewer — Escape/tap to close, close button auto-focused */}
      {viewer != null && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Photo viewer" onClick={() => setViewer(null)}>
          <AuthedImg photoId={viewer} alt="Door photo (full size)" className="max-w-full max-h-full rounded-xl object-contain" />
          <button
            autoFocus onClick={() => setViewer(null)}
            onKeyDown={e => { if (e.key === "Escape") setViewer(null); }}
            aria-label="Close photo"
            className="absolute top-[max(1rem,env(safe-area-inset-top))] right-4 w-11 h-11 rounded-full bg-black/50 text-white text-2xl leading-none flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

// Per-lead knock save state — confirms a tap actually landed (or is queued
// offline / failed) instead of leaving the rep guessing after they log.
function SaveState({ state, online }: { state?: string; online: boolean }) {
  if (!state || state === "idle" || state === "saved") return null;
  const map: Record<string, { icon: any; text: string; cls: string; spin?: boolean }> = {
    saving: { icon: RefreshCw, text: "Saving…", cls: "bg-primary/10 border-primary/25 text-primary", spin: true },
    queued: online
      ? { icon: CloudUpload, text: "Queued — syncing", cls: "bg-primary/10 border-primary/25 text-primary" }
      : { icon: WifiOff, text: "Saved offline — will sync", cls: "bg-muted border-border text-muted-foreground" },
    error: { icon: AlertTriangle, text: "Didn't save — will retry", cls: "bg-rose-500/10 border-rose-500/30 text-rose-500" },
  };
  const m = map[state]; if (!m) return null;
  const Icon = m.icon;
  return (
    <div className={`mb-2 flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-semibold ${m.cls}`} data-testid="detail-save-state" role="status">
      <Icon className={`h-3.5 w-3.5 ${m.spin ? "animate-spin" : ""}`} aria-hidden="true" />{m.text}
    </div>
  );
}

// Ledger-style key/value row: quiet label left, value right, hairline-divided
// by the parent. Icons stay muted (the fiber row alone carries the teal).
function FactRow({ icon: Icon, label, value, tone }: { icon: any; label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5">
      <Icon className={`h-3.5 w-3.5 shrink-0 ${tone ?? "text-muted-foreground"}`} aria-hidden="true" />
      <span className="shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-[13px] font-medium tabular-nums text-foreground" title={value}>{value}</span>
    </div>
  );
}

function TimelineRow({ h, last }: { h: HistoryRow; last: boolean }) {
  const meta = h.type === "status_change" ? OUTCOME_META[(h.status ?? "") as KnockOutcome] : null;
  const color = meta?.color ?? "#64748b";
  const Icon = h.type === "assignment" ? UserPlus : h.type === "note" ? StickyNote : null;
  return (
    <li className="relative pl-6 pb-4 last:pb-0">
      {!last && <span aria-hidden="true" className="absolute left-[5px] top-4 bottom-0 w-px bg-border" />}
      <span aria-hidden="true" className="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full ring-2 ring-card" style={{ background: color }} />
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-foreground inline-flex items-center gap-1.5">
          {Icon && <Icon className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />}
          {h.type === "status_change" ? (meta?.label ?? h.status) : h.type === "assignment" ? `Assigned to ${h.assignedTo ?? "a rep"}` : "Note"}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{fmtTime(h.changedAt)}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-2">
        {h.actor && <span className="text-[12px] text-muted-foreground">{h.actor}</span>}
        {h.type === "status_change" && <VerifyBadge v={h.verification} />}
        {h.distanceM != null && <span className="inline-flex items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground"><MapPin className="w-3 h-3" aria-hidden="true" />{Math.round(h.distanceM)}m from door</span>}
      </div>
      {h.type === "note" && h.notePreview && <div className="mt-1 border-l-2 border-border pl-2 text-[13px] italic text-muted-foreground">"{h.notePreview}"</div>}
    </li>
  );
}
