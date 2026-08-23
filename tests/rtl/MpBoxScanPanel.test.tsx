import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MpBoxScanPanel, { derivePanelState, type MpboxStats } from "@/components/map/MpBoxScanPanel";

/**
 * The MP Box scan panel.
 *
 * What matters here is that the panel never invents a number: every count comes
 * from the persisted scan results, and the chip count must equal what the list
 * can actually return. The rest defends the states the design contract promises
 * are reachable, and the accessibility commitments it makes.
 */
const stats = (o: Partial<MpboxStats> = {}): MpboxStats => ({
  discovered: 10, eligible: 10, processed: 10, matched: 5,
  tenured: 3, freshFiber: 4, both: 2,
  new: 6, changed: 1, unchanged: 3,
  skippedFromCache: 3, staleRescanned: 0, duplicatesRemoved: 0,
  succeeded: 10, failed: 0, cancelled: 0,
  cacheHitPct: 30, elapsedMs: 12_000, ...o,
});

const rowsFor = (n: number, tenured = true, fresh = false) =>
  Array.from({ length: n }, (_, i) => ({
    targetId: 100 + i, address: `${100 + i} Box Rd`, city: "Rockwell",
    tenured, freshFiber: fresh, outcome: i % 2 ? "cache_hit" : "classified", error: null,
  }));

function mockApi(o: {
  stats?: MpboxStats | null; counts?: any; results?: any[]; noHistory?: boolean; fail?: boolean;
} = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(String(url));
    if (o.fail) return { ok: false, status: 500, json: async () => ({}) } as any;
    if (String(url).includes("/results")) {
      const u = new URL(String(url), "http://x");
      const wantT = u.searchParams.get("tenured") === "1";
      const wantF = u.searchParams.get("fresh") === "1";
      let rows = o.results ?? [];
      if (wantT) rows = rows.filter((r: any) => r.tenured);
      if (wantF) rows = rows.filter((r: any) => r.freshFiber);
      return { ok: true, status: 200, json: async () => ({ results: rows, nextAfter: null, count: rows.length }) } as any;
    }
    if (o.noHistory) return { ok: true, status: 200, json: async () => ({ scanId: null, reason: "no_history" }) } as any;
    return {
      ok: true, status: 200,
      json: async () => ({
        scanId: "s1", status: "done", completedAt: new Date(Date.now() - 300_000).toISOString(),
        stats: o.stats === null ? null : (o.stats ?? stats()),
        counts: o.counts ?? { total: 10, tenured: 3, freshFiber: 4, both: 2, neither: 5 },
      }),
    } as any;
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

beforeEach(() => { window.history.replaceState(null, "", "/map"); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("derivePanelState - every promised state is reachable", () => {
  it("names the state from persisted facts, not from a spinner flag", () => {
    expect(derivePanelState({ scanning: true, hasHistory: true, stats: null })).toBe("scanning");
    expect(derivePanelState({ scanning: true, resumed: true, hasHistory: true, stats: null })).toBe("resumed");
    expect(derivePanelState({ scanning: false, hasHistory: false, stats: null })).toBe("no_history");
    expect(derivePanelState({ scanning: false, hasHistory: true, stats: null })).toBe("initial");
    expect(derivePanelState({ scanning: false, hasHistory: true, stats: stats() })).toBe("success");
    expect(derivePanelState({ scanning: false, hasHistory: true, stats: stats({ failed: 2 }) })).toBe("partial_failure");
    expect(derivePanelState({ scanning: false, hasHistory: true, stats: stats({ succeeded: 0, failed: 9 }) })).toBe("complete_failure");
    expect(derivePanelState({ scanning: false, hasHistory: true, stats: stats({ cancelled: 4 }) })).toBe("cancelled");
    expect(derivePanelState({
      scanning: false, hasHistory: true,
      stats: stats({ succeeded: 0, failed: 0, matched: 0, tenured: 0, freshFiber: 0, processed: 5 }),
    })).toBe("insufficient_data");
  });
});

describe("counts are read, never invented", () => {
  it("shows the persisted counts on the chips", async () => {
    mockApi();
    render(<MpBoxScanPanel scanId="s1" scanning={false} />);
    await waitFor(() => expect(screen.getByTestId("mpbox-stats")).toBeInTheDocument());
    expect(screen.getByTestId("stat-tenured")).toHaveTextContent("3");
    expect(screen.getByTestId("stat-fresh")).toHaveTextContent("4");
    expect(screen.getByTestId("stat-cached")).toHaveTextContent("3");
    expect(screen.getByTestId("stat-processed")).toHaveTextContent("10/10");
  });

  it("the chip count equals what the filter can return", async () => {
    // 3 tenured claimed; the list must be able to produce exactly 3.
    mockApi({ results: rowsFor(3, true, false) });
    const user = userEvent.setup();
    render(<MpBoxScanPanel scanId="s1" scanning={false} />);
    await waitFor(() => expect(screen.getByTestId("mpbox-filter-tenured")).toBeInTheDocument());
    await user.click(screen.getByTestId("mpbox-filter-tenured"));
    await waitFor(() => expect(screen.getByTestId("mpbox-table")).toBeInTheDocument());
    expect(within(screen.getByTestId("mpbox-table")).getAllByRole("row")).toHaveLength(3 + 1); // + header
    expect(screen.getByTestId("mpbox-shown")).toHaveTextContent("3 doors matching");
  });
});

describe("filters", () => {
  it("each works alone and both together mean AND", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ results: rowsFor(2, true, true) });
    render(<MpBoxScanPanel scanId="s1" scanning={false} />);
    await waitFor(() => expect(screen.getByTestId("mpbox-filter-tenured")).toBeInTheDocument());

    await user.click(screen.getByTestId("mpbox-filter-tenured"));
    await waitFor(() => expect(calls.some((c) => c.includes("tenured=1") && !c.includes("fresh=1"))).toBe(true));

    await user.click(screen.getByTestId("mpbox-filter-fresh"));
    await waitFor(() => expect(calls.some((c) => c.includes("tenured=1") && c.includes("fresh=1"))).toBe(true));
    // The AND semantics are stated to the operator, not left implicit.
    expect(screen.getByTestId("mpbox-and-note")).toHaveTextContent("both");
  });

  it("survives a reload by living in the URL, and clear-all removes it", async () => {
    const user = userEvent.setup();
    mockApi({ results: rowsFor(2) });
    render(<MpBoxScanPanel scanId="s1" scanning={false} />);
    await waitFor(() => expect(screen.getByTestId("mpbox-filter-tenured")).toBeInTheDocument());
    await user.click(screen.getByTestId("mpbox-filter-tenured"));
    await waitFor(() => expect(window.location.search).toContain("tenured=1"));
    await user.click(screen.getByTestId("mpbox-clear-filters"));
    await waitFor(() => expect(window.location.search).not.toContain("tenured=1"));
  });

  it("zero matches is an explained state with a way out, not a blank list", async () => {
    const user = userEvent.setup();
    mockApi({ results: [] });
    render(<MpBoxScanPanel scanId="s1" scanning={false} />);
    await waitFor(() => expect(screen.getByTestId("mpbox-filter-fresh")).toBeInTheDocument());
    await user.click(screen.getByTestId("mpbox-filter-fresh"));
    await waitFor(() => expect(screen.getByTestId("mpbox-zero-matches")).toBeInTheDocument());
    expect(screen.getByTestId("mpbox-zero-clear")).toBeInTheDocument();
  });
});

describe("cached results are distinguishable from this run's", () => {
  it("labels each row's source", async () => {
    mockApi({ results: rowsFor(2, true, false) });
    render(<MpBoxScanPanel scanId="s1" scanning={false} />);
    await waitFor(() => expect(screen.getByTestId("mpbox-table")).toBeInTheDocument());
    const body = screen.getByTestId("mpbox-table").textContent ?? "";
    expect(body).toContain("This scan");
    expect(body).toContain("Cached");
  });
});

describe("accessibility", () => {
  it("marks the region busy while scanning and announces one contextual status", async () => {
    mockApi({ stats: stats({ processed: 4, eligible: 10 }) });
    render(<MpBoxScanPanel scanId="s1" scanning />);
    await waitFor(() => expect(screen.getByTestId("mpbox-live").textContent).toBeTruthy());
    expect(screen.getByTestId("mpbox-panel")).toHaveAttribute("aria-busy", "true");
    const live = screen.getByTestId("mpbox-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    // A contextual sentence, never a bare number.
    expect(live.textContent).toMatch(/of 10 processed/);
    expect(live.textContent).toMatch(/tenured/);
  });

  it("filters are real labelled checkboxes reachable by keyboard", async () => {
    const user = userEvent.setup();
    mockApi({ results: rowsFor(1) });
    render(<MpBoxScanPanel scanId="s1" scanning={false} />);
    await waitFor(() => expect(screen.getByTestId("mpbox-filter-tenured")).toBeInTheDocument());
    const tenured = screen.getByRole("checkbox", { name: /tenured/i });
    expect(tenured).toBeInTheDocument();
    tenured.focus();
    expect(document.activeElement).toBe(tenured);
    await user.keyboard(" ");
    expect((tenured as HTMLInputElement).checked).toBe(true);
  });

  it("the table has a real header row", async () => {
    mockApi({ results: rowsFor(1) });
    render(<MpBoxScanPanel scanId="s1" scanning={false} />);
    await waitFor(() => expect(screen.getByTestId("mpbox-table")).toBeInTheDocument());
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Address", "Result", "Source"]);
  });
});

describe("failure and empty states", () => {
  it("offers recovery when results cannot load", async () => {
    mockApi({ fail: true });
    render(<MpBoxScanPanel scanId="s1" scanning={false} />);
    await waitFor(() => expect(screen.getByTestId("mpbox-error")).toBeInTheDocument());
    expect(screen.getByTestId("mpbox-retry")).toBeInTheDocument();
  });

  it("says so plainly when no scan has ever run", async () => {
    mockApi({ noHistory: true });
    render(<MpBoxScanPanel scanId={null} scanning={false} />);
    await waitFor(() => expect(screen.getByTestId("mpbox-no-history")).toBeInTheDocument());
    expect(screen.getByTestId("mpbox-last-scan")).toHaveTextContent("No area scan has been run yet");
  });

  it("a partial failure keeps the good results and offers a retry", async () => {
    mockApi({ stats: stats({ failed: 2 }), results: rowsFor(2) });
    render(<MpBoxScanPanel scanId="s1" scanning={false} onRescan={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("mpbox-partial")).toBeInTheDocument());
    expect(screen.getByTestId("mpbox-retry-failed")).toBeInTheDocument();
    expect(screen.getByTestId("stat-failed")).toHaveTextContent("2");
  });

  it("a cancelled scan says what was kept", async () => {
    mockApi({ stats: stats({ cancelled: 6, processed: 4 }), results: rowsFor(1) });
    render(<MpBoxScanPanel scanId="s1" scanning={false} onRescan={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("mpbox-cancelled")).toBeInTheDocument());
    expect(screen.getByTestId("mpbox-cancelled").textContent).toMatch(/4 records were saved/);
  });
});

describe("every visible control does something", () => {
  it("stop and door selection call their handlers", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const onSelectDoor = vi.fn();
    mockApi({ results: rowsFor(1) });
    render(<MpBoxScanPanel scanId="s1" scanning onStop={onStop} onSelectDoor={onSelectDoor} />);
    await waitFor(() => expect(screen.getByTestId("mpbox-stop")).toBeInTheDocument());
    await user.click(screen.getByTestId("mpbox-stop"));
    expect(onStop).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /100 Box Rd/ }));
    expect(onSelectDoor).toHaveBeenCalledWith(100);
  });
});
