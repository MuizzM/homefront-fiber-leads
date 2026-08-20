// ── Today — the rep's home ────────────────────────────────────────────────────
// Open the app and instantly know the next door and WHY, log an outcome in ≤2
// taps, and advance — one thumb, sunlight-readable, offline-safe. 100% real data:
// /api/leads/map pins, /api/leaderboard (today's doors/sales), /api/clock/status,
// and the SHARED offline logger (useKnockLogger → knockQueue + GPS evidence).
import { useState, useMemo, useEffect, type ReactNode } from "react";
import { FOCUS } from "@/lib/a11y";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { captureFieldFix } from "@/lib/geoFix";
import { useKnockLogger } from "@/lib/useKnockLogger";
import { OutcomeSheet } from "@/components/OutcomeSheet";
import { LiveSlot } from "@/components/LiveSlot";
import { EarningsToday, useEarningsToday } from "@/components/EarningsToday";
import { PushSetupCard } from "@/components/PushSetupCard";
import { TeamFeedBell, TeamFeedHeadline } from "@/components/TeamFeed";
import { useLiveItems } from "@/hooks/useLiveItems";
import { WarmupStrip } from "@/components/training/WarmupStrip";
import { unpackMapPins } from "@shared/mapPinsWire";
import {
  pinDisplayState, STATE_COLORS, STATE_LABELS,
  distanceHint, haversineMeters, todayISO, type RoutablePin,
} from "@shared/knock";
import { orderNextDoors, SCORE_SATURATION, type DoorRank } from "@shared/doorPriority";
import { doorOpener } from "@shared/doorOpener";
import { usd } from "@shared/moneyFormat";
import { useRankedDoors } from "@/lib/useRankedDoors";
import { Skeleton } from "@/components/ui/skeleton";
import { useSustained } from "@/hooks/use-sustained";
import { Navigation, Clock, RefreshCw, ChevronRight, SkipForward } from "lucide-react";


interface Pin extends RoutablePin {
  address: string; city: string; state?: string | null; zip?: string | null;
  leadTag?: string | null; fiberStatus?: string | null;
  carrier?: string | null; freshConfirmedAt?: string | null;
  contactName?: string | null; assignedRepId?: number | null; lastKnockedAt?: string | null; knockCount?: number | null;
}
interface LeaderRow { rep: { id: number; name: string; role: string }; knocks: number; sales: number; knocksToday: number; salesToday: number }
interface LatLng { lat: number; lng: number }

// Why THIS door. The server scores it (server/leadRanking.ts) on signals only
// this product has - a proven coming-soon to live flip, lit-age decay,
// confirmed-fresh density within 800m - and hands back the sentences with it.
// Those server reasons are the truth; the two local rules below are only a
// fallback for doors the ranker never pooled (it pools confirmed-fresh leads
// only) and for a dead zone, where the ranked fetch simply fails.
//
// Three rules were deleted rather than fixed: they read `isNewFiber`,
// `competitorName` and `inCompetitorArea`, none of which are on the map pin
// wire (shared/mapPinsWire.ts MAP_PIN_WIRE_FIELDS), so they could never fire.
// The "Hot lead" leadTag rule went too - the fresh-fiber projector stamps every
// confirmed-fresh door `fresh_fiber_confirmed`, so it was dead on exactly the
// doors it was meant to mark.
function reasons(p: Pin, rank: DoorRank | null): string[] {
  if (rank?.reasons.length) return rank.reasons.slice(0, 2);
  const out: string[] = [];
  if (p.fiberStatus === "new_fiber") out.push("New fiber");
  if (p.leadStatus === "follow_up") out.push("Callback due");
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

  // Own cache key, NOT the bare ["/api/leads/map"] the field map uses.
  // React Query keeps ONE queryFn per key — whichever observer mounted last
  // wins — so sharing it meant a Map → Today → Map trip left MapView refetching
  // through this function instead of its own, silently dropping the `view=`
  // lens the map was filtered by. Two screens, two questions, two keys.
  //
  // `format=packed` is the same rows in the columnar wire format the map has
  // used for a while; it is materially smaller than the object form this used
  // to request, for byte-identical data after unpacking.
  const pinsQ = useQuery<{ pins: Pin[]; total: number }>({
    queryKey: ["/api/leads/map", "today-route"],
    queryFn: async () => unpackMapPins<Pin>(await (await apiRequest("GET", "/api/leads/map?format=packed")).json()),
    staleTime: 20_000,
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/clock/status"] }); toast({ title: "Clocked in - have a great shift" }); },
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
      toast({ title: "Clocked out - shift saved", description: typeof m === "number" ? `${Math.floor(m / 60)}h ${m % 60}m logged` : undefined });
      setConfirmOut(false);
    },
    onError: (e: any) => { setConfirmOut(false); toast({ title: "Couldn't clock out", description: String(e?.message ?? e), variant: "destructive" }); },
  });

  const myRow = useMemo(() => (boardQ.data ?? []).find(r => r.rep.id === user?.teamMemberId) ?? null, [boardQ.data, user?.teamMemberId]);
  const pins = pinsQ.data?.pins ?? [];

  const [skip, setSkip] = useState<Set<number>>(new Set());
  // Why this door, in the rep's hand. The overlay is leadId -> {score, reasons}
  // from the ranking engine; it is sparse (only confirmed-fresh leads are
  // scored) and it is EMPTY offline, both of which shared/doorPriority.ts
  // handles by falling back to plain distance order.
  const rankById = useRankedDoors();
  // The screen shows one hero door and six rows, so only the best seven need
  // ordering — orderNextDoors keeps the bounded top-N single pass this used to
  // do inline, and adds the one thing distance alone cannot know: an
  // opportunity score buys a door at most DISCOUNT_MAX_M of extra walking.
  const route = useMemo(
    () => orderNextDoors<Pin>(myLoc, pins, rankById, skip, 7),
    [pins, myLoc, skip, rankById],
  );
  // leadId -> rank for the seven doors actually on screen, so the cards can
  // render the server's own words without re-reading the overlay.
  const rankOf = useMemo(() => {
    const m = new Map<number, DoorRank | null>();
    for (const view of route.ranked) m.set(view.pin.id, view.rank);
    return m;
  }, [route]);

  const [sheetLead, setSheetLead] = useState<Pin | null>(null);
  // Follow-ups included in the gate so the banner doesn't pop in above the hero
  // after first paint (it would shift "Log outcome" as the rep taps).
  const loading = pinsQ.isLoading || boardQ.isLoading || followupsQ.isLoading;
  const offline = snap.online === false;
  // Online saves settle in a sub-second blip — flashing "Syncing" on every
  // logged knock is noise (owner directive: no syncing shown). The strip
  // surfaces only offline truth, failures, or a genuinely stuck backlog.
  const backlog = useSustained(!offline && snap.pendingCount > 0, 3000);

  // Callbacks due today or earlier (still owed) — the top of the follow-up loop.
  // LOCAL date (via shared todayISO) so this badge can't disagree with the
  // Follow-ups page or over-count in the evening the way a UTC date would.
  const todayStr = todayISO();
  const followupsDue = (followupsQ.data ?? []).filter(f => f.callbackDate <= todayStr).length;

  // Today's progress — an honest read of two real numbers already on screen:
  // doors worked today vs doors still open. Mirrors a delivery driver's route bar.
  // One resolver, fed by the four incentive queries this page already makes.
  const liveItems = useLiveItems();

  // Same query key EarningsToday reads in the header, so the Key metrics block
  // below rides that request rather than opening a second one.
  const { data: earn, isError: earnError } = useEarningsToday();

  const doorsDone = myRow?.knocksToday ?? 0;
  const doorsLeft = route.openCount;
  const routeTotal = doorsDone + doorsLeft;
  const routePct = routeTotal > 0 ? Math.round((doorsDone / routeTotal) * 100) : 0;

  return (
    <div className="min-h-full bg-background pb-24">
      <h1 className="sr-only">Today</h1>
      <div className="mx-auto w-full max-w-lg px-4 pt-5">
        {/* ── ABOVE EVERYTHING: how the phone reaches them, and what it said ──
            Both of these were built and mounted NOWHERE — the install animation
            shipped to no one, and a manager could post an announcement that no
            rep had any surface to read. They go first because they are the two
            things that stop working silently:

            · PushSetupCard is the ONLY route to phone notifications, and on
              iPhone the only route to them existing at all (web push requires a
              home-screen install). It teaches the install with an animation,
              then asks for permission — in that order, because asking inside a
              Safari tab burns the single prompt iOS will ever show. It renders
              nothing once granted, unsupported, or dismissed, so it costs this
              screen no permanent space.
            · TeamFeedHeadline surfaces the newest UNREAD announcement as one
              line. Reading it clears it. A promo or a payout change should not
              require a rep to be curious about a badge. */}
        <PushSetupCard className="mb-3" />
        <TeamFeedHeadline className="mb-3" />

        <header className="flex items-start justify-between gap-3">
          {/* MONEY, not a greeting.
              "Good morning, Marcus" was 27px bold and owned the most valuable
              space above the fold while carrying no information — a rep opens
              this screen to find out where they stand, not to be greeted. The
              name and date move to a single small line above the number.
              EarningsToday shows BANKED money only (hours worked + spiffs in the
              ledger) and keeps commission on today's sales separate and labelled
              pending, because a sale can still fail qualification or charge back
              — and a headline number that turns out wrong on Friday discredits
              every other number on the screen. */}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" data-testid="today-greeting">
              
              {greeting}, {firstName} · {dateLabel}
            </div>
            <EarningsToday className="mt-1.5" />
          </div>
          {/* The bell is ALWAYS here, clocked in or not — it is the standing
              way back to anything the strip above was dismissed past by being
              read. Sits before the clock-out pill so the destructive-ish action
              stays at the far edge. */}
          <div className="flex shrink-0 items-start gap-1">
          <TeamFeedBell className="-mr-1 mt-0.5" />
          {clockQ.data?.clockedIn && (
            <button
              onClick={() => { if (confirmOut) clockOut.mutate(); else { setConfirmOut(true); setTimeout(() => setConfirmOut(false), 3000); } }}
              disabled={clockOut.isPending}
              data-testid="today-clock-out"
              aria-label={confirmOut ? "Tap again to clock out" : "On the clock - tap to clock out"}
              className={`shrink-0 mt-1 inline-flex items-center gap-1.5 rounded-full border min-h-11 px-3.5 text-[12px] font-semibold active:scale-95 transition disabled:opacity-60 ${FOCUS} ${confirmOut ? "bg-destructive/10 text-destructive border-destructive/25" : "bg-success/10 text-success border-success/15"}`}
            >
              {clockOut.isPending
                ? <><RefreshCw className="w-3 h-3 animate-spin" aria-hidden="true" />Clocking out…</>
                : confirmOut
                  ? <><Clock className="w-3 h-3" aria-hidden="true" />Tap to clock out</>
                  : <><span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" aria-hidden="true" />On the clock</>}
            </button>
          )}
          </div>
        </header>

        {(offline || backlog || snap.deadCount > 0) && (
          <div role="status" aria-live="polite" className={`mt-3 flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-[13px] ${offline ? "bg-muted border-border text-muted-foreground" : "bg-primary/10 border-primary/20 text-foreground"}`} data-testid="today-sync">
            {offline ? null : <RefreshCw className="w-4 h-4 shrink-0 text-primary animate-spin" aria-hidden="true" />}
            <span className="flex-1">
              {offline ? "Offline - your taps are saved" : `Syncing ${snap.pendingCount} knock${snap.pendingCount === 1 ? "" : "s"}`}
              {snap.deadCount > 0 && <span className="text-destructive"> · {snap.deadCount} failed</span>}
            </span>
          </div>
        )}

        {/* Reserve the clock-in card's slot while its status loads, so the card
            doesn't pop in above the hero and shift the tap targets. */}
        {clockQ.isLoading && <Skeleton className="mt-3 h-[62px] w-full rounded-xl" />}
        {/* A failed status fetch must not silently remove the way to start a
            paid shift — say what happened and give the retry. */}
        {clockQ.isError && (
          <div role="alert" className="mt-3 flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
            <span className="text-[13px] text-muted-foreground flex-1">Couldn't check your clock status.</span>
            <button onClick={() => clockQ.refetch()}
              className={`inline-flex items-center justify-center min-h-11 px-3 rounded-lg bg-secondary border border-border text-[13px] font-semibold text-foreground ${FOCUS}`}>
              Retry
            </button>
          </div>
        )}
        {clockQ.data && !clockQ.data.clockedIn && (
          <button onClick={() => clockIn.mutate()} disabled={clockIn.isPending} data-testid="today-clock-in"
            className={`mt-3 w-full flex items-center gap-3 rounded-xl bg-card border border-border px-4 py-3 text-left active:scale-[.99] transition-transform disabled:opacity-60 hover:border-primary/30 ${FOCUS}`}>
            
            <span className="flex-1"><span className="block text-[14px] font-semibold text-foreground">Clock in to start</span><span className="block text-[12px] text-muted-foreground">Records field activity; this is not hourly pay</span></span>
            {clockIn.isPending ? <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" aria-hidden="true" />}
          </button>
        )}

        {/* ── The glance band ────────────────────────────────────────────────
            All four facts stay visible at phone width. Each chip is also a
            route to the screen that owns the number, so no metric is a dead
            end or hidden behind an undiscoverable horizontal swipe. */}
        <div className="mt-4" data-testid="today-glance">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <GlanceChip to="/leaderboard" label="Doors today" value={loading ? null : (myRow?.knocksToday ?? 0)}
              tone="text-foreground" accent="bg-primary" error={boardQ.isError} />
            <GlanceChip to="/my-commission" label="Sales today" value={loading ? null : (myRow?.salesToday ?? 0)}
              tone="text-success" accent="bg-success" error={boardQ.isError} />
            <GlanceChip to="/map" label="Doors left" value={loading ? null : route.openCount}
              tone="text-primary" accent="bg-info" error={pinsQ.isError} />
            <GlanceChip to="/followups" label="Follow-ups" value={loading ? null : followupsDue}
              tone={followupsDue > 0 ? "text-warning" : "text-foreground"}
              accent={followupsDue > 0 ? "bg-warning" : "bg-border"} error={followupsQ.isError} />
          </div>
          {!loading && routeTotal > 0 && (
            <div className="mt-2 rounded-xl border border-border bg-card px-3.5 py-3">
              <div className="flex items-baseline justify-between gap-3 text-[12px]">
                <span className="font-semibold text-foreground">Today's progress</span>
                <span className="tabular-nums text-muted-foreground"><span className="font-semibold text-foreground">{doorsDone} done</span> · {doorsLeft} to go</span>
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={routePct} aria-valuemin={0} aria-valuemax={100} aria-label="Doors worked today">
                <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${routePct}%` }} />
              </div>
            </div>
          )}
        </div>

        {/* Follow-ups due — surfaces the callbacks a rep owes (top of the loop).
            On a failed fetch, say the count is unknown rather than implying zero. */}
        {followupsQ.isError && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-[12px] text-muted-foreground" data-testid="today-followups-error">
            
            <span className="flex-1">Couldn't check your follow-ups.</span>
            <button onClick={() => followupsQ.refetch()} className={`font-semibold text-foreground min-h-11 px-2 ${FOCUS}`}>Retry</button>
          </div>
        )}
        {followupsDue > 0 && (
          <Link href="/followups" className={`group mt-4 flex items-center gap-3 rounded-xl border border-info/15 bg-info/[0.08] px-4 py-3.5 active:scale-[.99] transition-transform hover:border-info/30 ${FOCUS}`} data-testid="today-followups">
            
            <span className="flex-1 min-w-0">
              <span className="block text-[14px] font-semibold text-foreground">{followupsDue} follow-up{followupsDue === 1 ? "" : "s"} due</span>
              <span className="block text-[12px] text-muted-foreground">Callbacks scheduled for today or earlier</span>
            </span>
            <span className="shrink-0 inline-flex items-center justify-center h-6 min-w-6 px-1.5 rounded-full bg-info/10 text-info text-[12px] font-bold tabular-nums">{followupsDue}</span>
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
        )}

        <div className="mt-6">
          <SectionTitle meta={locState === "off" ? "Location off · by priority" : null}>Your next door</SectionTitle>
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
            <HeroCard p={route.hero} loc={myLoc} rank={rankOf.get(route.hero.id) ?? null}
              onLog={() => setSheetLead(route.hero!)}
              onOpen={() => navigate(`/lead/${route.hero!.id}`)}
              onSkip={() => { setSkip(s => new Set(s).add(route.hero!.id)); toast({ title: "Door skipped" }); }} />
          )}
        </div>

        {/* Incentives and coaching support the route; they no longer displace
            the next-door task below the first mobile viewport. The selector
            still guarantees one live offer rather than a stack of promos. */}
        <div className="mt-4 empty:mt-0" data-testid="today-campaign">
          <LiveSlot items={liveItems} />
          <WarmupStrip />
        </div>

        {!loading && route.rest.length > 0 && (
          <div className="mt-6">
            <SectionTitle meta={`${route.openCount} doors on your route`}>Up next</SectionTitle>
            <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
              {route.rest.map((p, i) => <DoorRow key={p.id} p={p} n={i + 2} loc={myLoc} rank={rankOf.get(p.id) ?? null} onOpen={() => navigate(`/lead/${p.id}`)} />)}
            </div>
          </div>
        )}

        {/* ── Key metrics ────────────────────────────────────────────────────
            The standing totals, below the route because they are context, not
            the next action. The glance band answers "how is today going"; this
            answers "where do I stand", and the two must not be read as the same
            kind of number - which is exactly what happened when the only thing
            down here was one row reading "12 sales · 2 today", repeating a
            figure the top of the screen already owned.

            All four come from queries this screen already makes: the earnings
            hook is the same key EarningsToday reads in the header, so this
            costs no extra request. */}
        {myRow && (
          <div className="mt-6" data-testid="today-metrics">
            <SectionTitle>Key metrics</SectionTitle>
            <div className="grid grid-cols-2 gap-2">
              <MetricTile label="Doors all time" value={myRow.knocks.toLocaleString("en-US")} />
              <MetricTile label="Sales all time" value={myRow.sales.toLocaleString("en-US")} />
              {/* Guarded on the NUMBER, not on the response: a query that
                  resolves to something unexpected must degrade to a dash the
                  same way a rejected one does, never to "NaNh NaNm". */}
              <MetricTile label="On the clock" error={earnError}
                value={typeof earn?.hourlyMinutes === "number" ? clockLabel(earn.hourlyMinutes) : null} />
              <MetricTile label="Bonuses today" error={earnError}
                value={typeof earn?.spiffCents === "number" ? usd(earn.spiffCents) : null} />
            </div>
            <Link href="/my-commission" className={`group mt-2 flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 active:scale-[.99] transition-transform hover:border-success/25 ${FOCUS}`} data-testid="today-pay">
              <span className="flex-1 min-w-0 text-[14px] font-semibold text-foreground">View your weekly commission statement</span>
              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
          </div>
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

// One number in the glance band. The tone dot is the only colour the label
// carries: the value itself is toned, and a coloured label on a coloured value
// is two signals for one fact.
function GlanceChip({ to, label, value, tone, accent, error }: { to: string; label: string; value: number | null; tone: string; accent: string; error?: boolean }) {
  return (
    <Link
      href={to}
      data-testid={`glance-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className={`min-w-0 w-full rounded-2xl border border-border bg-card px-3.5 pt-3 pb-3.5 active:scale-[.97] transition-transform hover:border-primary/25 ${FOCUS}`}
    >
      <span className={`block w-1.5 h-1.5 rounded-full ${accent}`} aria-hidden="true" />
      {/* A failed query must not render as a real "0" - show an honest dash. */}
      {error ? <div className="text-[28px] font-bold tabular-nums leading-none mt-2 text-muted-foreground/60" aria-label={`${label} unavailable`}>-</div>
        : value == null ? <Skeleton className="h-7 w-10 mt-2" /> : <div className={`text-[28px] font-bold tabular-nums leading-none mt-2 ${tone}`}>{value}</div>}
      <div className="text-[11px] font-semibold text-muted-foreground mt-1.5">{label}</div>
    </Link>
  );
}

// Section headings were 11px uppercase muted - below the 11px legibility floor
// once tracking is added, and the same weight as the metadata beside them. A
// rep reading this at arm's length in sunlight needs the heading to be the
// thing that separates one block from the next.
function SectionTitle({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-2.5">
      <h2 className="text-[17px] font-bold tracking-tight text-foreground">{children}</h2>
      {meta ? <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{meta}</span> : null}
    </div>
  );
}

function MetricTile({ label, value, error }: { label: string; value: string | null; error?: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-card px-3.5 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {error
        ? <div className="text-[22px] font-bold tabular-nums leading-none mt-1.5 text-muted-foreground/60" aria-label={`${label} unavailable`}>-</div>
        : value == null
          ? <Skeleton className="h-6 w-16 mt-1.5" />
          : <div className="text-[22px] font-bold tabular-nums leading-none tracking-tight text-foreground mt-1.5">{value}</div>}
    </div>
  );
}

const clockLabel = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;

// How hard the ranker argued for this door, as a word rather than a number.
// The score is real (server/leadRanking.ts) and SCORE_SATURATION is the
// product's own line for "hot", so the rail is measured against the same
// constant the route ordering uses. Shown WITHOUT the raw figure: a rep needs
// to know this door earned its place, not to audit a 0-105 scale.
function opportunity(score: number): { pct: number; verdict: string } {
  const pct = Math.max(0, Math.min(100, Math.round((score / SCORE_SATURATION) * 100)));
  return { pct, verdict: pct >= 100 ? "Prime" : pct >= 60 ? "Strong" : "Fair" };
}

function ReasonChips({ p, rank }: { p: Pin; rank: DoorRank | null }) {
  const rs = reasons(p, rank);
  if (!rs.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2.5" data-testid="today-reasons">
      {rs.map((r) => (
        <span key={r} className="inline-flex items-center gap-1 rounded-full bg-secondary border border-border px-2 py-1 text-[11px] font-medium text-foreground">
          {r}
        </span>
      ))}
    </div>
  );
}

function HeroCard({ p, loc, rank, onLog, onOpen, onSkip }: { p: Pin; loc: LatLng | null; rank: DoorRank | null; onLog: () => void; onOpen: () => void; onSkip: () => void }) {
  const st = pinDisplayState(p);
  const dist = loc ? distanceHint(haversineMeters(loc, p)) : null;
  // The other half of "which door next": what to open with. Grounded in the
  // carrier and the confirmed-fresh stamp this pin already carries, and null
  // when the system has verified nothing worth saying (see shared/doorOpener).
  const opener = doorOpener({
    carrier: p.carrier, freshConfirmedAt: p.freshConfirmedAt,
    lastOutcome: p.lastOutcome, knockCount: p.knockCount,
  });
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
            {dist && <span className="text-[11px] text-muted-foreground inline-flex items-center gap-0.5">{dist} away</span>}
          </div>
          <div className="text-[21px] font-bold text-foreground leading-tight mt-1">{p.address}</div>
          <div className="text-[13px] text-muted-foreground mt-0.5">{p.city}{p.state ? `, ${p.state}` : ""}{p.zip ? ` ${p.zip}` : ""}</div>
          <ReasonChips p={p} rank={rank} />
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-1" aria-hidden="true" />
      </button>
      {/* Why this door is FIRST, as opposed to why it is worth knocking. The
          reason chips above say what is true about the address; this says how
          strongly the ranker argued for it, which is the question a rep asks
          when the hero is not the closest door on the street. Renders only for
          doors the ranker actually scored - it pools confirmed-fresh leads
          only, and an unranked door is neutral, never weak. */}
      {rank && (
        <div className="mt-3.5" data-testid="today-opportunity">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Opportunity</span>
            <span className="text-[12px] font-semibold text-foreground">{opportunity(rank.score).verdict}</span>
          </div>
          <div className="mt-1.5 h-1 rounded-full bg-muted overflow-hidden"
            role="progressbar" aria-valuenow={opportunity(rank.score).pct} aria-valuemin={0} aria-valuemax={100} aria-label="Opportunity score for this door">
            <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${opportunity(rank.score).pct}%` }} />
          </div>
        </div>
      )}
      {/* What to say. Sits between the address and the action because it is
          read on the walk up, not at the porch. Quiet by design - it is a
          prompt, not a script the rep is expected to recite. */}
      {opener && (
        <div className="mt-3 rounded-xl border border-border bg-secondary/40 px-3.5 py-2.5" data-testid="today-opener">
          <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Open with</div>
          <p className="text-[13px] text-foreground mt-1 leading-snug">
            {opener.fact} <span className="text-muted-foreground">{opener.ask}</span>
          </p>
        </div>
      )}
      <div className="flex gap-2.5 mt-4">
        <button onClick={onLog} data-testid="hero-log" className={`flex-1 h-12 rounded-xl bg-primary text-primary-foreground font-semibold text-[15px] shadow-sm active:scale-95 transition-transform hover:bg-primary/90 ${FOCUS}`}>Log outcome</button>
        <a href={directionsUrl(p)} target="_blank" rel="noreferrer" aria-label="Navigate to this address" className={`w-12 h-12 rounded-xl bg-secondary border border-border flex items-center justify-center active:scale-95 transition-transform hover:bg-secondary/70 ${FOCUS}`}><Navigation className="w-5 h-5 text-foreground" aria-hidden="true" /></a>
        <button onClick={onSkip} aria-label="Skip this door" className={`w-12 h-12 rounded-xl bg-secondary border border-border flex items-center justify-center text-muted-foreground active:scale-95 transition-transform hover:bg-secondary/70 ${FOCUS}`}><SkipForward className="w-5 h-5" aria-hidden="true" /></button>
      </div>
    </div>
  );
}

function DoorRow({ p, n, loc, rank, onOpen }: { p: Pin; n: number; loc: LatLng | null; rank: DoorRank | null; onOpen: () => void }) {
  const st = pinDisplayState(p);
  const dist = loc ? distanceHint(haversineMeters(loc, p)) : null;
  const rs = reasons(p, rank);
  return (
    <button onClick={onOpen} data-testid={`door-${p.id}`} className={`w-full flex items-center gap-3 px-4 py-3 text-left active:bg-secondary/60 transition-colors hover:bg-secondary/40 ${FOCUS}`}>
      {/* Numbered route stop with a status-colored badge (delivery-driver stop list). */}
      <span className="relative shrink-0 w-8 h-8 rounded-full bg-secondary border border-border flex items-center justify-center text-[12px] font-semibold tabular-nums text-muted-foreground">
        {n}
        <span className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-card" style={{ background: STATE_COLORS[st] }} aria-hidden="true" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold text-foreground truncate">{p.address}</div>
        <div className="text-[12px] text-muted-foreground truncate">{p.city}{dist ? ` · ${dist}` : ""}{rs[0] ? ` · ${rs[0]}` : ""}</div>
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
    </button>
  );
}

function ErrorCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 text-center" data-testid="today-error">
      
      <div className="text-[15px] font-semibold text-foreground mt-3">Couldn't load your route</div>
      <div className="text-[13px] text-muted-foreground mt-1 max-w-xs mx-auto">Check your connection and try again - nothing you've logged is lost.</div>
      <button onClick={onRetry} className={`mt-4 inline-flex items-center gap-2 h-11 px-4 rounded-xl bg-secondary border border-border text-[14px] font-semibold text-foreground active:scale-95 transition-transform hover:bg-secondary/70 ${FOCUS}`}>Retry</button>
    </div>
  );
}

function EmptyCard({ title, body, cta }: { title: string; body: string; cta: { to: string; label: string } }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 text-center" data-testid="today-empty">
      
      <div className="text-[15px] font-semibold text-foreground mt-3">{title}</div>
      <div className="text-[13px] text-muted-foreground mt-1 max-w-xs mx-auto">{body}</div>
      <Link href={cta.to} className={`mt-4 inline-flex items-center gap-2 h-11 px-4 rounded-xl bg-primary text-primary-foreground text-[14px] font-semibold active:scale-95 transition-transform hover:bg-primary/90 ${FOCUS}`}>{cta.label}</Link>
    </div>
  );
}

function AllDoneCard({ sales }: { sales: number }) {
  return (
    <div className="rounded-2xl border border-success/15 bg-success/[0.06] p-6 text-center" data-testid="today-alldone">
      
      <div className="text-[15px] font-semibold text-foreground mt-3">Every door worked - nice shift</div>
      <div className="text-[13px] text-muted-foreground mt-1 max-w-xs mx-auto">{sales > 0 ? `${sales} sale${sales === 1 ? "" : "s"} logged today.` : "Your route's clear."} New leads land here as they're assigned.</div>
      <Link href="/leaderboard" className={`mt-4 inline-flex items-center gap-2 h-11 px-4 rounded-xl bg-secondary border border-border text-[14px] font-semibold text-foreground active:scale-95 transition-transform hover:bg-secondary/70 ${FOCUS}`}>See the leaderboard</Link>
    </div>
  );
}
