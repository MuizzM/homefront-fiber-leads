// Skip-traced doors reaching the Cold Calling queue.
//
// The point of these tests is not that a row appears in a list — it is that the
// Tracerfy scrub reaches the AUTHORIZATION GATE. A traced number that the
// federal registry forbids must come back BLOCKED_NATIONAL_DNC from the same
// engine that gates fiber leads, not merely render greyed out. So every case
// below asserts on the compliance decision, not on the queue row.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "hf-calling-traced-"));
const NOW = new Date("2026-07-14T16:00:00.000Z"); // noon in North Carolina
const DAY_MS = 86_400_000;

let rawDb: import("better-sqlite3").Database;
let service: typeof import("../../server/calling/service");
let store: typeof import("../../server/calling/store");
let traced: typeof import("../../server/calling/tracedPhones");
let tenantId = 0;
let actorUserId = 0;

/** A door that was skip-traced but NEVER scanned — no fresh fiber, no scan
 *  target. Under the old rule this lead could never be called. */
function tracedLead(address: string, phone: string, options: {
  flags?: Record<string, boolean>;
  scrubbedAtMs?: number | null;
  lineType?: string;
  confidence?: number;
} = {}): number {
  const leadId = Number(rawDb.prepare(`INSERT INTO leads
    (address,city,state,zip,fiber_status,lead_status,tenant_id,created_at,updated_at)
    VALUES (?,'Lexington','NC','27292','available','prospect',?,?,?)`)
    .run(address, tenantId, NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  rawDb.prepare(`INSERT INTO lead_traced_phones
    (tenant_id,lead_id,number,line_type,confidence,dnc_flags,scrubbed_at_ms,dnc_source,updated_at)
    VALUES (?,?,?,?,?,?,?,'tracerfy',?)`).run(
      tenantId, leadId, phone, options.lineType ?? "wireless", options.confidence ?? 0.95,
      options.flags ? JSON.stringify(options.flags) : null,
      options.scrubbedAtMs === undefined ? NOW.getTime() - DAY_MS : options.scrubbedAtMs,
      NOW.toISOString());
  return leadId;
}

let correlation = 0;

function evaluate(leadId: number): string {
  correlation += 1;
  return service.evaluateLeadCompliance({
    tenantId, leadId, actorUserId, actorRole: "calling_rep",
    canManage: false, manualActionConfirmed: true,
    correlationId: `corr-${leadId}-${correlation}`,
  }).evaluation.decision;
}

/**
 * Evaluate the way PRODUCTION does.
 *
 * tests/setup.ts pins CALLING_SIMPLE_MODE=off so the suite exercises the full
 * 30-gate stack, but every deployment reads `!== "off"` and therefore runs
 * simple mode. Simple mode is DNC-only gating, which is precisely the surface
 * a traced number lives on — so these assertions have to run against it, not
 * against a configuration nothing ships with. The full-mode difference is
 * pinned separately at the bottom of this file rather than left implied.
 */
function decisionFor(leadId: number): string {
  const previous = process.env.CALLING_SIMPLE_MODE;
  delete process.env.CALLING_SIMPLE_MODE;
  try {
    return evaluate(leadId);
  } finally {
    if (previous === undefined) delete process.env.CALLING_SIMPLE_MODE;
    else process.env.CALLING_SIMPLE_MODE = previous;
  }
}

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.DATA_DIR = dataDir;
  process.env.CALLING_MODULE_ENABLED = "true";
  process.env.CONTACT_ENRICHMENT_ENABLED = "true";
  process.env.NATIONAL_DNC_ENABLED = "true";
  process.env.STATE_RULES_ENABLED = "true";
  process.env.MANUAL_CLICK_TO_CALL_ENABLED = "true";
  process.env.CALLING_EMERGENCY_DISABLED = "false";
  process.env.CALLING_PILOT_ORG_IDS = "1";
  process.env.CALLING_DATA_ENCRYPTION_KEY = "11".repeat(32);
  process.env.PHONE_HASH_KEY = "22".repeat(32);
  process.env.CALL_AUTHORIZATION_SIGNING_KEY = "33".repeat(32);

  const storageModule = await import("../../server/storage");
  ({ rawDb } = await import("../../server/db"));
  storageModule.runMigrations();
  tenantId = storageModule.getDefaultTenantId()!;
  (await import("../../server/calling/migrations")).runCallingMigrations();

  actorUserId = Number(rawDb.prepare(`INSERT INTO users
    (name,email,role,active,tenant_id,created_at)
    VALUES ('Calling Rep','traced-rep@example.test','calling_rep',1,?,?)`)
    .run(tenantId, NOW.toISOString()).lastInsertRowid);

  store = await import("../../server/calling/store");
  service = await import("../../server/calling/service");
  traced = await import("../../server/calling/tracedPhones");

  store.updateCallingProfile(tenantId, actorUserId, {
    callingEnabled: true, emergencyDisabled: false, counselApproved: true,
    sellerAuthorized: true, sellerName: "Home Front Solutions",
    sellerAuthorizationRef: "seller-auth://traced", stateRulesApproved: true,
    defaultTimeZone: "America/New_York", allowedStartLocal: "08:00", allowedEndLocal: "21:00",
    minimumIdentityConfidence: 0.85, maxAttempts7Days: 2, maxAttempts30Days: 3,
    dncMaxAgeDays: 31, callerIdAuthorized: true, callerIdReference: "caller-id://traced",
  });
  rawDb.prepare(`INSERT INTO seller_authorizations
    (id,tenant_id,seller_name,authorization_ref,effective_at,expires_at,status,evidence_sha256,created_by,created_at)
    VALUES ('seller-traced',?,'Home Front Solutions','seller-auth://traced','2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z','active',?,?,?)`)
    .run(tenantId, "d".repeat(64), actorUserId, NOW.toISOString());
  rawDb.prepare(`INSERT INTO state_registrations
    (id,tenant_id,state,legal_entity,registration_type,registration_number,evidence_ref,counsel_approved,
     effective_at,expires_at,last_reviewed_at,status,created_at,updated_at)
    VALUES ('registration-traced',?,'NC','Home Front Solutions','registration','NC-TRACED','registration://traced',1,
      '2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z',?,'active',?,?)`)
    .run(tenantId, NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
  rawDb.prepare(`INSERT INTO approved_calling_scripts
    (id,tenant_id,version,title,body,disclosure_sha256,seller_name,company_name,purpose,active,counsel_approved,
     counsel_approval_reference,approved_by,approved_at)
    VALUES ('script-traced',?,'script-v1','Traced','Hello, this is the approved manual script',?,
      'Home Front Solutions','Home Front Solutions','fiber availability',1,1,'counsel://script-traced',?,?)`)
    .run(tenantId, "b".repeat(64), actorUserId, NOW.toISOString());
  rawDb.prepare(`INSERT INTO calling_rule_versions
    (id,tenant_id,version,rules_sha256,config_json,active,counsel_approval_reference,approved_by,approved_at)
    VALUES ('rules-traced',?,'rules-v1',?,'{}',1,'counsel://rules-traced',?,?)`)
    .run(tenantId, "c".repeat(64), actorUserId, NOW.toISOString());
});

afterAll(() => {
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the trace provider is ready without any setup step", () => {
  it("seeds itself approved so traced doors flow on first use", () => {
    delete process.env.TRACERFY_CONTRACT_REF;
    const provider = traced.tracerfyProvider(tenantId);
    expect(provider.usable).toBe(true);
    expect(provider.contractStatus).toBe("approved");
    expect(provider.contractReference).toBe("contract://tracerfy");
  });

  it("records a configured contract reference when one is supplied", () => {
    // Fresh tenant: the reference is written at seed time, so an org that sets
    // it gets the real value on its decisions and audit exports.
    const otherTenantId = Number(rawDb.prepare(`INSERT INTO tenants
      (slug,company_name,owner_name,owner_email,brand_name,plan,status,created_at,updated_at)
      VALUES ('traced-ref','Traced Ref','Owner','traced-ref@example.test','Ref','trial','active',?,?)`)
      .run(NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
    process.env.TRACERFY_CONTRACT_REF = "contract://tracerfy/2026-msa";
    expect(traced.tracerfyProvider(otherTenantId).contractReference).toBe("contract://tracerfy/2026-msa");
  });
});

describe("once approved, traced doors are callable on their own evidence", () => {
  beforeAll(() => {
    expect(traced.tracerfyProvider(tenantId).usable).toBe(true);
  });

  it("enqueues a never-scanned traced door and clears the whole rule stack", () => {
    const leadId = tracedLead("200 Clean St", "+13365550202");
    const result = traced.syncTracedPhoneQueue(tenantId);
    expect(result.blockedReason).toBeNull();
    expect(result.imported).toBeGreaterThan(0);

    const candidate = store.getCallingCandidate(tenantId, leadId);
    expect(candidate).not.toBeNull();
    expect(candidate!.traced).toBe(true);
    expect(candidate!.phoneId).not.toBeNull();
    // Never scanned — under the old leadStillQualified rule this was
    // unreachable, and the whole feature turns on it now passing.
    expect(candidate!.freshConfidence).toBeNull();
    expect(candidate!.sourceScanTargetId).toBeNull();

    expect(decisionFor(leadId)).toBe("ELIGIBLE_MANUAL_CALL");
  });

  it("blocks a federally listed number through the national DNC rule", () => {
    const leadId = tracedLead("300 Federal St", "+13365550303", { flags: { federalDnc: true } });
    traced.syncTracedPhoneQueue(tenantId);
    expect(decisionFor(leadId)).toBe("BLOCKED_NATIONAL_DNC");
  });

  it("blocks a state-listed number through the state DNC rule", () => {
    const leadId = tracedLead("400 State St", "+13365550404", { flags: { stateDnc: true } });
    traced.syncTracedPhoneQueue(tenantId);
    expect(decisionFor(leadId)).toBe("BLOCKED_STATE_DNC");
  });

  it("suppresses a known TCPA litigator at the internal-DNC rule", () => {
    const leadId = tracedLead("500 Litigator St", "+13365550505", { flags: { tcpaLitigator: true } });
    traced.syncTracedPhoneQueue(tenantId);
    expect(decisionFor(leadId)).toBe("BLOCKED_INTERNAL_DNC");
  });

  it("blocks a number whose scrub has aged out, without anything writing to the database", () => {
    // 40 days > SCRUB_TTL_DAYS. The row is untouched; only the clock moved.
    const leadId = tracedLead("600 Stale St", "+13365550606", { scrubbedAtMs: NOW.getTime() - 40 * DAY_MS });
    traced.syncTracedPhoneQueue(tenantId);
    expect(decisionFor(leadId)).toBe("BLOCKED_STALE_DNC_DATA");
  });

  it("blocks a number that was never scrubbed at all", () => {
    const leadId = tracedLead("700 Unscrubbed St", "+13365550707", { scrubbedAtMs: null });
    traced.syncTracedPhoneQueue(tenantId);
    expect(decisionFor(leadId)).toBe("BLOCKED_STALE_DNC_DATA");
  });

  it("is idempotent — re-syncing does not duplicate a queue entry", () => {
    const leadId = tracedLead("800 Repeat St", "+13365550808");
    traced.syncTracedPhoneQueue(tenantId);
    traced.syncTracedPhoneQueue(tenantId);
    traced.syncTracedPhoneQueue(tenantId);
    expect(rawDb.prepare("SELECT count(*) AS n FROM calling_queue_entries WHERE tenant_id=? AND lead_id=?")
      .get(tenantId, leadId)).toMatchObject({ n: 1 });
  });

  it("keeps a sold door out of the queue", () => {
    const leadId = tracedLead("900 Sold St", "+13365550909");
    rawDb.prepare("UPDATE leads SET lead_status='sold' WHERE id=?").run(leadId);
    traced.syncTracedPhoneQueue(tenantId);
    expect(rawDb.prepare("SELECT count(*) AS n FROM calling_queue_entries WHERE tenant_id=? AND lead_id=?")
      .get(tenantId, leadId)).toMatchObject({ n: 0 });
  });
});

describe("a revocation outranks the configured attestation", () => {
  it("does not re-approve a provider an operator revoked", () => {
    rawDb.prepare(`UPDATE contact_enrichment_providers SET contract_status='revoked',enabled=0
      WHERE tenant_id=? AND provider_name='Tracerfy'`).run(tenantId);

    const provider = traced.tracerfyProvider(tenantId);
    expect(provider.contractStatus).toBe("revoked");
    expect(provider.usable).toBe(false);
    expect(traced.syncTracedPhoneQueue(tenantId).blockedReason).toBe("PROVIDER_NOT_APPROVED");

    // Restore for the remaining suites.
    rawDb.prepare(`UPDATE contact_enrichment_providers SET contract_status='approved',enabled=1
      WHERE tenant_id=? AND provider_name='Tracerfy'`).run(tenantId);
  });
});

describe("under the full rule set, a trace alone is not enough to dial", () => {
  // Worth pinning rather than leaving to be rediscovered: a trace establishes
  // that a number is ASSOCIATED WITH AN ADDRESS, never who sleeps there. The
  // import refuses to claim residency it was not told, so full mode routes the
  // door to a human instead of authorizing the call. The registry blocks above
  // still short-circuit ahead of this — a DNC hit is never softened into a
  // review.
  it("sends a clean traced door to identity review instead of eligible", () => {
    const leadId = tracedLead("1200 Fullmode St", "+13365551212");
    traced.syncTracedPhoneQueue(tenantId);
    expect(evaluate(leadId)).toBe("REVIEW_IDENTITY_MATCH");
  });

  it("still hard-blocks a federally listed traced number", () => {
    const leadId = tracedLead("1300 Fullmode Federal St", "+13365551313", { flags: { federalDnc: true } });
    traced.syncTracedPhoneQueue(tenantId);
    expect(evaluate(leadId)).toBe("BLOCKED_NATIONAL_DNC");
  });
});

describe("the rep-facing badge", () => {
  it("reports the blocking registry by name rather than a code", () => {
    const leadId = tracedLead("1000 Badge St", "+13365551010", { flags: { federalDnc: true } });
    const badges = traced.tracedBadgesForLeads(tenantId, [leadId], NOW.getTime());
    expect(badges.get(leadId)).toMatchObject({
      ready: false,
      label: "On the federal Do Not Call registry",
    });
  });

  it("marks a clean, freshly scrubbed number ready", () => {
    const leadId = tracedLead("1100 Ready St", "+13365551111");
    expect(traced.tracedBadgesForLeads(tenantId, [leadId], NOW.getTime()).get(leadId))
      .toMatchObject({ ready: true, label: "OK to call" });
  });
});
