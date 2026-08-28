// ── The import pipeline, end to end ──────────────────────────────────────────
//
// Everything this integration promises rests on one chain: an authorized admin
// uploads a report, a background worker parses it, each row is matched to a
// sale, orders and their transitions are recorded, and the ones that stalled
// become work for the rep who sold them.
//
// The tests are grouped by the property they hold, and each group is a
// different way the chain could break silently:
//
//   AUTHORIZATION   an unauthenticated or under-privileged caller gets nothing,
//                   and a second organization can never see the first's orders.
//   MAPPING         a mapping that cannot identify an order is refused, and the
//                   preview never ships customer contact details to a browser.
//   IMPORT          rows become orders, a second import updates rather than
//                   duplicates, and re-importing the same file changes nothing.
//   MATCHING        an exact id match attributes the order; an address-only
//                   match does not, and goes to a human instead.
//   RECOVERY        a stalled order becomes a case for the right rep, an
//                   installed one closes it, and an unmatched one never opens
//                   one at all.
//   THE WORKER      it runs outside the request, so /api/health answers while a
//                   large import is in flight.

import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let worker: typeof import("../../server/vendorOrderImportWorker");
let store: typeof import("../../server/vendorOrderStore");

let adminSession = "", managerSession = "", repASession = "", repBSession = "", foreignAdminSession = "";
let repAMemberId = 0, repBMemberId = 0;
let saleAId = 0, saleBId = 0, addressOnlySaleId = 0;

const realFetch = globalThis.fetch.bind(globalThis);
const ORG = 1;
const OTHER_ORG = 2;

/** Today, so "days stalled" arithmetic in the fixtures does not rot with the
 *  calendar. tests/unit covers the arithmetic itself against a pinned clock. */
const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
};

const HEADERS = [
  "Order Number", "Transaction ID", "Account Number", "Customer Name", "Customer Email",
  "Customer Phone", "Service Address", "Carrier", "Product", "Program",
  "Sales Rep Name", "Rep ID", "Manager", "Submitted Date", "Scheduled Install Date",
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
      r.rep ?? "Sam Rivera", "R-77", "Charlotte North",
      r.submitted ?? daysAgo(30), r.scheduled ?? "", r.installed ?? "",
      r.status ?? "Submitted", r.reason ?? "", r.modified ?? daysAgo(30),
    ].map(cell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function request(path: string, sessionId: string | null, init: RequestInit = {}) {
  return realFetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "x-session-id": sessionId } : {}),
      ...init.headers,
    },
  });
}

/**
 * A multipart upload, assembled by hand.
 *
 * NOT `new FormData()` with a Blob: these tests run in the jsdom environment,
 * so the global FormData and Blob are jsdom's, and handing one of those to
 * Node's fetch produces a body whose length disagrees with the Content-Length
 * undici computed. Building the bytes here keeps the request identical to what
 * a browser sends and removes the runtime mismatch entirely.
 */
async function upload(path: string, sessionId: string, content: string, fileName = "orders.csv", extra: Record<string, string> = {}) {
  const boundary = `----hfboundary${counter += 1}`;
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(extra)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`, "utf8"));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`,
    "utf8",
  ));
  parts.push(Buffer.from(content, "utf8"));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  const body = Buffer.concat(parts);

  return realFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "x-session-id": sessionId,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    body,
  });
}
let counter = 0;

/** Drain the worker queue. The production worker is a timer; a test drives it
 *  directly so nothing races a poll interval. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    if ((await worker.pump()) === 0) return;
  }
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-vendor-orders-"));
  process.env.NODE_ENV = "test";
  // Encryption on: the pipeline refuses to store the raw payload without it,
  // and the messaging tests depend on being able to read a destination back.
  process.env.VENDOR_ORDER_ENCRYPTION_KEY = "a".repeat(64);
  process.env.PERFECTVISION_ORDER_SYNC_ENABLED = "false";
  process.env.PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED = "false";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  worker = await import("../../server/vendorOrderImportWorker");
  store = await import("../../server/vendorOrderStore");
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (?, 'org-b-orders', 'Org B', 'Owner B', 'owner-b-orders@example.com', 'Org B')`,
  ).run(OTHER_ORG);

  const member = (name: string, orgId: number) => {
    const info = rawDb.prepare(
      `INSERT INTO team_members (name, tenant_id, role, active, created_at) VALUES (?,?,'rep',1,datetime('now'))`,
    ).run(name, orgId);
    return Number(info.lastInsertRowid);
  };
  repAMemberId = member("Sam Rivera", ORG);
  repBMemberId = member("Alex Chen", ORG);

  const user = (name: string, email: string, role: string, orgId: number, teamMemberId: number | null) => {
    const created = storage.createUser({ name, email, role, active: true, tenantId: orgId } as any);
    rawDb.prepare(`UPDATE users SET training_required = 0, team_member_id = ? WHERE id = ?`)
      .run(teamMemberId, created.id);
    return storage.createSession(created.id).id;
  };
  adminSession = user("Order Admin", "order-admin@example.com", "admin", ORG, null);
  managerSession = user("Order Manager", "order-manager@example.com", "manager", ORG, null);
  repASession = user("Sam Rivera", "rep-a-orders@example.com", "rep", ORG, repAMemberId);
  repBSession = user("Alex Chen", "rep-b-orders@example.com", "rep", ORG, repBMemberId);
  foreignAdminSession = user("Other Admin", "other-admin-orders@example.com", "admin", OTHER_ORG, null);

  // Two leads and three sales. Sale A carries the carrier's order id, so it
  // matches at tier one. The address-only sale carries none, which is what puts
  // its order in front of a human instead of a rep.
  const lead = (address: string) => {
    const info = rawDb.prepare(
      `INSERT INTO leads (address, city, state, zip, tenant_id, contact_name, lead_status, created_at, updated_at)
       VALUES (?, 'Concord', 'NC', '28025', ?, 'Jane Doe', 'sold', datetime('now'), datetime('now'))`,
    ).run(address, ORG);
    return Number(info.lastInsertRowid);
  };
  const leadA = lead("123 N Main St");
  const leadB = lead("77 Oak Avenue");

  const sale = (externalId: string, repId: number, leadId: number, orderId: string | null) => {
    const info = rawDb.prepare(
      `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, lead_id, external_order_id, created_at, updated_at)
       VALUES (?,?,?,'QUALIFIED',?,?,?,datetime('now'),datetime('now'))`,
    ).run(ORG, repId, externalId, new Date(Date.now() - 30 * 86_400_000).toISOString(), leadId, orderId);
    return Number(info.lastInsertRowid);
  };
  saleAId = sale("sale-a", repAMemberId, leadA, "PV-1001");
  saleBId = sale("sale-b", repBMemberId, leadA, "PV-2002");
  addressOnlySaleId = sale("sale-c", repAMemberId, leadB, null);

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
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

// ── Authorization ────────────────────────────────────────────────────────────

describe("authorization", () => {
  const ADMIN_ONLY = [
    "/api/order-imports/providers",
    "/api/order-imports/connection",
    "/api/order-imports/mapping",
    "/api/order-imports",
  ];

  it("refuses every import endpoint without a session", async () => {
    for (const path of ADMIN_ONLY) {
      expect((await request(path, null)).status, path).toBe(401);
    }
  });

  it("refuses a rep the import surface entirely", async () => {
    for (const path of ADMIN_ONLY) {
      expect((await request(path, repASession)).status, path).toBe(403);
    }
  });

  it("refuses a manager the import surface, which is org policy", async () => {
    expect((await request("/api/order-imports/mapping", managerSession)).status).toBe(403);
  });

  it("lets a rep reach their own recovery queue", async () => {
    expect((await request("/api/order-recovery/cases", repASession)).status).toBe(200);
  });

  it("refuses a rep the policy, template and suppression screens", async () => {
    for (const path of [
      "/api/order-recovery/policy",
      "/api/order-recovery/templates",
      "/api/order-recovery/suppressions",
      "/api/order-imports/exceptions/list",
    ]) {
      expect((await request(path, repASession)).status, path).toBe(403);
    }
  });

  it("never exposes a vendor credential on the connection read", async () => {
    await request("/api/order-imports/connection", adminSession, {
      method: "PUT",
      body: JSON.stringify({ label: "POE", sourceUrl: "https://example.invalid/report", mode: "manual_upload", enabled: true }),
    });
    const res = await request("/api/order-imports/connection", adminSession);
    const body = await res.json();
    expect(body.connection).toBeTruthy();
    expect(body.connection.encryptedCredentials).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("encryptedCredentials");
  });

  it("keeps automated retrieval refused while the sync flag is off", async () => {
    await request("/api/order-imports/connection", adminSession, {
      method: "PUT",
      body: JSON.stringify({ label: "POE", sourceUrl: "https://example.invalid/report", mode: "api", enabled: true }),
    });
    const res = await request("/api/order-imports/connection/test", adminSession, { method: "POST" });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.capabilities.canFetchReport).toBe(false);
    expect(body.message).toMatch(/authoriz/i);

    const { getOrderStatusProvider } = await import("../../server/providers/perfectVisionSubmittedOrders");
    await expect(getOrderStatusProvider("perfectvision_submitted_orders").fetchOrderReport({
      connection: { id: 1, organizationId: ORG, provider: "perfectvision_submitted_orders", label: "POE",
        sourceUrl: null, mode: "api", encryptedCredentials: null, enabled: true },
      periodStart: null, periodEnd: null, requestedByUserId: null,
    })).rejects.toThrow(/disabled/i);

    // Put it back, so the rest of the suite runs against the supported mode.
    await request("/api/order-imports/connection", adminSession, {
      method: "PUT",
      body: JSON.stringify({ label: "POE", sourceUrl: "https://example.invalid/report", mode: "manual_upload", enabled: true }),
    });
  });
});

// ── Mapping ──────────────────────────────────────────────────────────────────

describe("mapping", () => {
  it("previews a file without importing anything and without leaking contact details", async () => {
    const res = await upload("/api/order-imports/preview", adminSession, csv([{ order: "PV-1001" }]));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.columns).toContain("Order Number");
    expect(body.suggested.externalOrderId).toBe("Order Number");
    expect(body.rowCount).toBe(1);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("7045550142");
    expect(serialized).not.toContain("555-0142");
    expect(serialized).not.toContain("jane@example.com");
    expect(body.validation.sample[0].hasPhone).toBe(true);
    expect(body.validation.sample[0].hasEmail).toBe(true);

    expect(store.listImports(ORG)).toHaveLength(0);
  });

  it("refuses to save a mapping with no way to identify an order", async () => {
    const res = await request("/api/order-imports/mapping", adminSession, {
      method: "PUT",
      body: JSON.stringify({
        mapping: { columns: { sourceStatus: "Order Status" }, statusOverrides: {}, timeZone: "America/New_York", defaults: {} },
        sampleRows: [],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues.map((i: any) => i.code)).toContain("NO_STABLE_IDENTITY");
  });

  it("saves a complete mapping and versions it", async () => {
    const preview = await (await upload("/api/order-imports/preview", adminSession, csv([{ order: "PV-1001" }]))).json();
    const res = await request("/api/order-imports/mapping", adminSession, {
      method: "PUT",
      body: JSON.stringify({ mapping: preview.mapping, sampleRows: preview.sampleRows }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBeGreaterThanOrEqual(1);

    const saved = await (await request("/api/order-imports/mapping", adminSession)).json();
    expect(saved.mapping.columns.externalOrderId).toBe("Order Number");
    expect(saved.version).toBeGreaterThanOrEqual(1);
  });
});

// ── Import ───────────────────────────────────────────────────────────────────

describe("import", () => {
  it("accepts an upload, returns immediately, and completes in the worker", async () => {
    const content = csv([
      { order: "PV-1001", status: "Submitted", submitted: daysAgo(30), modified: daysAgo(30) },
      { order: "PV-2002", status: "Install Scheduled", scheduled: daysAgo(10), modified: daysAgo(12), address: "123 N Main St, Concord NC 28025" },
    ]);
    const res = await upload("/api/order-imports", adminSession, content, "batch-1.csv");
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.totalRows).toBe(2);

    // Nothing has been imported yet: the request returned before the work.
    expect(store.listOrders(ORG)).toHaveLength(0);

    await drain();
    const imported = store.getImport(body.importId, ORG);
    expect(imported.status).toBe("completed");
    expect(imported.inserted_rows).toBe(2);
    expect(imported.matched_rows).toBe(2);
    expect(store.listOrders(ORG)).toHaveLength(2);
  });

  it("refuses the same file twice", async () => {
    const content = csv([{ order: "PV-1001" }]);
    const first = await upload("/api/order-imports", adminSession, content, "dupe.csv");
    expect(first.status).toBe(202);
    await drain();

    const second = await upload("/api/order-imports", adminSession, content, "dupe.csv");
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/already imported/i);
  });

  it("updates an existing order rather than duplicating it, and records the transition", async () => {
    const before = store.listOrders(ORG).find((o) => o.external_order_id === "PV-1001");
    expect(before.normalized_status).toBe("submitted");

    const res = await upload(
      "/api/order-imports", adminSession,
      csv([{ order: "PV-1001", status: "Install Scheduled", scheduled: daysAgo(3), modified: daysAgo(4) }]),
      "batch-2.csv",
    );
    expect(res.status).toBe(202);
    await drain();

    const after = store.getOrder(before.id, ORG);
    expect(after.normalized_status).toBe("install_scheduled");
    expect(store.listOrders(ORG).filter((o) => o.external_order_id === "PV-1001")).toHaveLength(1);

    const events = store.listOrderEvents(ORG, before.id);
    expect(events.map((e) => e.new_status)).toEqual(expect.arrayContaining(["submitted", "install_scheduled"]));
    const change = events.find((e) => e.event_type === "status_changed");
    expect(change.old_status).toBe("submitted");
  });

  it("counts an unchanged row as a duplicate and writes no second event", async () => {
    const order = store.listOrders(ORG).find((o) => o.external_order_id === "PV-1001");
    const eventsBefore = store.listOrderEvents(ORG, order.id).length;

    // The SAME bytes again. The duplicate-file guard would normally refuse
    // this, so the test opts past it explicitly - which is the real operational
    // case: an admin re-running yesterday's export on purpose. Nothing about
    // the order should change.
    const res = await upload(
      "/api/order-imports", adminSession,
      csv([{ order: "PV-1001", status: "Install Scheduled", scheduled: daysAgo(3), modified: daysAgo(4) }]),
      "batch-2-again.csv",
      { allowDuplicate: "true" },
    );
    await drain();
    const imported = store.getImport((await res.json()).importId, ORG);
    expect(imported.duplicate_rows).toBe(1);
    expect(imported.inserted_rows).toBe(0);
    expect(store.listOrderEvents(ORG, order.id)).toHaveLength(eventsBefore);
  });

  it("keeps the original row encrypted rather than in the clear", () => {
    const order = store.listOrders(ORG).find((o) => o.external_order_id === "PV-1001");
    const row = store.latestImportRowForOrder(ORG, order.id);
    expect(row.encrypted_raw_payload).toBeTruthy();
    expect(row.encrypted_raw_payload).not.toContain("jane@example.com");
    expect(row.encrypted_raw_payload).not.toContain("7045550142");
    // And the order row itself only ever holds the masked forms.
    expect(order.customer_phone_masked).toBe("***-***-0142");
    expect(JSON.stringify(order)).not.toContain("7045550142");
  });

  it("rejects a file that is not a report at all", async () => {
    const res = await upload("/api/order-imports", adminSession, "", "empty.csv");
    expect(res.status).toBe(400);
  });
});

// ── Matching ─────────────────────────────────────────────────────────────────

describe("matching", () => {
  it("attributes an exact order-id match to the rep who sold it", () => {
    const order = store.listOrders(ORG).find((o) => o.external_order_id === "PV-1001");
    expect(order.match_status).toBe("matched");
    expect(order.match_confidence_score).toBe(1);
    expect(order.sale_id).toBe(saleAId);
    expect(order.rep_id).toBe(repAMemberId);
  });

  it("sends an address-only match to a human instead of attributing it", async () => {
    const res = await upload(
      "/api/order-imports", adminSession,
      csv([{
        order: "PV-9999", address: "77 Oak Avenue, Concord NC 28025",
        status: "Missed Appointment", scheduled: daysAgo(4), modified: daysAgo(4),
      }]),
      "address-only.csv",
    );
    await drain();
    expect((await request(`/api/order-imports/${(await res.json()).importId}`, adminSession)).status).toBe(200);

    const order = store.listOrders(ORG).find((o) => o.external_order_id === "PV-9999");
    expect(order.match_status).toBe("matched_low_confidence");
    // Nothing is attributed on a low-confidence match.
    expect(order.sale_id).toBeNull();
    expect(order.rep_id).toBeNull();

    const exceptions = await (await request("/api/order-imports/exceptions/list", adminSession)).json();
    const hit = exceptions.exceptions.find((e: any) => e.externalOrderId === "PV-9999");
    expect(hit).toBeTruthy();
    expect(hit.exceptionReason).toMatch(/confirm/i);
  });

  it("does not open a recovery case for an unresolved order", () => {
    const order = store.listOrders(ORG).find((o) => o.external_order_id === "PV-9999");
    expect(store.findActiveCase(ORG, order.id)).toBeNull();
  });

  it("lets an administrator resolve the exception, which then attributes it", async () => {
    const exceptions = await (await request("/api/order-imports/exceptions/list", adminSession)).json();
    const hit = exceptions.exceptions.find((e: any) => e.externalOrderId === "PV-9999");

    const res = await request(`/api/order-imports/exceptions/${hit.id}/resolve`, adminSession, {
      method: "POST",
      body: JSON.stringify({ decision: "link", saleId: addressOnlySaleId }),
    });
    expect(res.status).toBe(200);

    const order = store.listOrders(ORG).find((o) => o.external_order_id === "PV-9999");
    expect(order.match_status).toBe("matched");
    expect(order.sale_id).toBe(addressOnlySaleId);
    expect(order.rep_id).toBe(repAMemberId);

    // Resolving it also stamps the carrier's id onto the sale, so the NEXT
    // import matches at tier one without a human.
    const sale = rawDb.prepare(`SELECT external_order_id FROM commission_sales WHERE id = ?`).get(addressOnlySaleId) as any;
    expect(sale.external_order_id).toBe("PV-9999");

    // And the order enters the queue immediately rather than at the next pass.
    expect(store.findActiveCase(ORG, order.id)).toBeTruthy();
  });

  it("refuses to resolve an exception against another organization's sale", async () => {
    const exceptions = await (await request("/api/order-imports/exceptions/list", adminSession)).json();
    const anyRow = exceptions.exceptions[0];
    if (!anyRow) return;
    const res = await request(`/api/order-imports/exceptions/${anyRow.id}/resolve`, adminSession, {
      method: "POST",
      body: JSON.stringify({ decision: "link", saleId: 999_999 }),
    });
    expect(res.status).toBe(404);
  });
});

// ── Recovery ─────────────────────────────────────────────────────────────────

describe("recovery", () => {
  it("opens a case for a failed install and assigns it to the original rep", async () => {
    await upload(
      "/api/order-imports", adminSession,
      csv([{
        order: "PV-1001", status: "Install Failed", scheduled: daysAgo(2),
        reason: "Technician could not access the unit", modified: daysAgo(1),
      }]),
      "failed.csv",
    );
    await drain();

    const order = store.listOrders(ORG).find((o) => o.external_order_id === "PV-1001");
    const found = store.findActiveCase(ORG, order.id);
    expect(found).toBeTruthy();
    expect(found.recovery_reason).toBe("failed_install");
    expect(found.priority).toBe("urgent");
    expect(found.assigned_to_rep_id).toBe(repAMemberId);
  });

  it("shows a rep only their own cases", async () => {
    const mine = await (await request("/api/order-recovery/cases", repASession)).json();
    expect(mine.cases.length).toBeGreaterThan(0);
    for (const c of mine.cases) expect(c.assignedToRepId).toBe(repAMemberId);

    const theirs = await (await request("/api/order-recovery/cases", repBSession)).json();
    for (const c of theirs.cases) expect(c.assignedToRepId).toBe(repBMemberId);
    expect(theirs.cases.map((c: any) => c.id)).not.toEqual(
      expect.arrayContaining(mine.cases.map((c: any) => c.id)),
    );
  });

  it("refuses a rep another rep's case by 404, not 403", async () => {
    const mine = await (await request("/api/order-recovery/cases", repASession)).json();
    const caseId = mine.cases[0].id;
    expect((await request(`/api/order-recovery/cases/${caseId}`, repASession)).status).toBe(200);
    expect((await request(`/api/order-recovery/cases/${caseId}`, repBSession)).status).toBe(404);
  });

  it("refuses a rep the ability to reassign", async () => {
    const mine = await (await request("/api/order-recovery/cases", repASession)).json();
    const res = await request(`/api/order-recovery/cases/${mine.cases[0].id}/assign`, repASession, {
      method: "POST", body: JSON.stringify({ repId: repBMemberId }),
    });
    expect(res.status).toBe(403);
  });

  it("lets a manager reassign, and records who did it", async () => {
    const queue = await (await request("/api/order-recovery/cases", managerSession)).json();
    const caseId = queue.cases[0].id;
    const res = await request(`/api/order-recovery/cases/${caseId}/assign`, managerSession, {
      method: "POST", body: JSON.stringify({ repId: repBMemberId }),
    });
    expect(res.status).toBe(200);

    const detail = await (await request(`/api/order-recovery/cases/${caseId}`, managerSession)).json();
    expect(detail.case.assignedToRepId).toBe(repBMemberId);
    expect(detail.timeline.some((e: any) => e.event_type === "assigned")).toBe(true);

    // Put it back so later assertions read the original assignment.
    await request(`/api/order-recovery/cases/${caseId}/assign`, managerSession, {
      method: "POST", body: JSON.stringify({ repId: repAMemberId }),
    });
  });

  it("closes the case when the order installs, and counts it as recovered", async () => {
    await upload(
      "/api/order-imports", adminSession,
      csv([{ order: "PV-1001", status: "Installed", installed: daysAgo(0), modified: daysAgo(0) }]),
      "installed.csv",
    );
    await drain();

    const order = store.listOrders(ORG).find((o) => o.external_order_id === "PV-1001");
    expect(order.normalized_status).toBe("installed");
    expect(store.findActiveCase(ORG, order.id)).toBeNull();

    const closed = rawDb.prepare(
      `SELECT * FROM order_recovery_cases WHERE tenant_id = ? AND vendor_order_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(ORG, order.id) as any;
    expect(closed.status).toBe("resolved");
    expect(closed.resolution_code).toBe("recovered_installed");

    const metrics = await (await request("/api/order-recovery/metrics", managerSession)).json();
    expect(metrics.recovery.recoveredInstalled).toBeGreaterThanOrEqual(1);
    expect(metrics.funnel.installed).toBeGreaterThanOrEqual(1);
  });

  it("does not treat an installed order as a paid one", async () => {
    const order = store.listOrders(ORG).find((o) => o.external_order_id === "PV-1001");
    const detail = await (await request(`/api/vendor-orders/${order.id}`, managerSession)).json();
    expect(detail.order.normalizedStatus).toBe("installed");
    // The commission plane has said nothing about this order, and the API does
    // not invent an answer.
    expect(detail.commission).toEqual([]);
  });

  it("re-running the evaluation twice changes nothing the second time", async () => {
    const first = await (await request("/api/order-recovery/evaluate", adminSession, { method: "POST" })).json();
    const second = await (await request("/api/order-recovery/evaluate", adminSession, { method: "POST" })).json();
    expect(second.opened).toBe(0);
    expect(second.autoResolved).toBe(0);
    expect(first.scanned).toBe(second.scanned);
  });
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

describe("tenant isolation", () => {
  it("shows a second organization none of the first's orders, cases or imports", async () => {
    const orders = await (await request("/api/vendor-orders", foreignAdminSession)).json();
    expect(orders.orders).toHaveLength(0);

    const cases = await (await request("/api/order-recovery/cases", foreignAdminSession)).json();
    expect(cases.cases).toHaveLength(0);

    const imports = await (await request("/api/order-imports", foreignAdminSession)).json();
    expect(imports.imports).toHaveLength(0);

    const exceptions = await (await request("/api/order-imports/exceptions/list", foreignAdminSession)).json();
    expect(exceptions.exceptions).toHaveLength(0);
  });

  it("404s a cross-organization order and case read", async () => {
    const order = store.listOrders(ORG)[0];
    expect((await request(`/api/vendor-orders/${order.id}`, foreignAdminSession)).status).toBe(404);

    const anyCase = rawDb.prepare(`SELECT id FROM order_recovery_cases WHERE tenant_id = ? LIMIT 1`).get(ORG) as any;
    if (anyCase) {
      expect((await request(`/api/order-recovery/cases/${anyCase.id}`, foreignAdminSession)).status).toBe(404);
    }
  });

  it("404s a cross-organization import and its raw file", async () => {
    const anyImport = store.listImports(ORG)[0];
    expect((await request(`/api/order-imports/${anyImport.id}`, foreignAdminSession)).status).toBe(404);
    expect((await request(`/api/order-imports/${anyImport.id}/file`, foreignAdminSession)).status).toBe(404);
  });
});

// ── The raw file ─────────────────────────────────────────────────────────────

describe("the stored report", () => {
  it("gives an administrator the original bytes back, and records the download", async () => {
    const target = store.listImports(ORG).find((i) => i.source_file_storage_key);
    expect(target).toBeTruthy();

    const before = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'order_import.file.downloaded'`,
    ).get() as any;

    const res = await request(`/api/order-imports/${target!.id}/file`, adminSession);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("Order Number");

    const after = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'order_import.file.downloaded'`,
    ).get() as any;
    expect(Number(after.n)).toBe(Number(before.n) + 1);
  });

  it("refuses the raw file to a manager", async () => {
    const target = store.listImports(ORG).find((i) => i.source_file_storage_key)!;
    expect((await request(`/api/order-imports/${target.id}/file`, managerSession)).status).toBe(403);
  });
});

// ── The worker ───────────────────────────────────────────────────────────────

describe("the worker", () => {
  it("serves /api/health while a large import is in flight", async () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      order: `BULK-${i}`, status: "Submitted", submitted: daysAgo(40), modified: daysAgo(40),
    }));
    const res = await upload("/api/order-imports", adminSession, csv(rows), "bulk.csv");
    expect(res.status).toBe(202);

    // Start the import and hammer the health endpoint while it runs. The worker
    // yields between chunks, so these must all answer rather than queueing
    // behind the whole file.
    const importing = drain();
    const probes: Promise<Response>[] = [];
    for (let i = 0; i < 12; i += 1) probes.push(realFetch(`${baseUrl}/api/health`));
    const results = await Promise.all(probes);
    await importing;

    for (const probe of results) expect(probe.status).toBe(200);
    expect(store.listOrders(ORG, { limit: 500 }).length).toBeGreaterThanOrEqual(400);
  });

  it("claims each queued import exactly once", async () => {
    await upload("/api/order-imports", adminSession, csv([{ order: "LOCK-1" }]), "lock.csv");

    // Two workers racing for one row. The claim is an atomic UPDATE, so one
    // wins and the other finds nothing.
    const claims = [store.claimNextPendingImport(), store.claimNextPendingImport()];
    expect(claims.filter(Boolean)).toHaveLength(1);

    // Hand it back so the real worker finishes it.
    const claimed = claims.find(Boolean)!;
    store.setImportStatus(claimed.id, "pending");
    await drain();
    expect(store.getImport(claimed.id, ORG).status).toBe("completed");
  });

  it("fails an import whose file is gone rather than retrying forever", async () => {
    const id = store.createImport({
      tenantId: ORG, sourceUrl: null, importMode: "manual_upload",
      reportPeriodStart: null, reportPeriodEnd: null,
      sourceFileName: "missing.csv", sourceFileChecksum: "f".repeat(64),
      sourceFileStorageKey: null, mappingVersion: 1, importedByUserId: null, totalRows: 1,
    });
    await drain();
    const row = store.getImport(id, ORG);
    expect(row.status).toBe("failed");
    expect(row.safe_error_summary).toMatch(/upload the report again/i);
  });
});
