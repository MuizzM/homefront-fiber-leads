// ── PAY-A2 integration tests — contractor banking + W-9 + NACHA ACH ─────────
// Covers: ABA checksum validation, encryption at rest (rawDb ciphertext vs
// masked API), the W-9 lifecycle (validation, ESIGN consent, PDF generation,
// own-only + cross-tenant access), NACHA generation (strict 409, allowPartial
// sidecar, golden byte-stability, entry hash + control totals, reconciliation
// against the payroll CSV Total row), the 1099 summary, and capability gates.
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RETRO_TIERS } from "../../shared/commissionTiers";
import { weekBoundsFor, DEFAULT_WORKWEEK } from "../../shared/workweek";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let svc: typeof import("../../server/commissionService");
let nachaSvc: typeof import("../../server/nachaService");
let rawDb: any;
let dataDir = "";

// Valid ABA routing numbers (checksum-verified below): BofA 026009593 is the
// company ODFI; reps use Chase 021000021 / 011000015.
const ODFI_ROUTING = "026009593";
const REP1_ROUTING = "021000021";
const REP2_ROUTING = "011000015";
const BAD_ROUTING = "123456789"; // fails checksum

type Fixture = { userId: number; memberId: number; session: string };
function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep"): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@pay-a2.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, reportsToId: null, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}
function request(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) },
  });
}

let TENANT_B = 0;
let admin1: Fixture, mgr1: Fixture, rep1: Fixture, rep2: Fixture, mgr2: Fixture;

// A concrete, normal commission week: Mon Jun 8 – Sun Jun 14 2026 (America/New_York).
const WEEK_REF = "2026-06-10T12:00:00Z";
const WEEK_START = "2026-06-08";
let inWeekTs = "";

function seedQualifiedSales(tenantId: number, repId: number, n: number, prefix: string) {
  for (let i = 0; i < n; i++) {
    svc.upsertSale(tenantId, 1, { repId, externalId: `${prefix}-${i}`, status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
  }
}

const BANK_BODY = (routing: string, account = "123456789012", accountType = "checking") =>
  ({ routing, account, accountType });
const W9_BODY = (name: string, tin = "123456789") => ({
  legalName: name, address: { line1: "123 Main St", city: "Durham", state: "NC", zip: "27701" },
  tin, tinType: "ssn", signatureName: name, consent: true,
});

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hf-pay-a2-"));
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = "test";
  // 32-byte key (64 hex) for the pay plane's AES-256-GCM at-rest encryption.
  process.env.PAY_CRYPTO_KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  svc = await import("../../server/commissionService");
  nachaSvc = await import("../../server/nachaService");

  TENANT_B = storage.createTenant({
    slug: "pay-a2-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@pay-a2.example.test", brandName: "Org B",
  } as any).id;

  admin1 = makePerson("Pay Admin One", "admin", 1);
  mgr1 = makePerson("Pay Mgr One", "manager", 1);
  rep1 = makePerson("Pay Rep One", "rep", 1);
  rep2 = makePerson("Pay Rep Two", "rep", 1);
  mgr2 = makePerson("Pay Mgr Two", "manager", TENANT_B);

  inWeekTs = new Date(Date.parse(weekBoundsFor(WEEK_REF, DEFAULT_WORKWEEK).weekStartUtc) + 3 * 3_600_000).toISOString();

  // Commission fixture: standard retro tiered plan; rep1 8 sales ($1,600), rep2 1 sale ($150).
  const plan = svc.createPlan(1, admin1.userId, { name: "Standard", type: "TIERED", tierMode: "RETROACTIVE_WEEKLY" });
  const version = svc.addPlanVersion(1, admin1.userId, plan.id, { effectiveFrom: "2026-01-01", qualificationBasis: "QUALIFIED_AT", tiers: DEFAULT_RETRO_TIERS });
  svc.activatePlan(1, admin1.userId, plan.id);
  for (const rep of [rep1, rep2]) {
    svc.assignPlanVersionToRep(1, admin1.userId, { repId: rep.memberId, commissionPlanVersionId: version.id, effectiveFrom: "2026-01-01" });
  }
  seedQualifiedSales(1, rep1.memberId, 8, "p1");
  seedQualifiedSales(1, rep2.memberId, 1, "p2");
  svc.batchTransitionWeek(1, admin1.userId, WEEK_REF, "FINALIZE");

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe("ABA checksum + bank onboarding", () => {
  it("rejects an ABA routing number that fails the checksum", async () => {
    const res = await request("/api/me/bank", rep1.session, { method: "PUT", body: JSON.stringify(BANK_BODY(BAD_ROUTING)) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_ROUTING");
  });

  it("rejects malformed account numbers and account types", async () => {
    let res = await request("/api/me/bank", rep1.session, { method: "PUT", body: JSON.stringify(BANK_BODY(REP1_ROUTING, "12")) });
    expect(res.status).toBe(400);
    res = await request("/api/me/bank", rep1.session, { method: "PUT", body: JSON.stringify(BANK_BODY(REP1_ROUTING, "123456789012", "money-market")) });
    expect(res.status).toBe(400);
  });

  it("stores bank details ENCRYPTED at rest; API exposes last4 only", async () => {
    const res = await request("/api/me/bank", rep1.session, { method: "PUT", body: JSON.stringify(BANK_BODY(REP1_ROUTING, "123456789012", "checking")) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ last4: "9012", accountType: "checking", status: "active" });

    const row = rawDb.prepare(`SELECT * FROM rep_bank_details WHERE rep_id = ?`).get(rep1.memberId) as any;
    expect(row.routing_enc).toMatch(/^v1\./);
    expect(row.account_enc).toMatch(/^v1\./);
    expect(row.routing_enc).not.toContain(REP1_ROUTING);
    expect(row.account_enc).not.toContain("123456789012");
    expect(row.last4).toBe("9012");

    const get = await request("/api/me/bank", rep1.session);
    const masked = await get.json();
    expect(masked.last4).toBe("9012");
    expect(JSON.stringify(masked)).not.toContain(REP1_ROUTING);
    expect(JSON.stringify(masked)).not.toContain("123456789012");
  });

  it("GET /api/me/bank 404s when nothing is on file", async () => {
    const res = await request("/api/me/bank", rep2.session);
    expect(res.status).toBe(404);
  });
});

describe("W-9 lifecycle (ESIGN)", () => {
  it("requires consent, a 9-digit TIN, and a signature matching the legal name", async () => {
    let res = await request("/api/me/w9", rep1.session, { method: "POST", body: JSON.stringify({ ...W9_BODY("Pay Rep One"), consent: false }) });
    expect(res.status).toBe(400);
    res = await request("/api/me/w9", rep1.session, { method: "POST", body: JSON.stringify(W9_BODY("Pay Rep One", "12345")) });
    expect(res.status).toBe(400);
    res = await request("/api/me/w9", rep1.session, { method: "POST", body: JSON.stringify({ ...W9_BODY("Pay Rep One"), signatureName: "Someone Else" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/signature/i);
  });

  it("accepts a valid W-9, encrypts the TIN, and generates the official PDF", async () => {
    const res = await request("/api/me/w9", rep1.session, { method: "POST", body: JSON.stringify(W9_BODY("Pay Rep One")) });
    expect(res.status).toBe(201);
    const status = await res.json();
    expect(status).toMatchObject({ submitted: true, legalName: "Pay Rep One", tinType: "ssn", tinMasked: "***-**-6789" });

    const row = rawDb.prepare(`SELECT * FROM w9_forms WHERE rep_id = ? ORDER BY id DESC LIMIT 1`).get(rep1.memberId) as any;
    expect(row.tin_enc).toMatch(/^v1\./);
    expect(row.tin_enc).not.toContain("123456789");
    expect(row.consent).toBe(1);
    expect(row.signature_ip).toBeTruthy();
    expect(row.signature_ua).toBeTruthy();
    expect(row.pdf_path).toContain(join("uploads", "w9"));
    expect(existsSync(row.pdf_path)).toBe(true);
    expect(statSync(row.pdf_path).size).toBeGreaterThan(50_000); // official 6-page template, filled
    expect(readFileSync(row.pdf_path).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("streams the rep's OWN W-9 PDF only", async () => {
    const own = await request("/api/me/w9/pdf", rep1.session);
    expect(own.status).toBe(200);
    expect(own.headers.get("content-type")).toContain("application/pdf");
    expect((await own.arrayBuffer()).byteLength).toBeGreaterThan(50_000);
    // rep2 never submitted one
    expect((await request("/api/me/w9/pdf", rep2.session)).status).toBe(404);
    expect((await request("/api/me/w9", rep2.session)).status).toBe(404);
  });

  it("managers see masked status in-tenant; cross-tenant is a 404", async () => {
    const res = await request(`/api/team-members/${rep1.memberId}/w9`, mgr1.session);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tinMasked).toBe("***-**-6789");
    expect(JSON.stringify(body)).not.toContain("123456789");
    // manager of org B cannot see org A's rep
    expect((await request(`/api/team-members/${rep1.memberId}/w9`, mgr2.session)).status).toBe(404);
    expect((await request(`/api/team-members/${rep1.memberId}/bank`, mgr2.session)).status).toBe(404);
    // in-tenant bank status is masked
    const bank = await request(`/api/team-members/${rep1.memberId}/bank`, mgr1.session);
    expect(bank.status).toBe(200);
    expect(JSON.stringify(await bank.json())).not.toContain(REP1_ROUTING);
  });
});

describe("company profile (ODFI)", () => {
  it("is admin-writable, manager-readable, and masked", async () => {
    // manager lacks settings.manage.org
    expect((await request("/api/company-profile", mgr1.session, {
      method: "PUT", body: JSON.stringify({ legalName: "Home Front Solutions LLC", ein: "561234567", dfiAccount: "98765432101", dfiRouting: ODFI_ROUTING, companyId: "HFS-PAY001" }),
    })).status).toBe(403);

    const put = await request("/api/company-profile", admin1.session, {
      method: "PUT", body: JSON.stringify({ legalName: "Home Front Solutions LLC", ein: "561234567", dfiAccount: "98765432101", dfiRouting: ODFI_ROUTING, companyId: "HFS-PAY001" }),
    });
    expect(put.status).toBe(200);
    const masked = await put.json();
    expect(masked).toMatchObject({ legalName: "Home Front Solutions LLC", einMasked: "**-***4567", dfiAccountLast4: "2101", dfiRouting: ODFI_ROUTING, companyId: "HFS-PAY001" });
    expect(JSON.stringify(masked)).not.toContain("561234567");
    expect(JSON.stringify(masked)).not.toContain("98765432101");

    const row = rawDb.prepare(`SELECT * FROM company_profile WHERE tenant_id = 1`).get() as any;
    expect(row.ein_enc).toMatch(/^v1\./);
    expect(row.dfi_account_enc).toMatch(/^v1\./);

    const get = await request("/api/company-profile", mgr1.session);
    expect(get.status).toBe(200);
    expect((await get.json()).einMasked).toBe("**-***4567");
  });

  it("rejects an invalid DFI routing checksum", async () => {
    const res = await request("/api/company-profile", admin1.session, {
      method: "PUT", body: JSON.stringify({ legalName: "Home Front Solutions LLC", ein: "561234567", dfiAccount: "98765432101", dfiRouting: BAD_ROUTING, companyId: "HFS-PAY001" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("NACHA export", () => {
  it("strict mode 409s with named exceptions when an approved-pay rep lacks bank/W-9", async () => {
    const res = await request(`/api/pay/nacha?weekStart=${WEEK_START}`, mgr1.session);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("PAY_ROSTER_INCOMPLETE");
    expect(body.exceptions).toHaveLength(1);
    expect(body.exceptions[0]).toMatchObject({ repId: rep2.memberId, repName: "Pay Rep Two", amountCents: 15000 });
    expect(body.exceptions[0].missing).toEqual(expect.arrayContaining(["bank", "w9"]));
  });

  it("allowPartial=1 pays the payable set and names exclusions in the header", async () => {
    const res = await request(`/api/pay/nacha?weekStart=${WEEK_START}&allowPartial=1`, mgr1.session);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-disposition")).toContain(".ach");
    expect(res.headers.get("x-nacha-entry-count")).toBe("1");
    expect(res.headers.get("x-nacha-total-cents")).toBe("160000");
    const exceptions = JSON.parse(res.headers.get("x-nacha-exceptions")!);
    expect(exceptions[0].repId).toBe(rep2.memberId);
    const text = await res.text();
    expect(text).toContain("02100002"); // rep1 receiving DFI present
    expect(text).not.toContain("01100001"); // rep2 excluded
  });

  it("once the roster is complete, the file reconciles with the payroll CSV Total row", async () => {
    await request("/api/me/bank", rep2.session, { method: "PUT", body: JSON.stringify(BANK_BODY(REP2_ROUTING, "9988776655", "savings")) });
    await request("/api/me/w9", rep2.session, { method: "POST", body: JSON.stringify(W9_BODY("Pay Rep Two", "987654321")) });

    const res = await request(`/api/pay/nacha?weekStart=${WEEK_START}`, mgr1.session);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-nacha-total-cents")).toBe("175000");
    const text = await res.text();
    const lines = text.trimEnd().split("\n");
    expect(lines.every(l => l.length === 94)).toBe(true);
    expect(lines.length % 10).toBe(0);
    expect(lines[0][0]).toBe("1");
    expect(lines[1][0]).toBe("5");
    expect(lines[2][0]).toBe("6");
    expect(lines[3][0]).toBe("6");
    expect(lines[4][0]).toBe("8");
    expect(lines[5][0]).toBe("9");

    // Entry details: tran codes 22 (checking) / 32 (savings), amounts in cents.
    expect(lines[2].slice(1, 3)).toBe("22");
    expect(lines[2].slice(3, 12)).toBe(REP1_ROUTING);
    expect(lines[2].slice(12, 29).trim()).toBe("123456789012");
    expect(lines[2].slice(29, 39)).toBe("0000160000");
    expect(lines[3].slice(1, 3)).toBe("32");
    expect(lines[3].slice(29, 39)).toBe("0000015000");

    // Batch control: entry count 2, entry hash = Σ first-8 of receiving DFI
    // (02100002 + 01100001 = 03200003), debit 0, credit 175000.
    const batchCtl = lines[4];
    expect(batchCtl.slice(1, 4)).toBe("200");
    expect(batchCtl.slice(4, 10)).toBe("000002");
    expect(batchCtl.slice(10, 20)).toBe("0003200003");
    expect(batchCtl.slice(20, 32)).toBe("0".repeat(12));
    expect(batchCtl.slice(32, 44)).toBe("000000175000");

    // File control agrees; filler lines are all 9s.
    const fileCtl = lines[5];
    expect(fileCtl.slice(1, 7)).toBe("000001"); // one batch
    expect(fileCtl.slice(13, 21)).toBe("00000002"); // entry/addenda count
    expect(fileCtl.slice(21, 31)).toBe("0003200003"); // entry hash
    expect(fileCtl.slice(43, 55)).toBe("000000175000");
    for (const filler of lines.slice(6)) expect(filler).toBe("9".repeat(94));

    // PPD / WEEKLY PAY / effective date = next banking day after Mon 2026-06-08
    // → Tue 2026-06-09 (260609); service class 200 (credits only).
    expect(lines[1].slice(50, 53)).toBe("PPD");
    expect(lines[1].slice(53, 63)).toBe("WEEKLY PAY");
    expect(lines[1].slice(69, 75)).toBe("260609");

    // ── Reconciliation with the payroll CSV Total row (same money math) ──────
    const csv = await request(`/api/commission/week-export.csv?week=${WEEK_START}`, mgr1.session);
    expect(csv.status).toBe(200);
    const totalLine = (await csv.text()).trimEnd().split("\n").find(l => l.startsWith("Total,"))!;
    // NACHA total credit (175000¢) === CSV Total row final column ($1,750.00).
    expect(totalLine.endsWith(",1750.00")).toBe(true);
  });

  it("is byte-stable for the same inputs and honors fileIdModifier", async () => {
    const base = { tenantId: 1, actorId: admin1.userId, weekReference: WEEK_REF, now: new Date("2026-06-19T14:30:00Z") };
    const a = nachaSvc.buildNachaFile(base);
    const b = nachaSvc.buildNachaFile(base);
    expect(a.fileContent).toBe(b.fileContent);
    expect(a.entryCount).toBe(2);
    expect(a.totalCents).toBe(175000);
    expect(a.overviewTotalCents).toBe(175000);
    expect(a.exceptions).toHaveLength(0);
    // Golden digest: pins every byte of the deterministic file.
    const digest = createHash("sha256").update(a.fileContent).digest("hex");
    expect(digest).toBe("d2f038ad6f8b753ebf023392f9cc5c2a3002e335e8859ece0ca437480a8d74b7");
    // Regeneration per NACHA dup rules: file ID modifier changes byte 34.
    const c = nachaSvc.buildNachaFile({ ...base, fileIdModifier: "B" });
    expect(c.fileContent).not.toBe(a.fileContent);
    expect(c.fileContent[33]).toBe("B");
    expect(c.fileContent.slice(0, 33)).toBe(a.fileContent.slice(0, 33));
    expect(() => nachaSvc.buildNachaFile({ ...base, fileIdModifier: "AB" })).toThrowError(/fileIdModifier/);
  });

  it("is capability-gated: reps get 403, managers in another tenant see an empty run", async () => {
    expect((await request(`/api/pay/nacha?weekStart=${WEEK_START}`, rep1.session)).status).toBe(403);
    const other = await request(`/api/pay/nacha?weekStart=${WEEK_START}`, mgr2.session);
    expect(other.status).toBe(409); // tenant B has no company profile yet
    expect((await other.json()).code).toBe("COMPANY_PROFILE_MISSING");
    expect((await request(`/api/pay/1099-summary?year=2026`, rep1.session)).status).toBe(403);
  });
});

describe("1099-NEC readiness summary", () => {
  it("sums PAID statements per rep, applies the $600 threshold, joins W-9/bank status", async () => {
    svc.batchTransitionWeek(1, admin1.userId, WEEK_REF, "MARK_PAID");
    const res = await request(`/api/pay/1099-summary?year=2026`, mgr1.session);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.year).toBe(2026);
    const r1 = body.reps.find((r: any) => r.repId === rep1.memberId);
    const r2 = body.reps.find((r: any) => r.repId === rep2.memberId);
    expect(r1).toMatchObject({
      legalName: "Pay Rep One", tinMasked: "***-**-6789",
      grossCents: 160000, overThreshold: true, hasW9: true, hasBank: true,
      address: { line1: "123 Main St", city: "Durham", state: "NC", zip: "27701" },
    });
    expect(r2).toMatchObject({ grossCents: 15000, overThreshold: false, hasW9: true, hasBank: true });
    // secrets never leak
    expect(JSON.stringify(body)).not.toContain("123456789");
    expect(JSON.stringify(body)).not.toContain(REP1_ROUTING);
    // a different year has no paid volume
    const empty = await (await request(`/api/pay/1099-summary?year=2025`, mgr1.session)).json();
    expect(empty.reps.find((r: any) => r.repId === rep1.memberId).grossCents).toBe(0);
  });
});
