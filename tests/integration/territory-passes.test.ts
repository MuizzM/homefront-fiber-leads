// Multi-pass knocking: re-open an area for a second/third sweep.
//
// The requirement that drove this feature has two halves, and the second one is
// the one worth testing hard: reset what reps SEE, never lose what HAPPENED.
// So these tests don't just check that lead_status flipped — they check that
// every knock from the closed pass is still there, still attributed to the rep
// who made it, still tied to the pass it belonged to, and that the database
// itself refuses to let the ledger be rewritten.
//
// The other half is money. A sold door must never come back as a fresh prospect,
// because that means re-knocking a paying customer and potentially paying a
// second commission on the same address.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1, opts: { reportsToId?: number | null } = {}): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@pass.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId: opts.reportsToId ?? null } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) },
  });
}

const SQUARE = [[-80.41, 35.49], [-80.39, 35.49], [-80.39, 35.51], [-80.41, 35.51], [-80.41, 35.49]];
let seq = 0;

function seedArea(repIds: number[], tenantId = 1) {
  return storage.createTerritory({
    tenantId, name: "Maple Grove", repId: repIds[0], polygon: JSON.stringify(SQUARE),
    color: "#3EA394", status: "active", assigneeIds: JSON.stringify(repIds),
  } as any).id;
}

function seedLead(territoryId: number, repId: number | null, over: Record<string, any> = {}, tenantId = 1) {
  return storage.createLead({
    address: `${++seq} Maple St`, city: "Testburg", state: "NC", zip: "28100",
    lat: 35.50, lng: -80.40, tenantId, assignedRepId: repId, assignedTerritoryId: territoryId,
    leadStatus: "prospect", ...over,
  } as any).id;
}

function knock(leadId: number, repId: number, outcome: string, over: Record<string, any> = {}) {
  return storage.createKnock({
    leadId, repId, wasHome: outcome !== "not_home", outcome,
    knockedAt: new Date().toISOString(), ...over,
  } as any);
}

const leadOf = (id: number) => storage.getLeadById(id) as any;
const knocksOf = (leadId: number) =>
  rawDb.prepare(`SELECT * FROM knock_log WHERE lead_id = ? ORDER BY id`).all(leadId) as any[];

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-passes-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));

  fx.manager = person("Mona Manager", "manager");
  fx.lead = person("Lee Lead", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.rep = person("Rep Ann", "rep", 1, { reportsToId: fx.lead.memberId });
  fx.rep2 = person("Rep Bo", "rep", 1, { reportsToId: fx.lead.memberId });

  storage.createTenant({ slug: "other-pass", companyName: "Other", ownerName: "O", ownerEmail: "o@otherpass.test", brandName: "Other", brandColor: "#111", plan: "trial", status: "active" } as any);
  fx.foreignManager = person("Zed Manager", "manager", 2);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(() => new Promise<void>(r => server.close(() => r())));

// ── The core promise ──────────────────────────────────────────────────────────
describe("closing a pass re-opens the doors", () => {
  it("worked doors go back to prospect and lose their stale outcome", async () => {
    const area = seedArea([fx.rep.memberId]);
    const a = seedLead(area, fx.rep.memberId, { leadStatus: "not_interested", lastOutcome: "not_interested", lastOutcomeAt: "2026-01-01T00:00:00.000Z" });
    const b = seedLead(area, fx.rep.memberId, { leadStatus: "contacted", lastOutcome: "not_home" });

    const res = await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.leadsReset).toBe(2);

    for (const id of [a, b]) {
      const l = leadOf(id);
      expect(l.leadStatus).toBe("prospect");
      expect(l.lastOutcome).toBeNull();
      expect(l.lastOutcomeAt).toBeNull();
    }
  });

  it("the area advances to pass 2, and new knocks are stamped with it", async () => {
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId);
    knock(lead, fx.rep.memberId, "not_home");
    expect(knocksOf(lead)[0].pass_number).toBe(1);

    await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
    });

    knock(lead, fx.rep.memberId, "interested");
    const rows = knocksOf(lead);
    expect(rows).toHaveLength(2);
    // This is what makes the retained history *useful* rather than merely present:
    // you can tell which sweep each visit belonged to.
    expect(rows.map(r => r.pass_number)).toEqual([1, 2]);
  });

  it("does not touch leads in a different area", async () => {
    const mine = seedArea([fx.rep.memberId]);
    const theirs = seedArea([fx.rep2.memberId]);
    const untouched = seedLead(theirs, fx.rep2.memberId, { leadStatus: "not_interested" });
    seedLead(mine, fx.rep.memberId, { leadStatus: "not_interested" });

    await req(`/api/territories/${mine}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
    });
    expect(leadOf(untouched).leadStatus).toBe("not_interested");
  });
});

// ── History must not go away ──────────────────────────────────────────────────
describe("history survives the reset", () => {
  it("every knock from the closed pass is still there, unchanged", async () => {
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId, { leadStatus: "not_interested" });
    knock(lead, fx.rep.memberId, "not_home");
    knock(lead, fx.rep.memberId, "not_interested", { notes: "Said they're under contract" });
    const before = knocksOf(lead);
    expect(before).toHaveLength(2);

    await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "return_to_pool" }),
    });

    const after = knocksOf(lead);
    // Same rows, same ids, same outcomes, same notes, same rep. Byte-for-byte.
    expect(after).toEqual(before);
  });

  it("the rep who knocked keeps the credit after the area is handed to someone else", async () => {
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId);
    knock(lead, fx.rep.memberId, "interested");

    await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "reassign", newRepId: fx.rep2.memberId }),
    });

    expect(knocksOf(lead)[0].rep_id).toBe(fx.rep.memberId);   // history: original rep
    expect(leadOf(lead).assignedRepId).toBe(fx.rep2.memberId); // future work: new rep
  });

  it("records an immutable pass row with the closed pass's results", async () => {
    const area = seedArea([fx.rep.memberId]);
    const l1 = seedLead(area, fx.rep.memberId);
    const l2 = seedLead(area, fx.rep.memberId);
    knock(l1, fx.rep.memberId, "sold");
    knock(l2, fx.rep.memberId, "not_home");

    await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep", note: "Spring sweep done" }),
    });

    const res = await req(`/api/territories/${area}/passes`, fx.manager.session);
    const { passes, currentPass } = await res.json();
    expect(currentPass).toBe(2);
    expect(passes).toHaveLength(1);
    expect(passes[0].passNumber).toBe(1);
    expect(passes[0].note).toBe("Spring sweep done");
    expect(passes[0].stats.sold).toBe(1);
    expect(passes[0].stats.notHome).toBe(1);
    expect(passes[0].closedByName).toBe("Mona Manager");
  });

  it("the pass ledger is append-only - the DATABASE refuses to rewrite it", async () => {
    const area = seedArea([fx.rep.memberId]);
    seedLead(area, fx.rep.memberId);
    await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
    });

    // Not "the code doesn't do this" — the storage engine rejects it outright,
    // so a future writer that hasn't read the module comment still can't.
    expect(() => rawDb.exec(`UPDATE territory_passes SET leads_reset = 999`)).toThrow(/append-only/);
    expect(() => rawDb.exec(`DELETE FROM territory_passes`)).toThrow(/append-only/);
  });

  it("three passes stack into a readable history, newest first", async () => {
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId);
    for (let i = 0; i < 3; i++) {
      knock(lead, fx.rep.memberId, i === 1 ? "interested" : "not_home");
      await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
        method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
      });
    }
    const { passes, currentPass } = await (await req(`/api/territories/${area}/passes`, fx.manager.session)).json();
    expect(currentPass).toBe(4);
    expect(passes.map((p: any) => p.passNumber)).toEqual([3, 2, 1]);
    // Each sweep kept its own result rather than being folded into a running total.
    expect(passes.find((p: any) => p.passNumber === 2).stats.interested).toBe(1);
    expect(passes.find((p: any) => p.passNumber === 1).stats.notHome).toBe(1);
    expect(knocksOf(lead)).toHaveLength(3);
  });
});

// ── Money and compliance ──────────────────────────────────────────────────────
describe("doors that must never re-open", () => {
  it("a sold door stays sold", async () => {
    const area = seedArea([fx.rep.memberId]);
    const sold = seedLead(area, fx.rep.memberId, { leadStatus: "sold", lastOutcome: "sold" });
    const open = seedLead(area, fx.rep.memberId, { leadStatus: "not_interested" });

    const body = await (await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
    })).json();

    expect(leadOf(sold).leadStatus).toBe("sold");
    expect(leadOf(sold).lastOutcome).toBe("sold");
    expect(leadOf(open).leadStatus).toBe("prospect");
    expect(body.leadsFrozen).toBe(1);
    expect(body.frozenByReason.sold).toBe(1);
  });

  it("a door with a live commission is frozen even if its status says otherwise", async () => {
    // The ledger and lead_status can disagree — a sale imported from billing may
    // never have flipped the lead. The ledger wins, because that's the row that
    // gets paid on.
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId, { leadStatus: "contacted" });
    rawDb.prepare(`INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, lead_id)
                   VALUES (1, ?, ?, 'QUALIFIED', ?, ?)`)
      .run(fx.rep.memberId, `ext-${lead}`, new Date().toISOString(), lead);

    const body = await (await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
    })).json();

    expect(leadOf(lead).leadStatus).toBe("contacted"); // untouched
    expect(body.frozenByReason.commission_linked).toBe(1);
  });

  it("a REVERSED sale does not freeze the door forever", async () => {
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId, { leadStatus: "contacted" });
    rawDb.prepare(`INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, lead_id)
                   VALUES (1, ?, ?, 'REVERSED', ?, ?)`)
      .run(fx.rep.memberId, `rev-${lead}`, new Date().toISOString(), lead);

    await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
    });
    // The sale is dead, so the door is legitimately back in play.
    expect(leadOf(lead).leadStatus).toBe("prospect");
  });

  it("do-not-knock is permanent - no option in the API clears it", async () => {
    const area = seedArea([fx.rep.memberId]);
    const dnk = seedLead(area, fx.rep.memberId, { leadStatus: "not_interested", doNotKnock: true });

    const body = await (await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST",
      // Every permissive flag the endpoint accepts, set to its most permissive value.
      body: JSON.stringify({ territoryAction: "keep", keepPendingCallbacks: false }),
    })).json();

    expect(leadOf(dnk).leadStatus).toBe("not_interested");
    expect(body.frozenByReason.do_not_knock).toBe(1);
  });
});

describe("an area with no doors", () => {
  it("refuses to close a pass rather than recording an empty one", async () => {
    // Reclaiming to the pool clears assigned_territory_id on the leads, so a
    // pooled area genuinely reports zero doors. Closing a pass there would write
    // an all-zero ledger row and burn a pass number for nothing.
    const area = seedArea([fx.rep.memberId]);
    const res = await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NO_LINKED_DOORS");

    // Nothing recorded, nothing advanced.
    const { passes, currentPass } = await (await req(`/api/territories/${area}/passes`, fx.manager.session)).json();
    expect(passes).toHaveLength(0);
    expect(currentPass).toBe(1);
  });
});

// ── Atomicity ─────────────────────────────────────────────────────────────────
describe("the reset is all-or-nothing", () => {
  it("rolls back completely when the territory step fails", async () => {
    // A half-applied reset is the worst available outcome: doors re-opened with
    // no record of why, and no way to tell it happened. Prove the rollback by
    // making the territory step throw mid-transaction.
    const { startNextPass } = await import("../../server/territoryPass");
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId, { leadStatus: "not_interested" });
    knock(lead, fx.rep.memberId, "not_interested");

    expect(() => startNextPass({
      territoryId: area, tenantId: 1, action: "keep",
      applyTerritoryAction: () => { throw new Error("disk full"); },
    })).toThrow(/disk full/);

    // Nothing moved: lead untouched, pass not advanced, no ledger row.
    expect(leadOf(lead).leadStatus).toBe("not_interested");
    const t = rawDb.prepare(`SELECT current_pass AS p FROM territories WHERE id = ?`).get(area) as any;
    expect(t.p).toBe(1);
    const rows = rawDb.prepare(`SELECT COUNT(1) AS n FROM territory_passes WHERE territory_id = ?`).get(area) as any;
    expect(rows.n).toBe(0);
    // And the knock is still there, because a reset never touches history.
    expect(knocksOf(lead)).toHaveLength(1);
  });
});

// ── Territory handling ────────────────────────────────────────────────────────
describe("what happens to the area itself", () => {
  it("return_to_pool unassigns it and detaches the doors", async () => {
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId);
    await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "return_to_pool" }),
    });
    const t = storage.getTerritoryById(area) as any;
    expect(t.status).toBe("unassigned");
    expect(JSON.parse(t.assigneeIds)).toEqual([]);
    expect(leadOf(lead).assignedRepId).toBeNull();
  });

  it("keep leaves the same rep on it, ready to knock again", async () => {
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId, { leadStatus: "not_home" });
    await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
    });
    const t = storage.getTerritoryById(area) as any;
    expect(JSON.parse(t.assigneeIds)).toEqual([fx.rep.memberId]);
    expect(leadOf(lead).assignedRepId).toBe(fx.rep.memberId);
    expect(leadOf(lead).leadStatus).toBe("prospect");
  });

  it("reassign hands it to the new rep", async () => {
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId);
    await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "reassign", newRepId: fx.rep2.memberId }),
    });
    expect(JSON.parse((storage.getTerritoryById(area) as any).assigneeIds)).toEqual([fx.rep2.memberId]);
    expect(leadOf(lead).assignedRepId).toBe(fx.rep2.memberId);
  });

  it("rejects reassign with no rep, and does NOT half-apply the reset", async () => {
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId, { leadStatus: "not_interested" });
    const res = await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "reassign" }),
    });
    expect(res.status).toBe(400);
    // The validation runs before any write, so the area is untouched.
    expect(leadOf(lead).leadStatus).toBe("not_interested");
    const { passes } = await (await req(`/api/territories/${area}/passes`, fx.manager.session)).json();
    expect(passes).toHaveLength(0);
  });

  it("cannot hand an area to a rep from another org", async () => {
    const area = seedArea([fx.rep.memberId]);
    const res = await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "reassign", newRepId: fx.foreignManager.memberId }),
    });
    expect(res.status).toBe(404);
  });
});

// ── Preview ───────────────────────────────────────────────────────────────────
describe("preview", () => {
  it("reports what would happen and writes nothing", async () => {
    const area = seedArea([fx.rep.memberId]);
    seedLead(area, fx.rep.memberId, { leadStatus: "sold" });
    const open = seedLead(area, fx.rep.memberId, { leadStatus: "not_interested" });

    const p = await (await req(`/api/territories/${area}/next-pass/preview`, fx.manager.session)).json();
    expect(p.currentPass).toBe(1);
    expect(p.nextPass).toBe(2);
    expect(p.totals).toMatchObject({ total: 2, reset: 1, frozen: 1 });
    expect(p.frozenByReason.sold).toBe(1);
    expect(p.territoryName).toBe("Maple Grove");

    // Still pass 1, still not reset — a preview that mutates is worse than none.
    expect(leadOf(open).leadStatus).toBe("not_interested");
    expect((storage.getTerritoryById(area) as any).current_pass ?? 1).toBe(1);
  });

  it("does not leak lead ids", async () => {
    const area = seedArea([fx.rep.memberId]);
    seedLead(area, fx.rep.memberId);
    const raw = await (await req(`/api/territories/${area}/next-pass/preview`, fx.manager.session)).text();
    const body = JSON.parse(raw);
    expect(body.reset).toBeUndefined();
    expect(body.frozen).toBeUndefined();
  });

  it("counts callbacks the reset would drop, so the warning is honest", async () => {
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId, { leadStatus: "follow_up" });
    const future = new Date(Date.now() + 7 * 86400_000).toISOString();
    knock(lead, fx.rep.memberId, "callback", { callbackDate: future });

    const p = await (await req(`/api/territories/${area}/next-pass/preview`, fx.manager.session)).json();
    expect(p.callbacksAtRisk).toBe(1);

    // And with the option on, that door is protected instead.
    const kept = await (await req(`/api/territories/${area}/next-pass/preview?keepPendingCallbacks=true`, fx.manager.session)).json();
    expect(kept.frozenByReason.pending_callback).toBe(1);
    expect(kept.callbacksAtRisk).toBe(0);
  });
});

// ── Authorization and isolation ───────────────────────────────────────────────
describe("who can do this", () => {
  it("a rep cannot start a new pass", async () => {
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId, { leadStatus: "not_interested" });
    const res = await req(`/api/territories/${area}/next-pass`, fx.rep.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
    });
    expect(res.status).toBe(403);
    expect(leadOf(lead).leadStatus).toBe("not_interested");
  });

  it("a team lead cannot either - a reset wipes the whole team's outcomes", async () => {
    const area = seedArea([fx.rep.memberId]);
    const res = await req(`/api/territories/${area}/next-pass`, fx.lead.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
    });
    expect(res.status).toBe(403);
  });

  it("an unauthenticated caller gets 401", async () => {
    const area = seedArea([fx.rep.memberId]);
    const res = await fetch(`${baseUrl}/api/territories/${area}/next-pass`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ territoryAction: "keep" }),
    });
    expect(res.status).toBe(401);
  });

  it("a manager in another org gets 404, not 403 - no existence oracle", async () => {
    const area = seedArea([fx.rep.memberId]);
    const lead = seedLead(area, fx.rep.memberId, { leadStatus: "not_interested" });

    for (const path of [`/api/territories/${area}/next-pass/preview`, `/api/territories/${area}/passes`]) {
      expect((await req(path, fx.foreignManager.session)).status).toBe(404);
    }
    const res = await req(`/api/territories/${area}/next-pass`, fx.foreignManager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
    });
    expect(res.status).toBe(404);
    expect(leadOf(lead).leadStatus).toBe("not_interested");
  });

  it("the reset is recorded in the admin audit trail", async () => {
    const area = seedArea([fx.rep.memberId]);
    seedLead(area, fx.rep.memberId);
    await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
    });
    const row = rawDb.prepare(
      `SELECT * FROM admin_audit WHERE action = 'territory.next_pass' AND target_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(String(area)) as any;
    expect(row).toBeTruthy();
    expect(row.outcome).toBe("success");
  });
});
