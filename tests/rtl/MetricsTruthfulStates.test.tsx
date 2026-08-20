import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/capabilities", () => ({ useCan: () => false }));
vi.mock("@/components/metrics/FieldMode", () => ({ FieldModeCard: () => null }));

import { MyMetrics } from "@/components/metrics/MyMetrics";
import { TeamMetrics } from "@/components/metrics/TeamMetrics";
import { TerritoryMetrics } from "@/components/metrics/TerritoryMetrics";
import { Reports } from "@/components/metrics/Reports";

type QueryResponder = (key: string) => unknown | Promise<unknown>;

function renderWithQueries(ui: React.ReactElement, responder: QueryResponder) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        queryFn: ({ queryKey }) => Promise.resolve(responder(String(queryKey[0]))),
      },
    },
  });
  return {
    qc,
    ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Metrics tabs keep failed reads distinct from real zeros", () => {
  const cases: Array<{
    name: string;
    ui: React.ReactElement;
    failedKey: (key: string) => boolean;
  }> = [
    { name: "My Metrics", ui: <MyMetrics />, failedKey: (key) => key.startsWith("/api/metrics/me?") },
    { name: "Team Metrics", ui: <TeamMetrics />, failedKey: (key) => key.startsWith("/api/metrics/team?") },
    { name: "Territory Metrics", ui: <TerritoryMetrics />, failedKey: (key) => key === "/api/metrics/territories" },
    { name: "Reports", ui: <Reports />, failedKey: (key) => key.startsWith("/api/metrics/reports?") },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} renders the shared retry state instead of an empty dashboard`, async () => {
      renderWithQueries(testCase.ui, (key) => {
        if (testCase.failedKey(key)) throw new Error("network down");
        if (key.includes("hourly")) return { hours: [] };
        if (key.includes("insights")) return { insights: [] };
        return {};
      });

      const alert = await screen.findByTestId("metrics-error");
      expect(alert).toHaveAttribute("role", "alert");
      expect(alert).toHaveTextContent(/showing zeros would be misleading/i);
      expect(screen.getByTestId("metrics-error-retry")).toHaveAccessibleName(/try again/i);
    });
  }

  it("retry reissues the failed request and reveals a successful empty team response", async () => {
    let shouldFail = true;
    let teamCalls = 0;
    renderWithQueries(<TeamMetrics />, (key) => {
      if (!key.startsWith("/api/metrics/team?")) return {};
      teamCalls += 1;
      if (shouldFail) throw new Error("network down");
      return {
        period: { from: "2026-08-20", to: "2026-08-20", timezone: "America/New_York" },
        rows: [],
        kpis: null,
        baseline: null,
      };
    });

    await screen.findByTestId("metrics-error-retry");
    shouldFail = false;
    fireEvent.click(screen.getByTestId("metrics-error-retry"));

    await waitFor(() => expect(teamCalls).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByTestId("metrics-error")).not.toBeInTheDocument());
    expect(screen.getByText(/no reps in your scope have activity/i)).toBeInTheDocument();
  });

  it("removes pay estimates from My Metrics and links to the authoritative commission screen", async () => {
    renderWithQueries(<MyMetrics />, (key) => {
      if (key.startsWith("/api/metrics/me?")) {
        return { hasSeat: true, facts: {}, metrics: {}, funnel: [], daily: [], teamBaseline: null };
      }
      if (key.includes("hourly")) return { hours: [] };
      if (key.includes("insights")) return { insights: [] };
      return {};
    });

    const link = await screen.findByRole("link", { name: /open my commission/i });
    expect(link).toHaveAttribute("href", "/my-commission");
    expect(screen.queryByText("Estimated pay")).not.toBeInTheDocument();
    expect(screen.queryByText("Paid")).not.toBeInTheDocument();
  });
});
