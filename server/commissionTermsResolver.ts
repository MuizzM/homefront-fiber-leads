// ── What comp terms is THIS rep on? ─────────────────────────────────────────
//
// Four places could answer that, and before this they disagreed silently:
//
//   · team_members.reserve_percent / reserve_cap_cents — the per-rep override
//     an admin sets in the comp editor. NULL means "inherit".
//   · tenants.commission_reserve_percent / _cap_cents  — the org default.
//   · onboarding_recruiting_invites.commission_structure / flat_rate_cents /
//     reserve_percent / reserve_cap_cents — what the manager chose when they
//     sent the invitation, which until now rode along and was never read again
//     at the moment it actually mattered.
//   · the house default in @shared/commissionTerms.
//
// One precedence order, stated once, so the agreement a rep signs and the
// portal that pays them are reading the same answer. Most specific wins:
// explicit override → rep row → invite → tenant → house default.

import { rawDb } from "./db";
import { storage } from "./storage";
import { getRecruitingInviteByApplication } from "./onboardingRecruitingStore";
import {
  DEFAULT_COMMISSION_TERMS, normalizeCommissionTerms, type CommissionTerms,
} from "@shared/commissionTerms";

/** Terms an admin explicitly agreed for this rep, if any have been stored. */
function storedRepTerms(repId: number): Partial<CommissionTerms> | null {
  const row = rawDb.prepare(
    `SELECT reserve_percent AS pct, reserve_cap_cents AS cap, commission_terms AS terms
       FROM team_members WHERE id = ?`,
  ).get(repId) as { pct: number | null; cap: number | null; terms: string | null } | undefined;
  if (!row) return null;
  // commission_terms carries the full agreed structure (added with this
  // feature); the two reserve columns predate it and stay authoritative for
  // their own fields so an existing override is never silently dropped.
  let parsed: Partial<CommissionTerms> = {};
  if (row.terms) { try { parsed = JSON.parse(row.terms) as Partial<CommissionTerms>; } catch { /* ignore */ } }
  if (row.pct != null) parsed.reservePercent = row.pct;
  if (row.cap != null) parsed.reserveCapCents = row.cap;
  return Object.keys(parsed).length ? parsed : null;
}

function tenantDefaults(tenantId: number): Partial<CommissionTerms> {
  const row = rawDb.prepare(
    `SELECT commission_reserve_percent AS pct, commission_reserve_cap_cents AS cap
       FROM tenants WHERE id = ?`,
  ).get(tenantId) as { pct: number | null; cap: number | null } | undefined;
  const out: Partial<CommissionTerms> = {};
  if (row?.pct != null) out.reservePercent = row.pct;
  if (row?.cap != null) out.reserveCapCents = row.cap;
  return out;
}

function inviteTerms(tenantId: number, repId: number): Partial<CommissionTerms> {
  // The invitation is keyed to the APPLICATION, and the application to the rep
  // by email — the same join the pipeline uses. TENANT-SCOPED at both hops: the
  // email match alone would let a same-address candidate in another org supply
  // the terms rendered into this contract, and now that the invite carries a
  // whole ladder that is a bigger thing to get from the wrong row.
  const rep = storage.getTeamMemberById(repId);
  if (!rep?.email || rep.tenantId !== tenantId) return {};
  const app = rawDb.prepare(
    `SELECT id FROM rep_applications
      WHERE lower(email) = lower(?) AND tenant_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(rep.email, tenantId) as { id: number } | undefined;
  if (!app) return {};
  const invite = getRecruitingInviteByApplication(app.id);
  if (!invite || invite.tenantId !== tenantId) return {};
  const out: Partial<CommissionTerms> = {};
  if (invite.commissionStructure) out.structure = invite.commissionStructure;
  if (invite.flatRateCents != null) out.flatRateCents = invite.flatRateCents;
  // THE LADDER. Without this the merge below starts from DEFAULT_COMMISSION_TERMS
  // and an invite that says TIERED resolves to the HOUSE bands — so the rep
  // signed a ladder nobody chose, and nothing errored, because
  // normalizeCommissionTerms treats an absent ladder as "use the default".
  if (invite.commissionTiers?.length) out.tiers = invite.commissionTiers;
  if (invite.reservePercent != null) out.reservePercent = invite.reservePercent;
  if (invite.reserveCapCents != null) out.reserveCapCents = invite.reserveCapCents;
  return out;
}

/**
 * The effective terms for a rep, ready to render into an agreement.
 *
 * `override` is what a manager just typed in the send-paperwork dialog — it
 * wins outright, because it is the most recent explicit decision about this
 * engagement and it is the thing they are about to put a signature under.
 */
export function resolveCommissionTerms(
  tenantId: number, repId: number, override?: Partial<CommissionTerms> | null,
): CommissionTerms {
  const merged: Partial<CommissionTerms> = {
    ...DEFAULT_COMMISSION_TERMS,
    ...tenantDefaults(tenantId),
    ...inviteTerms(tenantId, repId),
    ...(storedRepTerms(repId) ?? {}),
    ...(override ?? {}),
  };
  // Normalised on the way out so a stored value that has since become invalid
  // (a ladder with a gap, a negative cap) cannot reach a contract.
  return normalizeCommissionTerms(merged).normalized;
}

/** Persist the terms actually agreed, so the portal pays what the paper says. */
export function saveRepCommissionTerms(repId: number, terms: CommissionTerms): void {
  rawDb.prepare(
    `UPDATE team_members
        SET commission_terms = ?, reserve_percent = ?, reserve_cap_cents = ?
      WHERE id = ?`,
  ).run(JSON.stringify(terms), terms.reservePercent, terms.reserveCapCents, repId);
}
