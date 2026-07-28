// Editing weekly sales tiers.
//
// The rule is RETROACTIVE: the band a rep lands in sets the rate for EVERY sale
// that week. 6 sales at the 1–6 band is 6 × $150 = $900; a 7th makes all seven
// pay $200 = $1,400. A $500 swing on one sale, so the editor has to show it.
//
// The other half is that an invalid plan must be unreachable, not merely
// reported: a gap between bands means a rep sells into a hole and earns nothing.
import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TierEditor } from "../../client/src/components/commission/TierEditor";
import type { CommissionTier } from "../../shared/commissionTiers";

/** The plan the operator actually asked for: 1–6 @ $150, 7+ @ $200. */
const SPEC: CommissionTier[] = [
  { position: 0, minimumSales: 1, maximumSales: 6, rateCents: 15000, label: "1–6" },
  { position: 1, minimumSales: 7, maximumSales: null, rateCents: 20000, label: "7+" },
];

/**
 * TierEditor is CONTROLLED, so a bare vi.fn() leaves the value frozen and every
 * keystroke re-edits the original string. This harness holds real state (as the
 * dialog does) and reports each committed value, which is what lets the typing
 * tests mean anything.
 */
function Harness({ initial, onChange }: { initial: CommissionTier[]; onChange: (t: CommissionTier[]) => void }) {
  const [tiers, setTiers] = useState(initial);
  return <TierEditor tiers={tiers} onChange={next => { setTiers(next); onChange(next); }} />;
}

function setup(tiers: CommissionTier[] = SPEC) {
  const onChange = vi.fn();
  render(<Harness initial={tiers} onChange={onChange} />);
  return { onChange };
}

describe("the retroactive payout preview", () => {
  it("shows a week's pay at each band, not just the rate", () => {
    setup();
    const preview = screen.getByTestId("tier-preview");
    // 1 sale in the low band, 7 in the high band — 7 × $200, NOT 6×150 + 200.
    expect(within(preview).getByText(/1 sale \(1–6\)/)).toBeInTheDocument();
    expect(within(preview).getByText("$1,400")).toBeInTheDocument();
  });

  it("makes the jump visible: the 7th sale re-prices the whole week", () => {
    setup();
    const preview = screen.getByTestId("tier-preview");
    // $150 for one sale at the bottom band vs $1,400 once the 7th lands.
    expect(within(preview).getByText("$150")).toBeInTheDocument();
    expect(within(preview).getByText("$1,400")).toBeInTheDocument();
  });

  it("hides the preview while the plan is invalid rather than showing wrong money", () => {
    render(<TierEditor onChange={vi.fn()} tiers={[
      { position: 0, minimumSales: 1, maximumSales: 6, rateCents: 15000, label: "" },
      { position: 1, minimumSales: 7, maximumSales: 12, rateCents: 20000, label: "" }, // not open-ended
    ]} />);
    expect(screen.queryByTestId("tier-preview")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/open-ended/i);
  });
});

describe("bands stay tiled — an invalid plan is unreachable", () => {
  it("editing a band's top pushes the next band's bottom", async () => {
    // No gap can be typed into existence: minimums are derived, not entered.
    const user = userEvent.setup();
    const { onChange } = setup();
    // fireEvent.change, not user.type: jsdom's number inputs don't support text
    // selection, so a "retype" would append (6 → 68) and test nothing real. This
    // delivers the committed value the way a replaced field does.
    fireEvent.change(screen.getByTestId("tier-max-0"), { target: { value: "8" } });

    const last = onChange.mock.calls.at(-1)![0] as CommissionTier[];
    expect(last[0].maximumSales).toBe(8);
    expect(last[1].minimumSales).toBe(9);      // pushed, not left at 7
    expect(last[1].maximumSales).toBeNull();   // still open-ended
  });

  it("adding a band closes the old open end and keeps the new one open", async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByTestId("tier-add"));

    const next = onChange.mock.calls.at(-1)![0] as CommissionTier[];
    expect(next).toHaveLength(3);
    expect(next[1].maximumSales).not.toBeNull();          // was open, now closed
    expect(next[2].maximumSales).toBeNull();              // the new open end
    expect(next[2].minimumSales).toBe(next[1].maximumSales! + 1); // contiguous
  });

  it("removing a band re-tiles the rest", async () => {
    const user = userEvent.setup();
    const three: CommissionTier[] = [
      { position: 0, minimumSales: 1, maximumSales: 6, rateCents: 15000, label: "" },
      { position: 1, minimumSales: 7, maximumSales: 12, rateCents: 20000, label: "" },
      { position: 2, minimumSales: 13, maximumSales: null, rateCents: 25000, label: "" },
    ];
    const onChange = vi.fn();
    render(<Harness initial={three} onChange={onChange} />);
    await user.click(screen.getByTestId("tier-remove-1"));

    const next = onChange.mock.calls.at(-1)![0] as CommissionTier[];
    expect(next).toHaveLength(2);
    expect(next[1].minimumSales).toBe(7);      // closed the hole left by the middle band
    expect(next[1].maximumSales).toBeNull();
  });

  it("refuses to remove the last remaining band", async () => {
    const user = userEvent.setup();
    const one: CommissionTier[] = [{ position: 0, minimumSales: 1, maximumSales: null, rateCents: 15000, label: "" }];
    const onChange = vi.fn();
    render(<Harness initial={one} onChange={onChange} />);
    expect(screen.getByTestId("tier-remove-0")).toBeDisabled();
    await user.click(screen.getByTestId("tier-remove-0"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never lets a band's top fall below its own bottom", async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    fireEvent.change(screen.getByTestId("tier-max-0"), { target: { value: "0" } }); // below its own minimum

    const last = onChange.mock.calls.at(-1)![0] as CommissionTier[];
    expect(last[0].maximumSales).toBeGreaterThanOrEqual(last[0].minimumSales);
  });

  it("the final band has no maximum input at all", () => {
    setup();
    // Not merely validated — there is nothing to type into, so the open end
    // cannot be closed by accident.
    expect(screen.getByTestId("tier-max-0")).toBeInTheDocument();
    expect(screen.queryByTestId("tier-max-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("tier-row-1")).toHaveTextContent("7+");
  });
});

describe("rates", () => {
  it("edits in dollars but reports integer cents", async () => {
    // Money never becomes a float: $175 must arrive as 17500, not 17499.999.
    const user = userEvent.setup();
    const { onChange } = setup();
    fireEvent.change(screen.getByTestId("tier-rate-0"), { target: { value: "175" } });

    const last = onChange.mock.calls.at(-1)![0] as CommissionTier[];
    expect(last[0].rateCents).toBe(17500);
    expect(Number.isInteger(last[0].rateCents)).toBe(true);
  });

  it("shows the existing rate in dollars", () => {
    setup();
    expect(screen.getByTestId("tier-rate-0")).toHaveValue(150);
    expect(screen.getByTestId("tier-rate-1")).toHaveValue(200);
  });
});
