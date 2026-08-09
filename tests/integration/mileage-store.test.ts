import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mayStartGpsTrip, maySampleInBackground, mayChangeOwnConsent } from "@shared/mileage";

/**
 * mileageStore against a real temp DB. The properties that matter:
 *
 *   * an APPROVED trip is frozen — the edit path refuses and a correction
 *     becomes an append-only adjustment the reads fold in;
 *   * approval FREEZES the rate from the trip's own date, so a later rate
 *     change cannot re-price it;
 *   * money is gated: with reimbursement off, an org's payable total is zero
 *     no matter how many trips are approved;
 *   * approving and submitting each emit exactly one domain event, inside the
 *     same transaction as the status change.
 */
let M: typeof import("../../server/mileageStore");
let E: typeof import("../../server/domainEventStore");
let rawDb: import("better-sqlite3").Database;

const T1 = 1, REP = 10, OTHER_REP = 11, MGR_USER = 99;
const NOW = "2026-08-06T17:00:00.000Z";
const TODAY = "2026-08-06";

function makeTrip(over: Partial<Parameters<typeof M.createTrip>[0]> = {}) {
  return M.createTrip({
    tenantId: T1, repId: REP, userId: 1,
    tripDate: TODAY, startLocation: "123 Main St", endLocation: "456 Oak Ave",
    milesHundredths: 1234, purpose: "Door knocking - Oakwood", source: "MANUAL",
    nowIso: NOW, todayIso: TODAY, ...over,
  });
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-mileage-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  M = await import("../../server/mileageStore");
  E = await import("../../server/domainEventStore");
});

beforeEach(() => {
  rawDb.prepare("DELETE FROM mileage_location_consent").run();
  rawDb.exec("DROP TRIGGER IF EXISTS mileage_adjustments_no_delete");
  rawDb.exec("DROP TRIGGER IF EXISTS domain_events_no_delete");
  rawDb.prepare("DELETE FROM mileage_adjustments").run();
  rawDb.prepare("DELETE FROM mileage_trips").run();
  rawDb.prepare("DELETE FROM mileage_rates").run();
  rawDb.prepare("DELETE FROM domain_events").run();
  rawDb.prepare("DELETE FROM app_settings WHERE key IN ('mileage.reimbursement_enabled','mileage.gps_policy')").run();
  M.ensureMileageSchema();
  E.ensureDomainEventSchema();
  M.addRate({ tenantId: T1, rateMilliCentsPerMile: 65_500, effectiveFrom: "2026-07-01", nowIso: NOW });
});

describe("creating trips", () => {
  it("stores integer hundredths and starts as a DRAFT", () => {
    const t = makeTrip();
    expect(t.milesHundredths).toBe(1234);
    expect(t.status).toBe("DRAFT");
    // Nothing is priced until approval — a pending trip must not display a
    // number the org has not agreed to.
    expect(t.reimbursementCents).toBeNull();
  });

  it("rejects an invalid trip rather than storing it", () => {
    expect(() => makeTrip({ purpose: "  " })).toThrow(/INVALID_TRIP/);
    expect(() => makeTrip({ tripDate: "2026-08-07" })).toThrow(/future/);
  });

  it("is idempotent on clientId - an offline replay returns the same trip", () => {
    const a = makeTrip({ clientId: "abc-123" });
    const b = makeTrip({ clientId: "abc-123" });
    expect(b.id).toBe(a.id);
    const n = rawDb.prepare("SELECT COUNT(*) c FROM mileage_trips").get() as any;
    expect(n.c).toBe(1);
  });

  it("allows only ONE open GPS trip per rep", () => {
    makeTrip({ milesHundredths: 0, startedAt: NOW, source: "GPS", endLocation: null });
    expect(() => makeTrip({ milesHundredths: 0, startedAt: NOW, source: "GPS", endLocation: null }))
      .toThrow(/UNIQUE/i);
  });
});

describe("approval freezes the money", () => {
  it("prices from the rate effective on the TRIP date and freezes it", () => {
    const t = makeTrip();
    M.transitionTrip({ tenantId: T1, id: t.id, to: "SUBMITTED", nowIso: NOW });
    const approved = M.transitionTrip({ tenantId: T1, id: t.id, to: "APPROVED", actorUserId: MGR_USER, nowIso: NOW });

    expect(approved.status).toBe("APPROVED");
    expect(approved.rateMilliCentsPerMile).toBe(65_500);
    expect(approved.reimbursementCents).toBe(808); // 12.34 mi × $0.655

    // A later rate change must not touch it.
    M.addRate({ tenantId: T1, rateMilliCentsPerMile: 90_000, effectiveFrom: "2026-08-01", nowIso: NOW });
    expect(M.getTrip(T1, t.id)!.reimbursementCents).toBe(808);
  });

  it("approves at zero when the org never set a rate", () => {
    rawDb.prepare("DELETE FROM mileage_rates").run();
    const t = makeTrip();
    M.transitionTrip({ tenantId: T1, id: t.id, to: "SUBMITTED", nowIso: NOW });
    const approved = M.transitionTrip({ tenantId: T1, id: t.id, to: "APPROVED", nowIso: NOW });
    // Zero, explicitly — never a guessed federal figure.
    expect(approved.reimbursementCents).toBe(0);
    expect(approved.rateMilliCentsPerMile).toBeNull();
  });

  it("uses a trip's OWN date, so back-dated trips price at the old rate", () => {
    M.addRate({ tenantId: T1, rateMilliCentsPerMile: 62_500, effectiveFrom: "2026-01-01", nowIso: NOW });
    const t = makeTrip({ tripDate: "2026-03-15" });
    M.transitionTrip({ tenantId: T1, id: t.id, to: "SUBMITTED", nowIso: NOW });
    const approved = M.transitionTrip({ tenantId: T1, id: t.id, to: "APPROVED", nowIso: NOW });
    expect(approved.rateMilliCentsPerMile).toBe(62_500);
  });
});

describe("locking and corrections", () => {
  function approved() {
    const t = makeTrip();
    M.transitionTrip({ tenantId: T1, id: t.id, to: "SUBMITTED", nowIso: NOW });
    return M.transitionTrip({ tenantId: T1, id: t.id, to: "APPROVED", nowIso: NOW });
  }

  it("refuses to edit an approved trip", () => {
    const t = approved();
    expect(() => M.patchTrip(T1, t.id, { milesHundredths: 9999 }, NOW)).toThrow("MILEAGE_LOCKED");
    expect(() => M.softDeleteTrip(T1, t.id, NOW)).toThrow("MILEAGE_LOCKED");
  });

  it("records a correction as an append-only adjustment the reads fold in", () => {
    const t = approved();
    const corrected = M.addAdjustment({
      tenantId: T1, tripId: t.id, milesHundredthsDelta: -234,
      reason: "Rep logged the round trip; only one leg was business",
      actorUserId: MGR_USER, nowIso: NOW,
    });
    // The original stays visible; the delta is separate.
    expect(corrected.milesHundredths).toBe(1234);
    expect(corrected.adjustmentMilesHundredths).toBe(-234);
    // Money derives from the rate FROZEN on the trip, never today's.
    expect(corrected.adjustmentCents).toBe(-153); // 2.34 mi × $0.655
  });

  it("refuses an empty or unexplained correction", () => {
    const t = approved();
    expect(() => M.addAdjustment({ tenantId: T1, tripId: t.id, reason: "", nowIso: NOW })).toThrow(/REASON_REQUIRED/);
    expect(() => M.addAdjustment({ tenantId: T1, tripId: t.id, reason: "typo", nowIso: NOW })).toThrow(/EMPTY/);
  });

  it("the database refuses to edit or delete a correction", () => {
    const t = approved();
    M.addAdjustment({ tenantId: T1, tripId: t.id, centsDelta: -100, reason: "fix", nowIso: NOW });
    const id = (rawDb.prepare("SELECT id FROM mileage_adjustments LIMIT 1").get() as any).id;
    expect(() => rawDb.prepare("UPDATE mileage_adjustments SET cents_delta = 0 WHERE id = ?").run(id))
      .toThrow(/append-only/);
  });

  it("refuses an illegal status change", () => {
    const t = approved();
    expect(() => M.transitionTrip({ tenantId: T1, id: t.id, to: "DRAFT", nowIso: NOW }))
      .toThrow(/MILEAGE_BAD_TRANSITION/);
  });

  it("refuses to submit a trip with no distance", () => {
    const t = makeTrip({ milesHundredths: 0, startedAt: NOW, source: "GPS", endLocation: null });
    expect(() => M.transitionTrip({ tenantId: T1, id: t.id, to: "SUBMITTED", nowIso: NOW }))
      .toThrow("MILEAGE_NO_DISTANCE");
  });
});

describe("rates are append-only", () => {
  it("the database refuses to edit a rate row", () => {
    const id = (rawDb.prepare("SELECT id FROM mileage_rates LIMIT 1").get() as any).id;
    expect(() => rawDb.prepare("UPDATE mileage_rates SET rate_millicents_per_mile = 1 WHERE id = ?").run(id))
      .toThrow(/append-only/);
  });

  it("lets a same-day typo be replaced but never rewrites another date", () => {
    M.addRate({ tenantId: T1, rateMilliCentsPerMile: 70_000, effectiveFrom: "2026-07-01", nowIso: NOW });
    const rates = M.listRates(T1);
    expect(rates.filter(r => r.effectiveFrom === "2026-07-01")).toHaveLength(1);
    expect(M.rateForDate(T1, "2026-07-05")?.rateMilliCentsPerMile).toBe(70_000);
  });
});

describe("the money gate", () => {
  it("pays nothing while reimbursement is off, however many trips are approved", () => {
    const t = makeTrip();
    M.transitionTrip({ tenantId: T1, id: t.id, to: "SUBMITTED", nowIso: NOW });
    M.transitionTrip({ tenantId: T1, id: t.id, to: "APPROVED", nowIso: NOW });

    expect(M.reimbursementEnabled(T1)).toBe(false);
    expect(M.payableMileageCents(T1, REP, "2026-01-01", "2026-12-31")).toEqual({
      cents: 0, milesHundredths: 0, tripCount: 0,
    });
  });

  it("pays once an operator turns it on", () => {
    const t = makeTrip();
    M.transitionTrip({ tenantId: T1, id: t.id, to: "SUBMITTED", nowIso: NOW });
    M.transitionTrip({ tenantId: T1, id: t.id, to: "APPROVED", nowIso: NOW });
    M.setReimbursementEnabled(T1, true, NOW);

    const payable = M.payableMileageCents(T1, REP, "2026-01-01", "2026-12-31");
    expect(payable).toEqual({ cents: 808, milesHundredths: 1234, tripCount: 1 });
  });

  it("folds corrections into the payable total", () => {
    const t = makeTrip();
    M.transitionTrip({ tenantId: T1, id: t.id, to: "SUBMITTED", nowIso: NOW });
    M.transitionTrip({ tenantId: T1, id: t.id, to: "APPROVED", nowIso: NOW });
    M.addAdjustment({ tenantId: T1, tripId: t.id, centsDelta: -108, reason: "partial personal use", nowIso: NOW });
    M.setReimbursementEnabled(T1, true, NOW);

    expect(M.payableMileageCents(T1, REP, "2026-01-01", "2026-12-31").cents).toBe(700);
  });
});

describe("events", () => {
  it("emits MILEAGE_APPROVED once, carrying the frozen money", () => {
    const t = makeTrip();
    M.transitionTrip({ tenantId: T1, id: t.id, to: "SUBMITTED", nowIso: NOW });
    M.transitionTrip({ tenantId: T1, id: t.id, to: "APPROVED", actorUserId: MGR_USER, nowIso: NOW });

    const events = E.eventsForSubject(T1, "mileage_trip", t.id);
    expect(events.map(e => e.type)).toEqual(["MILEAGE_SUBMITTED", "MILEAGE_APPROVED"]);
    const approvedEvent = events[1];
    expect(approvedEvent.subjectRepId).toBe(REP);
    expect(approvedEvent.payload).toMatchObject({ reimbursementCents: 808, reimbursementEnabled: false });
  });

  it("keeps a resubmission after a rejection as a SEPARATE event", () => {
    const t = makeTrip();
    M.transitionTrip({ tenantId: T1, id: t.id, to: "SUBMITTED", nowIso: NOW, submitAttempt: 1 });
    M.transitionTrip({ tenantId: T1, id: t.id, to: "REJECTED", reason: "no purpose given", nowIso: NOW });
    M.transitionTrip({ tenantId: T1, id: t.id, to: "DRAFT", nowIso: NOW });
    M.transitionTrip({ tenantId: T1, id: t.id, to: "SUBMITTED", nowIso: NOW, submitAttempt: 2 });

    // A collapsed second submission is a trip that never reaches the queue.
    const submits = E.eventsForSubject(T1, "mileage_trip", t.id).filter(e => e.type === "MILEAGE_SUBMITTED");
    expect(submits).toHaveLength(2);
  });
});

describe("each rep controls their own location tracking", () => {
  const REP_USER = 1, OTHER_USER = 2;

  it("starts OFF for everyone - consent is never assumed", () => {
    const consent = M.getConsent(T1, REP_USER);
    expect(consent.disclosureAcceptedAt).toBeNull();
    expect(consent.backgroundOptIn).toBe(false);
    expect(mayStartGpsTrip(consent)).toBe(false);
  });

  it("turns ON and STORES the choice", () => {
    M.setConsent({
      tenantId: T1, userId: REP_USER, accepted: true, backgroundOptIn: false,
      version: "2026-08-06.1", nowIso: NOW,
    });
    const consent = M.getConsent(T1, REP_USER);
    expect(consent.disclosureAcceptedAt).toBe(NOW);
    expect(consent.disclosureVersion).toBe("2026-08-06.1");
    expect(mayStartGpsTrip(consent)).toBe(true);
    // Persisted, not session state: a later read on a fresh request sees it.
    expect(M.getConsent(T1, REP_USER).disclosureAcceptedAt).toBe(NOW);
  });

  it("turns OFF again, and the OFF state is stored too", () => {
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: true, backgroundOptIn: true, version: "v1", nowIso: NOW });
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: false, backgroundOptIn: false, version: "v1", nowIso: NOW });

    const consent = M.getConsent(T1, REP_USER);
    expect(consent.disclosureAcceptedAt).toBeNull();
    expect(consent.revokedAt).toBe(NOW);
    // Revoking clears BOTH flags: a worker who withdrew permission must not be
    // left with background sampling still notionally allowed.
    expect(consent.backgroundOptIn).toBe(false);
    expect(mayStartGpsTrip(consent)).toBe(false);
  });

  it("can be turned back on after being revoked", () => {
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: true, backgroundOptIn: false, version: "v1", nowIso: NOW });
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: false, backgroundOptIn: false, version: "v1", nowIso: NOW });
    const later = "2026-08-07T09:00:00.000Z";
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: true, backgroundOptIn: false, version: "v1", nowIso: later });

    const consent = M.getConsent(T1, REP_USER);
    expect(consent.revokedAt).toBeNull();
    expect(consent.disclosureAcceptedAt).toBe(later);
  });

  it("keeps background sampling as a SEPARATE stored choice", () => {
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: true, backgroundOptIn: false, version: "v1", nowIso: NOW });
    expect(M.getConsent(T1, REP_USER).backgroundOptIn).toBe(false);

    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: true, backgroundOptIn: true, version: "v1", nowIso: NOW });
    expect(M.getConsent(T1, REP_USER).backgroundOptIn).toBe(true);

    // …and it only applies during an OPEN trip, never as continuous tracking.
    const consent = M.getConsent(T1, REP_USER);
    expect(maySampleInBackground(consent, true)).toBe(true);
    expect(maySampleInBackground(consent, false)).toBe(false);
  });

  it("is PER REP - one rep's choice never speaks for another", () => {
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: true, backgroundOptIn: true, version: "v1", nowIso: NOW });
    expect(M.getConsent(T1, OTHER_USER).disclosureAcceptedAt).toBeNull();
    expect(M.getConsent(T1, OTHER_USER).backgroundOptIn).toBe(false);
  });

  it("does not leak a rep's consent across orgs", () => {
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: true, backgroundOptIn: true, version: "v1", nowIso: NOW });
    expect(M.getConsent(2, REP_USER).disclosureAcceptedAt).toBeNull();
  });

  it("leaves manual logging fully available with tracking off", () => {
    // Turning location off must never cost a rep the ability to claim mileage.
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: false, backgroundOptIn: false, version: "v1", nowIso: NOW });
    const t = makeTrip({ userId: REP_USER });
    expect(t.status).toBe("DRAFT");
    expect(t.milesHundredths).toBe(1234);
  });
});

describe("an admin can lock and unlock tracking", () => {
  const REP_USER = 1, ADMIN_USER = 77;

  it("defaults to REP_CHOICE - the org has not taken the decision away", () => {
    expect(M.getGpsPolicy(T1)).toBe("REP_CHOICE");
  });

  it("LOCKED_OFF withdraws GPS from everyone, even a rep who already consented", () => {
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: true, backgroundOptIn: true, version: "v1", nowIso: NOW });
    M.setGpsPolicy(T1, "LOCKED_OFF", NOW);

    const consent = M.getConsent(T1, REP_USER);
    // The stored consent is NOT destroyed — lifting the lock the same afternoon
    // should not force everyone to re-consent.
    expect(consent.disclosureAcceptedAt).not.toBeNull();
    // …but it grants nothing while the lock is in force.
    expect(mayStartGpsTrip(consent, "LOCKED_OFF")).toBe(false);
    expect(mayChangeOwnConsent(consent, "LOCKED_OFF")).toBe(false);
  });

  it("refuses a rep who tries to opt in while the org has GPS off", () => {
    M.setGpsPolicy(T1, "LOCKED_OFF", NOW);
    expect(() => M.setConsent({
      tenantId: T1, userId: REP_USER, accepted: true, backgroundOptIn: false, version: "v1", nowIso: NOW,
    })).toThrow("MILEAGE_GPS_LOCKED_OFF");
  });

  it("unlocking restores the rep's own stored choice", () => {
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: true, backgroundOptIn: false, version: "v1", nowIso: NOW });
    M.setGpsPolicy(T1, "LOCKED_OFF", NOW);
    M.setGpsPolicy(T1, "REP_CHOICE", NOW);

    expect(mayStartGpsTrip(M.getConsent(T1, REP_USER), M.getGpsPolicy(T1))).toBe(true);
  });

  it("pins ONE rep's setting where it stands", () => {
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: true, backgroundOptIn: false, version: "v1", nowIso: NOW });
    M.setConsentLock({ tenantId: T1, userId: REP_USER, locked: true, actorUserId: ADMIN_USER, nowIso: NOW });

    const consent = M.getConsent(T1, REP_USER);
    expect(consent.adminLocked).toBe(true);
    expect(mayChangeOwnConsent(consent, "REP_CHOICE")).toBe(false);
    // The rep can no longer move it in either direction.
    expect(() => M.setConsent({
      tenantId: T1, userId: REP_USER, accepted: false, backgroundOptIn: false, version: "v1", nowIso: NOW,
    })).toThrow("MILEAGE_CONSENT_LOCKED");
  });

  it("a lock NEVER turns tracking on for someone who never agreed", () => {
    // The asymmetry that makes this safe: an administrator cannot consent on
    // another person's behalf, so locking an un-consented worker pins them OFF.
    M.setConsentLock({ tenantId: T1, userId: REP_USER, locked: true, actorUserId: ADMIN_USER, nowIso: NOW });
    const consent = M.getConsent(T1, REP_USER);
    expect(consent.adminLocked).toBe(true);
    expect(consent.disclosureAcceptedAt).toBeNull();
    expect(mayStartGpsTrip(consent, "REP_CHOICE")).toBe(false);
  });

  it("unlocking hands the choice back", () => {
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: true, backgroundOptIn: false, version: "v1", nowIso: NOW });
    M.setConsentLock({ tenantId: T1, userId: REP_USER, locked: true, actorUserId: ADMIN_USER, nowIso: NOW });
    M.setConsentLock({ tenantId: T1, userId: REP_USER, locked: false, actorUserId: ADMIN_USER, nowIso: NOW });

    expect(M.getConsent(T1, REP_USER).adminLocked).toBe(false);
    M.setConsent({ tenantId: T1, userId: REP_USER, accepted: false, backgroundOptIn: false, version: "v1", nowIso: NOW });
    expect(M.getConsent(T1, REP_USER).disclosureAcceptedAt).toBeNull();
  });

  it("locking is per rep and per org", () => {
    M.setConsentLock({ tenantId: T1, userId: REP_USER, locked: true, actorUserId: ADMIN_USER, nowIso: NOW });
    expect(M.getConsent(T1, 2).adminLocked).toBe(false);
    expect(M.getGpsPolicy(2)).toBe("REP_CHOICE");
  });

  it("leaves manual logging available under every lock", () => {
    // Whatever an admin does to GPS, a rep can still claim the miles they drove.
    M.setGpsPolicy(T1, "LOCKED_OFF", NOW);
    M.setConsentLock({ tenantId: T1, userId: REP_USER, locked: true, actorUserId: ADMIN_USER, nowIso: NOW });
    expect(makeTrip({ userId: REP_USER }).milesHundredths).toBe(1234);
  });
});

describe("tenant isolation and scoping", () => {
  it("never returns another org's trip", () => {
    const t = makeTrip();
    expect(M.getTrip(2, t.id)).toBeNull();
    expect(M.listTrips(2, { repIds: [REP] })).toEqual([]);
  });

  it("an EMPTY rep scope returns nothing, not everything", () => {
    makeTrip();
    // The classic inversion: treating "no reps in scope" as "unscoped" is how a
    // rep ends up reading the whole org.
    expect(M.listTrips(T1, { repIds: [] })).toEqual([]);
    expect(M.listTrips(T1, { repIds: [OTHER_REP] })).toEqual([]);
    expect(M.listTrips(T1, { repIds: [REP] })).toHaveLength(1);
  });

  it("excludes soft-deleted trips from every read", () => {
    const t = makeTrip();
    M.softDeleteTrip(T1, t.id, NOW);
    expect(M.getTrip(T1, t.id)).toBeNull();
    expect(M.listTrips(T1, { repIds: [REP] })).toEqual([]);
  });
});
