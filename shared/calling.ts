export const CALLING_DECISIONS = [
  "ELIGIBLE_MANUAL_CALL",
  "ELIGIBLE_WITH_VERIFIED_CONSENT",
  "BLOCKED_NATIONAL_DNC",
  "BLOCKED_STATE_DNC",
  "BLOCKED_INTERNAL_DNC",
  "BLOCKED_CONSENT_REVOKED",
  "BLOCKED_CALLING_HOURS",
  "BLOCKED_INVALID_NUMBER",
  "BLOCKED_AUTOMATED_DIAL_ATTEMPT",
  "BLOCKED_REASSIGNED_RISK",
  "BLOCKED_WRONG_PARTY",
  "BLOCKED_FREQUENCY_POLICY",
  "BLOCKED_MISSING_REGISTRATION",
  "BLOCKED_PROVIDER_USE",
  "BLOCKED_STALE_DNC_DATA",
  "BLOCKED_TENANT_POLICY",
  "BLOCKED_UNAUTHORIZED_REP",
  "BLOCKED_REPRESENTATIVE_HOLD",
  "REVIEW_IDENTITY_MATCH",
  "REVIEW_LEGAL_CONFIGURATION",
  "REVIEW_REQUIRED",
  "UNKNOWN",
] as const;

export type CallingDecision = typeof CALLING_DECISIONS[number];

export type ComplianceRuleResult = {
  rule: string;
  passed: boolean;
  reasonCode: string;
  evidenceRef?: string | null;
};

export type CallingWindow = {
  startLocal: string;
  endLocal: string;
};

export type ComplianceInput = {
  evaluatedAt: string;
  featureEnabled: boolean;
  emergencyDisabled: boolean;
  tenantAuthorized: boolean;
  leadStillQualified: boolean;
  representativeAuthorized: boolean;
  representativeOnHold?: boolean;
  sellerAuthorized: boolean;
  registrationValid: boolean;
  legalConfigurationApproved: boolean;
  providerUseApproved: boolean;
  providerContractRef?: string | null;
  phoneValid: boolean;
  lineType: string | null;
  manualActionConfirmed: boolean;
  phoneValidationFresh: boolean;
  identityConfidence: number;
  minimumIdentityConfidence: number;
  residentAssociationAllowed: boolean;
  wrongParty: boolean;
  internalDnc: boolean;
  tenantDnc: boolean;
  nationalDnc: boolean;
  stateDnc: boolean;
  nationalDncFresh: boolean;
  stateDncFresh: boolean;
  dncDatasetRef?: string | null;
  verifiedConsent: boolean;
  consentRevoked: boolean;
  allowNationalDncConsentOverride: boolean;
  allowStateDncConsentOverride: boolean;
  reassignedRisk: boolean;
  timeZone: string | null;
  timeZoneConfidence: "high" | "medium" | "low" | "unknown";
  callingWindow: CallingWindow;
  frequencyAllowed: boolean;
  previousDispositionAllowed: boolean;
  queueOwned: boolean;
  callerIdAuthorized: boolean;
  scriptApproved: boolean;
  scriptVersion?: string | null;
  ruleVersion: string;
  ruleVersionAvailable: boolean;
};

export type ComplianceEvaluation = {
  decision: CallingDecision;
  eligible: boolean;
  reasonCodes: string[];
  rules: ComplianceRuleResult[];
  evaluatedAt: string;
  expiresAt: string;
  localTime: string | null;
  timeZone: string | null;
  ruleVersion: string;
};

const US_PHONE_RE = /^\+1([2-9]\d{2})([2-9]\d{2})(\d{4})$/;

export function normalizeUsPhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  const e164 = `+1${national}`;
  return US_PHONE_RE.test(e164) ? e164 : null;
}

export function maskPhone(e164: string): string {
  const normalized = normalizeUsPhone(e164);
  if (!normalized) return "••• ••• ••••";
  return `(•••) •••-${normalized.slice(-4)}`;
}

function parseLocalMinute(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

export function localClock(at: string | Date, timeZone: string): { minutes: number; label: string } | null {
  const date = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return {
      minutes: hour * 60 + minute,
      label: new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(date),
    };
  } catch {
    return null;
  }
}

export function isInsideCallingWindow(
  at: string | Date,
  timeZone: string,
  window: CallingWindow,
): boolean {
  const clock = localClock(at, timeZone);
  const start = parseLocalMinute(window.startLocal);
  const end = parseLocalMinute(window.endLocal);
  if (!clock || start == null || end == null || start === end) return false;
  return start < end
    ? clock.minutes >= start && clock.minutes < end
    : clock.minutes >= start || clock.minutes < end;
}

/**
 * Pure, deterministic and fail-closed. Every rule is evaluated for the audit
 * record, then a fixed precedence selects the authoritative decision.
 */
export function evaluateCallingCompliance(input: ComplianceInput): ComplianceEvaluation {
  const rules: ComplianceRuleResult[] = [];
  const add = (rule: string, passed: boolean, reasonCode: string, evidenceRef?: string | null): boolean => {
    rules.push({ rule, passed, reasonCode, evidenceRef });
    return passed;
  };
  const finishEarly = (decision: CallingDecision, eligible = false): ComplianceEvaluation => {
    const evaluated = new Date(input.evaluatedAt);
    const ttlMs = eligible ? 2 * 60_000 : 15 * 60_000;
    const clock = input.timeZone ? localClock(input.evaluatedAt, input.timeZone) : null;
    return {
      decision, eligible,
      reasonCodes: rules.filter((rule) => !rule.passed).map((rule) => rule.reasonCode),
      rules, evaluatedAt: input.evaluatedAt,
      expiresAt: new Date((Number.isFinite(evaluated.getTime()) ? evaluated.getTime() : 0) + ttlMs).toISOString(),
      localTime: clock?.label ?? null, timeZone: input.timeZone, ruleVersion: input.ruleVersion,
    };
  };
  // ── SIMPLE MODE (default) ── DNC-only gating: module on, lead open, phone
  // present, NOT on any DNC list, consent not revoked. Full 30-gate stack via
  // CALLING_SIMPLE_MODE=off.
  if (process.env.CALLING_SIMPLE_MODE !== "off") {
    add("feature_enabled", input.featureEnabled && !input.emergencyDisabled, input.emergencyDisabled ? "EMERGENCY_DISABLED" : "CALLING_DISABLED");
    add("lead_current_status", input.leadStillQualified, "LEAD_NO_LONGER_FRESH_OR_OPEN");
    add("phone_present", Boolean(input.phoneValid), "PHONE_INVALID");
    const internalDncOk = add("internal_dnc", !input.internalDnc && !input.tenantDnc, input.internalDnc ? "COMPANY_DNC_HIT" : "TENANT_DNC_HIT");
    const nationalOk = add("national_dnc", !input.nationalDnc, "NATIONAL_DNC_HIT", input.dncDatasetRef);
    const stateOk = add("state_dnc", !input.stateDnc, "STATE_DNC_HIT", input.dncDatasetRef);
    const consentOk = add("consent_revocation", !input.consentRevoked, "CONSENT_REVOKED");
    if (!internalDncOk) return finishEarly("BLOCKED_INTERNAL_DNC");
    if (!consentOk) return finishEarly("BLOCKED_CONSENT_REVOKED");
    if (!nationalOk) return finishEarly("BLOCKED_NATIONAL_DNC");
    if (!stateOk) return finishEarly("BLOCKED_STATE_DNC");
    const gate = rules.find((rule) => !rule.passed);
    if (gate) return finishEarly("BLOCKED_TENANT_POLICY");
    return finishEarly("ELIGIBLE_MANUAL_CALL", true);
  }
  const finish = (decision: CallingDecision, eligible = false): ComplianceEvaluation => {
    const evaluated = new Date(input.evaluatedAt);
    const ttlMs = eligible ? 2 * 60_000 : 15 * 60_000;
    const clock = input.timeZone ? localClock(input.evaluatedAt, input.timeZone) : null;
    return {
      decision,
      eligible,
      reasonCodes: rules.filter((rule) => !rule.passed).map((rule) => rule.reasonCode),
      rules,
      evaluatedAt: input.evaluatedAt,
      // Invalid timestamps remain deterministic (epoch-based) so this pure
      // policy function never depends on wall-clock I/O.
      expiresAt: new Date((Number.isFinite(evaluated.getTime()) ? evaluated.getTime() : 0) + ttlMs).toISOString(),
      localTime: clock?.label ?? null,
      timeZone: input.timeZone,
      ruleVersion: input.ruleVersion,
    };
  };

  const featureOk = add("feature_enabled", input.featureEnabled && !input.emergencyDisabled, input.emergencyDisabled ? "EMERGENCY_DISABLED" : "CALLING_DISABLED");
  const tenantOk = add("tenant_authorized", input.tenantAuthorized, "TENANT_NOT_IN_PILOT");
  const leadOk = add("lead_current_status", input.leadStillQualified, "LEAD_NO_LONGER_FRESH_OR_OPEN");
  const repOk = add("representative_authorized", input.representativeAuthorized, "REPRESENTATIVE_NOT_AUTHORIZED");
  const repHoldOk = add("representative_hold", input.representativeOnHold !== true, "REPRESENTATIVE_CALLING_HOLD_ACTIVE");
  const sellerOk = add("seller_authorized", input.sellerAuthorized, "SELLER_AUTHORIZATION_MISSING");
  const registrationOk = add("registration", input.registrationValid, "REGISTRATION_OR_EXEMPTION_MISSING");
  const legalOk = add("legal_configuration", input.legalConfigurationApproved, "COUNSEL_APPROVAL_MISSING");
  const providerOk = add("provider_permitted_use", input.providerUseApproved, "PROVIDER_USE_NOT_APPROVED", input.providerContractRef);
  const phoneOk = add("phone_valid", input.phoneValid, "PHONE_INVALID");
  const callableLineTypes = new Set(["wireless", "landline", "voip", "fixed_voip", "non_fixed_voip"]);
  const lineTypeOk = add("line_type_known", callableLineTypes.has(input.lineType?.trim().toLowerCase() ?? ""),
    "LINE_TYPE_UNKNOWN_OR_UNSUPPORTED", input.lineType);
  const manualActionOk = add(
    "manual_human_action",
    input.manualActionConfirmed,
    input.lineType?.toLowerCase() === "wireless" ? "WIRELESS_REQUIRES_MANUAL_ACTION" : "MANUAL_ACTION_REQUIRED",
    input.lineType,
  );
  const validationOk = add("phone_validation_fresh", input.phoneValidationFresh, "PHONE_VALIDATION_STALE");
  const residentOk = add("resident_association", input.residentAssociationAllowed, "RESIDENT_ASSOCIATION_UNVERIFIED");
  const identityOk = add("identity_match", input.identityConfidence >= input.minimumIdentityConfidence, "IDENTITY_CONFIDENCE_LOW");
  const wrongPartyOk = add("wrong_party", !input.wrongParty, "WRONG_PARTY_SUPPRESSED");
  const internalDncOk = add("internal_dnc", !input.internalDnc && !input.tenantDnc, input.internalDnc ? "COMPANY_DNC_HIT" : "TENANT_DNC_HIT");
  const nationalFreshOk = add("national_dnc_fresh", input.nationalDncFresh, "NATIONAL_DNC_DATA_STALE", input.dncDatasetRef);
  const stateFreshOk = add("state_dnc_fresh", input.stateDncFresh, "STATE_DNC_DATA_STALE", input.dncDatasetRef);
  const nationalAllowed = !input.nationalDnc || (input.verifiedConsent && input.allowNationalDncConsentOverride);
  const nationalOk = add("national_dnc", nationalAllowed, "NATIONAL_DNC_HIT", input.dncDatasetRef);
  const stateAllowed = !input.stateDnc || (input.verifiedConsent && input.allowStateDncConsentOverride);
  const stateOk = add("state_dnc", stateAllowed, "STATE_DNC_HIT", input.dncDatasetRef);
  const consentOk = add("consent_revocation", !input.consentRevoked, "CONSENT_REVOKED");
  const reassignedOk = add("reassigned_number", !input.reassignedRisk, "REASSIGNED_NUMBER_RISK");
  const timeZoneOk = add("time_zone", Boolean(input.timeZone) && ["high", "medium"].includes(input.timeZoneConfidence), "TIME_ZONE_UNCERTAIN");
  const insideHours = input.timeZone ? isInsideCallingWindow(input.evaluatedAt, input.timeZone, input.callingWindow) : false;
  const hoursOk = add("calling_hours", insideHours, "OUTSIDE_CALLING_HOURS");
  const frequencyOk = add("frequency", input.frequencyAllowed, "ATTEMPT_FREQUENCY_LIMIT");
  const dispositionOk = add("previous_disposition", input.previousDispositionAllowed, "PREVIOUS_DISPOSITION_BLOCKS_CALL");
  const queueOk = add("queue_ownership", input.queueOwned, "QUEUE_NOT_OWNED");
  const callerIdOk = add("caller_id", input.callerIdAuthorized, "CALLER_ID_NOT_AUTHORIZED");
  const scriptOk = add("approved_script", input.scriptApproved, "APPROVED_SCRIPT_MISSING", input.scriptVersion);
  const ruleVersionOk = add("rule_version", input.ruleVersionAvailable && Boolean(input.ruleVersion.trim()), "RULE_VERSION_UNAVAILABLE", input.ruleVersion);

  // Suppression and revocation always win, even if another prerequisite is
  // also missing. This prevents a sales/configuration state from obscuring the
  // consumer's entity-specific opt-out in both UI and audit exports.
  if (!internalDncOk) return finish("BLOCKED_INTERNAL_DNC");
  if (!consentOk) return finish("BLOCKED_CONSENT_REVOKED");
  if (!wrongPartyOk) return finish("BLOCKED_WRONG_PARTY");
  if (!reassignedOk) return finish("BLOCKED_REASSIGNED_RISK");
  if (!nationalOk) return finish("BLOCKED_NATIONAL_DNC");
  if (!stateOk) return finish("BLOCKED_STATE_DNC");
  if (!featureOk || !tenantOk || !leadOk) return finish("BLOCKED_TENANT_POLICY");
  if (!repHoldOk) return finish("BLOCKED_REPRESENTATIVE_HOLD");
  if (!repOk || !queueOk) return finish("BLOCKED_UNAUTHORIZED_REP");
  if (!sellerOk || !legalOk || !scriptOk || !ruleVersionOk || !callerIdOk) return finish("REVIEW_LEGAL_CONFIGURATION");
  if (!registrationOk) return finish("BLOCKED_MISSING_REGISTRATION");
  if (!providerOk) return finish("BLOCKED_PROVIDER_USE");
  if (!phoneOk) return finish("BLOCKED_INVALID_NUMBER");
  if (!manualActionOk) return finish("BLOCKED_AUTOMATED_DIAL_ATTEMPT");
  if (!lineTypeOk) return finish("REVIEW_REQUIRED");
  if (!validationOk) return finish("REVIEW_REQUIRED");
  if (!residentOk) return finish("REVIEW_IDENTITY_MATCH");
  if (!identityOk) return finish("REVIEW_IDENTITY_MATCH");
  if (!nationalFreshOk || !stateFreshOk) return finish("BLOCKED_STALE_DNC_DATA");
  if (!timeZoneOk) return finish("REVIEW_REQUIRED");
  if (!hoursOk) return finish("BLOCKED_CALLING_HOURS");
  if (!frequencyOk) return finish("BLOCKED_FREQUENCY_POLICY");
  if (!dispositionOk) return finish("BLOCKED_TENANT_POLICY");

  const consentOverrideUsed = (input.nationalDnc || input.stateDnc) && input.verifiedConsent;
  return finish(consentOverrideUsed ? "ELIGIBLE_WITH_VERIFIED_CONSENT" : "ELIGIBLE_MANUAL_CALL", true);
}

export type ConsentEvidenceInput = {
  seller: string;
  organizationId: number;
  phoneId: number;
  serviceAddress: string;
  consumerIdentity: string;
  consentType: string;
  channels: string[];
  scope: string;
  disclosureVersion: string;
  disclosureTextSha256: string;
  capturedAt: string;
  timeZone: string;
  method: "signed_form" | "recorded_call" | "written" | "other";
  sourceRef: string;
  affirmativeAction: string;
  evidenceArtifactRef: string;
  voiceRecordingRef?: string | null;
  signatureRef?: string | null;
  ipAddress?: string | null;
  deviceMetadata?: Record<string, unknown> | null;
  expiresAt?: string | null;
};

export function consentEvidenceErrors(input: ConsentEvidenceInput): string[] {
  const errors: string[] = [];
  if (!input.seller.trim()) errors.push("seller_required");
  if (!Number.isSafeInteger(input.organizationId) || input.organizationId < 1) errors.push("organization_required");
  if (!Number.isSafeInteger(input.phoneId) || input.phoneId < 1) errors.push("phone_required");
  if (!input.serviceAddress.trim()) errors.push("service_address_required");
  if (!input.consumerIdentity.trim()) errors.push("consumer_identity_required");
  if (!input.consentType.trim() || !input.scope.trim() || input.channels.length === 0) errors.push("scope_required");
  if (!input.disclosureVersion.trim() || !/^[a-f0-9]{64}$/i.test(input.disclosureTextSha256)) errors.push("disclosure_proof_required");
  if (!Number.isFinite(Date.parse(input.capturedAt)) || !input.timeZone.trim()) errors.push("timestamp_and_timezone_required");
  if (!input.sourceRef.trim()) errors.push("source_reference_required");
  if (!input.affirmativeAction.trim()) errors.push("affirmative_action_required");
  if (!input.evidenceArtifactRef.trim()) errors.push("evidence_artifact_required");
  if (input.method === "recorded_call" && !input.voiceRecordingRef?.trim()) errors.push("voice_recording_required");
  if (!input.voiceRecordingRef?.trim() && !input.signatureRef?.trim()) errors.push("durable_proof_required");
  if (input.expiresAt != null && !Number.isFinite(Date.parse(input.expiresAt))) errors.push("consent_expiry_invalid");
  return errors;
}

export type CallAuthorizationClaims = {
  version: 1;
  tenantId: number;
  userId: number;
  leadId: number;
  contactId: number;
  phoneId: number;
  decisionId: string;
  action: "reveal_and_hand_dial" | "copy_number" | "click_to_call";
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  ruleVersion: string;
};
