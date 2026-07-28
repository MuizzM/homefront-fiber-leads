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
  | "follow_up";

export type PinShape = "teardrop" | "down_arrow";
export type PinGlyph = "door" | "star" | "dollar" | "x" | "clock" | "none";

export interface LeadStatusConfig {
  label: string;
  color: string;
  shape: PinShape;
  glyph: PinGlyph;
  cardIcon: "DoorClosed" | "Star" | "DollarSign" | "X" | "ArrowDown" | "Clock";
  /** Text/icon colour for use ON THE DARK CARD. `color` is tuned for a filled
   *  map pin (white glyph on a saturated fill) and a few of those are far too
   *  dark to use as TEXT on a dark sheet — sold's #14532D lands at 2.1:1 against
   *  the card, well under the 4.5:1 minimum, so the status line was effectively
   *  invisible. Defaults to `color` where the pin colour is already legible. */
  onDark?: string;
}

export const STATUS_CONFIG: Readonly<Record<LeadMapStatus, Readonly<LeadStatusConfig>>> = {
  not_home: {
    label: "Not Home", color: "#EAB308", shape: "teardrop", glyph: "door", cardIcon: "DoorClosed",
  },
  interested: {
    label: "Interested", color: "#8B5CF6", shape: "teardrop", glyph: "star", cardIcon: "Star",
  },
  sold: {
    // Deep dark green — clearly distinct from prospect (#16A34A) on the map.
    // The pin stays deep green (it must stay distinct from prospect on the map);
    // the card uses a lighter emerald so "SOLD" is actually readable — 10:1.
    label: "Sold", color: "#14532D", shape: "teardrop", glyph: "dollar", cardIcon: "DollarSign",
    onDark: "#34D399",
  },
  not_interested: {
    label: "Not Interested", color: "#EF4444", shape: "teardrop", glyph: "x", cardIcon: "X",
  },
  prospect: {
    label: "Prospect", color: "#16A34A", shape: "down_arrow", glyph: "none", cardIcon: "ArrowDown",
  },
  follow_up: {
    label: "Follow-up", color: "#F97316", shape: "teardrop", glyph: "clock", cardIcon: "Clock",
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
