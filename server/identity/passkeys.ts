import type Database from "better-sqlite3";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON, type AuthenticatorTransport } from "@simplewebauthn/server";
import { interactiveTransaction } from "../interactiveDb";
import { newIdentityToken } from "./crypto";
import { IdentityConflict, identityAudit } from "./lifecycle";
import { requireMfaContinuation, hasCurrentHomefrontMfa, recordMfaFailure, advanceMfaAuthority, replaceRecoveryCodes } from "./mfa";

const MAX_PASSKEYS = 10;
const ALGORITHMS = [-7, -257];
interface Challenge { kind: "registration" | "authentication"; challenge: string; rp_id: string; origin: string; factor_revision: number; created_at: number }
interface Passkey { credential_id: string; user_id: number; public_key: Buffer; counter: number; revision: number; rp_id: string; transports: string }

function reserveCryptoVerification(db: Database.Database, userId: number, now: number): void {
  // Reserve before asynchronous crypto. Counting only completed failures lets
  // concurrent requests start unbounded work before any failure is recorded.
  const reserved = db.prepare(`INSERT INTO identity_mfa_crypto_budget(user_id,window_start,attempts) VALUES(?,?,1)
    ON CONFLICT(user_id) DO UPDATE SET
      window_start=CASE WHEN window_start+60000<=excluded.window_start THEN excluded.window_start ELSE window_start END,
      attempts=CASE WHEN window_start+60000<=excluded.window_start THEN 1 ELSE attempts+1 END
    WHERE window_start+60000<=excluded.window_start OR attempts<10`).run(userId, now);
  if (reserved.changes !== 1) throw new IdentityConflict("MFA_RATE_LIMIT");
}
function boundResponse(response: unknown): void {
  if (!response || Buffer.byteLength(JSON.stringify(response)) > 65536) throw new IdentityConflict("INVALID_PASSKEY_RESPONSE");
}
function firstPartyClient(encoded: unknown): boolean {
  if (typeof encoded !== "string" || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return false;
  try {
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return data && typeof data === "object" && !Array.isArray(data)
      && (data.crossOrigin === undefined || data.crossOrigin === false) && data.topOrigin === undefined;
  } catch { return false; }
}

/** Configuration is operator-owned; never derive RP/origin from forwarded
 * request headers or accept an arbitrary browser-supplied origin. */
export function passkeyRealm(): { rpId: string; origin: string } {
  const origin = process.env.IDENTITY_WEBAUTHN_ORIGIN ?? "";
  const rpId = process.env.IDENTITY_WEBAUTHN_RP_ID ?? "";
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error("Passkey origin is not configured"); }
  const local = process.env.NODE_ENV !== "production" && url.hostname === "localhost" && rpId === "localhost";
  if ((!local && url.protocol !== "https:") || url.origin !== origin || url.username || url.password
      || (!local && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(rpId))
      || !(url.hostname === rpId || url.hostname.endsWith(`.${rpId}`))) throw new Error("Invalid passkey realm");
  return { rpId, origin };
}
function currentChallenge(db: Database.Database, hash: string, kind: Challenge["kind"], revision: number, now: number): Challenge {
  const realm = passkeyRealm();
  const challenge = db.prepare("SELECT * FROM identity_webauthn_challenges WHERE continuation_hash=?").get(hash) as Challenge | undefined;
  if (!challenge || challenge.kind !== kind || challenge.rp_id !== realm.rpId || challenge.origin !== realm.origin
      || challenge.factor_revision !== revision || challenge.created_at > now || challenge.created_at + 300_000 <= now) {
    throw new IdentityConflict("PASSKEY_CHALLENGE_EXPIRED");
  }
  return challenge;
}

export async function beginPasskeyCeremony(db: Database.Database, token: string, browser: string, kind: Challenge["kind"]) {
  const realm = passkeyRealm();
  const state = await interactiveTransaction(db, () => {
    const now = Date.now(), { proof, account } = requireMfaContinuation(db, token, browser, now);
    if (kind === "registration" && account.mfaEnabled && !hasCurrentHomefrontMfa(proof, account, now)) throw new IdentityConflict("MFA_REQUIRED");
    const keys = db.prepare("SELECT credential_id,transports FROM identity_passkeys WHERE user_id=? AND rp_id=? LIMIT ?")
      .all(account.userId, realm.rpId, MAX_PASSKEYS + 1) as Array<{ credential_id: string; transports: string }>;
    if (kind === "registration" && keys.length >= MAX_PASSKEYS) throw new IdentityConflict("PASSKEY_LIMIT");
    if (kind === "authentication" && (!account.mfaEnabled || !keys.length)) throw new IdentityConflict("PASSKEY_NOT_ENROLLED");
    db.prepare("INSERT OR IGNORE INTO identity_webauthn_users(user_id,handle) VALUES(?,?)").run(account.userId, newIdentityToken());
    const handle = (db.prepare("SELECT handle FROM identity_webauthn_users WHERE user_id=?").get(account.userId) as { handle: string }).handle;
    const challenge = newIdentityToken();
    db.prepare(`INSERT INTO identity_webauthn_challenges(continuation_hash,kind,challenge,rp_id,origin,factor_revision,created_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(continuation_hash) DO UPDATE SET kind=excluded.kind,challenge=excluded.challenge,
      rp_id=excluded.rp_id,origin=excluded.origin,factor_revision=excluded.factor_revision,created_at=excluded.created_at`)
      .run(proof.token_hash, kind, challenge, realm.rpId, realm.origin, account.factorRevision, now);
    return { account, challenge, handle, keys };
  });
  const credentials = state.keys.map(key => ({ id: key.credential_id, transports: JSON.parse(key.transports) as AuthenticatorTransport[] }));
  // Library crypto is asynchronous; it must not keep a SQLite transaction open.
  return kind === "registration" ? generateRegistrationOptions({ rpName: "Homefront", rpID: realm.rpId,
    userName: state.account.email, userDisplayName: state.account.name, userID: new Uint8Array(Buffer.from(state.handle, "base64url")),
    challenge: new Uint8Array(Buffer.from(state.challenge, "base64url")), timeout: 60_000, attestationType: "none", excludeCredentials: credentials,
    supportedAlgorithmIDs: ALGORITHMS, authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  }) : generateAuthenticationOptions({ rpID: realm.rpId, challenge: new Uint8Array(Buffer.from(state.challenge, "base64url")), allowCredentials: credentials,
    userVerification: "required", timeout: 60_000 });
}

export async function finishPasskeyRegistration(db: Database.Database, token: string, browser: string,
  response: RegistrationResponseJSON, label: string): Promise<{ verified: false } | { verified: true; recoveryCodes: string[] | null }> {
  boundResponse(response);
  if (typeof label !== "string" || !label.trim() || label.length > 120 || /[\u0000-\u001f\u007f]/.test(label)) throw new IdentityConflict("INVALID_DEVICE_LABEL");
  const snapshot = await interactiveTransaction(db, () => {
    const now = Date.now(), current = requireMfaContinuation(db, token, browser, now);
    if (current.account.mfaEnabled && !hasCurrentHomefrontMfa(current.proof, current.account, now)) throw new IdentityConflict("MFA_REQUIRED");
    const challenge = currentChallenge(db, current.proof.token_hash, "registration", current.account.factorRevision, now);
    reserveCryptoVerification(db, current.account.userId, now);
    return { ...current, challenge };
  });
  const verification = firstPartyClient(response.response?.clientDataJSON) ? await verifyRegistrationResponse({ response, expectedChallenge: snapshot.challenge.challenge,
    expectedOrigin: snapshot.challenge.origin, expectedRPID: snapshot.challenge.rp_id, requireUserVerification: true,
    requireUserPresence: true, supportedAlgorithmIDs: ALGORITHMS }).catch(() => null) : null;
  return interactiveTransaction(db, () => {
    const now = Date.now(), { proof, account } = requireMfaContinuation(db, token, browser, now);
    const challenge = currentChallenge(db, proof.token_hash, "registration", account.factorRevision, now);
    if (challenge.challenge !== snapshot.challenge.challenge || account.authEpoch !== snapshot.account.authEpoch) throw new IdentityConflict("REAUTH_REQUIRED");
    if (!verification?.verified || !verification.registrationInfo.userVerified) { recordMfaFailure(db, proof, now); return { verified: false as const }; }
    const existing = db.prepare("SELECT credential_id FROM identity_passkeys WHERE user_id=? LIMIT ?").all(account.userId, MAX_PASSKEYS);
    if (existing.length >= MAX_PASSKEYS) throw new IdentityConflict("PASSKEY_LIMIT");
    const info = verification.registrationInfo, key = info.credential;
    if (db.prepare("SELECT 1 FROM identity_passkeys WHERE credential_id=?").get(key.id)) throw new IdentityConflict("PASSKEY_ALREADY_REGISTERED");
    db.prepare(`INSERT INTO identity_passkeys(credential_id,user_id,public_key,counter,rp_id,label,transports,device_type,backed_up,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(key.id, account.userId, Buffer.from(key.publicKey), key.counter,
        challenge.rp_id, label.trim(), JSON.stringify(key.transports ?? []), info.credentialDeviceType, Number(info.credentialBackedUp), now);
    const updated = advanceMfaAuthority(db, proof, "webauthn", now);
    const recoveryCodes = !account.mfaEnabled ? replaceRecoveryCodes(db, account.userId, now) : null;
    identityAudit(db, account.tenantId, account.userId, account.userId, "identity.passkey_enrolled", { revision: updated.factorRevision }, now);
    return { verified: true as const, recoveryCodes };
  });
}

export async function finishPasskeyAuthentication(db: Database.Database, token: string, browser: string,
  response: AuthenticationResponseJSON): Promise<boolean> {
  boundResponse(response);
  const snapshot = await interactiveTransaction(db, () => {
    const now = Date.now(), current = requireMfaContinuation(db, token, browser, now);
    const challenge = currentChallenge(db, current.proof.token_hash, "authentication", current.account.factorRevision, now);
    const key = typeof response?.id === "string" && response.id.length <= 2048
      ? db.prepare("SELECT * FROM identity_passkeys WHERE credential_id=? AND user_id=? AND rp_id=?")
        .get(response.id, current.account.userId, challenge.rp_id) as Passkey | undefined : undefined;
    reserveCryptoVerification(db, current.account.userId, now);
    return { ...current, challenge, key };
  });
  const verification = snapshot.key && firstPartyClient(response.response?.clientDataJSON) ? await verifyAuthenticationResponse({ response, expectedChallenge: snapshot.challenge.challenge,
    expectedOrigin: snapshot.challenge.origin, expectedRPID: snapshot.challenge.rp_id, requireUserVerification: true,
    credential: { id: snapshot.key.credential_id, publicKey: new Uint8Array(snapshot.key.public_key), counter: snapshot.key.counter,
      transports: JSON.parse(snapshot.key.transports) as AuthenticatorTransport[] },
  }).catch(() => null) : null;
  return interactiveTransaction(db, () => {
    const now = Date.now(), { proof, account } = requireMfaContinuation(db, token, browser, now);
    const challenge = currentChallenge(db, proof.token_hash, "authentication", account.factorRevision, now);
    if (challenge.challenge !== snapshot.challenge.challenge || account.authEpoch !== snapshot.account.authEpoch) throw new IdentityConflict("REAUTH_REQUIRED");
    if (!snapshot.key || !verification?.verified || !verification.authenticationInfo.userVerified) { recordMfaFailure(db, proof, now); return false; }
    const info = verification.authenticationInfo;
    const changed = db.prepare(`UPDATE identity_passkeys SET counter=?,revision=revision+1,last_used_at=?,backed_up=?
      WHERE credential_id=? AND user_id=? AND counter=? AND revision=? AND public_key=? AND rp_id=?`)
      .run(info.newCounter, now, Number(info.credentialBackedUp), snapshot.key.credential_id, account.userId,
        snapshot.key.counter, snapshot.key.revision, snapshot.key.public_key, snapshot.key.rp_id);
    if (changed.changes !== 1) throw new IdentityConflict("REAUTH_REQUIRED");
    db.prepare("DELETE FROM identity_webauthn_challenges WHERE continuation_hash=?").run(proof.token_hash);
    db.prepare("UPDATE identity_continuations SET mfa_method='webauthn',mfa_verified_at=?,factor_revision=? WHERE token_hash=?")
      .run(now, account.factorRevision, proof.token_hash);
    identityAudit(db, account.tenantId, account.userId, account.userId, "identity.mfa_verified", { method: "webauthn" }, now);
    return true;
  });
}
