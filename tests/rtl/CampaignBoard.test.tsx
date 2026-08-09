// The campaign card is a MOTIVATION surface that quotes real money, so the
// things worth pinning are the ones a rep would act on and be wrong about:
//
//   1. The reward, the headline, and the next step render VERBATIM from the
//      server's progress — the client never re-derives them, because a second
//      encoding of the rule is a second thing that can disagree with the ledger.
//   2. The countdown reads in hours and minutes, and the card visibly changes
//      under an hour. "2h left" and "12m left" must not look the same.
//   3. A per-sale campaign draws NO progress bar — there is no finish line to
//      be 80% of the way to, and inventing one is a lie about the rules.
//   4. An empty board renders nothing at all. A standing "no contests running"
//      panel is a permanent reminder that nothing is happening.
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { CampaignBoard, CampaignCard, countdown, type RepCampaign } from "../../client/src/components/CampaignBoard";

const HOUR = 3_600_000;

function campaign(over: Partial<RepCampaign> = {}): RepCampaign {
  return {
    id: 1,
    name: "Morning grind",
    description: "Pure effort.",
    rewardCents: 5_000,
    trigger: { kind: "knocks_by_time", knocks: 40, byHourLocal: 12 },
    endsAtMs: Date.now() + 4 * HOUR,
    progress: {
      current: 18, target: 40, pct: 45, met: false,
      msRemaining: 4 * HOUR,
      headline: "18 of 40 knocks before 12 PM",
      nextStep: "22 more knocks before 12 PM.",
    },
    earnedCents: 0,
    ...over,
  };
}

function renderCard(c: RepCampaign) {
  return render(<CampaignCard campaign={c} />);
}

/** A board with a fixed server payload — no network, no retries. */
function renderBoard(campaigns: RepCampaign[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qc.setQueryData(["/api/me/campaigns"], { campaigns });
  return render(
    <QueryClientProvider client={qc}><CampaignBoard /></QueryClientProvider>,
  );
}

describe("countdown", () => {
  it("reads in hours and minutes above an hour, minutes below", () => {
    expect(countdown(2 * HOUR + 14 * 60_000)).toBe("2h 14m left");
    expect(countdown(48 * 60_000)).toBe("48m left");
    expect(countdown(2 * 86_400_000 + 3 * HOUR)).toBe("2d 3h left");
  });

  it("never shows a bare zero or a negative - the last minute says so in words", () => {
    expect(countdown(30_000)).toBe("Ends soon");
    expect(countdown(0)).toBe("Ended");
    expect(countdown(-5_000)).toBe("Ended");
  });
});

describe("what the rep reads", () => {
  it("shows the money, the server's headline, and the server's next step verbatim", () => {
    renderCard(campaign());
    expect(screen.getByTestId("campaign-reward-1").textContent).toBe("$50");
    // Verbatim: the client must not paraphrase a rule it does not evaluate.
    expect(screen.getByTestId("campaign-headline-1").textContent).toBe("18 of 40 knocks before 12 PM");
    expect(screen.getByTestId("campaign-next-1").textContent).toBe("22 more knocks before 12 PM.");
  });

  it("renders cents when the reward is not a whole dollar", () => {
    renderCard(campaign({ rewardCents: 7_550 }));
    expect(screen.getByTestId("campaign-reward-1").textContent).toBe("$75.50");
  });

  it("draws the bar at the server's percentage", () => {
    renderCard(campaign());
    expect((screen.getByTestId("campaign-bar-1") as HTMLElement).style.width).toBe("45%");
  });

  it("draws NO bar for a per-sale campaign - there is no finish line to fill", () => {
    renderCard(campaign({
      trigger: { kind: "per_sale" },
      progress: { ...campaign().progress, current: 2, target: 3, pct: 66, headline: "2 sales in this campaign", nextStep: "Every sale while this runs pays the bonus." },
    }));
    expect(screen.queryByTestId("campaign-bar-1")).toBeNull();
    expect(screen.getByTestId("campaign-headline-1").textContent).toBe("2 sales in this campaign");
  });

  it("drops the next step and shows the earned amount once it is won", () => {
    renderCard(campaign({
      earnedCents: 5_000,
      progress: { ...campaign().progress, current: 40, pct: 100, met: true, headline: "40 knocks in - bonus earned", nextStep: "" },
    }));
    expect(screen.queryByTestId("campaign-next-1")).toBeNull();
    expect(screen.getByTestId("campaign-earned-1").textContent).toContain("$50");
  });
});

describe("urgency is visible, not just written", () => {
  it("a campaign with hours left and one with minutes left do not look the same", () => {
    const { unmount } = renderCard(campaign({ endsAtMs: Date.now() + 4 * HOUR }));
    const relaxed = screen.getByTestId("campaign-countdown-1").className;
    unmount();

    // Half a minute of slack: the card re-reads the clock during render, so an
    // exact 12-minute deadline floors to "11m" and the assertion would be about
    // test timing rather than about the card.
    renderCard(campaign({ id: 1, endsAtMs: Date.now() + 12.5 * 60_000 }));
    const urgent = screen.getByTestId("campaign-countdown-1");
    expect(urgent.textContent).toContain("12m left");
    expect(urgent.className).not.toBe(relaxed);
  });
});

describe("the board", () => {
  it("renders nothing at all when no campaign is running", () => {
    const { container } = renderBoard([]);
    expect(screen.queryByTestId("campaign-board")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders one card per live campaign", () => {
    renderBoard([campaign(), campaign({ id: 2, name: "Every sale pays", trigger: { kind: "per_sale" } })]);
    expect(screen.getByTestId("campaign-1")).toBeTruthy();
    expect(screen.getByTestId("campaign-2")).toBeTruthy();
  });
});
