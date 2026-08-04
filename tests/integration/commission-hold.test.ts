// ── Install-gated commission hold (tenant_pay_policy) ────────────────────────
// A sold knock books money into TWO planes that must agree on the hold:
//   1. the legacy commissions ledger (/api/commissions, /api/commissions/summary)
//      — installHold is a computed read-time flag, never a lifecycle status;
//   2. the weekly statement engine (statements → week-overview →
//      week-export.csv → NACHA) — a held sale is EXCLUDED from the one
//      aggregation point, so no pay surface can pay it, and it pays in the
//      payable_after week once released.
//
// Pinned: default-on policy, confirm-install (+hold_days, idempotent, audited),
// release by time-travel, the PATCH approve/pay gate, hold_days clamp, policy
// off → legacy behavior byte-for-byte, NACHA/CSV exclusion, and the chargeback
// reserve ("holdback") layered on top completely untouched — the two "held"
// vocabularies never share a field name.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let svc: typeof import("../../server/commissionService");
let runMigrations: () => void;
let nacha: typeof import("../../server/nachaService");

type Person = { userId: number; memberId: number; session: string };

function person(name: string, loginRole: string, tenantId = 1, memberRole = loginRole): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@commission-hold.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, reportsToId: null, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  // These fixtures exercise the hold, not the training gate — exempt them all
  // (the upstream pattern: training_required = 0, see rbac-audit.test.ts).
  rawDb.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run(user.id);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) },
  });
}

let leadSeq = 0;
function makeLead(tenantId: number, assignedRepId: number) {
  leadSeq += 1;
  const lead = storage.createLead({
    address: `${9100 + leadSeq} Hold Ave`, city: "Durham", state: "NC", zip: "27701",
    tenantId, leadStatus: "prospect",
  } as any);
  storage.updateLead(lead.id, { assignedRepId } as any);
  return storage.getLeadById(lead.id)!;
}

let tsSeq = 0;
const nextTs = () => new Date(Date.now() - 3_600_000 + tsSeq++ * 1_000).toISOString();

let knockSeq = 0;
async function knock(leadId: number, session: string, outcome: string) {
  knockSeq += 1;
  const res = await req(`/api/leads/${leadId}/knock`, session, {
    method: "POST",
    body: JSON.stringify({ outcome, knockedAt: nextTs(), clientId: `hold-${knockSeq}` }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const commissionsFor = (leadId: number): any[] =>
  rawDb.prepare("SELECT * FROM commissions WHERE lead_id = ? ORDER BY id DESC").all(leadId);

async function summaryRowFor(session: string, repId: number) {
  const rows = (await (await req("/api/commissions/summary", session)).json()) as any[];
  return rows.find(r => r.repId === repId);
}

async function overviewRowFor(session: string, repId: number) {
  const ov = (await (await req("/api/commission/week-overview", session)).json()) as any;
  return { overview: ov, row: ov.rows.find((r: any) => r.repId === repId) };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

let TENANT_B = 0;
let mgr1: Person, admin1: Person, rep1: Person;
let mgr2: Person, admin2: Person, rep2: Person;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-hold-"));
  process.env.NODE_ENV = "test";
  process.env.PAY_CRYPTO_KEY = "b".repeat(64); // company-profile secrets for NACHA
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  runMigrations = storageModule.runMigrations;
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  svc = await import("../../server/commissionService");
  nacha = await import("../../server/nachaService");

  TENANT_B = storage.createTenant({
    slug: "hold-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@commission-hold.example.test", brandName: "Org B",
  } as any).id;

  mgr1 = person("Hold Mgr One", "manager", 1, "manager");
  admin1 = person("Hold Admin One", "admin", 1, "manager");
  rep1 = person("Hold Rep One", "rep", 1);
  mgr2 = person("Hold Mgr Two", "manager", TENANT_B, "manager");
  admin2 = person("Hold Admin Two", "admin", TENANT_B, "manager");
  rep2 = person("Hold Rep Two", "rep", TENANT_B);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Legacy-plane rates ($100 flat per sale) so sold knocks book commissions…
  for (const [mgr, tid] of [[mgr1, 1], [mgr2, TENANT_B]] as const) {
    const res = await req("/api/commission-rates", mgr.session, {
      method: "POST",
      body: JSON.stringify({ name: `Hold Flat ${tid}`, calcType: "flat", ratePerSale: 100, role: "rep", effectiveFrom: "2020-01-01" }),
    });
    expect(res.status, `rate create failed: ${await res.clone().text()}`).toBe(200);
  }
  // …and statement-plane plans ($100.00 flat) so the pay run has something to price.
  svc.assignStructureToRep(1, admin1.userId, { repId: rep1.memberId, structure: "FLAT", flatRateCents: 10000, effectiveFrom: "2020-01-01" });
  svc.assignStructureToRep(TENANT_B, admin2.userId, { repId: rep2.memberId, structure: "FLAT", flatRateCents: 10000, effectiveFrom: "2020-01-01" });

  // The ODFI profile the NACHA generator needs (pay secrets are set above).
  const profile = await req("/api/company-profile", admin1.session, {
    method: "PUT",
    body: JSON.stringify({
      legalName: "Hold Co LLC", ein: "123456789",
      dfiAccount: "1234567890", dfiRouting: "021000021", companyId: "1123456789",
    }),
  });
  expect(profile.status).toBe(200);
});

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

describe("default policy — install-gated hold", () => {
  it("sold knock books a pending, install-held commission excluded from every payable total", async () => {
    const lead = makeLead(1, rep1.memberId);
    expect((await knock(lead.id, rep1.session, "sold")).status).toBe(201);
    const [commission] = commissionsFor(lead.id);
    expect(commission.status).toBe("pending");
    expect(commission.install_confirmed_at).toBeNull();
    expect(commission.payable_after).toBeNull();

    // Legacy plane: the row reads as held; status is untouched.
    const list = (await (await req("/api/commissions", rep1.session)).json()) as any[];
    const mine = list.find(c => c.id === commission.id);
    expect(mine.installHold).toBe(true);
    expect(mine.status).toBe("pending");

    // Summary overlay: legacy totals unchanged, payable excludes held money —
    // and the field is named installHold, never "hold"/"holdback" (that's the
    // chargeback reserve's word).
    const row = await summaryRowFor(mgr1.session, rep1.memberId);
    expect(row.pending).toBe(100);
    expect(row.installHold).toBe(100);
    expect(row.payable).toBe(0);
    expect(row.payPolicy).toEqual({ requireInstallConfirm: true, holdDays: 90 });
    expect(row).not.toHaveProperty("hold");
    expect(row).not.toHaveProperty("holdback");

    // Pay run (statement plane): the held sale is EXCLUDED from the statement…
    const { overview, row: repRow } = await overviewRowFor(mgr1.session, rep1.memberId);
    expect(repRow.qualifiedSaleCount).toBe(0);
    expect(repRow.finalCommissionCents).toBe(0);
    // …and SHOWN as held, with no release date (install never confirmed).
    expect(repRow.installHold).toEqual({ saleCount: 1, earliestPayableAfter: null });
    expect(overview.totals.installHoldSales).toBeGreaterThanOrEqual(1);

    // The payroll CSV carries the same exclusion + the explanation columns.
    const csv = await (await req("/api/commission/week-export.csv", admin1.session)).text();
    expect(csv.split("\n")[1]).toContain("Install Hold Sales");
    const repLine = csv.split("\n").find(l => l.startsWith('"Hold Rep One"'))!;
    const cols = repLine.split(",");
    expect(cols[5]).toBe("0.00");   // Gross — held sale excluded
    expect(cols[13]).toBe("0.00");  // Total
    expect(cols[14]).toBe("1");     // Install Hold Sales
    expect(cols[15]).toBe('""');    // no release date while unconfirmed

    // NACHA reads the SAME computation — nothing payable while held.
    const file = nacha.buildNachaFile({ tenantId: 1, actorId: admin1.userId, weekReference: new Date().toISOString() });
    expect(file.overviewTotalCents).toBe(0);
    expect(file.entryCount).toBe(0);

    // …and a manager cannot approve or pay a held commission directly either.
    const approve = await req(`/api/commissions/${commission.id}`, mgr1.session, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: 1, expectedStatus: "pending", status: "approved" }),
    });
    expect(approve.status).toBe(409);
    expect((await approve.json() as any).code).toBe("INSTALL_HELD");
  });

  it("confirm-install starts the clock; the window releases by time, and the pay run follows", async () => {
    const lead = makeLead(1, rep1.memberId);
    await knock(lead.id, rep1.session, "sold");
    const [commission] = commissionsFor(lead.id);

    // Reps cannot confirm; cross-tenant is indistinguishable from missing.
    expect((await req(`/api/commissions/${commission.id}/confirm-install`, rep1.session, {
      method: "POST", body: "{}",
    })).status).toBe(403);
    expect((await req(`/api/commissions/${commission.id}/confirm-install`, mgr2.session, {
      method: "POST", body: "{}",
    })).status).toBe(404);

    const before = Date.now();
    const ok = await req(`/api/commissions/${commission.id}/confirm-install`, mgr1.session, {
      method: "POST", body: "{}",
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as any;
    expect(body.installConfirmedAt).toBeTruthy();
    expect(body.payableAfter).toBeTruthy();
    expect((Date.parse(body.payableAfter) - Date.parse(body.installConfirmedAt)) / 86_400_000).toBe(90);
    expect(Date.parse(body.installConfirmedAt)).toBeGreaterThanOrEqual(before - 5000);
    expect(body.installHold).toBe(true); // inside the 90-day window

    // Replay is idempotent and never pushes the window out.
    const again = (await (await req(`/api/commissions/${commission.id}/confirm-install`, mgr1.session, {
      method: "POST", body: "{}",
    })).json()) as any;
    expect(again.alreadyConfirmed).toBe(true);
    expect(again.payableAfter).toBe(body.payableAfter);

    const audit = rawDb.prepare(
      "SELECT * FROM activity_log WHERE action = 'pay.install.confirmed' AND entity_id = ?",
    ).get(commission.id) as any;
    expect(audit).toBeTruthy();

    // Still inside the window: the CSV now shows the RELEASE DATE.
    const csvHeld = await (await req("/api/commission/week-export.csv", admin1.session)).text();
    const heldLine = csvHeld.split("\n").find(l => l.startsWith('"Hold Rep One"'))!;
    expect(heldLine.split(",")[15]).toBe(`"${body.payableAfter.slice(0, 10)}"`);

    // Time-travel past payable_after: the hold lifts everywhere at once.
    rawDb.prepare("UPDATE commissions SET payable_after = ? WHERE id = ?").run(minutesAgo(5), commission.id);
    const list = (await (await req("/api/commissions", rep1.session)).json()) as any[];
    expect(list.find(c => c.id === commission.id).installHold).toBe(false);
    const rowAfter = await summaryRowFor(mgr1.session, rep1.memberId);
    expect(rowAfter.installHold).toBe(100); // the FIRST test's commission is still held
    expect(rowAfter.payable).toBe(100);     // …but THIS one is now payable

    // The pay run picks the sale up (in the payable_after week = this week).
    const { row: repRow } = await overviewRowFor(mgr1.session, rep1.memberId);
    expect(repRow.qualifiedSaleCount).toBe(1);
    expect(repRow.grossCommissionCents).toBe(10000);
    expect(repRow.installHold.saleCount).toBe(1); // test 1's sale, still held

    // Closeout: FINALIZE freezes the week with the released sale IN and the
    // held sale OUT — and the NACHA file reconciles to exactly that.
    const finalize = await req("/api/commission/week/transition", admin1.session, {
      method: "POST", body: JSON.stringify({ action: "FINALIZE", week: new Date().toISOString() }),
    });
    expect(finalize.status).toBe(200);
    const file = nacha.buildNachaFile({ tenantId: 1, actorId: admin1.userId, weekReference: new Date().toISOString() });
    expect(file.overviewTotalCents).toBe(10000);
    // No W-9/bank on file → the rep is a blocking exception, never paid silently.
    expect(file.exceptions.map(e => e.repId)).toContain(rep1.memberId);
  });

  it("cancel-before-install stays held forever until the manager voids (superseded)", async () => {
    const lead = makeLead(1, rep1.memberId);
    await knock(lead.id, rep1.session, "sold");
    const [commission] = commissionsFor(lead.id);

    const list = (await (await req("/api/commissions", rep1.session)).json()) as any[];
    const mine = list.find(c => c.id === commission.id);
    expect(mine.installHold).toBe(true);
    expect(mine.payableAfter).toBeNull();

    rawDb.prepare("UPDATE commissions SET status = 'superseded' WHERE id = ?").run(commission.id);
    const after = (await (await req("/api/commissions", rep1.session)).json()) as any[];
    const voided = after.find(c => c.id === commission.id);
    expect(voided.status).toBe("superseded");
    expect(voided.installHold).toBe(false);
    // A superseded row never counts in the summary totals at all.
    const row = await summaryRowFor(mgr1.session, rep1.memberId);
    expect(row.sales).toBe((rawDb.prepare(
      "SELECT COUNT(*) c FROM commissions WHERE rep_id = ? AND status != 'superseded'",
    ).get(rep1.memberId) as any).c);
  });
});

describe("tenant pay policy endpoints", () => {
  it("GET/PUT are admin-only, clamped, audited; requireInstallConfirm=false restores legacy behavior", async () => {
    expect((await req("/api/admin/pay-policy", rep2.session)).status).toBe(403);
    expect((await req("/api/admin/pay-policy", mgr2.session)).status).toBe(403);

    // Defaults for a fresh tenant: require install confirm, 90 days.
    const policy = (await (await req("/api/admin/pay-policy", admin2.session)).json()) as any;
    expect(policy.requireInstallConfirm).toBe(true);
    expect(policy.holdDays).toBe(90);

    // Out-of-range hold days rejected; a valid update is applied + audited.
    expect((await req("/api/admin/pay-policy", admin2.session, {
      method: "PUT", body: JSON.stringify({ holdDays: 999 }),
    })).status).toBe(400);
    const updated = (await (await req("/api/admin/pay-policy", admin2.session, {
      method: "PUT", body: JSON.stringify({ requireInstallConfirm: false, holdDays: 30 }),
    })).json()) as any;
    expect(updated.requireInstallConfirm).toBe(false);
    expect(updated.holdDays).toBe(30);
    expect(rawDb.prepare(
      "SELECT * FROM activity_log WHERE action = 'pay.policy.updated' ORDER BY id DESC LIMIT 1",
    ).get()).toBeTruthy();

    // Legacy behavior: a sold knock is immediately payable on BOTH planes.
    const lead = makeLead(TENANT_B, rep2.memberId);
    await knock(lead.id, rep2.session, "sold");
    const list = (await (await req("/api/commissions", rep2.session)).json()) as any[];
    expect(list.find(c => c.leadId === lead.id).installHold).toBe(false);
    const row = await summaryRowFor(mgr2.session, rep2.memberId);
    expect(row.payable).toBe(100);
    expect(row.installHold).toBe(0);
    const { row: repRow } = await overviewRowFor(mgr2.session, rep2.memberId);
    expect(repRow.qualifiedSaleCount).toBe(1);
    expect(repRow.grossCommissionCents).toBe(10000);
    expect(repRow.installHold.saleCount).toBe(0);

    // Toggle back on: new sales are held again, hold_days=30 honored.
    await req("/api/admin/pay-policy", admin2.session, {
      method: "PUT", body: JSON.stringify({ requireInstallConfirm: true }),
    });
    const lead2 = makeLead(TENANT_B, rep2.memberId);
    await knock(lead2.id, rep2.session, "sold");
    const [commission2] = commissionsFor(lead2.id);
    const confirm = (await (await req(`/api/commissions/${commission2.id}/confirm-install`, mgr2.session, {
      method: "POST", body: "{}",
    })).json()) as any;
    expect((Date.parse(confirm.payableAfter) - Date.parse(confirm.installConfirmedAt)) / 86_400_000).toBe(30);
  });
});

describe("chargeback reserve — untouched by the install hold", () => {
  it("the holdback split still applies to released money, and only to released money", async () => {
    // An isolated third tenant so nothing above leaks into this assertion.
    const TENANT_C = storage.createTenant({
      slug: "hold-c", companyName: "Org C", ownerName: "C Owner",
      ownerEmail: "owner-c@commission-hold.example.test", brandName: "Org C",
    } as any).id;
    const mgrC = person("Hold Mgr C", "manager", TENANT_C, "manager");
    const repC = person("Hold Rep C", "rep", TENANT_C);
    const res = await req("/api/commission-rates", mgrC.session, {
      method: "POST",
      body: JSON.stringify({ name: "Hold Flat C", calcType: "flat", ratePerSale: 100, role: "rep", effectiveFrom: "2020-01-01" }),
    });
    expect(res.status).toBe(200);
    svc.assignStructureToRep(TENANT_C, mgrC.userId, { repId: repC.memberId, structure: "FLAT", flatRateCents: 10000, effectiveFrom: "2020-01-01" });
    // 10% chargeback reserve — the OTHER "held" vocabulary.
    rawDb.prepare("UPDATE tenants SET commission_reserve_percent = 10 WHERE id = ?").run(TENANT_C);

    const lead = makeLead(TENANT_C, repC.memberId);
    await knock(lead.id, repC.session, "sold");
    const [commission] = commissionsFor(lead.id);

    // Held: nothing earned yet → nothing to reserve against.
    const heldView = (await (await req("/api/commission/statements/me/current", repC.session)).json()) as any;
    expect(heldView.statement.final_commission_cents).toBe(0);
    expect(heldView.holdback.current.reserveCents).toBe(0);
    // The rep's own sale list SHOWS the held sale instead of hiding it.
    expect(heldView.sales.find((s: any) => s.lead_id === lead.id)).toMatchObject({ installHold: true, payableAfter: null });

    // Released: the full 10% reserve split applies, exactly as before the graft.
    rawDb.prepare("UPDATE commissions SET install_confirmed_at = ?, payable_after = ? WHERE id = ?")
      .run(minutesAgo(10), minutesAgo(5), commission.id);
    const view = (await (await req("/api/commission/statements/me/current", repC.session)).json()) as any;
    expect(view.statement.final_commission_cents).toBe(10000);
    expect(view.holdback.current).toMatchObject({ reservePercent: 10, reserveCents: 1000, netPayableCents: 9000 });
    expect(view.sales.find((s: any) => s.lead_id === lead.id)).toMatchObject({ installHold: false });

    // …and the CSV Reserve column reconciles with that same split.
    const csv = await (await req("/api/commission/week-export.csv", mgrC.session)).text();
    const line = csv.split("\n").find(l => l.startsWith('"Hold Rep C"'))!;
    expect(line.split(",")[12]).toBe("10.00"); // Reserve
    expect(line.split(",")[13]).toBe("90.00"); // Total = 100.00 − 10.00
  });
});

describe("hold scope — pay-eligibility ONLY", () => {
  it("a held sale still counts as a REAL sale for campaign counters and incentive triggers", async () => {
    // Tenant B's policy is ON (toggled back above). The sale is held for PAY…
    const lead = makeLead(TENANT_B, rep2.memberId);
    await knock(lead.id, rep2.session, "sold");
    const [commission] = commissionsFor(lead.id);
    expect(commission.status).toBe("pending");
    expect(commission.install_confirmed_at).toBeNull(); // held

    // …but incentive counters are not a pay surface: the sale HAPPENED, so the
    // campaign engine must see it. (Regression pin: the hold filter is an
    // opt-in of the statement path — countQualifiedSales(..., {forPay:true})
    // — never a property of the raw sales count.)
    const campaigns = await import("../../server/spiffCampaignStore");
    const now = Date.now();
    const campaign = campaigns.createCampaign(TENANT_B, null, {
      name: "Hold scope", startsAtMs: now - 86_400_000, endsAtMs: now + 86_400_000,
      trigger: { kind: "per_sale" }, rewardCents: 1000, nowMs: now,
    });
    const counters = campaigns.buildCounters(TENANT_B, campaign, rep2.memberId, now);
    expect(counters.salesInWindow).toBeGreaterThanOrEqual(1);
  });
});

describe("install-hold adoption migration (rollout safety)", () => {
  it("releases commissions that were already pending pre-deploy — once — and never touches post-deploy holds", () => {
    // A pre-deploy row: pending, never confirmed, created long before the
    // first-boot adoption mark (booked under the old payable-immediately
    // contract — the deploy must not silently freeze it).
    rawDb.prepare(
      "INSERT INTO commissions (tenant_id, rep_id, lead_id, amount, status, sale_date, created_at) VALUES (1, ?, NULL, 50, 'pending', '2020-01-01', '2020-01-01T00:00:00.000Z')",
    ).run(rep1.memberId);

    // Second boot: the mark is already frozen at first boot (INSERT OR
    // IGNORE), so only rows predating it are adopted.
    runMigrations();
    const adopted = rawDb.prepare("SELECT * FROM commissions WHERE sale_date = '2020-01-01'").get() as any;
    expect(adopted.install_confirmed_at).toBe("2020-01-01T00:00:00.000Z");
    expect(adopted.payable_after).toBe("2020-01-01T00:00:00.000Z");

    // Post-deploy held rows (this suite's unconfirmed commissions) keep NULL.
    const stillHeld = rawDb.prepare(
      "SELECT COUNT(*) AS n FROM commissions WHERE status = 'pending' AND install_confirmed_at IS NULL",
    ).get() as any;
    expect(stillHeld.n).toBeGreaterThan(0);

    // …and a third boot changes nothing (the adoption is a one-time event).
    runMigrations();
    const again = rawDb.prepare("SELECT * FROM commissions WHERE sale_date = '2020-01-01'").get() as any;
    expect(again.payable_after).toBe("2020-01-01T00:00:00.000Z");
  });
});
