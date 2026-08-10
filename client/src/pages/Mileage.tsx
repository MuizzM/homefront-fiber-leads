// ── Mileage — the rep's tracker and log, and the manager's approval queue ────
//
// One page, three panels, gated by capability rather than by role string, so
// the UI can never offer an action the API will reject (shared/capabilities.ts
// is the single source both read).
//
// ── THE LOCATION DISCLOSURE IS A GATE, NOT A BANNER ─────────────────────────
// The GPS tracker does not render until the worker has accepted the
// disclosure, and the server refuses `/start` without it too. Background
// sampling is a SECOND, separately-worded opt-in that defaults off — agreeing
// to have a trip measured is not agreeing to be followed all day, and there is
// no state in this app where location is read without an open trip the worker
// started.

import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/ui/page-scaffold";
import { useToast } from "@/hooks/use-toast";
import { useCan } from "@/lib/capabilities";
import { formatMiles } from "@shared/mileage";
import { Check, X } from "lucide-react";

interface Trip {
  id: number; repId: number; repName?: string; tripDate: string;
  startLocation: string | null; endLocation: string | null;
  milesHundredths: number; distanceMethod: string;
  purpose: string | null; notes: string | null;
  source: string; status: string;
  rateMilliCentsPerMile: number | null; reimbursementCents: number | null;
  startedAt: string | null; endedAt: string | null; submittedAt: string | null;
  rejectionReason: string | null;
  adjustmentCents: number; adjustmentMilesHundredths: number;
}

interface Summary {
  tripCount: number; totalMilesHundredths: number; totalMiles: string;
  approvedCents: number; paidCents: number;
  pendingMilesHundredths: number; pendingEstimateCents: number;
  reimbursementEnabled: boolean;
  currentRate: { rateMilliCentsPerMile: number; label: string; effectiveFrom: string } | null;
}

interface Consent {
  disclosureAcceptedAt: string | null; backgroundOptIn: boolean;
  currentVersion: string; mayStartGpsTrip: boolean;
  gpsPolicy: "REP_CHOICE" | "LOCKED_OFF";
  mayChangeOwnConsent: boolean;
  adminLocked: boolean;
}

const money = (cents: number) => {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
};

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SUBMITTED: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  APPROVED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  REJECTED: "bg-destructive/15 text-destructive",
  PAID: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
};

// Human labels for the raw DB enum — a rep was reading "SUBMITTED" in caps next
// to a lowercase "corrected" chip. "Awaiting review" matches the summary tile
// and "Sent back" matches the rejection explainer line below it.
const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Awaiting review",
  APPROVED: "Approved",
  REJECTED: "Sent back",
  PAID: "Paid",
};

function get<T>(url: string) {
  return apiRequest("GET", url).then(r => r.json() as Promise<T>);
}
function invalidateMileage() {
  queryClient.invalidateQueries({ queryKey: ["/api/mileage/trips"] });
  queryClient.invalidateQueries({ queryKey: ["/api/mileage/summary"] });
  queryClient.invalidateQueries({ queryKey: ["/api/mileage/queue"] });
}

// ── The disclosure sheet ────────────────────────────────────────────────────

function LocationDisclosure({ consent }: { consent: Consent }) {
  const { toast } = useToast();
  const [background, setBackground] = useState(false);

  const accept = useMutation({
    mutationFn: (body: { accepted: boolean; backgroundOptIn: boolean }) =>
      apiRequest("POST", "/api/mileage/consent", body).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/mileage/consent"] }),
    onError: () => toast({ title: "Could not save your choice", variant: "destructive" }),
  });

  // A control the worker cannot move is shown as a STATE, not as a button that
  // 403s on tap. Saying who locked it and that manual logging still works is the
  // difference between "the app is broken" and "this is a policy".
  if (!consent.mayChangeOwnConsent) {
    return (
      <Card data-testid="mileage-consent-locked">
        <CardContent className="flex items-start gap-2 py-4 text-sm">
          
          <div>
            <p className="font-medium">
              {consent.gpsPolicy === "LOCKED_OFF"
                ? "GPS trips are turned off for your organization"
                : "Your location setting is managed by an administrator"}
            </p>
            <p className="text-muted-foreground">
              {consent.disclosureAcceptedAt && consent.gpsPolicy !== "LOCKED_OFF"
                ? "Tracking is on and cannot be changed here."
                : "Tracking is off."} You can still log trips by hand below.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (consent.disclosureAcceptedAt) {
    return (
      <Card data-testid="mileage-consent-granted">
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div className="text-sm">
            <p className="font-medium">Location is on for trips you start</p>
            <p className="text-muted-foreground">
              {consent.backgroundOptIn
                ? "Your phone may keep measuring while the app is in the background - only during a trip you started."
                : "Measured only while this screen is open, during a trip you started."}
            </p>
          </div>
          <Button
            variant="outline" size="sm" data-testid="mileage-consent-revoke"
            onClick={() => accept.mutate({ accepted: false, backgroundOptIn: false })}
          >
            Turn off
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="mileage-consent-prompt">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
           Before we use your location
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>Location is read <strong>only while a trip you started is open</strong>.</li>
          <li>We record the start and end points and the distance between them.</li>
          <li>Nothing is recorded when no trip is running, and never in the background unless you turn that on below.</li>
          <li>You can turn this off at any time, and you can always log trips by hand instead.</li>
        </ul>
        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <div className="min-w-0">
            <Label htmlFor="bg-optin" className="text-sm font-medium">Keep measuring in the background</Label>
            <p className="text-xs text-muted-foreground">
              Optional. Only applies during an open trip, so you can put your phone away while you drive.
            </p>
          </div>
          <Switch id="bg-optin" checked={background} onCheckedChange={setBackground} data-testid="mileage-background-optin" />
        </div>
        {/* Stacked on a phone. Side by side these two labels never fit: their
            combined min-content was 426px, which pushed the ENTIRE page wider
            than a 375px viewport and carried the export button off-screen. */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            data-testid="mileage-consent-accept"
            onClick={() => accept.mutate({ accepted: true, backgroundOptIn: background })}
            disabled={accept.isPending}
          >
            Allow location for trips
          </Button>
          <Button variant="ghost" data-testid="mileage-consent-decline" onClick={() => setBackground(false)}>
            Not now - I'll log by hand
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── The GPS tracker ─────────────────────────────────────────────────────────

function GpsTracker({ openTrip }: { openTrip: Trip | null }) {
  const { toast } = useToast();
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);

  /** One reading, with a real timeout. A tracker that hangs forever on a cold
   *  GPS fix is worse than one that admits it could not get a position. */
  const readPosition = (): Promise<GeolocationPosition | null> =>
    new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        p => resolve(p), () => resolve(null),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
      );
    });

  const start = useMutation({
    mutationFn: async () => {
      const pos = await readPosition();
      return apiRequest("POST", "/api/mileage/trips/0/start", {
        latitude: pos?.coords.latitude ?? null,
        longitude: pos?.coords.longitude ?? null,
        purpose: purpose.trim() || null,
      }).then(r => r.json());
    },
    onSuccess: () => { invalidateMileage(); setPurpose(""); },
    onError: (e: any) => toast({ title: "Could not start the trip", description: String(e?.message ?? ""), variant: "destructive" }),
  });

  const end = useMutation({
    mutationFn: async () => {
      const pos = await readPosition();
      return apiRequest("POST", `/api/mileage/trips/${openTrip?.id}/end`, {
        latitude: pos?.coords.latitude ?? null,
        longitude: pos?.coords.longitude ?? null,
      }).then(r => r.json());
    },
    onSuccess: () => invalidateMileage(),
    onError: () => toast({
      title: "Could not end the trip",
      description: "No distance could be measured. Enter the miles by hand on the trip.",
      variant: "destructive",
    }),
  });

  const running = !!openTrip;

  return (
    <Card data-testid="mileage-tracker">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Trip tracker</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {running ? (
          <>
            <div className="rounded-md bg-emerald-500/10 p-3 text-sm">
              <p className="font-medium text-emerald-700 dark:text-emerald-400">Trip running</p>
              <p className="text-muted-foreground">
                Started {openTrip.startedAt ? new Date(openTrip.startedAt).toLocaleTimeString() : " - "}
                {openTrip.purpose ? ` · ${openTrip.purpose}` : ""}
              </p>
            </div>
            <Button
              className="w-full" variant="destructive" data-testid="mileage-end-trip"
              disabled={end.isPending} onClick={() => end.mutate()}
            >
               End trip
            </Button>
          </>
        ) : (
          <>
            <div>
              <Label htmlFor="trip-purpose" className="text-xs">What is this trip for?</Label>
              <Input
                id="trip-purpose" data-testid="mileage-purpose"
                placeholder="Door knocking - Oakwood"
                value={purpose} onChange={e => setPurpose(e.target.value)}
              />
            </div>
            <Button
              className="w-full" data-testid="mileage-start-trip"
              disabled={start.isPending || busy} onClick={() => { setBusy(true); start.mutate(undefined, { onSettled: () => setBusy(false) }); }}
            >
               Start trip
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Manual entry ────────────────────────────────────────────────────────────

function ManualEntry({ rate }: { rate: Summary["currentRate"] }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ tripDate: new Date().toISOString().slice(0, 10), startLocation: "", endLocation: "", miles: "", purpose: "" });
  const [roundTrip, setRoundTrip] = useState(false);
  const [duplicateAck, setDuplicateAck] = useState(false);

  // What actually gets logged. A round trip is two legs of the number typed,
  // and the record stores the REAL distance driven - the toggle is a
  // convenience for entry, never a different kind of trip.
  const oneWay = Number(form.miles);
  const loggedMiles = Number.isFinite(oneWay) && oneWay > 0 ? (roundTrip ? oneWay * 2 : oneWay) : 0;
  // Priced from the live rate, in the same integer arithmetic the server uses:
  // milli-cents per mile x hundredths of a mile, divided down once at the end.
  const previewCents = rate ? Math.round((loggedMiles * 100 * rate.rateMilliCentsPerMile) / 100_000) : null;

  const create = useMutation({
    mutationFn: (body: any) => apiRequest("POST", "/api/mileage/trips", body).then(async r => {
      const json = await r.json();
      if (!r.ok) throw Object.assign(new Error(json.error ?? "Failed"), { code: json.code, duplicates: json.duplicates });
      return json;
    }),
    onSuccess: () => {
      invalidateMileage();
      setForm({ tripDate: new Date().toISOString().slice(0, 10), startLocation: "", endLocation: "", miles: "", purpose: "" });
      setRoundTrip(false);
      setDuplicateAck(false);
      toast({ title: "Trip saved as a draft" });
    },
    onError: (e: any) => {
      // A suspected duplicate is a QUESTION, not a refusal - the rep may
      // legitimately have driven the same route twice today.
      if (e?.code === "MILEAGE_DUPLICATE_SUSPECTED") {
        setDuplicateAck(true);
        toast({
          title: "Looks like a trip you already logged",
          description: "Check your log below. Submit again to keep it anyway.",
        });
        return;
      }
      toast({ title: "Could not save the trip", description: String(e?.message ?? ""), variant: "destructive" });
    },
  });

  return (
    <Card data-testid="mileage-manual-entry">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Log a trip by hand</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="m-date" className="text-xs">Date</Label>
            <Input id="m-date" type="date" data-testid="mileage-date" value={form.tripDate}
              onChange={e => setForm(f => ({ ...f, tripDate: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="m-miles" className="text-xs">{roundTrip ? "Miles each way" : "Miles"}</Label>
            <Input id="m-miles" inputMode="decimal" data-testid="mileage-miles" placeholder="12.3"
              value={form.miles} onChange={e => setForm(f => ({ ...f, miles: e.target.value }))} />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-xl border border-border px-3 py-2">
          <Label htmlFor="m-round" className="text-xs font-medium">Round trip</Label>
          <Switch id="m-round" checked={roundTrip} data-testid="mileage-round-trip"
            onCheckedChange={setRoundTrip} />
        </div>
        <div>
          <Label htmlFor="m-from" className="text-xs">From</Label>
          <Input id="m-from" data-testid="mileage-from" value={form.startLocation}
            onChange={e => setForm(f => ({ ...f, startLocation: e.target.value }))} />
        </div>
        <div>
          <Label htmlFor="m-to" className="text-xs">To</Label>
          <Input id="m-to" data-testid="mileage-to" value={form.endLocation}
            onChange={e => setForm(f => ({ ...f, endLocation: e.target.value }))} />
        </div>
        <div>
          <Label htmlFor="m-purpose" className="text-xs">Business purpose</Label>
          <Input id="m-purpose" data-testid="mileage-manual-purpose" placeholder="Door knocking - Oakwood"
            value={form.purpose} onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))} />
        </div>
        {/* The arithmetic, before it is committed - a rep should never have to
            take the reimbursement on faith, and a bookkeeper reading the log
            later should see the same three numbers. */}
        {loggedMiles > 0 && (
          <div className="flex items-baseline justify-between rounded-xl bg-secondary/50 px-3 py-2"
               data-testid="mileage-preview">
            <span className="text-xs text-muted-foreground">
              {loggedMiles.toFixed(2)} mi{roundTrip ? " (round trip)" : ""}
              {rate ? ` x ${rate.label}` : ""}
            </span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {previewCents != null ? money(previewCents) : "Logged for your records"}
            </span>
          </div>
        )}

        <Button
          className="w-full" data-testid="mileage-save-trip" disabled={create.isPending || loggedMiles <= 0}
          onClick={() => create.mutate({ ...form, miles: String(loggedMiles), duplicateAck })}
        >
          {duplicateAck ? "Save anyway" : "Save trip"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── One row in the log ──────────────────────────────────────────────────────

function TripRow({ trip, showRep }: { trip: Trip; showRep?: boolean }) {
  const { toast } = useToast();
  const submit = useMutation({
    mutationFn: () => apiRequest("POST", `/api/mileage/trips/${trip.id}/submit`, {}).then(r => r.json()),
    onSuccess: () => { invalidateMileage(); toast({ title: "Sent for approval" }); },
    onError: () => toast({ title: "Could not submit", variant: "destructive" }),
  });

  const netMiles = trip.milesHundredths + trip.adjustmentMilesHundredths;
  const netCents = (trip.reimbursementCents ?? 0) + trip.adjustmentCents;

  return (
    <div className="flex items-start justify-between gap-3 border-b py-3 last:border-0" data-testid={`mileage-trip-${trip.id}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium tabular-nums">{formatMiles(netMiles)}</span>
          <Badge className={STATUS_TONE[trip.status] ?? ""} variant="secondary">{STATUS_LABEL[trip.status] ?? trip.status}</Badge>
          {trip.source === "GPS" && <Badge variant="outline" className="text-xs">GPS</Badge>}
          {trip.adjustmentMilesHundredths !== 0 && (
            <Badge variant="outline" className="text-xs">corrected</Badge>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {showRep && trip.repName ? `${trip.repName} · ` : ""}
          {trip.tripDate}
          {trip.startLocation || trip.endLocation ? ` · ${trip.startLocation ?? "?"} to ${trip.endLocation ?? "?"}` : ""}
        </p>
        {trip.purpose && <p className="truncate text-xs text-muted-foreground">{trip.purpose}</p>}
        {trip.status === "REJECTED" && trip.rejectionReason && (
          <p className="mt-1 text-xs text-destructive">Sent back: {trip.rejectionReason}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {trip.reimbursementCents != null && (
          <span className="text-sm tabular-nums" data-testid={`mileage-amount-${trip.id}`}>{money(netCents)}</span>
        )}
        {(trip.status === "DRAFT" || trip.status === "REJECTED") && trip.milesHundredths > 0 && (
          <Button size="sm" variant="outline" data-testid={`mileage-submit-${trip.id}`}
            disabled={submit.isPending} onClick={() => submit.mutate()}>
            Submit
          </Button>
        )}
      </div>
    </div>
  );
}

// ── The manager's approval queue ────────────────────────────────────────────

function ApprovalQueue() {
  const { toast } = useToast();
  const { data: queue = [], isLoading, isError, refetch } = useQuery<Trip[]>({
    queryKey: ["/api/mileage/queue"],
    queryFn: () => get<Trip[]>("/api/mileage/queue"),
  });

  const decide = useMutation({
    mutationFn: ({ id, action, reason }: { id: number; action: "approve" | "reject"; reason?: string }) =>
      apiRequest("POST", `/api/mileage/trips/${id}/${action}`, reason ? { reason } : {}).then(async r => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed");
        return json;
      }),
    onSuccess: () => invalidateMileage(),
    onError: (e: any) => toast({ title: "Could not update the trip", description: String(e?.message ?? ""), variant: "destructive" }),
  });

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  return (
    <Card data-testid="mileage-approval-queue">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span>Approval queue</span>
          <Badge variant="secondary" data-testid="mileage-queue-count">{queue.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isError ? (
          // An approval queue that fails to load must never read as "all clear".
          <div role="alert" className="py-6 text-center">
            <p className="text-sm text-muted-foreground">Couldn't load the queue - trips may still be waiting.</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
          </div>
        ) : queue.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nothing waiting for review.</p>
        ) : (
          queue.map(t => (
            <div key={t.id} className="flex items-center justify-between gap-3 border-b py-3 last:border-0">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {t.repName} · <span className="tabular-nums">{formatMiles(t.milesHundredths)}</span>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {t.tripDate} · {t.startLocation ?? "?"} to {t.endLocation ?? "?"}
                </p>
                <p className="truncate text-xs text-muted-foreground">{t.purpose ?? "No purpose given"}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" data-testid={`mileage-approve-${t.id}`}
                  aria-label={`Approve ${t.repName}'s ${formatMiles(t.milesHundredths)} trip`}
                  onClick={() => decide.mutate({ id: t.id, action: "approve" })}>
                  <Check className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button size="sm" variant="ghost" data-testid={`mileage-reject-${t.id}`}
                  aria-label={`Send back ${t.repName}'s trip with a reason`}
                  onClick={() => {
                    const reason = window.prompt("Why is this being sent back?");
                    if (reason?.trim()) decide.mutate({ id: t.id, action: "reject", reason: reason.trim() });
                  }}>
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

// ── Bookkeeping periods ─────────────────────────────────────────────────────
// A mileage log is read at tax time, and tax time is periodic: a month for
// the books, a quarter for estimated payments, a year for the return. The
// server already filters on from/to, so the period is the one control that
// makes every total on this page answer a real question.
type PeriodKey = "month" | "quarter" | "year" | "all";
const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: "month", label: "This month" },
  { key: "quarter", label: "Quarter" },
  { key: "year", label: "Year" },
  { key: "all", label: "All" },
];
const iso = (d: Date) => d.toISOString().slice(0, 10);
function periodRange(key: PeriodKey): { from?: string; to?: string } {
  const now = new Date();
  if (key === "all") return {};
  if (key === "month") return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
  if (key === "quarter") {
    return { from: iso(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)), to: iso(now) };
  }
  return { from: iso(new Date(now.getFullYear(), 0, 1)), to: iso(now) };
}
const qs = (r: { from?: string; to?: string }) => {
  const parts = [r.from && `from=${r.from}`, r.to && `to=${r.to}`].filter(Boolean);
  return parts.length ? `?${parts.join("&")}` : "";
};

/** The log, grouped the way books are kept: by calendar month, newest first,
 *  each month carrying its own mileage and money subtotal. A flat reverse-
 *  chronological list is fine to scroll and useless to reconcile - nobody
 *  files a return for "the last 40 trips". */
function groupTripsByMonth(trips: Trip[]): Array<{
  key: string; label: string; trips: Trip[]; milesHundredths: number; cents: number;
}> {
  const buckets = new Map<string, { key: string; label: string; trips: Trip[]; milesHundredths: number; cents: number }>();
  for (const trip of trips) {
    const key = (trip.tripDate ?? "").slice(0, 7) || "unknown";
    let bucket = buckets.get(key);
    if (!bucket) {
      const parsed = Date.parse(`${key}-01T00:00:00Z`);
      bucket = {
        key,
        label: Number.isFinite(parsed)
          ? new Date(parsed).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
          : "Undated",
        trips: [], milesHundredths: 0, cents: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.trips.push(trip);
    bucket.milesHundredths += trip.milesHundredths + trip.adjustmentMilesHundredths;
    bucket.cents += (trip.reimbursementCents ?? 0) + trip.adjustmentCents;
  }
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}

export default function Mileage() {
  const canApprove = useCan("mileage.approve");
  const canExport = useCan("mileage.read.team");

  const { data: consent, isError: consentError, refetch: refetchConsent } = useQuery<Consent>({
    queryKey: ["/api/mileage/consent"],
    queryFn: () => get<Consent>("/api/mileage/consent"),
  });
  const { data: trips = [], isLoading, isError: tripsError, refetch: refetchTrips } = useQuery<Trip[]>({
    queryKey: ["/api/mileage/trips"],
    queryFn: () => get<Trip[]>("/api/mileage/trips"),
  });
  const [period, setPeriod] = useState<PeriodKey>("month");
  const range = periodRange(period);
  const { data: summary } = useQuery<Summary>({
    queryKey: ["/api/mileage/summary", period],
    queryFn: () => get<Summary>(`/api/mileage/summary${qs(range)}`),
  });

  const openTrip = trips.find(t => t.startedAt && !t.endedAt) ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 pb-24" data-testid="mileage-page">
      {/* Every rep can export their OWN log; a manager's export widens to
          their branch. The server decides the rows either way. The export
          carries the SELECTED period, so "Year" then "Export" is the whole
          tax-time workflow rather than a full-history dump you then filter in
          a spreadsheet. */}
      <PageHeader
        title="Mileage"
        actions={
          <Button variant="outline" size="sm" data-testid="mileage-export" asChild>
            <a href={`/api/mileage/export${qs(range)}${canExport ? `${qs(range) ? "&" : "?"}scope=team` : ""}`} download>
              Export
            </a>
          </Button>
        }
      />

      {/* Period first: every number under it answers "for which books?".
          Expensify/Revolut put the money and its rate together; a log whose
          total floats free of the period and the rate is not bookkeeping. */}
      <div className="inline-flex w-full rounded-xl border border-border bg-card p-1" role="tablist"
           aria-label="Mileage period">
        {PERIODS.map(p => (
          <button key={p.key} type="button" role="tab" aria-selected={period === p.key}
            onClick={() => setPeriod(p.key)} data-testid={`mileage-period-${p.key}`}
            className={`h-9 min-w-0 flex-1 truncate rounded-lg px-1.5 text-xs font-semibold transition-colors ${
              period === p.key ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {p.label}
          </button>
        ))}
      </div>

      {summary && (
        <Card data-testid="mileage-summary">
          <CardContent className="p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {summary.reimbursementEnabled ? "Reimbursable" : "Deductible mileage"}
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="text-3xl font-bold tabular-nums leading-none tracking-tight text-gold-text"
                    data-testid="mileage-period-total">
                {summary.reimbursementEnabled
                  ? money(summary.approvedCents + summary.pendingEstimateCents)
                  : summary.totalMiles}
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground"
                      data-testid="mileage-total-miles">
                  {summary.totalMiles}
                </span>
                <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground"
                      data-testid="mileage-trip-count">
                  {summary.tripCount} trip{summary.tripCount === 1 ? "" : "s"}
                </span>
                {summary.reimbursementEnabled && (
                  <>
                    <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-emerald-700 dark:text-emerald-400"
                          data-testid="mileage-approved">
                      {money(summary.approvedCents)} approved
                    </span>
                    <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground"
                          data-testid="mileage-pending">
                      {money(summary.pendingEstimateCents)} awaiting
                    </span>
                  </>
                )}
              </span>
            </div>
          </CardContent>
          {!summary.reimbursementEnabled && (
            // The money is off by default. Saying so plainly is the honest
            // alternative to showing a rep a dollar figure nobody has agreed
            // to pay them.
            <CardContent className="border-t pt-3">
              {/* Tracking-only is the INTENDED state, not an unfinished one.
                  The old copy ("has not turned on reimbursement… not being paid
                  yet") read as a missing feature and quietly promised money that
                  is never coming. A 1099 contractor deducts these miles
                  themselves, so the log's value IS the record — say that. */}
              <p className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="mileage-money-off">
                
                Your organization does not reimburse mileage - this log is for your own records.
                Export it for your tax return; as a contractor you deduct these miles yourself.
              </p>
            </CardContent>
          )}
          {summary.reimbursementEnabled && summary.currentRate && (
            <CardContent className="border-t pt-3">
              <p className="text-xs text-muted-foreground" data-testid="mileage-rate">
                Current rate {summary.currentRate.label} · effective {summary.currentRate.effectiveFrom}
              </p>
            </CardContent>
          )}
        </Card>
      )}

      {canApprove && <ApprovalQueue />}

      {/* The GPS tracker hangs off consent — if that fetch fails, say so
          instead of silently removing the whole tracking surface. */}
      {consentError && (
        <Card role="alert" data-testid="mileage-consent-error">
          <CardContent className="flex items-center gap-3 py-4">
            <p className="flex-1 text-sm text-muted-foreground">Couldn't load GPS tracking status.</p>
            <Button variant="outline" size="sm" onClick={() => refetchConsent()}>Retry</Button>
          </CardContent>
        </Card>
      )}
      {consent && <LocationDisclosure consent={consent} />}
      {consent?.mayStartGpsTrip && <GpsTracker openTrip={openTrip} />}
      <ManualEntry rate={summary?.currentRate ?? null} />

      <Card data-testid="mileage-log">
        <CardHeader className="pb-3"><CardTitle className="text-base">My mileage log</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-24 w-full" />
            : tripsError
              // A tax/compliance record must never render a failed fetch as the
              // reassuring "No trips logged yet."
              ? <div role="alert" className="py-6 text-center">
                  <p className="text-sm text-muted-foreground">Couldn't load your trips - the log is unchanged.</p>
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => refetchTrips()}>Retry</Button>
                </div>
            : trips.length === 0
              ? <p className="py-6 text-center text-sm text-muted-foreground">No trips logged yet.</p>
              : groupTripsByMonth(trips).map(month => (
                  <section key={month.key} data-testid={`mileage-month-${month.key}`}>
                    <div className="flex items-baseline justify-between gap-3 border-b border-border py-2">
                      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {month.label}
                      </h3>
                      <span className="text-[11px] font-semibold tabular-nums text-muted-foreground"
                            data-testid={`mileage-month-total-${month.key}`}>
                        {(month.milesHundredths / 100).toFixed(2)} mi
                        {month.cents > 0 ? ` · ${money(month.cents)}` : ""}
                      </span>
                    </div>
                    {month.trips.map(t => <TripRow key={t.id} trip={t} />)}
                  </section>
                ))}
        </CardContent>
      </Card>
    </div>
  );
}
