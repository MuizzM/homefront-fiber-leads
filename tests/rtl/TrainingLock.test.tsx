import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { TrainingLock, type GateStatus } from "../../client/src/components/TrainingLock";

const gate: GateStatus = {
  gated: true,
  exempt: false,
  trainingRequired: true,
  progress: {
    completed: 3,
    required: 12,
    remaining: 9,
    pct: 25,
    headline: "9 lessons left",
  },
  totalAvailable: 12,
};

function renderGate() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, queryFn: () => Promise.resolve(gate) },
    },
  });
  queryClient.setQueryData(["/api/training/gate"], gate);
  return render(
    <QueryClientProvider client={queryClient}>
      <TrainingLock />
    </QueryClientProvider>,
  );
}

describe("training-gated workspace", () => {
  it("turns the lock into a clear progress path with an accessible meter", () => {
    renderGate();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Finish training");
    expect(screen.getByRole("progressbar", { name: "Required training progress" }))
      .toHaveAttribute("aria-valuenow", "3");
    expect(screen.getByTestId("lock-count")).toHaveTextContent("3 of 12 lessons complete");
    expect(screen.getByTestId("lock-cta")).toHaveTextContent("Continue training");
  });

  it("keeps the onboarding surfaces discoverable while field tools are gated", () => {
    renderGate();
    expect(screen.getByRole("link", { name: /Profile/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /My documents/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Tax & pay/i })).toBeInTheDocument();
    expect(screen.getByTestId("lock-unlocks").children.length).toBeGreaterThan(2);
  });
});
