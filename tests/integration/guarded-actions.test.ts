// ── The gate, end to end ─────────────────────────────────────────────────────
//
// One question decides whether this layer is a control or a decoration: can a
// dangerous write reach the database without the gate it was supposed to pass?
// Every test here is a different way of asking that, plus the two questions the
// undo journal has to answer honestly.
//
//   THE FLAG        With GUARDED_ACTIONS_ENABLED off, the whole surface is 404.
//   AUTO            A routine action executes, and the row really moves.
//   MAGNITUDE       The same kind, bigger, waits - and nothing moves while it
//                   waits. This is the one that matters: a queued action must
//                   not have already happened.
//   SELF-APPROVAL   The requester cannot clear their own request.
//   THE FLOOR       An admin who configures a floor away does not get it away.
//   UNDO            A reversible action goes back exactly where it came from.
//   DRIFT           An undo over somebody else's later edit is refused, and
//                   changes nothing.
//   HONESTY         An irreversible action is never offered an undo.
//   THE RECORD      Every transition is written down, and cannot be rewritten.

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

let adminSession = "", leadASession = "", leadBSession = "", repSession = "", auditorSession = "";
let complianceSession = "";
let leadAUserId = 0;
let repMemberId = 0, otherRepMemberId = 0;
let doorIds: number[] = [];
let suppressionId = 0;

const realFetch = globalThis.fetch.bind(globalThis);
const ORG = 1;

function request(path: string, sessionId: string | null, init: RequestInit = {}) {
  return realFetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "x-session-id": sessionId } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function json(path: string, session: string | null, init: RequestInit = {}) {
  const res = await request(path, session, init);
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

function submit(session: string, kind: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return json("/api/actions", session, {
    method: "POST",
    body: JSON.stringify({ kind, payload, ...extra }),
  });
}

function setPolicy(kind: string, patch: Record<string, unknown>) {
  return json(`/api/actions/policies/${kind}`, adminSession, {
    method: "PUT",
    body: JSON.stringify({
      mode: "auto", approvalAboveMagnitude: null, selfApproval: false,
      undoWindowMinutes: 60, pendingExpiryMinutes: 4320, ...patch,
    }),
  });
}

const assigneeOf = (leadId: number): number | null =>
  (rawDb.prepare(`SELECT assigned_rep_id AS r FROM leads WHERE id = ?`).get(leadId) as { r: number | null }).r;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-guarded-"));
  process.env.NODE_ENV = "test";
  // Deliberately starts OFF so the first describe block can prove the wall
  // exists before anything else turns it on.
  process.env.GUARDED_ACTIONS_ENABLED = "false";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  const { registerRoutes } = await import("../../server/routes");

  const member = (name: string) => Number(rawDb.prepare(
    `INSERT INTO team_members (name, tenant_id, role, active, created_at) VALUES (?,?,'rep',1,datetime('now'))`,
  ).run(name, ORG).lastInsertRowid);
  repMemberId = member("Sam Rivera");
  otherRepMemberId = member("Alex Chen");

  const user = (name: string, email: string, role: string) => {
    const created = storage.createUser({ name, email, role, active: true, tenantId: ORG } as any);
    rawDb.prepare(`UPDATE users SET training_required = 0 WHERE id = ?`).run(created.id);
    return { id: created.id, session: storage.createSession(created.id).id };
  };
  adminSession = user("Gate Admin", "gate-admin@example.com", "admin").session;
  const leadA = user("Lead A", "gate-lead-a@example.com", "team_lead");
  leadAUserId = leadA.id;
  leadASession = leadA.session;
  leadBSession = user("Lead B", "gate-lead-b@example.com", "team_lead").session;
  repSession = user("Field Rep", "gate-rep@example.com", "rep").session;
  auditorSession = user("Reviewer", "gate-auditor@example.com", "auditor").session;
  // The only other role holding contact.suppression.manage. Needed because the
  // admin who submits a lift is barred from approving it, which is the point.
  complianceSession = user("Compliance", "gate-compliance@example.com", "compliance_admin").session;

  const insertDoor = rawDb.prepare(
    `INSERT INTO leads (address, city, state, zip, tenant_id, fiber_status, assigned_rep_id, created_at, updated_at)
     VALUES (?,?,?,?,?,'unknown',?,datetime('now'),datetime('now'))`,
  );
  doorIds = Array.from({ length: 12 }, (_, i) =>
    Number(insertDoor.run(`${100 + i} Test St`, "Charlotte", "NC", "28202", ORG, repMemberId).lastInsertRowid));

  suppressionId = Number(rawDb.prepare(
    `INSERT INTO customer_contact_suppressions
       (tenant_id, channel, destination_hash, destination_masked, reason, source, suppressed_at)
     VALUES (?, 'sms', 'hash-abc', '(704) xxx-0142', 'opt_out_reply', 'inbound_sms', datetime('now'))`,
  ).run(ORG).lastInsertRowid);

  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── The flag ─────────────────────────────────────────────────────────────────

describe("with the flag off the surface does not exist", () => {
  it("answers 404 on every route, to every role", async () => {
    // 404 and not 403 on purpose: a 403 would confirm the surface exists and
    // invite somebody to go looking for the switch.
    for (const [path, session] of [
      ["/api/actions/catalogue", adminSession],
      ["/api/actions/pending", adminSession],
      ["/api/actions/policies", adminSession],
      ["/api/actions/pending-count", leadASession],
    ] as const) {
      expect((await json(path, session)).status, path).toBe(404);
    }
    expect((await submit(leadASession, "lead.reassign", { leadId: doorIds[0], toRepId: otherRepMemberId })).status)
      .toBe(404);
  });

  it("leaves the door exactly where it was", async () => {
    expect(assigneeOf(doorIds[0])).toBe(repMemberId);
  });
});

// ── Everything below runs with the gate on ───────────────────────────────────

describe("with the gate on", () => {
  beforeAll(() => { process.env.GUARDED_ACTIONS_ENABLED = "true"; });

  beforeEach(() => {
    rawDb.prepare(`UPDATE leads SET assigned_rep_id = ? WHERE tenant_id = ?`).run(repMemberId, ORG);
    rawDb.prepare(`DELETE FROM guarded_action_policies WHERE tenant_id = ?`).run(ORG);
  });

  describe("an automatic action executes and is journaled", () => {
    it("moves the door and reports what it did", async () => {
      const { status, body } = await submit(leadASession, "lead.reassign",
        { leadId: doorIds[0], toRepId: otherRepMemberId });

      expect(status).toBe(200);
      expect(body.status).toBe("executed");
      expect(body.action.state).toBe("executed");
      // The claim and the database agree. Asserting only on the response would
      // pass just as happily against a layer that wrote nothing.
      expect(assigneeOf(doorIds[0])).toBe(otherRepMemberId);
      expect(body.action.resultSummary).toContain("Alex Chen");
    });

    it("offers an undo inside the window", async () => {
      const { body } = await submit(leadASession, "lead.reassign",
        { leadId: doorIds[1], toRepId: otherRepMemberId });
      expect(body.action.undo.available).toBe(true);
    });

    it("writes a transition log that cannot be rewritten", async () => {
      const { body } = await submit(leadASession, "lead.reassign",
        { leadId: doorIds[2], toRepId: otherRepMemberId });
      const detail = await json(`/api/actions/${body.action.id}`, adminSession);
      expect(detail.body.events.map((e: any) => e.type)).toEqual(["submitted", "auto_executed", "executed"]);

      // Enforced by the database, not by a convention in a code review.
      expect(() => rawDb.prepare(`UPDATE guarded_action_events SET note = 'x' WHERE action_id = ?`)
        .run(body.action.id)).toThrow(/append-only/);
      expect(() => rawDb.prepare(`DELETE FROM guarded_action_events WHERE action_id = ?`)
        .run(body.action.id)).toThrow(/append-only/);
    });
  });

  describe("magnitude sends the big one to a queue", () => {
    it("queues it AND leaves every door untouched", async () => {
      await setPolicy("lead.bulk_assign", { approvalAboveMagnitude: 5 });
      const selection = doorIds.slice(0, 9);

      const { status, body } = await submit(leadASession, "lead.bulk_assign",
        { leadIds: selection, toRepId: otherRepMemberId });

      // 202: accepted, not done.
      expect(status).toBe(202);
      expect(body.status).toBe("pending");
      expect(body.action.gateReason).toContain("9");
      // The assertion this whole file exists for. A pending action that has
      // already happened is not a gate.
      for (const id of selection) expect(assigneeOf(id)).toBe(repMemberId);
    });

    it("lets a small selection of the same kind straight through", async () => {
      await setPolicy("lead.bulk_assign", { approvalAboveMagnitude: 5 });
      const selection = doorIds.slice(0, 3);
      const { body } = await submit(leadASession, "lead.bulk_assign",
        { leadIds: selection, toRepId: otherRepMemberId });

      expect(body.status).toBe("executed");
      for (const id of selection) expect(assigneeOf(id)).toBe(otherRepMemberId);
    });
  });

  describe("a pending action needs somebody else", () => {
    let actionId = 0;
    const selection = () => doorIds.slice(0, 9);

    beforeEach(async () => {
      await setPolicy("lead.bulk_assign", { approvalAboveMagnitude: 5 });
      const { body } = await submit(leadASession, "lead.bulk_assign",
        { leadIds: selection(), toRepId: otherRepMemberId });
      actionId = body.action.id;
    });

    it("refuses the requester's own approval", async () => {
      const { status, body } = await json(`/api/actions/${actionId}/approve`, leadASession, {
        method: "POST", body: JSON.stringify({ note: "mine" }),
      });
      expect(status).toBe(403);
      expect(body.code).toBe("self_approval");
      for (const id of selection()) expect(assigneeOf(id)).toBe(repMemberId);
    });

    it("executes on a second approver, and only then", async () => {
      const { status, body } = await json(`/api/actions/${actionId}/approve`, leadBSession, {
        method: "POST", body: JSON.stringify({ note: "checked the map" }),
      });
      expect(status).toBe(200);
      expect(body.action.state).toBe("executed");
      for (const id of selection()) expect(assigneeOf(id)).toBe(otherRepMemberId);
    });

    it("refuses a second decision on the same request", async () => {
      await json(`/api/actions/${actionId}/approve`, leadBSession, { method: "POST", body: "{}" });
      const again = await json(`/api/actions/${actionId}/approve`, leadBSession, { method: "POST", body: "{}" });
      expect(again.status).toBe(409);
    });

    it("changes nothing when it is rejected", async () => {
      const { status, body } = await json(`/api/actions/${actionId}/reject`, leadBSession, {
        method: "POST", body: JSON.stringify({ note: "wrong rep" }),
      });
      expect(status).toBe(200);
      expect(body.action.state).toBe("rejected");
      for (const id of selection()) expect(assigneeOf(id)).toBe(repMemberId);
    });

    it("is invisible to a role that cannot approve its kind", async () => {
      // An auditor holds action.queue.read and none of the approve
      // capabilities, so the queue they are offered is empty rather than full
      // of buttons that would 403.
      const { body } = await json("/api/actions/pending", auditorSession);
      expect(body.actions).toEqual([]);
    });

    it("still shows up in history for that same role", async () => {
      const { body } = await json("/api/actions?state=pending", auditorSession);
      expect(body.actions.some((a: any) => a.id === actionId)).toBe(true);
    });
  });

  describe("undo puts things back", () => {
    it("returns every door to the rep that had it", async () => {
      // Two different previous owners, so a reversal that just restores "the"
      // previous rep would be visibly wrong.
      rawDb.prepare(`UPDATE leads SET assigned_rep_id = ? WHERE id = ?`).run(otherRepMemberId, doorIds[0]);

      const selection = doorIds.slice(0, 4);
      const { body } = await submit(leadASession, "lead.bulk_assign",
        { leadIds: selection, toRepId: repMemberId });
      expect(body.action.state).toBe("executed");

      const undone = await json(`/api/actions/${body.action.id}/undo`, leadBSession, {
        method: "POST", body: JSON.stringify({ reason: "wrong selection" }),
      });
      expect(undone.status).toBe(200);
      expect(undone.body.action.state).toBe("undone");

      expect(assigneeOf(doorIds[0])).toBe(otherRepMemberId);
      for (const id of selection.slice(1)) expect(assigneeOf(id)).toBe(repMemberId);
    });

    it("refuses to reverse twice", async () => {
      const { body } = await submit(leadASession, "lead.reassign",
        { leadId: doorIds[5], toRepId: otherRepMemberId });
      await json(`/api/actions/${body.action.id}/undo`, leadBSession, { method: "POST", body: "{}" });
      const again = await json(`/api/actions/${body.action.id}/undo`, leadBSession, { method: "POST", body: "{}" });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("already_undone");
    });

    it("refuses when somebody else changed the same door afterwards", async () => {
      const { body } = await submit(leadASession, "lead.reassign",
        { leadId: doorIds[6], toRepId: otherRepMemberId });

      // Somebody else moves the same door by another route.
      rawDb.prepare(`UPDATE leads SET assigned_rep_id = ?, assigned_at = ? WHERE id = ?`)
        .run(repMemberId, "2026-08-11T23:59:00.000Z", doorIds[6]);

      const undone = await json(`/api/actions/${body.action.id}/undo`, leadBSession, { method: "POST", body: "{}" });
      expect(undone.status).toBe(409);
      expect(undone.body.code).toBe("drift");
      // Refused means refused: the later edit still stands.
      expect(assigneeOf(doorIds[6])).toBe(repMemberId);
    });

    it("records the refused attempt", async () => {
      const { body } = await submit(leadASession, "lead.reassign",
        { leadId: doorIds[7], toRepId: otherRepMemberId });
      rawDb.prepare(`UPDATE leads SET assigned_at = ? WHERE id = ?`).run("2026-08-12T00:00:00.000Z", doorIds[7]);
      await json(`/api/actions/${body.action.id}/undo`, leadBSession, { method: "POST", body: "{}" });

      const detail = await json(`/api/actions/${body.action.id}`, adminSession);
      expect(detail.body.events.map((e: any) => e.type)).toContain("undo_failed");
      // The action itself is still executed, not undone and not failed.
      expect(detail.body.action.state).toBe("executed");
    });
  });

  describe("the floor holds against the organization's own settings", () => {
    it("hands back approval when an admin asks for automatic", async () => {
      const { status, body } = await setPolicy("contact.suppression.lift", { mode: "auto" });
      expect(status).toBe(200);
      // Echoed rather than 400: the response is the answer to "what did you
      // actually set", and the screen renders it.
      expect(body.policy.mode).toBe("approval");
      expect(body.floor).toBe("approval");
    });

    it("queues the lift anyway, and the block stays up while it waits", async () => {
      await setPolicy("contact.suppression.lift", { mode: "auto" });
      const { status, body } = await json("/api/actions", adminSession, {
        method: "POST",
        body: JSON.stringify({
          kind: "contact.suppression.lift",
          payload: { suppressionId, reason: "Customer called back and asked to be re-enrolled." },
        }),
      });
      expect(status).toBe(202);
      expect(body.status).toBe("pending");
      const row = rawDb.prepare(`SELECT lifted_at FROM customer_contact_suppressions WHERE id = ?`)
        .get(suppressionId) as { lifted_at: string | null };
      expect(row.lifted_at).toBeNull();
    });

    it("demands a substantive reason", async () => {
      const { status } = await json("/api/actions", adminSession, {
        method: "POST",
        body: JSON.stringify({ kind: "contact.suppression.lift", payload: { suppressionId, reason: "ok" } }),
      });
      expect(status).toBe(400);
    });

    it("never offers an undo once it has run", async () => {
      const submitted = await json("/api/actions", adminSession, {
        method: "POST",
        body: JSON.stringify({
          kind: "contact.suppression.lift",
          payload: { suppressionId, reason: "Written consent captured again on 2026-08-11." },
        }),
      });
      const approved = await json(`/api/actions/${submitted.body.action.id}/approve`, leadBSession, {
        method: "POST", body: "{}" });
      // leadB is a team_lead and holds no contact.suppression.manage, so the
      // engine refuses the decision even though the route let them in.
      expect(approved.status).toBe(403);

      // The admin who submitted it is barred too, by the same self-approval
      // rule - so the lift genuinely takes two people who both hold the
      // capability, which is what "always needs a second approver" has to mean.
      const bySelf = await json(`/api/actions/${submitted.body.action.id}/approve`, adminSession, {
        method: "POST", body: "{}" });
      expect(bySelf.status).toBe(403);
      expect(bySelf.body.code).toBe("self_approval");

      const byCompliance = await json(`/api/actions/${submitted.body.action.id}/approve`, complianceSession, {
        method: "POST", body: "{}" });
      expect(byCompliance.status).toBe(200);
      expect(byCompliance.body.action.state).toBe("executed");
      expect(byCompliance.body.action.undo.available).toBe(false);
      expect(byCompliance.body.action.undo.because).toBe("irreversible");

      const attempt = await json(`/api/actions/${submitted.body.action.id}/undo`, complianceSession, {
        method: "POST", body: "{}" });
      expect(attempt.status).toBe(409);
      expect(attempt.body.code).toBe("irreversible");
    });
  });

  describe("refusals and edges", () => {
    it("refuses a kind the caller may not request", async () => {
      // A rep holds neither lead.reassign nor lead.assign.
      const { status } = await submit(repSession, "lead.reassign",
        { leadId: doorIds[0], toRepId: otherRepMemberId });
      expect(status).toBe(403);
    });

    it("refuses a bulk selection that has gone stale, without assigning the rest", async () => {
      const selection = [...doorIds.slice(0, 3), 999_999];
      const { status, body } = await submit(leadASession, "lead.bulk_assign",
        { leadIds: selection, toRepId: otherRepMemberId });
      expect(status).toBe(409);
      expect(body.code).toBe("stale_selection");
      // A partial bulk move is the outcome nobody asked for and the hardest to
      // notice, so nothing moved at all.
      for (const id of doorIds.slice(0, 3)) expect(assigneeOf(id)).toBe(repMemberId);
    });

    it("refuses an inactive rep", async () => {
      const goneId = Number(rawDb.prepare(
        `INSERT INTO team_members (name, tenant_id, role, active, created_at) VALUES ('Departed',?,'rep',0,datetime('now'))`,
      ).run(ORG).lastInsertRowid);
      const { status } = await submit(leadASession, "lead.reassign", { leadId: doorIds[0], toRepId: goneId });
      expect(status).toBe(400);
    });

    it("returns the original action on an idempotent retry", async () => {
      const key = `retry-${Date.now()}`;
      const first = await submit(leadASession, "lead.reassign",
        { leadId: doorIds[8], toRepId: otherRepMemberId }, { idempotencyKey: key });
      const second = await submit(leadASession, "lead.reassign",
        { leadId: doorIds[8], toRepId: otherRepMemberId }, { idempotencyKey: key });

      expect(second.body.action.id).toBe(first.body.action.id);
      const count = rawDb.prepare(`SELECT COUNT(*) AS n FROM guarded_actions WHERE idempotency_key = ?`)
        .get(key) as { n: number };
      expect(count.n).toBe(1);
    });

    it("expires a pending request nobody decided", async () => {
      await setPolicy("lead.bulk_assign", { approvalAboveMagnitude: 1, pendingExpiryMinutes: 5 });
      const { body } = await submit(leadASession, "lead.bulk_assign",
        { leadIds: doorIds.slice(0, 4), toRepId: otherRepMemberId });

      rawDb.prepare(`UPDATE guarded_actions SET expires_at = ? WHERE id = ?`)
        .run("2026-08-10T00:00:00.000Z", body.action.id);

      // The sweep rides on the read, so an organization with no scheduler still
      // never sees a stale request presented as actionable.
      const queue = await json("/api/actions/pending", leadBSession);
      expect(queue.body.actions.some((a: any) => a.id === body.action.id)).toBe(false);

      const detail = await json(`/api/actions/${body.action.id}`, adminSession);
      expect(detail.body.action.state).toBe("expired");
      for (const id of doorIds.slice(0, 4)) expect(assigneeOf(id)).toBe(repMemberId);

      const decide = await json(`/api/actions/${body.action.id}/approve`, leadBSession, { method: "POST", body: "{}" });
      expect(decide.status).toBe(409);
    });

    it("keeps the policy screen away from non-admins", async () => {
      expect((await json("/api/actions/policies", leadASession)).status).toBe(403);
      expect((await json("/api/actions/policies", adminSession)).status).toBe(200);
    });

    it("404s an action from another organization", async () => {
      const otherId = Number(rawDb.prepare(
        `INSERT INTO guarded_actions
           (tenant_id, kind, state, payload_json, magnitude, gate_outcome, gate_reason, policy_snapshot_json, requested_at, created_at, updated_at)
         VALUES (99,'lead.reassign','pending','{}',1,'approval','x','{}',datetime('now'),datetime('now'),datetime('now'))`,
      ).run().lastInsertRowid);
      expect((await json(`/api/actions/${otherId}`, adminSession)).status).toBe(404);
      expect((await json(`/api/actions/${otherId}/approve`, adminSession, { method: "POST", body: "{}" })).status)
        .toBe(404);
    });
  });
});
