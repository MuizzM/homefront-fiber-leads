export interface LeadMapTarget {
  leadId: number;
  lat?: number;
  lng?: number;
}
type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const LEAD_MAP_TARGET_KEY = "homefront:field-map-target";

function validLeadId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validLat(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

function validLng(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

function browserSessionStore(): SessionStore | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Hand one lead from the list to the kept-alive Field Map without putting a
 * customer address or coordinates in the URL. The payload is tab-scoped and
 * consumed exactly once when the map becomes active.
 */
export function queueLeadMapTarget(
  target: LeadMapTarget,
  store: SessionStore | null = browserSessionStore(),
): boolean {
  if (!store || !validLeadId(target.leadId)) return false;
  const payload: LeadMapTarget = { leadId: target.leadId };
  if (validLat(target.lat) && validLng(target.lng)) {
    payload.lat = target.lat;
    payload.lng = target.lng;
  }
  try {
    store.setItem(LEAD_MAP_TARGET_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function takeLeadMapTarget(
  store: SessionStore | null = browserSessionStore(),
): LeadMapTarget | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(LEAD_MAP_TARGET_KEY);
    store.removeItem(LEAD_MAP_TARGET_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LeadMapTarget>;
    if (!validLeadId(parsed.leadId)) return null;
    const target: LeadMapTarget = { leadId: parsed.leadId };
    if (validLat(parsed.lat) && validLng(parsed.lng)) {
      target.lat = parsed.lat;
      target.lng = parsed.lng;
    }
    return target;
  } catch {
    return null;
  }
}
