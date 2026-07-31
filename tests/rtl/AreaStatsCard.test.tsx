// The area's numbers, and the states real data actually arrives in.
//
// The card that prompted this showed "AREA WORKED 0.00% — 0 of 1150 leads" and
// nothing else. Two lessons are baked into these specs: a brand-new area sits at
// ZERO for its first week and must not look broken there, and every rate has to
// name its denominator on screen, because a number nobody can reproduce is a
// number nobody trusts.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AreaStatsCard } from "../../client/src/components/territory/AreaStatsCard";

const FULL = {
  total: 1150,
  availableBase: 1100,
  knocked: 275,
  sold: 22,
  untouched: 825,
  penetrationRate: 2,
  knockCompletionRate: 25,
  contactRate: 12.5,
  color: "#14C985",
};

describe("the operational number wins", () => {
  it("leads with doors worked against the available base", () => {
    render(<AreaStatsCard {...FULL} />);
    expect(screen.getByTestId("stat-knocked")).toHaveTextContent("275");
    expect(screen.getByText(/of 1,100 worked/)).toBeInTheDocument();
  });

  it("counts against availableBase, not the raw total", () => {
    // total includes doors nobody can sell — counting against it understates
    // every rep's progress on an area with a lot of exclusions.
    render(<AreaStatsCard {...FULL} />);
    expect(screen.queryByText(/of 1,150 worked/)).toBeNull();
  });

  it("falls back to total when no base was supplied", () => {
    // Older cached responses predate availableBase; showing "of 0" would be worse
    // than showing the slightly wrong denominator.
    render(<AreaStatsCard {...FULL} availableBase={undefined} />);
    expect(screen.getByText(/of 1,150 worked/)).toBeInTheDocument();
  });

  it("groups thousands, because 1150 and 11500 differ by a glance", () => {
    render(<AreaStatsCard {...FULL} />);
    expect(screen.getByText(/1,100/)).toBeInTheDocument();
  });
});

describe("a brand-new area is at zero and must not look broken", () => {
  const EMPTY = { total: 1150, availableBase: 1100, color: "#14C985" };

  it("still draws the ring track at 0%", () => {
    // THE case this card exists to survive. Without a muted track an empty ring
    // renders as nothing at all, which reads as a component that failed.
    render(<AreaStatsCard {...EMPTY} />);
    expect(screen.getByTestId("stat-ring-track")).toBeInTheDocument();
  });

  it("draws no progress arc at 0%, rather than a zero-length stub", () => {
    // A round line-cap at zero length still paints a dot — a dot on the ring at
    // 0% looks like 1%.
    render(<AreaStatsCard {...EMPTY} />);
    expect(screen.queryByTestId("stat-ring-arc")).toBeNull();
  });

  it("shows 0%, not an em dash or a blank", () => {
    render(<AreaStatsCard {...EMPTY} />);
    expect(screen.getByTestId("stat-ring")).toHaveTextContent("0%");
  });

  it("shows real zeroes in the secondary row", () => {
    render(<AreaStatsCard {...EMPTY} />);
    expect(screen.getByTestId("stat-sold")).toHaveTextContent("0");
    expect(screen.getByTestId("stat-untouched")).toHaveTextContent("0");
  });

  it("never renders NaN from a missing field", () => {
    // safeRate returns 0 rather than NaN upstream, but the card must not depend
    // on that — a NaN reaching the DOM is the kind of thing shipped for months.
    const { container } = render(<AreaStatsCard total={0} color="#14C985" />);
    expect(container.textContent).not.toMatch(/NaN|Infinity|undefined/);
  });
});

describe("the ring reads as a proportion", () => {
  it("draws an arc once there is progress", () => {
    render(<AreaStatsCard {...FULL} />);
    expect(screen.getByTestId("stat-ring-arc")).toBeInTheDocument();
  });

  it("offsets the arc in proportion to completion", () => {
    const { rerender } = render(<AreaStatsCard {...FULL} knockCompletionRate={25} />);
    const quarter = Number(screen.getByTestId("stat-ring-arc").getAttribute("stroke-dashoffset"));
    rerender(<AreaStatsCard {...FULL} knockCompletionRate={75} />);
    const threeQuarters = Number(screen.getByTestId("stat-ring-arc").getAttribute("stroke-dashoffset"));
    // More progress = less remaining dash offset.
    expect(threeQuarters).toBeLessThan(quarter);
  });

  it("clamps a rate above 100 instead of overdrawing the circle", () => {
    // Defensive: a denominator drift upstream should not wrap the arc around.
    render(<AreaStatsCard {...FULL} knockCompletionRate={140} />);
    expect(screen.getByTestId("stat-ring")).toHaveTextContent("100%");
    expect(Number(screen.getByTestId("stat-ring-arc").getAttribute("stroke-dashoffset"))).toBe(0);
  });

  it("clamps a negative rate to zero", () => {
    render(<AreaStatsCard {...FULL} knockCompletionRate={-5} />);
    expect(screen.getByTestId("stat-ring")).toHaveTextContent("0%");
  });

  it("wears the AREA's colour so the card matches its polygon", () => {
    render(<AreaStatsCard {...FULL} color="#F97316" />);
    expect(screen.getByTestId("stat-ring-track")).toHaveAttribute("stroke", "#F97316");
  });

  it("is announced to screen readers, since a ring is only visual", () => {
    render(<AreaStatsCard {...FULL} />);
    expect(screen.getByRole("img", { name: "25% complete" })).toBeInTheDocument();
  });
});

describe("percentages are readable, not merely accurate", () => {
  it("drops a pointless trailing zero", () => {
    render(<AreaStatsCard {...FULL} knockCompletionRate={42} />);
    expect(screen.getByTestId("stat-ring")).toHaveTextContent("42%");
  });

  it("keeps one decimal where it carries meaning", () => {
    // 0.4% rounded to 0% erases a week of work on a big area.
    render(<AreaStatsCard {...FULL} knockCompletionRate={0.4} />);
    expect(screen.getByTestId("stat-ring")).toHaveTextContent("0.4%");
  });
});

describe("every derived number names its denominator", () => {
  // "Penetration 2%" is unusable until you know 2% of what. The spec asks for
  // the formula to be reachable; these prove it is on screen, not in a doc.
  it("explains completion on demand", () => {
    render(<AreaStatsCard {...FULL} />);
    fireEvent.click(screen.getByTestId("stat-info-completion"));
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Doors knocked ÷/);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/unavailable and disqualified/);
  });

  it("explains penetration on demand", () => {
    render(<AreaStatsCard {...FULL} />);
    fireEvent.click(screen.getByTestId("stat-info-penetration"));
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Sales ÷/);
  });

  it("keeps the tooltip closed until asked", () => {
    render(<AreaStatsCard {...FULL} />);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes on blur, so a tap elsewhere dismisses it on a phone", () => {
    render(<AreaStatsCard {...FULL} />);
    const btn = screen.getByTestId("stat-info-penetration");
    fireEvent.click(btn);
    fireEvent.blur(btn);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("labels the trigger for screen readers rather than shipping a bare glyph", () => {
    render(<AreaStatsCard {...FULL} />);
    expect(screen.getByRole("button", { name: "How penetration is calculated" })).toBeInTheDocument();
  });
});

describe("the info triggers are real targets", () => {
  // Audit finding: the ⓘ was a 24px button with no focus treatment. It keeps
  // its compact glyph but carries a 44px hit halo and the shared focus ring.
  it("every info button has an expanded hit area and the shared focus ring", () => {
    render(<AreaStatsCard {...FULL} />);
    for (const id of ["stat-info-completion", "stat-info-penetration", "stat-info-contact-rate"]) {
      const btn = screen.getByTestId(id);
      expect(btn.className).toMatch(/after:-inset-2\.5/);
      expect(btn.className).toMatch(/focus-visible:ring-2/);
    }
  });

  it("still toggles its tooltip when tapped", () => {
    render(<AreaStatsCard {...FULL} />);
    const btn = screen.getByTestId("stat-info-completion");
    fireEvent.click(btn);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("optional figures stay out of the way", () => {
  it("hides the contact rate line when there is no contact rate", () => {
    render(<AreaStatsCard {...FULL} contactRate={undefined} />);
    expect(screen.queryByTestId("stat-contact")).toBeNull();
  });

  it("shows it when there is one", () => {
    render(<AreaStatsCard {...FULL} />);
    expect(screen.getByTestId("stat-contact")).toHaveTextContent("12.5% contact rate");
  });
});
