export interface DiscoveryMapPoint {
  canonicalAddressId?: string | number | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  lat: number;
  lng: number;
  scanStatus?: string | null;
  fiberStatus?: string | null;
  billingStatus?: string | null;
  maxDownloadMbps?: number | null;
  householdSegmentType?: string | null;
  apiSource?: string | null;
}

/** Mutates the session-scoped feature index with rep-visible results only.
 * Candidates, negatives, active-service addresses and inconclusive checks are
 * deliberately ignored; the durable lead projector is the publication gate. */
export function applyDiscoveryMapPointBatch(
  features: Map<string, any>,
  jobId: string,
  points: DiscoveryMapPoint[],
  receivedAt = Date.now(),
): number {
  let changed = 0;
  for (const point of points) {
    const scanStatus = String(point.scanStatus ?? "").toLowerCase();
    const billingStatus = String(point.billingStatus ?? "").toUpperCase();
    if (scanStatus !== "fresh_confirmed" || billingStatus === "Y") continue;
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const canonicalId = point.canonicalAddressId
      ?? `${String(point.address ?? "address").toLowerCase()}|${lat.toFixed(6)}|${lng.toFixed(6)}`;
    const key = `${jobId}:${canonicalId}`;
    const previous = features.get(key);
    features.set(key, {
      type: "Feature",
      id: key,
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        ...(previous?.properties ?? {}),
        jobId,
        canonicalAddressId: String(canonicalId),
        receivedAt,
        address: String(point.address ?? previous?.properties?.address ?? "Address"),
        city: String(point.city ?? previous?.properties?.city ?? ""),
        state: String(point.state ?? previous?.properties?.state ?? ""),
        zip: String(point.zip ?? previous?.properties?.zip ?? ""),
        scanStatus,
        fiberStatus: point.fiberStatus ?? previous?.properties?.fiberStatus ?? null,
        isNewFiber: true,
        billingStatus: point.billingStatus ?? previous?.properties?.billingStatus ?? null,
        maxDownloadMbps: point.maxDownloadMbps ?? previous?.properties?.maxDownloadMbps ?? null,
        householdSegmentType: point.householdSegmentType ?? previous?.properties?.householdSegmentType ?? null,
        apiSource: point.apiSource ?? previous?.properties?.apiSource ?? null,
      },
    });
    changed++;
  }
  return changed;
}
