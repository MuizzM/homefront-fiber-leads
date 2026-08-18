import { describe, expect, it } from "vitest";
import { actionLabel } from "../../client/src/pages/Dashboard";

describe("dashboard activity labels", () => {
  it("keeps curated labels for common events", () => {
    expect(actionLabel("commission.approved")).toBe("Commission approved");
  });

  it("turns dotted and underscored internal event names into readable copy", () => {
    expect(actionLabel("lead.note_updated")).toBe("Lead note updated");
    expect(actionLabel("commission.week.rep_failed")).toBe("Commission week rep failed");
  });

  it("uses a safe label for an empty event name", () => {
    expect(actionLabel("___")).toBe("Activity");
  });
});
