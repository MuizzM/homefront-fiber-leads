import { pinDisplayState } from "@shared/knock";
import { toLeadMapStatus } from "@shared/statusConfig";

export interface GeoJsonLead {
  id: number;
  lat: number;
  lng: number;
  address: string;
  leadStatus: string;
  visited?: boolean | number | null;
  lastOutcome?: string | null;
  leadTag?: string | null;
  freshConfidence?: string | null;
}

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
  };
}

export interface CachedLeadFeature {
  signature: string;
  feature: LeadPointFeature;
}

export type LeadFeatureCache = Map<number, CachedLeadFeature>;

export function leadFeatureSignature(lead: GeoJsonLead): string {
  const ds = pinDisplayState(lead);
  const fresh = lead.leadTag === "fresh_fiber_confirmed" ? 1 : 0;
  return [lead.lng, lead.lat, lead.address, lead.leadStatus, lead.visited ? 1 : 0, lead.lastOutcome ?? "", ds, fresh].join("\u001f");
}

/**
 * Reconciles the next lead snapshot in O(n). Unchanged refetches reuse every
 * geometry/feature allocation even though the API produced new JS objects.
 */
export function reconcileLeadFeatures(
  leads: readonly GeoJsonLead[],
  cache: LeadFeatureCache,
): {
  data: { type: "FeatureCollection"; features: LeadPointFeature[] };
  byId: Map<number, LeadPointFeature>;
  created: number;
  reused: number;
  removed: number;
} {
  const features: LeadPointFeature[] = [];
  const byId = new Map<number, LeadPointFeature>();
  const seen = new Set<number>();
  let created = 0;
  let reused = 0;

  for (const lead of leads) {
    if (!Number.isFinite(lead.lat) || !Number.isFinite(lead.lng)) continue;
    seen.add(lead.id);
    const signature = leadFeatureSignature(lead);
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
          },
        },
      };
      cache.set(lead.id, cached);
      created++;
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

  return { data: { type: "FeatureCollection", features }, byId, created, reused, removed };
}
