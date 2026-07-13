import crypto from "node:crypto";
import {
  ONBOARDING_DOCUMENT_META,
  ONBOARDING_DOCUMENT_TYPES,
  type OnboardingDocumentType,
} from "../shared/onboardingDocuments";

interface CachedAuth {
  accessToken: string;
  accountId: string;
  baseUri: string;
  expiresAtMs: number;
}

let authCache: CachedAuth | null = null;

const TEMPLATE_ENV: Record<OnboardingDocumentType, string> = {
  independent_contractor: "DOCUSIGN_TEMPLATE_INDEPENDENT_CONTRACTOR",
  commission_agreement: "DOCUSIGN_TEMPLATE_COMMISSION_AGREEMENT",
  confidentiality: "DOCUSIGN_TEMPLATE_CONFIDENTIALITY",
  field_safety: "DOCUSIGN_TEMPLATE_FIELD_SAFETY",
};

export interface ConfiguredOnboardingDocument {
  type: OnboardingDocumentType;
  label: string;
  description: string;
  required: boolean;
  templateId: string;
  roleName: string;
}

export function configuredDocumentCatalog(): ConfiguredOnboardingDocument[] {
  const roleName = process.env.DOCUSIGN_TEMPLATE_ROLE_NAME?.trim() || "Rep";
  return ONBOARDING_DOCUMENT_TYPES.flatMap(type => {
    const templateId = process.env[TEMPLATE_ENV[type]]?.trim();
    if (!templateId) return [];
    return [{ type, ...ONBOARDING_DOCUMENT_META[type], templateId, roleName }];
  });
}

export function publicDocumentCatalog(): Omit<ConfiguredOnboardingDocument, "templateId" | "roleName">[] {
  return ONBOARDING_DOCUMENT_TYPES.map(type => ({ type, ...ONBOARDING_DOCUMENT_META[type] }));
}

function privateKey(): string | null {
  const base64 = process.env.DOCUSIGN_PRIVATE_KEY_BASE64?.trim();
  if (base64) {
    try { return Buffer.from(base64, "base64").toString("utf8"); }
    catch { return null; }
  }
  const pem = process.env.DOCUSIGN_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  return pem || null;
}

export function docusignConfigured(): boolean {
  return Boolean(
    process.env.DOCUSIGN_INTEGRATION_KEY &&
    process.env.DOCUSIGN_USER_ID &&
    process.env.DOCUSIGN_ACCOUNT_ID &&
    docusignWebhookConfigured() &&
    privateKey() &&
    configuredDocumentCatalog().length === ONBOARDING_DOCUMENT_TYPES.length,
  );
}

export function docusignWebhookConfigured(): boolean {
  return Boolean(process.env.DOCUSIGN_CONNECT_HMAC_SECRET);
}

function authServer(): string {
  return (process.env.DOCUSIGN_AUTH_SERVER || "account-d.docusign.com")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createJwtAssertion(): string {
  const key = privateKey();
  if (!key) throw new Error("DocuSign private key is not configured");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: process.env.DOCUSIGN_INTEGRATION_KEY,
    sub: process.env.DOCUSIGN_USER_ID,
    aud: authServer(),
    iat: now - 30,
    exp: now + 3600,
    scope: "signature impersonation",
  })}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function responseError(response: Response, context: string): Promise<Error> {
  const body = await response.json().catch(() => ({}));
  const message = body?.message ?? body?.error_description ?? body?.errorCode ?? response.statusText;
  return new Error(`${context} failed (${response.status}): ${String(message).slice(0, 300)}`);
}

async function auth(): Promise<CachedAuth> {
  if (!docusignConfigured()) throw new Error("DocuSign is not configured");
  if (authCache && authCache.expiresAtMs > Date.now() + 60_000) return authCache;

  const assertion = createJwtAssertion();
  const tokenResponse = await fetch(`https://${authServer()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!tokenResponse.ok) throw await responseError(tokenResponse, "DocuSign authentication");
  const token = await tokenResponse.json() as { access_token?: string; expires_in?: number };
  if (!token.access_token) throw new Error("DocuSign authentication returned no access token");

  const userInfoResponse = await fetch(`https://${authServer()}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
  });
  if (!userInfoResponse.ok) throw await responseError(userInfoResponse, "DocuSign account discovery");
  const userInfo = await userInfoResponse.json() as { accounts?: Array<{ account_id: string; base_uri: string }> };
  const desired = process.env.DOCUSIGN_ACCOUNT_ID!;
  const account = userInfo.accounts?.find(item => item.account_id === desired);
  if (!account?.base_uri) throw new Error("Configured DocuSign account is not available to the impersonated user");

  authCache = {
    accessToken: token.access_token,
    accountId: desired,
    baseUri: account.base_uri.replace(/\/$/, ""),
    expiresAtMs: Date.now() + Math.max(300, Number(token.expires_in ?? 3600) - 120) * 1000,
  };
  return authCache;
}

async function apiJson(path: string, init: RequestInit): Promise<any> {
  const credentials = await auth();
  const response = await fetch(`${credentials.baseUri}/restapi/v2.1/accounts/${credentials.accountId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw await responseError(response, `DocuSign ${path}`);
  return response.json();
}

export async function createOnboardingEnvelope(input: {
  document: ConfiguredOnboardingDocument;
  signerName: string;
  signerEmail: string;
  clientUserId: string;
  tenantId: number;
  repId: number;
  reservationId: number;
  webhookUrl: string;
}): Promise<{ envelopeId: string; status: string }> {
  const payload = {
    templateId: input.document.templateId,
    templateRoles: [{
      email: input.signerEmail,
      name: input.signerName,
      roleName: input.document.roleName,
      clientUserId: input.clientUserId,
    }],
    emailSubject: `${input.document.label} — Home Front Solutions`,
    status: "sent",
    transactionId: `homefront-onboarding-${input.reservationId}`,
    customFields: {
      textCustomFields: [
        { name: "homefrontTenantId", value: String(input.tenantId), show: "false" },
        { name: "homefrontRepId", value: String(input.repId), show: "false" },
        { name: "homefrontDocumentType", value: input.document.type, show: "false" },
      ],
    },
    eventNotification: {
      url: input.webhookUrl,
      loggingEnabled: "true",
      requireAcknowledgment: "true",
      deliveryMode: "SIM",
      envelopeEvents: [
        { envelopeEventStatusCode: "Sent" },
        { envelopeEventStatusCode: "Delivered" },
        { envelopeEventStatusCode: "Completed" },
        { envelopeEventStatusCode: "Declined" },
        { envelopeEventStatusCode: "Voided" },
      ],
      eventData: {
        version: "restv2.1",
        format: "json",
        includeData: ["recipients"],
      },
    },
  };
  const result = await apiJson("/envelopes", { method: "POST", body: JSON.stringify(payload) });
  if (!result?.envelopeId) throw new Error("DocuSign returned no envelope ID");
  return { envelopeId: result.envelopeId, status: result.status ?? "sent" };
}

export async function createSigningView(input: {
  envelopeId: string;
  signerName: string;
  signerEmail: string;
  clientUserId: string;
  returnUrl: string;
}): Promise<string> {
  const result = await apiJson(`/envelopes/${encodeURIComponent(input.envelopeId)}/views/recipient`, {
    method: "POST",
    body: JSON.stringify({
      returnUrl: input.returnUrl,
      authenticationMethod: "none",
      email: input.signerEmail,
      userName: input.signerName,
      clientUserId: input.clientUserId,
    }),
  });
  if (!result?.url) throw new Error("DocuSign returned no signing URL");
  return result.url;
}

export async function downloadCompletedEnvelope(envelopeId: string): Promise<Buffer> {
  const credentials = await auth();
  const response = await fetch(
    `${credentials.baseUri}/restapi/v2.1/accounts/${credentials.accountId}/envelopes/${encodeURIComponent(envelopeId)}/documents/combined?certificate=true`,
    { headers: { Authorization: `Bearer ${credentials.accessToken}`, Accept: "application/pdf" } },
  );
  if (!response.ok) throw await responseError(response, "DocuSign document download");
  return Buffer.from(await response.arrayBuffer());
}

export function verifyDocusignHmac(rawBody: Buffer | string, signature: string | undefined): boolean {
  const secret = process.env.DOCUSIGN_CONNECT_HMAC_SECRET;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64"); }
  catch { return false; }
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
