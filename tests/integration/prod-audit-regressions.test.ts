// Regressions from the 2026-08-31 read-only prod portal audit.
//
//   * closeRunawayClockSessions: a dead phone / deleted rep leaves an open
//     clock session forever (prod had a 111h "shift" and an unclosable
//     "Unknown · since 04:57 AM" row). The sweep caps them at clock-in + cap.
//   * login-attempt reads: the deployment's own diagnostic probes
//     (probe-*.diag@example.com) ride the tenant_id IS NULL clause into every
//     org's Login Activity screen. Tenant-scoped reads must exclude them;
//     the unscoped super-admin view must keep them.
//   * getLeadFacets: scan projectors write UPPERCASE cities while imports
//     title-case them; the byte-exact DISTINCT listed both spellings as two
//     territories ("Concord, NC" beside "CONCORD, NC").
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

const T1 = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-audit-regr-"));
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
});

describe("closeRunawayClockSessions", () => {
  it("closes only sessions past the cap, at clock-in + cap, and reports them", () => {
    const now = Date.now();
    const old = new Date(now - 5 * 24 * 3600_000).toISOString();   // 5 days open
    const fresh = new Date(now - 2 * 3600_000).toISOString();      // 2h open — a real shift
    rawDb.prepare(`INSERT INTO clock_sessions (rep_id, user_id, tenant_id, clocked_in, date)
                   VALUES (999, 1, ?, ?, ?)`).run(T1, old, old.slice(0, 10));
    rawDb.prepare(`INSERT INTO clock_sessions (rep_id, user_id, tenant_id, clocked_in, date)
                   VALUES (998, 1, ?, ?, ?)`).run(T1, fresh, fresh.slice(0, 10));

    const closed = storage.closeRunawayClockSessions(16 * 60);
    expect(closed.length).toBe(1);
    expect(closed[0].repId).toBe(999);
    expect(closed[0].tenantId).toBe(T1);

    const row: any = rawDb.prepare(`SELECT clocked_in, clocked_out, duration_minutes
                                      FROM clock_sessions WHERE rep_id = 999`).get();
    expect(row.duration_minutes).toBe(16 * 60);
    // Stamped at clock-in + cap, not "now": the recorded duration is the cap.
    const expectedOut = new Date(new Date(row.clocked_in).getTime() + 16 * 3600_000).getTime();
    expect(Math.abs(new Date(row.clocked_out).getTime() - expectedOut)).toBeLessThan(1500);

    const open: any = rawDb.prepare(`SELECT clocked_out FROM clock_sessions WHERE rep_id = 998`).get();
    expect(open.clocked_out).toBeNull();

    // Idempotent: a second sweep finds nothing.
    expect(storage.closeRunawayClockSessions(16 * 60).length).toBe(0);
  });
});

describe("login-attempt reads exclude diagnostic probes from tenant views", () => {
  it("filters probe identities from the org list and summary, keeps them for super admin", () => {
    storage.logLoginAttempt("probe-lat-1.diag@example.com", "request", false, "unknown_email", "1.1.1.1", "ua", null);
    storage.logLoginAttempt("nobody.diagnostic.probe@example.com", "request", false, "unknown_email", "1.1.1.1", "ua", null);
    storage.logLoginAttempt("typo@gmail.com", "request", false, "unknown_email", "2.2.2.2", "ua", null);
    storage.logLoginAttempt("real.rep@gmail.com", "verify", true, "ok", "3.3.3.3", "ua", T1);

    const scoped = storage.getLoginAttempts(200, undefined, T1).map((r: any) => r.email);
    expect(scoped).toContain("real.rep@gmail.com");
    expect(scoped).toContain("typo@gmail.com"); // a genuine mistyped login stays visible
    expect(scoped.some((e: string) => e.includes(".diag@") || e.includes(".probe@"))).toBe(false);

    const summary = storage.getLoginAttemptSummary(T1).map((r: any) => r.email);
    expect(summary).toContain("real.rep@gmail.com");
    expect(summary.some((e: string) => e.includes(".diag@") || e.includes(".probe@"))).toBe(false);

    // The unscoped (super-admin) view still sees everything.
    const all = storage.getLoginAttempts(200).map((r: any) => r.email);
    expect(all).toContain("probe-lat-1.diag@example.com");
    expect(all).toContain("nobody.diagnostic.probe@example.com");
  });
});

describe("getLeadFacets dedupes case-split territories", () => {
  it("returns one entry per (city, state) regardless of spelling case", () => {
    const now = new Date().toISOString();
    const ins = rawDb.prepare(
      `INSERT INTO leads (tenant_id, address, city, state, zip, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`);
    ins.run(T1, "1 Main St", "Concord", "NC", "28025", now, now);
    ins.run(T1, "2 Main St", "CONCORD", "NC", "28025", now, now);
    ins.run(T1, "3 Main St", "concord", "NC", "28025", now, now);
    ins.run(T1, "4 Oak St", "Inman", "SC", "29349", now, now);

    const facets = storage.getLeadFacets(T1);
    const concord = facets.filter(f => (f.city ?? "").toLowerCase() === "concord");
    expect(concord.length).toBe(1);
    expect(concord[0].city).toBe("Concord"); // title case wins the display
    expect(facets.some(f => f.city === "Inman" && f.state === "SC")).toBe(true);
  });
});
