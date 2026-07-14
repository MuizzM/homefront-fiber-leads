import crypto from "node:crypto";
import { rawDb } from "./db";
import { getDefaultTenantId, storage } from "./storage";
import { projectConfirmedFreshLeads, type ProjectionResult } from "./freshFiberProjector";
import { classifyCustomerOpportunity, classifyFiberAvailabilityTransition } from "@shared/opportunitySegment";
import { structuredLog } from "./structuredLog";

export interface KineticObservation {
  address: string;
  city: string;
  state: string;
  zip?: string | null;
  lat?: number | null;
  lng?: number | null;
  fiberStatus?: string | null;
  /** Full address-check results carry this. CNS results intentionally do not. */
  fiberAvailable?: boolean | null;
  isNewFiber?: boolean | null;
  billingStatus?: string | null;
  householdSegmentType?: string | null;
  serviceStatus?: string | null;
  dfAddressId?: string | null;
  maxDownloadMbps?: number | null;
  techType?: string | null;
  speedTier?: string | null;
  competitorName?: string | null;
  addressCatalogDate?: string | null;
  apiSource?: string | null;
  blocked?: boolean | null;
  checkFailed?: boolean | null;
  discoveredAt?: string | null;
  rawResponse?: unknown;
}

/**
 * An escape hatch for rows produced before availability_snapshots existed. A
 * timestamp and provenance are mandatory: accepting `priorUnavailable: true`
 * would fabricate the baseline needed to call a result fresh.
 */
export interface LegacyPriorUnavailableEvidence {
  observedAt: string;
  source: string;
  evidenceId?: string;
}

export interface PersistKineticObservationInput {
  tenantId?: number | null;
  source: string;
  observation: KineticObservation;
  legacyPriorUnavailableEvidence?: LegacyPriorUnavailableEvidence;
  latencyMs?: number;
}

export interface PersistKineticObservationResult {
  tenantId: number;
  targetId: number;
  targetCreated: boolean;
  conclusive: boolean;
  fiberAvailable: boolean | null;
  transition: ReturnType<typeof classifyFiberAvailabilityTransition>;
  customerSegment: ReturnType<typeof classifyCustomerOpportunity>["segment"];
  rawNewFiberHit: boolean;
  projection: ProjectionResult;
}

interface TargetState {
  id: number;
  address: string;
  city: string;
  state: string;
  tenant_id: number | null;
  last_scanned_at: string | null;
  last_fiber_available: number | null;
  last_fiber_status: string | null;
  last_is_new_fiber: number;
  last_billing_status: string | null;
  last_availability_status: string | null;
}

interface PreviousState {
  fiberAvailable: boolean;
  observedAt: string;
  source: string;
  evidenceId?: string;
}

function clean(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function validDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeObservedAt(value: string | null | undefined): string {
  const parsed = validDate(value);
  return parsed == null ? new Date().toISOString() : new Date(parsed).toISOString();
}

function inferAvailability(observation: KineticObservation): boolean | null {
  if (observation.checkFailed === true || observation.blocked === true || observation.apiSource === "failed") return null;
  if (typeof observation.fiberAvailable === "boolean") return observation.fiberAvailable;
  // CNS payloads omit fiberAvailable. NEW FIBER is their only affirmative fiber
  // signal; a no-service result is a negative; every other CNS shape is unknown.
  if (observation.isNewFiber === true) return true;
  const status = clean(observation.fiberStatus).toLowerCase().replace(/[\s-]+/g, "_");
  return status === "no_service" ? false : null;
}

function legacyStateFromTarget(target: TargetState): PreviousState | null {
  if (!target.last_scanned_at || validDate(target.last_scanned_at) == null) return null;
  if (target.last_fiber_available != null) return {
    fiberAvailable: !!target.last_fiber_available,
    observedAt: target.last_scanned_at,
    source: "legacy_scan_target",
    evidenceId: `scan-target-${target.id}`,
  };
  const status = clean(target.last_availability_status || target.last_fiber_status).toLowerCase().replace(/[\s-]+/g, "_");
  if (["checked_unavailable", "unavailable", "no_service"].includes(status)) return {
    fiberAvailable: false,
    observedAt: target.last_scanned_at,
    source: "legacy_scan_target",
    evidenceId: `scan-target-${target.id}`,
  };
  if (target.last_is_new_fiber === 1) return {
    fiberAvailable: true,
    observedAt: target.last_scanned_at,
    source: "legacy_scan_target",
    evidenceId: `scan-target-${target.id}`,
  };
  return null;
}

function legacyAvailabilityStatus(status: ReturnType<typeof classifyFiberAvailabilityTransition>["status"]): string {
  return ({
    check_failed: "check_failed",
    baseline_available: "checked_available",
    unavailable: "checked_unavailable",
    freshly_available: "newly_live",
    still_available: "still_available",
    went_unavailable: "went_stale",
  } as const)[status];
}

function evidenceHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requestImmediateAlert(tenantId: number): void {
  const hook = (globalThis as any).__flushFreshFiberAlerts;
  if (typeof hook !== "function") return;
  void Promise.resolve(hook(tenantId)).catch((error: any) => {
    structuredLog("fresh_fiber.immediate_alert_failed", {
      tenantId,
      error: String(error?.message ?? error),
    }, "warn");
  });
}

/**
 * Normalizes one legacy Kinetic/CNS result into the durable scan evidence model.
 * This is the only path legacy scanners use to reach a lead: first observation
 * is a baseline, an unavailable-to-available transition is provisional, and the
 * independent-evidence projector is the sole publisher.
 */
export function persistKineticObservation(input: PersistKineticObservationInput): PersistKineticObservationResult {
  const tenantId = input.tenantId ?? getDefaultTenantId();
  if (!Number.isInteger(tenantId) || Number(tenantId) <= 0) throw new Error("KINETIC_OBSERVATION_TENANT_REQUIRED");
  const source = clean(input.source);
  if (!source) throw new Error("KINETIC_OBSERVATION_SOURCE_REQUIRED");

  const observation = input.observation;
  const address = clean(observation.address);
  const city = clean(observation.city);
  const state = clean(observation.state).toUpperCase();
  const zip = clean(observation.zip);
  if (!address || !city || !state) throw new Error("KINETIC_OBSERVATION_ADDRESS_REQUIRED");

  const observedAt = normalizeObservedAt(observation.discoveredAt);
  const observedMs = validDate(observedAt)!;
  const fiberAvailable = inferAvailability(observation);
  const conclusive = fiberAvailable != null;
  const fiberStatus = clean(observation.fiberStatus) || (observation.isNewFiber ? "new_fiber" : "unknown");
  const apiSource = clean(observation.apiSource) || `kinetic_legacy:${source}`;

  const explicitLegacy = input.legacyPriorUnavailableEvidence;
  let explicitPrevious: PreviousState | null = null;
  if (explicitLegacy) {
    const legacyMs = validDate(explicitLegacy.observedAt);
    if (legacyMs == null || legacyMs >= observedMs || !clean(explicitLegacy.source)) {
      throw new Error("KINETIC_LEGACY_BASELINE_EVIDENCE_INVALID");
    }
    explicitPrevious = {
      fiberAvailable: false,
      observedAt: new Date(legacyMs).toISOString(),
      source: clean(explicitLegacy.source),
      evidenceId: clean(explicitLegacy.evidenceId) || undefined,
    };
  }

  let targetId = 0;
  let targetCreated = false;
  let transition!: ReturnType<typeof classifyFiberAvailabilityTransition>;
  let customer!: ReturnType<typeof classifyCustomerOpportunity>;

  rawDb.transaction(() => {
    let target = rawDb.prepare(`SELECT id,address,city,state,tenant_id,last_scanned_at,last_fiber_available,
        last_fiber_status,last_is_new_fiber,last_billing_status,last_availability_status
      FROM scan_targets WHERE lower(trim(address))=lower(trim(?)) LIMIT 1`).get(address) as TargetState | undefined;
    if (target && (target.city.trim().toLowerCase() !== city.toLowerCase() || target.state.trim().toUpperCase() !== state)) {
      throw new Error(`KINETIC_OBSERVATION_ADDRESS_COLLISION: ${target.id}`);
    }
    if (target && (target.tenant_id == null || Number(target.tenant_id) !== Number(tenantId))) {
      throw new Error(`KINETIC_OBSERVATION_TENANT_CONFLICT: ${target.id}`);
    }
    if (!target) {
      const inserted = rawDb.prepare(`INSERT INTO scan_targets
        (address,city,state,zip,lat,lng,tenant_id,source,df_address_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`).run(
        address, city, state, zip, observation.lat ?? null, observation.lng ?? null,
        tenantId, `live-${source}`, observation.dfAddressId ?? null,
      );
      targetId = Number(inserted.lastInsertRowid);
      targetCreated = true;
      target = rawDb.prepare(`SELECT id,address,city,state,tenant_id,last_scanned_at,last_fiber_available,
          last_fiber_status,last_is_new_fiber,last_billing_status,last_availability_status
        FROM scan_targets WHERE id=?`).get(targetId) as TargetState;
    } else {
      targetId = target.id;
      rawDb.prepare(`UPDATE scan_targets SET
          df_address_id=COALESCE(df_address_id,?),lat=COALESCE(lat,?),lng=COALESCE(lng,?),
          zip=CASE WHEN zip IS NULL OR zip='' THEN ? ELSE zip END
        WHERE id=? AND tenant_id=?`).run(observation.dfAddressId ?? null, observation.lat ?? null, observation.lng ?? null, zip, targetId, tenantId);
    }

    const latest = (rawDb.prepare(`SELECT fiber_available,checked_at,api_source,evidence_hash
      FROM availability_snapshots
      WHERE tenant_id=? AND scan_target_id=? AND conclusive=1 AND fiber_available IS NOT NULL
      ORDER BY id DESC LIMIT 100`).all(tenantId, targetId) as any[])
      .filter((row) => {
        const at = validDate(row.checked_at);
        return at != null && at < observedMs;
      })
      .sort((a, b) => (validDate(b.checked_at) ?? 0) - (validDate(a.checked_at) ?? 0))[0];
    let previous: PreviousState | null = latest ? {
      fiberAvailable: !!latest.fiber_available,
      observedAt: latest.checked_at,
      source: latest.api_source ?? "availability_snapshot",
      evidenceId: latest.evidence_hash,
    } : null;
    let previousPersisted = !!latest;

    const targetPrevious = legacyStateFromTarget(target);
    if (targetPrevious && (validDate(targetPrevious.observedAt) ?? observedMs) < observedMs &&
        (!previous || (validDate(targetPrevious.observedAt) ?? 0) > (validDate(previous.observedAt) ?? 0))) {
      previous = targetPrevious;
      previousPersisted = false;
    }

    // An explicit historical unavailable record participates only if it is the
    // newest known prior evidence. The current observation is never backfilled as
    // its own baseline.
    if (explicitPrevious && (!previous || (validDate(explicitPrevious.observedAt) ?? 0) > (validDate(previous.observedAt) ?? 0))) {
      previous = explicitPrevious;
      previousPersisted = false;
    }

    // Normalize genuine pre-snapshot evidence once. This gives the transition a
    // durable predecessor without inventing one for a first-seen live address.
    if (!previousPersisted && previous) {
      const priorPayload = {
        tenantId, targetId, observedAt: previous.observedAt,
        fiberAvailable: previous.fiberAvailable, source: previous.source,
        evidenceId: previous.evidenceId ?? null,
      };
      rawDb.prepare(`INSERT INTO availability_snapshots
        (tenant_id,scan_target_id,run_id,checked_at,conclusive,fiber_available,fiber_status,
         customer_segment,customer_confidence,customer_signals,transition_status,fresh,api_source,evidence_hash,error,blocked,latency_ms)
        VALUES (?,?,NULL,?,1,?,?, 'unknown','low','[]',?,0,?,?,NULL,0,NULL)`).run(
        tenantId, targetId, previous.observedAt, previous.fiberAvailable ? 1 : 0,
        previous.fiberAvailable ? "available" : "no_service",
        previous.fiberAvailable ? "baseline_available" : "unavailable",
        previous.source, evidenceHash(priorPayload),
      );
    }

    transition = classifyFiberAvailabilityTransition(
      { everObserved: previous != null, fiberAvailable: previous?.fiberAvailable ?? false },
      { conclusive, fiberAvailable: fiberAvailable ?? false },
    );
    customer = classifyCustomerOpportunity({
      fiberAvailable: fiberAvailable ?? false,
      billingStatus: observation.billingStatus,
      householdSegmentType: observation.householdSegmentType,
      serviceStatus: observation.serviceStatus,
    });

    const normalizedEvidence = {
      source, observedAt, address, city, state, zip,
      fiberStatus, fiberAvailable, isNewFiber: observation.isNewFiber === true,
      billingStatus: observation.billingStatus ?? null,
      householdSegmentType: observation.householdSegmentType ?? null,
      dfAddressId: observation.dfAddressId ?? null,
      maxDownloadMbps: observation.maxDownloadMbps ?? null,
      techType: observation.techType ?? null,
      apiSource, blocked: observation.blocked === true,
      rawResponse: observation.rawResponse ?? null,
    };
    rawDb.prepare(`INSERT INTO availability_snapshots
      (tenant_id,scan_target_id,run_id,checked_at,conclusive,fiber_available,fiber_status,max_download_mbps,
       service_status,household_segment_type,billing_status,customer_segment,customer_confidence,customer_signals,
       transition_status,fresh,api_source,evidence_hash,fiber_check_id,error,blocked,latency_ms)
      VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`).run(
      tenantId, targetId, observedAt, conclusive ? 1 : 0, fiberAvailable == null ? null : (fiberAvailable ? 1 : 0),
      fiberStatus, observation.maxDownloadMbps ?? null, observation.serviceStatus ?? null,
      observation.householdSegmentType ?? null, observation.billingStatus ?? null,
      conclusive ? customer.segment : "unknown", conclusive ? customer.confidence : "low",
      JSON.stringify(conclusive ? customer.signals : ["provider_answer_inconclusive"]),
      transition.status, transition.fresh ? 1 : 0, apiSource, evidenceHash(normalizedEvidence),
      conclusive ? null : "Provider result was inconclusive; prior state preserved.",
      observation.blocked === true ? 1 : 0,
      input.latencyMs == null ? null : Math.max(0, Math.round(input.latencyMs)),
    );

    if (conclusive) {
      storage.recordScanTargetResult(targetId, {
        fiberStatus,
        fiberAvailable,
        isNewFiber: observation.isNewFiber === true,
        billingStatus: observation.billingStatus,
        dfAddressId: observation.dfAddressId,
        availabilityStatus: legacyAvailabilityStatus(transition.status),
        newlyLive: transition.fresh,
        customerSegment: customer.segment,
        customerConfidence: customer.confidence,
        customerSignals: customer.signals,
      });
    } else {
      storage.bumpScanTargetInconclusive({ id: targetId });
    }
  }).immediate();

  const projection = projectConfirmedFreshLeads(Number(tenantId), [targetId]);
  if (projection.published > 0) requestImmediateAlert(Number(tenantId));
  return {
    tenantId: Number(tenantId), targetId, targetCreated, conclusive, fiberAvailable,
    transition, customerSegment: conclusive ? customer.segment : "unknown",
    rawNewFiberHit: observation.isNewFiber === true,
    projection,
  };
}
