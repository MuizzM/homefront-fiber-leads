// ── Read-only reconciliation ─────────────────────────────────────────────────
//
// The detector's whole value is that it is NOT a repairer: it must find money
// that does not add up, name it precisely enough to act on, and change nothing.
// Both halves are tested — what it catches, and that running it leaves the
// database byte-identical.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let svc: typeof import("../../server/commissionService");
let recon: typeof import("../../server/commissionReconciliation");
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let weekBoundsFor: (typeof import("../../shared/workweek"))["weekBoundsFor"];
let queueOps: typeof import("../../server/eventQueueOps");

const T = 1;
const NOW = "2026-08-07T12:00:00.000Z";
const run = (tenantId: number | null = T) =>
  recon.reconcile({ tenantId, nowIso: NOW, runId: "test-run" });
const kinds = (r: ReturnType<typeof run>) => r.findings.map(f => f.kind);

let seq = 0;
function person(name: string, role: string, reportsToId: number | null, tenantId = T) {
  seq += 1;
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, ".")}.${seq}@recon.example.test`;
  const m = storage.createTeamMember({ name, email, role, active: true, reportsToId, tenantId } as any);
  return m.id as number;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-recon-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));
  svc = await import("../../server/commissionService");
  await import("../../server/incentiveSubscriber");  // owns spiffs + source_event_id
  recon = await import("../../server/commissionReconciliation");
  ({ weekBoundsFor } = await import("../../shared/workweek"));
  queueOps = await import("../../server/eventQueueOps");
});

describe("a healthy org reports nothing", () => {
  it("finds no problems in a normally-processed week", () => {
    const rep = person("Recon Clean Rep", "rep", null);
    svc.assignStructureToRep(T, 1, { repId: rep, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    const ts = "2026-08-04T15:00:00.000Z";
    svc.upsertSale(T, 1, { repId: rep, externalId: "recon-ok", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    const report = run();
    expect(report.findings.filter(f => f.repId === rep)).toEqual([]);
  });
});

describe("what it catches", () => {
  it("a statement whose total does not satisfy final = gross + adjustments + overrides", () => {
    const rep = person("Recon Drift Rep", "rep", null);
    svc.assignStructureToRep(T, 1, { repId: rep, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    const ts = "2026-08-04T15:00:00.000Z";
    svc.upsertSale(T, 1, { repId: rep, externalId: "recon-drift", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    // Corrupt the total the way a partial write would.
    rawDb.prepare(
      `UPDATE commission_statements SET final_commission_cents = final_commission_cents + 12345
        WHERE tenant_id = ? AND rep_id = ?`,
    ).run(T, rep);

    const f = run().findings.find(x => x.kind === "STATEMENT_TOTAL_MISMATCH" && x.repId === rep);
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("critical");
    expect(f!.detail).toMatch(/final =/);
    expect(f!.observed).toMatchObject({ gross: 20000 });
    // Keyed so an operator can act without re-deriving anything.
    expect(f!.statementWeekUtc).toBe(weekBoundsFor(ts, svc.loadOrgConfig(T)).weekStartUtc);
    expect(f!.correlationId).toContain("test-run");
  });

  it("a qualified sale with no override rows while overrides are enabled and priced", () => {
    const mgr = person("Recon Mgr", "manager", null);
    const rep = person("Recon Downline Rep", "rep", mgr);
    svc.assignStructureToRep(T, 1, { repId: rep, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    svc.updateOrgConfig(T, null, { overridesEnabled: true, overrideManagerCents: 7500 } as any);
    const ts = "2026-08-05T15:00:00.000Z";
    svc.upsertSale(T, 1, { repId: rep, externalId: "recon-ovr", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    const saleId = svc.getSaleByExternalId(T, "recon-ovr").id;
    // Simulate the pre-fix state: the sale exists, the override rows do not.
    rawDb.exec("DROP TRIGGER IF EXISTS trg_cov_no_delete");
    rawDb.prepare(`DELETE FROM commission_overrides WHERE source_ref = ?`).run(`sale:${saleId}`);

    const f = run().findings.find(x => x.kind === "QUALIFIED_SALE_MISSING_OVERRIDES" && x.saleId === saleId);
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("critical");
    expect(f!.observed).toMatchObject({ externalId: "recon-ovr" });
  });

  it("a negative reserve balance - more released than was ever held", () => {
    const rep = person("Recon Reserve Rep", "rep", null);
    rawDb.prepare(
      `INSERT INTO reserve_entries (tenant_id, rep_id, kind, amount_cents, reason, created_at)
       VALUES (?,?,'drawdown',?,?,?)`,
    ).run(T, rep, -5000, "test drawdown with no prior hold", NOW);
    const f = run().findings.find(x => x.kind === "RESERVE_BALANCE_MISMATCH" && x.repId === rep);
    expect(f).toBeTruthy();
    expect(f!.observed).toMatchObject({ balanceCents: -5000 });
  });

  it("a week that ended long ago and is still OPEN", () => {
    const rep = person("Recon Stale Rep", "rep", null);
    svc.assignStructureToRep(T, 1, { repId: rep, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    const old = "2026-05-05T15:00:00.000Z";   // ~3 months before NOW
    svc.upsertSale(T, 1, { repId: rep, externalId: "recon-stale", status: "QUALIFIED", soldAt: old, qualifiedAt: old });
    const f = run().findings.find(x => x.kind === "STALE_CLOSEOUT" && x.repId === rep);
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("warning");
  });

  it("a blocked queue event, because it holds every later event", async () => {
    queueOps.ensureEventQueueSchema();
    const { emit } = await import("../../server/domainEventStore");
    const event = emit({ tenantId: T, type: "SALE_APPROVED", subjectType: "sale", subjectId: 99001, occurredAt: NOW }, NOW);
    rawDb.prepare(
      `INSERT INTO event_processing_state (subscriber, event_id, tenant_id, status, attempts, error_fingerprint, created_at, updated_at)
       VALUES ('incentives', ?, ?, 'blocked', 5, 'TypeError:boom', ?, ?)`,
    ).run(event.id, T, NOW, NOW);
    const f = run().findings.find(x => x.kind === "BLOCKED_QUEUE_EVENT");
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("critical");
    expect(f!.detail).toMatch(/later events cannot be processed/);
  });

  it("a QUALIFIED sale whose own basis timestamp is not set, so it counts in no week", () => {
    const rep = person("Recon Basis Rep", "rep", null);
    svc.assignStructureToRep(T, 1, { repId: rep, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    const ts = "2026-08-04T15:00:00.000Z";
    svc.upsertSale(T, 1, { repId: rep, externalId: "recon-basis", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    // Stamp a basis whose column is empty — the shape that silently pays nobody.
    rawDb.prepare(
      `UPDATE commission_sales SET qualification_basis = 'ACTIVATED_AT', activated_at = NULL WHERE external_id = ?`,
    ).run("recon-basis");
    const f = run().findings.find(x => x.kind === "SALE_WEEK_DISAGREES_WITH_BASIS");
    expect(f).toBeTruthy();
    expect(f!.observed).toMatchObject({ basis: "ACTIVATED_AT" });
  });
});

describe("it is READ-ONLY", () => {
  it("changes nothing - every money table is byte-identical after a run", () => {
    const snapshot = () => ({
      sales: rawDb.prepare(`SELECT * FROM commission_sales ORDER BY id`).all(),
      statements: rawDb.prepare(`SELECT * FROM commission_statements ORDER BY id`).all(),
      overrides: rawDb.prepare(`SELECT * FROM commission_overrides ORDER BY id`).all(),
      reserve: rawDb.prepare(`SELECT * FROM reserve_entries ORDER BY id`).all(),
      spiffs: rawDb.prepare(`SELECT * FROM spiffs ORDER BY id`).all(),
    });
    const before = JSON.stringify(snapshot());
    const report = run();
    expect(report.findings.length).toBeGreaterThan(0);   // it really did find things
    expect(JSON.stringify(snapshot())).toBe(before);      // and repaired none of them
  });

  it("summarizes by kind and stamps the run", () => {
    const report = run();
    expect(report.runId).toBe("test-run");
    expect(report.generatedAt).toBe(NOW);
    expect(Object.values(report.countsByKind).reduce((a, b) => a + b, 0)).toBe(report.findings.length);
  });
});

describe("tenant isolation", () => {
  it("a tenant-scoped report contains no other organization's findings", () => {
    const other = 8801;
    rawDb.prepare(
      `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
       VALUES (?, 'recon-other', 'Recon Other', 'O', 'o@recon-other.example.test', 'Other')`,
    ).run(other);
    const otherRep = person("Recon Other Rep", "rep", null, other);
    rawDb.prepare(
      `INSERT INTO reserve_entries (tenant_id, rep_id, kind, amount_cents, reason, created_at)
       VALUES (?,?,'drawdown',?,?,?)`,
    ).run(other, otherRep, -9999, "other org problem", NOW);

    const mine = run(T);
    expect(mine.findings.every(f => f.tenantId === T || f.tenantId == null)).toBe(true);
    expect(mine.findings.some(f => f.repId === otherRep)).toBe(false);

    // …and the other org's own report does see it.
    expect(run(other).findings.some(f => f.repId === otherRep && f.kind === "RESERVE_BALANCE_MISMATCH")).toBe(true);
  });
});
