// A commission statement names a person and states what they were paid, so the
// two things that must hold on these routes are: only people entitled to see a
// rep's pay can fetch it, and the numbers on it agree with the statement row
// they were assembled from.
//
//   GET /api/commission/statements/:id/document      → the JSON document
//   GET /api/commission/statements/:id/statement.pdf → the same document, rendered
//
// Both share the scope check of GET /statements/:id: own → yes, a team lead's
// direct report → yes, another team's rep → 403, another tenant → 404 (an
// out-of-scope resource must not confirm it exists).
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: any;

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep", reportsToId: number | null = null): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@stmt-doc.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, reportsToId, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

const request = (path: string, sessionId: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) } });
const post = (path: string, session: string, body: unknown) =>
  request(path, session, { method: "POST", body: JSON.stringify(body) });

let TENANT_B = 0;
let admin: Fixture, mgr: Fixture, lead: Fixture, rep: Fixture, otherRep: Fixture, adminB: Fixture;
let statementId = 0;
const HOUSE_CENTS = 49_900;
const RATE_CENTS = 5_000;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-stmt-doc-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  TENANT_B = storage.createTenant({
    slug: "stmt-doc-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@stmt-doc.example.test", brandName: "Org B",
  } as any).id;

  admin = makePerson("Doc Admin", "admin", 1, "manager");
  mgr = makePerson("Doc Manager", "manager", 1, "manager");
  lead = makePerson("Doc Lead", "team_lead", 1, "team_lead");
  rep = makePerson("Doc Rep", "rep", 1, "rep", lead.memberId);
  otherRep = makePerson("Doc Other Rep", "rep", 1, "rep");
  adminB = makePerson("Doc Admin Bee", "admin", TENANT_B, "manager");

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  // The tenant books a house amount per sale so the column has something real
  // in it; the rep is on a flat plan with three qualified doors.
  rawDb.prepare(`UPDATE tenants SET commission_house_amount_cents = ? WHERE id = ?`).run(HOUSE_CENTS, 1);
  expect((await post("/api/commission/assign-structure", admin.session, {
    repId: rep.memberId, structure: "FLAT", flatRateCents: RATE_CENTS,
  })).status).toBe(201);

  const now = new Date().toISOString();
  for (let i = 0; i < 3; i += 1) {
    expect((await post("/api/commission/sales", mgr.session, {
      repId: rep.memberId, externalId: `stmt-doc-sale-${i}`, soldAt: now, status: "QUALIFIED", qualifiedAt: now,
    })).status).toBe(201);
  }
  const recalc = await post("/api/commission/statements/recalculate", mgr.session, { repId: rep.memberId, week: now });
  expect(recalc.status).toBe(200);
  statementId = (await recalc.json() as any).statement.id;
  expect(statementId).toBeGreaterThan(0);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});

describe("statement document — who may read it", () => {
  it("the rep reads their OWN statement", async () => {
    const res = await request(`/api/commission/statements/${statementId}/document`, rep.session);
    expect(res.status).toBe(200);
    const doc = await res.json() as any;
    expect(doc.rep.name).toBe("Doc Rep");
  });

  it("the rep's team lead reads it (a direct report is in scope)", async () => {
    expect((await request(`/api/commission/statements/${statementId}/document`, lead.session)).status).toBe(200);
  });

  it("another rep in the same tenant is refused", async () => {
    const res = await request(`/api/commission/statements/${statementId}/document`, otherRep.session);
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("UNAUTHORIZED_COMMISSION_ACTION");
  });

  it("an admin of ANOTHER tenant gets 404, not 403 — the row must not be confirmed", async () => {
    expect((await request(`/api/commission/statements/${statementId}/document`, adminB.session)).status).toBe(404);
    expect((await request(`/api/commission/statements/${statementId}/statement.pdf`, adminB.session)).status).toBe(404);
  });

  it("a statement that does not exist is 404", async () => {
    expect((await request(`/api/commission/statements/99999999/document`, admin.session)).status).toBe(404);
  });

  it("the PDF enforces the SAME scope as the JSON document", async () => {
    expect((await request(`/api/commission/statements/${statementId}/statement.pdf`, otherRep.session)).status).toBe(403);
  });
});

describe("statement document — what it says", () => {
  it("names the tenant's own company, the rep, and the pay period", async () => {
    const doc = await (await request(`/api/commission/statements/${statementId}/document`, rep.session)).json() as any;
    expect(doc.company.name).toBe("Home Front Solutions"); // the seeded tenant's company_name
    expect(doc.rep.id).toBe(rep.memberId);
    expect(doc.period.label).toBeTruthy();
    expect(doc.statement.id).toBe(statementId);
  });

  it("lists every qualified door, and the commission column re-sums to gross", async () => {
    const doc = await (await request(`/api/commission/statements/${statementId}/document`, rep.session)).json() as any;
    const counted = doc.lines.filter((l: any) => l.counted);
    expect(counted).toHaveLength(3);
    expect(counted.reduce((s: number, l: any) => s + l.repCommissionCents, 0)).toBe(doc.totals.grossCommissionCents);
    expect(doc.totals.grossCommissionCents).toBe(3 * RATE_CENTS);
  });

  it("carries the org's house amount per counted door and totals it", async () => {
    const doc = await (await request(`/api/commission/statements/${statementId}/document`, rep.session)).json() as any;
    expect(doc.showHouseColumn).toBe(true);
    expect(doc.totals.houseAmountCents).toBe(3 * HOUSE_CENTS);
    expect(doc.totals.houseMarginCents).toBe(3 * HOUSE_CENTS - 3 * RATE_CENTS);
  });

  it("net pay is the earned amount less the holdback, and the balance is reported", async () => {
    const doc = await (await request(`/api/commission/statements/${statementId}/document`, rep.session)).json() as any;
    expect(doc.payout.netPayCents).toBe(doc.totals.earnedCents - doc.payout.reserveCents);
    expect(typeof doc.payout.reserveBalanceCents).toBe("number");
  });

  it("a reversed door is listed but pays nothing and leaves the house total alone", async () => {
    const now = new Date().toISOString();
    expect((await post("/api/commission/sales", mgr.session, {
      repId: rep.memberId, externalId: "stmt-doc-sale-reversed", soldAt: now, status: "QUALIFIED", qualifiedAt: now,
    })).status).toBe(201);
    expect((await post("/api/commission/sales/stmt-doc-sale-reversed/transition", mgr.session, { action: "REVERSE" })).status).toBe(200);
    expect((await post("/api/commission/statements/recalculate", mgr.session, { repId: rep.memberId, week: now })).status).toBe(200);

    const doc = await (await request(`/api/commission/statements/${statementId}/document`, rep.session)).json() as any;
    const reversed = doc.lines.find((l: any) => l.externalId === "stmt-doc-sale-reversed");
    expect(reversed).toBeTruthy();
    expect(reversed.counted).toBe(false);
    expect(reversed.repCommissionCents).toBe(0);
    // Still three paying doors, and the house total did not move.
    expect(doc.totals.countedSaleCount).toBe(3);
    expect(doc.totals.houseAmountCents).toBe(3 * HOUSE_CENTS);
  });
});

describe("statement PDF", () => {
  it("renders a real PDF with an attachment filename", async () => {
    const res = await request(`/api/commission/statements/${statementId}/statement.pdf`, rep.session);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    // The rep's name is interpolated into the filename — it must be sanitized
    // to a path-safe token, never quoted or slashed straight into the header.
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toMatch(/filename="commission-statement-[A-Za-z0-9-]+-\d{4}-\d{2}-\d{2}\.pdf"/);
    // A pay document must not be cached by an intermediary.
    expect(res.headers.get("cache-control")).toContain("no-store");

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

describe("house amount config", () => {
  it("rejects a negative or fractional house amount", async () => {
    const bad = await request("/api/commission/config", admin.session, {
      method: "PATCH", body: JSON.stringify({ commissionHouseAmountCents: -1 }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json() as any).code).toBe("INVALID_HOUSE_AMOUNT");

    const fractional = await request("/api/commission/config", admin.session, {
      method: "PATCH", body: JSON.stringify({ commissionHouseAmountCents: 10.5 }),
    });
    expect(fractional.status).toBe(400);
  });

  it("round-trips a valid house amount through the config API", async () => {
    const res = await request("/api/commission/config", admin.session, {
      method: "PATCH", body: JSON.stringify({ commissionHouseAmountCents: HOUSE_CENTS }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).houseAmountCents).toBe(HOUSE_CENTS);
  });
});
