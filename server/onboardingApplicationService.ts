import { getDefaultTenantId, storage } from "./storage";
import { attachApplicationToInvite, resolveRecruitingInviteToken } from "./onboardingRecruitingStore";
import { rawDb } from "./db";

export type ApplicationSource = "invited" | "careers" | "public_join";

export class ApplicationIntakeError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export interface ApplicationIntakeInput {
  fullName: string;
  email: string;
  phone: string;
  city: string;
  zip: string;
  state: string;
  hasSalesExperience: boolean;
  salesExperienceDetails?: string | null;
  /** null/undefined = the submitting form never asked (careers site). */
  hasReliableTransportation?: boolean | null;
  preferredCarriers: string;
  referralSource?: string | null;
  desiredRole?: string | null;
  requestedSource?: string | null;
  orgSlug?: string | null;
  inviteToken?: string | null;
  headshotPath?: string | null;
  licensePath?: string | null;
  actorIp?: string | null;
}

function cleanSlug(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64);
}

function careersTenantId(): number | null {
  const configuredSlug = cleanSlug(process.env.CAREERS_TENANT_SLUG);
  if (configuredSlug) return storage.getTenantBySlug(configuredSlug)?.id ?? null;
  return getDefaultTenantId() ?? null;
}

/**
 * Public applications never derive tenancy from a user/account. The secure
 * invitation is authoritative when present; the marketing careers source maps
 * to a server-owned tenant; a tenant join link maps through its server-known
 * slug. Unknown slugs fail instead of silently routing to the wrong org.
 */
export function submitPublicApplication(input: ApplicationIntakeInput) {
  const email = input.email.trim().toLowerCase();
  const invite = input.inviteToken ? resolveRecruitingInviteToken(input.inviteToken) : null;
  if (input.inviteToken && !invite) {
    throw new ApplicationIntakeError("This invitation is invalid, expired, or already used. Ask your recruiter for a new link.", 400);
  }
  if (invite && invite.candidateEmail !== email) {
    throw new ApplicationIntakeError("Use the email address that received this private invitation.", 400);
  }

  const requestedSource = input.requestedSource === "careers" ? "careers" : "public_join";
  const applicationSource: ApplicationSource = invite ? "invited" : requestedSource;
  const orgSlug = cleanSlug(input.orgSlug);
  let tenantId: number | null;
  if (invite) tenantId = invite.tenantId;
  else if (applicationSource === "careers") tenantId = careersTenantId();
  else if (orgSlug) {
    const tenant = storage.getTenantBySlug(orgSlug);
    if (!tenant) throw new ApplicationIntakeError("This organization application link is invalid.", 400);
    tenantId = tenant.id;
  } else tenantId = getDefaultTenantId() ?? null;

  if (tenantId == null) {
    throw new ApplicationIntakeError("Applications are temporarily unavailable because the recruiting organization is not configured.", 503);
  }

  const duplicate = storage.getRepApplications(undefined, tenantId).find(
    application => application.email.toLowerCase() === email && application.status === "pending",
  );
  if (duplicate) throw new ApplicationIntakeError("An application with this email is already pending review.", 409);

  const application = storage.createRepApplication({
    tenantId,
    inviteId: invite?.id ?? null,
    applicationSource,
    desiredRole: input.desiredRole?.trim().slice(0, 120) || null,
    fullName: input.fullName.trim(),
    email,
    phone: input.phone.trim(),
    city: input.city.trim(),
    zip: input.zip.trim(),
    state: input.state.trim().toUpperCase() || "NC",
    hasSalesExperience: input.hasSalesExperience,
    salesExperienceDetails: input.salesExperienceDetails?.trim() || null,
    hasReliableTransportation: input.hasReliableTransportation ?? null,
    preferredCarriers: input.preferredCarriers.trim(),
    referralSource: input.referralSource?.trim() || null,
    headshotPath: input.headshotPath ?? null,
    licensePath: input.licensePath ?? null,
  });

  try {
    if (invite) attachApplicationToInvite(invite.id, application.id);
  } catch (error) {
    // The invite attachment is a one-time compare-and-set. Roll back the public
    // row when another concurrent request won, so retries never leave duplicates.
    rawDb.prepare("DELETE FROM rep_applications WHERE id = ? AND user_id IS NULL").run(application.id);
    throw new ApplicationIntakeError(error instanceof Error ? error.message : "This invitation has already been used.", 409);
  }

  storage.logActivity(null, "onboarding.application.submitted", "rep_application", application.id, {
    tenantId,
    inviteId: invite?.id ?? null,
    source: applicationSource,
    state: "under_review",
  }, input.actorIp ?? undefined, tenantId);
  return storage.getRepApplicationById(application.id)!;
}
