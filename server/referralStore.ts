// ── Referral store — the durable side of shared/referral.ts ─────────────────
//
// The rules are pure and live in shared/referral.ts. This file owns the rows,
// the tenant walls, the code allocation, and the qualification recount.
//
// ── WHAT THIS REUSES RATHER THAN REBUILDS ───────────────────────────────────
//   * `team_members.recruited_by_member_id` — the IMMUTABLE sponsor edge, set
//     once at approval and protected by a database trigger that refuses any
//     re-point. That is already the spec's "the referrer cannot be changed
//     after hire" rule, enforced one level below the application, so the
//     referral row records the program state and the roster records the truth.
//   * `commission_sales` — qualification counts QUALIFIED, non-reversed sales
//     there. There is no second definition of "an approved sale" in this file;
//     inventing one is how a referral pays for a sale the commission plane
//     already reversed.
//   * `rep_applications` — the applicant lifecycle (pending → approved →
//     user_id → activated_at) the referral funnel rides on.
//
// ── THE PROGRAM SHIPS DARK ──────────────────────────────────────────────────
// `enabled` defaults false for every org. Links can be minted and clicks
// tracked, but `rejectAttribution` refuses while the program is off and no
// reward is ever created, so deploying this costs nobody anything.

import { randomBytes, createHash } from "node:crypto";
import { rawDb } from "./db";
import { emit } from "./domainEventStore";
import { recordReferralReward } from "./earningsLedgerStore";
import {
  DEFAULT_REFERRAL_CONFIG, canReferralTransition, canChangeReferrer,
  evaluateQualification, referralCodeFrom, referralUrl, rejectAttribution,
  rewardReleasable, validateReferralConfig, isReferralCommitted, applicantStatusView,
  type ReferralProgramConfig, type ReferralStatus, type QualificationResult,
} from "@shared/referral";

const CONFIG_SETTING = "referral.program";

export function ensureReferralSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS referral_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      referrer_user_id INTEGER NOT NULL,
      referrer_rep_id INTEGER NOT NULL,          -- team_members.id (who gets paid)
      code TEXT NOT NULL,
      url TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      click_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    -- Codes are typed by strangers; they must be globally unambiguous, not just
    -- unique per org, or the same code would resolve to two different reps.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_links_code ON referral_links(code);
    -- One ACTIVE link per rep: two live codes for one person splits their own
    -- pipeline and makes "my link" an ambiguous question.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_links_one_active
      ON referral_links(tenant_id, referrer_rep_id) WHERE active = 1;

    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      referrer_user_id INTEGER NOT NULL,
      referrer_rep_id INTEGER NOT NULL,
      referred_user_id INTEGER,                  -- users.id once the account exists
      referred_rep_id INTEGER,                   -- team_members.id once hired
      referred_application_id INTEGER,           -- rep_applications.id
      referred_email TEXT,                       -- normalized; the pre-account identity
      referral_link_id INTEGER,
      status TEXT NOT NULL DEFAULT 'CLICKED',
      hired_at TEXT,
      activated_at TEXT,
      qualified_at TEXT,
      qualifying_sales_count INTEGER NOT NULL DEFAULT 0,
      reward_amount_cents INTEGER NOT NULL DEFAULT 0,
      reward_ledger_id INTEGER,                  -- spiffs.id once awarded
      approved_by INTEGER,
      approved_at TEXT,
      rejected_by INTEGER,
      rejected_at TEXT,
      rejection_reason TEXT,
      paid_at TEXT,
      clawed_back_at TEXT,
      -- Frozen at qualification so a later config change cannot re-price or
      -- re-judge a referral that already met the bar.
      config_snapshot TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer
      ON referrals(tenant_id, referrer_rep_id, status);
    CREATE INDEX IF NOT EXISTS idx_referrals_status
      ON referrals(tenant_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_referrals_referred_rep
      ON referrals(tenant_id, referred_rep_id);
    -- One live referral per referred person, per identity we might know them by.
    -- Partial so historical REJECTED/EXPIRED rows never block a genuine retry.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_one_live_email
      ON referrals(tenant_id, referred_email)
      WHERE referred_email IS NOT NULL AND status NOT IN ('REJECTED','EXPIRED') AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_one_live_user
      ON referrals(tenant_id, referred_user_id)
      WHERE referred_user_id IS NOT NULL AND status NOT IN ('REJECTED','EXPIRED') AND deleted_at IS NULL;
    -- Click de-duplication. A counter that increments on every request counts a
    -- refresh, a back-button, and a prefetch as three people, which makes the
    -- one number a rep actually watches meaningless - and makes inflating it
    -- free. The dedupe key is coarse on purpose (see clickDedupeKey): it must
    -- collapse one person revisiting, without needing an identifier we have no
    -- business assigning to an anonymous visitor.
    CREATE TABLE IF NOT EXISTS referral_click_dedupe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_click_dedupe
      ON referral_click_dedupe(code, dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_referral_click_dedupe_age
      ON referral_click_dedupe(created_at);

    -- Append-only funnel history. This is the audit trail the admin console
    -- shows and the reason a status can be explained rather than just read.
    CREATE TABLE IF NOT EXISTS referral_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      referral_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      source_id INTEGER,
      metadata TEXT,
      actor_user_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_referral_events_referral
      ON referral_events(referral_id, id);
  `);

  ensureOneReferralPerApplicationIndex();

  rawDb.exec(`
    CREATE TRIGGER IF NOT EXISTS referral_events_no_update
      BEFORE UPDATE ON referral_events
      BEGIN SELECT RAISE(ABORT, 'referral_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS referral_events_no_delete
      BEFORE DELETE ON referral_events
      BEGIN SELECT RAISE(ABORT, 'referral_events is append-only'); END;
  `);
}
/**
 * ONE ATTRIBUTION PER APPLICATION.
 *
 * The live-email and live-user indexes stop the same PERSON being referred
 * twice, but neither stops two referrals pointing at the same application row —
 * which is what a retried intake, a double-submitted form, or two concurrent
 * requests would produce. Unlike those two this is NOT filtered on status: an
 * application that was rejected once must not become attributable again,
 * because the application itself is the thing that happened once.
 *
 * ── WHY THIS IS NOT JUST ANOTHER LINE IN THE exec() ABOVE ──────────────────
 * `CREATE UNIQUE INDEX` FAILS if the data already violates it, and this whole
 * function runs at module import — i.e. at BOOT. On an existing database that
 * already contains a duplicate, putting this in the bulk exec would throw
 * before the server finished starting, turning a data problem into an outage,
 * on every restart, with no way in.
 *
 * So: detect first, and if the data is dirty, START ANYWAY and say so loudly
 * with the exact offending rows. The constraint is a guard against a future
 * duplicate; refusing to boot does not un-create the ones already there.
 *
 * Deliberately does NOT auto-delete or auto-merge. These rows decide who gets
 * paid $500, and a heuristic that silently picks a winner is worse than an
 * operator picking one — this reports, a human resolves, the next boot
 * installs the index.
 */
export function ensureOneReferralPerApplicationIndex(): { installed: boolean; conflicts: number } {
  const duplicates = rawDb.prepare(
    `SELECT tenant_id AS tenantId, referred_application_id AS applicationId,
            COUNT(*) AS n, GROUP_CONCAT(id) AS referralIds
       FROM referrals
      WHERE referred_application_id IS NOT NULL
      GROUP BY tenant_id, referred_application_id
     HAVING COUNT(*) > 1`,
  ).all() as Array<{ tenantId: number; applicationId: number; n: number; referralIds: string }>;

  if (duplicates.length > 0) {
    for (const d of duplicates) {
      console.error(
        `[referral-migration] tenant ${d.tenantId}: application ${d.applicationId} has ${d.n} referrals ` +
        `(ids ${d.referralIds}). Resolve to one before the one-per-application constraint can be installed.`,
      );
    }
    console.error(
      "[referral-migration] Booting WITHOUT idx_referrals_one_per_application. " +
      "New duplicates are not blocked until this is resolved.",
    );
    return { installed: false, conflicts: duplicates.length };
  }

  rawDb.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_one_per_application
       ON referrals(tenant_id, referred_application_id)
       WHERE referred_application_id IS NOT NULL`,
  );
  return { installed: true, conflicts: 0 };
}

ensureReferralSchema();

// ── Config ──────────────────────────────────────────────────────────────────

export function getConfig(tenantId: number): ReferralProgramConfig {
  const row = rawDb.prepare(
    `SELECT value FROM app_settings WHERE tenant_id = ? AND key = ? LIMIT 1`,
  ).get(tenantId, CONFIG_SETTING) as { value: string } | undefined;
  if (!row?.value) return { ...DEFAULT_REFERRAL_CONFIG };
  try {
    // Merged over the defaults so a config written before a field existed keeps
    // working rather than reading that field as undefined.
    return { ...DEFAULT_REFERRAL_CONFIG, ...JSON.parse(row.value) };
  } catch { return { ...DEFAULT_REFERRAL_CONFIG }; }
}

export function setConfig(tenantId: number, patch: Partial<ReferralProgramConfig>, nowIso: string): ReferralProgramConfig {
  const problems = validateReferralConfig(patch);
  if (problems.length > 0) throw new Error(`INVALID_REFERRAL_CONFIG:${problems.join("; ")}`);
  const next = { ...getConfig(tenantId), ...patch };
  rawDb.prepare(
    `INSERT INTO app_settings (tenant_id, key, value, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(tenantId, CONFIG_SETTING, JSON.stringify(next), nowIso);
  return next;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface Referral {
  id: number; tenantId: number;
  referrerUserId: number; referrerRepId: number;
  referredUserId: number | null; referredRepId: number | null;
  referredApplicationId: number | null; referredEmail: string | null;
  referralLinkId: number | null;
  status: ReferralStatus;
  hiredAt: string | null; activatedAt: string | null; qualifiedAt: string | null;
  qualifyingSalesCount: number;
  rewardAmountCents: number; rewardLedgerId: number | null;
  approvedBy: number | null; approvedAt: string | null;
  rejectedBy: number | null; rejectedAt: string | null; rejectionReason: string | null;
  paidAt: string | null; clawedBackAt: string | null;
  configSnapshot: ReferralProgramConfig | null;
  createdAt: string; updatedAt: string;
}

function mapReferral(r: any): Referral | null {
  if (!r) return null;
  let snapshot: ReferralProgramConfig | null = null;
  if (r.config_snapshot) { try { snapshot = JSON.parse(r.config_snapshot); } catch { snapshot = null; } }
  return {
    id: r.id, tenantId: r.tenant_id,
    referrerUserId: r.referrer_user_id, referrerRepId: r.referrer_rep_id,
    referredUserId: r.referred_user_id ?? null, referredRepId: r.referred_rep_id ?? null,
    referredApplicationId: r.referred_application_id ?? null,
    referredEmail: r.referred_email ?? null,
    referralLinkId: r.referral_link_id ?? null,
    status: r.status as ReferralStatus,
    hiredAt: r.hired_at ?? null, activatedAt: r.activated_at ?? null, qualifiedAt: r.qualified_at ?? null,
    qualifyingSalesCount: r.qualifying_sales_count ?? 0,
    rewardAmountCents: r.reward_amount_cents ?? 0, rewardLedgerId: r.reward_ledger_id ?? null,
    approvedBy: r.approved_by ?? null, approvedAt: r.approved_at ?? null,
    rejectedBy: r.rejected_by ?? null, rejectedAt: r.rejected_at ?? null,
    rejectionReason: r.rejection_reason ?? null,
    paidAt: r.paid_at ?? null, clawedBackAt: r.clawed_back_at ?? null,
    configSnapshot: snapshot,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const normEmail = (e: unknown): string | null => {
  const s = String(e ?? "").trim().toLowerCase();
  return s.includes("@") ? s : null;
};

// ── Links ───────────────────────────────────────────────────────────────────

/**
 * The rep's link, minted on first ask. Idempotent: asking twice returns the
 * same code, because a rep who shares a link on Monday and reopens the page on
 * Tuesday must not be handed a second one that splits their pipeline.
 *
 * Collision handling is a bounded retry rather than a loop: with 31^8 codes a
 * collision is vanishingly rare, and an unbounded retry on a genuinely broken
 * index would spin forever.
 */
export function ensureLink(p: {
  tenantId: number; referrerUserId: number; referrerRepId: number;
  baseUrl: string; nowIso: string;
}) {
  const existing = rawDb.prepare(
    `SELECT * FROM referral_links WHERE tenant_id = ? AND referrer_rep_id = ? AND active = 1`,
  ).get(p.tenantId, p.referrerRepId) as any;
  if (existing) {
    return {
      id: existing.id, code: existing.code,
      url: referralUrl(p.baseUrl, existing.code),
      active: !!existing.active, clickCount: existing.click_count,
      createdAt: existing.created_at,
    };
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = referralCodeFrom(randomBytes(16));
    const url = referralUrl(p.baseUrl, code);
    try {
      const info = rawDb.prepare(
        `INSERT INTO referral_links (tenant_id, referrer_user_id, referrer_rep_id, code, url, created_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(p.tenantId, p.referrerUserId, p.referrerRepId, code, url, p.nowIso);
      return { id: Number(info.lastInsertRowid), code, url, active: true, clickCount: 0, createdAt: p.nowIso };
    } catch (e: any) {
      if (!/UNIQUE/i.test(e?.message ?? "")) throw e;
      // Another writer won the race for THIS rep's active link — return theirs.
      const raced = rawDb.prepare(
        `SELECT * FROM referral_links WHERE tenant_id = ? AND referrer_rep_id = ? AND active = 1`,
      ).get(p.tenantId, p.referrerRepId) as any;
      if (raced) {
        return {
          id: raced.id, code: raced.code, url: referralUrl(p.baseUrl, raced.code),
          active: true, clickCount: raced.click_count, createdAt: raced.created_at,
        };
      }
      // Otherwise it was a code collision — draw again.
    }
  }
  throw new Error("REFERRAL_CODE_ALLOCATION_FAILED");
}

/** Resolve a typed code. Deliberately NOT tenant-scoped on input: the person
 *  typing it has no org yet, and the code itself carries the org. */
export function linkByCode(code: string) {
  const r = rawDb.prepare(
    `SELECT * FROM referral_links WHERE code = ? AND active = 1`,
  ).get(code) as any;
  if (!r) return null;
  return {
    id: r.id, tenantId: r.tenant_id, referrerUserId: r.referrer_user_id,
    referrerRepId: r.referrer_rep_id, code: r.code, createdAt: r.created_at,
  };
}

/**
 * A coarse, privacy-preserving identity for one visitor-day.
 *
 * Hashed rather than stored raw: this exists to collapse a refresh, not to
 * build a profile of anonymous visitors, and an IP + user-agent pair kept in
 * plaintext against a referral code is exactly such a profile. The day bucket
 * means the window resets naturally without a sweeper needing to run on time.
 *
 * Deliberately imperfect. Two people behind one office NAT on the same browser
 * version collapse to one click, and one person on phone-then-laptop counts
 * twice. Both are acceptable: the number is a rep's engagement signal, not a
 * billing input, and the alternative is a durable identifier we have no reason
 * to assign to someone who has not applied for anything.
 */
export function clickDedupeKey(p: { ip?: string | null; userAgent?: string | null; dayIso: string }): string {
  return createHash("sha256")
    .update(`${p.ip ?? ""}|${p.userAgent ?? ""}|${p.dayIso}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Record a visit. Returns true only when this was a NEW click.
 *
 * A click is a counter bump, not a referral row — an anonymous visit has no
 * identity to attribute, and creating a referral per click would be both a
 * fraud vector and a garbage pipeline.
 *
 * With a dedupe key the increment happens at most once per visitor-day, so a
 * refresh, a back-button, or a background prefetch cannot inflate it. Without
 * one (a caller that has no request context) it falls back to the old
 * unconditional bump rather than silently dropping the click.
 */
export function trackClick(code: string, dedupeKey?: string | null, nowIso?: string): boolean {
  if (dedupeKey) {
    const fresh = rawDb.prepare(
      `INSERT INTO referral_click_dedupe (code, dedupe_key, created_at) VALUES (?,?,?)
       ON CONFLICT(code, dedupe_key) DO NOTHING`,
    ).run(code, dedupeKey, nowIso ?? new Date().toISOString());
    // Already counted this visitor today — not an error, just not a new click.
    if (fresh.changes === 0) return false;
  }
  const info = rawDb.prepare(
    `UPDATE referral_links SET click_count = click_count + 1 WHERE code = ? AND active = 1`,
  ).run(code);
  return info.changes > 0;
}

/** Drop dedupe rows older than the retention window. Called opportunistically;
 *  the table is a de-duplication cache, not a record of anything. */
export function pruneClickDedupe(olderThanIso: string): number {
  return rawDb.prepare(`DELETE FROM referral_click_dedupe WHERE created_at < ?`).run(olderThanIso).changes;
}

// ── Referral lifecycle ──────────────────────────────────────────────────────

function recordEvent(p: {
  tenantId: number; referralId: number; type: string;
  sourceId?: number | null; metadata?: Record<string, unknown> | null;
  actorUserId?: number | null; nowIso: string;
}): void {
  rawDb.prepare(
    `INSERT INTO referral_events (tenant_id, referral_id, event_type, source_id, metadata, actor_user_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    p.tenantId, p.referralId, p.type, p.sourceId ?? null,
    p.metadata ? JSON.stringify(p.metadata) : null, p.actorUserId ?? null, p.nowIso,
  );
}

export function eventsFor(tenantId: number, referralId: number) {
  return rawDb.prepare(
    `SELECT id, event_type AS eventType, source_id AS sourceId, metadata,
            actor_user_id AS actorUserId, created_at AS createdAt
       FROM referral_events WHERE tenant_id = ? AND referral_id = ? ORDER BY id ASC`,
  ).all(tenantId, referralId);
}

/**
 * Attribute an application to a referrer. This is the ONE place a referral row
 * is created, and it runs every anti-fraud rule before it does.
 *
 * Returns `{ rejected }` rather than throwing for a business refusal, because
 * a declined attribution must never fail the APPLICATION — a person applying
 * for a job does not lose their application because someone's referral code was
 * stale.
 */
export function attributeApplication(p: {
  tenantId: number; linkCode: string;
  applicantEmail: string; applicationId?: number | null;
  applicantUserId?: number | null;
  nowIso: string;
}): { referral: Referral | null; rejected: string | null } {
  const config = getConfig(p.tenantId);
  const link = linkByCode(p.linkCode);
  if (!link || link.tenantId !== p.tenantId) return { referral: null, rejected: "invalid_code" };

  const email = normEmail(p.applicantEmail);
  if (!email) return { referral: null, rejected: "invalid_email" };

  const referrer = rawDb.prepare(
    `SELECT tm.id, tm.active, u.email AS email, u.id AS userId
       FROM team_members tm LEFT JOIN users u ON u.team_member_id = tm.id
      WHERE tm.id = ? AND tm.tenant_id = ?`,
  ).get(link.referrerRepId, p.tenantId) as any;

  const existingUser = rawDb.prepare(`SELECT id FROM users WHERE lower(email) = ?`).get(email) as any;
  const existingReferral = rawDb.prepare(
    `SELECT id FROM referrals WHERE tenant_id = ? AND referred_email = ?
       AND status NOT IN ('REJECTED','EXPIRED') AND deleted_at IS NULL`,
  ).get(p.tenantId, email) as any;

  const rejection = rejectAttribution({
    referrerRepId: link.referrerRepId,
    referrerActive: !!referrer?.active,
    applicantEmail: email,
    referrerEmail: normEmail(referrer?.email) ?? "",
    // An applicant who already has an account is not a new applicant. Checked
    // against users, not against team_members, so a dormant login still counts.
    applicantAlreadyHasAccount: !!existingUser,
    applicantAlreadyReferred: !!existingReferral,
    linkCreatedAt: link.createdAt,
  }, config, p.nowIso);
  if (rejection) return { referral: null, rejected: rejection };

  // Belt and braces on self-referral: the email check catches the obvious case,
  // this catches someone applying with a second address that nonetheless
  // resolves to the referrer's own user account.
  if (p.applicantUserId && referrer?.userId && p.applicantUserId === referrer.userId) {
    return { referral: null, rejected: "self_referral" };
  }

  const info = rawDb.prepare(
    `INSERT INTO referrals
       (tenant_id, referrer_user_id, referrer_rep_id, referred_email, referred_user_id,
        referred_application_id, referral_link_id, status, reward_amount_cents, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    p.tenantId, link.referrerUserId, link.referrerRepId, email,
    p.applicantUserId ?? null, p.applicationId ?? null, link.id,
    "APPLIED", config.rewardCents, p.nowIso, p.nowIso,
  );
  const id = Number(info.lastInsertRowid);
  recordEvent({ tenantId: p.tenantId, referralId: id, type: "APPLIED", sourceId: p.applicationId ?? null, metadata: { code: p.linkCode }, nowIso: p.nowIso });

  emit({
    tenantId: p.tenantId, type: "REFERRAL_CREATED",
    subjectType: "referral", subjectId: id, subjectRepId: link.referrerRepId,
    occurredAt: p.nowIso, payload: { referrerRepId: link.referrerRepId },
  }, p.nowIso);

  return { referral: getReferral(p.tenantId, id), rejected: null };
}

export function getReferral(tenantId: number, id: number): Referral | null {
  return mapReferral(rawDb.prepare(
    `SELECT * FROM referrals WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
  ).get(tenantId, id));
}

export function listReferrals(tenantId: number, q: {
  referrerRepIds?: number[] | null; status?: ReferralStatus | null; limit?: number;
} = {}): Referral[] {
  const where = ["tenant_id = ?", "deleted_at IS NULL"];
  const params: any[] = [tenantId];
  if (q.referrerRepIds) {
    if (q.referrerRepIds.length === 0) return [];
    where.push(`referrer_rep_id IN (${q.referrerRepIds.map(() => "?").join(",")})`);
    params.push(...q.referrerRepIds);
  }
  if (q.status) { where.push("status = ?"); params.push(q.status); }
  const rows = rawDb.prepare(
    `SELECT * FROM referrals WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...params, Math.max(1, Math.min(2000, q.limit ?? 200)));
  return rows.map(mapReferral).filter((r): r is Referral => r != null);
}

/** The referral a hired rep came from, if any. */
export function referralForRep(tenantId: number, repId: number): Referral | null {
  return mapReferral(rawDb.prepare(
    `SELECT * FROM referrals WHERE tenant_id = ? AND referred_rep_id = ? AND deleted_at IS NULL`,
  ).get(tenantId, repId));
}

/**
 * The referred person was hired. Links the referral to the new team member and
 * stamps the instant the qualification window starts.
 */
export function markHired(p: {
  tenantId: number; referralId: number; referredRepId: number;
  referredUserId?: number | null; actorUserId?: number | null; nowIso: string;
}): Referral {
  const referral = getReferral(p.tenantId, p.referralId);
  if (!referral) throw new Error("REFERRAL_NOT_FOUND");
  if (!canReferralTransition(referral.status, "HIRED")) {
    throw new Error(`REFERRAL_BAD_TRANSITION:${referral.status}->HIRED`);
  }
  const tx = rawDb.transaction(() => {
    rawDb.prepare(
      `UPDATE referrals SET status = 'HIRED', referred_rep_id = ?, referred_user_id = COALESCE(?, referred_user_id),
         hired_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
    ).run(p.referredRepId, p.referredUserId ?? null, p.nowIso, p.nowIso, p.tenantId, p.referralId);
    recordEvent({ tenantId: p.tenantId, referralId: p.referralId, type: "HIRED", sourceId: p.referredRepId, actorUserId: p.actorUserId, nowIso: p.nowIso });
    emit({
      tenantId: p.tenantId, type: "REFERRAL_REP_HIRED",
      subjectType: "referral", subjectId: p.referralId, subjectRepId: referral.referrerRepId,
      actorUserId: p.actorUserId ?? null, occurredAt: p.nowIso,
      payload: { referredRepId: p.referredRepId },
    }, p.nowIso);
  });
  tx();
  return getReferral(p.tenantId, p.referralId)!;
}

/** The referred rep cleared training and may sell. */
export function markActivated(p: {
  tenantId: number; referralId: number; actorUserId?: number | null; nowIso: string;
}): Referral {
  const referral = getReferral(p.tenantId, p.referralId);
  if (!referral) throw new Error("REFERRAL_NOT_FOUND");
  if (!canReferralTransition(referral.status, "ACTIVATED")) {
    throw new Error(`REFERRAL_BAD_TRANSITION:${referral.status}->ACTIVATED`);
  }
  const tx = rawDb.transaction(() => {
    rawDb.prepare(
      `UPDATE referrals SET status = 'ACTIVATED', activated_at = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
    ).run(p.nowIso, p.nowIso, p.tenantId, p.referralId);
    recordEvent({ tenantId: p.tenantId, referralId: p.referralId, type: "ACTIVATED", actorUserId: p.actorUserId, nowIso: p.nowIso });
    emit({
      tenantId: p.tenantId, type: "REFERRAL_REP_ACTIVATED",
      subjectType: "referral", subjectId: p.referralId, subjectRepId: referral.referrerRepId,
      actorUserId: p.actorUserId ?? null, occurredAt: p.nowIso,
      payload: { referredRepId: referral.referredRepId },
    }, p.nowIso);
  });
  tx();
  return getReferral(p.tenantId, p.referralId)!;
}

// ── Qualification ───────────────────────────────────────────────────────────

/**
 * Count the referred rep's qualifying sales.
 *
 * QUALIFIED and not reversed, straight out of `commission_sales` — the same
 * ledger the commission statements read. There is deliberately no second
 * definition of "approved sale" here: a referral that paid on a sale the
 * commission plane had already reversed would be paying for nothing.
 */
export function countQualifyingSales(tenantId: number, referredRepId: number, sinceIso: string | null): number {
  const params: any[] = [tenantId, referredRepId];
  let clause = "";
  if (sinceIso) { clause = " AND sold_at >= ?"; params.push(sinceIso); }
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM commission_sales
      WHERE tenant_id = ? AND rep_id = ? AND status = 'QUALIFIED' AND reversed_at IS NULL${clause}`,
  ).get(...params) as any;
  return row?.n ?? 0;
}

/** Has the referred rep finished the org's required training? Reads the same
 *  `training_progress` count the field gate reads, so "complete" means the same
 *  thing to the referral program as it does to the door. */
function trainingComplete(tenantId: number, referredUserId: number | null): boolean {
  if (!referredUserId) return false;
  const required = rawDb.prepare(
    `SELECT value FROM app_settings WHERE tenant_id IN (?, 0) AND key = 'training.required_lessons'
      ORDER BY tenant_id DESC LIMIT 1`,
  ).get(tenantId) as any;
  const target = Number(required?.value ?? 0);
  const done = rawDb.prepare(
    `SELECT COUNT(DISTINCT lesson_id) AS n FROM training_progress WHERE tenant_id = ? AND user_id = ?`,
  ).get(tenantId ?? 0, referredUserId) as any;
  // With no threshold configured the org has not defined "complete", so any
  // completed lesson cannot prove it — fail closed rather than pay on nothing.
  if (target <= 0) return false;
  return (done?.n ?? 0) >= target;
}

/** Facts + verdict for one referral, without writing anything. This is what the
 *  rep's checklist and the admin's queue both render. */
export function qualificationFor(tenantId: number, referralId: number, nowIso: string): {
  referral: Referral; result: QualificationResult; config: ReferralProgramConfig;
  releasable: { releasable: boolean; daysRemaining: number };
} | null {
  const referral = getReferral(tenantId, referralId);
  if (!referral) return null;
  // A referral that already qualified is judged against the config FROZEN then,
  // so an admin raising the bar next week cannot un-qualify it.
  const config = referral.configSnapshot ?? getConfig(tenantId);

  const repActive = referral.referredRepId
    ? !!(rawDb.prepare(`SELECT active FROM team_members WHERE id = ? AND tenant_id = ?`)
      .get(referral.referredRepId, tenantId) as any)?.active
    : false;

  const sales = referral.referredRepId
    ? countQualifyingSales(tenantId, referral.referredRepId, referral.hiredAt)
    : 0;

  const result = evaluateQualification({
    hiredAt: referral.hiredAt,
    activatedAt: referral.activatedAt,
    approvedSalesCount: sales,
    trainingComplete: trainingComplete(tenantId, referral.referredUserId),
    repActive,
    thresholdReachedAt: referral.qualifiedAt,
  }, config, nowIso);

  return {
    referral, result, config,
    releasable: rewardReleasable(referral.qualifiedAt, config, nowIso),
  };
}

/**
 * Re-evaluate a referral and advance it if the bar is now cleared.
 *
 * Idempotent: qualifying twice is a no-op, because the transition guard refuses
 * QUALIFIED → QUALIFIED's successor twice and `qualified_at` is only stamped
 * when it was null. Safe to call from an event subscriber on every sale.
 */
export function recheckQualification(p: {
  tenantId: number; referralId: number; nowIso: string; actorUserId?: number | null;
}): { referral: Referral; result: QualificationResult } | null {
  const snapshot = qualificationFor(p.tenantId, p.referralId, p.nowIso);
  if (!snapshot) return null;
  const { referral, result, config } = snapshot;

  // Always keep the visible count fresh, even when nothing else changes — the
  // rep's "3 of 6" must move on the third sale, not only on the sixth.
  const salesReq = result.requirements.find(r => r.key === "sales");
  const count = salesReq?.current ?? 0;
  rawDb.prepare(`UPDATE referrals SET qualifying_sales_count = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
    .run(count, p.nowIso, p.tenantId, p.referralId);

  if (referral.status === "ACTIVATED" && count > 0 && !result.qualified) {
    rawDb.prepare(`UPDATE referrals SET status = 'IN_PROGRESS', updated_at = ? WHERE tenant_id = ? AND id = ?`)
      .run(p.nowIso, p.tenantId, p.referralId);
  }

  if (result.qualified && !referral.qualifiedAt && canReferralTransition(referral.status, "QUALIFIED")) {
    const tx = rawDb.transaction(() => {
      rawDb.prepare(
        `UPDATE referrals SET status = 'QUALIFIED', qualified_at = ?, config_snapshot = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND qualified_at IS NULL`,
      ).run(p.nowIso, JSON.stringify(config), p.nowIso, p.tenantId, p.referralId);
      recordEvent({
        tenantId: p.tenantId, referralId: p.referralId, type: "QUALIFIED",
        metadata: { salesCount: count, rewardCents: config.rewardCents }, nowIso: p.nowIso,
      });
      emit({
        tenantId: p.tenantId, type: "REFERRAL_THRESHOLD_REACHED",
        subjectType: "referral", subjectId: p.referralId, subjectRepId: referral.referrerRepId,
        occurredAt: p.nowIso,
        payload: { salesCount: count, rewardCents: config.rewardCents, referredRepId: referral.referredRepId },
        // Thresholds are configurable and an org may have more than one over a
        // referral's life, so the key names the threshold that was reached.
        dedupeKey: `REFERRAL_THRESHOLD_REACHED:referral:${p.referralId}:n:${config.requiredApprovedSales}`,
      }, p.nowIso);
    });
    tx();
    // Qualification opens the holding period; the money is not releasable until
    // the clawback window closes.
    rawDb.prepare(`UPDATE referrals SET status = 'REWARD_PENDING', updated_at = ? WHERE tenant_id = ? AND id = ?`)
      .run(p.nowIso, p.tenantId, p.referralId);
  }

  return { referral: getReferral(p.tenantId, p.referralId)!, result };
}

/**
 * A sale was cancelled. Re-count and, if the referral has dropped below the
 * bar, walk it back — including reversing an already-approved reward.
 *
 * A PAID reward is NOT silently reversed here: the money has left, and undoing
 * it is a clawback an admin performs against the ledger, not a status flip.
 * This marks it and surfaces it as an exception, matching how the override
 * ledger handles a reversal against a finalized week.
 */
export function recheckAfterCancellation(p: {
  tenantId: number; referralId: number; nowIso: string;
}): { referral: Referral; droppedBelowBar: boolean } {
  const snapshot = qualificationFor(p.tenantId, p.referralId, p.nowIso);
  if (!snapshot) throw new Error("REFERRAL_NOT_FOUND");
  const { referral, result } = snapshot;

  const salesReq = result.requirements.find(r => r.key === "sales");
  const count = salesReq?.current ?? 0;
  rawDb.prepare(`UPDATE referrals SET qualifying_sales_count = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
    .run(count, p.nowIso, p.tenantId, p.referralId);

  const dropped = !result.qualified && !!referral.qualifiedAt;
  if (dropped && referral.status === "REWARD_PENDING") {
    // Still inside the holding window — the reward simply un-qualifies.
    rawDb.prepare(
      `UPDATE referrals SET status = 'IN_PROGRESS', qualified_at = NULL, updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
    ).run(p.nowIso, p.tenantId, p.referralId);
    recordEvent({
      tenantId: p.tenantId, referralId: p.referralId, type: "UNQUALIFIED",
      metadata: { salesCount: count, reason: "sale_cancelled" }, nowIso: p.nowIso,
    });
  } else if (dropped && isReferralCommitted(referral.status)) {
    recordEvent({
      tenantId: p.tenantId, referralId: p.referralId, type: "CLAWBACK_EXCEPTION",
      metadata: { salesCount: count, status: referral.status }, nowIso: p.nowIso,
    });
  }
  return { referral: getReferral(p.tenantId, p.referralId)!, droppedBelowBar: dropped };
}

// ── Admin decisions ─────────────────────────────────────────────────────────

export function approveReward(p: {
  tenantId: number; referralId: number; actorUserId: number; nowIso: string;
  /** Set false only for a documented early release. */
  enforceClawbackWindow?: boolean;
}): Referral {
  const snapshot = qualificationFor(p.tenantId, p.referralId, p.nowIso);
  if (!snapshot) throw new Error("REFERRAL_NOT_FOUND");
  const { referral, result, releasable } = snapshot;

  if (!canReferralTransition(referral.status, "APPROVED")) {
    throw new Error(`REFERRAL_BAD_TRANSITION:${referral.status}->APPROVED`);
  }
  // Re-checked at approval, not trusted from the stored status: the sales that
  // qualified this referral may have been cancelled since it entered the queue.
  if (!result.qualified) throw new Error("REFERRAL_NOT_QUALIFIED");
  if (p.enforceClawbackWindow !== false && !releasable.releasable) {
    throw new Error(`REFERRAL_CLAWBACK_WINDOW_OPEN:${releasable.daysRemaining}`);
  }

  const tx = rawDb.transaction(() => {
    rawDb.prepare(
      `UPDATE referrals SET status = 'APPROVED', approved_by = ?, approved_at = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
    ).run(p.actorUserId, p.nowIso, p.nowIso, p.tenantId, p.referralId);
    recordEvent({ tenantId: p.tenantId, referralId: p.referralId, type: "APPROVED", actorUserId: p.actorUserId, nowIso: p.nowIso });

    // The earnings ledger owns referral money. Written in the same transaction
    // as the approval so the two can never disagree about whether this rep is
    // owed $500.
    recordReferralReward({
      tenantId: p.tenantId, referrerRepId: referral.referrerRepId, referralId: p.referralId,
      rewardCents: referral.rewardAmountCents,
      effectiveDate: p.nowIso.slice(0, 10),
      referredRepId: referral.referredRepId,
      qualifyingSales: referral.qualifyingSalesCount,
      nowIso: p.nowIso,
    });
  });
  tx();
  return getReferral(p.tenantId, p.referralId)!;
}

export function rejectReferral(p: {
  tenantId: number; referralId: number; actorUserId: number; reason: string; nowIso: string;
}): Referral {
  const referral = getReferral(p.tenantId, p.referralId);
  if (!referral) throw new Error("REFERRAL_NOT_FOUND");
  if (!String(p.reason ?? "").trim()) throw new Error("REFERRAL_REASON_REQUIRED");
  if (!canReferralTransition(referral.status, "REJECTED")) {
    throw new Error(`REFERRAL_BAD_TRANSITION:${referral.status}->REJECTED`);
  }
  rawDb.prepare(
    `UPDATE referrals SET status = 'REJECTED', rejected_by = ?, rejected_at = ?, rejection_reason = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ?`,
  ).run(p.actorUserId, p.nowIso, p.reason.trim(), p.nowIso, p.tenantId, p.referralId);
  recordEvent({ tenantId: p.tenantId, referralId: p.referralId, type: "REJECTED", metadata: { reason: p.reason }, actorUserId: p.actorUserId, nowIso: p.nowIso });
  return getReferral(p.tenantId, p.referralId)!;
}

/**
 * The referred person's OWN status, projected to what they may see.
 *
 * Takes a rep id resolved from the SESSION — there is no id parameter anywhere
 * in this path, which is what makes it immune to a tampered identifier rather
 * than merely defended against one.
 */
export function applicantStatusFor(tenantId: number, repId: number, nowIso: string) {
  const referral = referralForRep(tenantId, repId);
  if (!referral) return applicantStatusView(null, null, false);

  const snapshot = qualificationFor(tenantId, referral.id, nowIso);
  const trainingMet = snapshot?.result.requirements.find(r => r.key === "training")?.met
    // A programme that does not require training has no training requirement in
    // the checklist; the milestone then reads as met rather than as missing.
    ?? true;

  return applicantStatusView(referral, snapshot?.result ?? null, trainingMet);
}

/** Link the reward's ledger row once the incentive engine has written it. */
export function attachRewardLedgerId(tenantId: number, referralId: number, ledgerId: number, nowIso: string): void {
  rawDb.prepare(
    `UPDATE referrals SET reward_ledger_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND reward_ledger_id IS NULL`,
  ).run(ledgerId, nowIso, tenantId, referralId);
}

export function markPaid(tenantId: number, referralId: number, nowIso: string): Referral {
  const referral = getReferral(tenantId, referralId);
  if (!referral) throw new Error("REFERRAL_NOT_FOUND");
  if (!canReferralTransition(referral.status, "PAID")) {
    throw new Error(`REFERRAL_BAD_TRANSITION:${referral.status}->PAID`);
  }
  rawDb.prepare(`UPDATE referrals SET status = 'PAID', paid_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
    .run(nowIso, nowIso, tenantId, referralId);
  recordEvent({ tenantId, referralId, type: "PAID", nowIso });
  return getReferral(tenantId, referralId)!;
}

/**
 * Re-point a referral at a different referrer. Refused after hire unless the
 * actor is an admin, and never once the reward is committed — the same rule the
 * roster's immutable sponsor edge enforces at the database level.
 */
export function changeReferrer(p: {
  tenantId: number; referralId: number; newReferrerRepId: number;
  actorIsAdmin: boolean; actorUserId: number; reason: string; nowIso: string;
}): Referral {
  const referral = getReferral(p.tenantId, p.referralId);
  if (!referral) throw new Error("REFERRAL_NOT_FOUND");
  const verdict = canChangeReferrer(referral.status, p.actorIsAdmin);
  if (!verdict.allowed) throw new Error(`REFERRAL_REFERRER_LOCKED:${verdict.reason}`);

  const newReferrer = rawDb.prepare(
    `SELECT tm.id, u.id AS userId FROM team_members tm LEFT JOIN users u ON u.team_member_id = tm.id
      WHERE tm.id = ? AND tm.tenant_id = ? AND tm.active = 1`,
  ).get(p.newReferrerRepId, p.tenantId) as any;
  if (!newReferrer) throw new Error("REFERRAL_REFERRER_NOT_FOUND");
  if (referral.referredRepId === p.newReferrerRepId) throw new Error("REFERRAL_SELF_REFERRAL");

  rawDb.prepare(
    `UPDATE referrals SET referrer_rep_id = ?, referrer_user_id = COALESCE(?, referrer_user_id), updated_at = ?
      WHERE tenant_id = ? AND id = ?`,
  ).run(p.newReferrerRepId, newReferrer.userId ?? null, p.nowIso, p.tenantId, p.referralId);
  recordEvent({
    tenantId: p.tenantId, referralId: p.referralId, type: "REFERRER_CHANGED",
    metadata: { from: referral.referrerRepId, to: p.newReferrerRepId, reason: p.reason },
    actorUserId: p.actorUserId, nowIso: p.nowIso,
  });
  return getReferral(p.tenantId, p.referralId)!;
}

/** Outstanding referral liability — the admin dashboard figure. */
export function orgReferralLiability(tenantId: number): { pendingCents: number; approvedCents: number; inProgress: number } {
  const row = rawDb.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN ('QUALIFIED','REWARD_PENDING') THEN reward_amount_cents ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN reward_amount_cents ELSE 0 END), 0) AS approved,
       COALESCE(SUM(CASE WHEN status IN ('ACTIVATED','IN_PROGRESS') THEN 1 ELSE 0 END), 0) AS inProgress
     FROM referrals WHERE tenant_id = ? AND deleted_at IS NULL`,
  ).get(tenantId) as any;
  return { pendingCents: row?.pending ?? 0, approvedCents: row?.approved ?? 0, inProgress: row?.inProgress ?? 0 };
}
