// The Buyer score presentation contract: the tier carries the colour class
// (gold, navy, muted; never green or red), an unscored door reads as unscored
// rather than as a zero, and the property-page section shows the math that
// adds up to the headline, says why a removed door has no score, and renders
// nothing for a door the job has not reached yet.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BuyerScorePill, BuyerScoreTile } from "../../client/src/components/BuyerScorePill";
import { BuyerScoreSection } from "../../client/src/components/BuyerScoreSection";

describe("BuyerScorePill / BuyerScoreTile", () => {
  it("maps the score to its tier and never paints a tier green or red", () => {
    const { unmount } = render(<BuyerScorePill score={8.4} label />);
    const likely = screen.getByTestId("buyer-score-pill");
    expect(likely).toHaveAttribute("data-tier", "likely");
    expect(likely).toHaveTextContent("8.4");
    expect(likely).toHaveTextContent("Likely");
    expect(likely.className).toMatch(/gold/);
    expect(likely.className).not.toMatch(/green|emerald|red|rose|success|destructive/);
    unmount();

    render(<BuyerScorePill score={6.3} />);
    expect(screen.getByTestId("buyer-score-pill")).toHaveAttribute("data-tier", "possible");
  });

  it("an unscored door says so instead of showing a zero", () => {
    render(<BuyerScorePill score={null} />);
    expect(screen.getByTestId("buyer-score-pill")).toHaveTextContent("No score yet");
    expect(screen.getByTestId("buyer-score-pill")).not.toHaveTextContent("0.0");
  });

  it("the list tile keeps one decimal and labels itself for a screen reader", () => {
    render(<BuyerScoreTile score={7.95} />);
    const tile = screen.getByTestId("buyer-score-tile");
    expect(tile).toHaveTextContent("8.0");
    expect(tile).toHaveAttribute("aria-label", "Buyer score 8.0, Likely");
  });
});

describe("BuyerScoreSection", () => {
  const reasons = JSON.stringify([
    { key: "base", label: "Every door starts here", delta: 5 },
    { key: "fiber", label: "Fresh fiber here, no subscriber yet", delta: 1.6 },
    { key: "competitor", label: "On Spectrum cable today", delta: 0.8 },
    { key: "not_home", label: "Knocked once, nobody home", delta: -0.3 },
  ]);

  it("renders nothing for a door the job has not scored yet", () => {
    const { container } = render(<BuyerScoreSection lead={{ leadStatus: "prospect" }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the headline, the tier, and a reasons list whose deltas add up to the score", () => {
    render(<BuyerScoreSection lead={{ leadStatus: "prospect", buyerScore: 7.1, buyerScoreReasons: reasons, buyerScoredAt: "2026-08-22T04:00:00.000Z" }} />);
    expect(screen.getByTestId("buyer-score-headline")).toHaveTextContent("7.1");
    expect(screen.getByText("Possible buyer")).toBeInTheDocument();
    const rows = screen.getByTestId("buyer-score-reasons").querySelectorAll("li");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("5.0");
    expect(rows[1]).toHaveTextContent("+1.6");
    expect(rows[3]).toHaveTextContent("-0.3");
    // No minus-sign or dash glyphs in copy: ASCII hyphen only.
    expect(screen.getByTestId("buyer-score-section").textContent).not.toMatch(/[–—−]/);
  });

  it("says why a removed door has no score", () => {
    render(<BuyerScoreSection lead={{ leadStatus: "prospect", buyerScore: null, buyerScoredAt: "2026-08-22T04:00:00.000Z", doNotKnock: 1 }} />);
    expect(screen.getByTestId("buyer-score-removed")).toHaveTextContent("asked us not to return");
  });
});
