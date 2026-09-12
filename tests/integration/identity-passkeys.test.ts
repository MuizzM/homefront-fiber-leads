// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { beginPasskeyCeremony, finishPasskeyAuthentication, finishPasskeyRegistration, passkeyRealm } from "../../server/identity/passkeys";
import { admitIdentityContinuation, continueVerifiedIdentity } from "../../server/identity/admission";
import { readIdentityAccount } from "../../server/identity/model";
import { newIdentityToken } from "../../server/identity/crypto";
import { identityFixture, IDENTITY_NOW as now } from "../helpers/identityFixture";
import { softwareAuthenticator } from "../helpers/softwareAuthenticator";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
vi.mock("@simplewebauthn/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return { ...actual, verifyAuthenticationResponse: vi.fn(actual.verifyAuthenticationResponse) };
});
let db: Database.Database;
beforeEach(() => {
  db = identityFixture(); vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubEnv("IDENTITY_WEBAUTHN_ORIGIN", "https://portal.example.test");
  vi.stubEnv("IDENTITY_WEBAUTHN_RP_ID", "portal.example.test");
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function proof(userId = 3) {
  const account = readIdentityAccount(db, userId)!; const browser = newIdentityToken();
  const result = db.transaction(() => continueVerifiedIdentity(db, { userId, tenantId: account.tenantId, authEpoch: account.authEpoch,
    method: "email", browserToken: browser, deviceToken: newIdentityToken(), deviceLabel: "Fixture" }, Date.now())).immediate();
  if (!("token" in result)) throw new Error(result.code);
  return { ...result, browser };
}
async function enrolled(userId = 3) {
  const p = proof(userId), authenticator = softwareAuthenticator();
  const options = await beginPasskeyCeremony(db, p.token, p.browser, "registration");
  expect(await finishPasskeyRegistration(db, p.token, p.browser, authenticator.registration(options.challenge), "Fixture authenticator")).toMatchObject({ verified: true, recoveryCodes: expect.any(Array) });
  return { p, authenticator };
}

it("registers a real ES256 key, requires local user verification and admits only after the ceremony", async () => {
  const p = proof(), authenticator = softwareAuthenticator();
  const options = await beginPasskeyCeremony(db, p.token, p.browser, "registration");
  expect(options).toMatchObject({ authenticatorSelection: { userVerification: "required" } });
  expect(db.prepare("SELECT * FROM sessions WHERE user_id=3").all()).toEqual([]);
  expect(await finishPasskeyRegistration(db, p.token, p.browser, authenticator.registration(options.challenge), "Fixture")).toMatchObject({ verified: true, recoveryCodes: expect.any(Array) });
  expect(readIdentityAccount(db, 3)?.mfaEnabled).toBe(true);
  expect(db.transaction(() => admitIdentityContinuation(db, p.token, p.browser, now)).immediate().state).toBe("authenticated");
});

it.each(["origin", "rp", "challenge", "uv", "crossOrigin"])("rejects a registration with incorrect %s", async field => {
  const p = proof(), authenticator = softwareAuthenticator();
  const options = await beginPasskeyCeremony(db, p.token, p.browser, "registration");
  const response = authenticator.registration(field === "challenge" ? newIdentityToken() : options.challenge,
    field === "origin" ? "https://foreign.example.test" : undefined, field === "rp" ? "foreign.example.test" : undefined, field !== "uv", field === "crossOrigin");
  expect(await finishPasskeyRegistration(db, p.token, p.browser, response, "Fixture")).toEqual({ verified: false });
  expect(readIdentityAccount(db, 3)?.mfaEnabled).toBe(false);
  expect(db.prepare("SELECT * FROM identity_passkeys").all()).toEqual([]);
});

it("verifies signed assertions and atomically rejects concurrent reuse of the same ceremony", async () => {
  const { authenticator } = await enrolled(); const p = proof();
  const options = await beginPasskeyCeremony(db, p.token, p.browser, "authentication");
  expect(options).toMatchObject({ userVerification: "required", allowCredentials: [{ id: authenticator.id }] });
  const response = authenticator.authentication(options.challenge, 1);
  const results = await Promise.allSettled([
    finishPasskeyAuthentication(db, p.token, p.browser, response),
    finishPasskeyAuthentication(db, p.token, p.browser, response),
  ]);
  expect(results.filter(r => r.status === "fulfilled" && r.value === true)).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(db.prepare("SELECT counter FROM identity_passkeys WHERE user_id=3").get()).toEqual({ counter: 1 });
});

it.each(["origin", "rp", "challenge", "uv", "signature", "credential", "crossOrigin"])("rejects signed authentication with incorrect %s", async field => {
  const { authenticator } = await enrolled(); const p = proof();
  const options = await beginPasskeyCeremony(db, p.token, p.browser, "authentication");
  const response = authenticator.authentication(field === "challenge" ? newIdentityToken() : options.challenge, 1,
    field === "origin" ? "https://foreign.example.test" : undefined, field === "rp" ? "foreign.example.test" : undefined, field !== "uv", field === "crossOrigin");
  if (field === "signature") response.response.signature = Buffer.from("invalid signature").toString("base64url");
  if (field === "credential") response.id = softwareAuthenticator().id;
  expect(await finishPasskeyAuthentication(db, p.token, p.browser, response)).toBe(false);
  expect(db.prepare("SELECT counter FROM identity_passkeys WHERE user_id=3").get()).toEqual({ counter: 0 });
});

it("rejects a repeated counter even with a fresh valid challenge", async () => {
  const { authenticator } = await enrolled(); const p = proof();
  let options = await beginPasskeyCeremony(db, p.token, p.browser, "authentication");
  expect(await finishPasskeyAuthentication(db, p.token, p.browser, authenticator.authentication(options.challenge, 1))).toBe(true);
  const other = proof(); options = await beginPasskeyCeremony(db, other.token, other.browser, "authentication");
  expect(await finishPasskeyAuthentication(db, other.token, other.browser, authenticator.authentication(options.challenge, 1))).toBe(false);
});

it("rejects a different browser, an expired ceremony and changed realm configuration", async () => {
  const { authenticator } = await enrolled(); const p = proof();
  const options = await beginPasskeyCeremony(db, p.token, p.browser, "authentication");
  const response = authenticator.authentication(options.challenge, 1);
  await expect(finishPasskeyAuthentication(db, p.token, newIdentityToken(), response)).rejects.toThrow("REAUTH_REQUIRED");
  vi.spyOn(Date, "now").mockReturnValue(now + 300_000);
  await expect(finishPasskeyAuthentication(db, p.token, p.browser, response)).rejects.toThrow("PASSKEY_CHALLENGE_EXPIRED");
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubEnv("IDENTITY_WEBAUTHN_ORIGIN", "https://other.example.test"); vi.stubEnv("IDENTITY_WEBAUTHN_RP_ID", "other.example.test");
  await expect(finishPasskeyAuthentication(db, p.token, p.browser, response)).rejects.toThrow("PASSKEY_CHALLENGE_EXPIRED");
});

it("fails closed on an insecure or unrelated operator realm", () => {
  vi.stubEnv("IDENTITY_WEBAUTHN_ORIGIN", "http://portal.example.test"); expect(() => passkeyRealm()).toThrow();
  vi.stubEnv("IDENTITY_WEBAUTHN_ORIGIN", "https://foreign.example.test"); expect(() => passkeyRealm()).toThrow();
});

it("rejects a real credential owned by another enrolled user while accepting the requesting user's own key", async () => {
  const own = await enrolled(), foreign = await enrolled(2), p = proof();
  const options = await beginPasskeyCeremony(db, p.token, p.browser, "authentication");
  expect(await finishPasskeyAuthentication(db, p.token, p.browser, foreign.authenticator.authentication(options.challenge, 1))).toBe(false);
  expect(db.prepare("SELECT counter FROM identity_passkeys WHERE user_id=2").get()).toEqual({ counter: 0 });
  expect(await finishPasskeyAuthentication(db, p.token, p.browser, own.authenticator.authentication(options.challenge, 1))).toBe(true);
});

it("permits authenticators with a zero counter while consuming every individual challenge", async () => {
  const { authenticator } = await enrolled();
  for (let n = 0; n < 2; n++) {
    const p = proof(), options = await beginPasskeyCeremony(db, p.token, p.browser, "authentication");
    expect(await finishPasskeyAuthentication(db, p.token, p.browser, authenticator.authentication(options.challenge, 0))).toBe(true);
    expect(db.transaction(() => admitIdentityContinuation(db, p.token, p.browser, now)).immediate().state).toBe("authenticated");
  }
});

it.each(["revoke", "realm", "key", "challenge"])("rejects %s changes while a signature verification is in flight", async change => {
  const { authenticator } = await enrolled(), p = proof();
  const options = await beginPasskeyCeremony(db, p.token, p.browser, "authentication");
  const actual = await vi.importActual<typeof import("@simplewebauthn/server")>("@simplewebauthn/server");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(verifyAuthenticationResponse).mockImplementationOnce(async input => {
    entered(); await gate; return actual.verifyAuthenticationResponse(input);
  });
  const pending = finishPasskeyAuthentication(db, p.token, p.browser, authenticator.authentication(options.challenge, 1));
  const rejected = expect(pending).rejects.toThrow();
  await started;
  if (change === "revoke") db.exec("UPDATE users SET active=0 WHERE id=3");
  if (change === "realm") db.exec("UPDATE identity_passkeys SET rp_id='foreign.example.test' WHERE user_id=3");
  if (change === "key") db.exec("UPDATE identity_passkeys SET public_key=x'1234' WHERE user_id=3");
  if (change === "challenge") await beginPasskeyCeremony(db, p.token, p.browser, "authentication");
  release(); await rejected;
  expect(db.prepare("SELECT counter FROM identity_passkeys WHERE user_id=3").get()).toEqual({ counter: 0 });
});

it("reserves a bounded shared crypto budget before concurrent verification starts", async () => {
  const { authenticator } = await enrolled(), p = proof();
  const options = await beginPasskeyCeremony(db, p.token, p.browser, "authentication");
  const before = vi.mocked(verifyAuthenticationResponse).mock.calls.length;
  const response = authenticator.authentication(options.challenge, 1);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => finishPasskeyAuthentication(db, p.token, p.browser, response)));
  expect(results.filter(result => result.status === "fulfilled" && result.value)).toHaveLength(1);
  expect(vi.mocked(verifyAuthenticationResponse).mock.calls.length - before).toBe(9); // registration reserved the first slot
  expect(db.prepare("SELECT attempts FROM identity_mfa_crypto_budget WHERE user_id=3").get()).toEqual({ attempts: 10 });
});
