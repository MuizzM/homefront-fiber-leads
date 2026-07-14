import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store: typeof import("../../server/kineticScannerStore");
let ingest: typeof import("../../server/kineticEvidenceIngest");
let tenantId: number;
let actorId: number;

const result = (
  sequentialId: number,
  isLive: boolean,
  technologyType: string,
  version: number,
): import("../../server/kineticProviderAdapter").NormalizedKineticAddress => ({
  kineticAddressId: `KA-${sequentialId}`,
  sequentialId,
  address: `${sequentialId} Main St`,
  city: "Lexington",
  state: "NC",
  zip: "27292",
  latitude: 35.824,
  longitude: -80.253,
  exchangeId: "LEX",
  technologyType,
  maximumQualification: isLive ? 2000 : 100,
  estimatedCompletionDate: null,
  isLive,
  isComingSoon: false,
  isCopperUpgradeCandidate: !isLive,
  evidenceMode: "authorized_import",
  evidenceSource: "integration-fixture",
  evidenceId: `evidence-${sequentialId}-${version}`,
  observedAt: new Date(Date.UTC(2026, 6, version, 12)).toISOString(),
  parserVersion: "test-v1",
  rawResponse: { sequentialId, isLive, technologyType, version },
  responseHash: `hash-${sequentialId}-${version}`,
});

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-kinetic-truth-"));
  const storage = await import("../../server/storage");
  const { rawDb } = await import("../../server/db");
  storage.runMigrations();
  tenantId = storage.getDefaultTenantId();
  actorId = Number(
    rawDb
      .prepare(
        `INSERT INTO users (name,email,role,active,tenant_id,created_at)
         VALUES (?,?,?,?,?,datetime('now'))`,
      )
      .run(
        "Evidence Reviewer",
        "evidence-reviewer@example.test",
        "admin",
        1,
        tenantId,
      ).lastInsertRowid,
  );
  store = await import("../../server/kineticScannerStore");
  store.ensureKineticScannerSchema();
  ingest = await import("../../server/kineticEvidenceIngest");
});

describe("Kinetic scanner persistence truth", () => {
  it("keeps first-seen fiber as a baseline", () => {
    expect(
      store.upsertKineticAddress(tenantId, null, result(901, true, "Fiber", 1)),
    ).toMatchObject({
      inserted: true,
      discoveryState: "BASELINE_FIBER",
      fresh: false,
      transitionAction: "BASELINE",
    });
  });

  it("requires a prior non-fiber baseline and repeat positive check", () => {
    expect(
      store.upsertKineticAddress(
        tenantId,
        null,
        result(902, false, "Copper", 1),
      ),
    ).toMatchObject({ discoveryState: "NON_FIBER", fresh: false });
    expect(
      store.upsertKineticAddress(
        tenantId,
        null,
        result(902, true, "FTTH Fiber", 2),
      ),
    ).toMatchObject({
      discoveryState: "CANDIDATE_FRESH",
      fresh: false,
      transitionAction: "OPEN_CANDIDATE",
    });
    expect(
      store.upsertKineticAddress(
        tenantId,
        null,
        result(902, true, "FTTH Fiber", 3),
      ),
    ).toMatchObject({
      discoveryState: "VERIFIED_FRESH",
      fresh: true,
      transitionAction: "VERIFY",
    });
    expect(
      store.upsertKineticAddress(
        tenantId,
        null,
        result(902, true, "FTTH Fiber", 4),
      ),
    ).toMatchObject({
      discoveryState: "VERIFIED_FRESH",
      fresh: true,
      transitionAction: "NO_CHANGE",
    });
  });

  it("ingests approved JSON idempotently and allows a signed-in manual confirmation", () => {
    const base = {
      address: "700 Evidence Way",
      city: "Lexington",
      state: "NC",
      zip: "27292",
      unit: null,
      latitude: 35.82,
      longitude: -80.25,
      maximumQualification: null,
      isComingSoon: null,
      isCopperUpgradeCandidate: null,
    };
    const first = ingest.ingestApprovedImport({
      tenantId,
      actorId: null,
      payload: {
        format: "json",
        sourceName: "approved-export",
        records: [
          {
            ...base,
            evidenceId: "approved-1",
            observedAt: "2026-07-10T12:00:00.000Z",
            technologyType: "Copper",
            isLive: false,
          },
        ],
      },
    });
    expect(first).toMatchObject({ accepted: 1, rejected: 0, replays: 0 });
    const replay = ingest.ingestApprovedImport({
      tenantId,
      actorId: null,
      payload: {
        format: "json",
        sourceName: "approved-export",
        records: [
          {
            ...base,
            evidenceId: "approved-1",
            observedAt: "2026-07-10T12:00:00.000Z",
            technologyType: "Copper",
            isLive: false,
          },
        ],
      },
    });
    expect(replay).toMatchObject({ accepted: 0, rejected: 0, replays: 1 });
    const candidate = ingest.ingestApprovedImport({
      tenantId,
      actorId: null,
      payload: {
        format: "json",
        sourceName: "approved-export",
        records: [
          {
            ...base,
            evidenceId: "approved-2",
            observedAt: "2026-07-11T12:00:00.000Z",
            technologyType: "Fiber",
            isLive: true,
          },
        ],
      },
    });
    expect(candidate.accepted).toBe(1);
    const verified = ingest.ingestManualVerification({
      tenantId,
      actorId,
      payload: {
        ...base,
        observedAt: "2026-07-12T12:00:00.000Z",
        technologyType: "FTTH Fiber",
        isLive: true,
        reviewerNote:
          "Authorized reviewer confirmed the explicit fiber result.",
      },
    });
    expect(verified).toMatchObject({
      discoveryState: "VERIFIED_FRESH",
      fresh: true,
      replay: false,
    });
  });
});
