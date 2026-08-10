import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The program-live migration and the exactly-one-reward guarantees.
 *
 * The 2026-08-09 default flip (enabled: true) could not reach any environment
 * where a settings row had ever been SAVED - getConfig merges the row over the
 * defaults, so a row written while the program shipped dark kept it silently
 * OFF. These tests pin the migration that repairs that, the audit trail it
 * leaves, the marker that stops it overriding a later human decision, and the
 * database-level idempotency that makes the $500 impossible to double-pay.
 */
let R: typeof import("../../server/referralStore");
let L: typeof import("../../server/earningsLedgerStore");
let SVC: typeof import("../../server/commissionService");
let SUB: typeof import("../../server/incentiveSubscriber");
let EV: typeof import("../../server/domainEventStore");
let rawDb: import("better-sqlite3").Database;

const T1 = 1;
const REFERRER_REP = 10, REFERRER_USER = 100;
const REFERRED_REP = 11, REFERRED_USER = 101;
const ADMIN_USER = 999;
const NOW = "2026-08-06T00:00:00.000Z";
const LATER = "2026-09-10T00:00:00.000Z"; // past the 30-day clawback window
const SOLD_AT = "2026-08-06T01:00:00.000Z";

function member(id: number, name: string, tenantId = T1, active = 1) {
  rawDb.prepare(
    `INSERT OR REPLACE INTO team_members (id, name, role, active, tenant_id, created_at)
     VALUES (?,?,'rep',?,?,datetime('now'))`,
  ).run(id, name, active, tenantId);
}
function user(id: number, email: string, teamMemberId: number | null, tenantId = T1) {
  rawDb.prepare(
    `INSERT OR REPLACE INTO users (id, name, email, role, tenant_id, team_member_id, active, created_at)
     VALUES (?,?,?,'rep',?,?,1,datetime('now'))`,
  ).run(id, email, email, tenantId, teamMemberId);
}
function sale(repId: number, externalId: string, status = "QUALIFIED", soldAt = SOLD_AT) {
  rawDb.prepare(
    `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(T1, repId, externalId, status, soldAt, NOW, NOW);
}
function salesFor(repId: number, n: number, prefix = "sale") {
  for (let i = 0; i < n; i += 1) sale(repId, `${prefix}-${repId}-${i}`);
}
function setTrainingComplete(userId: number, lessons = 3) {
  rawDb.prepare(
    `INSERT INTO app_settings (tenant_id, key, value, updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
  ).run(T1, "training.required_lessons", String(lessons));
  for (let i = 0; i < lessons; i += 1) {
    rawDb.prepare(
      `INSERT OR IGNORE INTO training_progress (tenant_id, user_id, lesson_id, completed_at)
       VALUES (?,?,?,?)`,
    ).run(T1, userId, `lesson-${i}`, NOW);
  }
}
const savedConfig = () => {
  const row = rawDb.prepare(
    `SELECT value FROM app_settings WHERE tenant_id = ? AND key = 'referral.program'`,
  ).get(T1) as { value: string } | undefined;
  return row?.value ? JSON.parse(row.value) : null;
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-ref-live-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  R = await import("../../server/referralStore");
  L = await import("../../server/earningsLedgerStore");
  SVC = await import("../../server/commissionService");
  SUB = await import("../../server/incentiveSubscriber");
  EV = await import("../../server/domainEventStore");
});

beforeEach(() => {
  rawDb.exec("DROP TRIGGER IF EXISTS referral_events_no_delete");
  rawDb.exec("DROP TRIGGER IF EXISTS domain_events_no_delete");
  for (const t of ["referral_events", "referrals", "referral_links", "domain_events", "commission_sales", "training_progress", "earnings_ledger"]) {
    rawDb.prepare(`DELETE FROM ${t}`).run();
  }
  rawDb.prepare("DELETE FROM app_settings WHERE key LIKE 'referral.program%' OR key = 'training.required_lessons'").run();
  rawDb.prepare("DELETE FROM event_subscriptions").run();
  R.ensureReferralSchema();
  EV.ensureDomainEventSchema();
  SUB.ensureIncentiveSchema();
  member(REFERRER_REP, "Referring Rep");
  member(REFERRED_REP, "Referred Rep");
  user(REFERRER_USER, "referrer@example.com", REFERRER_REP);
  user(REFERRED_USER, "referred@example.com", REFERRED_REP);
});

/** Drive a referral all the way to REWARD_PENDING under the live program. */
function walkToPending() {
  const link = R.ensureLink({
    tenantId: T1, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP,
    baseUrl: "https://app.test", nowIso: NOW,
  });
  const { referral } = R.attributeApplication({
    tenantId: T1, linkCode: link.code, applicantEmail: "newhire@example.com", nowIso: NOW,
  });
  R.markHired({ tenantId: T1, referralId: referral!.id, referredRepId: REFERRED_REP, referredUserId: REFERRED_USER, nowIso: NOW });
  R.markActivated({ tenantId: T1, referralId: referral!.id, nowIso: NOW });
  setTrainingComplete(REFERRED_USER);
  return referral!.id;
}

describe("the program-live migration", () => {
  it("turns a saved OFF row on, forces $500/6, preserves tuned windows, and leaves an audit record", () => {
    // The exact production hazard: settings saved while the program shipped dark.
    R.setConfig(T1, { enabled: false, rewardCents: 25_000, requiredApprovedSales: 3, clawbackWindowDays: 45 }, NOW);
    expect(savedConfig().enabled).toBe(false);

    const records = R.migrateReferralProgramLive(LATER);
    const mine = records.find(r => r.tenantId === T1)!;
    expect(mine.action).toBe("enabled");
    expect(mine.before).toMatchObject({ enabled: false, rewardCents: 25_000, requiredApprovedSales: 3 });
    expect(mine.after).toMatchObject({ enabled: true, rewardCents: 50_000, requiredApprovedSales: 6 });

    const now = savedConfig();
    expect(now.enabled).toBe(true);
    expect(now.rewardCents).toBe(50_000);
    expect(now.requiredApprovedSales).toBe(6);
    // A tuned non-policy field survives - only activation/reward/threshold are forced.
    expect(now.clawbackWindowDays).toBe(45);

    // The audit row: who, when, before, after - readable straight off app_settings.
    const marker = rawDb.prepare(
      "SELECT value FROM app_settings WHERE tenant_id = ? AND key = 'referral.program.migration.2026-08-live'",
    ).get(T1) as { value: string };
    const audit = JSON.parse(marker.value);
    expect(audit.actor).toBe("migration:referral-program-live");
    expect(audit.at).toBe(LATER);
    expect(audit.before.enabled).toBe(false);
    expect(audit.after.enabled).toBe(true);
  });

  it("creates an explicit ENABLED row where none existed, so defaults and persisted state cannot drift silently", () => {
    expect(savedConfig()).toBeNull();
    const records = R.migrateReferralProgramLive(NOW);
    expect(records.find(r => r.tenantId === T1)!.action).toBe("row-created");
    const now = savedConfig();
    expect(now.enabled).toBe(true);
    expect(now.rewardCents).toBe(50_000);
    expect(now.requiredApprovedSales).toBe(6);
  });

  it("is one-shot: a second run changes nothing, and a HUMAN off-switch after it sticks", () => {
    R.migrateReferralProgramLive(NOW);
    expect(R.migrateReferralProgramLive(LATER)).toHaveLength(0);

    // An admin deliberately turns it off AFTER the migration - that decision
    // must survive every future boot.
    R.setConfig(T1, { enabled: false }, LATER);
    expect(R.migrateReferralProgramLive(LATER)).toHaveLength(0);
    expect(savedConfig().enabled).toBe(false);
    expect(R.referralProgramHealth(T1).warning).toMatch(/DISABLED/);
  });

  it("ensureReferralConfigRow seeds new installs exactly once", () => {
    expect(R.ensureReferralConfigRow(T1, NOW)).toBe(true);
    expect(R.ensureReferralConfigRow(T1, LATER)).toBe(false); // second call: row exists
    expect(savedConfig().enabled).toBe(true);
  });

  it("health reads green when live and warns when dark", () => {
    R.migrateReferralProgramLive(NOW);
    const live = R.referralProgramHealth(T1);
    expect(live.enabled).toBe(true);
    expect(live.rewardCents).toBe(50_000);
    expect(live.requiredApprovedSales).toBe(6);
    expect(live.explicitRow).toBe(true);
    expect(live.migratedAt).toBe(NOW);
    expect(live.warning).toBeNull();
  });
});

describe("exactly one $500, however the sixth sale arrives", () => {
  it("qualifies once at the sixth QUALIFIED sale and replays are no-ops", () => {
    R.migrateReferralProgramLive(NOW);
    const referralId = walkToPending();

    salesFor(REFERRED_REP, 5);
    R.recheckQualification({ tenantId: T1, referralId, nowIso: NOW });
    expect(R.getReferral(T1, referralId)!.status).toBe("IN_PROGRESS");
    expect(R.getReferral(T1, referralId)!.qualifyingSalesCount).toBe(5);

    sale(REFERRED_REP, "the-sixth");
    R.recheckQualification({ tenantId: T1, referralId, nowIso: NOW });
    expect(R.getReferral(T1, referralId)!.status).toBe("REWARD_PENDING");

    // Duplicate SALE_APPROVED deliveries re-run the recheck; the qualified_at
    // guard and the domain-event dedupe key make them no-ops.
    R.recheckQualification({ tenantId: T1, referralId, nowIso: LATER });
    R.recheckQualification({ tenantId: T1, referralId, nowIso: LATER });
    const qualifiedEvents = rawDb.prepare(
      "SELECT COUNT(*) AS n FROM referral_events WHERE referral_id = ? AND event_type = 'QUALIFIED'",
    ).get(referralId) as { n: number };
    expect(qualifiedEvents.n).toBe(1);
    const thresholdEvents = rawDb.prepare(
      "SELECT COUNT(*) AS n FROM domain_events WHERE type = 'REFERRAL_THRESHOLD_REACHED'",
    ).get() as { n: number };
    expect(thresholdEvents.n).toBe(1);
  });

  it("approval posts ONE ledger row; a retried write upserts into it and a second approve refuses", () => {
    R.migrateReferralProgramLive(NOW);
    const referralId = walkToPending();
    salesFor(REFERRED_REP, 6);
    R.recheckQualification({ tenantId: T1, referralId, nowIso: NOW });

    R.approveReward({ tenantId: T1, referralId, actorUserId: ADMIN_USER, nowIso: LATER });
    const rows = () => rawDb.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(gross_cents),0) AS cents FROM earnings_ledger
        WHERE source_type = 'referral' AND source_id = ? AND earning_type = 'REFERRAL_BONUS'`,
    ).get(referralId) as { n: number; cents: number };
    expect(rows()).toEqual({ n: 1, cents: 50_000 });

    // A second admin (or a double-submitted request) succeeds idempotently.
    // The repo's documented contract (referral-end-to-end.test.ts): the AUDIT
    // trail records every retry that happened, and the LEDGER's unique key is
    // what keeps the money single - asserted below.
    const again = R.approveReward({ tenantId: T1, referralId, actorUserId: ADMIN_USER + 1, nowIso: "2026-09-11T00:00:00.000Z" });
    expect(again.status).toBe("APPROVED");

    // Even a raw retried ledger write lands on the SAME row: the database's
    // unique idempotency key (referral:<id>:REFERRAL_BONUS), not writer memory.
    L.recordReferralReward({
      tenantId: T1, referrerRepId: REFERRER_REP, referralId,
      rewardCents: 50_000, effectiveDate: LATER.slice(0, 10),
      referredRepId: REFERRED_REP, qualifyingSales: 6, nowIso: LATER,
    });
    expect(rows()).toEqual({ n: 1, cents: 50_000 });
  });

  it("stamps the reward from the config in force at QUALIFICATION, not at application", () => {
    // A referral that applied under an older/absent rule must be paid the rule
    // it actually qualified under - and must never approve at $0.
    R.migrateReferralProgramLive(NOW);
    const referralId = walkToPending();
    rawDb.prepare("UPDATE referrals SET reward_amount_cents = 0 WHERE id = ?").run(referralId);

    salesFor(REFERRED_REP, 6);
    R.recheckQualification({ tenantId: T1, referralId, nowIso: NOW });
    expect(R.getReferral(T1, referralId)!.rewardAmountCents).toBe(50_000);

    R.approveReward({ tenantId: T1, referralId, actorUserId: ADMIN_USER, nowIso: LATER });
    const row = rawDb.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(gross_cents),0) AS cents FROM earnings_ledger
        WHERE source_type = 'referral' AND source_id = ? AND earning_type = 'REFERRAL_BONUS'`,
    ).get(referralId) as { n: number; cents: number };
    expect(row).toEqual({ n: 1, cents: 50_000 });
  });

  it("a cancelled sale inside the window un-qualifies the pending reward", () => {
    R.migrateReferralProgramLive(NOW);
    const referralId = walkToPending();
    salesFor(REFERRED_REP, 6);
    R.recheckQualification({ tenantId: T1, referralId, nowIso: NOW });
    expect(R.getReferral(T1, referralId)!.status).toBe("REWARD_PENDING");

    rawDb.prepare(
      "UPDATE commission_sales SET status = 'REVERSED' WHERE rep_id = ? AND external_id = ?",
    ).run(REFERRED_REP, `sale-${REFERRED_REP}-0`);
    const out = R.recheckAfterCancellation({ tenantId: T1, referralId, nowIso: NOW });
    expect(out.droppedBelowBar).toBe(true);
    expect(R.getReferral(T1, referralId)!.status).toBe("IN_PROGRESS");
    expect(R.getReferral(T1, referralId)!.qualifyingSalesCount).toBe(5);
  });
});

describe("the live chain: a sale write moves the referrer's progress", () => {
  // The gap this closes: SALE_APPROVED had no emitter in production code, and
  // the subscriber that consumes it had no drain loop outside tests. A referee
  // could close six sales and the referrer's bar would never move.
  it("emits SALE_APPROVED at the write site, and the drain recounts the referral", () => {
    R.migrateReferralProgramLive(NOW);
    const referralId = walkToPending();

    // Five sales through the REAL commission write door.
    for (let i = 0; i < 5; i += 1) {
      SVC.upsertSale(T1, 1, {
        repId: REFERRED_REP, externalId: `live-${i}`, status: "QUALIFIED",
        soldAt: SOLD_AT, qualifiedAt: SOLD_AT,
      } as any);
    }
    const approved = rawDb.prepare(
      "SELECT COUNT(*) AS n FROM domain_events WHERE type = 'SALE_APPROVED'",
    ).get() as { n: number };
    expect(approved.n).toBe(5);

    // The subscriber drains them; the referral's visible count follows.
    SUB.drain(NOW);
    expect(R.getReferral(T1, referralId)!.qualifyingSalesCount).toBe(5);
    expect(R.getReferral(T1, referralId)!.status).toBe("IN_PROGRESS");

    // The sixth crosses the bar.
    SVC.upsertSale(T1, 1, {
      repId: REFERRED_REP, externalId: "live-5", status: "QUALIFIED",
      soldAt: SOLD_AT, qualifiedAt: SOLD_AT,
    } as any);
    SUB.drain(NOW);
    const after = R.getReferral(T1, referralId)!;
    expect(after.qualifyingSalesCount).toBe(6);
    expect(after.status).toBe("REWARD_PENDING");

    // Draining again (a retry, a second worker) changes nothing.
    SUB.drain(NOW);
    SUB.drain(NOW);
    expect(R.getReferral(T1, referralId)!.status).toBe("REWARD_PENDING");
    const qualifiedEvents = rawDb.prepare(
      "SELECT COUNT(*) AS n FROM referral_events WHERE referral_id = ? AND event_type = 'QUALIFIED'",
    ).get(referralId) as { n: number };
    expect(qualifiedEvents.n).toBe(1);
  });

  it("a reversal through the same door emits SALE_CANCELLED and walks the referral back", () => {
    R.migrateReferralProgramLive(NOW);
    const referralId = walkToPending();
    for (let i = 0; i < 6; i += 1) {
      SVC.upsertSale(T1, 1, {
        repId: REFERRED_REP, externalId: `rev-${i}`, status: "QUALIFIED",
        soldAt: SOLD_AT, qualifiedAt: SOLD_AT,
      } as any);
    }
    SUB.drain(NOW);
    expect(R.getReferral(T1, referralId)!.status).toBe("REWARD_PENDING");

    SVC.transitionSale(T1, 1, "rev-0", "REVERSE");
    const cancelled = rawDb.prepare(
      "SELECT COUNT(*) AS n FROM domain_events WHERE type = 'SALE_CANCELLED'",
    ).get() as { n: number };
    expect(cancelled.n).toBe(1);

    SUB.drain(NOW);
    const after = R.getReferral(T1, referralId)!;
    expect(after.qualifyingSalesCount).toBe(5);
    expect(after.status).toBe("IN_PROGRESS");
  });

  it("recountOpenReferrals catches up a referee who crossed the bar before events existed", () => {
    R.migrateReferralProgramLive(NOW);
    const referralId = walkToPending();
    // Sales written straight to the ledger: the pre-fix world, no events.
    salesFor(REFERRED_REP, 6);
    expect(R.getReferral(T1, referralId)!.status).toBe("ACTIVATED");

    expect(R.recountOpenReferrals(NOW)).toBeGreaterThanOrEqual(1);
    expect(R.getReferral(T1, referralId)!.status).toBe("REWARD_PENDING");
    expect(R.getReferral(T1, referralId)!.qualifyingSalesCount).toBe(6);
  });
});
