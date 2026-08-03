// ── Commission statement assembly ─────────────────────────────────────────────
// Reads everything a statement needs out of the database and hands it to the
// PURE builder in shared/commissionStatement.ts. Nothing here decides money —
// it only fetches the authoritative rows (the statement, the week's doors, the
// spiffs, the reserve ledger) and names them.
//
// The statement's own row is the source of truth for a FINALIZED/PAID week: a
// locked week is read exactly as it was locked, including its frozen door
// snapshot, so re-printing last month's statement can never produce a different
// number than the one the rep was paid.

import { rawDb } from "./db";
import { storage } from "./storage";
import * as svc from "./commissionService";
import { hourlyBlockForStatement, sumWeekSpiffsByRep } from "./hourlyPay";
import { getReserveBalanceCents, resolveRepReserveConfig } from "./reserveService";
import {
  buildStatementDocument,
  type StatementDocInput,
  type StatementDocument,
  type StatementSaleInput,
} from "@shared/commissionStatement";

/** Raw sale rows come from two shapes (live query vs frozen snapshot JSON). */
function toSaleInput(row: any, basis: string, orgHouseAmountCents: number): StatementSaleInput {
  // The instant that placed this sale in the week, per the org's qualification
  // basis, with sold_at as the documented fallback (same COALESCE the ledger
  // query uses) so the statement orders doors the way the week counted them.
  const basisValue = row?.[basis] ?? row?.[camel(basis)] ?? null;
  const soldAt = row?.sold_at ?? row?.soldAt ?? "";
  // A per-sale override wins; otherwise the org default, and 0 means "unset"
  // rather than "free" — the builder hides the column when nothing is priced.
  const perSale = row?.house_amount_cents ?? row?.houseAmountCents ?? null;
  const houseAmountCents = perSale != null ? Math.trunc(Number(perSale))
    : orgHouseAmountCents > 0 ? orgHouseAmountCents
    : null;
  return {
    saleId: Number(row?.id ?? 0),
    externalId: String(row?.external_id ?? row?.externalId ?? ""),
    status: String(row?.status ?? "PENDING"),
    countedAtIso: String(basisValue ?? soldAt ?? ""),
    address: row?.address ?? null,
    city: row?.city ?? null,
    houseAmountCents,
  };
}

const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const BASIS_COLUMN: Record<string, string> = {
  SOLD_AT: "sold_at", QUALIFIED_AT: "qualified_at", INSTALLED_AT: "installed_at", ACTIVATED_AT: "activated_at",
};

/**
 * Build the printable document for one statement.
 *
 * `issuedAtIso` is injected rather than read from the clock so a test can pin
 * the whole document, and so a caller that renders the same statement twice in
 * one request stamps both copies identically.
 */
export function buildStatementDocumentFor(
  tenantId: number, statementId: number, issuedAtIso: string,
): StatementDocument | null {
  const stmt = svc.getStatementById(tenantId, statementId) as any;
  if (!stmt) return null;

  const config = svc.loadOrgConfig(tenantId);
  const rep = storage.getTeamMemberById(stmt.rep_id) as any;
  const tenant = rawDb.prepare(`SELECT company_name, owner_email FROM tenants WHERE id = ?`).get(tenantId) as any;

  // A locked week reads its FROZEN door snapshot; an open one reads live. The
  // fallback covers statements locked before the snapshot column existed.
  const locked = stmt.status === "FINALIZED" || stmt.status === "PAID";
  let rawSales: any[];
  if (locked && stmt.contributing_sales) {
    try { rawSales = JSON.parse(stmt.contributing_sales); }
    catch { rawSales = svc.listWeekSalesForRep(tenantId, stmt.rep_id, stmt.week_start_utc); }
  } else {
    rawSales = svc.listWeekSalesForRep(tenantId, stmt.rep_id, stmt.week_start_utc);
  }
  const basis = BASIS_COLUMN[String(stmt.qualification_basis)] ?? "qualified_at";
  const sales = (Array.isArray(rawSales) ? rawSales : []).map(r => toSaleInput(r, basis, config.houseAmountCents));

  const spiffCents = sumWeekSpiffsByRep(tenantId, stmt.week_start_utc, stmt.next_week_start_utc).get(stmt.rep_id) ?? 0;
  const hourly = hourlyBlockForStatement(stmt);
  const finalCents = Number(stmt.final_commission_cents ?? 0);
  // Per-rep, cap-aware split against the LIVE ledger balance — the same numbers
  // the reserve endpoints and the rep's reserve card report, so the statement
  // can never quote a holdback the ledger disagrees with.
  const holdback = svc.holdbackForStatement(tenantId, finalCents, stmt.rep_id);
  const reserveConfig = resolveRepReserveConfig(tenantId, stmt.rep_id);
  const reserveBalanceCents = getReserveBalanceCents(tenantId, stmt.rep_id);

  const input: StatementDocInput = {
    company: { name: tenant?.company_name || "Home Front Solutions", supportEmail: tenant?.owner_email ?? null },
    rep: { id: Number(stmt.rep_id), name: rep?.name || `Rep #${stmt.rep_id}` },
    period: {
      label: String(stmt.local_week_label ?? ""),
      startUtc: String(stmt.week_start_utc),
      nextStartUtc: String(stmt.next_week_start_utc),
      timezone: String(stmt.timezone ?? config.timezone),
    },
    statement: {
      id: Number(stmt.id),
      status: String(stmt.status),
      calculationVersion: Number(stmt.calculation_version ?? 1),
      tierLabel: stmt.tier_label ?? null,
      rateCents: Number(stmt.rate_cents ?? 0),
      structure: stmt.tier_id != null ? "TIERED" : (Number(stmt.rate_cents ?? 0) > 0 ? "FLAT" : null),
    },
    sales,
    money: {
      grossCommissionCents: Number(stmt.gross_commission_cents ?? 0),
      adjustmentCents: Number(stmt.adjustment_cents ?? 0),
      spiffCents,
      hourlyPayCents: hourly?.hourlyPayCents ?? 0,
      hourlyMinutes: Number(stmt.hourly_minutes ?? 0),
      hourlyRateCents: hourly?.rateCents ?? null,
      finalCommissionCents: finalCents,
    },
    holdback,
    reserve: {
      balanceCents: reserveBalanceCents,
      // 0 means "uncapped" in the reserve config; the document treats that as
      // "no ceiling to show" rather than a $0.00 cap the rep is already past.
      capCents: reserveConfig.reserveCapCents && reserveConfig.reserveCapCents > 0
        ? reserveConfig.reserveCapCents : null,
    },
    adjustments: svc.getStatementAdjustments(tenantId, stmt.id)
      .filter((a: any) => a.status === "APPROVED")
      .map((a: any) => ({
        id: Number(a.id), amountCents: Number(a.amount_cents ?? 0),
        reason: String(a.reason ?? ""), approvedAtIso: a.approved_at ?? null,
      })),
    issuedAtIso,
  };
  return buildStatementDocument(input);
}
