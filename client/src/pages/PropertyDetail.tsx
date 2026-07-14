// ── Property Detail — the deep rep view of one door ───────────────────────────
// Open a property → see everything that matters instantly (fiber, competitor,
// score, contact), the full knock timeline with location verification, and act:
// Navigate · open the separate gated Calling workspace · Log. Wired to
// GET /api/leads/:id and /api/leads/:id/history — real data, real states.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRoute, useLocation } from "wouter";
import { apiRequest, apiUpload } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useKnockLogger } from "@/lib/useKnockLogger";
import { OutcomeSheet, type SheetLead } from "@/components/OutcomeSheet";
import { OUTCOME_META, STATE_COLORS, pinDisplayState, type KnockOutcome } from "@shared/knock";
import { Skeleton } from "@/components/ui/skeleton";
import { useCan } from "@/lib/capabilities";
import {
  ChevronLeft, Navigation, Phone, Zap, Wifi, Building2, Trophy, User as UserIcon,
  ShieldCheck, AlertTriangle, ShieldX, StickyNote, UserPlus, RefreshCw, MapPin,
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
const fmtTime = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
// Prefer exact coords; fall back to the postal address so Navigate never opens a
// broken "destination=null,null" link when a lead has no lat/lng.
const directionsUrl = (l: Lead) => {
  const dest = l.lat != null && l.lng != null
    ? `${l.lat},${l.lng}`
    : encodeURIComponent([l.address, l.city, l.state, l.zip].filter(Boolean).join(", "));
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
};

function VerifyBadge({ v }: { v?: string | null }) {
  if (v === "verified") return <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-emerald-400"><ShieldCheck className="w-3 h-3" />Verified</span>;
  if (v === "needs_review") return <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-amber-400"><AlertTriangle className="w-3 h-3" />Needs review</span>;
  if (v === "invalid") return <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-rose-400"><ShieldX className="w-3 h-3" />Unverified</span>;
  return null;
}

export default function PropertyDetail() {
  const [, params] = useRoute("/lead/:id");
  const [, navigate] = useLocation();
  const id = Number(params?.id);
  const { log, snap } = useKnockLogger();
  const canOpenCalling = useCan("calling.lead.read");
  const [sheetOpen, setSheetOpen] = useState(false);

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

  return (
    <div className="min-h-full bg-background pb-28">
      {/* Sticky top bar */}
      <div className="sticky top-0 z-20 bg-background/90 backdrop-blur-md border-b border-border">
        <div className="mx-auto max-w-lg px-2 h-14 flex items-center gap-1">
          <button onClick={back} aria-label="Back" data-testid="detail-back" className="w-11 h-11 flex items-center justify-center text-foreground active:scale-90 transition-transform"><ChevronLeft className="w-6 h-6" /></button>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-bold text-foreground truncate">{lead?.address ?? "Property"}</div>
            {lead && <div className="text-[11px] text-muted-foreground truncate">{lead.city}{lead.state ? `, ${lead.state}` : ""}{lead.zip ? ` ${lead.zip}` : ""}</div>}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-lg px-4 pt-4">
        {leadQ.isLoading ? (
          <><Skeleton className="h-24 w-full rounded-2xl" /><Skeleton className="h-12 w-full rounded-xl mt-3" /><Skeleton className="h-40 w-full rounded-2xl mt-3" /></>
        ) : leadQ.isError || !lead ? (
          <div className="rounded-2xl border border-border bg-card p-6 text-center" data-testid="detail-error">
            <div className="text-[14px] font-semibold text-foreground">Couldn't open this property</div>
            <div className="text-[13px] text-muted-foreground mt-1">It may not be assigned to you, or you're offline.</div>
            <button onClick={() => leadQ.refetch()} className="mt-4 inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-secondary border border-border text-[14px] font-semibold text-foreground"><RefreshCw className="w-4 h-4" />Retry</button>
          </div>
        ) : (
          <>
            {/* Identity + status */}
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: STATE_COLORS[pinDisplayState(lead)] }} />
                <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{lead.leadStatus.replace(/_/g, " ")}</span>
                {lead.leadTag === "hot_lead" && <span className="ml-auto text-[10.5px] font-bold text-rose-400 bg-rose-500/15 rounded-full px-2 py-0.5">HOT</span>}
              </div>
              <div className="text-[22px] font-bold text-foreground leading-tight mt-1.5">{lead.address}</div>
              <div className="text-[13px] text-muted-foreground">{lead.city}{lead.state ? `, ${lead.state}` : ""}{lead.zip ? ` ${lead.zip}` : ""}</div>

              {/* Quick actions */}
              <div className="grid grid-cols-3 gap-2 mt-4">
                <a href={directionsUrl(lead)} target="_blank" rel="noreferrer" data-testid="detail-navigate" className="h-11 rounded-xl bg-secondary border border-border flex items-center justify-center gap-1.5 text-[13px] font-semibold text-foreground active:scale-95 transition-transform"><Navigation className="w-4 h-4 text-primary" />Navigate</a>
                {canOpenCalling
                  ? <Link href={`/calling/lead/${lead.id}`} data-testid="detail-open-calling" className="h-11 rounded-xl bg-secondary border border-border flex items-center justify-center gap-1.5 text-[13px] font-semibold text-foreground active:scale-95 transition-transform"><Phone className="w-4 h-4 text-primary" />Calling</Link>
                  : <div className="h-11 rounded-xl bg-secondary/50 border border-border flex items-center justify-center gap-1.5 text-[13px] font-semibold text-muted-foreground opacity-60"><Phone className="w-4 h-4" />Protected</div>}
                <button onClick={() => setSheetOpen(true)} data-testid="detail-log" className="h-11 rounded-xl bg-primary text-primary-foreground flex items-center justify-center gap-1.5 text-[13px] font-semibold active:scale-95 transition-transform"><StickyNote className="w-4 h-4" />Log</button>
              </div>
            </div>

            {/* Essentials */}
            <div className="mt-4 rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
              <Fact icon={Zap} tone="text-primary" label="Fiber status" value={FIBER_LABEL[lead.fiberStatus ?? "unknown"] ?? lead.fiberStatus ?? "—"} />
              {(lead.maxDownloadMbps || lead.speedTier) && <Fact icon={Wifi} tone="text-sky-400" label="Speed" value={lead.maxDownloadMbps ? `${lead.maxDownloadMbps} Mbps${lead.techType ? ` · ${lead.techType}` : ""}` : (lead.speedTier ?? "—")} />}
              {lead.competitorName && <Fact icon={Building2} tone="text-amber-400" label="Current provider" value={`${lead.competitorName}${lead.competitorSpeedMbps ? ` · ${lead.competitorSpeedMbps} Mbps` : ""}`} />}
              {lead.householdSegmentType && <Fact icon={UserIcon} tone="text-violet-400" label="Segment" value={lead.householdSegmentType} />}
              {lead.leadScore != null && <Fact icon={Trophy} tone="text-emerald-400" label="Lead score" value={`${lead.leadScore}/100`} />}
              {lead.contactName && <Fact icon={UserIcon} tone="text-muted-foreground" label="Contact name" value={lead.contactName} />}
            </div>

            {/* Photos — field evidence on this door */}
            <PhotoStrip leadId={lead.id} online={snap.online} />

            {/* Timeline */}
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mt-5 mb-2">Activity</h2>
            {histQ.isLoading ? (
              <div className="rounded-2xl border border-border bg-card p-4 space-y-3"><Skeleton className="h-5 w-3/4" /><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /></div>
            ) : !histQ.data?.length ? (
              <div className="rounded-2xl border border-border bg-card p-6 text-center text-[13px] text-muted-foreground" data-testid="detail-history-empty">No knocks yet — you'll be the first at this door.</div>
            ) : (
              <div className="rounded-2xl border border-border bg-card p-4">
                <ol className="relative">
                  {histQ.data.map((h, i) => <TimelineRow key={h.id} h={h} last={i === histQ.data!.length - 1} />)}
                </ol>
              </div>
            )}
          </>
        )}
      </div>

      {/* Sticky primary CTA */}
      {lead && (
        <div className="fixed inset-x-0 bottom-14 z-20 md:bottom-0 pointer-events-none">
          <div className="mx-auto max-w-lg px-4 pb-2" style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}>
            <SaveState state={snap.byLead[lead.id]} online={snap.online} />
            <button onClick={() => setSheetOpen(true)} data-testid="detail-log-cta" className="pointer-events-auto w-full h-13 py-3.5 rounded-2xl bg-primary text-primary-foreground font-bold text-[15px] shadow-lg shadow-black/30 active:scale-[.98] transition-transform">Log outcome</button>
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
  if (failed) return <div className={`${className} bg-secondary flex items-center justify-center`}><AlertTriangle className="w-4 h-4 text-muted-foreground" /></div>;
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
    <div className="mt-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Photos</h2>
      <div className="flex gap-2 overflow-x-auto pb-1" data-testid="photo-strip">
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden"
          aria-label="Take or choose a photo"
          onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={!online || uploading}
          data-testid="photo-add"
          className="shrink-0 w-20 h-20 rounded-xl border border-dashed border-border bg-card flex flex-col items-center justify-center gap-1 text-muted-foreground active:scale-95 transition-transform disabled:opacity-50"
        >
          {uploading ? <RefreshCw className="w-5 h-5 animate-spin text-primary" /> : <Camera className="w-5 h-5" />}
          <span className="text-[10px] font-semibold">{uploading ? "Uploading…" : online ? "Add" : "Offline"}</span>
        </button>
        {photos.map(p => (
          <button key={p.id} onClick={() => setViewer(p.id)}
            aria-label={`View door photo${p.takenBy ? ` by ${p.takenBy}` : ""}`}
            className="shrink-0 rounded-xl active:scale-95 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <AuthedImg photoId={p.id} alt={`Door photo${p.takenBy ? ` by ${p.takenBy}` : ""}`}
              className="w-20 h-20 rounded-xl object-cover border border-border" />
          </button>
        ))}
        {!photosQ.isLoading && photos.length === 0 && (
          <div className="flex items-center text-[12px] text-muted-foreground pl-1">No photos yet — snap the house, equipment, or paperwork.</div>
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
    error: { icon: AlertTriangle, text: "Didn't save — will retry", cls: "bg-rose-500/10 border-rose-500/30 text-rose-400" },
  };
  const m = map[state]; if (!m) return null;
  const Icon = m.icon;
  return (
    <div className={`pointer-events-auto mb-2 flex items-center justify-center gap-1.5 rounded-xl border px-3 py-1.5 text-[12px] font-semibold ${m.cls}`} data-testid="detail-save-state" role="status">
      <Icon className={`w-3.5 h-3.5 ${m.spin ? "animate-spin" : ""}`} />{m.text}
    </div>
  );
}

function Fact({ icon: Icon, tone, label, value }: { icon: any; tone: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0"><Icon className={`w-4 h-4 ${tone}`} /></span>
      <div className="min-w-0">
        <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-[14px] font-medium text-foreground truncate">{value}</div>
      </div>
    </div>
  );
}

function TimelineRow({ h, last }: { h: HistoryRow; last: boolean }) {
  const meta = h.type === "status_change" ? OUTCOME_META[(h.status ?? "") as KnockOutcome] : null;
  const color = meta?.color ?? "#64748b";
  const Icon = h.type === "assignment" ? UserPlus : h.type === "note" ? StickyNote : null;
  return (
    <li className="relative pl-6 pb-4 last:pb-0">
      {!last && <span className="absolute left-[5px] top-4 bottom-0 w-px bg-border" />}
      <span className="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full ring-2 ring-card" style={{ background: color }} />
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13.5px] font-semibold text-foreground inline-flex items-center gap-1.5">
          {Icon && <Icon className="w-3.5 h-3.5 text-muted-foreground" />}
          {h.type === "status_change" ? (meta?.label ?? h.status) : h.type === "assignment" ? `Assigned to ${h.assignedTo ?? "a rep"}` : "Note"}
        </span>
        <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">{fmtTime(h.changedAt)}</span>
      </div>
      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
        {h.actor && <span className="text-[12px] text-muted-foreground">{h.actor}</span>}
        {h.type === "status_change" && <VerifyBadge v={h.verification} />}
        {h.distanceM != null && <span className="text-[11px] text-muted-foreground inline-flex items-center gap-0.5"><MapPin className="w-3 h-3" />{Math.round(h.distanceM)}m from door</span>}
      </div>
      {h.type === "note" && h.notePreview && <div className="text-[13px] text-muted-foreground mt-1 italic">"{h.notePreview}"</div>}
    </li>
  );
}
