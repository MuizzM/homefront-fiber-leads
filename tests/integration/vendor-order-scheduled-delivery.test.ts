// ── Scheduled report delivery, end to end ────────────────────────────────────
//
// The automated path is a PUSH: a report subscription bridge posts the export
// to /api/order-imports/scheduled-delivery, and from there the file follows
// exactly the pipeline a manual upload does. What these tests hold:
//
//   THE WALL     without the shared secret the endpoint does not exist (404),
//                a short secret counts as no secret, and the sync flag plus an
//                enabled scheduled_export connection are each independently
//                required.
//   THE TENANT   the org an import lands in comes from connection state an
//                admin configured, never from the request; with two accepting
//                orgs the deliverer must name one, and can only name one that
//                opted in.
//   THE PIPELINE a delivered file becomes orders matched to sales under the
//                saved mapping, a re-delivered identical file is idempotent
//                success with no second import, and a changed file updates the
//                order rather than duplicating it.

import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let rawDb: import("better-sqlite3").Database;
let worker: typeof import("../../server/vendorOrderImportWorker");
let store: typeof import("../../server/vendorOrderStore");

const realFetch = globalThis.fetch.bind(globalThis);
const ORG = 1;
const OTHER_ORG = 2;
const SECRET = "delivery-secret-0123456789abcdef";

let repMemberId = 0;
let saleId = 0;

const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
};

const HEADERS = [
  "Order Number", "Transaction ID", "Account Number", "Customer Name", "Customer Email",
  "Customer Phone", "Service Address", "Carrier", "Product", "Program",
  "Sales Rep Name", "Rep ID", "Submitted Date", "Scheduled Install Date",
  "Install Date", "Order Status", "Status Reason", "Last Modified",
];

interface RowSpec {
  order?: string; txn?: string; account?: string; name?: string; email?: string; phone?: string;
  address?: string; rep?: string; submitted?: string; scheduled?: string; installed?: string;
  status?: string; reason?: string; modified?: string;
}

function csv(rows: RowSpec[]): string {
  const cell = (v: string | undefined) => {
    const text = v ?? "";
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [HEADERS.join(",")];
  for (const r of rows) {
    lines.push([
      r.order ?? "", r.txn ?? "", r.account ?? "", r.name ?? "Jane Doe",
      r.email ?? "jane@example.com", r.phone ?? "(704) 555-0142",
      r.address ?? "123 N Main St, Concord NC 28025", "Kinetic", "Fiber 1 Gig", "Door to Door",
      r.rep ?? "Sam Rivera", "R-77",
      r.submitted ?? daysAgo(20), r.scheduled ?? "", r.installed ?? "",
      r.status ?? "Submitted", r.reason ?? "", r.modified ?? daysAgo(20),
    ].map(cell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** A delivery, as the bridge sends it: raw bytes, the secret, a filename. */
function deliver(content: string, opts: { secret?: string | null; org?: number; fileName?: string; contentType?: string } = {}) {
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "text/csv",
    "x-report-filename": opts.fileName ?? "total-submitted-orders.csv",
  };
  if (opts.secret !== null) headers["x-webhook-secret"] = opts.secret ?? SECRET;
  if (opts.org != null) headers["x-organization-id"] = String(opts.org);
  return realFetch(`${baseUrl}/api/order-imports/scheduled-delivery`, {
    method: "POST", headers, body: content,
  });
}

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    if ((await worker.pump()) === 0) return;
  }
}

const importCount = () =>
  Number((rawDb.prepare(`SELECT COUNT(*) AS n FROM vendor_order_imports WHERE tenant_id = ?`).get(ORG) as any).n);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-scheduled-delivery-"));
  process.env.NODE_ENV = "test";
  process.env.VENDOR_ORDER_ENCRYPTION_KEY = "a".repeat(64);
  // Both dark at boot, exactly as production ships. Tests flip them
  // deliberately, and the flags are read at call time so that works.
  process.env.PERFECTVISION_ORDER_SYNC_ENABLED = "false";
  delete process.env.ORDER_REPORT_DELIVERY_SECRET;

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  ({ rawDb } = await import("../../server/db"));
  worker = await import("../../server/vendorOrderImportWorker");
  store = await import("../../server/vendorOrderStore");
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (?, 'org-b-delivery', 'Org B', 'Owner B', 'owner-b-delivery@example.com', 'Org B')`,
  ).run(OTHER_ORG);

  repMemberId = Number(rawDb.prepare(
    `INSERT INTO team_members (name, tenant_id, role, active, created_at) VALUES ('Sam Rivera', ?, 'rep', 1, datetime('now'))`,
  ).run(ORG).lastInsertRowid);

  const leadId = Number(rawDb.prepare(
    `INSERT INTO leads (address, city, state, zip, tenant_id, contact_name, lead_status, created_at, updated_at)
     VALUES ('123 N Main St', 'Concord', 'NC', '28025', ?, 'Jane Doe', 'sold', datetime('now'), datetime('now'))`,
  ).run(ORG).lastInsertRowid);

  saleId = Number(rawDb.prepare(
    `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, lead_id, external_order_id, created_at, updated_at)
     VALUES (?,?,'sale-delivery','QUALIFIED',?,?,'PV-9001',datetime('now'),datetime('now'))`,
  ).run(ORG, repMemberId, new Date(Date.now() - 20 * 86_400_000).toISOString(), leadId).lastInsertRowid);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  worker.stopVendorOrderImportWorker();
  delete process.env.ORDER_REPORT_DELIVERY_SECRET;
  process.env.PERFECTVISION_ORDER_SYNC_ENABLED = "false";
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

// ── The wall ─────────────────────────────────────────────────────────────────

describe("the wall", () => {
  it("does not exist while no secret is configured", async () => {
    const res = await deliver(csv([{ order: "PV-9001" }]));
    expect(res.status).toBe(404);
  });

  it("treats a short secret as no secret", async () => {
    process.env.ORDER_REPORT_DELIVERY_SECRET = "tooshort";
    const res = await deliver(csv([{ order: "PV-9001" }]), { secret: "tooshort" });
    expect(res.status).toBe(404);
  });

  it("refuses a wrong or missing secret without revealing anything", async () => {
    process.env.ORDER_REPORT_DELIVERY_SECRET = SECRET;
    expect((await deliver(csv([{}]), { secret: "wrong-secret-0123456789abcdef" })).status).toBe(404);
    expect((await deliver(csv([{}]), { secret: null })).status).toBe(404);
  });

  it("refuses while the sync flag is off, by name", async () => {
    const res = await deliver(csv([{ order: "PV-9001" }]));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/disabled/i);
  });

  it("refuses while no org has an enabled scheduled delivery", async () => {
    process.env.PERFECTVISION_ORDER_SYNC_ENABLED = "true";
    expect((await deliver(csv([{ order: "PV-9001" }]))).status).toBe(403);

    // A manual-upload connection, even enabled, is not an opt-in to deliveries.
    store.upsertConnection({ tenantId: ORG, label: "POE", sourceUrl: null, mode: "manual_upload", enabled: true });
    expect((await deliver(csv([{ order: "PV-9001" }]))).status).toBe(403);
  });

  it("refuses until a mapping exists, and says what to do", async () => {
    store.upsertConnection({ tenantId: ORG, label: "POE", sourceUrl: null, mode: "scheduled_export", enabled: true });
    const res = await deliver(csv([{ order: "PV-9001" }]));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/mapping/i);
  });
});

// ── The pipeline ─────────────────────────────────────────────────────────────

describe("the pipeline", () => {
  it("a delivered file becomes orders matched to sales", async () => {
    const { validateOrderColumnMapping } = await import("../../shared/orderColumnMapping");
    const { emptyOrderColumnMapping } = await import("../../shared/orderStatusSource");
    const { sha256Hex } = await import("../../server/vendorOrderCrypto");

    const mapping = {
      ...emptyOrderColumnMapping("America/New_York"),
      columns: {
        externalOrderId: "Order Number",
        externalTransactionId: "Transaction ID",
        customerAccountNumber: "Account Number",
        customerName: "Customer Name",
        customerEmail: "Customer Email",
        customerPhone: "Customer Phone",
        serviceAddress: "Service Address",
        carrier: "Carrier",
        productSold: "Product",
        program: "Program",
        repExternalName: "Sales Rep Name",
        repExternalId: "Rep ID",
        submittedDate: "Submitted Date",
        installScheduledAt: "Scheduled Install Date",
        installDate: "Install Date",
        sourceStatus: "Order Status",
        failureReason: "Status Reason",
        sourceLastUpdatedAt: "Last Modified",
      },
    } as any;
    // The same bar the mapping screen holds a human to: saved only if valid,
    // against a sample that carries every header the real export does.
    const sample: Record<string, string> = Object.fromEntries(HEADERS.map((h) => [h, ""]));
    Object.assign(sample, {
      "Order Number": "PV-9001", "Order Status": "Submitted",
      "Service Address": "123 N Main St, Concord NC 28025", "Submitted Date": daysAgo(20),
    });
    const verdict = validateOrderColumnMapping(mapping, [sample], ORG, sha256Hex);
    expect(verdict.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(verdict.ok).toBe(true);
    store.saveMapping(ORG, mapping, null);

    const res = await deliver(csv([{ order: "PV-9001", txn: "T-1", account: "A-1" }]));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.importId).toBeGreaterThan(0);
    expect(body.status).toBe("pending");

    await drain();

    const imp = rawDb.prepare(`SELECT * FROM vendor_order_imports WHERE id = ?`).get(body.importId) as any;
    expect(imp.import_mode).toBe("scheduled_export");
    expect(imp.status).toMatch(/^completed/);
    expect(imp.imported_by_user_id).toBeNull();

    const order = rawDb.prepare(
      `SELECT * FROM vendor_orders WHERE tenant_id = ? AND external_order_id = 'PV-9001'`,
    ).get(ORG) as any;
    expect(order).toBeTruthy();
    expect(order.match_status).toBe("matched");
    expect(Number(order.sale_id)).toBe(saleId);
    expect(Number(order.rep_id)).toBe(repMemberId);

    const audit = rawDb.prepare(
      `SELECT * FROM admin_audit WHERE action = 'order_import.scheduled_delivery.received' AND tenant_id = ?`,
    ).get(ORG) as any;
    expect(audit).toBeTruthy();
  });

  it("re-delivering the identical file is idempotent success, not a second import", async () => {
    const before = importCount();
    const res = await deliver(csv([{ order: "PV-9001", txn: "T-1", account: "A-1" }]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicate).toBe(true);
    expect(importCount()).toBe(before);
  });

  it("a changed file updates the order instead of duplicating it", async () => {
    const res = await deliver(csv([{ order: "PV-9001", txn: "T-1", account: "A-1", status: "Installed", installed: daysAgo(1) }]));
    expect(res.status).toBe(202);
    await drain();
    const orders = rawDb.prepare(
      `SELECT * FROM vendor_orders WHERE tenant_id = ? AND external_order_id = 'PV-9001'`,
    ).all(ORG) as any[];
    expect(orders.length).toBe(1);
    expect(orders[0].normalized_status).toBe("installed");
  });

  it("a body the global JSON parser ate gets the contract, not a crash", async () => {
    const res = await deliver(JSON.stringify({ rows: [] }), { contentType: "application/json" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/raw request body/i);
  });
});

// ── The tenant ───────────────────────────────────────────────────────────────

describe("the tenant", () => {
  it("with two accepting orgs the deliverer must name one that opted in", async () => {
    store.upsertConnection({ tenantId: OTHER_ORG, label: "POE", sourceUrl: null, mode: "scheduled_export", enabled: true });
    try {
      const anonymous = await deliver(csv([{ order: "PV-9002" }]));
      expect(anonymous.status).toBe(400);
      expect((await anonymous.json()).error).toMatch(/x-organization-id/);

      // Naming an org that never opted in is refused, not honoured.
      expect((await deliver(csv([{ order: "PV-9002" }]), { org: 999 })).status).toBe(400);

      // Naming an opted-in org works; ORG still has its mapping from above.
      const named = await deliver(csv([{ order: "PV-9001", txn: "T-1", account: "A-1", status: "Installed", installed: daysAgo(1) }]), { org: ORG });
      expect(named.status).toBe(200); // identical bytes to the last delivery: duplicate skip
    } finally {
      store.upsertConnection({ tenantId: OTHER_ORG, label: "POE", sourceUrl: null, mode: "manual_upload", enabled: false });
    }
  });
});
