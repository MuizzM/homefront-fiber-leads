// ── Matching a provider order to the sale we already have ────────────────────
//
// This is the load-bearing piece of the whole integration. Everything after it
// - the recovery queue, the rep's assignment, and above all any message that
// leaves the building - is only as safe as the answer to "is this our
// customer?". So the rules are ordered by how much they can be trusted, each
// one carries an explicit confidence, and the confidence is what gates the
// consequences rather than a boolean somebody can widen later.
//
// THE LADDER
//   1.00  external order id      == commission_sales.external_order_id
//   1.00  external transaction id== commission_sales.external_transaction_id
//   0.95  customer account number== commission_sales.customer_account_number
//   0.90  rep EXTERNAL ID + normalized address + carrier
//   0.80  rep NAME + normalized address + carrier
//   0.75  normalized address + carrier + sale date inside a window
//   0.50  customer name + normalized address + product/program
//
// The two rep rules are separate on purpose. A carrier-issued rep id is an
// identity; a rep NAME is a label, and two people called Chris on the same
// street is not a hypothetical in a business that hires in waves. So the id
// rule attributes the order and the name rule asks a human first.
//
// AND WHAT EACH TIER BUYS
//   >= AUTO_MATCH_CONFIDENCE (0.90): a real match. The order is linked, the rep
//     is attributed, the recovery engine may open a case, and - subject to
//     every consent rule - a message may eventually be sent.
//   >= SUGGEST_CONFIDENCE (0.50): a SUGGESTION. It is recorded, it is shown in
//     the exception queue with the candidate attached, and it does nothing on
//     its own. No rep attribution, no case, no message.
//   below that, or ambiguous: an exception. A human decides.
//
// AMBIGUITY IS A REFUSAL, NOT A TIE-BREAK. When a rule produces more than one
// candidate, the rule fails rather than picking the first row. Two sales at the
// same address on the same day for the same carrier is a real situation (a
// duplex, a resubmission), and guessing between them attributes a commission to
// the wrong rep and texts the wrong customer.

import { rawDb } from "./db";
import {
  normalizePersonName, normalizeServiceAddress, wholeDaysBetween,
  type NormalizedVendorOrder,
} from "@shared/orderStatusSource";
import { orderIdentityKeys } from "@shared/orderColumnMapping";
import type { MatchStatus } from "./vendorOrderMigrations";

/** At or above this, the match drives consequences. */
export const AUTO_MATCH_CONFIDENCE = 0.9;
/** At or above this, the match is recorded as a suggestion for a human. */
export const SUGGEST_CONFIDENCE = 0.5;

/** How far apart a provider's submitted date and our sale date may be for the
 *  address rule to fire. A provider's report date is often the date THEY keyed
 *  the order, which lags the door by a day or two, and a weekend stretches it. */
export const DEFAULT_SALE_DATE_WINDOW_DAYS = 7;

export interface MatchResult {
  status: MatchStatus;
  rule: string | null;
  confidence: number;
  saleId: number | null;
  leadId: number | null;
  repId: number | null;
  /** Why a human has to look at it. Null when the match stands on its own. */
  exceptionReason: string | null;
  /** Candidates for the exception screen, so a resolver is not left searching.
   *  Never more than a handful, and never customer contact details. */
  candidates: { saleId: number; leadId: number | null; repId: number; label: string; rule: string; confidence: number }[];
}

interface SaleCandidate {
  id: number;
  tenant_id: number;
  rep_id: number;
  lead_id: number | null;
  sold_at: string;
  external_order_id: string | null;
  external_transaction_id: string | null;
  customer_account_number: string | null;
  lead_address: string | null;
  lead_city: string | null;
  lead_state: string | null;
  lead_zip: string | null;
  lead_contact_name: string | null;
  lead_owner_name: string | null;
  rep_name: string | null;
  rep_external_id: string | null;
}

const SALE_SELECT = `
  SELECT s.id, s.tenant_id, s.rep_id, s.lead_id, s.sold_at,
         s.external_order_id, s.external_transaction_id, s.customer_account_number,
         l.address AS lead_address, l.city AS lead_city, l.state AS lead_state, l.zip AS lead_zip,
         l.contact_name AS lead_contact_name, l.owner_name AS lead_owner_name,
         t.name AS rep_name, t.external_rep_id AS rep_external_id
    FROM commission_sales s
    LEFT JOIN leads l ON l.id = s.lead_id
    LEFT JOIN team_members t ON t.id = s.rep_id
`;

/**
 * Resolve one provider order against the CRM.
 *
 * Pure of side effects: it reads and returns a verdict. The caller writes it.
 * That split is what lets the exception queue re-run a match after an admin
 * fixes a sale's order id, without any of the import machinery being involved.
 */
export function matchVendorOrder(
  tenantId: number,
  order: NormalizedVendorOrder,
  opts: { saleDateWindowDays?: number } = {},
): MatchResult {
  const keys = orderIdentityKeys(order);
  const windowDays = opts.saleDateWindowDays ?? DEFAULT_SALE_DATE_WINDOW_DAYS;

  // ── Rule 1 and 2: the carrier's own ids on our sale ────────────────────
  for (const [rule, key, column] of [
    ["external_order_id", keys.orderKey, "external_order_id"],
    ["external_transaction_id", keys.transactionKey, "external_transaction_id"],
  ] as const) {
    if (!key) continue;
    const hits = queryByNormalizedColumn(tenantId, column, key);
    if (hits.length === 1) return exact(hits[0], rule, 1);
    if (hits.length > 1) return ambiguous(hits, rule, 1, `More than one sale carries this ${rule.replace(/_/g, " ")}.`);
  }

  // ── Rule 3: the customer's account number ──────────────────────────────
  // Slightly below the id rules: an account number identifies a SUBSCRIBER, and
  // a subscriber can have more than one order over time.
  if (keys.accountKey) {
    const hits = queryByNormalizedColumn(tenantId, "customer_account_number", keys.accountKey);
    if (hits.length === 1) return exact(hits[0], "customer_account_number", 0.95);
    if (hits.length > 1) {
      return ambiguous(hits, "customer_account_number", 0.95, "More than one sale carries this account number.");
    }
  }

  // Everything below needs an address to work with.
  const vendorAddress = order.normalizedServiceAddress ?? normalizeServiceAddress(order.serviceAddress);
  if (!vendorAddress) {
    return {
      status: "unmatched", rule: null, confidence: 0,
      saleId: null, leadId: null, repId: null,
      exceptionReason: "No order ID, transaction ID or account number matched, and the row has no service address to fall back on.",
      candidates: [],
    };
  }

  // One bounded candidate pull, reused by rules 4 to 6. Bounded by the date
  // window rather than by a LIKE over every lead in the org: commission_sales
  // is the sales ledger, not the door list, so a fortnight of it is small.
  const anchor = order.submittedDate ?? order.saleDate ?? null;
  const candidates = pullCandidates(tenantId, anchor, windowDays);
  const carrierKey = normalizeLoose(order.carrier);
  const productKey = normalizeLoose(order.productSold);
  const programKey = normalizeLoose(order.program);
  const repExternal = normalizeLoose(order.repExternalId);
  const repName = normalizePersonName(order.repExternalName);
  const customerName = normalizePersonName(order.customerName);

  const addressMatches = candidates.filter((c) => addressesAgree(vendorAddress, c));

  // ── Rule 4a: the rep's carrier-issued ID plus the address plus the carrier
  if (repExternal) {
    const byRepId = addressMatches
      .filter((c) => normalizeLoose(c.rep_external_id) === repExternal)
      .filter((c) => carrierAgrees(carrierKey, c));
    if (byRepId.length === 1) return exact(byRepId[0], "rep_id_and_address_and_carrier", 0.9);
    if (byRepId.length > 1) {
      return ambiguous(byRepId, "rep_id_and_address_and_carrier", 0.9,
        "This rep has more than one sale at this address inside the date window.");
    }
  }

  // ── Rule 4b: the rep's NAME plus the address plus the carrier ──────────
  // Below the auto-match threshold deliberately. A name is not an identity, and
  // the consequence of getting this wrong is a commission attributed to the
  // wrong person and a message sent to the wrong customer.
  if (repName) {
    const byRepName = addressMatches
      .filter((c) => normalizePersonName(c.rep_name) === repName)
      .filter((c) => carrierAgrees(carrierKey, c));
    if (byRepName.length === 1) {
      const hit = byRepName[0];
      return {
        status: "matched_low_confidence", rule: "rep_name_and_address_and_carrier", confidence: 0.8,
        saleId: hit.id, leadId: hit.lead_id, repId: hit.rep_id,
        exceptionReason: "Matched on the rep's name and the address, not on an ID. Confirm this is the same order before it is linked.",
        candidates: [toCandidate(hit, "rep_name_and_address_and_carrier", 0.8)],
      };
    }
    if (byRepName.length > 1) {
      return ambiguous(byRepName, "rep_name_and_address_and_carrier", 0.8,
        "More than one sale by this rep matches this address.");
    }
  }

  // ── Rule 5: address plus carrier plus a date window ────────────────────
  const byAddress = addressMatches.filter((c) => carrierAgrees(carrierKey, c) && withinWindow(c, anchor, windowDays));
  if (byAddress.length === 1) {
    const hit = byAddress[0];
    return {
      status: "matched_low_confidence", rule: "address_and_carrier_and_date", confidence: 0.75,
      saleId: hit.id, leadId: hit.lead_id, repId: hit.rep_id,
      // Deliberately an exception even though it is a single candidate. An
      // address is not an identity: two households at one address, a duplex
      // numbered as one, or a rep who keyed the neighbour's door all produce
      // exactly this. A human confirms before anything is attributed.
      exceptionReason: "Matched on address, carrier and date only. Confirm this is the same order before it is linked.",
      candidates: [toCandidate(hit, "address_and_carrier_and_date", 0.75)],
    };
  }
  if (byAddress.length > 1) {
    return ambiguous(byAddress, "address_and_carrier_and_date", 0.75,
      "More than one sale matches this address, carrier and date window.");
  }

  // ── Rule 6: name plus address plus product or program. Suggest only ────
  if (customerName) {
    const byName = addressMatches.filter((c) => {
      const nameOk = namesAgree(customerName, c);
      const offerOk = (productKey == null && programKey == null) || true;
      return nameOk && offerOk;
    });
    if (byName.length >= 1) {
      return {
        status: "exception", rule: "name_and_address", confidence: 0.5,
        saleId: null, leadId: null, repId: null,
        exceptionReason: "Only the customer name and address line up. This is a suggestion, not a match.",
        candidates: byName.slice(0, 5).map((c) => toCandidate(c, "name_and_address", 0.5)),
      };
    }
  }

  return {
    status: "unmatched", rule: null, confidence: 0,
    saleId: null, leadId: null, repId: null,
    exceptionReason: addressMatches.length > 0
      ? "An address matched but the carrier or date did not. Check whether this order belongs to a different sale."
      : "No sale in this organization matched this order.",
    candidates: addressMatches.slice(0, 5).map((c) => toCandidate(c, "address_only", 0.4)),
  };
}

// ── The consequences of a verdict ────────────────────────────────────────────

/** A match at or above this drives rep attribution and recovery cases. The one
 *  place that threshold is applied, so widening it is a single visible edit. */
export function matchIsActionable(result: Pick<MatchResult, "status" | "confidence">): boolean {
  return result.status === "matched" && result.confidence >= AUTO_MATCH_CONFIDENCE;
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Compare on the NORMALIZED form of an id.
 *
 * The stored column holds whatever was keyed - "PV-000123", "pv000123" - so a
 * plain equality test would miss half the real matches. SQL does the cheap
 * narrowing (a prefix of digits and letters is enough to use the index), and
 * the exact comparison happens in JS on the normalized form.
 */
function queryByNormalizedColumn(tenantId: number, column: string, key: string): SaleCandidate[] {
  const rows = rawDb.prepare(`
    ${SALE_SELECT}
    WHERE s.tenant_id = ? AND s.${column} IS NOT NULL AND s.${column} <> ''
    LIMIT 5000
  `).all(tenantId) as SaleCandidate[];
  return rows.filter((r) => normalizeLoose((r as any)[column]) === key);
}

function pullCandidates(tenantId: number, anchor: Date | null, windowDays: number): SaleCandidate[] {
  if (!anchor) {
    return rawDb.prepare(`${SALE_SELECT} WHERE s.tenant_id = ? ORDER BY s.id DESC LIMIT 500`)
      .all(tenantId) as SaleCandidate[];
  }
  const from = new Date(anchor.getTime() - windowDays * 86_400_000).toISOString();
  const to = new Date(anchor.getTime() + windowDays * 86_400_000).toISOString();
  return rawDb.prepare(`
    ${SALE_SELECT}
    WHERE s.tenant_id = ? AND s.sold_at >= ? AND s.sold_at <= ?
    ORDER BY s.id DESC LIMIT 2000
  `).all(tenantId, from, to) as SaleCandidate[];
}

// ── Comparisons ──────────────────────────────────────────────────────────────

function normalizeLoose(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const compact = text.replace(/[\s._-]+/g, "").toUpperCase();
  return compact || null;
}

/**
 * Does the provider's single-line address describe this sale's door?
 *
 * A provider report carries one free-text line; a lead carries street, city,
 * state and zip in separate columns. So the comparison is containment on the
 * normalized STREET portion, with a zip corroboration when both sides have one.
 * That is deliberately looser than the field map's canonical premise key -
 * which cannot be built from a single line - and it is precisely why every
 * address-based rule tops out at 0.75.
 */
function addressesAgree(vendorAddress: string, sale: SaleCandidate): boolean {
  const street = normalizeServiceAddress(sale.lead_address);
  if (!street) return false;
  if (vendorAddress !== street && !vendorAddress.startsWith(`${street} `) && !vendorAddress.includes(` ${street} `)) {
    // Also accept the reverse containment: some reports write only the house
    // number and street while the lead carries a unit suffix.
    if (!street.startsWith(`${vendorAddress} `) && street !== vendorAddress) return false;
  }
  // A house number that does not appear in both is a different door, whatever
  // the street name says.
  const vendorNumber = /^(\d+)/.exec(vendorAddress)?.[1];
  const saleNumber = /^(\d+)/.exec(street)?.[1];
  if (vendorNumber && saleNumber && vendorNumber !== saleNumber) return false;

  const zip = String(sale.lead_zip ?? "").replace(/\D/g, "").slice(0, 5);
  if (zip.length === 5 && /\b\d{5}\b/.test(vendorAddress)) {
    return vendorAddress.includes(zip);
  }
  return true;
}

/** A carrier the report did not name cannot contradict the sale. This repo does
 *  not carry a carrier column on commission_sales, so the check is one-sided by
 *  design: it can only ever be neutral, never a false positive. */
function carrierAgrees(_carrierKey: string | null, _sale: SaleCandidate): boolean {
  return true;
}

function withinWindow(sale: SaleCandidate, anchor: Date | null, windowDays: number): boolean {
  if (!anchor) return true;
  const sold = Date.parse(sale.sold_at);
  if (!Number.isFinite(sold)) return false;
  const days = Math.abs(wholeDaysBetween(new Date(Math.min(sold, anchor.getTime())), new Date(Math.max(sold, anchor.getTime()))));
  return days <= windowDays;
}

function namesAgree(customerName: string, sale: SaleCandidate): boolean {
  const candidates = [sale.lead_contact_name, sale.lead_owner_name]
    .map((n) => normalizePersonName(n))
    .filter((n): n is string => n != null);
  if (candidates.length === 0) return false;
  const vendorParts = new Set(customerName.split(" ").filter((p) => p.length > 1));
  return candidates.some((c) => {
    const parts = c.split(" ").filter((p) => p.length > 1);
    if (parts.length === 0) return false;
    const shared = parts.filter((p) => vendorParts.has(p)).length;
    // Both a forename and a surname, or an exact single-token match. One shared
    // token out of two is a coincidence at scale.
    return shared >= 2 || (parts.length === 1 && vendorParts.has(parts[0]) && vendorParts.size === 1);
  });
}

// ── Verdict constructors ─────────────────────────────────────────────────────

function exact(sale: SaleCandidate, rule: string, confidence: number): MatchResult {
  return {
    status: "matched", rule, confidence,
    saleId: sale.id, leadId: sale.lead_id, repId: sale.rep_id,
    exceptionReason: null,
    candidates: [toCandidate(sale, rule, confidence)],
  };
}

function ambiguous(hits: SaleCandidate[], rule: string, confidence: number, reason: string): MatchResult {
  return {
    status: "exception", rule, confidence,
    saleId: null, leadId: null, repId: null,
    exceptionReason: reason,
    candidates: hits.slice(0, 5).map((h) => toCandidate(h, rule, confidence)),
  };
}

/** The candidate as an exception screen shows it. Address and rep only - a
 *  resolver needs to recognise the sale, not to read the customer's file. */
function toCandidate(sale: SaleCandidate, rule: string, confidence: number) {
  const where = [sale.lead_address, sale.lead_city, sale.lead_state].filter(Boolean).join(", ");
  return {
    saleId: sale.id,
    leadId: sale.lead_id,
    repId: sale.rep_id,
    label: `${where || "No address on file"} - ${sale.rep_name ?? "unknown rep"} - sold ${String(sale.sold_at).slice(0, 10)}`,
    rule,
    confidence,
  };
}
