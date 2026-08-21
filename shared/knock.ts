// ── Door-knocking domain logic ────────────────────────────────────────────────
// PURE and framework-free (like shared/territory.ts) — the single source of
// truth for knock outcomes, outcome→status mapping, pin display states, and
// next-door routing math. Imported by BOTH server/routes.ts and the client, so
// the outcome list and status mapping can never drift between the two.

import { STATUS_CONFIG } from "./statusConfig";

export type KnockOutcome =
  | "not_home" | "not_interested" | "interested" | "follow_up"
  | "callback" | "sold" | "prospect" | "needs_verification"
  | "already_customer"
  | "competitor" | "renter" | "moving" | "no_soliciting" | "go_back";

export type LeadStatus =
  | "prospect" | "contacted" | "interested" | "sold" | "not_interested" | "follow_up";

export interface OutcomeDef {
  key: KnockOutcome;
  label: string;          // button label
  short: string;          // compact code for the disposition strip (LEAD, ACTV, COMP…)
  color: string;          // hex — button tint AND the pin color the tap produces
  leadStatus: LeadStatus; // canonical status the knock sets
  worked: boolean;        // true = door is done for this pass
  icon: string;           // lucide-react icon NAME — the card maps name → component
}

// Button order = this array order (the rep card renders it verbatim).
// "prospect" is the reset disposition — one tap returns a door to the pool
// (status prospect, pin back to the green down-arrow), logged in history like
// any other change. "callback" folds to follow_up at the DB and presentation
// layers, so it uses the same orange clock status while remaining a card action.
// needs_verification maps to "contacted" — server/history back-compat only.
// `icon` is a lucide-react icon NAME (string) — pins and the card share the
// palette, and the card renders these via a name→component map (ICON_MAP).
// `color` MUST equal the canonical map status color — the card pill, map pin,
// legend, and confirm-flash all read the same presentation contract.
export const OUTCOMES: OutcomeDef[] = [
  { key: "not_home",           label: STATUS_CONFIG.not_home.label,       short: STATUS_CONFIG.not_home.short,       color: STATUS_CONFIG.not_home.color,       leadStatus: "prospect",       worked: false, icon: STATUS_CONFIG.not_home.cardIcon },
  { key: "interested",         label: STATUS_CONFIG.interested.label,     short: STATUS_CONFIG.interested.short,     color: STATUS_CONFIG.interested.color,     leadStatus: "interested",     worked: true,  icon: STATUS_CONFIG.interested.cardIcon },
  { key: "sold",               label: STATUS_CONFIG.sold.label,           short: STATUS_CONFIG.sold.short,           color: STATUS_CONFIG.sold.color,           leadStatus: "sold",           worked: true,  icon: STATUS_CONFIG.sold.cardIcon },
  { key: "not_interested",     label: STATUS_CONFIG.not_interested.label, short: STATUS_CONFIG.not_interested.short, color: STATUS_CONFIG.not_interested.color, leadStatus: "not_interested", worked: true,  icon: STATUS_CONFIG.not_interested.cardIcon },
  { key: "follow_up",          label: STATUS_CONFIG.follow_up.label,      short: STATUS_CONFIG.follow_up.short,      color: STATUS_CONFIG.follow_up.color,      leadStatus: "follow_up",      worked: true,  icon: STATUS_CONFIG.follow_up.cardIcon },
  // Go Back: the "promising door, return later" read. Persists as follow_up
  // (the callback precedent — no new LeadStatus, no schema ripple) while
  // lastOutcome keeps the pink rotate pin distinct from the orange clock.
  { key: "go_back",            label: STATUS_CONFIG.go_back.label,        short: STATUS_CONFIG.go_back.short,        color: STATUS_CONFIG.go_back.color,        leadStatus: "follow_up",      worked: true,  icon: STATUS_CONFIG.go_back.cardIcon },
  // Already a customer: the door is DONE but not hostile. Persists as
  // not_interested (no new LeadStatus, no schema ripple — the callback
  // precedent) while lastOutcome keeps it distinct on the map and card. Going
  // through the normal knock path matters: it wins the outcome CAS, so marking
  // it over an accidental "sold" reverses the commission and, with the
  // latest-knock leaderboard rule, removes the phantom sale from the board.
  { key: "already_customer",   label: STATUS_CONFIG.already_customer.label,     short: STATUS_CONFIG.already_customer.short,     color: STATUS_CONFIG.already_customer.color,     leadStatus: "not_interested", worked: true,  icon: STATUS_CONFIG.already_customer.cardIcon },
  // The four "structurally can't sell today" dispositions. All persist as
  // not_interested — the already_customer precedent — so the funnel, the
  // commission CAS (marking one over an accidental "sold" reverses the money
  // through the normal knock path), and every existing report keep working;
  // lastOutcome is what tells the pins and cards apart. Distinct dispositions
  // matter because they target DIFFERENTLY: a competitor street gets a win-back
  // pass, a renter block gets property-manager outreach, a moving door is a
  // fresh lead in 60 days, and a no-soliciting door is never knocked again.
  { key: "competitor",         label: STATUS_CONFIG.competitor.label,     short: STATUS_CONFIG.competitor.short,     color: STATUS_CONFIG.competitor.color,     leadStatus: "not_interested", worked: true,  icon: STATUS_CONFIG.competitor.cardIcon },
  { key: "renter",             label: STATUS_CONFIG.renter.label,         short: STATUS_CONFIG.renter.short,         color: STATUS_CONFIG.renter.color,         leadStatus: "not_interested", worked: true,  icon: STATUS_CONFIG.renter.cardIcon },
  { key: "moving",             label: STATUS_CONFIG.moving.label,         short: STATUS_CONFIG.moving.short,         color: STATUS_CONFIG.moving.color,         leadStatus: "not_interested", worked: true,  icon: STATUS_CONFIG.moving.cardIcon },
  { key: "no_soliciting",      label: STATUS_CONFIG.no_soliciting.label,  short: STATUS_CONFIG.no_soliciting.short,  color: STATUS_CONFIG.no_soliciting.color,  leadStatus: "not_interested", worked: true,  icon: STATUS_CONFIG.no_soliciting.cardIcon },
  // Callback is an action, not a canonical map status. It persists as follow_up
  // and shares the orange clock pin while retaining a phone affordance on-card.
  { key: "callback",           label: "Callback",                         short: "CB",                               color: STATUS_CONFIG.follow_up.color,      leadStatus: "follow_up",      worked: true,  icon: "Phone" },
  { key: "prospect",           label: STATUS_CONFIG.prospect.label,       short: STATUS_CONFIG.prospect.short,       color: STATUS_CONFIG.prospect.color,       leadStatus: "prospect",       worked: false, icon: STATUS_CONFIG.prospect.cardIcon },
  { key: "needs_verification", label: "Needs Verification", short: "NV", color: "#64748b", leadStatus: "contacted",      worked: true,  icon: "HelpCircle" },
];

// Actions offered for new field dispositions. Callback remains in OUTCOMES so
// historical records and old offline queues can still be read/synced, but it is
// intentionally unavailable for new entries on every current UI surface.
export const FIELD_OUTCOMES: OutcomeDef[] = OUTCOMES.filter(
  (outcome) => outcome.key !== "callback" && outcome.key !== "needs_verification",
);

export const OUTCOME_TO_STATUS: Record<KnockOutcome, LeadStatus> =
  Object.fromEntries(OUTCOMES.map(o => [o.key, o.leadStatus])) as Record<KnockOutcome, LeadStatus>;

export const OUTCOME_META: Record<KnockOutcome, OutcomeDef> =
  Object.fromEntries(OUTCOMES.map(o => [o.key, o])) as Record<KnockOutcome, OutcomeDef>;

export function isKnockOutcome(v: unknown): v is KnockOutcome {
  return typeof v === "string" && OUTCOMES.some(o => o.key === v);
}

// Outcomes valid for a BULK status edit (Sales Rabbit "Modify Status"). Only the
// dispositions whose pin display is determined by `leadStatus` ALONE, so a bulk
// edit — which writes just leadStatus, with no knock, no GPS, and no commission —
// always renders correctly on the map. Deliberately EXCLUDES: `sold` (a real
// field sale that must mint a commission, never a bulk toggle) and `not_home` /
// `callback` (their pin display needs a real knock's lastOutcome, which a bulk
// edit doesn't create). Used by BOTH the lasso UI (the offered options) and the
// server endpoint (validation) so they can't drift.
export const BULK_STATUS_OUTCOMES: KnockOutcome[] = ["prospect", "interested", "follow_up", "not_interested"];
export function isBulkStatusOutcome(v: unknown): v is KnockOutcome {
  return typeof v === "string" && (BULK_STATUS_OUTCOMES as string[]).includes(v);
}

// wasHome is DERIVED, never client-supplied — the server overwrites any value in
// the request body with this, so it can never contradict the outcome.
export function deriveWasHome(outcome: KnockOutcome): boolean {
  return outcome !== "not_home";
}

// ── Pin display state — the map states the rep sees ───────────────────────────
// A projection of {leadStatus, visited, lastOutcome} the map API already returns.
// One state per rep disposition: unworked (Prospect), not_home, interested,
// follow_up, callback, sold, not_interested — plus legacy "contacted"
// (needs_verification only, never offered on the rep card).
export type PinDisplayState =
  | "unworked" | "not_home" | "contacted" | "interested"
  | "follow_up" | "callback" | "sold" | "not_interested" | "already_customer"
  | "competitor" | "renter" | "moving" | "no_soliciting" | "go_back";

// Canonical field-map palette. Callback aliases Follow-up, while the legacy
// Contacted state stays slate until it receives a current disposition. The
// competition dispositions (competitor/renter/moving/no_soliciting under
// not_interested; go_back under follow_up) resolve exactly like
// already_customer/callback: shared stored status, own display state.
export const STATE_COLORS: Record<PinDisplayState, string> = {
  unworked:       STATUS_CONFIG.prospect.color,
  not_home:       STATUS_CONFIG.not_home.color,
  contacted:      "#64748b", // SLATE — touched
  interested:     STATUS_CONFIG.interested.color,
  follow_up:      STATUS_CONFIG.follow_up.color,
  callback:       STATUS_CONFIG.follow_up.color,
  sold:           STATUS_CONFIG.sold.color,
  not_interested: STATUS_CONFIG.not_interested.color,
  already_customer: STATUS_CONFIG.already_customer.color,
  competitor:     STATUS_CONFIG.competitor.color,
  renter:         STATUS_CONFIG.renter.color,
  moving:         STATUS_CONFIG.moving.color,
  no_soliciting:  STATUS_CONFIG.no_soliciting.color,
  go_back:        STATUS_CONFIG.go_back.color,
};

// Human labels for the display states — lives HERE beside STATE_COLORS so the
// vocabulary is defined once (search rows, leads panel, any future consumer).
export const STATE_LABELS: Record<PinDisplayState, string> = {
  unworked: STATUS_CONFIG.prospect.label, not_home: STATUS_CONFIG.not_home.label, contacted: "Contacted",
  interested: STATUS_CONFIG.interested.label, follow_up: STATUS_CONFIG.follow_up.label, callback: "Callback",
  sold: STATUS_CONFIG.sold.label, not_interested: STATUS_CONFIG.not_interested.label,
  already_customer: STATUS_CONFIG.already_customer.label,
  competitor: STATUS_CONFIG.competitor.label, renter: STATUS_CONFIG.renter.label,
  moving: STATUS_CONFIG.moving.label, no_soliciting: STATUS_CONFIG.no_soliciting.label,
  go_back: STATUS_CONFIG.go_back.label,
};

// The outcomes that share a stored leadStatus and are told apart by
// lastOutcome. ONE list per stored status, read by pinDisplayState below —
// adding a disposition to the not_interested family is a one-line change that
// cannot forget the projection.
const NOT_INTERESTED_VARIANTS: readonly KnockOutcome[] =
  ["already_customer", "competitor", "renter", "moving", "no_soliciting"];
const FOLLOW_UP_VARIANTS: readonly KnockOutcome[] = ["callback", "go_back"];

// Display state → the outcome whose button mirrors it as "pressed". Shared by
// every disposition surface (map card, Today/PropertyDetail sheet, manager
// quick-log) so the active-state mirror can never disagree between them.
// Legacy contacted/needs_verification deliberately have no entry — nothing on
// a current surface should light up for them.
export const DS_TO_OUTCOME: Partial<Record<PinDisplayState, KnockOutcome>> = {
  unworked: "prospect", not_home: "not_home", interested: "interested",
  follow_up: "follow_up", callback: "callback", sold: "sold",
  not_interested: "not_interested", already_customer: "already_customer",
  competitor: "competitor", renter: "renter", moving: "moving",
  no_soliciting: "no_soliciting", go_back: "go_back",
};

export function pinDisplayState(p: {
  leadStatus: string; visited?: boolean | number | null; lastOutcome?: string | null;
}): PinDisplayState {
  switch (p.leadStatus) {
    case "sold":           return "sold";
    case "not_interested":
      // Same mechanism as callback under follow_up: the stored status is shared,
      // the last outcome tells the variants apart on every surface.
      return (NOT_INTERESTED_VARIANTS as readonly string[]).includes(p.lastOutcome ?? "")
        ? (p.lastOutcome as PinDisplayState)
        : "not_interested";
    case "follow_up":
      // Callback/Go Back are first-class on the map/card though they store follow_up.
      return (FOLLOW_UP_VARIANTS as readonly string[]).includes(p.lastOutcome ?? "")
        ? (p.lastOutcome as PinDisplayState)
        : "follow_up";
    case "interested":     return "interested";
    case "contacted":      return "contacted";
    default: // "prospect" — fresh, knocked-not-home, or explicitly reset
      if (p.lastOutcome === "not_home") return "not_home";
      // A "prospect" tap RESETS the door: back to the pool, orange again.
      if (p.lastOutcome === "prospect") return "unworked";
      // Knocked but status unchanged (defensive) still reads as worked.
      return p.visited ? "contacted" : "unworked";
  }
}

// ── Lasso selection summary (Sales Rabbit-style) ──────────────────────────────
// PURE. Given a set of selected pins, return the per-display-state counts in the
// canonical palette order (only states actually present). Powers the lasso panel's
// "breakdown by status" chips and the refine-by-status filter. One place so the
// map, the count, and the bulk-action target set can never disagree.
export interface DisplayStateCount { ds: PinDisplayState; count: number }

export function summarizeByDisplayState(
  items: Array<{ leadStatus: string; visited?: boolean | number | null; lastOutcome?: string | null }>,
): DisplayStateCount[] {
  const counts = {} as Record<PinDisplayState, number>;
  for (const it of items) {
    const ds = pinDisplayState(it);
    counts[ds] = (counts[ds] ?? 0) + 1;
  }
  return (Object.keys(STATE_COLORS) as PinDisplayState[])
    .filter((ds) => (counts[ds] ?? 0) > 0)
    .map((ds) => ({ ds, count: counts[ds] }));
}

// ── Geometry / next-door routing ──────────────────────────────────────────────
export interface LatLng { lat: number; lng: number }

export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export interface RoutablePin extends LatLng {
  id: number;
  leadStatus: string;
  visited?: boolean | number | null;
  lastOutcome?: string | null;
  leadScore?: number | null;
}

// Next Door candidates: unworked OR not_home (a not-home door is the highest-value
// revisit, never a dead end). Sort: distance asc → leadScore desc → id asc (stable).
// Returns null when everything in range is worked.
export function nearestUnworkedLead(
  from: LatLng,
  pins: RoutablePin[],
  excludeIds: ReadonlySet<number> = new Set(),
): RoutablePin | null {
  let best: RoutablePin | null = null;
  let bestD = Infinity;
  for (const p of pins) {
    if (excludeIds.has(p.id)) continue;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const st = pinDisplayState(p);
    if (st !== "unworked" && st !== "not_home") continue;
    const d = haversineMeters(from, p);
    if (d < bestD - 0.5) { best = p; bestD = d; continue; }
    // Within half a meter = same house row; prefer the better lead, then lower id.
    if (Math.abs(d - bestD) <= 0.5 && best) {
      const ps = p.leadScore ?? 0, bs = best.leadScore ?? 0;
      if (ps > bs || (ps === bs && p.id < best.id)) { best = p; bestD = Math.min(d, bestD); }
    }
  }
  return best;
}

// Compact distance hint for the Next Door button ("40m" / "0.3mi").
export function distanceHint(meters: number): string {
  if (meters < 400) return `${Math.round(meters)}m`;
  return `${(meters / 1609.34).toFixed(1)}mi`;
}

// Local-calendar date as "YYYY-MM-DD". Callback dates are the rep's own picked
// local date, so grouping/counting them MUST use local — never UTC (toISOString),
// which rolls a day early every evening in the Americas. Shared so the Today
// badge and the Follow-ups page can never disagree.
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Offline queue item (persisted shape — logic in client/src/lib/knockQueue.ts) ─
export interface QueuedKnock {
  clientId: string;             // idempotency key
  leadId: number;
  repId: number;
  outcome: KnockOutcome;
  knockedAt: string;            // ISO, time of the TAP (not the flush)
  notes: string | null;
  callbackDate: string | null;  // "YYYY-MM-DD"
  callbackTime: string | null;  // "HH:mm"
  attempts: number;             // transient-failure attempts so far
  nextAttemptAt: number;        // epoch ms; flush skips items not yet due
  lastError: string | null;
  // ── Location evidence captured AT THE TAP (server computes distance+verdict) ──
  // All optional so legacy queue items and location-denied taps still flush.
  repLat?: number | null;
  repLng?: number | null;
  gpsAccuracy?: number | null;
  deviceTs?: string | null;     // device clock at the tap
  mockLocation?: boolean | null;
  netState?: "online" | "offline" | null;
  appVersion?: string | null;
}

export const KNOCK_QUEUE_MAX_ATTEMPTS = 8;

// 2s, 4s, 8s, … capped at 60s — a dead connection costs at most one request/min.
export function retryDelayMs(attempts: number): number {
  return Math.min(2000 * 2 ** attempts, 60_000);
}

export function makeClientId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      return crypto.randomUUID();
  } catch { /* sandboxed environments may block crypto */ }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}`;
}
