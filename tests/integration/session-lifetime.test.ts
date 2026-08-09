import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Session lifetime — a rep must never be signed out mid-shift.
 *
 * The old behaviour was an ABSOLUTE 7-day expiry set at login, so a session
 * minted a week ago died at whatever moment the rep happened to be working:
 * reliably mid-knock. Renewal makes the window "how long you may stay away",
 * not "how long a shift may last".
 */

let rawDb: import("better-sqlite3").Database;
let storageMod: typeof import("../../server/storage");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-session-"));
  ({ rawDb } = await import("../../server/db"));
  storageMod = await import("../../server/storage");
  storageMod.runMigrations();
});

const newUser = (email: string) =>
  storageMod.storage.createUser({ name: "Rep", email, role: "rep" } as any).id;

describe("session lifetime", () => {
  it("issues a session that comfortably outlives a 24h day", () => {
    const s = storageMod.storage.createSession(newUser("a@example.com"));
    const lifeMs = Date.parse(s.expiresAt) - Date.now();
    expect(lifeMs).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it("slides the expiry forward while the rep keeps working", () => {
    const s = storageMod.storage.createSession(newUser("b@example.com"));
    // Wind the clock back: this session is nearly out of road (2h left), exactly
    // the state that used to expire under an active rep.
    const nearlyDead = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    rawDb.prepare(`UPDATE sessions SET expires_at=? WHERE id=?`).run(nearlyDead, s.id);

    const renewed = storageMod.storage.touchSession({ ...s, expiresAt: nearlyDead });
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(nearlyDead));
    // Persisted, not just returned — the next request must see it too.
    const stored = rawDb.prepare(`SELECT expires_at AS e FROM sessions WHERE id=?`).get(s.id) as any;
    expect(Date.parse(stored.e) - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000);
    // And it is still a live session.
    expect(storageMod.storage.getSession(s.id)).toBeTruthy();
  });

  it("does not write on every request - only once the expiry has drifted", () => {
    const s = storageMod.storage.createSession(newUser("c@example.com"));
    // Freshly minted: already at a full TTL, so a renewal would move it by ~0.
    const before = (rawDb.prepare(`SELECT expires_at AS e FROM sessions WHERE id=?`).get(s.id) as any).e;
    storageMod.storage.touchSession(s);
    const after = (rawDb.prepare(`SELECT expires_at AS e FROM sessions WHERE id=?`).get(s.id) as any).e;
    expect(after).toBe(before);
  });

  it("never extends a session past the absolute cap measured from login", () => {
    const s = storageMod.storage.createSession(newUser("d@example.com"));
    // A session still in daily use but approaching the absolute cap: renewal
    // must clamp to the cap rather than hand out another full TTL, so a lost or
    // stolen device eventually falls out no matter how much it is used.
    const capMs = storageMod.SESSION_ABSOLUTE_MAX_MS;
    const created = new Date(Date.now() - (capMs - 24 * 60 * 60 * 1000)).toISOString(); // 1 day of cap left
    const nearlyDead = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    rawDb.prepare(`UPDATE sessions SET created_at=?, expires_at=? WHERE id=?`).run(created, nearlyDead, s.id);

    const renewed = storageMod.storage.touchSession({ ...s, createdAt: created, expiresAt: nearlyDead });
    const capDeadline = Date.parse(created) + capMs;
    expect(Date.parse(renewed.expiresAt)).toBeLessThanOrEqual(capDeadline + 1000);
    // Clamped to the cap (~1 day), NOT extended to a fresh full TTL.
    expect(Date.parse(renewed.expiresAt)).toBeLessThan(Date.now() + storageMod.SESSION_TTL_MS);
    // Still renewed enough to finish the shift.
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(nearlyDead));
  });

  it("expired sessions are rejected and purge-eligible with ISO comparison", () => {
    const s = storageMod.storage.createSession(newUser("e@example.com"));
    // Same-day expiry: the exact case the old datetime('now') comparison missed,
    // because 'T' sorts above ' ' in SQLite's text comparison.
    const justExpired = new Date(Date.now() - 60_000).toISOString();
    rawDb.prepare(`UPDATE sessions SET expires_at=? WHERE id=?`).run(justExpired, s.id);
    expect(storageMod.storage.getSession(s.id)).toBeUndefined();

    const staleWithSqliteFormat = rawDb
      .prepare(`SELECT COUNT(*) c FROM sessions WHERE id=? AND expires_at < datetime('now')`)
      .get(s.id) as any;
    expect(staleWithSqliteFormat.c).toBe(0); // the old, broken predicate misses it
    const purged = rawDb.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(new Date().toISOString()).changes;
    expect(purged).toBeGreaterThanOrEqual(1); // the ISO predicate collects it
  });
});
