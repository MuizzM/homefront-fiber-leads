import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  openLeadOnFieldMap,
  queueLeadMapTarget,
  takeLeadMapTarget,
} from "../../client/src/lib/leadMapNavigation";

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("lead list to Field Map navigation", () => {
  it("hands off a real lead and rooftop exactly once", () => {
    const store = memoryStore();
    expect(queueLeadMapTarget({ leadId: 234614, lat: 34.9904495, lng: -80.4632216 }, store)).toBe(true);
    expect(takeLeadMapTarget(store)).toEqual({ leadId: 234614, lat: 34.9904495, lng: -80.4632216 });
    expect(takeLeadMapTarget(store)).toBeNull();
  });

  it("keeps the lead selection but drops invalid coordinates", () => {
    const store = memoryStore();
    expect(queueLeadMapTarget({ leadId: 7, lat: 190, lng: -400 }, store)).toBe(true);
    expect(takeLeadMapTarget(store)).toEqual({ leadId: 7 });
  });

  it("rejects invalid lead ids and malformed stored payloads", () => {
    const store = memoryStore();
    expect(queueLeadMapTarget({ leadId: -1, lat: 35, lng: -80 }, store)).toBe(false);
    store.setItem("homefront:field-map-target", "not-json");
    expect(takeLeadMapTarget(store)).toBeNull();
    expect(takeLeadMapTarget(store)).toBeNull();
  });

  it("opens the stable Field Map route with a one-use rooftop target", () => {
    const store = memoryStore();
    const navigations: string[] = [];
    expect(openLeadOnFieldMap(
      { leadId: 88, lat: 35.9557, lng: -80.0053 },
      (path) => navigations.push(path),
      store,
    )).toBe(true);
    expect(navigations).toEqual(["/map"]);
    expect(takeLeadMapTarget(store)).toEqual({ leadId: 88, lat: 35.9557, lng: -80.0053 });
  });

  it("wires Leads to the kept-alive map and MapView to the one-use target", () => {
    const root = process.cwd();
    const leads = readFileSync(join(root, "client/src/pages/Leads.tsx"), "utf8");
    const map = readFileSync(join(root, "client/src/pages/MapView.tsx"), "utf8");
    expect(leads).toContain("openLeadOnFieldMap({ leadId: lead.id");
    expect(map).toContain("takeLeadMapTarget()");
    expect(map).toContain("setSelectedLeadId(target.leadId)");
    expect(map).toContain("if (mappable) flyToLead(mappable)");
  });

  it("routes every scanner/fresh-lead surface to the rooftop handoff", () => {
    const root = process.cwd();
    const dashboard = readFileSync(join(root, "client/src/pages/Dashboard.tsx"), "utf8");
    const fiber = readFileSync(join(root, "client/src/pages/FiberIntelligence.tsx"), "utf8");
    const ranked = readFileSync(join(root, "client/src/components/fiber/RankedLeads.tsx"), "utf8");
    const scanner = readFileSync(join(root, "client/src/pages/KineticScanner.tsx"), "utf8");

    expect(dashboard).not.toContain("#/leads?id=");
    expect(dashboard).toContain("openLeadOnFieldMap({ leadId: a.leadId!");
    expect(fiber.match(/openLeadOnFieldMap\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(ranked).toContain("openLeadOnFieldMap({");
    expect(scanner.match(/openLeadOnFieldMap\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(scanner).toContain("Convert and open in field");
  });
});
