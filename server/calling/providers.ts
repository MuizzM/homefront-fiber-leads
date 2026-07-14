import crypto from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { normalizeUsPhone } from "@shared/calling";
import { rawDb } from "../db";
import { callingEnvironment, encryptSensitive } from "./crypto";
import {
  appendCallingAudit,
  getCallingCandidate,
  internalDncHit,
  revealPhone,
  storeManualContact,
  validatePhoneManually,
  type CallingCandidate,
} from "./store";

export type EnrichmentAddress = {
  leadId: number;
  address: string;
  city: string;
  state: string;
  zip: string;
};

export type EnrichmentMatch = {
  phone: string;
  name: string | null;
  relationship: "resident" | "owner" | "unknown";
  confidence: number;
  providerRecordId: string | null;
};

export type ProviderOperation = {
  /** Stable UUID allocated by the paid-operation reservation. Reused for every retry. */
  operationId: string;
};

export interface ResidentContactProvider {
  readonly adapterType: string;
  lookup(address: EnrichmentAddress, operation: ProviderOperation, signal: AbortSignal): Promise<{
    requestId: string | null;
    matches: EnrichmentMatch[];
    raw: unknown;
  }>;
  validatePhone(phone: string, operation: ProviderOperation, signal: AbortSignal): Promise<PhoneValidationResult>;
}

export type PhoneValidationResult = {
  reachable: boolean;
  lineType: "wireless" | "landline" | "voip" | "fixed_voip" | "non_fixed_voip" | "toll_free" | "unknown";
  carrier: string | null;
  reassignedRisk: boolean;
  evidenceRef: string;
};

export type ProviderConfig = {
  id: string;
  tenantId: number;
  providerName: string;
  adapterType: string;
  enabled: boolean;
  contractStatus: string;
  permittedUseApproved: boolean;
  permittedUses: string[];
  contractReference: string | null;
  queryCostMicros: number;
  cacheTtlSeconds: number;
  retentionDays: number;
  rateLimitPerMinute: number;
  secretEnvName: string | null;
  baseUrl: string | null;
  dailyBudgetMicros: number;
  monthlyBudgetMicros: number;
  circuitOpenUntil: string | null;
};

const responseSchema = z.object({
  requestId: z.string().max(300).nullable().optional(),
  matches: z.array(z.object({
    phone: z.string().min(7).max(40),
    name: z.string().trim().max(200).nullable().optional(),
    relationship: z.enum(["resident", "owner", "unknown"]).default("unknown"),
    confidence: z.number().min(0).max(1),
    providerRecordId: z.string().max(300).nullable().optional(),
  }).passthrough()).max(20),
}).passthrough();

const validationResponseSchema = z.object({
  reachable: z.boolean(),
  lineType: z.enum(["wireless", "landline", "voip", "fixed_voip", "non_fixed_voip", "toll_free", "unknown"]),
  carrier: z.string().trim().max(200).nullable().optional(),
  reassignedRisk: z.boolean(),
  evidenceRef: z.string().trim().min(1).max(500),
}).passthrough();

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function configById(
  tenantId: number,
  id: string | undefined,
  requiredUse: "telemarketing_contact_enrichment" | "phone_validation",
): ProviderConfig | null {
  const where = id ? "p.tenant_id=? AND p.id=?" : `p.tenant_id=? AND p.enabled=1
    AND p.contract_status='approved' AND p.permitted_use_approved=1
    AND EXISTS(SELECT 1 FROM json_each(p.permitted_uses_json) WHERE value=?)
    ORDER BY p.priority,p.query_cost_micros,p.id LIMIT 1`;
  const row = rawDb.prepare(`SELECT p.id,p.tenant_id AS tenantId,p.provider_name AS providerName,
    p.adapter_type AS adapterType,p.enabled,p.contract_status AS contractStatus,
    p.permitted_use_approved AS permittedUseApproved,p.permitted_uses_json AS permittedUsesJson,
    p.contract_reference AS contractReference,p.query_cost_micros AS queryCostMicros,
    p.cache_ttl_seconds AS cacheTtlSeconds,p.retention_days AS retentionDays,
    p.rate_limit_per_minute AS rateLimitPerMinute,p.secret_env_name AS secretEnvName,p.base_url AS baseUrl,
    p.daily_budget_micros AS dailyBudgetMicros,p.monthly_budget_micros AS monthlyBudgetMicros,
    p.circuit_open_until AS circuitOpenUntil FROM contact_enrichment_providers p WHERE ${where}`)
    .get(...(id ? [tenantId, id] : [tenantId, requiredUse])) as any;
  if (!row) return null;
  return {
    ...row,
    enabled: Number(row.enabled) === 1,
    permittedUseApproved: Number(row.permittedUseApproved) === 1,
    permittedUses: parseStringArray(row.permittedUsesJson),
    queryCostMicros: Number(row.queryCostMicros || 0),
    cacheTtlSeconds: Number(row.cacheTtlSeconds || 0),
    retentionDays: Number(row.retentionDays || 0),
    rateLimitPerMinute: Number(row.rateLimitPerMinute || 1),
    dailyBudgetMicros: Number(row.dailyBudgetMicros || 0),
    monthlyBudgetMicros: Number(row.monthlyBudgetMicros || 0),
  };
}

function csvSet(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
}

function validateProviderEndpoint(config: ProviderConfig): { url: URL; secret: string } {
  if (config.adapterType !== "generic_http_v1") throw new Error("Provider adapter is not supported");
  if (!config.baseUrl || !config.secretEnvName) throw new Error("Provider endpoint and secret reference are required");
  const url = new URL(config.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Provider endpoint must be credential-free HTTPS");
  const allowedHosts = csvSet(process.env.CONTACT_PROVIDER_HOST_ALLOWLIST);
  if (!allowedHosts.has(url.hostname)) throw new Error("Provider host is not on CONTACT_PROVIDER_HOST_ALLOWLIST");
  const allowedSecretNames = csvSet(process.env.CONTACT_PROVIDER_SECRET_ENV_ALLOWLIST);
  if (!allowedSecretNames.has(config.secretEnvName)) throw new Error("Provider secret name is not allowlisted");
  let tenantBindings: Record<string, Record<string, string>> = {};
  try { tenantBindings = JSON.parse(process.env.CONTACT_PROVIDER_SECRET_BINDINGS_JSON ?? "{}") as Record<string, Record<string, string>>; }
  catch { throw new Error("CONTACT_PROVIDER_SECRET_BINDINGS_JSON is invalid"); }
  if (tenantBindings[String(config.tenantId)]?.[config.providerName] !== config.secretEnvName) {
    throw new Error("Provider secret is not bound to this tenant and provider name");
  }
  const secret = process.env[config.secretEnvName]?.trim();
  if (!secret) throw new Error("Provider secret is not configured");
  return { url, secret };
}

function isForbiddenProviderAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51)
      || (a === 203 && b === 0);
  }
  const value = address.toLowerCase();
  if (isIP(value) !== 6) return true;
  if (value.startsWith("::ffff:")) return isForbiddenProviderAddress(value.slice(7));
  return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd")
    || /^fe[89ab]/.test(value) || value.startsWith("ff") || value.startsWith("2001:db8:");
}

async function assertPublicProviderDns(hostname: string): Promise<void> {
  if (isIP(hostname)) {
    if (isForbiddenProviderAddress(hostname)) throw new Error("Provider endpoint resolves to a restricted network");
    return;
  }
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isForbiddenProviderAddress(address))) {
    throw new Error("Provider endpoint resolves to a restricted network");
  }
}

async function readResponseText(response: Response, maxBytes = 1_000_000): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponse(response);
    throw new Error("Provider response exceeded 1 MB");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Provider response exceeded 1 MB");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function assertPaidOperationAllowed(tenantId: number, leadId: number): void {
  const row = rawDb.prepare(`SELECT l.fresh_confidence AS freshConfidence,l.source_scan_target_id AS sourceScanTargetId,
    l.fresh_confirmed_at AS freshConfirmedAt,lower(coalesce(l.lead_status,'prospect')) AS leadStatus,
    q.stage,q.closed_at AS closedAt,p.phone_hash AS phoneHash
    FROM leads l JOIN calling_queue_entries q ON q.tenant_id=l.tenant_id AND q.lead_id=l.id
    LEFT JOIN phone_numbers p ON p.tenant_id=q.tenant_id AND p.id=q.phone_id
    WHERE l.tenant_id=? AND l.id=?`).get(tenantId, leadId) as any;
  if (!row || row.freshConfidence !== "cross_verified" || !row.sourceScanTargetId || !row.freshConfirmedAt) {
    throw new Error("Paid provider access requires a cross-verified fresh-fiber lead");
  }
  if (row.closedAt || ["sold", "not_interested"].includes(row.leadStatus)
      || ["SUPPRESSED", "CONVERTED", "CLOSED"].includes(row.stage)
      || internalDncHit(tenantId, row.phoneHash ?? null)) {
    throw new Error("Paid provider access is blocked for a closed or suppressed lead");
  }
}

const nextRequestAt = new Map<string, number>();

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds <= 0) return;
  await delay(milliseconds, undefined, { signal });
}

async function throttle(config: ProviderConfig, signal: AbortSignal): Promise<void> {
  const interval = 60_000 / Math.max(1, Math.min(10_000, config.rateLimitPerMinute));
  const now = Date.now();
  const scheduled = Math.max(now, nextRequestAt.get(config.id) ?? now);
  nextRequestAt.set(config.id, scheduled + interval);
  await abortableDelay(scheduled - now, signal);
}

function retryDelayMs(response: Response, attempt: number): number {
  if (response.status !== 429) return 250 * 2 ** attempt;
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (!retryAfter) return 500 * 2 ** attempt;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, seconds * 1_000);
  const retryAt = Date.parse(retryAfter);
  return Number.isFinite(retryAt) ? Math.max(0, Math.min(10_000, retryAt - Date.now())) : 500 * 2 ** attempt;
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection is already unusable; cancellation is only best-effort cleanup.
  }
}

export class GenericHttpResidentContactProvider implements ResidentContactProvider {
  readonly adapterType = "generic_http_v1";
  constructor(private readonly config: ProviderConfig) {}

  private async request(
    body: Record<string, unknown>,
    operation: ProviderOperation,
    signal: AbortSignal,
  ): Promise<unknown> {
    const operationId = z.string().uuid().parse(operation.operationId);
    const { url, secret } = validateProviderEndpoint(this.config);
    throwIfAborted(signal);
    await assertPublicProviderDns(url.hostname);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      throwIfAborted(signal);
      // Count retries as external requests too; provider rate limits apply to
      // every wire attempt, not merely to each logical paid operation.
      await throttle(this.config, signal);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          // A redirect is a provider configuration error, not a network retry.
          // Keeping it manual also prevents a redirect from escaping the checked host.
          redirect: "manual",
          signal,
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": "HomeFront-Calling/1.0",
            "idempotency-key": operationId,
            "x-homefront-operation-id": operationId,
          },
          body: JSON.stringify({ ...body, operationId }),
        });
      } catch (error) {
        if (signal.aborted) throw abortError(signal);
        // A rejection from fetch is a transport failure. Parsing, validation,
        // HTTP policy, DNS, and response-size failures occur outside this catch
        // and are deliberately terminal.
        lastError = error instanceof Error ? error : new Error("Provider request failed");
        if (attempt < 2) {
          await abortableDelay(250 * 2 ** attempt, signal);
          continue;
        }
        throw lastError;
      }

      const retryableStatus = response.status === 429 || response.status >= 500;
      if (!response.ok) {
        if (retryableStatus && attempt < 2) {
          await cancelResponse(response);
          await abortableDelay(retryDelayMs(response, attempt), signal);
          continue;
        }
        await cancelResponse(response);
        throw new Error(`Provider returned HTTP ${response.status}`);
      }

      const text = await readResponseText(response);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("Provider returned invalid JSON");
      }
    }
    throw lastError ?? new Error("Provider request failed");
  }

  async lookup(address: EnrichmentAddress, operation: ProviderOperation, signal: AbortSignal) {
    const raw = await this.request({
      operation: "enrich_address",
      address: address.address,
      city: address.city,
      state: address.state,
      postalCode: address.zip,
      country: "US",
    }, operation, signal);
    const parsed = responseSchema.parse(raw);
        const matches = parsed.matches.flatMap((match): EnrichmentMatch[] => {
          const phone = normalizeUsPhone(match.phone);
          return phone ? [{
            phone,
            name: match.name ?? null,
            relationship: match.relationship,
            confidence: match.confidence,
            providerRecordId: match.providerRecordId ?? null,
          }] : [];
        });
    return { requestId: parsed.requestId ?? null, matches, raw };
  }

  async validatePhone(phone: string, operation: ProviderOperation, signal: AbortSignal): Promise<PhoneValidationResult> {
    const raw = await this.request({ operation: "validate_phone", phone, country: "US" }, operation, signal);
    const parsed = validationResponseSchema.parse(raw);
    return {
      reachable: parsed.reachable,
      lineType: parsed.lineType,
      carrier: parsed.carrier ?? null,
      reassignedRisk: parsed.reassignedRisk,
      evidenceRef: parsed.evidenceRef,
    };
  }
}

function validateApprovedConfig(config: ProviderConfig, requiredUse: "telemarketing_contact_enrichment" | "phone_validation"): void {
  if (!config.enabled || config.contractStatus !== "approved" || !config.permittedUseApproved || !config.contractReference) {
    throw new Error("Provider contract and permitted use must be approved before enrichment");
  }
  if (!config.permittedUses.includes(requiredUse)) {
    throw new Error(`Provider contract does not explicitly permit ${requiredUse.replace(/_/g, " ")}`);
  }
  if (config.retentionDays < 1) throw new Error("Provider retention terms do not permit storing a usable match");
  if (config.circuitOpenUntil && Date.parse(config.circuitOpenUntil) > Date.now()) throw new Error("Provider circuit is open");
}

function reserveUsage(
  config: ProviderConfig,
  tenantId: number,
  leadId: number,
  actorUserId: number,
  idempotencyKey: string,
  operation: "enrichment" | "validation",
): {
  enrichmentId: string;
  usageId: string;
  replayed: boolean;
} {
  let output!: { enrichmentId: string; usageId: string; replayed: boolean };
  rawDb.transaction(() => {
    const existing = rawDb.prepare(`SELECT id,lead_id AS leadId,provider_config_id AS providerConfigId,status
      FROM contact_enrichments WHERE tenant_id=? AND idempotency_key=?`).get(tenantId, idempotencyKey) as any;
    if (existing) {
      if (existing.leadId !== leadId || existing.providerConfigId !== config.id
          || !String(existing.status).startsWith(operation)) {
        throw new Error("Idempotency key was used for another provider operation");
      }
      if (existing.status === `${operation}_requested`) {
        throw Object.assign(new Error("Provider operation is already in progress"), { status: 409 });
      }
      if (existing.status === `${operation}_failed`) {
        throw Object.assign(new Error("Previous provider operation failed; retry with a new idempotency key"), { status: 409 });
      }
      output = { enrichmentId: existing.id, usageId: "", replayed: true };
      return;
    }
    const costs = rawDb.prepare(`SELECT
      coalesce(sum(CASE WHEN created_at>=datetime('now','start of day') THEN cost_micros ELSE 0 END),0) AS daily,
      coalesce(sum(CASE WHEN created_at>=datetime('now','start of month') THEN cost_micros ELSE 0 END),0) AS monthly
      FROM provider_usage_events WHERE tenant_id=? AND provider_config_id=?`).get(tenantId, config.id) as any;
    if (config.dailyBudgetMicros <= 0 || Number(costs?.daily || 0) + config.queryCostMicros > config.dailyBudgetMicros) {
      throw new Error("Provider daily budget is disabled or exhausted");
    }
    if (config.monthlyBudgetMicros <= 0 || Number(costs?.monthly || 0) + config.queryCostMicros > config.monthlyBudgetMicros) {
      throw new Error("Provider monthly budget is disabled or exhausted");
    }
    const enrichmentId = crypto.randomUUID();
    const usageId = crypto.randomUUID();
    rawDb.prepare(`INSERT INTO contact_enrichments
      (id,tenant_id,lead_id,provider_config_id,idempotency_key,status,cost_micros,requested_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(enrichmentId, tenantId, leadId, config.id, idempotencyKey,
        `${operation}_requested`, config.queryCostMicros, actorUserId);
    rawDb.prepare(`INSERT INTO provider_usage_events
      (id,tenant_id,provider_config_id,enrichment_id,event_type,cost_micros)
      VALUES (?,?,?,?,?,?)`).run(usageId, tenantId, config.id, enrichmentId, `${operation}_query_reserved`, config.queryCostMicros);
    output = { enrichmentId, usageId, replayed: false };
  }).immediate();
  return output;
}

export type ProviderPayloadPurgeResult = {
  purged: number;
  hasMore: boolean;
};

/**
 * Clears only expired encrypted provider payloads. Durable operation, cost,
 * status, and audit metadata remain untouched. The bounded batch makes this
 * safe to invoke from request traffic or a scheduler without a long write lock.
 */
export function purgeExpiredProviderPayloads(input: {
  tenantId?: number;
  batchSize?: number;
  now?: Date;
} = {}): ProviderPayloadPurgeResult {
  const requestedBatchSize = input.batchSize ?? 100;
  if (!Number.isFinite(requestedBatchSize)) throw new Error("Provider payload purge batch size is invalid");
  // Stay below SQLite's conservative 999 bind-parameter limit.
  const batchSize = Math.max(1, Math.min(500, Math.trunc(requestedBatchSize)));
  if (input.tenantId !== undefined && (!Number.isSafeInteger(input.tenantId) || input.tenantId <= 0)) {
    throw new Error("Provider payload purge tenant is invalid");
  }
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Provider payload purge timestamp is invalid");
  }
  const nowIso = now.toISOString();
  const tenantClause = input.tenantId === undefined ? "" : "AND ce.tenant_id=?";
  const eligibility = `ce.raw_response_encrypted IS NOT NULL ${tenantClause} AND (
    p.id IS NULL OR p.retention_days<=0
    OR (ce.expires_at IS NOT NULL AND unixepoch(ce.expires_at)<=unixepoch(?))
    OR unixepoch(coalesce(ce.completed_at,ce.requested_at),
      '+' || p.retention_days || ' days')<=unixepoch(?)
  )`;
  const args = input.tenantId === undefined
    ? [nowIso, nowIso]
    : [input.tenantId, nowIso, nowIso];

  let purged = 0;
  let hasMore = false;
  rawDb.transaction(() => {
    const rows = rawDb.prepare(`SELECT ce.id FROM contact_enrichments ce
      LEFT JOIN contact_enrichment_providers p ON p.tenant_id=ce.tenant_id AND p.id=ce.provider_config_id
      WHERE ${eligibility}
      ORDER BY coalesce(ce.expires_at,ce.completed_at,ce.requested_at),ce.id LIMIT ?`)
      .all(...args, batchSize) as Array<{ id: string }>;
    if (rows.length) {
      const placeholders = rows.map(() => "?").join(",");
      purged = rawDb.prepare(`UPDATE contact_enrichments SET raw_response_encrypted=NULL
        WHERE raw_response_encrypted IS NOT NULL AND id IN (${placeholders})`)
        .run(...rows.map(({ id }) => id)).changes;
    }
    hasMore = Boolean(rawDb.prepare(`SELECT 1 FROM contact_enrichments ce
      LEFT JOIN contact_enrichment_providers p ON p.tenant_id=ce.tenant_id AND p.id=ce.provider_config_id
      WHERE ${eligibility} LIMIT 1`).get(...args));
  }).immediate();
  return { purged, hasMore };
}

export function findReusableApprovedPhoneValidation(input: {
  tenantId: number;
  phoneId: number;
  providerConfigId: string;
}): { id: string; checkedAt: string; expiresAt: string } | null {
  const row = rawDb.prepare(`SELECT v.id,v.checked_at AS checkedAt,v.expires_at AS expiresAt
    FROM phone_validations v
    JOIN phone_numbers pn ON pn.tenant_id=v.tenant_id AND pn.id=v.phone_id
    JOIN contact_enrichment_providers p ON p.tenant_id=v.tenant_id AND p.id=v.provider_config_id
    WHERE v.tenant_id=? AND v.phone_id=? AND v.provider_config_id=?
      AND v.id=(SELECT latest.id FROM phone_validations latest
        WHERE latest.tenant_id=v.tenant_id AND latest.phone_id=v.phone_id
        ORDER BY latest.checked_at DESC,latest.created_at DESC,latest.id DESC LIMIT 1)
      AND v.status='VALID' AND v.reachable=1 AND v.reassigned_risk=0
      AND unixepoch(v.expires_at)>unixepoch('now')
      AND pn.validation_status='VALID' AND pn.reassigned_risk=0
      AND unixepoch(pn.verification_expires_at)>unixepoch('now')
      AND p.enabled=1 AND p.contract_status='approved' AND p.permitted_use_approved=1
      AND p.contract_reference IS NOT NULL AND length(trim(p.contract_reference))>0
      AND p.retention_days>0
      AND EXISTS(SELECT 1 FROM json_each(p.permitted_uses_json) WHERE value='phone_validation')
    LIMIT 1`).get(input.tenantId, input.phoneId, input.providerConfigId) as any;
  return row ?? null;
}

export async function enrichCallingLead(input: {
  tenantId: number;
  leadId: number;
  providerConfigId?: string;
  actorUserId: number;
  idempotencyKey: string;
  correlationId: string;
}): Promise<{ candidate: CallingCandidate | null; enrichmentId: string; replayed: boolean; matchCount: number }> {
  purgeExpiredProviderPayloads({ tenantId: input.tenantId, batchSize: 100 });
  const environment = callingEnvironment(input.tenantId);
  if (!environment.enrichmentEnabled || !environment.pilotAllowed || !environment.secretsReady) {
    throw new Error("Contact enrichment is disabled for this organization");
  }
  assertPaidOperationAllowed(input.tenantId, input.leadId);
  const config = configById(input.tenantId, input.providerConfigId, "telemarketing_contact_enrichment");
  if (!config) throw new Error("No approved contact enrichment provider is configured");
  validateApprovedConfig(config, "telemarketing_contact_enrichment");
  const cached = rawDb.prepare(`SELECT id,match_count AS matchCount FROM contact_enrichments
    WHERE tenant_id=? AND lead_id=? AND provider_config_id=? AND status='enrichment_completed' AND expires_at>datetime('now')
    ORDER BY completed_at DESC LIMIT 1`).get(input.tenantId, input.leadId, config.id) as any;
  if (cached) return { candidate: getCallingCandidate(input.tenantId, input.leadId), enrichmentId: cached.id, replayed: true, matchCount: Number(cached.matchCount) };

  const address = rawDb.prepare(`SELECT id AS leadId,address,city,state,zip FROM leads WHERE tenant_id=? AND id=?`)
    .get(input.tenantId, input.leadId) as EnrichmentAddress | undefined;
  if (!address) throw new Error("Lead not found");
  const reservation = reserveUsage(config, input.tenantId, input.leadId, input.actorUserId, input.idempotencyKey, "enrichment");
  if (reservation.replayed) {
    const row = rawDb.prepare(`SELECT status,match_count AS matchCount FROM contact_enrichments WHERE tenant_id=? AND id=?`)
      .get(input.tenantId, reservation.enrichmentId) as any;
    return { candidate: getCallingCandidate(input.tenantId, input.leadId), enrichmentId: reservation.enrichmentId,
      replayed: true, matchCount: Number(row?.matchCount || 0) };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(30_000, Number(process.env.CONTACT_PROVIDER_TIMEOUT_MS) || 10_000)));
  try {
    const provider = new GenericHttpResidentContactProvider(config);
    const result = await provider.lookup(address, { operationId: reservation.enrichmentId }, controller.signal);
    const ranked = [...result.matches].sort((a, b) => b.confidence - a.confidence);
    // Ownership is useful sales context, but it is not evidence that the owner
    // currently resides at the service address. Prefer a provider-identified
    // resident; otherwise persist the best record for review without allowing
    // it into the callable queue.
    const best = ranked.find((match) => match.relationship === "resident") ?? ranked[0];
    if (!best) {
      rawDb.transaction(() => {
        rawDb.prepare(`UPDATE phone_address_associations SET expires_at=datetime('now'),resident_status='VACANT_OR_UNKNOWN',
          identity_confidence=0,updated_at=datetime('now') WHERE tenant_id=? AND lead_id=?`)
          .run(input.tenantId, input.leadId);
        rawDb.prepare(`UPDATE contacts SET status='REVIEW_REQUIRED',resident_status='VACANT_OR_UNKNOWN',
          updated_at=datetime('now') WHERE tenant_id=? AND lead_id=?`).run(input.tenantId, input.leadId);
        rawDb.prepare(`UPDATE calling_queue_entries SET stage='ENRICHMENT_FAILED',last_decision_id=NULL,
          version=version+1,updated_at=datetime('now') WHERE tenant_id=? AND lead_id=?`)
          .run(input.tenantId, input.leadId);
      }).immediate();
    }
    const candidate = best ? storeManualContact({
      tenantId: input.tenantId,
      leadId: input.leadId,
      phone: best.phone,
      name: best.name,
      relationship: best.relationship,
      identityConfidence: best.confidence,
      providerConfigId: config.id,
      providerRecordId: best.providerRecordId ?? result.requestId,
      humanVerified: false,
      sourceMode: "provider_api",
      associationValidDays: Math.min(30, config.retentionDays),
    }) : getCallingCandidate(input.tenantId, input.leadId);
    const cacheSeconds = Math.min(config.cacheTtlSeconds, config.retentionDays * 86_400);
    const expiresAt = cacheSeconds > 0 ? new Date(Date.now() + cacheSeconds * 1_000).toISOString() : null;
    const rawEncrypted = cacheSeconds > 0 ? encryptSensitive(JSON.stringify(result.raw)) : null;
    rawDb.prepare(`UPDATE contact_enrichments SET contact_id=?,status='enrichment_completed',match_count=?,cache_hit=0,
      raw_response_encrypted=?,completed_at=datetime('now'),expires_at=? WHERE tenant_id=? AND id=?`).run(
        candidate?.contactId ?? null, result.matches.length, rawEncrypted, expiresAt, input.tenantId, reservation.enrichmentId,
      );
    rawDb.prepare(`UPDATE provider_usage_events SET event_type='query_completed',successful_match=?,compliant_usable_match=?
      WHERE tenant_id=? AND id=?`).run(result.matches.length > 0 ? 1 : 0,
        best?.relationship === "resident" && best.confidence >= 0.85 ? 1 : 0,
        input.tenantId, reservation.usageId);
    rawDb.prepare(`UPDATE contact_enrichment_providers SET last_health_at=datetime('now'),last_health_status='healthy',
      circuit_open_until=NULL,updated_at=datetime('now') WHERE tenant_id=? AND id=?`).run(input.tenantId, config.id);
    appendCallingAudit({ tenantId: input.tenantId, correlationId: input.correlationId, eventType: "contact.enriched",
      entityType: "lead", entityId: String(input.leadId), actorUserId: input.actorUserId,
      metadata: { leadId: input.leadId, providerConfigId: config.id, enrichmentId: reservation.enrichmentId,
        matchCount: result.matches.length, relationship: best?.relationship ?? null } });
    return { candidate, enrichmentId: reservation.enrichmentId, replayed: false, matchCount: result.matches.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider request failed";
    rawDb.prepare(`UPDATE contact_enrichments SET status='enrichment_failed',error_code=?,completed_at=datetime('now')
      WHERE tenant_id=? AND id=?`).run(message.slice(0, 120), input.tenantId, reservation.enrichmentId);
    rawDb.prepare(`UPDATE provider_usage_events SET event_type='query_failed' WHERE tenant_id=? AND id=?`)
      .run(input.tenantId, reservation.usageId);
    rawDb.prepare(`UPDATE contact_enrichment_providers SET last_health_at=datetime('now'),last_health_status='failed',
      circuit_open_until=datetime('now','+5 minutes'),updated_at=datetime('now') WHERE tenant_id=? AND id=?`)
      .run(input.tenantId, config.id);
    throw new Error(`Contact enrichment failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function validateCallingLeadPhone(input: {
  tenantId: number;
  leadId: number;
  providerConfigId?: string;
  actorUserId: number;
  idempotencyKey: string;
  correlationId: string;
}): Promise<{ candidate: CallingCandidate; validationId: string; replayed: boolean }> {
  purgeExpiredProviderPayloads({ tenantId: input.tenantId, batchSize: 100 });
  const environment = callingEnvironment(input.tenantId);
  if (!environment.enrichmentEnabled || !environment.pilotAllowed || !environment.secretsReady) {
    throw new Error("Phone validation is disabled for this organization");
  }
  assertPaidOperationAllowed(input.tenantId, input.leadId);
  const config = configById(input.tenantId, input.providerConfigId, "phone_validation");
  if (!config) throw new Error("Phone-validation provider is not configured");
  validateApprovedConfig(config, "phone_validation");
  const candidate = getCallingCandidate(input.tenantId, input.leadId);
  if (!candidate?.phoneId) throw new Error("Lead has no phone to validate");
  const reusableValidation = findReusableApprovedPhoneValidation({
    tenantId: input.tenantId,
    phoneId: candidate.phoneId,
    providerConfigId: config.id,
  });
  if (reusableValidation) {
    return { candidate, validationId: reusableValidation.id, replayed: true };
  }

  const reservation = reserveUsage(
    config,
    input.tenantId,
    input.leadId,
    input.actorUserId,
    input.idempotencyKey,
    "validation",
  );
  if (reservation.replayed) {
    const current = getCallingCandidate(input.tenantId, input.leadId);
    if (!current) throw new Error("Calling candidate not found");
    return { candidate: current, validationId: reservation.enrichmentId, replayed: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(30_000,
    Number(process.env.CONTACT_PROVIDER_TIMEOUT_MS) || 10_000)));
  try {
    const provider = new GenericHttpResidentContactProvider(config);
    const phone = revealPhone(input.tenantId, candidate.phoneId);
    const result = await provider.validatePhone(phone, { operationId: reservation.enrichmentId }, controller.signal);
    validatePhoneManually({
      tenantId: input.tenantId,
      leadId: input.leadId,
      phoneId: candidate.phoneId,
      providerConfigId: config.id,
      lineType: result.lineType,
      reachable: result.reachable,
      reassignedRisk: result.reassignedRisk,
      evidenceRef: result.evidenceRef,
      validDays: Math.max(1, Math.min(30, config.retentionDays || 30)),
    });
    if (result.carrier) {
      rawDb.prepare(`UPDATE phone_numbers SET carrier=?,updated_at=datetime('now') WHERE tenant_id=? AND id=?`)
        .run(result.carrier, input.tenantId, candidate.phoneId);
    }
    rawDb.prepare(`UPDATE contact_enrichments SET contact_id=?,status='validation_completed',match_count=?,
      completed_at=datetime('now'),expires_at=(SELECT verification_expires_at FROM phone_numbers WHERE tenant_id=? AND id=?)
      WHERE tenant_id=? AND id=?`).run(candidate.contactId, result.reachable ? 1 : 0,
        input.tenantId, candidate.phoneId, input.tenantId, reservation.enrichmentId);
    rawDb.prepare(`UPDATE provider_usage_events SET event_type='validation_query_completed',successful_match=1,
      compliant_usable_match=? WHERE tenant_id=? AND id=?`).run(
        result.reachable && !result.reassignedRisk && result.lineType !== "unknown" ? 1 : 0,
        input.tenantId, reservation.usageId,
      );
    rawDb.prepare(`UPDATE contact_enrichment_providers SET last_health_at=datetime('now'),last_health_status='healthy',
      circuit_open_until=NULL,updated_at=datetime('now') WHERE tenant_id=? AND id=?`).run(input.tenantId, config.id);
    appendCallingAudit({ tenantId: input.tenantId, correlationId: input.correlationId, eventType: "phone.validated",
      entityType: "lead", entityId: String(input.leadId), actorUserId: input.actorUserId,
      metadata: { leadId: input.leadId, phoneId: candidate.phoneId, providerConfigId: config.id,
        validationId: reservation.enrichmentId, lineType: result.lineType, reachable: result.reachable,
        reassignedRisk: result.reassignedRisk, evidenceRef: result.evidenceRef } });
    const updated = getCallingCandidate(input.tenantId, input.leadId);
    if (!updated) throw new Error("Calling candidate not found after phone validation");
    return { candidate: updated, validationId: reservation.enrichmentId, replayed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Phone validation failed";
    rawDb.prepare(`UPDATE contact_enrichments SET status='validation_failed',error_code=?,completed_at=datetime('now')
      WHERE tenant_id=? AND id=?`).run(message.slice(0, 120), input.tenantId, reservation.enrichmentId);
    rawDb.prepare(`UPDATE provider_usage_events SET event_type='validation_query_failed' WHERE tenant_id=? AND id=?`)
      .run(input.tenantId, reservation.usageId);
    rawDb.prepare(`UPDATE contact_enrichment_providers SET last_health_at=datetime('now'),last_health_status='failed',
      circuit_open_until=datetime('now','+5 minutes'),updated_at=datetime('now') WHERE tenant_id=? AND id=?`)
      .run(input.tenantId, config.id);
    throw new Error(`Phone validation failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}
