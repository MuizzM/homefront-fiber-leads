// ── Scan Intelligence client API ──────────────────────────────────────────────
// Typed fetchers over the /api/scan/* intelligence endpoints. Reads are cheap
// (pure DB, no proxy); the run POST is the only spend and is admin-gated
// server-side. Shapes mirror the server services.
import { apiRequest } from "@/lib/queryClient";

export interface MarketCard {
  city: string; state: string;
  poolSize: number; verified: number; verifiedNewFiber: number; newlyLive: number;
  leads: number; unworkedLeads: number; workedLeads: number; soldLeads: number;
  lastVerifiedAtMs: number | null; lastLeadAtMs?: number | null;
  coverage: number; saturation: number; freshnessDays: number | null;
  estRemainingOpportunity: number; contactRate: number | null; conversionRate: number | null;
  priority: number; priorityBand: "hot" | "warm" | "cool" | "cold";
  confidence: "high" | "medium" | "low"; reasons: string[];
}
export interface MarketsResponse { markets: MarketCard[]; rate: { usdPerGb: number; bytesPerCheck: number } }

export interface CostEstimate { checks: number; estBytes: number; estGb: number; estUsd: number; bytesPerCheck: number; usdPerGb: number }
export interface BudgetTier { key: string; label: string; checks: number; blurb: string; cost: CostEstimate }
export interface MarketDetail {
  card: MarketCard; remaining: number; tiers: BudgetTier[]; rate: { usdPerGb?: number; bytesPerCheck?: number };
}

export interface OppCluster {
  id: string; points: number[]; size: number;
  centroid: { lat: number; lng: number };
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  hull: Array<[number, number]>;
  newFiber: number; newlyLive: number; unworked: number; sold: number;
  avgScore: number; competitorShare: number; freshnessDays: number | null;
  score: number; confidence: "high" | "medium" | "low"; reasons: string[];
}
export interface ClustersResponse { clusters: OppCluster[]; points: number }

export interface ScanRun {
  id: string; kind: string; label: string; city: string | null; state: string | null;
  budget: number; verified: number; newFiber: number; newlyLive: number; failed: number;
  status: "running" | "paused" | "done" | "error" | "cancelled"; error: string | null;
  estBytes: number; startedAt: string; heartbeatAt: string | null; completedAt: string | null;
  costUsd: number; active: boolean; pct: number; queued?: number;
}
export interface RunPreview { poolAvailable: number; available: number; highValue: number; willVerify: number; estimate: CostEstimate; maxPerRun: number }

export interface DeployBriefing {
  doors: number; unworked: number; avgScore: number;
  topCompetitor: { name: string; count: number } | null;
  competitorShare: number; newFiber: number; generatedAt: string;
}

const getJson = async <T>(url: string): Promise<T> => (await apiRequest("GET", url)).json();
const postJson = async <T>(url: string, body?: unknown): Promise<T> => (await apiRequest("POST", url, body)).json();

export const scanApi = {
  markets: () => getJson<MarketsResponse>("/api/scan/markets"),
  marketDetail: (city: string, state = "NC") => getJson<MarketDetail>(`/api/scan/markets/${encodeURIComponent(city)}?state=${encodeURIComponent(state)}`),
  clusters: (opts?: { bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number }; minPoints?: number; city?: string; state?: string }) => {
    const q = new URLSearchParams();
    if (opts?.bbox) { const b = opts.bbox; q.set("minLat", String(b.minLat)); q.set("maxLat", String(b.maxLat)); q.set("minLng", String(b.minLng)); q.set("maxLng", String(b.maxLng)); }
    if (opts?.minPoints != null) q.set("minPoints", String(opts.minPoints));
    if (opts?.city) q.set("city", opts.city);
    if (opts?.state) q.set("state", opts.state);
    const qs = q.toString();
    return getJson<ClustersResponse>(`/api/scan/clusters${qs ? "?" + qs : ""}`);
  },
  runs: () => getJson<{ runs: ScanRun[] }>("/api/scan/runs"),
  run: (id: string) => getJson<ScanRun>(`/api/scan/runs/${id}`),
  changes: (hours = 24) => getJson<any>(`/api/scan/changes?hours=${hours}`),
  previewRun: (city: string, state: string, budget: number, rescan = false) => postJson<RunPreview>("/api/scan/runs/preview", { city, state, budget, rescan }),
  startRun: (city: string, state: string, budget: number, rescan = false) => postJson<{ runId: string; queued: number; budget: number; estimate: CostEstimate; city: string; state: string }>("/api/scan/runs", { city, state, budget, rescan }),
  controlRun: (id: string, action: "pause" | "resume" | "cancel") => postJson<{ ok: boolean }>(`/api/scan/runs/${id}/${action}`),
  deploy: (polygon: Array<[number, number]>, repId: number | undefined, opts?: { name?: string; sourceRunId?: string; leadIds?: number[]; repIds?: number[] }) =>
    postJson<{ territory: any; assigned: number; briefing: DeployBriefing; deployments?: Array<{ territoryId: number; repId: number; assigned: number }> }>("/api/scan/deploy", { polygon, repId, ...opts }),
};

// ── Presentation helpers ──────────────────────────────────────────────────────
// Bands read as a heat scale — hot(orange) → cold(grey). "cool" is a muted
// blue-slate, NOT the brand teal (the hero colour must mean "primary action",
// not "meh market").
export const BAND_TINT: Record<MarketCard["priorityBand"], string> = {
  hot: "#f97316", warm: "#eab308", cool: "#6b8299", cold: "#64748b",
};
export function usdCompact(n: number): string {
  if (n < 0.01) return "<$0.01";
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}
export function freshnessLabel(days: number | null): string {
  if (days == null) return "never verified";
  if (days < 1) return "verified today";
  if (days < 2) return "verified yesterday";
  return `${Math.round(days)}d since verified`;
}
