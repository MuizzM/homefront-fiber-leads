import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * referralStore against a real temp DB — the full walkthrough the spec asks
 * for: a referring rep, a referred rep, six qualifying sales, and a $500
 * reward, plus the failure modes that matter more than the happy path
 * (self-referral, duplicates, cancellation, and a referrer that cannot be
 * re-pointed once money is committed).
 */
let R: typeof import("../../server/referralStore");
let E: typeof import("../../server/domainEventStore");
let rawDb: import("better-sqlite3").Database;

const T1 = 1;
const REFERRER_REP = 10, REFERRER_USER = 100;
const REFERRED_REP = 11, REFERRED_USER = 101;
const ADMIN_USER = 999;
const OTHER_REP = 12;
const NOW = "2026-08-06T00:00:00.000Z";
const LATER = "2026-09-10T00:00:00.000Z"; // past the 30-day clawback window
// Sales must fall AFTER the hire date: the store counts only what the referred
// rep sold once they were actually working here, which is the correct rule and
// the reason this constant is not simply "some date".
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
/** A QUALIFIED sale in the same ledger the commission statements read. */
function sale(repId: number, externalId: string, status = "QUALIFIED", soldAt = SOLD_AT) {
  rawDb.prepare(
    `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(T1, repId, externalId, status, soldAt, NOW, NOW);
}
function salesFor(repId: number, n: number, status = "QUALIFIED", prefix = "sale") {
  for (let i = 0; i < n; i += 1) sale(repId, `${prefix}-${repId}-${i}`, status);
}

/** Training "complete" means the same thing here as it does at the door. */
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

/** Drive a referral all the way to REWARD_PENDING. */
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
  salesFor(REFERRED_REP, 6);
  R.recheckQualification({ tenantId: T1, referralId: referral!.id, nowIso: NOW });
  return R.getReferral(T1, referral!.id)!;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-referral-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  R = await import("../../server/referralStore");
  E = await import("../../server/domainEventStore");
});

beforeEach(() => {
  rawDb.exec("DROP TRIGGER IF EXISTS referral_events_no_delete");
  rawDb.exec("DROP TRIGGER IF EXISTS domain_events_no_delete");
  rawDb.prepare("DELETE FROM referral_events").run();
  rawDb.prepare("DELETE FROM referrals").run();
  rawDb.prepare("DELETE FROM referral_links").run();
  rawDb.prepare("DELETE FROM domain_events").run();
  rawDb.prepare("DELETE FROM commission_sales").run();
  rawDb.prepare("DELETE FROM training_progress").run();
  rawDb.prepare("DELETE FROM app_settings WHERE key IN ('referral.program','training.required_lessons')").run();
  R.ensureReferralSchema();
  E.ensureDomainEventSchema();

  member(REFERRER_REP, "Referring Rep");
  member(REFERRED_REP, "Referred Rep");
  member(OTHER_REP, "Someone Else");
  user(REFERRER_USER, "rep@example.com", REFERRER_REP);
  R.setConfig(T1, { enabled: true }, NOW);
});

describe("the program is dark until an admin turns it on", () => {
  it("defaults to disabled with the recommended $500 / 6-sale rule", () => {
    rawDb.prepare("DELETE FROM app_settings WHERE key = 'referral.program'").run();
    const config = R.getConfig(T1);
    expect(config.enabled).toBe(false);
    expect(config.rewardCents).toBe(50_000);
    expect(config.requiredApprovedSales).toBe(6);
  });

  it("refuses to attribute anything while off", () => {
    R.setConfig(T1, { enabled: false }, NOW);
    const link = R.ensureLink({ tenantId: T1, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP, baseUrl: "https://app.test", nowIso: NOW });
    const { referral, rejected } = R.attributeApplication({
      tenantId: T1, linkCode: link.code, applicantEmail: "newhire@example.com", nowIso: NOW,
    });
    expect(referral).toBeNull();
    expect(rejected).toBe("program_disabled");
  });
});

describe("links", () => {
  it("mints one code per rep and returns the SAME one on re-ask", () => {
    const a = R.ensureLink({ tenantId: T1, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP, baseUrl: "https://app.test", nowIso: NOW });
    const b = R.ensureLink({ tenantId: T1, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP, baseUrl: "https://app.test", nowIso: NOW });
    // A second code would split the rep's own pipeline.
    expect(b.code).toBe(a.code);
    expect(b.id).toBe(a.id);
  });

  it("counts clicks without creating a referral row", () => {
    const link = R.ensureLink({ tenantId: T1, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP, baseUrl: "https://app.test", nowIso: NOW });
    expect(R.trackClick(link.code)).toBe(true);
    expect(R.trackClick("NOTACODE")).toBe(false);
    // An anonymous click has no identity to attribute; a row per click would be
    // free pipeline inflation.
    expect(R.listReferrals(T1)).toEqual([]);
  });
});

describe("attribution and anti-fraud", () => {
  function link() {
    return R.ensureLink({ tenantId: T1, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP, baseUrl: "https://app.test", nowIso: NOW });
  }

  it("creates an APPLIED referral and a REFERRAL_CREATED event", () => {
    const { referral, rejected } = R.attributeApplication({
      tenantId: T1, linkCode: link().code, applicantEmail: "NewHire@Example.com ", nowIso: NOW,
    });
    expect(rejected).toBeNull();
    expect(referral!.status).toBe("APPLIED");
    expect(referral!.referredEmail).toBe("newhire@example.com"); // normalized
    expect(referral!.rewardAmountCents).toBe(50_000);
    expect(E.eventsForSubject(T1, "referral", referral!.id).map(e => e.type)).toEqual(["REFERRAL_CREATED"]);
  });

  it("refuses a rep referring themselves", () => {
    const { referral, rejected } = R.attributeApplication({
      tenantId: T1, linkCode: link().code, applicantEmail: "rep@example.com", nowIso: NOW,
    });
    expect(rejected).toBe("self_referral");
    expect(referral).toBeNull();
  });

  it("refuses an applicant who already has an account", () => {
    user(500, "existing@example.com", null);
    const { rejected } = R.attributeApplication({
      tenantId: T1, linkCode: link().code, applicantEmail: "existing@example.com", nowIso: NOW,
    });
    expect(rejected).toBe("existing_user");
  });

  it("refuses a second referral for the same applicant", () => {
    R.attributeApplication({ tenantId: T1, linkCode: link().code, applicantEmail: "newhire@example.com", nowIso: NOW });
    member(OTHER_REP, "Someone Else");
    const second = R.ensureLink({ tenantId: T1, referrerUserId: 102, referrerRepId: OTHER_REP, baseUrl: "https://app.test", nowIso: NOW });
    const { rejected } = R.attributeApplication({
      tenantId: T1, linkCode: second.code, applicantEmail: "newhire@example.com", nowIso: NOW,
    });
    expect(rejected).toBe("already_referred");
  });

  it("refuses an offboarded referrer", () => {
    const code = link().code;
    member(REFERRER_REP, "Referring Rep", T1, 0);
    const { rejected } = R.attributeApplication({
      tenantId: T1, linkCode: code, applicantEmail: "newhire@example.com", nowIso: NOW,
    });
    expect(rejected).toBe("referrer_inactive");
  });
});

describe("the $500 / 6-sale walkthrough", () => {
  it("qualifies on the sixth approved sale and holds the reward pending", () => {
    const referral = walkToPending();

    expect(referral.qualifyingSalesCount).toBe(6);
    expect(referral.status).toBe("REWARD_PENDING");
    expect(referral.qualifiedAt).toBe(NOW);
    expect(referral.rewardAmountCents).toBe(50_000);

    const types = E.eventsForSubject(T1, "referral", referral.id).map(e => e.type);
    expect(types).toEqual([
      "REFERRAL_CREATED", "REFERRAL_REP_HIRED", "REFERRAL_REP_ACTIVATED", "REFERRAL_THRESHOLD_REACHED",
    ]);
  });

  it("does NOT qualify on the fifth", () => {
    const link = R.ensureLink({ tenantId: T1, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP, baseUrl: "https://app.test", nowIso: NOW });
    const { referral } = R.attributeApplication({ tenantId: T1, linkCode: link.code, applicantEmail: "newhire@example.com", nowIso: NOW });
    R.markHired({ tenantId: T1, referralId: referral!.id, referredRepId: REFERRED_REP, referredUserId: REFERRED_USER, nowIso: NOW });
    R.markActivated({ tenantId: T1, referralId: referral!.id, nowIso: NOW });
    setTrainingComplete(REFERRED_USER);
    salesFor(REFERRED_REP, 5);

    const { result } = R.recheckQualification({ tenantId: T1, referralId: referral!.id, nowIso: NOW })!;
    expect(result.qualified).toBe(false);
    expect(result.salesRemaining).toBe(1);
    // The count still moves, so the rep's "5 of 6" is live.
    expect(R.getReferral(T1, referral!.id)!.qualifyingSalesCount).toBe(5);
    expect(R.getReferral(T1, referral!.id)!.status).toBe("IN_PROGRESS");
  });

  it("ignores cancelled and reversed sales", () => {
    const link = R.ensureLink({ tenantId: T1, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP, baseUrl: "https://app.test", nowIso: NOW });
    const { referral } = R.attributeApplication({ tenantId: T1, linkCode: link.code, applicantEmail: "newhire@example.com", nowIso: NOW });
    R.markHired({ tenantId: T1, referralId: referral!.id, referredRepId: REFERRED_REP, referredUserId: REFERRED_USER, nowIso: NOW });
    R.markActivated({ tenantId: T1, referralId: referral!.id, nowIso: NOW });
    setTrainingComplete(REFERRED_USER);
    salesFor(REFERRED_REP, 4);
    salesFor(REFERRED_REP, 2, "CANCELLED", "cancelled");
    sale(REFERRED_REP, "reversed-1");
    rawDb.prepare(`UPDATE commission_sales SET reversed_at = ? WHERE external_id = 'reversed-1'`).run(NOW);

    // Four real sales — the referral must not read seven.
    expect(R.countQualifyingSales(T1, REFERRED_REP, null)).toBe(4);
    const { result } = R.recheckQualification({ tenantId: T1, referralId: referral!.id, nowIso: NOW })!;
    expect(result.qualified).toBe(false);
  });

  it("blocks on incomplete training", () => {
    const link = R.ensureLink({ tenantId: T1, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP, baseUrl: "https://app.test", nowIso: NOW });
    const { referral } = R.attributeApplication({ tenantId: T1, linkCode: link.code, applicantEmail: "newhire@example.com", nowIso: NOW });
    R.markHired({ tenantId: T1, referralId: referral!.id, referredRepId: REFERRED_REP, referredUserId: REFERRED_USER, nowIso: NOW });
    R.markActivated({ tenantId: T1, referralId: referral!.id, nowIso: NOW });
    salesFor(REFERRED_REP, 6);

    const { result } = R.recheckQualification({ tenantId: T1, referralId: referral!.id, nowIso: NOW })!;
    expect(result.qualified).toBe(false);
    expect(result.requirements.find(r => r.key === "training")!.met).toBe(false);
  });

  it("re-qualifying is idempotent - one threshold event, one qualified_at", () => {
    const referral = walkToPending();
    R.recheckQualification({ tenantId: T1, referralId: referral.id, nowIso: LATER });
    R.recheckQualification({ tenantId: T1, referralId: referral.id, nowIso: LATER });

    const thresholds = E.eventsForSubject(T1, "referral", referral.id).filter(e => e.type === "REFERRAL_THRESHOLD_REACHED");
    expect(thresholds).toHaveLength(1);
    expect(R.getReferral(T1, referral.id)!.qualifiedAt).toBe(NOW);
  });
});

describe("approval and the clawback window", () => {
  it("refuses approval while the holding window is open", () => {
    const referral = walkToPending();
    expect(() => R.approveReward({ tenantId: T1, referralId: referral.id, actorUserId: ADMIN_USER, nowIso: NOW }))
      .toThrow(/REFERRAL_CLAWBACK_WINDOW_OPEN/);
  });

  it("approves once the window has closed", () => {
    const referral = walkToPending();
    const approved = R.approveReward({ tenantId: T1, referralId: referral.id, actorUserId: ADMIN_USER, nowIso: LATER });
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedBy).toBe(ADMIN_USER);
    expect(approved.rewardAmountCents).toBe(50_000);
  });

  it("re-checks qualification AT approval, not just at queue time", () => {
    const referral = walkToPending();
    // A sale cancelled while the referral sat in the queue must block the money.
    rawDb.prepare(`UPDATE commission_sales SET status = 'CANCELLED' WHERE external_id = 'sale-11-0'`).run();
    expect(() => R.approveReward({ tenantId: T1, referralId: referral.id, actorUserId: ADMIN_USER, nowIso: LATER }))
      .toThrow("REFERRAL_NOT_QUALIFIED");
  });

  it("un-qualifies inside the window when a sale is cancelled", () => {
    const referral = walkToPending();
    rawDb.prepare(`UPDATE commission_sales SET status = 'CANCELLED' WHERE external_id = 'sale-11-0'`).run();

    const { droppedBelowBar } = R.recheckAfterCancellation({ tenantId: T1, referralId: referral.id, nowIso: NOW });
    expect(droppedBelowBar).toBe(true);
    const after = R.getReferral(T1, referral.id)!;
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.qualifiedAt).toBeNull();
    expect(after.qualifyingSalesCount).toBe(5);
  });

  it("does NOT silently reverse an already-approved reward - it raises an exception", () => {
    const referral = walkToPending();
    R.approveReward({ tenantId: T1, referralId: referral.id, actorUserId: ADMIN_USER, nowIso: LATER });
    rawDb.prepare(`UPDATE commission_sales SET status = 'CANCELLED' WHERE external_id = 'sale-11-0'`).run();

    const { droppedBelowBar } = R.recheckAfterCancellation({ tenantId: T1, referralId: referral.id, nowIso: LATER });
    expect(droppedBelowBar).toBe(true);
    // The money is committed; undoing it is an admin clawback, not a flip.
    expect(R.getReferral(T1, referral.id)!.status).toBe("APPROVED");
    const history = R.eventsFor(T1, referral.id) as any[];
    expect(history.some(e => e.eventType === "CLAWBACK_EXCEPTION")).toBe(true);
  });

  it("freezes the config at qualification so a later change cannot re-judge it", () => {
    const referral = walkToPending();
    expect(referral.configSnapshot?.requiredApprovedSales).toBe(6);
    // Admin raises the bar to 10 afterwards.
    R.setConfig(T1, { requiredApprovedSales: 10 }, LATER);
    const snapshot = R.qualificationFor(T1, referral.id, LATER)!;
    expect(snapshot.result.qualified).toBe(true);
  });
});

describe("the referrer cannot be redirected", () => {
  it("allows a change before hire", () => {
    const link = R.ensureLink({ tenantId: T1, referrerUserId: REFERRER_USER, referrerRepId: REFERRER_REP, baseUrl: "https://app.test", nowIso: NOW });
    const { referral } = R.attributeApplication({ tenantId: T1, linkCode: link.code, applicantEmail: "newhire@example.com", nowIso: NOW });
    const moved = R.changeReferrer({
      tenantId: T1, referralId: referral!.id, newReferrerRepId: OTHER_REP,
      actorIsAdmin: false, actorUserId: ADMIN_USER, reason: "wrong code entered", nowIso: NOW,
    });
    expect(moved.referrerRepId).toBe(OTHER_REP);
  });

  it("needs an admin after hire", () => {
    const referral = walkToPending();
    expect(() => R.changeReferrer({
      tenantId: T1, referralId: referral.id, newReferrerRepId: OTHER_REP,
      actorIsAdmin: false, actorUserId: 5, reason: "x", nowIso: NOW,
    })).toThrow(/REFERRAL_REFERRER_LOCKED/);
  });

  it("is refused outright once the reward is approved", () => {
    const referral = walkToPending();
    R.approveReward({ tenantId: T1, referralId: referral.id, actorUserId: ADMIN_USER, nowIso: LATER });
    expect(() => R.changeReferrer({
      tenantId: T1, referralId: referral.id, newReferrerRepId: OTHER_REP,
      actorIsAdmin: true, actorUserId: ADMIN_USER, reason: "x", nowIso: LATER,
    })).toThrow(/REFERRAL_REFERRER_LOCKED/);
  });
});

describe("audit history", () => {
  it("records every funnel step, append-only", () => {
    const referral = walkToPending();
    const history = R.eventsFor(T1, referral.id) as any[];
    expect(history.map(e => e.eventType)).toEqual(["APPLIED", "HIRED", "ACTIVATED", "QUALIFIED"]);

    const id = history[0].id;
    expect(() => rawDb.prepare("UPDATE referral_events SET event_type = 'X' WHERE id = ?").run(id))
      .toThrow(/append-only/);
  });
});

describe("liability and isolation", () => {
  it("separates pending from approved liability", () => {
    const referral = walkToPending();
    expect(R.orgReferralLiability(T1)).toMatchObject({ pendingCents: 50_000, approvedCents: 0 });
    R.approveReward({ tenantId: T1, referralId: referral.id, actorUserId: ADMIN_USER, nowIso: LATER });
    expect(R.orgReferralLiability(T1)).toMatchObject({ pendingCents: 0, approvedCents: 50_000 });
  });

  it("never leaks another org's referral", () => {
    const referral = walkToPending();
    expect(R.getReferral(2, referral.id)).toBeNull();
    expect(R.listReferrals(2)).toEqual([]);
  });

  it("an EMPTY referrer scope returns nothing, not everything", () => {
    walkToPending();
    expect(R.listReferrals(T1, { referrerRepIds: [] })).toEqual([]);
    expect(R.listReferrals(T1, { referrerRepIds: [REFERRER_REP] })).toHaveLength(1);
  });
});
