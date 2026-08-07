/**
 * Seed the workforce-platform walkthrough the spec asks for, end to end:
 *
 *   one manager · one team lead · one referring rep · one referred rep
 *   six qualifying sales · a $500 referral reward · a mileage reimbursement
 *   a training incentive · and the statement/PDF that carries them
 *
 * Run against a THROWAWAY database:
 *
 *   DATA_DIR=$(mktemp -d) npx tsx script/seed-workforce-demo.ts
 *
 * It refuses to run against a database that already has reps unless
 * SEED_FORCE=1, because the one thing worse than no demo data is demo money in
 * a live org's ledger.
 *
 * Everything it does goes through the real stores — no direct money INSERTs —
 * so a successful run is itself evidence that the whole path works: events are
 * emitted, the subscriber pays, the ledger reconciles.
 */
import { rawDb } from "../server/db";
import { runMigrations } from "../server/storage";
import * as mileage from "../server/mileageStore";
import * as referrals from "../server/referralStore";
import * as incentives from "../server/incentiveSubscriber";
import * as ledger from "../server/earningsLedgerStore";
import { formatCents } from "@shared/commissionStatement";
import { formatMiles } from "@shared/mileage";

const TENANT = 1;
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const NOW_MS = Date.parse(NOW);
const DAY = 86_400_000;

// Hire and sell in the recent past so the qualification window and the
// campaign windows are all comfortably open at "now".
const HIRED_AT = new Date(NOW_MS - 30 * DAY).toISOString();
const SOLD_AT = new Date(NOW_MS - 7 * DAY).toISOString();

function step(n: number, message: string) {
  console.log(`\n\x1b[36m${n}.\x1b[0m ${message}`);
}
function detail(message: string) {
  console.log(`   ${message}`);
}

function guard() {
  if (process.env.SEED_FORCE === "1") return;
  const existing = rawDb.prepare(`SELECT COUNT(*) AS n FROM team_members`).get() as any;
  if ((existing?.n ?? 0) > 0) {
    console.error(
      "\nRefusing to seed: this database already has team members.\n" +
      "Run against a throwaway DATA_DIR, or set SEED_FORCE=1 if you are certain.\n",
    );
    process.exit(1);
  }
}

function tenant() {
  rawDb.prepare(
    `INSERT INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(TENANT, "demo-fiber", "Demo Fiber Co", "Dana Owner", "owner@demo.test", "Demo Fiber", NOW, NOW);
}

function member(id: number, name: string, role: string, reportsToId: number | null) {
  rawDb.prepare(
    `INSERT INTO team_members (id, name, email, role, reports_to_id, active, tenant_id, created_at)
     VALUES (?,?,?,?,?,1,?,?)
     ON CONFLICT(id) DO UPDATE SET role = excluded.role, reports_to_id = excluded.reports_to_id`,
  ).run(id, name, `${name.toLowerCase().replace(/\W+/g, ".")}@demo.test`, role, reportsToId, TENANT, NOW);
  return id;
}

function user(id: number, name: string, teamMemberId: number, role: string) {
  const email = `${name.toLowerCase().replace(/\W+/g, ".")}@demo.test`;
  rawDb.prepare(
    `INSERT INTO users (id, name, email, role, tenant_id, team_member_id, active, created_at)
     VALUES (?,?,?,?,?,?,1,?)
     ON CONFLICT(id) DO UPDATE SET team_member_id = excluded.team_member_id`,
  ).run(id, name, email, role, TENANT, teamMemberId, NOW);
  return { id, email };
}

function qualifiedSale(repId: number, n: number) {
  rawDb.prepare(
    `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, qualified_at, created_at, updated_at)
     VALUES (?,?,?,'QUALIFIED',?,?,?,?)
     ON CONFLICT(tenant_id, external_id) DO NOTHING`,
  ).run(TENANT, repId, `demo-sale-${repId}-${n}`, SOLD_AT, SOLD_AT, NOW, NOW);
}

async function main() {
  runMigrations();
  guard();
  tenant();

  // ── The org chart ─────────────────────────────────────────────────────────
  step(1, "Building the org chart");
  const manager = member(901, "Morgan Manager", "manager", null);
  const teamLead = member(902, "Taylor TeamLead", "team_lead", manager);
  const referrer = member(903, "Riley Referrer", "rep", teamLead);
  const referred = member(904, "Remy Referred", "rep", teamLead);

  const referrerUser = user(9003, "Riley Referrer", referrer, "rep");
  const referredUser = user(9004, "Remy Referred", referred, "rep");
  user(9001, "Morgan Manager", manager, "manager");
  user(9002, "Taylor TeamLead", teamLead, "team_lead");
  detail(`manager ${manager} → team lead ${teamLead} → reps ${referrer}, ${referred}`);

  // ── Org policy ────────────────────────────────────────────────────────────
  step(2, "Turning on the programmes an admin has to opt into");
  referrals.setConfig(TENANT, { enabled: true }, NOW);
  detail("referral programme: ON ($500 after 6 approved sales)");

  // The rate is chosen by the operator; there is no default anywhere in the
  // codebase, deliberately.
  mileage.addRate({
    tenantId: TENANT, rateMilliCentsPerMile: 65_500,
    effectiveFrom: TODAY.slice(0, 8) + "01", note: "Demo rate", nowIso: NOW,
  });
  mileage.setReimbursementEnabled(TENANT, true, NOW);
  detail("mileage: ON at $0.655/mi (demo only — see the agreement note in the audit)");

  // Training "complete" means what the field gate means by it.
  rawDb.prepare(
    `INSERT INTO app_settings (tenant_id, key, value, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
  ).run(TENANT, "training.required_lessons", "3", NOW);

  // ── Campaigns ─────────────────────────────────────────────────────────────
  step(3, "Creating incentive campaigns");
  const window = { startsAtMs: NOW_MS - 90 * DAY, endsAtMs: NOW_MS + 90 * DAY };
  const trainingCampaign = incentives.createCampaign({
    tenantId: TENANT, name: "Training completion bonus",
    incentiveType: "TRAINING_COMPLETION", amountBasis: "FLAT", rewardCents: 10_000,
    maximumRewardsPerUser: 1, approvalRequired: false, ...window, nowIso: NOW,
  });
  const referralCampaign = incentives.createCampaign({
    tenantId: TENANT, name: "Rep referral reward",
    incentiveType: "REFERRAL_REWARD", amountBasis: "FLAT", rewardCents: 50_000,
    maximumRewardsPerUser: 0, approvalRequired: true, ...window, nowIso: NOW,
  });
  const mileageCampaign = incentives.createCampaign({
    tenantId: TENANT, name: "Mileage reimbursement",
    incentiveType: "MILEAGE_REIMBURSEMENT", amountBasis: "PASSTHROUGH", rewardCents: 0,
    approvalRequired: false, ...window, nowIso: NOW,
  });
  detail(`#${trainingCampaign.id} training · #${referralCampaign.id} referral · #${mileageCampaign.id} mileage`);

  // ── The referral funnel ───────────────────────────────────────────────────
  step(4, "Riley shares a referral link; Remy applies through it");
  const link = referrals.ensureLink({
    tenantId: TENANT, referrerUserId: referrerUser.id, referrerRepId: referrer,
    baseUrl: "https://demo.test", nowIso: NOW,
  });
  detail(`link: ${link.url}`);
  referrals.trackClick(link.code);

  // The applicant must be NEW, so the referral is attributed before the user
  // row exists — exactly as the public /referrals/apply endpoint does it.
  rawDb.prepare(`DELETE FROM users WHERE id = ?`).run(referredUser.id);
  const { referral, rejected } = referrals.attributeApplication({
    tenantId: TENANT, linkCode: link.code,
    applicantEmail: "remy.referred@demo.test", nowIso: HIRED_AT,
  });
  if (!referral) throw new Error(`attribution rejected: ${rejected}`);
  user(9004, "Remy Referred", referred, "rep");
  detail(`referral #${referral.id} → APPLIED`);

  step(5, "Remy is hired, then activated");
  referrals.markHired({
    tenantId: TENANT, referralId: referral.id, referredRepId: referred,
    referredUserId: referredUser.id, nowIso: HIRED_AT,
  });
  referrals.markActivated({ tenantId: TENANT, referralId: referral.id, nowIso: HIRED_AT });
  detail("HIRED → ACTIVATED");

  // ── Training ──────────────────────────────────────────────────────────────
  step(6, "Remy finishes required training — which pays a training incentive");
  for (let i = 0; i < 3; i += 1) {
    rawDb.prepare(
      `INSERT OR IGNORE INTO training_progress (tenant_id, user_id, lesson_id, completed_at, quiz_score)
       VALUES (?,?,?,?,?)`,
    ).run(TENANT, referredUser.id, `demo-lesson-${i}`, HIRED_AT, 90);
  }
  const { emit } = await import("../server/domainEventStore");
  emit({
    tenantId: TENANT, type: "TRAINING_COMPLETED", subjectType: "training_enrollment",
    subjectId: referredUser.id, subjectRepId: referred, occurredAt: HIRED_AT,
    payload: { lessons: 3, quizScore: 90 },
  }, NOW);
  detail("3 lessons complete, quiz passed at 90%");

  // ── Six qualifying sales ──────────────────────────────────────────────────
  step(7, "Remy closes six approved sales");
  for (let i = 1; i <= 6; i += 1) {
    qualifiedSale(referred, i);
    emit({
      tenantId: TENANT, type: "SALE_APPROVED", subjectType: "sale",
      subjectId: 90_000 + i, subjectRepId: referred, occurredAt: SOLD_AT,
      payload: { lifetimeSaleNumber: i, provider: "kinetic" },
    }, NOW);
  }
  detail("6 × QUALIFIED, none reversed");

  // ── Mileage ───────────────────────────────────────────────────────────────
  step(8, "Remy logs a trip; the team lead approves it");
  const trip = mileage.createTrip({
    tenantId: TENANT, repId: referred, userId: referredUser.id,
    tripDate: TODAY, startLocation: "Office", endLocation: "Oakwood territory",
    milesHundredths: 1234, purpose: "Door knocking — Oakwood",
    source: "MANUAL", nowIso: NOW, todayIso: TODAY,
  });
  mileage.transitionTrip({ tenantId: TENANT, id: trip.id, to: "SUBMITTED", actorUserId: referredUser.id, nowIso: NOW });
  const approvedTrip = mileage.transitionTrip({
    tenantId: TENANT, id: trip.id, to: "APPROVED", actorUserId: 9002, nowIso: NOW,
  });
  detail(`${formatMiles(approvedTrip.milesHundredths)} → ${formatCents(approvedTrip.reimbursementCents ?? 0)}`);

  // ── Let the engine run ────────────────────────────────────────────────────
  step(9, "Draining the incentive subscriber");
  const drained = incentives.drain(NOW);
  detail(`${drained.processed} events processed · ${drained.awarded} awards written`);

  // ── The referral reward ───────────────────────────────────────────────────
  step(10, "Approving the referral reward");
  const progress = referrals.qualificationFor(TENANT, referral.id, NOW)!;
  for (const requirement of progress.result.requirements) {
    detail(`${requirement.met ? "✓" : "✗"} ${requirement.label}${requirement.target ? ` (${requirement.current}/${requirement.target})` : ""}`);
  }
  if (!progress.result.qualified) throw new Error("referral did not qualify — the demo is broken");

  // The clawback window is deliberately overridden here so the walkthrough
  // reaches a paid state in one run; in production this waits.
  const approved = referrals.approveReward({
    tenantId: TENANT, referralId: referral.id, actorUserId: 9001,
    nowIso: NOW, enforceClawbackWindow: false,
  });
  detail(`referral ${approved.status} · ${formatCents(approved.rewardAmountCents)} to Riley`);

  // ── The unified ledger ────────────────────────────────────────────────────
  step(11, "Reading the earnings ledger");
  for (const repId of [referrer, referred]) {
    const rows = ledger.listEarnings(TENANT, { repIds: [repId] });
    const name = repId === referrer ? "Riley (referrer)" : "Remy (referred)";
    detail(`${name}:`);
    for (const row of rows) {
      detail(`    ${row.earningType.padEnd(24)} ${formatCents(row.netCents).padStart(10)}  ${row.status}`);
    }
    const total = rows.reduce((sum, r) => sum + r.netCents, 0);
    detail(`    ${"TOTAL".padEnd(24)} ${formatCents(total).padStart(10)}`);
  }

  step(12, "Organization liability");
  for (const [type, amount] of Object.entries(ledger.orgLiability(TENANT))) {
    detail(`${type.padEnd(24)} ${formatCents(amount).padStart(10)}`);
  }

  console.log(
    "\n\x1b[32mSeed complete.\x1b[0m " +
    "Log in as riley.referrer@demo.test to see the referral dashboard, " +
    "or remy.referred@demo.test for the mileage log and training bonus.\n",
  );
}

main().catch(err => {
  console.error("\nSeed failed:", err);
  process.exit(1);
});
