import {
  geometryBbox as sharedGeometryBbox,
  pointInDiscoveryGeometry,
  type Bbox,
  type DiscoveryGeometry as SharedDiscoveryGeometry,
  type Position as SharedPosition,
} from "@shared/addressDiscovery";

export type Position = SharedPosition;
export type DiscoveryGeometry = SharedDiscoveryGeometry;
export type DiscoveryBBox = Bbox;

export type SourceCoverageClass = "authoritative" | "primary" | "supplemental" | "evidence_only";

export interface AddressSourceMetadata {
  id: string;
  label: string;
  coverageClass: SourceCoverageClass;
  authoritative: boolean;
  evidenceOnly: boolean;
  licenseName: string;
  licenseUrl: string | null;
  defaultPriority: number;
}

export interface SourceAddressRecord {
  sourceRecordId: string;
  sourceId?: string;
  fullAddress: string;
  houseNumber?: string | null;
  street?: string | null;
  unit?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  lat?: number | null;
  lng?: number | null;
  coordinateQuality?: "rooftop" | "entrance" | "parcel" | "building_centroid" | "interpolated" | "unknown";
  confidence?: number;
  inferred?: boolean;
  authoritative?: boolean;
  licenseName?: string | null;
  licenseUrl?: string | null;
  observedAt?: string;
  evidenceKind?: string;
  raw: unknown;
}

export interface SourcePage {
  records: SourceAddressRecord[];
  partial: boolean;
  nextCursor?: string | null;
  diagnostics?: Record<string, unknown>;
}

export interface AddressSourceContext {
  tenantId: number;
  jobId: string;
  tileId: string;
  bbox: DiscoveryBBox;
  geometry: DiscoveryGeometry;
  city: string | null;
  state: string;
  cursor?: string | null;
  signal: AbortSignal;
  // True for an operator-ELECTED area scan (a box drawn on the field map): a
  // deliberate, bounded request that gets the densest, highest-capped address
  // enumeration. False/undefined for background market/town harvests, which
  // stay on the conservative cap. Set by the engine from the job.
  thorough?: boolean;
}

export interface AddressSourceAdapter {
  metadata: AddressSourceMetadata;
  available(tenantId: number): boolean;
  healthCheck(tenantId: number): Promise<{ ok: boolean; message?: string }>;
  discover(context: AddressSourceContext): Promise<SourcePage>;
}

export function geometryBBox(geometry: DiscoveryGeometry): DiscoveryBBox {
  return sharedGeometryBbox(geometry);
}

export function pointInGeometry(lng: number, lat: number, geometry: DiscoveryGeometry): boolean {
  return pointInDiscoveryGeometry([lng, lat], geometry);
}

export function bboxPolygon(bbox: DiscoveryBBox): DiscoveryGeometry {
  return {
    type: "Polygon",
    coordinates: [[
      [bbox.west, bbox.south], [bbox.east, bbox.south], [bbox.east, bbox.north],
      [bbox.west, bbox.north], [bbox.west, bbox.south],
    ]],
  };
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
