// ── The Commission File pipeline, end to end ─────────────────────────────────
//
// The fixture is a REAL captured export: 57 rows of the PerfectVision
// Commission File page for dealer HF336, 2026-07-17 to 2026-08-16, carrying
// every shape the parser has to survive in production - parenthesized
// negatives, comma thousands, weekly batch totals with no order identity,
// all-caps manual PAYMENT spiffs whose customer lives only in Comments, and
// the same account restated across weeks.
//
// The properties, grouped the way the vendor-order suite groups its own:
//
//   AUTHORIZATION   uploads are admin-only, the queue is manager-and-up, and a
//                   second organization sees nothing of the first's money.
//   PARSING         the fixture's 57 rows all land; money parses signed and
//                   exact; batch totals and manual spiffs are told apart from
//                   order lines structurally, not by casing.
//   MONEY           a pre-stamped account matches outright and its lines write
//                   vendor_order_commission_links - paid positive, chargeback
//                   negative, all on the SAME order's timeline - and the
//                   recovery engine's paid-block reads them.
//   REVIEW          a name-and-dates fit attaches NO money and waits for a
//                   human; two candidates refuse rather than guess.
//   RESOLUTION      confirming stamps the account onto the sale (and order),
//                   writes the money, and sweeps the account's other lines.
//   RESTATEMENT     newest upload wins; an older file cannot walk a paid line
//                   back; a byte-identical re-import writes nothing.

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let worker: typeof import("../../server/commissionFileImportWorker");
let store: typeof import("../../server/commissionFileStore");
let vendorStore: typeof import("../../server/vendorOrderStore");

let adminSession = "", managerSession = "", repSession = "", foreignAdminSession = "";
let repMuizzId = 0, repSaadId = 0;
let lillianSaleId = 0, lillianOrderId = 0, barbaraSaleId = 0, wayneSaleId = 0;
let betsySaleAId = 0, betsySaleBId = 0;

const realFetch = globalThis.fetch.bind(globalThis);
const ORG = 1;
const OTHER_ORG = 2;

// Resolved from the repo root: vitest runs with cwd at the workspace, and the
// jsdom environment leaves import.meta.url without a file scheme.
const FIXTURE = readFileSync(
  join(process.cwd(), "tests/fixtures/perfectvision/commission-file-2026-07-17_2026-08-16.csv"),
  "utf8",
);
const HEADER_LINE = FIXTURE.split("\n")[0];

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

/** Multipart assembled by hand: these tests run under jsdom, whose FormData
 *  handed to Node's fetch yields a Content-Length undici disagrees with. Same
 *  device as the vendor-order suite. */
let counter = 0;
async function upload(path: string, sessionId: string, content: string, fileName = "commission.csv", extra: Record<string, string> = {}) {
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

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    if ((await worker.pump()) === 0) return;
  }
}

const lineByKey = (fragment: string): any => {
  const rows = rawDb.prepare(
    `SELECT * FROM commission_file_lines WHERE tenant_id = ? AND line_key LIKE ? ORDER BY id ASC`,
  ).all(ORG, `%${fragment}%`) as any[];
  return rows[0] ?? null;
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-commission-file-"));
  process.env.NODE_ENV = "test";
  process.env.VENDOR_ORDER_ENCRYPTION_KEY = "b".repeat(64);
  process.env.PERFECTVISION_ORDER_SYNC_ENABLED = "false";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  worker = await import("../../server/commissionFileImportWorker");
  store = await import("../../server/commissionFileStore");
  vendorStore = await import("../../server/vendorOrderStore");
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (?, 'org-b-commission', 'Org B', 'Owner B', 'owner-b-commission@example.com', 'Org B')`,
  ).run(OTHER_ORG);

  const member = (name: string) => {
    const info = rawDb.prepare(
      `INSERT INTO team_members (name, tenant_id, role, active, created_at) VALUES (?,?,'rep',1,datetime('now'))`,
    ).run(name, ORG);
    return Number(info.lastInsertRowid);
  };
  repMuizzId = member("Muizz Muhammad");
  repSaadId = member("Saad Qadir");

  const user = (name: string, email: string, role: string, orgId: number) => {
    const created = storage.createUser({ name, email, role, active: true, tenantId: orgId } as any);
    rawDb.prepare(`UPDATE users SET training_required = 0 WHERE id = ?`).run(created.id);
    return storage.createSession(created.id).id;
  };
  adminSession = user("Money Admin", "money-admin@example.com", "admin", ORG);
  managerSession = user("Money Manager", "money-manager@example.com", "manager", ORG);
  repSession = user("Money Rep", "money-rep@example.com", "rep", ORG);
  foreignAdminSession = user("Other Admin", "other-admin-commission@example.com", "admin", OTHER_ORG);

  const lead = (address: string, contact: string) => {
    const info = rawDb.prepare(
      `INSERT INTO leads (address, city, state, zip, tenant_id, contact_name, lead_status, created_at, updated_at)
       VALUES (?, 'Concord', 'NC', '28025', ?, ?, 'sold', datetime('now'), datetime('now'))`,
    ).run(address, ORG, contact);
    return Number(info.lastInsertRowid);
  };
  // Dates are pinned to the fixture's own calendar (act/deact dates in August
  // 2026), so nothing here rots with the wall clock.
  const sale = (opts: {
    externalId: string; repId: number; leadId: number; soldAt: string;
    orderId?: string | null; account?: string | null;
  }) => {
    const info = rawDb.prepare(
      `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, qualified_at, lead_id,
                                     external_order_id, customer_account_number, created_at, updated_at)
       VALUES (?,?,?,'QUALIFIED',?,?,?,?,?,datetime('now'),datetime('now'))`,
    ).run(ORG, opts.repId, opts.externalId, opts.soldAt, opts.soldAt, opts.leadId,
      opts.orderId ?? null, opts.account ?? null);
    return Number(info.lastInsertRowid);
  };

  // LILLIAN LANTZ: the account (226978023) is already stamped on the sale -
  // as a resolution in a previous cycle would have left it - so her five
  // fixture lines (three activations, two first chargebacks) match outright.
  const lillianLead = lead("11 Fir Court", "Lillian Lantz");
  lillianSaleId = sale({
    externalId: "sale-lillian", repId: repMuizzId, leadId: lillianLead,
    soldAt: "2026-08-01T16:00:00.000Z", orderId: "013500111", account: "226978023",
  });
  const orderInfo = rawDb.prepare(
    `INSERT INTO vendor_orders (tenant_id, provider, external_order_id, external_order_key,
                                sale_id, lead_id, rep_id, customer_name, normalized_status, match_status, match_confidence_score)
     VALUES (?,?,?,?,?,?,?,?,'installed','matched',1)`,
  ).run(ORG, "perfectvision_submitted_orders", "013500111", "013500111",
    lillianSaleId, lillianLead, repMuizzId, "LILLIAN LANTZ");
  lillianOrderId = Number(orderInfo.lastInsertRowid);

  // BARBARA BRUCE: a sale with NO account number. Her open $625 activation
  // (act 8/12) can only reach the review queue until a human confirms it.
  barbaraSaleId = sale({
    externalId: "sale-barbara", repId: repMuizzId, leadId: lead("22 Pine Street", "Barbara Bruce"),
    soldAt: "2026-08-10T15:00:00.000Z", orderId: "013500222",
  });

  // WAYNE BLAIR: three fixture lines under one account (227049639), no
  // stamp. Confirming ONE line must sweep the other two.
  wayneSaleId = sale({
    externalId: "sale-wayne", repId: repSaadId, leadId: lead("33 Oak Avenue", "Wayne Blair"),
    soldAt: "2026-08-08T15:00:00.000Z",
  });

  // BETSY TREXLER twice: two sales fit her line's name and dates, and two
  // candidates is a refusal, never a coin flip.
  betsySaleAId = sale({
    externalId: "sale-betsy-a", repId: repMuizzId, leadId: lead("44 Elm Street", "Betsy Trexler"),
    soldAt: "2026-08-09T15:00:00.000Z",
  });
  betsySaleBId = sale({
    externalId: "sale-betsy-b", repId: repSaadId, leadId: lead("46 Elm Street", "Betsy Trexler"),
    soldAt: "2026-08-11T15:00:00.000Z",
  });

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
  worker.stopCommissionFileImportWorker();
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

// ── Authorization ────────────────────────────────────────────────────────────

describe("authorization", () => {
  it("refuses every endpoint without a session", async () => {
    for (const path of ["/api/commission-imports/providers", "/api/commission-imports", "/api/commission-imports/exceptions/list"]) {
      expect((await request(path, null)).status, path).toBe(401);
    }
  });

  it("refuses a rep everything, and a manager the upload surface", async () => {
    expect((await request("/api/commission-imports", repSession)).status).toBe(403);
    expect((await request("/api/commission-imports/exceptions/list", repSession)).status).toBe(403);
    // Upload is admin-only; the review queue is manager-and-up, same split as
    // the order plane's screens.
    expect((await request("/api/commission-imports", managerSession)).status).toBe(403);
    expect((await request("/api/commission-imports/exceptions/list", managerSession)).status).toBe(200);
  });
});

// ── Parsing ──────────────────────────────────────────────────────────────────

describe("parsing the real export", () => {
  it("previews the fixture without importing anything", async () => {
    const res = await upload("/api/commission-imports/preview", adminSession, FIXTURE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowCount).toBe(57);
    expect(body.skippedRows).toBe(0);
    expect(body.byCategory.activation.rows).toBe(48);
    expect(body.byCategory.chargeback.rows).toBe(2);
    expect(body.byCategory.manual_payment.rows).toBe(3);
    expect(body.byCategory.payment_batch.rows).toBe(4);
    // The four weekly batch totals: $2,405 + $3,930 + $1,250 + $11,960.
    expect(body.byCategory.payment_batch.paidCents).toBe(1_954_500);
    // The two first chargebacks parse NEGATIVE: ($45.00) and ($10.00).
    expect(body.byCategory.chargeback.paidCents).toBe(-5_500);
    expect(body.unparsableMoneyRows).toBe(0);
    expect(store.listCommissionImports(ORG)).toHaveLength(0);
  });

  it("refuses a file that is not the Commission File export", async () => {
    const res = await upload("/api/commission-imports", adminSession, "Name,Amount\nBob,5\n", "wrong.csv");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/missing column/i);
  });

  it("imports all 57 rows into 57 lines through the worker", async () => {
    const res = await upload("/api/commission-imports", adminSession, FIXTURE, "commission-file.csv");
    expect(res.status).toBe(202);
    const { importId } = await res.json();

    // Nothing imported yet: the request returned before the work.
    expect(rawDb.prepare(`SELECT COUNT(*) AS n FROM commission_file_lines WHERE tenant_id = ?`).get(ORG)).toEqual({ n: 0 });

    await drain();
    const imported = store.getCommissionImport(importId, ORG);
    expect(imported.status).toBe("completed");
    expect(imported.total_rows).toBe(57);
    expect(imported.valid_rows).toBe(57);
    expect(imported.inserted_rows).toBe(57);
    expect(imported.error_rows).toBe(0);
  });

  it("tells batch totals and manual spiffs apart from order lines structurally", () => {
    const batches = rawDb.prepare(
      `SELECT * FROM commission_file_lines WHERE tenant_id = ? AND category = 'payment_batch' ORDER BY id`,
    ).all(ORG) as any[];
    expect(batches).toHaveLength(4);
    // The weekly total is 'ignored' work: recorded for reconciliation, never
    // in front of a human as an exception.
    for (const b of batches) expect(b.match_status).toBe("ignored");

    const manuals = rawDb.prepare(
      `SELECT * FROM commission_file_lines WHERE tenant_id = ? AND category = 'manual_payment' ORDER BY id`,
    ).all(ORG) as any[];
    expect(manuals).toHaveLength(3);
    // The customer exists only inside "WI: DAMON DE LUCA - ..." and is
    // recovered from there.
    expect(manuals.map((m) => m.customer_name)).toEqual(
      expect.arrayContaining(["DAMON DE LUCA", "SIDNEY MANGAROO", "BRYAN MCCAIN"]),
    );
  });

  it("keeps the original rows encrypted, never in the clear", () => {
    const row = rawDb.prepare(
      `SELECT * FROM commission_file_rows WHERE tenant_id = ? AND customer_name = 'LILLIAN LANTZ' LIMIT 1`,
    ).get(ORG) as any;
    expect(row.encrypted_raw_payload).toBeTruthy();
    expect(String(row.encrypted_raw_payload)).not.toContain("LILLIAN");
  });
});

// ── Money ────────────────────────────────────────────────────────────────────

describe("money on a stamped account", () => {
  it("matches all five of the account's lines without a human", () => {
    const lines = store.listLinesByAccountKey(ORG, "226978023");
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(line.match_status).toBe("matched");
      expect(line.match_rule).toBe("sale_account_number");
      expect(line.matched_sale_id).toBe(lillianSaleId);
      expect(line.matched_vendor_order_id).toBe(lillianOrderId);
    }
  });

  it("writes paid links positive and chargeback links negative onto the SAME order", () => {
    const links = vendorStore.listCommissionLinks(ORG, lillianOrderId);
    expect(links).toHaveLength(5);
    const paid = links.filter((l) => l.commission_status === "paid");
    const chargebacks = links.filter((l) => l.commission_status === "chargeback");
    expect(paid.map((l) => l.amount_cents).sort((a, b) => a - b)).toEqual([1_000, 4_500, 62_500]);
    expect(chargebacks.map((l) => l.amount_cents).sort((a, b) => a - b)).toEqual([-4_500, -1_000]);
    // Net truth for the order: $680.00 earned, $55.00 clawed back.
    expect(links.reduce((sum, l) => sum + l.amount_cents, 0)).toBe(62_500);
    // The timeline orders by the provider's event date: activations (8/4)
    // before the chargebacks that answered them (8/10).
    expect(links[0].commission_status).toBe("paid");
    expect(links[links.length - 1].commission_status).toBe("chargeback");
  });

  it("marks the first-chargeback lines from the /FCHB comment", () => {
    const chargebackLines = rawDb.prepare(
      `SELECT * FROM commission_file_lines WHERE tenant_id = ? AND category = 'chargeback'`,
    ).all(ORG) as any[];
    expect(chargebackLines).toHaveLength(2);
    for (const line of chargebackLines) expect(line.first_chargeback).toBe(1);
  });

  it("feeds the recovery engine's paid-block through the existing reader", () => {
    expect(vendorStore.commissionPaidForOrder(ORG, lillianOrderId)).toBe(true);
  });

  it("shows the money on the order detail the vendor plane already serves", async () => {
    const detail = await (await request(`/api/vendor-orders/${lillianOrderId}`, managerSession)).json();
    expect(detail.commission).toHaveLength(5);
    expect(detail.commission.some((l: any) => l.commission_status === "chargeback" && l.amount_cents < 0)).toBe(true);
  });

  it("never touches the internal commission engine's statements", () => {
    expect(rawDb.prepare(`SELECT COUNT(*) AS n FROM commission_statements`).get()).toEqual({ n: 0 });
  });
});

// ── Review discipline ────────────────────────────────────────────────────────

describe("the review queue", () => {
  it("holds a name-and-dates fit with NO money attached", () => {
    const barbara = lineByKey("226971945");
    expect(barbara.match_status).toBe("matched_low_confidence");
    expect(barbara.matched_sale_id).toBe(barbaraSaleId);
    expect(barbara.commission_link_id).toBeNull();
    expect(rawDb.prepare(
      `SELECT COUNT(*) AS n FROM vendor_order_commission_links WHERE tenant_id = ? AND source_reference = ?`,
    ).get(ORG, barbara.line_key)).toEqual({ n: 0 });
    // And nothing was stamped: a suggestion earns no identity.
    const sale = rawDb.prepare(`SELECT customer_account_number FROM commission_sales WHERE id = ?`).get(barbaraSaleId) as any;
    expect(sale.customer_account_number).toBeNull();
  });

  it("refuses to pick between two sales that both fit", () => {
    const betsy = lineByKey("226971983");
    expect(betsy.match_status).toBe("exception");
    const candidates = JSON.parse(betsy.match_candidates_json);
    expect(candidates.length).toBe(2);
    expect(candidates.map((c: any) => c.saleId).sort()).toEqual([betsySaleAId, betsySaleBId].sort());
  });

  it("lists the waiting lines for a manager, without the batch totals", async () => {
    const body = await (await request("/api/commission-imports/exceptions/list?limit=200", managerSession)).json();
    expect(body.exceptions.length).toBeGreaterThan(0);
    expect(body.exceptions.some((e: any) => e.category === "payment_batch")).toBe(false);
    const barbara = body.exceptions.find((e: any) => e.accountNumber === "226971945");
    expect(barbara.exceptionReason).toMatch(/confirm/i);
    expect(barbara.candidates.length).toBe(1);
  });
});

// ── Resolution ───────────────────────────────────────────────────────────────

describe("resolving", () => {
  it("stamps the account onto the sale and writes the pending money", async () => {
    const barbara = lineByKey("226971945");
    const res = await request(`/api/commission-imports/exceptions/${barbara.id}/resolve`, managerSession, {
      method: "POST", body: JSON.stringify({ decision: "link", saleId: barbaraSaleId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.linkStatus).toBe("pending");
    expect(body.amountCents).toBe(62_500);

    const sale = rawDb.prepare(
      `SELECT customer_account_number, external_order_id FROM commission_sales WHERE id = ?`,
    ).get(barbaraSaleId) as any;
    expect(sale.customer_account_number).toBe("226971945");

    // No vendor order exists for Barbara yet, so the link waits on its keys:
    // the sale's carrier order id rides along so a later order import can
    // still find its money.
    const link = rawDb.prepare(
      `SELECT * FROM vendor_order_commission_links WHERE tenant_id = ? AND source_reference = ?`,
    ).get(ORG, barbara.line_key) as any;
    expect(link.commission_status).toBe("pending");
    expect(link.vendor_order_id).toBeNull();
    expect(link.external_order_key).toBe("013500222");
  });

  it("refuses to resolve against another organization's sale", async () => {
    const wayne = lineByKey("227049639");
    const res = await request(`/api/commission-imports/exceptions/${wayne.id}/resolve`, managerSession, {
      method: "POST", body: JSON.stringify({ decision: "link", saleId: 999_999 }),
    });
    expect(res.status).toBe(404);
  });

  it("sweeps the account's sibling lines on one confirmation", async () => {
    const wayneLines = store.listLinesByAccountKey(ORG, "227049639");
    expect(wayneLines).toHaveLength(3);
    for (const line of wayneLines) expect(line.match_status).toBe("matched_low_confidence");

    const res = await request(`/api/commission-imports/exceptions/${wayneLines[0].id}/resolve`, managerSession, {
      method: "POST", body: JSON.stringify({ decision: "link", saleId: wayneSaleId }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).sweptLines).toBe(2);

    for (const line of store.listLinesByAccountKey(ORG, "227049639")) {
      expect(line.match_status).toBe("matched");
      expect(line.matched_sale_id).toBe(wayneSaleId);
      expect(line.commission_link_id).toBeTruthy();
    }
    // Wayne's three open activations: $625 + $45 + $10 pending.
    const sum = rawDb.prepare(`
      SELECT SUM(amount_cents) AS total FROM vendor_order_commission_links
       WHERE tenant_id = ? AND source_reference LIKE '227049639%'
    `).get(ORG) as any;
    expect(sum.total).toBe(68_000);
  });

  it("records an audit line for the decision", () => {
    const n = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'commission_import.exception.resolved'`,
    ).get() as any;
    expect(Number(n.n)).toBeGreaterThanOrEqual(2);
  });
});

// ── Restatement across weekly files ──────────────────────────────────────────

describe("restatements", () => {
  const barbaraRow = (upload: string, status: string, pending: string, paid: string, payment = "") =>
    `${HEADER_LINE}\n226971945,02307855,8/12/2026,${upload},${payment},${status},${pending},${paid},Activation,Windstream,HSI SOLO FIBER MAX-THE WORKS,BARBARA BRUCE,MUIZZ MUHAMMAD,WI: BARBARA BRUCE - HSI SOLO FIBER MAX-THE WORKS/ACTV\n`;

  it("a NEWER file closes the line and flips its one link to paid", async () => {
    const res = await upload(
      "/api/commission-imports", adminSession,
      barbaraRow("8/21/2026", "Closed", "$0.00", "$625.00", "8/21/2026"),
      "week-after.csv",
    );
    expect(res.status).toBe(202);
    await drain();

    const barbara = lineByKey("226971945");
    expect(barbara.line_status).toBe("closed");
    // The stamp from the resolution made this file match by itself.
    expect(barbara.match_status).toBe("matched");
    expect(barbara.match_rule).toBe("sale_account_number");

    const links = rawDb.prepare(
      `SELECT * FROM vendor_order_commission_links WHERE tenant_id = ? AND source_reference = ?`,
    ).all(ORG, barbara.line_key) as any[];
    // Still ONE link: the restatement updated it rather than stacking a
    // second $625 onto the timeline.
    expect(links).toHaveLength(1);
    expect(links[0].commission_status).toBe("paid");
    expect(links[0].amount_cents).toBe(62_500);
  });

  it("an OLDER file cannot walk the paid line back to pending", async () => {
    const res = await upload(
      "/api/commission-imports", adminSession,
      barbaraRow("7/20/2026", "Open", "$625.00", "$0.00"),
      "stale-restatement.csv",
    );
    expect(res.status).toBe(202);
    await drain();

    const barbara = lineByKey("226971945");
    expect(barbara.line_status).toBe("closed");
    const link = rawDb.prepare(
      `SELECT * FROM vendor_order_commission_links WHERE tenant_id = ? AND source_reference = ?`,
    ).get(ORG, barbara.line_key) as any;
    expect(link.commission_status).toBe("paid");
  });

  it("refuses the same file twice, and a deliberate re-import writes nothing", async () => {
    const second = await upload("/api/commission-imports", adminSession, FIXTURE, "again.csv");
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/already imported/i);

    const linksBefore = rawDb.prepare(`SELECT COUNT(*) AS n FROM vendor_order_commission_links WHERE tenant_id = ?`).get(ORG) as any;
    const forced = await upload("/api/commission-imports", adminSession, FIXTURE, "again.csv", { allowDuplicate: "true" });
    expect(forced.status).toBe(202);
    const { importId } = await forced.json();
    await drain();

    const imported = store.getCommissionImport(importId, ORG);
    expect(imported.status).toBe("completed");
    expect(imported.inserted_rows).toBe(0);
    // 56 byte-identical rows plus Barbara's, superseded by the newer weekly
    // file above - every one of them evidence, none of them news.
    expect(imported.duplicate_rows).toBe(57);
    const linksAfter = rawDb.prepare(`SELECT COUNT(*) AS n FROM vendor_order_commission_links WHERE tenant_id = ?`).get(ORG) as any;
    expect(Number(linksAfter.n)).toBe(Number(linksBefore.n));
  });
});

// ── Tenant isolation and the stored file ─────────────────────────────────────

describe("tenant isolation", () => {
  it("shows a second organization none of the first's imports or lines", async () => {
    const imports = await (await request("/api/commission-imports", foreignAdminSession)).json();
    expect(imports.imports).toHaveLength(0);
    const exceptions = await (await request("/api/commission-imports/exceptions/list", foreignAdminSession)).json();
    expect(exceptions.exceptions).toHaveLength(0);
  });

  it("404s a cross-organization import and its raw file", async () => {
    const anyImport = store.listCommissionImports(ORG)[0];
    expect((await request(`/api/commission-imports/${anyImport.id}`, foreignAdminSession)).status).toBe(404);
    expect((await request(`/api/commission-imports/${anyImport.id}/file`, foreignAdminSession)).status).toBe(404);
  });

  it("gives an administrator the original bytes back, and records the download", async () => {
    const target = store.listCommissionImports(ORG).find((i) => i.source_file_storage_key)!;
    const res = await request(`/api/commission-imports/${target.id}/file`, adminSession);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("Account Number");
    const n = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'commission_import.file.downloaded'`,
    ).get() as any;
    expect(Number(n.n)).toBe(1);
  });
});

// ── The worker ───────────────────────────────────────────────────────────────

describe("the worker", () => {
  it("claims each queued import exactly once", async () => {
    await upload("/api/commission-imports", adminSession,
      `${HEADER_LINE}\n226999999,09999999,8/12/2026,8/14/2026,,Open,$1.00,$0.00,Activation,Windstream,HSI SOLO FIBER 1 GIG,NOBODY KNOWN,MUIZZ MUHAMMAD,WI: NOBODY KNOWN - HSI SOLO FIBER 1 GIG/ACTV\n`,
      "lock.csv");
    const claims = [store.claimNextPendingCommissionImport(), store.claimNextPendingCommissionImport()];
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = claims.find(Boolean)!;
    store.setCommissionImportStatus(claimed.id, "pending");
    await drain();
    expect(store.getCommissionImport(claimed.id, ORG).status).toBe("completed");
    // And a line nobody in the CRM fits sits unmatched, holding no money.
    const nobody = lineByKey("226999999");
    expect(nobody.match_status).toBe("unmatched");
    expect(nobody.commission_link_id).toBeNull();
  });

  it("fails an import whose file is gone rather than retrying forever", async () => {
    const id = store.createCommissionImport({
      tenantId: ORG, importMode: "manual_upload",
      reportPeriodStart: null, reportPeriodEnd: null,
      sourceFileName: "missing.csv", sourceFileChecksum: "e".repeat(64),
      sourceFileStorageKey: null, importedByUserId: null, totalRows: 1,
    });
    await drain();
    const row = store.getCommissionImport(id, ORG);
    expect(row.status).toBe("failed");
    expect(row.safe_error_summary).toMatch(/upload the commission file again/i);
  });
});
