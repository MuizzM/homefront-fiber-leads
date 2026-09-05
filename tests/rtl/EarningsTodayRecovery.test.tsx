import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { EarningsToday } from "@/components/EarningsToday";

const earnings = { bankedCents: 15000, hourlyCents: 15000, hourlyMinutes: 600, spiffCents: 0, salesToday: 1, pendingCents: 20000, pendingBasis: "flat" };
afterEach(() => onlineManager.setOnline(true));

describe("today's earnings recovery", () => {
  it("does not show zero earnings when a cold query is paused offline", async () => {
    onlineManager.setOnline(false);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => earnings } } });
    render(<QueryClientProvider client={qc}><EarningsToday /></QueryClientProvider>);
    await waitFor(() => expect(qc.getQueryState(["/api/me/earnings-today"])?.fetchStatus).toBe("paused"));
    expect(screen.queryByTestId("earnings-today")).not.toBeInTheDocument();
    expect(screen.getByTestId("earnings-today-loading")).toBeInTheDocument();
    await act(async () => { onlineManager.setOnline(true); });
    expect(await screen.findByTestId("earnings-today")).toBeInTheDocument();
  });

  it("offers recovery from a failed read without presenting $0 as fact", async () => {
    let fails = true;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => { if (fails) throw new Error("offline"); return earnings; } } } });
    render(<QueryClientProvider client={qc}><EarningsToday /></QueryClientProvider>);
    const error = await screen.findByTestId("earnings-today-error");
    expect(screen.queryByTestId("earnings-today")).not.toBeInTheDocument();
    fails = false;
    fireEvent.click(within(error).getByRole("button", { name: /retry/i }));
    expect(await screen.findByTestId("earnings-today")).toBeInTheDocument();
  });
});
