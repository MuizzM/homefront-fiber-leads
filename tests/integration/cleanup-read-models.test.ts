import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let rawDb: import("better-sqlite3").Database;
let commissions: typeof import("../../server/commissionService");
let payouts: typeof import("../../server/payoutStore");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-cleanup-reads-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  commissions = await import("../../server/commissionService");
  payouts = await import("../../server/payoutStore");
});
afterAll(() => rawDb?.close());

describe("batched commission plans", () => {
  it("preserves every field and ordering while using two queries for 50 plans", () => {
    const insertPlan = rawDb.prepare(`INSERT INTO commission_plans
      (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)`);
    const insertVersion = rawDb.prepare(`INSERT INTO commission_plan_versions
      (tenant_id, commission_plan_id, version_number, effective_from) VALUES (?, ?, ?, '2026-01-01')`);
    for (let id = 10001; id <= 10050; id++) {
      insertPlan.run(id, 71, `Plan ${id}`, String(id));
      if (id === 10050) continue; // A draft with no version must survive.
      insertVersion.run(71, id, 2);
      insertVersion.run(71, id, 1);
    }
    insertPlan.run(10051, 72, "Foreign plan", "99999");
    insertVersion.run(72, 10051, 1);
    insertVersion.run(72, 10001, 9); // A malformed cross-tenant reference.

    const expected = rawDb.prepare<[number], { id: number }>(
      "SELECT * FROM commission_plans WHERE tenant_id = ? ORDER BY created_at DESC",
    ).all(71).map(plan => ({ ...plan, versions: rawDb.prepare(
      "SELECT * FROM commission_plan_versions WHERE commission_plan_id = ? AND tenant_id = ? ORDER BY version_number ASC",
    ).all(plan.id, 71) }));
    const prepare = vi.spyOn(rawDb, "prepare");
    const actual = commissions.listPlans(71);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(actual).toEqual(expected);
    expect(actual[0].versions).toEqual([]);
    expect(actual.at(-1)?.versions.map(version => version.version_number)).toEqual([1, 2]);
  });

  it("returns no plans for an empty tenant with one query", () => {
    const prepare = vi.spyOn(rawDb, "prepare");
    expect(commissions.listPlans(999)).toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

describe("payout preview facts", () => {
  it("preserves the HTTP preview's order, eligibility, reversed label and payable totals", async () => {
    for (const id of [301, 302, 303]) {
      rawDb.prepare("INSERT INTO team_members (id, tenant_id, name, role, active) VALUES (?, 71, ?, 'rep', 1)")
        .run(id, `Preview rep ${id}`);
    }
    rawDb.prepare(`INSERT INTO rep_payout_accounts (rep_id, tenant_id, onboarding_status)
      VALUES (301, 71, 'enabled'), (302, 71, 'enabled')`).run();
    rawDb.prepare(`INSERT INTO rep_payouts (tenant_id, rep_id, statement_id, amount_cents, status)
      VALUES (71, 302, 802, 50000, 'reversed')`).run();
    const overview = commissions.getWeekOverview(71, null, '2026-09-01', [301, 302, 303]);
    overview.rows = overview.rows.map(row => ({
      ...row, status: 'FINALIZED', statementId: row.repId + 500, finalCommissionCents: row.repId === 301 ? 12345 : 50000,
    }));
    vi.spyOn(commissions, 'getWeekOverview').mockReturnValue(overview);
    const { registerPayoutRoutes } = await import('../../server/payoutRoutes');
    const app = express();
    registerPayoutRoutes(app, {
      requireAuth(req, _res, next) { Object.assign(req, { user: { tenantId: 71, id: 1 } }); next(); },
      requireCapability: () => (_req, _res, next) => next(),
    });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/payouts/week?week=2026-09-01`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.rows.map((row: { repId: number }) => row.repId)).toEqual(overview.rows.map(row => row.repId));
      // Characterize the existing preview: a reversed FINALIZED statement keeps
      // the eligibility helper's result but carries a needs-attention label.
      // The payment POST separately skips reversed transfers; batching must not
      // silently change either financial rule.
      expect(body).toMatchObject({ payableCount: 2, payableCents: 62345 });
      expect(body.rows.find((row: { repId: number }) => row.repId === 301)).toMatchObject({ eligible: true, payoutStatus: null });
      expect(body.rows.find((row: { repId: number }) => row.repId === 302)).toMatchObject({
        eligible: true, payoutStatus: 'reversed', blockReason: 'payout_reversed',
        blockLabel: 'Payout was reversed - needs attention',
      });
      expect(body.rows.find((row: { repId: number }) => row.repId === 303)).toMatchObject({ eligible: false, onboardingStatus: 'none' });
      expect(JSON.stringify(body)).not.toMatch(/stripeAccountId|stripeTransferId|destinationAccountId/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("matches single-row reads, keeps missing statuses and isolates both joins", () => {
    rawDb.prepare(`INSERT INTO rep_payout_accounts (rep_id, tenant_id, onboarding_status)
      VALUES (101, 71, 'enabled'), (102, 71, 'restricted'), (103, 72, 'enabled')`).run();
    rawDb.prepare(`INSERT INTO rep_payouts (tenant_id, rep_id, statement_id, amount_cents, status)
      VALUES (71, 101, 501, 10000, 'paid'), (71, 102, 502, 20000, 'reversed'),
             (72, 103, 503, 30000, 'pending')`).run();
    const rows = [
      { repId: 101, statementId: 501 },
      { repId: 102, statementId: 502 },
      { repId: 103, statementId: 503 },
      { repId: 104, statementId: null },
      { repId: 105, statementId: 599 },
    ];
    const expected = rows.map(row => ({
      repId: row.repId,
      onboardingStatus: payouts.getPayoutAccount(71, row.repId)?.onboardingStatus ?? "none",
      payoutStatus: row.statementId ? payouts.getPayoutByStatement(71, row.statementId)?.status ?? null : null,
    }));
    const prepare = vi.spyOn(rawDb, "prepare");
    const facts = payouts.getPayoutPreviewFacts(71, rows);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(rows.map(row => facts.get(row.repId))).toEqual(expected);
    expect(facts.get(103)).toEqual({ repId: 103, onboardingStatus: "none", payoutStatus: null });
    expect(facts.get(102)?.payoutStatus).toBe("reversed");
    expect(Object.keys(facts.get(101)!)).toEqual(["repId", "onboardingStatus", "payoutStatus"]);
  });

  it("handles 1,200 preview rows in one query without one bind per ID", () => {
    const rows = Array.from({ length: 1200 }, (_, index) => ({ repId: index + 2000, statementId: index + 9000 }));
    const prepare = vi.spyOn(rawDb, "prepare");
    const facts = payouts.getPayoutPreviewFacts(71, rows);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(facts.size).toBe(rows.length);
    expect(facts.get(2000)).toEqual({ repId: 2000, onboardingStatus: "none", payoutStatus: null });
  });

  it("does not query for an empty preview", () => {
    const prepare = vi.spyOn(rawDb, "prepare");
    expect(payouts.getPayoutPreviewFacts(71, []).size).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
  });
});
