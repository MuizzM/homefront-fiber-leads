// The whole path, in one test, in order:
//
//   referral link → deduped visit → application → attributed referral
//   → applicant self-status → qualification → approval retry
//   → exactly ONE earnings-ledger record
//
// This exists because every stage of it is already covered in isolation, and
// isolated coverage is what lets a system pass every test while the JOIN
// between two stages is broken — which is precisely the failure that shipped
// once here already (the link minted, and nothing read `?ref=`).
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let R: typeof import("../../server/referralStore");
let intake: typeof import("../../server/onboardingApplicationService");
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

const TENANT = 1;
const REFERRER_REP = 710, REFERRER_USER = 7100;
const REFERRED_REP = 711, REFERRED_USER = 7101;
const ADMIN_USER = 7999;
const NOW = "2026-08-07T12:00:00.000Z";
const SOLD_AT = "2026-08-07T13:00:00.000Z";
const AFTER_HOLD = "2026-09-20T12:00:00.000Z";

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-ref-e2e-"));
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  R = await import("../../server/referralStore");
  intake = await import("../../server/onboardingApplicationService");
});

beforeEach(() => {
  rawDb.exec("DROP TRIGGER IF EXISTS referral_events_no_delete");
  rawDb.exec("DROP TRIGGER IF EXISTS domain_events_no_delete");
  rawDb.exec("DROP TRIGGER IF EXISTS earnings_ledger_no_paid_delete");
  for (const t of ["referral_events", "referrals", "referral_links", "referral_click_dedupe",
    "domain_events", "commission_sales", "training_progress", "earnings_ledger", "rep_applications"]) {
    rawDb.prepare(`DELETE FROM ${t}`).run();
  }
  rawDb.prepare("DELETE FROM users WHERE id >= 7100").run();
  rawDb.prepare("DELETE FROM team_members WHERE id >= 710").run();
  R.ensureReferralSchema();

  rawDb.prepare(
    `INSERT INTO team_members (id, name, email, role, active, tenant_id, created_at)
     VALUES (?,?,?,'rep',1,?,datetime('now'))`,
  ).run(REFERRER_REP, "Riley Referrer", "riley.e2e@example.test", TENANT);
  rawDb.prepare(
    `INSERT INTO users (id, name, email, role, tenant_id, team_member_id, active, created_at)
     VALUES (?,?,?,'rep',?,?,1,datetime('now'))`,
  ).run(REFERRER_USER, "Riley Referrer", "riley.e2e@example.test", TENANT, REFERRER_REP);

  R.setConfig(TENANT, { enabled: true }, NOW);
  rawDb.prepare(
    `INSERT INTO app_settings (tenant_id, key, value, updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
  ).run(TENANT, "training.required_lessons", "1");
});

describe("referral link → one $500 earning", () => {
  it("walks the whole path, and every retry along it is a no-op", () => {
    // ── 1. The rep gets their link. Asking twice yields one code. ──────────
    const link = R.ensureLink({
      tenantId: TENANT, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP,
      baseUrl: "https://app.test", nowIso: NOW,
    });
    expect(R.ensureLink({
      tenantId: TENANT, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP,
      baseUrl: "https://app.test", nowIso: NOW,
    }).code).toBe(link.code);

    // ── 2. A visitor loads it three times (landing, refresh, back button). ──
    const visitor = R.clickDedupeKey({ ip: "203.0.113.42", userAgent: "Mozilla/5.0", dayIso: "2026-08-07" });
    R.trackClick(link.code, visitor, NOW);
    R.trackClick(link.code, visitor, NOW);
    R.trackClick(link.code, visitor, NOW);
    const clicks = rawDb.prepare(`SELECT click_count AS c FROM referral_links WHERE code = ?`).get(link.code) as any;
    expect(clicks.c).toBe(1);

    // ── 3. They apply through the form, carrying the code. ─────────────────
    const application = intake.submitPublicApplication({
      fullName: "Remy Referred", email: "remy.e2e@example.test",
      phone: "5551234567", city: "Raleigh", zip: "27601", state: "NC",
      hasSalesExperience: false, preferredCarriers: "kinetic",
      referralCode: link.code,
    } as any);
    expect(application.id).toBeGreaterThan(0);

    // ── 4. …which produced exactly one attributed referral. ────────────────
    const referrals = R.listReferrals(TENANT, { referrerRepIds: [REFERRER_REP] });
    expect(referrals).toHaveLength(1);
    const referralId = referrals[0].id;
    expect(referrals[0].status).toBe("APPLIED");
    expect(referrals[0].referredApplicationId).toBe(application.id);

    // ── 5. Hired and activated; the account now exists. ────────────────────
    rawDb.prepare(
      `INSERT INTO team_members (id, name, email, role, active, tenant_id, created_at)
       VALUES (?,?,?,'rep',1,?,datetime('now'))`,
    ).run(REFERRED_REP, "Remy Referred", "remy.e2e@example.test", TENANT);
    rawDb.prepare(
      `INSERT INTO users (id, name, email, role, tenant_id, team_member_id, active, created_at)
       VALUES (?,?,?,'rep',?,?,1,datetime('now'))`,
    ).run(REFERRED_USER, "Remy Referred", "remy.e2e@example.test", TENANT, REFERRED_REP);
    R.markHired({ tenantId: TENANT, referralId, referredRepId: REFERRED_REP, referredUserId: REFERRED_USER, nowIso: NOW });
    R.markActivated({ tenantId: TENANT, referralId, nowIso: NOW });

    // ── 6. The referred person's OWN status, mid-funnel. ───────────────────
    let mine = R.applicantStatusFor(TENANT, REFERRED_REP, NOW);
    expect(mine.attributed).toBe(true);
    expect(mine.rewardState).toBe("in_progress");
    expect(mine.milestones).toMatchObject({ hired: true, activated: true });
    // No amount reaches them at any point in the funnel.
    expect(JSON.stringify(mine)).not.toMatch(/50000|\$500/);

    // ── 7. Training, then six approved sales. ──────────────────────────────
    rawDb.prepare(
      `INSERT OR IGNORE INTO training_progress (tenant_id, user_id, lesson_id, completed_at) VALUES (?,?,?,?)`,
    ).run(TENANT, REFERRED_USER, "lesson-0", NOW);
    for (let i = 0; i < 6; i += 1) {
      rawDb.prepare(
        `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, created_at, updated_at)
         VALUES (?,?,?,'QUALIFIED',?,?,?)`,
      ).run(TENANT, REFERRED_REP, `e2e-sale-${i}`, SOLD_AT, NOW, NOW);
    }

    // ── 8. Qualification, run repeatedly — one stamp, one event. ───────────
    for (let i = 0; i < 4; i += 1) {
      R.recheckQualification({ tenantId: TENANT, referralId, nowIso: NOW });
    }
    const qualified = R.getReferral(TENANT, referralId)!;
    expect(qualified.status).toBe("REWARD_PENDING");
    expect(qualified.qualifyingSalesCount).toBe(6);
    const thresholds = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM domain_events WHERE type = 'REFERRAL_THRESHOLD_REACHED'`,
    ).get() as any;
    expect(thresholds.n).toBe(1);

    // The applicant's view follows along, still without an amount.
    mine = R.applicantStatusFor(TENANT, REFERRED_REP, NOW);
    expect(mine.rewardState).toBe("in_review");
    expect(mine.salesProgress).toEqual({ current: 6, target: 6 });

    // ── 9. The holding window is real. ─────────────────────────────────────
    expect(() => R.approveReward({
      tenantId: TENANT, referralId, actorUserId: ADMIN_USER, nowIso: NOW,
    })).toThrow(/CLAWBACK_WINDOW_OPEN/);

    // ── 10. Approval, retried three times → ONE $500 earning. ──────────────
    R.approveReward({ tenantId: TENANT, referralId, actorUserId: ADMIN_USER, nowIso: AFTER_HOLD });
    R.approveReward({ tenantId: TENANT, referralId, actorUserId: ADMIN_USER, nowIso: AFTER_HOLD });
    R.approveReward({ tenantId: TENANT, referralId, actorUserId: ADMIN_USER, nowIso: AFTER_HOLD });

    const ledger = rawDb.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(net_cents),0) AS c, MIN(origin) AS origin
         FROM earnings_ledger WHERE tenant_id = ? AND earning_type = 'REFERRAL_BONUS'`,
    ).get(TENANT) as any;
    expect(ledger.n).toBe(1);
    expect(ledger.c).toBe(50_000);
    expect(ledger.origin).toBe("NATIVE");

    // ── 11. The money is the REFERRER's, not the referred person's. ────────
    const byRecipient = rawDb.prepare(
      `SELECT recipient_rep_id AS rep FROM earnings_ledger WHERE earning_type = 'REFERRAL_BONUS'`,
    ).all() as any[];
    expect(byRecipient.map(r => r.rep)).toEqual([REFERRER_REP]);

    // ── 12. And the applicant's own view says "approved" — no figure. ──────
    mine = R.applicantStatusFor(TENANT, REFERRED_REP, AFTER_HOLD);
    expect(mine.rewardState).toBe("approved");
    expect(JSON.stringify(mine)).not.toMatch(/50000|\$500/);

    // ── 13. The audit trail is complete and in order. ──────────────────────
    const history = (R.eventsFor(TENANT, referralId) as any[]).map(e => e.eventType);

    // The funnel milestones, each exactly once.
    expect(history.slice(0, 4)).toEqual(["APPLIED", "HIRED", "ACTIVATED", "QUALIFIED"]);

    // …and one APPROVED per ATTEMPT, not per state change. The audit log
    // records ACTIONS, so three approve requests are three entries even though
    // only the first changed anything. That is the more truthful record: an
    // admin hammering the button is a fact worth being able to see, and
    // collapsing it would hide it. The idempotency guarantee lives in the
    // LEDGER (asserted above: one row, $500), which is where it protects money.
    expect(history.filter(t => t === "APPROVED")).toHaveLength(3);
    expect(new Set(history)).toEqual(new Set(["APPLIED", "HIRED", "ACTIVATED", "QUALIFIED", "APPROVED"]));
  });

  it("a broken code still lets the applicant apply, and pays nobody", () => {
    const application = intake.submitPublicApplication({
      fullName: "Unlucky Applicant", email: "unlucky.e2e@example.test",
      phone: "5551234567", city: "Raleigh", zip: "27601", state: "NC",
      hasSalesExperience: false, preferredCarriers: "kinetic",
      referralCode: "ZZZZ9999",
    } as any);

    // The acceptance criterion, exercised: a fraudulent or stale code can never
    // prevent someone applying, and can never produce money either.
    expect(application.id).toBeGreaterThan(0);
    expect(R.listReferrals(TENANT)).toEqual([]);
    const ledger = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM earnings_ledger WHERE earning_type = 'REFERRAL_BONUS'`,
    ).get() as any;
    expect(ledger.n).toBe(0);
  });
});
