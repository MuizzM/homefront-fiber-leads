import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Scanners from "@/pages/Scanners";

const lifecycle = vi.hoisted(() => ({ cityMount: vi.fn(), cityCleanup: vi.fn() }));
const usaChunk = vi.hoisted(() => {
  let resolve!: () => void;
  const pending = new Promise<void>(done => { resolve = done; });
  return { pending, resolve };
});

vi.mock("@/pages/CityScanner", async () => {
  const { useEffect } = await import("react");
  return { default: function City() {
    useEffect(() => { lifecycle.cityMount(); return lifecycle.cityCleanup; }, []);
    return <div>City scanner ready</div>;
  } };
});
vi.mock("@/pages/USAScanner", async () => {
  await usaChunk.pending;
  return { default: () => <div>USA scanner ready</div> };
});
vi.mock("@/pages/KineticScanner", () => ({ default: () => <div>Kinetic scanner ready</div> }));

describe("scanner tabs load independently", () => {
  it("keeps the launcher usable and disconnects the old scanner while a chunk is pending", async () => {
    render(<Scanners />);
    expect(screen.getByText("City scanner ready")).toBeInTheDocument();
    expect(lifecycle.cityMount).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("scanner-tab-usa"));
    expect(await screen.findByRole("status")).toHaveTextContent("Loading scan tool");
    expect(lifecycle.cityCleanup).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Choose a scan tool" })).toBeVisible();

    fireEvent.click(screen.getByTestId("scanner-tab-city"));
    expect(screen.getByText("City scanner ready")).toBeVisible();
    expect(lifecycle.cityMount).toHaveBeenCalledTimes(2);
    usaChunk.resolve();
    fireEvent.click(screen.getByTestId("scanner-tab-usa"));
    expect(await screen.findByText("USA scanner ready")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("preserves direct entry to the Kinetic tool", async () => {
    render(<Scanners initialTab="kinetic" />);
    expect(await screen.findByText("Kinetic scanner ready")).toBeVisible();
    expect(screen.getByTestId("scanner-tab-kinetic")).toHaveAttribute("aria-pressed", "true");
    expect(lifecycle.cityMount).not.toHaveBeenCalled();
  });
});
