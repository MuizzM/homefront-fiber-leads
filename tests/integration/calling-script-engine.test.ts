/**
 * LANE CC1 — personalized call-script engine tests.
 *
 * Covers: deterministic + personalized rules template (city momentum changes
 * the hook), LLM fallback (down / garbage / prohibited content — never 500),
 * LLM success path, DNC-blocked lead gets the same gate as other lead reads,
 * cross-tenant isolation, 6h cache hits, verbatim compliance footer on every
 * response, and no "free"/fake-urgency/named-competitor strings in output.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

const dataDir = mkdtempSync(join(tmpdir(), "hf-script-engine-"));
let server: Server;
let baseUrl: string;
let rawDb: import("better-sqlite3").Database;
let engine: typeof import("../../server/calling/scriptEngine");
let tenantId = 0;
let repUserId = 0;
let managerUserId = 0;
let complianceUserId = 0;
let otherRepUserId = 0;
let mainLeadId = 0;
let suppressedLeadId = 0;
let otherTenantLeadId = 0;
let otherTenantId = 0;

const REP = () => ({ id: repUserId, role: "calling_rep", tenantId });
const MANAGER = () => ({ id: managerUserId, role: "calling_manager", tenantId });
const COMPLIANCE = () => ({ id: complianceUserId, role: "compliance_admin", tenantId });
const OTHER_REP = () => ({ id: otherRepUserId, role: "calling_rep", tenantId });
const TENANT_B_REP = () => ({ id: 9999, role: "calling_rep", tenantId: otherTenantId });

function request(path: string, user: unknown) {
  return fetch(`${baseUrl}${path}`, {
    headers: { "content-type": "application/json", "x-test-user": JSON.stringify(user) },
  });
}

function insertLead(input: {
  address: string; city: string; state?: string; tenant?: number;
  leadTag?: string | null; fiberStatus?: string; createdAt?: string; isTenured?: number;
}) {
  const now = new Date().toISOString();
  const createdAt = input.createdAt ?? now;
  return Number(rawDb.prepare(`INSERT INTO leads
    (address,city,state,zip,fiber_status,lead_status,lead_tag,is_tenured,tenant_id,created_at,updated_at)
    VALUES (?,?,?,?,?,'prospect',?,?,?,?,?)`)
    .run(input.address, input.city, input.state ?? "NC", "27292", input.fiberStatus ?? "unknown",
      input.leadTag ?? null, input.isTenured ?? 0, input.tenant ?? tenantId, createdAt, now).lastInsertRowid);
}

function enqueue(leadId: number, stage = "FRESH_FIBER_DETECTED", assignedTo: number | null = repUserId, tenant = tenantId) {
  rawDb.prepare(`INSERT INTO calling_queue_entries
    (id,tenant_id,lead_id,stage,priority,assigned_user_id,created_at,updated_at)
    VALUES (lower(hex(randomblob(16))),?,?,?,80,?,datetime('now'),datetime('now'))`)
    .run(tenant, leadId, stage, assignedTo);
}

beforeAll(async () => {
  process.env.DATA_DIR = dataDir;
  process.env.CALLING_MODULE_ENABLED = "true";
  process.env.CALLING_DATA_ENCRYPTION_KEY = "11".repeat(32);
  process.env.PHONE_HASH_KEY = "22".repeat(32);
  process.env.CALL_AUTHORIZATION_SIGNING_KEY = "33".repeat(32);
  delete process.env.LLM_ENDPOINT;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_API_KEY;

  const storageModule = await import("../../server/storage");
  ({ rawDb } = await import("../../server/db"));
  storageModule.runMigrations();
  tenantId = storageModule.getDefaultTenantId()!;
  (await import("../../server/calling/migrations")).runCallingMigrations();
  engine = await import("../../server/calling/scriptEngine");

  otherTenantId = Number(rawDb.prepare(`INSERT INTO tenants
    (slug,company_name,owner_name,owner_email,brand_name,plan,status,created_at,updated_at)
    VALUES ('script-other','Other Org','Other Owner','other@script.example.test','Other','trial','active',?,?)`)
    .run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid);

  const insertUser = (name: string, role: string) => Number(rawDb.prepare(`INSERT INTO users
    (name,email,role,active,tenant_id,created_at) VALUES (?,?,?,1,?,?)`)
    .run(name, `${name.toLowerCase().replace(/\s+/g, ".")}@script.example.test`, role, tenantId,
      new Date().toISOString()).lastInsertRowid);
  repUserId = insertUser("Riley Rep", "calling_rep");
  managerUserId = insertUser("Morgan Manager", "calling_manager");
  complianceUserId = insertUser("Casey Compliance", "compliance_admin");
  otherRepUserId = insertUser("Opal Otherrep", "calling_rep");

  // Main fresh lead in Lexington plus fresh neighbors (21-day momentum = 4,
  // including self). One stale fresh lead (30d) must NOT count.
  mainLeadId = insertLead({ address: "100 Maple Grove Ln", city: "Lexington", leadTag: "fresh_fiber_confirmed" });
  rawDb.prepare(`UPDATE leads SET source_scan_target_id=999001,fresh_confirmed_at=?,fresh_confidence='cross_verified'
    WHERE id=?`).run(new Date().toISOString(), mainLeadId);
  insertLead({ address: "240 Oak Street", city: "Lexington", leadTag: "fresh_fiber_confirmed" });
  insertLead({ address: "17 Birchwood Dr", city: "Lexington", leadTag: "fresh_fiber_confirmed" });
  insertLead({ address: "8 Cedar Run", city: "Lexington", leadTag: "fresh_fiber_confirmed" });
  insertLead({ address: "9 Ancient Rd", city: "Lexington", leadTag: "fresh_fiber_confirmed",
    createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString() });
  // A suppressed (DNC) lead, still in the queue (in Denton so it does not
  // perturb the Lexington momentum count asserted below).
  suppressedLeadId = insertLead({ address: "12 Quiet Way", city: "Denton", leadTag: "fresh_fiber_confirmed" });
  enqueue(mainLeadId);
  enqueue(suppressedLeadId, "SUPPRESSED");
  // A lead in a different tenant — must be invisible to tenant 1.
  otherTenantLeadId = insertLead({ address: "1 Hidden Ct", city: "Lexington", tenant: otherTenantId, leadTag: "fresh_fiber_confirmed" });
  enqueue(otherTenantLeadId, "FRESH_FIBER_DETECTED", null, otherTenantId);

  const { registerCallingRoutes } = await import("../../server/calling/routes");
  const { can } = await import("@shared/capabilities");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    try { (req as any).user = JSON.parse(String(req.headers["x-test-user"] ?? "null")); }
    catch { (req as any).user = null; }
    next();
  });
  registerCallingRoutes(app, {
    requireAuth: (req, res, next) => ((req as any).user ? next() : res.status(401).json({ error: "Authentication required" })),
    requireCapability: (capability) => (req, res, next) =>
      (can(String((req as any).user?.role ?? ""), capability)
        ? next()
        : res.status(403).json({ error: "Forbidden", need: capability })),
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(dataDir, { recursive: true, force: true });
});

function expectCompliantText(text: string) {
  expect(text).not.toMatch(/\bfree\b/i);
  expect(text).not.toMatch(/\b(act now|limited[- ]time|expires? (today|tonight)|today only|last chance|offer ends)\b/i);
  expect(text).not.toMatch(/\b(spectrum|comcast|xfinity|at&t|verizon|frontier|centurylink)\b/i);
}

describe("rules template - deterministic and personalized", () => {
  it("builds identical output for identical context (deterministic)", async () => {
    engine.__clearScriptCacheForTests();
    const lead = { id: mainLeadId, address: "100 Maple Grove Ln", city: "Lexington", state: "NC", zip: "27292",
      leadTag: "fresh_fiber_confirmed", freshConfirmedAt: new Date().toISOString() };
    const a = await engine.generateScriptForLead({ tenantId, userId: repUserId, lead, repName: "Riley Rep", companyName: "Home Front Solutions" });
    engine.__clearScriptCacheForTests();
    const b = await engine.generateScriptForLead({ tenantId, userId: repUserId, lead, repName: "Riley Rep", companyName: "Home Front Solutions" });
    expect(a.script).toBe(b.script);
    expect(a.model).toBe("rules");
  });

  it("city momentum count changes the neighborhood hook", async () => {
    const highMomentum = engine.buildScriptContext({
      tenantId, repName: "Riley Rep", companyName: "Home Front Solutions",
      lead: { id: mainLeadId, address: "100 Maple Grove Ln", city: "Lexington", state: "NC", zip: "27292", leadTag: "fresh_fiber_confirmed" },
    });
    expect(highMomentum.freshCityCount21d).toBe(4); // stale 30-day-old fresh lead excluded
    expect(highMomentum.nearestFreshStreet).toBe("Oak Street");
    expect(highMomentum.fiberCategory).toBe("fresh");
    const busyHook = engine.buildTemplateSections(highMomentum).neighborhoodHook;
    expect(busyHook).toContain("4 homes in Lexington");
    expect(busyHook).toContain("Oak Street");

    const quietCityLeadId = insertLead({ address: "3 Solo Bend", city: "Thomasville", leadTag: "fresh_fiber_confirmed" });
    const lowMomentum = engine.buildScriptContext({
      tenantId, repName: "Riley Rep", companyName: "Home Front Solutions",
      lead: { id: quietCityLeadId, address: "3 Solo Bend", city: "Thomasville", state: "NC", zip: "27360", leadTag: "fresh_fiber_confirmed" },
    });
    expect(lowMomentum.freshCityCount21d).toBe(1);
    const quietHook = engine.buildTemplateSections(lowMomentum).neighborhoodHook;
    expect(quietHook).not.toBe(busyHook);
    expect(quietHook).not.toContain("homes in Thomasville have been confirmed");
    expect(quietHook).toContain("Solo Bend");
  });

  it("cache is per calling user: two users never share a cached opener (FIX-1)", async () => {
    engine.__clearScriptCacheForTests();
    const lead = { id: mainLeadId, address: "100 Maple Grove Ln", city: "Lexington", state: "NC", zip: "27292",
      leadTag: "fresh_fiber_confirmed" };
    const asRep = await engine.generateScriptForLead({ tenantId, userId: repUserId, lead,
      repName: "Riley Rep", companyName: "Home Front Solutions" });
    const asManager = await engine.generateScriptForLead({ tenantId, userId: managerUserId, lead,
      repName: "Morgan Manager", companyName: "Home Front Solutions" });
    const asRepAgain = await engine.generateScriptForLead({ tenantId, userId: repUserId, lead,
      repName: "Riley Rep", companyName: "Home Front Solutions" });
    expect(asRep.cached).toBe(false);
    expect(asManager.cached).toBe(false); // no cross-user cache hit
    expect(asRep.sections.opener).toContain("this is Riley with Home Front Solutions");
    expect(asManager.sections.opener).toContain("this is Morgan with Home Front Solutions");
    expect(asRepAgain.cached).toBe(true); // same user still hits the cache
    expect(asRepAgain.sections.opener).toContain("this is Riley with Home Front Solutions");
  });

  it("momentum window keys on fresh_confirmed_at over created_at (FIX-3)", () => {
    // Row created 30 days ago but CONFIRMED fresh 3 days ago: the old
    // created_at-keyed window would exclude it; the spoken claim must match.
    const old3RowRecentConfirmId = insertLead({ address: "55 Ledger Ct", city: "Midway",
      leadTag: "fresh_fiber_confirmed",
      createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    rawDb.prepare(`UPDATE leads SET fresh_confirmed_at=? WHERE id=?`)
      .run(new Date(Date.now() - 3 * 86_400_000).toISOString(), old3RowRecentConfirmId);
    const context = engine.buildScriptContext({
      tenantId, repName: "Riley Rep", companyName: "Home Front Solutions",
      lead: { id: old3RowRecentConfirmId, address: "55 Ledger Ct", city: "Midway", state: "NC", zip: "27292",
        leadTag: "fresh_fiber_confirmed", freshConfirmedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
    });
    expect(context.freshCityCount21d).toBe(1);
    // And the hook no longer claims proximity for the most-recent other fresh lead.
    const hook = engine.buildTemplateSections(engine.buildScriptContext({
      tenantId, repName: "Riley Rep", companyName: "Home Front Solutions",
      lead: { id: mainLeadId, address: "100 Maple Grove Ln", city: "Lexington", state: "NC", zip: "27292", leadTag: "fresh_fiber_confirmed" },
    })).neighborhoodHook;
    expect(hook).toContain("including homes on Oak Street");
    expect(hook).not.toContain("over by");
  });

  it("every section is present and compliant, with the footer verbatim", async () => {
    engine.__clearScriptCacheForTests();
    const result = await engine.generateScriptForLead({
      tenantId, userId: repUserId, repName: "Riley Rep", companyName: "Home Front Solutions",
      lead: { id: mainLeadId, address: "100 Maple Grove Ln", city: "Lexington", state: "NC", zip: "27292", leadTag: "fresh_fiber_confirmed" },
    });
    for (const value of [
      result.sections.opener, result.sections.neighborhoodHook, result.sections.valueProposition,
      result.sections.close, result.sections.objectionHandlers.price,
      result.sections.objectionHandlers.currentProvider, result.sections.objectionHandlers.renter,
      result.sections.objectionHandlers.worksFine,
    ]) {
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThan(20);
      expectCompliantText(value as string);
    }
    expect(result.sections.complianceFooter).toBe(engine.COMPLIANCE_FOOTER);
    expect(result.script.endsWith(engine.COMPLIANCE_FOOTER)).toBe(true);
    // New-voice opener: real first name, company, authorized-partner wording,
    // the words "sales call", and the purpose — never an employee claim.
    expect(result.sections.opener).toContain("this is Riley with Home Front Solutions");
    expect(result.sections.opener).toContain("Kinetic's authorized fiber partner");
    expect(result.script).toContain("Home Front Solutions");
    expect(result.script).toContain("sales call");
    expect(result.script).not.toMatch(/\bkinetic employee\b/i);
    expectCompliantText(result.script);
  });
});

describe("LLM enhancement - never fails the endpoint", () => {
  it("falls back to rules when no LLM is configured", async () => {
    engine.__clearScriptCacheForTests();
    const result = await engine.generateScriptForLead({
      tenantId, userId: repUserId, repName: "Riley Rep", companyName: "Home Front Solutions",
      lead: { id: mainLeadId, address: "100 Maple Grove Ln", city: "Lexington", state: "NC", zip: "27292", leadTag: "fresh_fiber_confirmed" },
    });
    expect(result.model).toBe("rules");
  });

  it("falls back to rules when the model errors, times out, or returns garbage", async () => {
    process.env.LLM_ENDPOINT = "http://127.0.0.1:1/unreachable";
    try {
      for (const transport of [
        async () => { throw new Error("model down"); },
        async () => "not json at all",
        async () => JSON.stringify({ opener: "too short" }),
        async () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late")), 50)),
      ]) {
        engine.__setScriptEngineLlmTransportForTests(transport as any);
        engine.__clearScriptCacheForTests();
        const result = await engine.generateScriptForLead({
          tenantId, userId: repUserId, repName: "Riley Rep", companyName: "Home Front Solutions",
          lead: { id: mainLeadId, address: "100 Maple Grove Ln", city: "Lexington", state: "NC", zip: "27292", leadTag: "fresh_fiber_confirmed" },
        });
        expect(result.model).toBe("rules");
        expect(result.script).toContain("Kinetic just dropped brand-new fiber in your neighborhood");
        expect(result.script).toContain("Your address on Maple Grove Ln was just confirmed");
      }
    } finally {
      engine.__setScriptEngineLlmTransportForTests(null);
      delete process.env.LLM_ENDPOINT;
    }
  });

  it("rejects model output containing prohibited content and falls back", async () => {
    process.env.LLM_ENDPOINT = "http://llm.test/chat";
    engine.__setScriptEngineLlmTransportForTests(async () => JSON.stringify({
      opener: "Hi, this is Riley Rep with an amazing deal you can get for free if you act now!",
      neighborhoodHook: "Kinetic Fiber just came to Maple Grove Ln, and Spectrum customers are switching in droves.",
      valueProposition: "Fiber is great for working from home, streaming, and gaming across the whole household.",
      objectionHandlers: {
        price: "Pricing depends on the tier you pick and I can check exact numbers for your address right now.",
        currentProvider: "Many households keep their provider until they see how consistent fiber is at busy times.",
        renter: "Renters can usually get fiber at serviceable addresses, set up in your own name.",
        worksFine: "Fiber keeps everything running smoothly even when the whole household is online at once.",
      },
      close: "Can I run a quick availability check for your address right now? It takes about a minute.",
    }));
    try {
      engine.__clearScriptCacheForTests();
      const result = await engine.generateScriptForLead({
        tenantId, userId: repUserId, repName: "Riley Rep", companyName: "Home Front Solutions",
        lead: { id: mainLeadId, address: "100 Maple Grove Ln", city: "Lexington", state: "NC", zip: "27292", leadTag: "fresh_fiber_confirmed" },
      });
      expect(result.model).toBe("rules");
      expectCompliantText(result.script);
    } finally {
      engine.__setScriptEngineLlmTransportForTests(null);
      delete process.env.LLM_ENDPOINT;
    }
  });

  it("screens bare Kinetic/Windstream employment claims but allows authorized-partner wording", () => {
    // Bare affiliation claims (no partner/dealer qualifier) are prohibited.
    for (const bad of [
      "Hi, I'm a Kinetic employee calling about fiber in your area today.",
      "I work for Kinetic and we are upgrading service across the neighborhood.",
      "Hi, this is Riley from Kinetic with a quick question about your internet.",
      "I'm a Windstream employee following up on the new fiber build nearby.",
    ]) {
      expect(engine.containsProhibitedContent(bad)).toBe(true);
    }
    // The legitimate qualified phrases must PASS the screen.
    for (const good of [
      "Hi, this is Riley with Homefront Solutions - Kinetic's authorized fiber partner.",
      "We're an authorized Kinetic dealer running the local fiber rollout right now.",
      "I'm calling on behalf of Homefront Solutions, an authorized seller of Kinetic Fiber internet from Windstream.",
      "Homefront Solutions is an authorized partner for Kinetic fiber in this area.",
    ]) {
      expect(engine.containsProhibitedContent(good)).toBe(false);
    }
  });

  it("rejects LLM output that claims Kinetic employment and falls back to rules", async () => {
    process.env.LLM_ENDPOINT = "http://llm.test/chat";
    engine.__setScriptEngineLlmTransportForTests(async () => JSON.stringify({
      // Disclosure + rep name survive, but the opener claims employment — the
      // prohibited-content screen must catch it before validation passes.
      opener: "Hi, this is Riley Rep - I'm a Kinetic employee, and this is a sales call about new fiber service at 100 Maple Grove Ln in Lexington.",
      neighborhoodHook: "Kinetic just dropped brand-new fiber in your neighborhood, with several homes connected in the last three weeks.",
      valueProposition: "Fiber gives you matching upload and download speeds that hold up at busy hours - smooth video calls, streaming without buffering, and low-latency gaming.",
      objectionHandlers: {
        price: "Fair question - pricing depends on the tier, and many households pay about the same as they do now. Can I check exact plans?",
        currentProvider: "Totally understandable. The fiber difference is consistency at busy times. Can I check what your address qualifies for?",
        renter: "Renters can usually get fiber at serviceable addresses, and the account goes in your name. Can I check while I have you?",
        worksFine: "That's great to hear. Fiber adds headroom so everything keeps working when everyone is online. Open to a quick check?",
      },
      close: "All I'd suggest is a one-minute availability check for 100 Maple Grove Ln - no obligation. Can I run that for you?",
    }));
    try {
      engine.__clearScriptCacheForTests();
      const result = await engine.generateScriptForLead({
        tenantId, userId: repUserId, repName: "Riley Rep", companyName: "Home Front Solutions",
        lead: { id: mainLeadId, address: "100 Maple Grove Ln", city: "Lexington", state: "NC", zip: "27292", leadTag: "fresh_fiber_confirmed" },
      });
      expect(result.model).toBe("rules");
      expect(result.script).not.toMatch(/\bkinetic employee\b/i);
      expect(result.sections.opener).toContain("Kinetic's authorized fiber partner");
      expectCompliantText(result.script);
    } finally {
      engine.__setScriptEngineLlmTransportForTests(null);
      delete process.env.LLM_ENDPOINT;
    }
  });

  it("discards LLM output that drops the mandatory disclosure or the rep name (FIX-2)", async () => {
    process.env.LLM_ENDPOINT = "http://llm.test/chat";
    const compliant = {
      neighborhoodHook: "Kinetic Fiber has just arrived on Maple Grove Ln in Lexington, with several homes confirmed for brand-new fiber in the last three weeks.",
      valueProposition: "Fiber gives you matching upload and download speeds that hold up at busy hours - smooth video calls, streaming without buffering, and low-latency gaming.",
      objectionHandlers: {
        price: "Fair question - pricing depends on the tier, and many households pay about the same as they do now. Can I check exact plans?",
        currentProvider: "Totally understandable. The fiber difference is consistency at busy times. Can I check what your address qualifies for?",
        renter: "Renters can usually get fiber at serviceable addresses, and the account goes in your name. Can I check while I have you?",
        worksFine: "That's great to hear. Fiber adds headroom so everything keeps working when everyone is online. Open to a quick check?",
      },
      close: "All I'd suggest is a one-minute availability check for 100 Maple Grove Ln - no obligation. Can I run that for you?",
    };
    const badOpeners = [
      // No "sales call" disclosure — mandatory opening language dropped.
      "Hi there, this is Riley Rep calling on behalf of Home Front Solutions about fiber service at 100 Maple Grove Ln in Lexington. Do you have about a minute?",
      // Disclosure present but the rep's own name is gone.
      "Hi there, I'm calling on behalf of Home Front Solutions - this is a sales call about fiber service at 100 Maple Grove Ln in Lexington. Do you have about a minute?",
    ];
    try {
      for (const opener of badOpeners) {
        engine.__setScriptEngineLlmTransportForTests(async () => JSON.stringify({ opener, ...compliant }));
        engine.__clearScriptCacheForTests();
        const result = await engine.generateScriptForLead({
          tenantId, userId: repUserId, repName: "Riley Rep", companyName: "Home Front Solutions",
          lead: { id: mainLeadId, address: "100 Maple Grove Ln", city: "Lexington", state: "NC", zip: "27292", leadTag: "fresh_fiber_confirmed" },
        });
        expect(result.model).toBe("rules");
        expect(result.sections.opener).toContain("sales call");
        expect(result.sections.opener).toContain("this is Riley with Home Front Solutions");
      }
    } finally {
      engine.__setScriptEngineLlmTransportForTests(null);
      delete process.env.LLM_ENDPOINT;
    }
  });

  it("uses compliant model rephrasing when the LLM succeeds (footer still verbatim)", async () => {
    process.env.LLM_ENDPOINT = "http://llm.test/chat";
    engine.__setScriptEngineLlmTransportForTests(async () => JSON.stringify({
      opener: "Hi there, this is Riley Rep calling on behalf of Home Front Solutions, an authorized seller of Kinetic Fiber from Windstream - this is a sales call about fiber service at 100 Maple Grove Ln in Lexington. Do you have about a minute?",
      neighborhoodHook: "Kinetic Fiber has just arrived on Maple Grove Ln in Lexington, with 4 homes confirmed for brand-new fiber in the last three weeks, including over by Oak Street.",
      valueProposition: "Fiber gives you matching upload and download speeds that hold up at busy hours - smooth video calls for working from home, streaming without buffering, and low-latency gaming.",
      objectionHandlers: {
        price: "Fair question - pricing depends on the tier, and many households pay about the same as they do now. Can I check the exact plans for your address?",
        currentProvider: "Totally understandable. The fiber difference is consistency at busy times and uploads that match downloads. Can I check what your address qualifies for?",
        renter: "Renters can usually get fiber at serviceable addresses, and the account goes in your name. Can I check your address while I have you?",
        worksFine: "That's great to hear. Fiber adds headroom so everything keeps working when the whole household is online. Open to a quick availability check?",
      },
      close: "All I'd suggest is a one-minute availability check for 100 Maple Grove Ln - no obligation. Can I run that for you?",
    }));
    try {
      engine.__clearScriptCacheForTests();
      const result = await engine.generateScriptForLead({
        tenantId, userId: repUserId, repName: "Riley Rep", companyName: "Home Front Solutions",
        lead: { id: mainLeadId, address: "100 Maple Grove Ln", city: "Lexington", state: "NC", zip: "27292", leadTag: "fresh_fiber_confirmed" },
      });
      expect(result.model).toBe("llm");
      expect(result.sections.opener).toContain("Riley Rep calling on behalf");
      expect(result.sections.complianceFooter).toBe(engine.COMPLIANCE_FOOTER);
      expect(result.script.endsWith(engine.COMPLIANCE_FOOTER)).toBe(true);
      expectCompliantText(result.script);
    } finally {
      engine.__setScriptEngineLlmTransportForTests(null);
      delete process.env.LLM_ENDPOINT;
    }
  });
});

describe("HTTP endpoints - gating, cache, footer", () => {
  it("GET /leads/:leadId/script returns a personalized script with metadata", async () => {
    engine.__clearScriptCacheForTests();
    const response = await request(`/api/v1/calling/leads/${mainLeadId}/script`, REP());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.leadId).toBe(mainLeadId);
    expect(body.version).toBe(engine.SCRIPT_ENGINE_VERSION);
    expect(body.model).toBe("rules");
    expect(typeof body.generatedAt).toBe("string");
    expect(body.cached).toBe(false);
    expect(body.context.fiberCategory).toBe("fresh");
    expect(body.context.freshCityCount21d).toBe(4);
    expect(body.script).toContain("Maple Grove Ln");
    expect(body.script.endsWith(engine.COMPLIANCE_FOOTER)).toBe(true);
    expect(body.fullPhoneNumberExposed).toBe(false);
  });

  it("caches per lead+version: second request within TTL is a hit and does not regenerate", async () => {
    engine.__clearScriptCacheForTests();
    let llmCalls = 0;
    process.env.LLM_ENDPOINT = "http://llm.test/chat";
    engine.__setScriptEngineLlmTransportForTests(async () => { llmCalls += 1; throw new Error("down"); });
    try {
      const first = await (await request(`/api/v1/calling/leads/${mainLeadId}/script`, REP())).json();
      const second = await (await request(`/api/v1/calling/leads/${mainLeadId}/script`, REP())).json();
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.generatedAt).toBe(first.generatedAt);
      expect(second.script).toBe(first.script);
      expect(llmCalls).toBe(1); // cache hit skips regeneration entirely
    } finally {
      engine.__setScriptEngineLlmTransportForTests(null);
      delete process.env.LLM_ENDPOINT;
    }
  });

  it("DNC-suppressed lead gets the same gate as the existing lead read", async () => {
    const scriptResponse = await request(`/api/v1/calling/leads/${suppressedLeadId}/script`, REP());
    const leadResponse = await request(`/api/v1/calling/leads/${suppressedLeadId}`, REP());
    expect(scriptResponse.status).toBe(leadResponse.status);
    if (scriptResponse.status === 200) {
      const body = await scriptResponse.json();
      expect(body.script).toContain("do not read this script");
      expect(body.script).toContain("DO_NOT_CALL");
    }
  });

  it("cross-tenant and out-of-scope leads are invisible (same as other lead reads)", async () => {
    const crossTenant = await request(`/api/v1/calling/leads/${mainLeadId}/script`, TENANT_B_REP());
    expect(crossTenant.status).toBe(404);
    const crossTenantLead = await request(`/api/v1/calling/leads/${otherTenantLeadId}/script`, REP());
    expect(crossTenantLead.status).toBe(404);
    // Assigned to repUserId: another non-manager rep gets the scopedCandidate 404.
    const outOfScope = await request(`/api/v1/calling/leads/${mainLeadId}/script`, OTHER_REP());
    expect(outOfScope.status).toBe(404);
    // Managers (calling.compliance.read) can inspect.
    const managerView = await request(`/api/v1/calling/leads/${mainLeadId}/script`, MANAGER());
    expect(managerView.status).toBe(200);
  });

  it("capability gate: template preview requires calling.compliance.read", async () => {
    const asRep = await request("/api/v1/calling/scripts/templates", REP());
    expect(asRep.status).toBe(403);
    // calling_manager is oversight; the admin preview sits with compliance_admin
    // (calling.compliance.read), like the other script-administration reads.
    const asCompliance = await request("/api/v1/calling/scripts/templates", COMPLIANCE());
    expect(asCompliance.status).toBe(200);
    const body = await asCompliance.json();
    expect(body.version).toBe(engine.SCRIPT_ENGINE_VERSION);
    expect(body.complianceFooter).toBe(engine.COMPLIANCE_FOOTER);
    for (const key of ["fresh", "coming_soon", "tenured", "unknown"]) {
      expect(typeof body.hookVariants[key]).toBe("string");
      expectCompliantText(body.hookVariants[key]);
    }
    for (const value of [
      body.sections.opener, body.sections.valueProposition, body.sections.close,
      body.sections.objectionHandlers.price, body.sections.objectionHandlers.currentProvider,
      body.sections.objectionHandlers.renter, body.sections.objectionHandlers.worksFine,
    ]) {
      expect(typeof value).toBe("string");
      expectCompliantText(value);
    }
    expect(body.llmEnhancement.timeoutMs).toBe(2000);
  });

  it("audits calling.script.generated with leadId, model, and tenant", async () => {
    engine.__clearScriptCacheForTests();
    const response = await request(`/api/v1/calling/leads/${mainLeadId}/script`, REP());
    expect(response.status).toBe(200);
    const row = rawDb.prepare(`SELECT event_type AS eventType,metadata_json AS metadataJson
      FROM calling_audit_events WHERE tenant_id=? AND event_type='calling.script.generated'
      ORDER BY created_at DESC,id DESC LIMIT 1`).get(tenantId) as any;
    expect(row).toBeTruthy();
    const metadata = JSON.parse(row.metadataJson);
    expect(metadata.leadId).toBe(mainLeadId);
    expect(metadata.tenantId).toBe(tenantId);
    expect(["rules", "llm"]).toContain(metadata.model);
  });
});
