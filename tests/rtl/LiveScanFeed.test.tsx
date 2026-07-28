import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LiveScanFeed, type LiveScanEvent } from "@/components/scan/LiveScanFeed";

// Fixed clock base so "stuck for Ns" assertions are deterministic.
const NOW = 1_700_000_000_000;

function ev(over: Partial<LiveScanEvent> & { addressKey: string }): LiveScanEvent {
  return {
    address: `${over.addressKey} Main St`,
    city: "Tulsa",
    state: "OK",
    zip: "74133",
    runId: "run-1",
    source: "field",
    stage: "queued",
    status: "ok",
    attempt: 1,
    tsEpoch: NOW,
    ...over,
  };
}

describe("LiveScanFeed", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders per-address rows newest-first", () => {
    render(
      <LiveScanFeed
        events={[
          ev({ addressKey: "100", stage: "queued", tsEpoch: NOW - 5_000 }),
          ev({ addressKey: "300", stage: "classified", classification: "newly_lit", tsEpoch: NOW - 1_000 }),
          ev({ addressKey: "200", stage: "searching", tsEpoch: NOW - 3_000 }),
        ]}
      />,
    );
    const items = within(screen.getByTestId("live-scan-rows")).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // Newest event first: 300 (1s ago) → 200 (3s ago) → 100 (5s ago).
    expect(items[0]).toHaveTextContent("300 Main St");
    expect(items[1]).toHaveTextContent("200 Main St");
    expect(items[2]).toHaveTextContent("100 Main St");
  });

  it("collapses repeated events for one address into a single row with the attempt count", () => {
    render(
      <LiveScanFeed
        events={[
          ev({ addressKey: "100", stage: "searching", attempt: 1, tsEpoch: NOW - 3_000 }),
          ev({ addressKey: "100", stage: "retry", attempt: 2, tsEpoch: NOW - 2_000 }),
          ev({ addressKey: "100", stage: "classified", attempt: 3, classification: "still_fresh", tsEpoch: NOW - 1_000 }),
        ]}
      />,
    );
    const items = within(screen.getByTestId("live-scan-rows")).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(screen.getByTestId("live-scan-stage-100")).toHaveTextContent("Classified");
    expect(items[0]).toHaveTextContent("attempt 3");
  });

  it("surfaces the failure reason on the row without needing to expand it", () => {
    render(
      <LiveScanFeed
        events={[
          ev({
            addressKey: "100",
            stage: "error",
            status: "error",
            retryReason: "no authorized session",
            tsEpoch: NOW - 1_000,
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("live-scan-reason-100")).toHaveTextContent("no authorized session");
  });

  it("shows the stall banner when many addresses repeat the same non-terminal stage", () => {
    // The production outage shape: everything parked at `minting`, nothing checked.
    const events = ["100", "200", "300", "400"].map((k) =>
      ev({ addressKey: k, stage: "minting", status: "pending_auth", tsEpoch: NOW - 45_000 }),
    );
    const { rerender } = render(<LiveScanFeed events={events} stallSeconds={20} />);

    const banner = screen.getByTestId("live-scan-stall-banner");
    expect(banner).toHaveTextContent("Scan is stalled");
    expect(banner).toHaveTextContent("4 addresses stuck waiting for a scan token");
    // No stage jargon in the headline — it must read as plain language.
    expect(banner).not.toHaveTextContent(/minting/i);

    // Non-vacuous: the same rows inside a longer patience window are not a stall.
    rerender(<LiveScanFeed events={events} stallSeconds={120} />);
    expect(screen.queryByTestId("live-scan-stall-banner")).not.toBeInTheDocument();
  });

  it("names the shared reason when several addresses fail identically", () => {
    const events = ["100", "200", "300"].map((k) =>
      ev({
        addressKey: k,
        stage: "error",
        status: "error",
        retryReason: "no authorized session",
        tsEpoch: NOW - 1_000,
      }),
    );
    render(<LiveScanFeed events={events} />);
    expect(screen.getByTestId("live-scan-stall-banner")).toHaveTextContent(
      "3 addresses are failing for the same reason",
    );
    expect(screen.getByTestId("live-scan-stall-reason")).toHaveTextContent("no authorized session");
  });

  it("does not cry wolf on a healthy, moving run", () => {
    render(
      <LiveScanFeed
        events={[
          ev({ addressKey: "100", stage: "classified", classification: "newly_lit", tsEpoch: NOW - 2_000 }),
          ev({ addressKey: "200", stage: "searching", tsEpoch: NOW - 1_000 }),
          ev({ addressKey: "300", stage: "minting", tsEpoch: NOW - 500 }),
        ]}
      />,
    );
    expect(screen.queryByTestId("live-scan-stall-banner")).not.toBeInTheDocument();
  });

  it("renders the empty state when no scan is running", () => {
    render(<LiveScanFeed events={[]} />);
    expect(screen.getByTestId("live-scan-empty")).toBeInTheDocument();
    expect(screen.getByText("No scan running")).toBeInTheDocument();
    expect(screen.queryByTestId("live-scan-rows")).not.toBeInTheDocument();
  });

  it("renders the error state as an alert", () => {
    render(<LiveScanFeed events={[]} error="scan feed unreachable (503)" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Can't load scan activity");
    expect(alert).toHaveTextContent("scan feed unreachable (503)");
  });

  it("shows loading and reconnecting transport states", () => {
    const { rerender } = render(<LiveScanFeed events={[]} loading connection="connecting" />);
    expect(screen.getByTestId("live-scan-loading")).toBeInTheDocument();
    expect(screen.getByTestId("live-scan-connection")).toHaveTextContent("Connecting");

    rerender(<LiveScanFeed events={[]} connection="reconnecting" />);
    expect(screen.getByTestId("live-scan-connection")).toHaveTextContent("Reconnecting");

    rerender(<LiveScanFeed events={[]} connection="disconnected" />);
    expect(screen.getByTestId("live-scan-connection")).toHaveTextContent("Offline");
  });

  it("never renders anything token-shaped — only a masked session id and 4 chars", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const rawJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.PAYLOADPAYLOAD.SIGNATURE";
    render(
      <LiveScanFeed
        events={[
          ev({
            addressKey: "100",
            stage: "token_ready",
            sessionId: "decodo-s3",
            // Over-shared on purpose: the component must still only paint 4 chars.
            tokenSuffix: rawJwt,
            tsEpoch: NOW - 1_000,
          }),
        ]}
      />,
    );
    // Expand the row so every detail field is in the DOM.
    await user.click(screen.getByTestId("live-scan-row-100"));

    const text = document.body.textContent ?? "";
    expect(text).toContain("decodo-s3");
    expect(text).toContain(`…${rawJwt.slice(-4)}`);
    expect(text).not.toContain(rawJwt);
    expect(text).not.toContain("eyJhbGciOi"); // no JWT header anywhere
    // Nothing credential-length: no unbroken 20+ char token-ish run in the output.
    expect(text).not.toMatch(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
    // And no field is even labelled as a raw token/secret.
    expect(screen.queryByText(/access[_ ]?token|bearer|secret|password/i)).not.toBeInTheDocument();
  });

  it("caps rendered rows so a huge run cannot jank the map", () => {
    const events = Array.from({ length: 500 }, (_, i) =>
      ev({ addressKey: String(i), stage: "searching", tsEpoch: NOW - i * 10 }),
    );
    render(<LiveScanFeed events={events} maxRows={25} />);
    expect(within(screen.getByTestId("live-scan-rows")).getAllByRole("listitem")).toHaveLength(25);
    expect(screen.getByTestId("live-scan-overflow")).toHaveTextContent("+475 more addresses not shown");
  });

  it("filters to problem rows via the accessible toggle", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <LiveScanFeed
        events={[
          ev({ addressKey: "100", stage: "classified", tsEpoch: NOW - 2_000 }),
          ev({ addressKey: "200", stage: "blocked", status: "blocked", retryReason: "429 throttled", tsEpoch: NOW - 1_000 }),
        ]}
      />,
    );
    const toggle = screen.getByTestId("live-scan-problems-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const items = within(screen.getByTestId("live-scan-rows")).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("200 Main St");
  });

  it("exposes the feed as an off-live log with a separate polite summary", () => {
    render(<LiveScanFeed events={[ev({ addressKey: "100", tsEpoch: NOW })]} />);
    const log = screen.getByTestId("live-scan-rows");
    expect(log).toHaveAttribute("role", "log");
    // Explicitly off: announcing every event at scan rate is unusable noise.
    expect(log).toHaveAttribute("aria-live", "off");
    const summary = screen.getByTestId("live-scan-sr-summary");
    expect(summary).toHaveAttribute("aria-live", "polite");
  });

  it("pulls events through an injected fetcher (no endpoint baked in)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      events: [ev({ addressKey: "100", stage: "classified", tsEpoch: NOW })],
      connection: "live" as const,
    });
    render(<LiveScanFeed fetcher={fetcher} runId="run-1" pollMs={50} />);

    await waitFor(() => expect(screen.getByTestId("live-scan-rows")).toBeInTheDocument());
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByTestId("live-scan-stage-100")).toHaveTextContent("Classified");
  });

  it("surfaces a fetcher failure as the error state", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
    render(<LiveScanFeed fetcher={fetcher} runId="run-1" pollMs={5_000} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("boom"));
    expect(screen.getByTestId("live-scan-connection")).toHaveTextContent("Offline");
  });
});
