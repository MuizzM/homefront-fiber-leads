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
  // Live field location. Split from field.app.use because seeing WHERE a
  // colleague is standing is a different power from using the field app, and
  // must be grantable without it. `.team` is scoped by liveOpsScope (a
  // manager's own branch, a team lead's subtree); `.org` is the unrestricted
  // read; `.export` is separate again because pulling a rep's movement history
  // out of the system is the act a compliance reviewer will ask about.
  | "field.location.read.self" | "field.location.read.team"
  | "field.location.read.org" | "field.location.export"
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
  // Coaching. Deliberately its OWN domain rather than an extension of
  // dashboard.*: an insight is a statement ABOUT a person, and the right to
  // read a team's numbers is not the right to read what the system concluded
  // about their weaknesses. `.self` is a rep reading their own; `.team` is a
  // supervisor reading their downline's; `note.write` is authoring the private
  // record, which a rep never holds even about themselves - a coaching note is
  // the supervisor's file, and letting the subject write in it would make it
  // useless as one.
  | "coaching.read.self" | "coaching.read.team" | "coaching.note.write"
  // Deciding a reclaim RECOMMENDATION. Separate from the territory rank model
  // (shared/permissions.reclaim_territory, which is team_lead) because this is
  // the audited review step in front of it: the engine recommends, a human with
  // this capability records the decision, and only then does an ordinary
  // reclaim happen through the existing rank-gated route.
  | "territory.reclaim.review"
  // Provider order status (PerfectVision submitted orders and any future
  // carrier order feed). Deliberately its OWN domain rather than an extension
  // of commission.*: this plane is order LIFECYCLE, and granting somebody the
  // right to see which installs are failing must not hand them the pay ledger.
  | "order.read.self" | "order.read.team" | "order.read.org"
  // Uploading a provider export, editing the column mapping, and configuring
  // the connection. One capability, admin-only: whoever holds it decides how
  // every order in the organization is interpreted.
  | "order.import.manage"
  // Resolving a match exception - deciding that a provider order IS a given
  // internal sale. It attributes a commission-bearing order to a rep, so it
  // sits with the supervisory tier, never with the rep who would benefit.
  | "order.match.resolve"
  // Order recovery. read.self is a rep's own queue; .work is acting on a case
  // they hold (note, callback, resolve); .manage is assignment across the
  // queue, which is a supervisory act.
  | "recovery.read.self" | "recovery.read.team" | "recovery.read.org"
  | "recovery.work" | "recovery.manage"
  // Messaging a customer. Drafting and sending are split because a draft is a
  // screen and a send is an irreversible act on somebody else's phone. Both
  // still pass the consent gate; the capability only decides who may try.
  | "recovery.message.draft" | "recovery.message.send"
  // Policy: stall windows, recoverable cancellation reasons, message caps,
  // sender identities, and the organization-level messaging approval.
  | "recovery.policy.manage"
  // Authoring and APPROVING the words that get sent.
  | "messaging.templates.manage"
  // The consent ledger and the suppression list. Held by compliance as well as
  // by the org owner, and never by a rep - lifting a suppression is the one
  // action that could un-block somebody who asked us to stop.
  | "contact.consent.manage" | "contact.suppression.manage"
  // Guarded actions - the approval queue in front of dangerous writes.
  // `queue.read` is seeing the queue and deciding the kinds you already hold the
  // approve capability for; the engine does that per-kind check, so this one
  // opens the SCREEN and never widens what a person may approve on it.
  // `policy.manage` is configuring the gate itself, which is why it is separate
  // and admin-only: whoever holds it decides how much of this layer applies.
  | "action.queue.read" | "action.policy.manage"
  // Audit / activity
  | "audit.read.team" | "audit.read.org"
  // Org settings / policy
  | "settings.manage.org";

// A rep works only assigned leads, dispositions + notes them, and sees their
// OWN commissions + scorecard. No assignment authority, no structure config.
const REP: readonly Capability[] = [
  "field.app.use",
  // A rep reads their OWN tracking state - whether they are being tracked, under
  // which policy, and why not when they are not. That is the transparency half
  // of "default on". Deliberately NOT .read.team: a rep has no business calling
  // a roster-wide board endpoint at all, even one that would scope them to a
  // single row. Least privilege is the door being locked, not the room beyond
  // it being empty.
  "field.location.read.self",
  "lead.read.assigned", "lead.disposition.update", "lead.note.write",
  "commission.read.self", "dashboard.read.self",
  // A rep reads the insights generated about their OWN work. This is the half
  // of the coaching engine the brief insists on: an insight a rep cannot see is
  // a file kept on them, and every rule in shared/coachingInsights is written
  // to be read by its subject. Deliberately NOT coaching.note.write - the
  // supervisor's private note stays the supervisor's.
  "coaching.read.self",
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
  // Their own orders and their own recovery queue. `recovery.message.send` is
  // here deliberately: the brief's rep view is built around consent-safe
  // contact actions, and every send passes the same gate whoever taps it - the
  // capability decides who may try, the gate decides whether it goes. A rep
  // cannot approve the template, cannot configure the sender, and cannot lift a
  // suppression, so the three things that would make a send unsafe are all out
  // of reach.
  "order.read.self", "recovery.read.self", "recovery.work",
  "recovery.message.draft", "recovery.message.send",
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
  "field.location.read.team",
  // Reading the downline's insights and writing coaching notes is the team
  // lead's core job, so both land here. Deciding a territory reclaim does not:
  // that stays with MANAGER below, matching how reset_territory_pass already
  // sits above reclaim in the rank model.
  "coaching.read.team", "coaching.note.write",
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
  // The branch's orders and recoveries. Mirrors commission.read.team: a team
  // lead sees their own tree, never the whole organization.
  "order.read.team", "recovery.read.team",
  // Team leads are the people who reassign doors, so they are the people whose
  // bulk moves land in the approval queue. Giving them the screen lets them see
  // their own request waiting rather than wondering why nothing happened. It
  // does NOT let them approve anything: the engine checks each kind's own
  // approve capability, and a team lead holds lead.assign but is still refused
  // self-approval by default.
  "action.queue.read",
];

// A manager adds org-wide oversight reads AND the commission write surface
// (booking sales/adjustments, recalculating statements) — but still not
// payouts.pay: only admin moves real money.
const MANAGER: readonly Capability[] = [
  ...TEAM_LEAD,
  "commission.read.all", "dashboard.read.org", "audit.read.org",
  "field.location.read.team",
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
  // Org-wide order visibility, queue assignment, and resolving match
  // exceptions. Resolving an exception attributes a commission-bearing order to
  // a rep, which is why it lands here and not on the rep who benefits.
  "order.read.org", "recovery.read.org", "recovery.manage", "order.match.resolve",
  // Recording a decision on a reclaim recommendation. A manager's call, and an
  // audited one - the review row names who decided and what they decided.
  "territory.reclaim.review",
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
  // The four switches that decide how the order plane behaves: how a provider
  // export is read, what counts as recoverable, which words may be sent, and
  // who may never be contacted again. Every one of them is org policy.
  "order.import.manage", "recovery.policy.manage", "messaging.templates.manage",
  "contact.consent.manage", "contact.suppression.manage",
  // Unrestricted location read, and the separate right to pull a movement
  // history out of the system. Deliberately admin-only: a supervisor needs to
  // find their team right now, which .team gives them; nobody needs to export
  // another person's route to answer that question.
  "field.location.read.org", "field.location.export",
  // Configuring the action gate. Admin-only because this is the setting that
  // decides how much of the gate applies at all - it can turn an approval queue
  // into an audit log. It cannot go below a kind's catalogue floor, which is
  // the one thing about this layer an admin cannot change.
  "action.policy.manage",
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
  // The consent ledger and the suppression list are a compliance surface first
  // and an operations one second. Reading the order and recovery planes comes
  // with it, because a suppression only makes sense next to the outreach that
  // caused it. Deliberately NOT recovery.message.send.
  "order.read.org", "recovery.read.org",
  "contact.consent.manage", "contact.suppression.manage",
  // Compliance is the right approver for a suppression lift, which is the one
  // action kind whose catalogue floor is "approval". They reach it through this
  // screen; the engine authorizes the decision itself on
  // contact.suppression.manage, which they already hold.
  "action.queue.read",
];

const AUDITOR: readonly Capability[] = [
  "dashboard.read.org", "audit.read.org", "calling.compliance.read", "lead.skip_trace.read",
  // Read, and nothing else. An auditor can see every order and every case and
  // change none of them.
  "order.read.org", "recovery.read.org",
  // The action queue is read-only for this role in practice as well as in
  // intent: an auditor holds none of the four kinds' approve capabilities, so
  // every decide route refuses them. The screen is where they read what was
  // approved, by whom, and what was reversed.
  "action.queue.read",
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
  | "onboarding" | "dashboard" | "audit" | "settings" | "orders" | "messaging"
  | "actions" | "coaching";

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
  "field.location.read.self": "field",
  "field.location.read.team": "field",
  "field.location.read.org": "field",
  "field.location.export": "field",
  "dashboard.read.team": "dashboard",
  "dashboard.read.org": "dashboard",
  "coaching.read.self": "coaching",
  "coaching.read.team": "coaching",
  "coaching.note.write": "coaching",
  "territory.reclaim.review": "assignments",
  "audit.read.team": "audit",
  "audit.read.org": "audit",
  "settings.manage.org": "settings",
  "order.read.self": "orders",
  "order.read.team": "orders",
  "order.read.org": "orders",
  "order.import.manage": "orders",
  "order.match.resolve": "orders",
  "recovery.read.self": "orders",
  "recovery.read.team": "orders",
  "recovery.read.org": "orders",
  "recovery.work": "orders",
  "recovery.manage": "orders",
  "recovery.policy.manage": "orders",
  "recovery.message.draft": "messaging",
  "recovery.message.send": "messaging",
  "messaging.templates.manage": "messaging",
  "contact.consent.manage": "compliance",
  "contact.suppression.manage": "compliance",
  "action.queue.read": "actions",
  "action.policy.manage": "actions",
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
  // Employee location. Reading where a colleague is standing, and especially
  // exporting where they have BEEN, is the most personally sensitive read in
  // the product - it is about a person's body, not their work product. Flagged
  // so the governance matrix shows it beside the money capabilities.
  "field.location.read.team", "field.location.read.org", "field.location.export",
  // Reading the system's conclusions about somebody's weaknesses, and taking
  // territory off them. Both are statements about a person's livelihood, and
  // both belong in the matrix beside the money capabilities for the same reason
  // the location ones do.
  "coaching.read.team", "territory.reclaim.review",
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
  // Sending to a customer's phone or inbox under the company's identity. The
  // consent gate is the wall; this flag is what makes the grant visible in the
  // permissions matrix beside the money capabilities.
  "recovery.message.send",
  // Deciding which words may be sent, who may never be contacted, and how a
  // provider export is read. Each one is a policy that every later message
  // inherits.
  "messaging.templates.manage", "contact.consent.manage", "contact.suppression.manage",
  "order.import.manage", "recovery.policy.manage",
  // Attributing a provider order - and the commission behind it - to a rep.
  "order.match.resolve",
  // Configuring the gate that stands in front of every other high-risk write.
  // Flagged above the capabilities it protects, because loosening this one is
  // how somebody would reach them without appearing in an approval queue.
  "action.policy.manage",
]);

export function isHighRisk(cap: Capability): boolean {
  return HIGH_RISK_CAPABILITIES.has(cap);
}

// Every capability, grouped by domain, in a stable domain order — the matrix
// and the "grouped capabilities" governance view render straight from this.
const DOMAIN_ORDER: CapabilityDomain[] = ["field", "leads", "assignments", "scanning", "calling", "compliance", "enrichment", "orders", "messaging", "commissions", "earnings", "incentives", "training", "mileage", "referrals", "onboarding", "dashboard", "coaching", "actions", "audit", "settings"];
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
