// The property card's perceived-latency contract, pinned.
//
// The card must (1) render its ENTIRE content synchronously from the prop
// payload — no fetch gates the open, no spinner exists anywhere, (2) animate
// open/close on the sheet base's GPU keyframes only — the large surface never
// carries transition-all or a >=300ms duration, (3) fire its actions
// (Add as lead / Open lead / close) synchronously on the tap, and (4) render
// nothing at all when no property is selected.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import { LeadCard, type CardProperty } from "../../client/src/components/LeadCard";

// jsdom lacks the pointer/media APIs Radix and readCardVariant touch.
beforeAll(() => {
  const proto = Element.prototype as any;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
  if (!window.matchMedia) {
    (window as any).matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
  }
});

function baseProperty(overrides: Partial<CardProperty> = {}): CardProperty {
  return {
    address: "148 Maple St",
    city: "Rockwell",
    state: "NC",
    zip: "28138",
    lat: 34.9,
    lng: -79.9,
    isNewFiber: true,
    billingStatus: "N",
    maxDownloadMbps: 2000,
    leadScore: 87,
    source: "scan",
    ...overrides,
  };
}

function renderCard(over: Record<string, any> = {}) {
  const onClose = vi.fn();
  const onAddLead = vi.fn();
  const onOpen = vi.fn();
  const utils = render(
    <LeadCard
      property={baseProperty()}
      onClose={onClose}
      onAddLead={onAddLead}
      onOpen={onOpen}
      {...over}
    />,
  );
  return { ...utils, onClose, onAddLead, onOpen };
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("lead card perceived-latency contract", () => {
  it("renders the whole card synchronously from the prop payload - no fetch, no spinner", () => {
    renderCard();
    // No awaits before any of these: the tap that selected the pin painted this.
    const card = screen.getByTestId("lead-card");
    expect(card).toHaveTextContent("148 Maple St");
    expect(card).toHaveTextContent("Rockwell, NC 28138");
    expect(card).toHaveTextContent("New-fiber lead");
    expect(card).toHaveTextContent("2 Gig");
    expect(screen.getByTestId("lead-card-add")).toBeInTheDocument();
    expect(screen.getByTestId("lead-card-directions")).toHaveAttribute(
      "href", expect.stringContaining("google.com/maps"),
    );
    // Pure prop-driven UI: opening the card never touches the network…
    expect(apiRequest).not.toHaveBeenCalled();
    // …and there is no spinner anywhere to wait on.
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("the large sheet surface animates on GPU keyframes only - no transition-all, nothing >=300ms", () => {
    renderCard();
    const cls = screen.getByTestId("lead-card").className;
    // The shadcn sheet base's bare `transition` (= all) is overridden off.
    expect(cls).toMatch(/\btransition-none\b/);
    expect(cls).not.toMatch(/\btransition-all\b|(^|\s)transition(\s|$)/);
    expect(cls).toMatch(/\bwill-change-transform\b/);
    // Enter 200ms / exit 150ms from the base variants; nothing slower.
    expect(cls).toMatch(/data-\[state=open\]:duration-200/);
    expect(cls).toMatch(/data-\[state=closed\]:duration-150/);
    expect(cls).not.toMatch(/\bduration-3\d\d\b|\bduration-[5-9]\d\d\b/);
  });

  it("Add as lead fires synchronously on the tap with the full property", async () => {
    const { onAddLead } = renderCard();
    await userEvent.click(screen.getByTestId("lead-card-add"));
    expect(onAddLead).toHaveBeenCalledTimes(1);
    expect(onAddLead).toHaveBeenCalledWith(expect.objectContaining({ address: "148 Maple St" }));
  });

  it("a saved lead shows Open lead instead and fires onOpen(id) on the tap", async () => {
    const { onOpen } = renderCard({ property: baseProperty({ id: 42, source: "lead" }) });
    expect(screen.queryByTestId("lead-card-add")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("lead-card-open"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(42);
  });

  it("close fires immediately from the sheet's close affordance", async () => {
    const { onClose } = renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing at all when no property is selected", () => {
    renderCard({ property: null });
    expect(screen.queryByTestId("lead-card")).not.toBeInTheDocument();
  });
});

// ── Skip-trace contacts are actually MOUNTED, in every variant ──────────────
//
// This block exists because of a real miss: PushSetupCard and TeamFeed both
// shipped fully built and referenced from no page at all. A component test
// passes happily against a component nothing renders, so these assert the WIRING
// — and do it per variant, because the card has three layouts and inserting into
// one of them is exactly how this regresses.
describe("the doorstep contact panel is wired into every card variant", () => {
  const traced = {
    ownerName: "Dana Whitfield",
    phones: [
      { number: "+15551110000", lineType: "wireless" as const, confidence: 0.9, dncFlags: {}, scrubbedAtMs: Date.now() - 86_400_000 },
      { number: "+15552220000", lineType: "landline" as const, confidence: 0.8, dncFlags: { federalDnc: true }, scrubbedAtMs: Date.now() - 86_400_000 },
    ],
  };

  for (const variant of [1, 2, 3] as const) {
    it(`variant ${variant} shows the name and both numbers`, () => {
      window.location.hash = `#/map?cardVariant=${variant}`;
      renderCard({ property: baseProperty(traced) });

      expect(screen.getByTestId("lead-contact-name").textContent).toBe("Dana Whitfield");
      expect(screen.getByTestId("lead-phone-+15551110000")).toBeTruthy();
      // The DNC number is STILL on the card — that is the requirement.
      expect(screen.getByTestId("lead-phone-+15552220000")).toBeTruthy();
    });

    it(`variant ${variant} never renders a DNC number as a tel: link`, () => {
      window.location.hash = `#/map?cardVariant=${variant}`;
      renderCard({ property: baseProperty(traced) });

      const blocked = screen.getByTestId("lead-phone-+15552220000");
      expect(blocked.closest("a")).toBeNull();
      // …while the clean one IS dialable.
      expect(screen.getByTestId("lead-phone-+15551110000").getAttribute("href")).toBe("tel:+15551110000");
    });
  }

  it("stays out of the way on a card with no traced contacts", () => {
    window.location.hash = "#/map";
    renderCard();
    expect(screen.queryByTestId("lead-contacts")).toBeNull();
  });
});
