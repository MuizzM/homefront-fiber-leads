import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { ONBOARDING_DOCUMENT_TYPES } from "../../shared/onboardingDocuments";
import { loginAs, mintSession } from "./helpers/auth";
import { withSigningTriggersSuspended } from "../helpers/signingTables";

const DB_PATH = process.env.E2E_DB_PATH ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data.db");
const MARKETING_URL = process.env.E2E_MARKETING_URL ?? `http://127.0.0.1:${process.env.E2E_MARKETING_PORT ?? 5187}`;
const ADMIN_EMAIL = "onboarding-e2e-admin@homefront.local";
const CANDIDATE_EMAIL = "careers-e2e-candidate@approval-flow.example.com";
const CANDIDATE_NAME = "Careers E2E Candidate";

let adminSession = "";
let applicationId = 0;
let candidateUserId = 0;
let candidateRepId = 0;

function withDb<T>(callback: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  try { return callback(db); } finally { db.close(); }
}

function clearFixture(db: Database.Database) {
  const user = db.prepare("SELECT id, team_member_id teamMemberId FROM users WHERE email = ?").get(CANDIDATE_EMAIL) as { id: number; teamMemberId: number | null } | undefined;
  if (user?.teamMemberId) {
    // The signature chain is append-only and a completed agreement is immutable
    // at the DATABASE level (triggers), so the fixture reset suspends those
    // triggers around its deletes and restores them verbatim afterwards.
    withSigningTriggersSuspended(db, () => {
      const ids = db.prepare("SELECT id FROM onboarding_signing_documents WHERE rep_id = ?").all(user.teamMemberId) as Array<{ id: number }>;
      for (const row of ids) db.prepare("DELETE FROM onboarding_signature_events WHERE document_id = ?").run(row.id);
      db.prepare("DELETE FROM onboarding_signing_documents WHERE rep_id = ?").run(user.teamMemberId);
    });
  }
  db.prepare("DELETE FROM onboarding_recruiting_invites WHERE candidate_email = ?").run(CANDIDATE_EMAIL);
  db.prepare("DELETE FROM rep_applications WHERE email = ?").run(CANDIDATE_EMAIL);
  db.prepare("DELETE FROM otp_codes WHERE email = ?").run(CANDIDATE_EMAIL);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user?.id ?? -1);
  db.prepare("DELETE FROM users WHERE email = ?").run(CANDIDATE_EMAIL);
  if (user?.teamMemberId) db.prepare("DELETE FROM team_members WHERE id = ?").run(user.teamMemberId);
}

function clearAdminFixture(db: Database.Database) {
  const admin = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL) as { id: number } | undefined;
  if (admin) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(admin.id);
  db.prepare("DELETE FROM otp_codes WHERE email = ?").run(ADMIN_EMAIL);
  db.prepare("DELETE FROM users WHERE email = ?").run(ADMIN_EMAIL);
}

test.beforeAll(async ({ request }) => {
  withDb(db => {
    clearFixture(db);
    db.prepare(`INSERT INTO users (name, email, role, active, tenant_id, created_at)
      VALUES (?, ?, 'admin', 1, 1, ?)
      ON CONFLICT(email) DO UPDATE SET role = 'admin', active = 1, tenant_id = 1`).run(
      "Onboarding E2E Admin", ADMIN_EMAIL, new Date().toISOString(),
    );
  });
  ({ sessionId: adminSession } = await mintSession(request, ADMIN_EMAIL));
});

test.afterAll(() => withDb(db => { clearFixture(db); clearAdminFixture(db); }));

test("careers application reaches review, approval provisions access, signing activates the rep", async ({ page, request, browser }) => {
  await page.goto(`${MARKETING_URL}/careers/fiber-sales-rep-greensboro/apply`);
  await page.getByLabel("Full name").fill(CANDIDATE_NAME);
  await page.getByLabel("Phone number").fill("3365550198");
  await page.getByLabel("Email address").fill(CANDIDATE_EMAIL);
  await page.getByLabel("City and state").fill("Greensboro, NC");
  await page.getByLabel("ZIP code").fill("27401");
  await page.getByLabel("Are you 18 or older?").selectOption("yes");
  await page.getByLabel("Reliable transportation?").selectOption("yes");
  await page.getByLabel("Sales experience").selectOption("none");
  await page.getByLabel("Why are you interested in this role?").fill("I enjoy field sales, serving homeowners, and building a long-term career with a growing team.");
  await page.getByLabel("How did you hear about us?").selectOption("search");
  await page.getByLabel(/I agree to receive SMS/).check();
  await page.getByRole("button", { name: /Submit Application/ }).click();
  await expect(page.getByText("Application received")).toBeVisible();

  await expect.poll(() => withDb(db => {
    const row = db.prepare("SELECT id FROM rep_applications WHERE email = ?").get(CANDIDATE_EMAIL) as { id: number } | undefined;
    return row?.id ?? 0;
  })).toBeGreaterThan(0);
  applicationId = withDb(db => (db.prepare("SELECT id FROM rep_applications WHERE email = ?").get(CANDIDATE_EMAIL) as { id: number }).id);

  await loginAs(page, adminSession);
  await page.goto("/#/applications");
  const queueItem = page.getByTestId(`pipeline-record-application-${applicationId}`);
  await expect(queueItem).toContainText(CANDIDATE_EMAIL);
  await expect(queueItem).toContainText("Website careers");
  await queueItem.click();
  await page.getByTestId("approve-start-onboarding").click();
  await expect(queueItem).toContainText(/Awaiting signatures|Login sent/);

  await expect.poll(() => withDb(db => {
    const row = db.prepare("SELECT id, team_member_id teamMemberId FROM users WHERE email = ?").get(CANDIDATE_EMAIL) as { id: number; teamMemberId: number | null } | undefined;
    candidateUserId = row?.id ?? 0;
    candidateRepId = row?.teamMemberId ?? 0;
    return candidateUserId > 0 && candidateRepId > 0;
  })).toBe(true);
  expect(withDb(db => db.prepare("SELECT COUNT(*) count FROM onboarding_signing_documents WHERE rep_id = ?").get(candidateRepId))).toMatchObject({ count: 4 });

  const candidateContext = await browser.newContext();
  const candidatePage = await candidateContext.newPage();
  await candidatePage.goto("/#/login");
  await candidatePage.getByTestId("input-email").fill(CANDIDATE_EMAIL);
  await candidatePage.getByTestId("button-send-code").click();
  await expect(candidatePage.getByTestId("button-verify-code")).toBeEnabled();
  await candidatePage.getByTestId("button-verify-code").click();
  await candidatePage.goto("/#/my-documents");
  await expect(candidatePage.getByText("0 of 4 signed")).toBeVisible();

  for (let index = 0; index < ONBOARDING_DOCUMENT_TYPES.length; index += 1) {
    const type = ONBOARDING_DOCUMENT_TYPES[index];
    await candidatePage.getByTestId(`sign-document-${type}`).click();
    const scroll = candidatePage.getByTestId("signing-document-scroll");
    await expect(scroll).toBeVisible();
    await scroll.evaluate(node => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await candidatePage.getByTestId("esign-consent").check();
    await candidatePage.getByTestId("esign-read").check();
    await candidatePage.getByTestId("esign-intent").check();
    await candidatePage.getByTestId("typed-signature").fill(CANDIDATE_NAME);
    await candidatePage.getByTestId("complete-signature").click();
    await expect(candidatePage.getByTestId(`onboarding-document-${type}`)).toContainText("Signed");
    await expect(candidatePage.getByText(`${index + 1} of 4 signed`)).toBeVisible();
  }

  await expect.poll(() => withDb(db => (db.prepare("SELECT active FROM team_members WHERE id = ?").get(candidateRepId) as { active: number }).active)).toBe(1);
  const pipeline = await request.get("/api/onboarding/pipeline", { headers: { "x-session-id": adminSession } });
  expect(pipeline.ok()).toBeTruthy();
  const record = (await pipeline.json()).records.find((item: any) => item.applicationId === applicationId);
  expect(record).toMatchObject({ stage: "active", milestones: { signedCount: 4, fullySigned: true, active: true } });
  await candidateContext.close();
});
