// ── Choosing the plan, and seeing the contract change ───────────────────────
//
// The promise of this control is that a manager can set the terms AND read what
// the rep will sign, before sending. So the tests hold it to that: the preview
// must track the choice, the errors must appear beside the field rather than
// behind the Send button, and editing a ladder must not be able to produce one
// the commission engine would refuse to pay against.
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { CompTermsEditor } from "../../client/src/components/onboarding/CompTermsEditor";
import { DEFAULT_COMMISSION_TERMS, type CommissionTerms } from "@shared/commissionTerms";

/** Wrapper holding state, so edits round-trip the way they do in the page. */
function Harness({ initial = DEFAULT_COMMISSION_TERMS, onTerms }: { initial?: CommissionTerms; onTerms?: (t: CommissionTerms) => void }) {
  const [terms, setTerms] = useState<CommissionTerms>(initial);
  return <CompTermsEditor value={terms} onChange={(next) => { setTerms(next); onTerms?.(next); }} />;
}

const preview = () => screen.getByTestId("comp-contract-preview").textContent ?? "";

describe("CompTermsEditor", () => {
  it("opens on the terms it was given, not a blank form", () => {
    render(<Harness />);
    expect(screen.getByTestId("comp-structure-tiered")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("comp-tier-rows")).toBeInTheDocument();
    expect(screen.getByTestId("comp-reserve-percent")).toHaveValue(10);
  });

  it("THE REQUIREMENT: switching to flat rewrites the contract wording", () => {
    render(<Harness />);
    expect(preview()).toMatch(/RETROACTIVE tier ladder/i);

    fireEvent.click(screen.getByTestId("comp-structure-flat"));
    expect(screen.getByTestId("comp-structure-flat")).toHaveAttribute("aria-checked", "true");
    expect(preview()).toMatch(/for each qualified sale/i);
    expect(preview()).not.toMatch(/RETROACTIVE tier ladder/i);
  });

  it("THE REQUIREMENT: editing a rate changes the money in the contract", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("comp-tier-0-rate"), { target: { value: "175" } });
    expect(preview()).toContain("$175");
  });

  it("a changed reserve percentage shows up in the wording immediately", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("comp-reserve-percent"), { target: { value: "20" } });
    expect(preview()).toContain("20%");
    expect(preview()).toContain("80%");
  });

  it("says plainly when nothing is withheld", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("comp-reserve-percent"), { target: { value: "0" } });
    expect(preview()).toMatch(/No chargeback reserve is withheld/i);
  });

  it("adding a band leaves a valid ladder, not a gap", () => {
    // The previous top band is open-ended; adding below it must close it, or
    // validateTiers rejects the result and the manager gets an error for doing
    // the obvious thing.
    render(<Harness />);
    const before = screen.getAllByTestId(/^comp-tier-\d+$/).length;
    fireEvent.click(screen.getByTestId("comp-tier-add"));
    expect(screen.getAllByTestId(/^comp-tier-\d+$/)).toHaveLength(before + 1);
    expect(screen.queryByTestId("comp-terms-errors")).toBeNull();
  });

  it("removing a band keeps the ladder open-ended at the top", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("comp-tier-3-remove"));
    expect(screen.queryByTestId("comp-terms-errors")).toBeNull();
    // The new last row is the unbounded one, so its max is not editable.
    const rows = screen.getAllByTestId(/^comp-tier-\d+$/);
    const lastMax = within(rows[rows.length - 1]).getByLabelText(/maximum sales/i);
    expect(lastMax).toBeDisabled();
  });

  it("will not let the last band be removed - a plan needs at least one", () => {
    render(<Harness initial={{ ...DEFAULT_COMMISSION_TERMS, tiers: [DEFAULT_COMMISSION_TERMS.tiers[0]] }} />);
    expect(screen.getByTestId("comp-tier-0-remove")).toBeDisabled();
  });

  it("shows an invalid ladder as an error beside the fields, not on submit", () => {
    // A gap: band 1 ends at 7, band 2 starts at 20.
    render(<Harness />);
    fireEvent.change(screen.getByTestId("comp-tier-1-min"), { target: { value: "20" } });
    expect(screen.getByTestId("comp-terms-errors")).toBeInTheDocument();
  });

  it("surfaces a flat plan with no rate as an error", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("comp-structure-flat"));
    fireEvent.change(screen.getByTestId("comp-flat-rate"), { target: { value: "0" } });
    expect(screen.getByTestId("comp-terms-errors")).toHaveTextContent(/rate per qualified sale/i);
  });

  it("summarises the offer in one line for the collapsed state", () => {
    render(<Harness />);
    expect(screen.getByTestId("comp-terms-summary")).toHaveTextContent("10% reserve");
    fireEvent.click(screen.getByTestId("comp-structure-flat"));
    expect(screen.getByTestId("comp-terms-summary")).toHaveTextContent(/Flat \$/);
  });

  it("hands the caller the edited terms, ready to send", () => {
    const onTerms = vi.fn();
    render(<Harness onTerms={onTerms} />);
    fireEvent.change(screen.getByTestId("comp-reserve-percent"), { target: { value: "12" } });
    expect(onTerms).toHaveBeenCalled();
    expect(onTerms.mock.calls.at(-1)?.[0].reservePercent).toBe(12);
  });

  it("the preview can be collapsed without losing the summary", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("comp-contract-toggle"));
    expect(screen.queryByTestId("comp-contract-preview")).toBeNull();
    expect(screen.getByTestId("comp-terms-summary")).toBeInTheDocument();
  });
});
