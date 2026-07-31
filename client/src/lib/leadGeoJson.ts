import { pinDisplayState } from "@shared/knock";
import { toLeadMapStatus } from "@shared/statusConfig";
import { haloFeatureProps, type HaloFeatureProps, type RepColorFn } from "./leadHalos";
import { knockBadgeBucket } from "./statusIcons";

export interface GeoJsonLead {
  id: number;
  lat: number;
  lng: number;
  address: string;
  leadStatus: string;
  visited?: boolean | number | null;
  lastOutcome?: string | null;
  /** Times the door has been knocked — drives the pin's count badge (>1). */
  knockCount?: number | null;
  leadTag?: string | null;
  freshConfidence?: string | null;
  carrier?: string | null;
  assignedRepId?: number | null;
  /** The area the door belongs to — the only link to the crew that works it.
   *  Not read here; it is what the caller's LeadRepIdsFn resolves against. */
  assignedTerritoryId?: number | null;
}

/** Resolves the full ordered rep set for a door. Injected rather than derived
 *  here because the mapping lives in territories (assignee_ids), which this
 *  module has no business knowing about — and because the caller is the only
 *  one who can precompute it per AREA and hand back the same array for every
 *  door in it, keeping this O(1) per lead instead of a scan. */
export type LeadRepIdsFn = (lead: GeoJsonLead) => readonly number[] | null | undefined;

const NO_HALO: HaloFeatureProps = { haloCount: 0 };

export interface LeadPointFeature {
  type: "Feature";
  id: number;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: number;
    status: string;
    address: string;
    visited: number;
    ds: string;
    fresh: number;
    carrier: string;
    assignedRepId: number;
    repColor: string;
    /** Bucketed knock count for the badge: 0 = none, 2..9 exact, 10 = "9+".
     *  Bucketed HERE (not raw) so an 11th knock on a 10-knock door doesn't
     *  invalidate a feature whose icon cannot change. */
    knocks: number;
  } & HaloFeatureProps;
}

export interface CachedLeadFeature {
  signature: string;
  feature: LeadPointFeature;
}

export type LeadFeatureCache = Map<number, CachedLeadFeature>;

export function leadFeatureSignature(
  lead: GeoJsonLead,
  halo: HaloFeatureProps = NO_HALO,
  repColor: string = colorForRep(lead.assignedRepId),
): string {
  const ds = pinDisplayState(lead);
  const fresh = lead.leadTag === "fresh_fiber_confirmed" ? 1 : 0;
  // Halo props are passed IN, never recomputed here: reconcileLeadFeatures
  // needs them for the feature body too, and deriving the rep colours a second
  // time is a whole extra pass over 5k+ doors on every snapshot.
  //
  // haloCount rides the string alongside the ring colours. Past HALO_MAX_RINGS
  // the outermost ring goes neutral slate, so a 4-rep and a 5-rep door carry an
  // IDENTICAL colour list — the count is the only thing still telling them
  // apart, and a prop left stale on a feature is a trap for whatever reads it next.
  return [lead.lng, lead.lat, lead.address, lead.leadStatus, lead.visited ? 1 : 0, lead.lastOutcome ?? "", ds, fresh, lead.carrier ?? "kinetic", lead.assignedRepId ?? 0, repColor, knockBadgeBucket(lead.knockCount), halo.haloCount, halo.halo0 ?? "", halo.halo1 ?? "", halo.halo2 ?? ""].join("\u001f");
}

import { colorForRep } from "@shared/repColors";
export { colorForRep as repColorFor };

/**
 * Reconciles the next lead snapshot in O(n). Unchanged refetches reuse every
 * geometry/feature allocation even though the API produced new JS objects.
 */
export function reconcileLeadFeatures(
  leads: readonly GeoJsonLead[],
  cache: LeadFeatureCache,
  repIdsFor?: LeadRepIdsFn,
  // Persisted-colour resolver (repColorOf over the team payload). Defaults to
  // the legacy hash so every existing caller behaves exactly as before; the
  // caller that HAS team data injects one fn and the pins, halos, and rep-color
  // mode all follow the same stored hue.
  colorFor: RepColorFn = colorForRep,
): {
  data: { type: "FeatureCollection"; features: LeadPointFeature[] };
  byId: Map<number, LeadPointFeature>;
  created: number;
  reused: number;
  removed: number;
  /** When EXACTLY one feature changed and none were added/removed, its lead id.
   * Lets the knock path skip the follow-up full setData when it already painted
   * that one pin imperatively. */
  soleChangedId: number | null;
} {
  const features: LeadPointFeature[] = [];
  const byId = new Map<number, LeadPointFeature>();
  const seen = new Set<number>();
  let created = 0;
  let reused = 0;
  let lastCreatedId: number | null = null;

  for (const lead of leads) {
    if (!Number.isFinite(lead.lat) || !Number.isFinite(lead.lng)) continue;
    seen.add(lead.id);
    // Computed once and used by BOTH the signature and the feature body. When no
    // resolver is supplied (tests, any caller without territory data) every door
    // reports haloCount 0 and carries no slot keys, so the halo layers filter to
    // nothing and the map behaves exactly as it did before halos existed.
    const halo = repIdsFor ? haloFeatureProps(repIdsFor(lead), colorFor) : NO_HALO;
    const repColor = colorFor(lead.assignedRepId);
    const signature = leadFeatureSignature(lead, halo, repColor);
    let cached = cache.get(lead.id);
    if (!cached || cached.signature !== signature) {
      const ds = pinDisplayState(lead);
      cached = {
        signature,
        feature: {
          type: "Feature",
          id: lead.id,
          geometry: { type: "Point", coordinates: [lead.lng, lead.lat] },
          properties: {
            id: lead.id,
            status: toLeadMapStatus(ds),
            address: lead.address,
            visited: lead.visited ? 1 : 0,
            ds,
            fresh: lead.leadTag === "fresh_fiber_confirmed" ? 1 : 0,
            carrier: lead.carrier ?? "kinetic",
            assignedRepId: lead.assignedRepId ?? 0,
            repColor,
            knocks: knockBadgeBucket(lead.knockCount),
            ...halo,
          },
        },
      };
      cache.set(lead.id, cached);
      created++;
      lastCreatedId = lead.id;
    } else {
      reused++;
    }
    features.push(cached.feature);
    byId.set(lead.id, cached.feature);
  }

  let removed = 0;
  for (const id of cache.keys()) {
    if (!seen.has(id)) {
      cache.delete(id);
      removed++;
    }
  }

  return {
    data: { type: "FeatureCollection", features },
    byId,
    created,
    reused,
    removed,
    soleChangedId: created === 1 && removed === 0 ? lastCreatedId : null,
  };
}
