// @vitest-environment node
// ── W-9 routes: the certification and the crown-jewel document ───────────────
// The rendered W-9 carries a contractor's COMPLETE 9-digit SSN. This suite pins
// the contract that hardening established:
//   * the signer's tax classification and backup-withholding answer are
//     REQUIRED and persisted — no more silent "individual / not subject",
//   * a name the IRS form cannot print is a 400 with an explanation, not a 500,
//   * the filled PDF is NEVER written to disk; it is re-rendered on demand,
//   * only the rep themselves or an ADMIN (payouts.pay) may download it — a
//     MANAGER keeps masked status and nothing more — and every hit is audited,
//   * no response body and no audit row ever contains the full TIN.
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let dataDir: string;

let repSession: string;
let managerSession: string;
let adminSession: string;
let repTmId: number;
let otherRepTmId: number;

const SSN = "123456789";
const realFetch = globalThis.fetch.bind(globalThis);

function w9Body(over: Record<string, any> = {}) {
  return {
    legalName: "Dana Fieldrep",
    address: { line1: "742 Evergreen Ter", city: "Charlotte", state: "NC", zip: "28202" },
    tin: SSN,
    tinType: "ssn",
    taxClassification: "individual",
    subjectToBackupWithholding: false,
    consent: true,
    signatureName: "Dana Fieldrep",
    ...over,
  };
}

function request(path: string, sessionId: string | null, init: RequestInit = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as any ?? {}) };
  if (sessionId) { headers["x-session-id"] = sessionId; headers["x-csrf-token"] = sessionId; }
  return realFetch(`${baseUrl}${path}`, { ...init, headers });
}

const postW9 = (session: string, body: Record<string, any>) =>
  request("/api/me/w9", session, { method: "POST", body: JSON.stringify(body) });

function w9AuditRows() {
  return rawDb.prepare(`SELECT action, details FROM activity_log WHERE action LIKE 'pay.w9%' ORDER BY id`).all() as
    Array<{ action: string; details: string | null }>;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hf-w9-routes-"));
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = "test";
  // 32-byte AES key for the pay plane (server/payCrypto.ts).
  process.env.PAY_CRYPTO_KEY = "a".repeat(64);

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (1, 'tenant-w9', 'Tenant W9', 'Owner', 'owner-w9@example.com', 'Tenant W9')",
  ).run();

  const repTm = storage.createTeamMember({ name: "Dana Fieldrep", role: "rep", active: true, tenantId: 1 } as any);
  const otherTm = storage.createTeamMember({ name: "Other Rep", role: "rep", active: true, tenantId: 1 } as any);
  repTmId = repTm.id;
  otherRepTmId = otherTm.id;

  const rep = storage.createUser({ name: "Dana Fieldrep", email: "rep-w9@example.com", role: "rep", active: true, tenantId: 1, teamMemberId: repTm.id } as any);
  const manager = storage.createUser({ name: "W9 Manager", email: "manager-w9@example.com", role: "manager", active: true, tenantId: 1 } as any);
  const admin = storage.createUser({ name: "W9 Admin", email: "admin-w9@example.com", role: "admin", active: true, tenantId: 1 } as any);

  repSession = storage.createSession(rep.id).id;
  managerSession = storage.createSession(manager.id).id;
  adminSession = storage.createSession(admin.id).id;

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
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
});

describe("POST /api/me/w9 — Line 3a tax classification is required and coherent", () => {
  it("rejects a submission with no classification at all", async () => {
    const res = await postW9(repSession, { ...w9Body(), taxClassification: undefined });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/taxClassification/);
  });

  it("rejects an LLC with no C/S/P letter", async () => {
    const res = await postW9(repSession, w9Body({ taxClassification: "llc" }));
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/llcTaxClass/);
  });

  it("rejects an LLC whose letter is not C, S, or P", async () => {
    const res = await postW9(repSession, w9Body({ taxClassification: "llc", llcTaxClass: "X" }));
    expect(res.status).toBe(400);
  });

  it('rejects "other" with no description', async () => {
    const res = await postW9(repSession, w9Body({ taxClassification: "other" }));
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/otherClassification/);
  });

  it("accepts an S corporation and persists the classification", async () => {
    const res = await postW9(repSession, w9Body({ taxClassification: "s_corp", businessName: "Fieldrep Sales Inc" }));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.taxClassification).toBe("s_corp");
    expect(body.subjectToBackupWithholding).toBe(false);
    const row = rawDb.prepare(`SELECT * FROM w9_forms WHERE rep_id = ? ORDER BY id DESC LIMIT 1`).get(repTmId) as any;
    expect(row.tax_classification).toBe("s_corp");
    expect(row.consent).toBe(1);
  });

  it("accepts a single-member LLC taxed as an S corp and stores the letter", async () => {
    const res = await postW9(repSession, w9Body({ taxClassification: "llc", llcTaxClass: "S" }));
    expect(res.status).toBe(201);
    expect((await res.json() as any).llcTaxClass).toBe("S");
    const row = rawDb.prepare(`SELECT * FROM w9_forms WHERE rep_id = ? ORDER BY id DESC LIMIT 1`).get(repTmId) as any;
    expect(row.llc_tax_class).toBe("S");
  });
});

describe("POST /api/me/w9 — Part II item 2 (backup withholding)", () => {
  it("requires an explicit answer — silence no longer means 'not subject'", async () => {
    const res = await postW9(repSession, { ...w9Body(), subjectToBackupWithholding: undefined });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/subjectToBackupWithholding/);
  });

  it("persists a TRUE answer and surfaces it on the rep's W-9 status", async () => {
    const res = await postW9(repSession, w9Body({ subjectToBackupWithholding: true }));
    expect(res.status).toBe(201);
    expect((await res.json() as any).subjectToBackupWithholding).toBe(true);
    const row = rawDb.prepare(`SELECT * FROM w9_forms WHERE rep_id = ? ORDER BY id DESC LIMIT 1`).get(repTmId) as any;
    expect(row.subject_to_backup_withholding).toBe(1);

    const status = await (await request("/api/me/w9", repSession)).json() as any;
    expect(status.subjectToBackupWithholding).toBe(true);
  });

  it("the flag reaches the pay lane's 1099 readiness summary", async () => {
    const res = await request("/api/pay/1099-summary", managerSession);
    expect(res.status).toBe(200);
    const rep = ((await res.json() as any).reps as any[]).find(r => r.repId === repTmId);
    expect(rep.subjectToBackupWithholding).toBe(true);
    expect(rep.taxClassification).toBe("individual");
  });

  it("renders the struck PDF on demand (the strike lands in page 1's content)", async () => {
    const res = await request("/api/me/w9/pdf", repSession);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const pdf = new Uint8Array(await res.arrayBuffer());
    const { PDFDocument } = await import("pdf-lib");
    const { readPageContent } = await import("../../server/w9Pdf");
    const doc = await PDFDocument.load(pdf);
    const ops = Buffer.from(readPageContent(doc.getPage(0))).toString("latin1");
    const struck = [305, 296, 286].filter(y => new RegExp(`\\b${y}\\.\\d+ (m|l)\\b`).test(ops)).length;
    expect(struck).toBe(3);
  });
});

describe("POST /api/me/w9 — non-Latin legal names", () => {
  it("Cyrillic onboards successfully (transliterated), and records both forms", async () => {
    const res = await postW9(repSession, w9Body({ legalName: "Иван Петров", signatureName: "Иван Петров" }));
    expect(res.status).toBe(201);
    const row = rawDb.prepare(`SELECT * FROM w9_forms WHERE rep_id = ? ORDER BY id DESC LIMIT 1`).get(repTmId) as any;
    expect(row.legal_name).toBe("Иван Петров");            // the original, verbatim
    expect(JSON.parse(row.rendered_names).legalName).toBe("Ivan Petrov"); // what printed
  });

  it("CJK is a 400 with an explanation — never a 500 that blocks onboarding", async () => {
    const res = await postW9(repSession, w9Body({ legalName: "张伟", signatureName: "张伟" }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe("W9_NAME_NOT_PRINTABLE");
    expect(body.error).toMatch(/romanized/);
    // and nothing was persisted for that attempt
    const row = rawDb.prepare(`SELECT * FROM w9_forms WHERE rep_id = ? ORDER BY id DESC LIMIT 1`).get(repTmId) as any;
    expect(row.legal_name).not.toBe("张伟");
  });
});

describe("the full-SSN document never rests on disk", () => {
  it("no W-9 PDF is written under DATA_DIR", () => {
    const dir = join(dataDir, "uploads", "w9");
    expect(existsSync(dir) && readdirSync(dir).length > 0).toBe(false);
  });

  it("pdf_path is never populated — the record is the encrypted row, not a file", () => {
    const rows = rawDb.prepare(`SELECT pdf_path FROM w9_forms`).all() as Array<{ pdf_path: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.pdf_path === null)).toBe(true);
  });

  it("every submission is kept as its own append-only row (nothing overwritten)", () => {
    const n = (rawDb.prepare(`SELECT COUNT(*) AS n FROM w9_forms WHERE rep_id = ?`).get(repTmId) as any).n;
    expect(n).toBeGreaterThan(1);
  });
});

describe("who may download a rep's full W-9", () => {
  it("the rep gets their OWN", async () => {
    const res = await request("/api/me/w9/pdf", repSession);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it("a MANAGER is forbidden — oversight sees masked status, never the numbers", async () => {
    const res = await request(`/api/team-members/${repTmId}/w9/pdf`, managerSession);
    expect(res.status).toBe(403);
    expect((await res.json() as any).need).toBe("payouts.pay");
  });

  it("a manager still reads the MASKED status (this route was not tightened)", async () => {
    const res = await request(`/api/team-members/${repTmId}/w9`, managerSession);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.tinMasked).toBe("***-**-6789");
    expect(JSON.stringify(body)).not.toContain(SSN);
  });

  it("a REP cannot reach another rep's W-9 PDF at all", async () => {
    const res = await request(`/api/team-members/${otherRepTmId}/w9/pdf`, repSession);
    expect(res.status).toBe(403);
  });

  it("an ADMIN can download it", async () => {
    const res = await request(`/api/team-members/${repTmId}/w9/pdf`, adminSession);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it("an anonymous caller gets 401", async () => {
    expect((await realFetch(`${baseUrl}/api/team-members/${repTmId}/w9/pdf`)).status).toBe(401);
    expect((await realFetch(`${baseUrl}/api/me/w9/pdf`)).status).toBe(401);
  });
});

describe("audit + secrecy", () => {
  it("every full-SSN document access is audited with its scope", () => {
    const downloads = w9AuditRows().filter(r => r.action === "pay.w9.pdf.downloaded");
    expect(downloads.length).toBeGreaterThanOrEqual(3);
    const scopes = downloads.map(r => JSON.parse(r.details ?? "{}").scope);
    expect(scopes).toContain("self");
    expect(scopes).toContain("admin");
  });

  it("no audit row anywhere contains the full TIN", () => {
    const all = rawDb.prepare(`SELECT details FROM activity_log`).all() as Array<{ details: string | null }>;
    for (const row of all) expect(row.details ?? "").not.toContain(SSN);
  });

  it("no W-9 response body contains the full TIN — masked only", async () => {
    for (const [path, session] of [["/api/me/w9", repSession], [`/api/team-members/${repTmId}/w9`, managerSession]] as const) {
      const text = await (await request(path, session)).text();
      expect(text).not.toContain(SSN);
      expect(text).toContain("***-**-6789");
    }
  });

  it("the TIN is only ever at rest as ciphertext", () => {
    const rows = rawDb.prepare(`SELECT tin_enc FROM w9_forms`).all() as Array<{ tin_enc: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.tin_enc).not.toContain(SSN);
  });
});
