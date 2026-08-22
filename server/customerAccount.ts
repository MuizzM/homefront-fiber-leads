// ── The account pin: this door already has service ───────────────────────────
//
// When the provider answers for a household that is already on the books it
// hands back the account itself: `address.localAccountNumber`, `accountTier`
// ("Tier 2"), `accountSubTier` and `billingSystem` ("CAMS"). Measured over the
// stored bodies, 1,084 checks carried one across 959 distinct accounts - and
// none of it was ever read, so a rep at the door could not tell an existing
// customer from a cold prospect, and the calling team had no account to quote.
//
// This records it on the address, next to the rest of the provider's answer.
//
// PRIVACY. An account number is customer data (AGENTS.md: "Treat ... customer
// addresses, phone numbers ... as sensitive data. Do not log or expose them
// unnecessarily."). So:
//   * it is never written to a log line - the structured event carries the tier
//     and a boolean, never the number;
//   * it never leaves the server whole. `accountPinFor` returns the tier plus a
//     masked tail, which is what a rep needs to confirm "yes, this is your
//     account" without the browser ever holding the full value;
//   * it is tenant-scoped like every other per-address fact.
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";
import { readAccount, type ProviderAccount } from "@shared/futureService";

let ready = false;
/** Additive, forward-only columns on scan_targets. */
export function ensureAccountSchema(): void {
  if (ready) return;
  try {
    const cols = new Set((rawDb.prepare(`PRAGMA table_info(scan_targets)`).all() as Array<{ name: string }>).map((c) => c.name));
    for (const [name, decl] of [
      ["account_number", "TEXT"],
      ["account_tier", "TEXT"],
      ["account_sub_tier", "TEXT"],
      ["billing_system", "TEXT"],
      ["account_seen_at", "TEXT"],
    ] as const) {
      if (!cols.has(name)) { try { rawDb.exec(`ALTER TABLE scan_targets ADD COLUMN ${name} ${decl}`); } catch { /* concurrent boot */ } }
    }
    ready = true;
  } catch { ready = false; }
}

/** "061769244" -> "..9244". Never the whole number. */
export function maskAccountNumber(value: string | null | undefined): string | null {
  const s = String(value ?? "").replace(/\s+/g, "");
  if (!s) return null;
  return s.length <= 4 ? `..${s}` : `..${s.slice(-4)}`;
}

export interface AccountPin {
  /** Masked tail, safe to render. */
  masked: string;
  tier: string | null;
  subTier: string | null;
  billingSystem: string | null;
  seenAt: string | null;
}

/**
 * Record the provider's account facts for a door. A door that comes back with
 * no account is left alone rather than cleared: the absence of an account on
 * one answer (an inconclusive or a different provider) is not evidence the
 * household cancelled.
 */
export function recordAccount(tenantId: number, targetId: number, raw: unknown, nowIso = new Date().toISOString()): ProviderAccount {
  const acct = readAccount(raw);
  if (!acct.accountNumber && !acct.tier) return acct;
  ensureAccountSchema();
  if (!ready) return acct;
  try {
    rawDb.prepare(
      `UPDATE scan_targets
          SET account_number = COALESCE(?, account_number),
              account_tier = COALESCE(?, account_tier),
              account_sub_tier = COALESCE(?, account_sub_tier),
              billing_system = COALESCE(?, billing_system),
              account_seen_at = ?
        WHERE id = ? AND tenant_id IS ?`,
    ).run(acct.accountNumber, acct.tier, acct.subTier, acct.billingSystem, nowIso, targetId, tenantId);
    // The number itself is never logged - only that one was seen, and its tier.
    structuredLog("customer_account.recorded", { tenantId, targetId, tier: acct.tier, hasAccount: !!acct.accountNumber });
  } catch (e: any) {
    structuredLog("customer_account.record_failed", { tenantId, targetId, error: String(e?.message ?? e).slice(0, 120) }, "warn");
  }
  return acct;
}

/** The masked pin for one address, by scan target id. Null when we have none. */
export function accountPinForTarget(tenantId: number, targetId: number): AccountPin | null {
  ensureAccountSchema();
  if (!ready) return null;
  try {
    const r = rawDb.prepare(
      `SELECT account_number AS n, account_tier AS tier, account_sub_tier AS sub,
              billing_system AS sys, account_seen_at AS seen
         FROM scan_targets WHERE id=? AND tenant_id IS ?`,
    ).get(targetId, tenantId) as any;
    if (!r || (!r.n && !r.tier)) return null;
    return { masked: maskAccountNumber(r.n) ?? "", tier: r.tier ?? null, subTier: r.sub ?? null, billingSystem: r.sys ?? null, seenAt: r.seen ?? null };
  } catch { return null; }
}

/**
 * The masked pin for a lead. A lead links to its address through
 * `source_scan_target_id` when the projector published it; the many doors that
 * never became projector leads are matched on the canonical key instead.
 */
export function accountPinForLead(tenantId: number, lead: { id: number; sourceScanTargetId?: number | null; canonicalKey?: string | null }): AccountPin | null {
  if (lead.sourceScanTargetId) {
    const direct = accountPinForTarget(tenantId, lead.sourceScanTargetId);
    if (direct) return direct;
  }
  ensureAccountSchema();
  if (!ready || !lead.canonicalKey) return null;
  try {
    const r = rawDb.prepare(
      `SELECT account_number AS n, account_tier AS tier, account_sub_tier AS sub,
              billing_system AS sys, account_seen_at AS seen
         FROM scan_targets
        WHERE tenant_id IS ? AND canonical_key = ? AND (account_number IS NOT NULL OR account_tier IS NOT NULL)
        LIMIT 1`,
    ).get(tenantId, lead.canonicalKey) as any;
    if (!r) return null;
    return { masked: maskAccountNumber(r.n) ?? "", tier: r.tier ?? null, subTier: r.sub ?? null, billingSystem: r.sys ?? null, seenAt: r.seen ?? null };
  } catch { return null; }
}
