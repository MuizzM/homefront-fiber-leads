// ── Matching a commission line to the order and sale it pays for ─────────────
//
// The submitted-orders matcher (orderMatching.ts) had seven rungs because its
// file carries the carrier's own order id. THIS file carries none: the
// Commission File has no Chuzo order number, and the POE report has no account
// number, so on first contact the two planes share no machine identity at all.
// What this ladder has instead is one hard key that has to be EARNED and a
// review tier that earns it:
//
//   1.00  account number == vendor_orders.account_key
//   0.95  account number == commission_sales.customer_account_number
//   0.75  customer name + act/deact date near the sale's own dates   REVIEW
//
// The account number reaches those tables one way only: a human confirms a
// line against a sale in the review queue, and the confirmation stamps the
// account onto the sale AND the vendor order. So the first file an
// organization imports lands almost entirely with a human, and every file
// after it matches the confirmed accounts exactly. That is the intended
// shape, not a degraded one: this ladder attaches MONEY, and money never
// moves on a name looking similar.
//
// The review rung deliberately scores below AUTO_MATCH_CONFIDENCE. Product
// family does not gate it - the commission file itemizes the security add-on
// and the tech-support line under the SAME account and document as the fiber
// plan, so a family disagreement with the order's headline product is
// expected, not disqualifying. Ambiguity is a refusal here for the same
// reason it is in orderMatching: two candidates means a human, never a coin
// flip with someone's commission.

import { rawDb } from "./db";
import { AUTO_MATCH_CONFIDENCE } from "./orderMatching";
import { normalizePersonName } from "@shared/orderStatusSource";
import type { NormalizedCommissionLine } from "@shared/commissionSource";
import type { MatchStatus } from "./vendorOrderMigrations";
import { PROVIDER as ORDER_PROVIDER } from "./vendorOrderStore";

/** How far an act/deact date may sit from the sale's own dates for the review
 *  rung. Activation follows the door by days to weeks; the far edge covers a
 *  construction-delayed install and the near edge a report keyed early. */
export const ACTIVATION_BEFORE_BASIS_DAYS = 7;
export const ACTIVATION_AFTER_BASIS_DAYS = 75;

export interface CommissionMatchCandidate {
  saleId: number | null;
  vendorOrderId: number | null;
  repId: number | null;
  leadId: number | null;
  label: string;
  rule: string;
  confidence: number;
}

export interface CommissionMatchResult {
  status: MatchStatus;
  rule: string | null;
  confidence: number;
  saleId: number | null;
  vendorOrderId: number | null;
  repId: number | null;
  leadId: number | null;
  exceptionReason: string | null;
  candidates: CommissionMatchCandidate[];
}

/** Money attaches at or above this and nowhere else. One definition, exported
 *  so the store, the worker and the tests all gate on the same line. */
export function commissionMatchIsPayable(result: Pick<CommissionMatchResult, "status" | "confidence">): boolean {
  return result.status === "matched" && result.confidence >= AUTO_MATCH_CONFIDENCE;
}

interface OrderRow {
  id: number; sale_id: number | null; lead_id: number | null; rep_id: number | null;
  customer_name: string | null; service_address: string | null; carrier: string | null;
  submitted_date: string | null; install_date: string | null; rep_external_name: string | null;
}

interface SaleRow {
  id: number; rep_id: number; lead_id: number | null; sold_at: string;
  qualified_at: string | null; installed_at: string | null; activated_at: string | null;
  customer_account_number: string | null;
  lead_address: string | null; lead_city: string | null; lead_state: string | null;
  lead_contact_name: string | null; lead_owner_name: string | null; rep_name: string | null;
}

const SALE_SELECT = `
  SELECT s.id, s.rep_id, s.lead_id, s.sold_at, s.qualified_at, s.installed_at, s.activated_at,
         s.customer_account_number,
         l.address AS lead_address, l.city AS lead_city, l.state AS lead_state,
         l.contact_name AS lead_contact_name, l.owner_name AS lead_owner_name,
         t.name AS rep_name
    FROM commission_sales s
    LEFT JOIN leads l ON l.id = s.lead_id
    LEFT JOIN team_members t ON t.id = s.rep_id
`;

/**
 * Resolve one commission line against the CRM. Pure of side effects, exactly
 * like matchVendorOrder: it reads and returns a verdict, and the caller writes
 * it - which is what lets the review queue re-run a match after a resolution
 * stamps an account number, without the import machinery involved.
 */
export function matchCommissionLine(tenantId: number, line: NormalizedCommissionLine): CommissionMatchResult {
  if (line.category === "payment_batch") {
    return {
      status: "ignored", rule: "payment_batch", confidence: 0,
      saleId: null, vendorOrderId: null, repId: null, leadId: null,
      exceptionReason: "The weekly payout total, not an order line. Recorded for reconciliation only.",
      candidates: [],
    };
  }

  // ── Rung 1: the account number on a vendor order ───────────────────────
  if (line.accountKey) {
    const orders = rawDb.prepare(`
      SELECT id, sale_id, lead_id, rep_id, customer_name, service_address, carrier,
             submitted_date, install_date, rep_external_name
        FROM vendor_orders
       WHERE tenant_id = ? AND provider = ? AND account_key = ?
       ORDER BY id ASC LIMIT 6
    `).all(tenantId, ORDER_PROVIDER, line.accountKey) as OrderRow[];
    if (orders.length === 1) {
      const o = orders[0];
      return {
        status: "matched", rule: "order_account_number", confidence: 1,
        saleId: o.sale_id, vendorOrderId: o.id, repId: o.rep_id, leadId: o.lead_id,
        exceptionReason: null,
        candidates: [orderCandidate(o, "order_account_number", 1)],
      };
    }
    if (orders.length > 1) {
      return refuse(orders.map((o) => orderCandidate(o, "order_account_number", 1)),
        "order_account_number", 1,
        "More than one order carries this account number. Pick which order this line pays for.");
    }
  }

  // ── Rung 2: the account number stamped on a sale ───────────────────────
  // Slightly below the order rung the way orderMatching scores accounts below
  // order ids: an account identifies a SUBSCRIBER, and a subscriber can buy
  // twice. Compared on the normalized form because the stored column holds
  // whatever a human or an earlier import keyed.
  if (line.accountKey) {
    const stamped = (rawDb.prepare(`
      ${SALE_SELECT}
      WHERE s.tenant_id = ? AND s.customer_account_number IS NOT NULL AND s.customer_account_number <> ''
      LIMIT 5000
    `).all(tenantId) as SaleRow[])
      .filter((s) => normalizeLoose(s.customer_account_number) === line.accountKey);
    if (stamped.length === 1) {
      const sale = stamped[0];
      return {
        status: "matched", rule: "sale_account_number", confidence: 0.95,
        saleId: sale.id, vendorOrderId: orderIdForSale(tenantId, sale.id), repId: sale.rep_id, leadId: sale.lead_id,
        exceptionReason: null,
        candidates: [saleCandidate(sale, "sale_account_number", 0.95)],
      };
    }
    if (stamped.length > 1) {
      return refuse(stamped.map((s) => saleCandidate(s, "sale_account_number", 0.95)),
        "sale_account_number", 0.95,
        "More than one sale carries this account number. Pick which sale this line pays for.");
    }
  }

  // ── The review rung: customer name plus dates ──────────────────────────
  const customer = normalizePersonName(line.customerName);
  if (!customer) {
    return {
      status: "unmatched", rule: null, confidence: 0,
      saleId: null, vendorOrderId: null, repId: null, leadId: null,
      exceptionReason: "No account number matched and the line carries no customer name to review by.",
      candidates: [],
    };
  }

  const anchor = line.actDeactDate ?? line.uploadDate ?? null;
  const candidates = mergeCandidates([
    ...orderNameCandidates(tenantId, customer, line, anchor),
    ...saleNameCandidates(tenantId, customer, anchor),
  ]);

  if (candidates.length === 1) {
    const hit = candidates[0];
    return {
      status: "matched_low_confidence", rule: hit.rule, confidence: 0.75,
      // Recorded on the line for the review screen, attributed to nothing:
      // the store attaches money only at commissionMatchIsPayable.
      saleId: hit.saleId, vendorOrderId: hit.vendorOrderId, repId: hit.repId, leadId: hit.leadId,
      exceptionReason: "Matched on the customer's name and the dates only. Confirm before this money attaches to the sale.",
      candidates,
    };
  }
  if (candidates.length > 1) {
    return refuse(candidates, "name_and_date", 0.75,
      "More than one sale or order fits this customer name and date window.");
  }

  return {
    status: "unmatched", rule: null, confidence: 0,
    saleId: null, vendorOrderId: null, repId: null, leadId: null,
    exceptionReason: "No sale or order in this organization fits this line's customer and dates.",
    candidates: [],
  };
}

// ── Candidate generation ─────────────────────────────────────────────────────

function orderNameCandidates(
  tenantId: number, customer: string, line: NormalizedCommissionLine, anchor: Date | null,
): CommissionMatchCandidate[] {
  const rows = (anchor
    ? rawDb.prepare(`
        SELECT id, sale_id, lead_id, rep_id, customer_name, service_address, carrier,
               submitted_date, install_date, rep_external_name
          FROM vendor_orders
         WHERE tenant_id = ? AND provider = ? AND customer_name IS NOT NULL
           AND (
             (install_date IS NOT NULL AND install_date >= ? AND install_date <= ?) OR
             (submitted_date IS NOT NULL AND submitted_date >= ? AND submitted_date <= ?)
           )
         ORDER BY id DESC LIMIT 2000
      `).all(
        tenantId, ORDER_PROVIDER,
        iso(addDays(anchor, -ACTIVATION_AFTER_BASIS_DAYS)), iso(addDays(anchor, ACTIVATION_BEFORE_BASIS_DAYS + 7)),
        iso(addDays(anchor, -ACTIVATION_AFTER_BASIS_DAYS)), iso(addDays(anchor, ACTIVATION_BEFORE_BASIS_DAYS)),
      )
    : rawDb.prepare(`
        SELECT id, sale_id, lead_id, rep_id, customer_name, service_address, carrier,
               submitted_date, install_date, rep_external_name
          FROM vendor_orders
         WHERE tenant_id = ? AND provider = ? AND customer_name IS NOT NULL
         ORDER BY id DESC LIMIT 500
      `).all(tenantId, ORDER_PROVIDER)) as OrderRow[];

  return rows
    .filter((o) => namesAgree(customer, [o.customer_name]))
    .filter((o) => carriersAgree(line.program, o.carrier))
    .map((o) => orderCandidate(o, "order_name_and_date", 0.75));
}

function saleNameCandidates(tenantId: number, customer: string, anchor: Date | null): CommissionMatchCandidate[] {
  const rows = (anchor
    ? rawDb.prepare(`
        ${SALE_SELECT}
        WHERE s.tenant_id = ? AND s.sold_at >= ? AND s.sold_at <= ?
        ORDER BY s.id DESC LIMIT 2000
      `).all(tenantId, iso(addDays(anchor, -(ACTIVATION_AFTER_BASIS_DAYS + 15))), iso(addDays(anchor, ACTIVATION_BEFORE_BASIS_DAYS)))
    : rawDb.prepare(`${SALE_SELECT} WHERE s.tenant_id = ? ORDER BY s.id DESC LIMIT 500`).all(tenantId)) as SaleRow[];

  return rows
    .filter((s) => namesAgree(customer, [s.lead_contact_name, s.lead_owner_name]))
    .filter((s) => saleDatesAgree(s, anchor))
    .map((s) => saleCandidate(s, "sale_name_and_date", 0.75));
}

/** The sale-side date test: the act/deact date sits inside a window around the
 *  sale's best-known progress date (activated, else installed, else qualified,
 *  else sold). One rule, so the queue's "why is this here" is explainable. */
function saleDatesAgree(sale: SaleRow, anchor: Date | null): boolean {
  if (!anchor) return true;
  const basisText = sale.activated_at ?? sale.installed_at ?? sale.qualified_at ?? sale.sold_at;
  const basis = Date.parse(basisText);
  if (!Number.isFinite(basis)) return false;
  const deltaDays = (anchor.getTime() - basis) / 86_400_000;
  return deltaDays >= -ACTIVATION_BEFORE_BASIS_DAYS && deltaDays <= ACTIVATION_AFTER_BASIS_DAYS;
}

/** Two candidates that point at the same sale are one candidate; the one that
 *  also knows its vendor order wins, because it can carry the money further. */
function mergeCandidates(all: CommissionMatchCandidate[]): CommissionMatchCandidate[] {
  const byId = new Map<string, CommissionMatchCandidate>();
  for (const c of all) {
    const key = c.saleId != null ? `s${c.saleId}` : `o${c.vendorOrderId}`;
    const existing = byId.get(key);
    if (!existing || (existing.vendorOrderId == null && c.vendorOrderId != null)) byId.set(key, c);
  }
  return [...byId.values()].slice(0, 5);
}

// ── Comparisons ──────────────────────────────────────────────────────────────

/** Same token-overlap semantics orderMatching applies to customer names: a
 *  forename and a surname shared, or an exact single-token match. */
function namesAgree(customer: string, targets: (string | null)[]): boolean {
  const wanted = new Set(customer.split(" ").filter((p) => p.length > 1));
  return targets.some((t) => {
    const norm = normalizePersonName(t);
    if (!norm) return false;
    const parts = norm.split(" ").filter((p) => p.length > 1);
    if (parts.length === 0) return false;
    const shared = parts.filter((p) => wanted.has(p)).length;
    return shared >= 2 || (parts.length === 1 && wanted.has(parts[0]) && wanted.size === 1);
  });
}

/** Windstream sells door-to-door as Kinetic, so the file's Program column and
 *  the order's carrier column name the same company two ways. Both known and
 *  neither a synonym nor a substring of the other excludes the candidate;
 *  anything unknown stays neutral, same one-sidedness as orderMatching. */
const CARRIER_SYNONYMS: readonly (readonly string[])[] = [["WINDSTREAM", "KINETIC"]];

function carriersAgree(program: string | null, carrier: string | null): boolean {
  const a = normalizeLoose(program);
  const b = normalizeLoose(carrier);
  if (!a || !b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  return CARRIER_SYNONYMS.some((set) => set.some((s) => a.includes(s)) && set.some((s) => b.includes(s)));
}

function normalizeLoose(value: unknown): string | null {
  if (value == null) return null;
  const compact = String(value).trim().replace(/[\s._-]+/g, "").toUpperCase();
  return compact || null;
}

/** The newest vendor order attached to a sale, for carrying a sale-rung match
 *  through to the order timeline. Null when the order plane has not seen it. */
function orderIdForSale(tenantId: number, saleId: number): number | null {
  const row = rawDb.prepare(`
    SELECT id FROM vendor_orders WHERE tenant_id = ? AND sale_id = ? ORDER BY id DESC LIMIT 1
  `).get(tenantId, saleId) as any;
  return row ? Number(row.id) : null;
}

// ── Verdict constructors ─────────────────────────────────────────────────────

function refuse(
  candidates: CommissionMatchCandidate[], rule: string, confidence: number, reason: string,
): CommissionMatchResult {
  return {
    status: "exception", rule, confidence,
    saleId: null, vendorOrderId: null, repId: null, leadId: null,
    exceptionReason: reason,
    candidates: candidates.slice(0, 5),
  };
}

function orderCandidate(o: OrderRow, rule: string, confidence: number): CommissionMatchCandidate {
  const when = (o.install_date ?? o.submitted_date ?? "").slice(0, 10);
  return {
    saleId: o.sale_id, vendorOrderId: o.id, repId: o.rep_id, leadId: o.lead_id,
    label: `${o.customer_name ?? "Unknown customer"} - ${o.service_address ?? "no address"} - ${o.rep_external_name ?? "unknown rep"}${when ? ` - ${when}` : ""}`,
    rule, confidence,
  };
}

function saleCandidate(s: SaleRow, rule: string, confidence: number): CommissionMatchCandidate {
  const where = [s.lead_address, s.lead_city, s.lead_state].filter(Boolean).join(", ");
  return {
    saleId: s.id, vendorOrderId: null, repId: s.rep_id, leadId: s.lead_id,
    label: `${where || "No address on file"} - ${s.rep_name ?? "unknown rep"} - sold ${String(s.sold_at).slice(0, 10)}`,
    rule, confidence,
  };
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function iso(d: Date): string {
  return d.toISOString();
}
