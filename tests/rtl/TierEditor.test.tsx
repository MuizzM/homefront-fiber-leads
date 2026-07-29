// Editing the weekly commission ladder.
//
// The rule is RETROACTIVE: the band a rep lands in re-prices EVERY sale that
// week. Sell 6 at the 1-6 band and it's 6 x $150; sell a 7th and all seven pay
// $200. A $500 swing on one sale, so the ladder has to be editable without
// fighting the manager.
//
// THE BUG THIS FILE PINS DOWN: the old max handler did
//     parseInt(e.target.value, 10) || t.minimumSales
// so clearing the field to retype it collapsed the band to a single sale —
// 1-6 became 1-1, which pushed the next band to 2+. Every attempt to fix it
// snapped back on the next keystroke, and the range became uneditable.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { TierEditor } from "../../client/src/components/commission/TierEditor";
import type { CommissionTier } from "../../shared/commissionTiers";

const DEFAULT: CommissionTier[] = [
  { position: 0, minimumSales: 1, maximumSales: 6, rateCents: 15000, label: "1-6" },
  { position: 1, minimumSales: 7, maximumSales: null, rateCents: 20000, label: "7+" },
];

/** Wrapper that actually holds state, the way the Team page does. A controlled
 *  component tested with a stub onChange hides exactly this class of bug. */
function Harness({ initial = DEFAULT }: { initial?: CommissionTier[] }) {
  const [tiers, setTiers] = useState(initial);
  return <TierEditor tiers={tiers} onChange={setTiers} />;
}

describe("clearing the range field does not collapse the band", () => {
  it("survives an empty field mid-edit", () => {
    // The exact reported symptom: clear the "6" and the band became 1-1 and the
    // next band jumped to 2+. The field must be allowed to be empty.
    render(<Harness />);
    fireEvent.change(screen.getByTestId("tier-max-0"), { target: { value: "" } });
    expect(screen.getByTestId("tier-max-0")).toHaveValue("");
    expect(screen.getByTestId("tier-row-1")).toHaveTextContent("7");
  });

  it("lets a manager retype the range from empty", () => {
    render(<Harness />);
    const max = screen.getByTestId("tier-max-0");
    fireEvent.change(max, { target: { value: "" } });
    fireEvent.change(max, { target: { value: "1" } });
    fireEvent.change(max, { target: { value: "12" } });
    fireEvent.blur(max);
    expect(screen.getByTestId("tier-max-0")).toHaveValue("12");
    expect(screen.getByTestId("tier-row-1")).toHaveTextContent("13");  // re-tiled
  });

  it("reverts an unusable draft on blur instead of silently becoming 1", () => {
    // Snapping to the minimum is what made the old editor unrecoverable.
    render(<Harness />);
    const max = screen.getByTestId("tier-max-0");
    fireEvent.change(max, { target: { value: "" } });
    fireEvent.blur(max);
    expect(screen.getByTestId("tier-max-0")).toHaveValue("6");
  });

  it("ignores a range below the band's own minimum", () => {
    render(<Harness />);
    const max = screen.getByTestId("tier-max-0");
    fireEvent.change(max, { target: { value: "0" } });
    fireEvent.blur(max);
    expect(screen.getByTestId("tier-max-0")).toHaveValue("6");
  });
});

describe("removing a band", () => {
  it("removes the one that was clicked", () => {
    render(<Harness initial={[
      ...DEFAULT.slice(0, 1),
      { position: 1, minimumSales: 7, maximumSales: 12, rateCents: 20000, label: "7-12" },
      { position: 2, minimumSales: 13, maximumSales: null, rateCents: 25000, label: "13+" },
    ]} />);
    expect(screen.getAllByTestId(/^tier-row-/)).toHaveLength(3);
    fireEvent.click(screen.getByTestId("tier-remove-1"));
    const rows = screen.getAllByTestId(/^tier-row-/);
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId("tier-rate-1")).toHaveValue("250");  // 13+ survived
  });

  it("re-tiles so no gap is left behind", () => {
    render(<Harness initial={[
      ...DEFAULT.slice(0, 1),
      { position: 1, minimumSales: 7, maximumSales: 12, rateCents: 20000, label: "7-12" },
      { position: 2, minimumSales: 13, maximumSales: null, rateCents: 25000, label: "13+" },
    ]} />);
    fireEvent.click(screen.getByTestId("tier-remove-0"));
    expect(screen.getByTestId("tier-row-0")).toHaveTextContent("1");
  });

  it("makes the delete stick even with an edit in flight", () => {
    // Drafts are keyed by row index. A draft left behind would land on whichever
    // band shifts up into that slot, resurrecting the value that was removed.
    render(<Harness initial={[
      ...DEFAULT.slice(0, 1),
      { position: 1, minimumSales: 7, maximumSales: 12, rateCents: 20000, label: "7-12" },
      { position: 2, minimumSales: 13, maximumSales: null, rateCents: 25000, label: "13+" },
    ]} />);
    fireEvent.change(screen.getByTestId("tier-max-1"), { target: { value: "99" } });
    fireEvent.click(screen.getByTestId("tier-remove-1"));
    expect(screen.getAllByTestId(/^tier-row-/)).toHaveLength(2);
    expect(screen.queryByDisplayValue("99")).toBeNull();
  });

  it("keeps the last band, since a plan with no bands pays nothing", () => {
    render(<Harness initial={DEFAULT.slice(1)} />);
    expect(screen.getByTestId("tier-remove-0")).toBeDisabled();
  });

  it("names the band it will remove, not just its position", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Remove band 1-6" })).toBeInTheDocument();
  });
});

describe("adding a band", () => {
  it("splits an open ladder into 1-6 and 7+", () => {
    // The ladder managers describe out loud: six sales, then the step up.
    render(<Harness initial={[
      { position: 0, minimumSales: 1, maximumSales: null, rateCents: 15000, label: "1+" },
    ]} />);
    fireEvent.click(screen.getByTestId("tier-add"));
    expect(screen.getByTestId("tier-max-0")).toHaveValue("6");
    expect(screen.getByTestId("tier-row-1")).toHaveTextContent("7");
  });

  it("keeps the final band open-ended so beating the top still pays", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("tier-add"));
    const rows = screen.getAllByTestId(/^tier-row-/);
    expect(screen.getByTestId(`tier-open-${rows.length - 1}`)).toHaveTextContent("and up");
  });

  it("does not crash on an empty ladder", () => {
    // The old addBand read `last.minimumSales` off undefined and threw. An empty
    // ladder is reachable, and this button should be the way out of it.
    const onChange = vi.fn();
    render(<TierEditor tiers={[]} onChange={onChange} />);
    expect(() => fireEvent.click(screen.getByTestId("tier-add"))).not.toThrow();
    expect(onChange.mock.calls[0][0]).toHaveLength(1);
  });

  it("shows the headroom before the limit is reached", () => {
    render(<Harness />);
    expect(screen.getByTestId("tier-remaining")).toHaveTextContent("6 more available");
  });
});

describe("the label follows the band it describes", () => {
  it("renames a band when its range changes", () => {
    // The label is persisted and shown on the rep's statement. A band paying
    // 1-12 that still calls itself "1-6" is a payroll dispute.
    const onChange = vi.fn();
    render(<TierEditor tiers={DEFAULT} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("tier-max-0"), { target: { value: "12" } });
    expect(onChange.mock.calls.at(-1)![0][0].label).toBe("1-12");
  });
});

describe("the retroactive jump is shown, not left to be inferred", () => {
  it("prices the whole week at the band rate, not progressively", () => {
    // 7 sales at the 7+ band is 7 x $200 = $1,400 — not 6 x $150 + $200.
    render(<Harness />);
    expect(screen.getByTestId("tier-preview")).toHaveTextContent("$1,400");
  });

  it("shows the bottom and top of a closed band", () => {
    render(<Harness />);
    const preview = screen.getByTestId("tier-preview");
    expect(preview).toHaveTextContent("$150");   // 1 sale at $150
    expect(preview).toHaveTextContent("$900");   // 6 sales at $150
  });
});

describe("a fat-fingered paste cannot build an absurd plan", () => {
  it("refuses a rate beyond any real commission", () => {
    // The server is authoritative, but rejecting at the input beats a
    // validation error after someone has saved a $10bn-per-sale ladder.
    render(<Harness />);
    const rate = screen.getByTestId("tier-rate-0");
    fireEvent.change(rate, { target: { value: "99999999999" } });
    fireEvent.blur(rate);
    expect(screen.getByTestId("tier-rate-0")).toHaveValue("150");
  });

  it("refuses a band boundary no rep could cross in a week", () => {
    render(<Harness />);
    const max = screen.getByTestId("tier-max-0");
    fireEvent.change(max, { target: { value: "999999" } });
    fireEvent.blur(max);
    expect(screen.getByTestId("tier-max-0")).toHaveValue("6");
  });

  it("still accepts an ordinary rate typed digit by digit", () => {
    render(<Harness />);
    const rate = screen.getByTestId("tier-rate-0");
    fireEvent.change(rate, { target: { value: "" } });
    fireEvent.change(rate, { target: { value: "2" } });
    fireEvent.change(rate, { target: { value: "22" } });
    fireEvent.change(rate, { target: { value: "225" } });
    fireEvent.blur(rate);
    expect(screen.getByTestId("tier-rate-0")).toHaveValue("225");
  });
});
