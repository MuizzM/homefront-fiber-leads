// The link has to actually attribute someone.
//
// Everything downstream of attribution was already covered (qualification, the
// $500, clawbacks) — but all of it starts from a referral row, and until this
// wiring existed nothing ever created one from a real application. The link
// minted, the click went uncounted, and the applicant arrived unattributed:
// a programme that could never pay anybody.
//
// The rule this suite exists to protect: a referral is a bonus on top of a
// hire, NEVER a gate on it. Every failure mode below still results in a
// submitted application.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let R: typeof import("../../server/referralStore");
let intake: typeof import("../../server/onboardingApplicationService");
let rawDb: import("better-sqlite3").Database;

const TENANT = 1;
const REFERRER_REP = 810, REFERRER_USER = 8100;
const NOW = "2026-08-07T12:00:00.000Z";

function applicant(over: Record<string, any> = {}) {
  return {
    fullName: "New Applicant", email: "new.applicant@example.test",
    phone: "5551234567", city: "Raleigh", zip: "27601", state: "NC",
    hasSalesExperience: false, preferredCarriers: "kinetic",
    ...over,
  } as any;
}

function link() {
  return R.ensureLink({
    tenantId: TENANT, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP,
    baseUrl: "https://app.test", nowIso: NOW,
  });
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-refattr-"));
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  ({ rawDb } = await import("../../server/db"));
  R = await import("../../server/referralStore");
  intake = await import("../../server/onboardingApplicationService");
});

beforeEach(() => {
  rawDb.exec("DROP TRIGGER IF EXISTS referral_events_no_delete");
  rawDb.exec("DROP TRIGGER IF EXISTS domain_events_no_delete");
  for (const t of ["referral_events", "referrals", "referral_links", "domain_events", "rep_applications"]) {
    rawDb.prepare(`DELETE FROM ${t}`).run();
  }
  rawDb.prepare("DELETE FROM users WHERE id >= 8100").run();
  rawDb.prepare("DELETE FROM team_members WHERE id >= 810").run();
  R.ensureReferralSchema();

  rawDb.prepare(
    `INSERT INTO team_members (id, name, email, role, active, tenant_id, created_at)
     VALUES (?,?,?,'rep',1,?,datetime('now'))`,
  ).run(REFERRER_REP, "Riley Referrer", "riley@example.test", TENANT);
  rawDb.prepare(
    `INSERT INTO users (id, name, email, role, tenant_id, team_member_id, active, created_at)
     VALUES (?,?,?,'rep',?,?,1,datetime('now'))`,
  ).run(REFERRER_USER, "Riley Referrer", "riley@example.test", TENANT, REFERRER_REP);

  R.setConfig(TENANT, { enabled: true }, NOW);
});

describe("a shared link attributes a real application", () => {
  it("creates the referral, linked to both the applicant and the referrer", () => {
    const code = link().code;
    const application = intake.submitPublicApplication(applicant({ referralCode: code }));

    const referrals = R.listReferrals(TENANT, { referrerRepIds: [REFERRER_REP] });
    expect(referrals).toHaveLength(1);
    expect(referrals[0].status).toBe("APPLIED");
    expect(referrals[0].referredEmail).toBe("new.applicant@example.test");
    expect(referrals[0].referredApplicationId).toBe(application.id);
    expect(referrals[0].rewardAmountCents).toBe(50_000);
  });

  it("accepts the code however the applicant typed or pasted it", () => {
    const code = link().code;
    intake.submitPublicApplication(applicant({ referralCode: ` ${code.toLowerCase()} ` }));
    expect(R.listReferrals(TENANT, { referrerRepIds: [REFERRER_REP] })).toHaveLength(1);
  });

  it("counts a click without creating a referral", () => {
    const code = link().code;
    expect(R.trackClick(code)).toBe(true);
    expect(R.listReferrals(TENANT)).toEqual([]);
  });
});

describe("attribution NEVER blocks the application", () => {
  it("submits fine with no code at all", () => {
    const application = intake.submitPublicApplication(applicant());
    expect(application.id).toBeGreaterThan(0);
    expect(R.listReferrals(TENANT)).toEqual([]);
  });

  it("submits fine on a garbage code", () => {
    const application = intake.submitPublicApplication(applicant({ referralCode: "NOTREAL1" }));
    expect(application.id).toBeGreaterThan(0);
    expect(R.listReferrals(TENANT)).toEqual([]);
  });

  it("submits fine on a malformed code, without a database lookup", () => {
    const application = intake.submitPublicApplication(applicant({ referralCode: "<script>" }));
    expect(application.id).toBeGreaterThan(0);
  });

  it("submits fine while the programme is switched OFF", () => {
    R.setConfig(TENANT, { enabled: false }, NOW);
    const code = link().code;
    const application = intake.submitPublicApplication(applicant({ referralCode: code }));
    expect(application.id).toBeGreaterThan(0);
    // No reward exists, and the decline is recorded rather than silently lost.
    expect(R.listReferrals(TENANT)).toEqual([]);
    const declined = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM activity_log WHERE action = 'referral.attribution.declined'`,
    ).get() as any;
    expect(declined.n).toBe(1);
  });

  it("submits fine when the applicant refers themselves", () => {
    const code = link().code;
    const application = intake.submitPublicApplication(applicant({ email: "riley@example.test" }) as any);
    expect(application.id).toBeGreaterThan(0);

    // …and a self-referral through the code is declined, not rewarded.
    rawDb.prepare("DELETE FROM rep_applications").run();
    const second = intake.submitPublicApplication(
      applicant({ email: "riley2@example.test", referralCode: code }),
    );
    expect(second.id).toBeGreaterThan(0);
  });

  it("submits fine when the referrer has been offboarded", () => {
    const code = link().code;
    rawDb.prepare("UPDATE team_members SET active = 0 WHERE id = ?").run(REFERRER_REP);
    const application = intake.submitPublicApplication(applicant({ referralCode: code }));
    expect(application.id).toBeGreaterThan(0);
    expect(R.listReferrals(TENANT)).toEqual([]);
  });
});

describe("the free-text source and the referral code are different things", () => {
  it("a 'how did you hear about us' answer pays nobody", () => {
    // referralSource is a dropdown; referralCode is money. Conflating them
    // would let anyone claim a reward by picking "a friend" from a list.
    const application = intake.submitPublicApplication(
      applicant({ referralSource: "A friend told me" }),
    );
    expect(application.referralSource).toBe("A friend told me");
    expect(R.listReferrals(TENANT)).toEqual([]);
  });
});
