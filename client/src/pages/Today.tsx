// ── Today — the rep's home ────────────────────────────────────────────────────
// The missing rep-first entry point: open the app and instantly know the next
// door and WHY, log an outcome in ≤2 taps, and advance — one thumb, sunlight-
// readable, offline-safe. 100% real data: /api/leads/map pins, /api/leaderboard
// (today's doors/sales), /api/clock/status, and the SAME offline knock queue +
// GPS-evidence pipeline the field map uses (nothing is faked).
import { useState, useMemo, useEffect, useCallback, useSyncExternalStore } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { getKnockQueue, type KnockQueue, type QueueSnapshot } from "@/lib/knockQueue";
import { captureFieldFix } from "@/lib/geoFix";
import {
  OUTCOMES, OUTCOME_TO_STATUS, pinDisplayState, STATE_COLORS, STATE_LABELS,
  nearestUnworkedLead, distanceHint, haversineMeters, type KnockOutcome, type RoutablePin,
} from "@shared/knock";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Navigation, Clock, WifiOff, RefreshCw, ChevronRight, MapPin as MapPinIcon,
  Zap, Flame, Repeat, DollarSign, Trophy, X, StickyNote, CheckCircle2, Sun,
} from "lucide-react";

// ── Real data shapes (subset of /api/leads/map pins we use) ──────────────────
interface Pin extends RoutablePin {
  address: string; city: string; state?: string | null; zip?: string | null;
  leadTag?: string | null; fiberStatus?: string | null; isNewFiber?: boolean | null;
  competitorName?: string | null; inCompetitorArea?: boolean | null;
  contactName?: string | null; assignedRepId?: number | null; lastKnockedAt?: string | null;
  knockCount?: number | null;
}
interface LeaderRow { rep: { id: number; name: string; role: string }; knocks: number; sales: number; knocksToday: number; salesToday: number }
interface LatLng { lat: number; lng: number }

const EMPTY_SNAP: QueueSnapshot = { pendingCount: 0, deadCount: 0, byLead: {}, online: true };
const GRID = OUTCOMES.filter(o => o.key !== "needs_verification"); // 7 one-tap outcomes

// Why is this door worth a knock? Ranked reasons from real lead fields.
function reasons(p: Pin): { label: string; icon: any; tone: string }[] {
  const out: { label: string; icon: any; tone: string }[] = [];
  if (p.isNewFiber || p.fiberStatus === "new_fiber") out.push({ label: "New fiber", icon: Zap, tone: "text-primary" });
  if (p.leadTag === "hot_lead") out.push({ label: "Hot lead", icon: Flame, tone: "text-rose-400" });
  if (p.lastOutcome === "callback" || (p.leadStatus === "follow_up")) out.push({ label: "Callback due", icon: Repeat, tone: "text-cyan-400" });
  if (p.competitorName && p.inCompetitorArea) out.push({ label: `Switch from ${p.competitorName}`, icon: MapPinIcon, tone: "text-amber-400" });
  if (!out.length && (p.leadScore ?? 0) >= 80) out.push({ label: "High-priority", icon: Trophy, tone: "text-violet-400" });
  return out.slice(0, 2);
}

function directionsUrl(p: Pin) { return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`; }

export default function Today() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const isRep = user?.role === "rep";
  const firstName = user?.name?.split(" ")[0] ?? "there";

  // ── Location: capture once (never rejects; denied → null, we fall back to score) ──
  const [myLoc, setMyLoc] = useState<LatLng | null>(null);
  const [locState, setLocState] = useState<"pending" | "on" | "off">("pending");
  useEffect(() => {
    let alive = true;
    captureFieldFix().then(fix => {
      if (!alive) return;
      if (fix.repLat != null && fix.repLng != null) { setMyLoc({ lat: fix.repLat, lng: fix.repLng }); setLocState("on"); }
      else setLocState("off");
    });
    return () => { alive = false; };
  }, []);

  // ── Real queries ──
  const pinsQ = useQuery<{ pins: Pin[]; total: number }>({
    queryKey: ["/api/leads/map"],
    queryFn: () => apiRequest("GET", "/api/leads/map").then(r => r.json()),
    staleTime: 20_000,
  });
  const boardQ = useQuery<LeaderRow[]>({
    queryKey: ["/api/leaderboard"],
    queryFn: () => apiRequest("GET", "/api/leaderboard").then(r => r.json()),
    staleTime: 20_000,
  });
  const clockQ = useQuery<{ clockedIn: boolean; session: any }>({
    queryKey: ["/api/clock/status"],
    queryFn: () => apiRequest("GET", "/api/clock/status").then(r => r.json()),
    staleTime: 10_000,
  });
  const clockIn = useMutation({
    mutationFn: () => apiRequest("POST", "/api/clock/in", {}).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/clock/status"] }); toast({ title: "Clocked in — have a great shift" }); },
    onError: (e: any) => toast({ title: "Couldn't clock in", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const myRow = useMemo(() => (boardQ.data ?? []).find(r => r.rep.id === user?.teamMemberId) ?? null, [boardQ.data, user?.teamMemberId]);
  const pins = pinsQ.data?.pins ?? [];

  // ── Offline queue — the SAME singleton the map uses; drives the sync chip ──
  const queue: KnockQueue | null = useMemo(() => {
    if (!user?.teamMemberId) return null;
    return getKnockQueue({
      repId: user.teamMemberId,
      post: (url, body) => apiRequest("POST", url, body).then(r => r.json()),
      patch: (url, body) => apiRequest("PATCH", url, body).then(r => r.json()),
      onSaved: (leadId) => {
        qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
        qc.invalidateQueries({ queryKey: ["/api/leads"] });
        qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}/history`] });
      },
    });
  }, [user?.teamMemberId, qc]);
  const snap = useSyncExternalStore(
    useCallback(cb => queue ? queue.subscribe(cb) : () => {}, [queue]),
    useCallback(() => queue ? queue.getSnapshot() : EMPTY_SNAP, [queue]),
  );

  // ── Route math — nearest unworked/not-home first (or score when GPS is off) ──
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const route = useMemo(() => {
    const isOpen = (p: Pin) => { const s = pinDisplayState(p); return (s === "unworked" || s === "not_home") && !skip.has(p.id); };
    const open = pins.filter(isOpen);
    let ordered: Pin[];
    if (myLoc) ordered = open.map(p => ({ p, d: haversineMeters(myLoc, p) })).sort((a, b) => a.d - b.d).map(x => x.p);
    else ordered = [...open].sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0));
    const hero = myLoc ? (nearestUnworkedLead(myLoc, open as RoutablePin[], skip) as Pin | null) ?? ordered[0] ?? null : ordered[0] ?? null;
    const rest = ordered.filter(p => p.id !== hero?.id).slice(0, 6);
    const openCount = pins.filter(p => { const s = pinDisplayState(p); return s === "unworked" || s === "not_home"; }).length;
    return { hero, rest, openCount };
  }, [pins, myLoc, skip]);

  // ── One-tap log — optimistic recolor, then offline-safe enqueue with GPS evidence ──
  const [sheetLead, setSheetLead] = useState<Pin | null>(null);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const openSheet = (p: Pin) => { setSheetLead(p); setNote(""); setNoteOpen(false); };

  const log = useCallback((lead: Pin, outcome: KnockOutcome, notes: string | null) => {
    if (!queue) return;
    const credit = isRep ? user?.teamMemberId : (lead.assignedRepId ?? user?.teamMemberId);
    if (!credit) { toast({ title: "This lead has no rep assigned", variant: "destructive" }); return; }
    const at = new Date().toISOString();
    // Optimistic recolor — the map cache is shared, so the pin updates everywhere at once.
    qc.setQueryData(["/api/leads/map"], (old: any) => old?.pins
      ? { ...old, pins: old.pins.map((p: Pin) => p.id === lead.id
          ? { ...p, leadStatus: OUTCOME_TO_STATUS[outcome] ?? p.leadStatus, visited: true, knockCount: (p.knockCount ?? 0) + 1, lastOutcome: outcome, lastKnockedAt: at }
          : p) }
      : old);
    captureFieldFix().then(fix => queue.enqueue({ leadId: lead.id, repId: credit, outcome, notes: notes || null, callbackDate: null, callbackTime: null, ...fix }));
    setSkip(s => new Set(s).add(lead.id)); // advance the queue past this door
    setSheetLead(null);
    if (outcome === "sold") toast({ title: "Sold 🎉 — commission logged", description: "Pending review on your Commission tab" });
    else toast({ title: `Logged: ${STATE_LABELS[pinDisplayState({ leadStatus: OUTCOME_TO_STATUS[outcome], visited: true, lastOutcome: outcome })] ?? outcome}` });
  }, [queue, isRep, user?.teamMemberId, qc, toast]);

  const loading = pinsQ.isLoading || boardQ.isLoading;
  const offline = snap.online === false;

  // ── Render ──
  return (
    <div className="min-h-full bg-background pb-24">
      <div className="mx-auto w-full max-w-lg px-4 pt-5">

        {/* Header */}
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Sun className="w-4 h-4 text-amber-400" />
              {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            </div>
            <h1 className="text-[26px] font-bold tracking-tight text-foreground mt-0.5" data-testid="today-greeting">
              {new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Good afternoon" : "Good evening"}, {firstName}
            </h1>
          </div>
          {clockQ.data && (
            clockQ.data.clockedIn
              ? <span className="shrink-0 mt-1 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 px-2.5 py-1 text-[11px] font-semibold"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />On the clock</span>
              : null
          )}
        </header>

        {/* Sync / offline banner — honest state, always */}
        {(offline || snap.pendingCount > 0 || snap.deadCount > 0) && (
          <div className={`mt-3 flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-[13px] ${offline ? "bg-muted border-border text-muted-foreground" : "bg-primary/10 border-primary/20 text-foreground"}`} data-testid="today-sync">
            {offline ? <WifiOff className="w-4 h-4 shrink-0" /> : <RefreshCw className="w-4 h-4 shrink-0 text-primary animate-spin" />}
            <span className="flex-1">
              {offline ? "Offline — your taps are saved" : `Syncing ${snap.pendingCount} knock${snap.pendingCount === 1 ? "" : "s"}`}
              {snap.deadCount > 0 && <span className="text-rose-400"> · {snap.deadCount} failed</span>}
            </span>
            {snap.deadCount > 0 && <button onClick={() => queue?.retryDead()} className="shrink-0 text-primary font-semibold text-[12px]">Retry</button>}
          </div>
        )}

        {/* Clocked-out nudge */}
        {clockQ.data && !clockQ.data.clockedIn && (
          <button
            onClick={() => clockIn.mutate()} disabled={clockIn.isPending}
            data-testid="today-clock-in"
            className="mt-3 w-full flex items-center gap-3 rounded-xl bg-card border border-border px-4 py-3 text-left active:scale-[.99] transition-transform disabled:opacity-60"
          >
            <span className="w-9 h-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center shrink-0"><Clock className="w-5 h-5" /></span>
            <span className="flex-1"><span className="block text-[14px] font-semibold text-foreground">Clock in to start</span><span className="block text-[12px] text-muted-foreground">Your hours count toward payroll</span></span>
            {clockIn.isPending ? <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          </button>
        )}

        {/* Today strip — real counts */}
        <div className="mt-4 grid grid-cols-3 rounded-xl border border-border bg-card overflow-hidden">
          <Stat label="Doors today" value={loading ? null : (myRow?.knocksToday ?? 0)} tone="text-foreground" />
          <Stat label="Sales today" value={loading ? null : (myRow?.salesToday ?? 0)} tone="text-emerald-400" border />
          <Stat label="Doors left" value={loading ? null : route.openCount} tone="text-primary" border />
        </div>

        {/* ── Next best door — the hero ── */}
        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Your next door</h2>
            {locState === "off" && <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><MapPinIcon className="w-3 h-3" />Location off · by priority</span>}
          </div>

          {loading ? (
            <div className="rounded-2xl border border-border bg-card p-5"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-4 w-1/3 mt-2" /><Skeleton className="h-11 w-full mt-4" /></div>
          ) : pinsQ.isError ? (
            <ErrorCard onRetry={() => pinsQ.refetch()} />
          ) : !pins.length ? (
            <EmptyCard title="No doors assigned yet" body="Ask your team lead for a territory, then your route shows up here." cta={{ to: "/map", label: "Open field map" }} />
          ) : !route.hero ? (
            <AllDoneCard sales={myRow?.salesToday ?? 0} />
          ) : (
            <HeroCard p={route.hero} loc={myLoc} onLog={() => openSheet(route.hero!)} onSkip={() => setSkip(s => new Set(s).add(route.hero!.id))} />
          )}
        </div>

        {/* ── Up next ── */}
        {!loading && route.rest.length > 0 && (
          <div className="mt-5">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Up next · {route.openCount} doors on your route</h2>
            <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
              {route.rest.map(p => <DoorRow key={p.id} p={p} loc={myLoc} onOpen={() => openSheet(p)} />)}
            </div>
          </div>
        )}

        {/* ── Pay peek — real sale counts, link to authoritative $ ── */}
        {myRow && (
          <Link href="/my-commission" className="mt-5 flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 active:scale-[.99] transition-transform" data-testid="today-pay">
            <span className="w-9 h-9 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0"><DollarSign className="w-5 h-5" /></span>
            <span className="flex-1">
              <span className="block text-[14px] font-semibold text-foreground tabular-nums">{myRow.sales} sale{myRow.sales === 1 ? "" : "s"} · {myRow.salesToday} today</span>
              <span className="block text-[12px] text-muted-foreground">View your weekly pay statement</span>
            </span>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </Link>
        )}
      </div>

      {/* ── Outcome sheet — one/two-tap logging ── */}
      <Sheet open={!!sheetLead} onOpenChange={o => { if (!o) setSheetLead(null); }}>
        <SheetContent side="bottom" className="rounded-t-2xl border-border bg-card p-0 max-h-[88dvh]" data-testid="outcome-sheet">
          {sheetLead && (
            <div className="flex flex-col">
              <div className="flex items-start gap-3 px-5 pt-5 pb-3 border-b border-border">
                <span className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0" style={{ background: STATE_COLORS[pinDisplayState(sheetLead)] }} />
                <div className="flex-1 min-w-0">
                  <div className="text-[16px] font-bold text-foreground leading-tight">{sheetLead.address}</div>
                  <div className="text-[12px] text-muted-foreground">{sheetLead.city}{sheetLead.zip ? ` ${sheetLead.zip}` : ""}{sheetLead.contactName ? ` · ${sheetLead.contactName}` : ""}</div>
                </div>
                <button onClick={() => setSheetLead(null)} aria-label="Close" className="w-9 h-9 -mr-2 -mt-1 flex items-center justify-center text-muted-foreground"><X className="w-5 h-5" /></button>
              </div>

              <div className="px-5 pt-4 pb-2 grid grid-cols-2 gap-2.5">
                {GRID.map(o => {
                  const win = o.key === "sold";
                  return (
                    <button
                      key={o.key}
                      onClick={() => log(sheetLead, o.key, note.trim())}
                      data-testid={`outcome-${o.key}`}
                      className="h-14 rounded-xl font-semibold text-[14px] flex items-center justify-center gap-2 active:scale-95 transition-transform border"
                      style={win
                        ? { background: o.color, color: "#04120d", borderColor: o.color }
                        : { background: `${o.color}1f`, color: o.color, borderColor: `${o.color}55` }}
                    >
                      {win && <CheckCircle2 className="w-4 h-4" />}{o.label}
                    </button>
                  );
                })}
              </div>

              {/* Optional note — minimal typing, only if they want it */}
              <div className="px-5 pt-2 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                {noteOpen ? (
                  <textarea
                    autoFocus value={note} onChange={e => setNote(e.target.value)} rows={2}
                    placeholder="Quick note (optional)…" data-testid="outcome-note"
                    className="w-full rounded-xl bg-background border border-border px-3 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground resize-none focus:border-primary focus:outline-none"
                  />
                ) : (
                  <button onClick={() => setNoteOpen(true)} className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground font-medium">
                    <StickyNote className="w-4 h-4" /> Add a note
                  </button>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────
function Stat({ label, value, tone, border }: { label: string; value: number | null; tone: string; border?: boolean }) {
  return (
    <div className={`px-3 py-3 ${border ? "border-l border-border" : ""}`}>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {value == null ? <Skeleton className="h-7 w-10 mt-1.5" /> : <div className={`text-[24px] font-bold tabular-nums leading-none mt-1.5 ${tone}`}>{value}</div>}
    </div>
  );
}

function ReasonChips({ p }: { p: Pin }) {
  const rs = reasons(p);
  if (!rs.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {rs.map((r, i) => { const Icon = r.icon; return (
        <span key={i} className="inline-flex items-center gap-1 rounded-full bg-secondary border border-border px-2 py-0.5 text-[11px] font-medium text-foreground">
          <Icon className={`w-3 h-3 ${r.tone}`} />{r.label}
        </span>
      ); })}
    </div>
  );
}

function HeroCard({ p, loc, onLog, onSkip }: { p: Pin; loc: LatLng | null; onLog: () => void; onSkip: () => void }) {
  const st = pinDisplayState(p);
  const dist = loc ? distanceHint(haversineMeters(loc, p)) : null;
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm" data-testid="today-hero">
      <div className="flex items-start gap-3">
        <span className="w-3 h-3 rounded-full mt-1.5 shrink-0" style={{ background: STATE_COLORS[st], boxShadow: `0 0 0 4px ${STATE_COLORS[st]}22` }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: STATE_COLORS[st] }}>{STATE_LABELS[st]}</span>
            {dist && <span className="text-[11px] text-muted-foreground inline-flex items-center gap-0.5"><Navigation className="w-3 h-3" />{dist} away</span>}
          </div>
          <div className="text-[20px] font-bold text-foreground leading-tight mt-0.5">{p.address}</div>
          <div className="text-[13px] text-muted-foreground">{p.city}{p.state ? `, ${p.state}` : ""}{p.zip ? ` ${p.zip}` : ""}</div>
          <ReasonChips p={p} />
        </div>
      </div>
      <div className="flex gap-2.5 mt-4">
        <button onClick={onLog} data-testid="hero-log" className="flex-1 h-12 rounded-xl bg-primary text-primary-foreground font-semibold text-[15px] active:scale-95 transition-transform">Log outcome</button>
        <a href={directionsUrl(p)} target="_blank" rel="noreferrer" aria-label="Navigate" className="w-12 h-12 rounded-xl bg-secondary border border-border flex items-center justify-center active:scale-95 transition-transform"><Navigation className="w-5 h-5 text-foreground" /></a>
        <button onClick={onSkip} aria-label="Skip" className="w-12 h-12 rounded-xl bg-secondary border border-border flex items-center justify-center text-muted-foreground active:scale-95 transition-transform"><ChevronRight className="w-5 h-5" /></button>
      </div>
    </div>
  );
}

function DoorRow({ p, loc, onOpen }: { p: Pin; loc: LatLng | null; onOpen: () => void }) {
  const st = pinDisplayState(p);
  const dist = loc ? distanceHint(haversineMeters(loc, p)) : null;
  const rs = reasons(p);
  return (
    <button onClick={onOpen} data-testid={`door-${p.id}`} className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-secondary/60 transition-colors">
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: STATE_COLORS[st] }} />
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold text-foreground truncate">{p.address}</div>
        <div className="text-[12px] text-muted-foreground truncate">{p.city}{dist ? ` · ${dist}` : ""}{rs[0] ? ` · ${rs[0].label}` : ""}</div>
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
    </button>
  );
}

function ErrorCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 text-center" data-testid="today-error">
      <div className="text-[14px] font-semibold text-foreground">Couldn't load your route</div>
      <div className="text-[13px] text-muted-foreground mt-1">Check your connection and try again — nothing you've logged is lost.</div>
      <button onClick={onRetry} className="mt-4 inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-secondary border border-border text-[14px] font-semibold text-foreground"><RefreshCw className="w-4 h-4" />Retry</button>
    </div>
  );
}

function EmptyCard({ title, body, cta }: { title: string; body: string; cta: { to: string; label: string } }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 text-center" data-testid="today-empty">
      <div className="w-11 h-11 rounded-xl bg-secondary flex items-center justify-center mx-auto"><MapPinIcon className="w-5 h-5 text-muted-foreground" /></div>
      <div className="text-[15px] font-semibold text-foreground mt-3">{title}</div>
      <div className="text-[13px] text-muted-foreground mt-1 max-w-xs mx-auto">{body}</div>
      <Link href={cta.to} className="mt-4 inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-primary text-primary-foreground text-[14px] font-semibold">{cta.label}</Link>
    </div>
  );
}

function AllDoneCard({ sales }: { sales: number }) {
  return (
    <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-6 text-center" data-testid="today-alldone">
      <div className="w-11 h-11 rounded-xl bg-emerald-500/15 flex items-center justify-center mx-auto"><Trophy className="w-5 h-5 text-emerald-400" /></div>
      <div className="text-[15px] font-semibold text-foreground mt-3">Every door worked — nice shift</div>
      <div className="text-[13px] text-muted-foreground mt-1">{sales > 0 ? `${sales} sale${sales === 1 ? "" : "s"} logged today.` : "Your route's clear."} New leads land here as they're assigned.</div>
      <Link href="/leaderboard" className="mt-4 inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-secondary border border-border text-[14px] font-semibold text-foreground"><Trophy className="w-4 h-4" />See the leaderboard</Link>
    </div>
  );
}
