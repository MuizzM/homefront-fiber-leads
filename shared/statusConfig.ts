/**
 * Canonical field-status presentation contract.
 *
 * This is intentionally framework-free so the map, lead card, server-shared
 * outcome model, tests, and any future native client read the same values.
 * Callback persists as follow_up and therefore uses the follow-up pin; legacy
 * contacted records fall back to prospect until they receive a real disposition.
 */
export type LeadMapStatus =
  | "not_home"
  | "interested"
  | "sold"
  | "not_interested"
  | "prospect"
  | "follow_up"
  | "already_customer"
  | "competitor"
  | "renter"
  | "moving"
  | "no_soliciting"
  | "go_back";

// Every live status renders as "circle" (SalesRabbit-style flat disc with a
// white inner glyph). The legacy members stay in the union so downstream code
// typed against the old vocabulary keeps compiling — the exported contract is
// append-only, the DATA below is what changed.
export type PinShape = "circle" | "teardrop" | "down_arrow";
export type PinGlyph =
  | "door" | "star" | "dollar" | "x" | "clock" | "user" | "arrow"
  | "flag" | "key" | "truck" | "ban" | "rotate" | "none";

export interface LeadStatusConfig {
  label: string;
  /** Compact fixed-width code for the disposition strip and dense chips —
   *  the SalesRabbit/SalesHub vocabulary reps already know from other tools
   *  (LEAD, ACTV, COMP, RENT…). Uppercase, 2–4 chars, unique per status. */
  short: string;
  color: string;
  shape: PinShape;
  glyph: PinGlyph;
  cardIcon:
    | "DoorClosed" | "Star" | "DollarSign" | "X" | "ArrowDown" | "Clock" | "UserCheck"
    | "Flag" | "KeyRound" | "Truck" | "Ban" | "RotateCcw";
  /** Text/icon colour for use ON THE DARK CARD. `color` is tuned for a filled
   *  map pin (white glyph on a saturated fill) and a few of those are far too
   *  dark to use as TEXT on a dark sheet — sold's #14532D lands at 2.1:1 against
   *  the card, well under the 4.5:1 minimum, so the status line was effectively
   *  invisible. Defaults to `color` where the pin colour is already legible. */
  onDark?: string;
}

export const STATUS_CONFIG: Readonly<Record<LeadMapStatus, Readonly<LeadStatusConfig>>> = {
  not_home: {
    label: "Not Home", short: "NH", color: "#EAB308", shape: "circle", glyph: "door", cardIcon: "DoorClosed",
  },
  interested: {
    label: "Interested", short: "INT", color: "#8B5CF6", shape: "circle", glyph: "star", cardIcon: "Star",
  },
  sold: {
    // Deep dark green — clearly distinct from prospect (#16A34A) on the map.
    // The pin stays deep green (it must stay distinct from prospect on the map);
    // the card uses a lighter emerald so "SOLD" is actually readable — 10:1.
    label: "Sold", short: "SOLD", color: "#14532D", shape: "circle", glyph: "dollar", cardIcon: "DollarSign",
    onDark: "#34D399",
  },
  not_interested: {
    label: "Not Interested", short: "NI", color: "#EF4444", shape: "circle", glyph: "x", cardIcon: "X",
  },
  prospect: {
    // "LEAD" — the industry code for a fresh/reset door, and the word reps
    // carry over from SalesRabbit-family tools. Label stays Prospect.
    label: "Prospect", short: "LEAD", color: "#16A34A", shape: "circle", glyph: "arrow", cardIcon: "ArrowDown",
  },
  follow_up: {
    label: "Follow-up", short: "FU", color: "#F97316", shape: "circle", glyph: "clock", cardIcon: "Clock",
  },
  already_customer: {
    // BLUE, deliberately outside the hot/cold axis every other pin sits on. The
    // door is closed but NOT hostile: a red street reads "burned turf", a blue
    // one reads "competitor's block — or ours already", which is targeting
    // data. blue-600 fill keeps the white glyph legible in sunlight; the card
    // uses blue-400 for the 4.5:1 dark-sheet minimum (same split as sold).
    // "ACTV" = active service at this address.
    label: "Already a Customer", short: "ACTV", color: "#2563EB", shape: "circle", glyph: "user", cardIcon: "UserCheck",
    onDark: "#60A5FA",
  },
  // ── Field-competition dispositions (SalesHub/SalesRabbit parity, Aug 2026) ──
  // Four "structurally can't sell today" reads plus one "promising, return"
  // read. All five persist through the existing status columns (see
  // shared/knock.ts — the already_customer/callback precedent: leadStatus
  // stays canonical, lastOutcome tells the pins apart), so no schema ripple.
  competitor: {
    // Burnt orange-700 — the hue family says "attention", the darkness keeps it
    // clearly apart from follow-up's bright #F97316 at arm's length; the flag
    // glyph does the rest. Card text needs the orange-400 lift (3.7:1 → 8.5:1).
    label: "Competitor", short: "COMP", color: "#C2410C", shape: "circle", glyph: "flag", cardIcon: "Flag",
    onDark: "#FB923C",
  },
  renter: {
    // Warm stone-500 — a neutral "no decision to win here" gray, deliberately
    // warm so it never collides with the cool slate legacy-contacted pin. Key
    // glyph: the house isn't theirs. Card uses stone-300 (4.0:1 → 12.9:1).
    label: "Renter", short: "RENT", color: "#78716C", shape: "circle", glyph: "key", cardIcon: "KeyRound",
    onDark: "#D6D3D1",
  },
  moving: {
    // Cyan-600 — transitional, sits between already-customer blue and prospect
    // green without reading as either; 5.2:1 on the card so no override.
    label: "Moving", short: "MOV", color: "#0891B2", shape: "circle", glyph: "truck", cardIcon: "Truck",
  },
  no_soliciting: {
    // Slate-700 — the hard stop. Near-black like the reference's NOSO pin but
    // not a void, so the ban glyph still reads as a drawn mark in sunlight.
    // Card needs slate-300 (1.9:1 → 12.9:1).
    label: "No Soliciting", short: "NOSO", color: "#334155", shape: "circle", glyph: "ban", cardIcon: "Ban",
    onDark: "#CBD5E1",
  },
  go_back: {
    // Pink-500 — the one warm hue still free. Go Back is follow-up's sibling
    // (it persists as follow_up), but a second orange pin would be untellable
    // on the street; layout groups them, hue separates them. 5.5:1 on card.
    label: "Go Back", short: "GB", color: "#EC4899", shape: "circle", glyph: "rotate", cardIcon: "RotateCcw",
  },
} as const;

export const LEAD_MAP_STATUSES = Object.freeze(Object.keys(STATUS_CONFIG) as LeadMapStatus[]);

export function isLeadMapStatus(value: unknown): value is LeadMapStatus {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STATUS_CONFIG, value);
}

/** Maps internal/legacy display states onto the six public pin designs. */
export function toLeadMapStatus(value: unknown): LeadMapStatus {
  if (isLeadMapStatus(value)) return value;
  if (value === "unworked" || value === "contacted") return "prospect";
  if (value === "callback") return "follow_up";
  return "prospect";
}
