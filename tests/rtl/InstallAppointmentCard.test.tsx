// One tap, the rep's own Messages app, the whole text already written.
//
// The rep has just closed a sale and is still on the doorstep. The message has
// to come from THEIR number — a text from the person the customer just spoke to
// gets read and gets a reply; a shortcode does not. The app never sends
// anything, so there is no provider and no campaign registration; it hands off
// to the OS composer and the rep sees the message before it goes.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InstallAppointmentCard } from "../../client/src/components/install/InstallAppointmentCard";

const BASE = {
  status: "scheduled" as const,
  customerName: "Dana Whitfield",
  customerPhone: "+1 (555) 123-4567",
  dateLabel: "Tue, Aug 4",
  timeWindowLabel: "8:00–10:00 AM",
  repName: "Rae",
  companyName: "Home Front",
  platform: "ios" as const,
};

const href = () => screen.getByTestId("install-send-text").getAttribute("href")!;

describe("the text opens in the rep's own Messages app", () => {
  it("is an anchor with an sms: href, not a button", () => {
    // The OS hand-off needs a real navigation. window.open on an sms: URL is
    // blocked or silently ignored in several mobile browsers, which would make
    // the primary action of this card do nothing.
    render(<InstallAppointmentCard {...BASE} />);
    const el = screen.getByTestId("install-send-text");
    expect(el.tagName).toBe("A");
    expect(el.getAttribute("href")).toMatch(/^sms:/);
  });

  it("uses the iOS separator on iOS", () => {
    render(<InstallAppointmentCard {...BASE} />);
    expect(href()).toContain("&body=");
    expect(href()).not.toContain("?body=");
  });

  it("uses the Android separator on Android", () => {
    render(<InstallAppointmentCard {...BASE} platform="android" />);
    expect(href()).toContain("?body=");
  });

  it("normalises the number a rep typed by hand", () => {
    render(<InstallAppointmentCard {...BASE} />);
    expect(href()).toContain("sms:+15551234567");
  });
});

describe("the message the customer receives", () => {
  const body = () => decodeURIComponent(href().split("body=")[1]);

  it("greets them by first name, not by their full record", () => {
    render(<InstallAppointmentCard {...BASE} />);
    expect(body()).toContain("Hi Dana,");
    expect(body()).not.toContain("Whitfield");
  });

  it("names the rep and the company before the date", () => {
    // An unknown number opening with an install date reads as spam.
    render(<InstallAppointmentCard {...BASE} />);
    expect(body().indexOf("Rae")).toBeLessThan(body().indexOf("Aug 4"));
    expect(body()).toContain("Home Front");
  });

  it("carries the window and the date", () => {
    render(<InstallAppointmentCard {...BASE} />);
    expect(body()).toContain("Tue, Aug 4");
    expect(body()).toContain("8:00–10:00 AM");
  });
});

describe("it will not half-render a message to a real customer", () => {
  it("blocks the send when a detail is missing, and says which", () => {
    // "Hi , your install is set for " is worse than a control that declines to
    // arm — the rep is on a doorstep and will not always proofread.
    render(<InstallAppointmentCard {...BASE} dateLabel="" />);
    expect(screen.queryByTestId("install-send-text")).toBeNull();
    expect(screen.getByTestId("install-send-reason")).toHaveTextContent(/dateLabel/);
  });

  it("blocks the send on an unusable phone number, and says why in plain words", () => {
    render(<InstallAppointmentCard {...BASE} customerPhone="123" />);
    expect(screen.queryByTestId("install-send-text")).toBeNull();
    expect(screen.getByTestId("install-send-reason")).toHaveTextContent(/mobile number/i);
  });

  it("never shows a blocked control without a reason beside it", () => {
    // The dead-Reclaim-button failure this codebase already shipped once: a
    // control that looks armed, does nothing, and explains nothing.
    render(<InstallAppointmentCard {...BASE} customerPhone="" />);
    expect(screen.getByTestId("install-send-blocked")).toBeInTheDocument();
    expect(screen.getByTestId("install-send-reason").textContent?.trim().length).toBeGreaterThan(0);
  });
});

describe("the appointment reads correctly at a glance", () => {
  it("shows the timezone with the window, as one fact", () => {
    render(<InstallAppointmentCard {...BASE} timezoneLabel="CT" />);
    expect(screen.getByTestId("install-window")).toHaveTextContent("8:00–10:00 AM CT");
  });

  it("reads cleanly with no timezone", () => {
    render(<InstallAppointmentCard {...BASE} />);
    expect(screen.getByTestId("install-window").textContent).toBe("8:00–10:00 AM");
  });

  it("labels status in words, never colour alone", () => {
    render(<InstallAppointmentCard {...BASE} status="chargeback_risk" />);
    expect(screen.getByTestId("install-status")).toHaveTextContent("Chargeback risk");
  });

  it("offers Call beside Text, since a rep needs both in the same minute", () => {
    render(<InstallAppointmentCard {...BASE} />);
    expect(screen.getByTestId("install-call").getAttribute("href")).toBe("tel:+15551234567");
  });

  it("names the call target for screen readers", () => {
    render(<InstallAppointmentCard {...BASE} />);
    expect(screen.getByRole("link", { name: "Call Dana Whitfield" })).toBeInTheDocument();
  });

  it("tells the rep the message is theirs to send", () => {
    render(<InstallAppointmentCard {...BASE} />);
    expect(screen.getByText(/your own number/i)).toBeInTheDocument();
  });

  it("reports the hand-off so it can be logged", () => {
    const onTextOpened = vi.fn();
    render(<InstallAppointmentCard {...BASE} onTextOpened={onTextOpened} />);
    screen.getByTestId("install-send-text").click();
    expect(onTextOpened).toHaveBeenCalledTimes(1);
  });
});
