import crypto from "node:crypto";

const TOKEN_VERSION = 1;

export interface OnboardingInviteTokenPayload {
  v: 1;
  rid: string;
  tid: number;
  email: string;
  exp: string;
}

function inviteSecret(): string {
  const configured = process.env.ONBOARDING_INVITE_SECRET?.trim() || "";
  if (configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("ONBOARDING_INVITE_SECRET must be configured with at least 32 characters");
  }
  return "homefront-development-invite-secret-change-before-production";
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signature(body: string): string {
  return crypto.createHmac("sha256", inviteSecret()).update(body).digest("base64url");
}

export function hashInviteToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createInviteToken(input: {
  recordId: string;
  tenantId: number;
  email: string;
  expiresAt: string;
}): string {
  const payload: OnboardingInviteTokenPayload = {
    v: TOKEN_VERSION,
    rid: input.recordId,
    tid: input.tenantId,
    email: input.email.trim().toLowerCase(),
    exp: input.expiresAt,
  };
  const body = encode(JSON.stringify(payload));
  return `${body}.${signature(body)}`;
}

export function verifyInviteToken(token: string, now = new Date()): OnboardingInviteTokenPayload | null {
  if (token.length < 64 || token.length > 2048) return null;
  const [body, suppliedSignature, extra] = token.split(".");
  if (!body || !suppliedSignature || extra) return null;
  const expected = signature(body);
  const supplied = Buffer.from(suppliedSignature);
  const expectedBytes = Buffer.from(expected);
  if (supplied.length !== expectedBytes.length || !crypto.timingSafeEqual(supplied, expectedBytes)) return null;
  try {
    const payload = JSON.parse(decode(body)) as Partial<OnboardingInviteTokenPayload>;
    if (payload.v !== TOKEN_VERSION || typeof payload.rid !== "string" || !Number.isInteger(payload.tid) ||
        typeof payload.email !== "string" || typeof payload.exp !== "string") return null;
    if (!/^[0-9a-f-]{36}$/i.test(payload.rid) || !payload.email.includes("@")) return null;
    if (!Number.isFinite(new Date(payload.exp).getTime()) || new Date(payload.exp).getTime() <= now.getTime()) return null;
    return payload as OnboardingInviteTokenPayload;
  } catch {
    return null;
  }
}
