// Idempotency across the whole referral path.
//
// The brief's rule: retried requests, page refreshes, double submits, and
// background retries must not create duplicate clicks, applications, referrals,
// qualifications, or payouts. Every one of those is a separate mechanism, so
// each gets its own test — and every one of them is enforced by a DATABASE
// constraint rather than by application code remembering, because the failure
// mode being defended against is two requests running at once.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let R: typeof import("../../server/referralStore");
let intake: typeof import("../../server/onboardingApplicationService");
let rawDb: import("better-sqlite3").Database;

const TENANT = 1;
const REFERRER_REP = 910, REFERRER_USER = 9100;
const NOW = "2026-08-07T12:00:00.000Z";

const applicant = (over: Record<string, any> = {}) => ({
  fullName: "Retry Applicant", email: "retry.applicant@example.test",
  phone: "5551234567", city: "Raleigh", zip: "27601", state: "NC",
  hasSalesExperience: false, preferredCarriers: "kinetic", ...over,
}) as any;

const link = () => R.ensureLink({
  tenantId: TENANT, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP,
  baseUrl: "https://app.test", nowIso: NOW,
});

const countReferrals = () =>
  (rawDb.prepare(`SELECT COUNT(*) AS n FROM referrals`).get() as any).n;
const clickCount = (code: string) =>
  (rawDb.prepare(`SELECT click_count AS c FROM referral_links WHERE code = ?`).get(code) as any).c;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-refidem-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  R = await import("../../server/referralStore");
  intake = await import("../../server/onboardingApplicationService");
});

beforeEach(() => {
  rawDb.exec("DROP TRIGGER IF EXISTS referral_events_no_delete");
  rawDb.exec("DROP TRIGGER IF EXISTS domain_events_no_delete");
  rawDb.exec("DROP TRIGGER IF EXISTS earnings_ledger_no_paid_delete");
  for (const t of ["referral_events", "referrals", "referral_links", "referral_click_dedupe",
    "domain_events", "rep_applications", "commission_sales", "training_progress",
    "earnings_ledger"]) {
    rawDb.prepare(`DELETE FROM ${t}`).run();
  }
  rawDb.prepare("DELETE FROM users WHERE id >= 9100").run();
  rawDb.prepare("DELETE FROM team_members WHERE id >= 910").run();
  R.ensureReferralSchema();

  rawDb.prepare(
    `INSERT INTO team_members (id, name, email, role, active, tenant_id, created_at)
     VALUES (?,?,?,'rep',1,?,datetime('now'))`,
  ).run(REFERRER_REP, "Riley Referrer", "riley.idem@example.test", TENANT);
  rawDb.prepare(
    `INSERT INTO users (id, name, email, role, tenant_id, team_member_id, active, created_at)
     VALUES (?,?,?,'rep',?,?,1,datetime('now'))`,
  ).run(REFERRER_USER, "Riley Referrer", "riley.idem@example.test", TENANT, REFERRER_REP);
  R.setConfig(TENANT, { enabled: true }, NOW);
});

describe("clicks", () => {
  it("counts one visitor-day once, however many times they load the page", () => {
    const code = link().code;
    const key = R.clickDedupeKey({ ip: "203.0.113.5", userAgent: "Mozilla/5.0", dayIso: "2026-08-07" });

    // A refresh, a back-button, and a prefetch are the same person.
    expect(R.trackClick(code, key, NOW)).toBe(true);
    expect(R.trackClick(code, key, NOW)).toBe(false);
    expect(R.trackClick(code, key, NOW)).toBe(false);
    expect(clickCount(code)).toBe(1);
  });

  it("counts genuinely different visitors separately", () => {
    const code = link().code;
    for (const ip of ["203.0.113.5", "203.0.113.6", "198.51.100.9"]) {
      R.trackClick(code, R.clickDedupeKey({ ip, userAgent: "Mozilla/5.0", dayIso: "2026-08-07" }), NOW);
    }
    expect(clickCount(code)).toBe(3);
  });

  it("lets the same visitor count again on a new day", () => {
    const code = link().code;
    const visitor = (day: string) => R.clickDedupeKey({ ip: "203.0.113.5", userAgent: "M", dayIso: day });
    R.trackClick(code, visitor("2026-08-07"), NOW);
    R.trackClick(code, visitor("2026-08-08"), NOW);
    expect(clickCount(code)).toBe(2);
  });

  it("still counts when no dedupe key is available, rather than dropping it", () => {
    const code = link().code;
    expect(R.trackClick(code)).toBe(true);
    expect(clickCount(code)).toBe(1);
  });

  it("prunes its dedupe cache without touching the counts", () => {
    const code = link().code;
    R.trackClick(code, R.clickDedupeKey({ ip: "1.2.3.4", userAgent: "M", dayIso: "2026-08-01" }), "2026-08-01T00:00:00.000Z");
    expect(R.pruneClickDedupe("2026-08-05T00:00:00.000Z")).toBe(1);
    expect(clickCount(code)).toBe(1);
  });
});

describe("links", () => {
  it("minting is idempotent — a rep keeps ONE code", () => {
    const first = link();
    for (let i = 0; i < 5; i += 1) expect(link().code).toBe(first.code);
    const n = rawDb.prepare(`SELECT COUNT(*) AS n FROM referral_links`).get() as any;
    expect(n.n).toBe(1);
  });
});

describe("attribution", () => {
  it("a double-submitted application creates ONE referral", () => {
    const code = link().code;
    intake.submitPublicApplication(applicant({ referralCode: code }));
    // The second submit is refused as a duplicate pending application, which is
    // the existing intake rule — and crucially no second referral appears.
    expect(() => intake.submitPublicApplication(applicant({ referralCode: code })))
      .toThrow(/already pending/i);
    expect(countReferrals()).toBe(1);
  });

  it("the database refuses a SECOND referral against one application", () => {
    const code = link().code;
    const application = intake.submitPublicApplication(applicant({ referralCode: code }));

    // Force the race the constraint exists for: a retried attribution for the
    // same application under a different applicant identity.
    expect(() => rawDb.prepare(
      `INSERT INTO referrals (tenant_id, referrer_user_id, referrer_rep_id, referred_email,
         referred_application_id, status, reward_amount_cents, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(TENANT, REFERRER_USER, REFERRER_REP, "someone.else@example.test",
      application.id, "APPLIED", 50_000, NOW, NOW)).toThrow(/UNIQUE/i);

    expect(countReferrals()).toBe(1);
  });

  it("refuses a second LIVE referral for the same applicant", () => {
    const code = link().code;
    R.attributeApplication({ tenantId: TENANT, linkCode: code, applicantEmail: "dupe@example.test", nowIso: NOW });
    const { referral, rejected } = R.attributeApplication({
      tenantId: TENANT, linkCode: code, applicantEmail: "dupe@example.test", nowIso: NOW,
    });
    expect(referral).toBeNull();
    expect(rejected).toBe("already_referred");
    expect(countReferrals()).toBe(1);
  });

  it("lets a REJECTED applicant be referred again", () => {
    const code = link().code;
    const first = R.attributeApplication({
      tenantId: TENANT, linkCode: code, applicantEmail: "second.chance@example.test", nowIso: NOW,
    }).referral!;
    R.rejectReferral({ tenantId: TENANT, referralId: first.id, actorUserId: 1, reason: "withdrew", nowIso: NOW });

    // The live-referral indexes are partial on status for exactly this: a
    // closed referral must not permanently bar a genuine second attempt.
    const { referral } = R.attributeApplication({
      tenantId: TENANT, linkCode: code, applicantEmail: "second.chance@example.test", nowIso: NOW,
    });
    expect(referral).not.toBeNull();
  });
});

describe("qualification and reward", () => {
  function qualified() {
    const code = link().code;
    const { referral } = R.attributeApplication({
      tenantId: TENANT, linkCode: code, applicantEmail: "grad@example.test", nowIso: NOW,
    });
    rawDb.prepare(
      `INSERT INTO team_members (id, name, role, active, tenant_id, created_at)
       VALUES (911,'Referred',' rep',1,?,datetime('now')) ON CONFLICT(id) DO NOTHING`,
    ).run(TENANT);
    rawDb.prepare(`UPDATE team_members SET role='rep' WHERE id = 911`).run();
    rawDb.prepare(
      `INSERT INTO users (id, name, email, role, tenant_id, team_member_id, active, created_at)
       VALUES (9101,'Referred','grad@example.test','rep',?,911,1,datetime('now'))
       ON CONFLICT(id) DO NOTHING`,
    ).run(TENANT);
    R.markHired({ tenantId: TENANT, referralId: referral!.id, referredRepId: 911, referredUserId: 9101, nowIso: NOW });
    R.markActivated({ tenantId: TENANT, referralId: referral!.id, nowIso: NOW });
    rawDb.prepare(
      `INSERT INTO app_settings (tenant_id, key, value, updated_at) VALUES (?,?,?,datetime('now'))
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
    ).run(TENANT, "training.required_lessons", "1");
    rawDb.prepare(
      `INSERT OR IGNORE INTO training_progress (tenant_id, user_id, lesson_id, completed_at) VALUES (?,?,?,?)`,
    ).run(TENANT, 9101, "l-0", NOW);
    for (let i = 0; i < 6; i += 1) {
      rawDb.prepare(
        `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, created_at, updated_at)
         VALUES (?,911,?,'QUALIFIED',?,?,?)`,
      ).run(TENANT, `idem-s-${i}`, "2026-08-07T13:00:00.000Z", NOW, NOW);
    }
    return referral!.id;
  }

  it("re-running qualification pays and stamps exactly once", () => {
    const id = qualified();
    for (let i = 0; i < 5; i += 1) {
      R.recheckQualification({ tenantId: TENANT, referralId: id, nowIso: NOW });
    }
    const referral = R.getReferral(TENANT, id)!;
    expect(referral.qualifiedAt).toBe(NOW);
    expect(referral.status).toBe("REWARD_PENDING");

    const thresholds = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM domain_events WHERE type = 'REFERRAL_THRESHOLD_REACHED'`,
    ).get() as any;
    expect(thresholds.n).toBe(1);
    const qualifiedEvents = (R.eventsFor(TENANT, id) as any[]).filter(e => e.eventType === "QUALIFIED");
    expect(qualifiedEvents).toHaveLength(1);
  });

  it("a repeated approval is a safe no-op, not a second payment", () => {
    const id = qualified();
    R.recheckQualification({ tenantId: TENANT, referralId: id, nowIso: NOW });
    const later = "2026-09-15T12:00:00.000Z";

    // A retried approve does NOT throw — `canReferralTransition` treats
    // same-status as allowed on purpose, so a client that retries a timed-out
    // request gets a success rather than a confusing 409 for work that already
    // happened. That makes the ledger, not the state machine, the thing that
    // has to stop a double payment.
    R.approveReward({ tenantId: TENANT, referralId: id, actorUserId: 1, nowIso: later });
    R.approveReward({ tenantId: TENANT, referralId: id, actorUserId: 1, nowIso: later });
    R.approveReward({ tenantId: TENANT, referralId: id, actorUserId: 1, nowIso: later });

    // …and it does: the earnings row is keyed `referral:<id>:REFERRAL_BONUS`,
    // so three approvals produce ONE $500 earning.
    const earnings = rawDb.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(net_cents),0) AS c FROM earnings_ledger
        WHERE tenant_id = ? AND earning_type = 'REFERRAL_BONUS'`,
    ).get(TENANT) as any;
    expect(earnings.n).toBe(1);
    expect(earnings.c).toBe(50_000);
    expect(R.getReferral(TENANT, id)!.status).toBe("APPROVED");
  });

  it("cannot be approved back out of a terminal state", () => {
    const id = qualified();
    R.recheckQualification({ tenantId: TENANT, referralId: id, nowIso: NOW });
    R.rejectReferral({ tenantId: TENANT, referralId: id, actorUserId: 1, reason: "fraud review", nowIso: NOW });

    // REJECTED is terminal — reinstating is a NEW referral with its own audit
    // trail, never a flip that erases why it was rejected.
    expect(() => R.approveReward({ tenantId: TENANT, referralId: id, actorUserId: 1, nowIso: NOW }))
      .toThrow(/REFERRAL_BAD_TRANSITION/);
    const earnings = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM earnings_ledger WHERE tenant_id = ? AND earning_type = 'REFERRAL_BONUS'`,
    ).get(TENANT) as any;
    expect(earnings.n).toBe(0);
  });
});
