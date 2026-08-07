// ── Read-only reconciliation ─────────────────────────────────────────────────
//
// Detects money that does not add up. It NEVER repairs anything.
//
// That restraint is the design: an auto-corrector that is wrong pays someone the
// wrong amount and destroys the evidence of what it changed, whereas a detector
// that is wrong costs an operator five minutes. Every finding here names what it
// compared and what it expected, so a human can decide — and any repair goes
// through the existing audited adjustment/override-exception workflows, which
// already record who changed what and why.
//
// Every query is tenant-scoped and every finding carries the keys an operator
// needs to act: tenant, rep, sale, statement week, and a correlation id.

import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";
import { basisTsExprFor } from "./commissionService";

export type ReconciliationKind =
  | "QUALIFIED_SALE_MISSING_OVERRIDES"
  | "OVERRIDE_MISSING_FROM_STATEMENT"
  | "STATEMENT_TOTAL_MISMATCH"
  | "RESERVE_BALANCE_MISMATCH"
  | "APPROVED_REFERRAL_MISSING_EARNING"
  | "DUPLICATE_EARNING"
  | "SALE_WEEK_DISAGREES_WITH_BASIS"
  | "BLOCKED_QUEUE_EVENT"
  | "STALE_CLOSEOUT";

export interface ReconciliationFinding {
  kind: ReconciliationKind;
  severity: "critical" | "warning" | "info";
  tenantId: number | null;
  repId: number | null;
  saleId: number | null;
  statementWeekUtc: string | null;
  correlationId: string;
  detail: string;
  /** What was compared, so the operator does not have to re-derive it. */
  observed: Record<string, unknown>;
}

export interface ReconciliationReport {
  runId: string;
  generatedAt: string;
  tenantId: number | null;
  findings: ReconciliationFinding[];
  countsByKind: Record<string, number>;
}

const key = (runId: string, kind: string, parts: Array<string | number | null>) =>
  `${runId}:${kind}:${parts.filter(p => p != null).join("/")}`;

/**
 * Run every check. `tenantId` scopes the whole report; omit it only for a
 * platform-wide sweep.
 *
 * Read-only by construction: this module issues SELECTs exclusively.
 */
export function reconcile(opts: { tenantId?: number | null; nowIso: string; runId: string }): ReconciliationReport {
  const { tenantId = null, nowIso, runId } = opts;
  const findings: ReconciliationFinding[] = [];
  const scope = tenantId == null ? "" : " AND tenant_id = ?";
  const args = (extra: any[] = []) => (tenantId == null ? extra : [tenantId, ...extra]);
  const push = (f: Omit<ReconciliationFinding, "correlationId"> & { correlationId?: string }) =>
    findings.push({ ...f, correlationId: f.correlationId ?? key(runId, f.kind, [f.tenantId, f.repId, f.saleId, f.statementWeekUtc]) });

  // ── 1. Qualified sales with no override rows ───────────────────────────────
  // Only meaningful while overrides are switched ON and priced — a $0 slot
  // legitimately produces no row, so those tenants are excluded rather than
  // reported as thousands of false positives.
  for (const r of rawDb.prepare(
    `SELECT cs.id AS saleId, cs.tenant_id AS tenantId, cs.rep_id AS repId, cs.external_id AS externalId
       FROM commission_sales cs
       JOIN tenants t ON t.id = cs.tenant_id
      WHERE cs.status = 'QUALIFIED'
        AND COALESCE(t.commission_override_enabled, 0) = 1
        AND (COALESCE(t.commission_override_team_lead_cents,0) > 0 OR COALESCE(t.commission_override_manager_cents,0) > 0)
        AND NOT EXISTS (SELECT 1 FROM commission_overrides o WHERE o.source_ref = 'sale:' || cs.id)
        ${tenantId == null ? "" : "AND cs.tenant_id = ?"}
      LIMIT 500`,
  ).all(...(tenantId == null ? [] : [tenantId])) as any[]) {
    push({
      kind: "QUALIFIED_SALE_MISSING_OVERRIDES", severity: "critical",
      tenantId: r.tenantId, repId: r.repId, saleId: r.saleId, statementWeekUtc: null,
      detail: `Qualified sale ${r.externalId} has no override ledger rows while overrides are enabled and priced.`,
      observed: { externalId: r.externalId },
    });
  }

  // ── 2. PAYABLE overrides in a week whose statement never folded them ───────
  for (const r of rawDb.prepare(
    `SELECT o.tenant_id AS tenantId, o.beneficiary_rep_id AS repId, o.earned_week_start_utc AS week,
            SUM(o.amount_cents) AS ledgerCents,
            (SELECT s.override_pay_cents FROM commission_statements s
              WHERE s.tenant_id = o.tenant_id AND s.rep_id = o.beneficiary_rep_id
                AND s.week_start_utc = o.earned_week_start_utc) AS statementCents
       FROM commission_overrides o
      WHERE o.status = 'PAYABLE' ${tenantId == null ? "" : "AND o.tenant_id = ?"}
      GROUP BY o.tenant_id, o.beneficiary_rep_id, o.earned_week_start_utc`,
  ).all(...(tenantId == null ? [] : [tenantId])) as any[]) {
    const ledger = Number(r.ledgerCents ?? 0);
    const stmt = r.statementCents == null ? null : Number(r.statementCents);
    if (stmt !== ledger) {
      push({
        kind: "OVERRIDE_MISSING_FROM_STATEMENT", severity: "critical",
        tenantId: r.tenantId, repId: r.repId, saleId: null, statementWeekUtc: r.week,
        detail: stmt == null
          ? `PAYABLE overrides total ${ledger}c but no statement exists for that week.`
          : `Statement override block is ${stmt}c while the PAYABLE ledger sums to ${ledger}c.`,
        observed: { ledgerCents: ledger, statementCents: stmt },
      });
    }
  }

  // ── 3. Statement totals that do not satisfy the documented invariant ───────
  // final = gross + adjustments + overrides. Any drift means one of the three
  // was written without the others being recomputed.
  for (const r of rawDb.prepare(
    `SELECT id, tenant_id AS tenantId, rep_id AS repId, week_start_utc AS week, status,
            gross_commission_cents AS gross, adjustment_cents AS adj,
            COALESCE(override_pay_cents,0) AS ovr, final_commission_cents AS final
       FROM commission_statements
      WHERE 1=1 ${scope}`,
  ).all(...args()) as any[]) {
    const expected = Number(r.gross) + Number(r.adj) + Number(r.ovr);
    if (expected !== Number(r.final)) {
      push({
        kind: "STATEMENT_TOTAL_MISMATCH", severity: "critical",
        tenantId: r.tenantId, repId: r.repId, saleId: null, statementWeekUtc: r.week,
        detail: `Statement ${r.id} (${r.status}): gross+adjustments+overrides = ${expected}c but final = ${r.final}c.`,
        observed: { gross: r.gross, adjustments: r.adj, overrides: r.ovr, final: r.final, expected },
      });
    }
  }

  // ── 4. Reserve balances vs the append-only reserve ledger ──────────────────
  for (const r of rawDb.prepare(
    `SELECT tenant_id AS tenantId, rep_id AS repId, SUM(amount_cents) AS balance, COUNT(*) AS entries
       FROM reserve_entries WHERE 1=1 ${scope}
      GROUP BY tenant_id, rep_id`,
  ).all(...args()) as any[]) {
    if (Number(r.balance) < 0) {
      push({
        kind: "RESERVE_BALANCE_MISMATCH", severity: "critical",
        tenantId: r.tenantId, repId: r.repId, saleId: null, statementWeekUtc: null,
        detail: `Reserve ledger sums to a NEGATIVE balance (${r.balance}c) across ${r.entries} entries — more was released than held.`,
        observed: { balanceCents: Number(r.balance), entries: Number(r.entries) },
      });
    }
  }

  // ── 5. Qualified referrals with no earnings row ────────────────────────────
  if (tableExists("referrals") && tableExists("earnings_ledger")) {
    for (const r of rawDb.prepare(
      `SELECT rf.id AS referralId, rf.tenant_id AS tenantId, rf.referrer_rep_id AS repId, rf.status
         FROM referrals rf
        WHERE rf.status IN ('QUALIFIED','APPROVED','qualified','approved')
          AND NOT EXISTS (
            SELECT 1 FROM earnings_ledger e
             WHERE e.tenant_id = rf.tenant_id AND e.recipient_rep_id = rf.referrer_rep_id
               AND e.earning_type = 'REFERRAL_REWARD')
          ${tenantId == null ? "" : "AND rf.tenant_id = ?"}
        LIMIT 500`,
    ).all(...(tenantId == null ? [] : [tenantId])) as any[]) {
      push({
        kind: "APPROVED_REFERRAL_MISSING_EARNING", severity: "warning",
        tenantId: r.tenantId, repId: r.repId, saleId: null, statementWeekUtc: null,
        detail: `Referral ${r.referralId} is ${r.status} but the referrer has no REFERRAL_REWARD earnings row.`,
        observed: { referralId: r.referralId, status: r.status },
      });
    }
  }

  // ── 6. Duplicate earnings for one source event ─────────────────────────────
  // The unique index is supposed to make this impossible; if it ever appears,
  // an idempotency key has drifted and someone is being paid twice.
  // The column is added by the incentive subscriber's schema, so guard on the
  // COLUMN rather than the table — a deployment without the engine loaded
  // still has `spiffs`.
  if (columnExists("spiffs", "source_event_id")) for (const r of rawDb.prepare(
    `SELECT tenant_id AS tenantId, rep_id AS repId, source_event_id AS eventId, COUNT(*) AS n
       FROM spiffs WHERE source_event_id IS NOT NULL ${scope}
      GROUP BY tenant_id, rep_id, source_event_id HAVING COUNT(*) > 1`,
  ).all(...args()) as any[]) {
    push({
      kind: "DUPLICATE_EARNING", severity: "critical",
      tenantId: r.tenantId, repId: r.repId, saleId: null, statementWeekUtc: null,
      detail: `Event ${r.eventId} produced ${r.n} awards for one rep — an idempotency key has drifted.`,
      observed: { sourceEventId: r.eventId, count: Number(r.n) },
    });
  }

  // ── 7. Sales counted in a week their own basis snapshot disagrees with ─────
  // The invariant the basis-snapshot work established: a sale's pay week must
  // follow the basis frozen on the sale, not any live configuration.
  for (const t of tenantsInScope(tenantId)) {
    const expr = basisTsExprFor(t.id);
    for (const r of rawDb.prepare(
      `SELECT cs.id AS saleId, cs.rep_id AS repId, cs.external_id AS externalId,
              cs.qualification_basis AS basis, (${expr}) AS basisTs, cs.sold_at AS soldAt
         FROM commission_sales cs
        WHERE cs.tenant_id = ? AND cs.status = 'QUALIFIED' AND cs.qualification_basis IS NOT NULL
          AND (${expr}) IS NULL
        LIMIT 200`,
    ).all(t.id) as any[]) {
      push({
        kind: "SALE_WEEK_DISAGREES_WITH_BASIS", severity: "warning",
        tenantId: t.id, repId: r.repId, saleId: r.saleId, statementWeekUtc: null,
        detail: `Sale ${r.externalId} is QUALIFIED with basis ${r.basis} but that timestamp is not set, so it counts in no week.`,
        observed: { basis: r.basis, soldAt: r.soldAt },
      });
    }
  }

  // ── 8. Queue events holding the line ───────────────────────────────────────
  if (tableExists("event_processing_state")) {
    for (const r of rawDb.prepare(
      `SELECT event_id AS eventId, tenant_id AS tenantId, subscriber, status, attempts,
              error_fingerprint AS fingerprint, first_failed_at AS firstFailedAt
         FROM event_processing_state
        WHERE status IN ('blocked','failed') ${tenantId == null ? "" : "AND (tenant_id = ? OR tenant_id IS NULL)"}`,
    ).all(...(tenantId == null ? [] : [tenantId])) as any[]) {
      push({
        kind: "BLOCKED_QUEUE_EVENT", severity: r.status === "blocked" ? "critical" : "warning",
        tenantId: r.tenantId ?? null, repId: null, saleId: null, statementWeekUtc: null,
        correlationId: key(runId, "BLOCKED_QUEUE_EVENT", [r.subscriber, r.eventId]),
        detail: `Event ${r.eventId} on "${r.subscriber}" is ${r.status} after ${r.attempts} attempt(s); later events cannot be processed until it is cleared.`,
        observed: { eventId: r.eventId, subscriber: r.subscriber, attempts: r.attempts, fingerprint: r.fingerprint, firstFailedAt: r.firstFailedAt },
      });
    }
  }

  // ── 9. Weeks that have ended but never closed ──────────────────────────────
  const staleCutoff = new Date(Date.parse(nowIso) - 14 * 86_400_000).toISOString();
  for (const r of rawDb.prepare(
    `SELECT tenant_id AS tenantId, rep_id AS repId, week_start_utc AS week, status, final_commission_cents AS final
       FROM commission_statements
      WHERE status = 'OPEN' AND next_week_start_utc < ?
        ${tenantId == null ? "" : "AND tenant_id = ?"}
      LIMIT 500`,
  ).all(...(tenantId == null ? [staleCutoff] : [staleCutoff, tenantId])) as any[]) {
    push({
      kind: "STALE_CLOSEOUT", severity: "warning",
      tenantId: r.tenantId, repId: r.repId, saleId: null, statementWeekUtc: r.week,
      detail: `Week ${r.week} ended over 14 days ago and is still OPEN (${r.final}c unpaid).`,
      observed: { finalCents: r.final },
    });
  }

  const countsByKind: Record<string, number> = {};
  for (const f of findings) countsByKind[f.kind] = (countsByKind[f.kind] ?? 0) + 1;
  const critical = findings.filter(f => f.severity === "critical").length;
  structuredLog("reconciliation.completed", { runId, tenantId, findings: findings.length, critical, ...countsByKind },
    critical > 0 ? "error" : "info");

  return { runId, generatedAt: nowIso, tenantId, findings, countsByKind };
}

function tableExists(name: string): boolean {
  return !!rawDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

function columnExists(table: string, column: string): boolean {
  if (!tableExists(table)) return false;
  return (rawDb.prepare(`PRAGMA table_info(${table})`).all() as any[]).some(c => c.name === column);
}

function tenantsInScope(tenantId: number | null): Array<{ id: number }> {
  return tenantId == null
    ? (rawDb.prepare(`SELECT id FROM tenants`).all() as any[])
    : [{ id: tenantId }];
}
