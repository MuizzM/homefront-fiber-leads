// ── The mapping layer, pinned ────────────────────────────────────────────────
//
// The brief's hardest constraint is that the POE report's columns are NOT
// assumed. These tests hold the three properties that make that real:
//
//   1. A SUGGESTION IS NOT A DECISION. Suggesting is allowed to be wrong;
//      saving a mapping that cannot identify an order is not.
//   2. VALIDATION FAILS FOR A NAMED REASON. Every refusal carries a code a UI
//      can explain and a test can assert, rather than a bare false.
//   3. APPLYING A MAPPING IS TOTAL. Any column may be absent, and the result is
//      still a well-formed row - never a crash, never a half-filled object.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  applyOrderMapping, orderIdentityKeys, suggestOrderMapping,
  validateOrderColumnMapping, withRowHash,
} from "@shared/orderColumnMapping";
import { emptyOrderColumnMapping, type OrderColumnMapping } from "@shared/orderStatusSource";

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");

/** The shape a Salesforce report export actually has: mixed casing, a couple of
 *  near-identical date columns, and one column the importer has no use for. */
const COLUMNS = [
  "Order Number", "Transaction ID", "Account Number", "Customer Name",
  "Customer Email", "Customer Phone", "Service Address", "Carrier",
  "Product", "Program", "Sales Rep Name", "Rep ID", "Manager",
  "Submitted Date", "Scheduled Install Date", "Install Date",
  "Order Status", "Status Reason", "Last Modified", "Record Count",
];

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "Order Number": "PV-1001",
    "Transaction ID": "TXN-5001",
    "Account Number": "88001234",
    "Customer Name": "Jane Doe",
    "Customer Email": "jane@example.com",
    "Customer Phone": "(704) 555-0142",
    "Service Address": "123 N Main St, Concord NC 28025",
    "Carrier": "Kinetic",
    "Product": "Fiber 1 Gig",
    "Program": "Door to Door",
    "Sales Rep Name": "Sam Rivera",
    "Rep ID": "R-77",
    "Manager": "Charlotte North",
    "Submitted Date": "8/1/2026",
    "Scheduled Install Date": "8/14/2026 7:00 PM",
    "Install Date": "",
    "Order Status": "Install Scheduled",
    "Status Reason": "",
    "Last Modified": "8/2/2026",
    "Record Count": "1",
    ...over,
  };
}

function mappingFor(columns: readonly string[]): OrderColumnMapping {
  return { ...emptyOrderColumnMapping("America/New_York"), columns: suggestOrderMapping(columns) };
}

describe("suggestOrderMapping", () => {
  it("binds the obvious columns", () => {
    const s = suggestOrderMapping(COLUMNS);
    expect(s.externalOrderId).toBe("Order Number");
    expect(s.externalTransactionId).toBe("Transaction ID");
    expect(s.customerAccountNumber).toBe("Account Number");
    expect(s.sourceStatus).toBe("Order Status");
    expect(s.serviceAddress).toBe("Service Address");
    expect(s.repExternalName).toBe("Sales Rep Name");
  });

  it("does not confuse the scheduled install date with the install date", () => {
    const s = suggestOrderMapping(COLUMNS);
    expect(s.installScheduledAt).toBe("Scheduled Install Date");
    expect(s.installDate).toBe("Install Date");
  });

  it("never binds one header to two fields", () => {
    const used = Object.values(suggestOrderMapping(COLUMNS));
    expect(new Set(used).size).toBe(used.length);
  });

  it("suggests nothing it cannot recognise rather than guessing", () => {
    const s = suggestOrderMapping(["Alpha", "Beta", "Gamma"]);
    expect(Object.keys(s)).toHaveLength(0);
  });
});

describe("validateOrderColumnMapping", () => {
  it("accepts a complete mapping against a real sample", () => {
    const result = validateOrderColumnMapping(mappingFor(COLUMNS), [row()], 1, sha256);
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("refuses a mapping with no stable identity", () => {
    const mapping = mappingFor(COLUMNS);
    delete mapping.columns.externalOrderId;
    delete mapping.columns.externalTransactionId;
    delete mapping.columns.customerAccountNumber;
    const result = validateOrderColumnMapping(mapping, [row()], 1, sha256);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("NO_STABLE_IDENTITY");
  });

  it("refuses a mapping with no status column", () => {
    const mapping = mappingFor(COLUMNS);
    delete mapping.columns.sourceStatus;
    const result = validateOrderColumnMapping(mapping, [row()], 1, sha256);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("NO_STATUS");
  });

  it("refuses a date field bound to a column that is not dates", () => {
    const mapping = mappingFor(COLUMNS);
    mapping.columns.installDate = "Customer Name";
    const result = validateOrderColumnMapping(mapping, [row(), row(), row()], 1, sha256);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === "UNPARSEABLE_DATES");
    expect(issue?.field).toBe("installDate");
  });

  it("refuses a binding to a column the file does not contain", () => {
    const mapping = mappingFor(COLUMNS);
    mapping.columns.program = "Program That Was Deleted";
    const result = validateOrderColumnMapping(mapping, [row()], 1, sha256);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("COLUMN_NOT_IN_REPORT");
  });

  it("warns rather than refuses when only an account number identifies the order", () => {
    const mapping = mappingFor(COLUMNS);
    delete mapping.columns.externalOrderId;
    delete mapping.columns.externalTransactionId;
    const result = validateOrderColumnMapping(mapping, [row()], 1, sha256);
    expect(result.ok).toBe(true);
    expect(result.issues.map((i) => i.code)).toContain("ACCOUNT_ONLY_IDENTITY");
  });

  it("warns about a status nobody has mapped, and still imports it", () => {
    const mapping = mappingFor(COLUMNS);
    const result = validateOrderColumnMapping(mapping, [row({ "Order Status": "ZZ-ALPHA" })], 1, sha256);
    expect(result.ok).toBe(true);
    expect(result.issues.map((i) => i.code)).toContain("UNMAPPED_STATUS");
    expect(result.statusPreview[0]).toMatchObject({ sourceStatus: "ZZ-ALPHA", normalized: "unknown" });
  });

  it("lets an organization override a status the normalizer cannot read", () => {
    const mapping = mappingFor(COLUMNS);
    mapping.statusOverrides = { "zz-alpha": "on_hold" };
    const result = validateOrderColumnMapping(mapping, [row({ "Order Status": "ZZ-ALPHA" })], 1, sha256);
    expect(result.statusPreview[0].normalized).toBe("on_hold");
    expect(result.issues.map((i) => i.code)).not.toContain("UNMAPPED_STATUS");
  });

  it("refuses an override that points at a state that does not exist", () => {
    const mapping = mappingFor(COLUMNS);
    mapping.statusOverrides = { "weird": "definitely_not_a_status" as any };
    const result = validateOrderColumnMapping(mapping, [row()], 1, sha256);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("BAD_STATUS_OVERRIDE");
  });

  it("reports contact-column quality as a RATE and never quotes a value", () => {
    const mapping = mappingFor(COLUMNS);
    // "n/a" reads as an EMPTY cell, not a bad one, so it is excluded from the
    // rate entirely - a sparse column and a wrongly-mapped column are different
    // problems and only the second one is worth a warning.
    const rows = [
      row({ "Customer Phone": "n/a" }),
      row({ "Customer Phone": "not a phone" }),
      row({ "Customer Phone": "Concord NC" }),
      row(),
    ];
    const result = validateOrderColumnMapping(mapping, rows, 1, sha256);
    const issue = result.issues.find((i) => i.code === "PHONE_FORMAT");
    expect(issue).toBeDefined();
    expect(issue!.message).not.toContain("555");
  });
});

describe("applyOrderMapping", () => {
  const mapping = mappingFor(COLUMNS);
  const apply = (over: Record<string, unknown> = {}) =>
    applyOrderMapping({
      organizationId: 7, mapping, row: row(over), sourceRowNumber: 3,
      sourceReportId: "rep123", timeZone: "America/New_York",
    });

  it("produces a well-formed row", () => {
    const out = apply();
    expect(out.organizationId).toBe(7);
    expect(out.externalOrderId).toBe("PV-1001");
    expect(out.normalizedStatus).toBe("install_scheduled");
    expect(out.carrier).toBe("Kinetic");
    expect(out.normalizedServiceAddress).toBe("123 N MAIN ST CONCORD NC 28025");
    expect(out.installScheduledAt?.toISOString()).toBe("2026-08-14T23:00:00.000Z");
    expect(out.installDate).toBeNull();
  });

  it("normalizes contact details at the boundary and drops what it cannot use", () => {
    expect(apply().customerPhone).toBe("+17045550142");
    expect(apply({ "Customer Phone": "123" }).customerPhone).toBeNull();
    expect(apply().customerEmail).toBe("jane@example.com");
    expect(apply({ "Customer Email": "Jane Doe" }).customerEmail).toBeNull();
  });

  it("falls back between the sale date and the submitted date", () => {
    const withSaleOnly = applyOrderMapping({
      organizationId: 7,
      mapping: { ...mapping, columns: { ...mapping.columns, submittedDate: undefined, saleDate: "Submitted Date" } },
      row: row(), sourceRowNumber: 1, sourceReportId: null, timeZone: "UTC",
    });
    expect(withSaleOnly.submittedDate?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("applies a constant when the report has no such column", () => {
    const withDefaults = applyOrderMapping({
      organizationId: 7,
      mapping: { ...mapping, columns: { ...mapping.columns, carrier: undefined }, defaults: { carrier: "Kinetic" } },
      row: row(), sourceRowNumber: 1, sourceReportId: null, timeZone: "UTC",
    });
    expect(withDefaults.carrier).toBe("Kinetic");
  });

  it("keeps the whole source record for the audit trail", () => {
    expect(apply().sourceRowPayload["Record Count"]).toBe("1");
  });

  it("survives a row where every mapped column is missing", () => {
    const out = applyOrderMapping({
      organizationId: 7, mapping, row: {}, sourceRowNumber: 1, sourceReportId: null, timeZone: "UTC",
    });
    expect(out.normalizedStatus).toBe("unknown");
    expect(out.externalOrderId).toBeNull();
    expect(out.sourceRowId).toBe("1");
  });
});

describe("row hashing and identity keys", () => {
  const mapping = mappingFor(COLUMNS);
  const build = (over: Record<string, unknown> = {}) =>
    withRowHash(applyOrderMapping({
      organizationId: 1, mapping, row: row(over), sourceRowNumber: 1,
      sourceReportId: null, timeZone: "UTC",
    }), sha256);

  it("is stable for an unchanged row and different for a changed one", () => {
    expect(build().rawRowHash).toBe(build().rawRowHash);
    expect(build().rawRowHash).not.toBe(build({ "Order Status": "Installed" }).rawRowHash);
  });

  it("normalizes identity keys so a reformatted id is the same order", () => {
    const a = orderIdentityKeys(build());
    const b = orderIdentityKeys(build({ "Order Number": "pv 1001", "Transaction ID": "txn_5001" }));
    expect(a.orderKey).toBe(b.orderKey);
    expect(a.transactionKey).toBe(b.transactionKey);
  });
});
