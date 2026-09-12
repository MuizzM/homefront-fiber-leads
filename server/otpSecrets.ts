import { timingSafeEqual } from "node:crypto";
import { decryptSensitive, encryptSensitive, encryptionKeyReady } from "./calling/crypto";

const keys = { otp: "OTP_ENCRYPTION_KEY", calling: "CALLING_DATA_ENCRYPTION_KEY" } as const;
export function otpEncryptionReady(): boolean {
  return encryptionKeyReady(keys.otp) || encryptionKeyReady(keys.calling);
}
export function protectOtpSecret(value: unknown): string {
  const kid = encryptionKeyReady(keys.otp) ? "otp" : "calling";
  return `otp1.${kid}.${encryptSensitive(JSON.stringify(value), keys[kid])}`;
}
export function revealOtpSecret<T>(value: string): T {
  const [version, kid, ...encrypted] = value.split(".");
  if (version !== "otp1" || !(kid in keys)) throw new Error("Invalid protected OTP envelope");
  return JSON.parse(decryptSensitive(encrypted.join("."), keys[kid as keyof typeof keys])) as T;
}
/** Dual reader survives flag rollback; old plaintext codes expire naturally. */
export function otpCodeMatches(stored: string, email: string, candidate: string): boolean {
  let code = stored;
  if (stored.startsWith("otp1.")) {
    const decoded = revealOtpSecret<{ purpose: string; email: string; code: string }>(stored);
    if (decoded.purpose !== "verify" || decoded.email !== email) return false;
    code = decoded.code;
  }
  if (!/^\d{6}$/.test(code) || !/^\d{6}$/.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(code), Buffer.from(candidate));
}
