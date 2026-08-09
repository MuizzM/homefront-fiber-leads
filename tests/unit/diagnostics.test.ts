import { describe, it, expect } from "vitest";
import { buildDiagnostics, type RawEvent } from "../../shared/diagnostics";

/**
 * CONTRACT (shared/diagnostics.ts): the ops panel reads a PURE aggregation of
 * the activity stream — health score docks for real failures, denials surface
 * as a governance feed, and everything is windowed deterministically.
 */

const NOW = 1_800_000_000_000;
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString();
const ev = (action: string, mins: number, details: unknown = {}): RawEvent =>
  ({ action, at: ago(mins), userId: 1, details });

describe("buildDiagnostics", () => {
  it("all-clear stream → healthScore 100 and every card green/ok", () => {
    const model = buildDiagnostics([ev("lead.assigned", 5), ev("commission.auto_created", 10)], NOW);
    expect(model.healthScore).toBe(100);
    expect(model.cards.find(c => c.module === "commission" && c.label === "Commission engine")!.severity).toBe("ok");
    expect(model.recentFailures).toHaveLength(0);
  });

  it("a commission-no-structure failure is CRITICAL and docks the score", () => {
    const model = buildDiagnostics([ev("commission.no_structure", 3, { leadId: 70, repId: 14 })], NOW);
    const card = model.cards.find(c => c.label === "Commission engine")!;
    expect(card.severity).toBe("critical");
    expect(card.value).toBe(1);
    expect(model.healthScore).toBe(85); // 100 - 15
    expect(model.recentFailures[0].detail).toContain("lead 70");
  });

  it("permission denials surface as a warning feed and escalate with volume", () => {
    const many = Array.from({ length: 6 }, (_, i) => ev("permission.denied", i, { need: "lead.assign", path: "/api/leads/1/assign" }));
    const model = buildDiagnostics(many, NOW);
    const card = model.cards.find(c => c.module === "permission")!;
    expect(card.value).toBe(6);
    expect(card.severity).toBe("warning"); // ≥5
    expect(model.recentDenials[0].detail).toContain("lead.assign");
    expect(model.healthScore).toBe(82); // 100 - min(6,10)*3
  });

  it("windows events out - anything older than the window is ignored", () => {
    const model = buildDiagnostics([
      ev("commission.no_structure", 10),          // in 24h window
      ev("commission.no_structure", 60 * 48),     // 48h ago — excluded
    ], NOW, 24);
    expect(model.cards.find(c => c.label === "Commission engine")!.value).toBe(1);
    expect(model.totalEvents).toBe(1);
  });

  it("sensitive-actions feed collects structure edits, assignments, and denials", () => {
    const model = buildDiagnostics([
      ev("commission_structure.updated", 2, { version: 2 }),
      ev("lead.assigned", 4, { assignedTo: "Z" }),
      ev("permission.denied", 6, { need: "lead.assign" }),
      ev("lead.disposition.update", 8), // NOT sensitive
    ], NOW);
    const actions = model.sensitiveActions.map(e => e.action);
    expect(actions).toContain("commission_structure.updated");
    expect(actions).toContain("lead.assigned");
    expect(actions).toContain("permission.denied");
    expect(actions).not.toContain("lead.disposition.update");
    // denials read as a warning; governed edits as info
    expect(model.sensitiveActions.find(e => e.action === "permission.denied")!.severity).toBe("warning");
  });

  it("flags a stale read model and docks health when the stream goes quiet", () => {
    const fresh = buildDiagnostics([ev("lead.assigned", 5)], NOW);
    expect(fresh.readModelStale).toBe(false);
    expect(fresh.readModelAgeMs).toBeGreaterThanOrEqual(0);

    // Newest event is 8h old (> 6h threshold) → stale, -10 health.
    const stale = buildDiagnostics([ev("lead.assigned", 60 * 8)], NOW, 24);
    expect(stale.readModelStale).toBe(true);
    expect(stale.healthScore).toBe(90);

    // No events at all → null age, not "stale".
    const empty = buildDiagnostics([], NOW);
    expect(empty.readModelAgeMs).toBeNull();
    expect(empty.readModelStale).toBe(false);
  });
});
