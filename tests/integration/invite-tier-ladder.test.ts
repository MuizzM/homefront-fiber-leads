// ── The ladder a manager invites on is the ladder the rep signs and is paid ──
//
// THE BUG: the recruiting invite carried `commissionStructure: "TIERED"` and
// nothing else. Its own comment promised these terms "seed the rep's plan +
// reserve at approval", which could not be true for TIERED — there were no
// tiers to seed from. Every reader downstream filled the hole silently and
// confidently:
//
//   · normalizeCommissionTerms swaps DEFAULT_RETRO_TIERS in for an empty
//     ladder and returns ok, so the contract printed the HOUSE bands;
//   · assignStructureToRep falls through to getOrCreateStandardTieredVersion
//     when handed no tiers, so the rep was PAID the house bands.
//
// Nothing threw, and both halves printed a plausible number. So these tests
// assert on the ladder's actual rates end to end — a test that only checked
// "a tiered plan was assigned" would have passed against the bug.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSigningTables } from "../helpers/signingTables";
import type { CommissionTier } from "@shared/commissionTiers";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let recruitingStore: typeof import("../../server/onboardingRecruitingStore");
let intake: typeof import("../../server/onboardingApplicationService");
let commissionSvc: typeof import("../../server/commissionService");
let resolver: typeof import("../../server/commissionTermsResolver");
let adminSession: string;
const realFetch = globalThis.fetch.bind(globalThis);

// Deliberately NOT the house ladder (1–7 @$150, 8–12 @$200, 13–16 @$250, 17+
// @$300). Every rate differs, so a substituted default cannot pass as this one.
const INVITED_LADDER: CommissionTier[] = [
  { position: 0, minimumSales: 1, maximumSales: 6, rateCents: 17_500, label: "1–6 sales" },
  { position: 1, minimumSales: 7, maximumSales: null, rateCents: 26_000, label: "7+ sales" },
];

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-invite-ladder-"));
  process.env.NODE_ENV = "test";
  process.env.APP_ORIGIN = "https://portal.example.com";
  process.env.CAREERS_TENANT_SLUG = "home-front-solutions";
  process.env.ONBOARDING_INVITE_SECRET = "test-onboarding-invite-secret-with-more-than-32-characters";
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_FROM = "Home Front Test <test@example.com>";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  recruitingStore = await import("../../server/onboardingRecruitingStore");
  intake = await import("../../server/onboardingApplicationService");
  commissionSvc = await import("../../server/commissionService");
  resolver = await import("../../server/commissionTermsResolver");
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (2, 'other-ladder-tenant', 'Other Tenant', 'Other Owner', 'other@example.com', 'Other Tenant')`,
  ).run();
  const admin = storage.createUser({ name: "Ladder Admin", email: "ladder-admin@example.com", role: "admin", active: true, tenantId: 1 } as any);
  adminSession = storage.createSession(admin.id).id;

  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  resetSigningTables(rawDb);
  rawDb.prepare("DELETE FROM onboarding_recruiting_invites").run();
  rawDb.prepare("DELETE FROM rep_applications").run();
  rawDb.prepare("DELETE FROM users WHERE email LIKE '%@ladder.example.com'").run();
  rawDb.prepare("DELETE FROM team_members WHERE email LIKE '%@ladder.example.com'").run();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, status: 200, statusText: "OK",
    json: async () => ({ id: `resend-${crypto.randomUUID()}` }),
  }));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

/** Invite → apply on the invite token → the application is attached to it. */
function invitedApplication(email: string, tiers: CommissionTier[] | null) {
  const invite = recruitingStore.createRecruitingInvite({
    tenantId: 1, candidateName: "Ladder Candidate", candidateEmail: email, invitedBy: null,
    commissionStructure: tiers ? "TIERED" : null,
    tiers,
    reservePercent: 10, reserveCapCents: 250_000,
  });
  recruitingStore.markRecruitingInviteSent(invite.id, "resend-invite");
  const token = recruitingStore.secureTokenForInvite(invite.id);
  const application = intake.submitPublicApplication({
    fullName: "Ladder Candidate", email, phone: "3365550188",
    city: "Greensboro", state: "NC", zip: "27401",
    hasSalesExperience: true, preferredCarriers: "Kinetic Fiber",
    inviteToken: token, actorIp: "127.0.0.1",
  });
  return { invite, application };
}

describe("the tier ladder on a recruiting invite", () => {
  it("round-trips through storage — the ladder that comes back is the one that went in", () => {
    const created = recruitingStore.createRecruitingInvite({
      tenantId: 1, candidateName: "Round Trip", candidateEmail: "roundtrip@ladder.example.com",
      invitedBy: null, commissionStructure: "TIERED", tiers: INVITED_LADDER,
    });
    expect(created.commissionTiers).toEqual(INVITED_LADDER);

    // And on a fresh read, not just the object the writer happened to return —
    // the column has to actually exist at runtime (Drizzle-only would not).
    const reread = recruitingStore.getRecruitingInvite(created.id)!;
    expect(reread.commissionTiers?.map(t => t.rateCents)).toEqual([17_500, 26_000]);
    expect(reread.commissionTiers?.map(t => t.maximumSales)).toEqual([6, null]);
    expect(recruitingStore.listRecruitingInvites(1).find(i => i.id === created.id)?.commissionTiers)
      .toEqual(INVITED_LADDER);
  });

  it("REFUSES a TIERED invite with no ladder rather than storing a promise it cannot keep", () => {
    expect(() => recruitingStore.createRecruitingInvite({
      tenantId: 1, candidateName: "No Ladder", candidateEmail: "noladder@ladder.example.com",
      invitedBy: null, commissionStructure: "TIERED",
    })).toThrow(/tier ladder/i);
    // Nothing was written — a rejected invite must not leave a half-configured row.
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM onboarding_recruiting_invites WHERE candidate_email = ?")
      .get("noladder@ladder.example.com")).toEqual({ n: 0 });
  });

  it("REFUSES a ladder the commission engine would not pay against", () => {
    // A gap: 1–6 then 9+. validateTiers owns this verdict; the invite reuses it
    // rather than storing the gap and throwing at issuance, in front of the
    // candidate.
    expect(() => recruitingStore.createRecruitingInvite({
      tenantId: 1, candidateName: "Gapped", candidateEmail: "gapped@ladder.example.com",
      invitedBy: null, commissionStructure: "TIERED",
      tiers: [
        { position: 0, minimumSales: 1, maximumSales: 6, rateCents: 17_500, label: "" },
        { position: 1, minimumSales: 9, maximumSales: null, rateCents: 26_000, label: "" },
      ],
    })).toThrow(/continuous/i);
  });

  it("stores no ladder on a FLAT invite, so a stale one cannot be picked up later", () => {
    const flat = recruitingStore.createRecruitingInvite({
      tenantId: 1, candidateName: "Flat Rate", candidateEmail: "flat@ladder.example.com",
      invitedBy: null, commissionStructure: "FLAT", flatRateCents: 22_500, tiers: INVITED_LADDER,
    });
    expect(flat.commissionTiers).toBeNull();
    expect(flat.flatRateCents).toBe(22_500);
  });

  it("reads a row written before this column existed as 'no ladder proposed'", () => {
    const legacy = recruitingStore.createRecruitingInvite({
      tenantId: 1, candidateName: "Legacy", candidateEmail: "legacy@ladder.example.com", invitedBy: null,
    });
    // Exactly what a pre-feature TIERED invite looks like on disk.
    rawDb.prepare("UPDATE onboarding_recruiting_invites SET commission_structure = 'TIERED' WHERE id = ?").run(legacy.id);
    expect(recruitingStore.getRecruitingInvite(legacy.id)!.commissionTiers).toBeNull();
    // And an unreadable blob must not take the whole invitations list down with
    // it — mapInvite runs over every row a manager loads.
    rawDb.prepare("UPDATE onboarding_recruiting_invites SET commission_tiers_json = '{not json' WHERE id = ?").run(legacy.id);
    expect(() => recruitingStore.listRecruitingInvites(1)).not.toThrow();
    expect(recruitingStore.getRecruitingInvite(legacy.id)!.commissionTiers).toBeNull();
  });
});

describe("POST /api/onboarding/invitations", () => {
  async function invite(body: Record<string, unknown>) {
    const response = await realFetch(`${baseUrl}/api/onboarding/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": adminSession },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  }

  it("accepts a ladder and persists it against the invite", async () => {
    const { status, body } = await invite({
      name: "Api Candidate", email: "api@ladder.example.com",
      commissionStructure: "TIERED", tiers: INVITED_LADDER,
      reservePercent: 10, reserveCapCents: 250_000,
    });
    expect(status).toBe(201);
    expect(body.invitation.commissionTiers).toEqual(INVITED_LADDER);
  });

  it("400s a TIERED invitation with no ladder, and says so instead of blaming the email", async () => {
    const { status, body } = await invite({
      name: "Empty Ladder", email: "empty@ladder.example.com", commissionStructure: "TIERED",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/tier ladder/i);
    expect(body.error).not.toMatch(/email address/i);
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM onboarding_recruiting_invites").get()).toEqual({ n: 0 });
  });

  it("points at the terms, not the email, when a number is out of range", async () => {
    // The reserve ceiling used to be a three-option select and is now a free
    // money field, so this is a mistake a manager can actually make.
    const { status, body } = await invite({
      name: "Huge Cap", email: "hugecap@ladder.example.com",
      commissionStructure: "TIERED", tiers: INVITED_LADDER,
      reserveCapCents: 999_999_999,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/commission terms/i);
    expect(body.error).not.toMatch(/email address/i);
  });

  it("400s a ladder with a gap in it", async () => {
    const { status, body } = await invite({
      name: "Gap Api", email: "gapapi@ladder.example.com", commissionStructure: "TIERED",
      tiers: [
        { position: 0, minimumSales: 1, maximumSales: 6, rateCents: 17_500, label: "" },
        { position: 1, minimumSales: 9, maximumSales: null, rateCents: 26_000, label: "" },
      ],
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/continuous/i);
  });
});

describe("the invited ladder reaches the contract and the pay engine", () => {
  async function approve(applicationId: number) {
    const response = await realFetch(`${baseUrl}/api/onboarding/applications/${applicationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-session-id": adminSession },
      body: JSON.stringify({ status: "approved" }),
    });
    return { status: response.status, body: await response.json() as any };
  }

  it("THE REQUIREMENT: approval assigns the INVITED bands, not the house ones", async () => {
    const email = "assigned@ladder.example.com";
    const { application } = invitedApplication(email, INVITED_LADDER);
    const { status, body } = await approve(application.id);
    expect(status).toBe(200);
    expect(body.commissionWarning ?? null).toBeNull();

    const rep = storage.getTeamMemberByEmail?.(email) ?? rawDb.prepare("SELECT * FROM team_members WHERE email = ?").get(email) as any;
    expect(rep).toBeTruthy();
    const assignments = commissionSvc.listRepAssignments(1, Number(rep.id));
    expect(assignments.length).toBeGreaterThan(0);
    const versionId = Number(assignments[0].commission_plan_version_id);
    const paid = commissionSvc.getPlanVersionTiers(1, versionId);
    // The rates the rep will actually be PAID on. The house ladder would read
    // 15000/20000/25000/30000 here — that was the bug.
    expect(paid.map((t: any) => Number(t.rate_cents))).toEqual([17_500, 26_000]);
    expect(paid.map((t: any) => Number(t.minimum_sales))).toEqual([1, 7]);
    expect(paid[paid.length - 1].maximum_sales).toBeNull();
  });

  it("THE REQUIREMENT: the commission agreement states the invited ladder", async () => {
    const email = "contract@ladder.example.com";
    const { application } = invitedApplication(email, INVITED_LADDER);
    await approve(application.id);

    const rep = rawDb.prepare("SELECT * FROM team_members WHERE email = ?").get(email) as any;
    const envelope = rawDb.prepare(
      `SELECT document_snapshot_json FROM onboarding_signing_documents
        WHERE rep_id = ? AND document_type = 'commission_agreement' ORDER BY id DESC LIMIT 1`,
    ).get(Number(rep.id)) as { document_snapshot_json: string } | undefined;
    expect(envelope).toBeTruthy();
    const snapshot = JSON.parse(envelope!.document_snapshot_json);

    // The structured terms frozen with the document.
    expect(snapshot.compTerms.tiers.map((t: any) => t.rateCents)).toEqual([17_500, 26_000]);
    // The prose the rep reads.
    const prose = snapshot.sections.flatMap((s: any) => s.paragraphs).join("\n");
    expect(prose).toContain("$175");
    expect(prose).toContain("$260");
    expect(prose).not.toContain("$150");
    // And the table.
    const rows = snapshot.sections.flatMap((s: any) => s.rows ?? []);
    expect(rows).toEqual([
      { band: "1–6 qualified sales", rate: "$175 per sale" },
      { band: "7+ qualified sales", rate: "$260 per sale" },
    ]);
  });

  it("resolveCommissionTerms hands the invited ladder to whatever builds the paperwork", async () => {
    const email = "resolve@ladder.example.com";
    const { application } = invitedApplication(email, INVITED_LADDER);
    await approve(application.id);
    const rep = rawDb.prepare("SELECT * FROM team_members WHERE email = ?").get(email) as any;
    const terms = resolver.resolveCommissionTerms(1, Number(rep.id), null);
    expect(terms.structure).toBe("TIERED");
    expect(terms.tiers.map(t => t.rateCents)).toEqual([17_500, 26_000]);
  });

  it("does not take another tenant's ladder from a colliding email address", () => {
    // The invite → rep hop matches on EMAIL. Two orgs can recruit the same
    // person, and now that an invite carries a whole ladder, an unscoped match
    // would render another company's pay terms into this company's contract.
    const email = "collision@ladder.example.com";
    const foreignLadder: CommissionTier[] = [
      { position: 0, minimumSales: 1, maximumSales: null, rateCents: 99_900, label: "foreign" },
    ];
    const foreign = recruitingStore.createRecruitingInvite({
      tenantId: 2, candidateName: "Collision", candidateEmail: email, invitedBy: null,
      commissionStructure: "TIERED", tiers: foreignLadder,
    });
    recruitingStore.markRecruitingInviteSent(foreign.id, "resend-foreign");
    const foreignApp = storage.createRepApplication({
      tenantId: 2, inviteId: foreign.id, fullName: "Collision", email,
      phone: "3365550199", city: "Greensboro", zip: "27401", state: "NC",
      hasSalesExperience: true, preferredCarriers: "Kinetic Fiber", applicationSource: "invited",
    } as any);
    recruitingStore.attachApplicationToInvite(foreign.id, foreignApp.id);

    // A rep with the same email in a DIFFERENT tenant.
    const rep = storage.createTeamMember({ name: "Collision", email, role: "rep", active: true, tenantId: 1 } as any);
    const terms = resolver.resolveCommissionTerms(1, rep.id, null);
    expect(terms.tiers.map(t => t.rateCents)).not.toContain(99_900);
    expect(terms.tiers.map(t => t.rateCents)).toEqual([15_000, 20_000, 25_000, 30_000]);
  });

  it("an invite that proposed nothing still inherits, rather than failing", async () => {
    const email = "inherit@ladder.example.com";
    const { application } = invitedApplication(email, null);
    const { status, body } = await approve(application.id);
    expect(status).toBe(200);
    expect(body.commissionWarning ?? null).toBeNull();
    const rep = rawDb.prepare("SELECT * FROM team_members WHERE email = ?").get(email) as any;
    const terms = resolver.resolveCommissionTerms(1, Number(rep.id), null);
    // The house ladder — correct here, because nobody chose anything else.
    expect(terms.tiers.map(t => t.rateCents)).toEqual([15_000, 20_000, 25_000, 30_000]);
  });
});
