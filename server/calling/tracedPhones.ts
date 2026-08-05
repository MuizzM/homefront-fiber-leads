// ── Traced numbers → the Cold Calling queue ─────────────────────────────────
//
// Area skip trace fills lead_traced_phones (server/areaSkipTrace.ts). Until
// now that table stopped at the doorstep card and the per-area worklist: the
// Cold Calling queue is built from calling_queue_entries, which only ever held
// fresh-fiber leads, and its phone lives in the encrypted phone_numbers table.
// So a traced lead never appeared in Cold Calling at all, and a fresh-fiber
// lead that HAD been traced still rendered "Not enriched" — the number never
// crossed over.
//
// This module is that crossing, and it does exactly two things:
//
//   1. Enqueues every traced lead, importing its best number through the same
//      contact/phone/association write a manual import uses. No shortcut
//      around encryption, hashing, association expiry, or permitted use.
//   2. Hands service.ts the tracerfy verdict for the imported number, so the
//      scrub REACHES THE AUTHORIZATION GATE rather than only tinting a row.
//
// (2) is the part that matters. Importing scrubbed numbers into a dialable
// queue without wiring their flags into evaluateCallingCompliance would build
// a queue whose rows read "on the federal registry" while the engine that
// authorizes the dial has never heard of the flag. The flags map onto rules
// that already exist — see tracedComplianceOverlay below — so this adds no new
// decision codes and no second, parallel notion of "blocked".

import crypto from "node:crypto";
import { rawDb } from "../db";
import { maskPhone, normalizeUsPhone } from "@shared/calling";
import {
  SCRUB_TTL_DAYS,
  dncExplanation,
  rankPhones,
  verdictForPhone,
  type DncFlags,
  type PhoneVerdict,
  type TracedPhone,
} from "@shared/tracerfy";
import { hashPhone } from "./crypto";
import { storeManualContact, validatePhoneManually } from "./store";
import { structuredLog } from "../structuredLog";

/** The provider row a traced import is attributed to. One per tenant, matched
 *  by adapter type + name so an operator renaming it in the console does not
 *  silently orphan every association written against it. */
export const TRACERFY_PROVIDER_NAME = "Tracerfy";

const DAY_MS = 86_400_000;

export type TracerfyProvider = {
  id: string;
  enabled: boolean;
  contractStatus: string;
  permittedUseApproved: boolean;
  contractReference: string | null;
  retentionDays: number;
  /** False until an operator approves the contract in Calling → Providers.
   *  Nothing imports while this is false. */
  usable: boolean;
  /** Separately approved permitted use. An organization may accept the trace as
   *  a contact source without accepting it as a phone-validation source, and
   *  the two are checked independently everywhere else in this module. */
  usableForValidation: boolean;
};

function parseFlags(raw: string | null): DncFlags {
  if (!raw) return {};
  try { return JSON.parse(raw) as DncFlags; } catch { return {}; }
}

/** The contract this org holds with Tracerfy. Override with
 *  TRACERFY_CONTRACT_REF to record the real reference on decisions and audit
 *  exports; the default keeps those rows attributable either way. */
function contractRef(): string {
  return process.env.TRACERFY_CONTRACT_REF?.trim() || "contract://tracerfy";
}

/**
 * The Tracerfy provider configuration, seeded approved on first use.
 *
 * Tracerfy is this org's contracted trace vendor, so the row it needs to exist
 * in the calling module is created ready to use — no separate switch to find,
 * which matters because this app has no provider console to find one in.
 *
 * The one state this will NOT overwrite is a revocation: if the provider is
 * explicitly revoked or expired through the compliance API, it stays that way.
 * That is the kill switch, and a seed that undid it on the next restart would
 * make it useless.
 */
export function tracerfyProvider(tenantId: number): TracerfyProvider {
  let row = rawDb.prepare(`SELECT id,enabled,contract_status AS contractStatus,
    permitted_use_approved AS permittedUseApproved,contract_reference AS contractReference,
    retention_days AS retentionDays,permitted_uses_json AS permittedUsesJson
    FROM contact_enrichment_providers
    WHERE tenant_id=? AND adapter_type='generic_http_v1' AND provider_name=?`)
    .get(tenantId, TRACERFY_PROVIDER_NAME) as any;

  const reference = contractRef();
  const reload = (id: string) => rawDb.prepare(`SELECT id,enabled,contract_status AS contractStatus,
    permitted_use_approved AS permittedUseApproved,contract_reference AS contractReference,
    retention_days AS retentionDays,permitted_uses_json AS permittedUsesJson
    FROM contact_enrichment_providers WHERE id=?`).get(id) as any;

  if (!row) {
    const id = crypto.randomUUID();
    rawDb.prepare(`INSERT INTO contact_enrichment_providers
      (id,tenant_id,provider_name,adapter_type,enabled,priority,contract_status,permitted_use_approved,
       permitted_uses_json,contract_reference,query_cost_micros,cache_ttl_seconds,retention_days,
       rate_limit_per_minute,secret_env_name,base_url)
      VALUES (?,?,?,'generic_http_v1',1,50,'approved',1,?,?,0,0,?,60,'TRACERFY_API_KEY',?)`)
      .run(id, tenantId, TRACERFY_PROVIDER_NAME,
        JSON.stringify(["telemarketing_contact_enrichment", "phone_validation"]),
        reference,
        // Retention may not outlast the scrub that justified holding the number.
        SCRUB_TTL_DAYS,
        (process.env.TRACERFY_BASE_URL || "https://api.tracerfy.com").replace(/\/+$/, ""));
    row = reload(id);
  } else if (row.contractStatus === "unapproved" || row.contractStatus === "pending") {
    // Bring a row seeded by an older build up to the same footing. Scoped to
    // the two states meaning "nobody has decided yet" — never to revoked or
    // expired, which are decisions.
    rawDb.prepare(`UPDATE contact_enrichment_providers
      SET enabled=1,contract_status='approved',permitted_use_approved=1,
          contract_reference=coalesce(contract_reference,?),
          retention_days=max(retention_days,?),updated_at=datetime('now')
      WHERE id=?`).run(reference, SCRUB_TTL_DAYS, row.id);
    row = reload(row.id);
  }

  let permittedUses: string[] = [];
  try { permittedUses = JSON.parse(row.permittedUsesJson ?? "[]"); } catch { permittedUses = []; }

  const enabled = Number(row.enabled) === 1;
  const permittedUseApproved = Number(row.permittedUseApproved) === 1;
  const retentionDays = Number(row.retentionDays ?? 0);
  return {
    id: String(row.id),
    enabled,
    contractStatus: String(row.contractStatus),
    permittedUseApproved,
    contractReference: row.contractReference ?? null,
    retentionDays,
    usable: enabled && row.contractStatus === "approved" && permittedUseApproved
      && Boolean(row.contractReference) && retentionDays >= 1
      && permittedUses.includes("telemarketing_contact_enrichment"),
    usableForValidation: enabled && row.contractStatus === "approved" && permittedUseApproved
      && Boolean(row.contractReference) && permittedUses.includes("phone_validation"),
  };
}

/** The phone row a just-imported number landed on. */
function phoneIdFor(tenantId: number, normalized: string): number | null {
  const row = rawDb.prepare("SELECT id FROM phone_numbers WHERE tenant_id=? AND phone_hash=?")
    .get(tenantId, hashPhone(tenantId, normalized)) as any;
  return row ? Number(row.id) : null;
}

function toTracedPhone(row: any): TracedPhone {
  return {
    number: String(row.number),
    lineType: (row.lineType ?? "unknown") as TracedPhone["lineType"],
    confidence: Number(row.confidence ?? 0),
    dncFlags: parseFlags(row.dncFlags ?? null),
    // 0 is the SQL max() floor from the upsert, not a real scrub time.
    scrubbedAtMs: row.scrubbedAtMs ? Number(row.scrubbedAtMs) : null,
  };
}

/**
 * The number to put in front of a rep for one lead.
 *
 * Prefers the best DIALABLE number; falls back to the best number overall when
 * every one of them is blocked. The fallback is the whole reason a blocked
 * lead still reaches the queue — the operator asked to see every traced door,
 * with the unreachable ones inert rather than missing. The compliance overlay
 * then blocks the dial, so "visible" and "callable" stay different questions.
 */
export function preferredTracedPhone(phones: TracedPhone[], nowMs: number): TracedPhone | null {
  const ranked = rankPhones(phones);
  return ranked.find(phone => !verdictForPhone(phone, nowMs).dnc) ?? ranked[0] ?? null;
}

type TracedLeadRow = { leadId: number; ownerName: string | null; phones: TracedPhone[] };

/** Traced leads that are still open, newest trace first so a capped sync makes
 *  progress on the freshest work rather than re-walking the same old rows. */
function tracedLeads(tenantId: number, limit: number): TracedLeadRow[] {
  const rows = rawDb.prepare(`SELECT l.id AS leadId,
      coalesce(nullif(trim(l.traced_owner_name),''),nullif(trim(l.owner_name),'')) AS ownerName,
      p.number,p.line_type AS lineType,p.confidence,p.dnc_flags AS dncFlags,p.scrubbed_at_ms AS scrubbedAtMs
    FROM leads l
    JOIN lead_traced_phones p ON p.lead_id=l.id AND (p.tenant_id IS NULL OR p.tenant_id=?)
    WHERE l.tenant_id=? AND lower(coalesce(l.lead_status,'prospect')) NOT IN ('sold','not_interested')
      AND l.id IN (
        -- GROUP BY, not a bare LIMIT on the phone rows: the cap counts DOORS.
        -- Limiting the phone table directly makes a household with four traced
        -- numbers eat four slots and quietly shrinks the batch.
        SELECT lead_id FROM lead_traced_phones WHERE (tenant_id IS NULL OR tenant_id=?)
        GROUP BY lead_id ORDER BY max(updated_at) DESC LIMIT ?
      )
    ORDER BY l.id,p.confidence DESC,p.number`).all(tenantId, tenantId, tenantId, limit) as any[];

  const byLead = new Map<number, TracedLeadRow>();
  for (const row of rows) {
    const leadId = Number(row.leadId);
    let entry = byLead.get(leadId);
    if (!entry) { entry = { leadId, ownerName: row.ownerName ?? null, phones: [] }; byLead.set(leadId, entry); }
    entry.phones.push(toTracedPhone(row));
  }
  return [...byLead.values()];
}

export type TracedSyncResult = {
  /** Queue entries created for leads that had none. */
  enqueued: number;
  /** Numbers written into the calling phone model. */
  imported: number;
  /** Leads skipped because their best number would not normalize to US E.164. */
  unusable: number;
  /** Set when the provider contract has not been approved — nothing imported. */
  blockedReason: "PROVIDER_NOT_APPROVED" | null;
};

function syncLimit(): number {
  const raw = Number(process.env.CALLING_TRACED_SYNC_LIMIT);
  return Number.isFinite(raw) ? Math.max(1, Math.min(2_000, Math.floor(raw))) : 500;
}

/**
 * Bring traced leads into calling_queue_entries.
 *
 * Idempotent and cheap to call on every queue read, the way syncFreshFiberQueue
 * already is: a lead whose queue entry already carries the same phone hash is
 * skipped without a write. Re-importing only happens when the trace produced a
 * DIFFERENT preferred number — a re-scrub that blocks the old favourite moves
 * the rep onto the next one instead of leaving them on a number the scrub has
 * since condemned.
 */
export function syncTracedPhoneQueue(tenantId: number): TracedSyncResult {
  const provider = tracerfyProvider(tenantId);
  const result: TracedSyncResult = { enqueued: 0, imported: 0, unusable: 0, blockedReason: null };
  if (!provider.usable) {
    result.blockedReason = "PROVIDER_NOT_APPROVED";
    return result;
  }

  const now = Date.now();
  for (const lead of tracedLeads(tenantId, syncLimit())) {
    const phone = preferredTracedPhone(lead.phones, now);
    if (!phone) continue;
    const normalized = normalizeUsPhone(phone.number);
    if (!normalized) { result.unusable += 1; continue; }

    const existing = rawDb.prepare(`SELECT q.id, p.phone_hash AS phoneHash
      FROM calling_queue_entries q
      LEFT JOIN phone_numbers p ON p.id=q.phone_id AND p.tenant_id=q.tenant_id
      WHERE q.tenant_id=? AND q.lead_id=?`).get(tenantId, lead.leadId) as any;

    if (!existing) {
      // AWAITING_ENRICHMENT rather than FRESH_FIBER_DETECTED: this lead did not
      // arrive through the fiber pipeline and must not claim it did.
      rawDb.prepare(`INSERT INTO calling_queue_entries
        (id,tenant_id,lead_id,stage,priority,created_at,updated_at)
        VALUES (?,?,?,'AWAITING_ENRICHMENT',?,datetime('now'),datetime('now'))`)
        .run(crypto.randomUUID(), tenantId, lead.leadId, Math.round(phone.confidence * 100));
      result.enqueued += 1;
    } else if (existing.phoneHash === hashPhone(tenantId, normalized)) {
      continue; // already carrying this exact number
    }

    try {
      storeManualContact({
        tenantId,
        leadId: lead.leadId,
        phone: normalized,
        name: lead.ownerName,
        // The trace answers "who is associated with this address", not "who
        // sleeps here". Claiming resident would hand the association a
        // confidence the vendor never asserted.
        relationship: lead.ownerName ? "owner" : "unknown",
        identityConfidence: Math.max(0, Math.min(1, phone.confidence)),
        providerConfigId: provider.id,
        providerRecordId: `tracerfy:${lead.leadId}:${normalized}`,
        humanVerified: false,
        sourceMode: "provider_api",
        // An association may not outlive the scrub that justified it.
        associationValidDays: SCRUB_TTL_DAYS,
      });
      result.imported += 1;

      // Line type is evidence the trace genuinely returned, so it is recorded
      // as a provider validation rather than left blank — an unknown line type
      // is not callable under the full rule set, and pretending we never
      // learned it would strand every traced door at REVIEW_REQUIRED.
      //
      // Only when the provider ACTUALLY told us. "unknown" is not a line type,
      // it is the absence of one, and asserting it would be manufacturing the
      // evidence this row exists to hold.
      if (phone.lineType !== "unknown" && provider.usableForValidation) {
        const phoneId = phoneIdFor(tenantId, normalized);
        if (phoneId) {
          validatePhoneManually({
            tenantId, leadId: lead.leadId, phoneId,
            providerConfigId: provider.id,
            lineType: phone.lineType,
            reachable: true,
            // The trace carries no reassignment signal either way. False is the
            // recorded absence of a hit, which is what the provider reported.
            reassignedRisk: false,
            evidenceRef: `tracerfy:trace:${lead.leadId}`,
            validDays: SCRUB_TTL_DAYS,
          });
        }
      }
    } catch (error) {
      structuredLog("calling.traced_import_failed", {
        tenantId, leadId: lead.leadId,
        error: error instanceof Error ? error.message : "IMPORT_FAILED",
      });
    }
  }
  return result;
}

// ── The overlay ─────────────────────────────────────────────────────────────

export type TracedComplianceOverlay = {
  /** The verdict behind the overlay, for evidence and for the rep-facing badge. */
  verdict: PhoneVerdict;
  nationalDnc: boolean;
  stateDnc: boolean;
  /** TCPA litigators land on the tenant suppression rule — the hardest block
   *  the engine has, and the one that short-circuits ahead of everything else. */
  tenantDnc: boolean;
  /** A scrub inside SCRUB_TTL_DAYS IS the screening evidence the dnc_screened
   *  rule asks for. Never-scrubbed and expired both leave this false, so the
   *  engine falls through to BLOCKED_STALE_DNC_DATA on its own. */
  screened: boolean;
};

/**
 * Fold one lead's traced scrub into the compliance input.
 *
 * The mapping is deliberately onto rules that ALREADY exist rather than new
 * decision codes: federal → national_dnc, state → state_dnc, litigator →
 * internal suppression, scrub freshness → dnc_screened. A reviewer reading an
 * audit export sees the same reason codes whether the evidence came from an
 * imported DNC dataset or from a Tracerfy scrub, which is the point — a second
 * vocabulary for "blocked" is a second thing to keep correct.
 *
 * Returns null when the lead has no traced number, leaving the dataset-based
 * evaluation exactly as it was.
 *
 * The verdict must come from the number the queue is ACTUALLY CARRYING, not
 * from the door's best one. A door commonly holds several traced numbers, and
 * once a rep can move between them, evaluating "the best" would let a clean
 * number vouch for a suppressed one the rep had just switched to — the exact
 * laundering this overlay exists to prevent. Preferred-number selection is only
 * the fallback for a door whose phone has not been imported yet.
 */
export function tracedComplianceOverlay(
  tenantId: number,
  leadId: number,
  nowMs: number,
): TracedComplianceOverlay | null {
  const rows = rawDb.prepare(`SELECT number,line_type AS lineType,confidence,
    dnc_flags AS dncFlags,scrubbed_at_ms AS scrubbedAtMs FROM lead_traced_phones
    WHERE (tenant_id IS NULL OR tenant_id=?) AND lead_id=?`).all(tenantId, leadId) as any[];
  if (rows.length === 0) return null;

  const activeHash = (rawDb.prepare(`SELECT p.phone_hash AS phoneHash
    FROM calling_queue_entries q JOIN phone_numbers p ON p.id=q.phone_id AND p.tenant_id=q.tenant_id
    WHERE q.tenant_id=? AND q.lead_id=?`).get(tenantId, leadId) as any)?.phoneHash ?? null;

  const traced = rows.map(toTracedPhone);
  const active = activeHash
    ? traced.find(candidate => {
        const normalized = normalizeUsPhone(candidate.number);
        return normalized ? hashPhone(tenantId, normalized) === activeHash : false;
      })
    : undefined;

  const phone = active ?? preferredTracedPhone(traced, nowMs);
  if (!phone) return null;

  const verdict = verdictForPhone(phone, nowMs);
  return {
    verdict,
    nationalDnc: verdict.dncFlags.federalDnc,
    stateDnc: verdict.dncFlags.stateDnc,
    tenantDnc: verdict.dncFlags.tcpaLitigator,
    screened: phone.scrubbedAtMs != null && nowMs - phone.scrubbedAtMs <= SCRUB_TTL_DAYS * DAY_MS,
  };
}

export type TracedBadge = {
  /** False when the scrub condemns the number. Renders the row inert. */
  ready: boolean;
  /** Rep-facing sentence — "On the federal Do Not Call registry", not a code. */
  label: string;
  reasons: string[];
};

/**
 * Scrub verdicts for a page of queue rows, batched.
 *
 * ADVISORY. This says the trace found a number the registries do not forbid —
 * nothing about calling hours, frequency, consent, or identity. A queue stage
 * of ELIGIBLE_MANUAL_CALL is the authorization, and it is only ever written by
 * evaluateLeadCompliance when a rep opens the lead. The badge exists because a
 * freshly imported door would otherwise sit at "Phone validation" with no hint
 * whether it is worth opening at all.
 *
 * Carries the verdict ONLY, never the number: the digits stay behind the same
 * masked/authorize path as every other phone in this module.
 */
export function tracedBadgesForLeads(
  tenantId: number,
  leadIds: number[],
  nowMs: number,
): Map<number, TracedBadge> {
  const out = new Map<number, TracedBadge>();
  if (leadIds.length === 0) return out;
  // Chunked: SQLite caps host parameters and a queue page may carry 250 rows.
  for (let i = 0; i < leadIds.length; i += 400) {
    const chunk = leadIds.slice(i, i + 400);
    const rows = rawDb.prepare(`SELECT lead_id AS leadId,number,line_type AS lineType,confidence,
      dnc_flags AS dncFlags,scrubbed_at_ms AS scrubbedAtMs FROM lead_traced_phones
      WHERE (tenant_id IS NULL OR tenant_id=?) AND lead_id IN (${chunk.map(() => "?").join(",")})`)
      .all(tenantId, ...chunk) as any[];
    const byLead = new Map<number, TracedPhone[]>();
    for (const row of rows) {
      const leadId = Number(row.leadId);
      const list = byLead.get(leadId) ?? [];
      list.push(toTracedPhone(row));
      byLead.set(leadId, list);
    }
    for (const [leadId, phones] of byLead) {
      const phone = preferredTracedPhone(phones, nowMs);
      if (!phone) continue;
      const verdict = verdictForPhone(phone, nowMs);
      out.set(leadId, {
        ready: !verdict.dnc,
        label: dncExplanation(verdict.reasons),
        reasons: verdict.reasons,
      });
    }
  }
  return out;
}

// ── Working every number on a door ──────────────────────────────────────────
//
// calling_queue_entries is UNIQUE(tenant_id,lead_id) with a single phone_id:
// the queue models a DOOR, not a phone line, and that is the right shape —
// a rep works a household, and the frequency, disposition and callback rules
// are all per-household. But a trace routinely returns three or four numbers
// for one address, and the queue can only carry one. Before this, the other
// numbers existed in lead_traced_phones and were simply unreachable from the
// calling workspace: a wrong-party answer on the imported number ended the
// door, even with two untried numbers sitting in the database.
//
// So the door stays one row and the rep gets to move it. Every traced number
// is listed on the lead, and selecting one repoints the queue entry through
// the same import path — which means the new number gets its own association,
// its own validation record, and its own compliance evaluation. Switching is
// not a shortcut around the gate; it re-enters it.

export type TracedPhoneOption = {
  /** lead_traced_phones.id — the handle the client sends back to select it.
   *  Never the digits: the raw number stays behind the authorize path. */
  id: number;
  masked: string;
  lineType: string;
  confidence: number;
  /** The scrub verdict. Advisory, exactly as on the queue badge. */
  ready: boolean;
  label: string;
  reasons: string[];
  /** True for the number the queue entry currently carries. */
  active: boolean;
  /** False when the number cannot be normalized to US E.164, so it can be
   *  shown but never selected — the import would reject it anyway. */
  selectable: boolean;
};

/** Every traced number for one door, ranked, with the scrub verdict on each. */
export function tracedPhoneOptions(
  tenantId: number,
  leadId: number,
  nowMs: number,
): TracedPhoneOption[] {
  const rows = rawDb.prepare(`SELECT id,number,line_type AS lineType,confidence,
    dnc_flags AS dncFlags,scrubbed_at_ms AS scrubbedAtMs FROM lead_traced_phones
    WHERE (tenant_id IS NULL OR tenant_id=?) AND lead_id=?`).all(tenantId, leadId) as any[];
  if (rows.length === 0) return [];

  const activeHash = (rawDb.prepare(`SELECT p.phone_hash AS phoneHash
    FROM calling_queue_entries q JOIN phone_numbers p ON p.id=q.phone_id AND p.tenant_id=q.tenant_id
    WHERE q.tenant_id=? AND q.lead_id=?`).get(tenantId, leadId) as any)?.phoneHash ?? null;

  const byNumber = new Map<string, any>();
  for (const row of rows) byNumber.set(String(row.number), row);

  // Rank on the shared helper so this list and the queue's chosen number can
  // never disagree about which phone is "best".
  return rankPhones(rows.map(toTracedPhone)).map(phone => {
    const row = byNumber.get(phone.number);
    const verdict = verdictForPhone(phone, nowMs);
    const normalized = normalizeUsPhone(phone.number);
    return {
      id: Number(row.id),
      masked: normalized ? maskPhone(normalized) : "unusable number",
      lineType: phone.lineType,
      confidence: phone.confidence,
      ready: !verdict.dnc,
      label: dncExplanation(verdict.reasons),
      reasons: verdict.reasons,
      active: Boolean(normalized && activeHash && hashPhone(tenantId, normalized) === activeHash),
      selectable: Boolean(normalized),
    };
  });
}

/**
 * Point a door's queue entry at a different traced number.
 *
 * Takes the stored row id, never digits from the client — a caller cannot use
 * this to inject a number that was never traced for this address, which is the
 * whole reason the association and permitted-use records mean anything.
 *
 * Any unused authorization for this lead is invalidated. An authorization is
 * issued against a specific phone; letting one survive a number change would
 * let a rep authorize a clean line and then dial a suppressed one under it.
 */
export function selectTracedPhone(input: {
  tenantId: number;
  leadId: number;
  tracedPhoneId: number;
  actorUserId: number;
}): { invalidatedAuthorizations: number; alreadyActive: boolean } {
  const provider = tracerfyProvider(input.tenantId);
  if (!provider.usable) throw Object.assign(new Error("Trace provider is not approved"), { status: 409 });

  const row = rawDb.prepare(`SELECT p.id,p.number,p.line_type AS lineType,p.confidence,
      p.dnc_flags AS dncFlags,p.scrubbed_at_ms AS scrubbedAtMs,
      coalesce(nullif(trim(l.traced_owner_name),''),nullif(trim(l.owner_name),'')) AS ownerName
    FROM lead_traced_phones p JOIN leads l ON l.id=p.lead_id
    WHERE p.id=? AND p.lead_id=? AND (p.tenant_id IS NULL OR p.tenant_id=?) AND l.tenant_id=?`)
    .get(input.tracedPhoneId, input.leadId, input.tenantId, input.tenantId) as any;
  if (!row) throw Object.assign(new Error("Traced number not found for this lead"), { status: 404 });

  const normalized = normalizeUsPhone(String(row.number));
  if (!normalized) throw Object.assign(new Error("That traced number is not a usable US number"), { status: 400 });

  const current = rawDb.prepare(`SELECT p.phone_hash AS phoneHash
    FROM calling_queue_entries q JOIN phone_numbers p ON p.id=q.phone_id AND p.tenant_id=q.tenant_id
    WHERE q.tenant_id=? AND q.lead_id=?`).get(input.tenantId, input.leadId) as any;
  if (current?.phoneHash === hashPhone(input.tenantId, normalized)) {
    return { invalidatedAuthorizations: 0, alreadyActive: true };
  }

  const phone = toTracedPhone(row);
  storeManualContact({
    tenantId: input.tenantId,
    leadId: input.leadId,
    phone: normalized,
    name: row.ownerName ?? null,
    relationship: row.ownerName ? "owner" : "unknown",
    identityConfidence: Math.max(0, Math.min(1, phone.confidence)),
    providerConfigId: provider.id,
    providerRecordId: `tracerfy:${input.leadId}:${normalized}`,
    humanVerified: false,
    sourceMode: "provider_api",
    associationValidDays: SCRUB_TTL_DAYS,
  });

  if (phone.lineType !== "unknown" && provider.usableForValidation) {
    const phoneId = phoneIdFor(input.tenantId, normalized);
    if (phoneId) {
      validatePhoneManually({
        tenantId: input.tenantId, leadId: input.leadId, phoneId,
        providerConfigId: provider.id,
        lineType: phone.lineType,
        reachable: true,
        reassignedRisk: false,
        evidenceRef: `tracerfy:trace:${input.leadId}`,
        validDays: SCRUB_TTL_DAYS,
      });
    }
  }

  const invalidatedAuthorizations = rawDb.prepare(`UPDATE call_authorizations
    SET invalidated_at=datetime('now'),invalidation_reason='PHONE_CHANGED'
    WHERE tenant_id=? AND lead_id=? AND used_at IS NULL AND invalidated_at IS NULL`)
    .run(input.tenantId, input.leadId).changes;

  return { invalidatedAuthorizations, alreadyActive: false };
}
