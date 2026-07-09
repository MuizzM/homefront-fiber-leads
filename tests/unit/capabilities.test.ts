import { describe, it, expect } from "vitest";
import {
  can, capabilitiesFor, ROLE_CAPABILITIES, type Capability,
  groupedCapabilities, rolesWithCapability, isHighRisk, CAPABILITY_DOMAIN,
} from "../../shared/capabilities";

/**
 * CONTRACT (shared/capabilities.ts): named capabilities, not role if/else.
 * Reps cannot assign leads or manage commission structures; team lead+ can;
 * unknown roles fail closed. Both server middleware and UI gates read this map.
 */

describe("capability matrix — hard permission rules", () => {
  it("reps CANNOT assign/reassign leads or manage commission structures", () => {
    for (const cap of ["lead.assign", "lead.reassign", "commission.structure.manage"] as Capability[]) {
      expect(can("rep", cap)).toBe(false);
    }
  });

  it("reps CAN work assigned leads, disposition, note, and read their own results", () => {
    for (const cap of ["lead.read.assigned", "lead.disposition.update", "lead.note.write",
                        "commission.read.self", "dashboard.read.self"] as Capability[]) {
      expect(can("rep", cap)).toBe(true);
    }
    // ...but NOT the whole org's leads or others' commissions.
    expect(can("rep", "lead.read.all")).toBe(false);
    expect(can("rep", "commission.read.team")).toBe(false);
  });

  it("team lead CAN assign leads and manage commission structures", () => {
    for (const cap of ["lead.assign", "lead.reassign", "commission.structure.manage",
                        "commission.read.team", "audit.read.team"] as Capability[]) {
      expect(can("team_lead", cap)).toBe(true);
    }
    // ...but not org-wide reads or org settings.
    expect(can("team_lead", "commission.read.all")).toBe(false);
    expect(can("team_lead", "settings.manage.org")).toBe(false);
  });

  it("manager adds org-wide oversight; admin adds org settings", () => {
    expect(can("manager", "commission.read.all")).toBe(true);
    expect(can("manager", "dashboard.read.org")).toBe(true);
    expect(can("manager", "settings.manage.org")).toBe(false);
    expect(can("admin", "settings.manage.org")).toBe(true);
  });

  it("capabilities are strictly widening rep ⊂ team_lead ⊂ manager ⊂ admin", () => {
    const rep = ROLE_CAPABILITIES.rep, tl = ROLE_CAPABILITIES.team_lead;
    const mgr = ROLE_CAPABILITIES.manager, admin = ROLE_CAPABILITIES.admin;
    for (const c of rep) expect(tl.has(c)).toBe(true);
    for (const c of tl) expect(mgr.has(c)).toBe(true);
    for (const c of mgr) expect(admin.has(c)).toBe(true);
    expect(admin.size).toBeGreaterThan(mgr.size);
  });

  it("super_admin mirrors admin; unknown/undefined roles fail closed", () => {
    expect(capabilitiesFor("super_admin").sort()).toEqual(capabilitiesFor("admin").sort());
    expect(can(undefined, "lead.read.assigned")).toBe(false);
    expect(can("intern", "lead.read.assigned" as Capability)).toBe(false);
    expect(capabilitiesFor("nope")).toEqual([]);
  });
});

describe("capability governance metadata", () => {
  it("groups EVERY capability by domain with no drops or dupes", () => {
    const groups = groupedCapabilities();
    const flat = groups.flatMap(g => g.capabilities);
    const all = Object.keys(CAPABILITY_DOMAIN) as Capability[];
    expect(flat.slice().sort()).toEqual(all.slice().sort());
    expect(new Set(flat).size).toBe(flat.length); // each cap in exactly one group
    expect(groups.map(g => g.domain)).toContain("commissions");
  });

  it("'who can do this' returns the right roles for a governed capability", () => {
    // structure management: team_lead+, never rep
    expect(rolesWithCapability("commission.structure.manage").sort())
      .toEqual(["admin", "manager", "super_admin", "team_lead"]);
    expect(rolesWithCapability("commission.structure.manage")).not.toContain("rep");
    // org settings: admin tier only
    expect(rolesWithCapability("settings.manage.org").sort()).toEqual(["admin", "super_admin"]);
    // a rep-level capability includes everyone
    expect(rolesWithCapability("lead.disposition.update")).toContain("rep");
  });

  it("flags money/ownership/org-data/policy capabilities as high-risk", () => {
    for (const cap of ["lead.assign", "commission.structure.manage", "settings.manage.org", "audit.read.org"] as Capability[]) {
      expect(isHighRisk(cap)).toBe(true);
    }
    // everyday rep capabilities are not high-risk
    expect(isHighRisk("lead.note.write")).toBe(false);
    expect(isHighRisk("dashboard.read.self")).toBe(false);
  });
});
