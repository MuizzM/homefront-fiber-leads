import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl = "";
let applicationId = 0;
let adminSession = "";
let managerSession = "";
let otherAdminSession = "";

async function getFile(kind: "headshot" | "license", session: string) {
  return fetch(`${baseUrl}/api/onboarding/applications/${applicationId}/files/${kind}`, {
    headers: { "x-session-id": session },
  });
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hf-applicant-file-review-"));
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = "test";
  process.env.APP_ORIGIN = "https://portal.example.com";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  const { storage } = storageModule;
  const { rawDb } = await import("../../server/db");
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare("INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'other-applicant-files', 'Other Tenant', 'Other Owner', 'other-files@example.com', 'Other Tenant')").run();
  const admin = storage.createUser({ name: "File Admin", email: "file-admin@example.com", role: "admin", active: true, tenantId: 1 } as any);
  const manager = storage.createUser({ name: "File Manager", email: "file-manager@example.com", role: "manager", active: true, tenantId: 1 } as any);
  const other = storage.createUser({ name: "Other File Admin", email: "other-file-admin@example.com", role: "admin", active: true, tenantId: 2 } as any);
  adminSession = storage.createSession(admin.id).id;
  managerSession = storage.createSession(manager.id).id;
  otherAdminSession = storage.createSession(other.id).id;

  mkdirSync(join(dataDir, "uploads", "headshots"), { recursive: true });
  mkdirSync(join(dataDir, "uploads", "licenses"), { recursive: true });
  writeFileSync(join(dataDir, "uploads", "headshots", "review.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  writeFileSync(join(dataDir, "uploads", "licenses", "legacy.pdf"), Buffer.from("%PDF-1.4\n% legacy applicant review fixture\n"));

  const application = storage.createRepApplication({
    fullName: "Applicant File Review",
    email: "applicant-file-review@example.com",
    phone: "3364209379",
    city: "High Point",
    state: "NC",
    zip: "27263",
    hasSalesExperience: false,
    preferredCarriers: "Kinetic",
    status: "pending",
    tenantId: 1,
    headshotPath: "/uploads/headshots/review.png",
    licensePath: "/uploads/licenses/legacy.pdf",
  } as any);
  applicationId = application.id;

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe("applicant identity file review", () => {
  it("streams an applicant image only to the tenant administrator", async () => {
    const response = await getFile("headshot", adminSession);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(8);
  });

  it("keeps legacy applicant PDFs reviewable while new intake is image-only", async () => {
    const response = await getFile("license", adminSession);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
    expect(Buffer.from(await response.arrayBuffer()).toString("ascii", 0, 5)).toBe("%PDF-");
  });

  it("refuses managers and hides another tenant's application", async () => {
    expect((await getFile("headshot", managerSession)).status).toBe(403);
    expect((await getFile("headshot", otherAdminSession)).status).toBe(404);
  });
});
