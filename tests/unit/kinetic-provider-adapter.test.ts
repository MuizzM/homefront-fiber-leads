import { beforeEach, describe, expect, it } from "vitest";
import {
  getKineticEvidenceGateway,
  normalizeImportedKineticEvidence,
  setKineticEvidenceSourceForTest,
  type KineticEvidenceResponse,
  type KineticEvidenceSourceAdapter,
} from "../../server/kineticProviderAdapter";

const imported = {
  address: "100 Main St",
  city: "Lexington",
  state: "NC",
  zip: "27292",
  unit: null,
  observedAt: "2026-07-14T12:00:00.000Z",
  latitude: 35.8,
  longitude: -80.25,
  technologyType: "FIBER",
  maximumQualification: 2000,
  isLive: true,
  isComingSoon: false,
  isCopperUpgradeCandidate: false,
  sourceName: "approved-file",
  evidenceId: "row-42",
};
const adapter = (
  response: KineticEvidenceResponse,
): KineticEvidenceSourceAdapter => ({
  id: "test-contract",
  mode: "authorized_public_lookup",
  contractVersion: "test-v1",
  healthCheck: async () => ({ ok: true, latencyMs: 1, message: "ok" }),
  qualifyAddress: async () => response,
});

beforeEach(() => setKineticEvidenceSourceForTest(null));

describe("Kinetic evidence boundary", () => {
  it("normalizes only explicit approved-import fields and preserves provenance", () => {
    const result = normalizeImportedKineticEvidence(
      imported,
      "authorized_import",
    );
    expect(result).toMatchObject({
      kineticAddressId: null,
      sequentialId: null,
      state: "NC",
      technologyType: "FIBER",
      maximumQualification: 2000,
      isLive: true,
      evidenceMode: "authorized_import",
      evidenceSource: "approved-file",
      evidenceId: "row-42",
      rawResponse: imported,
    });
    expect(result.responseHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("keeps missing serviceability inconclusive", () => {
    expect(
      normalizeImportedKineticEvidence(
        { ...imported, isLive: null, technologyType: null },
        "authorized_import",
      ),
    ).toMatchObject({ isLive: null, technologyType: null });
  });
  it("is offline by default", async () => {
    await expect(
      getKineticEvidenceGateway().qualifyAddress({
        address: "100 Main St",
        city: "Lexington",
        state: "NC",
        zip: "27292",
      }),
    ).rejects.toMatchObject({ code: "OFFLINE" });
  });
  it.each([
    ["denied", "ACCESS_DENIED"],
    ["challenge", "CHALLENGE"],
  ] as const)("stops immediately on %s", async (outcome, code) => {
    setKineticEvidenceSourceForTest(adapter({ outcome, record: null }));
    await expect(
      getKineticEvidenceGateway().qualifyAddress({
        address: "100 Main St",
        city: "Lexington",
        state: "NC",
        zip: "27292",
      }),
    ).rejects.toMatchObject({ code });
    expect(getKineticEvidenceGateway().status().circuitOpen).toBe(true);
  });
  it("briefly cools off (never stops) after repeated rate limits", async () => {
    setKineticEvidenceSourceForTest(
      adapter({ outcome: "rate_limited", record: null, retryAfterMs: 1000 }),
    );
    const gateway = getKineticEvidenceGateway();
    for (let index = 0; index < 3; index++)
      await expect(
        gateway.qualifyAddress({
          address: `${100 + index} Main St`,
          city: "Lexington",
          state: "NC",
          zip: "27292",
        }),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(gateway.status()).toMatchObject({
      circuitOpen: true,
      circuitReason: "repeated rate limits - rotating Decodo session",
    });
  });
});
