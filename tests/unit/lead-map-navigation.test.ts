import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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

  it("wires Leads to the kept-alive map and MapView to the one-use target", () => {
    const root = process.cwd();
    const leads = readFileSync(join(root, "client/src/pages/Leads.tsx"), "utf8");
    const map = readFileSync(join(root, "client/src/pages/MapView.tsx"), "utf8");
    expect(leads).toContain("queueLeadMapTarget({ leadId: lead.id");
    expect(leads).toContain('navigate("/map")');
    expect(map).toContain("takeLeadMapTarget()");
    expect(map).toContain("setSelectedLeadId(target.leadId)");
    expect(map).toContain("if (mappable) flyToLead(mappable)");
  });
});
