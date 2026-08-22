// ── Rulebook ─────────────────────────────────────────────────────────────────
//
// The page's one promise is that it cannot drift from the code: every
// threshold it shows is read from the shared constant the app runs on. These
// tests pin that by asserting the rendered sentences against those same
// constants, so a threshold change that forgot this page cannot exist.
import { render, screen, within, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Rulebook, { buildRules } from "../../client/src/pages/Rulebook";
import { DISCOUNT_MAX_M, SCORE_SATURATION } from "../../shared/doorPriority";
import { DEFAULT_RETRO_TIERS } from "../../shared/commissionTiers";
import { DEFAULT_REFERRAL_CONFIG } from "../../shared/referral";
import { DEFAULT_TERRITORY_THRESHOLDS } from "../../shared/territoryHealth";
import { DEFAULT_RECOVERY_POLICY } from "../../shared/orderRecovery";
import { DEFAULT_GEO_CONFIG } from "../../shared/geoVerify";
import { METRIC_DEFS } from "../../shared/repMetrics";

describe("Rulebook", () => {
  it("states the next-door rule from the shared constants", () => {
    render(<Rulebook />);
    const card = screen.getByTestId("rule-next-door");
    expect(card).toHaveTextContent(`${DISCOUNT_MAX_M} m of walking`);
    expect(card).toHaveTextContent(`min(score / ${SCORE_SATURATION}, 1)`);
  });

  it("lists every commission tier at its rate", () => {
    render(<Rulebook />);
    const card = screen.getByTestId("rule-commission-tiers");
    for (const tier of DEFAULT_RETRO_TIERS) {
      expect(card).toHaveTextContent(`${tier.label} $${tier.rateCents / 100} per sale`);
    }
  });

  it("states the referral, territory and recovery thresholds", () => {
    render(<Rulebook />);
    const r = DEFAULT_REFERRAL_CONFIG;
    expect(screen.getByTestId("rule-referral")).toHaveTextContent(`${r.requiredApprovedSales} approved sales within ${r.qualificationWindowDays} days of hire earns $${r.rewardCents / 100}`);
    const t = DEFAULT_TERRITORY_THRESHOLDS;
    expect(screen.getByTestId("rule-territory-health")).toHaveTextContent(`stale after ${t.staleHours} h silent`);
    expect(screen.getByTestId("rule-territory-health")).toHaveTextContent(`Under ${t.minDoorsForJudgement} eligible doors`);
    const rec = DEFAULT_RECOVERY_POLICY;
    expect(screen.getByTestId("rule-stalled-orders")).toHaveTextContent(`has not moved in ${rec.staleSubmittedDays} days`);
    expect(screen.getByTestId("rule-verified-knock")).toHaveTextContent(`within ${DEFAULT_GEO_CONFIG.maxDistanceM} m of the door`);
  });

  it("carries every metric formula the question-mark buttons open", () => {
    render(<Rulebook />);
    const table = screen.getByTestId("rulebook-metrics");
    for (const def of Object.values(METRIC_DEFS)) {
      expect(within(table).getByText(def.label)).toBeInTheDocument();
      expect(table).toHaveTextContent(def.formula);
    }
  });

  it("filters by domain without losing a rule", () => {
    render(<Rulebook />);
    const all = buildRules();
    expect(screen.getByTestId("rulebook-rules").querySelectorAll("section")).toHaveLength(all.length);
    // Radix tabs activate on pointer down, not on a synthetic click.
    fireEvent.mouseDown(screen.getByTestId("rulebook-domain-pay"), { button: 0 });
    const pay = all.filter(rule => rule.domain === "pay");
    expect(pay.length).toBeGreaterThan(0);
    expect(screen.getByTestId("rulebook-rules").querySelectorAll("section")).toHaveLength(pay.length);
    expect(screen.queryByTestId("rulebook-metrics")).toBeNull();
  });

  it("uses the one page-title treatment", () => {
    render(<Rulebook />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("Rulebook");
    expect(h1.className).toContain("text-xl");
    expect(h1.className).toContain("font-bold");
  });
});
