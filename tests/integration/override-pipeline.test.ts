// DOWNLINE OVERRIDE PIPELINE — the money contract, end to end at the service
// layer (real migrated DB, real commissionService hooks, real triggers).
//
// What is pinned:
//   1. a QUALIFIED downline sale earns the first active team_lead and manager
//      their configured flat cents, folded into each upline's statement FINAL
//   2. missing team-lead slot (rep reports straight to a manager) pays nobody
//      that $25 — the house keeps it; a seller never earns on their own sale
//   3. the chain is FROZEN at earn time — re-homing the tree later never
//      re-attributes an earned row; the next sale follows the new tree
//   4. reversal in an open week nets the fold to zero; after the upline week is
//      FINALIZED it becomes an EXCEPTION + adjustment flow, and
//      applyApprovedAdjustments preserves the frozen override component
//   5. replays converge (idempotent reconciler + unique pair_seq index)
//   6. an earn against an already-locked upline week books EXCEPTION, never
//      injected; the feature switched OFF stops earns but never stops claws
//   7. the ledger is append-only: money columns frozen, deletes abort
//   8. the install hold books HELD and releases into the payable_after week
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: any;
let svc: typeof import("../../server/commissionService");
let ov: typeof import("../../server/overrideStore");
let weekBoundsFor: (typeof import("../../shared/workweek"))["weekBoundsFor"];

const TENANT = 1;

type Member = { memberId: number; userId: number };
function member(name: string, role: string, reportsToId: number | null): Member {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@override-pipeline.example.test`;
  const m = storage.createTeamMember({ name, email, role, active: true, reportsToId, tenantId: TENANT } as any);
  const u = storage.createUser({ name, email, role, active: true, tenantId: TENANT, teamMemberId: m.id } as any);
  return { memberId: m.id, userId: u.id };
}

let mgr: Member, mgr2: Member, tl: Member, rep: Member, repDirect: Member;

// Sales are minted through the REAL knock bridge with distinct lead ids; the
// hand-rolled clock keeps every sale inside the current org week.
let leadSeq = 9000;
const soldNow = () => new Date(Date.now() - 60_000).toISOString();
function sell(repId: number): number {
  leadSeq += 1;
  svc.recordFieldSaleFromKnock({
    tenantId: TENANT, repId, leadId: leadSeq, knockId: leadSeq,
    soldAt: soldNow(), serverReceivedAt: new Date().toISOString(), actorId: null,
  });
  return leadSeq;
}
const saleRow = (leadId: number): any =>
  rawDb.prepare(`SELECT * FROM commission_sales WHERE tenant_id = ? AND external_id = ?`).get(TENANT, `lead:${leadId}`);
const ledgerFor = (leadId: number): any[] =>
  rawDb.prepare(`SELECT * FROM commission_overrides WHERE tenant_id = ? AND source_ref = ? ORDER BY beneficiary_rep_id, pair_seq`)
    .all(TENANT, `sale:${saleRow(leadId).id}`);
const thisWeekStart = (): string =>
  weekBoundsFor(new Date(), svc.loadOrgConfig(TENANT)).weekStartUtc;
const blockFor = (repId: number) => ov.overrideBlockForWeek(TENANT, repId, thisWeekStart());

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-override-pipeline-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); // creates + adopts the default tenant (id 1)
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));
  svc = await import("../../server/commissionService");
  ov = await import("../../server/overrideStore");
  ({ weekBoundsFor } = await import("../../shared/workweek"));

  // Install hold OFF for the core suite (it has its own test at the bottom).
  rawDb.prepare(
    "INSERT OR REPLACE INTO tenant_pay_policy (tenant_id, require_install_confirm, hold_days, updated_at) VALUES (?, 0, 90, datetime('now'))",
  ).run(TENANT);

  // Org chart: mgr ← tl ← rep, plus repDirect straight under mgr (no TL slot),
  // and a second manager for the re-home test.
  mgr = member("Ovr Mgr", "manager", null);
  mgr2 = member("Ovr Mgr Two", "manager", null);
  tl = member("Ovr Lead", "team_lead", mgr.memberId);
  rep = member("Ovr Rep", "rep", tl.memberId);
  repDirect = member("Ovr Rep Direct", "rep", mgr.memberId);

  // The 300 → 200/25/75 world: TL $25, manager $75 per qualified downline sale.
  svc.updateOrgConfig(TENANT, null, {
    overridesEnabled: true, overrideTeamLeadCents: 2500, overrideManagerCents: 7500,
  } as any);
});

describe("flat earn + statement fold", () => {
  it("a rep's qualified sale earns TL $25 (level 1) and manager $75 (level 2), folded into final", () => {
    const lead = sell(rep.memberId);
    const rows = ledgerFor(lead);
    expect(rows).toHaveLength(2);
    const tlRow = rows.find(r => r.beneficiary_rep_id === tl.memberId)!;
    const mgrRow = rows.find(r => r.beneficiary_rep_id === mgr.memberId)!;
    expect(tlRow).toMatchObject({ entry_type: "EARN", amount_cents: 2500, level: 1, beneficiary_role: "team_lead", status: "PAYABLE" });
    expect(mgrRow).toMatchObject({ entry_type: "EARN", amount_cents: 7500, level: 2, beneficiary_role: "manager", status: "PAYABLE" });
    // Frozen snapshots ride on the row.
    expect(JSON.parse(tlRow.rate_snapshot)).toMatchObject({ teamLeadCents: 2500, managerCents: 7500 });
    expect(JSON.parse(tlRow.chain_snapshot).length).toBeGreaterThan(0);

    // Override-only uplines still get a statement; final == override block.
    const tlStmt = svc.calculateOrRecalculateStatement({ tenantId: TENANT, repId: tl.memberId, weekReference: new Date(), actorId: null });
    expect(tlStmt.override).toEqual({ payCents: 2500, itemCount: 1 });
    expect(tlStmt.statement.final_commission_cents).toBe(2500);
    expect(tlStmt.statement.override_pay_cents).toBe(2500);
    const mgrStmt = svc.calculateOrRecalculateStatement({ tenantId: TENANT, repId: mgr.memberId, weekReference: new Date(), actorId: null });
    expect(mgrStmt.statement.final_commission_cents).toBe(7500);
  });

  it("missing TL slot: a rep reporting straight to a manager pays only the manager — house keeps the $25", () => {
    const lead = sell(repDirect.memberId);
    const rows = ledgerFor(lead);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ beneficiary_rep_id: mgr.memberId, amount_cents: 7500 });
  });

  it("self-sale guard: a team lead's own sale earns only their manager, never themselves", () => {
    const lead = sell(tl.memberId);
    const rows = ledgerFor(lead);
    expect(rows).toHaveLength(1);
    expect(rows[0].beneficiary_rep_id).toBe(mgr.memberId);
  });

  it("replay converges: re-recording the same sold door mints no second earn", () => {
    const lead = sell(rep.memberId);
    const before = ledgerFor(lead).length;
    // Same door sold again (knock replay / teammate re-mark) — money no-op.
    svc.recordFieldSaleFromKnock({
      tenantId: TENANT, repId: rep.memberId, leadId: lead, knockId: lead,
      soldAt: soldNow(), serverReceivedAt: new Date().toISOString(), actorId: null,
    });
    ov.syncOverridesForSale(TENANT, saleRow(lead).id, null, thisWeekStart());
    expect(ledgerFor(lead)).toHaveLength(before);
  });

  it("week overview includes the manager with override pay on the row", () => {
    const overview = svc.getWeekOverview(TENANT, null, new Date(), null);
    const mgrRow = overview.rows.find(r => r.repId === mgr.memberId)!;
    expect(mgrRow).toBeTruthy();
    expect(mgrRow.overridePayCents).toBeGreaterThan(0);
    expect(mgrRow.finalCommissionCents).toBe(mgrRow.overridePayCents);
  });
});

describe("tree mutation after earn", () => {
  it("earned rows keep the old manager; the next sale follows the new tree", () => {
    const earned = sell(rep.memberId);
    expect(ledgerFor(earned).map(r => r.beneficiary_rep_id)).toContain(mgr.memberId);

    // Re-home the team lead under manager 2 (the operational org chart moved).
    rawDb.prepare(`UPDATE team_members SET reports_to_id = ? WHERE id = ?`).run(mgr2.memberId, tl.memberId);

    const next = sell(rep.memberId);
    const nextBeneficiaries = ledgerFor(next).map(r => r.beneficiary_rep_id);
    expect(nextBeneficiaries).toContain(mgr2.memberId);
    expect(nextBeneficiaries).not.toContain(mgr.memberId);
    // The earlier row did NOT re-attribute.
    expect(ledgerFor(earned).map(r => r.beneficiary_rep_id)).toContain(mgr.memberId);

    rawDb.prepare(`UPDATE team_members SET reports_to_id = ? WHERE id = ?`).run(mgr.memberId, tl.memberId);
  });
});

describe("reversal", () => {
  it("open week: reversal claws the earn back and the fold nets to zero", () => {
    const lead = sell(rep.memberId);
    const tlBefore = blockFor(tl.memberId).payCents;
    svc.reverseFieldSale(TENANT, lead, null);
    const rows = ledgerFor(lead);
    expect(rows.filter(r => r.entry_type === "CLAWBACK")).toHaveLength(2);
    expect(rows.reduce((s, r) => s + (r.status === "PAYABLE" ? r.amount_cents : 0), 0)).toBe(0);
    expect(blockFor(tl.memberId).payCents).toBe(tlBefore - 2500);
  });

  it("re-qualify after reversal earns fresh (seq 2) with a fresh snapshot — pays once net", () => {
    const lead = sell(rep.memberId);
    svc.reverseFieldSale(TENANT, lead, null);
    svc.transitionSale(TENANT, null, `lead:${lead}`, "QUALIFY");
    const tlRows = ledgerFor(lead).filter(r => r.beneficiary_rep_id === tl.memberId);
    expect(tlRows.map(r => r.pair_seq)).toEqual([0, 1, 2]);
    expect(tlRows.reduce((s, r) => s + (r.status === "PAYABLE" ? r.amount_cents : 0), 0)).toBe(2500);
  });

  it("after upline FINALIZE: claw books EXCEPTION, statement untouched, adjustment flow preserves the frozen override", () => {
    const lead = sell(rep.memberId);
    const tlStmt = svc.calculateOrRecalculateStatement({ tenantId: TENANT, repId: tl.memberId, weekReference: new Date(), actorId: null });
    const finalizedTl = svc.transitionStatement(TENANT, null, tlStmt.statement.id, "FINALIZE");
    const frozenFinal = finalizedTl.final_commission_cents;
    expect(JSON.parse(finalizedTl.contributing_overrides).length).toBeGreaterThan(0);

    svc.reverseFieldSale(TENANT, lead, null);
    const tlClaw = ledgerFor(lead).find(r => r.beneficiary_rep_id === tl.memberId && r.entry_type === "CLAWBACK")!;
    expect(tlClaw.status).toBe("EXCEPTION");
    expect(tlClaw.reason).toBe("OVERRIDE_REVERSED_AFTER_FINALIZE");
    // The locked statement never moved.
    const after = rawDb.prepare(`SELECT * FROM commission_statements WHERE id = ?`).get(tlStmt.statement.id);
    expect(after.final_commission_cents).toBe(frozenFinal);
    expect(after.status).toBe("FINALIZED");

    // The console names it.
    const overview = svc.getWeekOverview(TENANT, null, new Date(), null);
    expect(overview.exceptions.some(e => e.type === "OVERRIDE_REVERSED_AFTER_FINALIZE" && e.repId === tl.memberId)).toBe(true);

    // Manager books the clawback adjustment; the frozen override survives it.
    const adj = svc.createAdjustment(TENANT, null, {
      statementId: tlStmt.statement.id, amountCents: -2500, type: "CLAWBACK", reason: "downline sale reversed after finalize",
    });
    svc.decideAdjustment(TENANT, null, adj.id, "APPROVE");
    const adjusted = rawDb.prepare(`SELECT * FROM commission_statements WHERE id = ?`).get(tlStmt.statement.id);
    expect(adjusted.final_commission_cents).toBe(frozenFinal - 2500);
    expect(adjusted.override_pay_cents).toBe(after.override_pay_cents); // component intact

    ov.resolveException(TENANT, tlClaw.id, adj.id, null);
    expect(rawDb.prepare(`SELECT status, resolved_adjustment_id FROM commission_overrides WHERE id = ?`).get(tlClaw.id))
      .toMatchObject({ status: "RESOLVED", resolved_adjustment_id: adj.id });
    // Double-resolve refuses.
    expect(() => ov.resolveException(TENANT, tlClaw.id, adj.id, null)).toThrow();
  });
});

describe("locked upline week + kill switch", () => {
  it("an earn against an already-FINALIZED upline week books EXCEPTION, never injected", () => {
    // TL's statement for this week is FINALIZED from the prior test. A new
    // downline sale must not inject money into it.
    const lead = sell(rep.memberId);
    const tlRow = ledgerFor(lead).find(r => r.beneficiary_rep_id === tl.memberId)!;
    expect(tlRow).toMatchObject({ entry_type: "EARN", status: "EXCEPTION", reason: "LOCKED_WEEK_EARN" });
    // The manager's week is open — their earn is normal money.
    expect(ledgerFor(lead).find(r => r.beneficiary_rep_id === mgr.memberId)!.status).toBe("PAYABLE");
    // Reopen for the remaining tests (re-prices from the ledger, restoring settled rows).
    const stmt = rawDb.prepare(`SELECT id FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`)
      .get(TENANT, tl.memberId, thisWeekStart());
    svc.transitionStatement(TENANT, null, stmt.id, "REOPEN");
  });

  it("switching the feature off stops new earns but never stops clawbacks", () => {
    const earnedWhileOn = sell(rep.memberId);
    expect(ledgerFor(earnedWhileOn).length).toBeGreaterThan(0);

    svc.updateOrgConfig(TENANT, null, { overridesEnabled: false } as any);
    const dark = sell(rep.memberId);
    expect(ledgerFor(dark)).toHaveLength(0);

    // Money earned while ON still reverses correctly while OFF.
    svc.reverseFieldSale(TENANT, earnedWhileOn, null);
    expect(ledgerFor(earnedWhileOn).filter(r => r.entry_type === "CLAWBACK").length).toBeGreaterThan(0);
    svc.updateOrgConfig(TENANT, null, { overridesEnabled: true } as any);
  });

  it("PERCENT_OF_COMMISSION is refused at config time (reserved, not executable)", () => {
    expect(() => svc.updateOrgConfig(TENANT, null, { overrideBasis: "PERCENT_OF_COMMISSION" } as any)).toThrow(/not yet supported/);
  });
});

describe("per-hire rates (chosen at invite time)", () => {
  it("a seller's own override rates out-rank the org config; the frozen snapshot proves which applied", () => {
    // The hirer chose: on THIS rep's sales the TL keeps $10 and the manager $99.
    rawDb.prepare(`UPDATE team_members SET override_team_lead_cents = 1000, override_manager_cents = 9900 WHERE id = ?`)
      .run(rep.memberId);
    const lead = sell(rep.memberId);
    const rows = ledgerFor(lead);
    expect(rows.find(r => r.beneficiary_rep_id === tl.memberId)!.amount_cents).toBe(1000);
    expect(rows.find(r => r.beneficiary_rep_id === mgr.memberId)!.amount_cents).toBe(9900);
    expect(JSON.parse(rows[0].rate_snapshot)).toMatchObject({ teamLeadCents: 1000, managerCents: 9900 });

    // Clearing back to NULL inherits the org config again — but only for NEW
    // earns; the rows above keep their frozen amounts.
    rawDb.prepare(`UPDATE team_members SET override_team_lead_cents = NULL, override_manager_cents = NULL WHERE id = ?`)
      .run(rep.memberId);
    const next = sell(rep.memberId);
    expect(ledgerFor(next).find(r => r.beneficiary_rep_id === tl.memberId)!.amount_cents).toBe(2500);
    expect(ledgerFor(lead).find(r => r.beneficiary_rep_id === tl.memberId)!.amount_cents).toBe(1000);
  });

  it("one column set, the other inherits — and a rep with NULL rates is byte-identical to before the feature", () => {
    rawDb.prepare(`UPDATE team_members SET override_manager_cents = 5000 WHERE id = ?`).run(repDirect.memberId);
    const lead = sell(repDirect.memberId);
    const rows = ledgerFor(lead);
    expect(rows).toHaveLength(1); // still no TL slot for a direct report
    expect(rows[0].amount_cents).toBe(5000);
    rawDb.prepare(`UPDATE team_members SET override_manager_cents = NULL WHERE id = ?`).run(repDirect.memberId);
  });
});

describe("append-only enforcement", () => {
  it("money/attribution columns are frozen and deletes abort; lifecycle updates pass", () => {
    const anyRow = rawDb.prepare(`SELECT id FROM commission_overrides LIMIT 1`).get();
    expect(anyRow).toBeTruthy();
    expect(() => rawDb.prepare(`UPDATE commission_overrides SET amount_cents = 999999 WHERE id = ?`).run(anyRow.id)).toThrow(/frozen/);
    expect(() => rawDb.prepare(`UPDATE commission_overrides SET beneficiary_rep_id = 42 WHERE id = ?`).run(anyRow.id)).toThrow(/frozen/);
    expect(() => rawDb.prepare(`DELETE FROM commission_overrides WHERE id = ?`).run(anyRow.id)).toThrow(/append-only/);
    // Lifecycle columns stay mutable.
    rawDb.prepare(`UPDATE commission_overrides SET updated_at = ? WHERE id = ?`).run(new Date().toISOString(), anyRow.id);
  });
});

describe("install hold", () => {
  it("an earn on a held sale books HELD, then releases into the payable_after week", () => {
    rawDb.prepare(
      "INSERT OR REPLACE INTO tenant_pay_policy (tenant_id, require_install_confirm, hold_days, updated_at) VALUES (?, 1, 90, datetime('now'))",
    ).run(TENANT);
    const lead = sell(rep.memberId);
    // The legacy commissions row is the hold's source of truth: pending with a
    // future payable_after = inside the hold window.
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    rawDb.prepare(
      `INSERT INTO commissions (rep_id, tenant_id, lead_id, amount, status, sale_date, payable_after, install_confirmed_at)
       VALUES (?, ?, ?, 0, 'pending', ?, ?, ?)`,
    ).run(rep.memberId, TENANT, lead, soldNow(), future, soldNow());
    ov.syncOverridesForSale(TENANT, saleRow(lead).id, null, thisWeekStart());
    // Fresh pairs were already opened PAYABLE before the hold row existed —
    // reverse + re-qualify to re-earn under the hold. (In production the
    // legacy row is written in the same knock transaction, before the sync.)
    svc.reverseFieldSale(TENANT, lead, null);
    svc.transitionSale(TENANT, null, `lead:${lead}`, "QUALIFY");
    const heldRows = ledgerFor(lead).filter(r => r.entry_type === "EARN" && r.pair_seq === 2);
    expect(heldRows.length).toBeGreaterThan(0);
    for (const r of heldRows) expect(r).toMatchObject({ status: "HELD", hold_payable_after: future });
    // Held money folds nowhere.
    const heldTl = heldRows.find(r => r.beneficiary_rep_id === tl.memberId);
    if (heldTl) {
      const block = blockFor(tl.memberId);
      const payableTlCents = rawDb.prepare(
        `SELECT COALESCE(SUM(amount_cents),0) AS s FROM commission_overrides
         WHERE tenant_id = ? AND beneficiary_rep_id = ? AND earned_week_start_utc = ? AND status = 'PAYABLE'`,
      ).get(TENANT, tl.memberId, thisWeekStart()).s;
      expect(block.payCents).toBe(payableTlCents);
    }

    // Release: the hold passes; the next block computation promotes the rows
    // into the week containing payable_after.
    const past = new Date(Date.now() - 60_000).toISOString();
    rawDb.prepare(`UPDATE commissions SET payable_after = ? WHERE lead_id = ?`).run(past, lead);
    rawDb.prepare(`UPDATE commission_overrides SET hold_payable_after = ? WHERE source_ref = ? AND status = 'HELD'`)
      .run(past, `sale:${saleRow(lead).id}`);
    ov.promoteReleasedHolds(TENANT, (ts) => weekBoundsFor(ts, svc.loadOrgConfig(TENANT)).weekStartUtc);
    const released = ledgerFor(lead).filter(r => r.entry_type === "EARN" && r.pair_seq === 2);
    for (const r of released) {
      expect(r.status).toBe("PAYABLE");
      expect(r.earned_week_start_utc).toBe(weekBoundsFor(past, svc.loadOrgConfig(TENANT)).weekStartUtc);
    }
    rawDb.prepare(
      "INSERT OR REPLACE INTO tenant_pay_policy (tenant_id, require_install_confirm, hold_days, updated_at) VALUES (?, 0, 90, datetime('now'))",
    ).run(TENANT);
  });
});

describe("a leader mid-onboarding still earns on their team's sales", () => {
  // THE BUG THIS PINS: approval creates the hire at active = 0 (agreements
  // unsigned) and can hand them a downline in the same breath. That team sells
  // immediately. The override math used to skip an inactive upline, so the
  // leader's cut quietly went to the house until they got round to signing —
  // while the manager ABOVE them was paid for the very same sale.
  it("pays the not-yet-activated team lead, not the house", () => {
    const pending = member("Ovr Pending Lead", "team_lead", mgr.memberId);
    rawDb.prepare(`UPDATE team_members SET active = 0 WHERE id = ?`).run(pending.memberId);
    const seller = member("Ovr Pending Rep", "rep", pending.memberId);

    const lead = sell(seller.memberId);
    const rows = ledgerFor(lead);
    expect(rows.find(r => r.beneficiary_rep_id === pending.memberId)).toMatchObject({
      amount_cents: 2500, beneficiary_role: "team_lead", status: "PAYABLE",
    });
    // The manager above is unaffected — both slots pay, as the tree says.
    expect(rows.find(r => r.beneficiary_rep_id === mgr.memberId)?.amount_cents).toBe(7500);

    // And it reaches the statement, so it is real money rather than a row.
    const stmt = svc.calculateOrRecalculateStatement({
      tenantId: TENANT, repId: pending.memberId, weekReference: new Date(), actorId: null,
    });
    expect(stmt.statement.override_pay_cents).toBe(2500);
  });
});
