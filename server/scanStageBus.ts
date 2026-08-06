// ── Scan stage bus ────────────────────────────────────────────────────────────
// A tiny in-process pub/sub the scanner + engine emit per-address pipeline stages
// to. It has ZERO database or transport dependencies, so the hot scan path (and
// its unit tests) never import a store or a DB. The durable/SSE layer
// (scanEvents.ts) subscribes to this bus; if nothing subscribes, emit is a no-op.
//
// Stages an address moves through:
//   discovered → queued → minting → token_ready → searching → parsing → saving → classified
// plus off-happy-path markers: retry (auth 401/403 rotate), blocked (429/5xx),
// bad_request (malformed 400 — diagnosed, NOT rotated), error (infra).
import { EventEmitter } from "node:events";

export type ScanStage =
  | "discovered" | "queued" | "minting" | "token_ready"
  | "searching" | "parsing" | "saving" | "classified"
  | "retry" | "blocked" | "bad_request" | "error";

export interface ScanStageEvent {
  addressKey: string;          // sha/normalized dedup key
  address: string;
  city: string;
  state: string;
  zip: string;
  runId: string | null;
  source: string;              // manual | field | lasso | city | market | ...
  stage: ScanStage;
  status: "ok" | "retry" | "blocked" | "bad_request" | "error" | "pending_auth" | "info";
  attempt: number;
  httpStatus?: number | null;
  latencyMs?: number | null;
  sessionId?: string | null;   // MASKED proxy session id (decodo-sN) — never the IP
  tokenSuffix?: string | null; // last 4 chars of the JWT ONLY — never the token
  retryReason?: string | null;
  classification?: string | null;
  detail?: string | null;
  tsEpoch: number;             // ms
}

const bus = new EventEmitter();
bus.setMaxListeners(50);

/** Emit a stage transition. Never throws — a telemetry failure must not break a scan. */
export function emitStage(evt: ScanStageEvent): void {
  try {
    bus.emit("stage", evt);
  } catch {
    /* swallow — telemetry is best-effort */
  }
}

export function onStage(listener: (evt: ScanStageEvent) => void): () => void {
  bus.on("stage", listener);
  return () => bus.off("stage", listener);
}

/** Whether any subscriber is attached (lets emitters skip building payloads if idle). */
