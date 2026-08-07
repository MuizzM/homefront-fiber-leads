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
 *
 * For a LOCKED week the caller's clock is overridden by the statement's own
 * `finalized_at`: a pay document is evidence of what was paid and when it was
 * issued, so re-downloading last month's statement must reproduce the same
 * page, not one stamped "generated today". An OPEN week has no issue date yet —
 * it keeps the request clock and is marked a draft (see `isDraft`), because a
 * live-recomputing week is a preview, never a pay document.
 */
export function buildStatementDocumentFor(
  tenantId: number, statementId: number, issuedAtIso: string,
): StatementDocument | null {
  const stmt = svc.getStatementById(tenantId, statementId) as any;
  if (!stmt) return null;

  const config = svc.loadOrgConfig(tenantId);
  const rep = storage.getTeamMemberById(stmt.rep_id) as any;
  const tenant = rawDb.prepare(`SELECT company_name, owner_email, brand_logo FROM tenants WHERE id = ?`).get(tenantId) as any;

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
  let holdback = svc.holdbackForStatement(tenantId, finalCents, stmt.rep_id);
  const reserveConfig = resolveRepReserveConfig(tenantId, stmt.rep_id);
  const reserveBalanceCents = getReserveBalanceCents(tenantId, stmt.rep_id);

  // A LOCKED week's holdback comes from the append-only reserve ledger, never
  // from a live recompute.
  //
  // holdbackForStatement resolves the CURRENT org/rep percent and cap against
  // the CURRENT running balance, so a settled statement re-printed later showed
  // whatever those happen to be today — and `netPayCents = earned - reserve` is
  // the hero figure on the page. Two people downloading the same statement id on
  // different days could see different net pay, and a statement could print "$0
  // withheld" while its own reserve_entries row said $160. reserveService states
  // the rule for exactly this reason: "Report the RECORDED amount — never
  // recompute it, or a display could disagree with the ledger that actually
  // paid." An OPEN week has no recorded hold yet and is already marked a draft,
  // so it keeps the live computation.
  if (locked) {
    const held = rawDb.prepare(
      `SELECT amount_cents AS amountCents FROM reserve_entries
       WHERE tenant_id = ? AND rep_id = ? AND kind = 'hold' AND week_start_utc = ?`,
    ).get(tenantId, stmt.rep_id, stmt.week_start_utc) as any;
    const recordedCents = Math.max(0, Math.trunc(Number(held?.amountCents ?? 0)));
    const earnedCents = Math.trunc(holdback.earnedCents ?? finalCents);
    holdback = {
      ...holdback,
      reserveCents: recordedCents,
      netPayableCents: earnedCents - recordedCents,
      // The EFFECTIVE rate this week was actually held at — a cap can make it
      // lower than the configured percent, and the label must agree with the
      // two numbers beside it rather than quote today's setting.
      reservePercent: earnedCents > 0 ? Math.round((recordedCents / earnedCents) * 100) : 0,
    };
  }

  const input: StatementDocInput = {
    company: {
      name: tenant?.company_name || "Home Front Solutions",
      supportEmail: tenant?.owner_email ?? null,
      // Validated at the boundary so neither renderer has to trust the column.
      logoDataUri: sanitizeLogoDataUri(tenant?.brand_logo),
    },
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
      // Frozen with the statement (recomputed live for OPEN weeks by the calc
      // itself) — the doc never re-reads the override ledger, so a re-print of
      // a locked week can never disagree with what was paid.
      overrideCents: Number(stmt.override_pay_cents ?? 0),
      overrideItemCount: Number(stmt.override_item_count ?? 0),
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
    // A locked week is stamped with the moment it was actually issued, so a
    // re-print reproduces the original page rather than today's date. PAID keeps
    // finalized_at too: paying does not re-issue the statement, it settles it.
    issuedAtIso: (locked && stmt.finalized_at) ? String(stmt.finalized_at) : issuedAtIso,
    isDraft: !locked,
  };
  return buildStatementDocument(input);
}

// ── Tenant wordmark ──────────────────────────────────────────────────────────
// `tenants.brand_logo` is TEXT and, until now, was written by the super-admin
// console and read by nothing — so its storage form was undefined. It is a
// self-contained data URI, deliberately NOT a URL and NOT a filesystem path:
// rendering a pay document must never depend on a network fetch, and a path out
// of a mutable column is a traversal risk on the server that renders it.
//
// Anything malformed, oversized, or of an unsupported type returns null rather
// than throwing. That preserves the existing three-level fallback in the PDF
// (tenant logo → bundled HFS wordmark → type-set text), which exists because a
// missing image must never cost a rep their statement.
const MAX_LOGO_BYTES = 512 * 1024;
const LOGO_DATA_URI = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/;

export function sanitizeLogoDataUri(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const match = LOGO_DATA_URI.exec(raw.trim());
  if (!match) return null;
  let bytes: Buffer;
  try { bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64"); }
  catch { return null; }
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return null;
  // Verify the magic bytes match the DECLARED type. A mislabelled payload would
  // otherwise reach doc.image() and throw mid-render, turning a cosmetic
  // misconfiguration into a failed statement download.
  const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const declaredPng = match[1] === "png";
  if (declaredPng ? !isPng : !isJpeg) return null;
  return `data:image/${match[1]};base64,${bytes.toString("base64")}`;
}
