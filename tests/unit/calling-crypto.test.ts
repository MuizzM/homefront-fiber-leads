import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalConsentArtifactManifest,
  hashPhone,
  hashPlatformPhone,
  verifyConsentArtifactManifest,
  type ConsentArtifactManifest,
} from "../../server/calling/crypto";

const phoneKey = "21".repeat(32);
const artifactKey = "43".repeat(32);

beforeEach(() => {
  process.env.PHONE_HASH_KEY = phoneKey;
  process.env.CONSENT_ARTIFACT_MANIFEST_SIGNING_KEY = artifactKey;
});

afterEach(() => {
  delete process.env.PHONE_HASH_KEY;
  delete process.env.CONSENT_ARTIFACT_MANIFEST_SIGNING_KEY;
});

describe("Calling cryptographic boundaries", () => {
  it("namespaces ordinary phone lookup hashes by tenant", () => {
    expect(hashPhone(10, "+13365551212")).toBe(hashPhone(10, "+13365551212"));
    expect(hashPhone(10, "+13365551212")).not.toBe(hashPhone(11, "+13365551212"));
    expect(hashPhone(10, "+13365551212")).not.toContain("3365551212");
    expect(() => hashPhone(0, "+13365551212")).toThrow(/valid tenant/i);
  });

  it("uses a distinct namespace for explicitly configured platform suppression", () => {
    expect(hashPlatformPhone("+13365551212")).toBe(hashPlatformPhone("+13365551212"));
    expect(hashPlatformPhone("+13365551212")).not.toBe(hashPhone(10, "+13365551212"));
  });

  it("accepts only an exact trusted storage-attestation manifest signature", () => {
    const manifest: ConsentArtifactManifest = {
      tenantId: 10,
      leadId: 20,
      phoneId: 30,
      callAttemptId: "4ad0132f-a1fd-4f5e-9399-d7315ed47ed7",
      artifactType: "voice_recording",
      storageProvider: "immutable-object-store",
      storageRef: "tenant/10/evidence/recording.wav",
      artifactSha256: "a1".repeat(32),
      capturedAt: "2026-07-14T16:00:00.000Z",
      retentionUntil: "2031-07-15T16:00:00.000Z",
      verificationEvidenceRef: "object-lock://retention-proof/123",
    };
    const signature = crypto.createHmac("sha256", Buffer.from(artifactKey, "hex"))
      .update(canonicalConsentArtifactManifest(manifest)).digest("hex");
    expect(verifyConsentArtifactManifest(manifest, signature)).toBe(true);
    expect(verifyConsentArtifactManifest({ ...manifest, storageRef: "different-object" }, signature)).toBe(false);
    expect(verifyConsentArtifactManifest(manifest, "00".repeat(32))).toBe(false);
  });
});
