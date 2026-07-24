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
    label: "Sold", color: "#14532D", shape: "teardrop", glyph: "dollar", cardIcon: "DollarSign",
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
