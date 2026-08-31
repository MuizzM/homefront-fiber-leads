// Full rep workflow regression: note -> sold -> pay -> metrics -> correction.
//
// This deliberately uses an isolated database. Production refuses to delete a
// lead once it has field or commission history, so exercising fake sales in the
// live tenant would leave permanent test rows in operational and pay records.
// Every business mutation below goes through the same authenticated HTTP route
// the field map uses; only fixture creation and the asynchronous metrics worker
// are driven directly.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl = "";
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let recomputeRepDay: (typeof import("../../server/repMetricsStore"))["recomputeRepDay"];
let localDateString: (typeof import("../../server/repMetricsStore"))["localDateString"];
let tenantTimezone: (typeof import("../../server/repMetricsStore"))["tenantTimezone"];

type Person = { userId: number; memberId: number; session: string };
let manager: Person;
let rep: Person;
let leads: Array<{ id: number; address: string }> = [];

function person(name: string, role: string): Person {
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@field-flow.example.test`;
  const member = storage.createTeamMember({
    name, email, role, active: true, reportsToId: null, tenantId: 1,
  } as any);
  const user = storage.createUser({
    name, email, role, active: true, tenantId: 1, teamMemberId: member.id,
  } as any);
  // These are established field users; onboarding-gate behavior has its own
  // suite and must not obscure this workflow.
  rawDb.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run(user.id);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function request(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-session-id": session,
      "x-csrf-token": session,
      ...init.headers,
    },
  });
}

async function json(path: string, session: string, init: RequestInit = {}) {
  const response = await request(path, session, init);
  const body = await response.json();
  expect(response.status, `${init.method ?? "GET"} ${path}: ${JSON.stringify(body)}`).toBeLessThan(300);
  return body as any;
}

function metricDate(): string {
  return localDateString(Date.now(), tenantTimezone(1));
}

function rollupToday() {
  return recomputeRepDay(1, rep.memberId, metricDate());
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-field-sale-flow-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  ({ recomputeRepDay, localDateString, tenantTimezone } = await import("../../server/repMetricsStore"));

  manager = person("Regression Manager", "manager");
  rep = person("Regression Rep", "rep");

  // Production's current terms: first seven qualified sales pay $150 each,
  // with a 10% reserve. Disable the separate install-confirmation hold so this
  // test isolates the commission and reserve arithmetic the rep sees.
  rawDb.prepare(
    `INSERT OR REPLACE INTO tenant_pay_policy
       (tenant_id, require_install_confirm, hold_days, updated_at)
     VALUES (1, 0, 90, datetime('now'))`,
  ).run();

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  await json("/api/commission/assign-structure", manager.session, {
    method: "POST",
    body: JSON.stringify({
      repId: rep.memberId,
      structure: "TIERED",
      effectiveFrom: "2026-01-01",
      reservePercent: 10,
      reserveCapCents: 250_000,
    }),
  });
  // Metrics' documented no-provider-feed fallback reads the legacy commission
  // rows created by the same knock route. Keep that compatibility rate aligned
  // with the authoritative weekly structure for this test.
  await json("/api/commission-rates", manager.session, {
    method: "POST",
    body: JSON.stringify({
      name: "Regression $150 per sale",
      calcType: "flat",
      ratePerSale: 150,
      repId: rep.memberId,
      effectiveFrom: "2026-01-01",
    }),
  });

  leads = Array.from({ length: 3 }, (_, index) => storage.createLead({
    address: `${9001 + index} QA Regression Way`,
    city: "High Point",
    state: "NC",
    zip: "27263",
    tenantId: 1,
    assignedRepId: rep.memberId,
    assignedAt: new Date().toISOString(),
    leadStatus: "prospect",
    lat: 35.95 + index * 0.0001,
    lng: -80.0 - index * 0.0001,
  } as any));
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("field sale, comments, commission and metrics stay in agreement", () => {
  it("saves one visible note on each lead and preserves it in unified history", async () => {
    for (const [index, lead] of leads.entries()) {
      const before = await json(`/api/leads/${lead.id}`, rep.session);
      const note = `QA regression comment ${index + 1}`;
      const saved = await json(`/api/leads/${lead.id}/notes`, rep.session, {
        method: "PATCH",
        body: JSON.stringify({ notes: note, baseUpdatedAt: before.updatedAt }),
      });
      expect(saved.notes).toBe(note);

      const history = await json(`/api/leads/${lead.id}/history`, rep.session);
      const noteRows = history.filter((row: any) => row.type === "note");
      expect(noteRows).toHaveLength(1);
      expect(noteRows[0]).toMatchObject({ actor: "Regression Rep", notePreview: note });
    }
  });

  it("marks three leads sold, deduplicates a replay, and prices the exact weekly pay", async () => {
    const start = Date.now() - 30_000;
    for (const [index, lead] of leads.entries()) {
      const sold = await json(`/api/leads/${lead.id}/knock`, rep.session, {
        method: "POST",
        body: JSON.stringify({
          outcome: "sold",
          knockedAt: new Date(start + index * 2_000).toISOString(),
          clientId: `field-flow-sold-${lead.id}`,
        }),
      });
      expect(sold).toMatchObject({ outcome: "sold", repId: rep.memberId });
    }

    // An offline retry must return the original command, not mint a fourth sale.
    const replay = await json(`/api/leads/${leads[0].id}/knock`, rep.session, {
      method: "POST",
      body: JSON.stringify({
        outcome: "sold",
        knockedAt: new Date(start).toISOString(),
        clientId: `field-flow-sold-${leads[0].id}`,
      }),
    });
    expect(replay.deduped).toBe(true);

    const pay = await json("/api/commission/statements/me/current", rep.session);
    expect(pay.statement).toMatchObject({
      qualified_sale_count: 3,
      gross_commission_cents: 45_000,
      final_commission_cents: 45_000,
    });
    expect(pay.sales.filter((sale: any) => sale.status === "QUALIFIED")).toHaveLength(3);
    expect(pay.holdback.current).toMatchObject({
      reservePercent: 10,
      reserveCents: 4_500,
      netPayableCents: 40_500,
    });

    // One pending compatibility commission per door; never one per retry.
    const legacyRows = rawDb.prepare(
      "SELECT lead_id AS leadId, amount, status FROM commissions WHERE rep_id = ? ORDER BY lead_id",
    ).all(rep.memberId) as any[];
    expect(legacyRows).toHaveLength(3);
    expect(legacyRows.every((row) => row.amount === 150 && row.status === "pending")).toBe(true);
  });

  it("rolls the saved sales into rep metrics without changing pay arithmetic", async () => {
    const facts = rollupToday();
    expect(facts).toMatchObject({
      doorsAttempted: 3,
      doorsVisited: 3,
      contacts: 3,
      submittedOrders: 3,
    });

    const metrics = await json(
      `/api/metrics/me?from=${metricDate()}&to=${metricDate()}`,
      rep.session,
    );
    expect(metrics.facts).toMatchObject({
      doorsAttempted: 3,
      doorsVisited: 3,
      contacts: 3,
      submittedOrders: 3,
    });
  });

  it("corrects one accidental sale and reconciles history, metrics and pay downward", async () => {
    const correctedLead = leads[2];
    await json(`/api/leads/${correctedLead.id}/knock`, rep.session, {
      method: "POST",
      body: JSON.stringify({
        outcome: "not_interested",
        knockedAt: new Date().toISOString(),
        clientId: `field-flow-correction-${correctedLead.id}`,
      }),
    });

    const lead = await json(`/api/leads/${correctedLead.id}`, rep.session);
    expect(lead).toMatchObject({ leadStatus: "not_interested", lastOutcome: "not_interested" });
    const history = await json(`/api/leads/${correctedLead.id}/history`, rep.session);
    expect(history.filter((row: any) => row.type === "status_change").map((row: any) => row.status))
      .toEqual(["not_interested", "sold"]);
    expect(history.some((row: any) => row.type === "note" && row.notePreview === "QA regression comment 3")).toBe(true);

    const pay = await json("/api/commission/statements/me/current", rep.session);
    expect(pay.statement).toMatchObject({
      qualified_sale_count: 2,
      gross_commission_cents: 30_000,
      final_commission_cents: 30_000,
    });
    expect(pay.sales.filter((sale: any) => sale.status === "QUALIFIED")).toHaveLength(2);
    expect(pay.sales.find((sale: any) => sale.lead_id === correctedLead.id)).toMatchObject({ status: "REVERSED" });
    expect(pay.holdback.current).toMatchObject({
      reservePercent: 10,
      reserveCents: 3_000,
      netPayableCents: 27_000,
    });

    const facts = rollupToday();
    expect(facts).toMatchObject({
      doorsAttempted: 4,
      doorsVisited: 3,
      contacts: 4,
      submittedOrders: 2,
      notInterestedRecords: 1,
      revisits: 1,
    });
    const metrics = await json(
      `/api/metrics/me?from=${metricDate()}&to=${metricDate()}`,
      rep.session,
    );
    expect(metrics.facts).toMatchObject({
      doorsAttempted: 4,
      doorsVisited: 3,
      submittedOrders: 2,
    });

    expect((rawDb.prepare(
      "SELECT COUNT(*) AS n FROM commission_sales WHERE tenant_id = 1 AND rep_id = ? AND status = 'QUALIFIED'",
    ).get(rep.memberId) as any).n).toBe(2);
    expect((rawDb.prepare(
      "SELECT COUNT(*) AS n FROM commissions WHERE rep_id = ? AND status = 'pending'",
    ).get(rep.memberId) as any).n).toBe(2);
  });
});
