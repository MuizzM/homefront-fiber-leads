// ── Capability model — the enterprise permission layer ────────────────────────
// Named, dotted capabilities (NOT raw role strings) are the unit of
// authorization. Roles map to capability SETS; BOTH the server middleware
// (requireCapability) and the client UI gate (useCan) authorize against the
// same map here, so the UI can never offer an action the API will reject.
//
// This composes with — does not replace — shared/permissions.ts (the territory
// rank model). New sensitive surfaces should gate on capabilities.

export type Role = "rep" | "team_lead" | "manager" | "admin" | "super_admin";

export type Capability =
  // Leads
  | "lead.read.assigned" | "lead.read.all"
  | "lead.assign" | "lead.reassign"
  | "lead.disposition.update" | "lead.note.write"
  // Commissions
  | "commission.read.self" | "commission.read.team" | "commission.read.all"
  | "commission.structure.manage"
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
  "lead.read.assigned", "lead.disposition.update", "lead.note.write",
  "commission.read.self", "dashboard.read.self",
];

// A team lead assigns/reassigns within scope, sees the team's leads + activity,
// and may configure commission structures (policy-permitting).
const TEAM_LEAD: readonly Capability[] = [
  ...REP,
  "lead.read.all", "lead.assign", "lead.reassign",
  "commission.read.team", "commission.structure.manage",
  "dashboard.read.team", "audit.read.team",
];

// A manager adds org-wide oversight reads.
const MANAGER: readonly Capability[] = [
  ...TEAM_LEAD,
  "commission.read.all", "dashboard.read.org", "audit.read.org",
];

// Admin (and super_admin) hold the full set including org policy + paying reps.
// payouts.pay is deliberately NOT in MANAGER — a manager is oversight/read; only
// the org owner (admin) may move real money.
const ADMIN: readonly Capability[] = [...MANAGER, "settings.manage.org", "payouts.pay"];

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  rep: new Set(REP),
  team_lead: new Set(TEAM_LEAD),
  manager: new Set(MANAGER),
  admin: new Set(ADMIN),
  super_admin: new Set(ADMIN),
};

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
  | "leads" | "assignments" | "commissions" | "dashboard" | "audit" | "settings";

export const CAPABILITY_DOMAIN: Record<Capability, CapabilityDomain> = {
  "lead.read.assigned": "leads",
  "lead.read.all": "leads",
  "lead.disposition.update": "leads",
  "lead.note.write": "leads",
  "lead.assign": "assignments",
  "lead.reassign": "assignments",
  "commission.read.self": "commissions",
  "commission.read.team": "commissions",
  "commission.read.all": "commissions",
  "commission.structure.manage": "commissions",
  "payouts.pay": "commissions",
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
  "audit.read.org", "settings.manage.org", "payouts.pay",
]);

export function isHighRisk(cap: Capability): boolean {
  return HIGH_RISK_CAPABILITIES.has(cap);
}

// Every capability, grouped by domain, in a stable domain order — the matrix
// and the "grouped capabilities" governance view render straight from this.
const DOMAIN_ORDER: CapabilityDomain[] = ["leads", "assignments", "commissions", "dashboard", "audit", "settings"];
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
