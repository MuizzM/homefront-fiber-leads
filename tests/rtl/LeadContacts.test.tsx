// The doorstep contact panel.
//
// One test here matters more than the rest: a DNC number must never be a tel:
// link. On a phone, a tel: link under a thumb IS a dialled call — so rendering
// a blocked number as an anchor turns "we show it for context" into "one tap to
// violate the TCPA". Everything else is presentation; that one is the feature.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LeadContacts } from "../../client/src/components/LeadContacts";
import type { TracedPhone } from "../../shared/tracerfy";

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);
const DAY = 86_400_000;

function phone(over: Partial<TracedPhone> = {}): TracedPhone {
  return {
    number: "+15551230001", lineType: "wireless", confidence: 0.9,
    dncFlags: {}, scrubbedAtMs: NOW - DAY, ...over,
  };
}

const ADDR = "123 Main St, Concord, NC 28025";

describe("the name — the thing a skip trace is actually bought for", () => {
  it("shows the traced owner name as the headline", () => {
    render(<LeadContacts ownerName="Dana Whitfield" address={ADDR} nowMs={NOW} />);
    expect(screen.getByTestId("lead-contact-name").textContent).toBe("Dana Whitfield");
    expect(screen.getByText(/ask for/i)).toBeTruthy();
  });

  it("falls back to the street without inventing a person", () => {
    render(<LeadContacts ownerName={null} address={ADDR} phones={[phone()]} nowMs={NOW} />);
    expect(screen.getByTestId("lead-contact-name").textContent).toBe("Resident at 123 Main St");
    expect(screen.getByText(/no name on file/i)).toBeTruthy();
  });

  it("renders nothing at all when there is neither a name nor a number", () => {
    const { container } = render(<LeadContacts ownerName={null} address={ADDR} nowMs={NOW} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("a DNC number stays visible but cannot be dialled", () => {
  const dncPhone = phone({ number: "+15559990000", dncFlags: { federalDnc: true } });

  it("keeps the number ON the card", () => {
    render(<LeadContacts ownerName="Dana Whitfield" address={ADDR} phones={[dncPhone]} nowMs={NOW} />);
    const row = screen.getByTestId("lead-phone-+15559990000");
    expect(row.textContent).toContain("(555) 999-0000");
  });

  it("is NOT a tel: link — this is the whole safety property", () => {
    render(<LeadContacts ownerName="D W" address={ADDR} phones={[dncPhone]} nowMs={NOW} />);
    const row = screen.getByTestId("lead-phone-+15559990000");
    expect(row.tagName).not.toBe("A");
    expect(row.closest("a")).toBeNull();
    expect(row.querySelector("a")).toBeNull();
    expect(document.querySelectorAll('a[href^="tel:"]')).toHaveLength(0);
  });

  it("tags it clearly for a knocker", () => {
    render(<LeadContacts ownerName="D W" address={ADDR} phones={[dncPhone]} nowMs={NOW} />);
    const row = screen.getByTestId("lead-phone-+15559990000");
    expect(within(row).getByTestId("lead-phone-badge").textContent).toBe("Door only");
    expect(row.textContent).toMatch(/federal do not call/i);
  });

  it("explains an EXPIRED scrub differently from a registry hit", () => {
    // Different problems: one is permanent and about the person, the other is
    // ours and clears itself. A rep who can't tell them apart ignores the badge.
    render(<LeadContacts ownerName="D W" address={ADDR} nowMs={NOW}
      phones={[phone({ number: "+15558880000", scrubbedAtMs: NOW - 90 * DAY })]} />);
    expect(screen.getByTestId("lead-phone-+15558880000").textContent).toMatch(/expired/i);
  });

  it("blocks a never-scrubbed number rather than assuming it is clear", () => {
    render(<LeadContacts ownerName="D W" address={ADDR} nowMs={NOW}
      phones={[phone({ number: "+15557770000", scrubbedAtMs: null })]} />);
    const row = screen.getByTestId("lead-phone-+15557770000");
    expect(row.getAttribute("data-dnc")).toBe("true");
    expect(row.closest("a")).toBeNull();
  });
});

describe("a clean number is one tap to call", () => {
  it("renders as a tel: link with an OK badge", () => {
    render(<LeadContacts ownerName="Dana Whitfield" address={ADDR} phones={[phone()]} nowMs={NOW} />);
    const row = screen.getByTestId("lead-phone-+15551230001");
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("href")).toBe("tel:+15551230001");
    expect(within(row).getByTestId("lead-phone-badge").textContent).toBe("OK to call");
  });

  it("formats for reading aloud at arm's length", () => {
    render(<LeadContacts ownerName="D W" address={ADDR} phones={[phone()]} nowMs={NOW} />);
    expect(screen.getByTestId("lead-phone-+15551230001").textContent).toContain("(555) 123-0001");
  });
});

describe("a mixed household — the realistic case", () => {
  // Today's real numbers: 264 traced, 149 blocked, 101 clean. Most cards will
  // carry both kinds at once, and the two must not be confusable.
  const phones = [
    phone({ number: "+15551110000" }),
    phone({ number: "+15552220000", dncFlags: { federalDnc: true } }),
    phone({ number: "+15553330000", dncFlags: { tcpaLitigator: true } }),
  ];

  it("shows every number, links only the callable one", () => {
    render(<LeadContacts ownerName="Dana Whitfield" address={ADDR} phones={phones} nowMs={NOW} />);
    const list = screen.getByTestId("lead-contact-phones");
    expect(within(list).getAllByTestId("lead-phone-badge")).toHaveLength(3);
    const links = list.querySelectorAll('a[href^="tel:"]');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("tel:+15551110000");
  });

  it("leads with the litigator warning on the number that carries it", () => {
    render(<LeadContacts ownerName="D W" address={ADDR} phones={phones} nowMs={NOW} />);
    expect(screen.getByTestId("lead-phone-+15553330000").textContent).toMatch(/litigator/i);
  });
});
