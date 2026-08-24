// ── Tenured doors that nobody is paying for ──────────────────────────────────
//
// The fresh-fiber projector publishes exactly one thing: NEW FIBER + billing N.
// That is the new-build moat and it should stay narrow. But it leaves a second,
// larger population on the floor.
//
// TENURED means Kinetic has plant and history at the address. It does NOT mean
// anyone is paying, and the provider says so itself: across 2,994 tenured NC
// doors carrying billing 'N', its own signals said "no active account" 600
// times and "active" ZERO times. Not once contradicted. Those doors have fiber
// at the curb and no one on it, which is a sellable door by any reading.
//
// Measured on the production-shaped copy: 8,580 such doors in NC against 3,193
// tenured doors that DO carry an active account. Publishing the first group and
// not the second is the whole job here.
//
// WHY THIS IS A SEPARATE MODULE, NOT A WIDER FRESH PROJECTOR.
// A database trigger (trg_leads_fresh_* in storage.ts) refuses any lead marked
// is_new_fiber=1 or fiber_status='new_fiber' unless it carries fresh-fiber
// proof. That guard is load-bearing and must not be loosened to fit a different
// kind of lead through it. A tenured lead is honestly NOT new fiber, so it
// carries fiber_status='tenured_fiber' and is_new_fiber=0, the trigger does not
// apply, and the moat's evidence rules stay exactly as strict as they were.
import { rawDb } from "./db";
import { normalizeKineticAddressKey } from "@shared/addressKey";
import { structuredLog } from "./structuredLog";
import { ensureAccountSchema } from "./customerAccount";

export interface TenuredProjectionResult {
  considered: number;
  created: number;
  alreadyLead: number;
  skippedNoCoords: number;
  skippedKeyless: number;
  errors: string[];
}

/** Scored below fresh fiber (100): real, but second in line behind a new build. */
export const TENURED_LEAD_SCORE = 60;
export const TENURED_LEAD_TAG = "tenured_open";

export interface TenuredProjectionOptions {
  /** Cap one pass so a first run cannot mint tens of thousands of rows unasked. */
  limit?: number;
  state?: string;
  city?: string;
  /** Report what would happen and write nothing. */
  dryRun?: boolean;
}

export function projectTenuredOpenLeads(
  tenantId: number,
  opts: TenuredProjectionOptions = {},
): TenuredProjectionResult {
  // account_number is created by ensureAccountSchema, not runMigrations, so on
  // a database no account code has touched it does not exist and the candidate
  // query throws `no such column`. Twice now that has silently disabled a
  // feature; ask for the schema rather than assume it.
  ensureAccountSchema();
  const limit = Math.max(1, Math.min(50_000, opts.limit ?? 5_000));
  const res: TenuredProjectionResult = {
    considered: 0, created: 0, alreadyLead: 0,
    skippedNoCoords: 0, skippedKeyless: 0, errors: [],
  };

  const where: string[] = [
    "s.tenant_id = ?",
    "s.last_scanned_at IS NOT NULL",
    "s.last_fiber_status = 'tenured_fiber'",
    // The one signal never contradicted by the provider. Anything else -
    // including a NULL billing - is not evidence that the door is open.
    "s.last_billing_status = 'N'",
    "s.last_customer_segment <> 'existing_customer'",
    "s.account_number IS NULL",
  ];
  const args: any[] = [tenantId];
  if (opts.state) { where.push("s.state = ?"); args.push(opts.state); }
  if (opts.city) { where.push("lower(trim(s.city)) = ?"); args.push(opts.city.toLowerCase().trim()); }

  const candidates = rawDb.prepare(
    `SELECT s.id, s.address, s.city, s.state, s.zip, s.lat, s.lng, s.carrier,
            s.last_billing_status
       FROM scan_targets s
      WHERE ${where.join(" AND ")}
        AND s.converted_to_lead_id IS NULL
      ORDER BY s.id
      LIMIT ?`,
  ).all(...args, limit) as any[];

  res.considered = candidates.length;
  if (!candidates.length) return res;

  // Idempotent by BOTH unique indexes on leads: canonical_key and
  // source_scan_target_id. A second run over the same doors inserts nothing.
  const insert = rawDb.prepare(
    `INSERT INTO leads
       (address,city,state,zip,lat,lng,fiber_status,is_new_deployment,is_new_fiber,is_tenured,
        household_segment_type,billing_status,lead_status,notes,deployment_notes,lead_tag,
        lead_score,tenant_id,source_scan_target_id,carrier,canonical_key,created_at,updated_at)
     VALUES (?,?,?,?,?,?, 'tenured_fiber', 0, 0, 1,
             'TENURED', ?, 'prospect', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(tenant_id, canonical_key) WHERE canonical_key IS NOT NULL DO NOTHING
     RETURNING id`);
  const link = rawDb.prepare(
    `UPDATE scan_targets SET converted_to_lead_id = ? WHERE id = ? AND tenant_id = ?`);
  const existsByKey = rawDb.prepare(
    `SELECT id FROM leads WHERE tenant_id = ? AND canonical_key = ? LIMIT 1`);
  const existsByTarget = rawDb.prepare(
    `SELECT id FROM leads WHERE tenant_id = ? AND source_scan_target_id = ? LIMIT 1`);

  const run = rawDb.transaction((batch: any[]) => {
    for (const c of batch) {
      if (c.lat == null || c.lng == null) { res.skippedNoCoords++; continue; }
      const key = normalizeKineticAddressKey(c.address, c.city, c.state, c.zip ?? "");
      if (!key) { res.skippedKeyless++; continue; }   // a keyless door cannot be deduped
      if (existsByKey.get(tenantId, key) || existsByTarget.get(tenantId, c.id)) {
        res.alreadyLead++;
        continue;
      }
      if (opts.dryRun) { res.created++; continue; }
      try {
        const row = insert.get(
          c.address, c.city, c.state, c.zip ?? "", c.lat, c.lng,
          c.last_billing_status ?? "N",
          "Tenured. Kinetic fiber at the address with no active service on it.",
          "TENURED + billing N: plant and history here, nobody on it.",
          TENURED_LEAD_TAG, TENURED_LEAD_SCORE, tenantId, c.id,
          c.carrier ?? "kinetic", key,
        ) as { id: number } | undefined;
        if (!row?.id) { res.alreadyLead++; continue; }  // lost the conflict race
        link.run(row.id, c.id, tenantId);
        res.created++;
      } catch (e: any) {
        if (res.errors.length < 10) res.errors.push(`${c.address}: ${String(e?.message ?? e).slice(0, 120)}`);
      }
    }
  });

  for (let i = 0; i < candidates.length; i += 250) run(candidates.slice(i, i + 250));

  structuredLog("tenured_leads.projected", {
    tenantId, considered: res.considered, created: res.created,
    alreadyLead: res.alreadyLead, dryRun: !!opts.dryRun,
  });
  return res;
}

/** How many doors are waiting, without writing anything. */
export function countTenuredOpenCandidates(tenantId: number, state?: string): number {
  ensureAccountSchema();
  const extra = state ? " AND s.state = ?" : "";
  const args: any[] = state ? [tenantId, state] : [tenantId];
  return (rawDb.prepare(
    `SELECT COUNT(*) c FROM scan_targets s
      WHERE s.tenant_id = ? AND s.last_scanned_at IS NOT NULL
        AND s.last_fiber_status = 'tenured_fiber' AND s.last_billing_status = 'N'
        AND s.last_customer_segment <> 'existing_customer' AND s.account_number IS NULL
        AND s.converted_to_lead_id IS NULL${extra}`).get(...args) as any).c;
}
