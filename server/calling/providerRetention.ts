// ── Provider payload retention ──────────────────────────────────────────────
//
// All that survives of the generic multi-provider enrichment framework. The
// HTTP adapter, the paid-call orchestration and the enrich/validate entry
// points are gone - Tracerfy is the single contact source now (see
// ./leadTracing.ts and ./tracedPhones.ts).
//
// This is NOT dead code kept for sentiment. `contact_enrichments` still holds
// encrypted payloads written before the switch, and the contracts they were
// fetched under oblige us to delete them on schedule. Removing the deletion
// job because we stopped writing new rows would quietly strand personal data
// past its retention window. It drains what is there, then does nothing.
import { rawDb } from "../db";

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

  // Empty retention ticks are reads. Recheck inside the transaction when work
  // exists so expiry, tenant scope and concurrent purges retain their semantics.
  const hasEligible = rawDb.prepare(`SELECT 1 FROM contact_enrichments ce
    LEFT JOIN contact_enrichment_providers p ON p.tenant_id=ce.tenant_id AND p.id=ce.provider_config_id
    WHERE ${eligibility} LIMIT 1`);
  if (!hasEligible.get(...args)) return { purged: 0, hasMore: false };

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
    hasMore = Boolean(hasEligible.get(...args));
  }).immediate();
  return { purged, hasMore };
}
