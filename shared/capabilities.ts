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
  // Address discovery / field scans. Reps may submit and observe their own
  // jobs; operational controls and source configuration stay manager-only.
  | "scan.submit" | "scan.manage"
  // Calling is deliberately independent from field permissions. A field rep
  // never inherits these grants merely because they can see or knock a lead.
  | "calling.queue.read" | "calling.lead.read" | "calling.evaluate" | "calling.attempt.manual"
  | "calling.disposition.write" | "calling.opt_out.write" | "calling.callback.write"
  | "calling.compliance.read" | "calling.manage" | "calling.policy.manage"
  | "calling.enrichment.request" | "calling.providers.manage" | "calling.dnc.manage"
  // Commissions
  | "commission.read.self" | "commission.read.team" | "commission.read.all"
  // structure.manage = plan/rate CONFIG only. Booking money (sales, adjustments)
  // and statement math are separate WRITE caps a team_lead never holds.
  | "commission.structure.manage"
  | "commission.sales.write" | "commission.adjustments.write" | "commission.statements.write"
  // Onboarding agreements
  | "onboarding.documents.read.self" | "onboarding.documents.manage"
  // Payouts — moving REAL money to reps. Owner/admin only, never a read/oversight role.
  | "payouts.pay"
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
  "scan.submit",
];

// A team lead assigns/reassigns within scope, sees the team's leads + activity,
// and may configure commission structures (rates/plans) — but never BOOKS money:
// sales, adjustments, and statement (re)calculation stay manager+.
const TEAM_LEAD: readonly Capability[] = [
  ...REP,
  "lead.read.all", "lead.assign", "lead.reassign",
  "commission.read.team", "commission.structure.manage",
  "dashboard.read.team", "audit.read.team",
];

// A manager adds org-wide oversight reads AND the commission write surface
// (booking sales/adjustments, recalculating statements) — but still not
// payouts.pay: only admin moves real money.
const MANAGER: readonly Capability[] = [
  ...TEAM_LEAD,
  "commission.read.all", "dashboard.read.org", "audit.read.org",
  "onboarding.documents.manage",
  "scan.manage",
  "commission.sales.write", "commission.adjustments.write", "commission.statements.write",
];

// Admin (and super_admin) hold the full set including org policy + paying reps.
// payouts.pay is deliberately NOT in MANAGER — a manager is oversight/read; only
// the org owner (admin) may move real money.
const ADMIN: readonly Capability[] = [...MANAGER, "settings.manage.org", "payouts.pay"];

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
];

const AUDITOR: readonly Capability[] = ["dashboard.read.org", "audit.read.org", "calling.compliance.read"];

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
  | "commissions" | "onboarding" | "dashboard" | "audit" | "settings";

export const CAPABILITY_DOMAIN: Record<Capability, CapabilityDomain> = {
  "field.app.use": "field",
  "lead.read.assigned": "leads",
  "lead.read.all": "leads",
  "lead.disposition.update": "leads",
  "lead.note.write": "leads",
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
  "commission.structure.manage": "commissions",
  "commission.sales.write": "commissions",
  "commission.adjustments.write": "commissions",
  "commission.statements.write": "commissions",
  "payouts.pay": "commissions",
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
  "commission.structure.manage", "commission.read.all",
  "commission.sales.write", "commission.adjustments.write", "commission.statements.write",
  "onboarding.documents.manage",
  "scan.manage",
  "calling.attempt.manual", "calling.manage", "calling.policy.manage", "calling.providers.manage", "calling.dnc.manage",
  "audit.read.org", "settings.manage.org", "payouts.pay",
]);

export function isHighRisk(cap: Capability): boolean {
  return HIGH_RISK_CAPABILITIES.has(cap);
}

// Every capability, grouped by domain, in a stable domain order — the matrix
// and the "grouped capabilities" governance view render straight from this.
const DOMAIN_ORDER: CapabilityDomain[] = ["field", "leads", "assignments", "scanning", "calling", "compliance", "enrichment", "commissions", "onboarding", "dashboard", "audit", "settings"];
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
