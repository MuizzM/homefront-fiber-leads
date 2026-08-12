// ── Recovery messaging: the wall, end to end ─────────────────────────────────
//
// One question decides whether this feature is safe to ship: can a message
// reach a customer who did not agree to receive it? Every test here is a
// different way of asking that.
//
//   THE FLAG      With PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED off,
//                 nothing sends, no matter what any organization has configured.
//   THE APPROVAL  With the flag on, an organization that has not approved
//                 messaging still sends nothing.
//   CONSENT       With both, a customer with no consent record still gets
//                 nothing, and one who revoked gets nothing.
//   SUPPRESSION   A STOP reply and an email unsubscribe both block immediately,
//                 and no rep can undo either.
//   THE CAPS      Frequency limits hold even for a fully consented customer.
//   THE RECORD    A blocked send is still written down, with its reasons.

import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recipientLocalHour } from "@shared/contactConsent";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let store: typeof import("../../server/vendorOrderStore");
let worker: typeof import("../../server/vendorOrderImportWorker");
let providers: typeof import("../../server/messagingProviders");
let messaging: typeof import("../../server/orderRecoveryMessaging");

let adminSession = "", repSession = "", otherRepSession = "";
let repMemberId = 0, otherRepMemberId = 0;
let caseId = 0, smsTemplateId = 0, emailTemplateId = 0;

const realFetch = globalThis.fetch.bind(globalThis);
const ORG = 1;
const CUSTOMER_PHONE = "+17045550142";
const CUSTOMER_EMAIL = "jane@example.com";

/** Everything the SMS provider was asked to send. A test asserts on the LENGTH
 *  of this as often as on a status code: "blocked" has to mean nothing reached
 *  the provider, not merely that the response said no. */
const smsSent: { to: string; body: string }[] = [];
const emailSent: { to: string; subject: string }[] = [];

let counter = 0;

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

async function upload(path: string, sessionId: string, content: string, fileName: string) {
  const boundary = `----hfmsg${counter += 1}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`, "utf8"),
    Buffer.from(content, "utf8"),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
  return realFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "x-session-id": sessionId,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    body,
  });
}

/** Quiet hours that certainly contain right now, computed the same way the gate
 *  computes it. Pinning the window to the clock rather than to a literal is what
 *  stops this suite failing only on a late-evening CI run. */
function windowAroundNow(offsetHours = 0): { quietHoursStart: number; quietHoursEnd: number } {
  const hour = recipientLocalHour("NC", new Date())!;
  return {
    quietHoursStart: (hour + offsetHours + 24) % 24,
    quietHoursEnd: (hour + offsetHours + 1 + 24) % 24,
  };
}

async function setPolicy(patch: Record<string, unknown>) {
  const current = await (await request("/api/order-recovery/policy", adminSession)).json();
  const res = await request("/api/order-recovery/policy", adminSession, {
    method: "PUT",
    body: JSON.stringify({ ...current.config, ...patch }),
  });
  expect(res.status).toBe(200);
}

async function draft(session: string, templateId: number) {
  const res = await request(`/api/order-recovery/cases/${caseId}/draft`, session, {
    method: "POST", body: JSON.stringify({ templateId }),
  });
  return { status: res.status, body: await res.json() };
}

async function send(session: string, templateId: number) {
  const res = await request(`/api/order-recovery/cases/${caseId}/send`, session, {
    method: "POST", body: JSON.stringify({ templateId }),
  });
  return { status: res.status, body: await res.json() };
}

function grantConsent(channel: "sms" | "email", basis = "express_written") {
  return request("/api/order-recovery/consents", adminSession, {
    method: "POST",
    body: JSON.stringify({
      channel,
      destination: channel === "sms" ? CUSTOMER_PHONE : CUSTOMER_EMAIL,
      status: "granted", basis, source: "door_agreement",
      capturedAt: new Date().toISOString(), proofReference: "agreement-123",
    }),
  });
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-recovery-msg-"));
  process.env.NODE_ENV = "test";
  process.env.VENDOR_ORDER_ENCRYPTION_KEY = "b".repeat(64);
  process.env.VENDOR_CONTACT_HASH_KEY = "c".repeat(64);
  process.env.PUBLIC_BASE_URL = "https://portal.example.test";
  process.env.PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED = "false";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  store = await import("../../server/vendorOrderStore");
  worker = await import("../../server/vendorOrderImportWorker");
  providers = await import("../../server/messagingProviders");
  messaging = await import("../../server/orderRecoveryMessaging");
  const { registerRoutes } = await import("../../server/routes");

  providers.setSmsProvider({
    name: "test-sms",
    isConfigured: () => true,
    async sendSms(input) {
      smsSent.push({ to: input.to, body: input.body });
      return { ok: true, providerMessageId: `sms-${smsSent.length}`, safeError: null };
    },
  });
  providers.setEmailProvider({
    name: "test-email",
    isConfigured: () => true,
    async sendEmail(input) {
      emailSent.push({ to: input.to, subject: input.subject });
      return { ok: true, providerMessageId: `email-${emailSent.length}`, safeError: null };
    },
  });

  const member = (name: string) => Number(rawDb.prepare(
    `INSERT INTO team_members (name, tenant_id, role, active, created_at) VALUES (?,?,'rep',1,datetime('now'))`,
  ).run(name, ORG).lastInsertRowid);
  repMemberId = member("Sam Rivera");
  otherRepMemberId = member("Alex Chen");

  const user = (name: string, email: string, role: string, teamMemberId: number | null) => {
    const created = storage.createUser({ name, email, role, active: true, tenantId: ORG } as any);
    rawDb.prepare(`UPDATE users SET training_required = 0, team_member_id = ? WHERE id = ?`).run(teamMemberId, created.id);
    return storage.createSession(created.id).id;
  };
  adminSession = user("Msg Admin", "msg-admin@example.com", "admin", null);
  repSession = user("Sam Rivera", "msg-rep@example.com", "rep", repMemberId);
  otherRepSession = user("Alex Chen", "msg-rep-b@example.com", "rep", otherRepMemberId);

  const leadId = Number(rawDb.prepare(
    `INSERT INTO leads (address, city, state, zip, tenant_id, contact_name, lead_status, created_at, updated_at)
     VALUES ('123 N Main St','Concord','NC','28025',?, 'Jane Doe','sold',datetime('now'),datetime('now'))`,
  ).run(ORG).lastInsertRowid);
  rawDb.prepare(
    `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, lead_id, external_order_id, created_at, updated_at)
     VALUES (?,?,'msg-sale-a','QUALIFIED',?,?,'PV-3001',datetime('now'),datetime('now'))`,
  ).run(ORG, repMemberId, new Date(Date.now() - 30 * 86_400_000).toISOString(), leadId);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  // A real import, so the case has a real order behind it and the send path can
  // decrypt a real destination out of the import row. Stubbing the case would
  // skip precisely the code that decides who gets the message.
  const header = "Order Number,Customer Name,Customer Email,Customer Phone,Service Address,Carrier,Product,Program,Sales Rep Name,Submitted Date,Scheduled Install Date,Order Status,Status Reason,Last Modified";
  const old = new Date(Date.now() - 30 * 86_400_000);
  const day = `${old.getUTCMonth() + 1}/${old.getUTCDate()}/${old.getUTCFullYear()}`;
  const csv = `${header}\nPV-3001,Jane Doe,${CUSTOMER_EMAIL},(704) 555-0142,"123 N Main St, Concord NC 28025",Kinetic,Fiber 1 Gig,Door to Door,Sam Rivera,${day},,Missing Documents,Awaiting proof of address,${day}\n`;

  const preview = await (await upload("/api/order-imports/preview", adminSession, csv, "seed.csv")).json();
  await request("/api/order-imports/mapping", adminSession, {
    method: "PUT", body: JSON.stringify({ mapping: preview.mapping, sampleRows: preview.sampleRows }),
  });
  const imported = await upload("/api/order-imports", adminSession, csv, "seed.csv");
  expect(imported.status).toBe(202);
  for (let i = 0; i < 5 && (await worker.pump()) > 0; i += 1) { /* drain */ }

  const order = store.listOrders(ORG).find((o) => o.external_order_id === "PV-3001");
  expect(order, "the seeded order should have imported").toBeTruthy();
  const opened = store.findActiveCase(ORG, order!.id);
  expect(opened, "a missing-documents order should open a case").toBeTruthy();
  caseId = opened!.id;

  // Templates, seeded on first read, then one of each channel approved.
  const templates = await (await request("/api/order-recovery/templates", adminSession)).json();
  smsTemplateId = templates.templates.find((t: any) => t.channel === "sms" && t.kind === "missing_documents").id;
  emailTemplateId = templates.templates.find((t: any) => t.channel === "email" && t.kind === "missing_documents").id;
  for (const id of [smsTemplateId, emailTemplateId]) {
    const res = await request(`/api/order-recovery/templates/${id}/approve`, adminSession, {
      method: "POST", body: JSON.stringify({ approved: true }),
    });
    expect(res.status, "the seeded templates must be approvable as shipped").toBe(200);
  }
});

afterAll(async () => {
  providers.resetMessagingProviders();
  worker.stopVendorOrderImportWorker();
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(async () => {
  smsSent.length = 0;
  emailSent.length = 0;
  process.env.PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED = "false";
  // A clean, fully-permissive configuration each time; the individual tests
  // break exactly one thing.
  await setPolicy({
    messagingApproved: true,
    consentPolicyConfigured: true,
    automatedSequencesEnabled: false,
    supportPhone: "704-555-0100",
    companyMailingAddress: "1 Example Way, Charlotte NC 28202",
    smsSenderIdentity: "+17045550100",
    emailSenderIdentity: "orders@example.test",
    emailReplyTo: "orders@example.test",
    callbackUrl: "https://portal.example.test/callback",
    ...windowAroundNow(0),
    maxPerDestinationPerDay: 1,
    maxPerCaseTotal: 4,
    minHoursBetweenOutreach: 24,
  });
  // Wipe messaging state so each test starts from the same place.
  rawDb.prepare(`DELETE FROM order_recovery_outreach WHERE tenant_id = ?`).run(ORG);
  rawDb.prepare(`DELETE FROM customer_contact_suppressions WHERE tenant_id = ?`).run(ORG);
  rawDb.prepare(`DELETE FROM customer_contact_consents WHERE tenant_id = ?`).run(ORG);
  store.updateCase(caseId, { status: "open", last_outreach_at: null, outreach_count: 0, opt_out_blocked: 0 });
});

// ── The flag ─────────────────────────────────────────────────────────────────

describe("the feature flag", () => {
  it("blocks every send while it is off, however the organization is configured", async () => {
    await grantConsent("sms");
    const result = await send(repSession, smsTemplateId);
    expect(result.status).toBe(409);
    expect(result.body.gate.blockedBy).toContain("FEATURE_DISABLED");
    expect(smsSent).toHaveLength(0);
  });

  it("still lets a rep build a draft, so the words can be reviewed", async () => {
    await grantConsent("sms");
    const result = await draft(repSession, smsTemplateId);
    expect(result.status).toBe(200);
    expect(result.body.body).toContain("Jane");
    expect(result.body.gate.allowed).toBe(false);
    expect(result.body.gate.blockedBy).toContain("FEATURE_DISABLED");
    expect(smsSent).toHaveLength(0);
  });

  it("blocks an automated sequence even with the flag on, until the org enables sequences", async () => {
    process.env.PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED = "true";
    await grantConsent("sms");
    const outcome = await messaging.sendOutreach({
      tenantId: ORG, caseId, templateId: smsTemplateId, actorUserId: null, automated: true,
    });
    expect(outcome.sent).toBe(false);
    expect(outcome.message).toMatch(/automated/i);
    expect(smsSent).toHaveLength(0);
  });
});

// ── Consent ──────────────────────────────────────────────────────────────────

describe("consent", () => {
  beforeEach(() => { process.env.PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED = "true"; });

  it("blocks a send when no consent is on file", async () => {
    const result = await send(repSession, smsTemplateId);
    expect(result.status).toBe(409);
    expect(result.body.gate.blockedBy).toContain("CONSENT_MISSING");
    expect(smsSent).toHaveLength(0);
  });

  it("blocks a send when the organization has not approved messaging", async () => {
    await grantConsent("sms");
    await setPolicy({ messagingApproved: false });
    const result = await send(repSession, smsTemplateId);
    expect(result.body.gate.blockedBy).toContain("ORG_NOT_APPROVED");
    expect(smsSent).toHaveLength(0);
  });

  it("blocks a send when the consent was revoked", async () => {
    await request("/api/order-recovery/consents", adminSession, {
      method: "POST",
      body: JSON.stringify({
        channel: "sms", destination: CUSTOMER_PHONE, status: "revoked",
        basis: "express_written", source: "inbound_message", capturedAt: new Date().toISOString(),
      }),
    });
    const result = await send(repSession, smsTemplateId);
    expect(result.body.gate.blockedBy).toContain("CONSENT_REVOKED");
    expect(smsSent).toHaveLength(0);
  });

  it("sends once every requirement is met, and records what was sent", async () => {
    await grantConsent("sms");
    const result = await send(repSession, smsTemplateId);
    expect(result.status).toBe(200);
    expect(result.body.sent).toBe(true);
    expect(smsSent).toHaveLength(1);
    expect(smsSent[0].to).toBe(CUSTOMER_PHONE);
    expect(smsSent[0].body).toContain("Jane");
    expect(smsSent[0].body).toMatch(/reply stop/i);

    const detail = await (await request(`/api/order-recovery/cases/${caseId}`, repSession)).json();
    const outreach = detail.outreach[0];
    expect(outreach.status).toBe("sent");
    expect(outreach.consentBasis).toBe("express_written");
    // The record keeps the words, and the destination only in masked form.
    expect(outreach.body).toContain("Jane");
    expect(outreach.recipient).toBe("***-***-0142");
    expect(JSON.stringify(detail)).not.toContain("7045550142");
  });

  it("blocks a marketing text on a relationship-only consent", async () => {
    await grantConsent("sms", "existing_business_relationship");
    const res = await request(`/api/order-recovery/cases/${caseId}/send`, repSession, {
      method: "POST", body: JSON.stringify({ templateId: smsTemplateId, purpose: "marketing" }),
    });
    const body = await res.json();
    expect(body.gate.blockedBy).toContain("CONSENT_BASIS_INSUFFICIENT");
    expect(smsSent).toHaveLength(0);
  });
});

// ── Suppression ──────────────────────────────────────────────────────────────

describe("suppression", () => {
  beforeEach(() => { process.env.PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED = "true"; });

  it("turns an inbound STOP into a suppression and blocks the next send", async () => {
    await grantConsent("sms");
    expect((await send(repSession, smsTemplateId)).body.sent).toBe(true);
    smsSent.length = 0;

    process.env.RECOVERY_SMS_WEBHOOK_SECRET = "webhook-secret";
    const hook = await realFetch(`${baseUrl}/api/order-recovery/sms/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": "webhook-secret" },
      body: JSON.stringify({ from: "(704) 555-0142", body: "STOP" }),
    });
    expect(hook.status).toBe(200);
    expect((await hook.json()).optOut).toBe(true);

    // Reset the frequency counters so the ONLY thing blocking is the opt-out.
    rawDb.prepare(`DELETE FROM order_recovery_outreach WHERE tenant_id = ?`).run(ORG);
    const blocked = await send(repSession, smsTemplateId);
    expect(blocked.body.gate.blockedBy).toContain("SUPPRESSED");
    expect(smsSent).toHaveLength(0);
  });

  it("refuses the webhook without the shared secret", async () => {
    process.env.RECOVERY_SMS_WEBHOOK_SECRET = "webhook-secret";
    const res = await realFetch(`${baseUrl}/api/order-recovery/sms/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "(704) 555-0142", body: "STOP" }),
    });
    expect(res.status).toBe(404);
  });

  it("does not suppress a customer who used the word inside a sentence", async () => {
    process.env.RECOVERY_SMS_WEBHOOK_SECRET = "webhook-secret";
    await grantConsent("sms");
    await send(repSession, smsTemplateId);

    await realFetch(`${baseUrl}/api/order-recovery/sms/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": "webhook-secret" },
      body: JSON.stringify({ from: "(704) 555-0142", body: "please stop by tomorrow instead" }),
    });
    const suppressions = await (await request("/api/order-recovery/suppressions", adminSession)).json();
    expect(suppressions.suppressions.filter((s: any) => !s.lifted_at)).toHaveLength(0);
  });

  it("blocks a send after an email unsubscribe, using the link from the message", async () => {
    await grantConsent("email");
    const sent = await send(repSession, emailTemplateId);
    expect(sent.body.sent).toBe(true);
    expect(emailSent).toHaveLength(1);

    const outreach = rawDb.prepare(
      `SELECT id FROM order_recovery_outreach WHERE tenant_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(ORG) as any;
    const token = messaging.unsubscribeToken(ORG, outreach.id)!;
    const res = await realFetch(`${baseUrl}/api/order-recovery/unsubscribe?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/unsubscribed/i);

    rawDb.prepare(`DELETE FROM order_recovery_outreach WHERE tenant_id = ?`).run(ORG);
    const blocked = await send(repSession, emailTemplateId);
    expect(blocked.body.gate.blockedBy).toContain("SUPPRESSED");
    expect(emailSent).toHaveLength(1); // still just the first one
  });

  it("refuses a forged or draft unsubscribe token", async () => {
    for (const token of ["", "nonsense", messaging.unsubscribeToken(ORG, 0)!]) {
      const res = await realFetch(`${baseUrl}/api/order-recovery/unsubscribe?token=${encodeURIComponent(token)}`);
      expect(res.status).toBe(400);
    }
  });

  it("does not let a rep lift a suppression", async () => {
    const added = await request("/api/order-recovery/suppressions", adminSession, {
      method: "POST",
      body: JSON.stringify({ channel: "sms", destination: CUSTOMER_PHONE, reason: "do_not_contact" }),
    });
    const { id } = await added.json();

    expect((await request(`/api/order-recovery/suppressions/${id}/lift`, repSession, {
      method: "POST", body: JSON.stringify({ reason: "the customer asked me to resume" }),
    })).status).toBe(403);

    expect((await request("/api/order-recovery/suppressions", repSession)).status).toBe(403);
  });

  it("makes an administrator write down why a block is being lifted", async () => {
    const added = await request("/api/order-recovery/suppressions", adminSession, {
      method: "POST",
      body: JSON.stringify({ channel: "sms", destination: CUSTOMER_PHONE, reason: "do_not_contact" }),
    });
    const { id } = await added.json();

    expect((await request(`/api/order-recovery/suppressions/${id}/lift`, adminSession, {
      method: "POST", body: JSON.stringify({ reason: "asked" }),
    })).status).toBe(400);

    const ok = await request(`/api/order-recovery/suppressions/${id}/lift`, adminSession, {
      method: "POST", body: JSON.stringify({ reason: "Customer called back and asked to be contacted again." }),
    });
    expect(ok.status).toBe(200);

    const audit = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'order_recovery.suppression.lifted' AND outcome = 'success'`,
    ).get() as any;
    expect(Number(audit.n)).toBeGreaterThanOrEqual(1);
  });

  it("re-arms a lifted suppression when the customer opts out again", async () => {
    process.env.RECOVERY_SMS_WEBHOOK_SECRET = "webhook-secret";
    await grantConsent("sms");
    await send(repSession, smsTemplateId);

    await realFetch(`${baseUrl}/api/order-recovery/sms/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": "webhook-secret" },
      body: JSON.stringify({ from: CUSTOMER_PHONE, body: "STOP" }),
    });
    const list = await (await request("/api/order-recovery/suppressions", adminSession)).json();
    const row = list.suppressions.find((s: any) => !s.lifted_at);
    await request(`/api/order-recovery/suppressions/${row.id}/lift`, adminSession, {
      method: "POST", body: JSON.stringify({ reason: "Customer called and asked us to resume contact." }),
    });

    await realFetch(`${baseUrl}/api/order-recovery/sms/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": "webhook-secret" },
      body: JSON.stringify({ from: CUSTOMER_PHONE, body: "stop" }),
    });
    const after = await (await request("/api/order-recovery/suppressions", adminSession)).json();
    expect(after.suppressions.filter((s: any) => !s.lifted_at)).toHaveLength(1);
  });
});

// ── Frequency ────────────────────────────────────────────────────────────────

describe("frequency caps", () => {
  beforeEach(() => { process.env.PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED = "true"; });

  it("stops a second message to the same contact on the same day", async () => {
    await grantConsent("sms");
    expect((await send(repSession, smsTemplateId)).body.sent).toBe(true);
    const second = await send(repSession, smsTemplateId);
    expect(second.body.gate.blockedBy).toEqual(expect.arrayContaining(["RATE_LIMIT_DAILY"]));
    expect(smsSent).toHaveLength(1);
  });

  it("stops a case that has already had its allowance", async () => {
    await grantConsent("sms");
    await setPolicy({ maxPerDestinationPerDay: 99, minHoursBetweenOutreach: 0, maxPerCaseTotal: 2 });
    expect((await send(repSession, smsTemplateId)).body.sent).toBe(true);
    expect((await send(repSession, smsTemplateId)).body.sent).toBe(true);
    const third = await send(repSession, smsTemplateId);
    expect(third.body.gate.blockedBy).toContain("RATE_LIMIT_CASE");
    expect(smsSent).toHaveLength(2);
  });

  it("stops a message sent too soon after the last one", async () => {
    await grantConsent("sms");
    await setPolicy({ maxPerDestinationPerDay: 99, maxPerCaseTotal: 99, minHoursBetweenOutreach: 24 });
    expect((await send(repSession, smsTemplateId)).body.sent).toBe(true);
    const second = await send(repSession, smsTemplateId);
    expect(second.body.gate.blockedBy).toContain("RATE_LIMIT_COOLDOWN");
    expect(smsSent).toHaveLength(1);
  });

  it("stops a message outside the customer's local contact hours", async () => {
    await grantConsent("sms");
    await setPolicy(windowAroundNow(3));
    const result = await send(repSession, smsTemplateId);
    expect(result.body.gate.blockedBy).toContain("QUIET_HOURS");
    expect(smsSent).toHaveLength(0);
  });
});

// ── Templates and the record ─────────────────────────────────────────────────

describe("templates and the record", () => {
  beforeEach(() => { process.env.PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED = "true"; });

  it("refuses to approve a text with no opt-out wording", async () => {
    const created = await request("/api/order-recovery/templates", adminSession, {
      method: "POST",
      body: JSON.stringify({
        channel: "sms", kind: "customer_action", name: "No opt out",
        body: "Hi {{customer_first_name}}, call {{support_phone}} about your order.",
      }),
    });
    expect(created.status).toBe(400);
    expect((await created.json()).issues.map((i: any) => i.code)).toContain("NO_OPT_OUT");
  });

  it("refuses to send an unapproved template", async () => {
    await grantConsent("sms");
    const created = await request("/api/order-recovery/templates", adminSession, {
      method: "POST",
      body: JSON.stringify({
        channel: "sms", kind: "customer_action", name: "Draft only",
        body: "Hi {{customer_first_name}}, this is {{company_name}}. Reply STOP to opt out.",
      }),
    });
    const { id } = await created.json();
    const result = await send(repSession, id);
    expect(result.body.gate.blockedBy).toContain("TEMPLATE_NOT_APPROVED");
    expect(smsSent).toHaveLength(0);
  });

  it("publishes a new version rather than changing approved words", async () => {
    const before = await (await request("/api/order-recovery/templates", adminSession)).json();
    const approved = before.templates.find((t: any) => t.id === smsTemplateId);
    expect(approved.approved).toBe(1);

    const edited = await request("/api/order-recovery/templates", adminSession, {
      method: "POST",
      body: JSON.stringify({
        channel: "sms", kind: "missing_documents", name: "Missing documents v2",
        body: "Hi {{customer_first_name}}, one item left on your {{carrier}} order. Call {{support_phone}}. Reply STOP to opt out.",
        replacesId: smsTemplateId,
      }),
    });
    const { id: newId, version } = await edited.json();
    expect(version).toBe(approved.version + 1);

    const after = await (await request("/api/order-recovery/templates", adminSession)).json();
    const fresh = after.templates.find((t: any) => t.id === newId);
    expect(fresh.approved).toBe(0);
    // The words that were approved are retired, not rewritten.
    expect(after.templates.find((t: any) => t.id === smsTemplateId)).toBeUndefined();

    // Restore an approved template for the rest of the suite.
    await request(`/api/order-recovery/templates/${newId}/approve`, adminSession, {
      method: "POST", body: JSON.stringify({ approved: true }),
    });
    smsTemplateId = newId;
  });

  it("writes a blocked send down, with its reasons", async () => {
    const result = await send(repSession, smsTemplateId);
    expect(result.body.sent).toBe(false);

    const detail = await (await request(`/api/order-recovery/cases/${caseId}`, repSession)).json();
    const record = detail.outreach[0];
    expect(record.status).toBe("blocked");
    expect(record.blockedReasons).toContain("CONSENT_MISSING");

    const audit = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'order_recovery.message.blocked'`,
    ).get() as any;
    expect(Number(audit.n)).toBeGreaterThanOrEqual(1);
  });

  it("refuses a rep another rep's case entirely", async () => {
    expect((await request(`/api/order-recovery/cases/${caseId}/draft`, otherRepSession, {
      method: "POST", body: JSON.stringify({ templateId: smsTemplateId }),
    })).status).toBe(404);

    expect((await request(`/api/order-recovery/cases/${caseId}/send`, otherRepSession, {
      method: "POST", body: JSON.stringify({ templateId: smsTemplateId }),
    })).status).toBe(404);
    expect(smsSent).toHaveLength(0);
  });
});
