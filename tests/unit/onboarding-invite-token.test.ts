import { beforeEach, describe, expect, it } from "vitest";
import { createInviteToken, hashInviteToken, verifyInviteToken } from "../../server/onboardingInviteToken";

describe("secure onboarding invitation tokens", () => {
  beforeEach(() => {
    process.env.ONBOARDING_INVITE_SECRET = "unit-test-invite-secret-with-at-least-thirty-two-characters";
  });

  it("authenticates the record, tenant, email, and expiry", () => {
    const expiresAt = "2026-07-20T12:00:00.000Z";
    const token = createInviteToken({
      recordId: "b6650bb1-90f4-4b94-8c95-e0a980c269ea",
      tenantId: 42,
      email: "Candidate@Example.com",
      expiresAt,
    });
    expect(hashInviteToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyInviteToken(token, new Date("2026-07-13T12:00:00.000Z"))).toEqual({
      v: 1,
      rid: "b6650bb1-90f4-4b94-8c95-e0a980c269ea",
      tid: 42,
      email: "candidate@example.com",
      exp: expiresAt,
    });
    expect(verifyInviteToken(token, new Date(expiresAt))).toBeNull();
    expect(verifyInviteToken(`${token.slice(0, -1)}x`, new Date("2026-07-13T12:00:00.000Z"))).toBeNull();
  });

  it("rejects tokens after the signing secret changes", () => {
    const token = createInviteToken({
      recordId: "fa16a8f1-25d2-4ac2-9f3c-0e2c8de1d268",
      tenantId: 1,
      email: "candidate@example.com",
      expiresAt: "2026-07-20T12:00:00.000Z",
    });
    process.env.ONBOARDING_INVITE_SECRET = "different-unit-test-secret-with-at-least-thirty-two-characters";
    expect(verifyInviteToken(token, new Date("2026-07-13T12:00:00.000Z"))).toBeNull();
  });
});
