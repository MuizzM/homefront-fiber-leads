// ── Today — the rep's home ────────────────────────────────────────────────────
// Open the app and instantly know the next door and WHY, log an outcome in ≤2
// taps, and advance — one thumb, sunlight-readable, offline-safe. 100% real data:
// /api/leads/map pins, /api/leaderboard (today's doors/sales), /api/clock/status,
// and the SHARED offline logger (useKnockLogger → knockQueue + GPS evidence).
import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { captureFieldFix } from "@/lib/geoFix";
import { useKnockLogger } from "@/lib/useKnockLogger";
import { OutcomeSheet } from "@/components/OutcomeSheet";
import {
  pinDisplayState, STATE_COLORS, STATE_LABELS,
  nearestUnworkedLead, distanceHint, haversineMeters, todayISO, type RoutablePin,
} from "@shared/knock";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Navigation, Clock, WifiOff, RefreshCw, ChevronRight, MapPin as MapPinIcon,
  Zap, Flame, Repeat, DollarSign, Trophy, Sun, CalendarClock, SkipForward,
} from "lucide-react";

// Visible keyboard focus for outdoor + accessibility — one ring, teal, everywhere.
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background";

interface Pin extends RoutablePin {
  address: string; city: string; state?: string | null; zip?: string | null;
  leadTag?: string | null; fiberStatus?: string | null; isNewFiber?: boolean | null;
  competitorName?: string | null; inCompetitorArea?: boolean | null;
  contactName?: string | null; assignedRepId?: number | null; lastKnockedAt?: string | null; knockCount?: number | null;
}
interface LeaderRow { rep: { id: number; name: string; role: string }; knocks: number; sales: number; knocksToday: number; salesToday: number }
interface LatLng { lat: number; lng: number }

function reasons(p: Pin): { label: string; icon: any; tone: string }[] {
  const out: { label: string; icon: any; tone: string }[] = [];
  if (p.isNewFiber || p.fiberStatus === "new_fiber") out.push({ label: "New fiber", icon: Zap, tone: "text-primary" });
  if (p.leadTag === "hot_lead") out.push({ label: "Hot lead", icon: Flame, tone: "text-red-500" });
  if (p.lastOutcome === "callback" || p.leadStatus === "follow_up") out.push({ label: "Callback due", icon: Repeat, tone: "text-sky-400" });
  if (p.competitorName && p.inCompetitorArea) out.push({ label: `Switch from ${p.competitorName}`, icon: MapPinIcon, tone: "text-amber-500" });
  if (!out.length && (p.leadScore ?? 0) >= 80) out.push({ label: "High-priority", icon: Trophy, tone: "text-amber-500" });
  return out.slice(0, 2);
}
const directionsUrl = (p: Pin) => {
  const dest = p.lat != null && p.lng != null
    ? `${p.lat},${p.lng}`
    : encodeURIComponent([p.address, p.city, p.state, p.zip].filter(Boolean).join(", "));
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
};

export default function Today() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const firstName = user?.name?.split(" ")[0] ?? "there";
  const { log, snap } = useKnockLogger();

  // One clock read per render — the date line and the greeting must never
  // disagree across a midnight/noon boundary (three separate new Date() calls
  // could straddle one). Recomputes each render, which is all Today needs.
  const now = new Date();
  const dateLabel = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  // Location: capture once (never rejects; denied → null → priority order).
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

  const pinsQ = useQuery<{ pins: Pin[]; total: number }>({
    queryKey: ["/api/leads/map"], queryFn: () => apiRequest("GET", "/api/leads/map").then(r => r.json()), staleTime: 20_000,
  });
  const boardQ = useQuery<LeaderRow[]>({
    queryKey: ["/api/leaderboard"], queryFn: () => apiRequest("GET", "/api/leaderboard").then(r => r.json()), staleTime: 20_000,
  });
  const clockQ = useQuery<{ clockedIn: boolean; session: any }>({
    queryKey: ["/api/clock/status"], queryFn: () => apiRequest("GET", "/api/clock/status").then(r => r.json()), staleTime: 10_000,
  });
  // Follow-ups due — callbacks scheduled for today or earlier (still owed).
  const followupsQ = useQuery<Array<{ callbackDate: string }>>({
    queryKey: ["/api/followups"], queryFn: () => apiRequest("GET", "/api/followups").then(r => r.json()), staleTime: 30_000,
  });
  const clockIn = useMutation({
    mutationFn: () => apiRequest("POST", "/api/clock/in", {}).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/clock/status"] }); toast({ title: "Clocked in — have a great shift" }); },
    onError: (e: any) => toast({ title: "Couldn't clock in", description: String(e?.message ?? e), variant: "destructive" }),
  });
  // Clock-OUT lives here too so end-of-shift is one tap from the rep's home
  // (there is no clock tab). Tap-to-confirm guards against an accidental tap.
  const [confirmOut, setConfirmOut] = useState(false);
  const clockOut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/clock/out", {}).then(r => r.json()),
    onSuccess: (s: any) => {
      qc.invalidateQueries({ queryKey: ["/api/clock/status"] });
      const m = s?.durationMinutes;
      toast({ title: "Clocked out — shift saved", description: typeof m === "number" ? `${Math.floor(m / 60)}h ${m % 60}m logged` : undefined });
      setConfirmOut(false);
    },
    onError: (e: any) => { setConfirmOut(false); toast({ title: "Couldn't clock out", description: String(e?.message ?? e), variant: "destructive" }); },
  });

  const myRow = useMemo(() => (boardQ.data ?? []).find(r => r.rep.id === user?.teamMemberId) ?? null, [boardQ.data, user?.teamMemberId]);
  const pins = pinsQ.data?.pins ?? [];

  const [skip, setSkip] = useState<Set<number>>(new Set());
  const route = useMemo(() => {
    const isOpen = (p: Pin) => { const s = pinDisplayState(p); return (s === "unworked" || s === "not_home") && !skip.has(p.id); };
    const open = pins.filter(isOpen);
    const ordered = myLoc
      ? open.map(p => ({ p, d: haversineMeters(myLoc, p) })).sort((a, b) => a.d - b.d).map(x => x.p)
      : [...open].sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0));
    const hero = myLoc ? (nearestUnworkedLead(myLoc, open as RoutablePin[], skip) as Pin | null) ?? ordered[0] ?? null : ordered[0] ?? null;
    const rest = ordered.filter(p => p.id !== hero?.id).slice(0, 6);
    const openCount = pins.filter(p => { const s = pinDisplayState(p); return s === "unworked" || s === "not_home"; }).length;
    return { hero, rest, openCount };
  }, [pins, myLoc, skip]);

  const [sheetLead, setSheetLead] = useState<Pin | null>(null);
  // Follow-ups included in the gate so the banner doesn't pop in above the hero
  // after first paint (it would shift "Log outcome" as the rep taps).
  const loading = pinsQ.isLoading || boardQ.isLoading || followupsQ.isLoading;
  const offline = snap.online === false;

  // Callbacks due today or earlier (still owed) — the top of the follow-up loop.
  // LOCAL date (via shared todayISO) so this badge can't disagree with the
  // Follow-ups page or over-count in the evening the way a UTC date would.
  const todayStr = todayISO();
  const followupsDue = (followupsQ.data ?? []).filter(f => f.callbackDate <= todayStr).length;

  // Today's progress — an honest read of two real numbers already on screen:
  // doors worked today vs doors still open. Mirrors a delivery driver's route bar.
  const doorsDone = myRow?.knocksToday ?? 0;
  const doorsLeft = route.openCount;
  const routeTotal = doorsDone + doorsLeft;
  const routePct = routeTotal > 0 ? Math.round((doorsDone / routeTotal) * 100) : 0;

  return (
    <div className="min-h-full bg-background pb-24">
      <div className="mx-auto w-full max-w-lg px-4 pt-5">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Sun className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" />
              {dateLabel}
            </div>
            <h1 className="text-[27px] font-bold tracking-tight text-foreground mt-1 leading-tight" data-testid="today-greeting">
              {greeting}, {firstName}
            </h1>
          </div>
          {clockQ.data?.clockedIn && (
            <button
              onClick={() => { if (confirmOut) clockOut.mutate(); else { setConfirmOut(true); setTimeout(() => setConfirmOut(false), 3000); } }}
              disabled={clockOut.isPending}
              data-testid="today-clock-out"
              aria-label={confirmOut ? "Tap again to clock out" : "On the clock — tap to clock out"}
              className={`shrink-0 mt-1 inline-flex items-center gap-1.5 rounded-full border min-h-11 px-3.5 text-[12px] font-semibold active:scale-95 transition disabled:opacity-60 ${FOCUS} ${confirmOut ? "bg-red-500/15 text-red-500 border-red-500/30" : "bg-emerald-500/15 text-emerald-400 border-emerald-500/25"}`}
            >
              {clockOut.isPending
                ? <><RefreshCw className="w-3 h-3 animate-spin" aria-hidden="true" />Clocking out…</>
                : confirmOut
                  ? <><Clock className="w-3 h-3" aria-hidden="true" />Tap to clock out</>
                  : <><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />On the clock</>}
            </button>
          )}
        </header>

        {(offline || snap.pendingCount > 0 || snap.deadCount > 0) && (
          <div className={`mt-3 flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-[13px] ${offline ? "bg-muted border-border text-muted-foreground" : "bg-primary/10 border-primary/20 text-foreground"}`} data-testid="today-sync">
            {offline ? <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" /> : <RefreshCw className="w-4 h-4 shrink-0 text-primary animate-spin" aria-hidden="true" />}
            <span className="flex-1">
              {offline ? "Offline — your taps are saved" : `Syncing ${snap.pendingCount} knock${snap.pendingCount === 1 ? "" : "s"}`}
              {snap.deadCount > 0 && <span className="text-red-500"> · {snap.deadCount} failed</span>}
            </span>
          </div>
        )}

        {/* Reserve the clock-in card's slot while its status loads, so the card
            doesn't pop in above the hero and shift the tap targets. */}
        {clockQ.isLoading && <Skeleton className="mt-3 h-[62px] w-full rounded-xl" />}
        {clockQ.data && !clockQ.data.clockedIn && (
          <button onClick={() => clockIn.mutate()} disabled={clockIn.isPending} data-testid="today-clock-in"
            className={`mt-3 w-full flex items-center gap-3 rounded-xl bg-card border border-border px-4 py-3 text-left active:scale-[.99] transition-transform disabled:opacity-60 hover:border-primary/30 ${FOCUS}`}>
            <span className="w-9 h-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center shrink-0"><Clock className="w-5 h-5" aria-hidden="true" /></span>
            <span className="flex-1"><span className="block text-[14px] font-semibold text-foreground">Clock in to start</span><span className="block text-[12px] text-muted-foreground">Your hours count toward payroll</span></span>
            {clockIn.isPending ? <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" aria-hidden="true" />}
          </button>
        )}

        <div className="mt-4 rounded-xl border border-border bg-card overflow-hidden">
          <div className="grid grid-cols-3">
            <Stat label="Doors today" value={loading ? null : (myRow?.knocksToday ?? 0)} tone="text-foreground" accent="bg-primary" error={boardQ.isError} />
            <Stat label="Sales today" value={loading ? null : (myRow?.salesToday ?? 0)} tone="text-emerald-400" accent="bg-emerald-500" border error={boardQ.isError} />
            <Stat label="Doors left" value={loading ? null : route.openCount} tone="text-primary" accent="bg-sky-400" border error={pinsQ.isError} />
          </div>
          {!loading && routeTotal > 0 && (
            <div className="border-t border-border px-3.5 py-3">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold uppercase tracking-wide text-muted-foreground">Today's progress</span>
                <span className="tabular-nums text-muted-foreground"><span className="text-foreground font-semibold">{doorsDone} done</span> · {doorsLeft} to go</span>
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={routePct} aria-valuemin={0} aria-valuemax={100} aria-label="Doors worked today">
                <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${routePct}%` }} />
              </div>
            </div>
          )}
        </div>

        {/* Follow-ups due — surfaces the callbacks a rep owes (top of the loop). */}
        {followupsDue > 0 && (
          <Link href="/followups" className={`group mt-4 flex items-center gap-3 rounded-xl border border-sky-400/25 bg-sky-400/[0.08] px-4 py-3.5 active:scale-[.99] transition-transform hover:border-sky-400/40 ${FOCUS}`} data-testid="today-followups">
            <span className="w-9 h-9 rounded-lg bg-sky-400/15 text-sky-400 flex items-center justify-center shrink-0"><CalendarClock className="w-5 h-5" aria-hidden="true" /></span>
            <span className="flex-1 min-w-0">
              <span className="block text-[14px] font-semibold text-foreground">{followupsDue} follow-up{followupsDue === 1 ? "" : "s"} due</span>
              <span className="block text-[12px] text-muted-foreground">Callbacks scheduled for today or earlier</span>
            </span>
            <span className="shrink-0 inline-flex items-center justify-center h-6 min-w-6 px-1.5 rounded-full bg-sky-400/15 text-sky-400 text-[12px] font-bold tabular-nums">{followupsDue}</span>
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
        )}

        <div className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Your next door</h2>
            {locState === "off" && <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><MapPinIcon className="w-3 h-3" aria-hidden="true" />Location off · by priority</span>}
          </div>
          {loading ? (
            <div className="rounded-2xl border border-border bg-card p-5">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-6 w-2/3 mt-2.5" />
              <Skeleton className="h-4 w-1/3 mt-2" />
              <div className="flex gap-2.5 mt-4"><Skeleton className="h-12 flex-1" /><Skeleton className="h-12 w-12" /><Skeleton className="h-12 w-12" /></div>
            </div>
          ) : pinsQ.isError ? (
            <ErrorCard onRetry={() => pinsQ.refetch()} />
          ) : !pins.length ? (
            <EmptyCard title="No doors assigned yet" body="Ask your team lead for a territory, then your route shows up here." cta={{ to: "/map", label: "Open field map" }} />
          ) : !route.hero ? (
            <AllDoneCard sales={myRow?.salesToday ?? 0} />
          ) : (
            <HeroCard p={route.hero} loc={myLoc}
              onLog={() => setSheetLead(route.hero!)}
              onOpen={() => navigate(`/lead/${route.hero!.id}`)}
              onSkip={() => { setSkip(s => new Set(s).add(route.hero!.id)); toast({ title: "Door skipped" }); }} />
          )}
        </div>

        {!loading && route.rest.length > 0 && (
          <div className="mt-6">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Up next</h2>
              <span className="text-[11px] text-muted-foreground tabular-nums">{route.openCount} doors on your route</span>
            </div>
            <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
              {route.rest.map((p, i) => <DoorRow key={p.id} p={p} n={i + 2} loc={myLoc} onOpen={() => navigate(`/lead/${p.id}`)} />)}
            </div>
          </div>
        )}

        {myRow && (
          <Link href="/my-commission" className={`group mt-6 flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 active:scale-[.99] transition-transform hover:border-emerald-500/30 ${FOCUS}`} data-testid="today-pay">
            <span className="w-9 h-9 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0"><DollarSign className="w-5 h-5" aria-hidden="true" /></span>
            <span className="flex-1 min-w-0">
              <span className="block text-[14px] font-semibold text-foreground tabular-nums">{myRow.sales} sale{myRow.sales === 1 ? "" : "s"} · {myRow.salesToday} today</span>
              <span className="block text-[12px] text-muted-foreground">View your weekly pay statement</span>
            </span>
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
        )}
      </div>

      <OutcomeSheet
        lead={sheetLead}
        onClose={() => setSheetLead(null)}
        onLog={(outcome, opts) => {
          if (!sheetLead) return;
          log({ id: sheetLead.id, leadStatus: sheetLead.leadStatus, assignedRepId: sheetLead.assignedRepId }, outcome, opts);
          setSkip(s => new Set(s).add(sheetLead.id));
          setSheetLead(null);
        }}
      />
    </div>
  );
}

function Stat({ label, value, tone, accent = "bg-muted-foreground/50", border, error }: { label: string; value: number | null; tone: string; accent?: string; border?: boolean; error?: boolean }) {
  return (
    <div className={`px-3 py-3.5 ${border ? "border-l border-border" : ""}`}>
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span className={`w-1.5 h-1.5 rounded-full ${accent}`} aria-hidden="true" />{label}
      </div>
      {/* A failed query must not render as a real "0" — show an honest em-dash. */}
      {error ? <div className="text-[25px] font-bold tabular-nums leading-none mt-1.5 text-muted-foreground/60" aria-label={`${label} unavailable`}>—</div>
        : value == null ? <Skeleton className="h-7 w-10 mt-1.5" /> : <div className={`text-[25px] font-bold tabular-nums leading-none mt-1.5 ${tone}`}>{value}</div>}
    </div>
  );
}

function ReasonChips({ p }: { p: Pin }) {
  const rs = reasons(p);
  if (!rs.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2.5">
      {rs.map((r, i) => { const Icon = r.icon; return (
        <span key={i} className="inline-flex items-center gap-1 rounded-full bg-secondary border border-border px-2 py-1 text-[11px] font-medium text-foreground">
          <Icon className={`w-3 h-3 ${r.tone}`} aria-hidden="true" />{r.label}
        </span>
      ); })}
    </div>
  );
}

function HeroCard({ p, loc, onLog, onOpen, onSkip }: { p: Pin; loc: LatLng | null; onLog: () => void; onOpen: () => void; onSkip: () => void }) {
  const st = pinDisplayState(p);
  const dist = loc ? distanceHint(haversineMeters(loc, p)) : null;
  return (
    // Status-colored spine + elevated card = the one thing to do next (Jobber's visit card).
    <div className="relative rounded-2xl border border-border bg-card pl-5 pr-4 py-4 shadow-sm overflow-hidden" data-testid="today-hero">
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1.5" style={{ background: STATE_COLORS[st] }} />
      <button onClick={onOpen} className={`w-full flex items-start gap-3 text-left rounded-lg ${FOCUS}`} aria-label="Open property details">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Hue is carried by the spine (left); keep the LABEL text high-contrast (state-color = failed AA). */}
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground">
              <span className="w-2 h-2 rounded-full" style={{ background: STATE_COLORS[st] }} aria-hidden="true" />{STATE_LABELS[st]}
            </span>
            {dist && <span className="text-[11px] text-muted-foreground inline-flex items-center gap-0.5"><Navigation className="w-3 h-3" aria-hidden="true" />{dist} away</span>}
          </div>
          <div className="text-[21px] font-bold text-foreground leading-tight mt-1">{p.address}</div>
          <div className="text-[13px] text-muted-foreground mt-0.5">{p.city}{p.state ? `, ${p.state}` : ""}{p.zip ? ` ${p.zip}` : ""}</div>
          <ReasonChips p={p} />
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-1" aria-hidden="true" />
      </button>
      <div className="flex gap-2.5 mt-4">
        <button onClick={onLog} data-testid="hero-log" className={`flex-1 h-12 rounded-xl bg-primary text-primary-foreground font-semibold text-[15px] shadow-sm active:scale-95 transition-transform hover:bg-primary/90 ${FOCUS}`}>Log outcome</button>
        <a href={directionsUrl(p)} target="_blank" rel="noreferrer" aria-label="Navigate to this address" className={`w-12 h-12 rounded-xl bg-secondary border border-border flex items-center justify-center active:scale-95 transition-transform hover:bg-secondary/70 ${FOCUS}`}><Navigation className="w-5 h-5 text-foreground" aria-hidden="true" /></a>
        <button onClick={onSkip} aria-label="Skip this door" className={`w-12 h-12 rounded-xl bg-secondary border border-border flex items-center justify-center text-muted-foreground active:scale-95 transition-transform hover:bg-secondary/70 ${FOCUS}`}><SkipForward className="w-5 h-5" aria-hidden="true" /></button>
      </div>
    </div>
  );
}

function DoorRow({ p, n, loc, onOpen }: { p: Pin; n: number; loc: LatLng | null; onOpen: () => void }) {
  const st = pinDisplayState(p);
  const dist = loc ? distanceHint(haversineMeters(loc, p)) : null;
  const rs = reasons(p);
  return (
    <button onClick={onOpen} data-testid={`door-${p.id}`} className={`w-full flex items-center gap-3 px-4 py-3 text-left active:bg-secondary/60 transition-colors hover:bg-secondary/40 ${FOCUS}`}>
      {/* Numbered route stop with a status-colored badge (delivery-driver stop list). */}
      <span className="relative shrink-0 w-8 h-8 rounded-full bg-secondary border border-border flex items-center justify-center text-[12px] font-semibold tabular-nums text-muted-foreground">
        {n}
        <span className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-card" style={{ background: STATE_COLORS[st] }} aria-hidden="true" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold text-foreground truncate">{p.address}</div>
        <div className="text-[12px] text-muted-foreground truncate">{p.city}{dist ? ` · ${dist}` : ""}{rs[0] ? ` · ${rs[0].label}` : ""}</div>
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
    </button>
  );
}

function ErrorCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 text-center" data-testid="today-error">
      <div className="w-11 h-11 rounded-xl bg-red-500/15 flex items-center justify-center mx-auto"><WifiOff className="w-5 h-5 text-red-500" aria-hidden="true" /></div>
      <div className="text-[15px] font-semibold text-foreground mt-3">Couldn't load your route</div>
      <div className="text-[13px] text-muted-foreground mt-1 max-w-xs mx-auto">Check your connection and try again — nothing you've logged is lost.</div>
      <button onClick={onRetry} className={`mt-4 inline-flex items-center gap-2 h-11 px-4 rounded-xl bg-secondary border border-border text-[14px] font-semibold text-foreground active:scale-95 transition-transform hover:bg-secondary/70 ${FOCUS}`}><RefreshCw className="w-4 h-4" aria-hidden="true" />Retry</button>
    </div>
  );
}

function EmptyCard({ title, body, cta }: { title: string; body: string; cta: { to: string; label: string } }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 text-center" data-testid="today-empty">
      <div className="w-11 h-11 rounded-xl bg-secondary flex items-center justify-center mx-auto"><MapPinIcon className="w-5 h-5 text-muted-foreground" aria-hidden="true" /></div>
      <div className="text-[15px] font-semibold text-foreground mt-3">{title}</div>
      <div className="text-[13px] text-muted-foreground mt-1 max-w-xs mx-auto">{body}</div>
      <Link href={cta.to} className={`mt-4 inline-flex items-center gap-2 h-11 px-4 rounded-xl bg-primary text-primary-foreground text-[14px] font-semibold active:scale-95 transition-transform hover:bg-primary/90 ${FOCUS}`}>{cta.label}</Link>
    </div>
  );
}

function AllDoneCard({ sales }: { sales: number }) {
  return (
    <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-6 text-center" data-testid="today-alldone">
      <div className="w-11 h-11 rounded-xl bg-emerald-500/15 flex items-center justify-center mx-auto"><Trophy className="w-5 h-5 text-emerald-400" aria-hidden="true" /></div>
      <div className="text-[15px] font-semibold text-foreground mt-3">Every door worked — nice shift</div>
      <div className="text-[13px] text-muted-foreground mt-1 max-w-xs mx-auto">{sales > 0 ? `${sales} sale${sales === 1 ? "" : "s"} logged today.` : "Your route's clear."} New leads land here as they're assigned.</div>
      <Link href="/leaderboard" className={`mt-4 inline-flex items-center gap-2 h-11 px-4 rounded-xl bg-secondary border border-border text-[14px] font-semibold text-foreground active:scale-95 transition-transform hover:bg-secondary/70 ${FOCUS}`}><Trophy className="w-4 h-4" aria-hidden="true" />See the leaderboard</Link>
    </div>
  );
}
