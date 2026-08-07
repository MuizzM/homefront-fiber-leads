// ── Capability model — the enterprise permission layer ────────────────────────
// Named, dotted capabilities (NOT raw role strings) are the unit of
// authorization. Roles map to capability SETS; BOTH the server middleware
// (requireCapability) and the client UI gate (useCan) authorize against the
// same map here, so the UI can never offer an action the API will reject.
//
// This composes with — does not replace — shared/permissions.ts (the territory
// rank model). New sensitive surfaces should gate on capabilities.

export type Role =
  | "rep" | "team_lead" | "manager" | "admin" | "super_admin"
  | "calling_rep" | "calling_manager" | "compliance_admin" | "auditor";

export type Capability =
  // Field application boundary. Calling/compliance-only identities never
  // inherit legacy map, knock, GPS, clock, roster, or field-pay access.
  | "field.app.use"
  // Leads
  | "lead.read.assigned" | "lead.read.all"
  | "lead.assign" | "lead.reassign"
  | "lead.disposition.update" | "lead.note.write"
  // Area skip trace. Deliberately lead-domain, NOT calling.*: team_lead and
  // manager hold zero calling.* capabilities by design, so gating this on
  // calling.enrichment.request would 403 exactly the roles that run areas —
  // and granting them that capability would open the whole calling surface.
  | "lead.skip_trace.request" | "lead.skip_trace.read"
  // Address discovery / field scans. Two tiers on purpose: submit starts a scan
  // and observes your OWN job with provider diagnostics redacted; manage sees
  // every job in the org unredacted and configures sources. Scanning begins at
  // team lead — a rep knocking doors never holds either.
  | "scan.submit" | "scan.manage"
  // Calling is deliberately independent from field permissions. A field rep
  // never inherits these grants merely because they can see or knock a lead.
  | "calling.queue.read" | "calling.lead.read" | "calling.evaluate" | "calling.attempt.manual"
  | "calling.disposition.write" | "calling.opt_out.write" | "calling.callback.write"
  | "calling.compliance.read" | "calling.manage" | "calling.policy.manage"
  | "calling.enrichment.request" | "calling.providers.manage" | "calling.dnc.manage"
  // Commissions
  | "commission.read.self" | "commission.read.team" | "commission.read.all"
  // read.downline widens read.team from direct reports to the FULL reports-to
  // subtree (multi-level). Distinct from read.all: a team_lead sees their own
  // tree, never the whole tenant.
  | "commission.read.downline"
  // structure.manage = plan/rate CONFIG only. Booking money (sales, adjustments)
  // and statement math are separate WRITE caps a team_lead never holds.
  | "commission.structure.manage"
  | "commission.sales.write" | "commission.adjustments.write" | "commission.statements.write"
  // Resolving override-ledger exceptions (reversals against finalized weeks).
  // Sits with the other money-write caps at manager+, never team_lead.
  | "commission.overrides.manage"
  // Onboarding agreements
  | "onboarding.documents.read.self" | "onboarding.documents.manage"
  // Payouts — moving REAL money to reps. Owner/admin only, never a read/oversight role.
  | "payouts.pay"
  // Earnings ledger — the unified read across commission, overrides, spiffs,
  // mileage and referral money. Deliberately SEPARATE from commission.read.*:
  // the ledger folds in reimbursements and referral bonuses that the commission
  // capabilities were never scoped to expose, so widening those would have
  // silently granted the new surface to everyone who already held them.
  | "earnings.read.self" | "earnings.read.team" | "earnings.read.org"
  // Training. read.self is every rep's own progress; read.team is the
  // compliance view over a downline; manage is authoring courses and deciding
  // what is REQUIRED — which gates who may sell, so it is high-risk.
  | "training.read.self" | "training.read.team" | "training.manage"
  // Mileage. submit.self is a worker logging their own trips; approve is the
  // review queue; settings.manage owns the reimbursement RATE, which is money
  // policy and therefore admin-only.
  | "mileage.submit.self" | "mileage.read.team" | "mileage.approve" | "mileage.settings.manage"
  // Referrals. read.self is a rep's own link and pipeline; read.org is the
  // whole program; approve releases the reward; settings.manage sets the
  // threshold, amount, qualification window and clawback period.
  | "referral.read.self" | "referral.read.org" | "referral.approve" | "referral.settings.manage"
  // Incentive campaigns that can pay a percentage of a sale, carry a clawback
  // policy, and fire off training/mileage/referral events — a strictly wider
  // surface than the knock-shaped spiff campaigns, hence its own capability
  // rather than reusing commission.structure.manage.
  | "incentive.campaign.manage"
  // Dashboards / analytics read models
  | "dashboard.read.self" | "dashboard.read.team" | "dashboard.read.org"
  // Audit / activity
  | "audit.read.team" | "audit.read.org"
  // Org settings / policy
  | "settings.manage.org";

// A rep works only assigned leads, dispositions + notes them, and sees their
// OWN commissions + scorecard. No assignment authority, no structure config.
const REP: readonly Capability[] = [
  "field.app.use",
  "lead.read.assigned", "lead.disposition.update", "lead.note.write",
  "commission.read.self", "dashboard.read.self",
  "onboarding.documents.read.self",
  // READ only — a rep works the numbers an area run already produced. This is
  // safe to grant org-wide because the capability alone opens nothing: every
  // area route pairs it with canManageArea, and a rep's leadVisibilityScope is
  // [their own teamMemberId], so they reach the areas assigned to them and 404
  // on every other one. Requesting a run stays team_lead+ — reading a worklist
  // is field work, spending metered provider budget is a supervisory call.
  "lead.skip_trace.read",
  // Own money, own training, own trips, own referral link. Every one of these
  // is self-scoped at the route by the session's teamMemberId — the capability
  // opens the endpoint, the scope decides the rows, exactly as
  // commission.read.self already works.
  "earnings.read.self", "training.read.self", "mileage.submit.self", "referral.read.self",
];
// Deliberately NOT here: scan.submit. Address discovery spends metered upstream
// geocoding budget, and choosing which streets are worth buying data for is a
// supervisory call, not field work. A rep knocking doors has no reason to launch
// one, and every rep holding it multiplied the ways that budget could be spent
// without anyone deciding to spend it. It starts at team lead (below).

// A team lead assigns/reassigns within scope, sees the team's leads + activity,
// and may configure commission structures (rates/plans) — but never BOOKS money:
// sales, adjustments, and statement (re)calculation stay manager+.
const TEAM_LEAD: readonly Capability[] = [
  ...REP,
  "lead.read.all", "lead.assign", "lead.reassign",
  "commission.read.team", "commission.read.downline", "commission.structure.manage",
  "dashboard.read.team", "audit.read.team",
  // Scanning starts here. These sets are unions of the tier below, not supersets
  // of REP — TEAM_LEAD spreads REP and MANAGER spreads TEAM_LEAD — so removing
  // scan.submit from REP took it off every role at once; granting it back here
  // restores it for team lead and up, and for nobody beneath.
  //
  // It lands on TEAM_LEAD rather than MANAGER on purpose: submit and manage are
  // two deliberate tiers. Whoever holds submit-without-manage may start a scan
  // and watch their OWN job, but sees provider diagnostics, failure counts, and
  // error text redacted (addressDiscovery/routes canManage). Put submit on
  // MANAGER and no role holds one without the other, which makes that redaction
  // unreachable and quietly collapses the split.
  "scan.submit",
  // Starting an area skip trace spends metered provider budget, so it sits
  // with the other supervisory spend actions rather than with field work. NOT
  // added to REP: these sets are unions, so a REP entry would grant it to
  // every tier at once.
  "lead.skip_trace.request", "lead.skip_trace.read",
  // Oversight reads over the branch. Mirrors commission.read.team/downline: a
  // team lead sees their own tree's training compliance, trips and earnings —
  // never the whole tenant, which starts at MANAGER below.
  "earnings.read.team", "training.read.team", "mileage.read.team",
];

// A manager adds org-wide oversight reads AND the commission write surface
// (booking sales/adjustments, recalculating statements) — but still not
// payouts.pay: only admin moves real money.
const MANAGER: readonly Capability[] = [
  ...TEAM_LEAD,
  "commission.read.all", "dashboard.read.org", "audit.read.org",
  "onboarding.documents.manage",
  // The second half of scanning: a manager inherits scan.submit from TEAM_LEAD
  // and adds scan.manage, which unredacts provider diagnostics and widens the
  // view from their own jobs to every job in the org.
  "scan.manage",
  "commission.sales.write", "commission.adjustments.write", "commission.statements.write",
  "commission.overrides.manage",
  "earnings.read.org", "referral.read.org",
  // Authoring courses and deciding what is REQUIRED. High-risk: required
  // training is what gates a rep out of the field (shared/trainingGate.ts), so
  // this capability can stop an org selling as surely as it can start one.
  "training.manage",
  // The mileage review queue is a manager's daily work — the spec's manager
  // dashboard is built around it. Setting the RATE is not: that is money
  // policy and lands on ADMIN below.
  "mileage.approve",
  // Launching an incentive campaign commits money, so it sits with the other
  // money-write caps rather than with the softer structure.manage tier that
  // the knock-shaped spiff campaigns use today.
  "incentive.campaign.manage",
];

// Admin (and super_admin) hold the full set including org policy + paying reps.
// payouts.pay is deliberately NOT in MANAGER — a manager is oversight/read; only
// the org owner (admin) may move real money.
//
// referral.approve and mileage.settings.manage join it for the same reason:
// releasing a referral reward and setting the reimbursement rate both decide
// what leaves the company's bank account, and both mirror how approving a
// commission adjustment is already gated on payouts.pay rather than on the
// manager capability that CREATES the adjustment.
const ADMIN: readonly Capability[] = [
  ...MANAGER, "settings.manage.org", "payouts.pay",
  "referral.approve", "referral.settings.manage", "mileage.settings.manage",
];

const CALLING_REP: readonly Capability[] = [
  "dashboard.read.self",
  "calling.queue.read", "calling.lead.read", "calling.evaluate", "calling.attempt.manual",
  "calling.disposition.write", "calling.opt_out.write", "calling.callback.write",
];

const CALLING_MANAGER: readonly Capability[] = [
  ...CALLING_REP,
  "dashboard.read.team", "audit.read.team", "calling.manage", "calling.enrichment.request",
];

const COMPLIANCE_ADMIN: readonly Capability[] = [
  "dashboard.read.org", "audit.read.org", "calling.queue.read", "calling.lead.read",
  "calling.compliance.read", "calling.policy.manage", "calling.providers.manage", "calling.dnc.manage",
  // Read-only: compliance must be able to review what a vendor screen decided
  // without gaining the ability to spend budget starting one.
  "lead.skip_trace.read",
];

const AUDITOR: readonly Capability[] = [
  "dashboard.read.org", "audit.read.org", "calling.compliance.read", "lead.skip_trace.read",
];

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  rep: new Set(REP),
  team_lead: new Set(TEAM_LEAD),
  manager: new Set(MANAGER),
  admin: new Set(ADMIN),
  super_admin: new Set(ADMIN),
  calling_rep: new Set(CALLING_REP),
  calling_manager: new Set(CALLING_MANAGER),
  compliance_admin: new Set(COMPLIANCE_ADMIN),
  auditor: new Set(AUDITOR),
};

// Organization owners administer the pilot and may perform a deliberate test
// call, but ordinary managers cannot silently inherit calling authority.
for (const capability of [
  "calling.queue.read", "calling.lead.read", "calling.evaluate", "calling.attempt.manual",
  "calling.disposition.write", "calling.opt_out.write", "calling.callback.write",
  "calling.compliance.read", "calling.manage", "calling.enrichment.request",
  "calling.policy.manage", "calling.providers.manage", "calling.dnc.manage",
] as const) {
  (ROLE_CAPABILITIES.admin as Set<Capability>).add(capability);
  (ROLE_CAPABILITIES.super_admin as Set<Capability>).add(capability);
}

// O(1) capability check. Unknown/undefined role → fail closed (deny).
export function can(role: Role | string | undefined | null, cap: Capability): boolean {
  const set = role ? ROLE_CAPABILITIES[role as Role] : undefined;
  return set ? set.has(cap) : false;
}

// The full capability set for a role — handed to the client so UI gates read
// from the same source (never a re-derived role if/else).
export function capabilitiesFor(role: Role | string | undefined | null): Capability[] {
  const set = role ? ROLE_CAPABILITIES[role as Role] : undefined;
  return set ? [...set] : [];
}

// ── Governance metadata — capabilities as first-class objects ─────────────────
// The permissions-admin UI groups by domain, flags high-risk grants, and
// answers "who can do this?" — all from this one source, never a role if/else.

export type CapabilityDomain =
  | "field" | "leads" | "assignments" | "scanning" | "calling" | "compliance" | "enrichment"
  | "commissions" | "earnings" | "incentives" | "training" | "mileage" | "referrals"
  | "onboarding" | "dashboard" | "audit" | "settings";

export const CAPABILITY_DOMAIN: Record<Capability, CapabilityDomain> = {
  "field.app.use": "field",
  "lead.read.assigned": "leads",
  "lead.read.all": "leads",
  "lead.disposition.update": "leads",
  "lead.note.write": "leads",
  "lead.skip_trace.request": "leads",
  "lead.skip_trace.read": "leads",
  "lead.assign": "assignments",
  "lead.reassign": "assignments",
  "scan.submit": "scanning",
  "scan.manage": "scanning",
  "calling.queue.read": "calling",
  "calling.lead.read": "calling",
  "calling.evaluate": "calling",
  "calling.attempt.manual": "calling",
  "calling.disposition.write": "calling",
  "calling.opt_out.write": "calling",
  "calling.callback.write": "calling",
  "calling.compliance.read": "compliance",
  "calling.manage": "compliance",
  "calling.policy.manage": "compliance",
  "calling.enrichment.request": "enrichment",
  "calling.providers.manage": "enrichment",
  "calling.dnc.manage": "compliance",
  "commission.read.self": "commissions",
  "commission.read.team": "commissions",
  "commission.read.all": "commissions",
  "commission.read.downline": "commissions",
  "commission.overrides.manage": "commissions",
  "commission.structure.manage": "commissions",
  "commission.sales.write": "commissions",
  "commission.adjustments.write": "commissions",
  "commission.statements.write": "commissions",
  "payouts.pay": "commissions",
  "earnings.read.self": "earnings",
  "earnings.read.team": "earnings",
  "earnings.read.org": "earnings",
  "incentive.campaign.manage": "incentives",
  "training.read.self": "training",
  "training.read.team": "training",
  "training.manage": "training",
  "mileage.submit.self": "mileage",
  "mileage.read.team": "mileage",
  "mileage.approve": "mileage",
  "mileage.settings.manage": "mileage",
  "referral.read.self": "referrals",
  "referral.read.org": "referrals",
  "referral.approve": "referrals",
  "referral.settings.manage": "referrals",
  "onboarding.documents.read.self": "onboarding",
  "onboarding.documents.manage": "onboarding",
  "dashboard.read.self": "dashboard",
  "dashboard.read.team": "dashboard",
  "dashboard.read.org": "dashboard",
  "audit.read.team": "audit",
  "audit.read.org": "audit",
  "settings.manage.org": "settings",
};

// High-risk grants — governance highlights these because they move money,
// change ownership, expose org-wide data, or alter policy.
export const HIGH_RISK_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "lead.assign", "lead.reassign",
  // Spends metered provider budget on an entire area in one action.
  "lead.skip_trace.request",
  "commission.structure.manage", "commission.read.all",
  // Multi-level pay visibility + resolving money exceptions on the override ledger.
  "commission.read.downline", "commission.overrides.manage",
  "commission.sales.write", "commission.adjustments.write", "commission.statements.write",
  "onboarding.documents.manage",
  "scan.manage",
  "calling.attempt.manual", "calling.manage", "calling.policy.manage", "calling.providers.manage", "calling.dnc.manage",
  "audit.read.org", "settings.manage.org", "payouts.pay",
  // Org-wide money visibility across every earning type, including
  // reimbursements and referral bonuses.
  "earnings.read.org",
  // Commits money on a rule, with a clawback policy attached.
  "incentive.campaign.manage",
  // Required training is the field gate — this can stop an org selling.
  "training.manage",
  // Each of these decides that money leaves the company: approving trips,
  // setting the per-mile rate, and releasing a referral reward.
  "mileage.approve", "mileage.settings.manage",
  "referral.approve", "referral.settings.manage",
]);

export function isHighRisk(cap: Capability): boolean {
  return HIGH_RISK_CAPABILITIES.has(cap);
}

// Every capability, grouped by domain, in a stable domain order — the matrix
// and the "grouped capabilities" governance view render straight from this.
const DOMAIN_ORDER: CapabilityDomain[] = ["field", "leads", "assignments", "scanning", "calling", "compliance", "enrichment", "commissions", "earnings", "incentives", "training", "mileage", "referrals", "onboarding", "dashboard", "audit", "settings"];
export function groupedCapabilities(): { domain: CapabilityDomain; capabilities: Capability[] }[] {
  const all = Object.keys(CAPABILITY_DOMAIN) as Capability[];
  return DOMAIN_ORDER.map(domain => ({
    domain,
    capabilities: all.filter(c => CAPABILITY_DOMAIN[c] === domain),
  })).filter(g => g.capabilities.length > 0);
}

// "Who can do this?" — every role whose set includes the capability.
export function rolesWithCapability(cap: Capability): Role[] {
  return (Object.keys(ROLE_CAPABILITIES) as Role[]).filter(r => ROLE_CAPABILITIES[r].has(cap));
}
