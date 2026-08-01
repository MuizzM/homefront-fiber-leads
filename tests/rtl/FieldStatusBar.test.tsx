// The field sync bar's "needs attention" state must tell the rep WHICH door
// and WHY (oldest dead item), and offer Retry ONLY when a retry can plausibly
// work — a Retry that loops into the same rejection forever was the owner's
// original complaint. Offline/syncing states stay as before.
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FieldStatusBar } from "@/components/FieldStatusBar";
import type { QueueSnapshot } from "@/lib/knockQueue";

const mockState: {
  online: boolean;
  snap: QueueSnapshot;
  queue: { retryDead: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> };
} = {
  online: true,
  snap: { pendingCount: 0, deadCount: 0, deadItems: [], byLead: {}, online: true },
  queue: { retryDead: vi.fn(), flush: vi.fn(async () => {}) },
};

vi.mock("@/lib/useKnockLogger", () => ({
  useKnockLogger: () => ({ queue: mockState.queue, snap: mockState.snap, log: vi.fn() }),
}));
vi.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => mockState.online,
}));

function renderBar() {
  const qc = new QueryClient();
  qc.setQueryData(["/api/leads/map"], {
    pins: [
      { id: 42, address: "42 Oak St" },
      { id: 51, address: "9 Birch Ln" },
    ],
  });
  return render(
    <QueryClientProvider client={qc}>
      <FieldStatusBar />
    </QueryClientProvider>,
  );
}

const deadItem = (over: Partial<QueueSnapshot["deadItems"][number]> = {}) => ({
  clientId: "c1",
  leadId: 42,
  outcome: "interested" as const,
  reason: "not authorized right now — sign out and back in, then retry",
  retryable: true,
  ...over,
});

beforeEach(() => {
  mockState.online = true;
  mockState.snap = { pendingCount: 0, deadCount: 0, deadItems: [], byLead: {}, online: true };
  mockState.queue = { retryDead: vi.fn(), flush: vi.fn(async () => {}) };
});

describe("FieldStatusBar — needs attention with door + reason", () => {
  it("renders nothing when online with an empty queue", () => {
    renderBar();
    expect(screen.queryByTestId("field-status")).toBeNull();
  });

  it("one dead item: shows the door address and the failure reason", () => {
    mockState.snap = { ...mockState.snap, deadCount: 1, deadItems: [deadItem()] };
    renderBar();
    const bar = screen.getByTestId("field-status");
    expect(bar.textContent).toContain("42 Oak St needs attention");
    expect(bar.textContent).toContain("not authorized right now");
  });

  it("falls back to the count when the door is not in the map cache", () => {
    mockState.snap = { ...mockState.snap, deadCount: 1, deadItems: [deadItem({ leadId: 777 })] };
    renderBar();
    expect(screen.getByTestId("field-status").textContent).toContain("1 field update needs attention");
  });

  it("several dead items: shows the count and the OLDEST item's reason", () => {
    mockState.snap = {
      ...mockState.snap,
      deadCount: 2,
      deadItems: [deadItem(), deadItem({ clientId: "c2", leadId: 51, reason: "other reason" })],
    };
    renderBar();
    const bar = screen.getByTestId("field-status");
    expect(bar.textContent).toContain("2 field updates need attention");
    expect(bar.textContent).toContain("not authorized right now");
    expect(bar.textContent).not.toContain("other reason");
  });

  it("offers Retry for a retryable item and wires it to retryDead + flush", () => {
    mockState.snap = { ...mockState.snap, deadCount: 1, deadItems: [deadItem()] };
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockState.queue.retryDead).toHaveBeenCalledTimes(1);
    expect(mockState.queue.flush).toHaveBeenCalledTimes(1);
  });

  it("hides Retry when a retry cannot plausibly work", () => {
    mockState.snap = {
      ...mockState.snap,
      deadCount: 1,
      deadItems: [deadItem({ retryable: false, reason: "the lead no longer exists or is no longer yours" })],
    };
    renderBar();
    expect(screen.getByTestId("field-status").textContent).toContain("no longer exists");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("hides Retry while offline (delivery cannot be attempted)", () => {
    mockState.online = false;
    mockState.snap = { ...mockState.snap, deadCount: 1, deadItems: [deadItem()] };
    renderBar();
    expect(screen.getByTestId("field-status")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps the offline state's honest saved-on-device copy", () => {
    mockState.online = false;
    mockState.snap = { ...mockState.snap, pendingCount: 2 };
    renderBar();
    expect(screen.getByTestId("field-status").textContent).toContain("Offline — 2 updates saved on this device");
  });
});

describe("the map overlay NEVER shows the syncing state (owner directive)", () => {
  it("overlay renders nothing for a sustained online backlog — only offline and failures surface", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockState.online = true;
    mockState.snap = { pendingCount: 3, deadCount: 0, deadItems: [], byLead: {}, online: true };
    const qc = new QueryClient();
    const { container, rerender } = render(
      <QueryClientProvider client={qc}>
        <FieldStatusBar overlay />
      </QueryClientProvider>,
    );
    // Even after the sustained window elapses, the map overlay stays empty.
    act(() => { vi.advanceTimersByTime(3500); });
    rerender(
      <QueryClientProvider client={qc}>
        <FieldStatusBar overlay />
      </QueryClientProvider>,
    );
    expect(container.querySelector('[data-testid="field-status"]')).toBeNull();
    expect(screen.queryByText(/Syncing/)).toBeNull();
    vi.useRealTimers();
  });

  it("the NON-overlay bar still surfaces a genuinely stuck backlog", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockState.online = true;
    mockState.snap = { pendingCount: 2, deadCount: 0, deadItems: [], byLead: {}, online: true };
    const qc = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <FieldStatusBar />
      </QueryClientProvider>,
    );
    act(() => { vi.advanceTimersByTime(3500); });
    rerender(
      <QueryClientProvider client={qc}>
        <FieldStatusBar />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Syncing 2 field updates/)).toBeTruthy();
    vi.useRealTimers();
  });
});
