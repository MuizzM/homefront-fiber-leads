// Classification projection, evidence history and lead promotion, end to end
// against a real database.
//
// The invariant under test throughout: a door becomes a workable lead ONLY by
// being classified confirmed_2026, and the only way to be classified
// confirmed_2026 is a conclusive authorized qualification plus dated evidence
// that the address was unserved before 2026. Everything else - a filing, a
// half-built block, a construction sighting, an announcement - lands on the
// map as a candidate and mints nothing.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

let store: typeof import("../../server/kineticBuildStore");
let fcc: typeof import("../../server/fccImportStore");
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

const TENANT = 1;
const WIN = "130623";
/** A Rowan block Kinetic had NOT touched as of D25, and one it fully covers. */
const BLOCK_EMPTY = "371590501001000";
const BLOCK_COVERED = "371590501001001";
/** Kinetic added part of this block through D25 - the leading edge. */
const BLOCK_PARTIAL = "371590501001002";

const NOW = Date.now();
const daysAgo = (n: number) => NOW - n * 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let addrSeq = 1000;
function identity(over: Partial<import("../../server/kineticBuildStore").AddressIdentity> = {}) {
  return {
    tenantId: TENANT,
    address: `${addrSeq++} Fiber Way`,
    city: "Salisbury", state: "NC", zip: "28144",
    lat: 35.6707, lng: -80.4742,
    blockGeoid: BLOCK_EMPTY,
    ...over,
  };
}

/** Conclusive "fiber is live here, nobody is subscribed". */
const LIVE = { isFiberLive: true as const, conclusive: true, billingStatus: "N", maxDownMbps: 1000 };

function seedVintage(vintage: string, blocks: Record<string, number>) {
  const rows = Object.entries(blocks).flatMap(([blockGeoid, n]) =>
    Array.from({ length: n }, (_, i) => ({
      locationId: `${vintage}-${blockGeoid}-${i}`,
      blockGeoid, providerId: WIN, technology: 50, brCode: "R",
      maxDownMbps: 1000, maxUpMbps: 1000,
    })));
  const job = fcc.openImport({
    tenantId: TENANT, vintage, providerIds: [WIN],
    manifest: `seed-${vintage}`, expectedChunkCount: 1, expectedRowCount: rows.length,
  });
  fcc.ingestChunk(job.id, 0, rows);
  fcc.finalizeImport(job.id);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-kbuild-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));
  fcc = await import("../../server/fccImportStore");
  store = await import("../../server/kineticBuildStore");

  // D24 baseline: Kinetic serves BLOCK_COVERED only.
  seedVintage("D24", { [BLOCK_COVERED]: 30 });
  // D25: BLOCK_COVERED unchanged, BLOCK_PARTIAL half lit, BLOCK_EMPTY still dark.
  seedVintage("D25", { [BLOCK_COVERED]: 30, [BLOCK_PARTIAL]: 10 });
  fcc.setBlockDenominators(TENANT, "D25", [
    { blockGeoid: BLOCK_COVERED, totalResidentialLocations: 30 },
    { blockGeoid: BLOCK_PARTIAL, totalResidentialLocations: 24 },
  ]);
});

describe("confirmed 2026 builds", () => {
  it("confirms a live address in a block the FCC showed dark through D25", () => {
    const who = identity();
    const { state, decision } = store.recordAuthorizedObservation({
      identity: who, ...LIVE, observedAtMs: daysAgo(2),
    });
    expect(decision.classification).toBe("confirmed_2026");
    expect(decision.buildYear).toBe(2026);
    expect(state.confidence).toBe("high");
    expect(state.firstConfirmedAt).not.toBeNull();
    expect(state.sources).toContain("fcc_D25_block_absent");
    // No quarter: the window runs from the end of 2025 to now.
    expect(state.quarterWhenProven).toBeNull();
  });

  it("names a quarter once two dated observations bracket one", () => {
    const who = identity();
    store.recordAuthorizedObservation({
      identity: who, isFiberLive: false, conclusive: true, observedAtMs: Date.parse("2026-04-05T00:00:00Z"),
    });
    const { state } = store.recordAuthorizedObservation({
      identity: who, ...LIVE, observedAtMs: Date.parse("2026-05-18T00:00:00Z"),
    });
    expect(state.classification).toBe("confirmed_2026");
    expect(state.quarterWhenProven).toBe("2026Q2");
    expect(state.lastNonFiberAt).toBe(iso(Date.parse("2026-04-05T00:00:00Z")));
  });

  it("keeps the bounds monotonic when observations arrive out of order", () => {
    const who = identity();
    store.recordAuthorizedObservation({ identity: who, ...LIVE, observedAtMs: Date.parse("2026-06-01T00:00:00Z") });
    // A later delivery of an EARLIER live reading must pull first-live back.
    const { state } = store.recordAuthorizedObservation({ identity: who, ...LIVE, observedAtMs: Date.parse("2026-05-01T00:00:00Z") });
    expect(state.firstFiberLiveAt).toBe(iso(Date.parse("2026-05-01T00:00:00Z")));
    // ...and last-verified must NOT go backwards.
    expect(state.lastVerifiedAt).toBe(iso(Date.parse("2026-06-01T00:00:00Z")));
  });

  it("does not let an inconclusive response undo a confirmation", () => {
    const who = identity();
    store.recordAuthorizedObservation({ identity: who, ...LIVE, observedAtMs: daysAgo(3) });
    // A timeout, throttle or schema drift today is a NON-ANSWER, not a
    // retraction. The confirmed verdict has to survive it, or every bad
    // afternoon at the provider would wipe the layer.
    const { state, decision } = store.recordAuthorizedObservation({
      identity: who, isFiberLive: null, conclusive: false, observedAtMs: daysAgo(1),
    });
    expect(decision.classification).toBe("confirmed_2026");
    expect(state.firstFiberLiveAt).not.toBeNull();
    expect(store.reclassify(TENANT, state.canonicalKey).classification).toBe("confirmed_2026");
    // The attempt is still on the record, marked for what it was.
    const history = store.evidenceHistory(state.id);
    expect(history[0].kind).toBe("inconclusive");
    expect(history[0].conclusive).toBe(false);
  });

  it("a conclusive negative DOES retract a confirmation", () => {
    const who = identity();
    store.recordAuthorizedObservation({ identity: who, ...LIVE, observedAtMs: daysAgo(10) });
    const { state } = store.recordAuthorizedObservation({
      identity: who, isFiberLive: false, conclusive: true, observedAtMs: daysAgo(1),
    });
    expect(state.classification).toBe("not_serviceable");
  });
});

describe("what does not confirm", () => {
  it("a live address in a long-covered block is existing_fiber", () => {
    const { state } = store.recordAuthorizedObservation({
      identity: identity({ blockGeoid: BLOCK_COVERED }), ...LIVE, observedAtMs: daysAgo(1),
    });
    expect(state.classification).toBe("existing_fiber");
    expect(state.leadId).toBeNull();
  });

  it("a half-built block yields likely_2026, and no lead", () => {
    const { state } = store.recordFieldObservation({
      identity: identity({ blockGeoid: BLOCK_PARTIAL }),
      observation: { kind: "service_confirmed", observedAtMs: daysAgo(1), verifiedByUserId: null },
    });
    // service_confirmed from the field is not an authorized qualification, so
    // the block statistic is the strongest evidence available.
    expect(state.classification).toBe("likely_2026");
    expect(state.leadId).toBeNull();
  });

  it("a construction sighting is amber, never confirmed", () => {
    const { state, decision } = store.recordFieldObservation({
      identity: identity({ blockGeoid: BLOCK_EMPTY }),
      observation: { kind: "construction", observedAtMs: daysAgo(1), verifiedByUserId: 42 },
    });
    expect(state.classification).toBe("construction_observed");
    expect(decision.leadEligible).toBe(false);
  });

  it("a conclusive negative is not_serviceable", () => {
    const { state } = store.recordAuthorizedObservation({
      identity: identity(), isFiberLive: false, conclusive: true, observedAtMs: daysAgo(1),
    });
    expect(state.classification).toBe("not_serviceable");
  });

  it("suppression outranks a perfect confirmation", () => {
    const { state } = store.recordAuthorizedObservation(
      { identity: identity(), ...LIVE, observedAtMs: daysAgo(1) },
      { suppression: "dnc" },
    );
    expect(state.classification).toBe("suppressed");
    expect(state.suppressionReason).toBe("dnc");
  });

  it("an existing customer outranks a confirmation", () => {
    const { state } = store.recordAuthorizedObservation(
      { identity: identity(), ...LIVE, observedAtMs: daysAgo(1) },
      { existingCustomer: true },
    );
    expect(state.classification).toBe("existing_customer");
  });
});

describe("evidence history", () => {
  it("keeps every observation, including the ones that changed nothing", () => {
    const who = identity();
    store.recordAuthorizedObservation({ identity: who, isFiberLive: false, conclusive: true, observedAtMs: daysAgo(30) });
    store.recordAuthorizedObservation({ identity: who, isFiberLive: null, conclusive: false, observedAtMs: daysAgo(20) });
    store.recordAuthorizedObservation({ identity: who, ...LIVE, observedAtMs: daysAgo(10) });

    const state = store.getBuildState(TENANT, store.canonicalKeyFor(who))!;
    const history = store.evidenceHistory(state.id);
    expect(history.map((h) => h.kind)).toEqual(["fiber_live", "inconclusive", "non_fiber"]);
    expect(history.find((h) => h.kind === "inconclusive")!.conclusive).toBe(false);
    // The newest entry records the verdict it produced.
    expect(history[0].resultingClassification).toBe("confirmed_2026");
  });

  it("collapses a replayed observation instead of duplicating history", () => {
    const who = identity();
    const key = "replay-key-1";
    store.recordAuthorizedObservation({ identity: who, ...LIVE, observedAtMs: daysAgo(5), evidenceKey: key });
    const second = store.recordAuthorizedObservation({ identity: who, ...LIVE, observedAtMs: daysAgo(5), evidenceKey: key });
    expect(second.duplicate).toBe(true);
    const state = store.getBuildState(TENANT, store.canonicalKeyFor(who))!;
    expect(store.evidenceHistory(state.id)).toHaveLength(1);
  });

  it("survives a vintage revert - the verdict downgrades, the history stays", () => {
    const who = identity({ address: "77 Revert Rd" });
    store.recordAuthorizedObservation({ identity: who, ...LIVE, observedAtMs: daysAgo(2) });
    const key = store.canonicalKeyFor(who);
    expect(store.getBuildState(TENANT, key)!.classification).toBe("confirmed_2026");

    // Pull the D25 baseline out from under it. Without the evidence that the
    // block was dark, the build year can no longer be established.
    fcc.revertVintage(TENANT, "D25");
    const after = store.reclassify(TENANT, key);
    expect(after.classification).toBe("existing_fiber");
    const state = store.getBuildState(TENANT, key)!;
    expect(store.evidenceHistory(state.id).length).toBeGreaterThan(0);

    // Restore for the remaining tests.
    seedVintage("D25", { [BLOCK_COVERED]: 30, [BLOCK_PARTIAL]: 10 });
    expect(store.reclassify(TENANT, key).classification).toBe("confirmed_2026");
  });
});

describe("address identity and units", () => {
  it("treats units as distinct premises", () => {
    const base = { tenantId: TENANT, address: "500 Tower Ln", city: "Concord", state: "NC", zip: "28025", lat: 35.4, lng: -80.6, blockGeoid: BLOCK_EMPTY };
    const a = store.ensureBuildState({ ...base, unit: "Apt 4" });
    const b = store.ensureBuildState({ ...base, unit: "Apt 5" });
    const bare = store.ensureBuildState(base);
    expect(new Set([a.id, b.id, bare.id]).size).toBe(3);
  });

  it("folds equivalent unit designators onto one premise", () => {
    const base = { tenantId: TENANT, address: "600 Tower Ln", city: "Concord", state: "NC", zip: "28025", lat: 35.4, lng: -80.6, blockGeoid: BLOCK_EMPTY };
    const apt = store.ensureBuildState({ ...base, unit: "Apt 7" });
    const unit = store.ensureBuildState({ ...base, unit: "Unit 7" });
    const hash = store.ensureBuildState({ ...base, unit: "#7" });
    expect(unit.id).toBe(apt.id);
    expect(hash.id).toBe(apt.id);
  });

  it("does not double a unit already present in the street line", () => {
    expect(store.fullStreet("12 Oak St Apt 4", "Apt 4")).toBe("12 Oak St Apt 4");
    expect(store.fullStreet("12 Oak St", "Apt 4")).toBe("12 Oak St Apt 4");
    expect(store.fullStreet("12 Oak St", null)).toBe("12 Oak St");
  });

  it("never overwrites an expensive geocode with a later blank", () => {
    const who = identity({ address: "900 Geocode Ct", lat: 35.61, lng: -80.49 });
    store.ensureBuildState(who);
    const after = store.ensureBuildState({ ...who, lat: null, lng: null });
    expect(after.lat).toBe(35.61);
    expect(after.lng).toBe(-80.49);
  });

  it("fills a coordinate that was missing", () => {
    const who = identity({ address: "901 Geocode Ct", lat: null, lng: null });
    store.ensureBuildState(who);
    const after = store.ensureBuildState({ ...who, lat: 35.62, lng: -80.48 });
    expect(after.lat).toBe(35.62);
  });
});

describe("lead promotion", () => {
  beforeEach(() => {
    rawDb.prepare(`DELETE FROM leads WHERE tenant_id = ? AND lead_tag = ?`).run(TENANT, store.KINETIC_2026_LEAD_TAG);
    rawDb.prepare(`UPDATE kinetic_build_state SET lead_id = NULL WHERE tenant_id = ?`).run(TENANT);
  });

  it("mints leads for confirmed builds and for nothing else", () => {
    const before = store.buildSummary(TENANT);
    const result = store.promoteConfirmedBuilds(TENANT);
    expect(result.created + result.attached).toBe(before.confirmed_2026 ?? 0);

    const tagged = rawDb.prepare(
      `SELECT COUNT(*) n FROM leads WHERE tenant_id = ? AND lead_tag = ?`,
    ).get(TENANT, store.KINETIC_2026_LEAD_TAG) as any;
    expect(tagged.n).toBe(before.confirmed_2026 ?? 0);

    // Nothing that is not confirmed acquired a lead.
    const leaked = rawDb.prepare(
      `SELECT COUNT(*) n FROM kinetic_build_state WHERE tenant_id = ? AND lead_id IS NOT NULL AND classification <> 'confirmed_2026'`,
    ).get(TENANT) as any;
    expect(leaked.n).toBe(0);
  });

  it("is idempotent - a second run mints nothing", () => {
    store.promoteConfirmedBuilds(TENANT);
    const second = store.promoteConfirmedBuilds(TENANT);
    expect(second.created).toBe(0);
    expect(second.attached).toBe(0);
  });

  it("attaches to an existing lead at the same address instead of duplicating", () => {
    const who = identity({ address: "42 Dedup Dr" });
    const existing = storage.createLead({
      address: "42 Dedup Dr", city: "Salisbury", state: "NC", zip: "28144",
      lat: 35.67, lng: -80.47, tenantId: TENANT, leadStatus: "interested", leadTag: "hot_lead",
    } as any);
    store.recordAuthorizedObservation({ identity: who, ...LIVE, observedAtMs: daysAgo(1) });

    const result = store.promoteConfirmedBuilds(TENANT);
    expect(result.attached).toBeGreaterThan(0);

    const rows = rawDb.prepare(
      `SELECT id FROM leads WHERE tenant_id = ? AND address = '42 Dedup Dr'`,
    ).all(TENANT) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(existing.id);
    const state = store.getBuildState(TENANT, store.canonicalKeyFor(who))!;
    expect(state.leadId).toBe(existing.id);
  });

  it("links a promoted unit to the lead for that unit, not the building", () => {
    const base = { tenantId: TENANT, address: "800 Unit Way", city: "Salisbury", state: "NC", zip: "28144", lat: 35.66, lng: -80.46, blockGeoid: BLOCK_EMPTY };
    store.recordAuthorizedObservation({ identity: { ...base, unit: "Apt 1" }, ...LIVE, observedAtMs: daysAgo(1) });
    store.recordAuthorizedObservation({ identity: { ...base, unit: "Apt 2" }, ...LIVE, observedAtMs: daysAgo(1) });
    store.promoteConfirmedBuilds(TENANT);

    const one = store.getBuildState(TENANT, store.canonicalKeyFor({ ...base, unit: "Apt 1" }))!;
    const two = store.getBuildState(TENANT, store.canonicalKeyFor({ ...base, unit: "Apt 2" }))!;
    expect(one.leadId).not.toBeNull();
    expect(two.leadId).not.toBeNull();
    expect(one.leadId).not.toBe(two.leadId);
  });

  it("a dry run writes nothing", () => {
    rawDb.prepare(`UPDATE kinetic_build_state SET lead_id = NULL WHERE tenant_id = ?`).run(TENANT);
    const before = (rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ?`).get(TENANT) as any).n;
    const dry = store.promoteConfirmedBuilds(TENANT, { dryRun: true });
    expect(dry.created).toBeGreaterThan(0);
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ?`).get(TENANT) as any).n).toBe(before);
  });
});

describe("build-front ranking picks the CHRONOLOGICALLY newest vintage", () => {
  // Regression. Vintage codes sort lexically as D24 < D25 < J25, so a SQL
  // MAX(vintage) names JUNE as the newest filing. That silently scored every
  // block against the wrong baseline and flattened the whole candidate list to
  // one value - the ranked list looked plausible and was arbitrary. Uses its
  // own tenant so the J25 vintage cannot disturb the suite's D24/D25 fixture.
  const T2 = 77;
  const BLOCK = "370250401002050";

  beforeAll(() => {
    const seed = (vintage: string, n: number) => {
      const rows = Array.from({ length: n }, (_, i) => ({
        locationId: `t2-${vintage}-${i}`, blockGeoid: BLOCK, providerId: "131413",
        technology: 50, brCode: "R", maxDownMbps: 1000, maxUpMbps: 1000,
      }));
      const job = fcc.openImport({
        tenantId: T2, vintage, providerIds: ["131413"],
        manifest: `t2-${vintage}`, expectedChunkCount: 1, expectedRowCount: rows.length,
      });
      fcc.ingestChunk(job.id, 0, rows);
      fcc.finalizeImport(job.id);
    };
    // D24 2 -> J25 4 -> D25 20. Correct baseline (J25) gives 16 added of 40
    // premises = 0.4. The lexical bug would use J25 as "latest" and D24 as its
    // baseline, giving 2/40 = 0.05, or no row at all.
    seed("D24", 2); seed("J25", 4); seed("D25", 20);
    fcc.setBlockDenominators(T2, "D25", [{ blockGeoid: BLOCK, totalResidentialLocations: 40 }]);

    store.ensureBuildState({
      tenantId: T2, address: "1 Chronology Ct", city: "Concord", state: "NC", zip: "28025",
      lat: 35.41, lng: -80.61, blockGeoid: BLOCK,
    });
    store.reclassify(T2, store.canonicalKeyFor({
      tenantId: T2, address: "1 Chronology Ct", city: "Concord", state: "NC", zip: "28025",
    }));
  });

  it("orders the imported vintages chronologically, not lexically", () => {
    expect(fcc.importedVintages(T2)).toEqual(["D24", "J25", "D25"]);
  });

  it("diffs D25 against J25, not against whatever sorts highest", () => {
    const facts = fcc.blockFactsFor(T2, BLOCK)!;
    expect(facts.latestVintage).toBe("D25");
    expect(facts.baselineVintage).toBe("J25");
    expect(facts.addedLocations).toBe(16);
  });

  it("scores the candidate on the real build front, not zero", () => {
    const ranked = store.rankedBuilds(T2, { limit: 10, classifications: ["likely_2026"] });
    expect(ranked).toHaveLength(1);
    // 16 added of 40 premises = 40% of the block newly lit, which the ranker
    // must both score and say out loud.
    expect(ranked[0].explanation.join(" ")).toContain("40% of this block");
    expect(ranked[0].score).toBeGreaterThan(0);
  });
});

describe("map reads", () => {
  const WINDOW = { minLat: 35.0, maxLat: 36.5, minLng: -81.5, maxLng: -79.5 };

  it("paints a confirmed build gold only while its verification is fresh", () => {
    const pins = store.buildWindowPins(TENANT, WINDOW);
    expect(pins.length).toBeGreaterThan(0);
    const confirmed = pins.filter((p) => p.classification === "confirmed_2026");
    expect(confirmed.length).toBeGreaterThan(0);
    // Gold is "confirmed AND checked lately". The same classification with an
    // aged verification is blue - which is the whole point of the two tiers.
    for (const pin of confirmed) {
      const fresh = (pin.verificationAgeDays ?? Infinity) <= 30;
      expect(pin.tier).toBe(fresh ? "gold" : "blue");
    }
    expect(confirmed.some((p) => p.tier === "gold")).toBe(true);
    expect(pins.filter((p) => p.classification === "existing_fiber").every((p) => p.tier === "gray")).toBe(true);
  });

  it("filters by classification, county and quarter", () => {
    const only = store.buildWindowPins(TENANT, { ...WINDOW, classifications: ["confirmed_2026"] });
    expect(only.every((p) => p.classification === "confirmed_2026")).toBe(true);

    const rowan = store.buildWindowPins(TENANT, { ...WINDOW, counties: ["37159"] });
    expect(rowan.length).toBeGreaterThan(0);

    const q2 = store.buildWindowPins(TENANT, { ...WINDOW, quarters: ["2026Q2"] });
    expect(q2.every((p) => p.quarter === "2026Q2")).toBe(true);
    expect(q2.length).toBeGreaterThan(0);
  });

  it("filters by verification age without dropping rows after the cap", () => {
    const fresh = store.buildWindowPins(TENANT, { ...WINDOW, verificationAge: ["fresh"] });
    const count = store.buildWindowCount(TENANT, { ...WINDOW, verificationAge: ["fresh"] });
    // The count and the row set agree, which is what makes the cap honest.
    expect(fresh.length).toBe(count);
    expect(fresh.every((p) => (p.verificationAgeDays ?? 999) <= 30)).toBe(true);
  });

  it("excludes rows outside the bounding box", () => {
    const far = store.buildWindowPins(TENANT, { minLat: 10, maxLat: 11, minLng: -100, maxLng: -99 });
    expect(far).toEqual([]);
  });

  it("aggregates into a grid whose totals match the pin count", () => {
    const cells = store.buildGrid(TENANT, { ...WINDOW, cell: 0.01 });
    const gridTotal = cells.reduce((n, c) => n + c.count, 0);
    expect(gridTotal).toBe(store.buildWindowCount(TENANT, WINDOW));
  });

  it("ranks confirmed builds and explains the order", () => {
    const ranked = store.rankedBuilds(TENANT, { limit: 10 });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((r) => r.classification === "confirmed_2026")).toBe(true);
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
  });
});
