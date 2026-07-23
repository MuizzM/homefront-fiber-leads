// Render-time lead/pin deduplication.
//
// The server already enforces one lead per canonical address (the leads
// UNIQUE(tenant_id, canonical_key) index). This is a defensive CLIENT layer for
// the cases that still reach the map with two records on one house: the
// incremental SSE scan-pin bridge, in-flight optimistic updates, and legacy
// rows. It guarantees the two things the map needs — one marker per physical
// house, and a stable unique React key per rendered row — without mutating the
// source array.

export interface DedupableLead {
  id: number | string;
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  // Optional priority signals — used to pick the survivor when two records
  // collapse. All optional so any lead-ish shape can be deduped.
  leadScore?: number | null;
  leadTag?: string | null;
  lastKnockedAt?: string | null;
  // Attached to the survivor when >1 record merged (so a popup can surface all).
  mergedLeadIds?: string[];
  mergedCount?: number;
}

import { canonicalAddressPart } from "@shared/addressKey";

// A physical "house" identity — ADDRESS-FIRST, using the server's own canonical
// normalizer (one alias table for both sides), geo only as the fallback.
//
// The old key preferred rounded coordinates (5 decimals ≈ 1.1 m) with a comment
// claiming "two real neighbours never collide" — the real DB proved 29 lead-
// cells (58 leads) DO collide at that rounding (townhouse/duplex neighbours were
// silently hidden behind one pin), while the same house under two spellings
// ("Poplar Tr" vs "Poplar Trl") geocoded >1.1 m apart rendered TWO green
// arrows. Address-first fixes both directions: neighbours differ in house
// number (never merge), spelling variants fold to one canonical key (always
// merge). Coordinates only identify records with NO usable street address.
export function houseKey(lead: DedupableLead): string | null {
  const addr = canonicalAddressPart(String(lead.address ?? ""));
  if (addr) {
    return `addr:${addr}|${canonicalAddressPart(String(lead.city ?? ""))}|${canonicalAddressPart(String(lead.state ?? ""))}`;
  }
  const { lat, lng } = lead;
  if (typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)) {
    return `geo:${lat.toFixed(5)},${lng.toFixed(5)}`;
  }
  return null;
}

// Same-rooftop secondary identity: rounded coordinate + house number. Catches
// the cross-city-name twin (same rooftop, different postal city → different
// address keys) WITHOUT hiding real neighbours (a neighbour differs in house
// number). Null when either part is missing.
function rooftopKey(lead: DedupableLead): string | null {
  const { lat, lng } = lead;
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const houseNum = String(lead.address ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^\d+$/.test(houseNum)) return null;
  return `roof:${lat.toFixed(4)},${lng.toFixed(4)}|${houseNum}`;
}

// A stable, unique React key. `id` alone can arrive as a string vs number, or
// (rarely) collide across records, so compose it with the coordinate — after
// dedup every surviving row has a distinct house, making this unique. NEVER the
// array index (rows reorder/filter every pan).
export function leadKey(lead: DedupableLead): string {
  const lat = typeof lead.lat === "number" ? lead.lat : "na";
  const lng = typeof lead.lng === "number" ? lead.lng : "na";
  return `${String(lead.id)}-${lat}-${lng}`;
}

// Higher-priority survivor when two records share a house. Deterministic:
// fresh-fiber-confirmed > higher lead score > more recently knocked > lowest id
// (the final tiebreak keeps the result stable across renders).
function priorityRank(lead: DedupableLead): [number, number, number, number] {
  const fresh = lead.leadTag === "fresh_fiber_confirmed" ? 1 : 0;
  const score = Number.isFinite(lead.leadScore as number) ? (lead.leadScore as number) : 0;
  const knocked = lead.lastKnockedAt ? Date.parse(lead.lastKnockedAt) || 0 : 0;
  // Negative id so that, at equal priority, the LOWEST id wins under a
  // descending comparison — the stable, deterministic choice.
  const idNum = typeof lead.id === "number" ? lead.id : Number(lead.id) || 0;
  return [fresh, score, knocked, -idNum];
}
function isHigherPriority(candidate: DedupableLead, current: DedupableLead): boolean {
  const a = priorityRank(candidate), b = priorityRank(current);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * Collapse leads that share a physical house to ONE pin. Returns a NEW array
 * (source untouched); the survivor of a merged group carries `mergedLeadIds`
 * (all collapsed ids, survivor first) and `mergedCount` so a popup can surface
 * every underlying lead. Records with no usable house key pass through
 * unchanged. Order: first-seen house order, then the passthrough rows.
 */
export function dedupeLeads<T extends DedupableLead>(
  leads: readonly T[],
): Array<T> {
  if (!Array.isArray(leads) || leads.length === 0) return [];
  const survivors = new Map<string, T>();
  const groupIds = new Map<string, string[]>();
  const passthrough: T[] = [];

  for (const lead of leads) {
    const key = houseKey(lead);
    if (key == null) { passthrough.push(lead); continue; }
    const current = survivors.get(key);
    if (!current) {
      survivors.set(key, lead);
      groupIds.set(key, [String(lead.id)]);
      continue;
    }
    // Merge: record both ids, keep the higher-priority record as the survivor.
    const ids = groupIds.get(key)!;
    if (isHigherPriority(lead, current)) {
      survivors.set(key, lead);
      ids.unshift(String(lead.id));      // survivor id first
    } else {
      ids.push(String(lead.id));
    }
  }

  // SECOND PASS — same-rooftop merge. Two survivors whose ADDRESS keys differ
  // (boundary houses carry different postal cities across data sources) but
  // that sit on the same rounded rooftop with the same house number are one
  // physical door. Group survivors by rooftopKey and collapse again.
  const byRoof = new Map<string, string>(); // rooftopKey -> surviving houseKey
  for (const [key, survivor] of [...survivors]) {
    const roof = rooftopKey(survivor);
    if (!roof) continue;
    const winnerKey = byRoof.get(roof);
    if (winnerKey == null) { byRoof.set(roof, key); continue; }
    const winner = survivors.get(winnerKey)!;
    const winnerIds = groupIds.get(winnerKey)!;
    const loserIds = groupIds.get(key)!;
    if (isHigherPriority(survivor, winner)) {
      groupIds.set(key, [...loserIds, ...winnerIds]);
      survivors.delete(winnerKey);
      groupIds.delete(winnerKey);
      byRoof.set(roof, key);
    } else {
      groupIds.set(winnerKey, [...winnerIds, ...loserIds]);
      survivors.delete(key);
      groupIds.delete(key);
    }
  }

  const out: T[] = [];
  for (const [key, survivor] of survivors) {
    const ids = groupIds.get(key)!;
    // Only allocate a new object for genuinely-merged houses; singletons keep
    // their original reference (no mutation, cheaper, referential stability).
    out.push(ids.length > 1 ? { ...survivor, mergedLeadIds: ids, mergedCount: ids.length } : survivor);
  }
  for (const p of passthrough) out.push(p);
  return out;
}
