import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GENERIC_DISCLOSURE_REMINDER, LeadScriptPanel, STANDARD_OPENER } from "@/components/calling/LeadScriptPanel";
import * as callingApi from "@/lib/callingApi";

vi.mock("@/lib/callingApi", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/callingApi")>();
  return { ...actual, getLeadScript: vi.fn() };
});

/**
 * Fixtures mirror the REAL wire shape from server/calling/scriptEngine.ts
 * (GeneratedScript): objectionHandlers is an OBJECT keyed by slug, and
 * provenance is `model: "rules" | "llm"` — there is no engine field.
 * getLeadScript is mocked to run the production normalization choke point so
 * these tests exercise the same object→array path the panel uses live.
 */
const wireFixture: callingApi.LeadScriptWire = {
  version: "1",
  model: "llm",
  generatedAt: new Date().toISOString(),
  cached: false,
  context: {
    leadId: 7, city: "Lexington", state: "NC", fiberCategory: "fresh",
    freshCityCount21d: 3, onComingSoonWatchlist: false, nearestFreshStreet: "Maple St",
  },
  sections: {
    opener: "Hi, this is Alex with Homefront Solutions — Kinetic's authorized fiber partner. Quick one, this is a sales call: Kinetic just dropped brand-new fiber in your neighborhood and we're running the rollout right now.",
    neighborhoodHook: "Kinetic just dropped brand-new fiber in your neighborhood — 3 homes in Lexington connected in the last three weeks, including homes on Maple St.",
    valueProposition: "Kinetic Fiber runs on a fiber-optic line rather than older cable or copper, which means symmetrical upload and download speeds and a connection that holds up when everyone is home.",
    objectionHandlers: {
      price: "That's a completely fair question. Pricing depends on the speed tier you choose.",
      currentProvider: "That makes sense — most people I speak with already have internet.",
      renter: "Good question, and you're not alone — plenty of renters get fiber.",
      worksFine: "Glad to hear it's working — that's honestly the best starting point.",
    },
    close: "Here's all I'd suggest: let me run a quick availability and speed check for 148 Maple St right now.",
    complianceFooter: "---- COMPLIANCE NOTES (REP GUIDANCE — NEVER READ ALOUD UNLESS REQUIRED) ----\n1. Open every call the way the opener does: your real first name, Homefront Solutions (Kinetic's authorized fiber partner), the words \"sales call\", and why you're calling.",
  },
  script: "[OPENER — read verbatim]\n...",
};

/** Route the wire fixture through the real normalization the panel consumes. */
function mockScript(wire: callingApi.LeadScriptWire) {
  vi.mocked(callingApi.getLeadScript).mockImplementation(() => Promise.resolve(callingApi.normalizeLeadScript(wire)));
}

function renderPanel(leadId = 7) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LeadScriptPanel leadId={leadId} />
    </QueryClientProvider>,
  );
}

describe("normalizeLeadScript (wire → panel choke point)", () => {
  it("maps the object-form objectionHandlers to humanized rows", () => {
    const normalized = callingApi.normalizeLeadScript(wireFixture);
    expect(normalized.sections?.objectionHandlers).toEqual([
      { objection: "Price", response: expect.stringContaining("fair question") },
      { objection: "Current provider", response: expect.stringContaining("already have internet") },
      { objection: "Renter", response: expect.stringContaining("renters get fiber") },
      { objection: "Works fine", response: expect.stringContaining("best starting point") },
    ]);
  });

  it("passes an array form through untouched", () => {
    const rows = [{ objection: "Too expensive", response: "Fair." }];
    const normalized = callingApi.normalizeLeadScript({ sections: { objectionHandlers: rows } });
    expect(normalized.sections?.objectionHandlers).toEqual(rows);
  });
});

describe("LeadScriptPanel", () => {
  beforeEach(() => {
    mockScript(wireFixture);
  });

  it("renders the literal server shape — 4 objection rows, no crash", async () => {
    const user = userEvent.setup();
    renderPanel(7);
    expect(await screen.findByTestId("script-opener")).toHaveTextContent("Hi, this is Alex with Homefront Solutions");
    expect(screen.getByTestId("script-opener")).toHaveTextContent("sales call");
    expect(callingApi.getLeadScript).toHaveBeenCalledWith(7);
    expect(screen.getByTestId("script-hook")).toHaveTextContent("Kinetic just dropped brand-new fiber in your neighborhood");
    expect(screen.getByText("Value prop (1)")).toBeInTheDocument();
    expect(screen.getByText("Close")).toBeInTheDocument();
    expect(screen.getByTestId("script-disclosure")).toHaveTextContent("COMPLIANCE NOTES");
    expect(screen.getByTestId("script-provenance")).toHaveTextContent("Personalized script");

    await user.click(screen.getByText("Objection handlers (4)"));
    expect(screen.getByText("Price")).toBeInTheDocument();
    expect(screen.getByText("Current provider")).toBeInTheDocument();
    expect(screen.getByText("Renter")).toBeInTheDocument();
    expect(screen.getByText("Works fine")).toBeInTheDocument();
    await user.click(screen.getByText("Current provider"));
    expect(screen.getByText(/most people I speak with already have internet/)).toBeInTheDocument();
  });

  it("collapses value prop / objections / close by default while the disclosure stays pinned and visible", async () => {
    renderPanel();
    const disclosure = await screen.findByTestId("script-disclosure");
    expect(screen.getByTestId("script-value-prop")).not.toHaveAttribute("open");
    expect(screen.getByTestId("script-objections")).not.toHaveAttribute("open");
    expect(screen.getByTestId("script-close")).not.toHaveAttribute("open");
    // Disclosure is never inside a collapsible element.
    expect(disclosure.closest("details")).toBeNull();
    expect(disclosure).toBeVisible();
  });

  it("labels model:\"rules\" output as a standard script", async () => {
    mockScript({ ...wireFixture, model: "rules" });
    renderPanel();
    expect(await screen.findByTestId("script-provenance")).toHaveTextContent("Standard script");
    expect(screen.getByTestId("script-provenance")).not.toHaveTextContent("Personalized");
  });

  it("labels model:\"llm\" output as a personalized script without inventing a model name", async () => {
    mockScript({ ...wireFixture, model: "llm" });
    renderPanel();
    const badge = await screen.findByTestId("script-provenance");
    expect(badge).toHaveTextContent("Personalized script");
    // The wire never sends the real model name — the badge must not invent one.
    expect(badge.textContent?.replace("Personalized script", "").trim()).toBe("");
  });

  it("degrades a partial payload section-by-section, including object-form handlers, with the standard disclosure reminder", async () => {
    mockScript({
      model: "rules",
      sections: {
        opener: "Hi, this is the fiber team.",
        objectionHandlers: { worksFine: "Glad to hear it — fiber is about headroom." },
      },
    });
    renderPanel();
    expect(await screen.findByTestId("script-opener")).toHaveTextContent("Hi, this is the fiber team.");
    expect(screen.queryByTestId("script-hook")).not.toBeInTheDocument();
    expect(screen.queryByTestId("script-value-prop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("script-close")).not.toBeInTheDocument();
    // Object-form handlers still render (normalized), even when partial.
    expect(screen.getByText("Objection handlers (1)")).toBeInTheDocument();
    // No complianceFooter in the payload → pinned standard reminder instead.
    const disclosure = screen.getByTestId("script-disclosure");
    expect(disclosure).toHaveTextContent("Standard disclosure reminder");
    expect(disclosure).toHaveTextContent(GENERIC_DISCLOSURE_REMINDER);
    expect(disclosure.closest("details")).toBeNull();
    expect(screen.getByTestId("script-provenance")).toHaveTextContent("Standard script");
  });

  it("error state: labeled standard opener + standard disclosure reminder, no fake content", async () => {
    vi.mocked(callingApi.getLeadScript).mockRejectedValue(new Error("404 script generation unavailable"));
    renderPanel();
    // The panel retries once before settling into its honest error state.
    expect(await screen.findByText("Script unavailable", undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText("Standard opener")).toBeInTheDocument();
    expect(screen.getByText(STANDARD_OPENER)).toBeInTheDocument();
    // Fallback opener carries the required disclosure elements.
    expect(STANDARD_OPENER).toContain("Homefront Solutions");
    expect(STANDARD_OPENER).toContain("sales call");
    // Disclosure reminder is pinned even in the error state.
    const disclosure = screen.getByTestId("script-disclosure");
    expect(disclosure).toHaveTextContent(GENERIC_DISCLOSURE_REMINDER);
    expect(disclosure.closest("details")).toBeNull();
    // No provenance badge and none of the personalized fixture leaks through.
    expect(screen.queryByTestId("script-provenance")).not.toBeInTheDocument();
    expect(screen.queryByText(/including homes on Maple St/)).not.toBeInTheDocument();
  });
});
