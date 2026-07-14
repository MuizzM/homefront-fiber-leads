import crypto from "node:crypto";
import { z } from "zod";

export const kineticEvidenceModes = [
  "approved_api",
  "authorized_public_lookup",
  "authorized_import",
  "manual_verification",
  "offline",
] as const;
export type KineticEvidenceMode = (typeof kineticEvidenceModes)[number];

export const kineticPostalAddressSchema = z
  .object({
    address: z.string().trim().min(3).max(180),
    city: z.string().trim().min(1).max(100),
    state: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase()),
    zip: z
      .string()
      .trim()
      .regex(/^\d{5}(?:-\d{4})?$/),
    unit: z.string().trim().max(40).nullable().optional(),
  })
  .strict();
export type KineticPostalAddress = z.infer<typeof kineticPostalAddressSchema>;

export const importedKineticEvidenceSchema = kineticPostalAddressSchema
  .extend({
    evidenceId: z.string().trim().min(1).max(180).optional(),
    sourceReference: z.string().trim().min(1).max(240).optional(),
    observedAt: z.string().datetime({ offset: true }),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    technologyType: z.string().trim().max(100).nullable(),
    maximumQualification: z.number().nonnegative().nullable().optional(),
    isLive: z.boolean().nullable(),
    isComingSoon: z.boolean().nullable().optional(),
    isCopperUpgradeCandidate: z.boolean().nullable().optional(),
    sourceName: z.string().trim().min(2).max(100),
  })
  .strict();
export type ImportedKineticEvidence = z.infer<
  typeof importedKineticEvidenceSchema
>;

export interface NormalizedKineticAddress {
  kineticAddressId: string | null;
  sequentialId: number | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  latitude: number | null;
  longitude: number | null;
  exchangeId: string | null;
  technologyType: string | null;
  maximumQualification: number | null;
  estimatedCompletionDate: string | null;
  isLive: boolean | null;
  isComingSoon: boolean | null;
  isCopperUpgradeCandidate: boolean | null;
  /** Known provider fields used by the fresh-lead eligibility gate. */
  billingStatus?: string | null;
  householdSegmentType?: string | null;
  fiberStatus?: string | null;
  isNewFiber?: boolean | null;
  evidenceMode: KineticEvidenceMode;
  evidenceSource: string;
  evidenceId: string;
  observedAt: string;
  parserVersion: string;
  rawResponse: unknown;
  responseHash: string;
}

export type KineticAccessOutcome =
  "ok" | "not_found" | "denied" | "rate_limited" | "challenge" | "error";
export interface KineticEvidenceResponse {
  outcome: KineticAccessOutcome;
  record: NormalizedKineticAddress | null;
  statusCode?: number;
  retryAfterMs?: number;
  message?: string;
}

export interface KineticEvidenceSourceAdapter {
  readonly id: string;
  readonly mode: "approved_api" | "authorized_public_lookup";
  readonly contractVersion: string;
  healthCheck(
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; latencyMs: number; message: string }>;
  qualifyAddress(
    address: KineticPostalAddress,
    signal?: AbortSignal,
  ): Promise<KineticEvidenceResponse>;
}

export class KineticEvidenceUnavailableError extends Error {
  constructor(
    public readonly code:
      | "OFFLINE"
      | "SOURCE_NOT_REGISTERED"
      | "CIRCUIT_OPEN"
      | "ACCESS_DENIED"
      | "CHALLENGE"
      | "RATE_LIMITED",
    message: string,
  ) {
    super(message);
    this.name = "KineticEvidenceUnavailableError";
  }
}

export function hashKineticEvidence(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex");
}

export function normalizeImportedKineticEvidence(
  raw: unknown,
  mode: "authorized_import" | "manual_verification",
  parserVersion = "kinetic-evidence-v1",
): NormalizedKineticAddress {
  const value = importedKineticEvidenceSchema.parse(raw),
    responseHash = hashKineticEvidence(raw);
  return {
    kineticAddressId: null,
    sequentialId: null,
    address: value.unit ? `${value.address} ${value.unit}` : value.address,
    city: value.city,
    state: value.state,
    zip: value.zip,
    latitude: value.latitude ?? null,
    longitude: value.longitude ?? null,
    exchangeId: null,
    technologyType: value.technologyType,
    maximumQualification: value.maximumQualification ?? null,
    estimatedCompletionDate: null,
    isLive: value.isLive,
    isComingSoon: value.isComingSoon ?? null,
    isCopperUpgradeCandidate: value.isCopperUpgradeCandidate ?? null,
    billingStatus: null,
    householdSegmentType: null,
    fiberStatus: null,
    isNewFiber: null,
    evidenceMode: mode,
    evidenceSource: value.sourceName,
    evidenceId: value.evidenceId ?? responseHash,
    observedAt: value.observedAt,
    parserVersion,
    rawResponse: raw,
    responseHash,
  };
}

interface Circuit {
  openedUntil: number;
  rateLimitCount: number;
  reason: string | null;
}
class KineticEvidenceGateway {
  private adapter: KineticEvidenceSourceAdapter | null = null;
  private circuit: Circuit = {
    openedUntil: 0,
    rateLimitCount: 0,
    reason: null,
  };
  private readonly inflight = new Map<
    string,
    Promise<KineticEvidenceResponse>
  >();
  private readonly cache = new Map<
    string,
    { expiresAt: number; value: KineticEvidenceResponse }
  >();

  register(adapter: KineticEvidenceSourceAdapter): void {
    this.adapter = adapter;
    this.reset();
  }
  clear(): void {
    this.adapter = null;
    this.reset();
  }
  mode(): KineticEvidenceMode {
    return this.adapter?.mode ?? "offline";
  }
  source(): string {
    return this.adapter?.id ?? "offline";
  }
  supportsLiveQualification(): boolean {
    return this.adapter != null;
  }
  status() {
    return {
      mode: this.mode(),
      source: this.source(),
      contractVersion: this.adapter?.contractVersion ?? null,
      supportsLiveQualification: this.supportsLiveQualification(),
      circuitOpen: this.circuit.openedUntil > Date.now(),
      circuitReason: this.circuit.reason,
      circuitReopensAt: this.circuit.openedUntil
        ? new Date(this.circuit.openedUntil).toISOString()
        : null,
      concurrency: Math.max(1, Math.min(50, Number(process.env.SCAN_GLOBAL_CONCURRENCY) || 50)),
    };
  }
  async healthCheck(signal?: AbortSignal) {
    if (!this.adapter)
      return {
        ok: false,
        latencyMs: 0,
        message: "Offline: no permitted live evidence source is registered",
      };
    return this.adapter.healthCheck(signal);
  }

  async qualifyAddress(
    input: KineticPostalAddress,
    signal?: AbortSignal,
  ): Promise<KineticEvidenceResponse> {
    const address = kineticPostalAddressSchema.parse(input),
      key = hashKineticEvidence(address),
      now = Date.now();
    if (!this.adapter)
      throw new KineticEvidenceUnavailableError(
        "OFFLINE",
        "No permitted live Kinetic evidence source is registered.",
      );
    if (this.circuit.openedUntil > now)
      throw new KineticEvidenceUnavailableError(
        "CIRCUIT_OPEN",
        `Evidence source stopped: ${this.circuit.reason ?? "circuit open"}.`,
      );
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const task = this.runControlled(address, signal).finally(() =>
      this.inflight.delete(key),
    );
    this.inflight.set(key, task);
    return task;
  }

  private async runControlled(
    address: KineticPostalAddress,
    signal?: AbortSignal,
  ): Promise<KineticEvidenceResponse> {
    const result = await this.adapter!.qualifyAddress(address, signal);
      if (result.outcome === "denied") {
        this.trip("access denied (403)", 60 * 60_000);
        throw new KineticEvidenceUnavailableError(
          "ACCESS_DENIED",
          "Evidence source denied automated access; scanning stopped.",
        );
      }
      if (result.outcome === "challenge") {
        this.trip("challenge or CAPTCHA", 24 * 60 * 60_000);
        throw new KineticEvidenceUnavailableError(
          "CHALLENGE",
          "Challenge/CAPTCHA detected; scanning stopped without interpreting the page.",
        );
      }
      if (result.outcome === "rate_limited") {
        this.circuit.rateLimitCount++;
        if (this.circuit.rateLimitCount >= 3)
          this.trip(
            "repeated rate limits",
            Math.max(result.retryAfterMs ?? 0, 30 * 60_000),
          );
        throw new KineticEvidenceUnavailableError(
          "RATE_LIMITED",
          "Evidence source rate limit respected; no availability result recorded.",
        );
      }
      this.circuit.rateLimitCount = 0;
      if (result.outcome === "ok" || result.outcome === "not_found")
        this.cache.set(hashKineticEvidence(address), {
          expiresAt:
            Date.now() +
            Math.max(
              30_000,
              Number(process.env.KINETIC_EVIDENCE_CACHE_MS) || 300_000,
            ),
          value: result,
        });
      return result;
  }
  private trip(reason: string, durationMs: number) {
    this.circuit = {
      openedUntil: Date.now() + durationMs,
      rateLimitCount: this.circuit.rateLimitCount,
      reason,
    };
  }
  private reset() {
    this.circuit = { openedUntil: 0, rateLimitCount: 0, reason: null };
    this.inflight.clear();
    this.cache.clear();
  }
}

const gateway = new KineticEvidenceGateway();
export function getKineticEvidenceGateway(): KineticEvidenceGateway {
  return gateway;
}
export function registerKineticEvidenceSource(
  adapter: KineticEvidenceSourceAdapter,
): void {
  gateway.register(adapter);
}
export function clearKineticEvidenceSource(): void {
  gateway.clear();
}
export function setKineticEvidenceSourceForTest(
  adapter: KineticEvidenceSourceAdapter | null,
): void {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Kinetic evidence source overrides are test-only");
  adapter ? gateway.register(adapter) : gateway.clear();
}
