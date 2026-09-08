// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { admitIdentityContinuation, continueVerifiedIdentity } from "../../server/identity/admission";
import { hashIdentityToken, newIdentityToken } from "../../server/identity/crypto";
import { readIdentityAccount, sessionAdmission } from "../../server/identity/model";
import { readSessionAssurance, provisionManagedAccount, reviewManagedAccount } from "../../server/identity/lifecycle";
import { interactiveTransaction } from "../../server/interactiveDb";
import { identityFixture, IDENTITY_NOW as now } from "../helpers/identityFixture";
let db: Database.Database;
beforeEach(() => { db = identityFixture(); });
afterEach(() => { if (db.open) db.close(); });
function continuation(database = db, userId = 3, when = now) {
  const account = readIdentityAccount(database, userId)!;
  const browser = newIdentityToken(), device = newIdentityToken();
  const result = database.transaction(() => continueVerifiedIdentity(database, { userId, tenantId: account.tenantId,
    authEpoch: account.authEpoch, method: "email", browserToken: browser, deviceToken: device, deviceLabel: "Test browser" }, when)).immediate();
  if (!("token" in result)) throw new Error(result.code);
  return { ...result, browser, device };
}
function finish(proof: { token: string; browser: string }, when = now) {
  return db.transaction(() => admitIdentityContinuation(db, proof.token, proof.browser, when)).immediate();
}
function policy(values: { mfa?: boolean; limit?: number; idle?: number; absolute?: number }) {
  db.prepare(`INSERT INTO identity_policies(tenant_id,require_mfa,session_limit,idle_timeout_ms,absolute_timeout_ms,updated_at)
    VALUES(1,?,?,?,?,?)`).run(Number(values.mfa ?? false), values.limit ?? null, values.idle ?? null, values.absolute ?? null, now);
}
function enableMfa() {
  db.exec("INSERT INTO identity_mfa_state(user_id) VALUES(3); UPDATE identity_mfa_state SET enabled=1,revision=1 WHERE user_id=3");
}
function proveMfa(proof: { token: string }, method = "totp", when = now + 500) {
  db.prepare("UPDATE identity_continuations SET mfa_method=?,mfa_verified_at=?,factor_revision=1 WHERE token_hash=?")
    .run(method, when, hashIdentityToken(proof.token, "continuation"));
}

it("keeps a browser-bound primary continuation separate from sessions and consumes it exactly once", () => {
  const proof = continuation();
  expect(db.prepare("SELECT * FROM sessions WHERE user_id=3").all()).toEqual([]);
  const persisted = JSON.stringify(db.prepare("SELECT * FROM identity_continuations").all());
  expect(persisted).not.toContain(proof.token); expect(persisted).not.toContain(proof.browser); expect(persisted).not.toContain(proof.device);
  expect(finish({ ...proof, browser: newIdentityToken() })).toEqual({ state: "denied", code: "REAUTH_REQUIRED" });
  const admitted = finish(proof, now + 1000);
  expect(admitted.state).toBe("authenticated");
  if (admitted.state !== "authenticated") throw new Error("Expected admitted session");
  expect(sessionAdmission(readIdentityAccount(db, 3), admitted.session, readSessionAssurance(db, admitted.session.id), now + 1001)).toEqual({ allowed: true });
  expect(finish(proof, now + 1001)).toEqual(admitted);
  expect(db.prepare("SELECT count(*) AS n FROM sessions WHERE user_id=3").get()).toEqual({ n: 1 });
});

it("recovers a lost final response without using another slot, but refuses foreign, expired or revoked receipts", () => {
  policy({ limit: 1 }); const proof = continuation();
  const first = finish(proof);
  expect(first.state).toBe("authenticated");
  const writes = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  expect(finish(proof, now + 1000)).toEqual(first);
  expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(writes);
  expect(finish({ ...proof, browser: newIdentityToken() }, now + 1000)).toEqual({ state: "denied", code: "REAUTH_REQUIRED" });
  expect(finish(proof, now + 120_000)).toEqual({ state: "denied", code: "REAUTH_REQUIRED" });
  db.exec("UPDATE users SET active=0 WHERE id=3; UPDATE users SET active=1 WHERE id=3");
  expect(finish(proof, now + 1001)).toEqual({ state: "denied", code: "REAUTH_REQUIRED" });
});

it("enforces current Homefront MFA even when enabled after primary proof, excluding IdP/SMS evidence", () => {
  const proof = continuation(); policy({ mfa: true });
  expect(finish(proof)).toEqual({ state: "mfa_required", enroll: true });
  enableMfa(); // factor change invalidates old primary proofs
  expect(finish(proof)).toEqual({ state: "denied", code: "REAUTH_REQUIRED" });
  const current = continuation();
  expect(finish(current)).toEqual({ state: "mfa_required", enroll: false });
  proveMfa(current, "sms");
  expect(finish(current, now + 1000)).toEqual({ state: "mfa_required", enroll: false });
  proveMfa(current, "totp");
  const result = finish(current, now + 1000);
  expect(result.state).toBe("authenticated");
  if (result.state !== "authenticated") throw new Error("Expected admitted session");
  expect(sessionAdmission(readIdentityAccount(db, 3), result.session, readSessionAssurance(db, result.session.id), now + 1001)).toEqual({ allowed: true });
});

it("requires voluntary MFA as well as tenant-required MFA and rejects stale factor revisions", () => {
  enableMfa(); const proof = continuation();
  expect(finish(proof)).toEqual({ state: "mfa_required", enroll: false });
  proveMfa(proof);
  db.exec("UPDATE identity_continuations SET factor_revision=0");
  expect(finish(proof, now + 1000)).toEqual({ state: "mfa_required", enroll: false });
});

it("blocks overflow without consuming the pending proof or evicting the existing device", () => {
  policy({ limit: 1 }); const first = continuation(), second = continuation();
  const winner = finish(first);
  expect(winner.state).toBe("authenticated");
  const sessions = db.prepare("SELECT * FROM sessions WHERE user_id=3").all();
  expect(finish(second)).toEqual({ state: "session_limit", limit: 1 });
  expect(db.prepare("SELECT * FROM sessions WHERE user_id=3").all()).toEqual(sessions);
  expect(db.prepare("SELECT count(*) AS n FROM identity_continuations").get()).toEqual({ n: 1 });
  // Explicit revocation creates a slot; retrying the same proof then succeeds.
  if (winner.state === "authenticated") db.prepare("DELETE FROM sessions WHERE id=?").run(winner.session.id);
  expect(finish(second, now + 1000).state).toBe("authenticated");
});

it("counts only currently valid sessions and uses current idle and absolute deadlines", () => {
  policy({ limit: 1, idle: 300_000, absolute: 3600_000 });
  db.exec("INSERT INTO sessions VALUES('expired',3,'2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z')");
  const admitted = finish(continuation());
  if (admitted.state !== "authenticated") throw new Error("Expected admitted session");
  expect(Date.parse(admitted.session.expiresAt) - now).toBe(300_000);
  const account = readIdentityAccount(db, 3), assurance = readSessionAssurance(db, admitted.session.id);
  expect(sessionAdmission(account, admitted.session, assurance, now + 299_999)).toEqual({ allowed: true });
  expect(sessionAdmission(account, admitted.session, assurance, now + 300_000)).toEqual({ allowed: false, code: "SESSION_EXPIRED" });
});

it("rolls back proof consumption, devices and sessions when final persistence fails", () => {
  const proof = continuation();
  db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON identity_session_assurance BEGIN SELECT RAISE(ABORT,'fixture insert failure'); END");
  expect(() => finish(proof)).toThrow("fixture insert failure");
  expect(db.prepare("SELECT * FROM sessions WHERE user_id=3").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM identity_devices WHERE user_id=3").all()).toEqual([]);
  expect(db.prepare("SELECT count(*) AS n FROM identity_continuations").get()).toEqual({ n: 1 });
  db.exec("DROP TRIGGER fixture_fail");
  expect(finish(proof).state).toBe("authenticated");
});

it("rejects expired and revoked continuations and bounds per-user pending state", () => {
  const proof = continuation();
  expect(finish(proof, now + 600_000)).toEqual({ state: "denied", code: "REAUTH_REQUIRED" });
  db.exec("UPDATE users SET active=0 WHERE id=3; UPDATE users SET active=1 WHERE id=3");
  expect(finish(proof)).toEqual({ state: "denied", code: "REAUTH_REQUIRED" });
  for (let n = 0; n < 5; n++) continuation();
  expect(() => continuation()).toThrow("PENDING_LOGIN_LIMIT");
  expect(db.prepare("SELECT count(*) AS n FROM identity_continuations").get()).toEqual({ n: 5 });
});

it("uses one writer decision for competing processes blocked on the last session slot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-identity-admission-")), file = join(dir, "fixture.db");
  const first = identityFixture(file), second = new Database(file);
  const children: ReturnType<typeof fork>[] = [];
  try {
    first.prepare("INSERT INTO identity_policies(tenant_id,session_limit,updated_at) VALUES(1,1,?)").run(now);
    const a = continuation(first), b = continuation(second);
    first.exec("BEGIN IMMEDIATE");
    const launch = (proof: { token: string; browser: string }) => {
      const child = fork(fileURLToPath(new URL("../fixtures/identityAdmissionChild.ts", import.meta.url)),
        [file, proof.token, proof.browser, String(now)], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
      children.push(child);
      let unblock!: () => void;
      const blocked = new Promise<void>(resolve => { unblock = resolve; });
      const result = new Promise<string>((resolve, reject) => {
        child.on("error", reject);
        child.on("message", (message: any) => {
          if (message.state === "blocked") unblock();
          if (message.state === "result") resolve(message.result);
          if (message.state === "error") reject(new Error(message.error));
        });
        child.on("exit", code => { if (code !== 0) reject(new Error(`Fixture worker exited ${code}`)); });
      });
      return { blocked, result };
    };
    const contenders = [launch(a), launch(b)];
    const outcome = Promise.all(contenders.map(c => c.result));
    await Promise.all(contenders.map(c => c.blocked));
    first.exec("COMMIT");
    expect((await outcome).sort()).toEqual(["authenticated", "session_limit"]);
    expect(first.prepare("SELECT count(*) AS n FROM sessions WHERE user_id=3").get()).toEqual({ n: 1 });
    expect(first.prepare("SELECT count(*) AS n FROM identity_continuations WHERE user_id=3").get()).toEqual({ n: 1 });
  } finally { if (first.inTransaction) first.exec("ROLLBACK"); for (const child of children) child.kill(); second.close(); first.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("moves a legacy browser binding to the current tenant without carrying prior trust", () => {
  const original = continuation();
  expect(finish(original).state).toBe("authenticated");
  db.exec("UPDATE identity_devices SET trusted=1 WHERE user_id=3; UPDATE users SET tenant_id=2 WHERE id=3");
  const account = readIdentityAccount(db, 3)!;
  const current = db.transaction(() => continueVerifiedIdentity(db, { userId: 3, tenantId: 2, authEpoch: account.authEpoch,
    method: "email", browserToken: original.browser, deviceToken: original.device, deviceLabel: "Current browser" }, now)).immediate();
  if (!("token" in current)) throw new Error(current.code);
  expect(finish({ ...current, browser: original.browser }).state).toBe("authenticated");
  expect(db.prepare("SELECT tenant_id,trusted FROM identity_devices WHERE user_id=3").all()).toEqual([{ tenant_id: 2, trusted: 0 }]);
});

it("applies stricter policy to existing sessions even while their stored expiration is in the future", () => {
  const issued = finish(continuation());
  if (issued.state !== "authenticated") throw new Error("Expected admission");
  const assurance = readSessionAssurance(db, issued.session.id);
  policy({ mfa: true });
  expect(sessionAdmission(readIdentityAccount(db, 3), issued.session, assurance, now + 1)).toEqual({ allowed: false, code: "MFA_REQUIRED" });
  db.exec("UPDATE identity_policies SET require_mfa=0,require_sso=1");
  expect(sessionAdmission(readIdentityAccount(db, 3), issued.session, assurance, now + 1)).toEqual({ allowed: false, code: "SSO_REQUIRED" });
  db.exec("UPDATE identity_policies SET require_sso=0,idle_timeout_ms=300000,absolute_timeout_ms=3600000,session_limit=1");
  expect(sessionAdmission(readIdentityAccount(db, 3), issued.session, assurance, now + 300_000)).toEqual({ allowed: false, code: "SESSION_EXPIRED" });
  expect(finish(continuation(db, 3, now + 300_001), now + 300_001).state).toBe("authenticated");
  // Recent activity cannot extend the original absolute deadline.
  expect(sessionAdmission(readIdentityAccount(db, 3), issued.session, { ...assurance!, lastActivityAt: now + 3599_000 }, now + 3600_000))
    .toEqual({ allowed: false, code: "SESSION_EXPIRED" });
});

it("rechecks approval authority and policy after a held writer commits revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-identity-contention-")), file = join(dir, "fixture.db");
  const request = identityFixture(file), writer = new Database(file);
  try {
    const user = request.transaction(() => provisionManagedAccount(request, { tenantId: 1, email: "pending@example.test", name: "Pending" }, now)).immediate();
    writer.exec("BEGIN IMMEDIATE; DELETE FROM sessions WHERE id='admin1'");
    const review = interactiveTransaction(request, () => reviewManagedAccount(request, {
      adminSessionId: "admin1", tenantId: 1, userId: user.userId, expectedGeneration: 1, decision: "approved",
    }, now));
    const assertion = expect(review).rejects.toThrow("ADMIN_AUTHORITY_REQUIRED");
    setTimeout(() => writer.exec("COMMIT"), 40);
    await assertion;
    expect(readIdentityAccount(request, user.userId)?.managed?.approval).toBe("pending");
    const proof = continuation(request);
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("INSERT INTO identity_policies(tenant_id,require_mfa,updated_at) VALUES(1,1,?)").run(now);
    const pending = interactiveTransaction(request, () => admitIdentityContinuation(request, proof.token, proof.browser, now));
    setTimeout(() => writer.exec("COMMIT"), 40);
    expect(await pending).toEqual({ state: "mfa_required", enroll: true });
    expect(request.prepare("SELECT * FROM sessions WHERE user_id=3").all()).toEqual([]);
  } finally { if (writer.inTransaction) writer.exec("ROLLBACK"); writer.close(); request.close(); rmSync(dir, { recursive: true, force: true }); }
});
