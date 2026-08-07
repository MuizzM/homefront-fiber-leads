import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The event-driven incentive engine, end to end. The properties that decide
 * whether it is safe to run against real money:
 *
 *   * ONE event pays ONE reward, no matter how many times the subscriber runs;
 *   * a replay after a crash re-runs the batch and pays nothing extra;
 *   * a referral reward pays the REFERRER for an event about someone else;
 *   * a cancellation appends a negative row rather than editing the original;
 *   * caps trim rather than suppress, and every skip is explained.
 */
let E: typeof import("../../server/domainEventStore");
let S: typeof import("../../server/incentiveSubscriber");
let R: typeof import("../../server/referralStore");
let rawDb: import("better-sqlite3").Database;

const T1 = 1, REP = 10, REFERRER = 20, REFERRED = 21;
const NOW = "2026-08-06T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const WINDOW = { startsAtMs: NOW_MS - 86_400_000, endsAtMs: NOW_MS + 86_400_000 };

function member(id: number, name: string, role = "rep", tenantId = T1) {
  rawDb.prepare(
    `INSERT OR REPLACE INTO team_members (id, name, role, active, tenant_id, created_at)
     VALUES (?,?,?,1,?,datetime('now'))`,
  ).run(id, name, role, tenantId);
}

function campaign(over: Partial<Parameters<typeof S.createCampaign>[0]> = {}) {
  return S.createCampaign({
    tenantId: T1, name: "Test incentive", incentiveType: "PRODUCT_SPIFF",
    amountBasis: "FLAT", rewardCents: 7_500,
    ...WINDOW, approvalRequired: false, nowIso: NOW, ...over,
  } as any);
}

function saleApproved(saleId: number, payload: Record<string, unknown> = {}) {
  return E.emit({
    tenantId: T1, type: "SALE_APPROVED", subjectType: "sale", subjectId: saleId,
    subjectRepId: REP, occurredAt: NOW, payload,
  }, NOW);
}

const awardsFor = (repId: number) =>
  rawDb.prepare(`SELECT * FROM spiffs WHERE tenant_id = ? AND rep_id = ? ORDER BY id ASC`).all(T1, repId) as any[];

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-incentive-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  E = await import("../../server/domainEventStore");
  R = await import("../../server/referralStore");
  S = await import("../../server/incentiveSubscriber");
});

beforeEach(() => {
  rawDb.exec("DROP TRIGGER IF EXISTS domain_events_no_delete");
  rawDb.exec("DROP TRIGGER IF EXISTS referral_events_no_delete");
  for (const t of ["domain_events", "event_subscriptions", "spiffs", "spiff_campaigns",
    "incentive_evaluations", "referrals", "referral_links", "referral_events",
    "commission_sales", "earnings_ledger"]) {
    rawDb.prepare(`DELETE FROM ${t}`).run();
  }
  E.ensureDomainEventSchema();
  R.ensureReferralSchema();
  S.ensureIncentiveSchema();
  member(REP, "Field Rep");
  member(REFERRER, "Referring Rep");
  member(REFERRED, "Referred Rep");
});

describe("one event, one reward", () => {
  it("awards on a matching event", () => {
    campaign();
    saleApproved(1);
    const result = S.drain(NOW);

    expect(result.awarded).toBe(1);
    const awards = awardsFor(REP);
    expect(awards).toHaveLength(1);
    expect(awards[0].amount_cents).toBe(7_500);
    // A campaign that needs no review is approved at the instant it is earned.
    expect(awards[0].status).toBe("approved");
    expect(awards[0].approved_at).toBe(NOW);
    // The award cites the fact that caused it.
    expect(awards[0].source_event_id).toBeGreaterThan(0);
  });

  it("pays NOTHING extra when the subscriber re-runs over the same events", () => {
    campaign();
    saleApproved(1);
    S.drain(NOW);
    // Simulate a crash between the write and the cursor advance.
    E.resetCursor(S.SUBSCRIBER_NAME, 0, NOW);
    const replay = S.drain(NOW);

    expect(replay.awarded).toBe(0);
    expect(awardsFor(REP)).toHaveLength(1);
  });

  it("pays nothing extra when the same event is emitted twice", () => {
    campaign();
    saleApproved(1);
    saleApproved(1);   // a retry — collapses in the event log
    S.drain(NOW);
    expect(awardsFor(REP)).toHaveLength(1);
  });

  it("lets TWO campaigns both pay for one event", () => {
    campaign({ name: "Provider spiff" });
    campaign({ name: "Territory push", rewardCents: 2_500 });
    saleApproved(1);
    S.drain(NOW);

    const awards = awardsFor(REP);
    expect(awards).toHaveLength(2);
    expect(awards.reduce((a, r) => a + r.amount_cents, 0)).toBe(10_000);
  });
});

describe("amount bases", () => {
  it("pays a percentage of the event's own amount, to the cent", () => {
    campaign({ amountBasis: "PERCENT", percentageBp: 825, rewardCents: 0 });
    saleApproved(1, { saleAmountCents: 123_456 });
    S.drain(NOW);
    // 8.25% of $1,234.56 = $101.85 — an integer basis-point multiply, rounded
    // once, so it is the same number on every machine.
    expect(awardsFor(REP)[0].amount_cents).toBe(10_185);
  });

  it("passes an already-computed amount through unchanged", () => {
    campaign({ incentiveType: "MILEAGE_REIMBURSEMENT", amountBasis: "PASSTHROUGH", rewardCents: 0 });
    E.emit({
      tenantId: T1, type: "MILEAGE_APPROVED", subjectType: "mileage_trip", subjectId: 5,
      subjectRepId: REP, occurredAt: NOW, payload: { reimbursementCents: 808 },
    }, NOW);
    S.drain(NOW);
    expect(awardsFor(REP)[0].amount_cents).toBe(808);
  });

  it("pays nothing when a passthrough amount is zero", () => {
    // A trip approved while the org's reimbursement switch is off carries zero.
    campaign({ incentiveType: "MILEAGE_REIMBURSEMENT", amountBasis: "PASSTHROUGH", rewardCents: 0 });
    E.emit({
      tenantId: T1, type: "MILEAGE_APPROVED", subjectType: "mileage_trip", subjectId: 5,
      subjectRepId: REP, occurredAt: NOW, payload: { reimbursementCents: 0 },
    }, NOW);
    S.drain(NOW);
    expect(awardsFor(REP)).toHaveLength(0);
  });
});

describe("filters, caps, and explained skips", () => {
  it("only pays on the configured provider", () => {
    campaign({ filters: { providers: ["kinetic"] } });
    // Ids come from the emitted rows: the table is AUTOINCREMENT and the
    // sequence survives the DELETE between tests.
    const wrongProvider = saleApproved(1, { provider: "other" });
    saleApproved(2, { provider: "kinetic" });
    S.drain(NOW);

    expect(awardsFor(REP)).toHaveLength(1);
    const skipped = S.evaluationsForEvent(T1, wrongProvider.id) as any[];
    expect(skipped[0].skipReason).toBe("filter_provider");
  });

  it("records WHY nobody was paid, so the question is answerable later", () => {
    campaign({ ...WINDOW, startsAtMs: NOW_MS + 60_000, endsAtMs: NOW_MS + 120_000 });
    const event = saleApproved(1);
    S.drain(NOW);

    const evaluations = S.evaluationsForEvent(T1, event.id) as any[];
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].awarded).toBe(0);
    expect(evaluations[0].skipReason).toBe("window_closed");
  });

  it("caps the NUMBER of awards per person", () => {
    campaign({ maximumRewardsPerUser: 2 });
    saleApproved(1); saleApproved(2); saleApproved(3);
    S.drain(NOW);
    expect(awardsFor(REP)).toHaveLength(2);
  });

  it("TRIMS to the rep cap rather than suppressing the award", () => {
    // A rep $25 from their cap should earn that $25, not nothing.
    campaign({ perRepCapCents: 10_000 });
    saleApproved(1);
    S.drain(NOW);
    saleApproved(2);
    S.drain(NOW);

    const awards = awardsFor(REP);
    expect(awards.map(a => a.amount_cents)).toEqual([7_500, 2_500]);
  });

  it("stops at the campaign's whole liability ceiling", () => {
    campaign({ campaignCapCents: 7_500 });
    saleApproved(1);
    S.drain(NOW);
    const second = saleApproved(2);
    S.drain(NOW);

    expect(awardsFor(REP).reduce((a, r) => a + r.amount_cents, 0)).toBe(7_500);
    const evaluations = S.evaluationsForEvent(T1, second.id) as any[];
    expect(evaluations[0].skipReason).toBe("campaign_cap_reached");
  });

  it("fires FIRST_SALE only on the first", () => {
    campaign({ incentiveType: "FIRST_SALE", rewardCents: 5_000 });
    saleApproved(1, { lifetimeSaleNumber: 1 });
    saleApproved(2, { lifetimeSaleNumber: 2 });
    S.drain(NOW);
    expect(awardsFor(REP)).toHaveLength(1);
  });

  it("ignores an event no campaign waits for", () => {
    campaign({ incentiveType: "TRAINING_COMPLETION" });
    saleApproved(1);
    S.drain(NOW);
    expect(awardsFor(REP)).toHaveLength(0);
  });
});

describe("a referral reward pays the REFERRER", () => {
  function qualifiedReferral() {
    rawDb.prepare(
      `INSERT OR REPLACE INTO users (id, name, email, role, tenant_id, team_member_id, active, created_at)
       VALUES (?,?,?,'rep',?,?,1,datetime('now'))`,
    ).run(200, "ref@example.com", "ref@example.com", T1, REFERRER);
    R.setConfig(T1, { enabled: true }, NOW);
    const link = R.ensureLink({ tenantId: T1, referrerUserId: 200, referrerRepId: REFERRER, baseUrl: "https://app.test", nowIso: NOW });
    const { referral } = R.attributeApplication({
      tenantId: T1, linkCode: link.code, applicantEmail: "newhire@example.com", nowIso: NOW,
    });
    R.markHired({ tenantId: T1, referralId: referral!.id, referredRepId: REFERRED, referredUserId: 201, nowIso: NOW });
    R.markActivated({ tenantId: T1, referralId: referral!.id, nowIso: NOW });
    rawDb.prepare(
      `INSERT INTO app_settings (tenant_id, key, value, updated_at) VALUES (?,?,?,datetime('now'))
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
    ).run(T1, "training.required_lessons", "1");
    rawDb.prepare(
      `INSERT OR IGNORE INTO training_progress (tenant_id, user_id, lesson_id, completed_at) VALUES (?,?,?,?)`,
    ).run(T1, 201, "lesson-0", NOW);
    for (let i = 0; i < 6; i += 1) {
      rawDb.prepare(
        `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, created_at, updated_at)
         VALUES (?,?,?,'QUALIFIED',?,?,?)`,
      ).run(T1, REFERRED, `s-${i}`, NOW, NOW, NOW);
    }
    R.recheckQualification({ tenantId: T1, referralId: referral!.id, nowIso: NOW });
    return referral!.id;
  }

  it("pays $500 to the referrer, not to the referred rep", () => {
    campaign({ incentiveType: "REFERRAL_REWARD", rewardCents: 50_000 });
    const referralId = qualifiedReferral();
    S.drain(NOW);

    // The event is ABOUT the referred rep; the money goes to the referrer.
    expect(awardsFor(REFERRED)).toHaveLength(0);
    const awards = awardsFor(REFERRER);
    expect(awards).toHaveLength(1);
    expect(awards[0].amount_cents).toBe(50_000);
    expect(awards[0].incentive_type).toBe("REFERRAL_REWARD");

    // And the referral row points back at the money.
    expect(R.getReferral(T1, referralId)!.rewardLedgerId).toBe(awards[0].id);
  });

  it("pays it once, even across repeated drains", () => {
    campaign({ incentiveType: "REFERRAL_REWARD", rewardCents: 50_000 });
    qualifiedReferral();
    S.drain(NOW);
    E.resetCursor(S.SUBSCRIBER_NAME, 0, NOW);
    S.drain(NOW);
    expect(awardsFor(REFERRER)).toHaveLength(1);
  });
});

describe("clawback", () => {
  it("appends a NEGATIVE row rather than editing the original", () => {
    campaign();
    saleApproved(1);
    S.drain(NOW);

    E.emit({
      tenantId: T1, type: "SALE_CANCELLED", subjectType: "sale", subjectId: 1,
      subjectRepId: REP, occurredAt: NOW,
    }, NOW);
    const result = S.drain(NOW);

    expect(result.reversed).toBe(1);
    const awards = awardsFor(REP);
    expect(awards).toHaveLength(2);
    // The original stays visible — a rep who earned $75 and lost it is owed
    // both lines, not a silently different number.
    expect(awards[0].amount_cents).toBe(7_500);
    expect(awards[1].amount_cents).toBe(-7_500);
    expect(awards.reduce((a, r) => a + r.amount_cents, 0)).toBe(0);
  });

  it("reverses once, however many times the cancellation is replayed", () => {
    campaign();
    saleApproved(1);
    S.drain(NOW);
    E.emit({
      tenantId: T1, type: "SALE_CANCELLED", subjectType: "sale", subjectId: 1,
      subjectRepId: REP, occurredAt: NOW,
    }, NOW);
    S.drain(NOW);
    E.resetCursor(S.SUBSCRIBER_NAME, 0, NOW);
    S.drain(NOW);

    expect(awardsFor(REP).filter(a => a.amount_cents < 0)).toHaveLength(1);
  });

  it("does NOT reverse outside the campaign's clawback window", () => {
    campaign({ clawbackPolicy: { enabled: true, windowDays: 30, mode: "FULL" } });
    saleApproved(1);
    S.drain(NOW);

    const muchLater = "2026-12-01T12:00:00.000Z";
    E.emit({
      tenantId: T1, type: "SALE_CANCELLED", subjectType: "sale", subjectId: 1,
      subjectRepId: REP, occurredAt: muchLater,
    }, muchLater);
    S.drain(muchLater);

    expect(awardsFor(REP).filter(a => a.amount_cents < 0)).toHaveLength(0);
  });

  it("never reverses when a campaign disables clawback", () => {
    campaign({ clawbackPolicy: { enabled: false, windowDays: 0, mode: "FULL" } });
    saleApproved(1);
    S.drain(NOW);
    E.emit({
      tenantId: T1, type: "SALE_CANCELLED", subjectType: "sale", subjectId: 1,
      subjectRepId: REP, occurredAt: NOW,
    }, NOW);
    S.drain(NOW);
    expect(awardsFor(REP)).toHaveLength(1);
  });
});

describe("one owner per earning", () => {
  it("does NOT write an earnings row for money another store already owns", async () => {
    // A mileage campaign still writes a spiff (that is the rail the money takes
    // to the statement), but mileageStore already wrote the earnings row when it
    // decided the amount. Both writing produces two rows for one debt under two
    // different idempotency keys — which no constraint can catch, because the
    // database cannot tell they are the same money.
    const L = await import("../../server/earningsLedgerStore");
    campaign({ incentiveType: "MILEAGE_REIMBURSEMENT", amountBasis: "PASSTHROUGH", rewardCents: 0 });
    E.emit({
      tenantId: T1, type: "MILEAGE_APPROVED", subjectType: "mileage_trip", subjectId: 5,
      subjectRepId: REP, occurredAt: NOW, payload: { reimbursementCents: 808 },
    }, NOW);
    S.drain(NOW);

    expect(awardsFor(REP)).toHaveLength(1);                       // the payment rail
    expect(L.listEarnings(T1, { repIds: [REP] })).toHaveLength(0); // no engine mirror
  });

  it("DOES write one for money the engine itself decided", async () => {
    const L = await import("../../server/earningsLedgerStore");
    campaign({ incentiveType: "PRODUCT_SPIFF", rewardCents: 7_500 });
    saleApproved(1);
    S.drain(NOW);

    const earnings = L.listEarnings(T1, { repIds: [REP] });
    expect(earnings).toHaveLength(1);
    expect(earnings[0].earningType).toBe("SPIFF");
    expect(earnings[0].netCents).toBe(7_500);
  });
});

describe("cursor discipline", () => {
  it("advances only past events it processed", () => {
    campaign();
    saleApproved(1);
    saleApproved(2);
    const result = S.drain(NOW);
    expect(result.processed).toBe(2);
    expect(E.cursorFor(S.SUBSCRIBER_NAME)).toBe(result.lastEventId);
    // A second drain finds nothing.
    expect(S.drain(NOW).processed).toBe(0);
  });

  it("does not pay another org's campaign", () => {
    campaign();
    E.emit({
      tenantId: 2, type: "SALE_APPROVED", subjectType: "sale", subjectId: 99,
      subjectRepId: REP, occurredAt: NOW,
    }, NOW);
    S.drain(NOW);
    expect(awardsFor(REP)).toHaveLength(0);
  });
});
