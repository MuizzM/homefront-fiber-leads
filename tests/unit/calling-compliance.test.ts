import { describe, expect, it } from "vitest";
import {
  consentEvidenceErrors,
  evaluateCallingCompliance,
  isInsideCallingWindow,
  localClock,
  maskPhone,
  normalizeUsPhone,
  type ComplianceInput,
  type ConsentEvidenceInput,
} from "../../shared/calling";

const EVALUATED_AT = "2026-07-14T16:00:00.000Z"; // 12:00 EDT

function eligible(overrides: Partial<ComplianceInput> = {}): ComplianceInput {
  return {
    evaluatedAt: EVALUATED_AT,
    featureEnabled: true,
    emergencyDisabled: false,
    tenantAuthorized: true,
    leadStillQualified: true,
    representativeAuthorized: true,
    representativeOnHold: false,
    sellerAuthorized: true,
    registrationValid: true,
    legalConfigurationApproved: true,
    providerUseApproved: true,
    providerContractRef: "contract:test:v1",
    phoneValid: true,
    lineType: "landline",
    manualActionConfirmed: true,
    phoneValidationFresh: true,
    identityConfidence: 0.95,
    minimumIdentityConfidence: 0.85,
    residentAssociationAllowed: true,
    wrongParty: false,
    internalDnc: false,
    tenantDnc: false,
    nationalDnc: false,
    stateDnc: false,
    nationalDncFresh: true,
    stateDncFresh: true,
    dncDatasetRef: "national:2026-07-14,state-NC:2026-07-14",
    verifiedConsent: false,
    consentRevoked: false,
    allowNationalDncConsentOverride: false,
    allowStateDncConsentOverride: false,
    reassignedRisk: false,
    timeZone: "America/New_York",
    timeZoneConfidence: "high",
    callingWindow: { startLocal: "08:00", endLocal: "21:00" },
    frequencyAllowed: true,
    previousDispositionAllowed: true,
    queueOwned: true,
    callerIdAuthorized: true,
    scriptApproved: true,
    scriptVersion: "script-v1",
    ruleVersion: "rules-v1",
    ruleVersionAvailable: true,
    ...overrides,
  };
}

function expectBlocked(overrides: Partial<ComplianceInput>, decision: string, reason: string) {
  const input = eligible(overrides);
  const result = evaluateCallingCompliance(input);
  expect(result).toMatchObject({ eligible: false, decision, evaluatedAt: input.evaluatedAt });
  expect(result.reasonCodes).toContain(reason);
  expect(result.rules.find((rule) => rule.reasonCode === reason)).toMatchObject({ passed: false });
  return result;
}

describe("calling compliance engine", () => {
  it("returns a short-lived deterministic authorization only when every rule passes", () => {
    const first = evaluateCallingCompliance(eligible());
    const second = evaluateCallingCompliance(eligible());
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      eligible: true,
      decision: "ELIGIBLE_MANUAL_CALL",
      localTime: "12:00 PM EDT",
      timeZone: "America/New_York",
      expiresAt: "2026-07-14T16:02:00.000Z",
      ruleVersion: "rules-v1",
    });
    expect(first.rules.length).toBeGreaterThanOrEqual(27);
    expect(first.rules.every((rule) => rule.passed)).toBe(true);
  });

  it.each([
    ["national", { nationalDnc: true }, "BLOCKED_NATIONAL_DNC", "NATIONAL_DNC_HIT"],
    ["state", { stateDnc: true }, "BLOCKED_STATE_DNC", "STATE_DNC_HIT"],
  ])("blocks a %s DNC hit", (_label, input, decision, reason) => {
    expectBlocked(input as Partial<ComplianceInput>, decision, reason);
  });

  it.each([
    ["national", { nationalDncFresh: false }, "NATIONAL_DNC_DATA_STALE"],
    ["state", { stateDncFresh: false }, "STATE_DNC_DATA_STALE"],
  ])("fails closed on stale %s DNC data", (_label, input, reason) => {
    expectBlocked(input as Partial<ComplianceInput>, "BLOCKED_STALE_DNC_DATA", reason);
  });

  it("gives an entity-specific/internal opt-out precedence over every other failure", () => {
    const result = expectBlocked({
      internalDnc: true,
      consentRevoked: true,
      featureEnabled: false,
      nationalDncFresh: false,
    }, "BLOCKED_INTERNAL_DNC", "COMPANY_DNC_HIT");
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      "COMPANY_DNC_HIT", "CONSENT_REVOKED", "CALLING_DISABLED", "NATIONAL_DNC_DATA_STALE",
    ]));
  });

  it("treats consent revocation as permanent suppression even if verified consent exists", () => {
    expectBlocked({ verifiedConsent: true, consentRevoked: true }, "BLOCKED_CONSENT_REVOKED", "CONSENT_REVOKED");
  });

  it.each([
    ["before 8am", "2026-07-14T11:59:00.000Z"],
    ["at 9pm", "2026-07-15T01:00:00.000Z"],
    ["after 9pm", "2026-07-15T02:00:00.000Z"],
  ])("blocks local calls %s", (_label, evaluatedAt) => {
    expectBlocked({ evaluatedAt }, "BLOCKED_CALLING_HOURS", "OUTSIDE_CALLING_HOURS");
  });

  it.each([
    ["at 8am", "2026-07-14T12:00:00.000Z"],
    ["one minute before 9pm", "2026-07-15T00:59:00.000Z"],
  ])("allows local calls %s", (_label, evaluatedAt) => {
    expect(evaluateCallingCompliance(eligible({ evaluatedAt }))).toMatchObject({
      eligible: true,
      decision: "ELIGIBLE_MANUAL_CALL",
    });
  });

  it("fails closed when the address timezone is missing or low confidence", () => {
    expectBlocked({ timeZone: null, timeZoneConfidence: "unknown" }, "REVIEW_REQUIRED", "TIME_ZONE_UNCERTAIN");
    expectBlocked({ timeZoneConfidence: "low" }, "REVIEW_REQUIRED", "TIME_ZONE_UNCERTAIN");
  });

  it("allows a validated wireless number only after an explicit human manual action", () => {
    const permitted = evaluateCallingCompliance(eligible({ lineType: "wireless", manualActionConfirmed: true }));
    expect(permitted).toMatchObject({ eligible: true, decision: "ELIGIBLE_MANUAL_CALL" });
    expect(permitted.rules.find((rule) => rule.rule === "manual_human_action")).toMatchObject({
      passed: true,
      evidenceRef: "wireless",
    });
    expectBlocked(
      { lineType: "wireless", manualActionConfirmed: false },
      "BLOCKED_AUTOMATED_DIAL_ATTEMPT",
      "WIRELESS_REQUIRES_MANUAL_ACTION",
    );
  });

  it("keeps an owner-only or unknown association out of the resident calling queue", () => {
    expectBlocked(
      { residentAssociationAllowed: false, identityConfidence: 0.99 },
      "REVIEW_IDENTITY_MATCH",
      "RESIDENT_ASSOCIATION_UNVERIFIED",
    );
  });

  it("blocks any non-manual attempt and reviews unknown line types", () => {
    expectBlocked({ manualActionConfirmed: false }, "BLOCKED_AUTOMATED_DIAL_ATTEMPT", "MANUAL_ACTION_REQUIRED");
    expectBlocked({ lineType: null }, "REVIEW_REQUIRED", "LINE_TYPE_UNKNOWN_OR_UNSUPPORTED");
  });

  it.each([
    [{ phoneValid: false }, "BLOCKED_INVALID_NUMBER", "PHONE_INVALID"],
    [{ phoneValidationFresh: false }, "REVIEW_REQUIRED", "PHONE_VALIDATION_STALE"],
    [{ wrongParty: true }, "BLOCKED_WRONG_PARTY", "WRONG_PARTY_SUPPRESSED"],
    [{ reassignedRisk: true }, "BLOCKED_REASSIGNED_RISK", "REASSIGNED_NUMBER_RISK"],
    [{ identityConfidence: 0.84 }, "REVIEW_IDENTITY_MATCH", "IDENTITY_CONFIDENCE_LOW"],
    [{ frequencyAllowed: false }, "BLOCKED_FREQUENCY_POLICY", "ATTEMPT_FREQUENCY_LIMIT"],
    [{ previousDispositionAllowed: false }, "BLOCKED_TENANT_POLICY", "PREVIOUS_DISPOSITION_BLOCKS_CALL"],
  ])("blocks or reviews unsafe phone/contact state %#", (input, decision, reason) => {
    expectBlocked(input as Partial<ComplianceInput>, decision, reason);
  });

  it.each([
    [{ featureEnabled: false }, "BLOCKED_TENANT_POLICY", "CALLING_DISABLED"],
    [{ emergencyDisabled: true }, "BLOCKED_TENANT_POLICY", "EMERGENCY_DISABLED"],
    [{ tenantAuthorized: false }, "BLOCKED_TENANT_POLICY", "TENANT_NOT_IN_PILOT"],
    [{ representativeAuthorized: false }, "BLOCKED_UNAUTHORIZED_REP", "REPRESENTATIVE_NOT_AUTHORIZED"],
    [{ representativeOnHold: true }, "BLOCKED_REPRESENTATIVE_HOLD", "REPRESENTATIVE_CALLING_HOLD_ACTIVE"],
    [{ queueOwned: false }, "BLOCKED_UNAUTHORIZED_REP", "QUEUE_NOT_OWNED"],
    [{ sellerAuthorized: false }, "REVIEW_LEGAL_CONFIGURATION", "SELLER_AUTHORIZATION_MISSING"],
    [{ registrationValid: false }, "BLOCKED_MISSING_REGISTRATION", "REGISTRATION_OR_EXEMPTION_MISSING"],
    [{ legalConfigurationApproved: false }, "REVIEW_LEGAL_CONFIGURATION", "COUNSEL_APPROVAL_MISSING"],
    [{ providerUseApproved: false }, "BLOCKED_PROVIDER_USE", "PROVIDER_USE_NOT_APPROVED"],
    [{ callerIdAuthorized: false }, "REVIEW_LEGAL_CONFIGURATION", "CALLER_ID_NOT_AUTHORIZED"],
    [{ scriptApproved: false }, "REVIEW_LEGAL_CONFIGURATION", "APPROVED_SCRIPT_MISSING"],
    [{ ruleVersionAvailable: false }, "REVIEW_LEGAL_CONFIGURATION", "RULE_VERSION_UNAVAILABLE"],
  ])("fails closed for disabled or incomplete configuration %#", (input, decision, reason) => {
    expectBlocked(input as Partial<ComplianceInput>, decision, reason);
  });

  it("permits a DNC override only when verified consent and each explicit policy override are present", () => {
    expectBlocked(
      { nationalDnc: true, verifiedConsent: true, allowNationalDncConsentOverride: false },
      "BLOCKED_NATIONAL_DNC",
      "NATIONAL_DNC_HIT",
    );
    const result = evaluateCallingCompliance(eligible({
      nationalDnc: true,
      stateDnc: true,
      verifiedConsent: true,
      allowNationalDncConsentOverride: true,
      allowStateDncConsentOverride: true,
    }));
    expect(result).toMatchObject({ eligible: true, decision: "ELIGIBLE_WITH_VERIFIED_CONSENT" });
  });

  it("evaluates overnight windows without assuming the interval is same-day", () => {
    expect(isInsideCallingWindow("2026-07-15T03:30:00.000Z", "America/New_York", {
      startLocal: "20:00", endLocal: "02:00",
    })).toBe(true);
    expect(isInsideCallingWindow("2026-07-15T16:00:00.000Z", "America/New_York", {
      startLocal: "20:00", endLocal: "02:00",
    })).toBe(false);
  });

  it("rejects malformed clocks/timezones and normalizes US phone numbers", () => {
    expect(localClock("not-a-date", "America/New_York")).toBeNull();
    expect(localClock(EVALUATED_AT, "Not/AZone")).toBeNull();
    expect(isInsideCallingWindow(EVALUATED_AT, "America/New_York", { startLocal: "25:00", endLocal: "21:00" })).toBe(false);
    expect(normalizeUsPhone("(336) 555-1212")).toBe("+13365551212");
    expect(normalizeUsPhone("+1 036 555 1212")).toBeNull();
    expect(maskPhone("+13365551212")).toBe("(•••) •••-1212");
  });
});

describe("calling consent evidence", () => {
  function validEvidence(overrides: Partial<ConsentEvidenceInput> = {}): ConsentEvidenceInput {
    return {
      seller: "Home Front Solutions",
      organizationId: 1,
      phoneId: 11,
      serviceAddress: "100 Main St, Lexington, NC 27292",
      consumerIdentity: "Muizz Muhammad",
      consentType: "express_written",
      channels: ["manual_voice"],
      scope: "fiber availability and sales calls",
      disclosureVersion: "disclosure-2026-07",
      disclosureTextSha256: "a".repeat(64),
      capturedAt: EVALUATED_AT,
      timeZone: "America/New_York",
      method: "signed_form",
      sourceRef: "first-party://signup/abc",
      affirmativeAction: "checked consent box and signed",
      evidenceArtifactRef: "artifact://consent/abc",
      signatureRef: "signature://immutable/abc",
      ...overrides,
    };
  }

  it("accepts all required proof elements for signed/written consent", () => {
    expect(consentEvidenceErrors(validEvidence())).toEqual([]);
  });

  it("requires a voice recording reference for recorded-call consent", () => {
    expect(consentEvidenceErrors(validEvidence({ method: "recorded_call", voiceRecordingRef: null, signatureRef: null })))
      .toEqual(expect.arrayContaining(["voice_recording_required", "durable_proof_required"]));
    expect(consentEvidenceErrors(validEvidence({ method: "recorded_call", voiceRecordingRef: "recording://immutable/123", signatureRef: null })))
      .toEqual([]);
  });

  it("requires a recording or signature as durable proof; IP and timestamp are not enough", () => {
    expect(consentEvidenceErrors(validEvidence({
      voiceRecordingRef: null,
      signatureRef: null,
      ipAddress: "203.0.113.10",
      deviceMetadata: { userAgent: "test" },
    }))).toContain("durable_proof_required");
  });

  it("reports every missing consent proof element instead of accepting IP and timestamp alone", () => {
    const errors = consentEvidenceErrors(validEvidence({
      seller: "",
      organizationId: 0,
      phoneId: 0,
      serviceAddress: "",
      consumerIdentity: "",
      consentType: "",
      channels: [],
      scope: "",
      disclosureVersion: "",
      disclosureTextSha256: "not-a-hash",
      capturedAt: "invalid",
      timeZone: "",
      sourceRef: "",
      affirmativeAction: "",
      evidenceArtifactRef: "",
      signatureRef: null,
    }));
    expect(errors).toEqual([
      "seller_required",
      "organization_required",
      "phone_required",
      "service_address_required",
      "consumer_identity_required",
      "scope_required",
      "disclosure_proof_required",
      "timestamp_and_timezone_required",
      "source_reference_required",
      "affirmative_action_required",
      "evidence_artifact_required",
      "durable_proof_required",
    ]);
  });
});

// ── DNC coverage in SIMPLE mode ─────────────────────────────────────────────
// Simple mode is the PRODUCTION default: every check reads
// `process.env.CALLING_SIMPLE_MODE !== "off"`, and nothing but tests/setup.ts
// ever sets it. It evaluated the national/state DNC *hit* rules but never the
// *coverage* rules that full mode has — and store.dncHit() answers `false`
// when there is no dataset. An organization holding zero DNC data was
// therefore ELIGIBLE_MANUAL_CALL for every number it held.
describe("DNC coverage in simple mode", () => {
  /** Run under the production default, then restore the suite's "off" pin.
   *  Without this the shipped code path is never exercised by any test here. */
  function inSimpleMode(body: () => void): void {
    const previous = process.env.CALLING_SIMPLE_MODE;
    delete process.env.CALLING_SIMPLE_MODE;
    try { body(); } finally {
      if (previous === undefined) delete process.env.CALLING_SIMPLE_MODE;
      else process.env.CALLING_SIMPLE_MODE = previous;
    }
  }

  it("blocks a never-screened number - absence of evidence is not evidence of absence", () => {
    inSimpleMode(() => {
      const result = evaluateCallingCompliance(eligible({
        nationalDncFresh: false, stateDncFresh: false,
      }));
      expect(result.eligible).toBe(false);
      expect(result.decision).toBe("BLOCKED_STALE_DNC_DATA");
      expect(result.reasonCodes).toContain("PHONE_NOT_DNC_SCREENED");
    });
  });

  it("blocks when only one registry is current", () => {
    inSimpleMode(() => {
      expect(evaluateCallingCompliance(eligible({ stateDncFresh: false })).eligible).toBe(false);
      expect(evaluateCallingCompliance(eligible({ nationalDncFresh: false })).eligible).toBe(false);
    });
  });

  it("still allows a properly screened number", () => {
    inSimpleMode(() => {
      expect(evaluateCallingCompliance(eligible()).eligible).toBe(true);
    });
  });

  it("evaluates every DNC rule, so a refactor cannot silently drop one", () => {
    inSimpleMode(() => {
      const names = new Set(evaluateCallingCompliance(eligible()).rules.map(rule => rule.rule));
      for (const rule of ["internal_dnc", "national_dnc", "state_dnc", "dnc_screened"]) {
        expect(names).toContain(rule);
      }
    });
  });
});
